import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { useSession } from "../App";
import { formatDateTime } from "../format";
import { ReferenceTab } from "../components/ReferenceAdmin";

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

