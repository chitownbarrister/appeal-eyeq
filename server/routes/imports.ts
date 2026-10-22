// Bulk import: upload a batch of files (CSV or Excel, one workbook or fifty), say what each sheet
// holds and which column is which field, preview every row, commit, and undo. Mounted under
// /api/firm after requireFirmContext. Everything runs inside withContext (row-level security) and
// filters on firm_id. Imports carry client data, so none of this is open under support access.

import express, { Router, type Request } from "express";
import type pg from "pg";
import { z } from "zod";
import { withContext } from "../db.js";
import { safeName } from "../dropbox/folders.js";
import { httpError, idParam } from "./files-common.js";
import { parseFile } from "../imports/parse.js";
import { autoMap, detectEntity, ENTITIES, ENTITY_LABELS, FIELDS, templateCsv, type Entity } from "../imports/fields.js";
import { applyPlan, buildPlan, PURPOSE_DEFAULTS, summarize, undoBatch, undoCheck, type FileSheets, type ImportOptions, type SheetMapping } from "../imports/engine.js";
import type { DbContext } from "../db.js";
import type { ParsedSheet } from "../imports/parse.js";

export const importsRouter = Router();
for (const path of ["/imports", "/import-mappings"]) {
  importsRouter.use(path, (req, res, next) => {
    if (req.auth?.user.isSuperAdmin) {
      res.status(403).json({ error: "Imports aren't available under support access." });
      return;
    }
    next();
  });
}

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 50;
const PURPOSES = ["migration", "new", "update"] as const;
type Purpose = (typeof PURPOSES)[number];

/** Imports big enough to run in the background (one transaction each), with how far along they are. */
const jobs = new Map<number, { kind: "commit" | "undo"; done: number; total: number }>();
const INLINE_ROWS = 500;

interface BatchRow {
  id: number; purpose: Purpose; status: string; error: string | null; options: Partial<ImportOptions>; mapping: { sheets?: SheetMapping[] }; summary: Record<string, unknown> | null;
  mapping_name: string | null; created_at: string; created_by_name: string | null; committed_at: string | null; committed_by_name: string | null; undone_at: string | null;
}

async function loadBatch(c: pg.PoolClient, firmId: number, id: number): Promise<BatchRow> {
  const b = (await c.query<BatchRow>(
    `SELECT b.*, cu.name AS created_by_name, mu.name AS committed_by_name
       FROM import_batches b
       LEFT JOIN users cu ON cu.firm_id = b.firm_id AND cu.id = b.created_by
       LEFT JOIN users mu ON mu.firm_id = b.firm_id AND mu.id = b.committed_by
      WHERE b.firm_id = $1 AND b.id = $2`,
    [firmId, id],
  )).rows[0];
  if (!b) throw httpError(404, "Import not found.");
  // A background run that isn't running any more (the server restarted mid-way) rolled back with it.
  if ((b.status === "committing" || b.status === "undoing") && !jobs.has(b.id)) {
    b.status = b.status === "committing" ? "previewed" : "committed";
    b.error = "The server restarted while this was running, so nothing was changed. Try again.";
    await c.query(`UPDATE import_batches SET status = $3, error = $4 WHERE firm_id = $1 AND id = $2`, [firmId, id, b.status, b.error]);
  }
  return b;
}
async function loadFiles(c: pg.PoolClient, firmId: number, batchId: number): Promise<FileSheets[]> {
  return (await c.query<{ id: number; name: string; sheets: ParsedSheet[] }>(
    `SELECT id, name, sheets FROM import_files WHERE firm_id = $1 AND batch_id = $2 ORDER BY id`, [firmId, batchId],
  )).rows;
}
const optionsOf = (b: BatchRow): ImportOptions => ({ ...PURPOSE_DEFAULTS[b.purpose], ...(b.options ?? {}) });

/** The mapping in force: what was saved for each sheet, else what Appeal EyeQ worked out from the sheet. */
function mappingsFor(b: BatchRow, files: FileSheets[]): SheetMapping[] {
  const saved = b.mapping?.sheets ?? [];
  const out: SheetMapping[] = [];
  for (const f of files) for (const s of f.sheets) {
    const have = saved.find((m) => m.fileId === f.id && m.sheet === s.name);
    if (have) { out.push(have); continue; }
    const entity = detectEntity(s.name, s.headers, f.sheets.map((x) => x.name));
    out.push({ fileId: f.id, sheet: s.name, entity, columns: entity === "skip" ? {} : autoMap(entity, s.headers) });
  }
  return out;
}
function batchJson(b: BatchRow) {
  return {
    id: b.id, purpose: b.purpose, status: b.status, error: b.error, job: jobs.get(b.id) ?? null, options: optionsOf(b), summary: b.summary, mappingName: b.mapping_name,
    createdAt: b.created_at, createdBy: b.created_by_name, committedAt: b.committed_at, committedBy: b.committed_by_name, undoneAt: b.undone_at,
  };
}
const editable = (b: BatchRow) => {
  if (b.status === "committing" || b.status === "undoing") throw httpError(409, "This import is running. Wait for it to finish.");
  if (b.status === "committed" || b.status === "undone") throw httpError(409, "This import has been committed. Start a new one.");
};

/** Runs the work now (small imports) or in the background (large ones), recording the outcome on the batch. */
async function run(ctx: DbContext, id: number, kind: "commit" | "undo", size: number, work: (c: pg.PoolClient, progress: (d: number, t: number) => void) => Promise<unknown>, onFail: string) {
  const firmId = ctx.firmId!;
  const job = { kind, done: 0, total: size };
  jobs.set(id, job);
  const go = async () => {
    try {
      return await withContext(ctx, (c) => work(c, (d, t) => { job.done = d; job.total = t; }));
    } catch (err) {
      const e = err as { publicMessage?: string };
      const msg = (e.publicMessage ?? "Something went wrong, so nothing was changed. Try again, or send the file to support.").slice(0, 1000);
      if (!e.publicMessage) console.error(`import ${id} ${kind} failed`, err);
      await withContext(ctx, (c) => c.query(`UPDATE import_batches SET status = $3, error = $4 WHERE firm_id = $1 AND id = $2`, [firmId, id, onFail, msg])).catch(() => undefined);
      throw err;
    } finally {
      jobs.delete(id);
    }
  };
  if (size <= INLINE_ROWS) return { inline: true, result: await go() };
  go().catch(() => undefined);
  return { inline: false, result: null };
}

// ---------------------------------------------------------------- the field list (for the mapping screen and templates)
importsRouter.get("/imports/fields", (_req, res) => {
  res.json({ entities: ENTITIES.map((e) => ({ key: e, label: ENTITY_LABELS[e], fields: FIELDS[e].map(({ key, label, required, note, aliases }) => ({ key, label, required: Boolean(required), note: note ?? null, aliases })) })) });
});
importsRouter.get("/imports/templates/:entity.csv", (req, res) => {
  const entity = String(req.params.entity) as Entity;
  if (!(ENTITIES as readonly string[]).includes(entity)) throw httpError(404, "No such template.");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="Appeal EyeQ import - ${ENTITY_LABELS[entity].replace(/[()]/g, "")}.csv"`);
  res.send(templateCsv(entity));
});

// ---------------------------------------------------------------- batches
importsRouter.get("/imports", async (req, res) => {
  const rows = await withContext(req.ctx!, async (c) => (await c.query<BatchRow & { files: number }>(
    `SELECT b.*, cu.name AS created_by_name, mu.name AS committed_by_name,
            (SELECT count(*)::int FROM import_files f WHERE f.firm_id = b.firm_id AND f.batch_id = b.id) AS files,
            (SELECT string_agg(f.name, ', ' ORDER BY f.id) FROM import_files f WHERE f.firm_id = b.firm_id AND f.batch_id = b.id) AS file_names
       FROM import_batches b
       LEFT JOIN users cu ON cu.firm_id = b.firm_id AND cu.id = b.created_by
       LEFT JOIN users mu ON mu.firm_id = b.firm_id AND mu.id = b.committed_by
      WHERE b.firm_id = $1 ORDER BY b.created_at DESC LIMIT 100`,
    [req.ctx!.firmId],
  )).rows);
  res.json({ imports: rows.map((b) => ({ ...batchJson(b), files: b.files, fileNames: (b as unknown as { file_names: string | null }).file_names })) });
});

importsRouter.post("/imports", async (req, res) => {
  const body = z.object({ purpose: z.enum(PURPOSES) }).parse(req.body);
  const id = await withContext(req.ctx!, async (c) => (await c.query<{ id: number }>(
    `INSERT INTO import_batches (firm_id, purpose, options, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [req.ctx!.firmId, body.purpose, JSON.stringify(PURPOSE_DEFAULTS[body.purpose]), req.auth!.user.id],
  )).rows[0].id);
  res.status(201).json({ id });
});

function batchId(req: Request): number {
  const id = idParam(req);
  if (!id) throw httpError(400, "Invalid import.");
  return id;
}

importsRouter.post("/imports/:id/files", express.raw({ type: "application/octet-stream", limit: MAX_FILE_BYTES }), async (req, res) => {
  const id = batchId(req);
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw httpError(400, "The file is empty.");
  const name = safeName(String(req.query.name ?? "")).slice(0, 200) || "Import file";
  const sheets = await parseFile(name, req.body);
  if (!sheets.some((s) => s.rows.length)) throw httpError(422, `${name} has no rows to import.`);
  const out = await withContext(req.ctx!, async (c) => {
    const b = await loadBatch(c, req.ctx!.firmId!, id);
    editable(b);
    const n = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM import_files WHERE firm_id = $1 AND batch_id = $2`, [req.ctx!.firmId, id])).rows[0].n;
    if (n >= MAX_FILES) throw httpError(409, `One import takes up to ${MAX_FILES} files. Start a second import for the rest.`);
    const fid = (await c.query<{ id: number }>(
      `INSERT INTO import_files (firm_id, batch_id, name, size, sheets) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.ctx!.firmId, id, name, req.body.length, JSON.stringify(sheets)],
    )).rows[0].id;
    await c.query(`UPDATE import_batches SET status = 'draft' WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id]);
    return fid;
  });
  res.status(201).json({ file: { id: out, name, sheets: sheets.map((s) => ({ name: s.name, rows: s.rows.length })) } });
});

importsRouter.delete("/imports/:id/files/:fileId", async (req, res) => {
  const id = batchId(req);
  const fileId = Number(req.params.fileId);
  if (!Number.isInteger(fileId) || fileId <= 0) throw httpError(400, "Invalid file.");
  await withContext(req.ctx!, async (c) => {
    editable(await loadBatch(c, req.ctx!.firmId!, id));
    const r = await c.query(`DELETE FROM import_files WHERE firm_id = $1 AND batch_id = $2 AND id = $3`, [req.ctx!.firmId, id, fileId]);
    if (!r.rowCount) throw httpError(404, "File not found.");
    await c.query(`UPDATE import_batches SET status = 'draft' WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id]);
  });
  res.json({ ok: true });
});

/** The batch with its files and sheets: what each sheet looks like it holds, its columns, a few sample values, and the mapping. */
importsRouter.get("/imports/:id", async (req, res) => {
  const id = batchId(req);
  const out = await withContext(req.ctx!, async (c) => {
    const b = await loadBatch(c, req.ctx!.firmId!, id);
    const files = await loadFiles(c, req.ctx!.firmId!, id);
    const maps = mappingsFor(b, files);
    return {
      import: batchJson(b),
      files: files.map((f) => ({
        id: f.id, name: f.name,
        sheets: f.sheets.map((s) => {
          const m = maps.find((x) => x.fileId === f.id && x.sheet === s.name)!;
          return {
            name: s.name, rows: s.rows.length, headers: s.headers, entity: m.entity, columns: m.columns,
            samples: Object.fromEntries(s.headers.map((h, i) => [h, s.rows.map((r) => r[i]).filter((v) => v).slice(0, 3)])),
            context: s.context,
          };
        }),
      })),
    };
  });
  res.json(out);
});

const columnsSchema = z.record(z.string().max(80), z.string().max(300));
const mappingSchema = z.object({
  sheets: z.array(z.object({ fileId: z.number().int().positive(), sheet: z.string().max(300), entity: z.enum([...ENTITIES, "skip"] as [string, ...string[]]), columns: columnsSchema })).max(2000).optional(),
  options: z.object({ updateMode: z.enum(["fill", "overwrite"]), skipProblems: z.boolean(), markHistoryBilled: z.boolean(), applyAsDecision: z.boolean() }).partial().optional(),
  mappingId: z.number().int().positive().optional(),
});

importsRouter.put("/imports/:id/mapping", async (req, res) => {
  const id = batchId(req);
  const body = mappingSchema.parse(req.body);
  await withContext(req.ctx!, async (c) => {
    const firmId = req.ctx!.firmId!;
    const b = await loadBatch(c, firmId, id);
    editable(b);
    const files = await loadFiles(c, firmId, id);
    let sheets = mappingsFor(b, files);
    if (body.mappingId) {
      // A saved mapping applies to sheets with the same name, or else to sheets of the same kind, using the columns these sheets have.
      const saved = (await c.query<{ mapping: { sheets: { sheet: string; entity: string; columns: Record<string, string> }[] } }>(
        `SELECT mapping FROM import_mappings WHERE firm_id = $1 AND id = $2`, [firmId, body.mappingId],
      )).rows[0];
      if (!saved) throw httpError(404, "Saved mapping not found.");
      sheets = sheets.map((m) => {
        const f = files.find((x) => x.id === m.fileId)!;
        const s = f.sheets.find((x) => x.name === m.sheet)!;
        const hit = saved.mapping.sheets.find((x) => x.sheet.toLowerCase() === m.sheet.toLowerCase()) ?? saved.mapping.sheets.find((x) => x.entity === m.entity && x.entity !== "skip");
        if (!hit) return m;
        const cols = Object.fromEntries(Object.entries(hit.columns).filter(([, h]) => s.headers.includes(h)));
        return { ...m, entity: hit.entity as SheetMapping["entity"], columns: hit.entity === "skip" ? {} : { ...(hit.entity === m.entity ? m.columns : autoMap(hit.entity as Entity, s.headers)), ...cols } };
      });
    }
    if (body.sheets) {
      for (const m of body.sheets) {
        const f = files.find((x) => x.id === m.fileId);
        const s = f?.sheets.find((x) => x.name === m.sheet);
        if (!s) throw httpError(400, `There's no sheet "${m.sheet}" in this import.`);
        const fields = m.entity === "skip" ? [] : FIELDS[m.entity as Entity].map((x) => x.key);
        for (const [k, h] of Object.entries(m.columns)) {
          if (!fields.includes(k)) throw httpError(400, `"${k}" isn't a field for that kind of sheet.`);
          if (!s.headers.includes(h)) throw httpError(400, `"${h}" isn't a column in ${m.sheet}.`);
        }
        sheets = sheets.map((x) => (x.fileId === m.fileId && x.sheet === m.sheet ? (m as SheetMapping) : x));
      }
    }
    const options = { ...optionsOf(b), ...(body.options ?? {}) };
    await c.query(
      `UPDATE import_batches SET mapping = $3, options = $4, status = 'draft', mapping_name = COALESCE($5, mapping_name) WHERE firm_id = $1 AND id = $2`,
      [firmId, id, JSON.stringify({ sheets }), JSON.stringify(options), body.mappingId ? (await c.query(`SELECT name FROM import_mappings WHERE firm_id = $1 AND id = $2`, [firmId, body.mappingId])).rows[0]?.name ?? null : null],
    );
  });
  res.json({ ok: true });
});

async function plan(c: pg.PoolClient, firmId: number, b: BatchRow) {
  const files = await loadFiles(c, firmId, b.id);
  if (!files.length) throw httpError(409, "Add a file first.");
  const maps = mappingsFor(b, files);
  if (!maps.some((m) => m.entity !== "skip")) throw httpError(409, "Every sheet is set to Skip, so there's nothing to import.");
  return buildPlan(c, firmId, files, maps, optionsOf(b));
}

importsRouter.post("/imports/:id/preview", async (req, res) => {
  const id = batchId(req);
  const out = await withContext(req.ctx!, async (c) => {
    const firmId = req.ctx!.firmId!;
    const b = await loadBatch(c, firmId, id);
    editable(b);
    const p = await plan(c, firmId, b);
    await c.query(`DELETE FROM import_rows WHERE firm_id = $1 AND batch_id = $2`, [firmId, id]);
    // Stored in chunks so a whole-firm migration doesn't send one enormous statement.
    for (let i = 0; i < p.rows.length; i += 500) {
      const chunk = p.rows.slice(i, i + 500);
      await c.query(
        `INSERT INTO import_rows (firm_id, batch_id, position, file_name, sheet, row_no, entity, action, label, message, changes)
         SELECT $1, $2, x.position, x.file_name, x.sheet, x.row_no, x.entity, x.action, x.label, x.message, x.changes
           FROM jsonb_to_recordset($3::jsonb) AS x(position int, file_name text, sheet text, row_no int, entity text, action text, label text, message text, changes jsonb)`,
        [firmId, id, JSON.stringify(chunk.map((r, j) => ({
          position: i + j, file_name: r.src?.file ?? null, sheet: r.src?.sheet ?? null, row_no: r.src?.row ?? null, entity: r.entity, action: r.action,
          label: r.label.slice(0, 300) || "(blank)", message: r.message, changes: r.changes,
        })))],
      );
    }
    const summary = summarize(p);
    await c.query(`UPDATE import_batches SET status = 'previewed', previewed_at = now(), summary = $3 WHERE firm_id = $1 AND id = $2`, [firmId, id, JSON.stringify({ preview: summary })]);
    return summary;
  });
  res.json({ summary: out });
});

importsRouter.get("/imports/:id/rows", async (req, res) => {
  const id = batchId(req);
  const action = ["new", "update", "unchanged", "problem"].includes(String(req.query.action)) ? String(req.query.action) : null;
  const entity = (ENTITIES as readonly string[]).includes(String(req.query.entity)) ? String(req.query.entity) : null;
  const offset = Math.max(0, Math.min(1_000_000, Number(req.query.offset) || 0));
  const out = await withContext(req.ctx!, async (c) => {
    await loadBatch(c, req.ctx!.firmId!, id);
    const where = `firm_id = $1 AND batch_id = $2 AND ($3::text IS NULL OR action = $3) AND ($4::text IS NULL OR entity = $4)`;
    const rows = (await c.query(
      `SELECT position, file_name, sheet, row_no, entity, action, label, message, changes FROM import_rows WHERE ${where} ORDER BY position LIMIT 200 OFFSET $5`,
      [req.ctx!.firmId, id, action, entity, offset],
    )).rows;
    const total = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM import_rows WHERE ${where}`, [req.ctx!.firmId, id, action, entity])).rows[0].n;
    return { total, rows: rows.map((r) => ({ position: r.position, file: r.file_name, sheet: r.sheet, row: r.row_no, entity: r.entity, action: r.action, label: r.label, message: r.message, changes: r.changes })) };
  });
  res.json(out);
});

const csvCell = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
importsRouter.get("/imports/:id/problems.csv", async (req, res) => {
  const id = batchId(req);
  const rows = await withContext(req.ctx!, async (c) => {
    await loadBatch(c, req.ctx!.firmId!, id);
    return (await c.query(`SELECT file_name, sheet, row_no, entity, label, message FROM import_rows WHERE firm_id = $1 AND batch_id = $2 AND action = 'problem' ORDER BY position`, [req.ctx!.firmId, id])).rows;
  });
  const lines = [["File", "Sheet", "Row", "Kind", "Record", "Problem"], ...rows.map((r) => [r.file_name, r.sheet, r.row_no, ENTITY_LABELS[r.entity as Entity], r.label, r.message])];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="Import ${id} problems.csv"`);
  res.send(lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n");
});

/** Every check a commit makes, against the plan worked out again now. Throws the reason it can't go ahead. */
async function commitChecks(c: pg.PoolClient, req: Request, b: BatchRow) {
  const auth = req.auth!;
  const firmId = req.ctx!.firmId!;
  const p = await plan(c, firmId, b);
  const opts = optionsOf(b);
  const s = summarize(p);
  if (s.problems && !opts.skipProblems) throw httpError(409, `${s.problems} row${s.problems === 1 ? "" : "s"} can't be imported. Fix them in the file, or choose to leave them out.`, { problems: s.problems });
  const n = (e: string, a: string) => s.byEntity[e]?.[a] ?? 0;
  // Who may commit what: a firm admin for a migration or for new clients or properties; otherwise the role's own permissions.
  const creates = n("client", "new") + n("property", "new");
  if ((b.purpose === "migration" || creates) && !auth.user.isFirmAdmin) throw httpError(403, "Only a firm admin can import a firm's data or add clients and properties in bulk.");
  const needs: string[] = [];
  if (n("client", "update")) needs.push("accounts.edit");
  if (n("property", "update") + n("parcel", "new") + n("parcel", "update") + n("contact", "new") + n("contact", "update") + n("activity", "new")) needs.push("properties.edit");
  if (n("appeal", "new") + n("appeal", "update")) needs.push("appeals.edit");
  if (opts.applyAsDecision) needs.push("decisions.apply");
  if (!auth.user.isFirmAdmin) {
    for (const perm of needs) {
      const ok = (await c.query<{ allowed: boolean }>(`SELECT allowed FROM role_permissions WHERE firm_id = $1 AND role = $2 AND permission = $3`, [firmId, auth.user.role, perm])).rows[0]?.allowed === true;
      if (!ok) throw httpError(403, "Your role does not allow this import.");
    }
  }
  if (!s.total || s.total === s.problems || s.total === s.problems + Object.values(s.byEntity).reduce((a, e) => a + e.unchanged, 0)) {
    throw httpError(409, "Everything in this import is already in Appeal EyeQ or can't be brought in, so there's nothing to commit.");
  }
  return { p, opts, s };
}

importsRouter.post("/imports/:id/commit", async (req, res) => {
  const id = batchId(req);
  const ctx = req.ctx!;
  const firmId = ctx.firmId!;
  const size = await withContext(ctx, async (c) => {
    const b = await loadBatch(c, firmId, id);
    editable(b);
    if (b.status !== "previewed") throw httpError(409, "Preview the import first (the mapping or files changed since the last preview).");
    const { s } = await commitChecks(c, req, b);
    await c.query(`UPDATE import_batches SET status = 'committing', error = NULL WHERE firm_id = $1 AND id = $2`, [firmId, id]);
    return s.total - s.problems;
  });
  const userId = req.auth!.user.id;
  const r = await run(ctx, id, "commit", size, async (c, progress) => {
    const b = await loadBatch(c, firmId, id);
    await c.query(`SELECT 1 FROM import_batches WHERE firm_id = $1 AND id = $2 FOR UPDATE`, [firmId, id]);
    const { p, opts, s } = await commitChecks(c, req, { ...b, status: "previewed" });
    const applied = await applyPlan(c, firmId, userId, id, p, opts, b.purpose, progress);
    const summary = { preview: s, applied };
    await c.query(`UPDATE import_batches SET status = 'committed', committed_at = now(), committed_by = $3, summary = $4, error = NULL WHERE firm_id = $1 AND id = $2`, [firmId, id, userId, JSON.stringify(summary)]);
    return summary;
  }, "previewed");
  if (r.inline) res.json(r.result);
  else res.status(202).json({ running: true, total: size });
});

importsRouter.post("/imports/:id/undo", async (req, res) => {
  const id = batchId(req);
  const ctx = req.ctx!;
  const firmId = ctx.firmId!;
  const auth = req.auth!;
  const size = await withContext(ctx, async (c) => {
    const b = await loadBatch(c, firmId, id);
    if (b.status !== "committed") throw httpError(409, b.status === "undoing" ? "This import is being undone." : "Only a committed import can be undone.");
    if (!auth.user.isFirmAdmin && (await c.query(`SELECT committed_by FROM import_batches WHERE firm_id = $1 AND id = $2`, [firmId, id])).rows[0].committed_by !== auth.user.id) {
      throw httpError(403, "Only a firm admin or the person who committed it can undo an import.");
    }
    const later = (await c.query<{ id: number }>(
      `SELECT id FROM import_batches WHERE firm_id = $1 AND status IN ('committed', 'undoing') AND committed_at > (SELECT committed_at FROM import_batches WHERE firm_id = $1 AND id = $2) ORDER BY committed_at LIMIT 1`,
      [firmId, id],
    )).rows[0];
    if (later) throw httpError(409, `Import ${later.id} was committed after this one. Undo it first.`);
    const why = await undoCheck(c, firmId, id);
    if (why) throw httpError(409, why);
    await c.query(`UPDATE import_batches SET status = 'undoing', error = NULL WHERE firm_id = $1 AND id = $2`, [firmId, id]);
    return (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM import_effects WHERE firm_id = $1 AND batch_id = $2`, [firmId, id])).rows[0].n;
  });
  const r = await run(ctx, id, "undo", size, async (c) => {
    const b = await loadBatch(c, firmId, id);
    const result = await undoBatch(c, firmId, id);
    const summary = { ...(b.summary ?? {}), undo: result };
    await c.query(`UPDATE import_batches SET status = 'undone', undone_at = now(), undone_by = $3, summary = $4, error = NULL WHERE firm_id = $1 AND id = $2`, [firmId, id, auth.user.id, JSON.stringify(summary)]);
    return result;
  }, "committed");
  if (r.inline) res.json(r.result);
  else res.status(202).json({ running: true, total: size });
});

importsRouter.delete("/imports/:id", async (req, res) => {
  const id = batchId(req);
  await withContext(req.ctx!, async (c) => {
    const b = await loadBatch(c, req.ctx!.firmId!, id);
    if (b.status === "committed") throw httpError(409, "A committed import stays in the history. Undo it instead.");
    if (b.status === "committing" || b.status === "undoing") throw httpError(409, "This import is running. Wait for it to finish.");
    await c.query(`DELETE FROM import_batches WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id]);
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- saved mappings
importsRouter.get("/import-mappings", async (req, res) => {
  const rows = await withContext(req.ctx!, async (c) => (await c.query(
    `SELECT id, name, mapping, updated_at FROM import_mappings WHERE firm_id = $1 ORDER BY lower(name)`, [req.ctx!.firmId],
  )).rows);
  res.json({ mappings: rows.map((r) => ({ id: r.id, name: r.name, sheets: (r.mapping.sheets ?? []).length, updatedAt: r.updated_at })) });
});

/** Saves the import's current mapping under a name (replacing one of the same name). */
importsRouter.post("/import-mappings", async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1).max(120), importId: z.number().int().positive() }).parse(req.body);
  const out = await withContext(req.ctx!, async (c) => {
    const firmId = req.ctx!.firmId!;
    const b = await loadBatch(c, firmId, body.importId);
    const files = await loadFiles(c, firmId, b.id);
    const sheets = mappingsFor(b, files).map(({ sheet, entity, columns }) => ({ sheet, entity, columns }));
    const id = (await c.query<{ id: number }>(
      `INSERT INTO import_mappings (firm_id, name, mapping, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (firm_id, lower(name)) DO UPDATE SET mapping = EXCLUDED.mapping RETURNING id`,
      [firmId, body.name, JSON.stringify({ sheets }), req.auth!.user.id],
    )).rows[0].id;
    await c.query(`UPDATE import_batches SET mapping_name = $3 WHERE firm_id = $1 AND id = $2`, [firmId, b.id, body.name]);
    return id;
  });
  res.status(201).json({ id: out });
});

importsRouter.delete("/import-mappings/:id", async (req, res) => {
  const id = idParam(req);
  if (!id) throw httpError(400, "Invalid mapping.");
  await withContext(req.ctx!, async (c) => {
    const r = await c.query(`DELETE FROM import_mappings WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id]);
    if (!r.rowCount) throw httpError(404, "Saved mapping not found.");
  });
  res.json({ ok: true });
});
