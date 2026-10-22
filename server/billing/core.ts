// Billing rules shared by the firm's billing routes, the decisions flow and the pay page.
// Every function runs inside the caller's withContext and filters on firm_id.
//
// The firm's rules (spec section 10, Dillon):
//  - One invoice per appeal. Assessor and Board of Review fees are a percent of the
//    first-year tax savings at that level (the savings from the AV going into the level),
//    drafted when a reduction is applied. Nothing reaches a client until someone sends it.
//  - A statement gathers a client's unpaid invoices; once sent, only the statement can be
//    paid, and only in full. Paying it pays each invoice on it.
//  - No partial payments anywhere.
//  - PTAB and Circuit Court fees come out of the refund check (Delivery 9b), so they're never
//    invoiced here.

import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { LEVEL_LABELS, matterTitle, type Level } from "../../shared/domain.js";
import { effectiveFee, firstYearFee, type FeeBasis } from "../../shared/fees.js";
import { centsToString, formatMoney, toCents } from "../../shared/money.js";
import { todayIso } from "../today.js";
import { decryptSecret, encryptSecret, hasEncryptionKey } from "../secrets.js";
import { addExpenseLines } from "./trust.js";

type C = pg.PoolClient;
const err = (status: number, publicMessage: string) => Object.assign(new Error(publicMessage), { status, publicMessage });

// ---------------------------------------------------------------- settings and numbers
export interface BillingSettings {
  invoice_prefix: string; payment_terms_days: number; invoice_note: string | null; reply_to_email: string | null;
  accent_color: string | null; remit_to: string | null;
}

export function initialsOf(name: string): string {
  const i = name.split(/[^A-Za-z]+/).filter(Boolean).map((w) => w[0].toUpperCase()).join("").slice(0, 4);
  return i || "INV";
}

/** The firm's billing settings, created with its initials as the prefix the first time they're needed. */
export async function billingSettings(c: C, firmId: number): Promise<BillingSettings> {
  const row = (await c.query<BillingSettings>(`SELECT invoice_prefix, payment_terms_days, invoice_note, reply_to_email, accent_color, remit_to FROM billing_settings WHERE firm_id = $1`, [firmId])).rows[0];
  if (row) return row;
  const firm = (await c.query<{ name: string }>(`SELECT name FROM firms WHERE id = $1`, [firmId])).rows[0];
  return (await c.query<BillingSettings>(
    `INSERT INTO billing_settings (firm_id, invoice_prefix) VALUES ($1, $2)
     ON CONFLICT (firm_id) DO UPDATE SET firm_id = EXCLUDED.firm_id
     RETURNING invoice_prefix, payment_terms_days, invoice_note, reply_to_email, accent_color, remit_to`,
    [firmId, initialsOf(firm?.name ?? "")],
  )).rows[0];
}

/** NL-2026-0001 for invoices, NL-S-2026-0001 for statements; numbers never repeat within a firm. */
export async function nextNumber(c: C, firmId: number, kind: "invoice" | "statement", onDate = todayIso()): Promise<string> {
  const s = await billingSettings(c, firmId);
  const year = Number(onDate.slice(0, 4));
  const n = (await c.query<{ last_number: number }>(
    `INSERT INTO invoice_counters (firm_id, kind, year, last_number) VALUES ($1, $2, $3, 1)
     ON CONFLICT (firm_id, kind, year) DO UPDATE SET last_number = invoice_counters.last_number + 1
     RETURNING last_number`,
    [firmId, kind, year],
  )).rows[0].last_number;
  return `${s.invoice_prefix}-${kind === "statement" ? "S-" : ""}${year}-${String(n).padStart(4, "0")}`;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- the fee on an appeal
export interface FeeLine { amount: string; description: string; basis: Record<string, unknown> }

/**
 * The fee for a decided Assessor or BOR appeal, or why there isn't one. The client's fee cap
 * applies, and a flat-fee client is billed the flat fee.
 */
/** An appeal with its property's and client's fee terms, and the fee that applies to it. */
export async function feeContext(c: C, firmId: number, appealId: number) {
  const a = (await c.query(
    `SELECT a.*, p.no_fee AS p_no_fee, p.fee_percent_first_year AS p_fy, p.fee_percent_refund AS p_rf,
            ac.no_fee AS a_no_fee, ac.fee_percent_first_year AS a_fy, ac.fee_percent_refund AS a_rf, ac.fee_type, ac.fee_cap, ac.flat_fee
       FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id
       JOIN accounts ac ON ac.firm_id = p.firm_id AND ac.id = p.account_id
      WHERE a.firm_id = $1 AND a.id = $2`,
    [firmId, appealId],
  )).rows[0];
  if (!a) return null;
  const defaults = (await c.query<{ level: Level; percent: string; basis: FeeBasis }>(`SELECT level, percent, basis FROM fee_defaults WHERE firm_id = $1`, [firmId])).rows;
  const eff = effectiveFee(a.level, {
    firmDefaults: defaults,
    account: { fee_percent_first_year: a.a_fy, fee_percent_refund: a.a_rf, no_fee: a.a_no_fee },
    property: { fee_percent_first_year: a.p_fy, fee_percent_refund: a.p_rf, no_fee: a.p_no_fee },
    appeal: { fee_percent: a.fee_percent },
  });
  return { a, eff };
}

export async function feeForAppeal(c: C, firmId: number, appealId: number): Promise<{ fee: FeeLine | null; reason: string | null }> {
  const ctx = await feeContext(c, firmId, appealId);
  if (!ctx) return { fee: null, reason: "Appeal not found." };
  const { a, eff } = ctx;
  if (a.level === "ptab" || a.level === "circuit") return { fee: null, reason: "PTAB and Circuit Court fees come out of the refund check." };
  if (a.status !== "reduced") return { fee: null, reason: "Only a reduction is billed." };
  if (a.billing_skipped_at) return { fee: null, reason: `Marked not billed here${a.billing_skip_reason ? `: ${a.billing_skip_reason}` : ""}.` };
  if (eff.noFee) return { fee: null, reason: "No fee for this property or client." };
  const what = `${LEVEL_LABELS[a.level as Level]} appeal, ${a.assessment_year} assessment year`;
  if (a.fee_type === "flat" && a.flat_fee !== null) {
    return { fee: { amount: centsToString(toCents(a.flat_fee)), description: `${what}: flat fee`, basis: { flat: a.flat_fee } }, reason: null };
  }
  if (a.savings === null || toCents(a.savings) <= 0n) return { fee: null, reason: "No tax savings figured for this appeal yet." };
  let amount = firstYearFee(a.savings, eff)!;
  let capped = false;
  if (a.fee_cap !== null && toCents(amount) > toCents(a.fee_cap)) { amount = centsToString(toCents(a.fee_cap)); capped = true; }
  return {
    fee: {
      amount,
      description: `${what}: ${eff.percent}% of first-year tax savings of ${formatMoney(a.savings)}${capped ? `, capped at ${formatMoney(a.fee_cap)}` : ""}`,
      basis: { savings: a.savings, percent: eff.percent, source: eff.source, cap: capped ? a.fee_cap : null },
    },
    reason: null,
  };
}

/** Recomputes an invoice's total from its lines. */
export async function refreshTotal(c: C, firmId: number, invoiceId: number): Promise<string> {
  return (await c.query<{ total: string }>(
    `UPDATE invoices SET total = COALESCE((SELECT sum(amount) FROM invoice_lines WHERE firm_id = $1 AND invoice_id = $2), 0)
      WHERE firm_id = $1 AND id = $2 RETURNING total`,
    [firmId, invoiceId],
  )).rows[0].total;
}

/** Drafts the invoice for a decided appeal. Returns its id, or null (with why) when there's nothing to bill or one exists. */
export async function draftInvoice(c: C, firmId: number, userId: number | null, appealId: number): Promise<{ id: number | null; reason: string | null }> {
  const existing = (await c.query<{ id: number }>(`SELECT id FROM invoices WHERE firm_id = $1 AND appeal_id = $2 AND status <> 'void'`, [firmId, appealId])).rows[0];
  if (existing) return { id: null, reason: "This appeal already has an invoice." };
  const { fee, reason } = await feeForAppeal(c, firmId, appealId);
  if (!fee) return { id: null, reason };
  const a = (await c.query<{ property_id: number; account_id: number }>(
    `SELECT a.property_id, p.account_id FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id WHERE a.firm_id = $1 AND a.id = $2`, [firmId, appealId],
  )).rows[0];
  const inv = (await c.query<{ id: number }>(
    `INSERT INTO invoices (firm_id, account_id, property_id, appeal_id, status, fee_basis, created_by) VALUES ($1, $2, $3, $4, 'draft', $5, $6) RETURNING id`,
    [firmId, a.account_id, a.property_id, appealId, JSON.stringify(fee.basis), userId],
  )).rows[0];
  await c.query(`INSERT INTO invoice_lines (firm_id, invoice_id, kind, description, amount, position) VALUES ($1, $2, 'fee', $3, $4, 0)`, [firmId, inv.id, fee.description, fee.amount]);
  await refreshTotal(c, firmId, inv.id);
  // Expenses fronted on this property, marked to be recovered on an invoice, ride along.
  await addExpenseLines(c, firmId, inv.id);
  return { id: inv.id, reason: null };
}

/** An invoice for a property's open "recover on an invoice" expenses alone (no fee). */
export async function draftExpenseInvoice(c: C, firmId: number, userId: number | null, propertyId: number): Promise<number> {
  const p = (await c.query<{ account_id: number }>(`SELECT account_id FROM properties WHERE firm_id = $1 AND id = $2`, [firmId, propertyId])).rows[0];
  if (!p) throw err(404, "Property not found.");
  const inv = (await c.query<{ id: number }>(
    `INSERT INTO invoices (firm_id, account_id, property_id, status, created_by) VALUES ($1, $2, $3, 'draft', $4) RETURNING id`, [firmId, p.account_id, propertyId, userId],
  )).rows[0];
  const n = await addExpenseLines(c, firmId, inv.id);
  if (!n) {
    await c.query(`DELETE FROM invoices WHERE firm_id = $1 AND id = $2`, [firmId, inv.id]);
    throw err(409, "This property has no open expenses to invoice.");
  }
  return inv.id;
}

/**
 * Decided Assessor and BOR reductions that would be billed but have no tax savings figured,
 * with what's missing, so a real reduction never drops out of sight.
 */
export async function needsTaxFigures(c: C, firmId: number) {
  const rows = (await c.query(
    `SELECT a.id, a.assessment_year, a.level, a.decision_on, a.orig_av, a.resolved_av, a.equalizer, a.tax_rate_percent, a.property_id,
            p.tax_code, p.address1, p.name, p.city, t.name AS township, ac.id AS account_id, ac.name AS client, ac.fee_type, ac.flat_fee,
            (SELECT x.pin FROM parcels x WHERE x.firm_id = p.firm_id AND x.property_id = p.id ORDER BY x.is_primary DESC, x.id LIMIT 1) AS pin
       FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id
       JOIN accounts ac ON ac.firm_id = p.firm_id AND ac.id = p.account_id LEFT JOIN townships t ON t.id = p.township_id
      WHERE a.firm_id = $1 AND a.level IN ('assessor', 'bor') AND a.status = 'reduced' AND (a.savings IS NULL OR a.savings <= 0)
        AND a.billing_skipped_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.firm_id = a.firm_id AND i.appeal_id = a.id AND i.status <> 'void')
      ORDER BY a.assessment_year DESC, a.decision_on DESC NULLS LAST, a.id`,
    [firmId],
  )).rows;
  const out = [];
  for (const r of rows) {
    if (r.fee_type === "flat" && r.flat_fee !== null) continue; // a flat fee doesn't need the tax math, so it's already in Ready to bill
    const ctx = await feeContext(c, firmId, r.id);
    if (!ctx || ctx.eff.noFee) continue;
    const missing = [
      !r.tax_code && "tax code", r.equalizer === null && "equalizer", r.tax_rate_percent === null && "tax rate",
      r.orig_av === null && "AV going in", r.resolved_av === null && "decided AV",
    ].filter(Boolean) as string[];
    out.push({
      appealId: r.id, year: r.assessment_year, level: r.level, decisionOn: r.decision_on, propertyId: r.property_id, accountId: r.account_id, client: r.client,
      title: matterTitle(r.pin, r.address1 || r.name, r.city, r.township), missing: missing.length ? missing : ["tax savings"],
    });
  }
  return out;
}

/** Decided Assessor and BOR reductions with a fee and no invoice yet. */
export async function readyToBill(c: C, firmId: number) {
  const rows = (await c.query<{ id: number }>(
    `SELECT a.id FROM appeals a
      WHERE a.firm_id = $1 AND a.level IN ('assessor', 'bor') AND a.status = 'reduced' AND a.billing_skipped_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.firm_id = a.firm_id AND i.appeal_id = a.id AND i.status <> 'void')
      ORDER BY a.decision_on DESC NULLS LAST, a.id`,
    [firmId],
  )).rows;
  const out = [];
  for (const r of rows) {
    const { fee } = await feeForAppeal(c, firmId, r.id);
    if (!fee) continue;
    const d = (await c.query(
      `SELECT a.id, a.assessment_year, a.level, a.decision_on, a.savings, a.property_id, p.address1, p.name, p.city, t.name AS township, ac.id AS account_id, ac.name AS client,
              (SELECT x.pin FROM parcels x WHERE x.firm_id = p.firm_id AND x.property_id = p.id ORDER BY x.is_primary DESC, x.id LIMIT 1) AS pin
         FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id
         JOIN accounts ac ON ac.firm_id = p.firm_id AND ac.id = p.account_id LEFT JOIN townships t ON t.id = p.township_id
        WHERE a.firm_id = $1 AND a.id = $2`,
      [firmId, r.id],
    )).rows[0];
    out.push({
      appealId: d.id, year: d.assessment_year, level: d.level, decisionOn: d.decision_on, savings: d.savings, fee: fee.amount, description: fee.description,
      propertyId: d.property_id, accountId: d.account_id, client: d.client, title: matterTitle(d.pin, d.address1 || d.name, d.city, d.township),
    });
  }
  return out;
}

// ---------------------------------------------------------------- who gets the bill
/** Billing contacts' emails for the client (and this property), else the primary contact, else the client's own email. */
export async function billingRecipients(c: C, firmId: number, accountId: number, propertyId: number | null): Promise<string[]> {
  const rows = (await c.query<{ email: string; role: string }>(
    `SELECT email, role FROM contacts WHERE firm_id = $1 AND email IS NOT NULL AND email <> ''
        AND (account_id = $2 OR property_id = $3)`,
    [firmId, accountId, propertyId],
  )).rows;
  const billing = rows.filter((r) => r.role === "billing").map((r) => r.email);
  if (billing.length) return [...new Set(billing)];
  const primary = rows.filter((r) => r.role === "primary").map((r) => r.email);
  if (primary.length) return [...new Set(primary)];
  const acct = (await c.query<{ email: string | null }>(`SELECT email FROM accounts WHERE firm_id = $1 AND id = $2`, [firmId, accountId])).rows[0];
  return acct?.email ? [acct.email] : [];
}

// ---------------------------------------------------------------- pay links
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/** A fresh pay link for an invoice or statement; any earlier link for it stops working. */
export async function newPayLink(c: C, firmId: number, target: { invoiceId?: number; statementId?: number }): Promise<string> {
  const col = target.invoiceId ? "invoice_id" : "statement_id";
  const id = target.invoiceId ?? target.statementId!;
  await c.query(`UPDATE pay_links SET revoked_at = now() WHERE firm_id = $1 AND ${col} = $2 AND revoked_at IS NULL`, [firmId, id]);
  const token = randomBytes(32).toString("base64url");
  await c.query(
    `INSERT INTO pay_links (token_hash, firm_id, invoice_id, statement_id, token_enc) VALUES ($1, $2, $3, $4, $5)`,
    [hashToken(token), firmId, target.invoiceId ?? null, target.statementId ?? null, hasEncryptionKey() ? encryptSecret(token) : null],
  );
  return token;
}

/** The live pay link for an invoice or statement, if there is one and it can be shown again. */
export async function currentPayLink(c: C, firmId: number, target: { invoiceId?: number; statementId?: number }): Promise<string | null> {
  const col = target.invoiceId ? "invoice_id" : "statement_id";
  const row = (await c.query<{ token_enc: string | null }>(
    `SELECT token_enc FROM pay_links WHERE firm_id = $1 AND ${col} = $2 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [firmId, target.invoiceId ?? target.statementId],
  )).rows[0];
  if (!row?.token_enc) return null;
  try { return decryptSecret(row.token_enc); } catch { return null; }
}

export async function revokeLinks(c: C, firmId: number, target: { invoiceIds?: number[]; statementId?: number }): Promise<void> {
  if (target.invoiceIds?.length) await c.query(`UPDATE pay_links SET revoked_at = now() WHERE firm_id = $1 AND invoice_id = ANY($2::int[]) AND revoked_at IS NULL`, [firmId, target.invoiceIds]);
  if (target.statementId) await c.query(`UPDATE pay_links SET revoked_at = now() WHERE firm_id = $1 AND statement_id = $2 AND revoked_at IS NULL`, [firmId, target.statementId]);
}

export const payUrl = (token: string) => `${(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "")}/pay/${token}`;

// ---------------------------------------------------------------- sending
/** Gives a draft its number and dates and marks it sent; the appeal moves to Invoice sent. */
export async function markInvoiceSent(c: C, firmId: number, invoiceId: number, to: string[]): Promise<void> {
  const inv = (await c.query(`SELECT * FROM invoices WHERE firm_id = $1 AND id = $2 FOR UPDATE`, [firmId, invoiceId])).rows[0];
  if (!inv) throw err(404, "Invoice not found.");
  if (inv.status === "void" || inv.status === "paid") throw err(409, `This invoice is ${inv.status}.`);
  if (toCents(inv.total) <= 0n) throw err(400, "The invoice total is $0.00. Add a line or delete the draft.");
  if (inv.status === "draft") {
    const s = await billingSettings(c, firmId);
    const today = todayIso();
    const number = await nextNumber(c, firmId, "invoice", today);
    await c.query(
      `UPDATE invoices SET status = 'sent', number = $3, issued_on = $4, due_on = $5, sent_at = now(), sent_to = $6 WHERE firm_id = $1 AND id = $2`,
      [firmId, invoiceId, number, today, addDays(today, s.payment_terms_days), to],
    );
    if (inv.appeal_id) {
      await c.query(
        `UPDATE appeals SET substage = 'invoice_sent', substage_since = now() WHERE firm_id = $1 AND id = $2 AND substage NOT IN ('invoice_sent', 'pushed_next_level', 'closed')`,
        [firmId, inv.appeal_id],
      );
    }
  } else {
    await c.query(`UPDATE invoices SET sent_at = now(), sent_to = $3 WHERE firm_id = $1 AND id = $2`, [firmId, invoiceId, to]);
  }
}

// ---------------------------------------------------------------- what's owed and paying it
export interface Payable {
  kind: "invoice" | "statement"; id: number; accountId: number; number: string; total: string; status: string;
  invoiceIds: number[]; blockedReason: string | null;
}

/** An invoice or statement as something to pay, with why it can't be paid right now. */
export async function payable(c: C, firmId: number, target: { invoiceId?: number; statementId?: number }): Promise<Payable | null> {
  if (target.invoiceId) {
    const i = (await c.query(`SELECT i.*, s.status AS statement_status FROM invoices i LEFT JOIN statements s ON s.firm_id = i.firm_id AND s.id = i.statement_id WHERE i.firm_id = $1 AND i.id = $2`, [firmId, target.invoiceId])).rows[0];
    if (!i) return null;
    const processing = (await c.query(`SELECT 1 FROM payments WHERE firm_id = $1 AND invoice_id = $2 AND status = 'processing'`, [firmId, i.id])).rowCount;
    const blocked = i.status === "paid" ? "This invoice is paid." : i.status !== "sent" ? `This invoice is ${i.status === "draft" ? "not sent yet" : "void"}.`
      : i.statement_status === "open" ? "This invoice is on a statement; pay the statement." : processing ? "A payment for this invoice is processing." : null;
    return { kind: "invoice", id: i.id, accountId: i.account_id, number: i.number ?? "Draft", total: i.total, status: i.status, invoiceIds: [i.id], blockedReason: blocked };
  }
  const s = (await c.query(`SELECT * FROM statements WHERE firm_id = $1 AND id = $2`, [firmId, target.statementId])).rows[0];
  if (!s) return null;
  const ids = (await c.query<{ id: number }>(`SELECT id FROM invoices WHERE firm_id = $1 AND statement_id = $2`, [firmId, s.id])).rows.map((r) => r.id);
  const processing = (await c.query(`SELECT 1 FROM payments WHERE firm_id = $1 AND statement_id = $2 AND status = 'processing'`, [firmId, s.id])).rowCount;
  const blocked = s.status === "paid" ? "This statement is paid." : s.status === "void" ? "This statement is void." : processing ? "A payment for this statement is processing." : null;
  return { kind: "statement", id: s.id, accountId: s.account_id, number: s.number, total: s.total, status: s.status, invoiceIds: ids, blockedReason: blocked };
}

/** Settles a succeeded payment: the invoice (or the statement and every invoice on it) is paid, and pay links stop working. */
export async function settlePayment(c: C, firmId: number, paymentId: number): Promise<void> {
  const p = (await c.query(`SELECT * FROM payments WHERE firm_id = $1 AND id = $2 FOR UPDATE`, [firmId, paymentId])).rows[0];
  if (!p || p.status !== "succeeded") return;
  if (p.invoice_id) {
    const i = (await c.query(`SELECT total FROM invoices WHERE firm_id = $1 AND id = $2`, [firmId, p.invoice_id])).rows[0];
    await c.query(`INSERT INTO payment_allocations (firm_id, payment_id, invoice_id, amount) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [firmId, p.id, p.invoice_id, i.total]);
    await c.query(`UPDATE invoices SET status = 'paid', paid_at = COALESCE(paid_at, now()) WHERE firm_id = $1 AND id = $2`, [firmId, p.invoice_id]);
    await revokeLinks(c, firmId, { invoiceIds: [p.invoice_id] });
  } else {
    const invs = (await c.query<{ id: number; total: string }>(`SELECT id, total FROM invoices WHERE firm_id = $1 AND statement_id = $2`, [firmId, p.statement_id])).rows;
    for (const i of invs) {
      await c.query(`INSERT INTO payment_allocations (firm_id, payment_id, invoice_id, amount) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [firmId, p.id, i.id, i.total]);
    }
    await c.query(`UPDATE invoices SET status = 'paid', paid_at = COALESCE(paid_at, now()) WHERE firm_id = $1 AND statement_id = $2`, [firmId, p.statement_id]);
    await c.query(`UPDATE statements SET status = 'paid', paid_at = COALESCE(paid_at, now()) WHERE firm_id = $1 AND id = $2`, [firmId, p.statement_id]);
    await revokeLinks(c, firmId, { statementId: p.statement_id, invoiceIds: invs.map((i) => i.id) });
  }
}

/** Records a payment for exactly what's owed (never partial). Settles it now when it already succeeded. */
export async function recordPayment(
  c: C, firmId: number,
  p: { target: { invoiceId?: number; statementId?: number }; amount: string; method: "card" | "ach" | "check" | "other"; status: "processing" | "succeeded";
       receivedOn?: string | null; checkNumber?: string | null; reference?: string | null; session?: string | null; intent?: string | null; userId?: number | null },
): Promise<number> {
  const due = await payable(c, firmId, p.target);
  if (!due) throw err(404, "Invoice or statement not found.");
  if (due.blockedReason) throw err(409, due.blockedReason);
  if (toCents(p.amount) !== toCents(due.total)) throw err(400, `Payments are for the full amount, ${formatMoney(due.total)}. Partial payments aren't accepted.`);
  const id = (await c.query<{ id: number }>(
    `INSERT INTO payments (firm_id, account_id, invoice_id, statement_id, amount, method, status, received_on, check_number, reference, stripe_checkout_session, stripe_payment_intent, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    [firmId, due.accountId, p.target.invoiceId ?? null, p.target.statementId ?? null, due.total, p.method, p.status, p.receivedOn ?? (p.status === "succeeded" ? todayIso() : null),
      p.checkNumber ?? null, p.reference ?? null, p.session ?? null, p.intent ?? null, p.userId ?? null],
  )).rows[0].id;
  if (p.status === "succeeded") await settlePayment(c, firmId, id);
  return id;
}
