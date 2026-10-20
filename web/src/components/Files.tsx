import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, errorText } from "../api";
import { formatDate, formatDateTime } from "../format";
import { LEVELS, LEVEL_LABELS, type Level } from "../../../shared/domain";
import { DOC_STATUSES, DOC_STATUS_LABELS, desktopAppFor, extensionOf, type DocStatus, type PreviewKind } from "../../../shared/documents";

// ---------------------------------------------------------------- shapes from the server
interface Profile { docTypeId: number | null; docType: string | null; status: DocStatus | null; docDate: string | null; tags: string[]; profiled: boolean }
interface Entry {
  id: string; rev: string | null; name: string; kind: "file" | "folder"; size: number | null; modified: string | null; relPath: string; webUrl: string;
  preview: PreviewKind | null; templateFolder: boolean; protected: boolean; profile: Profile | null;
}
interface TypeOption { id: number; name: string; protected: boolean; folder?: string | null }
interface FilesData {
  connected: boolean; configured?: boolean;
  folder?: { path: string; webUrl: string; outOfDate: boolean; inDeadzone: boolean } | null;
  expectedPath?: string; path?: string; breadcrumbs?: { name: string; relPath: string }[];
  here?: { templateFolder: boolean; year: number | null; level: Level | null; types: TypeOption[] };
  entries?: Entry[]; pin?: string | null; windowsBudget?: number;
  can?: { delete: boolean; deleteProtected: boolean; edit: boolean };
  template?: { folders: { id: number; name: string; kind: string }[]; levels: Record<Level, string>; types: TypeOption[] };
}
interface Details {
  name: string; relPath: string; dropboxPath: string; webUrl: string; size: number | null; modified: string | null; clientModified: string | null;
  rev: string | null; format: string; preview: PreviewKind; tooLongForWindows: boolean;
  profile: {
    docTypeId: number | null; docType: string | null; status: DocStatus | null; docDate: string | null; receivedOn: string | null; filedOn: string | null;
    author: string | null; tags: string[]; notes: string | null; year: number | null; level: Level | null;
    uploadedBy: string | null; uploadedAt: string | null; profiledBy: string | null; profiledAt: string | null; protected: boolean;
  };
  suggestedTypes: number[]; pin: string | null; suggestedName: string | null;
  revisions: { rev: string; modified: string; size: number | null; current: boolean }[];
}
interface Deleted { id: number; kind: "file" | "folder"; name: string; path_display: string; relPath: string | null; files: number; was_protected: boolean; outside: boolean; deleted_at: string; deleted_by: string | null }

const MAX_BYTES = 50 * 1024 * 1024;
const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

function size(n: number | null): string {
  if (n === null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function parentOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

// ================================================================ the tab
export function FilesTab({ propertyId, propertyStatus, canEdit, initialPath = "", initialFile = null }: {
  propertyId: number; propertyStatus?: string; canEdit: boolean; initialPath?: string; initialFile?: string | null;
}) {
  const [rel, setRel] = useState(initialFile ? parentOf(initialFile) : initialPath);
  const [data, setData] = useState<FilesData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState<string | null>(initialFile);
  const [panel, setPanel] = useState<"preview" | "profile" | "versions" | null>(initialFile ? "preview" : null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLTableSectionElement>(null);
  const [panelKey, setPanelKey] = useState(0);

  const load = useCallback(async (path: string) => {
    setError("");
    try {
      setData(await api<FilesData>(`/firm/properties/${propertyId}/files?${q({ path })}`));
    } catch (err) {
      setError(errorText(err));
    }
  }, [propertyId]);
  useEffect(() => { void load(rel); }, [load, rel]);

  const entries = useMemo(() => data?.entries ?? [], [data]);
  const current = entries.find((e) => e.relPath === selected) ?? null;
  const editable = canEdit && (data?.can?.edit ?? canEdit);

  async function act(label: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await fn();
      if (done) setNotice(done);
      await load(rel);
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy("");
    }
  }

  function goTo(path: string) {
    setRel(path);
    setSelected(null);
    setPanel(null);
    setRenaming(null);
    setConfirmDelete(null);
    setMenu(null);
    setNotice("");
  }

  async function uploadFiles(files: FileList | File[]) {
    const list = [...files];
    const tooBig = list.filter((f) => f.size > MAX_BYTES);
    if (tooBig.length) { setError(`${tooBig.map((f) => f.name).join(", ")} ${tooBig.length === 1 ? "is" : "are"} over 50 MB. Save large files straight into the Dropbox folder instead.`); return; }
    let long = false;
    await act("upload", async () => {
      let n = 0;
      for (const f of list) {
        setBusy(`Uploading ${++n} of ${list.length}: ${f.name}`);
        const res = await fetch(`/api/firm/properties/${propertyId}/files/upload?${q({ path: rel, name: f.name })}`, {
          method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream" }, body: f,
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string; tooLongForWindows?: boolean };
        if (!res.ok) throw new ApiError(res.status, body.error || `Upload failed (${res.status})`);
        long = long || Boolean(body.tooLongForWindows);
      }
    }, `Uploaded ${list.length} file${list.length === 1 ? "" : "s"}. Choose one to give it a document type.`);
    if (long) setNotice((n) => `${n} One name makes the full path long enough that Windows computers may not open it; a shorter name helps.`);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (editable && e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
  }

  // Keyboard: arrows move through the list, Space toggles the preview (like Quick Look), Enter opens a folder.
  function onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement).closest("input, textarea, select")) return;
    const i = entries.findIndex((x) => x.relPath === selected);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = entries[Math.max(0, Math.min(entries.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) { setSelected(next.relPath); focusRow(next.relPath); }
    } else if (e.key === " " && current?.kind === "file") {
      e.preventDefault();
      setPanel((p) => (p ? null : "preview"));
    } else if (e.key === "Enter" && current?.kind === "folder") {
      e.preventDefault();
      goTo(current.relPath);
    } else if (e.key === "Escape" && panel) {
      setPanel(null);
    }
  }
  function focusRow(relPath: string) {
    requestAnimationFrame(() => tableRef.current?.querySelector<HTMLElement>(`[data-rel="${CSS.escape(relPath)}"]`)?.focus());
  }

  if (error && !data) return <div className="error" role="alert">{error}</div>;
  if (!data) return <p className="meta">Loading files…</p>;

  if (!data.connected) {
    return (
      <div className="placeholder">
        <h2>Dropbox isn't connected</h2>
        <p className="muted">
          {data.configured === false
            ? "Dropbox isn't set up on this server yet."
            : <>A firm admin can connect the firm's Dropbox in <Link to="/settings?tab=integrations">Settings, Integrations</Link>. Then this tab shows the property's folder.</>}
        </p>
      </div>
    );
  }

  if (!data.folder) {
    return (
      <div className="placeholder">
        <h2>No folder yet</h2>
        <p className="muted" style={{ maxWidth: "64ch", margin: "0 auto 14px" }}>
          This property's folder will be <span className="mono">{data.expectedPath}</span>, with the firm's template folders
          ({data.template?.folders.map((f) => f.name).join(", ")}) and a folder for each appeal year and level. A folder already at that path is used as is.
        </p>
        {editable && (
          <button className="btn" disabled={Boolean(busy)} onClick={() => void act("create", () => api(`/firm/properties/${propertyId}/files/ensure`, { method: "POST", body: {} }), "Folder ready.")}>
            {busy === "create" ? "Creating" : "Create the folder"}
          </button>
        )}
        {error && <div className="error" role="alert">{error}</div>}
      </div>
    );
  }

  const crumbs = data.breadcrumbs ?? [];
  const here = data.here;
  const can = data.can ?? { delete: false, deleteProtected: false, edit: false };
  const closed = propertyStatus === "closed" || propertyStatus === "sold";
  const deadzone = (to: "deadzone" | "active") =>
    void act("deadzone", () => api(`/firm/properties/${propertyId}/files/deadzone`, { method: "POST", body: { to } }), to === "deadzone" ? "Moved to Deadzone with every file and profile." : "Moved back to the active client folders.");

  return (
    <div className={`files${dragging ? " dragging" : ""}`}
      onDragOver={(e) => { if (editable && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}
    >
      {data.folder.inDeadzone && (
        <div className="notice-box" role="status">
          <span>This matter's folder is in Deadzone, kept with closed matters and out of search.</span>
          <span className="sp" />
          {editable && <button className="btn small secondary" disabled={Boolean(busy)} onClick={() => deadzone("active")}>Move back</button>}
        </div>
      )}
      {!data.folder.inDeadzone && closed && editable && (
        <div className="notice-box copper" role="status">
          <span>This matter is {propertyStatus}. Move its folder to Deadzone, out of the active client folders? Every file and profile goes with it, and it can come back.</span>
          <span className="sp" />
          <button className="btn small copper" disabled={Boolean(busy)} onClick={() => deadzone("deadzone")}>Move to Deadzone</button>
        </div>
      )}
      {data.folder.outOfDate && (
        <div className="notice-box copper" role="status">
          <span>This folder's name no longer matches the client or address. It should be <span className="mono">{data.expectedPath}</span>.</span>
          <span className="sp" />
          {editable && <button className="btn small copper" disabled={Boolean(busy)} onClick={() => void act("move", () => api(`/firm/properties/${propertyId}/files/move`, { method: "POST", body: {} }), "Folder moved. Its files came with it.")}>Rename the folder</button>}
        </div>
      )}

      <div className="tbar">
        <nav className="crumbs" aria-label="Folder">
          <button className="lk" onClick={() => { setShowDeleted(false); goTo(""); }} aria-current={!showDeleted && rel === "" ? "page" : undefined}>Property folder</button>
          {!showDeleted && crumbs.map((c) => (
            <span key={c.relPath}> / <button className="lk" onClick={() => goTo(c.relPath)} aria-current={c.relPath === rel ? "page" : undefined}>{c.name}</button></span>
          ))}
          {showDeleted && <span> / <b>Recently deleted</b></span>}
        </nav>
        <span className="sp" />
        {!showDeleted && (
          <>
            {editable && <button className="btn small secondary" disabled={Boolean(busy)} onClick={() => setNewFolder("")}>New folder</button>}
            {editable && (
              <>
                <button className="btn small" disabled={Boolean(busy)} onClick={() => input.current?.click()}>Upload</button>
                <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) void uploadFiles(e.target.files); e.target.value = ""; }} aria-label="Choose files to upload" />
              </>
            )}
            <MoreMenu
              items={[
                { label: "Open this folder in Dropbox", href: data.folder.webUrl },
                ...(editable ? [{ label: "Apply the folder template", onClick: () => void act("ensure", () => api(`/firm/properties/${propertyId}/files/ensure`, { method: "POST", body: {} }), "Template applied. Missing folders were added; nothing was moved or removed.") }] : []),
                { label: "Recently deleted", onClick: () => { setShowDeleted(true); setPanel(null); setSelected(null); } },
                ...(editable && !data.folder.inDeadzone && !closed ? [{ label: "Move to Deadzone", onClick: () => deadzone("deadzone") }] : []),
              ]}
            />
          </>
        )}
        {showDeleted && <button className="btn small secondary" onClick={() => setShowDeleted(false)}>Back to files</button>}
      </div>

      {showDeleted ? (
        <DeletedList propertyId={propertyId} canRestore={editable} onRestored={(msg) => { setNotice(msg); void load(rel); }} />
      ) : (
        <>
          {here && here.types.length > 0 && (
            <p className="guide" aria-label="What belongs in this folder">
              <span className="meta">Save here</span>{" "}
              {here.types.map((t, i) => <span key={t.id}>{i > 0 && " · "}{t.name}{t.protected && <span className="lock" title="Protected: only an attorney or a firm admin can delete it" aria-label="protected" />}</span>)}
            </p>
          )}
          {newFolder !== null && (
            <form className="inline-form" onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void act("folder", () => api(`/firm/properties/${propertyId}/files/folder`, { method: "POST", body: { path: rel, name: newFolder } }), `Folder ${newFolder} created.`).then((ok) => { if (ok) setNewFolder(null); });
            }}>
              <input className="in" autoFocus value={newFolder} onChange={(e) => setNewFolder(e.target.value)} aria-label="New folder name" placeholder="Folder name" />
              <button className="btn small" disabled={!newFolder.trim() || Boolean(busy)}>Create</button>
              <button type="button" className="btn small secondary" onClick={() => setNewFolder(null)}>Cancel</button>
            </form>
          )}
          <div className={`fwrap${panel && current?.kind === "file" ? " with-panel" : ""}`}>
            <div className="tw card" onKeyDown={onKey}>
              <table className="compact ftable">
                <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Modified</th><th className="num">Size</th><th aria-label="Actions" /></tr></thead>
                <tbody ref={tableRef}>
                  {rel && (
                    <tr className="clickable" onClick={() => goTo(crumbs.length > 1 ? crumbs[crumbs.length - 2].relPath : "")}>
                      <td colSpan={6} className="meta span-all">↑ Up a folder</td>
                    </tr>
                  )}
                  {entries.map((e) => (
                    <tr
                      key={e.relPath}
                      data-rel={e.relPath}
                      tabIndex={0}
                      aria-selected={selected === e.relPath}
                      className={`clickable${selected === e.relPath ? " sel" : ""}`}
                      onClick={() => { setSelected(e.relPath); setMenu(null); if (e.kind === "file" && panel === null) setPanel("preview"); }}
                      onDoubleClick={() => { if (e.kind === "folder") goTo(e.relPath); }}
                      onFocus={() => setSelected(e.relPath)}
                    >
                      <td>
                        <span className={`ficon ${e.kind}`} aria-hidden="true" />
                        {renaming === e.relPath ? (
                          <RenameForm entry={e} onCancel={() => setRenaming(null)} onSave={(name) => act("rename", () => api(`/firm/properties/${propertyId}/files/rename`, { method: "POST", body: { path: e.relPath, name } }), "Renamed.").then((ok) => { if (ok) { setRenaming(null); setSelected(`${parentOf(e.relPath) ? `${parentOf(e.relPath)}/` : ""}${name}`); } })} />
                        ) : e.kind === "folder" ? (
                          <button className="fname" onClick={(ev) => { ev.stopPropagation(); goTo(e.relPath); }}>{e.name}</button>
                        ) : (
                          <span className="fname">{e.name}</span>
                        )}
                        {e.protected && <span className="lock" title={e.kind === "folder" ? "Template folder: only an attorney or a firm admin can delete it" : "Protected: only an attorney or a firm admin can delete it"} aria-label="protected" />}
                      </td>
                      <td>{e.kind === "file" ? (e.profile?.docType ?? <span className="meta">Not profiled</span>) : ""}</td>
                      <td>{e.profile?.status ? <span className={`pill ${e.profile.status === "filed" ? "net" : e.profile.status === "final" ? "ok" : e.profile.status === "draft" ? "warn" : "grey"}`}>{DOC_STATUS_LABELS[e.profile.status]}</span> : ""}</td>
                      <td className="meta">{e.modified ? formatDateTime(e.modified) : ""}</td>
                      <td className="num">{size(e.size)}</td>
                      <td className="num" onClick={(ev) => ev.stopPropagation()}>
                        {confirmDelete === e.relPath ? (
                          <span className="confirm tight">
                            Delete{e.kind === "folder" ? " the folder and everything in it" : ""}?
                            <button className="btn small danger" disabled={Boolean(busy)} onClick={() => void act("delete", () => api(`/firm/properties/${propertyId}/files/delete`, { method: "POST", body: { path: e.relPath } }), `${e.name} deleted. It's in Recently deleted if you need it back.`).then(() => { setConfirmDelete(null); setSelected(null); setPanel(null); })}>Delete</button>
                            <button className="btn small secondary" onClick={() => setConfirmDelete(null)}>Keep</button>
                          </span>
                        ) : (
                          <RowMenu
                            open={menu === e.relPath}
                            onToggle={() => setMenu(menu === e.relPath ? null : e.relPath)}
                            label={`Actions for ${e.name}`}
                            items={e.kind === "folder" ? [
                              { label: "Open", onClick: () => goTo(e.relPath) },
                              { label: "View in Dropbox", href: e.webUrl },
                              ...(editable && !e.templateFolder ? [{ label: "Rename", onClick: () => setRenaming(e.relPath) }] : []),
                              ...deleteItem(e, can, () => setConfirmDelete(e.relPath)),
                            ] : [
                              { label: "Preview", onClick: () => { setSelected(e.relPath); setPanel("preview"); } },
                              { label: "Open via Dropbox", href: e.webUrl, hint: `Choose Open, then ${desktopAppFor(e.name)}` },
                              { label: "Download", href: `/api/firm/properties/${propertyId}/files/download?${q({ path: e.relPath })}`, download: true },
                              { label: "Profile", onClick: () => { setSelected(e.relPath); setPanel("profile"); } },
                              { label: "Version history", onClick: () => { setSelected(e.relPath); setPanel("versions"); } },
                              ...(editable ? [{ label: "Rename", onClick: () => setRenaming(e.relPath) }] : []),
                              ...deleteItem(e, can, () => setConfirmDelete(e.relPath)),
                            ]}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                  {entries.length === 0 && (
                    <tr><td colSpan={6} className="meta span-all" style={{ textAlign: "center", padding: 22 }}>{editable ? "Empty. Drag files here, or use Upload." : "Empty."}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {panel && current?.kind === "file" && (
              <FilePanel
                key={`${current.relPath}:${panelKey}`}
                propertyId={propertyId}
                entry={current}
                tab={panel}
                onTab={setPanel}
                onClose={() => { setPanel(null); focusRow(current.relPath); }}
                canEdit={editable}
                types={data.template?.types ?? []}
                onChanged={(msg, newRel) => { if (msg) setNotice(msg); if (newRel) setSelected(newRel); setPanelKey((k) => k + 1); void load(rel); }}
              />
            )}
          </div>
        </>
      )}
      {busy && busy.startsWith("Uploading") && <div className="meta" role="status" style={{ marginTop: 8 }}>{busy}</div>}
      {notice && <div className="ok" role="status">{notice}</div>}
      {error && <div className="error" role="alert">{error}</div>}
      <p className="meta" style={{ marginTop: 10 }}>
        Click a file to preview it; Space shows and hides the preview, and the arrow keys move through the list. Open via Dropbox shows the file in Dropbox:
        choose Open, then Word, Excel or PowerPoint, and press Save as usual. Changes save to the same file in Dropbox, which keeps every earlier version.
      </p>
    </div>
  );
}

function deleteItem(e: Entry, can: { delete: boolean; deleteProtected: boolean }, onDelete: () => void) {
  if (!can.delete) return [];
  if (e.protected && !can.deleteProtected) return [{ label: "Delete", disabled: true, hint: "Protected. An attorney or a firm admin can delete it" }];
  return [{ label: "Delete", onClick: onDelete, danger: true }];
}

// ================================================================ small menus and forms
interface MenuItem { label: string; onClick?: () => void; href?: string; download?: boolean; hint?: string; disabled?: boolean; danger?: boolean }

function RowMenu({ open, onToggle, items, label }: { open: boolean; onToggle: () => void; items: MenuItem[]; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (ev: MouseEvent) => { if (ref.current && !ref.current.contains(ev.target as Node)) onToggle(); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open, onToggle]);
  return (
    <div className="rmenu" ref={ref} onKeyDown={(ev) => { if (ev.key === "Escape" && open) { ev.stopPropagation(); onToggle(); } }}>
      <button className="btn small ghost dots" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={onToggle}>⋯</button>
      {open && (
        <div className="rmenu-list" role="menu" aria-label={label}>
          {items.map((it) => it.href ? (
            <a key={it.label} role="menuitem" href={it.href} target={it.download ? undefined : "_blank"} rel="noreferrer" title={it.hint} onClick={onToggle}>
              {it.label}{it.hint && <small>{it.hint}</small>}
            </a>
          ) : (
            <button key={it.label} role="menuitem" disabled={it.disabled} className={it.danger ? "danger" : ""} title={it.hint} onClick={() => { onToggle(); it.onClick?.(); }}>
              {it.label}{it.hint && <small>{it.hint}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MoreMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  return <RowMenu open={open} onToggle={() => setOpen((o) => !o)} items={items} label="More folder actions" />;
}

function RenameForm({ entry, onSave, onCancel }: { entry: Entry; onSave: (name: string) => Promise<unknown>; onCancel: () => void }) {
  const ext = entry.kind === "file" ? extensionOf(entry.name) : "";
  const [name, setName] = useState(ext ? entry.name.slice(0, -(ext.length + 1)) : entry.name);
  return (
    <form className="rename" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void onSave(ext ? `${name.trim()}.${ext}` : name.trim()); }}>
      <input className="in" autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label={`New name for ${entry.name}`} onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }} />
      {ext && <span className="meta">.{ext}</span>}
      <button className="btn small" disabled={!name.trim()}>Save</button>
      <button type="button" className="btn small secondary" onClick={onCancel}>Cancel</button>
    </form>
  );
}

// ================================================================ the side panel: preview, profile, versions
function FilePanel({ propertyId, entry, tab, onTab, onClose, canEdit, types, onChanged }: {
  propertyId: number; entry: Entry; tab: "preview" | "profile" | "versions"; onTab: (t: "preview" | "profile" | "versions") => void; onClose: () => void;
  canEdit: boolean; types: TypeOption[]; onChanged: (msg?: string, newRel?: string) => void;
}) {
  const [d, setD] = useState<Details | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setD(null);
    api<Details>(`/firm/properties/${propertyId}/files/details?${q({ path: entry.relPath })}`).then((x) => { if (live) setD(x); }).catch((err) => { if (live) setError(errorText(err)); });
    return () => { live = false; };
  }, [propertyId, entry.relPath, entry.rev]);

  const base = `/api/firm/properties/${propertyId}/files`;
  return (
    <aside className="fpanel card" aria-label={`File: ${entry.name}`}>
      <div className="fpanel-head">
        <div style={{ minWidth: 0 }}>
          <b className="fpanel-name" title={entry.name}>{entry.name}</b>
          <span className="meta">{d ? `${d.format} · ${size(d.size)}${d.profile.docType ? ` · ${d.profile.docType}` : ""}` : " "}</span>
        </div>
        <button className="btn small ghost" onClick={onClose} aria-label="Close the file panel">✕</button>
      </div>
      <div className="fpanel-actions">
        <a className="btn small" href={entry.webUrl} target="_blank" rel="noreferrer" title={`Opens the file in Dropbox. Choose Open, then ${desktopAppFor(entry.name)}`}>Open via Dropbox</a>
        <a className="btn small secondary" href={`${base}/download?${q({ path: entry.relPath })}`}>Download</a>
      </div>
      <div className="subtabs small" role="tablist">
        {(["preview", "profile", "versions"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => onTab(t)}>{t === "preview" ? "Preview" : t === "profile" ? "Profile" : "Versions"}</button>
        ))}
      </div>
      <div className="fpanel-body">
        {error && <div className="error" role="alert">{error}</div>}
        {tab === "preview" && <Preview propertyId={propertyId} entry={entry} />}
        {tab === "profile" && (d ? <ProfileForm propertyId={propertyId} d={d} canEdit={canEdit} types={types} onChanged={onChanged} /> : !error && <p className="meta">Loading…</p>)}
        {tab === "versions" && (d ? <Versions propertyId={propertyId} d={d} canEdit={canEdit} onChanged={onChanged} /> : !error && <p className="meta">Loading…</p>)}
      </div>
    </aside>
  );
}

function Preview({ propertyId, entry }: { propertyId: number; entry: Entry }) {
  const base = `/api/firm/properties/${propertyId}/files`;
  const raw = `${base}/raw?${q({ path: entry.relPath })}`;
  const rendered = `${base}/preview?${q({ path: entry.relPath })}`;
  const [failed, setFailed] = useState("");
  const [attempt, setAttempt] = useState(0);
  const kind = entry.preview ?? "none";

  // Dropbox-rendered previews: check first, so a "still preparing" or "can't preview" reply shows as a message, not a broken frame.
  const [ready, setReady] = useState(kind !== "office" && kind !== "sheet");
  useEffect(() => {
    if (kind !== "office" && kind !== "sheet") return;
    let live = true;
    setReady(false);
    setFailed("");
    fetch(rendered, { method: "GET", credentials: "same-origin" }).then(async (r) => {
      if (!live) return;
      if (r.ok) { setReady(true); return; }
      const body = (await r.json().catch(() => ({}))) as { error?: string; retry?: boolean };
      setFailed(body.error || "This file can't be previewed.");
      if (body.retry && attempt < 3) window.setTimeout(() => live && setAttempt((a) => a + 1), 2500);
    }).catch(() => live && setFailed("The preview didn't load."));
    return () => { live = false; };
  }, [rendered, kind, attempt]);

  if (failed) return <div className="pv-none"><p>{failed}</p></div>;
  if (kind === "pdf") return <iframe className="pv-frame" src={raw} title={`Preview of ${entry.name}`} />;
  if (kind === "office") return ready ? <iframe className="pv-frame" src={rendered} title={`Preview of ${entry.name}`} /> : <p className="meta">Preparing the preview…</p>;
  if (kind === "sheet") return ready ? <iframe className="pv-frame sheet" sandbox="" src={rendered} title={`Preview of ${entry.name}`} /> : <p className="meta">Preparing the preview…</p>;
  if (kind === "image") return <div className="pv-image"><img src={raw} alt={entry.name} /></div>;
  if (kind === "text") return <iframe className="pv-frame text" sandbox="" src={raw} title={`Preview of ${entry.name}`} />;
  if (kind === "audio") return <audio controls src={raw} style={{ width: "100%" }} />;
  if (kind === "video") return <video controls src={raw} style={{ width: "100%" }} />;
  if (kind === "email") return <EmailView propertyId={propertyId} entry={entry} />;
  return (
    <div className="pv-none">
      <p>There's no preview for {extensionOf(entry.name) ? `.${extensionOf(entry.name)} files` : "this file"}.</p>
      <p className="meta">Open it in its app or download it.</p>
    </div>
  );
}

interface Email { from: string; to: string[]; cc: string[]; date: string | null; subject: string; text: string | null; html: string | null; attachments: { filename: string; mimeType: string; size: number }[] }

function EmailView({ propertyId, entry }: { propertyId: number; entry: Entry }) {
  const [m, setM] = useState<Email | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<Email>(`/firm/properties/${propertyId}/files/email?${q({ path: entry.relPath })}`).then(setM).catch((err) => setError(errorText(err)));
  }, [propertyId, entry.relPath]);
  if (error) return <div className="error" role="alert">{error}</div>;
  if (!m) return <p className="meta">Reading the email…</p>;
  // The message body is shown in a sandboxed frame: no scripts, no outside images.
  const doc = m.html
    ? `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>body{font:13px/1.5 system-ui,sans-serif;margin:12px;color:#14233f}</style>${m.html}`
    : null;
  return (
    <div className="email">
      <h4>{m.subject || "(no subject)"}</h4>
      <dl className="email-head">
        <div><dt>From</dt><dd>{m.from}</dd></div>
        <div><dt>To</dt><dd>{m.to.join(", ")}</dd></div>
        {m.cc.length > 0 && <div><dt>Cc</dt><dd>{m.cc.join(", ")}</dd></div>}
        {m.date && <div><dt>Date</dt><dd>{formatDateTime(m.date)}</dd></div>}
      </dl>
      {doc ? <iframe className="pv-frame email-body" sandbox="" srcDoc={doc} title={`Message: ${m.subject}`} /> : <pre className="email-text">{m.text}</pre>}
      {m.attachments.length > 0 && (
        <div className="email-att">
          <span className="meta">Attachments</span>
          <ul>{m.attachments.map((a, i) => <li key={i}>{a.filename} <span className="meta">{size(a.size)}</span></li>)}</ul>
          <span className="meta">To open an attachment, open the email in Outlook.</span>
        </div>
      )}
    </div>
  );
}

function ProfileForm({ propertyId, d, canEdit, types, onChanged }: { propertyId: number; d: Details; canEdit: boolean; types: TypeOption[]; onChanged: (msg?: string, newRel?: string) => void }) {
  const p = d.profile;
  const [f, setF] = useState({
    docTypeId: p.docTypeId ? String(p.docTypeId) : "", status: p.status ?? "", docDate: p.docDate ?? "", receivedOn: p.receivedOn ?? "", filedOn: p.filedOn ?? "",
    author: p.author ?? "", tags: p.tags.join(", "), notes: p.notes ?? "", year: p.year ? String(p.year) : "", level: p.level ?? "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const suggested = types.filter((t) => d.suggestedTypes.includes(t.id));
  const others = types.filter((t) => !d.suggestedTypes.includes(t.id));
  const chosen = types.find((t) => String(t.id) === f.docTypeId);
  const nameFromType = chosen ? suggestName(d.pin, chosen.name, f.year ? Number(f.year) : null, d.name) : null;

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/firm/properties/${propertyId}/files/profile`, {
        method: "PUT",
        body: {
          path: d.relPath, docTypeId: f.docTypeId ? Number(f.docTypeId) : null, status: f.status || null,
          docDate: f.docDate || null, receivedOn: f.receivedOn || null, filedOn: f.filedOn || null, author: f.author || null,
          tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean), notes: f.notes || null,
          year: f.year ? Number(f.year) : null, level: f.level || null,
        },
      });
      onChanged("Profile saved.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function rename(to: string) {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ relPath: string; name: string }>(`/firm/properties/${propertyId}/files/rename`, { method: "POST", body: { path: d.relPath, name: to } });
      onChanged(`Renamed to ${r.name}.`, r.relPath);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const ro = !canEdit;
  return (
    <form onSubmit={save} className="pform" aria-label="Document profile">
      <div className="fld">
        <label htmlFor="pf-type">Document type</label>
        <select id="pf-type" className="in" value={f.docTypeId} onChange={set("docTypeId")} disabled={ro}>
          <option value="">Not set</option>
          {suggested.length > 0 && <optgroup label="For this folder">{suggested.map((t) => <option key={t.id} value={t.id}>{t.name}{t.protected ? " (protected)" : ""}</option>)}</optgroup>}
          <optgroup label={suggested.length ? "Other types" : "All types"}>{others.map((t) => <option key={t.id} value={t.id}>{t.name}{t.protected ? " (protected)" : ""}{t.folder ? ` · ${t.folder}` : ""}</option>)}</optgroup>
        </select>
      </div>
      <div className="pgrid">
        <div className="fld">
          <label htmlFor="pf-status">Status</label>
          <select id="pf-status" className="in" value={f.status} onChange={set("status")} disabled={ro}>
            <option value="">Not set</option>
            {DOC_STATUSES.map((s) => <option key={s} value={s}>{DOC_STATUS_LABELS[s]}</option>)}
          </select>
        </div>
        <div className="fld"><label htmlFor="pf-date">Document date</label><input id="pf-date" className="in" type="date" value={f.docDate} onChange={set("docDate")} disabled={ro} /></div>
        <div className="fld"><label htmlFor="pf-received">Received</label><input id="pf-received" className="in" type="date" value={f.receivedOn} onChange={set("receivedOn")} disabled={ro} /></div>
        <div className="fld"><label htmlFor="pf-filed">Filed</label><input id="pf-filed" className="in" type="date" value={f.filedOn} onChange={set("filedOn")} disabled={ro} /></div>
        <div className="fld"><label htmlFor="pf-year">Assessment year</label><input id="pf-year" className="in" inputMode="numeric" value={f.year} onChange={set("year")} disabled={ro} /></div>
        <div className="fld">
          <label htmlFor="pf-level">Level</label>
          <select id="pf-level" className="in" value={f.level} onChange={set("level")} disabled={ro}>
            <option value="">Not set</option>
            {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
          </select>
        </div>
      </div>
      <div className="fld"><label htmlFor="pf-author">Author</label><input id="pf-author" className="in" value={f.author} onChange={set("author")} disabled={ro} /></div>
      <div className="fld"><label htmlFor="pf-tags">Tags</label><input id="pf-tags" className="in" value={f.tags} onChange={set("tags")} placeholder="Separate with commas" disabled={ro} /></div>
      <div className="fld"><label htmlFor="pf-notes">Notes</label><textarea id="pf-notes" className="in" value={f.notes} onChange={set("notes")} disabled={ro} /></div>
      {canEdit && <button className="btn small" disabled={busy}>{busy ? "Saving" : "Save profile"}</button>}
      {canEdit && nameFromType && nameFromType !== d.name && (
        <div className="suggest">
          <span className="meta">Firm naming</span>
          <span className="mono">{nameFromType}</span>
          <button type="button" className="btn small secondary" disabled={busy} onClick={() => void rename(nameFromType)}>Rename to this</button>
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}
      {d.profile.protected && <p className="meta"><span className="lock" aria-hidden="true" /> Protected. Only an attorney or a firm admin can delete it.</p>}
      {d.tooLongForWindows && <p className="warn-text">This file's path is long enough that Windows computers may not open it. A shorter name or folder helps.</p>}
      <dl className="facts compact-facts">
        <div><dt>Uploaded</dt><dd>{p.uploadedBy ? `${p.uploadedBy}, ${p.uploadedAt ? formatDate(p.uploadedAt.slice(0, 10)) : ""}` : "Outside Appeal EyeQ"}</dd></div>
        <div><dt>Modified</dt><dd>{d.modified ? formatDateTime(d.modified) : ""}</dd></div>
        {p.profiledBy && <div><dt>Profiled</dt><dd>{p.profiledBy}{p.profiledAt ? `, ${formatDate(p.profiledAt.slice(0, 10))}` : ""}</dd></div>}
        <div><dt>Versions</dt><dd>{d.revisions.length}</dd></div>
        <div className="wide"><dt>In Dropbox</dt><dd className="mono small">{d.dropboxPath}</dd></div>
      </dl>
    </form>
  );
}

function suggestName(pin: string | null, type: string, year: number | null, current: string): string {
  const ext = extensionOf(current);
  const head = [pin, type].filter(Boolean).join(" – ");
  const base = year ? `${head} (${year})` : head;
  return ext ? `${base}.${ext}` : base;
}

function Versions({ propertyId, d, canEdit, onChanged }: { propertyId: number; d: Details; canEdit: boolean; onChanged: (msg?: string) => void }) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState("");
  const base = `/api/firm/properties/${propertyId}/files`;
  async function restore(rev: string) {
    setError("");
    try {
      await api(`${base.replace("/api", "")}/revisions/restore`, { method: "POST", body: { path: d.relPath, rev } });
      setConfirm(null);
      onChanged("That version is current again. The one it replaced is still in the history.");
    } catch (err) {
      setError(errorText(err));
    }
  }
  if (!d.revisions.length) return <p className="meta">Dropbox has no earlier versions of this file.</p>;
  return (
    <div>
      <p className="meta">Every save in Word, Excel or Dropbox is kept here. Making an older version current adds it as the newest; nothing is lost.</p>
      <ul className="versions">
        {d.revisions.map((r, i) => (
          <li key={r.rev}>
            <div>
              <b>{formatDateTime(r.modified)}</b>{r.current && i === 0 && <span className="pill ok">Current</span>}
              <span className="meta" style={{ display: "block" }}>{size(r.size)}</span>
            </div>
            <span className="sp" />
            <a className="btn small ghost" href={`${base}/download?${q({ path: d.relPath, rev: r.rev })}`}>Download</a>
            {canEdit && i > 0 && (confirm === r.rev ? (
              <span className="confirm tight">
                Make current?
                <button className="btn small" onClick={() => void restore(r.rev)}>Yes</button>
                <button className="btn small secondary" onClick={() => setConfirm(null)}>No</button>
              </span>
            ) : <button className="btn small secondary" onClick={() => setConfirm(r.rev)}>Make current</button>)}
          </li>
        ))}
      </ul>
      {error && <div className="error" role="alert">{error}</div>}
    </div>
  );
}

// ================================================================ recently deleted
function DeletedList({ propertyId, canRestore, onRestored }: { propertyId: number; canRestore: boolean; onRestored: (msg: string) => void }) {
  const [rows, setRows] = useState<Deleted[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const load = useCallback(() => api<{ deleted: Deleted[] }>(`/firm/properties/${propertyId}/files/deleted`).then((r) => setRows(r.deleted)).catch((err) => setError(errorText(err))), [propertyId]);
  useEffect(() => { void load(); }, [load]);
  async function restore(r: Deleted) {
    setBusy(r.id);
    setError("");
    try {
      const out = await api<{ restored: number; failed: string[] }>(`/firm/properties/${propertyId}/files/restore`, { method: "POST", body: { deletionId: r.id } });
      onRestored(out.failed.length ? `Restored ${out.restored} file${out.restored === 1 ? "" : "s"}; Dropbox couldn't bring back ${out.failed.join(", ")}.` : `${r.name} is back where it was.`);
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }
  if (!rows) return error ? <div className="error" role="alert">{error}</div> : <p className="meta">Loading…</p>;
  return (
    <div className="tw card">
      <table className="compact">
        <thead><tr><th>Name</th><th>Was in</th><th>Deleted</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><span className={`ficon ${r.kind}`} aria-hidden="true" />{r.name}{r.kind === "folder" && <span className="meta"> · {r.files} file{r.files === 1 ? "" : "s"}</span>}{r.was_protected && <span className="lock" aria-label="protected" />}</td>
              <td className="meta">{r.relPath ? parentOf(r.relPath) || "Property folder" : r.path_display}</td>
              <td>{formatDateTime(r.deleted_at)} <span className="meta" style={{ display: "block" }}>{r.outside ? "Deleted outside Appeal EyeQ" : `by ${r.deleted_by ?? "someone"}`}</span></td>
              <td className="num">{canRestore && <button className="btn small secondary" disabled={busy !== null} onClick={() => void restore(r)}>{busy === r.id ? "Restoring" : "Restore"}</button>}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={4} className="meta" style={{ textAlign: "center", padding: 22 }}>Nothing deleted from this property recently.</td></tr>}
        </tbody>
      </table>
      {error && <div className="error" role="alert" style={{ margin: 12 }}>{error}</div>}
      <p className="meta" style={{ margin: "10px 14px" }}>Dropbox keeps deleted files for at least 30 days, longer on some plans. After that they can't be restored.</p>
    </div>
  );
}
