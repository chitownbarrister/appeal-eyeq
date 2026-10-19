import { expect, test, type Page } from "@playwright/test";

// Runs after the other specs (it publishes a new tax rate, which changes estimates) and ends by resetting the sample data.
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

test("publishing a tax rate refreshes open appeals and flags a decided one with a one-click apply", async ({ page, browser }) => {
  await signIn(page);
  // A decided BOR appeal on tax code 23008 that hasn't been invoiced, and an open one.
  const cook = (await (await page.request.get("/api/reference/counties")).json()).counties.find((c: { name: string }) => c.name === "Cook").id;
  const prop = await (await page.request.post("/api/firm/properties", { data: {
    newAccount: { name: "Ridge Road Trust", accountType: "individual" }, address1: "900 Ridge Road", city: "Wilmette", countyId: cook,
    taxCode: "23008", assetType: "residential", pin: "05-27-100-001-0000", firstAppeal: { assessmentYear: 2026, level: "assessor" },
  } })).json();
  const detail = await (await page.request.get(`/api/firm/properties/${prop.id}`)).json();
  const openId = detail.appeals[0].id;
  await page.request.patch(`/api/firm/appeals/${openId}`, { data: { original: { total: "70000" }, target: { total: "62800" } } });
  const decided = await (await page.request.post(`/api/firm/properties/${prop.id}/appeals`, { data: { assessmentYear: 2025, level: "bor" } })).json();
  await page.request.patch(`/api/firm/appeals/${decided.id}`, { data: { original: { total: "70000" }, resolved: { total: "62800" }, status: "reduced", substage: "decision_analysis" } });

  // The super admin publishes tax year 2025 for 23008, with its equalizer.
  const ctx = await browser.newContext();
  const admin = await ctx.newPage();
  admin.on("pageerror", (err) => { throw err; });
  await signIn(admin, "admin@appealeyeq.example", "superadmin-pass-1");
  await admin.getByRole("tab", { name: "Reference data" }).click();
  await admin.getByRole("tab", { name: "Equalizers" }).click();
  await admin.getByRole("button", { name: "+ Equalizer" }).click();
  let sheet = admin.getByRole("dialog", { name: "Publish an equalizer" });
  await sheet.getByLabel("County").selectOption({ label: "Cook" });
  await sheet.getByLabel("Year").fill("2025");
  await sheet.getByLabel("Factor").fill("3.0163");
  await sheet.getByLabel("Source").fill("Illinois Department of Revenue");
  await sheet.getByRole("button", { name: "Publish equalizer" }).click();
  await expect(admin.getByRole("status")).toContainText("Equalizer published.");
  await admin.getByRole("tab", { name: "Tax rates" }).click();
  await admin.getByRole("button", { name: "+ Rate" }).click();
  sheet = admin.getByRole("dialog", { name: "Publish a tax rate" });
  await sheet.getByLabel("County").selectOption({ label: "Cook" });
  await sheet.getByLabel("Tax code").fill("23008");
  await sheet.getByLabel("Tax year").fill("2025");
  await sheet.getByLabel("Rate %").fill("8.123456");
  await sheet.getByRole("button", { name: "Publish rate" }).click();
  await expect(admin.getByRole("status")).toContainText("Rate published. Estimates refreshed on 1 open appeal at 1 firm.");
  await admin.screenshot({ path: "test-results/admin-rates.png", fullPage: true });
  await ctx.close();

  // The open appeal now uses 2025; the decided one shows the flag and applies it on request.
  await page.goto(`/properties/${prop.id}`);
  await page.getByRole("tab", { name: "Values" }).click();
  await page.getByLabel("Choose an appeal").selectOption({ label: "2026 Assessor · Open" });
  await expect(page.getByText("Tax year 2025 · equalizer 3.0163 · tax rate 8.123456%")).toBeVisible();
  await expect(page.getByText("Newer rate published.")).toHaveCount(0);
  await page.getByLabel("Choose an appeal").selectOption({ label: "2025 Board of Review · Reduced" });
  await expect(page.getByText("Newer rate published.")).toBeVisible();
  await page.screenshot({ path: "test-results/values-newer-rate.png", fullPage: true });
  await page.getByRole("button", { name: "Apply the newer rate" }).click();
  await expect(page.getByText("Applied the latest published equalizer and rate.")).toBeVisible();
  await expect(page.getByText("Newer rate published.")).toHaveCount(0);
  await expect(page.getByText("Tax year 2025 · equalizer 3.0163 · tax rate 8.123456%")).toBeVisible();
});

test("uploading a year of windows: problems are listed and nothing is saved until they're fixed", async ({ page }) => {
  await signIn(page, "admin@appealeyeq.example", "superadmin-pass-1");
  await page.getByRole("tab", { name: "Reference data" }).click();
  await page.getByRole("button", { name: "Upload CSV" }).click();
  const box = page.getByLabel("CSV", { exact: true });
  await box.fill("County,Township,Level,Year,Opens,Closes\nCook,New Trier,Board of Review,2027,2027-07-20,2027-08-19\nCook,Atlantis,Board of Review,2027,2027-07-20,2027-08-19");
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Nothing was saved.");
  await expect(page.locator(".ref-errors")).toContainText('Row 3: "Atlantis" isn\'t a township in Cook');
  await box.fill("County,Township,Level,Year,Opens,Closes\nCook,New Trier,Board of Review,2027,2027-07-20,2027-08-19\nCook,Evanston,Board of Review,2027,2027-08-03,2027-09-02");
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Upload saved: 2 added, 0 updated, 0 already up to date.");
  await page.getByLabel("Assessment year").selectOption("2027");
  await expect(page.locator("tbody tr")).toHaveCount(2);
});

test("resetting the sample data brings back the starting set", async ({ page }) => {
  await signIn(page);
  await page.goto("/properties");
  await expect(page.getByText(/^1[67] of 1[67]$/)).toBeVisible(); // properties added by earlier tests
  await page.getByRole("button", { name: /^Account menu for/ }).click();
  await page.getByRole("menuitem", { name: "Firm settings" }).click();
  await page.getByRole("tab", { name: "Sample data" }).click();
  await page.getByRole("button", { name: "Reset sample data" }).click();
  await page.locator(".confirm").getByRole("button", { name: "Reset sample data" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Sample data reloaded." })).toBeVisible();
  await page.goto("/properties");
  await expect(page.getByText("15 of 15")).toBeVisible();
});
