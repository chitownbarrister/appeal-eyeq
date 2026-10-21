import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, errorText } from "../api";
import { useSession } from "../App";
import { ROLE_LABELS } from "../../../shared/domain";

const MIN = 10;

/** The signed-in person's own account: who they are, and changing their password. */
export function MyAccount() {
  const { me, refresh } = useSession();
  const [cents, setCents] = useState(Boolean(me.preferences?.showValueCents));
  const [centsError, setCentsError] = useState("");
  async function toggleCents(on: boolean) {
    setCents(on);
    setCentsError("");
    try {
      await api("/auth/preferences", { method: "PUT", body: { showValueCents: on } });
      await refresh();
    } catch (err) {
      setCents(!on);
      setCentsError(errorText(err));
    }
  }
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const role = me.user.isSuperAdmin ? "Super admin" : me.user.role ? ROLE_LABELS[me.user.role] : "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setDone(false);
    if (form.next.length < MIN) { setError(`The new password needs at least ${MIN} characters.`); return; }
    if (form.next !== form.confirm) { setError("The two new passwords don't match."); return; }
    setBusy(true);
    try {
      await api("/auth/password", { method: "POST", body: { current: form.current, next: form.next } });
      setForm({ current: "", next: "", confirm: "" });
      setDone(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Account</div>
          <h1>{me.user.name}</h1>
        </div>
      </div>
      <div className="acct">
        <section className="card pad" aria-labelledby="acct-who">
          <h3 id="acct-who">Profile</h3>
          <dl className="facts">
            <div><dt>Email</dt><dd>{me.user.email}</dd></div>
            <div><dt>Role</dt><dd>{role}{me.user.isFirmAdmin && !me.user.isSuperAdmin ? " · Firm admin" : ""}</dd></div>
            {me.firm && !me.acting && <div><dt>Firm</dt><dd>{me.firm.name}</dd></div>}
          </dl>
          <p className="meta" style={{ marginTop: 12 }}>
            {me.user.isSuperAdmin
              ? "The super admin's name and email are set in the server's settings."
              : <>A firm admin changes names, emails and roles in <Link to="/settings">Firm settings</Link>, Users.</>}
          </p>
        </section>

        <section className="card pad" aria-labelledby="acct-display">
          <h3 id="acct-display">Display</h3>
          <label className="check">
            <input type="checkbox" checked={cents} onChange={(e) => void toggleCents(e.target.checked)} /> Show cents on assessed and market values
          </label>
          <p className="meta">Values show in whole dollars, the way notices print them: {cents ? "$61,875.00 instead of $61,875" : "$61,875, not $61,875.00"}. Taxes, savings and fees always show cents. This is your own setting.</p>
          {centsError && <div className="error" role="alert">{centsError}</div>}
        </section>

        <form className="card pad" onSubmit={submit} aria-labelledby="acct-pw">
          <h3 id="acct-pw">Change password</h3>
          <div className="pw-fields">
            <div className="fld">
              <label htmlFor="pw-current">Current password</label>
              <input id="pw-current" className="in" type="password" autoComplete="current-password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} required />
            </div>
            <div className="fld">
              <label htmlFor="pw-next">New password</label>
              <input id="pw-next" className="in" type="password" autoComplete="new-password" value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} required />
            </div>
            <div className="fld">
              <label htmlFor="pw-confirm">New password again</label>
              <input id="pw-confirm" className="in" type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} required />
            </div>
          </div>
          <p className="meta">At least {MIN} characters. Changing it signs you out everywhere else.</p>
          <button className="btn" disabled={busy}>{busy ? "Saving" : "Change password"}</button>
          {done && <div className="ok" role="status">Password changed. Any other signed-in browsers have been signed out.</div>}
          {error && <div className="error" role="alert">{error}</div>}
        </form>
      </div>
    </>
  );
}
