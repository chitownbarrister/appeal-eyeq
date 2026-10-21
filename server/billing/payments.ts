// Online payments on the firm's own Stripe account: Checkout for the pay page, a charge to a
// saved card or bank account, and settling what Stripe reports (webhooks, or a check on return
// from Checkout). Card payments settle at once; ACH shows Processing for a few business days
// and settles when Stripe says the money arrived.

import type pg from "pg";
import { withContext, type DbContext } from "../db.js";
import { formatMoney, toCents } from "../../shared/money.js";
import { stripe, StripeError } from "./stripe.js";
import { payable, recordPayment, settlePayment, type Payable } from "./core.js";

const sys = (firmId: number): DbContext => ({ actorKind: "system", userId: null, firmId });
const err = (status: number, publicMessage: string) => Object.assign(new Error(publicMessage), { status, publicMessage });

export interface FirmStripe { stripe_account_id: string; charges_enabled: boolean }

export async function firmStripe(c: pg.PoolClient, firmId: number): Promise<FirmStripe | null> {
  return (await c.query<FirmStripe>(`SELECT stripe_account_id, charges_enabled FROM stripe_accounts WHERE firm_id = $1`, [firmId])).rows[0] ?? null;
}

/** The client's customer on the firm's Stripe account, created the first time it's needed. */
export async function ensureCustomer(ctx: DbContext, firmId: number, accountId: number, acct: string): Promise<string> {
  const have = await withContext(ctx, async (c) => (await c.query<{ stripe_customer_id: string }>(
    `SELECT stripe_customer_id FROM stripe_customers WHERE firm_id = $1 AND account_id = $2 AND stripe_account_id = $3`, [firmId, accountId, acct],
  )).rows[0]);
  if (have) return have.stripe_customer_id;
  const a = await withContext(ctx, async (c) => (await c.query<{ name: string; email: string | null }>(`SELECT name, email FROM accounts WHERE firm_id = $1 AND id = $2`, [firmId, accountId])).rows[0]);
  const cust = await stripe<{ id: string }>("POST", "/v1/customers", { name: a.name, email: a.email ?? undefined, metadata: { firm_id: firmId, account_id: accountId } }, acct, `cust-${firmId}-${accountId}-${acct}`);
  await withContext(ctx, (c) => c.query(
    `INSERT INTO stripe_customers (firm_id, account_id, stripe_account_id, stripe_customer_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (firm_id, account_id, stripe_account_id) DO NOTHING`,
    [firmId, accountId, acct, cust.id],
  ));
  return cust.id;
}

const targetMeta = (p: Payable) => (p.kind === "invoice" ? { invoice_id: p.id } : { statement_id: p.id });

/** A Stripe Checkout page for paying an invoice or statement in full, by card or by bank account. */
export async function createCheckout(firmId: number, p: Payable, method: "card" | "ach", save: boolean, token: string, base: string): Promise<string> {
  const ctx = sys(firmId);
  const acct = await withContext(ctx, (c) => firmStripe(c, firmId));
  if (!acct?.charges_enabled) throw err(409, "Online payment isn't available for this firm yet. Please pay by check or contact the firm.");
  const customer = await ensureCustomer(ctx, firmId, p.accountId, acct.stripe_account_id);
  const firm = await withContext(ctx, async (c) => (await c.query<{ name: string; letterhead_name: string | null }>(`SELECT name, letterhead_name FROM firms WHERE id = $1`, [firmId])).rows[0]);
  const meta = { firm_id: firmId, ...targetMeta(p), pay_kind: "checkout" };
  const session = await stripe<{ id: string; url: string }>("POST", "/v1/checkout/sessions", {
    mode: "payment",
    customer,
    payment_method_types: [method === "ach" ? "us_bank_account" : "card"],
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: Number(toCents(p.total)), product_data: { name: `${p.kind === "invoice" ? "Invoice" : "Statement"} ${p.number}`, description: `${firm.letterhead_name || firm.name}` } } }],
    payment_intent_data: { metadata: meta, ...(save ? { setup_future_usage: "off_session" } : {}), description: `${p.kind === "invoice" ? "Invoice" : "Statement"} ${p.number}` },
    metadata: meta,
    success_url: `${base}/pay/${token}?status=done&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/pay/${token}?status=cancel`,
  }, acct.stripe_account_id);
  return session.url;
}

interface Session {
  id: string; payment_status: "paid" | "unpaid" | "no_payment_required"; status: string; amount_total: number; payment_intent: string | null;
  metadata: Record<string, string>; customer: string | null;
}

async function rememberMethod(firmId: number, acct: string, intentId: string): Promise<void> {
  const pi = await stripe<{ setup_future_usage: string | null; customer: string | null; payment_method: { id: string; type: string; card?: { brand: string; last4: string }; us_bank_account?: { bank_name: string | null; last4: string } } | null }>(
    "GET", `/v1/payment_intents/${intentId}`, { expand: ["payment_method"] }, acct,
  );
  if (!pi.setup_future_usage || !pi.payment_method || !pi.customer) return;
  const pm = pi.payment_method;
  const label = pm.type === "card" && pm.card ? `${pm.card.brand.charAt(0).toUpperCase()}${pm.card.brand.slice(1)} ending ${pm.card.last4}`
    : pm.us_bank_account ? `${pm.us_bank_account.bank_name ?? "Bank account"} ending ${pm.us_bank_account.last4}` : "Saved method";
  await withContext(sys(firmId), (c) => c.query(
    `UPDATE stripe_customers SET saved_payment_method = $4, saved_method_label = $5, saved_method_kind = $6 WHERE firm_id = $1 AND stripe_account_id = $2 AND stripe_customer_id = $3`,
    [firmId, acct, pi.customer, pm.id, label, pm.type === "card" ? "card" : "ach"],
  ));
}

/**
 * What a Checkout session says happened, applied once: a payment recorded as Processing (ACH on
 * its way) or Succeeded (settled at once), or Failed. Safe to call again for the same session.
 */
export async function applyCheckoutSession(firmId: number, acct: string, s: Session, outcome: "completed" | "succeeded" | "failed"): Promise<void> {
  const ctx = sys(firmId);
  const target = s.metadata.invoice_id ? { invoiceId: Number(s.metadata.invoice_id) } : s.metadata.statement_id ? { statementId: Number(s.metadata.statement_id) } : null;
  if (!target || Number(s.metadata.firm_id) !== firmId) return;
  const method = await (async () => {
    if (!s.payment_intent) return "card" as const;
    const pi = await stripe<{ payment_method_types: string[] }>("GET", `/v1/payment_intents/${s.payment_intent}`, {}, acct).catch(() => null);
    return pi?.payment_method_types?.includes("us_bank_account") ? ("ach" as const) : ("card" as const);
  })();
  const status = outcome === "failed" ? "failed" : s.payment_status === "paid" || outcome === "succeeded" ? "succeeded" : "processing";
  await withContext(ctx, async (c) => {
    const existing = (await c.query<{ id: number; status: string }>(`SELECT id, status FROM payments WHERE firm_id = $1 AND stripe_checkout_session = $2 FOR UPDATE`, [firmId, s.id])).rows[0];
    if (existing) {
      if (existing.status === status || existing.status === "succeeded") return;
      await c.query(`UPDATE payments SET status = $3, received_on = CASE WHEN $3 = 'succeeded' THEN CURRENT_DATE ELSE received_on END,
                     failure_reason = CASE WHEN $3 = 'failed' THEN 'The bank payment didn''t go through.' ELSE failure_reason END WHERE firm_id = $1 AND id = $2`,
        [firmId, existing.id, status]);
      if (status === "succeeded") await settlePayment(c, firmId, existing.id);
      return;
    }
    if (status === "failed") return;
    const due = await payable(c, firmId, target);
    if (!due) return;
    // Stripe took exactly what was owed when the session was made; record it even if the invoice changed since.
    const amount = (Number(s.amount_total) / 100).toFixed(2);
    if (due.blockedReason || toCents(amount) !== toCents(due.total)) {
      await c.query(
        `INSERT INTO payments (firm_id, account_id, invoice_id, statement_id, amount, method, status, stripe_checkout_session, stripe_payment_intent, failure_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [firmId, due.accountId, target.invoiceId ?? null, target.statementId ?? null, amount, method, status, s.id, s.payment_intent,
          `Received ${formatMoney(amount)} after the bill changed (${due.blockedReason ?? `now ${formatMoney(due.total)}`}). Check it in Stripe.`],
      );
      return;
    }
    await recordPayment(c, firmId, { target, amount, method, status, session: s.id, intent: s.payment_intent });
  });
  if (status !== "failed" && s.payment_intent) await rememberMethod(firmId, acct, s.payment_intent).catch(() => undefined);
}

/** An off-session charge to the client's saved card or bank account, for the full amount. */
export async function chargeSaved(firmId: number, userId: number, target: { invoiceId?: number; statementId?: number }): Promise<{ status: string }> {
  const ctx: DbContext = { actorKind: "system", userId: null, firmId };
  const { due, acct, saved } = await withContext(ctx, async (c) => {
    const due = await payable(c, firmId, target);
    if (!due) throw err(404, "Invoice or statement not found.");
    if (due.blockedReason) throw err(409, due.blockedReason);
    const acct = await firmStripe(c, firmId);
    if (!acct?.charges_enabled) throw err(409, "Connect Stripe in Settings, Billing first.");
    const saved = (await c.query<{ stripe_customer_id: string; saved_payment_method: string | null; saved_method_kind: "card" | "ach" | null }>(
      `SELECT stripe_customer_id, saved_payment_method, saved_method_kind FROM stripe_customers WHERE firm_id = $1 AND account_id = $2 AND stripe_account_id = $3`,
      [firmId, due.accountId, acct.stripe_account_id],
    )).rows[0];
    if (!saved?.saved_payment_method) throw err(409, "This client has no saved card or bank account. Send the pay link instead.");
    return { due, acct, saved };
  });
  let pi: { id: string; status: string };
  try {
    pi = await stripe<{ id: string; status: string }>("POST", "/v1/payment_intents", {
      amount: Number(toCents(due.total)), currency: "usd", customer: saved.stripe_customer_id, payment_method: saved.saved_payment_method,
      payment_method_types: [saved.saved_method_kind === "ach" ? "us_bank_account" : "card"], off_session: true, confirm: true,
      description: `${due.kind === "invoice" ? "Invoice" : "Statement"} ${due.number}`,
      metadata: { firm_id: firmId, ...(due.kind === "invoice" ? { invoice_id: due.id } : { statement_id: due.id }), pay_kind: "saved" },
    }, acct.stripe_account_id, `charge-${firmId}-${due.kind}-${due.id}-${Date.now()}`);
  } catch (e) {
    if (e instanceof StripeError) throw err(402, e.code === "authentication_required" ? "The bank or card needs the client to approve this payment. Send them the pay link instead." : `The charge didn't go through: ${e.message}`);
    throw e;
  }
  const status = pi.status === "succeeded" ? "succeeded" : pi.status === "processing" ? "processing" : "failed";
  if (status === "failed") throw err(402, "The charge didn't go through. Send the client the pay link instead.");
  await withContext(ctx, (c) => recordPayment(c, firmId, { target, amount: due.total, method: saved.saved_method_kind === "ach" ? "ach" : "card", status, intent: pi.id, userId }));
  return { status };
}

/** A saved-method charge Stripe later settled or refused. */
export async function applyIntent(firmId: number, pi: { id: string; metadata: Record<string, string>; last_payment_error?: { message?: string } | null }, outcome: "succeeded" | "failed"): Promise<void> {
  if (pi.metadata?.pay_kind !== "saved" || Number(pi.metadata.firm_id) !== firmId) return;
  await withContext(sys(firmId), async (c) => {
    const p = (await c.query<{ id: number; status: string }>(`SELECT id, status FROM payments WHERE firm_id = $1 AND stripe_payment_intent = $2 FOR UPDATE`, [firmId, pi.id])).rows[0];
    if (!p || p.status !== "processing") return;
    await c.query(`UPDATE payments SET status = $3, received_on = CASE WHEN $3 = 'succeeded' THEN CURRENT_DATE ELSE received_on END, failure_reason = $4 WHERE firm_id = $1 AND id = $2`,
      [firmId, p.id, outcome, outcome === "failed" ? (pi.last_payment_error?.message ?? "The payment didn't go through.").slice(0, 300) : null]);
    if (outcome === "succeeded") await settlePayment(c, firmId, p.id);
  });
}
