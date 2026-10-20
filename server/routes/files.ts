// Dropbox: connecting the firm's account (firm admins), and each property's
// folder (browse, create from the template, rename to match, upload, open).
// Mounted under /api/firm after requireFirmContext. Every query runs inside
// withContext (row-level security) AND filters on firm_id.
//
// Support access never reaches client documents: the super admin gets 403
// on every file route, even while a firm has granted read-only access.

import { randomBytes } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import { withContext } from "../db.js";
import { requireFirmAdmin } from "../auth.js";
import { encryptSecret, hasEncryptionKey, sign, verify } from "../secrets.js";
import {
  DROPBOX_SCOPES, FirmDropbox, dropboxConfigured, dropboxUrls, exchangeToken, loadIntegration, rpcWithToken,
} from "../dropbox/client.js";
import { joinPath, safeName } from "../dropbox/folders.js";
import { propertyFilesRouter } from "./property-files.js";
import { documentsAdminRouter } from "./documents-admin.js";

export const filesRouter = Router();

const STATE_COOKIE = "aeq_dbx";
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
  // Dropbox's standard code flow for a server app: the app secret never leaves the server, and the
  // signed, short-lived state cookie ties the reply to this admin's sign-in.
  const cookie = sign({ state, firmId: req.ctx!.firmId, userId: req.auth!.user.id }, 600);
  const secure = req.secure || process.env.NODE_ENV === "production";
  res.setHeader("Set-Cookie", `${STATE_COOKIE}=${encodeURIComponent(cookie)}; HttpOnly; SameSite=Lax; Path=/api/firm/dropbox; Max-Age=600${secure ? "; Secure" : ""}`);
  const url = new URL(dropboxUrls().authorize);
  url.search = new URLSearchParams({
    client_id: process.env.DROPBOX_APP_KEY!,
    response_type: "code",
    token_access_type: "offline",
    redirect_uri: redirectUri(req),
    state,
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
  const saved = verify<{ state: string; firmId: number; userId: number }>(readCookie(req, STATE_COOKIE));
  if (!saved || saved.state !== req.query.state || saved.firmId !== req.ctx!.firmId || saved.userId !== req.auth!.user.id || !req.auth!.user.isFirmAdmin) {
    return back({ dropbox: "error", reason: "The Dropbox sign-in expired or didn't match. Start again from Connect Dropbox." });
  }
  if (typeof req.query.error === "string") return back({ dropbox: "error", reason: "Dropbox access wasn't approved, so nothing was connected." });
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code) return back({ dropbox: "error", reason: "Dropbox didn't send a sign-in code. Start again from Connect Dropbox." });

  let token: { access_token: string; expires_in: number; refresh_token?: string };
  let account: DbxAccount;
  // When Dropbox refuses, say which step and what Dropbox said (its error codes carry no secrets),
  // and log it, so a setup problem such as a mistyped app secret is visible instead of a generic retry.
  const failed = (step: string, err: unknown) => {
    const said = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 200);
    console.error(`Dropbox sign-in failed at ${step} for firm ${req.ctx!.firmId}: ${said}`);
    return back({ dropbox: "error", reason: `Dropbox didn't complete the sign-in (${step}: ${said}). If this repeats, check the Dropbox app key and secret in the server's settings.` });
  };
  try {
    token = await exchangeToken({ grant_type: "authorization_code", code, redirect_uri: redirectUri(req) });
  } catch (err) {
    return failed("token exchange", err);
  }
  try {
    account = await rpcWithToken<DbxAccount>(token.access_token, "users/get_current_account", null);
  } catch (err) {
    return failed("account lookup", err);
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

// ================================================================ a property's documents
// The property routes (browse, template, folders, rename, delete and restore, upload, previews,
// profiles, versions, Deadzone) live in property-files.ts; the firm's template and document
// types in documents-admin.ts.
filesRouter.use(propertyFilesRouter);
filesRouter.use(documentsAdminRouter);
