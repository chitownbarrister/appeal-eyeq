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
  await page.clock.setFixedTime(new Date("2026-10-19T12:00:00"));
});

test("the dashboard: KPIs, window watch, pipeline, fee forecast and win rates", async ({ page }) => {
  await signIn(page);
  const kpis = page.locator(".kpis");
  await expect(kpis).toContainText("Unfiled, window open5");
  await expect(kpis).toContainText("Next close: Elk Grove, Oct 27, 2026");
  await expect(kpis).toContainText("$274,084.32");
  await expect(kpis).toContainText("Fees ready to bill$15,060.00");
  await expect(kpis).toContainText("$94,452.00");
  await expect(kpis).toContainText("$72,801.81 at your win rates");

  const watch = page.locator("section", { has: page.getByRole("heading", { name: "Window watch" }) });
  await expect(watch.locator("tbody tr")).toHaveCount(7);
  await expect(watch.locator("tbody tr").nth(1)).toContainText("Elk Grove");
  await expect(watch.locator("tbody tr").nth(1)).toContainText("8 days");

  const pipeline = page.locator("section", { has: page.getByRole("heading", { name: "Pipeline by level and substage" }) });
  await expect(pipeline.locator("tbody tr", { hasText: "Board of Review" })).toContainText("11");
  await expect(pipeline.locator(".callout")).toContainText("2 properties have sat in Decision analysis more than 14 days");

  const forecast = page.locator("section", { has: page.getByRole("heading", { name: "When fees land" }) });
  await expect(forecast.getByRole("img")).toHaveAttribute("aria-label", /January 2027 \$59,332/);
  await forecast.locator("g.col").nth(3).hover();
  await expect(forecast.locator(".tip")).toContainText("$59,332.00");
  await expect(forecast).toContainText("1300 Sheridan Rd.");
  await expect(forecast).toContainText("3 open PTAB or Circuit Court appeals aren't included");

  const wins = page.locator("section", { has: page.getByRole("heading", { name: "Win rate and average reduction" }) });
  await expect(wins.locator("tr", { hasText: "BOR" }).first()).toContainText("73%");
  await expect(page.getByText("9 active properties sit in jurisdictions reassessed in 2027")).toBeVisible();
  await page.screenshot({ path: "test-results/dashboard-full.png", fullPage: true });

  await page.getByRole("link", { name: /Unfiled, window open/ }).click();
  await expect(page.getByText("5 of 15")).toBeVisible();
});

test("the properties summary strip filters the grid", async ({ page }) => {
  await signIn(page);
  await page.goto("/properties");
  const strip = page.getByLabel("Summary");
  await expect(strip).toContainText("Next close: Elk Grove BOR");
  await expect(strip).toContainText("$274,084.32 in play");
  await strip.getByRole("button", { name: /stalled in Decision analysis/ }).click();
  await expect(page.getByText("2 of 15")).toBeVisible();
  await page.screenshot({ path: "test-results/properties-strip.png" });
});

test("phone width: the dashboard doesn't scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await expect(page.locator(".kpis")).toContainText("$274,084.32");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
