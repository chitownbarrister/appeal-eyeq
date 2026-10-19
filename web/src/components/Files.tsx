import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, errorText } from "../api";
import { formatDateTime } from "../format";

interface Entry { name: string; kind: "file" | "folder"; size: number | null; modified: string | null; relPath: string; webUrl: string }
interface FilesData {
  connected: boolean; configured?: boolean;
  folder?: { path: string; webUrl: string; outOfDate: boolean } | null;
  expectedPath?: string; path?: string; breadcrumbs?: { name: string; relPath: string }[]; entries?: Entry[];
}

const MAX_BYTES = 50 * 1024 * 1024;

function size(n: number | null): string {
  if (n === null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function FilesTab({ propertyId, canEdit }: { propertyId: number; canEdit: boolean }) {
  const [rel, setRel] = useState("");
  const [data, setData] = useState<FilesData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async (path: string) => {
    setError("");
    try {
      setData(await api<FilesData>(`/firm/properties/${propertyId}/files?${new URLSearchParams({ path })}`));
    } catch (err) {
      setError(errorText(err));
    }
  }, [propertyId]);
  useEffect(() => { void load(rel); }, [load, rel]);

  async function act(label: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await fn();
      if (done) setNotice(done);
      await load(rel);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy("");
    }
  }

  async function uploadFiles(files: FileList | File[]) {
    const list = [...files];
    const tooBig = list.filter((f) => f.size > MAX_BYTES);
    if (tooBig.length) { setError(`${tooBig.map((f) => f.name).join(", ")} ${tooBig.length === 1 ? "is" : "are"} over 50 MB. Save large files straight into the Dropbox folder instead.`); return; }
    await act("upload", async () => {
      let n = 0;
      for (const f of list) {
        setBusy(`Uploading ${++n} of ${list.length}: ${f.name}`);
        const res = await fetch(`/api/firm/properties/${propertyId}/files/upload?${new URLSearchParams({ path: rel, name: f.name })}`, {
          method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream" }, body: f,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new ApiError(res.status, body.error || `Upload failed (${res.status})`);
        }
      }
    }, `Uploaded ${list.length} file${list.length === 1 ? "" : "s"}.`);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (canEdit && e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
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
          This property's folder will be <span className="mono">{data.expectedPath}</span>, with Appeals, then a folder for each year and level. If a folder already
          exists at that path, it's used as is.
        </p>
        {canEdit && (
          <button className="btn" disabled={Boolean(busy)} onClick={() => void act("create", () => api(`/firm/properties/${propertyId}/files/ensure`, { method: "POST", body: {} }), "Folder ready.")}>
            {busy === "create" ? "Creating" : "Create the folder"}
          </button>
        )}
        {error && <div className="error" role="alert">{error}</div>}
      </div>
    );
  }

  const crumbs = data.breadcrumbs ?? [];
  return (
    <div
      className={`files${dragging ? " dragging" : ""}`}
      onDragOver={(e) => { if (canEdit) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}
    >
      {data.folder.outOfDate && (
        <div className="notice-box copper" role="status">
          <span>This folder's name no longer matches the client or address. It should be <span className="mono">{data.expectedPath}</span>.</span>
          <span className="sp" />
          {canEdit && <button className="btn small copper" disabled={Boolean(busy)} onClick={() => void act("move", () => api(`/firm/properties/${propertyId}/files/move`, { method: "POST", body: {} }), "Folder moved. Its files came with it.")}>Rename the folder</button>}
        </div>
      )}
      <div className="tbar">
        <nav className="crumbs" aria-label="Folder">
          <button className="lk" onClick={() => setRel("")} aria-current={rel === "" ? "page" : undefined}>Property folder</button>
          {crumbs.map((c) => (
            <span key={c.relPath}> / <button className="lk" onClick={() => setRel(c.relPath)} aria-current={c.relPath === rel ? "page" : undefined}>{c.name}</button></span>
          ))}
        </nav>
        <span className="sp" />
        <a className="btn small secondary" href={data.folder.webUrl} target="_blank" rel="noreferrer">Open in Dropbox</a>
        {canEdit && <button className="btn small secondary" disabled={Boolean(busy)} onClick={() => void act("ensure", () => api(`/firm/properties/${propertyId}/files/ensure`, { method: "POST", body: {} }), "Folders added for every appeal.")} title="Adds Appeals / year / level folders for appeals created since">Add appeal folders</button>}
        {canEdit && (
          <>
            <button className="btn small" disabled={Boolean(busy)} onClick={() => input.current?.click()}>Upload</button>
            <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) void uploadFiles(e.target.files); e.target.value = ""; }} aria-label="Choose files to upload" />
          </>
        )}
      </div>
      <div className="tw card">
        <table className="compact">
          <thead><tr><th>Name</th><th className="num">Size</th><th>Modified</th><th /></tr></thead>
          <tbody>
            {rel && (
              <tr className="clickable" onClick={() => setRel(crumbs.length > 1 ? crumbs[crumbs.length - 2].relPath : "")}>
                <td colSpan={4} className="meta">↑ Up a folder</td>
              </tr>
            )}
            {(data.entries ?? []).map((e) => (
              <tr key={e.relPath} className={e.kind === "folder" ? "clickable" : ""} onClick={e.kind === "folder" ? () => setRel(e.relPath) : undefined}>
                <td>
                  <span className={`ficon ${e.kind}`} aria-hidden="true" />
                  {e.kind === "folder"
                    ? <button className="fname" onClick={(ev) => { ev.stopPropagation(); setRel(e.relPath); }}>{e.name}</button>
                    : <a className="fname" href={e.webUrl} target="_blank" rel="noreferrer" title="Opens in Dropbox, where Open in, Word or Excel starts the desktop app">{e.name}</a>}
                </td>
                <td className="num">{size(e.size)}</td>
                <td className="meta">{e.modified ? formatDateTime(e.modified) : ""}</td>
                <td className="num" style={{ whiteSpace: "nowrap" }}>
                  {e.kind === "file" && (
                    <>
                      <a className="btn small ghost" href={e.webUrl} target="_blank" rel="noreferrer">Open</a>
                      <a className="btn small ghost" href={`/api/firm/properties/${propertyId}/files/download?${new URLSearchParams({ path: e.relPath })}`}>Download</a>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {(data.entries ?? []).length === 0 && (
              <tr><td colSpan={4} className="meta" style={{ textAlign: "center", padding: 22 }}>{canEdit ? "Empty. Drag files here, or use Upload." : "Empty."}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {busy && busy.startsWith("Uploading") && <div className="meta" role="status" style={{ marginTop: 8 }}>{busy}</div>}
      {notice && <div className="ok" role="status">{notice}</div>}
      {error && <div className="error" role="alert">{error}</div>}
      <p className="meta" style={{ marginTop: 10 }}>
        Open shows the file in Dropbox, where Open in, then Word or Excel, starts the desktop app (the Dropbox desktop app must be installed). Changes save back to
        Dropbox. Uploads here are limited to 50 MB a file.
      </p>
    </div>
  );
}
