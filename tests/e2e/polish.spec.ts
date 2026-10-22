import { expect, test, type Page } from "@playwright/test";

// Delivery 10a in the browser: fee figures, asset types and the class-based level of assessment,
// the calendar's views and entries, the invoice design settings with a live preview, and a PDF
// attached to an invoice. Runs after folders-and-documents.spec (Dropbox is connected again there).
const PW = "sample-pass-1";
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email").fill("dillon@nicholslaw.example");
  await page.getByLabel("Password").fill(PW);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}

async function propertyId(page: Page, address: string): Promise<number> {
  const props = (await (await page.request.get("/api/firm/properties")).json()).properties as { id: number; address1: string }[];
  return props.find((p) => p.address1 === address)!.id;
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => { throw err; });
});

test("fee figures, asset types and the level of assessment from the class code", async ({ page }) => {
  await signIn(page);
  const sheridan = await propertyId(page, "1300 Sheridan Rd.");
  await page.goto(`/properties/${sheridan}`);
  await expect(page.locator(".eyebrow").first()).toContainText("Multi-family · Commercial");
  const facts = page.locator("dl.facts");
  await expect(facts.locator("div", { hasText: "Level of assessment" })).toContainText("10%Class 3-15");
  await expect(facts.locator(".fee-figs")).toHaveText(/Assessor\/BOR 40%·PTAB\/Court 33\.33%/);
  await page.screenshot({ path: "test-results/polish-property-header.png" });

  // Group it by hand, then back to its unit count.
  await page.getByRole("button", { name: "Edit matter" }).click();
  const sheet = page.getByRole("dialog");
  const options = await sheet.getByLabel("Asset type").locator("option").allTextContents();
  expect(options).toEqual(["Residential", "Commercial", "Industrial", "──────────", "Medical", "Retail", "Hospitality", "Multi-family", "Flex", "Data Center"]);
  await expect(sheet.getByLabel("Group as")).toHaveValue("");
  await expect(sheet.getByLabel("Group as").locator("option").first()).toHaveText("By unit count (Commercial)");
  await expect(sheet.getByLabel("Level of assessment %")).toHaveValue("");
  await expect(sheet.getByLabel("Level of assessment %")).toHaveAttribute("placeholder", "10 (automatic)");
  await sheet.getByLabel("Group as").selectOption("residential");
  await sheet.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".eyebrow").first()).toContainText("Multi-family · Residential");
  await page.getByRole("button", { name: "Edit matter" }).click();
  await page.getByRole("dialog").getByLabel("Group as").selectOption("");
  await page.getByRole("dialog").getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".eyebrow").first()).toContainText("Multi-family · Commercial");

  // The grid: a main type takes everything that rolls up to it; a specialty type only itself.
  await page.goto("/properties");
  await page.getByLabel("Asset type").selectOption("commercial");
  await expect(page.locator("tbody tr", { hasText: "1300 Sheridan Rd." })).toContainText("Multi-familyCommercial");
  await page.getByLabel("Asset type").selectOption("retail");
  await expect(page.locator("tbody tr")).toHaveCount(2); // 1415 W. Grand Ave. and 3800 E. Main St.
  await page.getByRole("button", { name: "Clear filters" }).click();
});

test("calendar: every view, a new entry tagged to a property, and the view remembered", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/calendar");
  await expect(page.getByRole("heading", { name: "October 2026" })).toBeVisible();

  await page.getByRole("button", { name: "Week", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Oct 18 to 24, 2026" })).toBeVisible();
  const thu = page.getByRole("gridcell", { name: "Thursday, October 22", exact: true });
  await expect(thu).toContainText("10:30 AM BOR hearing · 1440 Brookdale Rd.");
  await page.screenshot({ path: "test-results/calendar-week.png", fullPage: true });
  await page.getByRole("button", { name: "Work week" }).click();
  await expect(page.getByRole("heading", { name: "Oct 19 to 23, 2026" })).toBeVisible();
  await page.getByRole("button", { name: "Year" }).click();
  await expect(page.getByRole("heading", { name: "2026" })).toBeVisible();
  await expect(page.locator(".cal-year .ym")).toHaveCount(12);
  await page.screenshot({ path: "test-results/calendar-year.png", fullPage: true });
  await page.getByRole("button", { name: /^October 27, \d+ items?$/ }).click();
  await expect(page.getByRole("heading", { name: "Tuesday, October 27, 2026" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Day", exact: true })).toHaveAttribute("aria-pressed", "true");

  // A meeting at 2 PM, tagged to a property: from the empty slot in the day view.
  await page.getByRole("button", { name: "New entry 2:00 PM" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByLabel("Starts")).toHaveValue("14:00");
  await sheet.getByLabel("What").fill("Walk-through with the owner");
  await sheet.getByLabel("Ends").fill("15:30");
  await sheet.getByLabel("Where").fill("On site");
  await sheet.getByLabel("Property (optional)").selectOption({ label: "3800 E. Main St., St. Charles (St. Charles)" });
  await expect(sheet.getByLabel("Client")).not.toHaveValue("");
  await expect(sheet.getByText("Private: only I see it")).toHaveCount(0);
  await sheet.getByRole("button", { name: "Add to calendar" }).click();
  const ev = page.locator(".tg-ev", { hasText: "Walk-through with the owner" });
  await expect(ev).toContainText("2:00 PM to 3:30 PM");
  await page.screenshot({ path: "test-results/calendar-day.png", fullPage: true });

  // It's on the property's Activities too.
  const main = await propertyId(page, "3800 E. Main St.");
  const acts = (await (await page.request.get(`/api/firm/properties/${main}`)).json()).activities as { subject: string; kind: string }[];
  expect(acts.find((a) => a.subject === "Walk-through with the owner")?.kind).toBe("meeting");

  // Open it, mark it done; the view is remembered.
  await ev.getByRole("button").click();
  await page.getByRole("dialog").getByRole("button", { name: "Mark done" }).click();
  await expect(page.locator(".tg-ev.done", { hasText: "Walk-through with the owner" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Day", exact: true })).toHaveAttribute("aria-pressed", "true");

  // A private reminder from + New entry, then delete it.
  await page.getByRole("button", { name: "+ New entry" }).click();
  const r = page.getByRole("dialog");
  await r.getByLabel("Type").selectOption("reminder");
  await r.getByLabel("What").fill("Call the bank");
  await r.getByText("Private: only I see it").click();
  await r.getByRole("button", { name: "Add to calendar" }).click();
  await page.getByRole("button", { name: /Call the bank/ }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("button", { name: /Call the bank/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Month", exact: true }).click();
});

test("phone width: the week view doesn't scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/calendar");
  await page.getByRole("button", { name: "Week", exact: true }).click();
  await expect(page.locator(".tg")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "Month", exact: true }).click();
});

test("invoice design: logo, accent and check details with a live preview; a PDF attached to an invoice", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/settings?tab=billing");
  await page.getByLabel("Choose a logo image").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG_1PX });
  await expect(page.getByText("Logo saved.")).toBeVisible();
  await expect(page.getByRole("img", { name: "Your letterhead logo" })).toBeVisible();
  await page.getByLabel("Accent color", { exact: true }).fill("#0A1F44");
  await page.getByLabel("Pay by check: payable to and mail to").fill("Payable to Nichols Law\nPO Box 12, Winnetka, IL 60093");
  const frame = page.getByTitle("Invoice preview");
  await expect(frame).toHaveAttribute("src", /invoice-preview\?d=.*PO%20Box%2012/);
  const src = (await frame.getAttribute("src"))!;
  const pdf = await page.request.get(src);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  await page.screenshot({ path: "test-results/settings-invoice-design.png", fullPage: true });
  await page.getByRole("button", { name: "Save billing settings" }).click();
  await expect(page.getByText("Billing settings saved.")).toBeVisible();

  // A draft for an expense on 3800 E. Main St., and the decision letter from its Files tab attached to it.
  const main = await propertyId(page, "3800 E. Main St.");
  // Dropbox is connected when the whole suite runs; on its own, this connects it (the stand-in approves at once).
  if (!(await (await page.request.get("/api/firm/integrations")).json()).dropbox.connected) {
    await page.goto("/settings?tab=integrations");
    await page.getByRole("button", { name: "Connect Dropbox" }).click();
    await expect(page.getByText("Dropbox is connected.")).toBeVisible();
  }
  expect((await page.request.post(`/api/firm/properties/${main}/files/ensure`, { data: {} })).ok()).toBe(true);
  const up = await page.request.post(`/api/firm/properties/${main}/files/upload?${new URLSearchParams({ path: "Misc", name: "Decision letter.pdf" })}`, {
    headers: { "Content-Type": "application/octet-stream" }, data: Buffer.from("%PDF-1.4 decision"),
  });
  expect(up.status()).toBe(201);
  const exp = await page.request.post("/api/firm/expenses", { data: { propertyId: main, incurredOn: "2026-10-15", vendor: "Courier", description: "Filing delivery", amount: "45", recovery: "invoice" } });
  expect(exp.ok()).toBe(true);
  const expenseId = ((await exp.json()) as { id: number }).id;
  expect((await page.request.post(`/api/firm/billing/properties/${main}/expense-invoice`, { data: {} })).status()).toBe(201);

  await page.goto(`/properties/${main}`);
  await page.getByRole("tab", { name: "Billing" }).click();
  await page.locator("tr", { hasText: "Draft" }).first().click();
  const inv = page.getByRole("dialog");
  await inv.getByRole("button", { name: "+ Attach a PDF from the property's files" }).click();
  await inv.getByRole("listitem").filter({ hasText: "Decision letter.pdf" }).click();
  await expect(inv.locator(".att-list li", { hasText: "Decision letter.pdf" })).toBeVisible();
  await expect(inv.getByText("Email it with the PDF and 1 attachment attached")).toBeVisible();
  await page.screenshot({ path: "test-results/invoice-attachments.png", fullPage: true });
  await inv.getByRole("button", { name: "Remove Decision letter.pdf" }).click();
  await expect(inv.getByText("Nothing attached.")).toBeVisible();
  await inv.getByRole("button", { name: "Delete draft" }).click();
  await expect(inv).toHaveCount(0);
  // Leave the sample as it was for the specs after this one.
  expect((await page.request.delete(`/api/firm/expenses/${expenseId}`)).ok()).toBe(true);
});
