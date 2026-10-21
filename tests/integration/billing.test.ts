// Delivery 9a: billing. Invoices drafted from decided Assessor and BOR reductions (with the
// fee to the penny), editing drafts, numbering, sending with and without email, the client's
// pay page, Stripe Connect onboarding, card and ACH payments through Checkout and webhooks
// (ACH processing, settling and failing), saved methods, statements that replace their
// invoices' links, checks for the full amount only, voids, the decisions link, and cross-firm
// and support-access lockouts. Real server and Postgres; stand-in Stripe and Postmark.

import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, call, login, startTestEnv, stopTestEnv, type TestEnv } from "./helpers";
import { letters, textPdf } from "./letters";
import { startFakeStripe, FAKE_STRIPE_KEY, FAKE_WEBHOOK_SECRET, type FakeStripe } from "../fake-stripe/server";
import { netTax, feeAmount, centsToString, toCents } from "../../shared/money";

let env: TestEnv;
let fake: FakeStripe;
let dillon = "";
let julie = "";
let olivia = "";
const ENV_KEYS = ["STRIPE_SECRET_KEY", "STRIPE_API_URL", "STRIPE_WEBHOOK_SECRET", "POSTMARK_SERVER_TOKEN", "POSTMARK_FROM", "POSTMARK_API_URL", "TOKEN_ENCRYPTION_KEY", "PUBLIC_BASE_URL"];

const get = (cookie: string, url: string) => call(env.base, cookie, "GET", url);
const post = (cookie: string, url: string, body: unknown = {}) => call(env.base, cookie, "POST", url, body);
async function sys<T>(fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const { withContext } = await import("../../server/db");
  return withContext({ actorKind: "system", userId: null, firmId: env.nicholsId }, fn);
}
const fakeState = async () => (await (await fetch(`${fake.url}/__test/state`)).json()) as { emails: Record<string, unknown>[]; sessions: { id: string }[]; intents: { id: string; status: string }[] };
const tokenOf = (link: string) => link.split("/pay/")[1];
const pay = (token: string, q = "") => fetch(`${env.base}/api/pay/${token}${q}`).then(async (r) => ({ status: r.status, body: await r.json() }));

/** A new client and property in tax code 23008 with a decided 2026 BOR reduction (AV 100,000 to 90,000), so the tax math is real. */
async function decidedBor(name: string, address: string, opts: { email?: string; level?: "bor" | "assessor" } = {}) {
  const geo = (await get(dillon, "/api/reference/counties")).body;
  const cook = geo.counties.find((c: { name: string }) => c.name === "Cook").id;
  const nt = geo.townships.find((t: { name: string }) => t.name === "New Trier").id;
  const p = await post(dillon, "/api/firm/properties", {
    newAccount: { name, accountType: "individual" }, address1: address, city: "Winnetka", countyId: cook, townshipId: nt, taxCode: "23008",
    assetType: "residential", pin: `05-17-${String(300 + Math.floor(Math.random() * 600)).padStart(3, "0")}-${String(Math.floor(Math.random() * 999)).padStart(3, "0")}-0000`,
    firstAppeal: { assessmentYear: 2026, level: opts.level ?? "bor" },
  });
  expect(p.status).toBe(201);
  const d = (await get(dillon, `/api/firm/properties/${p.body.id}`)).body;
  const appeal = d.appeals[0];
  await call(env.base, dillon, "PATCH", `/api/firm/appeals/${appeal.id}`, { original: { total: "100000" }, target: { total: "88000" } });
  if (opts.email) await post(dillon, "/api/firm/contacts", { accountId: d.property.account_id, name: `${name} billing`, role: "billing", email: opts.email });
  return { propertyId: p.body.id as number, appealId: appeal.id as number, accountId: d.property.account_id as number };
}
async function decide(appealId: number) {
  const r = await call(env.base, dillon, "PATCH", `/api/firm/appeals/${appealId}`, { resolved: { total: "90000" }, status: "reduced", substage: "decision_analysis" });
  expect(r.status).toBe(200);
  return r.body.appeal;
}

beforeAll(async () => {
  env = await startTestEnv();
  fake = await startFakeStripe();
  fake.setWebhook(`${env.base}/api/stripe/webhook`);
  Object.assign(process.env, {
    STRIPE_SECRET_KEY: FAKE_STRIPE_KEY, STRIPE_API_URL: fake.url, STRIPE_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
    POSTMARK_SERVER_TOKEN: "postmark-test-token", POSTMARK_FROM: "billing@appealeyeq.test", POSTMARK_API_URL: fake.url,
    TOKEN_ENCRYPTION_KEY: "test-encryption-key-that-is-long-enough-123", PUBLIC_BASE_URL: env.base,
  });
  dillon = await login(env.base, "dillon@nicholslaw.example");
  julie = await login(env.base, "julie@nicholslaw.example");
  olivia = await login(env.base, "olivia@otherfirm.example");
}, 120000);

afterAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  await fake?.close();
  await stopTestEnv(env);
});

let a1: Awaited<ReturnType<typeof decidedBor>>;
let inv1 = 0;
let link1 = "";
let expectedFee = "";

describe("drafting", () => {
  it("lists a decided BOR reduction as ready to bill, with the fee to the penny, and drafts it", async () => {
    a1 = await decidedBor("Ashby, Claire", "10 Elm Ct.", { email: "claire@example.test" });
    expect((await get(dillon, "/api/firm/billing")).body.ready.find((r: { appealId: number }) => r.appealId === a1.appealId)).toBeUndefined();
    const ap = await decide(a1.appealId);
    const savings = centsToString(toCents(netTax("100000", ap.equalizer, ap.tax_rate_percent)) - toCents(netTax("90000", ap.equalizer, ap.tax_rate_percent)));
    expect(ap.savings).toBe(savings);
    expectedFee = feeAmount(savings, "40.00");
    const b = (await get(dillon, "/api/firm/billing")).body;
    const row = b.ready.find((r: { appealId: number }) => r.appealId === a1.appealId);
    expect(row).toMatchObject({ fee: expectedFee, year: 2026, level: "bor" });
    expect(row.description).toBe(`Board of Review appeal, 2026 assessment year: 40.00% of first-year tax savings of $${Number(savings).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
    const d = await post(dillon, "/api/firm/billing/draft", { appealIds: [a1.appealId] });
    expect(d.body.drafted).toHaveLength(1);
    inv1 = d.body.drafted[0];
    const inv = (await get(dillon, `/api/firm/billing/invoices/${inv1}`)).body;
    expect(inv).toMatchObject({ status: "draft", number: null, total: expectedFee, suggestedTo: ["claire@example.test"] });
    expect((await post(dillon, "/api/firm/billing/draft", { appealIds: [a1.appealId] })).body.skipped[0].reason).toBe("This appeal already has an invoice.");
  });

  it("no fee for a no-fee property, nothing for PTAB, and a fee cap holds", async () => {
    const tower = (await get(dillon, "/api/firm/properties")).body.properties.find((p: { address1: string }) => p.address1 === "1044 Tower Road");
    const towerBor = (await get(dillon, `/api/firm/properties/${tower.id}`)).body.appeals.find((a: { assessment_year: number; level: string }) => a.assessment_year === 2025 && a.level === "bor");
    expect((await post(dillon, `/api/firm/billing/appeals/${towerBor.id}/invoice`)).body.error).toBe("No fee for this property or client.");
    const capped = await decidedBor("Cap, Ada", "12 Elm Ct.");
    await call(env.base, dillon, "PATCH", `/api/firm/accounts/${capped.accountId}`, { feeCap: "100" });
    await decide(capped.appealId);
    const inv = (await post(dillon, `/api/firm/billing/appeals/${capped.appealId}/invoice`)).body;
    expect(inv.total).toBe("100.00");
    expect(inv.lines[0].description).toContain("capped at $100.00");
    expect((await call(env.base, dillon, "DELETE", `/api/firm/billing/invoices/${inv.id}`)).status).toBe(200);
  });

  it("edits a draft: extra lines add up; changing the fee needs the fee permission", async () => {
    const cur = (await get(dillon, `/api/firm/billing/invoices/${inv1}`)).body;
    const fee = cur.lines[0];
    await sys((c) => c.query(`UPDATE role_permissions SET allowed = false WHERE firm_id = $1 AND role = 'analyst' AND permission = 'fees.edit'`, [env.nicholsId]));
    const refused = await call(env.base, julie, "PATCH", `/api/firm/billing/invoices/${inv1}`, { lines: [{ id: fee.id, description: fee.description, amount: "1.00" }] });
    expect(refused.status).toBe(403);
    const ok = await call(env.base, julie, "PATCH", `/api/firm/billing/invoices/${inv1}`, { lines: [{ id: fee.id, description: fee.description, amount: fee.amount }, { description: "Appraisal fronted for the client", amount: "$350" }] });
    expect(ok.status).toBe(200);
    expect(ok.body.total).toBe(centsToString(toCents(expectedFee) + 35000n));
    await sys((c) => c.query(`UPDATE role_permissions SET allowed = true WHERE firm_id = $1 AND role = 'analyst' AND permission = 'fees.edit'`, [env.nicholsId]));
    const back = await call(env.base, dillon, "PATCH", `/api/firm/billing/invoices/${inv1}`, { lines: [{ id: fee.id, description: fee.description, amount: fee.amount }] });
    expect(back.body.total).toBe(expectedFee);
  });
});

describe("sending", () => {
  it("without email set up: the invoice still goes out with its number, a pay link to copy, and the appeal moves to Invoice sent", async () => {
    const token = process.env.POSTMARK_SERVER_TOKEN;
    delete process.env.POSTMARK_SERVER_TOKEN;
    const r = await post(dillon, `/api/firm/billing/invoices/${inv1}/send`, { to: ["claire@example.test"], email: true });
    process.env.POSTMARK_SERVER_TOKEN = token;
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ emailed: false, emailError: "Email isn't set up on this server, so nothing was emailed. Copy the pay link instead." });
    expect(r.body.invoice).toMatchObject({ status: "sent", number: "NL-2026-0001", issuedOn: "2026-10-19", dueOn: "2026-11-18" });
    link1 = r.body.link;
    expect(link1).toMatch(new RegExp(`^${env.base}/pay/[A-Za-z0-9_-]{40,}$`));
    const ap = (await get(dillon, `/api/firm/properties/${a1.propertyId}`)).body.appeals[0];
    expect(ap.substage).toBe("invoice_sent");
    // The same link can be copied again later.
    expect((await post(dillon, `/api/firm/billing/invoices/${inv1}/link`)).body.link).toBe(link1);
  });

  it("with email: Postmark gets the invoice with its PDF, from the firm, replying to the sender", async () => {
    const b = await decidedBor("Bell, Owen", "14 Elm Ct.", { email: "owen@example.test" });
    await decide(b.appealId);
    const inv = (await post(dillon, `/api/firm/billing/appeals/${b.appealId}/invoice`)).body;
    const r = await post(dillon, `/api/firm/billing/invoices/${inv.id}/send`, { to: inv.suggestedTo, email: true });
    expect(r.body).toMatchObject({ emailed: true, emailError: null });
    expect(r.body.invoice.number).toBe("NL-2026-0002");
    const mail = (await fakeState()).emails.at(-1)!;
    expect(mail).toMatchObject({ To: "owen@example.test", Subject: "Invoice NL-2026-0002 from Nichols Law", ReplyTo: "dillon@nicholslaw.example", From: '"Nichols Law" <billing@appealeyeq.test>', Attachments: ["NL-2026-0002.pdf"] });
    expect(String(mail.TextBody)).toContain(r.body.link);
    expect(r.body.invoice.emails[0]).toMatchObject({ status: "sent", to_addresses: ["owen@example.test"] });
    const pdf = await fetch(`${env.base}/api/firm/billing/invoices/${inv.id}/pdf`, { headers: { Cookie: dillon } });
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("the pay page shows the bill without signing in; online payment waits for the firm's Stripe account", async () => {
    const p = await pay(tokenOf(link1));
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ firm: { name: "Nichols Law" }, client: "Ashby, Claire", kind: "invoice", number: "NL-2026-0001", total: expectedFee, state: "payable", online: false });
    expect(p.body.items[0].matter).toContain("10 Elm Ct., Winnetka (New Trier)");
    const co = await fetch(`${env.base}/api/pay/${tokenOf(link1)}/checkout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "card" }) });
    expect(co.status).toBe(409);
    expect((await pay("not-a-real-token-at-all-aaaaaaaaaaaaaaaaaaaaaa")).status).toBe(404);
  });
});

describe("Stripe", () => {
  it("a firm admin connects the firm's own Stripe account; others can't", async () => {
    expect((await post(julie, "/api/firm/billing/stripe/connect")).status).toBe(403);
    const r = await post(dillon, "/api/firm/billing/stripe/connect");
    expect(r.status).toBe(200);
    const onboard = await fetch(r.body.url, { redirect: "manual" });
    expect(onboard.headers.get("location")).toBe(`${env.base}/api/firm/billing/stripe/return`);
    const back = await fetch(onboard.headers.get("location")!, { redirect: "manual", headers: { Cookie: dillon } });
    expect(back.headers.get("location")).toBe("/settings?tab=billing&stripe=back");
    const s = (await get(dillon, "/api/firm/billing/settings")).body;
    expect(s.stripe).toMatchObject({ charges_enabled: true, payouts_enabled: true });
    expect((await pay(tokenOf(link1))).body.online).toBe(true);
  });

  it("pays by card on Checkout: the invoice is paid, the card is saved for next time, and the link closes", async () => {
    const co = await fetch(`${env.base}/api/pay/${tokenOf(link1)}/checkout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "card", save: true }) });
    const { url } = await co.json();
    const done = await fetch(url, { redirect: "manual" });
    expect(done.headers.get("location")).toMatch(/\/pay\/.+\?status=done&session=cs_test_/);
    const inv = (await get(dillon, `/api/firm/billing/invoices/${inv1}`)).body;
    expect(inv).toMatchObject({ status: "paid", savedMethod: "Visa ending 4242" });
    expect(inv.payments[0]).toMatchObject({ method: "card", status: "succeeded", amount: expectedFee });
    expect((await pay(tokenOf(link1))).body).toMatchObject({ state: "paid" });
    // The session was made on the firm's own account, not the platform's.
    const acct = (await get(dillon, "/api/firm/billing/settings")).body.stripe.stripe_account_id;
    expect(fake.state.requests.filter((x) => x.startsWith("POST /checkout/sessions"))).toEqual([`POST /checkout/sessions ${acct}`]);
  });

  it("settles from the return trip even if the webhook hasn't arrived", async () => {
    const b = await decidedBor("Cole, Ruth", "16 Elm Ct.");
    await decide(b.appealId);
    const inv = (await post(dillon, `/api/firm/billing/appeals/${b.appealId}/invoice`)).body;
    const link = (await post(dillon, `/api/firm/billing/invoices/${inv.id}/send`, { to: [], email: false })).body.link;
    const { url } = await (await fetch(`${env.base}/api/pay/${tokenOf(link)}/checkout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "card" }) })).json();
    const done = await fetch(`${url}?webhook=skip`, { redirect: "manual" });
    const ret = new URL(done.headers.get("location")!);
    expect((await pay(tokenOf(link), ret.search)).body.state).toBe("paid");
  });

  let achInvoice = 0;
  let achLink = "";
  it("ACH shows Processing for days, blocks a second payment, then settles", async () => {
    const b = await decidedBor("Dunn, Iris", "18 Elm Ct.");
    await decide(b.appealId);
    achInvoice = (await post(dillon, `/api/firm/billing/appeals/${b.appealId}/invoice`)).body.id;
    achLink = (await post(dillon, `/api/firm/billing/invoices/${achInvoice}/send`, { to: [], email: false })).body.link;
    const { url } = await (await fetch(`${env.base}/api/pay/${tokenOf(achLink)}/checkout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "ach" }) })).json();
    await fetch(url, { redirect: "manual" });
    expect((await pay(tokenOf(achLink))).body).toMatchObject({ state: "processing", payment: { status: "processing", method: "ach" } });
    expect((await get(dillon, `/api/firm/billing/invoices/${achInvoice}`)).body).toMatchObject({ status: "sent", blockedReason: "A payment for this invoice is processing." });
    expect((await fetch(`${env.base}/api/pay/${tokenOf(achLink)}/checkout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "card" }) })).status).toBe(409);
    expect((await post(dillon, `/api/firm/billing/invoices/${achInvoice}/void`, { reason: "test" })).status).toBe(409);
    const session = (await fakeState()).sessions.at(-1)!.id;
    await fetch(`${fake.url}/__test/ach-settle`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session, ok: true }) });
    expect((await get(dillon, `/api/firm/billing/invoices/${achInvoice}`)).body.status).toBe("paid");
  });

  it("a failed ACH payment leaves the invoice payable again", async () => {
    const b = await decidedBor("Eads, Nora", "20 Elm Ct.");
    await decide(b.appealId);
    const id = (await post(dillon, `/api/firm/billing/appeals/${b.appealId}/invoice`)).body.id;
    const link = (await post(dillon, `/api/firm/billing/invoices/${id}/send`, { to: [], email: false })).body.link;
    const { url } = await (await fetch(`${env.base}/api/pay/${tokenOf(link)}/checkout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "ach" }) })).json();
    await fetch(url, { redirect: "manual" });
    const session = (await fakeState()).sessions.at(-1)!.id;
    await fetch(`${fake.url}/__test/ach-settle`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session, ok: false }) });
    const inv = (await get(dillon, `/api/firm/billing/invoices/${id}`)).body;
    expect(inv).toMatchObject({ status: "sent", payable: true });
    expect(inv.payments[0]).toMatchObject({ status: "failed", failure_reason: "The bank payment didn't go through." });
    expect((await pay(tokenOf(link))).body.state).toBe("payable");
  });

  it("webhooks: a repeated event does nothing, a bad signature is refused, another firm's account is ignored", async () => {
    const acct = (await get(dillon, "/api/firm/billing/settings")).body.stripe.stripe_account_id;
    const body = JSON.stringify({ id: "evt_fixed_1", type: "account.updated", account: acct, data: { object: { id: acct, charges_enabled: true, payouts_enabled: true, details_submitted: true, metadata: { firm_id: String(env.nicholsId) } } } });
    const sign = (b: string, secret = FAKE_WEBHOOK_SECRET) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${b}`).digest("hex")}`; };
    const send = (b: string, sig: string) => fetch(`${env.base}/api/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": sig }, body: b }).then(async (r) => ({ status: r.status, body: await r.json() }));
    expect((await send(body, sign(body))).body).toEqual({ ok: true });
    expect((await send(body, sign(body))).body).toEqual({ duplicate: true });
    expect((await send(body, sign(body, "whsec_wrong"))).status).toBe(400);
    const other = body.replace("evt_fixed_1", "evt_fixed_2").replace(`"account":"${acct}"`, `"account":"acct_someone_else"`);
    expect((await send(other, sign(other))).body).toEqual({ ignored: true });
  });

  it("charges a client's saved card in one click", async () => {
    const accountId = (await get(dillon, `/api/firm/billing/invoices/${inv1}`)).body.accountId;
    const pid = (await post(dillon, "/api/firm/properties", { accountId, address1: "11 Elm Ct.", city: "Winnetka", countyId: (await get(dillon, "/api/reference/counties")).body.counties.find((c: { name: string }) => c.name === "Cook").id, assetType: "residential", pin: "05-17-399-001-0000" })).body.id;
    void pid;
    const b = await decidedBor("Ashby second", "13 Elm Ct.");
    await decide(b.appealId);
    // Move this appeal's invoice to Claire's account, which has the saved card.
    const id = (await post(dillon, `/api/firm/billing/appeals/${b.appealId}/invoice`)).body.id;
    await sys((c) => c.query(`UPDATE invoices SET account_id = $2 WHERE firm_id = $1 AND id = $3`, [env.nicholsId, accountId, id]));
    await post(dillon, `/api/firm/billing/invoices/${id}/send`, { to: [], email: false });
    const r = await post(dillon, `/api/firm/billing/invoices/${id}/charge`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "succeeded", invoice: { status: "paid" } });
    expect((await post(dillon, `/api/firm/billing/invoices/${achInvoice}/charge`)).body.error).toBe("This invoice is paid.");
  });
});

describe("statements, checks and voids", () => {
  let s1 = 0;
  const two: { id: number; link: string }[] = [];
  let acc = 0;
  it("a statement gathers a client's unpaid invoices; their own links stop working", async () => {
    const b = await decidedBor("Fenn Holdings", "30 Elm Ct.", { email: "ap@fenn.test" });
    await decide(b.appealId);
    acc = b.accountId;
    const first = (await post(dillon, `/api/firm/billing/appeals/${b.appealId}/invoice`)).body.id;
    two.push({ id: first, link: (await post(dillon, `/api/firm/billing/invoices/${first}/send`, { to: [], email: false })).body.link });
    const pid = (await post(dillon, "/api/firm/properties", { accountId: acc, address1: "32 Elm Ct.", city: "Winnetka", countyId: (await get(dillon, "/api/reference/counties")).body.counties.find((c: { name: string }) => c.name === "Cook").id, townshipId: (await get(dillon, "/api/reference/counties")).body.townships.find((t: { name: string }) => t.name === "New Trier").id, taxCode: "23008", assetType: "residential", pin: "05-17-398-002-0000", firstAppeal: { assessmentYear: 2026, level: "bor" } })).body.id;
    const ap2 = (await get(dillon, `/api/firm/properties/${pid}`)).body.appeals[0].id;
    await call(env.base, dillon, "PATCH", `/api/firm/appeals/${ap2}`, { original: { total: "100000" } });
    await decide(ap2);
    const second = (await post(dillon, `/api/firm/billing/appeals/${ap2}/invoice`)).body.id;
    two.push({ id: second, link: (await post(dillon, `/api/firm/billing/invoices/${second}/send`, { to: [], email: false })).body.link });
    expect((await post(dillon, "/api/firm/billing/statements", { accountId: acc, invoiceIds: [first], to: [], email: false })).body.error).toBe("A statement covers two or more invoices.");
    const r = await post(dillon, "/api/firm/billing/statements", { accountId: acc, invoiceIds: two.map((x) => x.id), to: ["ap@fenn.test"], email: true });
    expect(r.status).toBe(201);
    s1 = r.body.statement.id;
    expect(r.body.statement).toMatchObject({ number: "NL-S-2026-0001", status: "open", invoices: 2, total: centsToString(toCents(expectedFee) * 2n) });
    expect((await fakeState()).emails.at(-1)).toMatchObject({ Subject: "Statement NL-S-2026-0001 from Nichols Law", Attachments: ["NL-S-2026-0001.pdf"] });
    for (const x of two) expect((await pay(tokenOf(x.link))).body).toMatchObject({ state: "closed" });
    expect((await post(dillon, `/api/firm/billing/invoices/${first}/payments`, { method: "check", amount: expectedFee, receivedOn: "2026-10-19" })).body.error).toBe("This invoice is on a statement; pay the statement.");
    const sp = await pay(tokenOf(r.body.link));
    expect(sp.body).toMatchObject({ kind: "statement", state: "payable", items: [{}, {}] });
  });

  it("checks are recorded for the full amount only, and paying the statement pays every invoice on it", async () => {
    expect((await post(dillon, `/api/firm/billing/statements/${s1}/payments`, { method: "check", amount: expectedFee, receivedOn: "2026-10-19", checkNumber: "1043" })).body.error)
      .toMatch(/^Payments are for the full amount, \$[\d,]+\.\d{2}\. Partial payments aren't accepted\.$/);
    expect((await post(dillon, `/api/firm/billing/statements/${s1}/payments`, { method: "check", amount: centsToString(toCents(expectedFee) * 2n), receivedOn: "2099-01-01" })).status).toBe(400);
    const ok = await post(dillon, `/api/firm/billing/statements/${s1}/payments`, { method: "check", amount: centsToString(toCents(expectedFee) * 2n), receivedOn: "2026-10-18", checkNumber: "1043" });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe("paid");
    for (const x of two) expect((await get(dillon, `/api/firm/billing/invoices/${x.id}`)).body.status).toBe("paid");
    const alloc = await sys(async (c) => (await c.query(`SELECT count(*)::int AS n FROM payment_allocations WHERE firm_id = $1 AND invoice_id = ANY($2::int[])`, [env.nicholsId, two.map((x) => x.id)])).rows[0].n);
    expect(alloc).toBe(2);
  });

  it("voiding a sent invoice closes its link and puts the appeal back in Decision analysis", async () => {
    const b = await decidedBor("Gale, Hugo", "40 Elm Ct.");
    await decide(b.appealId);
    const id = (await post(dillon, `/api/firm/billing/appeals/${b.appealId}/invoice`)).body.id;
    const link = (await post(dillon, `/api/firm/billing/invoices/${id}/send`, { to: [], email: false })).body.link;
    expect((await post(julie, `/api/firm/billing/invoices/${id}/void`, { reason: "" })).status).toBe(400);
    const v = await post(dillon, `/api/firm/billing/invoices/${id}/void`, { reason: "Billed the wrong client" });
    expect(v.body).toMatchObject({ status: "void", voidReason: "Billed the wrong client" });
    expect((await pay(tokenOf(link))).body.state).toBe("closed");
    expect((await get(dillon, `/api/firm/properties/${b.propertyId}`)).body.appeals[0].substage).toBe("decision_analysis");
    // A replacement can be drafted, and the property can't be deleted while it has a billing record.
    expect((await post(dillon, `/api/firm/billing/appeals/${b.appealId}/invoice`)).status).toBe(201);
    expect((await call(env.base, dillon, "DELETE", `/api/firm/properties/${b.propertyId}`)).body.error).toContain("This property has invoices");
  });
});

describe("decisions draft the invoice", () => {
  it("applying a BOR reduction letter drafts its invoice; undo removes the draft, and is refused once it's sent", async () => {
    const b = await decidedBor("Hale, June", "50 Elm Ct.");
    const pin = (await get(dillon, `/api/firm/properties/${b.propertyId}`)).body.parcels[0].pin;
    const pdf = await textPdf([letters.bor({ pin, complaint: "2690001-001", year: 2026, date: "10/10/2026", orig: "100,000", final: "90,000" })]);
    const res = await fetch(`${env.base}/api/firm/decisions/upload?name=hale.pdf`, { method: "POST", headers: { Cookie: dillon, "Content-Type": "application/octet-stream" }, body: pdf });
    const upId = (await res.json()).upload.id;
    const { decisionQueueIdle } = await import("../../server/decisions/queue");
    await decisionQueueIdle();
    const letter = (await get(dillon, "/api/firm/decisions?view=clean")).body.letters.find((l: { uploadId: number }) => l.uploadId === upId);
    await post(dillon, `/api/firm/decisions/letters/${letter.id}/apply`);
    const draft = (await get(dillon, "/api/firm/billing")).body.drafts.find((d: { appealId: number }) => d.appealId === b.appealId);
    expect(draft).toMatchObject({ status: "draft", total: expectedFee });
    expect((await post(dillon, `/api/firm/decisions/letters/${letter.id}/undo`)).status).toBe(200);
    expect((await get(dillon, "/api/firm/billing")).body.drafts.find((d: { appealId: number }) => d.appealId === b.appealId)).toBeUndefined();
    await post(dillon, `/api/firm/decisions/letters/${letter.id}/apply`);
    const again = (await get(dillon, "/api/firm/billing")).body.drafts.find((d: { appealId: number }) => d.appealId === b.appealId);
    await post(dillon, `/api/firm/billing/invoices/${again.id}/send`, { to: [], email: false });
    expect((await post(dillon, `/api/firm/decisions/letters/${letter.id}/undo`)).body.error).toBe("This appeal's invoice is sent. Void it in Billing before undoing the letter.");
  });
});

describe("isolation", () => {
  it("another firm sees none of it and can't reach an invoice or statement by id", async () => {
    const b = (await get(olivia, "/api/firm/billing")).body;
    expect([b.ready, b.drafts, b.unpaid, b.paid, b.statements]).toEqual([[], [], [], [], []]);
    for (const url of [`/api/firm/billing/invoices/${inv1}`, `/api/firm/billing/statements/1`]) expect((await get(olivia, url)).status).toBe(404);
    expect((await fetch(`${env.base}/api/firm/billing/invoices/${inv1}/pdf`, { headers: { Cookie: olivia } })).status).toBe(404);
    expect((await post(olivia, `/api/firm/billing/invoices/${inv1}/send`, { to: [], email: false })).status).toBe(404);
    expect((await post(olivia, `/api/firm/billing/invoices/${inv1}/payments`, { method: "check", amount: "1", receivedOn: "2026-10-19" })).status).toBe(404);
    expect((await post(olivia, `/api/firm/billing/invoices/${inv1}/link`)).status).toBe(404);
    expect((await post(olivia, "/api/firm/billing/statements", { accountId: 1, invoiceIds: [inv1, inv1 + 1], to: [], email: false })).status).toBe(404);
    expect((await get(olivia, "/api/firm/billing/settings")).body.stripe).toBeNull();
    expect((await get(olivia, `/api/firm/billing/properties/${a1.propertyId}`)).body).toEqual({ invoices: [], ready: [], needs: [], expenses: [], settlements: [], appeals: [], receipts: [] });
    expect((await get(olivia, `/api/firm/billing/accounts/${a1.accountId}/open`)).body).toMatchObject({ invoices: [], statements: [], all: [], suggestedTo: [] });
    expect((await get(dillon, `/api/firm/billing/properties/${a1.propertyId}`)).body.invoices[0]).toMatchObject({ id: inv1, number: "NL-2026-0001" });
  });

  it("support access can look but not send, charge or change settings", async () => {
    await post(dillon, "/api/firm/support-grants", { hours: 2, reason: "Billing check" });
    const admin = await login(env.base, ADMIN.email, ADMIN.password);
    await post(admin, `/api/admin/firms/${env.nicholsId}/enter`);
    expect((await get(admin, "/api/firm/billing")).status).toBe(200);
    expect((await post(admin, "/api/firm/billing/draft", {})).status).toBe(403);
    expect((await call(env.base, admin, "PUT", "/api/firm/billing/settings", { paymentTermsDays: 10 })).status).toBe(403);
  });

  it("settings: firm admins only; the prefix numbers new invoices", async () => {
    expect((await call(env.base, julie, "PUT", "/api/firm/billing/settings", { invoicePrefix: "XX" })).status).toBe(403);
    expect((await call(env.base, dillon, "PUT", "/api/firm/billing/settings", { invoicePrefix: "nlaw", paymentTermsDays: 15, letterheadAddress: "100 N. Sample St., Chicago, IL 60600" })).status).toBe(200);
    const b = await decidedBor("Ives, Kai", "60 Elm Ct.");
    await decide(b.appealId);
    const id = (await post(dillon, `/api/firm/billing/appeals/${b.appealId}/invoice`)).body.id;
    const sent = (await post(dillon, `/api/firm/billing/invoices/${id}/send`, { to: [], email: false })).body.invoice;
    expect(sent.number).toMatch(/^NLAW-2026-\d{4}$/);
    expect(sent.dueOn).toBe("2026-11-03");
  });

  it("the sample firm resets cleanly with billing records in it", async () => {
    expect((await post(dillon, "/api/firm/sample/reset")).status).toBe(200);
    const b = (await get(dillon, "/api/firm/billing")).body;
    expect([b.drafts, b.unpaid, b.paid, b.statements]).toEqual([[], [], [], []]);
  });
});
