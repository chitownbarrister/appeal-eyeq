// Talks to the Dropbox API for one firm. Holds the firm's connection
// (decrypting tokens only in memory), refreshes the short-lived access token
// when needed, and, for a team account, addresses the team space so the
// "Appeal EyeQ" folder is shared by everyone on the firm's team.
//
// Endpoints are configurable so tests can point at a stand-in Dropbox.

import type pg from "pg";
import { withContext, type DbContext } from "../db.js";
import { decryptSecret, encryptSecret } from "../secrets.js";

export const dropboxUrls = () => ({
  api: process.env.DROPBOX_API_URL || "https://api.dropboxapi.com",
  content: process.env.DROPBOX_CONTENT_URL || "https://content.dropboxapi.com",
  authorize: process.env.DROPBOX_AUTHORIZE_URL || "https://www.dropbox.com/oauth2/authorize",
  web: process.env.DROPBOX_WEB_URL || "https://www.dropbox.com",
});

export function dropboxConfigured(): boolean {
  return Boolean(process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET);
}

/** Permissions Appeal EyeQ asks Dropbox for (tick the same boxes in the App Console). */
export const DROPBOX_SCOPES = ["account_info.read", "files.metadata.read", "files.metadata.write", "files.content.read", "files.content.write"];

export class DropboxError extends Error {
  constructor(public tag: string, public httpStatus: number, message: string) {
    super(message);
  }
}

/** Dropbox puts JSON in an HTTP header for content calls; anything outside ASCII must be escaped. */
export function headerJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

async function readError(res: Response): Promise<DropboxError> {
  const text = await res.text();
  let summary = text;
  try {
    const j = JSON.parse(text) as { error_summary?: string };
    summary = j.error_summary ?? text;
  } catch { /* plain text error */ }
  return new DropboxError(summary || `http_${res.status}`, res.status, summary || `Dropbox error ${res.status}`);
}

export async function exchangeToken(form: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string; account_id?: string }> {
  const res = await fetch(`${dropboxUrls().api}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...form, client_id: process.env.DROPBOX_APP_KEY!, client_secret: process.env.DROPBOX_APP_SECRET! }),
  });
  if (!res.ok) throw await readError(res);
  return res.json() as Promise<{ access_token: string; expires_in: number; refresh_token?: string; account_id?: string }>;
}

/** Calls an RPC endpoint with a raw access token (used during sign-in, before anything is stored). */
export async function rpcWithToken<T>(token: string, endpoint: string, args: unknown, pathRoot?: string | null): Promise<T> {
  const res = await fetch(`${dropboxUrls().api}/2/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(args === null ? {} : { "Content-Type": "application/json" }),
      ...(pathRoot ? { "Dropbox-API-Path-Root": headerJson({ ".tag": "root", root: pathRoot }) } : {}),
    },
    body: args === null ? undefined : JSON.stringify(args),
  });
  if (!res.ok) throw await readError(res);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export interface Integration {
  id: number; firm_id: number; account_id: string; account_email: string | null; account_name: string | null; account_type: string;
  team_name: string | null; root_namespace_id: string | null; uses_team_space: boolean; root_folder: string;
  refresh_token_enc: string; access_token_enc: string | null; access_expires_at: string | null;
  connected_by_user_id: number | null; connected_at: string;
}

export async function loadIntegration(c: pg.PoolClient, firmId: number): Promise<Integration | null> {
  return (await c.query<Integration>(`SELECT * FROM firm_integrations WHERE firm_id = $1 AND provider = 'dropbox'`, [firmId])).rows[0] ?? null;
}

/** A Dropbox session for one firm and one request. */
export class FirmDropbox {
  private token: string | null = null;
  constructor(private ctx: DbContext, public integration: Integration) {}

  static async open(ctx: DbContext): Promise<FirmDropbox | null> {
    const integration = await withContext(ctx, (c) => loadIntegration(c, ctx.firmId!));
    return integration ? new FirmDropbox(ctx, integration) : null;
  }

  private get pathRoot(): string | null {
    return this.integration.uses_team_space ? this.integration.root_namespace_id : null;
  }

  private async accessToken(force = false): Promise<string> {
    const i = this.integration;
    if (!force && this.token) return this.token;
    if (!force && i.access_token_enc && i.access_expires_at && new Date(i.access_expires_at).getTime() - Date.now() > 60_000) {
      this.token = decryptSecret(i.access_token_enc);
      return this.token;
    }
    const t = await exchangeToken({ grant_type: "refresh_token", refresh_token: decryptSecret(i.refresh_token_enc) });
    const expires = new Date(Date.now() + t.expires_in * 1000).toISOString();
    const enc = encryptSecret(t.access_token);
    // A super admin under a grant never reaches here (file routes refuse support access).
    await withContext(this.ctx, (c) =>
      c.query(`UPDATE firm_integrations SET access_token_enc = $3, access_expires_at = $4 WHERE firm_id = $1 AND id = $2`, [i.firm_id, i.id, enc, expires]),
    );
    i.access_token_enc = enc;
    i.access_expires_at = expires;
    this.token = t.access_token;
    return t.access_token;
  }

  /** RPC call; on an expired token it refreshes once and retries. */
  async rpc<T>(endpoint: string, args: unknown): Promise<T> {
    try {
      return await rpcWithToken<T>(await this.accessToken(), endpoint, args, this.pathRoot);
    } catch (err) {
      if (err instanceof DropboxError && err.httpStatus === 401) return rpcWithToken<T>(await this.accessToken(true), endpoint, args, this.pathRoot);
      throw err;
    }
  }

  async upload(path: string, body: Buffer): Promise<{ name: string; path_display: string; size: number; id: string; rev: string; server_modified: string }> {
    const send = async (token: string) =>
      fetch(`${dropboxUrls().content}/2/files/upload`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": headerJson({ path, mode: "add", autorename: true, mute: false }),
          ...(this.pathRoot ? { "Dropbox-API-Path-Root": headerJson({ ".tag": "root", root: this.pathRoot }) } : {}),
        },
        body,
      });
    let res = await send(await this.accessToken());
    if (res.status === 401) res = await send(await this.accessToken(true));
    if (!res.ok) throw await readError(res);
    return res.json() as Promise<{ name: string; path_display: string; size: number; id: string; rev: string; server_modified: string }>;
  }

  /**
   * A content-download call (files/download, files/get_preview): the argument goes in the
   * Dropbox-API-Arg header, the body comes back as bytes and the metadata in Dropbox-API-Result.
   */
  async content(endpoint: "files/download" | "files/get_preview", arg: Record<string, unknown>, maxBytes: number): Promise<{ body: Buffer; contentType: string; result: Record<string, unknown> }> {
    const send = async (token: string) =>
      fetch(`${dropboxUrls().content}/2/${endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Dropbox-API-Arg": headerJson(arg),
          ...(this.pathRoot ? { "Dropbox-API-Path-Root": headerJson({ ".tag": "root", root: this.pathRoot }) } : {}),
        },
      });
    let res = await send(await this.accessToken());
    if (res.status === 401) res = await send(await this.accessToken(true));
    if (!res.ok) throw await readError(res);
    const length = Number(res.headers.get("content-length") || 0);
    if (length > maxBytes) {
      await res.body?.cancel();
      throw Object.assign(new Error("too big"), { status: 413, publicMessage: "That file is too large to show here. Download it or open it in its app instead." });
    }
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > maxBytes) throw Object.assign(new Error("too big"), { status: 413, publicMessage: "That file is too large to show here. Download it or open it in its app instead." });
    let result: Record<string, unknown> = {};
    try { result = JSON.parse(res.headers.get("dropbox-api-result") || "{}"); } catch { /* no metadata */ }
    return { body, contentType: res.headers.get("content-type") || "application/octet-stream", result };
  }
}
