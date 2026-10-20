// A property's Dropbox folder and the operations on it:
//
//   <root>/<Client>/<PIN – Address, City (Township)>/<template folders>, Appeals/<year>/<level folder>
//   <root>/Deadzone/<Client>/<PIN – Address, City (Township)>   (closed matters, moved aside)
//
// The template itself (folder names, level names) is per firm; see server/documents.ts.
// Each property's folder is remembered by Dropbox's folder id, which survives
// renames, so the link holds even if someone moves the folder in Dropbox. A
// folder that already exists at the template path is reused, never duplicated.

import { DropboxError, dropboxUrls, type FirmDropbox } from "./client.js";
import { DEADZONE_FOLDER } from "../../shared/documents.js";

/** Characters Dropbox (and Windows, where the desktop app syncs) won't take in a name. */
export function safeName(name: string): string {
  const s = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  return (s || "Untitled").slice(0, 200);
}

export function joinPath(...parts: string[]): string {
  return `/${parts.flatMap((p) => p.split("/")).filter(Boolean).join("/")}`;
}

export function expectedPropertyPath(root: string, clientName: string, matterTitle: string, inDeadzone = false): string {
  return inDeadzone
    ? joinPath(root, DEADZONE_FOLDER, safeName(clientName), safeName(matterTitle))
    : joinPath(root, safeName(clientName), safeName(matterTitle));
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

export interface Metadata {
  ".tag": "file" | "folder" | "deleted"; id?: string; name: string; path_display?: string; path_lower?: string;
  size?: number; server_modified?: string; client_modified?: string; rev?: string; content_hash?: string;
}

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

export interface Entry { id: string; rev: string | null; name: string; kind: "file" | "folder"; size: number | null; modified: string | null; relPath: string; path: string; webUrl: string }

export function webUrl(path: string, isFile: boolean): string {
  const base = dropboxUrls().web;
  if (!isFile) return `${base}/home${path.split("/").map(encodeURIComponent).join("/")}`;
  const slash = path.lastIndexOf("/");
  const parent = path.slice(0, slash) || "";
  return `${base}/home${parent.split("/").map(encodeURIComponent).join("/")}?preview=${encodeURIComponent(path.slice(slash + 1))}`;
}

async function listRaw(dbx: FirmDropbox, path: string, recursive: boolean, maxPages = 20): Promise<Metadata[]> {
  const out: Metadata[] = [];
  let page = await dbx.rpc<{ entries: Metadata[]; cursor: string; has_more: boolean }>("files/list_folder", { path, recursive, limit: 2000 });
  out.push(...page.entries);
  let guard = 0;
  while (page.has_more && guard++ < maxPages) {
    page = await dbx.rpc("files/list_folder/continue", { cursor: page.cursor });
    out.push(...page.entries);
  }
  return out;
}

/** Every file under a folder, at any depth (for the document index and for deleting a folder). */
export async function listAllFiles(dbx: FirmDropbox, path: string): Promise<Metadata[]> {
  return (await listRaw(dbx, path, true)).filter((m) => m[".tag"] === "file");
}

export async function listFolder(dbx: FirmDropbox, folderPath: string, rel: string): Promise<Entry[]> {
  const out = await listRaw(dbx, rel ? joinPath(folderPath, rel) : folderPath, false);
  return out
    .filter((m) => m[".tag"] === "file" || m[".tag"] === "folder")
    .map((m) => ({
      id: m.id ?? "",
      rev: m.rev ?? null,
      path: m.path_display ?? joinPath(folderPath, rel, m.name),
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

export async function metadata(dbx: FirmDropbox, path: string): Promise<Metadata | null> {
  try {
    return await dbx.rpc<Metadata>("files/get_metadata", { path });
  } catch (err) {
    if (isTag(err, "not_found")) return null;
    throw err;
  }
}

/** Renames or moves a file or folder; refuses to overwrite. */
export async function movePath(dbx: FirmDropbox, from: string, to: string): Promise<Metadata> {
  try {
    return (await dbx.rpc<{ metadata: Metadata }>("files/move_v2", { from_path: from, to_path: to, autorename: false })).metadata;
  } catch (err) {
    if (isTag(err, "conflict")) throw Object.assign(new Error("taken"), { status: 409, publicMessage: "Something with that name is already there. Choose another name." });
    throw err;
  }
}

export async function deletePath(dbx: FirmDropbox, path: string): Promise<void> {
  await dbx.rpc("files/delete_v2", { path });
}

export async function restoreFile(dbx: FirmDropbox, path: string, rev: string): Promise<Metadata> {
  return dbx.rpc<Metadata>("files/restore", { path, rev });
}

export async function listRevisions(dbx: FirmDropbox, fileId: string, limit = 20): Promise<Metadata[]> {
  const r = await dbx.rpc<{ entries: Metadata[] }>("files/list_revisions", { path: fileId, mode: "id", limit });
  return r.entries;
}
