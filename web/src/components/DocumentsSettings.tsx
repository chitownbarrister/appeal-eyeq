import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, errorText } from "../api";
import { useSession } from "../App";
import { LEVEL_LABELS, type Level } from "../../../shared/domain";

interface Folder { id: number; kind: "folder" | "appeals"; name: string; position: number }
interface LevelRow { id: number; level: Level; name: string }
interface DocType { id: number; name: string; templateId: number | null; anyLevel: boolean; protected: boolean; active: boolean; documents: number }
interface TemplateData { folders: Folder[]; levels: LevelRow[]; types: DocType[] }

/** Settings, Documents: the property folder template and the document types staff file by. Firm admins edit; everyone can read. */
export function DocumentsTab() {
  const { me } = useSession();
  const admin = !me.user.isSuperAdmin && me.user.isFirmAdmin;
  const [t, setT] = useState<TemplateData | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<string | null>(null); // "f:<id>" | "l:<id>" | "t:<id>"
  const [draft, setDraft] = useState("");
  const [newFolder, setNewFolder] = useState("");
  const [newType, setNewType] = useState({ name: "", where: "", protected: false });

  const load = useCallback(async () => setT(await api<TemplateData>("/firm/documents/template")), []);
  useEffect(() => { void load().catch((err) => setError(errorText(err))); }, [load]);

  async function run(fn: () => Promise<unknown>, done?: string) {
    setError("");
    setNotice("");
    try {
      await fn();
      if (done) setNotice(done);
      setEditing(null);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  }

  if (!t) return error ? <div className="error" role="alert">{error}</div> : <p className="meta">Loading…</p>;

  const move = (i: number, by: number) => {
    const ids = t.folders.map((f) => f.id);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void run(() => api("/firm/documents/template/order", { method: "PUT", body: { ids } }));
  };
  const whereLabel = (d: DocType) => (d.anyLevel ? "Every level folder" : t.folders.find((f) => f.id === d.templateId)?.name ?? t.levels.find((l) => l.id === d.templateId)?.name ?? "Any folder");
  const whereValue = (d: DocType) => (d.anyLevel ? "any-level" : d.templateId ? String(d.templateId) : "");
  const whereBody = (v: string) => (v === "any-level" ? { anyLevel: true, templateId: null } : { anyLevel: false, templateId: v ? Number(v) : null });
  const WhereOptions = () => (
    <>
      <option value="">Any folder</option>
      <optgroup label="Property folders">{t.folders.filter((f) => f.kind === "folder").map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</optgroup>
      <optgroup label="Appeals">
        <option value="any-level">Every level folder</option>
        {t.levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </optgroup>
    </>
  );

  return (
    <div className="docset">
      <section className="card pad" aria-labelledby="tpl-h">
        <h3 id="tpl-h">Property folder template</h3>
        <p className="small muted" style={{ maxWidth: "70ch" }}>
          Every property's Dropbox folder gets these folders, in this order, with Appeals holding a folder for each year and a folder for each level inside it.
          Changes apply to folders created from now on; Apply the folder template on a property's Files tab adds anything missing there. Existing folders keep their names.
        </p>
        <ol className="tpl-list">
          {t.folders.map((f, i) => (
            <li key={f.id}>
              <span className="ficon folder" aria-hidden="true" />
              {editing === `f:${f.id}` ? (
                <form className="rename" onSubmit={(e: FormEvent) => { e.preventDefault(); void run(() => api(`/firm/documents/template/folders/${f.id}`, { method: "PATCH", body: { name: draft } }), "Folder renamed in the template."); }}>
                  <input className="in" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={`New name for ${f.name}`} />
                  <button className="btn small">Save</button>
                  <button type="button" className="btn small secondary" onClick={() => setEditing(null)}>Cancel</button>
                </form>
              ) : (
                <b>{f.name}</b>
              )}
              {f.kind === "appeals" && <span className="meta"> · years, then {t.levels.map((l) => l.name).join(", ")}</span>}
              <span className="sp" />
              {admin && editing !== `f:${f.id}` && (
                <span className="tpl-actions">
                  <button className="btn small ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${f.name} up`}>↑</button>
                  <button className="btn small ghost" onClick={() => move(i, 1)} disabled={i === t.folders.length - 1} aria-label={`Move ${f.name} down`}>↓</button>
                  {f.kind === "folder" && <button className="btn small ghost" onClick={() => { setEditing(`f:${f.id}`); setDraft(f.name); }}>Rename</button>}
                  {f.kind === "folder" && <button className="btn small ghost" onClick={() => void run(() => api(`/firm/documents/template/folders/${f.id}`, { method: "DELETE" }), `${f.name} removed from the template. Existing folders stay in Dropbox.`)}>Remove</button>}
                </span>
              )}
            </li>
          ))}
        </ol>
        {admin && (
          <form className="inline-form" onSubmit={(e: FormEvent) => { e.preventDefault(); void run(() => api("/firm/documents/template/folders", { method: "POST", body: { name: newFolder } }), `${newFolder} added to the template.`).then(() => setNewFolder("")); }}>
            <input className="in" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="New template folder" aria-label="New template folder name" />
            <button className="btn small" disabled={!newFolder.trim()}>Add folder</button>
          </form>
        )}

        <h4 style={{ marginTop: 18 }}>Level folder names</h4>
        <ul className="tpl-list">
          {t.levels.map((l) => (
            <li key={l.id}>
              <span className="meta" style={{ width: 150, flexShrink: 0 }}>{LEVEL_LABELS[l.level]}</span>
              {editing === `l:${l.id}` ? (
                <form className="rename" onSubmit={(e: FormEvent) => { e.preventDefault(); void run(() => api(`/firm/documents/template/levels/${l.id}`, { method: "PATCH", body: { name: draft } }), "Level folder renamed in the template."); }}>
                  <input className="in" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={`Folder name for ${LEVEL_LABELS[l.level]}`} />
                  <button className="btn small">Save</button>
                  <button type="button" className="btn small secondary" onClick={() => setEditing(null)}>Cancel</button>
                </form>
              ) : <b>{l.name}</b>}
              <span className="sp" />
              {admin && editing !== `l:${l.id}` && <button className="btn small ghost" onClick={() => { setEditing(`l:${l.id}`); setDraft(l.name); }}>Rename</button>}
            </li>
          ))}
        </ul>
      </section>

      <section className="card pad" aria-labelledby="types-h">
        <h3 id="types-h">Document types</h3>
        <p className="small muted" style={{ maxWidth: "70ch" }}>
          The labels staff choose when they profile a document, and the guide shown in each folder for what's saved there. A protected type can be deleted only by roles
          allowed to delete protected files, and by firm admins. A type no longer used can be turned off; documents already profiled with it keep it.
        </p>
        <div className="tw">
          <table className="compact">
            <thead><tr><th>Type</th><th>Saved in</th><th>Protected</th><th>In use</th><th>Active</th></tr></thead>
            <tbody>
              {t.types.map((d) => (
                <tr key={d.id} className={d.active ? "" : "inactive"}>
                  <td>
                    {editing === `t:${d.id}` ? (
                      <form className="rename" onSubmit={(e: FormEvent) => { e.preventDefault(); void run(() => api(`/firm/documents/types/${d.id}`, { method: "PATCH", body: { name: draft } }), "Document type renamed."); }}>
                        <input className="in" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={`New name for ${d.name}`} />
                        <button className="btn small">Save</button>
                        <button type="button" className="btn small secondary" onClick={() => setEditing(null)}>Cancel</button>
                      </form>
                    ) : admin ? <button className="lk" onClick={() => { setEditing(`t:${d.id}`); setDraft(d.name); }} title="Rename">{d.name}</button> : d.name}
                  </td>
                  <td>
                    {admin ? (
                      <select className="in" style={{ height: 28 }} value={whereValue(d)} aria-label={`Where ${d.name} is saved`} onChange={(e) => void run(() => api(`/firm/documents/types/${d.id}`, { method: "PATCH", body: whereBody(e.target.value) }))}>
                        <WhereOptions />
                      </select>
                    ) : whereLabel(d)}
                  </td>
                  <td>
                    <button className={`toggle${d.protected ? " on" : ""}`} aria-label={`Protected: ${d.name}`} aria-pressed={d.protected} disabled={!admin}
                      onClick={() => void run(() => api(`/firm/documents/types/${d.id}`, { method: "PATCH", body: { protected: !d.protected } }))} />
                  </td>
                  <td className="num">{d.documents}</td>
                  <td>
                    <button className={`toggle${d.active ? " on" : ""}`} aria-label={`Active: ${d.name}`} aria-pressed={d.active} disabled={!admin}
                      onClick={() => void run(() => api(`/firm/documents/types/${d.id}`, { method: "PATCH", body: { active: !d.active } }))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {admin && (
          <form className="inline-form" style={{ marginTop: 12 }} onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void run(() => api("/firm/documents/types", { method: "POST", body: { name: newType.name, protected: newType.protected, ...whereBody(newType.where) } }), `${newType.name} added.`).then(() => setNewType({ name: "", where: "", protected: false }));
          }}>
            <input className="in" value={newType.name} onChange={(e) => setNewType({ ...newType, name: e.target.value })} placeholder="New document type" aria-label="New document type name" />
            <select className="in" style={{ maxWidth: 220, height: 30 }} value={newType.where} onChange={(e) => setNewType({ ...newType, where: e.target.value })} aria-label="Where the new type is saved"><WhereOptions /></select>
            <label className="check"><input type="checkbox" checked={newType.protected} onChange={(e) => setNewType({ ...newType, protected: e.target.checked })} /> Protected</label>
            <button className="btn small" disabled={!newType.name.trim()}>Add type</button>
          </form>
        )}
        {!admin && <p className="meta">A firm admin can change the template and the document types.</p>}
      </section>
      {notice && <div className="ok" role="status">{notice}</div>}
      {error && <div className="error" role="alert">{error}</div>}
    </div>
  );
}
