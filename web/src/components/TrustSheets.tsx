// Trust and expenses (Delivery 9b): a refund's settlement (the fee and fronted expenses out
// of the refund, the rest to the client, approved by an attorney, then paid by check or ACH),
// expenses the firm fronts, and a client's trust ledger.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, errorText } from "../api";
import { useSession } from "../App";
import { formatDate, formatDateTime, formatMoney, todayIso } from "../format";
import { Sheet } from "./Sheet";
import { MoneyInput } from "./MoneyInput";
import { Matter } from "./BillingSheets";

export interface SettlementRow {
  id: number; status: "draft" | "approved" | "paid" | "void"; accountId: number; propertyId: number; appealId: number; client: string; appeal: string; title: string;
  refund: string; receivedOn: string; fee: string; expenses: string; toClient: string; preparedBy: string | null; approvedBy: string | null; approvedAt: string | null;
  paidOn: string | null; payoutMethod: "check" | "ach" | null; payoutReference: string | null; voidReason: string | null;
}
export interface ExpenseRow {
  id: number; accountId: number; propertyId: number; appealId: number | null; incurredOn: string; vendor: string; description: string; amount: string;
  recovery: "refund" | "invoice"; state: "open" | "on_invoice" | "in_settlement" | "recovered" | "written_off"; writtenOffReason: string | null;
  receipt: { id: number; name: string } | null; client: string; appeal: string | null; title: string;
}
interface SettlementDetail extends SettlementRow {
  note: string | null; feeBasis: { percent?: string; source?: string; cap?: string | null; flat?: string; noFee?: boolean; description?: string; overriddenFrom?: string } | null;
  expenseList: (ExpenseRow & { included: boolean })[]; emails: { to_addresses: string[]; status: string; created_at: string }[]; suggestedTo: string[]; today: string;
}

const STATE_LABEL: Record<ExpenseRow["state"], string> = { open: "Open", on_invoice: "On an invoice", in_settlement: "On a settlement", recovered: "Recovered", written_off: "Written off" };
const STATE_PILL: Record<ExpenseRow["state"], string> = { open: "warn", on_invoice: "net", in_settlement: "net", recovered: "ok", written_off: "grey" };

export function SettlementStatus({ s }: { s: Pick<SettlementRow, "status"> }) {
  const map = { draft: ["copper", "To approve"], approved: ["warn", "Approved, to pay"], paid: ["ok", "Paid"], void: ["grey", "Void"] } as const;
  const [cls, label] = map[s.status];
  return <span className={`pill ${cls}`}>{label}</span>;
}

export function ExpenseState({ e }: { e: Pick<ExpenseRow, "state"> }) {
  return <span className={`pill ${STATE_PILL[e.state]}`}>{STATE_LABEL[e.state]}</span>;
}

const parseEmails = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

export function SettlementSheet({ settlementId, onClose, onChanged }: { settlementId: number; onClose: () => void; onChanged: () => void }) {
  const { can } = useSession();
  const [d, setD] = useState<SettlementDetail | null>(null);
  const [fee, setFee] = useState<string | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [note, setNote] = useState("");
  const [payout, setPayout] = useState({ method: "check" as "check" | "ach", reference: "", paidOn: "" });
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const take = useCallback((x: SettlementDetail) => {
    setD(x);
    setFee(x.fee);
    setPicked(x.expenseList.filter((e) => e.included).map((e) => e.id));
    setNote(x.note ?? "");
    setPayout((p) => ({ ...p, paidOn: p.paidOn || x.today }));
    setTo(x.suggestedTo.join(", "));
  }, []);
  useEffect(() => { void api<SettlementDetail>(`/firm/trust/settlements/${settlementId}`).then(take).catch((e) => setError(errorText(e))); }, [settlementId, take]);

  async function run(label: string, fn: () => Promise<string | void>) {
    setBusy(label); setError(""); setNotice("");
    try { const m = await fn(); if (m) setNotice(m); onChanged(); } catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  }
  const call = (path: string, body: unknown = {}) => api<SettlementDetail>(`/firm/trust/settlements/${settlementId}${path}`, { method: "POST", body });

  if (!d) return <Sheet eyebrow="Trust settlement" title="Loading" onClose={onClose}>{error && <div className="error" role="alert">{error}</div>}</Sheet>;
  const draft = d.status === "draft" && can("invoices.send");
  const dirty = draft && (fee !== d.fee || note !== (d.note ?? "") || JSON.stringify([...picked].sort()) !== JSON.stringify(d.expenseList.filter((e) => e.included).map((e) => e.id).sort()));
  const expensesNow = d.expenseList.filter((e) => picked.includes(e.id)).reduce((a, e) => a + Number(e.amount), 0);
  const toClientNow = Number(d.refund) - Number(fee ?? 0) - expensesNow;
  const b = d.feeBasis ?? {};
  const feeWhy = b.noFee ? "No fee for this client or property" : b.flat ? "Flat fee" : `${b.percent ?? ""}% of the refund${b.cap ? `, capped at ${formatMoney(b.cap)}` : ""}${b.overriddenFrom ? `, changed from ${formatMoney(b.overriddenFrom)}` : ""}`;

  const save = () => run("save", async () => {
    take(await api<SettlementDetail>(`/firm/trust/settlements/${settlementId}`, { method: "PATCH", body: { feeAmount: fee ?? "0", expenseIds: picked, note: note || null } }));
    return "Settlement saved.";
  });

  return (
    <Sheet wide eyebrow={`Trust settlement · ${d.appeal}`} title={d.client} onClose={onClose}
      footer={<><span className="sp" /><button type="button" className="btn secondary" onClick={onClose}>Close</button>
        {dirty && <button type="button" className="btn" disabled={!!busy} onClick={() => void save()}>{busy === "save" ? "Saving" : "Save settlement"}</button>}</>}>
      <div className="dmeta" style={{ marginBottom: 12 }}>
        <span><Matter title={d.title} propertyId={d.propertyId} /></span>
        <SettlementStatus s={d} />
        <span>Refund received {formatDate(d.receivedOn)}</span>
        {d.approvedBy && <span>Approved by {d.approvedBy}</span>}
        {d.paidOn && <span>Paid {formatDate(d.paidOn)}</span>}
      </div>
      {d.voidReason && <div className="notice-box">Void: {d.voidReason}</div>}
      {notice && <div className="ok" role="status">{notice}</div>}
      {error && <div className="error" role="alert">{error}</div>}

      <div className="tw">
        <table className="compact settle">
          <tbody>
            <tr><td>Refund received, including interest</td><td className="num">{formatMoney(d.refund)}</td></tr>
            <tr>
              <td>Fee<span className="mn" style={{ display: "block" }}>{feeWhy}</span></td>
              <td className="num" style={{ width: 170 }}>{draft && can("fees.edit") ? <MoneyInput money aria-label="Fee" value={fee} onChange={setFee} /> : `(${formatMoney(d.fee)})`}</td>
            </tr>
            <tr><td>Expenses the firm fronted</td><td className="num">({formatMoney((draft ? expensesNow : Number(d.expenses)).toFixed(2))})</td></tr>
            <tr><td><b>{d.status === "paid" ? "Paid to the client" : "To the client"}</b></td><td className="num"><b>{formatMoney((draft ? toClientNow : Number(d.toClient)).toFixed(2))}</b></td></tr>
          </tbody>
        </table>
      </div>
      {draft && toClientNow < 0 && <div className="error" role="alert">The fee and expenses add up to more than the refund.</div>}

      {d.expenseList.length > 0 && (
        <div className="blk" style={{ marginTop: 14 }}>
          <h5>Expenses to recover from this refund</h5>
          <ul className="tl">
            {d.expenseList.map((e) => (
              <li key={e.id}>
                <span className="k">{draft
                  ? <label className="check"><input type="checkbox" checked={picked.includes(e.id)} onChange={(ev) => setPicked(ev.target.checked ? [...picked, e.id] : picked.filter((x) => x !== e.id))} aria-label={`Recover ${e.vendor}`} /> {formatDate(e.incurredOn)}</label>
                  : formatDate(e.incurredOn)}</span>
                <span>{e.vendor}: {e.description} · {formatMoney(e.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {draft ? (
        <div className="fld" style={{ marginTop: 10 }}><label htmlFor="st-note">Note on the letter</label><textarea id="st-note" className="in" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></div>
      ) : d.note && <p className="muted">{d.note}</p>}

      <div className="blk" style={{ marginTop: 14 }}>
        <h5>Letter to the client</h5>
        <a className="btn small ghost" href={`/api/firm/trust/settlements/${d.id}/letter`} target="_blank" rel="noreferrer">Download letter (PDF)</a>
        {d.status === "paid" && can("invoices.send") && (
          <div style={{ marginTop: 10 }}>
            <div className="fld"><label htmlFor="st-to">Email it to</label><input id="st-to" className="in" value={to} onChange={(e) => setTo(e.target.value)} /></div>
            <button type="button" className="btn small secondary" style={{ marginTop: 8 }} disabled={!!busy} onClick={() => void run("email", async () => {
              const r = await api<{ emailed: boolean; emailError: string | null }>(`/firm/trust/settlements/${d.id}/email`, { method: "POST", body: { to: parseEmails(to) } });
              if (r.emailError) throw new Error(r.emailError);
              return "Letter emailed.";
            })}>{busy === "email" ? "Sending" : "Email the letter"}</button>
          </div>
        )}
        {d.emails.length > 0 && <ul className="tl" style={{ marginTop: 8 }}>{d.emails.map((e, i) => <li key={i}><span className="k">{formatDateTime(e.created_at)}</span><span>{e.to_addresses.join(", ")} · {e.status === "sent" ? "sent" : "not sent"}</span></li>)}</ul>}
      </div>

      {d.status === "draft" && (
        <div className="notice-box copper" style={{ marginTop: 14 }}>
          <span>{can("trust.approve") ? "Check the figures, then approve. The payout can be recorded once it's approved." : "An attorney approves this settlement before the payout is recorded."}</span>
          <span className="sp" />
          {can("trust.approve") && <button type="button" className="btn small copper" disabled={!!busy || dirty || toClientNow < 0} onClick={() => void run("approve", async () => { take(await call("/approve")); return "Approved."; })}>{dirty ? "Save first" : "Approve settlement"}</button>}
        </div>
      )}

      {d.status === "approved" && can("invoices.send") && (
        <div className="blk" style={{ marginTop: 14 }}>
          <h5>Record the payout to the client</h5>
          <p className="meta" style={{ marginTop: 0 }}>Recording it moves the fee ({formatMoney(d.fee)}) and expenses ({formatMoney(d.expenses)}) out of trust and records {formatMoney(d.toClient)} paid to the client.</p>
          <div className="fgrid">
            <div className="fld"><label htmlFor="po-m">Paid by</label><select id="po-m" className="in" value={payout.method} onChange={(e) => setPayout({ ...payout, method: e.target.value as "check" | "ach" })}><option value="check">Check</option><option value="ach">ACH</option></select></div>
            <div className="fld"><label htmlFor="po-r">{payout.method === "check" ? "Check number" : "ACH reference (optional)"}</label><input id="po-r" className="in" value={payout.reference} onChange={(e) => setPayout({ ...payout, reference: e.target.value })} /></div>
            <div className="fld"><label htmlFor="po-d">Date paid</label><input id="po-d" className="in" type="date" max={d.today} value={payout.paidOn} onChange={(e) => setPayout({ ...payout, paidOn: e.target.value })} /></div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn copper" disabled={!!busy} onClick={() => void run("pay", async () => { take(await call("/pay", { method: payout.method, reference: payout.reference || null, paidOn: payout.paidOn })); return "Payout recorded. The client's trust balance for this refund is now zero."; })}>{busy === "pay" ? "Recording" : "Record payout"}</button>
            {can("trust.approve") && <button type="button" className="btn ghost" disabled={!!busy} onClick={() => void run("unapprove", async () => { take(await call("/unapprove")); return "Back to draft."; })}>Back to draft</button>}
          </div>
        </div>
      )}

      {(d.status === "draft" || d.status === "approved") && can("trust.approve") && (
        voiding ? (
          <div className="blk" style={{ marginTop: 14 }}>
            <h5>Void this settlement</h5>
            <p className="meta" style={{ marginTop: 0 }}>The refund stays in trust; draft a new settlement from Billing, Trust.</p>
            <div className="fld"><label htmlFor="st-void">Why</label><input id="st-void" className="in" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button type="button" className="btn small danger" disabled={!!busy} onClick={() => void run("void", async () => { take(await call("/void", { reason })); setVoiding(false); return "Settlement voided."; })}>Void settlement</button>
              <button type="button" className="btn small ghost" onClick={() => setVoiding(false)}>Keep it</button>
            </div>
          </div>
        ) : <div style={{ marginTop: 14 }}><button type="button" className="btn small ghost" onClick={() => setVoiding(true)}>Void settlement</button></div>
      )}
    </Sheet>
  );
}

/** Add or edit an expense the firm fronted, on a property. */
export function ExpenseSheet({ propertyId, existing, appeals, receipts, onClose, onSaved }: {
  propertyId: number; existing: ExpenseRow | null; appeals: { id: number; label: string }[]; receipts: { id: number; name: string }[]; onClose: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState({
    incurredOn: existing?.incurredOn?.slice(0, 10) ?? todayIso(), vendor: existing?.vendor ?? "", description: existing?.description ?? "", amount: existing?.amount ?? (null as string | null),
    recovery: existing?.recovery ?? "refund", appealId: existing?.appealId ? String(existing.appealId) : "", receiptDocumentId: existing?.receipt ? String(existing.receipt.id) : "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [writeOff, setWriteOff] = useState<string | null>(null);
  const { can } = useSession();
  async function other(fn: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await fn(); onSaved(); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  async function save(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true); setError("");
    const body = { incurredOn: f.incurredOn, vendor: f.vendor, description: f.description, amount: f.amount ?? "", recovery: f.recovery, appealId: f.appealId ? Number(f.appealId) : null, receiptDocumentId: f.receiptDocumentId ? Number(f.receiptDocumentId) : null };
    try {
      if (existing) await api(`/firm/expenses/${existing.id}`, { method: "PATCH", body });
      else await api("/firm/expenses", { method: "POST", body: { propertyId, ...body } });
      onSaved();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return (
    <Sheet eyebrow={existing ? "Edit expense" : "New expense"} title="Expense the firm fronted" onClose={onClose} onSubmit={() => void save()}
      footer={<>{error && <span className="error" style={{ margin: 0, flexBasis: "100%" }} role="alert">{error}</span>}<span className="sp" /><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy}>{busy ? "Saving" : "Save expense"}</button></>}>
      <p className="muted" style={{ marginTop: 0 }}>Only costs the firm pays for the client. If the client pays the vendor directly, there's nothing to record.</p>
      <div className="fgrid">
        <div className="fld"><label htmlFor="ex-d">Date paid</label><input id="ex-d" className="in" type="date" max={todayIso()} value={f.incurredOn} onChange={(e) => setF({ ...f, incurredOn: e.target.value })} required /></div>
        <div className="fld"><label htmlFor="ex-a">Amount</label><MoneyInput id="ex-a" money value={f.amount} onChange={(v) => setF({ ...f, amount: v })} required /></div>
        <div className="fld"><label htmlFor="ex-v">Paid to</label><input id="ex-v" className="in" value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} placeholder="Lakeside Appraisal" required /></div>
        <div className="fld"><label htmlFor="ex-ap">Appeal</label><select id="ex-ap" className="in" value={f.appealId} onChange={(e) => setF({ ...f, appealId: e.target.value })}><option value="">Not tied to one appeal</option>{appeals.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></div>
        <div className="fld span2"><label htmlFor="ex-desc">For</label><input id="ex-desc" className="in" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Appraisal for the PTAB hearing" required /></div>
        <div className="fld span2">
          <label htmlFor="ex-r">Recover it</label>
          <select id="ex-r" className="in" value={f.recovery} onChange={(e) => setF({ ...f, recovery: e.target.value as "refund" | "invoice" })}>
            <option value="refund">From the refund (PTAB or Circuit Court)</option>
            <option value="invoice">On the client's next invoice</option>
          </select>
        </div>
        <div className="fld span2">
          <label htmlFor="ex-rc">Receipt</label>
          <select id="ex-rc" className="in" value={f.receiptDocumentId} onChange={(e) => setF({ ...f, receiptDocumentId: e.target.value })}>
            <option value="">{receipts.length ? "None chosen" : "No files on this property yet"}</option>
            {receipts.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <span className="hint">Upload the receipt on the Files tab, then pick it here.</span>
        </div>
      </div>
      {existing && (
        <div className="blk" style={{ marginTop: 16 }}>
          <h5>Not recovering it</h5>
          {writeOff === null ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {can("invoices.void") && <button type="button" className="btn small secondary" onClick={() => setWriteOff("")}>Write it off</button>}
              <button type="button" className="btn small ghost" disabled={busy} onClick={() => void other(() => api(`/firm/expenses/${existing.id}`, { method: "DELETE" }))}>Delete (entered by mistake)</button>
            </div>
          ) : (
            <>
              <div className="fld"><label htmlFor="ex-wo">Why it won't be recovered</label><input id="ex-wo" className="in" value={writeOff} onChange={(e) => setWriteOff(e.target.value)} /></div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button type="button" className="btn small danger" disabled={busy} onClick={() => void other(() => api(`/firm/expenses/${existing.id}/write-off`, { method: "POST", body: { reason: writeOff } }))}>Write off</button>
                <button type="button" className="btn small ghost" onClick={() => setWriteOff(null)}>Cancel</button>
              </div>
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}

export function ExpenseList({ rows, onOpen, showProperty }: { rows: ExpenseRow[]; onOpen?: (e: ExpenseRow) => void; showProperty?: boolean }) {
  return (
    <div className="tw">
      <table className="compact">
        <thead><tr><th>Date</th>{showProperty && <th>Property</th>}<th>Paid to</th><th>For</th><th>Recover</th><th className="num">Amount</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id} className={onOpen && e.state === "open" ? "clickable" : ""} onClick={() => e.state === "open" && onOpen?.(e)}>
              <td>{formatDate(e.incurredOn)}</td>
              {showProperty && <td><Matter title={e.title} propertyId={e.propertyId} /><span className="mn" style={{ display: "block" }}>{e.client}</span></td>}
              <td>{e.vendor}</td>
              <td>{e.description}{e.appeal && <span className="mn" style={{ display: "block" }}>{e.appeal}</span>}{e.receipt && <span className="mn" style={{ display: "block" }}>Receipt: {e.receipt.name}</span>}</td>
              <td>{e.recovery === "refund" ? "From the refund" : "On an invoice"}</td>
              <td className="num">{formatMoney(e.amount)}</td>
              <td><ExpenseState e={e} />{e.writtenOffReason && <span className="mn" style={{ display: "block" }}>{e.writtenOffReason}</span>}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={showProperty ? 7 : 6} className="meta" style={{ textAlign: "center", padding: 20 }}>No expenses.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function SettlementList({ rows, onOpen, showClient = true }: { rows: SettlementRow[]; onOpen: (id: number) => void; showClient?: boolean }) {
  return (
    <div className="tw">
      <table className="compact">
        <thead><tr><th>Property</th>{showClient && <th>Client</th>}<th>Appeal</th><th>Refund in</th><th className="num">Refund</th><th className="num">Fee</th><th className="num">Expenses</th><th className="num">To client</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} className="clickable" tabIndex={0} onClick={() => onOpen(s.id)} onKeyDown={(e) => { if (e.key === "Enter") onOpen(s.id); }}>
              <td><Matter title={s.title} propertyId={s.propertyId} /></td>
              {showClient && <td>{s.client}</td>}
              <td>{s.appeal}</td><td>{formatDate(s.receivedOn)}</td>
              <td className="num">{formatMoney(s.refund)}</td><td className="num">{formatMoney(s.fee)}</td><td className="num">{formatMoney(s.expenses)}</td><td className="num"><b>{formatMoney(s.toClient)}</b></td>
              <td><SettlementStatus s={s} />{s.paidOn && <span className="mn" style={{ display: "block" }}>{s.payoutMethod === "ach" ? "ACH" : "Check"}{s.payoutReference ? ` ${s.payoutReference}` : ""} · {formatDate(s.paidOn)}</span>}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={showClient ? 9 : 8} className="meta" style={{ textAlign: "center", padding: 20 }}>None.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/** A client's trust ledger with its running balance. */
export function TrustLedger({ accountId }: { accountId: number }) {
  const [d, setD] = useState<{ entries: { id: number; kind: string; amount: string; entryOn: string; memo: string | null; reference: string | null; balance: string }[]; balance: string } | null>(null);
  useEffect(() => { void api<NonNullable<typeof d>>(`/firm/trust/accounts/${accountId}`).then(setD).catch(() => undefined); }, [accountId]);
  if (!d || d.entries.length === 0) return null;
  const KIND: Record<string, string> = { deposit: "Refund deposited", fee: "Fee to operating", expenses: "Expenses reimbursed", payout: "Paid to client" };
  return (
    <>
      <h3 className="subhead">Trust ledger · balance {formatMoney(d.balance)}</h3>
      <div className="tw">
        <table className="compact">
          <thead><tr><th>Date</th><th>Entry</th><th>Memo</th><th className="num">Amount</th><th className="num">Balance</th></tr></thead>
          <tbody>
            {d.entries.map((e) => (
              <tr key={e.id}><td>{formatDate(e.entryOn)}</td><td>{KIND[e.kind] ?? e.kind}</td><td>{e.memo}{e.reference ? ` · ${e.reference}` : ""}</td><td className="num">{formatMoney(e.amount)}</td><td className="num">{formatMoney(e.balance)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
