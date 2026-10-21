// Refunds into trust and out again (Delivery 9b). Rules from Dillon (Oct 21):
//  - A PTAB or Circuit Court refund check (refund and interest together) is a trust deposit.
//  - The fee comes out of the refund: the appeal's refund-basis fee (33.33% unless the
//    property, client or appeal says otherwise; no-fee, flat fee and the client's cap apply).
//  - Expenses the firm fronted on that property, marked "recover from the refund", come out too.
//  - What's left is the client's, paid by check or ACH, after an attorney (anyone with
//    trust.approve) approves the settlement.
//  - A client's trust balance can never go below zero.
// Every function runs inside the caller's withContext and filters on firm_id.

import type pg from "pg";
import { LEVEL_LABELS, matterTitle, type Level } from "../../shared/domain.js";
import { refundFee } from "../../shared/fees.js";
import { centsToString, formatMoney, toCents } from "../../shared/money.js";
import { todayIso } from "../today.js";
import { feeContext, refreshTotal } from "./core.js";

type C = pg.PoolClient;
const err = (status: number, publicMessage: string) => Object.assign(new Error(publicMessage), { status, publicMessage });

// ---------------------------------------------------------------- expenses
/** Where an expense stands, worked out from what it's attached to. */
export const EXPENSE_STATE_SQL = `CASE
  WHEN e.written_off_at IS NOT NULL THEN 'written_off'
  WHEN EXISTS (SELECT 1 FROM settlement_expenses se JOIN trust_settlements s ON s.firm_id = se.firm_id AND s.id = se.settlement_id
                WHERE se.firm_id = e.firm_id AND se.expense_id = e.id AND s.status = 'paid') THEN 'recovered'
  WHEN EXISTS (SELECT 1 FROM invoice_lines l JOIN invoices i ON i.firm_id = l.firm_id AND i.id = l.invoice_id
                WHERE l.firm_id = e.firm_id AND l.expense_id = e.id AND i.status = 'paid') THEN 'recovered'
  WHEN EXISTS (SELECT 1 FROM settlement_expenses se JOIN trust_settlements s ON s.firm_id = se.firm_id AND s.id = se.settlement_id
                WHERE se.firm_id = e.firm_id AND se.expense_id = e.id AND s.status IN ('draft', 'approved')) THEN 'in_settlement'
  WHEN EXISTS (SELECT 1 FROM invoice_lines l JOIN invoices i ON i.firm_id = l.firm_id AND i.id = l.invoice_id
                WHERE l.firm_id = e.firm_id AND l.expense_id = e.id AND i.status IN ('draft', 'sent')) THEN 'on_invoice'
  ELSE 'open' END`;

export type ExpenseState = "open" | "on_invoice" | "in_settlement" | "recovered" | "written_off";

export async function expenseRows(c: C, firmId: number, where: string, params: unknown[]) {
  return (await c.query(
    `SELECT e.id, e.account_id, e.property_id, e.appeal_id, e.incurred_on, e.vendor, e.description, e.amount, e.recovery, e.receipt_document_id,
            e.written_off_reason, ${EXPENSE_STATE_SQL} AS state, ac.name AS client, a.assessment_year, a.level, d.name AS receipt_name,
            p.address1, p.name AS pname, p.city, t.name AS township,
            (SELECT x.pin FROM parcels x WHERE x.firm_id = p.firm_id AND x.property_id = p.id ORDER BY x.is_primary DESC, x.id LIMIT 1) AS pin
       FROM expenses e JOIN accounts ac ON ac.firm_id = e.firm_id AND ac.id = e.account_id
       JOIN properties p ON p.firm_id = e.firm_id AND p.id = e.property_id LEFT JOIN townships t ON t.id = p.township_id
       LEFT JOIN appeals a ON a.firm_id = e.firm_id AND a.id = e.appeal_id
       LEFT JOIN documents d ON d.firm_id = e.firm_id AND d.id = e.receipt_document_id AND d.property_id = e.property_id
      WHERE e.firm_id = $1 AND ${where}
      ORDER BY e.incurred_on DESC, e.id DESC LIMIT 500`,
    [firmId, ...params],
  )).rows.map((r) => ({
    id: r.id as number, accountId: r.account_id as number, propertyId: r.property_id as number, appealId: r.appeal_id as number | null,
    incurredOn: r.incurred_on as string, vendor: r.vendor as string, description: r.description as string, amount: r.amount as string,
    recovery: r.recovery as "refund" | "invoice", state: r.state as ExpenseState, writtenOffReason: r.written_off_reason as string | null,
    receipt: r.receipt_document_id && r.receipt_name ? { id: r.receipt_document_id as number, name: r.receipt_name as string } : null,
    client: r.client as string, appeal: r.level ? `${r.assessment_year} ${LEVEL_LABELS[r.level as Level]}` : null,
    title: matterTitle(r.pin, r.address1 || r.pname, r.city, r.township),
  }));
}

/** Adds the property's open "recover on an invoice" expenses to a draft invoice. Returns how many. */
export async function addExpenseLines(c: C, firmId: number, invoiceId: number): Promise<number> {
  const inv = (await c.query<{ property_id: number; status: string }>(`SELECT property_id, status FROM invoices WHERE firm_id = $1 AND id = $2`, [firmId, invoiceId])).rows[0];
  if (!inv || inv.status !== "draft") return 0;
  const open = await expenseRows(c, firmId, `e.property_id = $2 AND e.recovery = 'invoice'`, [inv.property_id]);
  const add = open.filter((e) => e.state === "open").reverse();
  let pos = (await c.query<{ n: number }>(`SELECT COALESCE(max(position), 0)::int AS n FROM invoice_lines WHERE firm_id = $1 AND invoice_id = $2`, [firmId, invoiceId])).rows[0].n;
  for (const e of add) {
    pos += 1;
    await c.query(
      `INSERT INTO invoice_lines (firm_id, invoice_id, kind, expense_id, description, amount, position) VALUES ($1, $2, 'expense', $3, $4, $5, $6)`,
      [firmId, invoiceId, e.id, `Expense: ${e.vendor}, ${e.description} (${fmtShort(e.incurredOn)})`.slice(0, 300), e.amount, pos],
    );
  }
  if (add.length) await refreshTotal(c, firmId, invoiceId);
  return add.length;
}

const fmtShort = (iso: string) => {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return `${m}/${d}/${y}`;
};

// ---------------------------------------------------------------- the fee on a refund
export interface RefundFee { amount: string; description: string; basis: Record<string, unknown> }

export async function refundFeeFor(c: C, firmId: number, appealId: number, refund: string): Promise<RefundFee> {
  const ctx = await feeContext(c, firmId, appealId);
  if (!ctx) throw err(404, "Appeal not found.");
  const { a, eff } = ctx;
  const what = `${LEVEL_LABELS[a.level as Level]} appeal, ${a.assessment_year} assessment year`;
  if (eff.noFee) return { amount: "0.00", description: `${what}: no fee`, basis: { noFee: true } };
  if (a.fee_type === "flat" && a.flat_fee !== null) {
    const flat = toCents(a.flat_fee) > toCents(refund) ? toCents(refund) : toCents(a.flat_fee);
    return { amount: centsToString(flat), description: `${what}: flat fee`, basis: { flat: a.flat_fee } };
  }
  let amount = refundFee(refund, eff);
  let capped = false;
  if (a.fee_cap !== null && toCents(amount) > toCents(a.fee_cap)) { amount = centsToString(toCents(a.fee_cap)); capped = true; }
  return {
    amount,
    description: `${what}: ${eff.percent}% of the refund of ${formatMoney(refund)}${capped ? `, capped at ${formatMoney(a.fee_cap)}` : ""}`,
    basis: { refund, percent: eff.percent, source: eff.source, cap: capped ? a.fee_cap : null },
  };
}

// ---------------------------------------------------------------- the ledger
/** A client's trust balance, with the client's row locked so two payouts can't both spend it. */
export async function lockedBalance(c: C, firmId: number, accountId: number): Promise<bigint> {
  await c.query(`SELECT 1 FROM accounts WHERE firm_id = $1 AND id = $2 FOR UPDATE`, [firmId, accountId]);
  const s = (await c.query<{ s: string }>(`SELECT COALESCE(sum(amount), 0)::numeric(14,2) AS s FROM trust_entries WHERE firm_id = $1 AND account_id = $2`, [firmId, accountId])).rows[0].s;
  return toCents(s);
}

export async function balances(c: C, firmId: number) {
  return (await c.query<{ account_id: number; client: string; balance: string; last_on: string }>(
    `SELECT e.account_id, ac.name AS client, sum(e.amount)::numeric(14,2) AS balance, max(e.entry_on) AS last_on
       FROM trust_entries e JOIN accounts ac ON ac.firm_id = e.firm_id AND ac.id = e.account_id
      WHERE e.firm_id = $1 GROUP BY e.account_id, ac.name HAVING sum(e.amount) <> 0 ORDER BY ac.name`,
    [firmId],
  )).rows.map((r) => ({ accountId: r.account_id, client: r.client, balance: r.balance, lastOn: r.last_on }));
}

export async function ledger(c: C, firmId: number, accountId: number) {
  const rows = (await c.query(
    `SELECT e.id, e.kind, e.amount, e.entry_on, e.memo, e.reference, e.settlement_id, e.appeal_id, u.name AS by_name
       FROM trust_entries e LEFT JOIN users u ON u.firm_id = e.firm_id AND u.id = e.created_by
      WHERE e.firm_id = $1 AND e.account_id = $2 ORDER BY e.entry_on, e.id`,
    [firmId, accountId],
  )).rows;
  let run = 0n;
  return rows.map((r) => {
    run += toCents(r.amount);
    return { id: r.id, kind: r.kind, amount: r.amount, entryOn: r.entry_on, memo: r.memo, reference: r.reference, settlementId: r.settlement_id, appealId: r.appeal_id, by: r.by_name, balance: centsToString(run) };
  });
}

// ---------------------------------------------------------------- refund in, settlement drafted
/** The refund check arrived: deposit it to the client's trust ledger and draft the settlement. */
export async function refundReceived(c: C, firmId: number, userId: number | null, appealId: number): Promise<number | null> {
  const a = (await c.query(
    `SELECT a.id, a.level, a.assessment_year, a.refund_status, a.refund_received, a.refund_received_on, p.account_id
       FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id WHERE a.firm_id = $1 AND a.id = $2`,
    [firmId, appealId],
  )).rows[0];
  if (!a || a.refund_status !== "received" || !a.refund_received) return null;
  await c.query(
    `INSERT INTO trust_entries (firm_id, account_id, appeal_id, kind, amount, entry_on, memo, created_by)
     VALUES ($1, $2, $3, 'deposit', $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
    [firmId, a.account_id, appealId, a.refund_received, a.refund_received_on, `Refund check, ${a.assessment_year} ${LEVEL_LABELS[a.level as Level]}`, userId],
  );
  return draftSettlement(c, firmId, userId, appealId);
}

/** Takes a recorded refund back out (it was entered by mistake). Refused once a settlement is approved or paid. */
export async function refundUndone(c: C, firmId: number, appealId: number): Promise<void> {
  const live = (await c.query<{ status: string }>(`SELECT status FROM trust_settlements WHERE firm_id = $1 AND appeal_id = $2 AND status IN ('approved', 'paid')`, [firmId, appealId])).rows[0];
  if (live) throw err(409, `This refund's settlement is ${live.status}. Void the settlement in Billing, Trust first.`);
  await c.query(`DELETE FROM trust_settlements WHERE firm_id = $1 AND appeal_id = $2 AND status = 'draft'`, [firmId, appealId]);
  await c.query(`DELETE FROM trust_entries WHERE firm_id = $1 AND appeal_id = $2 AND kind = 'deposit'`, [firmId, appealId]);
}

/** Drafts the settlement for a received refund: the fee, the fronted expenses that fit, and the client's share. */
export async function draftSettlement(c: C, firmId: number, userId: number | null, appealId: number): Promise<number | null> {
  const live = (await c.query<{ id: number }>(`SELECT id FROM trust_settlements WHERE firm_id = $1 AND appeal_id = $2 AND status <> 'void'`, [firmId, appealId])).rows[0];
  if (live) return live.id;
  const a = (await c.query(
    `SELECT a.id, a.property_id, a.refund_received, a.refund_received_on, a.refund_status, p.account_id
       FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id WHERE a.firm_id = $1 AND a.id = $2`,
    [firmId, appealId],
  )).rows[0];
  if (!a || a.refund_status !== "received" || !a.refund_received) return null;
  const fee = await refundFeeFor(c, firmId, appealId, a.refund_received);
  const refund = toCents(a.refund_received);
  let left = refund - toCents(fee.amount);
  const open = (await expenseRows(c, firmId, `e.property_id = $2 AND e.recovery = 'refund'`, [a.property_id])).filter((e) => e.state === "open").reverse();
  const take: { id: number; amount: string }[] = [];
  for (const e of open) {
    if (toCents(e.amount) <= left) { take.push({ id: e.id, amount: e.amount }); left -= toCents(e.amount); }
  }
  const expensesTotal = take.reduce((s, e) => s + toCents(e.amount), 0n);
  const id = (await c.query<{ id: number }>(
    `INSERT INTO trust_settlements (firm_id, account_id, property_id, appeal_id, refund_amount, refund_received_on, fee_amount, fee_basis, expenses_amount, client_amount, prepared_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [firmId, a.account_id, a.property_id, appealId, a.refund_received, a.refund_received_on, fee.amount, JSON.stringify({ ...fee.basis, description: fee.description }),
      centsToString(expensesTotal), centsToString(refund - toCents(fee.amount) - expensesTotal), userId],
  )).rows[0].id;
  for (const e of take) await c.query(`INSERT INTO settlement_expenses (firm_id, settlement_id, expense_id, amount) VALUES ($1, $2, $3, $4)`, [firmId, id, e.id, e.amount]);
  return id;
}

/** Recomputes a draft's expenses and the client's share; refuses if the fee and expenses would exceed the refund. */
async function rebalance(c: C, firmId: number, id: number): Promise<void> {
  const s = (await c.query(`SELECT refund_amount, fee_amount FROM trust_settlements WHERE firm_id = $1 AND id = $2`, [firmId, id])).rows[0];
  const exp = (await c.query<{ s: string }>(`SELECT COALESCE(sum(amount), 0)::numeric(14,2) AS s FROM settlement_expenses WHERE firm_id = $1 AND settlement_id = $2`, [firmId, id])).rows[0].s;
  const client = toCents(s.refund_amount) - toCents(s.fee_amount) - toCents(exp);
  if (client < 0n) throw err(400, "The fee and expenses can't add up to more than the refund.");
  await c.query(`UPDATE trust_settlements SET expenses_amount = $3, client_amount = $4 WHERE firm_id = $1 AND id = $2`, [firmId, id, exp, centsToString(client)]);
}

export async function updateDraft(c: C, firmId: number, id: number, d: { feeAmount?: string; expenseIds?: number[]; note?: string | null }, canFees: boolean): Promise<void> {
  const s = (await c.query(`SELECT status, property_id, fee_amount, fee_basis FROM trust_settlements WHERE firm_id = $1 AND id = $2 FOR UPDATE`, [firmId, id])).rows[0];
  if (!s) throw err(404, "Settlement not found.");
  if (s.status !== "draft") throw err(409, "Only a draft settlement can be changed. Void it to start over.");
  if (d.note !== undefined) await c.query(`UPDATE trust_settlements SET note = $3 WHERE firm_id = $1 AND id = $2`, [firmId, id, d.note || null]);
  if (d.feeAmount !== undefined && toCents(d.feeAmount) !== toCents(s.fee_amount)) {
    if (!canFees) throw err(403, "Your role doesn't allow changing the fee.");
    await c.query(`UPDATE trust_settlements SET fee_amount = $3, fee_basis = fee_basis || $4::jsonb WHERE firm_id = $1 AND id = $2`,
      [firmId, id, d.feeAmount, JSON.stringify({ overriddenFrom: s.fee_basis?.overriddenFrom ?? s.fee_amount })]);
  }
  if (d.expenseIds) {
    const avail = await expenseRows(c, firmId, `e.property_id = $2 AND e.recovery = 'refund'`, [s.property_id]);
    const mine = new Set((await c.query<{ expense_id: number }>(`SELECT expense_id FROM settlement_expenses WHERE firm_id = $1 AND settlement_id = $2`, [firmId, id])).rows.map((r) => r.expense_id));
    for (const eid of d.expenseIds) {
      const e = avail.find((x) => x.id === eid);
      if (!e || (e.state !== "open" && !mine.has(eid))) throw err(400, "One of those expenses can't go on this settlement.");
    }
    await c.query(`DELETE FROM settlement_expenses WHERE firm_id = $1 AND settlement_id = $2 AND NOT (expense_id = ANY($3::int[]))`, [firmId, id, d.expenseIds]);
    for (const eid of d.expenseIds) {
      if (!mine.has(eid)) await c.query(`INSERT INTO settlement_expenses (firm_id, settlement_id, expense_id, amount) VALUES ($1, $2, $3, $4)`, [firmId, id, eid, avail.find((x) => x.id === eid)!.amount]);
    }
  }
  await rebalance(c, firmId, id);
}

export async function approve(c: C, firmId: number, userId: number, id: number): Promise<void> {
  const s = (await c.query(`SELECT status FROM trust_settlements WHERE firm_id = $1 AND id = $2 FOR UPDATE`, [firmId, id])).rows[0];
  if (!s) throw err(404, "Settlement not found.");
  if (s.status !== "draft") throw err(409, `This settlement is ${s.status}.`);
  await c.query(`UPDATE trust_settlements SET status = 'approved', approved_by = $3, approved_at = now() WHERE firm_id = $1 AND id = $2`, [firmId, id, userId]);
}

/** Back to draft (for a change after approval). Needs trust.approve too. */
export async function unapprove(c: C, firmId: number, id: number): Promise<void> {
  const r = await c.query(`UPDATE trust_settlements SET status = 'draft', approved_by = NULL, approved_at = NULL WHERE firm_id = $1 AND id = $2 AND status = 'approved'`, [firmId, id]);
  if (!r.rowCount) throw err(409, "Only an approved settlement can go back to draft.");
}

/** Records the payout: the fee moves to operating, expenses are reimbursed, and the client is paid. */
export async function pay(c: C, firmId: number, userId: number, id: number, p: { method: "check" | "ach"; reference: string | null; paidOn: string }): Promise<void> {
  const s = (await c.query(`SELECT * FROM trust_settlements WHERE firm_id = $1 AND id = $2 FOR UPDATE`, [firmId, id])).rows[0];
  if (!s) throw err(404, "Settlement not found.");
  if (s.status !== "approved") throw err(409, s.status === "draft" ? "An attorney approves the settlement before it's paid." : `This settlement is ${s.status}.`);
  if (p.paidOn > todayIso()) throw err(400, "The payout date can't be in the future.");
  if (p.paidOn < String(s.refund_received_on).slice(0, 10)) throw err(400, "The payout can't be dated before the refund arrived.");
  const out = toCents(s.fee_amount) + toCents(s.expenses_amount) + toCents(s.client_amount);
  const bal = await lockedBalance(c, firmId, s.account_id);
  if (bal < out) throw err(409, `The client's trust balance is ${formatMoney(centsToString(bal))}, less than this settlement's ${formatMoney(centsToString(out))}.`);
  const entry = async (kind: string, amount: bigint, memo: string, reference: string | null) => {
    if (amount === 0n) return;
    await c.query(
      `INSERT INTO trust_entries (firm_id, account_id, appeal_id, settlement_id, kind, amount, entry_on, memo, reference, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [firmId, s.account_id, s.appeal_id, id, kind, centsToString(-amount), p.paidOn, memo, reference, userId],
    );
  };
  await entry("fee", toCents(s.fee_amount), "Fee earned, to operating", null);
  await entry("expenses", toCents(s.expenses_amount), "Fronted expenses reimbursed", null);
  await entry("payout", toCents(s.client_amount), `Paid to client by ${p.method === "ach" ? "ACH" : "check"}`, p.reference);
  await c.query(
    `UPDATE trust_settlements SET status = 'paid', paid_on = $3, payout_method = $4, payout_reference = $5, paid_by = $6 WHERE firm_id = $1 AND id = $2`,
    [firmId, id, p.paidOn, p.method, p.reference, userId],
  );
}

export async function voidSettlement(c: C, firmId: number, id: number, reason: string): Promise<void> {
  const s = (await c.query(`SELECT status FROM trust_settlements WHERE firm_id = $1 AND id = $2 FOR UPDATE`, [firmId, id])).rows[0];
  if (!s) throw err(404, "Settlement not found.");
  if (s.status === "paid") throw err(409, "A paid settlement can't be voided: the money has left trust.");
  if (s.status === "void") throw err(409, "This settlement is already void.");
  // The voided settlement keeps its figures for the record; its expenses count as open again.
  await c.query(`UPDATE trust_settlements SET status = 'void', void_reason = $3 WHERE firm_id = $1 AND id = $2`, [firmId, id, reason]);
}
