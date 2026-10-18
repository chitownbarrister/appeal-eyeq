import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { useSession } from "../App";
import { formatDate, formatDateTime } from "../format";
import { LEVEL_LABELS, type Level } from "../../../shared/domain";

interface FirmRow { id: number; name: string; slug: string; status: string; is_sample: boolean; active_users: number; grant_expires_at: string | null }

export function Admin() {
  const [tab, setTab] = useState<"firms" | "reference">("firms");
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Super admin</div>
          <h1>Firms and reference data</h1>
          <div className="subtitle">You can't see any firm's data unless that firm grants support access.</div>
        </div>
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "firms"} className={tab === "firms" ? "active" : ""} onClick={() => setTab("firms")}>Firms</button>
        <button role="tab" aria-selected={tab === "reference"} className={tab === "reference" ? "active" : ""} onClick={() => setTab("reference")}>Reference data</button>
      </div>
      {tab === "firms" ? <FirmsTab /> : <ReferenceTab />}
    </>
  );
}

function FirmsTab() {
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [firms, setFirms] = useState<FirmRow[]>([]);
  const [form, setForm] = useState({ name: "", slug: "", attorneyName: "", attorneyEmail: "", attorneyPassword: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(() => api<{ firms: FirmRow[] }>("/admin/firms").then((d) => setFirms(d.firms)), []);
  useEffect(() => { void load(); }, [load]);

  async function enter(id: number) {
    setError("");
    try {
      await api(`/admin/firms/${id}/enter`, { method: "POST", body: {} });
      await refresh();
      navigate("/dashboard");
    } catch (err) { setError(err instanceof ApiError ? err.message : "Could not enter firm."); }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(""); setNotice("");
    try {
      await api("/admin/firms", { method: "POST", body: form });
      setNotice(`${form.name} created. ${form.attorneyName} can sign in with the password you set.`);
      setForm({ name: "", slug: "", attorneyName: "", attorneyEmail: "", attorneyPassword: "" });
      await load();
    } catch (err) { setError(err instanceof ApiError ? err.message : "Could not create firm."); }
  }

  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  return (
    <>
      <div className="card pad">
        <table>
          <thead><tr><th>Firm</th><th>Users</th><th>Support access</th><th /></tr></thead>
          <tbody>
            {firms.map((f) => (
              <tr key={f.id}>
                <td>{f.name} {f.is_sample && <span className="pill grey">Sample</span>}</td>
                <td>{f.active_users}</td>
                <td>{f.grant_expires_at ? <span className="pill copper">Open until {formatDateTime(f.grant_expires_at)}</span> : <span className="muted">Not granted</span>}</td>
                <td className="num">{f.grant_expires_at && <button className="btn small" onClick={() => void enter(f.id)}>View (read-only)</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="card pad" onSubmit={create} aria-label="Create a firm">
        <h3 style={{ marginBottom: 12 }}>Create a firm</h3>
        <div className="form-row">
          <div className="field"><label htmlFor="f-name">Firm name</label><input id="f-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value, slug: slugify(e.target.value) })} required /></div>
          <div className="field"><label htmlFor="f-slug">Short name</label><input id="f-slug" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} required /></div>
          <div className="field"><label htmlFor="f-an">First attorney</label><input id="f-an" value={form.attorneyName} onChange={(e) => setForm({ ...form, attorneyName: e.target.value })} required /></div>
          <div className="field"><label htmlFor="f-ae">Attorney email</label><input id="f-ae" type="email" value={form.attorneyEmail} onChange={(e) => setForm({ ...form, attorneyEmail: e.target.value })} required /></div>
          <div className="field"><label htmlFor="f-ap">Temporary password</label><input id="f-ap" type="password" minLength={10} value={form.attorneyPassword} onChange={(e) => setForm({ ...form, attorneyPassword: e.target.value })} required /></div>
          <button className="btn" type="submit">Create firm</button>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>New firms start with default fees (40% Assessor and BOR, 33.33% PTAB and Circuit Court) and no data.</p>
      </form>
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="ok">{notice}</div>}
    </>
  );
}

interface WindowRow { id: number; county: string; township: string | null; level: Level; assessment_year: number; opens_on: string; closes_on: string; note: string | null; is_sample: boolean }
interface EqRow { id: number; county: string; township: string | null; year: number; factor: string; source: string | null; is_sample: boolean }
interface RateRow { id: number; county: string; tax_code: string; tax_year: number; rate_percent: string; source: string | null; is_sample: boolean }

function ReferenceTab() {
  const [windows, setWindows] = useState<WindowRow[]>([]);
  const [eqs, setEqs] = useState<EqRow[]>([]);
  const [rates, setRates] = useState<RateRow[]>([]);
  useEffect(() => {
    void api<{ windows: WindowRow[] }>("/reference/windows").then((d) => setWindows(d.windows));
    void api<{ equalizers: EqRow[] }>("/reference/equalizers").then((d) => setEqs(d.equalizers));
    void api<{ taxRates: RateRow[] }>("/reference/tax-rates").then((d) => setRates(d.taxRates));
  }, []);
  return (
    <>
      <div className="card pad">
        <p className="muted small" style={{ marginTop: 0 }}>
          Every firm reads these. Editing and the global push arrive in build step 3. Rows marked Sample are placeholders, not published figures.
        </p>
        <h3 style={{ marginBottom: 10 }}>Filing windows</h3>
        <table>
          <thead><tr><th>County</th><th>Township</th><th>Level</th><th>Year</th><th>Opens</th><th>Closes</th><th /></tr></thead>
          <tbody>
            {windows.map((w) => (
              <tr key={w.id}>
                <td>{w.county}</td><td>{w.township ?? "County-wide"}</td><td>{LEVEL_LABELS[w.level]}</td><td>{w.assessment_year}</td>
                <td>{formatDate(w.opens_on)}</td><td>{formatDate(w.closes_on)}</td><td>{w.is_sample && <span className="pill grey">Sample</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card pad">
        <h3 style={{ marginBottom: 10 }}>Equalizers</h3>
        <table>
          <thead><tr><th>County</th><th>Township</th><th>Year</th><th className="num">Factor</th><th>Source</th></tr></thead>
          <tbody>{eqs.map((e) => <tr key={e.id}><td>{e.county}</td><td>{e.township ?? "County-wide"}</td><td>{e.year}</td><td className="num">{e.factor}</td><td className="muted small">{e.source}</td></tr>)}</tbody>
        </table>
      </div>
      <div className="card pad">
        <h3 style={{ marginBottom: 10 }}>Tax rates</h3>
        <table>
          <thead><tr><th>County</th><th>Tax code</th><th>Tax year</th><th className="num">Rate</th><th>Source</th></tr></thead>
          <tbody>{rates.map((r) => <tr key={r.id}><td>{r.county}</td><td>{r.tax_code}</td><td>{r.tax_year}</td><td className="num">{r.rate_percent}%</td><td className="muted small">{r.source}</td></tr>)}</tbody>
        </table>
      </div>
    </>
  );
}
