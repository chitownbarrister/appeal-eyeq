// Test-only stand-ins for Stripe and Postmark: the endpoints Appeal EyeQ calls, plus pages
// and hooks that play the client's part (finishing onboarding, paying on Checkout, an ACH
// payment settling days later). Webhooks are signed with the shared secret, as Stripe's are.

import express from "express";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

export const FAKE_STRIPE_KEY = "sk_test_fake_platform_key";
export const FAKE_WEBHOOK_SECRET = "whsec_fake_secret_for_tests";

interface Session {
  id: string; account: string; customer: string; amount_total: number; metadata: Record<string, string>; payment_method_types: string[];
  success_url: string; cancel_url: string; status: "open" | "complete"; payment_status: "unpaid" | "paid"; payment_intent: string | null; save: boolean;
}
interface Intent { id: string; account: string; amount: number; status: string; customer: string | null; payment_method: string | null; payment_method_types: string[]; setup_future_usage: string | null; metadata: Record<string, string> }

export interface FakeStripe {
  url: string;
  server: Server;
  state: { accounts: Map<string, { id: string; charges_enabled: boolean; return_url?: string; metadata: Record<string, string> }>; sessions: Map<string, Session>; intents: Map<string, Intent>; emails: Record<string, unknown>[]; requests: string[] };
  setWebhook: (url: string) => void;
  close: () => Promise<void>;
}

function parseForm(body: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of body.split("&").filter(Boolean)) {
    const [k, v = ""] = pair.split("=").map((x) => decodeURIComponent(x.replace(/\+/g, " ")));
    const keys = k.replace(/\]/g, "").split("[");
    let cur = out as Record<string, unknown>;
    keys.forEach((key, i) => {
      if (i === keys.length - 1) cur[key] = v;
      else { cur[key] ??= {}; cur = cur[key] as Record<string, unknown>; }
    });
  }
  return out;
}

export async function startFakeStripe(port = 0): Promise<FakeStripe> {
  const app = express();
  const state: FakeStripe["state"] = { accounts: new Map(), sessions: new Map(), intents: new Map(), emails: [], requests: [] };
  let webhook = "";
  let n = 0;
  let base = "";
  const id = (p: string) => `${p}_${++n}${Math.random().toString(36).slice(2, 8)}`;

  async function send(type: string, account: string, object: unknown) {
    if (!webhook) return;
    const body = JSON.stringify({ id: id("evt"), type, account, data: { object } });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", FAKE_WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex");
    await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${t},v1=${sig}` }, body });
  }
  const sessionObj = (s: Session) => ({ object: "checkout.session", id: s.id, amount_total: s.amount_total, metadata: s.metadata, status: s.status, payment_status: s.payment_status, payment_intent: s.payment_intent, customer: s.customer });

  app.use(express.text({ type: "*/*" }));
  app.use("/v1", (req, res, next) => {
    if (req.headers.authorization !== `Bearer ${FAKE_STRIPE_KEY}`) { res.status(401).json({ error: { message: "Invalid API Key provided" } }); return; }
    state.requests.push(`${req.method} ${req.path} ${req.headers["stripe-account"] ?? ""}`);
    next();
  });
  const form = (req: express.Request) => parseForm(typeof req.body === "string" ? req.body : "");

  app.post("/v1/accounts", (req, res) => {
    const f = form(req) as { metadata?: Record<string, string> };
    const a = { id: id("acct"), charges_enabled: false, metadata: f.metadata ?? {} };
    state.accounts.set(a.id, a);
    res.json({ id: a.id, livemode: false });
  });
  app.get("/v1/accounts/:id", (req, res) => {
    const a = state.accounts.get(req.params.id);
    if (!a) { res.status(404).json({ error: { message: "No such account" } }); return; }
    res.json({ id: a.id, charges_enabled: a.charges_enabled, payouts_enabled: a.charges_enabled, details_submitted: a.charges_enabled, business_profile: { name: "Test firm" } });
  });
  app.post("/v1/account_links", (req, res) => {
    const f = form(req) as { account: string; return_url: string };
    const a = state.accounts.get(f.account)!;
    a.return_url = f.return_url;
    res.json({ url: `${base}/__onboard?account=${a.id}` });
  });
  // The firm admin finishing onboarding on "Stripe".
  app.get("/__onboard", async (req, res) => {
    const a = state.accounts.get(String(req.query.account))!;
    a.charges_enabled = true;
    await send("account.updated", a.id, { id: a.id, charges_enabled: true, payouts_enabled: true, details_submitted: true, metadata: a.metadata, business_profile: { name: "Test firm" } });
    res.redirect(302, a.return_url!);
  });

  app.post("/v1/customers", (req, res) => res.json({ id: id("cus") }));

  app.post("/v1/checkout/sessions", (req, res) => {
    const f = form(req) as { customer: string; payment_method_types: Record<string, string>; line_items: Record<string, { price_data: { unit_amount: string } }>; metadata: Record<string, string>; success_url: string; cancel_url: string; payment_intent_data?: { setup_future_usage?: string } };
    const s: Session = {
      id: id("cs_test"), account: String(req.headers["stripe-account"]), customer: f.customer, amount_total: Number(f.line_items["0"].price_data.unit_amount),
      metadata: f.metadata, payment_method_types: Object.values(f.payment_method_types), success_url: f.success_url, cancel_url: f.cancel_url,
      status: "open", payment_status: "unpaid", payment_intent: null, save: f.payment_intent_data?.setup_future_usage === "off_session",
    };
    state.sessions.set(s.id, s);
    res.json({ id: s.id, url: `${base}/__checkout/${s.id}` });
  });
  app.get("/v1/checkout/sessions/:id", (req, res) => {
    const s = state.sessions.get(req.params.id);
    if (!s) { res.status(404).json({ error: { message: "No such session" } }); return; }
    res.json(sessionObj(s));
  });
  // The client paying on "Checkout": a card settles at once; a bank account starts processing.
  app.get("/__checkout/:id", async (req, res) => {
    const s = state.sessions.get(req.params.id)!;
    const ach = s.payment_method_types.includes("us_bank_account");
    const pm = id("pm");
    const pi: Intent = { id: id("pi"), account: s.account, amount: s.amount_total, status: ach ? "processing" : "succeeded", customer: s.customer, payment_method: pm, payment_method_types: s.payment_method_types, setup_future_usage: s.save ? "off_session" : null, metadata: s.metadata };
    state.intents.set(pi.id, pi);
    s.status = "complete";
    s.payment_status = ach ? "unpaid" : "paid";
    s.payment_intent = pi.id;
    if (req.query.webhook !== "skip") await send("checkout.session.completed", s.account, sessionObj(s));
    res.redirect(303, s.success_url.replace("{CHECKOUT_SESSION_ID}", s.id));
  });
  // Days later, the bank payment arrives (or doesn't).
  app.post("/__test/ach-settle", async (req, res) => {
    const b = JSON.parse(String(req.body));
    const s = state.sessions.get(b.session)!;
    const ok = b.ok !== false;
    if (ok) s.payment_status = "paid";
    state.intents.get(s.payment_intent!)!.status = ok ? "succeeded" : "requires_payment_method";
    await send(ok ? "checkout.session.async_payment_succeeded" : "checkout.session.async_payment_failed", s.account, sessionObj(s));
    res.json({ ok: true });
  });

  app.get("/v1/payment_intents/:id", (req, res) => {
    const pi = state.intents.get(req.params.id)!;
    const ach = pi.payment_method_types.includes("us_bank_account");
    res.json({
      id: pi.id, status: pi.status, customer: pi.customer, setup_future_usage: pi.setup_future_usage, payment_method_types: pi.payment_method_types, metadata: pi.metadata,
      payment_method: { id: pi.payment_method, type: ach ? "us_bank_account" : "card", ...(ach ? { us_bank_account: { bank_name: "STRIPE TEST BANK", last4: "6789" } } : { card: { brand: "visa", last4: "4242" } }) },
    });
  });
  app.post("/v1/payment_intents", (req, res) => {
    const f = form(req) as { amount: string; customer: string; payment_method: string; payment_method_types: Record<string, string>; metadata: Record<string, string> };
    const types = Object.values(f.payment_method_types);
    if (f.payment_method === "pm_declined") { res.status(402).json({ error: { code: "card_declined", message: "Your card was declined." } }); return; }
    const pi: Intent = { id: id("pi"), account: String(req.headers["stripe-account"]), amount: Number(f.amount), status: types.includes("us_bank_account") ? "processing" : "succeeded", customer: f.customer, payment_method: f.payment_method, payment_method_types: types, setup_future_usage: null, metadata: f.metadata };
    state.intents.set(pi.id, pi);
    res.json({ id: pi.id, status: pi.status });
  });
  app.post("/__test/intent-settle", async (req, res) => {
    const b = JSON.parse(String(req.body));
    const pi = state.intents.get(b.id)!;
    const ok = b.ok !== false;
    pi.status = ok ? "succeeded" : "requires_payment_method";
    await send(ok ? "payment_intent.succeeded" : "payment_intent.payment_failed", pi.account, { id: pi.id, metadata: pi.metadata, last_payment_error: ok ? null : { message: "The bank account couldn't be debited." } });
    res.json({ ok: true });
  });

  // Postmark
  app.post("/email", (req, res) => {
    if (req.headers["x-postmark-server-token"] !== "postmark-test-token") { res.status(401).json({ ErrorCode: 10, Message: "Bad token" }); return; }
    const m = JSON.parse(String(req.body));
    state.emails.push(m);
    res.json({ ErrorCode: 0, MessageID: id("pm-msg"), Message: "OK" });
  });

  app.get("/__test/state", (_req, res) => res.json({ emails: state.emails.map((e) => ({ ...e, Attachments: ((e.Attachments as { Name: string }[]) ?? []).map((a) => a.Name) })), sessions: [...state.sessions.values()], intents: [...state.intents.values()], requests: state.requests }));
  app.post("/__test/webhook", (req, res) => { webhook = JSON.parse(String(req.body)).url; res.json({ ok: true }); });

  const server = app.listen(port);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: base, server, state, setWebhook: (u) => { webhook = u; }, close: () => new Promise((r) => server.close(() => r())) };
}

if (process.argv[1] && /fake-stripe[\\/]server\.ts$/.test(process.argv[1])) {
  void startFakeStripe(Number(process.env.PORT || 3198)).then((f) => {
    if (process.env.WEBHOOK_URL) f.setWebhook(process.env.WEBHOOK_URL);
    console.log(`Fake Stripe and Postmark on ${f.url}`);
  });
}
