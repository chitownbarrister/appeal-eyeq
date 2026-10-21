import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Delivery 9a: billing in the browser. Connecting Stripe from Settings, drafting an invoice
// from a decided BOR reduction, editing and sending it, the client paying by card on the
// pay page, and a statement gathering two invoices paid by check.
// Named receivables.spec so it runs after the specs that count properties (file-name order)
// and before reference.spec, which resets the sample data.
const PW = "sample-pass-1";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email").fill("dillon@nicholslaw.example");
  await page.getByLabel("Password").fill(PW);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}

/** A client and property in tax code 23008 with a decided 2026 BOR reduction (AV 100,000 to 90,000). */
async function decided(api: APIRequestContext, opts: { name?: string; accountId?: number; address: string; pin: string; email?: string }) {
  const geo = await (await api.get("/api/reference/counties")).json();
  const cook = geo.counties.find((c: { name: string }) => c.name === "Cook").id;
  const nt = geo.townships.find((t: { name: string }) => t.name === "New Trier").id;
  const r = await api.post("/api/firm/properties", { data: {
    ...(opts.accountId ? { accountId: opts.accountId } : { newAccount: { name: opts.name, accountType: "individual" } }),
    address1: opts.address, city: "Winnetka", countyId: cook, townshipId: nt, taxCode: "23008", assetType: "residential", pin: opts.pin,
    firstAppeal: { assessmentYear: 2026, level: "bor" },
  } });
  expect(r.status()).toBe(201);
  const pid = (await r.json()).id;
  const d = await (await api.get(`/api/firm/properties/${pid}`)).json();
  const aid = d.appeals[0].id;
  expect((await api.patch(`/api/firm/appeals/${aid}`, { data: { original: { total: "100000" } } })).status()).toBe(200);
  expect((await api.patch(`/api/firm/appeals/${aid}`, { data: { resolved: { total: "90000" }, status: "reduced", substage: "decision_analysis" } })).status()).toBe(200);
  if (opts.email) await api.post("/api/firm/contacts", { data: { accountId: d.property.account_id, name: "Accounts payable", role: "billing", email: opts.email } });
  return { propertyId: pid as number, appealId: aid as number, accountId: d.property.account_id as number };
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => { throw err; });
});

test("connect Stripe, draft and send an invoice, and the client pays it by card", async ({ page, context }) => {
  test.setTimeout(90000);
  await signIn(page);

  // Settings > Billing: connect the firm's Stripe account (the fake finishes onboarding at once).
  await page.goto("/settings?tab=billing");
  await expect(page.getByText("Not connected").first()).toBeVisible();
  await page.getByRole("button", { name: "Connect Stripe" }).click();
  await expect(page.getByText("Stripe is connected. Clients can now pay invoices online.")).toBeVisible();
  await expect(page.getByText("Accepting payments")).toBeVisible();
  await page.getByLabel("Payment terms, days").fill("21");
  await page.getByLabel("Note printed on every invoice").fill("Checks payable to Nichols Law.");
  await page.getByRole("button", { name: "Save billing settings" }).click();
  await expect(page.getByText("Billing settings saved.")).toBeVisible();

  const a = await decided(page.request, { name: "Ashby, Claire", address: "10 Elm Ct.", pin: "05-17-310-001-0000", email: "claire@example.test" });
  const ready = (await (await page.request.get("/api/firm/billing")).json()).ready.find((r: { appealId: number }) => r.appealId === a.appealId);
  const feeText = `$${Number(ready.fee).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Billing" }).click();
  await expect(page.getByRole("heading", { name: "Invoices and payments" })).toBeVisible();
  const row = page.locator("tr", { hasText: "10 Elm Ct." });
  await expect(row).toContainText(feeText);
  await expect(row).toContainText("Ashby, Claire");
  await page.screenshot({ path: "test-results/billing-ready.png", fullPage: true });
  await row.getByRole("button", { name: "Draft" }).click();

  // The draft opens: add a line, save, send by email.
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Draft invoice")).toBeVisible();
  await expect(sheet.getByLabel("Line description").first()).toHaveValue(/^Board of Review appeal, 2026 assessment year: 40\.00% of first-year tax savings of \$[\d,]+\.\d{2}$/);
  await sheet.getByRole("button", { name: "+ Add a line" }).click();
  await sheet.getByLabel("Line description").last().fill("Courier for the hearing packet");
  await sheet.getByLabel("Line amount").last().fill("25");
  await sheet.getByLabel("Line amount").last().blur();
  await sheet.getByRole("button", { name: "Save draft" }).click();
  await expect(sheet.getByText("Draft saved.")).toBeVisible();
  const total = (Number(ready.fee) + 25).toLocaleString("en-US", { minimumFractionDigits: 2 });
  await expect(sheet.locator("tr", { hasText: "Total" })).toContainText(`$${total}`);
  await expect(sheet.getByLabel("To")).toHaveValue("claire@example.test");
  await sheet.getByRole("button", { name: "Send invoice" }).click();
  await expect(sheet.getByText(/^Invoice NL-2026-\d{4} emailed to claire@example\.test\.$/)).toBeVisible();
  await page.screenshot({ path: "test-results/billing-invoice-sent.png", fullPage: true });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await sheet.getByRole("button", { name: "Copy pay link" }).click();
  const link = await sheet.getByLabel("Pay link").inputValue();
  expect(link).toMatch(/^http:\/\/127\.0\.0\.1:3100\/pay\/[A-Za-z0-9_-]+$/);
  await sheet.getByRole("button", { name: "Close" }).last().click();
  await page.getByRole("tab", { name: /^Unpaid/ }).click();
  await expect(page.locator("tr", { hasText: "10 Elm Ct." })).toContainText("Unpaid");

  // The client, signed out, opens the link and pays by card, saving the card.
  const client = await context.browser()!.newContext();
  const pay = await client.newPage();
  pay.on("pageerror", (err) => { throw err; });
  await pay.goto(link);
  await expect(pay.getByText("Nichols Law").first()).toBeVisible();
  await expect(pay.getByRole("heading", { name: "Ashby, Claire" })).toBeVisible();
  await expect(pay.locator(".pay-amount")).toContainText(`$${total}`);
  await expect(pay.getByText("10 Elm Ct., Winnetka (New Trier)")).toBeVisible();
  await pay.screenshot({ path: "test-results/pay-page.png", fullPage: true });
  await pay.setViewportSize({ width: 390, height: 844 });
  await pay.screenshot({ path: "test-results/pay-page-phone.png", fullPage: true });
  await pay.setViewportSize({ width: 1280, height: 800 });
  await pay.getByLabel(/Save this payment method/).check();
  await pay.getByRole("button", { name: "Pay by card" }).click();
  await expect(pay.getByText("Thank you. Your payment went through.")).toBeVisible();
  await expect(pay.getByText("Paid", { exact: true })).toBeVisible();
  expect(new URL(pay.url()).search).toBe("");
  await pay.screenshot({ path: "test-results/pay-page-paid.png", fullPage: true });
  await client.close();

  await page.reload();
  await page.getByRole("tab", { name: /^Paid/ }).click();
  const paid = page.locator("tr", { hasText: "10 Elm Ct." });
  await expect(paid).toContainText("Paid");
  await paid.click();
  await expect(page.getByRole("dialog")).toContainText("Card");
  await expect(page.getByRole("dialog")).toContainText(`$${total}`);
});

test("a statement gathers a client's two unpaid invoices, and a check pays both", async ({ page }) => {
  await signIn(page);
  const one = await decided(page.request, { name: "Fenn Holdings", address: "30 Elm Ct.", pin: "05-17-320-001-0000", email: "ap@fenn.test" });
  const two = await decided(page.request, { accountId: one.accountId, address: "32 Elm Ct.", pin: "05-17-320-002-0000" });
  let sum = 0;
  for (const x of [one, two]) {
    const inv = await (await page.request.post(`/api/firm/billing/appeals/${x.appealId}/invoice`, { data: {} })).json();
    sum += Number(inv.total);
    expect((await page.request.post(`/api/firm/billing/invoices/${inv.id}/send`, { data: { to: [], email: false } })).status()).toBe(200);
  }
  const sumText = `$${sum.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

  await page.goto(`/accounts/${one.accountId}`);
  await page.getByRole("tab", { name: "Billing" }).click();
  await expect(page.getByText(`2 unpaid invoices · ${sumText} outstanding`)).toBeVisible();
  await page.getByRole("button", { name: "Create statement" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.locator("tr", { hasText: "Statement total" })).toContainText(sumText);
  await expect(sheet.getByLabel("To")).toHaveValue("ap@fenn.test");
  await sheet.getByRole("button", { name: "Send statement" }).click();
  await expect(page.getByText(/^Statement NL-S-2026-\d{4} emailed\.$/)).toBeVisible();
  const st = page.getByRole("dialog");
  await expect(st.getByText(/^Statement NL-S-2026-\d{4}$/)).toBeVisible();
  await page.screenshot({ path: "test-results/billing-statement.png", fullPage: true });

  await st.getByRole("button", { name: "Record a check" }).click();
  await expect(st.getByLabel("Amount")).toHaveValue(sumText);
  await st.getByLabel("Check number").fill("1043");
  await st.getByRole("button", { name: "Record payment" }).click();
  await expect(st.getByText("Payment recorded.")).toBeVisible();
  await expect(st.getByText("Paid", { exact: true }).first()).toBeVisible();
  await expect(st).toContainText("Check #1043");
  await st.getByRole("button", { name: "Close" }).last().click();
  await expect(page.locator("tbody tr", { hasText: "30 Elm Ct." })).toContainText("Paid");
  await expect(page.locator("tbody tr", { hasText: "32 Elm Ct." })).toContainText("Paid");

  // The property page shows its invoice under Billing.
  await page.goto(`/properties/${two.propertyId}`);
  await page.getByRole("tab", { name: "Billing" }).click();
  await expect(page.locator("tbody tr").first()).toContainText("Paid");
});
