import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError, errorText } from "../api";
import { useSession } from "../App";
import { formatDateTime } from "../format";

// Bulk import: drop a batch of files (CSV or Excel, from a spreadsheet or another system's reports),
// say what each sheet holds and which column is which, preview every row, then commit. Undo takes
// the whole import back out.

type Purpose = "migration" | "new" | "update";
type Action = "new" | "update" | "unchanged" | "problem";
interface FieldDef { key: string; label: string; required: boolean; note: string | null; aliases: string[] }
interface EntityDef { key: string; label: string; fields: FieldDef[] }
interface Options { updateMode: "fill" | "overwrite"; skipProblems: boolean; markHistoryBilled: boolean; applyAsDecision: boolean }
interface Counts { new: number; update: number; unchanged: number; problem: number }
interface Summary { byEntity: Record<string, Counts>; problems: number; total: number }
interface Batch {
  id: number; purpose: Purpose; status: string; error: string | null; job: { kind: string; done: number; total: number } | null; options: Options;
  summary: { preview?: Summary; applied?: { created: Record<string, number>; updated: Record<string, number>; skipped: number }; undo?: { removed: number; restored: number; kept: number } } | null;
  mappingName: string | null; createdAt: string; createdBy: string | null; committedAt: string | null; committedBy: string | null; undoneAt: string | null;
}
interface SheetInfo { name: string; rows: number; headers: string[]; entity: string; columns: Record<string, string>; samples: Record<string, string[]> }
interface FileInfo { id: number; name: string; sheets: SheetInfo[] }
interface Row { position: number; file: string | null; sheet: string | null; row: number | null; entity: string; action: Action; label: string; message: string | null; changes: Record<string, [unknown, unknown]> | null }
interface HistoryRow extends Batch { files: number; fileNames: string | null }

const PURPOSES: { id: Purpose; title: string; text: string }[] = [
  { id: "migration", title: "Move a firm's data in", text: "Everything from the software you used before: clients, properties, PINs, appeal history, contacts and notes. Reports from that system work as they are, one client's or all of them." },
  { id: "new", title: "Add new clients and matters", text: "A spreadsheet of clients, properties and PINs to open in bulk, with this year's appeals if you have them." },
  { id: "update", title: "Update what's here", text: "New values or results for appeals already in Appeal EyeQ (a county's list of decisions, a batch of target values), or corrected property details." },
];
const PURPOSE_LABELS: Record<Purpose, string> = { migration: "Firm migration", new: "New clients and matters", update: "Bulk update" };
const ACTION_LABELS: Record<Action, string> = { new: "New", update: "Changes", unchanged: "Already here", problem: "Can't import" };
const ACTION_PILL: Record<Action, string> = { new: "ok", update: "copper", unchanged: "grey", problem: "crit" };
const COLUMN_LABELS: Record<string, string> = {
  account_number: "Client number", address1: "Address", address2: "Address line 2", city: "City", state: "State", zip: "ZIP", phone: "Phone", email: "Email", mobile: "Mobile", notes: "Notes", title: "Title",
  name: "Name", property_number: "Property number", no_fee: "No fee", tax_code: "Tax code", status: "Status", use_type: "Use", purchase_date: "Purchase date", purchase_price: "Purchase price",
  year_built: "Year built", acreage: "Acreage", units: "Units", building_sqft: "Building sq ft", land_sqft: "Land sq ft", asset_type: "Asset type",
  alternate_pin: "Alternate PIN", owner_name: "Owner", class: "Class", address: "Address",
  tax_year: "Tax year", external_id: "Appeal ID", petition_no: "Docket", filed_on: "Filed", decision_on: "Decided", substage: "Substage",
  orig_av: "Original AV", target_av: "Target AV", resolved_av: "Decided AV", orig_land_av: "Original land", orig_impr_av: "Original building", resolved_land_av: "Decided land", resolved_impr_av: "Decided building",
  original_tax: "Original tax", target_tax: "Target tax", resolved_tax: "Decided tax", estimated_savings: "Est. savings", savings: "Savings", refund_status: "Refund", refund_expected: "Refund expected",
};
const ENTITY_ORDER = ["client", "property", "parcel", "appeal", "contact", "activity"];
const MAX_BYTES = 20 * 1024 * 1024;
const show = (v: unknown) => (v === null || v === undefined || v === "" ? "blank" : String(v));

/** Sends files to an import one at a time; returns how many went in. */
async function sendFiles(id: number, files: File[], onEach: (i: number) => void) {
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    onEach(i);
    if (f.size > MAX_BYTES) throw new ApiError(413, `${f.name} is over 20 MB. Export it in parts, or save it as CSV.`);
    const res = await fetch(`/api/firm/imports/${id}/files?name=${encodeURIComponent(f.name)}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream" }, body: f });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, `${f.name}: ${body.error || `Upload failed (${res.status})`}`);
  }
}

export function Import() {
  const [params, setParams] = useSearchParams();
  const id = Number(params.get("id")) || null;
  return id ? <BatchView id={id} onClose={() => setParams({}, { replace: false })} /> : <Start onStarted={(n) => setParams({ id: String(n) })} />;
}

// ---------------------------------------------------------------- start: purpose, files, history, templates
function Start({ onStarted }: { onStarted: (id: number) => void }) {
  const { me } = useSession();
  const [purpose, setPurpose] = useState<Purpose>("migration");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [entities, setEntities] = useState<EntityDef[]>([]);
  useEffect(() => {
    void api<{ imports: HistoryRow[] }>("/firm/imports").then((d) => setHistory(d.imports)).catch((e) => setError(errorText(e)));
    void api<{ entities: EntityDef[] }>("/firm/imports/fields").then((d) => setEntities(d.entities)).catch(() => undefined);
  }, []);

  async function begin(files: File[]) {
    const ok = files.filter((f) => /\.(xlsx|csv|txt)$/i.test(f.name));
    if (!ok.length) { setError("Choose Excel (.xlsx) or CSV files."); return; }
    setError("");
    let batch = 0;
    try {
      batch = (await api<{ id: number }>("/firm/imports", { method: "POST", body: { purpose } })).id;
      await sendFiles(batch, ok, (i) => setBusy(`Reading ${ok[i].name} (${i + 1} of ${ok.length})`));
      onStarted(batch);
    } catch (e) {
      setError(errorText(e));
      if (batch) onStarted(batch); // keep what came in; the rest can be added on the next screen
    } finally { setBusy(""); }
  }
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) void begin([...e.dataTransfer.files]); };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Import</div>
          <h1>Bring data in</h1>
          <p className="subtitle">Drop the files, check how their columns line up, and see every row before anything changes. One import can be undone as a whole.</p>
        </div>
      </div>
      {me.user.isSuperAdmin ? <div className="notice-box">Imports aren't available under support access.</div> : (
        <>
          <section className="card pad">
            <h3 style={{ marginTop: 0 }}>What are you bringing in?</h3>
            <div className="imp-purposes" role="radiogroup" aria-label="What are you bringing in?">
              {PURPOSES.map((p) => (
                <label key={p.id} className={`imp-purpose${purpose === p.id ? " on" : ""}`}>
                  <input type="radio" name="purpose" value={p.id} checked={purpose === p.id} onChange={() => setPurpose(p.id)} />
                  <b>{p.title}</b>
                  <span>{p.text}</span>
                </label>
              ))}
            </div>
            <div
              className={`dropzone imp-drop${dragging ? " dragging" : ""}`}
              onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
              onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
              onDrop={onDrop}
            >
              <div>
                <b>Drop the files here</b>
                <p className="meta" style={{ margin: "2px 0 0" }}>Excel (.xlsx) or CSV, up to 50 files and 20 MB each. A workbook can hold several sheets; each is read on its own. If the old system exports one client at a time, drop all of them together.</p>
              </div>
              <span className="sp" />
              <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => input.current?.click()}>{busy ? "Reading" : "Choose files"}</button>
              <input ref={input} type="file" multiple hidden accept=".xlsx,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="Choose files to import"
                onChange={(e) => { if (e.target.files?.length) void begin([...e.target.files]); e.target.value = ""; }} />
            </div>
            {busy && <div className="meta" role="status" style={{ marginTop: 8 }}>{busy}</div>}
            {error && <div className="error" role="alert">{error}</div>}
          </section>

          <section className="card">
            <div className="ch"><h3>Imports</h3><span className="meta">Newest first</span></div>
            <div className="tw">
              <table className="compact" aria-label="Import history">
                <thead><tr><th>Started</th><th>Kind</th><th>Files</th><th>Status</th><th>Result</th><th /></tr></thead>
                <tbody>
                  {(history ?? []).map((h) => (
                    <tr key={h.id}>
                      <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(h.createdAt)}<span className="mn" style={{ display: "block" }}>{h.createdBy}</span></td>
                      <td>{PURPOSE_LABELS[h.purpose]}</td>
                      <td style={{ maxWidth: 260 }}>{h.files} file{h.files === 1 ? "" : "s"}<span className="mn" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.fileNames}</span></td>
                      <td><StatusPill b={h} /></td>
                      <td className="meta">{resultText(h)}</td>
                      <td><Link to={`/import?id=${h.id}`}>Open</Link></td>
                    </tr>
                  ))}
                  {history && !history.length && <tr><td colSpan={6} className="meta" style={{ padding: 18, textAlign: "center" }}>Nothing imported yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card pad">
            <h3 style={{ marginTop: 0 }}>Starting from a spreadsheet?</h3>
            <p className="meta" style={{ marginTop: 0 }}>Any columns work; you match them up after dropping the file. These templates have one column per field, already named the way Appeal EyeQ recognizes.</p>
            <div className="chips">
              {entities.map((e) => <a key={e.key} className="btn small secondary" href={`/api/firm/imports/templates/${e.key}.csv`} download>{e.label}</a>)}
            </div>
          </section>
        </>
      )}
    </>
  );
}

function resultText(b: Batch): string {
  const a = b.summary?.applied;
  if (b.status === "undone") return `Undone ${b.undoneAt ? formatDateTime(b.undoneAt) : ""}`.trim();
  if (a) {
    const made = Object.values(a.created).reduce((x, y) => x + y, 0), changed = Object.values(a.updated).reduce((x, y) => x + y, 0);
    return [made && `${made.toLocaleString("en-US")} added`, changed && `${changed.toLocaleString("en-US")} changed`, a.skipped && `${a.skipped} left out`].filter(Boolean).join(" · ") || "Nothing changed";
  }
  const p = b.summary?.preview;
  return p ? `${p.total.toLocaleString("en-US")} rows previewed${p.problems ? `, ${p.problems} can't import` : ""}` : "";
}
function StatusPill({ b }: { b: Batch }) {
  const [cls, label] = ({
    draft: ["grey", "Not previewed"], previewed: ["net", "Previewed"], committing: ["copper", "Importing"], committed: ["ok", "Imported"], undoing: ["copper", "Undoing"], undone: ["grey", "Undone"],
  } as Record<string, [string, string]>)[b.status] ?? ["grey", b.status];
  return <span className={`pill ${cls}`}>{label}</span>;
}

// ---------------------------------------------------------------- one import
function BatchView({ id, onClose }: { id: number; onClose: () => void }) {
  const navigate = useNavigate();
  const { me } = useSession();
  const [batch, setBatch] = useState<Batch | null>(null);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [entities, setEntities] = useState<EntityDef[]>([]);
  const [mappings, setMappings] = useState<{ id: number; name: string; sheets: number }[]>([]);
  const [edits, setEdits] = useState<Record<string, { entity: string; columns: Record<string, string> }>>({});
  const [opts, setOpts] = useState<Options | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const d = await api<{ import: Batch; files: FileInfo[] }>(`/firm/imports/${id}`);
    setBatch(d.import);
    setFiles(d.files);
    setOpts(d.import.options);
    setEdits({});
    return d.import;
  }, [id]);
  useEffect(() => {
    load().catch((e) => setError(errorText(e)));
    void api<{ entities: EntityDef[] }>("/firm/imports/fields").then((d) => setEntities(d.entities)).catch(() => undefined);
    void api<{ mappings: { id: number; name: string; sheets: number }[] }>("/firm/import-mappings").then((d) => setMappings(d.mappings)).catch(() => undefined);
  }, [load]);

  // While a large import runs in the background, check on it every second.
  const running = batch?.status === "committing" || batch?.status === "undoing";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => { void load().catch(() => undefined); }, 1000);
    return () => clearInterval(t);
  }, [running, load]);

  const locked = !batch || ["committing", "committed", "undoing", "undone"].includes(batch.status);
  const key = (f: FileInfo, s: SheetInfo) => `${f.id}\u0000${s.name}`;
  const sheetOf = (f: FileInfo, s: SheetInfo) => edits[key(f, s)] ?? { entity: s.entity, columns: s.columns };
  const dirty = Object.keys(edits).length > 0 || (batch && opts && JSON.stringify(opts) !== JSON.stringify(batch.options));

  async function act(label: string, fn: () => Promise<string | void>) {
    setBusy(label); setError(""); setNotice("");
    try { const m = await fn(); if (m) setNotice(m); } catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  }
  async function saveMapping() {
    const sheets = files.flatMap((f) => f.sheets.filter((s) => edits[key(f, s)]).map((s) => ({ fileId: f.id, sheet: s.name, ...sheetOf(f, s) })));
    await api(`/firm/imports/${id}/mapping`, { method: "PUT", body: { sheets, options: opts ?? undefined } });
  }
  const preview = () => act("preview", async () => {
    if (dirty) await saveMapping();
    await api(`/firm/imports/${id}/preview`, { method: "POST", body: {} });
    await load();
  });
  const commit = () => act("commit", async () => {
    const r = await fetch(`/api/firm/imports/${id}/commit`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(r.status, body.error || `Import failed (${r.status})`);
    const b = await load();
    if (b.status === "committed") return "Imported.";
  });
  const undo = () => act("undo", async () => {
    if (!window.confirm("Undo this import? Everything it added is removed, and what it changed goes back to how it was (unless someone has changed it since).")) return;
    await api(`/firm/imports/${id}/undo`, { method: "POST", body: {} });
    const b = await load();
    if (b.status === "undone") return "Undone.";
  });
  const discard = () => act("discard", async () => {
    await api(`/firm/imports/${id}`, { method: "DELETE" });
    onClose();
  });
  const addFiles = (list: File[]) => act("upload", async () => {
    await sendFiles(id, list.filter((f) => /\.(xlsx|csv|txt)$/i.test(f.name)), (i) => setBusy(`Reading ${list[i]?.name ?? ""}`));
    await load();
  });
  const removeFile = (f: FileInfo) => act("remove", async () => { await api(`/firm/imports/${id}/files/${f.id}`, { method: "DELETE" }); await load(); });
  const applySaved = (mappingId: number) => act("mapping", async () => {
    await api(`/firm/imports/${id}/mapping`, { method: "PUT", body: { mappingId } });
    await load();
    return "Saved mapping applied.";
  });
  const saveAs = () => act("save", async () => {
    const name = window.prompt("Save this mapping as", batch?.mappingName ?? "");
    if (!name?.trim()) return;
    if (dirty) await saveMapping();
    await api("/firm/import-mappings", { method: "POST", body: { name: name.trim(), importId: id } });
    setMappings((await api<{ mappings: { id: number; name: string; sheets: number }[] }>("/firm/import-mappings")).mappings);
    await load();
    return `Saved as "${name.trim()}". Choose it next time from Saved mappings.`;
  });

  if (!batch || !opts) return <>{error ? <div className="error" role="alert">{error}</div> : <p className="meta">Loading</p>}</>;
  const preview_ = batch.summary?.preview;
  const sheetsIn = files.reduce((n, f) => n + f.sheets.length, 0);
  const used = files.reduce((n, f) => n + f.sheets.filter((s) => sheetOf(f, s).entity !== "skip").length, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow"><Link to="/import" onClick={(e) => { e.preventDefault(); onClose(); }}>Import</Link></div>
          <h1>{PURPOSE_LABELS[batch.purpose]}</h1>
          <p className="subtitle">Started {formatDateTime(batch.createdAt)}{batch.createdBy ? ` by ${batch.createdBy}` : ""} · {files.length} file{files.length === 1 ? "" : "s"} · {used} of {sheetsIn} sheets in use <StatusPill b={batch} /></p>
        </div>
        <div className="actions">
          {!locked && <button className="btn ghost" disabled={Boolean(busy)} onClick={() => void discard()}>Discard</button>}
        </div>
      </div>
      {batch.error && <div className="notice-box copper" role="alert">{batch.error}</div>}
      {error && <div className="error" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <div className="ok" role="status" style={{ marginBottom: 12 }}>{notice}</div>}

      {running && batch.job && (
        <section className="card pad" aria-live="polite">
          <b>{batch.job.kind === "commit" ? "Importing" : "Undoing"} {batch.job.done.toLocaleString("en-US")} of {batch.job.total.toLocaleString("en-US")}</b>
          <div className="imp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={batch.job.total} aria-valuenow={batch.job.done}><span style={{ width: `${batch.job.total ? (100 * batch.job.done) / batch.job.total : 0}%` }} /></div>
          <p className="meta" style={{ marginBottom: 0 }}>It all goes in together or not at all, so it's safe to leave this page; come back to Import to see how it went.</p>
        </section>
      )}

      {(batch.status === "committed" || batch.status === "undone") && <Outcome b={batch} busy={busy} onUndo={() => void undo()} canUndo={batch.status === "committed" && (me.user.isFirmAdmin || batch.committedBy === me.user.name)} onGo={(to) => navigate(to)} />}

      {!locked && (
        <>
          <section className="card">
            <div className="ch"><h3>Files</h3><span className="meta">Each sheet is read on its own</span></div>
            <div className="cb">
              {files.map((f) => (
                <div key={f.id} className="imp-file">
                  <span className="tt">{f.name}</span>
                  <span className="meta">{f.sheets.length} sheet{f.sheets.length === 1 ? "" : "s"} · {f.sheets.reduce((n, s) => n + s.rows, 0).toLocaleString("en-US")} rows</span>
                  <span className="sp" />
                  <button className="btn small ghost" disabled={Boolean(busy)} onClick={() => void removeFile(f)} aria-label={`Remove ${f.name}`}>Remove</button>
                </div>
              ))}
              <div
                className={`dropzone imp-drop small${dragging ? " dragging" : ""}`}
                onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
                onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
                onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) void addFiles([...e.dataTransfer.files]); }}
              >
                <span className="meta">Drop more files to add them to this import.</span>
                <span className="sp" />
                <button type="button" className="btn small secondary" disabled={Boolean(busy)} onClick={() => input.current?.click()}>Add files</button>
                <input ref={input} type="file" multiple hidden accept=".xlsx,.csv,.txt" aria-label="Add files to this import" onChange={(e) => { if (e.target.files?.length) void addFiles([...e.target.files]); e.target.value = ""; }} />
              </div>
            </div>
          </section>

          <section className="card">
            <div className="ch">
              <h3>Sheets and columns</h3>
              <div className="imp-maps">
                {mappings.length > 0 && (
                  <label className="meta">Saved mappings{" "}
                    <select value="" onChange={(e) => { if (e.target.value) void applySaved(Number(e.target.value)); }} aria-label="Apply a saved mapping">
                      <option value="">Apply one</option>
                      {mappings.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </label>
                )}
                <button className="btn small secondary" disabled={Boolean(busy)} onClick={() => void saveAs()}>Save this mapping</button>
              </div>
            </div>
            <div className="cb">
              <p className="meta" style={{ marginTop: 0 }}>Appeal EyeQ worked out what each sheet holds and which column is which. Check the ones in use; a sheet that repeats another (a summary page, a second copy of the appeals) is set to Skip.</p>
              {files.map((f) => f.sheets.map((s) => (
                <SheetCard key={key(f, s)} file={f} sheet={s} value={sheetOf(f, s)} entities={entities} showFile={files.length > 1}
                  onChange={(v) => setEdits((e) => ({ ...e, [key(f, s)]: v }))} />
              )))}
            </div>
          </section>

          <section className="card pad">
            <h3 style={{ marginTop: 0 }}>How to bring it in</h3>
            <div className="imp-opts">
              <fieldset>
                <legend>When a record is already in Appeal EyeQ</legend>
                <label className="check"><input type="radio" name="mode" checked={opts.updateMode === "fill"} onChange={() => setOpts({ ...opts, updateMode: "fill" })} /> Fill in only what's blank here</label>
                <label className="check"><input type="radio" name="mode" checked={opts.updateMode === "overwrite"} onChange={() => setOpts({ ...opts, updateMode: "overwrite" })} /> Replace what's here with the file's values</label>
              </fieldset>
              <fieldset>
                <legend>Appeals</legend>
                <label className="check"><input type="checkbox" checked={opts.markHistoryBilled} onChange={(e) => setOpts({ ...opts, markHistoryBilled: e.target.checked })} /> Decided Assessor and BOR reductions were billed before, so keep them off Ready to bill</label>
                <label className="check"><input type="checkbox" checked={opts.applyAsDecision} onChange={(e) => setOpts({ ...opts, applyAsDecision: e.target.checked })} /> A result that's new here is handled like a decision letter (Decision analysis, the invoice drafted, the refund awaited)</label>
              </fieldset>
              <fieldset>
                <legend>Rows that can't come in</legend>
                <label className="check"><input type="checkbox" checked={opts.skipProblems} onChange={(e) => setOpts({ ...opts, skipProblems: e.target.checked })} /> Leave them out and import the rest</label>
              </fieldset>
            </div>
            <div className="imp-go">
              <button className="btn" disabled={Boolean(busy) || !used} onClick={() => void preview()}>{busy === "preview" ? "Checking every row" : preview_ && batch.status === "previewed" && !dirty ? "Preview again" : "Preview"}</button>
              {dirty && <span className="meta">Changes since the last preview</span>}
            </div>
          </section>

          {preview_ && batch.status === "previewed" && !dirty && (
            <Preview id={id} summary={preview_} busy={busy} onCommit={() => void commit()} skip={opts.skipProblems} />
          )}
        </>
      )}
    </>
  );
}

function SheetCard({ file, sheet, value, entities, showFile, onChange }: {
  file: FileInfo; sheet: SheetInfo; value: { entity: string; columns: Record<string, string> }; entities: EntityDef[]; showFile: boolean;
  onChange: (v: { entity: string; columns: Record<string, string> }) => void;
}) {
  const ent = entities.find((e) => e.key === value.entity);
  const matched = ent ? ent.fields.filter((f) => value.columns[f.key]).length : 0;
  const missing = ent ? ent.fields.filter((f) => f.required && !value.columns[f.key]) : [];
  return (
    <details className={`imp-sheet${value.entity === "skip" ? " skip" : ""}`} open={value.entity !== "skip" && missing.length > 0}>
      <summary>
        <span className="tt">{sheet.name}{showFile && <span className="mn"> · {file.name}</span>}</span>
        <span className="meta">{sheet.rows.toLocaleString("en-US")} row{sheet.rows === 1 ? "" : "s"}</span>
        <span className="sp" />
        {ent && <span className={`pill ${missing.length ? "warn" : "net"}`}>{missing.length ? `Needs ${missing.map((m) => m.label).join(", ")}` : `${matched} of ${ent.fields.length} fields`}</span>}
        <select value={value.entity} aria-label={`What ${sheet.name} holds`} onClick={(e) => e.stopPropagation()}
          onChange={(e) => onChange({ entity: e.target.value, columns: e.target.value === value.entity ? value.columns : guess(entities.find((x) => x.key === e.target.value), sheet.headers) })}>
          <option value="skip">Skip</option>
          {entities.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
        </select>
      </summary>
      {ent && (
        <div className="tw">
          <table className="compact imp-cols" aria-label={`Columns in ${sheet.name}`}>
            <thead><tr><th>Field</th><th>Column in the file</th><th>Sample values</th></tr></thead>
            <tbody>
              {ent.fields.map((f) => {
                const h = value.columns[f.key] ?? "";
                return (
                  <tr key={f.key}>
                    <td>{f.label}{f.required && <span className="req" aria-label="required"> *</span>}{f.note && <span className="mn" style={{ display: "block" }}>{f.note}</span>}</td>
                    <td>
                      <select value={h} aria-label={`Column for ${f.label}`} onChange={(e) => {
                        const cols = { ...value.columns };
                        if (e.target.value) { for (const k of Object.keys(cols)) if (cols[k] === e.target.value) delete cols[k]; cols[f.key] = e.target.value; } else delete cols[f.key];
                        onChange({ entity: value.entity, columns: cols });
                      }}>
                        <option value="">Not in this file</option>
                        {sheet.headers.map((x) => <option key={x} value={x}>{x}</option>)}
                      </select>
                    </td>
                    <td className="meta imp-sample">{h ? (sheet.samples[h] ?? []).join(" · ") || "blank" : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

/** The same matching the server does: the field's label or any name it's known by, each column used once. */
function guess(ent: EntityDef | undefined, headers: string[]): Record<string, string> {
  if (!ent) return {};
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]/g, "");
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const f of ent.fields) {
    for (const a of [f.label, ...f.aliases]) {
      const h = headers.find((x) => !used.has(x) && n(x) === n(a));
      if (h) { out[f.key] = h; used.add(h); break; }
    }
  }
  return out;
}

function Preview({ id, summary, busy, onCommit, skip }: { id: number; summary: Summary; busy: string; onCommit: () => void; skip: boolean }) {
  const [filter, setFilter] = useState<{ action: Action | ""; entity: string }>(() => ({ action: summary.problems ? "problem" : "", entity: "" }));
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [entities, setEntities] = useState<Record<string, string>>({});
  useEffect(() => { void api<{ entities: EntityDef[] }>("/firm/imports/fields").then((d) => setEntities(Object.fromEntries(d.entities.map((e) => [e.key, e.label])))); }, []);
  const fetchRows = useCallback(async (offset: number) => {
    const q = new URLSearchParams({ offset: String(offset), ...(filter.action ? { action: filter.action } : {}), ...(filter.entity ? { entity: filter.entity } : {}) });
    const d = await api<{ total: number; rows: Row[] }>(`/firm/imports/${id}/rows?${q}`);
    setTotal(d.total);
    setRows((r) => (offset ? [...r, ...d.rows] : d.rows));
  }, [id, filter]);
  useEffect(() => { void fetchRows(0); }, [fetchRows]);
  const order = ENTITY_ORDER.filter((e) => summary.byEntity[e]);
  const sum = (a: Action) => order.reduce((n, e) => n + summary.byEntity[e][a], 0);
  const going = sum("new") + sum("update");
  const blocked = summary.problems > 0 && !skip;

  return (
    <section className="card">
      <div className="ch"><h3>Preview</h3><span className="meta">Nothing has changed yet</span></div>
      <div className="cb">
        <div className="tw">
          <table className="compact imp-summary" aria-label="What this import would do">
            <thead><tr><th /><th className="num">New</th><th className="num">Changes</th><th className="num">Already here</th><th className="num">Can't import</th></tr></thead>
            <tbody>
              {order.map((e) => (
                <tr key={e}>
                  <th scope="row">{entities[e] ?? e}</th>
                  {(["new", "update", "unchanged", "problem"] as Action[]).map((a) => (
                    <td key={a} className="num">
                      {summary.byEntity[e][a] ? <button className={`lk${a === "problem" ? " bad" : ""}`} onClick={() => setFilter({ action: a, entity: e })}>{summary.byEntity[e][a].toLocaleString("en-US")}</button> : <span className="meta">0</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="imp-filter">
          <div className="chips" role="group" aria-label="Show rows">
            {(["", "problem", "new", "update", "unchanged"] as (Action | "")[]).map((a) => (
              <button key={a || "all"} className={`btn small ${filter.action === a ? "" : "secondary"}`} onClick={() => setFilter({ action: a, entity: filter.entity })}>
                {a ? ACTION_LABELS[a] : "All rows"}
              </button>
            ))}
          </div>
          {filter.entity && <button className="lk" onClick={() => setFilter({ ...filter, entity: "" })}>Every kind of record</button>}
          {summary.problems > 0 && <a className="lk" href={`/api/firm/imports/${id}/problems.csv`} download>Download the rows that can't import</a>}
        </div>
        <ul className="imp-rows" aria-label="Rows">
          {rows.map((r) => (
            <li key={r.position}>
              <div className="imp-row-head">
                <span className={`pill ${ACTION_PILL[r.action]}`}>{ACTION_LABELS[r.action]}</span>
                <span className="meta">{entities[r.entity] ?? r.entity}</span>
                <b className="imp-label">{r.label}</b>
                <span className="sp" />
                {r.file && <span className="meta">{r.file}{r.sheet && r.sheet !== r.file.replace(/\.[^.]+$/, "") ? ` · ${r.sheet}` : ""}{r.row ? ` · row ${r.row}` : ""}</span>}
              </div>
              {r.message && <div className={r.action === "problem" ? "imp-msg bad" : "imp-msg"}>{r.message}</div>}
              {r.changes && r.action !== "problem" && (
                <div className="imp-changes">
                  {Object.entries(r.changes).map(([col, [a, b]]) => (
                    <span key={col}><span className="meta">{COLUMN_LABELS[col] ?? col}</span> {r.action === "new" ? show(b) : <>{show(a)} → <b>{show(b)}</b></>}</span>
                  ))}
                </div>
              )}
            </li>
          ))}
          {!rows.length && <li className="meta">No rows here.</li>}
        </ul>
        {rows.length < total && <button className="btn small secondary" onClick={() => void fetchRows(rows.length)}>Show more ({(total - rows.length).toLocaleString("en-US")} left)</button>}
      </div>
      <div className="cb imp-commit">
        <div>
          <b>{going ? `${sum("new").toLocaleString("en-US")} new and ${sum("update").toLocaleString("en-US")} changed` : "Nothing new to bring in"}</b>
          <p className="meta" style={{ margin: "2px 0 0" }}>
            {blocked ? `${summary.problems} row${summary.problems === 1 ? "" : "s"} can't import. Fix them in the file and add it again, or choose to leave them out above.`
              : `${summary.problems ? `${summary.problems} row${summary.problems === 1 ? "" : "s"} left out. ` : ""}It all goes in together, and Undo takes it all back out.`}
          </p>
        </div>
        <span className="sp" />
        <button className="btn copper" disabled={Boolean(busy) || blocked || !going} onClick={onCommit}>{busy === "commit" ? "Importing" : "Import"}</button>
      </div>
    </section>
  );
}

function Outcome({ b, busy, onUndo, canUndo, onGo }: { b: Batch; busy: string; onUndo: () => void; canUndo: boolean; onGo: (to: string) => void }) {
  const a = b.summary?.applied;
  const LABELS: Record<string, [string, string]> = {
    client: ["client", "clients"], property: ["property", "properties"], parcel: ["PIN", "PINs"], appeal: ["appeal", "appeals"], contact: ["contact", "contacts"], activity: ["activity", "activities"], invoice: ["draft invoice", "draft invoices"],
  };
  const list = (m: Record<string, number>) => Object.entries(m).map(([k, n]) => `${n.toLocaleString("en-US")} ${LABELS[k]?.[n === 1 ? 0 : 1] ?? k}`).join(", ");
  const u = b.summary?.undo;
  return (
    <section className="card pad">
      {b.status === "committed" ? (
        <>
          <h3 style={{ marginTop: 0 }}>Imported {b.committedAt ? formatDateTime(b.committedAt) : ""}{b.committedBy ? ` by ${b.committedBy}` : ""}</h3>
          {a && Object.keys(a.created).length > 0 && <p>Added {list(a.created)}.</p>}
          {a && Object.keys(a.updated).length > 0 && <p>Changed {list(a.updated)}.</p>}
          {a && a.skipped > 0 && <p className="meta">{a.skipped} row{a.skipped === 1 ? "" : "s"} left out.</p>}
          <div className="chips">
            <button className="btn small secondary" onClick={() => onGo("/accounts")}>Clients</button>
            <button className="btn small secondary" onClick={() => onGo("/properties")}>Properties</button>
            {canUndo && <button className="btn small danger" disabled={Boolean(busy)} onClick={onUndo}>{busy === "undo" ? "Undoing" : "Undo this import"}</button>}
          </div>
        </>
      ) : (
        <>
          <h3 style={{ marginTop: 0 }}>Undone {b.undoneAt ? formatDateTime(b.undoneAt) : ""}</h3>
          {u && <p>Removed {u.removed.toLocaleString("en-US")} record{u.removed === 1 ? "" : "s"}{u.restored ? ` and put ${u.restored} back as they were` : ""}.{u.kept ? ` ${u.kept} value${u.kept === 1 ? " was" : "s were"} changed by someone since, so ${u.kept === 1 ? "it was" : "they were"} kept.` : ""}</p>}
        </>
      )}
    </section>
  );
}
