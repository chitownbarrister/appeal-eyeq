// The client's pay page. No sign-in: the link in the email is the key. Shows the bill
// on the firm's letterhead, and pays it in full on Stripe Checkout by bank account or card.

import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "../api";
import { formatDate, formatMoney, splitMatterTitle } from "../format";

interface Bill {
  firm: { name: string; address: string | null; phone: string | null; website: string | null };
  client: string; kind: "invoice" | "statement"; number: string; total: string; dueOn: string | null;
  state: "payable" | "processing" | "paid" | "closed"; message: string | null;
  items: { number: string; matter: string; issuedOn: string; total: string }[];
  payment: { status: string; method: string; amount: string; at: string } | null;
  online: boolean;
}

export function Pay({ token }: { token: string }) {
  const [bill, setBill] = useState<Bill | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "ach" | "card">("");
  const [save, setSave] = useState(false);
  // Read once: the address is tidied right after the first load.
  const [back] = useState(() => new URLSearchParams(window.location.search));
  const returned = back.get("status") === "done";
  const cancelled = back.get("status") === "cancel";

  const load = useCallback(async (search = "") => {
    try { setBill(await api<Bill>(`/pay/${encodeURIComponent(token)}${search}`)); setError(""); } catch (e) { setError(errorText(e)); }
  }, [token]);

  useEffect(() => {
    const session = back.get("session");
    void load(session ? `?session=${encodeURIComponent(session)}` : "");
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  // Just back from paying and not settled yet: check again for a little while.
  useEffect(() => {
    if (!returned || !bill || bill.state !== "payable") return;
    let n = 0;
    const t = setInterval(() => { n += 1; void load(); if (n >= 5) clearInterval(t); }, 2000);
    return () => clearInterval(t);
  }, [returned, bill?.state, load]); // eslint-disable-line react-hooks/exhaustive-deps

  async function pay(method: "ach" | "card") {
    setBusy(method); setError("");
    try {
      const r = await api<{ url: string }>(`/pay/${encodeURIComponent(token)}/checkout`, { method: "POST", body: { method, save } });
      window.location.assign(r.url);
    } catch (e) { setError(errorText(e)); setBusy(""); }
  }

  const what = bill?.kind === "statement" ? "Statement" : "Invoice";
  return (
    <div className="pay-wrap">
      <main className="pay-card card" aria-labelledby="pay-h">
        {!bill && !error && <p className="meta">Loading your bill.</p>}
        {!bill && error && (
          <>
            <h1 id="pay-h">This link doesn't work</h1>
            <p className="muted">{error} If you were sent a newer email or statement, use the link in that one, or contact the firm that billed you.</p>
          </>
        )}
        {bill && (
          <>
            <header className="pay-firm">
              <div className="pay-firm-name">{bill.firm.name}</div>
              <div className="meta">{[bill.firm.address, bill.firm.phone, bill.firm.website].filter(Boolean).join(" · ")}</div>
            </header>
            <div className="eyebrow">{what} {bill.number}</div>
            <h1 id="pay-h">{bill.client}</h1>
            <div className="pay-amount">
              <span className="num">{formatMoney(bill.total)}</span>
              {bill.state === "paid" ? <span className="pill ok">Paid</span> : bill.dueOn && bill.state !== "closed" ? <span className="meta">Due {formatDate(bill.dueOn)}</span> : null}
            </div>

            {bill.state === "paid" && (
              <div className="ok" role="status">
                {returned ? "Thank you. Your payment went through." : "This bill is paid. Thank you."}
                {bill.payment && bill.payment.status === "succeeded" && <> {formatMoney(bill.payment.amount)} by {bill.payment.method === "ach" ? "bank account" : bill.payment.method === "card" ? "card" : bill.payment.method}.</>}
              </div>
            )}
            {bill.state === "processing" && (
              <div className="notice-box" role="status">Your bank payment is on its way. Bank payments take about 3 to 5 business days to arrive; this page shows Paid once it does. There's nothing more to do.</div>
            )}
            {bill.state === "closed" && <div className="notice-box" role="status">{bill.message}</div>}
            {bill.state === "payable" && returned && <div className="notice-box" role="status">Checking on your payment. This takes a moment.</div>}
            {bill.state === "payable" && cancelled && <div className="notice-box" role="status">Payment wasn't completed. You can try again below.</div>}
            {bill.payment?.status === "failed" && bill.state === "payable" && <div className="error" role="alert">The last payment didn't go through. Please try again, or use another method.</div>}

            <table className="compact pay-items">
              <thead><tr><th>{bill.kind === "statement" ? "Invoice" : "For"}</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {bill.items.map((i) => {
                  const t = splitMatterTitle(i.matter);
                  return (
                    <tr key={i.number}>
                      <td>{bill.kind === "statement" && <span className="mt" style={{ display: "block" }}>{i.number}</span>}{t.place}{t.pin && <span className="mn" style={{ display: "block" }}>PIN {t.pin}</span>}</td>
                      <td className="num">{formatMoney(i.total)}</td>
                    </tr>
                  );
                })}
                <tr><td><b>Total</b></td><td className="num"><b>{formatMoney(bill.total)}</b></td></tr>
              </tbody>
            </table>

            {bill.state === "payable" && (bill.online ? (
              <div className="pay-actions">
                <p className="meta" style={{ margin: 0 }}>Pay the full amount. A bank account (ACH) costs the firm less to accept; either is fine.</p>
                <div className="pay-buttons">
                  <button type="button" className="btn" disabled={!!busy} onClick={() => void pay("ach")}>{busy === "ach" ? "Opening" : "Pay by bank account"}</button>
                  <button type="button" className="btn secondary" disabled={!!busy} onClick={() => void pay("card")}>{busy === "card" ? "Opening" : "Pay by card"}</button>
                </div>
                <label className="check"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Save this payment method so {bill.firm.name} can charge it for future bills</label>
              </div>
            ) : (
              <div className="notice-box">Online payment isn't available for this bill yet. Please pay by check, or contact {bill.firm.name}.</div>
            ))}
            {error && <div className="error" role="alert">{error}</div>}

            <footer className="pay-foot">
              <a className="lk" href={`/api/pay/${encodeURIComponent(token)}/pdf`} target="_blank" rel="noreferrer">Download the {what.toLowerCase()} (PDF)</a>
              <span className="meta">Payments are processed by Stripe. Card and bank details never reach {bill.firm.name} or Appeal EyeQ.</span>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
