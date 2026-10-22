// The client's pay page (no sign-in: the link itself is the key) and Stripe's webhook.
// A pay link is 32 random bytes; only its hash is stored. Looking it up is the one step
// before a firm is known, through pay_links (ids only); everything after runs under a
// 'system' context for that link's firm, so row-level security still applies.

import express, { Router, type Request } from "express";
import { z } from "zod";
import { query, withContext, type DbContext } from "../db.js";
import { matterTitle } from "../../shared/domain.js";
import { hashToken, payable, type Payable } from "../billing/core.js";
import { invoicePdf, statementPdf } from "../billing/pdf.js";
import { sendPdf } from "./billing-design.js";
import { applyCheckoutSession, applyIntent, createCheckout, firmStripe } from "../billing/payments.js";
import { friendlyStripeError, stripe, StripeError, verifyStripeSignature } from "../billing/stripe.js";

const err = (status: number, publicMessage: string) => Object.assign(new Error(publicMessage), { status, publicMessage });
const sys = (firmId: number): DbContext => ({ actorKind: "system", userId: null, firmId });

interface Link { firm_id: number; invoice_id: number | null; statement_id: number | null; revoked_at: string | null }

async function linkFor(req: Request): Promise<Link> {
  const token = String(req.params.token ?? "");
  if (!/^[A-Za-z0-9_-]{30,80}$/.test(token)) throw err(404, "This pay link isn't valid.");
  const l = (await query<Link>(`SELECT firm_id, invoice_id, statement_id, revoked_at FROM pay_links WHERE token_hash = $1`, [hashToken(token)])).rows[0];
  if (!l) throw err(404, "This pay link isn't valid.");
  return l;
}

const targetOf = (l: Link) => (l.invoice_id ? { invoiceId: l.invoice_id } : { statementId: l.statement_id! });
const baseUrl = (req: Request) => (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");

export const payRouter = Router();

/** What the client sees: who's billing, for what, how much, and whether it can be paid now. */
async function summary(l: Link) {
  return withContext(sys(l.firm_id), async (c) => {
    const due = (await payable(c, l.firm_id, targetOf(l)))!;
    const firm = (await c.query(`SELECT name, letterhead_name, letterhead_address, letterhead_phone, letterhead_website FROM firms WHERE id = $1`, [l.firm_id])).rows[0];
    const client = (await c.query<{ name: string }>(`SELECT name FROM accounts WHERE firm_id = $1 AND id = $2`, [l.firm_id, due.accountId])).rows[0];
    const items = (await c.query(
      `SELECT i.number, i.issued_on, i.due_on, i.total, p.address1, p.name, p.city, t.name AS township,
              (SELECT x.pin FROM parcels x WHERE x.firm_id = p.firm_id AND x.property_id = p.id ORDER BY x.is_primary DESC, x.id LIMIT 1) AS pin
         FROM invoices i JOIN properties p ON p.firm_id = i.firm_id AND p.id = i.property_id LEFT JOIN townships t ON t.id = p.township_id
        WHERE i.firm_id = $1 AND i.id = ANY($2::int[]) ORDER BY i.issued_on, i.number`,
      [l.firm_id, due.invoiceIds],
    )).rows;
    const dueOn = due.kind === "statement"
      ? (await c.query<{ due_on: string }>(`SELECT due_on FROM statements WHERE firm_id = $1 AND id = $2`, [l.firm_id, due.id])).rows[0].due_on
      : items[0]?.due_on ?? null;
    const lastPayment = (await c.query<{ status: string; method: string; amount: string; created_at: string }>(
      `SELECT status, method, amount, created_at FROM payments WHERE firm_id = $1 AND ${due.kind === "invoice" ? "invoice_id" : "statement_id"} = $2 ORDER BY id DESC LIMIT 1`,
      [l.firm_id, due.id],
    )).rows[0] ?? null;
    const acct = await firmStripe(c, l.firm_id);
    const state = due.status === "paid" ? "paid" : l.revoked_at || due.status === "void" || (due.kind === "invoice" && due.status !== "sent") ? "closed"
      : lastPayment?.status === "processing" ? "processing" : due.blockedReason ? "closed" : "payable";
    return {
      firm: { name: firm.letterhead_name || firm.name, address: firm.letterhead_address, phone: firm.letterhead_phone, website: firm.letterhead_website },
      client: client?.name ?? "",
      kind: due.kind, number: due.number, total: due.total, dueOn, state,
      message: state === "closed" ? (l.revoked_at && due.status !== "paid" ? "This link has been replaced. Use the most recent email or statement from the firm, or contact them." : due.blockedReason ?? "This bill can't be paid online.") : null,
      items: items.map((i) => ({ number: i.number, matter: matterTitle(i.pin, i.address1 || i.name, i.city, i.township), issuedOn: i.issued_on, total: i.total })),
      payment: lastPayment ? { status: lastPayment.status, method: lastPayment.method, amount: lastPayment.amount, at: lastPayment.created_at } : null,
      online: Boolean(acct?.charges_enabled),
      attachments: (await c.query<{ id: number; name: string; size: number }>(
        `SELECT id, name, size FROM invoice_attachments WHERE firm_id = $1 AND invoice_id = ANY($2::int[]) ORDER BY invoice_id, position, id`,
        [l.firm_id, due.invoiceIds],
      )).rows,
    };
  });
}

payRouter.get("/pay/:token", async (req, res) => {
  const l = await linkFor(req);
  // Back from Checkout: settle from the session right away, in case the webhook is still on its way.
  const session = typeof req.query.session === "string" && /^cs_[A-Za-z0-9_]+$/.test(req.query.session) ? req.query.session : null;
  if (session) {
    const acct = await withContext(sys(l.firm_id), (c) => firmStripe(c, l.firm_id));
    if (acct) {
      const s = await stripe<Parameters<typeof applyCheckoutSession>[2]>("GET", `/v1/checkout/sessions/${session}`, {}, acct.stripe_account_id).catch(() => null);
      if (s && s.status === "complete") await applyCheckoutSession(l.firm_id, acct.stripe_account_id, s, "completed").catch(() => undefined);
    }
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(await summary(l));
});

payRouter.get("/pay/:token/pdf", async (req, res) => {
  const l = await linkFor(req);
  const token = String(req.params.token);
  const pdf = await withContext(sys(l.firm_id), (c) => (l.invoice_id ? invoicePdf(c, l.firm_id, l.invoice_id, `${baseUrl(req)}/pay/${token}`) : statementPdf(c, l.firm_id, l.statement_id!, `${baseUrl(req)}/pay/${token}`)));
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${l.invoice_id ? "invoice" : "statement"}.pdf"`);
  res.setHeader("Cache-Control", "no-store");
  res.end(pdf);
});

/** A file the firm attached to the bill (only while the link is live and only that bill's own files). */
payRouter.get("/pay/:token/attachments/:att", async (req, res) => {
  const l = await linkFor(req);
  const att = Number(req.params.att);
  if (!Number.isInteger(att) || att <= 0 || l.revoked_at) throw err(404, "That file isn't available.");
  const a = await withContext(sys(l.firm_id), async (c) => {
    const due = (await payable(c, l.firm_id, targetOf(l)))!;
    return (await c.query<{ name: string; content: Buffer }>(
      `SELECT name, content FROM invoice_attachments WHERE firm_id = $1 AND id = $2 AND invoice_id = ANY($3::int[])`,
      [l.firm_id, att, due.invoiceIds],
    )).rows[0];
  });
  if (!a) throw err(404, "That file isn't available.");
  sendPdf(res, a.name, a.content);
});

payRouter.post("/pay/:token/checkout", async (req, res) => {
  const l = await linkFor(req);
  const parsed = z.object({ method: z.enum(["card", "ach"]), save: z.boolean().optional() }).strict().safeParse(req.body);
  if (!parsed.success) throw err(400, "Choose bank account or card.");
  if (l.revoked_at) throw err(409, "This link has been replaced. Use the most recent email or statement from the firm.");
  const due: Payable | null = await withContext(sys(l.firm_id), (c) => payable(c, l.firm_id, targetOf(l)));
  if (!due) throw err(404, "This pay link isn't valid.");
  if (due.blockedReason) throw err(409, due.blockedReason);
  try {
    const url = await createCheckout(l.firm_id, due, parsed.data.method, Boolean(parsed.data.save), String(req.params.token), baseUrl(req));
    res.json({ url });
  } catch (e) {
    if (e instanceof StripeError) throw err(502, friendlyStripeError(e));
    throw e;
  }
});

// ---------------------------------------------------------------- Stripe webhook
export const stripeWebhook = Router();

interface StripeEvent { id: string; type: string; account?: string; data: { object: Record<string, unknown> & { id: string; metadata?: Record<string, string> } } }

stripeWebhook.post("/stripe/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  if (!secret || !verifyStripeSignature(raw, req.header("stripe-signature"), secret)) {
    res.status(400).json({ error: "Bad signature." });
    return;
  }
  const ev = JSON.parse(raw.toString("utf8")) as StripeEvent;
  const obj = ev.data.object;
  // Which firm: from the metadata Appeal EyeQ put on the object, checked against that firm's own Stripe account.
  const firmId = Number(obj.metadata?.firm_id);
  if (!ev.account || !Number.isInteger(firmId) || firmId <= 0) { res.json({ ignored: true }); return; }
  const acct = await withContext(sys(firmId), (c) => firmStripe(c, firmId)).catch(() => null);
  if (!acct || acct.stripe_account_id !== ev.account) { res.json({ ignored: true }); return; }
  const fresh = (await query(`INSERT INTO stripe_events (event_id, type, firm_id) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING`, [ev.id, ev.type, firmId])).rowCount;
  if (!fresh) { res.json({ duplicate: true }); return; }
  try {
    switch (ev.type) {
      case "account.updated": {
        const a = obj as unknown as { charges_enabled: boolean; payouts_enabled: boolean; details_submitted: boolean; business_profile?: { name?: string | null } };
        await withContext(sys(firmId), (c) => c.query(
          `UPDATE stripe_accounts SET charges_enabled = $2, payouts_enabled = $3, details_submitted = $4, business_name = COALESCE($5, business_name) WHERE firm_id = $1`,
          [firmId, a.charges_enabled, a.payouts_enabled, a.details_submitted, a.business_profile?.name ?? null],
        ));
        break;
      }
      case "checkout.session.completed":
        await applyCheckoutSession(firmId, ev.account, obj as never, "completed");
        break;
      case "checkout.session.async_payment_succeeded":
        await applyCheckoutSession(firmId, ev.account, obj as never, "succeeded");
        break;
      case "checkout.session.async_payment_failed":
        await applyCheckoutSession(firmId, ev.account, obj as never, "failed");
        break;
      case "payment_intent.succeeded":
        await applyIntent(firmId, obj as never, "succeeded");
        break;
      case "payment_intent.payment_failed":
        await applyIntent(firmId, obj as never, "failed");
        break;
      default:
        break;
    }
  } catch (e) {
    // Let Stripe retry: forget the event so the next delivery is processed.
    await query(`DELETE FROM stripe_events WHERE event_id = $1`, [ev.id]);
    console.error(`Stripe webhook failed: ${ev.type} ${e instanceof Error ? e.name : "Error"}`);
    res.status(500).json({ error: "Not processed." });
    return;
  }
  res.json({ ok: true });
});
