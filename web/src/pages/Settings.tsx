import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { useSession } from "../App";
import { formatDateTime, titleCase } from "../format";
import { LEVEL_LABELS, PERMISSIONS, type Level } from "../../../shared/domain";

type Tab = "users" | "fees" | "permissions" | "support" | "audit";

const TABS: { id: Tab; label: string }[] = [
  { id: "users", label: "Users" },
  { id: "fees", label: "Fee defaults" },
  { id: "permissions", label: "Roles & permissions" },
  { id: "support", label: "Support access" },
  { id: "audit", label: "Audit log" },
];

export function Settings() {
  const [tab, setTab] = useState<Tab>("users");
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Settings</div>
          <h1>Firm settings</h1>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "users" && <UsersTab />}
      {tab === "fees" && <FeesTab />}
      {tab === "permissions" && <PermissionsTab />}
      {tab === "support" && <SupportTab />}
      {tab === "audit" && <AuditTab />}
    </>
  );
}

function useCan(permission: string): boolean {
  const { me } = useSession();
  return !me.user.isSuperAdmin && me.permissions.includes(permission);
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong.";
}

// ---------------------------------------------------------------- users
interface UserRow { id: number; name: string; email: string; role: "attorney" | "analyst"; active: boolean }

function UsersTab() {
  const { me } = useSession();
  const canManage = useCan("users.manage");
  const [users, setUsers] = useState<UserRow[]>([]);
  const [form, setForm] = useState({ name: "", email: "", role: "analyst", password: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(() => api<{ users: UserRow[] }>("/firm/users").then((d) => setUsers(d.users)), []);
  useEffect(() => { void load(); }, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(""); setNotice("");
    try {
      await api("/firm/users", { method: "POST", body: form });
      setNotice(`${form.name} can now sign in with the password you set.`);
      setForm({ name: "", email: "", role: "analyst", password: "" });
      await load();
    } catch (err) { setError(errorText(err)); }
  }

  async function update(id: number, change: Partial<Pick<UserRow, "role" | "active">>) {
    setError("");
    try { await api(`/firm/users/${id}`, { method: "PATCH", body: change }); await load(); }
    catch (err) { setError(errorText(err)); }
  }

  return (
    <>
      <div className="card">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td className="muted">{u.email}</td>
                <td>
                  {canManage && u.id !== me.user.id ? (
                    <select value={u.role} onChange={(e) => void update(u.id, { role: e.target.value as UserRow["role"] })} aria-label={`Role for ${u.name}`}>
                      <option value="attorney">Attorney</option>
                      <option value="analyst">Analyst</option>
                    </select>
                  ) : titleCase(u.role)}
                </td>
                <td>{u.active ? <span className="pill green">Active</span> : <span className="pill grey">Inactive</span>}</td>
                <td className="num">
                  {canManage && u.id !== me.user.id && (
                    <button className={`btn small ${u.active ? "danger" : "secondary"}`} onClick={() => void update(u.id, { active: !u.active })}>
                      {u.active ? "Deactivate" : "Reactivate"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canManage && (
        <form className="card" onSubmit={add} aria-label="Add a user">
          <h3 style={{ marginBottom: 12 }}>Add a user</h3>
          <div className="form-row">
            <div className="field"><label htmlFor="nu-name">Name</label><input id="nu-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
            <div className="field"><label htmlFor="nu-email">Email</label><input id="nu-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></div>
            <div className="field">
              <label htmlFor="nu-role">Role</label>
              <select id="nu-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="attorney">Attorney</option>
                <option value="analyst">Analyst</option>
              </select>
            </div>
            <div className="field"><label htmlFor="nu-pw">Temporary password</label><input id="nu-pw" type="password" minLength={10} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></div>
            <button className="btn" type="submit">Add user</button>
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>At least 10 characters. Email invitations arrive with the email step.</p>
        </form>
      )}
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="ok">{notice}</div>}
    </>
  );
}

// ---------------------------------------------------------------- fees
interface FeeRow { level: Level; percent: string; basis: "first_year_savings" | "refund" }

function FeesTab() {
  const canEdit = useCan("fees.edit");
  const [fees, setFees] = useState<FeeRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const load = useCallback(async () => {
    const d = await api<{ feeDefaults: FeeRow[] }>("/firm/fee-defaults");
    setFees(d.feeDefaults);
    setDrafts(Object.fromEntries(d.feeDefaults.map((f) => [f.level, f.percent])));
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(level: Level) {
    setError(""); setSaved("");
    try {
      await api("/firm/fee-defaults", { method: "PUT", body: { level, percent: drafts[level] } });
      setSaved(`${LEVEL_LABELS[level]} fee saved.`);
      await load();
    } catch (err) { setError(errorText(err)); }
  }

  return (
    <div className="card">
      <p className="muted small" style={{ marginTop: 0 }}>
        Firm-wide defaults. Individual clients, properties and appeals can carry their own terms, and a property can be marked no fee.
      </p>
      <table>
        <thead><tr><th>Level</th><th>Basis</th><th className="num">Fee %</th><th /></tr></thead>
        <tbody>
          {fees.map((f) => (
            <tr key={f.level}>
              <td>{LEVEL_LABELS[f.level]}</td>
              <td className="muted">{f.basis === "refund" ? "Full refund" : "First-year projected tax savings"}</td>
              <td className="num">
                {canEdit ? (
                  <input
                    aria-label={`${LEVEL_LABELS[f.level]} fee percent`}
                    value={drafts[f.level] ?? ""}
                    onChange={(e) => setDrafts({ ...drafts, [f.level]: e.target.value })}
                    style={{ width: 80, textAlign: "right", border: "1px solid var(--line)", borderRadius: 6, padding: "6px 8px" }}
                  />
                ) : `${f.percent}%`}
              </td>
              <td className="num">
                {canEdit && drafts[f.level] !== f.percent && <button className="btn small" onClick={() => void save(f.level)}>Save</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <div className="error" role="alert">{error}</div>}
      {saved && <div className="ok">{saved}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- permissions
const PERMISSION_LABELS: Record<string, string> = {
  "properties.edit": "Edit properties",
  "properties.delete": "Delete properties",
  "appeals.edit": "Edit appeals and values",
  "fees.edit": "Edit fee terms",
  "invoices.send": "Send invoices and statements",
  "invoices.void": "Void invoices",
  "decisions.apply": "Apply decisions",
  "users.manage": "Manage users and permissions",
  "support.grant": "Grant support access",
  "settings.edit": "Edit firm settings",
};

function PermissionsTab() {
  const canManage = useCan("users.manage");
  const { refresh } = useSession();
  const [rows, setRows] = useState<{ role: string; permission: string; allowed: boolean }[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(() => api<{ permissions: typeof rows }>("/firm/permissions").then((d) => setRows(d.permissions)), []);
  useEffect(() => { void load(); }, [load]);

  const allowed = (role: string, permission: string) => rows.find((r) => r.role === role && r.permission === permission)?.allowed ?? false;

  async function toggle(role: string, permission: string) {
    setError("");
    try {
      await api("/firm/permissions", { method: "PUT", body: { role, permission, allowed: !allowed(role, permission) } });
      await load();
      await refresh();
    } catch (err) { setError(errorText(err)); }
  }

  return (
    <div className="card">
      <p className="muted small" style={{ marginTop: 0 }}>Attorneys and Analysts start with the same rights. Switch any of them off per role.</p>
      <table>
        <thead><tr><th>Permission</th><th className="num">Attorney</th><th className="num">Analyst</th></tr></thead>
        <tbody>
          {PERMISSIONS.map((p) => (
            <tr key={p}>
              <td>{PERMISSION_LABELS[p]}</td>
              {(["attorney", "analyst"] as const).map((role) => (
                <td key={role} className="num">
                  <button
                    className={`toggle${allowed(role, p) ? " on" : ""}`}
                    aria-label={`${PERMISSION_LABELS[p]} for ${role}`}
                    aria-pressed={allowed(role, p)}
                    disabled={!canManage}
                    onClick={() => void toggle(role, p)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {error && <div className="error" role="alert">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- support access
interface Grant { id: number; reason: string | null; expires_at: string; revoked_at: string | null; created_at: string; granted_by: string; revoked_by: string | null; active: boolean }

function SupportTab() {
  const canGrant = useCan("support.grant");
  const [grants, setGrants] = useState<Grant[]>([]);
  const [log, setLog] = useState<{ id: number; method: string; path: string; at: string }[]>([]);
  const [hours, setHours] = useState(4);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [g, l] = await Promise.all([
      api<{ grants: Grant[] }>("/firm/support-grants"),
      api<{ entries: typeof log }>("/firm/support-access-log"),
    ]);
    setGrants(g.grants);
    setLog(l.entries);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const active = grants.find((g) => g.active);

  async function grant(e: FormEvent) {
    e.preventDefault();
    setError("");
    try { await api("/firm/support-grants", { method: "POST", body: { hours, reason: reason || undefined } }); setReason(""); await load(); }
    catch (err) { setError(errorText(err)); }
  }

  async function revoke(id: number) {
    setError("");
    try { await api(`/firm/support-grants/${id}/revoke`, { method: "POST", body: {} }); await load(); }
    catch (err) { setError(errorText(err)); }
  }

  return (
    <>
      <div className="card">
        <h3>Appeal EyeQ support can't see your firm's data unless you allow it</h3>
        <p className="muted small">
          A grant lets the Appeal EyeQ administrator view (never change) your firm's data for the hours you choose. You can end it at any
          time, and every page they open is listed below.
        </p>
        {active ? (
          <div className="form-row" style={{ alignItems: "center" }}>
            <span className="pill copper">Access open until {formatDateTime(active.expires_at)}</span>
            {canGrant && <button className="btn small danger" onClick={() => void revoke(active.id)}>End access now</button>}
          </div>
        ) : (
          canGrant && (
            <form className="form-row" onSubmit={grant} aria-label="Grant support access">
              <div className="field">
                <label htmlFor="grant-hours">For</label>
                <select id="grant-hours" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                  {[1, 4, 8, 24, 72].map((h) => <option key={h} value={h}>{h} {h === 1 ? "hour" : "hours"}</option>)}
                </select>
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="grant-reason">Reason (optional)</label>
                <input id="grant-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
              </div>
              <button className="btn" type="submit">Grant access</button>
            </form>
          )
        )}
        {error && <div className="error" role="alert">{error}</div>}
      </div>
      <div className="card">
        <h3 style={{ marginBottom: 10 }}>Grants</h3>
        {grants.length === 0 ? <p className="muted small">No grants yet.</p> : (
          <table>
            <thead><tr><th>Granted</th><th>By</th><th>Reason</th><th>Ends</th><th>Status</th></tr></thead>
            <tbody>
              {grants.map((g) => (
                <tr key={g.id}>
                  <td>{formatDateTime(g.created_at)}</td>
                  <td>{g.granted_by}</td>
                  <td className="muted">{g.reason}</td>
                  <td>{formatDateTime(g.revoked_at ?? g.expires_at)}</td>
                  <td>{g.active ? <span className="pill copper">Open</span> : g.revoked_at ? <span className="pill grey">Ended by {g.revoked_by}</span> : <span className="pill grey">Expired</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h3 style={{ marginBottom: 10 }}>What support viewed</h3>
        {log.length === 0 ? <p className="muted small">Nothing yet.</p> : (
          <table>
            <thead><tr><th>When</th><th>Page</th></tr></thead>
            <tbody>{log.map((l) => <tr key={l.id}><td>{formatDateTime(l.at)}</td><td className="muted">{l.path}</td></tr>)}</tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- audit
function AuditTab() {
  const [entries, setEntries] = useState<{ id: number; actor_name: string | null; actor_kind: string; table_name: string; row_id: string; action: string; at: string }[]>([]);
  useEffect(() => { void api<{ entries: typeof entries }>("/firm/audit-log?limit=100").then((d) => setEntries(d.entries)); }, []);
  const actionLabel: Record<string, string> = { INSERT: "Created", UPDATE: "Changed", DELETE: "Deleted" };
  return (
    <div className="card">
      <p className="muted small" style={{ marginTop: 0 }}>The most recent 100 changes to your firm's data. Entries can't be edited or deleted.</p>
      <table>
        <thead><tr><th>When</th><th>Who</th><th>What</th><th>Record</th></tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td>{formatDateTime(e.at)}</td>
              <td>{e.actor_name ?? (e.actor_kind === "system" ? "System" : "Unknown")}</td>
              <td>{actionLabel[e.action] ?? e.action} {e.table_name.replace(/_/g, " ")}</td>
              <td className="muted">#{e.row_id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
