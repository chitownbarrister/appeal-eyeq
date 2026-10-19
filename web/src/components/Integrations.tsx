import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, errorText } from "../api";
import { useSession } from "../App";
import { formatDateTime } from "../format";

interface DropboxStatus {
  configured: boolean; requiresTeamPlan: boolean; connected: boolean;
  accountEmail?: string | null; accountName?: string | null; accountType?: string; teamName?: string | null;
  usesTeamSpace?: boolean; rootFolder?: string; connectedAt?: string; connectedBy?: string | null;
}

const PLAN_LABEL: Record<string, string> = { business: "Dropbox team plan", pro: "Personal (Plus or Professional)", basic: "Personal (free)" };

export function IntegrationsTab() {
  const { me } = useSession();
  const isAdmin = !me.user.isSuperAdmin && me.user.isFirmAdmin;
  const [params, setParams] = useSearchParams();
  const [d, setD] = useState<DropboxStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [root, setRoot] = useState("");
  const [editingRoot, setEditingRoot] = useState(false);
  const result = params.get("dropbox");
  const reason = params.get("reason");

  const load = useCallback(async () => {
    const r = await api<{ dropbox: DropboxStatus }>("/firm/integrations");
    setD(r.dropbox);
    setRoot(r.dropbox.rootFolder ?? "/Appeal EyeQ");
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function connect() {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ url: string }>("/firm/integrations/dropbox/connect", { method: "POST", body: {} });
      window.location.assign(r.url);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError("");
    try {
      await api("/firm/integrations/dropbox", { method: "DELETE" });
      setConfirm(false);
      setParams({ tab: "integrations" }, { replace: true });
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveRoot() {
    setError("");
    try {
      await api("/firm/integrations/dropbox", { method: "PATCH", body: { rootFolder: root } });
      setEditingRoot(false);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <section className="card pad" style={{ maxWidth: 780 }} aria-labelledby="dbx-h">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
        <h3 id="dbx-h">Dropbox</h3>
        {d?.connected ? <span className="pill ok">Connected</span> : <span className="pill grey">Not connected</span>}
      </div>
      {result === "connected" && <div className="ok" role="status">Dropbox is connected. Each property's Files tab can now create its folder.</div>}
      {result === "error" && reason && <div className="error" role="alert">{reason}</div>}

      {d && !d.configured && (
        <p className="small muted">
          Dropbox isn't set up on this server yet. The app key and secret from Appeal EyeQ's Dropbox app, and an encryption key, need to be added to the server's settings.
        </p>
      )}

      {d && d.configured && !d.connected && (
        <>
          <p className="small" style={{ maxWidth: "62ch" }}>
            Client files live in the firm's Dropbox, in a team folder named Appeal EyeQ, one folder per client and property. Everyone on the firm's Dropbox team
            sees them in the Dropbox desktop app, so documents open in desktop Word and Excel.
          </p>
          <p className="small muted" style={{ maxWidth: "62ch" }}>
            {d.requiresTeamPlan
              ? "A Dropbox team plan (Standard or Advanced) is required, so the firm, not one person, owns client files. Sign in with an account on the firm's team."
              : "This is a sample firm, so a personal Dropbox account is accepted for testing."}
          </p>
          {isAdmin
            ? <button className="btn" onClick={() => void connect()} disabled={busy}>{busy ? "Opening Dropbox" : "Connect Dropbox"}</button>
            : <p className="meta">A firm admin can connect Dropbox.</p>}
        </>
      )}

      {d?.connected && (
        <>
          <dl className="facts" style={{ marginTop: 14, maxWidth: 620 }}>
            <div><dt>Account</dt><dd>{d.accountName}{d.accountEmail ? ` · ${d.accountEmail}` : ""}</dd></div>
            <div><dt>Plan</dt><dd>{PLAN_LABEL[d.accountType ?? ""] ?? d.accountType}{d.teamName ? ` · ${d.teamName}` : ""}</dd></div>
            <div className="wide">
              <dt>Folders go in</dt>
              <dd>
                {editingRoot ? (
                  <span style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <input className="in" style={{ maxWidth: 280 }} value={root} onChange={(e) => setRoot(e.target.value)} aria-label="Dropbox folder for Appeal EyeQ" />
                    <button className="btn small" onClick={() => void saveRoot()}>Save</button>
                    <button className="btn small secondary" onClick={() => { setEditingRoot(false); setRoot(d.rootFolder ?? ""); }}>Cancel</button>
                  </span>
                ) : (
                  <>
                    {d.rootFolder}{d.usesTeamSpace ? " in the team space" : ""}{" "}
                    {isAdmin && <button className="lk" onClick={() => setEditingRoot(true)}>Change</button>}
                  </>
                )}
                <span className="meta" style={{ display: "block" }}>
                  Folders already created stay where they are; a property's Files tab offers to move one whose name is out of date.
                </span>
              </dd>
            </div>
            <div className="wide"><dt>Connected</dt><dd>{d.connectedAt ? formatDateTime(d.connectedAt) : ""}{d.connectedBy ? ` by ${d.connectedBy}` : ""}</dd></div>
          </dl>
          {isAdmin && (confirm ? (
            <div className="confirm" style={{ marginTop: 14 }}>
              Disconnect Dropbox? Appeal EyeQ stops showing files until someone reconnects. Nothing is deleted from Dropbox.
              <button className="btn small danger" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>
              <button className="btn small secondary" onClick={() => setConfirm(false)}>Keep connected</button>
            </div>
          ) : <button className="btn secondary" style={{ marginTop: 14 }} onClick={() => setConfirm(true)}>Disconnect Dropbox</button>)}
        </>
      )}
      {error && <div className="error" role="alert">{error}</div>}
    </section>
  );
}
