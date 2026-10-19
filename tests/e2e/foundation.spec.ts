import { expect, test, type Page } from "@playwright/test";

const PW = "sample-pass-1";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.beforeEach(async ({ page }) => {
  // Any uncaught script error fails the test: a top-level error would blank every screen.
  page.on("pageerror", (err) => {
    throw err;
  });
});

test("an attorney signs in and sees the sample dashboard with exact figures", async ({ page }) => {
  await signIn(page, "dillon@nicholslaw.example", PW);
  await expect(page.getByRole("heading", { name: "Nichols Law" })).toBeVisible();
  await expect(page.getByText("Sample data. Nichols Law is a demonstration firm")).toBeVisible();
  await expect(page.getByText("$274,084.32")).toBeVisible();
  await expect(page.getByText("$2,290.20")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" })).toHaveCount(0);
  for (const label of ["Dashboard", "Properties", "Accounts", "Calendar", "Decisions", "Billing"]) {
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: label })).toBeVisible();
  }
  await page.screenshot({ path: "test-results/dashboard.png", fullPage: true });
});

test("a wrong password shows an error", async ({ page }) => {
  await signIn(page, "dillon@nicholslaw.example", "not-the-password");
  await expect(page.getByRole("alert")).toContainText("don't match");
});

test("settings: users, fees, permissions and the audit trail work end to end", async ({ page }) => {
  await signIn(page, "dillon@nicholslaw.example", PW);
  await page.getByRole("button", { name: /^Account menu for/ }).click();
  await page.getByRole("menuitem", { name: "Firm settings" }).click();
  await expect(page.getByRole("cell", { name: "julie@nicholslaw.example" })).toBeVisible();

  await page.getByRole("tab", { name: "Fee defaults" }).click();
  const bor = page.getByLabel("Board of Review fee percent");
  await expect(bor).toHaveValue("40.00");
  await bor.fill("38.50");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Board of Review fee saved.")).toBeVisible();
  await expect(bor).toHaveValue("38.50");

  await page.getByRole("tab", { name: "Audit log" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Changed fee defaults" }).first()).toContainText("Dillon Nichols");
  // Put the fee back so later tests see the default.
  await page.getByRole("tab", { name: "Fee defaults" }).click();
  await page.getByLabel("Board of Review fee percent").fill("40");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Board of Review fee saved.")).toBeVisible();

  await page.getByRole("tab", { name: "Roles & permissions" }).click();
  const toggle = page.getByLabel("Void invoices for analyst");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await page.screenshot({ path: "test-results/settings-permissions.png", fullPage: true });
});

test("support access: the super admin is locked out until granted, reads are logged, and revocation ends access", async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  admin.on("pageerror", (err) => { throw err; });
  await signIn(admin, "admin@appealeyeq.example", "superadmin-pass-1");
  await expect(admin.getByRole("heading", { name: "Firms and reference data" })).toBeVisible();
  const nicholsRow = admin.getByRole("row").filter({ hasText: "Nichols Law" });
  await expect(nicholsRow).toContainText("Not granted");
  await expect(nicholsRow.getByRole("button", { name: "View (read-only)" })).toHaveCount(0);

  const firmCtx = await browser.newContext();
  const dillon = await firmCtx.newPage();
  dillon.on("pageerror", (err) => { throw err; });
  await signIn(dillon, "dillon@nicholslaw.example", PW);
  await dillon.getByRole("button", { name: /^Account menu for/ }).click();
  await dillon.getByRole("menuitem", { name: "Firm settings" }).click();
  await dillon.getByRole("tab", { name: "Support access" }).click();
  await dillon.getByLabel("Reason (optional)").fill("Onboarding help");
  await dillon.getByRole("button", { name: "Grant access" }).click();
  await expect(dillon.getByText(/Access open until/)).toBeVisible();

  await admin.reload();
  await admin.getByRole("row").filter({ hasText: "Nichols Law" }).getByRole("button", { name: "View (read-only)" }).click();
  await expect(admin.getByText(/under support access, read-only/)).toBeVisible();
  await expect(admin.getByText("$2,290.20")).toBeVisible();
  await admin.screenshot({ path: "test-results/support-view.png", fullPage: true });

  await dillon.reload();
  await dillon.getByRole("tab", { name: "Support access" }).click();
  await expect(dillon.getByRole("cell", { name: "/api/firm/summary" }).first()).toBeVisible();
  await dillon.getByRole("button", { name: "End access now" }).click();
  await expect(dillon.getByRole("button", { name: "Grant access" })).toBeVisible();

  await admin.reload();
  await expect(admin.getByRole("heading", { name: "Firms and reference data" })).toBeVisible();
  await expect(admin.getByRole("row").filter({ hasText: "Nichols Law" })).toContainText("Not granted");

  await adminCtx.close();
  await firmCtx.close();
});

test("the super admin creates a firm and its attorney signs in to an empty firm", async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await signIn(admin, "admin@appealeyeq.example", "superadmin-pass-1");
  await admin.getByLabel("Firm name").fill("Lakeview Tax Partners");
  await expect(admin.getByLabel("Short name")).toHaveValue("lakeview-tax-partners");
  await admin.getByLabel("First attorney").fill("Lee Lakeview");
  await admin.getByLabel("Attorney email").fill("lee@lakeviewtax.example");
  await admin.getByLabel("Temporary password").fill("lakeview-pass-1");
  await admin.getByRole("button", { name: "Create firm" }).click();
  await expect(admin.getByText("Lakeview Tax Partners created.")).toBeVisible();
  await adminCtx.close();

  const ctx = await browser.newContext();
  const lee = await ctx.newPage();
  await signIn(lee, "lee@lakeviewtax.example", "lakeview-pass-1");
  await expect(lee.getByRole("heading", { name: "Lakeview Tax Partners" })).toBeVisible();
  await expect(lee.locator(".subtitle")).toContainText("0 active properties");
  await expect(lee.getByText("Sample data.")).toHaveCount(0);
  await ctx.close();
});

test("signing out returns to the sign-in page, and deep links are guarded", async ({ page }) => {
  await signIn(page, "julie@nicholslaw.example", PW);
  await expect(page.getByText("Nichols Law · Analyst")).toBeVisible();
  await page.getByRole("button", { name: /^Account menu for/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});
