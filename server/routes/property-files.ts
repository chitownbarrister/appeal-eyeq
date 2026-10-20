// A property's documents. Dropbox stores the files; Appeal EyeQ keeps the index:
// each file's profile (type, status, dates, author, tags, notes, year, level),
// the delete rules, Recently deleted, version history, previews, and the move to
// Deadzone when a matter closes.
//
// Every route is for firm users only (support access never sees client files),
// every query runs inside withContext (row-level security) and filters on firm_id,
// and every path from the browser is relative to the property's own folder and
// checked so it can't climb out of it.

import express, { Router, type Request } from "express";
import { z } from "zod";
import PostalMime from "postal-mime";
import { withContext } from "../db.js";
import { requirePermission } from "../auth.js";
import { matterTitle, shortPin, LEVELS, type Level } from "../../shared/domain.js";
import {
  DOC_STATUSES, LEGACY_LEVEL_FOLDERS, WINDOWS_PATH_BUDGET, extensionOf, pathTooLongForWindows, previewKind, suggestedFileName,
} from "../../shared/documents.js";
import { DropboxError, FirmDropbox, dropboxConfigured } from "../dropbox/client.js";
import { hasEncryptionKey } from "../secrets.js";
import {
  cleanRelative, deletePath, ensureFolder, expectedPropertyPath, joinPath, listAllFiles, listFolder, listRevisions, locate, metadata,
  moveFolder, movePath, restoreFile, safeName, temporaryLink, webUrl, type Metadata,
} from "../dropbox/folders.js";
import { loadTemplate, placeOf, typesFor, type Template } from "../documents.js";
import { dropboxCall, hasPermission, httpError, idParam, noSupportAccess } from "./files-common.js";

export const propertyFilesRouter = Router();
propertyFilesRouter.use("/properties/:id/files", noSupportAccess);

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 50 * 1024 * 1024;
const INDEX_EVERY_MS = 2 * 60 * 1000;

// ================================================================ loading a property and its folder
interface Link { folder_id: string; path_display: string; in_deadzone: boolean; indexed_at: string | null }
interface Prop { id: number; title: string; client: string; pin: string | null; appeals: { assessment_year: number; level: Level }[]; link: Link | null }

async function loadProperty(req: Request): Promise<Prop> {
  const pid = idParam(req);
  if (!pid) throw httpError(400, "Invalid property.");
  const p = await withContext(req.ctx!, async (c) => {
    const row = (await c.query(
      `SELECT p.id, p.name, p.address1, p.city, t.name AS township, ac.name AS client,
              (SELECT x.pin FROM parcels x WHERE x.firm_id = p.firm_id AND x.property_id = p.id ORDER BY x.is_primary DESC, x.id LIMIT 1) AS pin
         FROM properties p JOIN accounts ac ON ac.firm_id = p.firm_id AND ac.id = p.account_id
         LEFT JOIN townships t ON t.id = p.township_id
        WHERE p.firm_id = $1 AND p.id = $2`,
      [req.ctx!.firmId, pid],
    )).rows[0];
    if (!row) return null;
    const appeals = (await c.query(`SELECT DISTINCT assessment_year, level FROM appeals WHERE firm_id = $1 AND property_id = $2`, [req.ctx!.firmId, pid])).rows;
    const link = (await c.query<Link>(
      `SELECT folder_id, path_display, in_deadzone, indexed_at FROM property_folders WHERE firm_id = $1 AND property_id = $2 AND provider = 'dropbox'`,
      [req.ctx!.firmId, pid],
    )).rows[0] ?? null;
    return { id: row.id, title: matterTitle(row.pin, row.address1 || row.name, row.city, row.township), client: row.client, pin: row.pin, appeals, link } as Prop;
  });
  if (!p) throw httpError(404, "Property not found.");
  return p;
}

async function openDropbox(req: Request): Promise<FirmDropbox> {
  const dbx = await FirmDropbox.open(req.ctx!);
  if (!dbx) throw httpError(409, "Dropbox isn't connected. A firm admin can connect it in Settings, Integrations.");
  return dbx;
}

function expectedFor(dbx: FirmDropbox, p: Prop, inDeadzone = p.link?.in_deadzone ?? false): string {
  return expectedPropertyPath(dbx.integration.root_folder, p.client, p.title, inDeadzone);
}

/** The property's linked folder where it is now (following renames), or null if there's none or it was deleted. */
async function currentFolder(req: Request, dbx: FirmDropbox, p: Prop): Promise<{ id: string; path_display: string } | null> {
  if (!p.link) return null;
  const now = await locate(dbx, p.link.folder_id);
  if (!now) {
    await withContext(req.ctx!, (c) => c.query(`DELETE FROM property_folders WHERE firm_id = $1 AND property_id = $2 AND provider = 'dropbox'`, [req.ctx!.firmId, p.id]));
    p.link = null;
    return null;
  }
  if (now.path_display !== p.link.path_display) {
    await withContext(req.ctx!, (c) => c.query(`UPDATE property_folders SET path_display = $3 WHERE firm_id = $1 AND property_id = $2 AND provider = 'dropbox'`, [req.ctx!.firmId, p.id, now.path_display]));
    p.link.path_display = now.path_display;
  }
  return now;
}

async function requireFolder(req: Request, dbx: FirmDropbox, p: Prop) {
  const folder = await dropboxCall(() => currentFolder(req, dbx, p));
  if (!folder) throw httpError(409, "Create this property's Dropbox folder first.");
  return folder;
}

async function template(req: Request): Promise<Template> {
  return withContext(req.ctx!, (c) => loadTemplate(c, req.ctx!.firmId!));
}

/** The relative path of an absolute Dropbox path inside the property folder ("" for the folder itself). */
function relOf(folderPath: string, abs: string): string | null {
  const f = folderPath.toLowerCase();
  const a = abs.toLowerCase();
  if (a === f) return "";
  if (!a.startsWith(`${f}/`)) return null;
  return abs.slice(folderPath.length + 1);
}

function parentRel(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

function relPath(req: Request, field: "query" | "body" = "query"): string {
  const raw = field === "query" ? req.query.path : (req.body as { path?: unknown } | undefined)?.path;
  return cleanRelative(typeof raw === "string" ? raw : "");
}

// ================================================================ the document index
interface DocRow {
  id: number; file_id: string; rev: string | null; path_display: string; name: string; size: string | null; server_modified: string | null;
  doc_type_id: number | null; status: string | null; doc_date: string | null; received_on: string | null; filed_on: string | null;
  author: string | null; tags: string[]; notes: string | null; assessment_year: number | null; level: Level | null;
  uploaded_by: number | null; uploaded_at: string | null; profiled_by: number | null; profiled_at: string | null; deleted_at: string | null;
}

/** Year and level a file sits under: Appeals/<year>/<level folder>/... */
function yearLevelOf(t: Template, rel: string): { year: number | null; level: Level | null } {
  const place = placeOf(t, parentRel(rel));
  return { year: place.year, level: place.level };
}

/**
 * Reads the whole property folder and brings the index up to date: new files get a row (no
 * profile yet), moved or renamed files are followed by their Dropbox id, and files that are
 * gone (deleted in Finder or on dropbox.com) are recorded in Recently deleted as deleted
 * outside Appeal EyeQ, with what's needed to restore them.
 */
async function indexFolder(req: Request, dbx: FirmDropbox, p: Prop, folderPath: string, force = false): Promise<void> {
  if (!force && p.link?.indexed_at && Date.now() - new Date(p.link.indexed_at).getTime() < INDEX_EVERY_MS) return;
  const t = await template(req);
  const files = await dropboxCall(() => listAllFiles(dbx, folderPath));
  const firmId = req.ctx!.firmId!;
  const seen = new Set(files.map((f) => f.id!));
  if (files.length) {
    const rows = files.map((f) => {
      const rel = relOf(folderPath, f.path_display!) ?? f.name;
      const yl = yearLevelOf(t, rel);
      return { id: f.id!, rev: f.rev ?? null, path: f.path_display!, name: f.name, size: f.size ?? null, mod: f.server_modified ?? null, year: yl.year, level: yl.level };
    });
    await withContext(req.ctx!, (c) =>
      c.query(
        `INSERT INTO documents (firm_id, property_id, provider, file_id, rev, path_display, name, size, server_modified, assessment_year, level)
         SELECT $1, $2, 'dropbox', r.id, r.rev, r.path, r.name, r.size, r.mod, r.year, r.level
           FROM jsonb_to_recordset($3::jsonb) AS r(id text, rev text, path text, name text, size bigint, mod timestamptz, year int, level text)
         ON CONFLICT (firm_id, provider, file_id) DO UPDATE SET
           property_id = EXCLUDED.property_id, rev = EXCLUDED.rev, path_display = EXCLUDED.path_display, name = EXCLUDED.name,
           size = EXCLUDED.size, server_modified = EXCLUDED.server_modified, deleted_at = NULL,
           assessment_year = COALESCE(documents.assessment_year, EXCLUDED.assessment_year),
           level = COALESCE(documents.level, EXCLUDED.level)`,
        [firmId, p.id, JSON.stringify(rows)],
      ),
    );
  }
  const known = await withContext(req.ctx!, async (c) =>
    (await c.query<{ id: number; file_id: string; rev: string | null; path_display: string; name: string }>(
      `SELECT id, file_id, rev, path_display, name FROM documents WHERE firm_id = $1 AND property_id = $2 AND deleted_at IS NULL`,
      [firmId, p.id],
    )).rows,
  );
  for (const d of known.filter((k) => !seen.has(k.file_id))) {
    const elsewhere = await dropboxCall(() => metadata(dbx, d.file_id));
    if (elsewhere && elsewhere[".tag"] === "file") {
      // Moved out of this property's folder: follow it, keep the profile.
      await withContext(req.ctx!, (c) => c.query(`UPDATE documents SET path_display = $3, name = $4 WHERE firm_id = $1 AND id = $2`, [firmId, d.id, elsewhere.path_display, elsewhere.name]));
      continue;
    }
    await withContext(req.ctx!, async (c) => {
      await c.query(`UPDATE documents SET deleted_at = now() WHERE firm_id = $1 AND id = $2`, [firmId, d.id]);
      await c.query(
        `INSERT INTO file_deletions (firm_id, property_id, kind, path_display, name, items, outside, was_protected)
         VALUES ($1, $2, 'file', $3, $4, $5, true, $6)`,
        [firmId, p.id, d.path_display, d.name, JSON.stringify([{ path: d.path_display, rev: d.rev, fileId: d.file_id }]), await isProtectedDoc(c, firmId, d.id)],
      );
    });
  }
  await withContext(req.ctx!, (c) => c.query(`UPDATE property_folders SET indexed_at = now() WHERE firm_id = $1 AND property_id = $2 AND provider = 'dropbox'`, [firmId, p.id]));
}

async function isProtectedDoc(c: import("pg").PoolClient, firmId: number, docId: number): Promise<boolean> {
  const r = await c.query<{ p: boolean }>(
    `SELECT (COALESCE(t.protected, false) OR d.status = 'filed') AS p
       FROM documents d LEFT JOIN document_types t ON t.firm_id = d.firm_id AND t.id = d.doc_type_id
      WHERE d.firm_id = $1 AND d.id = $2`,
    [firmId, docId],
  );
  return r.rows[0]?.p ?? false;
}

async function docsByFileId(req: Request, pid: number, fileIds: string[]): Promise<Map<string, DocRow & { type_name: string | null; type_protected: boolean | null }>> {
  if (!fileIds.length) return new Map();
  const rows = await withContext(req.ctx!, async (c) =>
    (await c.query<DocRow & { type_name: string | null; type_protected: boolean | null }>(
      `SELECT d.*, t.name AS type_name, t.protected AS type_protected
         FROM documents d LEFT JOIN document_types t ON t.firm_id = d.firm_id AND t.id = d.doc_type_id
        WHERE d.firm_id = $1 AND d.file_id = ANY($2::text[])`,
      [req.ctx!.firmId, fileIds],
    )).rows,
  );
  void pid;
  return new Map(rows.map((r) => [r.file_id, r]));
}

function canDeleteProtectedFor(req: Request): Promise<boolean> {
  if (req.auth?.user.isFirmAdmin) return Promise.resolve(true);
  return hasPermission(req, "files.delete_protected");
}

// ================================================================ browse
const LEVEL_ORDER = (t: Template, name: string) => {
  const i = LEVELS.findIndex((l) => t.levels[l].toLowerCase() === name.toLowerCase());
  return i < 0 ? 99 : i;
};

propertyFilesRouter.get("/properties/:id/files", async (req, res) => {
  const p = await loadProperty(req);
  const rel = relPath(req);
  const dbx = await FirmDropbox.open(req.ctx!);
  if (!dbx) {
    res.json({ connected: false, configured: dropboxConfigured() && hasEncryptionKey() });
    return;
  }
  const t = await template(req);
  const expected = expectedFor(dbx, p);
  const folder = await dropboxCall(() => currentFolder(req, dbx, p));
  if (!folder) {
    res.json({ connected: true, folder: null, expectedPath: expectedFor(dbx, p, false), template: templateSummary(t) });
    return;
  }
  await indexFolder(req, dbx, p, folder.path_display);
  const entries = await dropboxCall(() => listFolder(dbx, folder.path_display, rel));
  const docs = await docsByFileId(req, p.id, entries.filter((e) => e.kind === "file").map((e) => e.id));
  const here = placeOf(t, rel);

  // Template folders first, in the template's order (years newest first, levels in order), then the rest A to Z.
  const order = (name: string): number => {
    if (!rel) { const i = t.top.findIndex((r) => r.name.toLowerCase() === name.toLowerCase()); return i < 0 ? 1000 : i; }
    if (here.templateId === t.appeals?.id && here.year === null && /^\d{4}$/.test(name)) return 3000 - Number(name);
    if (here.year !== null && here.level === null) return LEVEL_ORDER(t, name);
    return 1000;
  };
  const canDelete = await hasPermission(req, "files.delete");
  const canDeleteProtected = await canDeleteProtectedFor(req);
  const shaped = entries
    .map((e) => {
      const d = e.kind === "file" ? docs.get(e.id) : undefined;
      const childPlace = e.kind === "folder" ? placeOf(t, e.relPath) : null;
      const isProtected = e.kind === "file" ? Boolean(d?.type_protected || d?.status === "filed") : Boolean(childPlace?.isTemplateFolder);
      return {
        ...e,
        preview: e.kind === "file" ? previewKind(e.name) : null,
        templateFolder: Boolean(childPlace?.isTemplateFolder),
        protected: isProtected,
        profile: d ? {
          docTypeId: d.doc_type_id, docType: d.type_name, status: d.status, docDate: d.doc_date, tags: d.tags, profiled: Boolean(d.profiled_at || d.doc_type_id),
        } : null,
        sort: order(e.name),
      };
    })
    .sort((a, b) => (a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : a.sort - b.sort || a.name.localeCompare(b.name, undefined, { numeric: true })))
    .map(({ sort: _s, ...e }) => e);

  const crumbs = rel ? rel.split("/") : [];
  res.json({
    connected: true,
    folder: {
      path: folder.path_display,
      webUrl: webUrl(rel ? joinPath(folder.path_display, rel) : folder.path_display, false),
      outOfDate: folder.path_display.toLowerCase() !== expected.toLowerCase(),
      inDeadzone: p.link?.in_deadzone ?? false,
    },
    expectedPath: expected,
    path: rel,
    breadcrumbs: crumbs.map((name, i) => ({ name, relPath: crumbs.slice(0, i + 1).join("/") })),
    here: { templateFolder: here.isTemplateFolder, year: here.year, level: here.level, types: typesFor(t, here).map((d) => ({ id: d.id, name: d.name, protected: d.protected })) },
    entries: shaped,
    pin: p.pin ? shortPin(p.pin) : null,
    windowsBudget: WINDOWS_PATH_BUDGET,
    can: { delete: canDelete, deleteProtected: canDeleteProtected, edit: await hasPermission(req, "properties.edit") },
    template: templateSummary(t),
  });
});

function templateSummary(t: Template) {
  const folderName = (id: number | null) => (id === null ? null : t.top.find((r) => r.id === id)?.name ?? (Object.values(t.levelRows).find((r) => r?.id === id)?.name ?? null));
  return {
    folders: t.top.map((r) => ({ id: r.id, name: r.name, kind: r.kind })),
    levels: t.levels,
    types: t.types.filter((d) => d.active).map((d) => ({ id: d.id, name: d.name, protected: d.protected, folder: d.any_level ? "Every level folder" : folderName(d.template_id) })),
  };
}

// ================================================================ apply the template
/** Renames old short level folder names (ASSR, BOR, PTAB, SPOB) in every year folder to the template's names. */
async function renameLegacyLevels(dbx: FirmDropbox, t: Template, appealsPath: string): Promise<number> {
  let renamed = 0;
  const years = (await listFolder(dbx, appealsPath, "")).filter((e) => e.kind === "folder" && /^\d{4}$/.test(e.name));
  for (const y of years) {
    const kids = await listFolder(dbx, appealsPath, y.name);
    const names = new Set(kids.filter((k) => k.kind === "folder").map((k) => k.name.toLowerCase()));
    for (const level of LEVELS) {
      const want = t.levels[level];
      if (names.has(want.toLowerCase())) continue;
      const old = kids.find((k) => k.kind === "folder" && LEGACY_LEVEL_FOLDERS[level].some((l) => l.toLowerCase() === k.name.toLowerCase()));
      if (old) {
        await movePath(dbx, old.path, joinPath(appealsPath, y.name, want));
        renamed++;
      }
    }
  }
  return renamed;
}

/** Creates the property's folder from the template (or links the one already at that path), its template folders and one folder per appeal. */
propertyFilesRouter.post("/properties/:id/files/ensure", requirePermission("properties.edit"), async (req, res) => {
  const p = await loadProperty(req);
  const dbx = await openDropbox(req);
  const t = await template(req);
  const result = await dropboxCall(async () => {
    let folder = await currentFolder(req, dbx, p);
    let created = false;
    if (!folder) {
      const made = await ensureFolder(dbx, expectedFor(dbx, p, false));
      folder = made;
      created = true;
      await withContext(req.ctx!, (c) =>
        c.query(
          `INSERT INTO property_folders (firm_id, property_id, provider, folder_id, path_display, in_deadzone) VALUES ($1, $2, 'dropbox', $3, $4, false)
           ON CONFLICT (firm_id, property_id, provider) DO UPDATE SET folder_id = EXCLUDED.folder_id, path_display = EXCLUDED.path_display, in_deadzone = false`,
          [req.ctx!.firmId, p.id, made.id, made.path_display],
        ),
      );
    }
    for (const top of t.top) await ensureFolder(dbx, joinPath(folder.path_display, top.name));
    const appealsName = t.appeals?.name ?? "Appeals";
    const appealsPath = joinPath(folder.path_display, appealsName);
    const renamed = await renameLegacyLevels(dbx, t, appealsPath);
    for (const a of p.appeals) await ensureFolder(dbx, joinPath(appealsPath, String(a.assessment_year), t.levels[a.level]));
    return { folder, created, renamed };
  });
  res.json({ path: result.folder.path_display, linked: result.created, renamed: result.renamed });
});

/** Moves the folder to the name the template gives it now (after a client or address change). */
propertyFilesRouter.post("/properties/:id/files/move", requirePermission("properties.edit"), async (req, res) => {
  const p = await loadProperty(req);
  const dbx = await openDropbox(req);
  const folder = await requireFolder(req, dbx, p);
  const expected = expectedFor(dbx, p);
  const moved = folder.path_display.toLowerCase() === expected.toLowerCase() ? folder : await dropboxCall(() => moveFolderTo(dbx, folder.id, expected));
  await withContext(req.ctx!, (c) => c.query(`UPDATE property_folders SET path_display = $3 WHERE firm_id = $1 AND property_id = $2 AND provider = 'dropbox'`, [req.ctx!.firmId, p.id, moved.path_display]));
  await reindexPaths(req, folder.path_display, moved.path_display);
  res.json({ path: moved.path_display });
});

async function moveFolderTo(dbx: FirmDropbox, id: string, to: string) {
  try {
    return await moveFolder(dbx, id, to);
  } catch (err) {
    if (err instanceof DropboxError && err.tag.includes("conflict")) {
      throw httpError(409, `A folder already exists at ${to}. Merge or rename it in Dropbox, then try again.`);
    }
    throw err;
  }
}

/** After a folder moves, the index follows: every document path under it is rewritten. */
async function reindexPaths(req: Request, from: string, to: string): Promise<void> {
  if (from === to) return;
  await withContext(req.ctx!, (c) =>
    c.query(
      `UPDATE documents SET path_display = $3 || substr(path_display, length($2) + 1)
        WHERE firm_id = $1 AND (lower(path_display) = lower($2) OR lower(path_display) LIKE lower($2) || '/%')`,
      [req.ctx!.firmId, from, to],
    ),
  );
}

/** Deadzone: closed matters move aside (and back), keeping every file and its profile. */
propertyFilesRouter.post("/properties/:id/files/deadzone", requirePermission("properties.edit"), async (req, res) => {
  const parsed = z.object({ to: z.enum(["deadzone", "active"]) }).safeParse(req.body);
  if (!parsed.success) throw httpError(400, "Say whether the folder goes to Deadzone or back.");
  const p = await loadProperty(req);
  const dbx = await openDropbox(req);
  const folder = await requireFolder(req, dbx, p);
  const toDeadzone = parsed.data.to === "deadzone";
  const target = expectedFor(dbx, p, toDeadzone);
  const moved = folder.path_display.toLowerCase() === target.toLowerCase() ? folder : await dropboxCall(() => moveFolderTo(dbx, folder.id, target));
  await withContext(req.ctx!, (c) =>
    c.query(`UPDATE property_folders SET path_display = $3, in_deadzone = $4 WHERE firm_id = $1 AND property_id = $2 AND provider = 'dropbox'`, [req.ctx!.firmId, p.id, moved.path_display, toDeadzone]),
  );
  await reindexPaths(req, folder.path_display, moved.path_display);
  // Leave no empty client folder behind.
  const oldParent = folder.path_display.slice(0, folder.path_display.lastIndexOf("/"));
  const root = dbx.integration.root_folder.toLowerCase();
  if (oldParent && oldParent.toLowerCase() !== root && oldParent.toLowerCase().startsWith(`${root}/`)) {
    await dropboxCall(async () => {
      const rest = await listFolder(dbx, oldParent, "");
      if (rest.length === 0) await deletePath(dbx, oldParent);
    }).catch(() => undefined);
  }
  res.json({ path: moved.path_display, inDeadzone: toDeadzone });
});

// ================================================================ folders, rename, delete
const NewFolder = z.object({ path: z.string().max(1000).default(""), name: z.string().trim().min(1, "Name the folder.").max(200) });

propertyFilesRouter.post("/properties/:id/files/folder", requirePermission("properties.edit"), async (req, res) => {
  const parsed = NewFolder.safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const parent = cleanRelative(parsed.data.path);
  const name = safeName(parsed.data.name);
  const p = await loadProperty(req);
  const dbx = await openDropbox(req);
  const folder = await requireFolder(req, dbx, p);
  const path = joinPath(folder.path_display, parent, name);
  const made = await dropboxCall(async () => {
    try {
      return (await dbx.rpc<{ metadata: Metadata }>("files/create_folder_v2", { path, autorename: false })).metadata;
    } catch (err) {
      if (err instanceof DropboxError && err.tag.includes("conflict")) throw httpError(409, `There's already something named ${name} here.`);
      throw err;
    }
  });
  res.status(201).json({ name: made.name, relPath: relOf(folder.path_display, made.path_display!), tooLongForWindows: pathTooLongForWindows(made.path_display!) });
});

const Rename = z.object({ path: z.string().min(1).max(1000), name: z.string().trim().min(1, "Enter a name.").max(200) });

propertyFilesRouter.post("/properties/:id/files/rename", requirePermission("properties.edit"), async (req, res) => {
  const parsed = Rename.safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const rel = cleanRelative(parsed.data.path);
  if (!rel) throw httpError(400, "Choose a file or folder.");
  const p = await loadProperty(req);
  const dbx = await openDropbox(req);
  const t = await template(req);
  if (placeOf(t, rel).isTemplateFolder) throw httpError(409, "This folder is part of the firm's folder template, so it keeps its name. A firm admin can change the template in Settings, Documents.");
  const folder = await requireFolder(req, dbx, p);
  const from = joinPath(folder.path_display, rel);
  const current = await dropboxCall(() => metadata(dbx, from));
  if (!current) throw httpError(404, "That file or folder isn't in Dropbox any more.");
  let name = safeName(parsed.data.name);
  const oldExt = extensionOf(current.name);
  if (current[".tag"] === "file" && oldExt && extensionOf(name) !== oldExt) name = `${name}.${oldExt}`;
  const to = joinPath(folder.path_display, parentRel(rel), name);
  if (to === from) { res.json({ name, relPath: rel, tooLongForWindows: pathTooLongForWindows(to) }); return; }
  const moved = await dropboxCall(() => movePath(dbx, from, to));
  if (current[".tag"] === "file") {
    await withContext(req.ctx!, (c) => c.query(`UPDATE documents SET path_display = $3, name = $4 WHERE firm_id = $1 AND file_id = $2`, [req.ctx!.firmId, current.id, moved.path_display, moved.name]));
  } else {
    await reindexPaths(req, from, moved.path_display!);
  }
  res.json({ name: moved.name, relPath: relOf(folder.path_display, moved.path_display!), tooLongForWindows: pathTooLongForWindows(moved.path_display!) });
});

propertyFilesRouter.post("/properties/:id/files/delete", requirePermission("files.delete"), async (req, res) => {
  const rel = relPath(req, "body");
  if (!rel) throw httpError(400, "Choose a file or folder.");
  const p = await loadProperty(req);
  const dbx = await openDropbox(req);
  const t = await template(req);
  const folder = await requireFolder(req, dbx, p);
  const abs = joinPath(folder.path_display, rel);
  const current = await dropboxCall(() => metadata(dbx, abs));
  if (!current) throw httpError(404, "That file or folder isn't in Dropbox any more.");
  const firmId = req.ctx!.firmId!;

  // What would go, and whether any of it is protected.
  const files = current[".tag"] === "file" ? [current] : await dropboxCall(() => listAllFiles(dbx, abs));
  const ids = files.map((f) => f.id!);
  const protectedDocs = await withContext(req.ctx!, async (c) =>
    (await c.query<{ name: string; reason: string }>(
      `SELECT d.name, COALESCE(CASE WHEN t.protected THEN t.name END, 'Filed') AS reason
         FROM documents d LEFT JOIN document_types t ON t.firm_id = d.firm_id AND t.id = d.doc_type_id
        WHERE d.firm_id = $1 AND d.file_id = ANY($2::text[]) AND (t.protected OR d.status = 'filed')`,
      [firmId, ids],
    )).rows,
  );
  const templateFolder = current[".tag"] === "folder" && placeOf(t, rel).isTemplateFolder;
  const isProtected = templateFolder || protectedDocs.length > 0;
  if (isProtected && !(await canDeleteProtectedFor(req))) {
    const why = templateFolder
      ? `${current.name} is one of the firm's template folders`
      : current[".tag"] === "file"
        ? `${current.name} is a protected document (${protectedDocs[0].reason})`
        : `${current.name} holds protected documents (${protectedDocs.slice(0, 3).map((d) => d.name).join(", ")}${protectedDocs.length > 3 ? ", ..." : ""})`;
    throw httpError(403, `${why}. Your role can't delete protected files; an attorney or a firm admin can.`);
  }

  await dropboxCall(() => deletePath(dbx, abs));
  const deletion = await withContext(req.ctx!, async (c) => {
    if (ids.length) await c.query(`UPDATE documents SET deleted_at = now() WHERE firm_id = $1 AND file_id = ANY($2::text[])`, [firmId, ids]);
    return (await c.query<{ id: number }>(
      `INSERT INTO file_deletions (firm_id, property_id, kind, path_display, name, items, was_protected, deleted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [firmId, p.id, current[".tag"], current.path_display, current.name, JSON.stringify(files.map((f) => ({ path: f.path_display, rev: f.rev, fileId: f.id }))), isProtected, req.auth!.user.id],
    )).rows[0];
  });
  res.json({ deletionId: deletion.id, files: files.length });
});

propertyFilesRouter.get("/properties/:id/files/deleted", async (req, res) => {
  const p = await loadProperty(req);
  const rows = await withContext(req.ctx!, async (c) =>
    (await c.query(
      `SELECT f.id, f.kind, f.path_display, f.name, jsonb_array_length(f.items) AS files, f.was_protected, f.outside, f.deleted_at, u.name AS deleted_by
         FROM file_deletions f LEFT JOIN users u ON u.firm_id = f.firm_id AND u.id = f.deleted_by
        WHERE f.firm_id = $1 AND f.property_id = $2 AND f.restored_at IS NULL AND f.deleted_at > now() - interval '180 days'
        ORDER BY f.deleted_at DESC LIMIT 200`,
      [req.ctx!.firmId, p.id],
    )).rows,
  );
  const folderPath = p.link?.path_display ?? "";
  res.json({ deleted: rows.map((r) => ({ ...r, relPath: folderPath ? relOf(folderPath, r.path_display) : null })) });
});

propertyFilesRouter.post("/properties/:id/files/restore", requirePermission("properties.edit"), async (req, res) => {
  const parsed = z.object({ deletionId: z.number().int().positive() }).safeParse(req.body);
  if (!parsed.success) throw httpError(400, "Choose something to restore.");
  const p = await loadProperty(req);
  const dbx = await openDropbox(req);
  await requireFolder(req, dbx, p);
  const firmId = req.ctx!.firmId!;
  const del = await withContext(req.ctx!, async (c) =>
    (await c.query<{ id: number; kind: string; path_display: string; name: string; items: { path: string; rev: string | null; fileId: string }[]; restored_at: string | null }>(
      `SELECT id, kind, path_display, name, items, restored_at FROM file_deletions WHERE firm_id = $1 AND property_id = $2 AND id = $3`,
      [firmId, p.id, parsed.data.deletionId],
    )).rows[0],
  );
  if (!del) throw httpError(404, "That deleted item isn't on this property.");
  if (del.restored_at) throw httpError(409, `${del.name} was already restored.`);
  const failed: string[] = [];
  let restored = 0;
  await dropboxCall(async () => {
    if (del.kind === "folder") await ensureFolder(dbx, del.path_display);
    for (const item of del.items) {
      if (!item.rev) { failed.push(item.path.split("/").pop()!); continue; }
      try {
        const m = await restoreFile(dbx, item.path, item.rev);
        restored++;
        await withContext(req.ctx!, (c) =>
          c.query(
            `UPDATE documents SET deleted_at = NULL, file_id = $3, rev = $4, path_display = $5, name = $6 WHERE firm_id = $1 AND file_id = $2`,
            [firmId, item.fileId, m.id ?? item.fileId, m.rev ?? item.rev, m.path_display ?? item.path, m.name],
          ),
        );
      } catch (err) {
        if (err instanceof DropboxError) { failed.push(item.path.split("/").pop()!); continue; }
        throw err;
      }
    }
  });
  if (failed.length && !restored && del.kind === "file") {
    throw httpError(409, `Dropbox couldn't restore ${del.name}. It may be past Dropbox's restore window, or something else now has that name.`);
  }
  await withContext(req.ctx!, (c) => c.query(`UPDATE file_deletions SET restored_at = now(), restored_by = $3 WHERE firm_id = $1 AND id = $2`, [firmId, del.id, req.auth!.user.id]));
  res.json({ restored, failed });
});

// ================================================================ upload, download, preview
propertyFilesRouter.post(
  "/properties/:id/files/upload",
  requirePermission("properties.edit"),
  express.raw({ type: "application/octet-stream", limit: MAX_UPLOAD_BYTES }),
  async (req, res) => {
    const rel = relPath(req);
    const name = safeName(String(req.query.name ?? ""));
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw httpError(400, "The file is empty.");
    const p = await loadProperty(req);
    const dbx = await openDropbox(req);
    const t = await template(req);
    const folder = await requireFolder(req, dbx, p);
    const saved = await dropboxCall(() => dbx.upload(joinPath(folder.path_display, rel, name), req.body as Buffer));
    const fileRel = relOf(folder.path_display, saved.path_display) ?? name;
    const yl = yearLevelOf(t, fileRel);
    await withContext(req.ctx!, (c) =>
      c.query(
        `INSERT INTO documents (firm_id, property_id, provider, file_id, rev, path_display, name, size, server_modified, assessment_year, level, uploaded_by, uploaded_at)
         VALUES ($1, $2, 'dropbox', $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
         ON CONFLICT (firm_id, provider, file_id) DO UPDATE SET rev = EXCLUDED.rev, path_display = EXCLUDED.path_display, name = EXCLUDED.name,
           size = EXCLUDED.size, server_modified = EXCLUDED.server_modified, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = EXCLUDED.uploaded_at, deleted_at = NULL`,
        [req.ctx!.firmId, p.id, saved.id, saved.rev, saved.path_display, saved.name, saved.size, saved.server_modified, yl.year, yl.level, req.auth!.user.id],
      ),
    );
    res.status(201).json({ name: saved.name, size: saved.size, relPath: fileRel, tooLongForWindows: pathTooLongForWindows(saved.path_display) });
  },
);

/** The absolute path and current metadata of a file inside the property folder. */
async function fileAt(req: Request, dbx: FirmDropbox, p: Prop, relGiven?: string): Promise<{ abs: string; rel: string; meta: Metadata; folderPath: string }> {
  const rel = relGiven === undefined ? relPath(req) : cleanRelative(relGiven);
  if (!rel) throw httpError(400, "Choose a file.");
  const folder = await requireFolder(req, dbx, p);
  const abs = joinPath(folder.path_display, rel);
  const meta = await dropboxCall(() => metadata(dbx, abs));
  if (!meta || meta[".tag"] !== "file") throw httpError(404, "That file isn't in Dropbox any more.");
  return { abs, rel, meta, folderPath: folder.path_display };
}

/** Downloads a file (or an earlier version of it) through a short-lived Dropbox link. */
propertyFilesRouter.get("/properties/:id/files/download", async (req, res) => {
  const p = await loadProperty(req);
  const dbx = await openDropbox(req);
  const f = await fileAt(req, dbx, p);
  let target = f.abs;
  const rev = typeof req.query.rev === "string" ? req.query.rev : "";
  if (rev) {
    const revs = await dropboxCall(() => listRevisions(dbx, f.meta.id!));
    if (!revs.some((r) => r.rev === rev)) throw httpError(404, "That version isn't in this file's history.");
    target = `rev:${rev}`;
  }
  res.redirect(302, await dropboxCall(() => temporaryLink(dbx, target)));
});

const MIME: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8", json: "text/plain; charset=utf-8", xml: "text/plain; charset=utf-8", log: "text/plain; charset=utf-8",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};

/** Lets the Files tab show a preview in a frame on the same site (the rest of the app refuses framing). */
function allowSameOriginFrame(res: import("express").Response, sandbox: boolean): void {
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader(
    "Content-Security-Policy",
    sandbox
      ? "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'"
      : "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'",
  );
  res.setHeader("Cache-Control", "private, no-store");
}

/** The file itself, shown inline: PDFs, images, text, audio and video. */
propertyFilesRouter.get("/properties/:id/files/raw", async (req, res) => {
  const p = await loadProperty(req);
  const dbx = await openDropbox(req);
  const f = await fileAt(req, dbx, p);
  const kind = previewKind(f.meta.name);
  if (!["pdf", "image", "text", "audio", "video"].includes(kind)) throw httpError(415, "This file isn't shown as is. Use the preview instead.");
  const got = await dropboxCall(() => dbx.content("files/download", { path: f.abs }, MAX_PREVIEW_BYTES));
  allowSameOriginFrame(res, kind === "image" && extensionOf(f.meta.name) === "svg");
  res.setHeader("Content-Type", MIME[extensionOf(f.meta.name)] ?? "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.meta.name)}`);
  res.send(got.body);
});

/** Word, PowerPoint and similar as PDF, spreadsheets as HTML, both rendered by Dropbox. */
propertyFilesRouter.get("/properties/:id/files/preview", async (req, res) => {
  const p = await loadProperty(req);
  const dbx = await openDropbox(req);
  const f = await fileAt(req, dbx, p);
  const kind = previewKind(f.meta.name);
  if (kind !== "office" && kind !== "sheet") throw httpError(415, "This file isn't previewed this way.");
  let got: Awaited<ReturnType<FirmDropbox["content"]>>;
  try {
    got = await dbx.content("files/get_preview", { path: f.abs }, MAX_PREVIEW_BYTES);
  } catch (err) {
    const tag = err instanceof DropboxError ? err.tag : "";
    if (tag.includes("in_progress")) throw httpError(409, "Dropbox is still preparing this preview. Try again in a few seconds.", { retry: true });
    if (tag.includes("unsupported")) throw httpError(415, "Dropbox can't preview this file. Open it in its app or download it.");
    return dropboxCall(() => Promise.reject(err));
  }
  const html = kind === "sheet";
  allowSameOriginFrame(res, html);
  res.setHeader("Content-Type", html ? "text/html; charset=utf-8" : "application/pdf");
  res.setHeader("Content-Disposition", "inline");
  res.send(got.body);
});

/** An .eml email, read by Appeal EyeQ: who, when, subject, the message and its attachments. */
propertyFilesRouter.get("/properties/:id/files/email", async (req, res) => {
  const p = await loadProperty(req);
  const dbx = await openDropbox(req);
  const f = await fileAt(req, dbx, p);
  if (previewKind(f.meta.name) !== "email") throw httpError(415, "That isn't an .eml email.");
  const got = await dropboxCall(() => dbx.content("files/download", { path: f.abs }, 25 * 1024 * 1024));
  const mail = await PostalMime.parse(got.body);
  const who = (a: { name?: string; address?: string } | undefined) => (a ? (a.name ? `${a.name} <${a.address ?? ""}>` : a.address ?? "") : "");
  const list = (xs: { name?: string; address?: string }[] | undefined) => (xs ?? []).map(who).filter(Boolean);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    from: who(mail.from), to: list(mail.to), cc: list(mail.cc), date: mail.date ?? null, subject: mail.subject ?? "",
    text: mail.text ?? null, html: mail.html ?? null,
    attachments: (mail.attachments ?? []).map((a) => ({ filename: a.filename ?? "(unnamed)", mimeType: a.mimeType, size: typeof a.content === "string" ? a.content.length : (a.content as ArrayBuffer).byteLength })),
  });
});

// ================================================================ details, profile, versions
propertyFilesRouter.get("/properties/:id/files/details", async (req, res) => {
  const p = await loadProperty(req);
  const dbx = await openDropbox(req);
  const t = await template(req);
  const f = await fileAt(req, dbx, p);
  const firmId = req.ctx!.firmId!;
  const doc = await withContext(req.ctx!, async (c) =>
    (await c.query(
      `SELECT d.*, t.name AS type_name, t.protected AS type_protected, ub.name AS uploaded_by_name, pb.name AS profiled_by_name
         FROM documents d
         LEFT JOIN document_types t ON t.firm_id = d.firm_id AND t.id = d.doc_type_id
         LEFT JOIN users ub ON ub.firm_id = d.firm_id AND ub.id = d.uploaded_by
         LEFT JOIN users pb ON pb.firm_id = d.firm_id AND pb.id = d.profiled_by
        WHERE d.firm_id = $1 AND d.file_id = $2`,
      [firmId, f.meta.id],
    )).rows[0] ?? null,
  );
  const revisions = await dropboxCall(() => listRevisions(dbx, f.meta.id!)).catch(() => [] as Metadata[]);
  const yl = yearLevelOf(t, f.rel);
  const year = doc?.assessment_year ?? yl.year;
  res.json({
    name: f.meta.name,
    relPath: f.rel,
    dropboxPath: f.meta.path_display,
    webUrl: webUrl(f.meta.path_display!, true),
    size: f.meta.size ?? null,
    modified: f.meta.server_modified ?? null,
    clientModified: f.meta.client_modified ?? null,
    rev: f.meta.rev ?? null,
    contentHash: f.meta.content_hash ?? null,
    format: extensionOf(f.meta.name).toUpperCase() || "File",
    preview: previewKind(f.meta.name),
    tooLongForWindows: pathTooLongForWindows(f.meta.path_display!),
    profile: {
      docTypeId: doc?.doc_type_id ?? null, docType: doc?.type_name ?? null, status: doc?.status ?? null,
      docDate: doc?.doc_date ?? null, receivedOn: doc?.received_on ?? null, filedOn: doc?.filed_on ?? null,
      author: doc?.author ?? null, tags: doc?.tags ?? [], notes: doc?.notes ?? null,
      year, level: doc?.level ?? yl.level,
      uploadedBy: doc?.uploaded_by_name ?? null, uploadedAt: doc?.uploaded_at ?? null,
      profiledBy: doc?.profiled_by_name ?? null, profiledAt: doc?.profiled_at ?? null,
      protected: Boolean(doc?.type_protected || doc?.status === "filed"),
    },
    suggestedTypes: typesFor(t, placeOf(t, parentRel(f.rel))).map((d) => d.id),
    pin: p.pin ? shortPin(p.pin) : null,
    suggestedName: doc?.type_name ? suggestedFileName(p.pin ? shortPin(p.pin) : null, doc.type_name, year, f.meta.name) : null,
    revisions: revisions.map((r, i) => ({ rev: r.rev, modified: r.server_modified, size: r.size ?? null, current: i === 0 || r.rev === f.meta.rev })),
  });
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a full date.").nullable().optional();
const Profile = z.object({
  path: z.string().min(1).max(1000),
  docTypeId: z.number().int().positive().nullable().optional(),
  status: z.enum(DOC_STATUSES).nullable().optional(),
  docDate: isoDate, receivedOn: isoDate, filedOn: isoDate,
  author: z.string().trim().max(120).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  notes: z.string().max(4000).nullable().optional(),
  year: z.number().int().min(1990).max(2100).nullable().optional(),
  level: z.enum(LEVELS).nullable().optional(),
});

propertyFilesRouter.put("/properties/:id/files/profile", requirePermission("properties.edit"), async (req, res) => {
  const parsed = Profile.safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const v = parsed.data;
  const p = await loadProperty(req);
  const dbx = await openDropbox(req);
  const f = await fileAt(req, dbx, p, v.path);
  const firmId = req.ctx!.firmId!;
  if (v.docTypeId) {
    const ok = await withContext(req.ctx!, async (c) => (await c.query(`SELECT 1 FROM document_types WHERE firm_id = $1 AND id = $2`, [firmId, v.docTypeId])).rowCount);
    if (!ok) throw httpError(400, "That document type isn't one of the firm's.");
  }
  const blank = (s: string | null | undefined) => (s === undefined ? undefined : s === null || s.trim() === "" ? null : s.trim());
  await withContext(req.ctx!, (c) =>
    c.query(
      `INSERT INTO documents (firm_id, property_id, provider, file_id, rev, path_display, name, size, server_modified,
                              doc_type_id, status, doc_date, received_on, filed_on, author, tags, notes, assessment_year, level, profiled_by, profiled_at)
       VALUES ($1, $2, 'dropbox', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, COALESCE($15, '{}'::text[]), $16, $17, $18, $19, now())
       ON CONFLICT (firm_id, provider, file_id) DO UPDATE SET
         doc_type_id = $9, status = $10, doc_date = $11, received_on = $12, filed_on = $13, author = $14,
         tags = COALESCE($15, documents.tags), notes = $16, assessment_year = $17, level = $18, profiled_by = $19, profiled_at = now(),
         path_display = EXCLUDED.path_display, name = EXCLUDED.name, rev = EXCLUDED.rev, deleted_at = NULL`,
      [
        firmId, p.id, f.meta.id, f.meta.rev ?? null, f.meta.path_display, f.meta.name, f.meta.size ?? null, f.meta.server_modified ?? null,
        v.docTypeId ?? null, v.status ?? null, v.docDate ?? null, v.receivedOn ?? null, v.filedOn ?? null, blank(v.author) ?? null,
        v.tags ? [...new Set(v.tags)] : null, blank(v.notes) ?? null, v.year ?? null, v.level ?? null, req.auth!.user.id,
      ],
    ),
  );
  res.json({ ok: true });
});

/** Makes an earlier version the current one (Dropbox keeps the newer one in the history too). */
propertyFilesRouter.post("/properties/:id/files/revisions/restore", requirePermission("properties.edit"), async (req, res) => {
  const parsed = z.object({ path: z.string().min(1), rev: z.string().min(9).max(64) }).safeParse(req.body);
  if (!parsed.success) throw httpError(400, "Choose a version.");
  const p = await loadProperty(req);
  const dbx = await openDropbox(req);
  const f = await fileAt(req, dbx, p, parsed.data.path);
  const revs = await dropboxCall(() => listRevisions(dbx, f.meta.id!));
  if (!revs.some((r) => r.rev === parsed.data.rev)) throw httpError(404, "That version isn't in this file's history.");
  const m = await dropboxCall(() => restoreFile(dbx, f.abs, parsed.data.rev));
  await withContext(req.ctx!, (c) => c.query(`UPDATE documents SET rev = $3, size = $4, server_modified = $5 WHERE firm_id = $1 AND file_id = $2`, [req.ctx!.firmId, f.meta.id, m.rev, m.size ?? null, m.server_modified ?? null]));
  res.json({ rev: m.rev });
});
