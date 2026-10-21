// Billing sheets shared by the Billing page, the client page and the property page:
// one invoice (edit a draft, send it, copy its pay link, record a check, charge a saved
// method, void), one statement, and gathering a client's unpaid invoices into a statement.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, errorText } from "../api";
import { useSession } from "../App";
import { formatDate, formatDateTime, formatMoney, splitMatterTitle, todayIso } from "../format";
import { Sheet } from "./Sheet";
import { MoneyInput } from "./MoneyInput";

export interface InvoiceRow {
  id: number; number: string | null; status: "draft" | "sent" | "paid" | "void"; issuedOn: string | null; dueOn: string | null; total: string;
  sentAt: string | null; paidAt: string | null; appealId: number | null; propertyId: number; accountId: number; client: string; title: string;
  appeal: string | null; statement: { id: number; number: string; status: string } | null; paymentStatus: string | null; daysOverdue: number;
}
export interface StatementRow { id: number; number: string; status: "open" | "paid" | "void"; issuedOn: string; dueOn: string; total: string; client: string; accountId: number; invoices: number; paymentStatus: string | null; paidAt: string | null }
interface Payment { id: number; amount: string; method: string; status: string; received_on: string | null; check_number: string | null; reference?: string | null; failure_reason: string | null; created_at?: string; recorded_by?: string | null }
interface InvoiceDetail extends InvoiceRow {
  note: string | null; sentTo: string[] | null; voidReason: string | null; lines: { id: number; kind: "fee" | "other"; description: string; amount: string }[];
  payments: Payment[]; emails: { to_addresses: string[]; status: string; error: string | null; created_at: string }[];
  payable: boolean; blockedReason: string | null; savedMethod: string | null; suggestedTo: string[]; hasLink: boolean; today: string;
}
interface StatementDetail extends StatementRow { invoiceList: InvoiceRow[]; payments: Payment[]; payable: boolean; blockedReason: string | null; savedMethod: string | null; today: string }

const METHOD: Record<string, string> = { card: "Card", ach: "Bank account (ACH)", check: "Check", other: "Other" };

/** The status pill for an invoice row, with a processing payment or statement noted. */
export function InvoiceStatus({ r }: { r: InvoiceRow }) {
  if (r.status === "draft") return <span className="pill grey">Draft</span>;
  if (r.status === "void") return <span className="pill grey">Void</span>;
  if (r.status === "paid") return <span className="pill ok">Paid</span>;
  if (r.paymentStatus === "processing") return <span className="pill net">Payment processing</span>;
  return (
    <>
      <span className={`pill ${r.daysOverdue > 0 ? "crit" : "warn"}`}>{r.daysOverdue > 0 ? `${r.daysOverdue} days overdue` : "Unpaid"}</span>
      {r.statement?.status === "open" && <span className="mn" style={{ display: "block" }}>On {r.statement.number}</span>}
    </>
  );
}

export function StatementStatus({ s }: { s: StatementRow }) {
  if (s.status === "paid") return <span className="pill ok">Paid</span>;
  if (s.status === "void") return <span className="pill grey">Void</span>;
  if (s.paymentStatus === "processing") return <span className="pill net">Payment processing</span>;
  return <span className={`pill ${s.dueOn < todayIso() ? "crit" : "warn"}`}>{s.dueOn < todayIso() ? "Overdue" : "Unpaid"}</span>;
}

export function Matter({ title, propertyId }: { title: string; propertyId: number }) {
  const t = splitMatterTitle(title);
  return <>{t.pin && <span className="mn" style={{ display: "block" }}>PIN {t.pin}</span>}<Link to={`/properties/${propertyId}`} className="mt" onClick={(e) => e.stopPropagation()}>{t.place}</Link></>;
}

const parseEmails = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

function PayLink({ url, onLink }: { url: string; onLink: () => Promise<string> }) {
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  async function copy() {
    setError("");
    try {
      const l = link || (await onLink());
      setLink(l);
      await navigator.clipboard?.writeText(l).catch(() => undefined);
      setCopied(true);
    } catch (e) { setError(errorText(e)); }
  }
  return (
    <div className="blk">
      <h5>Pay link</h5>
      <p className="meta" style={{ marginTop: 0 }}>The client opens it without signing in to see the bill and pay by bank account or card.</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" className="btn small secondary" onClick={() => void copy()}>{copied ? "Copied" : "Copy pay link"}</button>
        <a className="btn small ghost" href={url} target="_blank" rel="noreferrer">Download PDF</a>
      </div>
      {link && <input className="in" readOnly value={link} aria-label="Pay link" style={{ marginTop: 8 }} onFocus={(e) => e.target.select()} />}
      {error && <div className="error" role="alert">{error}</div>}
    </div>
  );
}

/** Record a check (or other payment received outside Stripe) for the full amount. */
function RecordPayment({ total, today, path, onDone }: { total: string; today: string; path: string; onDone: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ method: "check", amount: total as string | null, receivedOn: today, checkNumber: "", reference: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setError("");
    try {
      await api(path, { method: "POST", body: { method: f.method, amount: f.amount ?? "", receivedOn: f.receivedOn, checkNumber: f.checkNumber || null, reference: f.reference || null } });
      setOpen(false);
      onDone("Payment recorded.");
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  if (!open) return <button type="button" className="btn small secondary" onClick={() => setOpen(true)}>Record a check</button>;
  return (
    <div className="blk" style={{ flexBasis: "100%" }}>
      <h5>Record a payment</h5>
      <p className="meta" style={{ marginTop: 0 }}>Payments are for the full amount, {formatMoney(total)}. Partial payments aren't accepted.</p>
      <div className="fgrid">
        <div className="fld"><label htmlFor="rp-m">Method</label><select id="rp-m" className="in" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option value="check">Check</option><option value="other">Other (wire, cash)</option></select></div>
        <div className="fld"><label htmlFor="rp-a">Amount</label><MoneyInput id="rp-a" money value={f.amount} onChange={(v) => setF({ ...f, amount: v })} /></div>
        <div className="fld"><label htmlFor="rp-d">Received</label><input id="rp-d" className="in" type="date" max={today} value={f.receivedOn} onChange={(e) => setF({ ...f, receivedOn: e.target.value })} /></div>
        {f.method === "check"
          ? <div className="fld"><label htmlFor="rp-n">Check number</label><input id="rp-n" className="in" value={f.checkNumber} onChange={(e) => setF({ ...f, checkNumber: e.target.value })} /></div>
          : <div className="fld"><label htmlFor="rp-r">Reference</label><input id="rp-r" className="in" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></div>}
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button type="button" className="btn small" disabled={busy} onClick={() => void save()}>{busy ? "Saving" : "Record payment"}</button>
        <button type="button" className="btn small ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

function VoidBox({ path, what, onDone }: { path: string; what: string; onDone: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  async function go() {
    setError("");
    try { await api(path, { method: "POST", body: { reason } }); setOpen(false); onDone(`The ${what} is void.`); } catch (e) { setError(errorText(e)); }
  }
  if (!open) return <button type="button" className="btn small ghost" onClick={() => setOpen(true)}>Void {what}</button>;
  return (
    <div className="blk" style={{ flexBasis: "100%" }}>
      <h5>Void this {what}</h5>
      <p className="meta" style={{ marginTop: 0 }}>Its pay link stops working. The number stays in the record.</p>
      <div className="fld"><label htmlFor="vd-r">Why</label><input id="vd-r" className="in" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Billed the wrong client" /></div>
      {error && <div className="error" role="alert">{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button type="button" className="btn small danger" onClick={() => void go()}>Void {what}</button>
        <button type="button" className="btn small ghost" onClick={() => setOpen(false)}>Keep it</button>
      </div>
    </div>
  );
}

function ChargeSaved({ label, total, path, onDone }: { label: string; total: string; path: string; onDone: (msg: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true); setError("");
    try {
      const r = await api<{ status: string }>(path, { method: "POST", body: {} });
      setConfirm(false);
      onDone(r.status === "processing" ? `Charged ${label}. Bank payments take a few business days to settle.` : `Charged ${label}.`);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <>
      {confirm ? (
        <span className="confirm">
          Charge {formatMoney(total)} to the client's {label}?
          <button type="button" className="btn small copper" disabled={busy} onClick={() => void go()}>{busy ? "Charging" : "Charge"}</button>
          <button type="button" className="btn small ghost" onClick={() => setConfirm(false)}>Cancel</button>
        </span>
      ) : <button type="button" className="btn small copper" onClick={() => setConfirm(true)}>Charge {label}</button>}
      {error && <div className="error" role="alert" style={{ flexBasis: "100%" }}>{error}</div>}
    </>
  );
}

function Payments({ rows }: { rows: Payment[] }) {
  if (!rows.length) return null;
  return (
    <div className="blk">
      <h5>Payments</h5>
      <ul className="tl">
        {rows.map((p) => (
          <li key={p.id}>
            <span className="k">{METHOD[p.method] ?? p.method}{p.check_number ? ` #${p.check_number}` : ""}</span>
            <span>
              {formatMoney(p.amount)} · {p.status === "succeeded" ? `received ${p.received_on ? formatDate(p.received_on) : ""}` : p.status === "processing" ? "processing" : "failed"}
              {p.failure_reason && <span className="mn" style={{ display: "block" }}>{p.failure_reason}</span>}
              {p.recorded_by && <span className="mn" style={{ display: "block" }}>Recorded by {p.recorded_by}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface LineDraft { id?: number; kind: "fee" | "other"; description: string; amount: string | null }

export function InvoiceSheet({ invoiceId, emailOn, onClose, onChanged }: { invoiceId: number; emailOn: boolean; onClose: () => void; onChanged: () => void }) {
  const { can } = useSession();
  const canSend = can("invoices.send");
  const [d, setD] = useState<InvoiceDetail | null>(null);
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [note, setNote] = useState("");
  const [to, setTo] = useState("");
  const [useEmail, setUseEmail] = useState(emailOn);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [sentLink, setSentLink] = useState("");

  const take = useCallback((x: InvoiceDetail) => {
    setD(x);
    setLines(x.lines.map((l) => ({ id: l.id, kind: l.kind, description: l.description, amount: l.amount })));
    setNote(x.note ?? "");
    setTo((x.sentTo?.length ? x.sentTo : x.suggestedTo).join(", "));
  }, []);
  const load = useCallback(async () => {
    try { take(await api<InvoiceDetail>(`/firm/billing/invoices/${invoiceId}`)); } catch (e) { setError(errorText(e)); }
  }, [invoiceId, take]);
  useEffect(() => { void load(); }, [load]);

  const done = (msg: string) => { setNotice(msg); void load(); onChanged(); };
  async function run(label: string, fn: () => Promise<string | void>) {
    setBusy(label); setError(""); setNotice("");
    try { const m = await fn(); if (m) setNotice(m); onChanged(); } catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  }
  const save = () => run("save", async () => {
    take(await api<InvoiceDetail>(`/firm/billing/invoices/${invoiceId}`, { method: "PATCH", body: { note, lines: lines.map((l) => ({ ...(l.id ? { id: l.id } : {}), description: l.description, amount: l.amount ?? "" })) } }));
    return "Draft saved.";
  });
  const send = () => run("send", async () => {
    const r = await api<{ link: string; emailed: boolean; emailError: string | null; invoice: InvoiceDetail }>(`/firm/billing/invoices/${invoiceId}/send`, { method: "POST", body: { to: parseEmails(to), email: useEmail } });
    take(r.invoice);
    setSentLink(r.link);
    if (r.emailError) setError(r.emailError);
    return r.emailed ? `Invoice ${r.invoice.number} emailed to ${parseEmails(to).join(", ")}.` : `Invoice ${r.invoice.number} is sent. Copy the pay link below to share it.`;
  });
  const remove = () => run("delete", async () => { await api(`/firm/billing/invoices/${invoiceId}`, { method: "DELETE" }); onClose(); });

  if (!d) return <Sheet eyebrow="Invoice" title="Loading" onClose={onClose}>{error && <div className="error" role="alert">{error}</div>}</Sheet>;
  const editing = d.status === "draft" && canSend;
  const dirty = editing && (note !== (d.note ?? "") || JSON.stringify(lines.map((l) => [l.id, l.description, l.amount])) !== JSON.stringify(d.lines.map((l) => [l.id, l.description, l.amount])));
  const total = lines.reduce((a, l) => a + (Number(l.amount) || 0), 0);

  return (
    <Sheet wide eyebrow={d.number ? `Invoice ${d.number}` : "Draft invoice"} title={d.client} onClose={onClose}
      footer={<>
        {editing && <button type="button" className="btn ghost" disabled={!!busy} onClick={() => void remove()}>Delete draft</button>}
        <span className="sp" />
        <button type="button" className="btn secondary" onClick={onClose}>Close</button>
        {editing && dirty && <button type="button" className="btn" disabled={!!busy} onClick={() => void save()}>{busy === "save" ? "Saving" : "Save draft"}</button>}
      </>}>
      <div className="dmeta" style={{ marginBottom: 12 }}>
        <span><Matter title={d.title} propertyId={d.propertyId} /></span>
        {d.appeal && <span>{d.appeal}</span>}
        <InvoiceStatus r={d} />
        {d.issuedOn && <span>Issued {formatDate(d.issuedOn)}</span>}
        {d.dueOn && <span>Due {formatDate(d.dueOn)}</span>}
      </div>
      {d.voidReason && <div className="notice-box">Void: {d.voidReason}</div>}
      {notice && <div className="ok" role="status">{notice}</div>}
      {error && <div className="error" role="alert">{error}</div>}

      <div className="tw">
        <table className="compact">
          <thead><tr><th>Description</th><th className="num">Amount</th>{editing && <th />}</tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.id ?? `n${i}`}>
                <td>{editing ? <input className="in" aria-label="Line description" value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} /> : l.description}</td>
                <td className="num" style={{ width: 150 }}>{editing && (l.kind === "other" || can("fees.edit")) ? <MoneyInput money aria-label="Line amount" value={l.amount} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: v } : x)))} /> : formatMoney(l.amount)}</td>
                {editing && <td style={{ width: 40 }}>{l.kind === "other" && <button type="button" className="btn small ghost" aria-label="Remove line" onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</button>}</td>}
              </tr>
            ))}
            <tr><td><b>Total</b></td><td className="num"><b>{formatMoney(editing ? total.toFixed(2) : d.total)}</b></td>{editing && <td />}</tr>
          </tbody>
        </table>
      </div>
      {editing && <button type="button" className="lk" onClick={() => setLines([...lines, { kind: "other", description: "", amount: null }])}>+ Add a line</button>}
      {editing ? (
        <div className="fld" style={{ marginTop: 10 }}><label htmlFor="inv-note">Note on the invoice</label><textarea id="inv-note" className="in" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></div>
      ) : d.note && <p className="muted">{d.note}</p>}

      {canSend && (d.status === "draft" || (d.status === "sent" && !d.statement)) && (
        <div className="blk" style={{ marginTop: 14 }}>
          <h5>{d.status === "draft" ? "Send" : "Send again"}</h5>
          <div className="fld"><label htmlFor="inv-to">To</label><input id="inv-to" className="in" value={to} onChange={(e) => setTo(e.target.value)} placeholder="billing@client.com" /></div>
          {!d.suggestedTo.length && <p className="meta">No billing email on file. Add a Billing contact on the client, or type an address.</p>}
          <label className="check" style={{ margin: "8px 0" }}><input type="checkbox" checked={useEmail} onChange={(e) => setUseEmail(e.target.checked)} /> Email it with the PDF attached</label>
          {!emailOn && useEmail && <p className="meta">Email isn't set up on this server yet, so the invoice will be marked sent and you can copy its pay link.</p>}
          <button type="button" className="btn copper" disabled={!!busy || dirty} onClick={() => void send()}>
            {busy === "send" ? "Sending" : d.status === "draft" ? (useEmail ? "Send invoice" : "Mark sent") : "Send again"}
          </button>
          {dirty && <span className="meta"> Save the draft first.</span>}
          {d.status === "draft" && <p className="meta">Sending gives the invoice its number and moves the appeal to Invoice sent.</p>}
        </div>
      )}

      {d.status !== "draft" && d.status !== "void" && (
        <div className="grid g-2" style={{ marginTop: 14 }}>
          {d.status === "sent" && !d.statement && canSend
            ? <PayLink key={sentLink} url={`/api/firm/billing/invoices/${d.id}/pdf`} onLink={async () => sentLink || (await api<{ link: string }>(`/firm/billing/invoices/${d.id}/link`, { method: "POST", body: {} })).link} />
            : <div className="blk"><h5>PDF</h5><a className="btn small ghost" href={`/api/firm/billing/invoices/${d.id}/pdf`} target="_blank" rel="noreferrer">Download PDF</a></div>}
          <Payments rows={d.payments} />
        </div>
      )}
      {d.statement && d.status === "sent" && <p className="meta">This invoice is on statement {d.statement.number}. Payment goes through the statement.</p>}

      {d.status === "sent" && canSend && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
          {d.payable && <RecordPayment total={d.total} today={d.today} path={`/firm/billing/invoices/${d.id}/payments`} onDone={done} />}
          {d.payable && d.savedMethod && <ChargeSaved label={d.savedMethod} total={d.total} path={`/firm/billing/invoices/${d.id}/charge`} onDone={done} />}
          {can("invoices.void") && !d.statement && d.paymentStatus !== "processing" && <VoidBox path={`/firm/billing/invoices/${d.id}/void`} what="invoice" onDone={done} />}
        </div>
      )}
      {d.blockedReason && d.status === "sent" && !d.statement && <p className="meta">{d.blockedReason}</p>}

      {d.emails.length > 0 && (
        <div className="blk" style={{ marginTop: 14 }}>
          <h5>Emails</h5>
          <ul className="tl">
            {d.emails.map((e, i) => <li key={i}><span className="k">{formatDateTime(e.created_at)}</span><span>{e.to_addresses.join(", ")} · {e.status === "sent" ? "sent" : e.status === "not_configured" ? "not sent (email not set up)" : "failed"}</span></li>)}
          </ul>
        </div>
      )}
    </Sheet>
  );
}

export function StatementSheet({ statementId, onClose, onChanged, onOpenInvoice }: { statementId: number; onClose: () => void; onChanged: () => void; onOpenInvoice?: (id: number) => void }) {
  const { can } = useSession();
  const canSend = can("invoices.send");
  const [d, setD] = useState<StatementDetail | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    try { setD(await api<StatementDetail>(`/firm/billing/statements/${statementId}`)); } catch (e) { setError(errorText(e)); }
  }, [statementId]);
  useEffect(() => { void load(); }, [load]);
  const done = (msg: string) => { setNotice(msg); void load(); onChanged(); };
  if (!d) return <Sheet eyebrow="Statement" title="Loading" onClose={onClose}>{error && <div className="error" role="alert">{error}</div>}</Sheet>;
  return (
    <Sheet wide eyebrow={`Statement ${d.number}`} title={d.client} onClose={onClose} footer={<><span className="sp" /><button type="button" className="btn secondary" onClick={onClose}>Close</button></>}>
      <div className="dmeta" style={{ marginBottom: 12 }}>
        <StatementStatus s={d} /><span>Issued {formatDate(d.issuedOn)}</span><span>Due {formatDate(d.dueOn)}</span><span>{d.invoices} invoices</span>
      </div>
      {notice && <div className="ok" role="status">{notice}</div>}
      {error && <div className="error" role="alert">{error}</div>}
      <div className="tw">
        <table className="compact">
          <thead><tr><th>Invoice</th><th>Property</th><th>Appeal</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {d.invoiceList.map((i) => (
              <tr key={i.id} className={onOpenInvoice ? "clickable" : ""} onClick={() => onOpenInvoice?.(i.id)}>
                <td>{i.number}<span className="mn" style={{ display: "block" }}>{i.issuedOn ? formatDate(i.issuedOn) : ""}</span></td>
                <td><Matter title={i.title} propertyId={i.propertyId} /></td><td>{i.appeal ?? "—"}</td><td className="num">{formatMoney(i.total)}</td>
              </tr>
            ))}
            <tr><td colSpan={3}><b>Total</b></td><td className="num"><b>{formatMoney(d.total)}</b></td></tr>
          </tbody>
        </table>
      </div>
      <div className="grid g-2" style={{ marginTop: 14 }}>
        {d.status === "open" && canSend
          ? <PayLink url={`/api/firm/billing/statements/${d.id}/pdf`} onLink={async () => (await api<{ link: string }>(`/firm/billing/statements/${d.id}/link`, { method: "POST", body: {} })).link} />
          : <div className="blk"><h5>PDF</h5><a className="btn small ghost" href={`/api/firm/billing/statements/${d.id}/pdf`} target="_blank" rel="noreferrer">Download PDF</a></div>}
        <Payments rows={d.payments} />
      </div>
      {d.status === "open" && canSend && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
          {d.payable && <RecordPayment total={d.total} today={d.today} path={`/firm/billing/statements/${d.id}/payments`} onDone={done} />}
          {d.payable && d.savedMethod && <ChargeSaved label={d.savedMethod} total={d.total} path={`/firm/billing/statements/${d.id}/charge`} onDone={done} />}
          {can("invoices.void") && d.paymentStatus !== "processing" && <VoidBox path={`/firm/billing/statements/${d.id}/void`} what="statement" onDone={done} />}
        </div>
      )}
      {d.status === "open" && <p className="meta">The invoices on a statement are paid together, through the statement's link. Voiding the statement lets each be paid on its own again; send them again for fresh links.</p>}
    </Sheet>
  );
}

export function CreateStatementSheet({ accountId, client, emailOn, onClose, onCreated }: { accountId: number; client: string; emailOn: boolean; onClose: () => void; onCreated: (id: number, msg: string) => void }) {
  const [rows, setRows] = useState<InvoiceRow[] | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [to, setTo] = useState("");
  const [useEmail, setUseEmail] = useState(emailOn);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ invoices: InvoiceRow[]; suggestedTo: string[] }>(`/firm/billing/accounts/${accountId}/open`).then((r) => {
      setRows(r.invoices);
      setPicked(r.invoices.filter((i) => i.paymentStatus !== "processing").map((i) => i.id));
      setTo(r.suggestedTo.join(", "));
    }).catch((e) => setError(errorText(e)));
  }, [accountId]);
  async function create(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true); setError("");
    try {
      const r = await api<{ statement: StatementRow; emailed: boolean; emailError: string | null }>("/firm/billing/statements", { method: "POST", body: { accountId, invoiceIds: picked, to: parseEmails(to), email: useEmail } });
      onCreated(r.statement.id, r.emailed ? `Statement ${r.statement.number} emailed.` : r.emailError ?? `Statement ${r.statement.number} is ready. Copy its pay link to share it.`);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  const total = (rows ?? []).filter((r) => picked.includes(r.id)).reduce((a, r) => a + Number(r.total), 0);
  return (
    <Sheet wide eyebrow="New statement" title={client} onClose={onClose} onSubmit={() => void create()}
      footer={<>{error && <span className="error" style={{ margin: 0, flexBasis: "100%" }} role="alert">{error}</span>}<span className="sp" /><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn copper" disabled={busy || picked.length < 2}>{busy ? "Sending" : useEmail ? "Send statement" : "Create statement"}</button></>}>
      <p className="muted" style={{ marginTop: 0 }}>A statement gathers this client's unpaid invoices into one bill, paid in full in one payment. The invoices' own pay links stop working.</p>
      {rows && rows.length < 2 && <p className="meta">A statement needs two or more sent, unpaid invoices. This client has {rows.length}.</p>}
      {rows && rows.length > 0 && (
        <div className="tw">
          <table className="compact">
            <thead><tr><th /><th>Invoice</th><th>Property</th><th>Due</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><input type="checkbox" aria-label={`Include ${r.number}`} disabled={r.paymentStatus === "processing"} checked={picked.includes(r.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))} /></td>
                  <td>{r.number}</td><td><Matter title={r.title} propertyId={r.propertyId} /></td><td>{r.dueOn ? formatDate(r.dueOn) : ""}</td><td className="num">{formatMoney(r.total)}</td>
                </tr>
              ))}
              <tr><td colSpan={4}><b>Statement total</b></td><td className="num"><b>{formatMoney(total.toFixed(2))}</b></td></tr>
            </tbody>
          </table>
        </div>
      )}
      <div className="fld" style={{ marginTop: 12 }}><label htmlFor="st-to">To</label><input id="st-to" className="in" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={useEmail} onChange={(e) => setUseEmail(e.target.checked)} /> Email it with the PDF attached</label>
    </Sheet>
  );
}

/** A client's billing on the client page: every invoice and statement, and starting a statement. */
export function ClientBilling({ accountId, client }: { accountId: number; client: string }) {
  const { can } = useSession();
  const [data, setData] = useState<{ invoices: InvoiceRow[]; statements: StatementRow[]; all: InvoiceRow[] } | null>(null);
  const [emailOn, setEmailOn] = useState(false);
  const [open, setOpen] = useState<{ kind: "invoice" | "statement"; id: number } | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    setData(await api(`/firm/billing/accounts/${accountId}/open`));
  }, [accountId]);
  useEffect(() => { void load(); void api<{ emailAvailable: boolean }>("/firm/billing/settings").then((s) => setEmailOn(s.emailAvailable)).catch(() => undefined); }, [load]);
  if (!data) return null;
  return (
    <>
      <div className="tbar">
        <span className="meta">{data.invoices.length} unpaid invoice{data.invoices.length === 1 ? "" : "s"} · {formatMoney(data.invoices.reduce((a, i) => a + Number(i.total), 0).toFixed(2))} outstanding</span>
        <span className="sp" />
        {can("invoices.send") && data.invoices.length >= 2 && <button type="button" className="btn small copper" onClick={() => setCreating(true)}>Create statement</button>}
      </div>
      {notice && <div className="ok" role="status">{notice}</div>}
      <BillingList invoices={data.all} statements={data.statements} onOpen={setOpen} showClient={false} />
      {open?.kind === "invoice" && <InvoiceSheet invoiceId={open.id} emailOn={emailOn} onClose={() => setOpen(null)} onChanged={() => void load()} />}
      {open?.kind === "statement" && <StatementSheet statementId={open.id} onClose={() => setOpen(null)} onChanged={() => void load()} onOpenInvoice={(id) => setOpen({ kind: "invoice", id })} />}
      {creating && <CreateStatementSheet accountId={accountId} client={client} emailOn={emailOn} onClose={() => setCreating(false)} onCreated={(id, msg) => { setCreating(false); setNotice(msg); void load(); setOpen({ kind: "statement", id }); }} />}
    </>
  );
}

/** One property's billing on the property page: anything ready to bill, then its invoices. */
export function PropertyBilling({ propertyId }: { propertyId: number }) {
  const { can } = useSession();
  const [data, setData] = useState<{ invoices: InvoiceRow[]; ready: { appealId: number; year: number; level: string; fee: string; savings: string; description: string }[] } | null>(null);
  const [emailOn, setEmailOn] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => { setData(await api(`/firm/billing/properties/${propertyId}`)); }, [propertyId]);
  useEffect(() => { void load(); void api<{ emailAvailable: boolean }>("/firm/billing/settings").then((s) => setEmailOn(s.emailAvailable)).catch(() => undefined); }, [load]);
  async function draft(appealId: number) {
    setError("");
    try { const r = await api<{ id: number }>(`/firm/billing/appeals/${appealId}/invoice`, { method: "POST", body: {} }); await load(); setOpen(r.id); } catch (e) { setError(errorText(e)); }
  }
  if (!data) return null;
  return (
    <>
      {error && <div className="error" role="alert">{error}</div>}
      {data.ready.map((r) => (
        <div key={r.appealId} className="notice-box copper">
          <span>Ready to bill: {r.description}. Fee {formatMoney(r.fee)}.</span>
          <span className="sp" />
          {can("invoices.send") && <button type="button" className="btn small copper" onClick={() => void draft(r.appealId)}>Draft invoice</button>}
        </div>
      ))}
      <BillingList invoices={data.invoices} statements={[]} onOpen={(x) => setOpen(x.id)} showClient={false} showProperty={false} />
      {open !== null && <InvoiceSheet invoiceId={open} emailOn={emailOn} onClose={() => setOpen(null)} onChanged={() => void load()} />}
    </>
  );
}

export function BillingList({ invoices, statements, onOpen, showClient = true, showProperty = true, empty = "No invoices yet." }: {
  invoices: InvoiceRow[]; statements: StatementRow[]; onOpen: (x: { kind: "invoice" | "statement"; id: number }) => void; showClient?: boolean; showProperty?: boolean; empty?: string;
}) {
  return (
    <div className="tw">
      <table className="compact">
        <thead><tr><th>Number</th>{showClient && <th>Client</th>}{showProperty && <th>Property</th>}<th>Appeal</th><th>Issued</th><th>Due</th><th className="num">Amount</th><th>Status</th></tr></thead>
        <tbody>
          {statements.map((s) => (
            <tr key={`s${s.id}`} className="clickable" tabIndex={0} onClick={() => onOpen({ kind: "statement", id: s.id })} onKeyDown={(e) => { if (e.key === "Enter") onOpen({ kind: "statement", id: s.id }); }}>
              <td>{s.number}<span className="mn" style={{ display: "block" }}>Statement</span></td>
              {showClient && <td>{s.client}</td>}{showProperty && <td>{s.invoices} invoices</td>}<td>—</td>
              <td>{formatDate(s.issuedOn)}</td><td>{formatDate(s.dueOn)}</td><td className="num">{formatMoney(s.total)}</td><td><StatementStatus s={s} /></td>
            </tr>
          ))}
          {invoices.map((r) => (
            <tr key={r.id} className="clickable" tabIndex={0} onClick={() => onOpen({ kind: "invoice", id: r.id })} onKeyDown={(e) => { if (e.key === "Enter") onOpen({ kind: "invoice", id: r.id }); }}>
              <td>{r.number ?? <span className="meta">Draft</span>}</td>
              {showClient && <td>{r.client}</td>}
              {showProperty && <td><Matter title={r.title} propertyId={r.propertyId} /></td>}
              <td>{r.appeal ?? "—"}</td>
              <td>{r.issuedOn ? formatDate(r.issuedOn) : "—"}</td><td>{r.dueOn ? formatDate(r.dueOn) : "—"}</td>
              <td className="num">{formatMoney(r.total)}</td><td><InvoiceStatus r={r} /></td>
            </tr>
          ))}
          {invoices.length + statements.length === 0 && <tr><td colSpan={8} className="meta" style={{ textAlign: "center", padding: 20 }}>{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
