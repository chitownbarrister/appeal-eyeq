import { expect, test, type Page } from "@playwright/test";

const PW = "sample-pass-1";

async function signIn(page: Page, email = "dillon@nicholslaw.example", password = PW) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: /^Account menu for/ })).toBeVisible();
}
const menuButton = (page: Page) => page.getByRole("button", { name: /^Account menu for/ });

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => { throw err; });
});

test("the account menu: who you are, settings, integrations, sign out; Settings is gone from the top nav", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" })).toHaveCount(0);
  const button = menuButton(page);
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const menu = page.getByRole("menu", { name: "Account" });
  await expect(menu).toContainText("dillon@nicholslaw.example");
  await expect(menu).toContainText("Nichols Law · Attorney");
  await expect(menu).toContainText("Firm admin");
  await expect(menu.getByRole("menuitem")).toHaveText(["Your account", "Firm settings", "Integrations", "Sign out"]);
  await page.screenshot({ path: "test-results/account-menu.png" });

  // A click elsewhere closes it.
  await page.getByRole("heading", { level: 1 }).click();
  await expect(menu).toHaveCount(0);

  // Firm settings, then Integrations while already on Settings switches the tab.
  await button.click();
  await page.getByRole("menuitem", { name: "Firm settings" }).click();
  await expect(page.getByRole("heading", { name: "Firm settings" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Firm profile" })).toHaveAttribute("aria-selected", "true");
  await button.click();
  await page.getByRole("menuitem", { name: "Integrations" }).click();
  await expect(page.getByRole("tab", { name: "Integrations" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("the menu works from the keyboard", async ({ page }) => {
  await signIn(page);
  const button = menuButton(page);
  await button.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Your account" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Firm settings" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Your account" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Your account" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Dillon Nichols", level: 1 })).toBeVisible();
});

test("an analyst who isn't a firm admin sees no Integrations item", async ({ page }) => {
  await signIn(page, "julie@nicholslaw.example");
  await menuButton(page).click();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Your account", "Firm settings", "Sign out"]);
  await expect(page.getByRole("menu")).toContainText("Nichols Law · Analyst");
});

test("changing your password from Your account", async ({ page, browser }) => {
  // A second browser signed in as Marcus is signed out by the change.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await signIn(otherPage, "marcus@nicholslaw.example");

  await signIn(page, "marcus@nicholslaw.example");
  await menuButton(page).click();
  await page.getByRole("menuitem", { name: "Your account" }).click();
  await expect(page.getByRole("heading", { name: "Marcus Tate", level: 1 })).toBeVisible();
  await expect(page.locator(".facts")).toContainText("marcus@nicholslaw.example");

  const fill = async (current: string, next: string, confirm = next) => {
    await page.getByLabel("Current password").fill(current);
    await page.getByLabel("New password", { exact: true }).fill(next);
    await page.getByLabel("New password again").fill(confirm);
    await page.getByRole("button", { name: "Change password" }).click();
  };
  await fill(PW, "marcus-browser-9", "marcus-browser-8");
  await expect(page.getByRole("alert")).toHaveText("The two new passwords don't match.");
  await fill("not-my-password", "marcus-browser-9");
  await expect(page.getByRole("alert")).toHaveText("Your current password isn't right.");
  await fill(PW, "marcus-browser-9");
  await expect(page.getByText("Password changed.")).toBeVisible();
  await expect(page.getByLabel("Current password")).toHaveValue("");
  await page.screenshot({ path: "test-results/your-account.png", fullPage: true });

  await otherPage.goto("/properties");
  await expect(otherPage.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await other.close();

  // Put it back for the other tests.
  await fill("marcus-browser-9", PW);
  await expect(page.getByText("Password changed.")).toBeVisible();
});

test("the super admin's menu has the console and no firm settings", async ({ page }) => {
  await signIn(page, "admin@appealeyeq.example", "superadmin-pass-1");
  await menuButton(page).click();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Your account", "Firms & reference data", "Sign out"]);
  await page.getByRole("menuitem", { name: "Your account" }).click();
  await expect(page.getByText("The super admin's name and email are set in the server's settings.")).toBeVisible();
});

test("phone width: the menu shows initials, fits on screen, and signs out", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 });
  await signIn(page);
  await expect(page.locator(".avatar")).toHaveText("DN");
  await menuButton(page).click();
  const box = await page.getByRole("menu").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.screenshot({ path: "test-results/account-menu-phone.png" });
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});
