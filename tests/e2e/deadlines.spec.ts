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
  // The sample windows and deadlines are dated around this day; the server is pinned to it too.
  await page.clock.setFixedTime(new Date("2026-10-19T12:00:00"));
});

test("deadlines sit in the property card: upcoming first, past ones folded away", async ({ page }) => {
  await signIn(page);
  await page.goto("/properties");
  await page.getByRole("link", { name: /1440 Brookdale Rd\./ }).click();
  const block = page.locator(".dlb");
  await expect(block.getByRole("list", { name: "Upcoming deadlines" })).toContainText("BOR hearing");
  await expect(block).toContainText("10:30 AM");
  await expect(block.locator("li").first().locator(".pill")).toHaveText("3 days");
  await expect(page.getByRole("tab", { name: /Deadlines/ })).toHaveCount(0);
  await expect(page.locator(".facts")).not.toContainText("Next");
  await block.getByRole("button", { name: "Show 1 past deadline" }).click();
  await expect(block.getByRole("list", { name: "Past deadlines" })).toContainText("Lisle BOR window closed");
  await page.screenshot({ path: "test-results/deadlines-card.png", fullPage: true });
});

test("adding, finishing and deleting a deadline", async ({ page }) => {
  await signIn(page);
  await page.goto("/properties");
  await page.getByRole("link", { name: /1440 Brookdale Rd\./ }).click();
  await page.locator(".dlb").getByRole("button", { name: "+ Add" }).click();
  const sheet = page.getByRole("dialog", { name: "Add a deadline" });
  await sheet.getByLabel("Type").selectOption("evidence");
  await expect(sheet.getByLabel("Name")).toHaveAttribute("placeholder", "BOR evidence due");
  await sheet.getByLabel("Date").fill("2026-10-20");
  await sheet.getByRole("button", { name: "Save deadline" }).click();
  const first = page.locator(".dlb li").first();
  await expect(first).toContainText("BOR evidence due");
  await expect(first.locator(".pill")).toHaveText("Tomorrow");

  await page.getByRole("button", { name: /Edit BOR evidence due/ }).click();
  const edit = page.getByRole("dialog", { name: "BOR evidence due" });
  await edit.getByLabel("Done").check();
  await edit.getByRole("button", { name: "Save deadline" }).click();
  await expect(page.locator(".dlb").getByRole("list", { name: "Upcoming deadlines" })).not.toContainText("BOR evidence due");
  await page.locator(".dlb").getByRole("button", { name: "Show 2 past deadlines" }).click();
  await page.getByRole("button", { name: /Edit BOR evidence due/ }).click();
  await page.getByRole("dialog", { name: "BOR evidence due" }).getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "BOR evidence due" }).locator(".confirm").getByRole("button", { name: "Delete" }).click();
  await expect(page.locator(".dlb")).not.toContainText("BOR evidence due");
});

test("the grid flags properties not yet filed while their window is open", async ({ page }) => {
  await signIn(page);
  await page.goto("/properties");
  await page.getByRole("button", { name: "5 unfiled with the window open" }).click();
  await expect(page.getByText("5 of 15")).toBeVisible();
  await expect(page.locator("tbody .pill", { hasText: "Unfiled" })).toHaveCount(5);
  await expect(page.locator("tbody tr", { hasText: "1700 Busse Rd." })).toContainText("Elk Grove BOR window closes");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.locator("tbody tr", { hasText: "1440 Brookdale Rd." })).toContainText("BOR hearing");
  await page.screenshot({ path: "test-results/grid-unfiled.png", fullPage: true });
});

test("calendar: month and list views, type filters, and links to the property", async ({ page }) => {
  await signIn(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Calendar" }).click();
  await expect(page.getByRole("heading", { name: "October 2026" })).toBeVisible();
  const oct27 = page.getByRole("gridcell", { name: "Tuesday, October 27" });
  await expect(oct27).toContainText("Elk Grove BOR window closes");
  const oct22 = page.getByRole("gridcell", { name: "Thursday, October 22" });
  await expect(oct22).toContainText("10:30 AM BOR hearing · 1440 Brookdale Rd.");
  await expect(page.locator(".cal-day.today")).toHaveAttribute("aria-label", "Monday, October 19");
  await page.screenshot({ path: "test-results/calendar-month.png", fullPage: true });

  await page.getByRole("button", { name: "Hearings" }).click();
  await expect(oct22).not.toContainText("BOR hearing");
  await page.getByRole("button", { name: "Hearings" }).click();

  await page.getByRole("button", { name: "Mine" }).click();
  await expect(oct22).not.toContainText("BOR hearing"); // Marcus and Sana's property
  await expect(oct27).toContainText("Elk Grove BOR window closes"); // Dillon has properties in Elk Grove
  await page.getByRole("button", { name: "Everyone" }).click();

  await page.getByRole("button", { name: "List", exact: true }).click();
  const day = page.locator(".cal-list .day", { hasText: "Oct 22" });
  await expect(day).toContainText("Marcus Tate, Sana Khan");
  await page.screenshot({ path: "test-results/calendar-list.png", fullPage: true });
  await page.getByRole("button", { name: "Next month" }).click();
  await expect(page.getByRole("heading", { name: "November 2026" })).toBeVisible();
  await page.getByRole("link", { name: /Tax objection hearing \(2024 levy year\)/ }).click();
  await expect(page.getByRole("heading", { name: /2550 Channahon Rd\./ })).toBeVisible();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Calendar" }).click();
  await expect(page.getByRole("button", { name: "List", exact: true })).toHaveAttribute("aria-pressed", "true"); // remembered
  await page.getByRole("button", { name: "Month", exact: true }).click();
});

test("phone width: the calendar doesn't scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/calendar");
  await expect(page.getByRole("heading", { name: "October 2026" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
