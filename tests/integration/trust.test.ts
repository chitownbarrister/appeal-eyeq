// Delivery 9b: refunds into trust and out to the client, expenses the firm fronts, the trust
// ledger, appeals taken off Ready to bill, Needs tax figures, the dashboard agreeing with
// Billing, and the accounting journal. Real server and Postgres; stand-in Postmark.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, call, login, startTestEnv, stopTestEnv, type TestEnv } from "./helpers";
import { startFakeStripe, type FakeStripe } from "../fake-stripe/server";

let env: TestEnv;
let fake: FakeStripe;
let dillon = "";
let julie = "";
let olivia = "";
const get = (cookie: string, url: string) => call(env.base, cookie, "GET", url);
const post = (cookie: string, url: string, body: unknown = {}) => call(env.base, cookie, "POST", url, body);
const patch = (cookie: string, url: string, body: unknown) => call(env.base, cookie, "PATCH", url, body);
async function sys<T>(fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const { withContext } = await import("../../server/db");
  return withContext({ actorKind: "system", userId: null, firmId: env.nicholsId }, fn);
}

/** A client and property with a PTAB appeal decided Reduced and Awaiting refund. */
async function ptabAwaiting(name: string, address: string, pin: string) {
  const geo = (await get(dillon, "/api/reference/counties")).body;
  const cook = geo.counties.find((c: { name: string }) => c.name === "Cook").id;
  const p = await post(dillon, "/api/firm/properties", { newAccount: { name, accountType: "entity" }, address1: address, city: "Chicago", countyId: cook, assetType: "commercial", pin, firstAppeal: { assessmentYear: 2024, level: "ptab" } });
  expect(p.status).toBe(201);
  const d = (await get(dillon, `/api/firm/properties/${p.body.id}`)).body;
  const appealId = d.appeals[0].id as number;
  await sys((c) => c.query(`UPDATE appeals SET status = 'reduced', substage = 'decision_analysis', refund_status = 'awaiting', refund_expected = 11500 WHERE firm_id = $1 AND id = $2`, [env.nicholsId, appealId]));
  return { propertyId: p.body.id as number, appealId, accountId: d.property.account_id as number };
}

beforeAll(async () => {
  env = await startTestEnv();
  fake = await startFakeStripe();
  Object.assign(process.env, { POSTMARK_SERVER_TOKEN: "postmark-test-token", POSTMARK_FROM: "billing@appealeyeq.test", POSTMARK_API_URL: fake.url });
  dillon = await login(env.base, "dillon@nicholslaw.example");
  julie = await login(env.base, "julie@nicholslaw.example");
  olivia = await login(env.base, "olivia@otherfirm.example");
}, 120000);

afterAll(async () => {
  for (const k of ["POSTMARK_SERVER_TOKEN", "POSTMARK_FROM", "POSTMARK_API_URL"]) delete process.env[k];
  await fake?.close();
  await stopTestEnv(env);
});

let m: Awaited<ReturnType<typeof ptabAwaiting>>;
let s1 = 0;
let appraisal = 0;

describe("expenses the firm fronts", () => {
  it("records an expense on the property; it's open until recovered", async () => {
    m = await ptabAwaiting("Harbor Point LLC", "500 W. Lake St.", "17-09-300-001-0000");
    const bad = await post(dillon, "/api/firm/expenses", { propertyId: m.propertyId, incurredOn: "2099-01-01", vendor: "X", description: "Y", amount: "10", recovery: "refund" });
    expect(bad.body.error).toBe("The date can't be in the future.");
    const r = await post(dillon, "/api/firm/expenses", { propertyId: m.propertyId, appealId: m.appealId, incurredOn: "2025-03-04", vendor: "Lakeside Appraisal", description: "Appraisal for the PTAB hearing", amount: "$350.00", recovery: "refund" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ amount: "350.00", state: "open", recovery: "refund", appeal: "2024 PTAB", client: "Harbor Point LLC" });
    appraisal = r.body.id;
    // A second one bigger than the refund can absorb after the fee stays out of the settlement.
    expect((await post(dillon, "/api/firm/expenses", { propertyId: m.propertyId, incurredOn: "2025-03-05", vendor: "Big Survey Co", description: "Survey", amount: "9000", recovery: "refund" })).status).toBe(201);
  });
});

describe("a refund into trust and out to the client", () => {
  it("recording the refund check deposits it in trust and drafts the settlement: fee, fronted expenses, the client's share", async () => {
    const r = await post(dillon, `/api/firm/decisions/refunds/${m.appealId}`, { receivedOn: "2026-10-15", amount: "12,000.00" });
    expect(r.status).toBe(200);
    s1 = r.body.settlementId;
    const s = (await get(dillon, `/api/firm/trust/settlements/${s1}`)).body;
    // 33.33% of 12,000.00 = 3,999.60; the 350.00 appraisal fits, the 9,000.00 survey doesn't.
    expect(s).toMatchObject({ status: "draft", refund: "12000.00", fee: "3999.60", expenses: "350.00", toClient: "7650.40", client: "Harbor Point LLC", appeal: "2024 PTAB" });
    expect(s.feeBasis).toMatchObject({ percent: "33.33", source: "firm" });
    expect(s.expenseList.map((e: { vendor: string; included: boolean }) => [e.vendor, e.included])).toEqual([["Big Survey Co", false], ["Lakeside Appraisal", true]]);
    const led = (await get(dillon, `/api/firm/trust/accounts/${m.accountId}`)).body;
    expect(led.balance).toBe("12000.00");
    expect(led.entries).toHaveLength(1);
    expect(led.entries[0]).toMatchObject({ kind: "deposit", amount: "12000.00", entryOn: "2026-10-15", memo: "Refund check, 2024 PTAB" });
    expect((await get(dillon, `/api/firm/expenses?propertyId=${m.propertyId}`)).body.expenses.find((e: { id: number }) => e.id === appraisal).state).toBe("in_settlement");
  });

  it("the draft can change: expenses in or out, the fee only with the fee permission, never past the refund", async () => {
    const big = (await get(dillon, `/api/firm/trust/settlements/${s1}`)).body.expenseList.find((e: { vendor: string }) => e.vendor === "Big Survey Co").id;
    expect((await patch(dillon, `/api/firm/trust/settlements/${s1}`, { expenseIds: [appraisal, big] })).body.error).toBe("The fee and expenses can't add up to more than the refund.");
    await sys((c) => c.query(`UPDATE role_permissions SET allowed = false WHERE firm_id = $1 AND role = 'analyst' AND permission = 'fees.edit'`, [env.nicholsId]));
    expect((await patch(julie, `/api/firm/trust/settlements/${s1}`, { feeAmount: "3500" })).status).toBe(403);
    await sys((c) => c.query(`UPDATE role_permissions SET allowed = true WHERE firm_id = $1 AND role = 'analyst' AND permission = 'fees.edit'`, [env.nicholsId]));
    const out = await patch(julie, `/api/firm/trust/settlements/${s1}`, { expenseIds: [], note: "Appraisal billed separately." });
    expect(out.body).toMatchObject({ expenses: "0.00", toClient: "8000.40", note: "Appraisal billed separately." });
    const back = await patch(julie, `/api/firm/trust/settlements/${s1}`, { expenseIds: [appraisal], note: null });
    expect(back.body).toMatchObject({ expenses: "350.00", toClient: "7650.40" });
  });

  it("only someone allowed to approve trust payouts approves; nothing is paid before approval", async () => {
    expect((await post(dillon, `/api/firm/trust/settlements/${s1}/pay`, { method: "check", reference: "5001", paidOn: "2026-10-19" })).body.error).toBe("An attorney approves the settlement before it's paid.");
    expect((await post(julie, `/api/firm/trust/settlements/${s1}/approve`)).status).toBe(403);
    const ok = await post(dillon, `/api/firm/trust/settlements/${s1}/approve`);
    expect(ok.body).toMatchObject({ status: "approved", approvedBy: "Dillon Nichols" });
    expect((await patch(dillon, `/api/firm/trust/settlements/${s1}`, { note: "x" })).body.error).toBe("Only a draft settlement can be changed. Void it to start over.");
    // Taking the refund back isn't allowed once approved.
    expect((await call(env.base, dillon, "DELETE", `/api/firm/decisions/refunds/${m.appealId}`)).body.error).toBe("This refund's settlement is approved. Void the settlement in Billing, Trust first.");
  });

  it("the payout needs a check number, a real date, and enough in trust", async () => {
    expect((await post(julie, `/api/firm/trust/settlements/${s1}/pay`, { method: "check", paidOn: "2026-10-19" })).body.error).toBe("Give the check number.");
    expect((await post(julie, `/api/firm/trust/settlements/${s1}/pay`, { method: "check", reference: "5001", paidOn: "2026-10-01" })).body.error).toBe("The payout can't be dated before the refund arrived.");
    expect((await post(julie, `/api/firm/trust/settlements/${s1}/pay`, { method: "check", reference: "5001", paidOn: "2099-01-01" })).body.error).toBe("The payout date can't be in the future.");
    // With the deposit gone (as if it had been spent), the balance check refuses.
    const dep = await sys(async (c) => (await c.query(`SELECT id FROM trust_entries WHERE firm_id = $1 AND appeal_id = $2 AND kind = 'deposit'`, [env.nicholsId, m.appealId])).rows[0].id);
    await sys((c) => c.query(`UPDATE trust_entries SET amount = 100 WHERE firm_id = $1 AND id = $2`, [env.nicholsId, dep]));
    expect((await post(julie, `/api/firm/trust/settlements/${s1}/pay`, { method: "check", reference: "5001", paidOn: "2026-10-19" })).body.error).toBe("The client's trust balance is $100.00, less than this settlement's $12,000.00.");
    await sys((c) => c.query(`UPDATE trust_entries SET amount = 12000 WHERE firm_id = $1 AND id = $2`, [env.nicholsId, dep]));
  });

  it("paying moves the fee and expenses out, pays the client, and leaves the client's trust balance at zero", async () => {
    const r = await post(julie, `/api/firm/trust/settlements/${s1}/pay`, { method: "check", reference: "5001", paidOn: "2026-10-19" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "paid", paidOn: "2026-10-19", payoutMethod: "check", payoutReference: "5001" });
    const led = (await get(dillon, `/api/firm/trust/accounts/${m.accountId}`)).body;
    expect(led.entries.map((e: { kind: string; amount: string; balance: string }) => [e.kind, e.amount, e.balance])).toEqual([
      ["deposit", "12000.00", "12000.00"], ["fee", "-3999.60", "8000.40"], ["expenses", "-350.00", "7650.40"], ["payout", "-7650.40", "0.00"],
    ]);
    expect((await get(dillon, `/api/firm/expenses?propertyId=${m.propertyId}`)).body.expenses.find((e: { id: number }) => e.id === appraisal).state).toBe("recovered");
    expect((await post(dillon, `/api/firm/trust/settlements/${s1}/void`, { reason: "x" })).body.error).toBe("A paid settlement can't be voided: the money has left trust.");
    const t = (await get(dillon, "/api/firm/trust")).body;
    expect(t.balances.find((b: { accountId: number }) => b.accountId === m.accountId)).toBeUndefined();
    expect(t.paid.map((x: { id: number }) => x.id)).toContain(s1);
  });

  it("the settlement letter and its email", async () => {
    const pdf = await fetch(`${env.base}/api/firm/trust/settlements/${s1}/letter`, { headers: { Cookie: dillon } });
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    const e = await post(dillon, `/api/firm/trust/settlements/${s1}/email`, { to: ["ap@harbor.test"] });
    expect(e.body).toEqual({ emailed: true, emailError: null });
    const mail = (await (await fetch(`${fake.url}/__test/state`)).json()).emails.at(-1);
    expect(mail).toMatchObject({ To: "ap@harbor.test", Subject: "Your 2024 PTAB refund from Nichols Law", Attachments: ["Refund settlement 2024 PTAB.pdf"] });
  });
});

describe("a PTAB reduction entered by hand", () => {
  it("waits for its refund like one applied from a letter, and stops waiting if the reduction is taken away", async () => {
    const geo = (await get(dillon, "/api/reference/counties")).body;
    const p = await post(dillon, "/api/firm/properties", { newAccount: { name: "Hand Entered LLC", accountType: "entity" }, address1: "800 W. Canal St.", city: "Chicago", countyId: geo.counties.find((c: { name: string }) => c.name === "Cook").id, assetType: "commercial", pin: "17-09-300-009-0000", firstAppeal: { assessmentYear: 2024, level: "ptab" } });
    const aid = (await get(dillon, `/api/firm/properties/${p.body.id}`)).body.appeals[0].id;
    expect((await patch(dillon, `/api/firm/appeals/${aid}`, { status: "reduced" })).body.appeal).toMatchObject({ refund_status: "awaiting" });
    expect((await get(dillon, "/api/firm/decisions/refunds")).body.refunds.some((r: { appealId: number }) => r.appealId === aid)).toBe(true);
    expect((await patch(dillon, `/api/firm/appeals/${aid}`, { status: "no_change" })).body.appeal).toMatchObject({ refund_status: null });
    await patch(dillon, `/api/firm/appeals/${aid}`, { status: "reduced" });
    await post(dillon, `/api/firm/decisions/refunds/${aid}`, { receivedOn: "2026-10-16", amount: "900" });
    // Once the check is in, changing the status doesn't drop the refund.
    expect((await patch(dillon, `/api/firm/appeals/${aid}`, { status: "no_change" })).body.appeal).toMatchObject({ refund_status: "received" });
  });
});

describe("voids, corrections and taking a refund back", () => {
  let m2: Awaited<ReturnType<typeof ptabAwaiting>>;
  it("a corrected refund amount replaces the draft; voiding frees its expenses; a new draft can be made", async () => {
    m2 = await ptabAwaiting("Canal Yards LP", "600 W. Canal St.", "17-09-300-002-0000");
    const exp = (await post(dillon, "/api/firm/expenses", { propertyId: m2.propertyId, incurredOn: "2025-06-01", vendor: "Court reporter", description: "Transcript", amount: "120", recovery: "refund" })).body.id;
    const a = (await post(dillon, `/api/firm/decisions/refunds/${m2.appealId}`, { receivedOn: "2026-10-16", amount: "3000" })).body.settlementId;
    const b = (await post(dillon, `/api/firm/decisions/refunds/${m2.appealId}`, { receivedOn: "2026-10-16", amount: "3,300" })).body.settlementId;
    expect(b).not.toBe(a);
    expect((await get(dillon, `/api/firm/trust/settlements/${a}`)).status).toBe(404);
    expect((await get(dillon, `/api/firm/trust/accounts/${m2.accountId}`)).body.balance).toBe("3300.00");
    expect((await get(dillon, `/api/firm/trust/settlements/${b}`)).body).toMatchObject({ refund: "3300.00", fee: "1099.89", expenses: "120.00", toClient: "2080.11" });
    expect((await post(julie, `/api/firm/trust/settlements/${b}/void`, { reason: "Wrong fee" })).status).toBe(403);
    expect((await post(dillon, `/api/firm/trust/settlements/${b}/void`, { reason: "Wrong fee" })).body.status).toBe("void");
    expect((await get(dillon, `/api/firm/expenses?propertyId=${m2.propertyId}`)).body.expenses[0]).toMatchObject({ id: exp, state: "open" });
    expect((await get(dillon, "/api/firm/trust")).body.unsettled.map((u: { appealId: number }) => u.appealId)).toContain(m2.appealId);
    const c = await post(dillon, `/api/firm/trust/appeals/${m2.appealId}/settlement`);
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ status: "draft", toClient: "2080.11" });
  });

  it("taking a draft refund back removes the deposit and the draft; the appeal can't be deleted while trust holds its refund", async () => {
    expect((await call(env.base, dillon, "DELETE", `/api/firm/appeals/${m2.appealId}`)).body.error).toBe("This appeal has a refund recorded in trust. Take the refund back on Decisions, Awaiting refund first.");
    expect((await call(env.base, dillon, "DELETE", `/api/firm/decisions/refunds/${m2.appealId}`)).status).toBe(200);
    expect((await get(dillon, `/api/firm/trust/accounts/${m2.accountId}`)).body).toMatchObject({ balance: "0.00", entries: [] });
    expect((await call(env.base, dillon, "DELETE", `/api/firm/properties/${m2.propertyId}`)).body.error).toBe("This property has expenses or trust records, which stay in the record. Mark it Closed or Sold instead of deleting it.");
  });

  it("a no-fee client keeps the whole refund less expenses", async () => {
    const m3 = await ptabAwaiting("Free Client LLC", "700 W. Canal St.", "17-09-300-003-0000");
    await call(env.base, dillon, "PATCH", `/api/firm/accounts/${m3.accountId}`, { noFee: true });
    const id = (await post(dillon, `/api/firm/decisions/refunds/${m3.appealId}`, { receivedOn: "2026-10-16", amount: "500" })).body.settlementId;
    expect((await get(dillon, `/api/firm/trust/settlements/${id}`)).body).toMatchObject({ fee: "0.00", toClient: "500.00", feeBasis: { noFee: true } });
  });
});

describe("expenses recovered on an invoice", () => {
  it("ride along on the appeal's invoice, keep their amount, come off when removed, and count as recovered once paid", async () => {
    const geo = (await get(dillon, "/api/reference/counties")).body;
    const p = await post(dillon, "/api/firm/properties", {
      newAccount: { name: "Ivy, Rose", accountType: "individual" }, address1: "5 Oak Ln.", city: "Winnetka",
      countyId: geo.counties.find((c: { name: string }) => c.name === "Cook").id, townshipId: geo.townships.find((t: { name: string }) => t.name === "New Trier").id,
      taxCode: "23008", assetType: "residential", pin: "05-17-330-001-0000", firstAppeal: { assessmentYear: 2026, level: "bor" },
    });
    const pid = p.body.id;
    const aid = (await get(dillon, `/api/firm/properties/${pid}`)).body.appeals[0].id;
    const e1 = (await post(dillon, "/api/firm/expenses", { propertyId: pid, incurredOn: "2026-09-01", vendor: "FedEx", description: "Courier", amount: "42.50", recovery: "invoice" })).body.id;
    await call(env.base, dillon, "PATCH", `/api/firm/appeals/${aid}`, { original: { total: "100000" } });
    await call(env.base, dillon, "PATCH", `/api/firm/appeals/${aid}`, { resolved: { total: "90000" }, status: "reduced", substage: "decision_analysis" });
    const inv = (await post(dillon, `/api/firm/billing/appeals/${aid}/invoice`)).body;
    expect(inv.lines.map((l: { kind: string }) => l.kind)).toEqual(["fee", "expense"]);
    expect(inv.lines[1]).toMatchObject({ amount: "42.50", description: "Expense: FedEx, Courier (9/1/2026)" });
    const fee = inv.lines[0];
    const exp = inv.lines[1];
    expect((await patch(dillon, `/api/firm/billing/invoices/${inv.id}`, { lines: [{ id: fee.id, description: fee.description, amount: fee.amount }, { id: exp.id, description: exp.description, amount: "50" }] })).body.error)
      .toBe("An expense line's amount comes from the expense. Change the expense, or remove the line.");
    expect((await get(dillon, `/api/firm/expenses?propertyId=${pid}`)).body.expenses[0].state).toBe("on_invoice");
    expect((await patch(dillon, `/api/firm/expenses/${e1}`, { amount: "50" })).body.error).toBe("This expense is on an invoice or settlement. Take it off there first.");
    await patch(dillon, `/api/firm/billing/invoices/${inv.id}`, { lines: [{ id: fee.id, description: fee.description, amount: fee.amount }] });
    expect((await get(dillon, `/api/firm/expenses?propertyId=${pid}`)).body.expenses[0].state).toBe("open");
    const again = (await post(dillon, `/api/firm/billing/invoices/${inv.id}/add-expenses`)).body;
    expect(again.added).toBe(1);
    await post(dillon, `/api/firm/billing/invoices/${inv.id}/send`, { to: [], email: false });
    await post(dillon, `/api/firm/billing/invoices/${inv.id}/payments`, { method: "check", amount: again.invoice.total, receivedOn: "2026-10-19", checkNumber: "77" });
    expect((await get(dillon, `/api/firm/expenses?propertyId=${pid}`)).body.expenses[0].state).toBe("recovered");
    // An expenses-only invoice for a later cost.
    expect((await post(dillon, `/api/firm/billing/properties/${pid}/expense-invoice`)).body.error).toBe("This property has no open expenses to invoice.");
    await post(dillon, "/api/firm/expenses", { propertyId: pid, incurredOn: "2026-10-01", vendor: "Clerk", description: "Certified copies", amount: "18", recovery: "invoice" });
    const only = await post(dillon, `/api/firm/billing/properties/${pid}/expense-invoice`);
    expect(only.status).toBe(201);
    expect(only.body).toMatchObject({ total: "18.00", appealId: null });
  });

  it("an open expense can be written off or deleted; a used one can't be deleted", async () => {
    const e = (await post(dillon, "/api/firm/expenses", { propertyId: m.propertyId, incurredOn: "2026-10-01", vendor: "Parking", description: "Hearing parking", amount: "25", recovery: "refund" })).body.id;
    expect((await post(julie, `/api/firm/expenses/${e}/write-off`, { reason: "" })).status).toBe(400);
    expect((await post(dillon, `/api/firm/expenses/${e}/write-off`, { reason: "Not worth chasing" })).body.state).toBe("written_off");
    expect((await call(env.base, dillon, "DELETE", `/api/firm/expenses/${appraisal}`)).body.error).toBe("This expense is on an invoice or settlement. Take it off there first.");
    const e2 = (await post(dillon, "/api/firm/expenses", { propertyId: m.propertyId, incurredOn: "2026-10-01", vendor: "Oops", description: "Entered twice", amount: "5", recovery: "refund" })).body.id;
    expect((await call(env.base, dillon, "DELETE", `/api/firm/expenses/${e2}`)).status).toBe(200);
  });
});

describe("Ready to bill, Needs tax figures and the dashboard", () => {
  it("reduced appeals with no tax savings figured are listed with what's missing, and can be marked billed elsewhere", async () => {
    const b = (await get(dillon, "/api/firm/billing")).body;
    const grand = b.needs.find((n: { title: string }) => n.title.includes("1415 W. Grand Ave."));
    expect(grand).toMatchObject({ year: 2025, level: "assessor", missing: ["tax code", "equalizer", "tax rate"] });
    expect(b.needs.length).toBeGreaterThanOrEqual(8);
    expect((await post(julie, "/api/firm/billing/skip", { appealIds: [grand.appealId], reason: "" })).status).toBe(400);
    expect((await post(julie, "/api/firm/billing/skip", { appealIds: b.needs.map((n: { appealId: number }) => n.appealId), reason: "Billed in the old system" })).body.skipped).toBe(b.needs.length);
    expect((await get(dillon, "/api/firm/billing")).body.needs).toEqual([]);
    expect((await post(dillon, `/api/firm/billing/appeals/${grand.appealId}/invoice`)).body.error).toBe("Marked not billed here: Billed in the old system.");
    await call(env.base, dillon, "DELETE", `/api/firm/billing/skip/${grand.appealId}`);
    expect((await get(dillon, "/api/firm/billing")).body.needs.map((n: { appealId: number }) => n.appealId)).toEqual([grand.appealId]);
  });

  it("the dashboard's Fees ready to bill is Billing's figure", async () => {
    const b = (await get(dillon, "/api/firm/billing")).body;
    const d = (await get(dillon, "/api/firm/dashboard")).body;
    expect(d.kpis.readyToBill).toBe(b.totals.ready);
  });
});

describe("the accounting journal", () => {
  it("every entry balances, trust moves are there, and the CSV is safe to open in Excel", async () => {
    const j = (await get(dillon, "/api/firm/accounting/export?from=2025-01-01&to=2026-12-31&format=json")).body;
    const by = new Map<string, { dr: number; cr: number }>();
    for (const l of j.lines) {
      const x = by.get(l.entry) ?? { dr: 0, cr: 0 };
      x.dr += Math.round(Number(l.debit || 0) * 100); x.cr += Math.round(Number(l.credit || 0) * 100);
      by.set(l.entry, x);
    }
    expect(by.size).toBeGreaterThan(5);
    for (const x of by.values()) expect(x.dr).toBe(x.cr);
    const harbor = j.lines.filter((l: { client: string }) => l.client === "Harbor Point LLC");
    expect(harbor.filter((l: { source: string }) => l.source === "trust deposit").map((l: { account: string; debit: string; credit: string }) => [l.account, l.debit, l.credit]))
      .toEqual([["Trust bank (IOLTA)", "12000.00", ""], ["Client trust funds (liability)", "", "12000.00"]]);
    expect(harbor.some((l: { source: string; account: string; credit: string }) => l.source === "trust fee" && l.account === "Legal fee income" && l.credit === "3999.60")).toBe(true);
    const csv = await fetch(`${env.base}/api/firm/accounting/export?from=2025-01-01&to=2026-12-31`, { headers: { Cookie: dillon } });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text.split("\r\n")[0]).toBe("Date,Entry,Account,Debit,Credit,Client,Matter,Memo,Reference,Source");
    expect((await get(dillon, "/api/firm/accounting/export?from=2026-12-01&to=2026-01-01")).body.error).toBe("The start date is after the end date.");
  });
});

describe("isolation", () => {
  it("another firm sees none of it and can't reach a settlement, ledger, letter or expense by id", async () => {
    const t = (await get(olivia, "/api/firm/trust")).body;
    expect([t.draft, t.approved, t.paid, t.balances, t.unsettled, t.inTrust]).toEqual([[], [], [], [], [], "0.00"]);
    expect((await get(olivia, `/api/firm/trust/settlements/${s1}`)).status).toBe(404);
    expect((await fetch(`${env.base}/api/firm/trust/settlements/${s1}/letter`, { headers: { Cookie: olivia } })).status).toBe(404);
    expect((await get(olivia, `/api/firm/trust/accounts/${m.accountId}`)).body).toMatchObject({ entries: [], balance: "0.00", settlements: [] });
    expect((await get(olivia, `/api/firm/expenses?propertyId=${m.propertyId}`)).body.expenses).toEqual([]);
    expect((await patch(olivia, `/api/firm/expenses/${appraisal}`, { vendor: "x" })).status).toBe(404);
    expect((await post(olivia, "/api/firm/expenses", { propertyId: m.propertyId, incurredOn: "2026-10-01", vendor: "x", description: "y", amount: "1", recovery: "refund" })).status).toBe(404);
    expect((await post(olivia, `/api/firm/trust/settlements/${s1}/approve`)).status).toBe(404);
    expect((await post(olivia, `/api/firm/decisions/refunds/${m.appealId}`, { receivedOn: "2026-10-01", amount: "1" })).status).toBe(404);
    expect((await post(olivia, "/api/firm/billing/skip", { appealIds: [m.appealId], reason: "x" })).body.skipped).toBe(0);
    expect((await get(olivia, "/api/firm/accounting/export?from=2000-01-01&to=2030-01-01&format=json")).body.lines).toEqual([]);
  });

  it("support access can look but not approve, pay or record expenses", async () => {
    await post(dillon, "/api/firm/support-grants", { hours: 2, reason: "Trust check" });
    const admin = await login(env.base, ADMIN.email, ADMIN.password);
    await post(admin, `/api/admin/firms/${env.nicholsId}/enter`);
    expect((await get(admin, "/api/firm/trust")).status).toBe(200);
    expect((await post(admin, `/api/firm/trust/settlements/${s1}/approve`)).status).toBe(403);
    expect((await post(admin, "/api/firm/expenses", { propertyId: m.propertyId, incurredOn: "2026-10-01", vendor: "x", description: "y", amount: "1", recovery: "refund" })).status).toBe(403);
  });

  it("the sample firm resets cleanly with trust and expense records, and numbering starts over", async () => {
    expect((await post(dillon, "/api/firm/sample/reset")).status).toBe(200);
    const t = (await get(dillon, "/api/firm/trust")).body;
    expect([t.draft, t.approved, t.paid, t.balances]).toEqual([[], [], [], []]);
    expect((await get(dillon, "/api/firm/expenses")).body.expenses).toEqual([]);
    expect(await sys(async (c) => (await c.query(`SELECT count(*)::int AS n FROM invoice_counters WHERE firm_id = $1`, [env.nicholsId])).rows[0].n)).toBe(0);
  });
});
