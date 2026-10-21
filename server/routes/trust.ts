// Trust, expenses and the accounting export for firm staff (Delivery 9b). Mounted under
// /api/firm after requireFirmContext; every query runs inside withContext and filters on
// firm_id. Support access can look but not change anything (requirePermission refuses it).

import { Router, type Request } from "express";
import type pg from "pg";
import { z } from "zod";
import { withContext } from "../db.js";
import { requirePermission } from "../auth.js";
import { LEVEL_LABELS, matterTitle, type Level } from "../../shared/domain.js";
import { todayIso } from "../today.js";
import { httpError, idParam, hasPermission } from "./files-common.js";
import { billingRecipients, billingSettings } from "../billing/core.js";
import { approve, balances, draftSettlement, expenseRows, ledger, pay, unapprove, updateDraft, voidSettlement } from "../billing/trust.js";
import { settlementPdf } from "../billing/pdf.js";
import { escapeHtml, sendEmail, validEmail } from "../billing/email.js";
import { journal, journalCsv } from "../billing/journal.js";

export const trustRouter = Router();

const money = z.union([z.string(), z.number()]).transform((v) => String(v).replace(/[$,\s]/g, "")).pipe(z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Use an amount with up to 2 decimals"));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Give a date.");

// ---------------------------------------------------------------- settlements
async function settlementRows(c: pg.PoolClient, firmId: number, where: string, params: unknown[]) {
  return (await c.query(
    `SELECT s.id, s.status, s.account_id, s.property_id, s.appeal_id, s.refund_amount, s.refund_received_on, s.fee_amount, s.expenses_amount, s.client_amount,
            s.approved_at, s.paid_on, s.payout_method, s.payout_reference, s.void_reason, ac.name AS client, a.assessment_year, a.level,
            pu.name AS prepared_by, au.name AS approved_by, p.address1, p.name AS pname, p.city, t.name AS township,
            (SELECT x.pin FROM parcels x WHERE x.firm_id = p.firm_id AND x.property_id = p.id ORDER BY x.is_primary DESC, x.id LIMIT 1) AS pin
       FROM trust_settlements s JOIN accounts ac ON ac.firm_id = s.firm_id AND ac.id = s.account_id
       JOIN appeals a ON a.firm_id = s.firm_id AND a.id = s.appeal_id
       JOIN properties p ON p.firm_id = s.firm_id AND p.id = s.property_id LEFT JOIN townships t ON t.id = p.township_id
       LEFT JOIN users pu ON pu.firm_id = s.firm_id AND pu.id = s.prepared_by LEFT JOIN users au ON au.firm_id = s.firm_id AND au.id = s.approved_by
      WHERE s.firm_id = $1 AND ${where}
      ORDER BY s.refund_received_on DESC, s.id DESC LIMIT 300`,
    [firmId, ...params],
  )).rows.map((r) => ({
    id: r.id, status: r.status, accountId: r.account_id, propertyId: r.property_id, appealId: r.appeal_id, client: r.client,
    appeal: `${r.assessment_year} ${LEVEL_LABELS[r.level as Level]}`, title: matterTitle(r.pin, r.address1 || r.pname, r.city, r.township),
    refund: r.refund_amount, receivedOn: r.refund_received_on, fee: r.fee_amount, expenses: r.expenses_amount, toClient: r.client_amount,
    preparedBy: r.prepared_by, approvedBy: r.approved_by, approvedAt: r.approved_at, paidOn: r.paid_on, payoutMethod: r.payout_method, payoutReference: r.payout_reference,
    voidReason: r.void_reason,
  }));
}

trustRouter.get("/trust", async (req, res) => {
  const firmId = req.ctx!.firmId!;
  res.json(await withContext(req.ctx!, async (c) => {
    const draft = await settlementRows(c, firmId, `s.status = 'draft'`, []);
    const approved = await settlementRows(c, firmId, `s.status = 'approved'`, []);
    const paid = await settlementRows(c, firmId, `s.status = 'paid' AND s.paid_on > CURRENT_DATE - 365`, []);
    const bal = await balances(c, firmId);
    const inTrust = bal.reduce((a, b) => a + Number(b.balance), 0).toFixed(2);
    // Refunds received with no live settlement (one was voided): draft again from here.
    const unsettled = (await c.query(
      `SELECT a.id, a.assessment_year, a.level, a.refund_received, a.refund_received_on, ac.name AS client, p.id AS property_id, p.address1, p.name AS pname, p.city, t.name AS township,
              (SELECT x.pin FROM parcels x WHERE x.firm_id = p.firm_id AND x.property_id = p.id ORDER BY x.is_primary DESC, x.id LIMIT 1) AS pin
         FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id JOIN accounts ac ON ac.firm_id = p.firm_id AND ac.id = p.account_id
         LEFT JOIN townships t ON t.id = p.township_id
        WHERE a.firm_id = $1 AND a.refund_status = 'received'
          AND EXISTS (SELECT 1 FROM trust_entries e WHERE e.firm_id = a.firm_id AND e.appeal_id = a.id AND e.kind = 'deposit')
          AND NOT EXISTS (SELECT 1 FROM trust_settlements s WHERE s.firm_id = a.firm_id AND s.appeal_id = a.id AND s.status <> 'void')`,
      [firmId],
    )).rows.map((r) => ({ appealId: r.id, propertyId: r.property_id, client: r.client, appeal: `${r.assessment_year} ${LEVEL_LABELS[r.level as Level]}`, refund: r.refund_received, receivedOn: r.refund_received_on, title: matterTitle(r.pin, r.address1 || r.pname, r.city, r.township) }));
    return { draft, approved, paid, unsettled, balances: bal, inTrust };
  }));
});

function sid(req: Request): number {
  const n = idParam(req);
  if (!n) throw httpError(400, "Invalid settlement.");
  return n;
}

async function detail(c: pg.PoolClient, firmId: number, id: number) {
  const s = (await settlementRows(c, firmId, `s.id = $2`, [id]))[0];
  if (!s) throw httpError(404, "Settlement not found.");
  const raw = (await c.query(`SELECT note, fee_basis FROM trust_settlements WHERE firm_id = $1 AND id = $2`, [firmId, id])).rows[0];
  const included = new Set((await c.query<{ expense_id: number }>(`SELECT expense_id FROM settlement_expenses WHERE firm_id = $1 AND settlement_id = $2`, [firmId, id])).rows.map((r) => r.expense_id));
  const all = await expenseRows(c, firmId, `e.property_id = $2 AND e.recovery = 'refund'`, [s.propertyId]);
  const expenses = all.filter((e) => included.has(e.id) || (s.status === "draft" && e.state === "open")).map((e) => ({ ...e, included: included.has(e.id) }));
  const emails = (await c.query(`SELECT to_addresses, status, error, created_at FROM email_log WHERE firm_id = $1 AND settlement_id = $2 ORDER BY id DESC`, [firmId, id])).rows;
  return { ...s, note: raw.note, feeBasis: raw.fee_basis, expenseList: expenses, emails, suggestedTo: await billingRecipients(c, firmId, s.accountId, s.propertyId), today: todayIso() };
}

trustRouter.get("/trust/settlements/:id", async (req, res) => {
  const id = sid(req);
  res.json(await withContext(req.ctx!, (c) => detail(c, req.ctx!.firmId!, id)));
});

trustRouter.patch("/trust/settlements/:id", requirePermission("invoices.send"), async (req, res) => {
  const id = sid(req);
  const parsed = z.object({ feeAmount: money.optional(), expenseIds: z.array(z.number().int().positive()).max(100).optional(), note: z.string().trim().max(600).nullable().optional() }).strict().safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const canFees = await hasPermission(req, "fees.edit");
  res.json(await withContext(req.ctx!, async (c) => {
    await updateDraft(c, req.ctx!.firmId!, id, parsed.data, canFees);
    return detail(c, req.ctx!.firmId!, id);
  }));
});

trustRouter.post("/trust/settlements/:id/approve", requirePermission("trust.approve"), async (req, res) => {
  const id = sid(req);
  res.json(await withContext(req.ctx!, async (c) => { await approve(c, req.ctx!.firmId!, req.auth!.user.id, id); return detail(c, req.ctx!.firmId!, id); }));
});

trustRouter.post("/trust/settlements/:id/unapprove", requirePermission("trust.approve"), async (req, res) => {
  const id = sid(req);
  res.json(await withContext(req.ctx!, async (c) => { await unapprove(c, req.ctx!.firmId!, id); return detail(c, req.ctx!.firmId!, id); }));
});

trustRouter.post("/trust/settlements/:id/pay", requirePermission("invoices.send"), async (req, res) => {
  const id = sid(req);
  const parsed = z.object({ method: z.enum(["check", "ach"]), reference: z.string().trim().max(120).nullable().optional(), paidOn: isoDate }).strict().safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  if (parsed.data.method === "check" && !parsed.data.reference) throw httpError(400, "Give the check number.");
  res.json(await withContext(req.ctx!, async (c) => {
    await pay(c, req.ctx!.firmId!, req.auth!.user.id, id, { method: parsed.data.method, reference: parsed.data.reference || null, paidOn: parsed.data.paidOn });
    return detail(c, req.ctx!.firmId!, id);
  }));
});

trustRouter.post("/trust/settlements/:id/void", requirePermission("trust.approve"), async (req, res) => {
  const id = sid(req);
  const parsed = z.object({ reason: z.string().trim().min(1, "Say why it's void.").max(300) }).strict().safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  res.json(await withContext(req.ctx!, async (c) => { await voidSettlement(c, req.ctx!.firmId!, id, parsed.data.reason); return detail(c, req.ctx!.firmId!, id); }));
});

/** Drafts a settlement again for a refund in trust whose last settlement was voided. */
trustRouter.post("/trust/appeals/:id/settlement", requirePermission("invoices.send"), async (req, res) => {
  const aid = idParam(req);
  if (!aid) throw httpError(400, "Invalid appeal.");
  const out = await withContext(req.ctx!, async (c) => {
    if (!(await c.query(`SELECT 1 FROM trust_entries WHERE firm_id = $1 AND appeal_id = $2 AND kind = 'deposit'`, [req.ctx!.firmId, aid])).rowCount) throw httpError(409, "No refund is recorded in trust for this appeal.");
    const id = await draftSettlement(c, req.ctx!.firmId!, req.auth!.user.id, aid);
    if (!id) throw httpError(409, "No refund is recorded for this appeal.");
    return detail(c, req.ctx!.firmId!, id);
  });
  res.status(201).json(out);
});

trustRouter.get("/trust/settlements/:id/letter", async (req, res) => {
  const id = sid(req);
  const pdf = await withContext(req.ctx!, async (c) => {
    if (!(await c.query(`SELECT 1 FROM trust_settlements WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id])).rowCount) throw httpError(404, "Settlement not found.");
    return settlementPdf(c, req.ctx!.firmId!, id);
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="settlement-${id}.pdf"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.end(pdf);
});

/** Emails the settlement letter (paid settlements only), with the PDF attached. */
trustRouter.post("/trust/settlements/:id/email", requirePermission("invoices.send"), async (req, res) => {
  const id = sid(req);
  const parsed = z.object({ to: z.array(z.string().trim().toLowerCase()).min(1, "Add at least one email address.").max(10).refine((xs) => xs.every(validEmail), "One of the email addresses isn't valid.") }).strict().safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const firmId = req.ctx!.firmId!;
  const prep = await withContext(req.ctx!, async (c) => {
    const s = (await settlementRows(c, firmId, `s.id = $2`, [id]))[0];
    if (!s) throw httpError(404, "Settlement not found.");
    if (s.status !== "paid") throw httpError(409, "Email the letter once the payout is recorded.");
    const firm = (await c.query(`SELECT name, letterhead_name FROM firms WHERE id = $1`, [firmId])).rows[0];
    const bs = await billingSettings(c, firmId);
    return { s, pdf: await settlementPdf(c, firmId, id), firmName: firm.letterhead_name || firm.name, replyTo: bs.reply_to_email || req.auth!.user.email };
  });
  const subject = `Your ${prep.s.appeal} refund from ${prep.firmName}`;
  const text = [`Dear ${prep.s.client},`, "", `Your refund for ${prep.s.title} arrived and has been paid out to you. The attached letter shows the refund, our fee and any expenses we advanced, and the amount paid to you.`, "", "Thank you,", prep.firmName].join("\n");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#14233f;font-size:14px;line-height:1.5"><p>Dear ${escapeHtml(prep.s.client)},</p><p>Your refund for ${escapeHtml(prep.s.title)} arrived and has been paid out to you. The attached letter shows the refund, our fee and any expenses we advanced, and the amount paid to you.</p><p>Thank you,<br>${escapeHtml(prep.firmName)}</p></div>`;
  let status: "sent" | "failed" | "not_configured" = "sent";
  let providerId: string | null = null;
  let error: string | null = null;
  try {
    providerId = (await sendEmail({ to: parsed.data.to, subject, text, html, replyTo: prep.replyTo, fromName: prep.firmName, attachments: [{ name: `Refund settlement ${prep.s.appeal}.pdf`, content: prep.pdf, contentType: "application/pdf" }] })).id;
  } catch (e) {
    status = (e as { notConfigured?: boolean }).notConfigured ? "not_configured" : "failed";
    error = status === "not_configured" ? "Email isn't set up on this server, so nothing was emailed. Download the letter instead." : "The email didn't go out. Try again, or download the letter.";
  }
  await withContext(req.ctx!, (c) => c.query(
    `INSERT INTO email_log (firm_id, kind, settlement_id, to_addresses, subject, status, provider_id, error, sent_by) VALUES ($1, 'settlement', $2, $3, $4, $5, $6, $7, $8)`,
    [firmId, id, parsed.data.to, subject, status, providerId, error, req.auth!.user.id],
  ));
  res.json({ emailed: status === "sent", emailError: error });
});

trustRouter.get("/trust/accounts/:id", async (req, res) => {
  const aid = idParam(req);
  if (!aid) throw httpError(400, "Invalid client.");
  const firmId = req.ctx!.firmId!;
  res.json(await withContext(req.ctx!, async (c) => {
    const entries = await ledger(c, firmId, aid);
    return { entries, balance: entries.length ? entries[entries.length - 1].balance : "0.00", settlements: await settlementRows(c, firmId, `s.account_id = $2`, [aid]) };
  }));
});

// ---------------------------------------------------------------- expenses
const ExpenseBody = z.object({
  propertyId: z.number().int().positive(),
  appealId: z.number().int().positive().nullable().optional(),
  incurredOn: isoDate,
  vendor: z.string().trim().min(1, "Who was paid?").max(120),
  description: z.string().trim().min(1, "What was it for?").max(300),
  amount: money,
  recovery: z.enum(["refund", "invoice"]),
  receiptDocumentId: z.number().int().positive().nullable().optional(),
}).strict();

async function checkExpenseRefs(c: pg.PoolClient, firmId: number, d: { propertyId: number; appealId?: number | null; receiptDocumentId?: number | null }) {
  const p = (await c.query<{ account_id: number }>(`SELECT account_id FROM properties WHERE firm_id = $1 AND id = $2`, [firmId, d.propertyId])).rows[0];
  if (!p) throw httpError(404, "Property not found.");
  if (d.appealId && !(await c.query(`SELECT 1 FROM appeals WHERE firm_id = $1 AND id = $2 AND property_id = $3`, [firmId, d.appealId, d.propertyId])).rowCount) throw httpError(400, "That appeal isn't on this property.");
  if (d.receiptDocumentId && !(await c.query(`SELECT 1 FROM documents WHERE firm_id = $1 AND id = $2 AND property_id = $3`, [firmId, d.receiptDocumentId, d.propertyId])).rowCount) throw httpError(400, "That file isn't on this property.");
  return p.account_id;
}

trustRouter.get("/expenses", async (req, res) => {
  const firmId = req.ctx!.firmId!;
  const pid = Number(req.query.propertyId) || null;
  const aid = Number(req.query.accountId) || null;
  res.json(await withContext(req.ctx!, async (c) => {
    const rows = pid ? await expenseRows(c, firmId, `e.property_id = $2`, [pid]) : aid ? await expenseRows(c, firmId, `e.account_id = $2`, [aid]) : await expenseRows(c, firmId, `true`, []);
    return { expenses: rows };
  }));
});

trustRouter.post("/expenses", requirePermission("invoices.send"), async (req, res) => {
  const parsed = ExpenseBody.safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  if (parsed.data.incurredOn > todayIso()) throw httpError(400, "The date can't be in the future.");
  if (Number(parsed.data.amount) <= 0) throw httpError(400, "Give the amount paid.");
  const firmId = req.ctx!.firmId!;
  const out = await withContext(req.ctx!, async (c) => {
    const accountId = await checkExpenseRefs(c, firmId, parsed.data);
    const d = parsed.data;
    const id = (await c.query<{ id: number }>(
      `INSERT INTO expenses (firm_id, account_id, property_id, appeal_id, incurred_on, vendor, description, amount, recovery, receipt_document_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [firmId, accountId, d.propertyId, d.appealId ?? null, d.incurredOn, d.vendor, d.description, d.amount, d.recovery, d.receiptDocumentId ?? null, req.auth!.user.id],
    )).rows[0].id;
    return (await expenseRows(c, firmId, `e.id = $2`, [id]))[0];
  });
  res.status(201).json(out);
});

trustRouter.patch("/expenses/:id", requirePermission("invoices.send"), async (req, res) => {
  const id = idParam(req);
  if (!id) throw httpError(400, "Invalid expense.");
  const parsed = ExpenseBody.omit({ propertyId: true }).partial().strict().safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const firmId = req.ctx!.firmId!;
  const out = await withContext(req.ctx!, async (c) => {
    const cur = (await expenseRows(c, firmId, `e.id = $2`, [id]))[0];
    if (!cur) throw httpError(404, "Expense not found.");
    if (cur.state !== "open") throw httpError(409, "This expense is on an invoice or settlement. Take it off there first.");
    const d = parsed.data;
    if (d.incurredOn && d.incurredOn > todayIso()) throw httpError(400, "The date can't be in the future.");
    await checkExpenseRefs(c, firmId, { propertyId: cur.propertyId, appealId: d.appealId, receiptDocumentId: d.receiptDocumentId });
    const map: [string, unknown][] = [];
    if (d.appealId !== undefined) map.push(["appeal_id", d.appealId]);
    if (d.incurredOn) map.push(["incurred_on", d.incurredOn]);
    if (d.vendor) map.push(["vendor", d.vendor]);
    if (d.description) map.push(["description", d.description]);
    if (d.amount) { if (Number(d.amount) <= 0) throw httpError(400, "Give the amount paid."); map.push(["amount", d.amount]); }
    if (d.recovery) map.push(["recovery", d.recovery]);
    if (d.receiptDocumentId !== undefined) map.push(["receipt_document_id", d.receiptDocumentId]);
    if (map.length) await c.query(`UPDATE expenses SET ${map.map(([k], i) => `${k} = $${i + 3}`).join(", ")} WHERE firm_id = $1 AND id = $2`, [firmId, id, ...map.map(([, v]) => v)]);
    return (await expenseRows(c, firmId, `e.id = $2`, [id]))[0];
  });
  res.json(out);
});

trustRouter.delete("/expenses/:id", requirePermission("invoices.send"), async (req, res) => {
  const id = idParam(req);
  if (!id) throw httpError(400, "Invalid expense.");
  await withContext(req.ctx!, async (c) => {
    const cur = (await expenseRows(c, req.ctx!.firmId!, `e.id = $2`, [id]))[0];
    if (!cur) throw httpError(404, "Expense not found.");
    const used = (await c.query(`SELECT 1 FROM invoice_lines WHERE firm_id = $1 AND expense_id = $2 UNION ALL SELECT 1 FROM settlement_expenses WHERE firm_id = $1 AND expense_id = $2`, [req.ctx!.firmId, id])).rowCount;
    if (used) throw httpError(409, cur.state === "open" ? "This expense was on an invoice or settlement that was voided, so it stays in the record. Write it off instead." : "This expense is on an invoice or settlement. Take it off there first.");
    await c.query(`DELETE FROM expenses WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id]);
  });
  res.json({ ok: true });
});

trustRouter.post("/expenses/:id/write-off", requirePermission("invoices.void"), async (req, res) => {
  const id = idParam(req);
  if (!id) throw httpError(400, "Invalid expense.");
  const parsed = z.object({ reason: z.string().trim().min(1, "Say why.").max(300) }).strict().safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const out = await withContext(req.ctx!, async (c) => {
    const cur = (await expenseRows(c, req.ctx!.firmId!, `e.id = $2`, [id]))[0];
    if (!cur) throw httpError(404, "Expense not found.");
    if (cur.state !== "open") throw httpError(409, "Only an open expense can be written off.");
    await c.query(`UPDATE expenses SET written_off_at = now(), written_off_reason = $3 WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id, parsed.data.reason]);
    return (await expenseRows(c, req.ctx!.firmId!, `e.id = $2`, [id]))[0];
  });
  res.json(out);
});

// ---------------------------------------------------------------- accounting export
trustRouter.get("/accounting/export", async (req, res) => {
  const from = typeof req.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : `${todayIso().slice(0, 7)}-01`;
  const to = typeof req.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : todayIso();
  if (from > to) throw httpError(400, "The start date is after the end date.");
  const lines = await withContext(req.ctx!, (c) => journal(c, req.ctx!.firmId!, from, to));
  if (req.query.format === "json") { res.json({ from, to, lines }); return; }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="accounting-journal-${from}-to-${to}.csv"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.end(journalCsv(lines));
});

