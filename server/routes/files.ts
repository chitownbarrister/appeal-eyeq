// Dropbox: connecting the firm's account (firm admins), and each property's
// folder (browse, create from the template, rename to match, upload, open).
// Mounted under /api/firm after requireFirmContext. Every query runs inside
// withContext (row-level security) AND filters on firm_id.
//
// Support access never reaches client documents: the super admin gets 403
// on every file route, even while a firm has granted read-only access.

import { randomBytes, createHash } from "node:crypto";
import express, { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { withContext } from "../db.js";
import { requireFirmAdmin, requirePermission } from "../auth.js";
import { matterTitle } from "../../shared/domain.js";
import { encryptSecret, hasEncryptionKey, sign, verify } from "../secrets.js";
import {
  DropboxError, DROPBOX_SCOPES, FirmDropbox, dropboxConfigured, dropboxUrls, exchangeToken, loadIntegration, rpcWithToken,
} from "../dropbox/client.js";
import {
  LEVEL_FOLDER, cleanRelative, ensureFolder, expectedPropertyPath, friendlyDropboxError, joinPath, listFolder, locate, moveFolder,
  safeName, temporaryLink, webUrl,
} from "../dropbox/folders.js";

export const filesRouter = Router();

const STATE_COOKIE = "aeq_dbx";
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function noSupportAccess(req: Request, res: Response, next: NextFunction): void {
  if (req.auth?.user.isSuperAdmin) {
    res.status(403).json({ error: "Client files aren't available under support access." });
    return;
  }
  next();
}

function idParam(req: Request): number | null {
  const n = Number(req.params.id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Turns a Dropbox failure into a plain message for the user. */
async function dropboxCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const friendly = friendlyDropboxError(err);
    if (friendly) throw Object.assign(new Error("dropbox"), friendly);
    throw err;
  }
}

function redirectUri(req: Request): string {
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return `${base.replace(/\/$/, "")}/api/firm/dropbox/callback`;
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

async function auditIntegration(req: Request, action: "INSERT" | "DELETE", detail: Record<string, unknown>): Promise<void> {
  await withContext(req.ctx!, (c) =>
    c.query(
      `INSERT INTO audit_log (firm_id, actor_user_id, actor_kind, table_name, row_id, action, before, after)
       VALUES ($1, $2, $3, 'firm_integrations', 'dropbox', $4, $5, $6)`,
      [req.ctx!.firmId, req.ctx!.userId, req.ctx!.actorKind, action, action === "DELETE" ? detail : null, action === "INSERT" ? detail : null],
    ),
  );
}

// ================================================================ the firm's connection
filesRouter.get("/integrations", async (req, res) => {
  const row = await withContext(req.ctx!, (c) => loadIntegration(c, req.ctx!.firmId!));
  const firm = await withContext(req.ctx!, async (c) => (await c.query<{ is_sample: boolean }>(`SELECT is_sample FROM firms WHERE id = $1`, [req.ctx!.firmId])).rows[0]);
  const by = row?.connected_by_user_id
    ? await withContext(req.ctx!, async (c) => (await c.query<{ name: string }>(`SELECT name FROM users WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, row.connected_by_user_id])).rows[0]?.name ?? null)
    : null;
  res.json({
    dropbox: {
      configured: dropboxConfigured() && hasEncryptionKey(),
      requiresTeamPlan: !firm?.is_sample,
      scopes: DROPBOX_SCOPES,
      connected: Boolean(row),
      ...(row ? {
        accountEmail: row.account_email, accountName: row.account_name, accountType: row.account_type, teamName: row.team_name,
        usesTeamSpace: row.uses_team_space, rootFolder: row.root_folder, connectedAt: row.connected_at, connectedBy: by,
      } : {}),
    },
  });
});

filesRouter.post("/integrations/dropbox/connect", requireFirmAdmin, async (req, res) => {
  if (!dropboxConfigured() || !hasEncryptionKey()) {
    res.status(503).json({ error: "Dropbox isn't set up on this server yet. The app key, app secret and encryption key need to be added to the server's settings." });
    return;
  }
  const state = randomBytes(18).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const cookie = sign({ state, verifier, firmId: req.ctx!.firmId, userId: req.auth!.user.id }, 600);
  const secure = req.secure || process.env.NODE_ENV === "production";
  res.setHeader("Set-Cookie", `${STATE_COOKIE}=${encodeURIComponent(cookie)}; HttpOnly; SameSite=Lax; Path=/api/firm/dropbox; Max-Age=600${secure ? "; Secure" : ""}`);
  const url = new URL(dropboxUrls().authorize);
  url.search = new URLSearchParams({
    client_id: process.env.DROPBOX_APP_KEY!,
    response_type: "code",
    token_access_type: "offline",
    redirect_uri: redirectUri(req),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: DROPBOX_SCOPES.join(" "),
  }).toString();
  res.json({ url: url.toString() });
});

interface DbxAccount {
  account_id: string; email: string; name: { display_name: string };
  account_type: { ".tag": string }; team?: { name: string } | null;
  root_info: { ".tag": "team" | "user"; root_namespace_id: string; home_namespace_id: string };
}

/** Dropbox sends the browser back here after the firm admin approves (or declines). */
filesRouter.get("/dropbox/callback", async (req, res) => {
  const back = (q: Record<string, string>) => res.redirect(302, `/settings?${new URLSearchParams({ tab: "integrations", ...q })}`);
  res.setHeader("Set-Cookie", `${STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/api/firm/dropbox; Max-Age=0`);
  const saved = verify<{ state: string; verifier: string; firmId: number; userId: number }>(readCookie(req, STATE_COOKIE));
  if (!saved || saved.state !== req.query.state || saved.firmId !== req.ctx!.firmId || saved.userId !== req.auth!.user.id || !req.auth!.user.isFirmAdmin) {
    return back({ dropbox: "error", reason: "The Dropbox sign-in expired or didn't match. Start again from Connect Dropbox." });
  }
  if (typeof req.query.error === "string") return back({ dropbox: "error", reason: "Dropbox access wasn't approved, so nothing was connected." });
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code) return back({ dropbox: "error", reason: "Dropbox didn't send a sign-in code. Start again from Connect Dropbox." });

  let token: { access_token: string; expires_in: number; refresh_token?: string };
  let account: DbxAccount;
  try {
    token = await exchangeToken({ grant_type: "authorization_code", code, redirect_uri: redirectUri(req), code_verifier: saved.verifier });
    account = await rpcWithToken<DbxAccount>(token.access_token, "users/get_current_account", null);
  } catch {
    return back({ dropbox: "error", reason: "Dropbox didn't complete the sign-in. Try again in a moment." });
  }
  const isSample = await withContext(req.ctx!, async (c) => (await c.query<{ is_sample: boolean }>(`SELECT is_sample FROM firms WHERE id = $1`, [req.ctx!.firmId])).rows[0]?.is_sample);
  const isTeam = account.account_type[".tag"] === "business";
  if (!isTeam && !isSample) {
    await rpcWithToken(token.access_token, "auth/token/revoke", null).catch(() => undefined);
    return back({ dropbox: "error", reason: "That's a personal Dropbox account. Appeal EyeQ needs a Dropbox team plan (Standard or Advanced), so the firm, not one person, owns client files." });
  }
  if (!token.refresh_token) return back({ dropbox: "error", reason: "Dropbox didn't grant lasting access. Start again from Connect Dropbox." });

  const usesTeamSpace = account.root_info[".tag"] === "team";
  const values = [
    req.ctx!.firmId, account.account_id, account.email, account.name.display_name, account.account_type[".tag"], account.team?.name ?? null,
    usesTeamSpace ? account.root_info.root_namespace_id : null, usesTeamSpace, encryptSecret(token.refresh_token), encryptSecret(token.access_token),
    new Date(Date.now() + token.expires_in * 1000).toISOString(), req.auth!.user.id,
  ];
  await withContext(req.ctx!, (c) =>
    c.query(
      `INSERT INTO firm_integrations (firm_id, provider, account_id, account_email, account_name, account_type, team_name, root_namespace_id,
                                      uses_team_space, refresh_token_enc, access_token_enc, access_expires_at, connected_by_user_id)
       VALUES ($1, 'dropbox', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (firm_id, provider) DO UPDATE SET
         account_id = EXCLUDED.account_id, account_email = EXCLUDED.account_email, account_name = EXCLUDED.account_name,
         account_type = EXCLUDED.account_type, team_name = EXCLUDED.team_name, root_namespace_id = EXCLUDED.root_namespace_id,
         uses_team_space = EXCLUDED.uses_team_space, refresh_token_enc = EXCLUDED.refresh_token_enc, access_token_enc = EXCLUDED.access_token_enc,
         access_expires_at = EXCLUDED.access_expires_at, connected_by_user_id = EXCLUDED.connected_by_user_id, connected_at = now()`,
      values,
    ),
  );
  await auditIntegration(req, "INSERT", { provider: "dropbox", account_email: account.email, account_type: account.account_type[".tag"], team_name: account.team?.name ?? null });
  back({ dropbox: "connected" });
});

const RootFolder = z.object({
  rootFolder: z.string().trim().min(1, "Name the folder").max(200).transform((v) => joinPath(...v.split("/").map(safeName))),
});

filesRouter.patch("/integrations/dropbox", requireFirmAdmin, async (req, res) => {
  const parsed = RootFolder.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0].message }); return; }
  const r = await withContext(req.ctx!, (c) =>
    c.query(`UPDATE firm_integrations SET root_folder = $2 WHERE firm_id = $1 AND provider = 'dropbox' RETURNING root_folder`, [req.ctx!.firmId, parsed.data.rootFolder]),
  );
  if (!r.rowCount) { res.status(404).json({ error: "Dropbox isn't connected." }); return; }
  res.json({ rootFolder: r.rows[0].root_folder });
});

filesRouter.delete("/integrations/dropbox", requireFirmAdmin, async (req, res) => {
  const dbx = await FirmDropbox.open(req.ctx!);
  if (!dbx) { res.status(404).json({ error: "Dropbox isn't connected." }); return; }
  await dbx.rpc("auth/token/revoke", null).catch(() => undefined); // disconnecting works even if Dropbox already dropped the token
  await withContext(req.ctx!, (c) => c.query(`DELETE FROM firm_integrations WHERE firm_id = $1 AND provider = 'dropbox'`, [req.ctx!.firmId]));
  await auditIntegration(req, "DELETE", { provider: "dropbox", account_email: dbx.integration.account_email, team_name: dbx.integration.team_name });
  res.json({ ok: true });
});

// ================================================================ a property's folder
interface PropertyForFiles { id: number; title: string; client: string; appeals: { assessment_year: number; level: keyof typeof LEVEL_FOLDER }[] }

async function propertyForFiles(req: Request, pid: number): Promise<{ p: PropertyForFiles; link: { folder_id: string; path_display: string } | null } | null> {
  return withContext(req.ctx!, async (c) => {
    const p = (await c.query(
      `SELECT p.id, p.name, p.address1, p.city, t.name AS township, ac.name AS client,
              (SELECT x.pin FROM parcels x WHERE x.firm_id = p.firm_id AND x.property_id = p.id ORDER BY x.is_primary DESC, x.id LIMIT 1) AS pin
         FROM properties p JOIN accounts ac ON ac.firm_id = p.firm_id AND ac.id = p.account_id
         LEFT JOIN townships t ON t.id = p.township_id
        WHERE p.firm_id = $1 AND p.id = $2`,
      [req.ctx!.firmId, pid],
    )).rows[0];
    if (!p) return null;
    const appeals = (await c.query(`SELECT DISTINCT assessment_year, level FROM appeals WHERE firm_id = $1 AND property_id = $2`, [req.ctx!.firmId, pid])).rows;
    const link = (await c.query(`SELECT folder_id, path_display FROM property_folders WHERE firm_id = $1 AND property_id = $2 AND provider = 'dropbox'`, [req.ctx!.firmId, pid])).rows[0] ?? null;
    return { p: { id: p.id, title: matterTitle(p.pin, p.address1 || p.name, p.city, p.township), client: p.client, appeals }, link };
  });
}

/** Finds the property's linked folder where it is now (following renames), or null if it's gone. */
async function currentFolder(req: Request, dbx: FirmDropbox, pid: number, link: { folder_id: string; path_display: string } | null) {
  if (!link) return null;
  const now = await locate(dbx, link.folder_id);
  if (!now) {
    await withContext(req.ctx!, (c) => c.query(`DELETE FROM property_folders WHERE firm_id = $1 AND property_id = $2 AND provider = 'dropbox'`, [req.ctx!.firmId, pid]));
    return null;
  }
  if (now.path_display !== link.path_display) {
    await withContext(req.ctx!, (c) => c.query(`UPDATE property_folders SET path_display = $3 WHERE firm_id = $1 AND property_id = $2 AND provider = 'dropbox'`, [req.ctx!.firmId, pid, now.path_display]));
  }
  return now;
}

function breadcrumbs(rel: string): { name: string; relPath: string }[] {
  const parts = rel ? rel.split("/") : [];
  return parts.map((name, i) => ({ name, relPath: parts.slice(0, i + 1).join("/") }));
}

filesRouter.get("/properties/:id/files", noSupportAccess, async (req, res) => {
  const pid = idParam(req);
  if (!pid) { res.status(400).json({ error: "Invalid property." }); return; }
  const rel = cleanRelative(String(req.query.path ?? ""));
  const found = await propertyForFiles(req, pid);
  if (!found) { res.status(404).json({ error: "Property not found." }); return; }
  const dbx = await FirmDropbox.open(req.ctx!);
  if (!dbx) {
    res.json({ connected: false, configured: dropboxConfigured() && hasEncryptionKey() });
    return;
  }
  const expected = expectedPropertyPath(dbx.integration.root_folder, found.p.client, found.p.title);
  const folder = await dropboxCall(() => currentFolder(req, dbx, pid, found.link));
  if (!folder) {
    res.json({ connected: true, folder: null, expectedPath: expected });
    return;
  }
  const entries = await dropboxCall(() => listFolder(dbx, folder.path_display, rel));
  res.json({
    connected: true,
    folder: {
      path: folder.path_display,
      webUrl: webUrl(rel ? joinPath(folder.path_display, rel) : folder.path_display, false),
      outOfDate: folder.path_display.toLowerCase() !== expected.toLowerCase(),
    },
    expectedPath: expected,
    path: rel,
    breadcrumbs: breadcrumbs(rel),
    entries,
  });
});

/** Creates the property's folder from the template (or links the one already at that path) and the folders for each appeal. */
filesRouter.post("/properties/:id/files/ensure", noSupportAccess, requirePermission("properties.edit"), async (req, res) => {
  const pid = idParam(req);
  if (!pid) { res.status(400).json({ error: "Invalid property." }); return; }
  const found = await propertyForFiles(req, pid);
  if (!found) { res.status(404).json({ error: "Property not found." }); return; }
  const dbx = await FirmDropbox.open(req.ctx!);
  if (!dbx) { res.status(409).json({ error: "Dropbox isn't connected. A firm admin can connect it in Settings, Integrations." }); return; }
  const expected = expectedPropertyPath(dbx.integration.root_folder, found.p.client, found.p.title);
  const result = await dropboxCall(async () => {
    let folder = await currentFolder(req, dbx, pid, found.link);
    let created = false;
    if (!folder) {
      const made = await ensureFolder(dbx, expected);
      folder = made;
      created = true;
      await withContext(req.ctx!, (c) =>
        c.query(
          `INSERT INTO property_folders (firm_id, property_id, provider, folder_id, path_display) VALUES ($1, $2, 'dropbox', $3, $4)
           ON CONFLICT (firm_id, property_id, provider) DO UPDATE SET folder_id = EXCLUDED.folder_id, path_display = EXCLUDED.path_display`,
          [req.ctx!.firmId, pid, made.id, made.path_display],
        ),
      );
    }
    for (const a of found.p.appeals) {
      await ensureFolder(dbx, joinPath(folder.path_display, "Appeals", String(a.assessment_year), LEVEL_FOLDER[a.level]));
    }
    if (!found.p.appeals.length) await ensureFolder(dbx, joinPath(folder.path_display, "Appeals"));
    return { folder, created };
  });
  res.json({ path: result.folder.path_display, linked: result.created });
});

/** Moves the folder to the name the template gives it now (after a client or address change). */
filesRouter.post("/properties/:id/files/move", noSupportAccess, requirePermission("properties.edit"), async (req, res) => {
  const pid = idParam(req);
  if (!pid) { res.status(400).json({ error: "Invalid property." }); return; }
  const found = await propertyForFiles(req, pid);
  if (!found) { res.status(404).json({ error: "Property not found." }); return; }
  const dbx = await FirmDropbox.open(req.ctx!);
  if (!dbx) { res.status(409).json({ error: "Dropbox isn't connected." }); return; }
  const expected = expectedPropertyPath(dbx.integration.root_folder, found.p.client, found.p.title);
  const moved = await dropboxCall(async () => {
    const folder = await currentFolder(req, dbx, pid, found.link);
    if (!folder) throw Object.assign(new Error("none"), { status: 404, publicMessage: "This property has no Dropbox folder yet." });
    if (folder.path_display.toLowerCase() === expected.toLowerCase()) return folder;
    try {
      return await moveFolder(dbx, folder.id, expected);
    } catch (err) {
      if (err instanceof DropboxError && err.tag.includes("conflict")) {
        throw Object.assign(new Error("taken"), { status: 409, publicMessage: `A folder already exists at ${expected}. Merge or rename it in Dropbox, then try again.` });
      }
      throw err;
    }
  });
  await withContext(req.ctx!, (c) =>
    c.query(`UPDATE property_folders SET path_display = $3 WHERE firm_id = $1 AND property_id = $2 AND provider = 'dropbox'`, [req.ctx!.firmId, pid, moved.path_display]),
  );
  res.json({ path: moved.path_display });
});

filesRouter.post(
  "/properties/:id/files/upload",
  noSupportAccess,
  requirePermission("properties.edit"),
  express.raw({ type: "application/octet-stream", limit: MAX_UPLOAD_BYTES }),
  async (req, res) => {
    const pid = idParam(req);
    if (!pid) { res.status(400).json({ error: "Invalid property." }); return; }
    const rel = cleanRelative(String(req.query.path ?? ""));
    const name = safeName(String(req.query.name ?? ""));
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) { res.status(400).json({ error: "The file is empty." }); return; }
    const found = await propertyForFiles(req, pid);
    if (!found) { res.status(404).json({ error: "Property not found." }); return; }
    const dbx = await FirmDropbox.open(req.ctx!);
    if (!dbx) { res.status(409).json({ error: "Dropbox isn't connected." }); return; }
    const saved = await dropboxCall(async () => {
      const folder = await currentFolder(req, dbx, pid, found.link);
      if (!folder) throw Object.assign(new Error("none"), { status: 409, publicMessage: "Create this property's Dropbox folder first." });
      return dbx.upload(joinPath(folder.path_display, rel, name), req.body as Buffer);
    });
    res.status(201).json({ name: saved.name, size: saved.size });
  },
);

/** Downloads a file through a short-lived Dropbox link. */
filesRouter.get("/properties/:id/files/download", noSupportAccess, async (req, res) => {
  const pid = idParam(req);
  if (!pid) { res.status(400).json({ error: "Invalid property." }); return; }
  const rel = cleanRelative(String(req.query.path ?? ""));
  if (!rel) { res.status(400).json({ error: "Choose a file." }); return; }
  const found = await propertyForFiles(req, pid);
  if (!found) { res.status(404).json({ error: "Property not found." }); return; }
  const dbx = await FirmDropbox.open(req.ctx!);
  if (!dbx) { res.status(409).json({ error: "Dropbox isn't connected." }); return; }
  const link = await dropboxCall(async () => {
    const folder = await currentFolder(req, dbx, pid, found.link);
    if (!folder) throw Object.assign(new Error("none"), { status: 404, publicMessage: "This property has no Dropbox folder yet." });
    return temporaryLink(dbx, joinPath(folder.path_display, rel));
  });
  res.redirect(302, link);
});
