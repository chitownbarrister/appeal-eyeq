import { expect, test, type Page } from "@playwright/test";

// Delivery 10d in the browser: a migration from the prior software's two reports (the Account
// Workbook and Property Detail), with a sheet switched off, previewed, imported and undone; the
// co-counsel mark and filter on the Properties grid; and the import pages at phone width.
const PW = "sample-pass-1";
const FIX = "tests/fixtures/imports";

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

test("a migration from the old system's reports: map, preview, import, undo", async ({ page }) => {
  await signIn(page);
  await page.goto("/properties");
  await page.getByRole("link", { name: "Import", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Bring data in" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Move a firm's data in/ })).toBeChecked();
  await page.screenshot({ path: "test-results/import-start.png", fullPage: true });

  await page.getByLabel("Choose files to import").setInputFiles([`${FIX}/AccountWorkbook.xlsx`, `${FIX}/PropertyDetail.xlsx`]);
  await expect(page.getByRole("heading", { name: "Firm migration" })).toBeVisible();
  await expect(page.getByLabel("What All Appeals holds")).toHaveValue("appeal");
  await expect(page.getByLabel("What Active Appeals holds")).toHaveValue("skip");
  await expect(page.getByLabel("What Property (from Overview) holds")).toHaveValue("property");

  // Open the appeals sheet: its columns, matched from the old system's headers, with sample values.
  await page.locator("summary", { hasText: "All Appeals" }).click();
  const cols = page.getByRole("table", { name: "Columns in All Appeals" });
  await expect(cols.getByLabel("Column for Original AV")).toHaveValue("Orig  AV");
  await expect(cols.locator("tr", { hasText: "Level" }).first()).toContainText("Assessor · Board of Review · Assessor");

  await page.getByLabel("What Contacts holds").selectOption("skip");
  await expect(page.getByText("Changes since the last preview")).toBeVisible();
  await page.screenshot({ path: "test-results/import-mapping.png", fullPage: true });
  await page.getByRole("button", { name: "Preview" }).click();

  const summary = page.getByRole("table", { name: "What this import would do" });
  await expect(summary).toBeVisible();
  await expect(summary.getByRole("rowheader")).toHaveText(["Clients", "Properties", "PINs (parcels)", "Appeals and values", "Activities and notes"]);
  await expect(summary.locator("tr", { has: page.getByRole("rowheader", { name: "Clients" }) }).locator("td").nth(1)).toHaveText("1");
  await page.getByRole("group", { name: "Show rows" }).getByRole("button", { name: "Changes" }).click();
  await expect(page.getByRole("list", { name: "Rows" })).toContainText('Matched "Dillon Nichols" to Nichols, Dillon.');
  await page.screenshot({ path: "test-results/import-preview.png", fullPage: true });

  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Imported / })).toBeVisible();
  await expect(page.getByText(/^Added 8 activities\.$/)).toBeVisible();
  await page.screenshot({ path: "test-results/import-done.png" });

  // The new activities are on the property; then Undo takes them back out.
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Undo this import" }).click();
  await expect(page.getByRole("heading", { name: /^Undone / })).toBeVisible();
  await page.getByRole("link", { name: "Import" }).first().click();
  await expect(page.getByRole("table", { name: "Import history" }).locator("tbody tr").first()).toContainText("Undone");
});

test("the Properties grid marks co-counseled matters and filters to them", async ({ page }) => {
  await signIn(page);
  const props = (await (await page.request.get("/api/firm/properties")).json()).properties as { id: number; address1: string }[];
  const sheridan = props.find((p) => p.address1 === "1300 Sheridan Rd.")!.id;
  expect((await page.request.patch(`/api/firm/properties/${sheridan}`, { data: { coCounselFirm: "Lakeshore Tax Partners", coCounselRole: "handling", coCounselPercent: "40", coCounselBills: "co_counsel" } })).ok()).toBe(true);
  await page.goto("/properties");
  const row = page.locator("tr", { hasText: "1300 Sheridan Rd." });
  await expect(row.getByLabel("Co-counseled with Lakeshore Tax Partners")).toHaveText("*");
  await expect(row.getByLabel("Co-counseled with Lakeshore Tax Partners")).toHaveAttribute("title", "Co-counseled with Lakeshore Tax Partners (we're the handling firm)");
  await expect(page.locator("tr", { hasText: "1044 Tower Road" }).locator(".cc-mark")).toHaveCount(0);
  await page.getByLabel("Needs attention").selectOption("co_counsel");
  await expect(page.locator("table.grid-table tbody tr")).toHaveCount(1);
  await expect(page).toHaveURL(/flag=co_counsel/);
  await page.screenshot({ path: "test-results/properties-co-counsel.png" });
  expect((await page.request.patch(`/api/firm/properties/${sheridan}`, { data: { coCounselFirm: null } })).ok()).toBe(true);
});

test("phone width: the import pages don't scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/import");
  await expect(page.getByRole("heading", { name: "Bring data in" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.getByRole("radio", { name: /Add new clients and matters/ }).check({ force: true });
  await page.getByLabel("Choose files to import").setInputFiles([`${FIX}/AccountWorkbook.xlsx`]);
  await expect(page.getByRole("heading", { name: "New clients and matters" })).toBeVisible();
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("table", { name: "What this import would do" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "test-results/import-phone.png", fullPage: true });
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByRole("heading", { name: "Bring data in" })).toBeVisible();
});
