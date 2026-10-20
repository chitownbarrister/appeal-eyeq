import { expect, test, type Page } from "@playwright/test";

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

test("property grid: all sample properties, filters and sorting", async ({ page }) => {
  await signIn(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Properties" }).click();
  await expect(page.getByRole("heading", { name: "Properties", level: 1 })).toBeVisible();
  await expect(page.getByText("15 of 15")).toBeVisible();
  await page.getByLabel("County").selectOption("Kane");
  await expect(page.getByText("2 of 15")).toBeVisible();
  await expect(page.getByRole("link", { name: /3800 E\. Main St\., St\. Charles \(St\. Charles\)/ })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByRole("columnheader", { name: /Est\. savings/ }).click();
  await page.getByRole("columnheader", { name: /Est\. savings/ }).click();
  await expect(page.locator("tbody tr").first()).toContainText("1700 Busse Rd.");
  await page.screenshot({ path: "test-results/properties.png", fullPage: true });
});

test("property page: year track, appeals and the 2025 BOR at $1,736.12", async ({ page }) => {
  await signIn(page);
  await page.goto("/properties");
  await page.getByRole("link", { name: /1044 Tower Road, Winnetka/ }).click();
  await expect(page.getByRole("heading", { name: "1044 Tower Road, Winnetka (New Trier)" })).toBeVisible();
  await expect(page.locator(".pin-head")).toHaveText("PIN 05-17-302-010");
  await expect(page.getByText("Board of Review · Appeal filed")).toBeVisible();
  await expect(page.getByRole("button", { name: "2026 · current" })).toBeVisible();
  await page.screenshot({ path: "test-results/property-1044.png", fullPage: true });

  await page.getByRole("button", { name: "2025", exact: true }).click();
  await page.getByRole("button", { name: "Open Board of Review values" }).click();
  await expect(page.getByRole("tab", { name: "Values" })).toHaveAttribute("aria-selected", "true");
  const values = page.locator("table.values");
  await expect(values).toContainText("$16,878.97");
  await expect(values).toContainText("$15,142.85");
  await expect(values).toContainText("$1,736.12");
  await expect(values).toContainText("$694.45");
  await expect(values).toContainText("waived, no fee");
  await expect(values).toContainText("700,000");
  await expect(values).toContainText("628,000");
  await page.screenshot({ path: "test-results/values-2025-bor.png", fullPage: true });
});

test("editing an appeal recalculates live, saves, and moves the year track", async ({ page }) => {
  await signIn(page);
  await page.goto("/properties");
  await page.getByRole("link", { name: /1044 Tower Road, Winnetka/ }).click();
  await page.getByRole("tab", { name: "Values" }).click();
  await page.getByLabel("Choose an appeal").selectOption({ label: "2026 Board of Review · Waiting for decision" });
  await page.getByLabel("Enter tax figures by hand (no calculation)").uncheck();
  await page.getByRole("button", { name: "Use latest published rates" }).click();
  await expect(page.getByText("Applied the latest published equalizer and rate.")).toBeVisible();
  await expect(page.locator("table.values")).toContainText("$1,736.12");

  await page.getByLabel("Resolved Land AV").fill("20250");
  await page.getByLabel("Resolved Improvement / building AV").fill("42,550");
  await expect(page.locator("table.values tr", { hasText: "Total AV" })).toContainText("62,800");
  await page.getByLabel("Status").selectOption("reduced");
  await page.getByRole("button", { name: "Save appeal" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  await page.getByRole("button", { name: "Set Board of Review to Decision analysis" }).click();
  await expect(page.getByText("Board of Review · Decision analysis")).toBeVisible();
  await page.getByRole("tab", { name: "Appeals" }).click();
  const row = page.locator("tbody tr", { hasText: "Decision analysis" }).first();
  await expect(row).toContainText("Reduced");
  await expect(row).toContainText("$1,736.12");
});

test("creating a property with a new client, then finding it with global search", async ({ page }) => {
  await signIn(page);
  await page.goto("/properties");
  await page.getByRole("button", { name: "+ New property" }).click();
  const sheet = page.getByRole("dialog", { name: "New property" });
  await sheet.getByLabel("Client").selectOption("new");
  await sheet.getByLabel("New client name").fill("Lakeview Holdings LLC");
  await sheet.getByLabel("Type", { exact: true }).selectOption("entity");
  await sheet.getByLabel("Address").fill("2800 N. Lake Shore Dr.");
  await sheet.getByLabel("City").fill("Chicago");
  await sheet.getByLabel("County").selectOption({ label: "Cook" });
  await sheet.getByLabel("Township").selectOption({ label: "Lake View" });
  await sheet.getByLabel("PIN").fill("14-28-200-011-0000");
  await sheet.getByLabel("Asset type").selectOption("commercial");
  await sheet.getByLabel("Attorney").selectOption({ label: "Marcus Tate" });
  await sheet.getByRole("button", { name: "Create property" }).click();
  await expect(page.getByRole("heading", { name: "2800 N. Lake Shore Dr., Chicago (Lake View)" })).toBeVisible();
  await expect(page.locator(".pin-head")).toHaveText("PIN 14-28-200-011");
  await expect(page.locator(".facts")).toContainText("Level of assessment25%");
  await expect(page.locator(".txlvl.cur")).toContainText("Assessor");

  const search = page.getByLabel("Search properties, clients, appeals and documents");
  await search.fill("lakeview");
  await expect(page.getByRole("option", { name: /Lakeview Holdings LLC/ })).toBeVisible();
  await search.press("Enter");
  await expect(page.getByRole("heading", { name: "Lakeview Holdings LLC" })).toBeVisible();
  await expect(page.getByRole("link", { name: /2800 N\. Lake Shore Dr\./ })).toBeVisible();
});

test("clients list and client page", async ({ page }) => {
  await signIn(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Accounts" }).click();
  await expect(page.getByRole("heading", { name: "Clients", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Prairie Crossing Industrial LLC" }).click();
  await expect(page.getByText("Custom: 30% at all levels")).toBeHidden();
  await expect(page.locator(".kpis")).toContainText("30.00%");
  await expect(page.getByRole("link", { name: /2400 Channahon Rd\./ })).toBeVisible();
  await expect(page.getByRole("link", { name: /2550 Channahon Rd\./ })).toBeVisible();
  await page.screenshot({ path: "test-results/client.png", fullPage: true });
});

test("when the session ends while a page is open, the app returns to sign-in with a note", async ({ page }) => {
  await signIn(page);
  await page.goto("/properties");
  await expect(page.getByText(/\d+ of \d+/)).toBeVisible();
  await page.request.post("/api/auth/logout", { data: {} });
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Accounts" }).click();
  await expect(page.getByText("Your session ended, so you've been signed out.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("laptop width: every top-nav link fits without clipping", async ({ page }) => {
  await signIn(page);
  const nav = page.getByRole("navigation", { name: "Main" });
  const clipped = await nav.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(clipped).toBeLessThanOrEqual(0);
  await page.goto("/properties");
  const grid = page.locator(".tw").first();
  expect(await grid.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
});

test("phone width: the property page doesn't scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/properties");
  await page.getByRole("link", { name: /1044 Tower Road, Winnetka/ }).click();
  await expect(page.getByRole("heading", { name: /1044 Tower Road/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "test-results/property-phone.png", fullPage: true });
});
