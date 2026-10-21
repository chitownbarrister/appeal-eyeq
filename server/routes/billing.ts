// Billing for firm staff: ready to bill, drafts, sending, statements, payments, settings,
// and connecting the firm's Stripe account. Mounted under /api/firm after
// requireFirmContext; every query runs inside withContext and filters on firm_id.
// Support access can look (read-only) but never send, charge or change anything.

import { Router, type Request } from "express";
import type pg from "pg";
import { z } from "zod";
import { withContext } from "../db.js";
import { requireFirmAdmin, requirePermission } from "../auth.js";
import { LEVEL_LABELS, matterTitle, type Level } from "../../shared/domain.js";
import { centsToString, formatMoney, toCents } from "../../shared/money.js";
import { todayIso } from "../today.js";
import { httpError, idParam, hasPermission } from "./files-common.js";
import {
  addDays, billingRecipients, billingSettings, currentPayLink, draftExpenseInvoice, draftInvoice, markInvoiceSent, needsTaxFigures, newPayLink, nextNumber, payable, payUrl, readyToBill,
  recordPayment, refreshTotal, revokeLinks,
} from "../billing/core.js";
import { invoicePdf, statementPdf } from "../billing/pdf.js";
import { emailConfigured, escapeHtml, sendEmail, validEmail } from "../billing/email.js";
import { chargeSaved, firmStripe } from "../billing/payments.js";
import { addExpenseLines, balances, expenseRows } from "../billing/trust.js";
import { friendlyStripeError, stripe, stripeConfigured, StripeError } from "../billing/stripe.js";

export const billingRouter = Router();

const money = z.union([z.string(), z.number()]).transform((v) => String(v).replace(/[$,\s]/g, "")).pipe(z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Use an amount with up to 2 decimals"));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Give a date.");
const emails = z.array(z.string().trim().toLowerCase()).max(10).refine((xs) => xs.every(validEmail), "One of the email addresses isn't valid.");

const TITLE_SQL = `(SELECT x.pin FROM parcels x WHERE x.firm_id = p.firm_id AND x.property_id = p.id ORDER BY x.is_primary DESC, x.id LIMIT 1) AS pin, p.address1, p.name AS pname, p.city, t.name AS township`;
const title = (r: { pin: string | null; address1: string | null; pname: string; city: string | null; township: string | null }) => matterTitle(r.pin, r.address1 || r.pname, r.city, r.township);

// ---------------------------------------------------------------- the billing page
async function invoiceRows(c: pg.PoolClient, firmId: number, where: string, params: unknown[]) {
  return (await c.query(
    `SELECT i.id, i.number, i.status, i.issued_on, i.due_on, i.total, i.sent_at, i.paid_at, i.statement_id, i.appeal_id, i.property_id, i.account_id,
            ac.name AS client, a.assessment_year, a.level, s.number AS statement_number, s.status AS statement_status, ${TITLE_SQL},
            (SELECT status FROM payments y WHERE y.firm_id = i.firm_id AND (y.invoice_id = i.id OR y.statement_id = i.statement_id) ORDER BY y.id DESC LIMIT 1) AS payment_status
       FROM invoices i JOIN accounts ac ON ac.firm_id = i.firm_id AND ac.id = i.account_id
       JOIN properties p ON p.firm_id = i.firm_id AND p.id = i.property_id LEFT JOIN townships t ON t.id = p.township_id
       LEFT JOIN appeals a ON a.firm_id = i.firm_id AND a.id = i.appeal_id
       LEFT JOIN statements s ON s.firm_id = i.firm_id AND s.id = i.statement_id
      WHERE i.firm_id = $1 AND ${where}
      ORDER BY i.issued_on DESC NULLS FIRST, i.id DESC LIMIT 500`,
    [firmId, ...params],
  )).rows.map((r) => ({
    id: r.id, number: r.number, status: r.status, issuedOn: r.issued_on, dueOn: r.due_on, total: r.total, sentAt: r.sent_at, paidAt: r.paid_at,
    appealId: r.appeal_id, propertyId: r.property_id, accountId: r.account_id, client: r.client, title: title(r),
    appeal: r.level ? `${r.assessment_year} ${LEVEL_LABELS[r.level as Level]}` : null,
    statement: r.statement_id ? { id: r.statement_id, number: r.statement_number, status: r.statement_status } : null,
    paymentStatus: r.payment_status, daysOverdue: r.status === "sent" && r.due_on && r.due_on < todayIso() ? Math.round((Date.parse(todayIso()) - Date.parse(r.due_on)) / 86400000) : 0,
  }));
}

async function statementRows(c: pg.PoolClient, firmId: number, where: string, params: unknown[]) {
  return (await c.query(
    `SELECT s.*, ac.name AS client, (SELECT count(*)::int FROM invoices i WHERE i.firm_id = s.firm_id AND i.statement_id = s.id) AS invoices,
            (SELECT status FROM payments y WHERE y.firm_id = s.firm_id AND y.statement_id = s.id ORDER BY y.id DESC LIMIT 1) AS payment_status
       FROM statements s JOIN accounts ac ON ac.firm_id = s.firm_id AND ac.id = s.account_id
      WHERE s.firm_id = $1 AND ${where} ORDER BY s.issued_on DESC, s.id DESC LIMIT 300`,
    [firmId, ...params],
  )).rows.map((s) => ({ id: s.id, number: s.number, status: s.status, issuedOn: s.issued_on, dueOn: s.due_on, total: s.total, client: s.client, accountId: s.account_id, invoices: s.invoices, paymentStatus: s.payment_status, paidAt: s.paid_at }));
}

billingRouter.get("/billing", async (req, res) => {
  const firmId = req.ctx!.firmId!;
  const out = await withContext(req.ctx!, async (c) => {
    const ready = await readyToBill(c, firmId);
    const needs = await needsTaxFigures(c, firmId);
    const openExpenses = (await expenseRows(c, firmId, `e.written_off_at IS NULL`, [])).filter((e) => e.state === "open");
    const trust = await balances(c, firmId);
    const drafts = await invoiceRows(c, firmId, `i.status = 'draft'`, []);
    const unpaid = await invoiceRows(c, firmId, `i.status = 'sent'`, []);
    const paid = await invoiceRows(c, firmId, `i.status = 'paid' AND i.paid_at > now() - interval '180 days'`, []);
    const statements = await statementRows(c, firmId, `s.status = 'open'`, []);
    const paidStatements = await statementRows(c, firmId, `s.status = 'paid' AND s.paid_at > now() - interval '180 days'`, []);
    const acct = await firmStripe(c, firmId);
    const sum = (xs: { total: string }[]) => centsToString(xs.reduce((a, x) => a + toCents(x.total), 0n));
    const monthStart = `${todayIso().slice(0, 7)}-01`;
    const paidThisMonth = (await c.query<{ s: string }>(`SELECT COALESCE(sum(amount), 0)::numeric(14,2) AS s FROM payments WHERE firm_id = $1 AND status = 'succeeded' AND received_on >= $2`, [firmId, monthStart])).rows[0].s;
    return {
      totals: { ready: sum(ready.map((r) => ({ total: r.fee }))), drafts: sum(drafts), outstanding: sum(unpaid), overdue: sum(unpaid.filter((u) => u.daysOverdue > 0)), paidThisMonth },
      ready, needs, drafts, unpaid, paid, statements, paidStatements, openExpenses,
      inTrust: centsToString(trust.reduce((a, b) => a + toCents(b.balance), 0n)),
      setup: { stripe: Boolean(acct?.charges_enabled), stripeStarted: Boolean(acct), email: emailConfigured() },
    };
  });
  res.json(out);
});

/** Drafts invoices for every decided reduction that's ready (or the appeals listed). */
billingRouter.post("/billing/draft", requirePermission("invoices.send"), async (req, res) => {
  const parsed = z.object({ appealIds: z.array(z.number().int().positive()).max(500).optional() }).strict().safeParse(req.body ?? {});
  if (!parsed.success) throw httpError(400, "Invalid request.");
  const firmId = req.ctx!.firmId!;
  const r = await withContext(req.ctx!, async (c) => {
    const ids = parsed.data.appealIds ?? (await readyToBill(c, firmId)).map((x) => x.appealId);
    const made: number[] = [];
    const skipped: { appealId: number; reason: string }[] = [];
    for (const id of ids) {
      const d = await draftInvoice(c, firmId, req.auth!.user.id, id);
      if (d.id) made.push(d.id); else skipped.push({ appealId: id, reason: d.reason ?? "Nothing to bill." });
    }
    return { drafted: made, skipped };
  });
  res.status(201).json(r);
});

/** Takes decided appeals off Ready to bill (billed in earlier software, or waived), with a reason. */
billingRouter.post("/billing/skip", requirePermission("invoices.send"), async (req, res) => {
  const parsed = z.object({ appealIds: z.array(z.number().int().positive()).min(1).max(500), reason: z.string().trim().min(1, "Give a reason.").max(200) }).strict().safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const n = await withContext(req.ctx!, async (c) => (await c.query(
    `UPDATE appeals SET billing_skipped_at = now(), billing_skip_reason = $3
      WHERE firm_id = $1 AND id = ANY($2::int[]) AND billing_skipped_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.firm_id = appeals.firm_id AND i.appeal_id = appeals.id AND i.status <> 'void')`,
    [req.ctx!.firmId, parsed.data.appealIds, parsed.data.reason],
  )).rowCount);
  res.json({ skipped: n });
});

billingRouter.delete("/billing/skip/:id", requirePermission("invoices.send"), async (req, res) => {
  const aid = idParam(req);
  if (!aid) throw httpError(400, "Invalid appeal.");
  await withContext(req.ctx!, (c) => c.query(`UPDATE appeals SET billing_skipped_at = NULL, billing_skip_reason = NULL WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, aid]));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- one invoice
function invId(req: Request): number {
  const n = idParam(req);
  if (!n) throw httpError(400, "Invalid invoice.");
  return n;
}

async function invoiceDetail(c: pg.PoolClient, firmId: number, id: number) {
  const r = (await invoiceRows(c, firmId, `i.id = $2`, [id]))[0];
  if (!r) throw httpError(404, "Invoice not found.");
  const inv = (await c.query(`SELECT note, sent_to, void_reason, fee_basis FROM invoices WHERE firm_id = $1 AND id = $2`, [firmId, id])).rows[0];
  const lines = (await c.query(`SELECT id, kind, description, amount FROM invoice_lines WHERE firm_id = $1 AND invoice_id = $2 ORDER BY position, id`, [firmId, id])).rows;
  const payments = (await c.query(
    `SELECT y.id, y.amount, y.method, y.status, y.received_on, y.check_number, y.reference, y.failure_reason, y.created_at, u.name AS recorded_by
       FROM payments y LEFT JOIN users u ON u.firm_id = y.firm_id AND u.id = y.recorded_by
      WHERE y.firm_id = $1 AND (y.invoice_id = $2 OR y.id IN (SELECT payment_id FROM payment_allocations WHERE firm_id = $1 AND invoice_id = $2))
      ORDER BY y.id DESC`,
    [firmId, id],
  )).rows;
  const emailsSent = (await c.query(`SELECT to_addresses, status, error, created_at FROM email_log WHERE firm_id = $1 AND invoice_id = $2 ORDER BY id DESC`, [firmId, id])).rows;
  const due = await payable(c, firmId, { invoiceId: id });
  const acct = await firmStripe(c, firmId);
  const saved = acct ? (await c.query(`SELECT saved_method_label FROM stripe_customers WHERE firm_id = $1 AND account_id = $2 AND stripe_account_id = $3`, [firmId, r.accountId, acct.stripe_account_id])).rows[0]?.saved_method_label ?? null : null;
  return {
    ...r, note: inv.note, sentTo: inv.sent_to, voidReason: inv.void_reason, feeBasis: inv.fee_basis, lines, payments, emails: emailsSent,
    payable: due ? !due.blockedReason : false, blockedReason: due?.blockedReason ?? null, savedMethod: saved,
    suggestedTo: await billingRecipients(c, firmId, r.accountId, r.propertyId), hasLink: Boolean(await currentPayLink(c, firmId, { invoiceId: id })), today: todayIso(),
  };
}

billingRouter.get("/billing/invoices/:id", async (req, res) => {
  const id = invId(req);
  res.json(await withContext(req.ctx!, (c) => invoiceDetail(c, req.ctx!.firmId!, id)));
});

billingRouter.post("/billing/appeals/:id/invoice", requirePermission("invoices.send"), async (req, res) => {
  const aid = idParam(req);
  if (!aid) throw httpError(400, "Invalid appeal.");
  const out = await withContext(req.ctx!, async (c) => {
    const d = await draftInvoice(c, req.ctx!.firmId!, req.auth!.user.id, aid);
    if (!d.id) throw httpError(409, d.reason ?? "Nothing to bill.");
    return invoiceDetail(c, req.ctx!.firmId!, d.id);
  });
  res.status(201).json(out);
});

const LinesBody = z.object({
  note: z.string().trim().max(600).nullable().optional(),
  lines: z.array(z.object({ id: z.number().int().positive().optional(), description: z.string().trim().min(1, "Every line needs a description.").max(300), amount: money })).max(30).optional(),
}).strict();

/** Edits a draft: its note and lines. Changing the fee line's amount needs the fee permission. */
billingRouter.patch("/billing/invoices/:id", requirePermission("invoices.send"), async (req, res) => {
  const id = invId(req);
  const parsed = LinesBody.safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const canFees = await hasPermission(req, "fees.edit");
  const firmId = req.ctx!.firmId!;
  const out = await withContext(req.ctx!, async (c) => {
    const inv = (await c.query(`SELECT status FROM invoices WHERE firm_id = $1 AND id = $2 FOR UPDATE`, [firmId, id])).rows[0];
    if (!inv) throw httpError(404, "Invoice not found.");
    if (inv.status !== "draft") throw httpError(409, "Only a draft can be changed. Void a sent invoice and draft a new one.");
    if (parsed.data.note !== undefined) await c.query(`UPDATE invoices SET note = $3 WHERE firm_id = $1 AND id = $2`, [firmId, id, parsed.data.note || null]);
    if (parsed.data.lines) {
      const old = (await c.query<{ id: number; kind: string; amount: string; description: string }>(`SELECT id, kind, amount, description FROM invoice_lines WHERE firm_id = $1 AND invoice_id = $2`, [firmId, id])).rows;
      const fee = old.find((l) => l.kind === "fee");
      const keptFee = fee ? parsed.data.lines.find((l) => l.id === fee.id) : undefined;
      if (fee && !canFees && (!keptFee || toCents(keptFee.amount) !== toCents(fee.amount))) throw httpError(403, "Your role doesn't allow changing the fee.");
      if (parsed.data.lines.some((l) => l.id && !old.some((o) => o.id === l.id))) throw httpError(400, "That line isn't on this invoice.");
      // An expense line's amount is the expense's: change the expense itself, or take the line off.
      for (const o of old.filter((x) => x.kind === "expense")) {
        const kept = parsed.data.lines.find((l) => l.id === o.id);
        if (kept && toCents(kept.amount) !== toCents(o.amount)) throw httpError(400, "An expense line's amount comes from the expense. Change the expense, or remove the line.");
      }
      await c.query(`DELETE FROM invoice_lines WHERE firm_id = $1 AND invoice_id = $2 AND NOT (id = ANY($3::int[]))`, [firmId, id, parsed.data.lines.filter((l) => l.id).map((l) => l.id)]);
      for (const [i, l] of parsed.data.lines.entries()) {
        if (l.id) await c.query(`UPDATE invoice_lines SET description = $3, amount = $4, position = $5 WHERE firm_id = $1 AND id = $2`, [firmId, l.id, l.description, l.amount, i]);
        else await c.query(`INSERT INTO invoice_lines (firm_id, invoice_id, kind, description, amount, position) VALUES ($1, $2, 'other', $3, $4, $5)`, [firmId, id, l.description, l.amount, i]);
      }
      await refreshTotal(c, firmId, id);
    }
    return invoiceDetail(c, firmId, id);
  });
  res.json(out);
});

billingRouter.delete("/billing/invoices/:id", requirePermission("invoices.void"), async (req, res) => {
  const id = invId(req);
  await withContext(req.ctx!, async (c) => {
    const r = await c.query(`DELETE FROM invoices WHERE firm_id = $1 AND id = $2 AND status = 'draft'`, [req.ctx!.firmId, id]);
    if (!r.rowCount) throw httpError(409, "Only a draft can be deleted. Void a sent invoice instead.");
  });
  res.json({ ok: true });
});

/** Adds the property's open expenses (marked to be recovered on an invoice) to a draft. */
billingRouter.post("/billing/invoices/:id/add-expenses", requirePermission("invoices.send"), async (req, res) => {
  const id = invId(req);
  const out = await withContext(req.ctx!, async (c) => {
    const i = (await c.query(`SELECT status FROM invoices WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id])).rows[0];
    if (!i) throw httpError(404, "Invoice not found.");
    if (i.status !== "draft") throw httpError(409, "Expenses can only be added to a draft.");
    const n = await addExpenseLines(c, req.ctx!.firmId!, id);
    return { added: n, invoice: await invoiceDetail(c, req.ctx!.firmId!, id) };
  });
  res.json(out);
});

/** An invoice for a property's open expenses alone. */
billingRouter.post("/billing/properties/:id/expense-invoice", requirePermission("invoices.send"), async (req, res) => {
  const pid = idParam(req);
  if (!pid) throw httpError(400, "Invalid property.");
  const out = await withContext(req.ctx!, async (c) => invoiceDetail(c, req.ctx!.firmId!, await draftExpenseInvoice(c, req.ctx!.firmId!, req.auth!.user.id, pid)));
  res.status(201).json(out);
});

// ---------------------------------------------------------------- sending
function emailBody(firmName: string, kind: "invoice" | "statement", number: string, total: string, dueOn: string, link: string, client: string) {
  const what = kind === "invoice" ? `invoice ${number}` : `statement ${number}`;
  const text = [`Dear ${client},`, "", `Attached is ${what} from ${firmName} for ${formatMoney(total)}, due ${dueOn}.`, "",
    `You can pay online by bank account (ACH) or card here:`, link, "", "Thank you,", firmName].join("\n");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#14233f;font-size:14px;line-height:1.5">
<p>Dear ${escapeHtml(client)},</p><p>Attached is ${escapeHtml(what)} from ${escapeHtml(firmName)} for <b>${escapeHtml(formatMoney(total))}</b>, due ${escapeHtml(dueOn)}.</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#0A1F44;color:#ffffff;padding:10px 18px;border-radius:3px;text-decoration:none">View and pay</a></p>
<p style="color:#5d6678;font-size:12px">Pay by bank account (ACH) or card. Or copy this link: ${escapeHtml(link)}</p><p>Thank you,<br>${escapeHtml(firmName)}</p></div>`;
  return { text, html };
}

async function deliver(req: Request, target: { invoiceId?: number; statementId?: number }, to: string[], useEmail: boolean) {
  const firmId = req.ctx!.firmId!;
  const prep = await withContext(req.ctx!, async (c) => {
    if (target.invoiceId) await markInvoiceSent(c, firmId, target.invoiceId, to);
    const token = await newPayLink(c, firmId, target);
    const link = payUrl(token);
    const due = (await payable(c, firmId, target))!;
    const firm = (await c.query(`SELECT name, letterhead_name FROM firms WHERE id = $1`, [firmId])).rows[0];
    const client = (await c.query<{ name: string }>(`SELECT name FROM accounts WHERE firm_id = $1 AND id = $2`, [firmId, due.accountId])).rows[0].name;
    const dueOn = target.invoiceId
      ? (await c.query<{ due_on: string }>(`SELECT due_on FROM invoices WHERE firm_id = $1 AND id = $2`, [firmId, target.invoiceId])).rows[0].due_on
      : (await c.query<{ due_on: string }>(`SELECT due_on FROM statements WHERE firm_id = $1 AND id = $2`, [firmId, target.statementId])).rows[0].due_on;
    const pdf = target.invoiceId ? await invoicePdf(c, firmId, target.invoiceId, link) : await statementPdf(c, firmId, target.statementId!, link);
    const s = await billingSettings(c, firmId);
    return { link, due, firmName: firm.letterhead_name || firm.name, client, dueOn, pdf, replyTo: s.reply_to_email || req.auth!.user.email };
  });
  let emailed = false;
  let emailError: string | null = null;
  if (useEmail) {
    const dueText = new Date(`${prep.dueOn}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
    const body = emailBody(prep.firmName, prep.due.kind, prep.due.number, prep.due.total, dueText, prep.link, prep.client);
    const subject = `${prep.due.kind === "invoice" ? "Invoice" : "Statement"} ${prep.due.number} from ${prep.firmName}`;
    let status: "sent" | "failed" | "not_configured" = "sent";
    let providerId: string | null = null;
    try {
      providerId = (await sendEmail({ to, subject, ...body, replyTo: prep.replyTo, fromName: prep.firmName, attachments: [{ name: `${prep.due.number}.pdf`, content: prep.pdf, contentType: "application/pdf" }] })).id;
      emailed = true;
    } catch (e) {
      status = (e as { notConfigured?: boolean }).notConfigured ? "not_configured" : "failed";
      emailError = status === "not_configured" ? "Email isn't set up on this server, so nothing was emailed. Copy the pay link instead." : "The email didn't go out. Copy the pay link, or try sending again.";
    }
    await withContext(req.ctx!, (c) => c.query(
      `INSERT INTO email_log (firm_id, kind, invoice_id, statement_id, to_addresses, subject, status, provider_id, error, sent_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [firmId, prep.due.kind, target.invoiceId ?? null, target.statementId ?? null, to, subject, status, providerId, emailError, req.auth!.user.id],
    ));
  }
  return { link: prep.link, emailed, emailError };
}

const SendBody = z.object({ to: emails, email: z.boolean() }).strict().refine((v) => !v.email || v.to.length > 0, "Add at least one email address.");

/** Sends a draft (it gets its number now) or sends a sent invoice again. */
billingRouter.post("/billing/invoices/:id/send", requirePermission("invoices.send"), async (req, res) => {
  const id = invId(req);
  const parsed = SendBody.safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const pre = await withContext(req.ctx!, async (c) => (await payable(c, req.ctx!.firmId!, { invoiceId: id })));
  if (!pre) throw httpError(404, "Invoice not found.");
  if (pre.status === "sent" && pre.blockedReason?.includes("statement")) throw httpError(409, "This invoice is on an open statement. Send the statement instead.");
  const r = await deliver(req, { invoiceId: id }, parsed.data.to, parsed.data.email);
  const invoice = await withContext(req.ctx!, (c) => invoiceDetail(c, req.ctx!.firmId!, id));
  res.json({ ...r, invoice });
});

/** Sends every draft listed, each to its own suggested recipients. */
billingRouter.post("/billing/send-drafts", requirePermission("invoices.send"), async (req, res) => {
  const parsed = z.object({ ids: z.array(z.number().int().positive()).min(1).max(200), email: z.boolean() }).strict().safeParse(req.body);
  if (!parsed.success) throw httpError(400, "Choose the drafts to send.");
  const results: { id: number; ok: boolean; number?: string; error?: string; emailed?: boolean }[] = [];
  for (const id of parsed.data.ids) {
    try {
      const to = await withContext(req.ctx!, async (c) => {
        const i = (await c.query(`SELECT account_id, property_id, status FROM invoices WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id])).rows[0];
        if (!i || i.status !== "draft") throw httpError(409, "Not a draft.");
        return billingRecipients(c, req.ctx!.firmId!, i.account_id, i.property_id);
      });
      if (parsed.data.email && !to.length) throw httpError(409, "No billing email on file for this client.");
      const r = await deliver(req, { invoiceId: id }, to, parsed.data.email);
      const n = await withContext(req.ctx!, async (c) => (await c.query<{ number: string }>(`SELECT number FROM invoices WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id])).rows[0].number);
      results.push({ id, ok: !r.emailError, number: n, emailed: r.emailed, ...(r.emailError ? { error: r.emailError } : {}) });
    } catch (e) {
      results.push({ id, ok: false, error: (e as { publicMessage?: string }).publicMessage ?? "Couldn't send." });
    }
  }
  res.json({ results });
});

billingRouter.get("/billing/invoices/:id/pdf", async (req, res) => {
  const id = invId(req);
  const pdf = await withContext(req.ctx!, async (c) => {
    if (!(await c.query(`SELECT 1 FROM invoices WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id])).rowCount) throw httpError(404, "Invoice not found.");
    const link = await currentPayLink(c, req.ctx!.firmId!, { invoiceId: id });
    return invoicePdf(c, req.ctx!.firmId!, id, link ? payUrl(link) : null);
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="invoice-${id}.pdf"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.end(pdf);
});

/** The live pay link to copy (a new one if it can't be shown again). */
billingRouter.post("/billing/invoices/:id/link", requirePermission("invoices.send"), async (req, res) => {
  const id = invId(req);
  const link = await withContext(req.ctx!, async (c) => {
    const due = await payable(c, req.ctx!.firmId!, { invoiceId: id });
    if (!due) throw httpError(404, "Invoice not found.");
    if (due.status !== "sent") throw httpError(409, "Send the invoice first.");
    return (await currentPayLink(c, req.ctx!.firmId!, { invoiceId: id })) ?? (await newPayLink(c, req.ctx!.firmId!, { invoiceId: id }));
  });
  res.json({ link: payUrl(link) });
});

billingRouter.post("/billing/invoices/:id/void", requirePermission("invoices.void"), async (req, res) => {
  const id = invId(req);
  const parsed = z.object({ reason: z.string().trim().min(1, "Say why it's void.").max(300) }).strict().safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const firmId = req.ctx!.firmId!;
  const out = await withContext(req.ctx!, async (c) => {
    const i = (await c.query(`SELECT i.status, i.appeal_id, s.status AS st FROM invoices i LEFT JOIN statements s ON s.firm_id = i.firm_id AND s.id = i.statement_id WHERE i.firm_id = $1 AND i.id = $2 FOR UPDATE OF i`, [firmId, id])).rows[0];
    if (!i) throw httpError(404, "Invoice not found.");
    if (i.status !== "sent") throw httpError(409, i.status === "draft" ? "Delete a draft instead." : `This invoice is ${i.status}.`);
    if (i.st === "open") throw httpError(409, "This invoice is on an open statement. Void the statement first.");
    if ((await c.query(`SELECT 1 FROM payments WHERE firm_id = $1 AND invoice_id = $2 AND status = 'processing'`, [firmId, id])).rowCount) throw httpError(409, "A payment is processing. Wait for it to settle or fail.");
    await c.query(`UPDATE invoices SET status = 'void', void_reason = $3 WHERE firm_id = $1 AND id = $2`, [firmId, id, parsed.data.reason]);
    await revokeLinks(c, firmId, { invoiceIds: [id] });
    if (i.appeal_id) await c.query(`UPDATE appeals SET substage = 'decision_analysis', substage_since = now() WHERE firm_id = $1 AND id = $2 AND substage = 'invoice_sent'`, [firmId, i.appeal_id]);
    return invoiceDetail(c, firmId, id);
  });
  res.json(out);
});

const PaymentBody = z.object({
  method: z.enum(["check", "other"]), amount: money, receivedOn: isoDate,
  checkNumber: z.string().trim().max(40).nullable().optional(), reference: z.string().trim().max(200).nullable().optional(),
}).strict();

async function recordManual(req: Request, target: { invoiceId?: number; statementId?: number }) {
  const parsed = PaymentBody.safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  if (parsed.data.receivedOn > todayIso()) throw httpError(400, "The date received can't be in the future.");
  await withContext(req.ctx!, (c) => recordPayment(c, req.ctx!.firmId!, {
    target, amount: parsed.data.amount, method: parsed.data.method, status: "succeeded", receivedOn: parsed.data.receivedOn,
    checkNumber: parsed.data.checkNumber || null, reference: parsed.data.reference || null, userId: req.auth!.user.id,
  }));
}

billingRouter.post("/billing/invoices/:id/payments", requirePermission("invoices.send"), async (req, res) => {
  const id = invId(req);
  await recordManual(req, { invoiceId: id });
  res.status(201).json(await withContext(req.ctx!, (c) => invoiceDetail(c, req.ctx!.firmId!, id)));
});

billingRouter.post("/billing/invoices/:id/charge", requirePermission("invoices.send"), async (req, res) => {
  const id = invId(req);
  const r = await chargeSaved(req.ctx!.firmId!, req.auth!.user.id, { invoiceId: id });
  res.json({ ...r, invoice: await withContext(req.ctx!, (c) => invoiceDetail(c, req.ctx!.firmId!, id)) });
});

// ---------------------------------------------------------------- statements
async function statementDetail(c: pg.PoolClient, firmId: number, id: number) {
  const s = (await statementRows(c, firmId, `s.id = $2`, [id]))[0];
  if (!s) throw httpError(404, "Statement not found.");
  const invoices = await invoiceRows(c, firmId, `i.statement_id = $2`, [id]);
  const payments = (await c.query(`SELECT id, amount, method, status, received_on, check_number, failure_reason FROM payments WHERE firm_id = $1 AND statement_id = $2 ORDER BY id DESC`, [firmId, id])).rows;
  const due = await payable(c, firmId, { statementId: id });
  const acct = await firmStripe(c, firmId);
  const saved = acct ? (await c.query(`SELECT saved_method_label FROM stripe_customers WHERE firm_id = $1 AND account_id = $2 AND stripe_account_id = $3`, [firmId, s.accountId, acct.stripe_account_id])).rows[0]?.saved_method_label ?? null : null;
  return { ...s, invoiceList: invoices, payments, payable: due ? !due.blockedReason : false, blockedReason: due?.blockedReason ?? null, savedMethod: saved, today: todayIso() };
}

/** A client's unpaid sent invoices that could go on a statement. */
billingRouter.get("/billing/accounts/:id/open", async (req, res) => {
  const aid = idParam(req);
  if (!aid) throw httpError(400, "Invalid client.");
  const firmId = req.ctx!.firmId!;
  res.json(await withContext(req.ctx!, async (c) => ({
    invoices: await invoiceRows(c, firmId, `i.account_id = $2 AND i.status = 'sent' AND (i.statement_id IS NULL OR s.status = 'void')`, [aid]),
    statements: await statementRows(c, firmId, `s.account_id = $2`, [aid]),
    suggestedTo: await billingRecipients(c, firmId, aid, null),
    all: await invoiceRows(c, firmId, `i.account_id = $2`, [aid]),
    expenses: await expenseRows(c, firmId, `e.account_id = $2`, [aid]),
    trustBalance: (await c.query<{ s: string }>(`SELECT COALESCE(sum(amount), 0)::numeric(14,2) AS s FROM trust_entries WHERE firm_id = $1 AND account_id = $2`, [firmId, aid])).rows[0].s,
  })));
});

/** One property's invoices, and any of its decided reductions ready to bill. */
billingRouter.get("/billing/properties/:id", async (req, res) => {
  const pid = idParam(req);
  if (!pid) throw httpError(400, "Invalid property.");
  const firmId = req.ctx!.firmId!;
  res.json(await withContext(req.ctx!, async (c) => ({
    invoices: await invoiceRows(c, firmId, `i.property_id = $2`, [pid]),
    ready: (await readyToBill(c, firmId)).filter((r) => r.propertyId === pid),
    needs: (await needsTaxFigures(c, firmId)).filter((r) => r.propertyId === pid),
    expenses: await expenseRows(c, firmId, `e.property_id = $2`, [pid]),
    settlements: (await c.query(
      `SELECT s.id, s.status, s.refund_amount, s.fee_amount, s.expenses_amount, s.client_amount, s.refund_received_on, s.paid_on, a.assessment_year, a.level
         FROM trust_settlements s JOIN appeals a ON a.firm_id = s.firm_id AND a.id = s.appeal_id WHERE s.firm_id = $1 AND s.property_id = $2 ORDER BY s.id DESC`,
      [firmId, pid],
    )).rows.map((r) => ({ id: r.id, status: r.status, refund: r.refund_amount, fee: r.fee_amount, expenses: r.expenses_amount, toClient: r.client_amount, receivedOn: r.refund_received_on, paidOn: r.paid_on, appeal: `${r.assessment_year} ${LEVEL_LABELS[r.level as Level]}` })),
    appeals: (await c.query(`SELECT id, assessment_year, level FROM appeals WHERE firm_id = $1 AND property_id = $2 ORDER BY assessment_year DESC, id DESC`, [firmId, pid])).rows
      .map((r) => ({ id: r.id, label: `${r.assessment_year} ${LEVEL_LABELS[r.level as Level]}` })),
    receipts: (await c.query(`SELECT id, name FROM documents WHERE firm_id = $1 AND property_id = $2 ORDER BY name LIMIT 300`, [firmId, pid])).rows,
  })));
});

const StatementBody = z.object({ accountId: z.number().int().positive(), invoiceIds: z.array(z.number().int().positive()).min(2, "A statement covers two or more invoices.").max(200), to: emails, email: z.boolean() }).strict()
  .refine((v) => !v.email || v.to.length > 0, "Add at least one email address.");

/** Gathers sent, unpaid invoices into a statement and sends it. Their own pay links stop working. */
billingRouter.post("/billing/statements", requirePermission("invoices.send"), async (req, res) => {
  const parsed = StatementBody.safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const firmId = req.ctx!.firmId!;
  const sid = await withContext(req.ctx!, async (c) => {
    const invs = (await c.query<{ id: number; total: string; account_id: number; status: string; st: string | null }>(
      `SELECT i.id, i.total, i.account_id, i.status, s.status AS st FROM invoices i LEFT JOIN statements s ON s.firm_id = i.firm_id AND s.id = i.statement_id
        WHERE i.firm_id = $1 AND i.id = ANY($2::int[]) FOR UPDATE OF i`,
      [firmId, parsed.data.invoiceIds],
    )).rows;
    if (invs.length !== parsed.data.invoiceIds.length) throw httpError(404, "One of those invoices isn't in your firm.");
    if (invs.some((i) => i.account_id !== parsed.data.accountId)) throw httpError(400, "A statement covers one client's invoices.");
    if (invs.some((i) => i.status !== "sent" || i.st === "open")) throw httpError(409, "Only sent, unpaid invoices that aren't on another statement can go on a statement.");
    if ((await c.query(`SELECT 1 FROM payments WHERE firm_id = $1 AND invoice_id = ANY($2::int[]) AND status = 'processing'`, [firmId, parsed.data.invoiceIds])).rowCount) throw httpError(409, "A payment on one of those invoices is processing.");
    const s = await billingSettings(c, firmId);
    const today = todayIso();
    const total = centsToString(invs.reduce((a, i) => a + toCents(i.total), 0n));
    const id = (await c.query<{ id: number }>(
      `INSERT INTO statements (firm_id, account_id, number, issued_on, due_on, total, sent_at, sent_to, created_by) VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8) RETURNING id`,
      [firmId, parsed.data.accountId, await nextNumber(c, firmId, "statement", today), today, addDays(today, s.payment_terms_days), total, parsed.data.to, req.auth!.user.id],
    )).rows[0].id;
    await c.query(`UPDATE invoices SET statement_id = $3 WHERE firm_id = $1 AND id = ANY($2::int[])`, [firmId, parsed.data.invoiceIds, id]);
    await revokeLinks(c, firmId, { invoiceIds: parsed.data.invoiceIds });
    return id;
  });
  const r = await deliver(req, { statementId: sid }, parsed.data.to, parsed.data.email);
  res.status(201).json({ ...r, statement: await withContext(req.ctx!, (c) => statementDetail(c, firmId, sid)) });
});

billingRouter.get("/billing/statements/:id", async (req, res) => {
  const id = idParam(req);
  if (!id) throw httpError(400, "Invalid statement.");
  res.json(await withContext(req.ctx!, (c) => statementDetail(c, req.ctx!.firmId!, id)));
});

billingRouter.get("/billing/statements/:id/pdf", async (req, res) => {
  const id = idParam(req);
  if (!id) throw httpError(400, "Invalid statement.");
  const pdf = await withContext(req.ctx!, async (c) => {
    if (!(await c.query(`SELECT 1 FROM statements WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id])).rowCount) throw httpError(404, "Statement not found.");
    const link = await currentPayLink(c, req.ctx!.firmId!, { statementId: id });
    return statementPdf(c, req.ctx!.firmId!, id, link ? payUrl(link) : null);
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="statement-${id}.pdf"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.end(pdf);
});

billingRouter.post("/billing/statements/:id/link", requirePermission("invoices.send"), async (req, res) => {
  const id = idParam(req);
  if (!id) throw httpError(400, "Invalid statement.");
  const link = await withContext(req.ctx!, async (c) => {
    const due = await payable(c, req.ctx!.firmId!, { statementId: id });
    if (!due) throw httpError(404, "Statement not found.");
    if (due.status !== "open") throw httpError(409, `This statement is ${due.status}.`);
    return (await currentPayLink(c, req.ctx!.firmId!, { statementId: id })) ?? (await newPayLink(c, req.ctx!.firmId!, { statementId: id }));
  });
  res.json({ link: payUrl(link) });
});

/** Voids a statement; its invoices can be paid on their own again (send them again for fresh links). */
billingRouter.post("/billing/statements/:id/void", requirePermission("invoices.void"), async (req, res) => {
  const id = idParam(req);
  if (!id) throw httpError(400, "Invalid statement.");
  const parsed = z.object({ reason: z.string().trim().min(1, "Say why it's void.").max(300) }).strict().safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const firmId = req.ctx!.firmId!;
  const out = await withContext(req.ctx!, async (c) => {
    const s = (await c.query(`SELECT status FROM statements WHERE firm_id = $1 AND id = $2 FOR UPDATE`, [firmId, id])).rows[0];
    if (!s) throw httpError(404, "Statement not found.");
    if (s.status !== "open") throw httpError(409, `This statement is ${s.status}.`);
    if ((await c.query(`SELECT 1 FROM payments WHERE firm_id = $1 AND statement_id = $2 AND status = 'processing'`, [firmId, id])).rowCount) throw httpError(409, "A payment is processing. Wait for it to settle or fail.");
    await c.query(`UPDATE statements SET status = 'void', void_reason = $3 WHERE firm_id = $1 AND id = $2`, [firmId, id, parsed.data.reason]);
    await revokeLinks(c, firmId, { statementId: id });
    return statementDetail(c, firmId, id);
  });
  res.json(out);
});

billingRouter.post("/billing/statements/:id/payments", requirePermission("invoices.send"), async (req, res) => {
  const id = idParam(req);
  if (!id) throw httpError(400, "Invalid statement.");
  await recordManual(req, { statementId: id });
  res.status(201).json(await withContext(req.ctx!, (c) => statementDetail(c, req.ctx!.firmId!, id)));
});

billingRouter.post("/billing/statements/:id/charge", requirePermission("invoices.send"), async (req, res) => {
  const id = idParam(req);
  if (!id) throw httpError(400, "Invalid statement.");
  const r = await chargeSaved(req.ctx!.firmId!, req.auth!.user.id, { statementId: id });
  res.json({ ...r, statement: await withContext(req.ctx!, (c) => statementDetail(c, req.ctx!.firmId!, id)) });
});

// ---------------------------------------------------------------- settings and Stripe
billingRouter.get("/billing/settings", async (req, res) => {
  const out = await withContext(req.ctx!, async (c) => {
    const s = await billingSettings(c, req.ctx!.firmId!);
    const f = (await c.query(`SELECT letterhead_name, letterhead_address, letterhead_phone, letterhead_website FROM firms WHERE id = $1`, [req.ctx!.firmId])).rows[0];
    const acct = (await c.query(`SELECT stripe_account_id, charges_enabled, payouts_enabled, details_submitted, business_name, livemode FROM stripe_accounts WHERE firm_id = $1`, [req.ctx!.firmId])).rows[0] ?? null;
    return { settings: s, letterhead: f, stripe: acct, stripeAvailable: stripeConfigured(), emailAvailable: emailConfigured() };
  });
  res.json(out);
});

const SettingsBody = z.object({
  invoicePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,6}$/, "The prefix is 1 to 6 letters or numbers.").optional(),
  paymentTermsDays: z.number().int().min(0).max(120).optional(),
  invoiceNote: z.string().trim().max(600).nullable().optional(),
  replyToEmail: z.string().trim().toLowerCase().refine((v) => v === "" || validEmail(v), "The reply-to address isn't valid.").nullable().optional(),
  letterheadName: z.string().trim().max(120).nullable().optional(),
  letterheadAddress: z.string().trim().max(200).nullable().optional(),
  letterheadPhone: z.string().trim().max(40).nullable().optional(),
  letterheadWebsite: z.string().trim().max(120).nullable().optional(),
}).strict();

billingRouter.put("/billing/settings", requireFirmAdmin, async (req, res) => {
  const parsed = SettingsBody.safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const d = parsed.data;
  const firmId = req.ctx!.firmId!;
  await withContext(req.ctx!, async (c) => {
    await billingSettings(c, firmId);
    const sets: [string, unknown][] = [];
    if (d.invoicePrefix !== undefined) sets.push(["invoice_prefix", d.invoicePrefix]);
    if (d.paymentTermsDays !== undefined) sets.push(["payment_terms_days", d.paymentTermsDays]);
    if (d.invoiceNote !== undefined) sets.push(["invoice_note", d.invoiceNote || null]);
    if (d.replyToEmail !== undefined) sets.push(["reply_to_email", d.replyToEmail || null]);
    if (sets.length) await c.query(`UPDATE billing_settings SET ${sets.map(([k], i) => `${k} = $${i + 2}`).join(", ")} WHERE firm_id = $1`, [firmId, ...sets.map(([, v]) => v)]);
  });
  // The letterhead lives on the firm (outside the tenant lock), so it's written by firm id and audited by hand.
  const lh: [string, unknown][] = [];
  if (d.letterheadName !== undefined) lh.push(["letterhead_name", d.letterheadName || null]);
  if (d.letterheadAddress !== undefined) lh.push(["letterhead_address", d.letterheadAddress || null]);
  if (d.letterheadPhone !== undefined) lh.push(["letterhead_phone", d.letterheadPhone || null]);
  if (d.letterheadWebsite !== undefined) lh.push(["letterhead_website", d.letterheadWebsite || null]);
  if (lh.length) {
    await withContext(req.ctx!, async (c) => {
      await c.query(`UPDATE firms SET ${lh.map(([k], i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [firmId, ...lh.map(([, v]) => v)]);
      await c.query(
        `INSERT INTO audit_log (firm_id, actor_user_id, actor_kind, table_name, row_id, action, before, after) VALUES ($1, $2, 'firm_user', 'firms', $4, 'UPDATE', NULL, $3)`,
        [firmId, req.auth!.user.id, Object.fromEntries(lh), String(firmId)],
      );
    });
  }
  res.json({ ok: true });
});

const stripeMessage = (e: unknown) => httpError(502, friendlyStripeError(e));

/** Starts (or continues) Stripe onboarding for the firm's own account. Firm admins only. */
billingRouter.post("/billing/stripe/connect", requireFirmAdmin, async (req, res) => {
  if (!stripeConfigured()) throw httpError(409, "Online payments aren't set up on this server yet (STRIPE_SECRET_KEY).");
  const firmId = req.ctx!.firmId!;
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  try {
    let acct = await withContext(req.ctx!, (c) => firmStripe(c, firmId));
    if (!acct) {
      const firm = await withContext(req.ctx!, async (c) => (await c.query<{ name: string }>(`SELECT name FROM firms WHERE id = $1`, [firmId])).rows[0]);
      // The firm's own account: it pays Stripe's fees and carries its own losses, with the full Stripe dashboard.
      const created = await stripe<{ id: string; livemode: boolean }>("POST", "/v1/accounts", {
        country: "US", business_profile: { name: firm.name }, metadata: { firm_id: firmId },
        controller: { fees: { payer: "account" }, losses: { payments: "stripe" }, stripe_dashboard: { type: "full" } },
      }, null, `acct-${firmId}`);
      await withContext(req.ctx!, (c) => c.query(
        `INSERT INTO stripe_accounts (firm_id, stripe_account_id, livemode, business_name, connected_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (firm_id) DO NOTHING`,
        [firmId, created.id, created.livemode, firm.name, req.auth!.user.id],
      ));
      acct = { stripe_account_id: created.id, charges_enabled: false };
    }
    const link = await stripe<{ url: string }>("POST", "/v1/account_links", {
      account: acct.stripe_account_id, type: "account_onboarding",
      refresh_url: `${base}/settings?tab=billing&stripe=retry`, return_url: `${base}/api/firm/billing/stripe/return`,
    });
    res.json({ url: link.url });
  } catch (e) {
    if (e instanceof StripeError) throw stripeMessage(e);
    throw e;
  }
});

async function refreshAccount(req: Request): Promise<void> {
  const firmId = req.ctx!.firmId!;
  const acct = await withContext(req.ctx!, (c) => firmStripe(c, firmId));
  if (!acct) return;
  const a = await stripe<{ charges_enabled: boolean; payouts_enabled: boolean; details_submitted: boolean; business_profile?: { name?: string | null } }>("GET", `/v1/accounts/${acct.stripe_account_id}`);
  await withContext(req.ctx!, (c) => c.query(
    `UPDATE stripe_accounts SET charges_enabled = $2, payouts_enabled = $3, details_submitted = $4, business_name = COALESCE($5, business_name) WHERE firm_id = $1`,
    [firmId, a.charges_enabled, a.payouts_enabled, a.details_submitted, a.business_profile?.name ?? null],
  ));
}

/** Where Stripe sends the firm admin back after onboarding. */
billingRouter.get("/billing/stripe/return", requireFirmAdmin, async (req, res) => {
  await refreshAccount(req).catch(() => undefined);
  res.redirect(302, "/settings?tab=billing&stripe=back");
});

billingRouter.post("/billing/stripe/refresh", requireFirmAdmin, async (req, res) => {
  try { await refreshAccount(req); } catch (e) { if (e instanceof StripeError) throw stripeMessage(e); throw e; }
  res.json({ ok: true });
});

/** Forgets the connection here (the firm's Stripe account itself is untouched). Not while a payment is processing. */
billingRouter.delete("/billing/stripe", requireFirmAdmin, async (req, res) => {
  await withContext(req.ctx!, async (c) => {
    if ((await c.query(`SELECT 1 FROM payments WHERE firm_id = $1 AND status = 'processing'`, [req.ctx!.firmId])).rowCount) throw httpError(409, "A payment is still processing. Disconnect once it settles.");
    await c.query(`DELETE FROM stripe_customers WHERE firm_id = $1`, [req.ctx!.firmId]);
    await c.query(`DELETE FROM stripe_accounts WHERE firm_id = $1`, [req.ctx!.firmId]);
  });
  res.json({ ok: true });
});
