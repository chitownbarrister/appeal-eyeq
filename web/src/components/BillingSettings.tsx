// Settings > Billing: the firm's Stripe account (connected by a firm admin, paid out to
// the firm, the firm pays Stripe's fees), whether email is set up, invoice numbering,
// payment terms, the note printed on invoices, and the letterhead.

import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { api, errorText } from "../api";
import { useSession } from "../App";
import { todayIso } from "../format";

interface S {
  settings: { invoice_prefix: string; payment_terms_days: number; invoice_note: string | null; reply_to_email: string | null; accent_color: string | null; remit_to: string | null };
  logo: { width: number; height: number; updated_at: string } | null;
  letterhead: { letterhead_name: string | null; letterhead_address: string | null; letterhead_phone: string | null; letterhead_website: string | null };
  stripe: { stripe_account_id: string; charges_enabled: boolean; payouts_enabled: boolean; details_submitted: boolean; business_name: string | null; livemode: boolean } | null;
  stripeAvailable: boolean; emailAvailable: boolean;
}

export function BillingSettingsTab() {
  const { me } = useSession();
  const isAdmin = !me.user.isSuperAdmin && me.user.isFirmAdmin;
  const [params, setParams] = useSearchParams();
  const [s, setS] = useState<S | null>(null);
  const [f, setF] = useState({ invoicePrefix: "", paymentTermsDays: "30", invoiceNote: "", replyToEmail: "", letterheadName: "", letterheadAddress: "", letterheadPhone: "", letterheadWebsite: "", accentColor: "", remitTo: "" });
  const [logoMsg, setLogoMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [previewSrc, setPreviewSrc] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [formMsg, setFormMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const back = params.get("stripe");

  const load = useCallback(async () => {
    const r = await api<S>("/firm/billing/settings");
    setS(r);
    setF({
      invoicePrefix: r.settings.invoice_prefix, paymentTermsDays: String(r.settings.payment_terms_days), invoiceNote: r.settings.invoice_note ?? "", replyToEmail: r.settings.reply_to_email ?? "",
      letterheadName: r.letterhead.letterhead_name ?? "", letterheadAddress: r.letterhead.letterhead_address ?? "", letterheadPhone: r.letterhead.letterhead_phone ?? "", letterheadWebsite: r.letterhead.letterhead_website ?? "",
      accentColor: r.settings.accent_color ?? "", remitTo: r.settings.remit_to ?? "",
    });
  }, []);
  useEffect(() => { void load().catch((e) => setError(errorText(e))); }, [load]);

  async function run(label: string, fn: () => Promise<string | void>) {
    setBusy(label); setError(""); setNotice("");
    try { const m = await fn(); if (m) setNotice(m); } catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  }
  const connect = () => run("connect", async () => {
    const r = await api<{ url: string }>("/firm/billing/stripe/connect", { method: "POST", body: {} });
    window.location.assign(r.url);
  });
  const refresh = () => run("refresh", async () => { await api("/firm/billing/stripe/refresh", { method: "POST", body: {} }); await load(); return "Checked with Stripe."; });
  const disconnect = () => run("disconnect", async () => { await api("/firm/billing/stripe", { method: "DELETE" }); setConfirm(false); setParams({ tab: "billing" }, { replace: true }); await load(); return "Stripe is disconnected here. The firm's Stripe account itself is unchanged."; });
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy("save"); setFormMsg(null);
    try {
      await api("/firm/billing/settings", { method: "PUT", body: { ...f, paymentTermsDays: Number(f.paymentTermsDays), accentColor: f.accentColor.trim().toUpperCase() } });
      await load();
      setFormMsg({ ok: true, text: "Billing settings saved." });
    } catch (err) { setFormMsg({ ok: false, text: errorText(err) }); } finally { setBusy(""); }
  }

  // The preview follows the form as you type, a moment after you stop.
  const draftKey = JSON.stringify({
    letterheadName: f.letterheadName, letterheadAddress: f.letterheadAddress, letterheadPhone: f.letterheadPhone, letterheadWebsite: f.letterheadWebsite,
    invoiceNote: f.invoiceNote, remitTo: f.remitTo, accentColor: /^#[0-9A-Fa-f]{6}$/.test(f.accentColor) ? f.accentColor.toUpperCase() : "",
  });
  const logoStamp = s?.logo?.updated_at ?? "none";
  useEffect(() => {
    if (!s) return;
    const t = window.setTimeout(() => setPreviewSrc(`/api/firm/billing/invoice-preview?d=${encodeURIComponent(draftKey)}&logo=${encodeURIComponent(logoStamp)}`), 600);
    return () => window.clearTimeout(t);
  }, [draftKey, logoStamp, s]);

  async function chooseLogo(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setLogoMsg(null);
    if (!["image/png", "image/jpeg"].includes(file.type)) { setLogoMsg({ ok: false, text: "Use a PNG or JPEG image." }); return; }
    if (file.size > 1024 * 1024) { setLogoMsg({ ok: false, text: "The logo can be up to 1 MB." }); return; }
    const data = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    setBusy("logo");
    try {
      await api("/firm/billing/logo", { method: "PUT", body: { contentType: file.type, data } });
      await load();
      setLogoMsg({ ok: true, text: "Logo saved. It prints on invoices, statements and settlement letters." });
    } catch (err) { setLogoMsg({ ok: false, text: errorText(err) }); } finally { setBusy(""); }
  }
  async function removeLogo() {
    setBusy("logo"); setLogoMsg(null);
    try { await api("/firm/billing/logo", { method: "DELETE" }); await load(); setLogoMsg({ ok: true, text: "Logo removed." }); } catch (err) { setLogoMsg({ ok: false, text: errorText(err) }); } finally { setBusy(""); }
  }

  if (!s) return error ? <div className="error" role="alert">{error}</div> : null;
  const st = s.stripe;
  const year = todayIso().slice(0, 4);
  return (
    <>
      <section className="card pad" style={{ maxWidth: 780 }} aria-labelledby="stripe-h">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
          <h3 id="stripe-h">Online payments (Stripe)</h3>
          {st?.charges_enabled ? <span className="pill ok">Accepting payments</span> : st ? <span className="pill warn">Setup not finished</span> : <span className="pill grey">Not connected</span>}
        </div>
        {back === "back" && st?.charges_enabled && <div className="ok" role="status">Stripe is connected. Clients can now pay invoices online.</div>}
        {back === "back" && st && !st.charges_enabled && <div className="notice-box" role="status">Stripe still needs some details before payments can be accepted. Continue setup to finish.</div>}
        {back === "retry" && <div className="notice-box" role="status">The Stripe setup link expired. Continue setup to get a fresh one.</div>}
        <p className="muted">
          Clients pay by bank account (ACH) or card on Stripe's checkout page. The money goes to your firm's own Stripe account and pays out to your bank. Stripe's fees come out of each payment
          (about 0.8% for a bank payment, capped at $5, and about 2.9% plus 30¢ for a card). Appeal EyeQ adds nothing.
        </p>
        {st && (
          <ul className="tl">
            <li><span className="k">Account</span><span>{st.business_name ?? "Your firm"} <span className="mn">{st.stripe_account_id}{st.livemode ? "" : " · test mode"}</span></span></li>
            <li><span className="k">Payments</span><span>{st.charges_enabled ? "On" : "Not yet"}</span></li>
            <li><span className="k">Payouts to your bank</span><span>{st.payouts_enabled ? "On" : "Not yet"}</span></li>
          </ul>
        )}
        {!s.stripeAvailable && <p className="meta">Online payments aren't switched on for this server yet.</p>}
        {isAdmin ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
            {s.stripeAvailable && !st?.charges_enabled && <button type="button" className="btn" disabled={!!busy} onClick={() => void connect()}>{busy === "connect" ? "Opening Stripe" : st ? "Continue setup" : "Connect Stripe"}</button>}
            {st && <button type="button" className="btn secondary" disabled={!!busy} onClick={() => void refresh()}>Check status</button>}
            {st && (confirm ? (
              <span className="confirm">
                Stop taking online payments here? Saved client payment methods are forgotten.
                <button type="button" className="btn small danger" disabled={!!busy} onClick={() => void disconnect()}>Disconnect</button>
                <button type="button" className="btn small secondary" onClick={() => setConfirm(false)}>Keep</button>
              </span>
            ) : <button type="button" className="btn ghost" onClick={() => setConfirm(true)}>Disconnect</button>)}
          </div>
        ) : <p className="meta">A firm admin connects Stripe.</p>}
        {notice && <div className="ok" role="status">{notice}</div>}
        {error && <div className="error" role="alert">{error}</div>}
      </section>

      <section className="card pad" style={{ maxWidth: 780, marginTop: 14 }} aria-labelledby="email-h">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
          <h3 id="email-h">Email</h3>
          {s.emailAvailable ? <span className="pill ok">On</span> : <span className="pill grey">Not set up</span>}
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          {s.emailAvailable
            ? "Invoices and statements are emailed with the PDF attached, from your firm's name. Replies go to the reply-to address below, or to whoever sent it."
            : "Email isn't set up on this server yet. Invoices can still be sent: each is marked sent and you copy its pay link into your own email."}
        </p>
      </section>

      <form className="card pad" style={{ maxWidth: 780, marginTop: 14 }} onSubmit={(e) => void save(e)} aria-labelledby="inv-h">
        <h3 id="inv-h">Invoices</h3>
        <div className="fgrid">
          <div className="fld"><label htmlFor="bs-prefix">Number prefix</label><input id="bs-prefix" className="in" value={f.invoicePrefix} maxLength={6} disabled={!isAdmin} onChange={(e) => setF({ ...f, invoicePrefix: e.target.value.toUpperCase() })} />
            <span className="hint">Invoices are numbered {f.invoicePrefix || "NL"}-{year}-0001, statements {f.invoicePrefix || "NL"}-S-{year}-0001.</span></div>
          <div className="fld"><label htmlFor="bs-terms">Payment terms, days</label><input id="bs-terms" className="in" type="number" min={0} max={120} value={f.paymentTermsDays} disabled={!isAdmin} onChange={(e) => setF({ ...f, paymentTermsDays: e.target.value })} /></div>
          <div className="fld span2"><label htmlFor="bs-note">Note printed on every invoice</label><textarea id="bs-note" className="in" rows={2} value={f.invoiceNote} disabled={!isAdmin} onChange={(e) => setF({ ...f, invoiceNote: e.target.value })} placeholder="Thank you for your business. Checks payable to Nichols Law." /></div>
          <div className="fld span2"><label htmlFor="bs-reply">Reply-to email</label><input id="bs-reply" className="in" type="email" value={f.replyToEmail} disabled={!isAdmin} onChange={(e) => setF({ ...f, replyToEmail: e.target.value })} placeholder="billing@yourfirm.com" /><span className="hint">Leave blank to have replies go to whoever sent the invoice.</span></div>
        </div>
        <h3 style={{ marginTop: 18 }}>Letterhead</h3>
        <p className="meta" style={{ marginTop: 0 }}>Printed at the top of invoices, statements and the client's pay page.</p>
        <div className="fgrid">
          <div className="fld"><label htmlFor="bs-lname">Firm name</label><input id="bs-lname" className="in" value={f.letterheadName} disabled={!isAdmin} onChange={(e) => setF({ ...f, letterheadName: e.target.value })} placeholder={me.firm?.name} /></div>
          <div className="fld"><label htmlFor="bs-lphone">Phone</label><input id="bs-lphone" className="in" value={f.letterheadPhone} disabled={!isAdmin} onChange={(e) => setF({ ...f, letterheadPhone: e.target.value })} /></div>
          <div className="fld span2"><label htmlFor="bs-laddr">Address</label><input id="bs-laddr" className="in" value={f.letterheadAddress} disabled={!isAdmin} onChange={(e) => setF({ ...f, letterheadAddress: e.target.value })} /></div>
          <div className="fld span2"><label htmlFor="bs-lweb">Website</label><input id="bs-lweb" className="in" value={f.letterheadWebsite} disabled={!isAdmin} onChange={(e) => setF({ ...f, letterheadWebsite: e.target.value })} /></div>
          <div className="fld span2">
            <span className="lbl">Logo</span>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              {s.logo ? <img className="logo-thumb" src={`/api/firm/billing/logo?v=${encodeURIComponent(s.logo.updated_at)}`} alt="Your letterhead logo" /> : <span className="meta">No logo. The firm name prints in its place.</span>}
              {isAdmin && (
                <>
                  <label className="btn small secondary" style={{ cursor: "pointer" }}>
                    {busy === "logo" ? "Saving" : s.logo ? "Replace logo" : "Upload logo"}
                    <input type="file" hidden accept="image/png,image/jpeg" aria-label="Choose a logo image" onChange={(e) => void chooseLogo(e)} />
                  </label>
                  {s.logo && <button type="button" className="btn small ghost" disabled={busy === "logo"} onClick={() => void removeLogo()}>Remove</button>}
                </>
              )}
            </div>
            <span className="hint">PNG or JPEG, up to 1 MB. A wide logo on a white or clear background prints best.</span>
            {logoMsg && <div className={logoMsg.ok ? "ok" : "error"} role={logoMsg.ok ? "status" : "alert"}>{logoMsg.text}</div>}
          </div>
          <div className="fld">
            <label htmlFor="bs-accent">Accent color</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="color" aria-label="Pick the accent color" value={/^#[0-9A-Fa-f]{6}$/.test(f.accentColor) ? f.accentColor : "#B8733E"} disabled={!isAdmin} onChange={(e) => setF({ ...f, accentColor: e.target.value.toUpperCase() })} style={{ width: 40, height: 32, padding: 0, border: "1px solid var(--line)" }} />
              <input id="bs-accent" className="in" value={f.accentColor} disabled={!isAdmin} onChange={(e) => setF({ ...f, accentColor: e.target.value })} placeholder="#B8733E" maxLength={7} style={{ maxWidth: 110 }} />
              {f.accentColor && isAdmin && <button type="button" className="lk" onClick={() => setF({ ...f, accentColor: "" })}>Use copper</button>}
            </div>
            <span className="hint">The title, rule and totals on invoices. Blank uses Appeal EyeQ copper.</span>
          </div>
          <div className="fld span2"><label htmlFor="bs-remit">Pay by check: payable to and mail to</label>
            <textarea id="bs-remit" className="in" rows={3} value={f.remitTo} disabled={!isAdmin} onChange={(e) => setF({ ...f, remitTo: e.target.value })} maxLength={300}
              placeholder={`Payable to ${f.letterheadName || me.firm?.name || "your firm"}\nMail to ${f.letterheadAddress || "the firm's address"}`} />
            <span className="hint">Printed in the "How to pay" box, next to the pay link and its QR code. Blank uses the firm name and address above.</span></div>
        </div>
        <div className="inv-preview">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <h3 style={{ margin: 0 }}>Preview</h3>
            <span className="meta">A sample invoice with the settings above, before you save. {previewSrc && <a href={previewSrc} target="_blank" rel="noreferrer">Open it full size</a>}</span>
          </div>
          {previewSrc ? <iframe className="pv-frame" src={previewSrc} title="Invoice preview" /> : <p className="meta">Preparing the preview…</p>}
        </div>
        {isAdmin && <div style={{ marginTop: 12 }}><button className="btn" disabled={busy === "save"}>{busy === "save" ? "Saving" : "Save billing settings"}</button></div>}
        {formMsg && <div className={formMsg.ok ? "ok" : "error"} role={formMsg.ok ? "status" : "alert"}>{formMsg.text}</div>}
        {!isAdmin && <p className="meta">Firm admins change billing settings.</p>}
      </form>
    </>
  );
}
