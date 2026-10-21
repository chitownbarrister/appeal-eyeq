import { expect, test, type Page } from "@playwright/test";
import { letters, scannedPdf, textPdf } from "../integration/letters";

// Delivery 8: decision letters. A scanned stack read by OCR and applied together,
// Start BOR, a letter corrected in review, uploading from the property page, PTAB
// refunds, and values in accounting format with the cents choice.
// Uses properties the later specs don't look at (Pratt, Clinton, Euclid, Green Bay, Waukegan).
// Named letters.spec so it runs after foundation.spec, whose dashboard figures it would change
// (specs run in file-name order; reference.spec runs last and resets the sample data).
const PW = "sample-pass-1";

async function signIn(page: Page, email = "dillon@nicholslaw.example", password = PW) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => { throw err; });
});

test("a scanned stack is read, matched, applied together, and the no-change Assessor letter starts the BOR appeal", async ({ page }) => {
  test.setTimeout(120000);
  await signIn(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Decisions" }).click();
  await expect(page.getByRole("heading", { name: "Decision letters" })).toBeVisible();
  const pdf = await scannedPdf([
    letters.bor({ pin: "08-22-200-014-0000", complaint: "2640001-001", year: 2026, date: "10/08/2026", orig: "2,210,000", final: "2,050,000" }),
    ...letters.assessor({ year: 2026, date: "09/14/2026", township: "76 SOUTH CHICAGO", appealNo: "2771901", rows: [{ pin: "17-16-104-008-0000", cls: "591", prior: "1,100,000", proposed: "1,150,000", current: "1,150,000" }] }),
  ]);
  await page.getByLabel("Choose decision letters to upload").setInputFiles({ name: "Oct 9 scan.pdf", mimeType: "application/pdf", buffer: pdf });
  await expect(page.getByRole("tab", { name: "Matched cleanly (2)" })).toBeVisible({ timeout: 90000 });
  const rows = page.locator("table.letters tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("2200 Pratt Blvd.");
  await expect(rows.nth(0)).toContainText("$2,210,000 → $2,050,000");
  await expect(rows.nth(0)).toContainText("72.7%");
  await expect(rows.nth(1)).toContainText("820 S. Clinton St.");
  await expect(rows.nth(1)).toContainText("No change");
  await page.screenshot({ path: "test-results/decisions-matched.png", fullPage: true });

  await page.getByRole("button", { name: "Apply all that matched cleanly" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Applied 2 letters." })).toBeVisible();
  await page.getByRole("button", { name: "Start the BOR appeal" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Started 1 Board of Review appeal." })).toBeVisible();
  await page.getByRole("tab", { name: /^Applied/ }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Not filed yet");

  await page.getByRole("link", { name: "820 S. Clinton St., Chicago (South Chicago)" }).click();
  await expect(page.getByText("Board of Review · Under review")).toBeVisible();
  await page.getByRole("tab", { name: "Appeals" }).click();
  await expect(page.locator(".letters-mini")).toContainText("Applied");
});

test("a letter to review: the scan beside what was read, a corrected PIN, then apply and undo", async ({ page }) => {
  await signIn(page);
  await page.goto("/decisions");
  const pdf = await textPdf([letters.bor({ pin: "16-07-118-021-0000", complaint: "2640002-001", year: 2026, date: "10/09/2026", orig: "78,500", final: "71,000" })]);
  await page.getByLabel("Choose decision letters to upload").setInputFiles({ name: "euclid.pdf", mimeType: "application/pdf", buffer: pdf });
  await page.getByRole("tab", { name: /^To review \(1\)/ }).click({ timeout: 30000 });
  const row = page.locator("table.letters tbody tr").first();
  await expect(row).toContainText("PIN 16-07-118-021-0000 isn't on any of your properties. The closest is 16-07-118-020-0000");
  await row.click();
  const sheet = page.getByRole("dialog", { name: "Board of Review letter, 2026" });
  await expect(sheet.locator("iframe")).toHaveAttribute("src", /\/api\/firm\/decisions\/letters\/\d+\/file/);
  await expect(sheet.locator(".ck.block").first()).toContainText("Can't apply");
  await expect(sheet.getByText("Fix the items marked Can't apply first.")).toBeVisible();
  await sheet.getByLabel("PIN 1", { exact: true }).fill("16-07-118-020-0000");
  await expect(sheet.getByLabel("Decided AV, PIN 1")).toHaveValue("$71,000");
  await sheet.getByRole("button", { name: "Save and check again" }).click();
  await expect(sheet.getByText("Matched cleanly")).toBeVisible();
  await expect(sheet.locator(".letter-match")).toContainText("1027 N. Euclid Ave., Oak Park (Oak Park)");
  await expect(sheet.locator(".checks")).toContainText("Starting AV $78,500 matches the appeal.");
  await page.screenshot({ path: "test-results/decisions-letter.png", fullPage: true });
  await sheet.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(sheet.getByRole("status").filter({ hasText: /^Applied/ })).toBeVisible();
  await expect(sheet.locator(".next-step")).toContainText("Reduced at the Board of Review: ready to bill.");
  await sheet.getByRole("button", { name: "Undo" }).click();
  await expect(sheet.getByText("Undone. The appeal is back the way it was")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Apply", exact: true })).toBeVisible();
  await sheet.getByRole("button", { name: "Close" }).click();
});

test("uploading a decision letter from the property page opens it ready to apply", async ({ page }) => {
  await signIn(page);
  await page.goto("/properties");
  await page.getByRole("link", { name: /1180 N\. Green Bay Rd\./ }).click();
  const pdf = await textPdf([letters.bor({ pin: "16-05-302-014", complaint: "2026-00451", year: 2026, date: "10/01/2026", orig: "612,000", final: "575,000", county: "Lake" })]);
  await page.getByLabel("Choose a decision letter to upload").setInputFiles({ name: "green bay.pdf", mimeType: "application/pdf", buffer: pdf });
  const sheet = page.getByRole("dialog", { name: "Board of Review letter, 2026" });
  await expect(sheet).toBeVisible({ timeout: 30000 });
  await expect(sheet.locator(".letter-match")).toContainText("Matched cleanly");
  await sheet.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(sheet.getByRole("status").filter({ hasText: /^Applied/ })).toBeVisible();
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(page.locator("table.compact").first()).toContainText("Reduced");
  await expect(page.locator(".letters-mini")).toContainText("Applied");
});

test("a PTAB reduction waits for its refund, which is recorded when the check comes", async ({ page }) => {
  await signIn(page);
  await page.goto("/decisions");
  const pdf = await textPdf([letters.ptab({ docket: "2026-001122.001-C-1", pin: "04-24-100-027-0000", county: "Cook", outcome: "reduction", land: "180,000", impr: "700,000", total: "880,000" })]);
  await page.getByLabel("Choose decision letters to upload").setInputFiles({ name: "waukegan ptab.pdf", mimeType: "application/pdf", buffer: pdf });
  const row = page.locator("table.letters tbody tr", { hasText: "1450 Waukegan Rd." });
  await expect(row).toBeVisible({ timeout: 30000 });
  await row.click();
  const sheet = page.getByRole("dialog", { name: "PTAB letter, 2026" });
  await expect(sheet.locator(".checks")).toContainText("Docket 2026-001122.001-C-1 will be saved to the appeal.");
  await sheet.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(sheet.locator(".next-step")).toContainText("Awaiting the refund check.");
  await sheet.getByRole("button", { name: "Close" }).click();
  await page.getByRole("tab", { name: /^Awaiting refund \(1\)/ }).click();
  const refund = page.locator("tr", { hasText: "1450 Waukegan Rd." });
  await refund.getByRole("button", { name: "Record refund" }).click();
  const rs = page.getByRole("dialog", { name: /1450 Waukegan Rd\./ });
  await rs.getByLabel("Check received").fill("2026-10-16"); // the test server's "today" is pinned to Oct 19
  await rs.getByLabel("Amount, refund and interest").fill("4321.09");
  await rs.getByRole("button", { name: "Record refund" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Refund recorded." })).toBeVisible();
  await expect(page.locator("h3", { hasText: "Received" })).toBeVisible();
  await expect(page.locator("tr", { hasText: "1450 Waukegan Rd." })).toContainText("$4,321.09");
});

test("values show in accounting format, inputs format when you leave them, and cents are a personal choice", async ({ page }) => {
  await signIn(page);
  await page.goto("/properties");
  await page.getByRole("link", { name: /1415 W\. Grand Ave\./ }).click();
  await page.getByRole("tab", { name: "Values" }).click();
  await page.getByLabel("Choose an appeal").selectOption({ label: "2026 Board of Review · Open" });
  await expect(page.locator(".vtile", { hasText: "Original AV" })).toContainText("$412,500");
  const land = page.getByLabel("17-08-101-022-0000 Original land");
  await expect(land).toHaveValue("$61,875");
  await land.focus();
  await expect(land).toHaveValue("61875");
  await land.blur();
  await expect(land).toHaveValue("$61,875");

  await page.getByRole("button", { name: /^Account menu for/ }).click();
  await page.getByRole("menuitem", { name: "Your account" }).click();
  await page.getByLabel("Show cents on assessed and market values").check();
  await expect(page.getByText("$61,875.00 instead of $61,875")).toBeVisible();
  await page.goto("/properties");
  await page.getByRole("link", { name: /1415 W\. Grand Ave\./ }).click();
  await page.getByRole("tab", { name: "Values" }).click();
  await page.getByLabel("Choose an appeal").selectOption({ label: "2026 Board of Review · Open" });
  await expect(page.locator(".vtile", { hasText: "Original AV" })).toContainText("$412,500.00");
  // Back to whole dollars for the specs that follow.
  await page.goto("/account");
  await page.getByLabel("Show cents on assessed and market values").uncheck();
  await expect(page.getByText("$61,875, not $61,875.00")).toBeVisible();
});

test("phone width: the Decisions page and a letter don't scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/decisions?view=applied");
  await expect(page.locator("table.letters tbody tr").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.locator("table.letters tbody tr").first().locator("td").first().click();
  await expect(page.locator(".letter-sheet .checks")).toBeVisible();
  expect(await page.locator(".letter-sheet").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
});
