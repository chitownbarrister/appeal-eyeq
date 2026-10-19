// The folder template for a property and the operations on it:
//
//   <root>/<Client>/<PIN – Address, City (Township)>/Appeals/<year>/<ASSR | BOR | PTAB | Circuit Court>
//
// Each property's folder is remembered by Dropbox's folder id, which survives
// renames, so the link holds even if someone moves the folder in Dropbox. A
// folder that already exists at the template path is reused, never duplicated.

import { DropboxError, dropboxUrls, type FirmDropbox } from "./client.js";
import type { Level } from "../../shared/domain.js";

export const LEVEL_FOLDER: Record<Level, string> = { assessor: "ASSR", bor: "BOR", ptab: "PTAB", circuit: "Circuit Court" };

/** Characters Dropbox (and Windows, where the desktop app syncs) won't take in a name. */
export function safeName(name: string): string {
  const s = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  return (s || "Untitled").slice(0, 200);
}

export function joinPath(...parts: string[]): string {
  return `/${parts.flatMap((p) => p.split("/")).filter(Boolean).join("/")}`;
}

export function expectedPropertyPath(root: string, clientName: string, matterTitle: string): string {
  return joinPath(root, safeName(clientName), safeName(matterTitle));
}

/** A path inside the property folder from the browser; refuses anything that climbs out. */
export function cleanRelative(rel: string | undefined | null): string {
  const parts = String(rel ?? "").split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === ".." || /[\u0000-\u001f]/.test(p))) {
    throw Object.assign(new Error("path"), { status: 400, publicMessage: "That folder isn't inside this property's folder." });
  }
  return parts.join("/");
}

const isTag = (err: unknown, tag: string) => err instanceof DropboxError && err.tag.includes(tag);

export function friendlyDropboxError(err: unknown): { status: number; publicMessage: string } | null {
  if (!(err instanceof DropboxError)) return null;
  if (err.httpStatus === 401 || isTag(err, "invalid_access_token") || isTag(err, "invalid_grant")) {
    return { status: 409, publicMessage: "Dropbox no longer accepts this connection. A firm admin needs to reconnect Dropbox in Settings, Integrations." };
  }
  if (isTag(err, "no_write_permission")) {
    return { status: 409, publicMessage: "Dropbox won't let this account write there. Ask your Dropbox team admin to create the Appeal EyeQ team folder and give this account edit access, then try again." };
  }
  if (isTag(err, "insufficient_space")) return { status: 409, publicMessage: "The firm's Dropbox is out of space." };
  if (isTag(err, "not_found")) return { status: 404, publicMessage: "That file or folder isn't in Dropbox any more." };
  if (err.httpStatus === 429) return { status: 503, publicMessage: "Dropbox is busy. Wait a minute and try again." };
  return { status: 502, publicMessage: "Dropbox didn't complete the request. Try again in a moment." };
}

interface Metadata { ".tag": "file" | "folder" | "deleted"; id?: string; name: string; path_display?: string; path_lower?: string; size?: number; server_modified?: string; client_modified?: string }

/** Creates a folder, or returns the one already there. */
export async function ensureFolder(dbx: FirmDropbox, path: string): Promise<{ id: string; path_display: string }> {
  try {
    const r = await dbx.rpc<{ metadata: Metadata }>("files/create_folder_v2", { path, autorename: false });
    return { id: r.metadata.id!, path_display: r.metadata.path_display! };
  } catch (err) {
    if (!isTag(err, "path/conflict")) throw err;
    const m = await dbx.rpc<Metadata>("files/get_metadata", { path });
    if (m[".tag"] !== "folder") {
      throw Object.assign(new Error("file in the way"), { status: 409, publicMessage: `There's a file named ${m.name} where the folder should be. Rename it in Dropbox, then try again.` });
    }
    return { id: m.id!, path_display: m.path_display! };
  }
}

/** Current location of a remembered folder, or null if it was deleted in Dropbox. */
export async function locate(dbx: FirmDropbox, folderId: string): Promise<{ id: string; path_display: string } | null> {
  try {
    const m = await dbx.rpc<Metadata>("files/get_metadata", { path: folderId });
    return m[".tag"] === "folder" ? { id: m.id!, path_display: m.path_display! } : null;
  } catch (err) {
    if (isTag(err, "not_found")) return null;
    throw err;
  }
}

export async function moveFolder(dbx: FirmDropbox, folderId: string, to: string): Promise<{ id: string; path_display: string }> {
  const r = await dbx.rpc<{ metadata: Metadata }>("files/move_v2", { from_path: folderId, to_path: to, autorename: false });
  return { id: r.metadata.id!, path_display: r.metadata.path_display! };
}

export interface Entry { name: string; kind: "file" | "folder"; size: number | null; modified: string | null; relPath: string; webUrl: string }

export function webUrl(path: string, isFile: boolean): string {
  const base = dropboxUrls().web;
  if (!isFile) return `${base}/home${path.split("/").map(encodeURIComponent).join("/")}`;
  const slash = path.lastIndexOf("/");
  const parent = path.slice(0, slash) || "";
  return `${base}/home${parent.split("/").map(encodeURIComponent).join("/")}?preview=${encodeURIComponent(path.slice(slash + 1))}`;
}

export async function listFolder(dbx: FirmDropbox, folderPath: string, rel: string): Promise<Entry[]> {
  const out: Metadata[] = [];
  let page = await dbx.rpc<{ entries: Metadata[]; cursor: string; has_more: boolean }>("files/list_folder", { path: rel ? joinPath(folderPath, rel) : folderPath, recursive: false, limit: 500 });
  out.push(...page.entries);
  let guard = 0;
  while (page.has_more && guard++ < 20) {
    page = await dbx.rpc("files/list_folder/continue", { cursor: page.cursor });
    out.push(...page.entries);
  }
  return out
    .filter((m) => m[".tag"] === "file" || m[".tag"] === "folder")
    .map((m) => ({
      name: m.name,
      kind: m[".tag"] as "file" | "folder",
      size: m[".tag"] === "file" ? m.size ?? null : null,
      modified: m.server_modified ?? null,
      relPath: rel ? `${rel}/${m.name}` : m.name,
      webUrl: webUrl(m.path_display ?? joinPath(folderPath, rel, m.name), m[".tag"] === "file"),
    }))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === "folder" ? -1 : 1));
}

export async function temporaryLink(dbx: FirmDropbox, path: string): Promise<string> {
  return (await dbx.rpc<{ link: string }>("files/get_temporary_link", { path })).link;
}
