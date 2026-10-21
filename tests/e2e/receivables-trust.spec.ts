import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Delivery 9b in the browser: the PTAB refund letters.spec recorded for 1450 Waukegan Rd.
// ($4,321.09) is in trust with a draft settlement. Add an expense the firm fronted, put it on
// the settlement, approve, record the payout, and the client's trust balance is zero. Then the
// Appeals tab filters, Needs tax figures, and the accounting export.
// Runs after letters.spec (file-name order) and before reference.spec resets the sample data.
const PW = "sample-pass-1";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email").fill("dillon@nicholslaw.example");
  await page.getByLabel("Password").fill(PW);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => { throw err; });
});

test("a refund in trust: expense added, settlement approved and paid, letter ready", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  const props = (await (await page.request.get("/api/firm/properties")).json()).properties as { id: number; address1: string }[];
  const waukegan = props.find((p) => p.address1 === "1450 Waukegan Rd.")!.id;

  // The firm fronted a transcript for this matter.
  await page.goto(`/properties/${waukegan}`);
  await page.getByRole("tab", { name: "Billing" }).click();
  await expect(page.locator("tr", { hasText: "Property Tax Appeal Board" }).or(page.locator("tr", { hasText: "PTAB" })).first()).toContainText("$4,321.09");
  await page.getByRole("button", { name: "+ Expense" }).click();
  const ex = page.getByRole("dialog");
  await ex.getByLabel("Date paid").fill("2026-09-30");
  await ex.getByLabel("Amount").fill("120");
  await ex.getByLabel("Paid to").fill("Court reporter");
  await ex.getByLabel("For").fill("Hearing transcript");
  await ex.getByRole("button", { name: "Save expense" }).click();
  await expect(page.getByText("Expense saved.")).toBeVisible();
  await expect(page.locator("tr", { hasText: "Court reporter" })).toContainText("Open");

  // Billing, Trust: the draft settlement to approve.
  await page.goto("/billing?view=trust");
  await expect(page.getByText(/\$4,321\.09 held in trust/)).toBeVisible();
  const row = page.locator("tr", { hasText: "1450 Waukegan Rd." }).first();
  await expect(row).toContainText("To approve");
  await row.click();
  const s = page.getByRole("dialog");
  await expect(s.locator("tr", { hasText: "Refund received" })).toContainText("$4,321.09");
  // 33.33% of $4,321.09 = $1,440.22; the client gets the rest until the expense goes on.
  await expect(s.locator("tr", { hasText: "Fee" })).toContainText("33.33% of the refund");
  await expect(s.locator("tr", { hasText: "To the client" })).toContainText("$2,880.87");
  await s.getByLabel("Recover Court reporter").check();
  await expect(s.locator("tr", { hasText: "To the client" })).toContainText("$2,760.87");
  await s.getByRole("button", { name: "Save settlement" }).click();
  await expect(s.getByText("Settlement saved.")).toBeVisible();
  await page.screenshot({ path: "test-results/trust-settlement-draft.png", fullPage: true });
  await s.getByRole("button", { name: "Approve settlement" }).click();
  await expect(s.getByText("Approved.", { exact: true })).toBeVisible();

  await s.getByLabel("Check number").fill("1001");
  await s.getByLabel("Date paid").fill("2026-10-19");
  await s.getByRole("button", { name: "Record payout" }).click();
  await expect(s.getByText("Payout recorded. The client's trust balance for this refund is now zero.")).toBeVisible();
  await expect(s.locator("tr", { hasText: "Paid to the client" })).toContainText("$2,760.87");
  await expect(s.getByRole("link", { name: "Download letter (PDF)" })).toHaveAttribute("href", /\/api\/firm\/trust\/settlements\/\d+\/letter/);
  await page.screenshot({ path: "test-results/trust-settlement-paid.png", fullPage: true });
  await s.getByRole("button", { name: "Close" }).last().click();
  await expect(page.getByText("Nothing held in trust.")).toBeVisible();

  // The client page shows the ledger back to zero.
  await page.goto(`/properties/${waukegan}`);
  await page.getByRole("tab", { name: "Billing" }).click();
  await expect(page.locator("tr", { hasText: "Court reporter" })).toContainText("Recovered");
});

test("the Appeals tab filters by year, level and status, one choice each", async ({ page }) => {
  await signIn(page);
  const props = (await (await page.request.get("/api/firm/properties")).json()).properties as { id: number; address1: string }[];
  const id = props.find((p) => p.address1 === "1044 Tower Road")!.id;
  // Earlier specs add appeals here, so the expected counts come from the property itself.
  const appeals = (await (await page.request.get(`/api/firm/properties/${id}`)).json()).appeals as { assessment_year: number; level: string; status: string }[];
  const n = (f: (a: { assessment_year: number; level: string; status: string }) => boolean) => appeals.filter(f).length;
  const total = appeals.length;
  await page.goto(`/properties/${id}`);
  const rows = page.locator(".pane table.compact tbody tr");
  await expect(rows).toHaveCount(total);
  await page.getByLabel("Filter by assessment year").selectOption("2025");
  await expect(rows).toHaveCount(n((a) => a.assessment_year === 2025));
  await expect(page.getByText(`${n((a) => a.assessment_year === 2025)} of ${total} appeals`)).toBeVisible();
  await page.getByLabel("Filter by level").selectOption("bor");
  await expect(rows).toHaveCount(n((a) => a.assessment_year === 2025 && a.level === "bor"));
  await expect(page.getByText(/ of \d+ appeals · achieved savings \$1,736\.12$/)).toBeVisible();
  await page.getByLabel("Filter by assessment year").selectOption("");
  await expect(rows).toHaveCount(n((a) => a.level === "bor"));
  await page.getByLabel("Filter by status").selectOption("reduced");
  const reducedBor = n((a) => a.level === "bor" && a.status === "reduced");
  await expect(rows).toHaveCount(reducedBor);
  await expect(page.getByText(new RegExp(`^${reducedBor} of ${total} appeals · achieved savings \\$`))).toBeVisible();
  // Remembered on this browser.
  await page.reload();
  await expect(rows).toHaveCount(reducedBor);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(rows).toHaveCount(total);
});

test("Needs tax figures, taking history off Ready to bill, and the accounting export", async ({ page }) => {
  await signIn(page);
  await page.goto("/billing");
  await expect(page.getByRole("heading", { name: /^Needs tax figures/ })).toBeVisible();
  const needs = page.locator("table", { hasText: "Missing" });
  const grand = needs.locator("tr", { hasText: "1415 W. Grand Ave." });
  await expect(grand).toContainText("tax code, equalizer, tax rate");
  await expect(grand.getByRole("link", { name: "Enter figures" })).toHaveAttribute("href", /\/properties\/\d+\?appeal=\d+/);
  await page.screenshot({ path: "test-results/billing-needs-figures.png", fullPage: true });
  const before = await needs.locator("tbody tr").count();
  await grand.getByRole("checkbox").check();
  await page.getByLabel("Reason").selectOption("Billed in earlier software");
  await page.getByRole("button", { name: "Not billed here" }).click();
  await expect(page.getByText("1 appeal taken off Ready to bill (billed in earlier software).")).toBeVisible();
  await expect(needs.locator("tbody tr")).toHaveCount(before - 1);

  await page.getByRole("button", { name: "Accounting export" }).click();
  await page.getByLabel("From").fill("2026-01-01");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download CSV" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^accounting-journal-2026-01-01-to-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync((await download.path())!, "utf8");
  expect(csv.split("\r\n")[0]).toBe("Date,Entry,Account,Debit,Credit,Client,Matter,Memo,Reference,Source");
  expect(csv).toContain("Trust bank (IOLTA),4321.09,");
  expect(csv).toContain("Paid to client by check");
});
