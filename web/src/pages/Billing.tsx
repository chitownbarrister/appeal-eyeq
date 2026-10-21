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
import { ExpenseList, SettlementList, SettlementSheet, type ExpenseRow, type SettlementRow } from "../components/TrustSheets";
import { todayIso } from "../format";

interface Ready { appealId: number; year: number; level: Level; decisionOn: string | null; savings: string; fee: string; description: string; propertyId: number; accountId: number; client: string; title: string }
interface Data {
  totals: { ready: string; drafts: string; outstanding: string; overdue: string; paidThisMonth: string };
  ready: Ready[]; needs: Needs[]; openExpenses: ExpenseRow[]; inTrust: string; drafts: InvoiceRow[]; unpaid: InvoiceRow[]; paid: InvoiceRow[]; statements: StatementRow[]; paidStatements: StatementRow[];
  setup: { stripe: boolean; stripeStarted: boolean; email: boolean };
}
interface Needs { appealId: number; year: number; level: Level; decisionOn: string | null; propertyId: number; accountId: number; client: string; title: string; missing: string[] }
interface Trust { draft: SettlementRow[]; approved: SettlementRow[]; paid: SettlementRow[]; unsettled: { appealId: number; propertyId: number; client: string; appeal: string; refund: string; receivedOn: string; title: string }[]; balances: { accountId: number; client: string; balance: string; lastOn: string }[]; inTrust: string }
type View = "ready" | "drafts" | "unpaid" | "statements" | "trust" | "expenses" | "paid";
const VIEWS: { id: View; label: string }[] = [
  { id: "ready", label: "Ready to bill" }, { id: "drafts", label: "Drafts" }, { id: "unpaid", label: "Unpaid" }, { id: "statements", label: "Statements" },
  { id: "trust", label: "Trust" }, { id: "expenses", label: "Expenses" }, { id: "paid", label: "Paid" },
];
const SKIP_REASONS = ["Billed in earlier software", "Fee waived"];

export function Billing() {
  const { can, me } = useSession();
  const canSend = can("invoices.send");
  const [params, setParams] = useSearchParams();
  const asked = params.get("view") as View | null;
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState<{ kind: "invoice" | "statement" | "settlement"; id: number } | null>(null);
  const [trust, setTrust] = useState<Trust | null>(null);
  const [skipPick, setSkipPick] = useState<number[]>([]);
  const [skipReason, setSkipReason] = useState(SKIP_REASONS[0]);
  const [exportOpen, setExportOpen] = useState(false);
  const [range, setRange] = useState({ from: `${todayIso().slice(0, 4)}-01-01`, to: todayIso() });
  const [picked, setPicked] = useState<number[]>([]);
  const [useEmail, setUseEmail] = useState(true);
  const shown: View = asked && VIEWS.some((v) => v.id === asked) ? asked : data && data.ready.length === 0 && data.drafts.length > 0 ? "drafts" : "ready";

  const load = useCallback(async () => {
    try {
      const d = await api<Data>("/firm/billing");
      setData(d);
      setPicked((p) => p.filter((id) => d.drafts.some((x) => x.id === id)));
      setSkipPick((p) => p.filter((id) => d.needs.some((x) => x.appealId === id) || d.ready.some((x) => x.appealId === id)));
      setTrust(await api<Trust>("/firm/trust"));
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

  const skip = (ids: number[]) => act("skip", async () => {
    const r = await api<{ skipped: number }>("/firm/billing/skip", { method: "POST", body: { appealIds: ids, reason: skipReason } });
    setSkipPick([]);
    return `${r.skipped} appeal${r.skipped === 1 ? "" : "s"} taken off Ready to bill (${skipReason.toLowerCase()}).`;
  });
  const draftAgain = (appealId: number) => act("settle", async () => {
    const r = await api<{ id: number }>(`/firm/trust/appeals/${appealId}/settlement`, { method: "POST", body: {} });
    setOpen({ kind: "settlement", id: r.id });
  });
  const t = data?.totals;
  const count = (v: View) => (!data ? 0 : v === "ready" ? data.ready.length : v === "drafts" ? data.drafts.length : v === "unpaid" ? data.unpaid.length : v === "statements" ? data.statements.length
    : v === "trust" ? (trust ? trust.draft.length + trust.approved.length + trust.unsettled.length : 0) : v === "expenses" ? data.openExpenses.length : data.paid.length + data.paidStatements.length);
  const isAdmin = !me.user.isSuperAdmin && me.user.isFirmAdmin;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Billing</div>
          <h1>Invoices and payments</h1>
          <p className="subtitle">Each decided Assessor or Board of Review reduction gets a draft invoice for its fee. Check the drafts, send them, and clients pay online by bank account or card, or by check.</p>
        </div>
        <div className="actions">
          <button type="button" className="btn secondary" aria-expanded={exportOpen} onClick={() => setExportOpen(!exportOpen)}>Accounting export</button>
        </div>
      </div>
      {exportOpen && (
        <div className="card pad" style={{ marginBottom: 14 }}>
          <div className="tbar" style={{ marginBottom: 0, alignItems: "flex-end" }}>
            <div className="fld"><label htmlFor="ex-from">From</label><input id="ex-from" className="in" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></div>
            <div className="fld"><label htmlFor="ex-to">To</label><input id="ex-to" className="in" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></div>
            <a className="btn" href={`/api/firm/accounting/export?from=${range.from}&to=${range.to}`} download>Download CSV</a>
            <span className="meta" style={{ flex: 1, minWidth: 220 }}>Every invoice, payment, expense and trust entry in the range as balanced debits and credits, for your accountant or to import into your books.</span>
          </div>
        </div>
      )}

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
                        <td className="num" style={{ whiteSpace: "nowrap" }}>
                          {canSend && <input type="checkbox" aria-label={`Choose ${r.title}`} style={{ marginRight: 10 }} checked={skipPick.includes(r.appealId)} onChange={(e) => setSkipPick(e.target.checked ? [...skipPick, r.appealId] : skipPick.filter((x) => x !== r.appealId))} />}
                          {canSend && <button type="button" className="btn small" disabled={!!busy} onClick={() => void draftAll([r.appealId])}>Draft</button>}
                        </td>
                      </tr>
                    ))}
                    {data.ready.length === 0 && <tr><td colSpan={7} className="meta" style={{ textAlign: "center", padding: 20 }}>Nothing ready to bill.</td></tr>}
                  </tbody>
                </table>
              </div>
              {data.needs.length > 0 && (
                <>
                  <h3 className="subhead">Needs tax figures ({data.needs.length})</h3>
                  <p className="meta" style={{ marginTop: 0 }}>Decided reductions with a fee whose tax savings can't be worked out yet. Enter what's missing on the appeal's Values tab and they move up to Ready to bill. History billed before Appeal EyeQ can be taken off the list.</p>
                  <div className="tw">
                    <table className="compact">
                      <thead><tr>{canSend && <th><input type="checkbox" aria-label="Choose every appeal that needs tax figures" checked={data.needs.every((n) => skipPick.includes(n.appealId))} onChange={(e) => setSkipPick(e.target.checked ? [...new Set([...skipPick, ...data.needs.map((n) => n.appealId)])] : skipPick.filter((x) => !data.needs.some((n) => n.appealId === x)))} /></th>}<th>Property</th><th>Client</th><th>Appeal</th><th>Missing</th><th /></tr></thead>
                      <tbody>
                        {data.needs.map((n) => (
                          <tr key={n.appealId}>
                            {canSend && <td><input type="checkbox" aria-label={`Choose ${n.title}`} checked={skipPick.includes(n.appealId)} onChange={(e) => setSkipPick(e.target.checked ? [...skipPick, n.appealId] : skipPick.filter((x) => x !== n.appealId))} /></td>}
                            <td><Matter title={n.title} propertyId={n.propertyId} /></td>
                            <td><Link to={`/accounts/${n.accountId}`}>{n.client}</Link></td>
                            <td>{n.year}<span className="mn" style={{ display: "block" }}>{LEVEL_LABELS[n.level]}</span></td>
                            <td><span className="warn-text">{n.missing.join(", ")}</span></td>
                            <td className="num"><Link className="btn small secondary" to={`/properties/${n.propertyId}?appeal=${n.appealId}`}>Enter figures</Link></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              {canSend && skipPick.length > 0 && (
                <div className="notice-box" style={{ marginTop: 12 }}>
                  <span>{skipPick.length} chosen. Take {skipPick.length === 1 ? "it" : "them"} off Ready to bill because:</span>
                  <select className="in" style={{ width: 230, height: 30 }} aria-label="Reason" value={skipReason} onChange={(e) => setSkipReason(e.target.value)}>
                    {SKIP_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <span className="sp" />
                  <button type="button" className="btn small" disabled={busy === "skip"} onClick={() => void skip(skipPick)}>Not billed here</button>
                  <button type="button" className="btn small ghost" onClick={() => setSkipPick([])}>Clear</button>
                </div>
              )}
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
          {data && shown === "trust" && trust && (
            <>
              <div className="tbar">
                <span className="meta">{formatMoney(trust.inTrust)} held in trust for {trust.balances.length} client{trust.balances.length === 1 ? "" : "s"}. PTAB and Circuit Court refunds come in here when recorded on Decisions, Awaiting refund.</span>
              </div>
              <h3 className="subhead" style={{ marginTop: 0 }}>To approve ({trust.draft.length})</h3>
              <SettlementList rows={trust.draft} onOpen={(id) => setOpen({ kind: "settlement", id })} />
              <h3 className="subhead">Approved, to pay ({trust.approved.length})</h3>
              <SettlementList rows={trust.approved} onOpen={(id) => setOpen({ kind: "settlement", id })} />
              {trust.unsettled.length > 0 && (
                <>
                  <h3 className="subhead">Refunds in trust with no settlement</h3>
                  <div className="tw">
                    <table className="compact">
                      <thead><tr><th>Property</th><th>Client</th><th>Appeal</th><th>Refund in</th><th className="num">Refund</th><th /></tr></thead>
                      <tbody>
                        {trust.unsettled.map((u) => (
                          <tr key={u.appealId}>
                            <td><Matter title={u.title} propertyId={u.propertyId} /></td><td>{u.client}</td><td>{u.appeal}</td><td>{formatDate(u.receivedOn)}</td><td className="num">{formatMoney(u.refund)}</td>
                            <td className="num">{canSend && <button type="button" className="btn small" disabled={!!busy} onClick={() => void draftAgain(u.appealId)}>Draft settlement</button>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              <h3 className="subhead">Client trust balances</h3>
              <div className="tw">
                <table className="compact">
                  <thead><tr><th>Client</th><th>Last entry</th><th className="num">Balance</th></tr></thead>
                  <tbody>
                    {trust.balances.map((b) => <tr key={b.accountId}><td><Link to={`/accounts/${b.accountId}`}>{b.client}</Link></td><td>{formatDate(b.lastOn)}</td><td className="num">{formatMoney(b.balance)}</td></tr>)}
                    {trust.balances.length === 0 && <tr><td colSpan={3} className="meta" style={{ textAlign: "center", padding: 20 }}>Nothing held in trust.</td></tr>}
                  </tbody>
                </table>
              </div>
              {trust.paid.length > 0 && (
                <>
                  <h3 className="subhead">Paid out in the last year</h3>
                  <SettlementList rows={trust.paid} onOpen={(id) => setOpen({ kind: "settlement", id })} />
                </>
              )}
            </>
          )}
          {data && shown === "expenses" && (
            <>
              <p className="meta" style={{ marginTop: 0 }}>Open expenses the firm fronted, not yet on an invoice or a settlement. Add and change them on each property's Billing tab.</p>
              <ExpenseList rows={data.openExpenses} showProperty />
            </>
          )}
          {data && shown === "paid" && <BillingList invoices={data.paid} statements={data.paidStatements} onOpen={setOpen} empty="Nothing paid in the last six months." />}
        </div>
      </section>

      {open?.kind === "invoice" && <InvoiceSheet invoiceId={open.id} emailOn={data?.setup.email ?? false} onClose={() => setOpen(null)} onChanged={() => void load()} />}
      {open?.kind === "settlement" && <SettlementSheet settlementId={open.id} onClose={() => setOpen(null)} onChanged={() => void load()} />}
      {open?.kind === "statement" && <StatementSheet statementId={open.id} onClose={() => setOpen(null)} onChanged={() => void load()} onOpenInvoice={(id) => setOpen({ kind: "invoice", id })} />}
    </>
  );
}
