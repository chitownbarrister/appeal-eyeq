// Billing: decided Assessor and BOR reductions ready to bill, drafts to check and send,
// unpaid invoices and statements, and what's been paid. Nothing reaches a client until
// someone sends it.

import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, errorText } from "../api";
import { useSession } from "../App";
import { formatDate, formatMoney } from "../format";
import { LEVEL_LABELS, type Level } from "../../../shared/domain";
import { BillingList, InvoiceSheet, InvoiceStatus, Matter, StatementSheet, type InvoiceRow, type StatementRow } from "../components/BillingSheets";

interface Ready { appealId: number; year: number; level: Level; decisionOn: string | null; savings: string; fee: string; description: string; propertyId: number; accountId: number; client: string; title: string }
interface Data {
  totals: { ready: string; drafts: string; outstanding: string; overdue: string; paidThisMonth: string };
  ready: Ready[]; drafts: InvoiceRow[]; unpaid: InvoiceRow[]; paid: InvoiceRow[]; statements: StatementRow[]; paidStatements: StatementRow[];
  setup: { stripe: boolean; stripeStarted: boolean; email: boolean };
}
type View = "ready" | "drafts" | "unpaid" | "statements" | "paid";
const VIEWS: { id: View; label: string }[] = [
  { id: "ready", label: "Ready to bill" }, { id: "drafts", label: "Drafts" }, { id: "unpaid", label: "Unpaid" }, { id: "statements", label: "Statements" }, { id: "paid", label: "Paid" },
];

export function Billing() {
  const { can, me } = useSession();
  const canSend = can("invoices.send");
  const [params, setParams] = useSearchParams();
  const asked = params.get("view") as View | null;
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState<{ kind: "invoice" | "statement"; id: number } | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [useEmail, setUseEmail] = useState(true);
  const shown: View = asked && VIEWS.some((v) => v.id === asked) ? asked : data && data.ready.length === 0 && data.drafts.length > 0 ? "drafts" : "ready";

  const load = useCallback(async () => {
    try {
      const d = await api<Data>("/firm/billing");
      setData(d);
      setPicked((p) => p.filter((id) => d.drafts.some((x) => x.id === id)));
      setError("");
    } catch (e) { setError(errorText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (data) setUseEmail(data.setup.email); }, [data?.setup.email]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(label: string, fn: () => Promise<string | void>) {
    setBusy(label); setError(""); setNotice("");
    try { const m = await fn(); if (m) setNotice(m); await load(); } catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  }
  const draftAll = (ids?: number[]) => act("draft", async () => {
    const r = await api<{ drafted: number[]; skipped: { reason: string }[] }>("/firm/billing/draft", { method: "POST", body: ids ? { appealIds: ids } : {} });
    if (ids?.length === 1 && r.drafted.length === 1) setOpen({ kind: "invoice", id: r.drafted[0] });
    return `Drafted ${r.drafted.length} invoice${r.drafted.length === 1 ? "" : "s"}.${r.skipped.length ? ` ${r.skipped.length} skipped: ${r.skipped[0].reason}` : ""} Check them in Drafts, then send.`;
  });
  const sendPicked = () => act("send", async () => {
    const r = await api<{ results: { ok: boolean; number?: string; error?: string; emailed?: boolean }[] }>("/firm/billing/send-drafts", { method: "POST", body: { ids: picked, email: useEmail } });
    setPicked([]);
    const ok = r.results.filter((x) => x.number);
    const bad = r.results.filter((x) => !x.ok);
    return [
      `Sent ${ok.length} invoice${ok.length === 1 ? "" : "s"}${useEmail ? "" : " (marked sent, not emailed)"}.`,
      bad.length ? `${bad.length} need a look: ${bad[0].error}` : "",
    ].filter(Boolean).join(" ");
  });

  const t = data?.totals;
  const count = (v: View) => (!data ? 0 : v === "ready" ? data.ready.length : v === "drafts" ? data.drafts.length : v === "unpaid" ? data.unpaid.length : v === "statements" ? data.statements.length : data.paid.length + data.paidStatements.length);
  const isAdmin = !me.user.isSuperAdmin && me.user.isFirmAdmin;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Billing</div>
          <h1>Invoices and payments</h1>
          <p className="subtitle">Each decided Assessor or Board of Review reduction gets a draft invoice for its fee. Check the drafts, send them, and clients pay online by bank account or card, or by check.</p>
        </div>
      </div>

      {data && (!data.setup.stripe || !data.setup.email) && (
        <div className="notice-box" role="status">
          <span>
            {!data.setup.stripe && (data.setup.stripeStarted ? "Finish connecting your Stripe account so clients can pay online. " : "Connect your firm's Stripe account so clients can pay online. ")}
            {!data.setup.email && "Email isn't set up on this server yet, so invoices are marked sent and you copy each pay link."}
          </span>
          <span className="sp" />
          {isAdmin && !data.setup.stripe && <Link className="btn small secondary" to="/settings?tab=billing">Billing settings</Link>}
        </div>
      )}

      {t && (
        <div className="kpis k5">
          <div className="card kpi"><span className="label">Ready to bill</span><span className="value">{formatMoney(t.ready)}</span><span className="note">{data!.ready.length} decided</span></div>
          <div className="card kpi"><span className="label">Drafts</span><span className="value">{formatMoney(t.drafts)}</span><span className="note">{data!.drafts.length} to send</span></div>
          <div className="card kpi"><span className="label">Outstanding</span><span className="value">{formatMoney(t.outstanding)}</span><span className="note">{data!.unpaid.length} unpaid</span></div>
          <div className="card kpi"><span className="label">Overdue</span><span className={`value${Number(t.overdue) > 0 ? " bad" : ""}`}>{formatMoney(t.overdue)}</span></div>
          <div className="card kpi"><span className="label">Paid this month</span><span className="value good">{formatMoney(t.paidThisMonth)}</span></div>
        </div>
      )}

      {notice && <div className="ok" role="status">{notice}</div>}
      {error && <div className="error" role="alert">{error}</div>}

      <section className="card">
        <div className="subtabs" role="tablist" aria-label="Billing">
          {VIEWS.map((v) => (
            <button key={v.id} role="tab" aria-selected={shown === v.id} className={shown === v.id ? "active" : ""} onClick={() => setParams(v.id === "ready" ? {} : { view: v.id })}>
              {v.label}{data ? ` (${count(v.id)})` : ""}
            </button>
          ))}
        </div>
        <div className="pane">
          {data && shown === "ready" && (
            <>
              <div className="tbar">
                <span className="meta">{data.ready.length ? "Decided reductions with a fee and no invoice yet. Drafting doesn't send anything." : "Nothing to bill. Decided Assessor and BOR reductions with a fee show here."}</span>
                <span className="sp" />
                {canSend && data.ready.length > 1 && <button type="button" className="btn copper" disabled={busy === "draft"} onClick={() => void draftAll()}>{busy === "draft" ? "Drafting" : `Draft all ${data.ready.length}`}</button>}
              </div>
              <div className="tw">
                <table className="compact">
                  <thead><tr><th>Property</th><th>Client</th><th>Appeal</th><th>Decided</th><th className="num">Tax savings</th><th className="num">Fee</th><th /></tr></thead>
                  <tbody>
                    {data.ready.map((r) => (
                      <tr key={r.appealId}>
                        <td><Matter title={r.title} propertyId={r.propertyId} /></td>
                        <td><Link to={`/accounts/${r.accountId}`}>{r.client}</Link></td>
                        <td>{r.year}<span className="mn" style={{ display: "block" }}>{LEVEL_LABELS[r.level]}</span></td>
                        <td>{r.decisionOn ? formatDate(r.decisionOn) : "—"}</td>
                        <td className="num">{formatMoney(r.savings)}</td>
                        <td className="num"><b>{formatMoney(r.fee)}</b><span className="mn" style={{ display: "block" }} title={r.description}>{r.description.split(": ")[1]?.split(" of ")[0] ?? ""}</span></td>
                        <td className="num">{canSend && <button type="button" className="btn small" disabled={!!busy} onClick={() => void draftAll([r.appealId])}>Draft</button>}</td>
                      </tr>
                    ))}
                    {data.ready.length === 0 && <tr><td colSpan={7} className="meta" style={{ textAlign: "center", padding: 20 }}>Nothing ready to bill.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {data && shown === "drafts" && (
            <>
              <div className="tbar">
                {canSend && data.drafts.length > 0 && (
                  <label className="check"><input type="checkbox" aria-label="Choose every draft" checked={picked.length === data.drafts.length} onChange={(e) => setPicked(e.target.checked ? data.drafts.map((d) => d.id) : [])} /> Choose all</label>
                )}
                <span className="sp" />
                {canSend && picked.length > 0 && (
                  <>
                    <label className="check"><input type="checkbox" checked={useEmail} onChange={(e) => setUseEmail(e.target.checked)} /> Email each to the client's billing contacts</label>
                    <button type="button" className="btn copper" disabled={busy === "send"} onClick={() => void sendPicked()}>{busy === "send" ? "Sending" : `Send ${picked.length}`}</button>
                  </>
                )}
              </div>
              <div className="tw">
                <table className="compact">
                  <thead><tr>{canSend && <th />}<th>Property</th><th>Client</th><th>Appeal</th><th className="num">Total</th><th>Status</th></tr></thead>
                  <tbody>
                    {data.drafts.map((r) => (
                      <tr key={r.id} className="clickable" tabIndex={0} onClick={() => setOpen({ kind: "invoice", id: r.id })} onKeyDown={(e) => { if (e.key === "Enter") setOpen({ kind: "invoice", id: r.id }); }}>
                        {canSend && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Choose the draft for ${r.client}`} checked={picked.includes(r.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))} /></td>}
                        <td><Matter title={r.title} propertyId={r.propertyId} /></td>
                        <td>{r.client}</td><td>{r.appeal ?? "—"}</td><td className="num">{formatMoney(r.total)}</td><td><InvoiceStatus r={r} /></td>
                      </tr>
                    ))}
                    {data.drafts.length === 0 && <tr><td colSpan={6} className="meta" style={{ textAlign: "center", padding: 20 }}>No drafts.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {data && shown === "unpaid" && <BillingList invoices={data.unpaid} statements={[]} onOpen={setOpen} empty="Nothing outstanding." />}
          {data && shown === "statements" && (
            <>
              <p className="meta" style={{ marginTop: 0 }}>To gather a client's unpaid invoices into one bill, open the client and choose Create statement on its Billing tab.</p>
              <BillingList invoices={[]} statements={data.statements} onOpen={setOpen} showProperty={false} empty="No open statements." />
            </>
          )}
          {data && shown === "paid" && <BillingList invoices={data.paid} statements={data.paidStatements} onOpen={setOpen} empty="Nothing paid in the last six months." />}
        </div>
      </section>

      {open?.kind === "invoice" && <InvoiceSheet invoiceId={open.id} emailOn={data?.setup.email ?? false} onClose={() => setOpen(null)} onChanged={() => void load()} />}
      {open?.kind === "statement" && <StatementSheet statementId={open.id} onClose={() => setOpen(null)} onChanged={() => void load()} onOpenInvoice={(id) => setOpen({ kind: "invoice", id })} />}
    </>
  );
}
