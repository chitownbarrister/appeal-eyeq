// Super admin: the reference data every firm reads. Windows, equalizers,
// tax rates and townships can be added, edited, deleted and uploaded as CSV.
// Publishing an equalizer or rate refreshes firms' undecided appeals; the
// server reports how many, without showing any firm's data.

import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import { api, errorText, ApiError } from "../api";
import { clearLookupCache, type County, type Township } from "../data";
import { formatDate, formatDateTime, nn } from "../format";
import { LEVELS, LEVEL_LABELS, type Level } from "../../../shared/domain";
import { Sheet } from "./Sheet";

interface WindowRow { id: number; county_id: number; township_id: number | null; county: string; township: string | null; level: Level; assessment_year: number; opens_on: string; closes_on: string; note: string | null; is_sample: boolean }
interface EqRow { id: number; county_id: number; township_id: number | null; county: string; township: string | null; year: number; factor: string; source: string | null; is_sample: boolean }
interface RateRow { id: number; county_id: number; county: string; tax_code: string; tax_year: number; rate_percent: string; source: string | null; is_sample: boolean }
interface Refresh { appealsUpdated: number; firmsUpdated: number }
interface ChangeRow { id: number; table_name: string; action: string; at: string; actor_name: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null }

type Panel = "windows" | "equalizers" | "rates" | "townships" | "log";
const PANELS: { id: Panel; label: string }[] = [
  { id: "windows", label: "Filing windows" }, { id: "equalizers", label: "Equalizers" }, { id: "rates", label: "Tax rates" },
  { id: "townships", label: "Townships" }, { id: "log", label: "Change log" },
];

function refreshText(r: Refresh | undefined): string {
  if (!r) return "";
  if (!r.appealsUpdated) return " No open appeals needed new estimates.";
  return ` Estimates refreshed on ${r.appealsUpdated} open appeal${r.appealsUpdated === 1 ? "" : "s"} at ${r.firmsUpdated} firm${r.firmsUpdated === 1 ? "" : "s"}.`;
}

export function ReferenceTab() {
  const [panel, setPanel] = useState<Panel>("windows");
  const [geo, setGeo] = useState<{ counties: County[]; townships: Township[] }>({ counties: [], townships: [] });
  const [notice, setNotice] = useState("");
  const loadGeo = useCallback(() => api<{ counties: County[]; townships: Township[] }>("/reference/counties").then(setGeo), []);
  useEffect(() => { void loadGeo(); }, [loadGeo]);
  const say = (msg: string) => { setNotice(msg); window.setTimeout(() => setNotice((n) => (n === msg ? "" : n)), 9000); };

  return (
    <>
      <div className="card pad">
        <p className="muted small" style={{ margin: 0 }}>
          Every firm reads these figures. When you save an equalizer or tax rate, each firm's open appeals in that county that haven't been decided
          pick it up and their estimates are recalculated. Decided appeals and figures someone entered by hand keep their numbers and show a
          “Newer rate” flag instead. Rows marked Sample are placeholders until you replace them.
        </p>
      </div>
      <div className="subtabs" role="tablist" style={{ padding: 0, marginTop: 16 }}>
        {PANELS.map((p) => (
          <button key={p.id} role="tab" aria-selected={panel === p.id} className={panel === p.id ? "active" : ""} onClick={() => setPanel(p.id)}>{p.label}</button>
        ))}
      </div>
      {notice && <div className="ok" role="status" style={{ marginBottom: 8 }}>{notice}</div>}
      <div style={{ marginTop: 16 }}>
        {panel === "windows" && <WindowsPanel geo={geo} say={say} />}
        {panel === "equalizers" && <EqualizersPanel geo={geo} say={say} />}
        {panel === "rates" && <RatesPanel geo={geo} say={say} />}
        {panel === "townships" && <TownshipsPanel geo={geo} reload={async () => { clearLookupCache(); await loadGeo(); }} say={say} />}
        {panel === "log" && <ChangeLog />}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- shared bits
function CountySelect({ id, geo, value, onChange, all }: { id: string; geo: { counties: County[] }; value: string; onChange: (v: string) => void; all?: boolean }) {
  return (
    <select id={id} className="in" value={value} onChange={(e) => onChange(e.target.value)}>
      {all ? <option value="">All counties</option> : <option value="">Choose</option>}
      {geo.counties.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}

function TownshipSelect({ id, geo, countyId, value, onChange }: { id: string; geo: { townships: Township[] }; countyId: string; value: string; onChange: (v: string) => void }) {
  return (
    <select id={id} className="in" value={value} onChange={(e) => onChange(e.target.value)} disabled={!countyId}>
      <option value="">County-wide</option>
      {geo.townships.filter((t) => String(t.county_id) === countyId).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
  );
}

function RowActions({ label, onEdit, onDelete }: { label: string; onEdit: () => void; onDelete: () => Promise<void> }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  if (confirm) {
    return (
      <span className="confirm" style={{ justifyContent: "flex-end" }}>
        Delete {label}?
        <button className="btn small danger" onClick={async () => { try { await onDelete(); } catch (err) { setError(errorText(err)); } }}>Delete</button>
        <button className="btn small secondary" onClick={() => setConfirm(false)}>Keep</button>
        {error && <span role="alert">{error}</span>}
      </span>
    );
  }
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <button className="btn small ghost" onClick={onEdit} aria-label={`Edit ${label}`}>Edit</button>
      <button className="btn small ghost" onClick={() => setConfirm(true)} aria-label={`Delete ${label}`}>Delete</button>
    </span>
  );
}

function ImportBox({ kind, columns, example, onDone }: { kind: "windows" | "equalizers" | "tax-rates"; columns: string; example: string; onDone: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [rows, setRows] = useState<string[]>([]);
  function readFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ""));
    reader.readAsText(file);
  }
  async function upload() {
    setBusy(true);
    setError("");
    setRows([]);
    try {
      const r = await api<{ added: number; updated: number; unchanged: number; refresh: Refresh }>(`/admin/import/${kind}`, { method: "POST", body: { csv: text } });
      onDone(`Upload saved: ${r.added} added, ${r.updated} updated, ${r.unchanged} already up to date.${refreshText(r.refresh)}`);
      setText("");
      setOpen(false);
    } catch (err) {
      setError(errorText(err));
      if (err instanceof ApiError && Array.isArray(err.body?.rows)) setRows(err.body.rows as string[]);
    } finally {
      setBusy(false);
    }
  }
  if (!open) return <button className="btn small secondary" onClick={() => setOpen(true)}>Upload CSV</button>;
  return (
    <div className="card pad ref-import" style={{ flexBasis: "100%" }}>
      <div className="meta">Columns: {columns}. Existing rows are updated; nothing is saved if any row has a problem.</div>
      <label htmlFor={`imp-${kind}`} className="meta">CSV</label>
      <textarea id={`imp-${kind}`} value={text} onChange={(e) => setText(e.target.value)} placeholder={example} spellCheck={false} />
      <div className="tbar" style={{ margin: 0 }}>
        <input type="file" accept=".csv,text/csv" onChange={readFile} aria-label="Choose a CSV file" />
        <span className="sp" />
        <button className="btn small secondary" onClick={() => setOpen(false)}>Cancel</button>
        <button className="btn small" disabled={busy || !text.trim()} onClick={() => void upload()}>{busy ? "Uploading" : "Upload"}</button>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {rows.length > 0 && <ul className="ref-errors">{rows.map((r) => <li key={r}>{r}</li>)}</ul>}
    </div>
  );
}

function SheetFooter({ busy, error, onClose, label }: { busy: boolean; error: string; onClose: () => void; label: string }) {
  return (
    <>
      {error && <span className="error" style={{ margin: 0, flexBasis: "100%" }} role="alert">{error}</span>}
      <span className="sp" />
      <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
      <button className="btn" disabled={busy}>{busy ? "Saving" : label}</button>
    </>
  );
}

// ---------------------------------------------------------------- windows
function WindowsPanel({ geo, say }: { geo: { counties: County[]; townships: Township[] }; say: (m: string) => void }) {
  const [rows, setRows] = useState<WindowRow[]>([]);
  const [year, setYear] = useState("");
  const [county, setCounty] = useState("");
  const [editing, setEditing] = useState<WindowRow | "new" | null>(null);
  const load = useCallback(() => api<{ windows: WindowRow[] }>("/reference/windows").then((d) => setRows(d.windows)), []);
  useEffect(() => { void load(); }, [load]);
  const years = useMemo(() => [...new Set(rows.map((r) => r.assessment_year))].sort((a, b) => b - a), [rows]);
  const shown = rows.filter((r) => (!year || String(r.assessment_year) === year) && (!county || String(r.county_id) === county));
  return (
    <section className="card">
      <div className="ch">
        <h3>Filing windows <span className="meta">{shown.length} of {rows.length}</span></h3>
        <div className="tbar" style={{ margin: 0 }}>
          <select aria-label="Assessment year" className="in" style={{ width: "auto", height: 28 }} value={year} onChange={(e) => setYear(e.target.value)}>
            <option value="">All years</option>{years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <select aria-label="County" className="in" style={{ width: "auto", height: 28 }} value={county} onChange={(e) => setCounty(e.target.value)}>
            <option value="">All counties</option>{geo.counties.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <ImportBox kind="windows" columns="County, Township (blank for county-wide), Level, Year, Opens, Closes, Note" example={"County,Township,Level,Year,Opens,Closes,Note\nCook,New Trier,Board of Review,2026,2026-07-20,2026-08-19,"} onDone={(m) => { say(m); void load(); }} />
          <button className="btn small" onClick={() => setEditing("new")}>+ Window</button>
        </div>
      </div>
      <div className="tw" style={{ marginTop: 12 }}>
        <table className="compact">
          <thead><tr><th>County</th><th>Township</th><th>Level</th><th>Year</th><th>Opens</th><th>Closes</th><th>Note</th><th /></tr></thead>
          <tbody>
            {shown.map((w) => (
              <tr key={w.id}>
                <td>{w.county}</td><td>{w.township ?? "County-wide"}</td><td>{LEVEL_LABELS[w.level]}</td><td className="num">{w.assessment_year}</td>
                <td className="num">{formatDate(w.opens_on)}</td><td className="num">{formatDate(w.closes_on)}</td>
                <td className="meta">{w.note}{w.is_sample && <> <span className="pill grey">Sample</span></>}</td>
                <td className="num"><RowActions label={`${w.township ?? w.county} ${LEVEL_LABELS[w.level]} ${w.assessment_year}`} onEdit={() => setEditing(w)} onDelete={async () => { await api(`/admin/windows/${w.id}`, { method: "DELETE" }); say("Window deleted."); await load(); }} /></td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={8} className="meta" style={{ textAlign: "center", padding: 20 }}>No windows yet. Add one, or upload the year's calendar as a CSV.</td></tr>}
          </tbody>
        </table>
      </div>
      {editing && <WindowSheet geo={geo} row={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={(m) => { setEditing(null); say(m); void load(); }} />}
    </section>
  );
}

function WindowSheet({ geo, row, onClose, onSaved }: { geo: { counties: County[]; townships: Township[] }; row: WindowRow | null; onClose: () => void; onSaved: (m: string) => void }) {
  const [f, setF] = useState({
    countyId: row ? String(row.county_id) : "", townshipId: row?.township_id ? String(row.township_id) : "", level: row?.level ?? "bor",
    assessmentYear: String(row?.assessment_year ?? new Date().getFullYear()), opensOn: row?.opens_on ?? "", closesOn: row?.closes_on ?? "", note: row?.note ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true); setError("");
    const body = { countyId: Number(f.countyId), townshipId: f.townshipId ? Number(f.townshipId) : null, level: f.level, assessmentYear: Number(f.assessmentYear), opensOn: f.opensOn, closesOn: f.closesOn, note: nn(f.note) };
    try {
      if (row) await api(`/admin/windows/${row.id}`, { method: "PATCH", body }); else await api("/admin/windows", { method: "POST", body });
      onSaved(row ? "Window updated. Every firm sees the new dates now." : "Window published to every firm.");
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return (
    <Sheet eyebrow={row ? "Edit filing window" : "New filing window"} title={row ? `${row.township ?? row.county} ${LEVEL_LABELS[row.level]} ${row.assessment_year}` : "Publish a filing window"} onClose={onClose} onSubmit={() => void save()} footer={<SheetFooter busy={busy} error={error} onClose={onClose} label="Publish window" />}>
      <div className="fgrid">
        <div className="fld"><label htmlFor="w-county">County</label><CountySelect id="w-county" geo={geo} value={f.countyId} onChange={(v) => setF({ ...f, countyId: v, townshipId: "" })} /></div>
        <div className="fld"><label htmlFor="w-twp">Township</label><TownshipSelect id="w-twp" geo={geo} countyId={f.countyId} value={f.townshipId} onChange={(v) => setF({ ...f, townshipId: v })} /></div>
        <div className="fld"><label htmlFor="w-level">Level</label>
          <select id="w-level" className="in" value={f.level} onChange={(e) => setF({ ...f, level: e.target.value as Level })}>{LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}</select>
        </div>
        <div className="fld"><label htmlFor="w-year">Assessment year</label><input id="w-year" className="in num" inputMode="numeric" value={f.assessmentYear} onChange={(e) => setF({ ...f, assessmentYear: e.target.value })} /></div>
        <div className="fld"><label htmlFor="w-open">Opens</label><input id="w-open" type="date" className="in" value={f.opensOn} required onChange={(e) => setF({ ...f, opensOn: e.target.value })} /></div>
        <div className="fld"><label htmlFor="w-close">Closes</label><input id="w-close" type="date" className="in" value={f.closesOn} required onChange={(e) => setF({ ...f, closesOn: e.target.value })} /></div>
        <div className="fld span2"><label htmlFor="w-note">Note</label><input id="w-note" className="in" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- equalizers
function EqualizersPanel({ geo, say }: { geo: { counties: County[]; townships: Township[] }; say: (m: string) => void }) {
  const [rows, setRows] = useState<EqRow[]>([]);
  const [editing, setEditing] = useState<EqRow | "new" | null>(null);
  const load = useCallback(() => api<{ equalizers: EqRow[] }>("/reference/equalizers").then((d) => setRows(d.equalizers)), []);
  useEffect(() => { void load(); }, [load]);
  return (
    <section className="card">
      <div className="ch">
        <h3>Equalizers <span className="meta">Cook publishes one county-wide multiplier a year; collar counties may set them by township</span></h3>
        <div className="tbar" style={{ margin: 0 }}>
          <ImportBox kind="equalizers" columns="County, Township (blank for county-wide), Year, Factor, Source" example={"County,Township,Year,Factor,Source\nCook,,2025,3.0163,Illinois Department of Revenue final multiplier"} onDone={(m) => { say(m); void load(); }} />
          <button className="btn small" onClick={() => setEditing("new")}>+ Equalizer</button>
        </div>
      </div>
      <div className="tw" style={{ marginTop: 12 }}>
        <table className="compact">
          <thead><tr><th>County</th><th>Township</th><th>Year</th><th className="num">Factor</th><th>Source</th><th /></tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td>{e.county}</td><td>{e.township ?? "County-wide"}</td><td className="num">{e.year}</td><td className="num">{e.factor}</td>
                <td className="meta">{e.source}{e.is_sample && <> <span className="pill grey">Sample</span></>}</td>
                <td className="num"><RowActions label={`${e.township ?? e.county} ${e.year} equalizer`} onEdit={() => setEditing(e)} onDelete={async () => { const r = await api<{ refresh: Refresh }>(`/admin/equalizers/${e.id}`, { method: "DELETE" }); say(`Equalizer deleted.${refreshText(r.refresh)}`); await load(); }} /></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="meta" style={{ textAlign: "center", padding: 20 }}>No equalizers yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {editing && <EqualizerSheet geo={geo} row={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={(m) => { setEditing(null); say(m); void load(); }} />}
    </section>
  );
}

function EqualizerSheet({ geo, row, onClose, onSaved }: { geo: { counties: County[]; townships: Township[] }; row: EqRow | null; onClose: () => void; onSaved: (m: string) => void }) {
  const [f, setF] = useState({ countyId: row ? String(row.county_id) : "", townshipId: row?.township_id ? String(row.township_id) : "", year: String(row?.year ?? new Date().getFullYear() - 1), factor: row?.factor ?? "", source: row?.source ?? "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true); setError("");
    const body = { countyId: Number(f.countyId), townshipId: f.townshipId ? Number(f.townshipId) : null, year: Number(f.year), factor: f.factor.trim(), source: nn(f.source) };
    try {
      const r = row ? await api<{ refresh: Refresh }>(`/admin/equalizers/${row.id}`, { method: "PATCH", body }) : await api<{ refresh: Refresh }>("/admin/equalizers", { method: "POST", body });
      onSaved(`Equalizer published.${refreshText(r.refresh)}`);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return (
    <Sheet eyebrow={row ? "Edit equalizer" : "New equalizer"} title={row ? `${row.township ?? row.county} ${row.year}` : "Publish an equalizer"} onClose={onClose} onSubmit={() => void save()} footer={<SheetFooter busy={busy} error={error} onClose={onClose} label="Publish equalizer" />}>
      <div className="fgrid">
        <div className="fld"><label htmlFor="e-county">County</label><CountySelect id="e-county" geo={geo} value={f.countyId} onChange={(v) => setF({ ...f, countyId: v, townshipId: "" })} /></div>
        <div className="fld"><label htmlFor="e-twp">Township</label><TownshipSelect id="e-twp" geo={geo} countyId={f.countyId} value={f.townshipId} onChange={(v) => setF({ ...f, townshipId: v })} /></div>
        <div className="fld"><label htmlFor="e-year">Year</label><input id="e-year" className="in num" inputMode="numeric" value={f.year} onChange={(e) => setF({ ...f, year: e.target.value })} /></div>
        <div className="fld"><label htmlFor="e-factor">Factor</label><input id="e-factor" className="in num" inputMode="decimal" value={f.factor} required placeholder="3.0355" onChange={(e) => setF({ ...f, factor: e.target.value })} /></div>
        <div className="fld span2"><label htmlFor="e-source">Source</label><input id="e-source" className="in" value={f.source} placeholder="Where the figure comes from" onChange={(e) => setF({ ...f, source: e.target.value })} /></div>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- tax rates
function RatesPanel({ geo, say }: { geo: { counties: County[]; townships: Township[] }; say: (m: string) => void }) {
  const [rows, setRows] = useState<RateRow[]>([]);
  const [code, setCode] = useState("");
  const [editing, setEditing] = useState<RateRow | "new" | null>(null);
  const load = useCallback(() => api<{ taxRates: RateRow[] }>("/reference/tax-rates").then((d) => setRows(d.taxRates)), []);
  useEffect(() => { void load(); }, [load]);
  const shown = rows.filter((r) => !code.trim() || r.tax_code.includes(code.trim()));
  return (
    <section className="card">
      <div className="ch">
        <h3>Tax rates <span className="meta">Composite rate per tax code, from the county clerk</span></h3>
        <div className="tbar" style={{ margin: 0 }}>
          <input aria-label="Find a tax code" className="in" style={{ width: 140, height: 28 }} placeholder="Tax code" value={code} onChange={(e) => setCode(e.target.value)} />
          <ImportBox kind="tax-rates" columns="County, Tax code, Tax year, Rate (percent), Source" example={"County,Tax code,Tax year,Rate,Source\nCook,23008,2024,7.943607,Cook County Clerk tax rate report"} onDone={(m) => { say(m); void load(); }} />
          <button className="btn small" onClick={() => setEditing("new")}>+ Rate</button>
        </div>
      </div>
      <div className="tw" style={{ marginTop: 12 }}>
        <table className="compact">
          <thead><tr><th>County</th><th>Tax code</th><th>Tax year</th><th className="num">Rate</th><th>Source</th><th /></tr></thead>
          <tbody>
            {shown.slice(0, 300).map((r) => (
              <tr key={r.id}>
                <td>{r.county}</td><td className="num">{r.tax_code}</td><td className="num">{r.tax_year}</td><td className="num">{r.rate_percent}%</td>
                <td className="meta">{r.source}{r.is_sample && <> <span className="pill grey">Sample</span></>}</td>
                <td className="num"><RowActions label={`tax code ${r.tax_code} ${r.tax_year}`} onEdit={() => setEditing(r)} onDelete={async () => { const x = await api<{ refresh: Refresh }>(`/admin/tax-rates/${r.id}`, { method: "DELETE" }); say(`Rate deleted.${refreshText(x.refresh)}`); await load(); }} /></td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={6} className="meta" style={{ textAlign: "center", padding: 20 }}>{rows.length ? "No rates for that tax code." : "No rates yet. Upload the clerk's rate list as a CSV."}</td></tr>}
          </tbody>
        </table>
      </div>
      {shown.length > 300 && <p className="meta" style={{ padding: "8px 18px" }}>Showing 300 of {shown.length}. Search by tax code to find others.</p>}
      {editing && <RateSheet geo={geo} row={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={(m) => { setEditing(null); say(m); void load(); }} />}
    </section>
  );
}

function RateSheet({ geo, row, onClose, onSaved }: { geo: { counties: County[] }; row: RateRow | null; onClose: () => void; onSaved: (m: string) => void }) {
  const [f, setF] = useState({ countyId: row ? String(row.county_id) : "", taxCode: row?.tax_code ?? "", taxYear: String(row?.tax_year ?? new Date().getFullYear() - 1), ratePercent: row?.rate_percent ?? "", source: row?.source ?? "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true); setError("");
    const body = { countyId: Number(f.countyId), taxCode: f.taxCode.trim(), taxYear: Number(f.taxYear), ratePercent: f.ratePercent.trim().replace(/%$/, ""), source: nn(f.source) };
    try {
      const r = row ? await api<{ refresh: Refresh }>(`/admin/tax-rates/${row.id}`, { method: "PATCH", body }) : await api<{ refresh: Refresh }>("/admin/tax-rates", { method: "POST", body });
      onSaved(`Rate published.${refreshText(r.refresh)}`);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return (
    <Sheet eyebrow={row ? "Edit tax rate" : "New tax rate"} title={row ? `Tax code ${row.tax_code}, ${row.tax_year}` : "Publish a tax rate"} onClose={onClose} onSubmit={() => void save()} footer={<SheetFooter busy={busy} error={error} onClose={onClose} label="Publish rate" />}>
      <div className="fgrid">
        <div className="fld"><label htmlFor="r-county">County</label><CountySelect id="r-county" geo={geo} value={f.countyId} onChange={(v) => setF({ ...f, countyId: v })} /></div>
        <div className="fld"><label htmlFor="r-code">Tax code</label><input id="r-code" className="in num" value={f.taxCode} required onChange={(e) => setF({ ...f, taxCode: e.target.value })} /></div>
        <div className="fld"><label htmlFor="r-year">Tax year</label><input id="r-year" className="in num" inputMode="numeric" value={f.taxYear} onChange={(e) => setF({ ...f, taxYear: e.target.value })} /></div>
        <div className="fld"><label htmlFor="r-rate">Rate %</label><input id="r-rate" className="in num" inputMode="decimal" value={f.ratePercent} required placeholder="7.943607" onChange={(e) => setF({ ...f, ratePercent: e.target.value })} /></div>
        <div className="fld span2"><label htmlFor="r-source">Source</label><input id="r-source" className="in" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} /></div>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- townships
function TownshipsPanel({ geo, reload, say }: { geo: { counties: County[]; townships: Township[] }; reload: () => Promise<void>; say: (m: string) => void }) {
  const [county, setCounty] = useState("");
  const [name, setName] = useState("");
  const [triad, setTriad] = useState("");
  const [error, setError] = useState("");
  const cook = geo.counties.find((c) => c.name === "Cook");
  const list = geo.townships.filter((t) => String(t.county_id) === county);
  async function add() {
    setError("");
    try {
      await api("/admin/townships", { method: "POST", body: { countyId: Number(county), name: name.trim(), triad: triad || null } });
      say(`${name.trim()} added.`);
      setName(""); setTriad("");
      await reload();
    } catch (err) { setError(errorText(err)); }
  }
  return (
    <section className="card pad">
      <div className="form-row" style={{ alignItems: "flex-end" }}>
        <div className="field"><label htmlFor="t-county">County</label><CountySelect id="t-county" geo={geo} value={county} onChange={setCounty} /></div>
        <div className="field"><label htmlFor="t-name">New township</label><input id="t-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!county} /></div>
        {cook && county === String(cook.id) && (
          <div className="field"><label htmlFor="t-triad">Triad</label>
            <select id="t-triad" value={triad} onChange={(e) => setTriad(e.target.value)}><option value="">None</option><option>City</option><option>North</option><option>South</option></select>
          </div>
        )}
        <button className="btn" disabled={!county || name.trim().length < 2} onClick={() => void add()}>Add township</button>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {county && (
        <p className="small" style={{ marginBottom: 0 }}>
          <b>{list.length} townships:</b> {list.map((t) => `${t.name}${t.triad ? ` (${t.triad})` : ""}`).join(", ") || "none yet"}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- change log
function describe(c: ChangeRow): string {
  const r = (c.after ?? c.before ?? {}) as Record<string, string | number | null>;
  if (c.table_name === "filing_windows") return `${LEVEL_LABELS[r.level as Level] ?? r.level} window ${r.assessment_year}: ${r.opens_on} to ${r.closes_on}`;
  if (c.table_name === "equalizers") return `Equalizer ${r.year}: ${r.factor}`;
  if (c.table_name === "tax_rates") return `Tax code ${r.tax_code}, ${r.tax_year}: ${r.rate_percent}%`;
  return c.table_name;
}

function ChangeLog() {
  const [rows, setRows] = useState<ChangeRow[]>([]);
  useEffect(() => { void api<{ changes: ChangeRow[] }>("/admin/reference-changes").then((d) => setRows(d.changes)); }, []);
  const verb: Record<string, string> = { INSERT: "Added", UPDATE: "Changed", DELETE: "Deleted" };
  return (
    <section className="card">
      <div className="tw">
        <table className="compact">
          <thead><tr><th>When</th><th>Who</th><th>Change</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td className="num" style={{ whiteSpace: "nowrap" }}>{formatDateTime(c.at)}</td>
                <td>{c.actor_name ?? "System (sample data)"}</td>
                <td>{verb[c.action] ?? c.action} · {describe(c)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={3} className="meta" style={{ textAlign: "center", padding: 20 }}>No changes yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
