// Settings > Firm profile: the firm's logo. One logo for everything: the top of every page,
// invoices, statements and settlement letters, and the client's pay page.

import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { Link } from "react-router-dom";
import { api, errorText } from "../api";
import { useSession } from "../App";

interface Logo { width: number; height: number; updated_at: string }

export function FirmProfileTab() {
  const { me, refresh } = useSession();
  const isAdmin = !me.user.isSuperAdmin && me.user.isFirmAdmin;
  const [logo, setLogo] = useState<Logo | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ logo: Logo | null }>("/firm/billing/settings");
    setLogo(r.logo);
  }, []);
  useEffect(() => { void load().catch((e) => setMsg({ ok: false, text: errorText(e) })); }, [load]);

  async function choose(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setMsg(null);
    if (!["image/png", "image/jpeg"].includes(file.type)) { setMsg({ ok: false, text: "Use a PNG or JPEG image." }); return; }
    if (file.size > 1024 * 1024) { setMsg({ ok: false, text: "The logo can be up to 1 MB." }); return; }
    const data = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    setBusy(true);
    try {
      await api("/firm/billing/logo", { method: "PUT", body: { contentType: file.type, data } });
      await load();
      await refresh();
      setMsg({ ok: true, text: "Logo saved. It shows at the top of every page and prints on invoices, statements and settlement letters." });
    } catch (err) { setMsg({ ok: false, text: errorText(err) }); } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setMsg(null);
    try { await api("/firm/billing/logo", { method: "DELETE" }); await load(); await refresh(); setMsg({ ok: true, text: "Logo removed. The firm name shows in its place." }); }
    catch (err) { setMsg({ ok: false, text: errorText(err) }); } finally { setBusy(false); }
  }

  const src = logo ? `/api/firm/billing/logo?v=${encodeURIComponent(logo.updated_at)}` : null;
  return (
    <section className="card pad firm-profile">
      <h3 style={{ marginTop: 0 }}>{me.firm?.name ?? "Your firm"}</h3>
      <div className="fp-grid">
        <div>
          <span className="lbl">Logo</span>
          <div className="fp-logo">
            {logo === undefined ? <span className="meta">Loading</span> : src ? <img src={src} alt={`${me.firm?.name ?? "Firm"} logo`} /> : <span className="meta">No logo yet. The firm name shows in its place.</span>}
          </div>
          {isAdmin ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
              <label className="btn small secondary" style={{ cursor: "pointer" }}>
                {busy ? "Saving" : logo ? "Replace logo" : "Upload logo"}
                <input type="file" hidden accept="image/png,image/jpeg" aria-label="Choose a logo image" onChange={(e) => void choose(e)} />
              </label>
              {logo && <button type="button" className="btn small ghost" disabled={busy} onClick={() => void remove()}>Remove</button>}
            </div>
          ) : <p className="meta">A firm admin changes the logo.</p>}
          <p className="meta" style={{ marginTop: 8 }}>PNG or JPEG, up to 1 MB. A wide logo on a white or clear background works best.</p>
          {msg && <div className={msg.ok ? "ok" : "error"} role={msg.ok ? "status" : "alert"}>{msg.text}</div>}
        </div>
        <div>
          <span className="lbl">Where it shows</span>
          <div className="fp-where">
            <div className="fp-bar" aria-label="At the top of every page">
              <span className="fp-brand">Appeal Eye<em>Q</em></span>
              <span className="sp" />
              {src ? <span className="firm-logo"><img src={src} alt="" /></span> : <span className="fp-name">{me.firm?.name}</span>}
            </div>
            <p className="meta">At the top of every page, for everyone at the firm. On invoices, statements and settlement letters, and the client's pay page (letterhead details are in <Link to="/settings?tab=billing">Billing</Link>).</p>
          </div>
        </div>
      </div>
    </section>
  );
}
