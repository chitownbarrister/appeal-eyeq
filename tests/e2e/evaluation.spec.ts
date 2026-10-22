import { expect, test, type Page } from "@playwright/test";

// Delivery 10b in the browser: the Evaluation tab on 1044 Tower Road (three years, PIN detail),
// the full history overlay, the Excel downloads, and co-counsel on 1300 Sheridan Rd.
const PW = "sample-pass-1";

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

test("the Evaluation tab: three years, PIN detail, full history and the Excel export", async ({ page }) => {
  await signIn(page);
  await page.goto(`/properties/${await propertyId(page, "1044 Tower Road")}`);
  await page.getByRole("tab", { name: "Evaluation" }).click();
  const summary = page.getByRole("table", { name: "Summary by assessment year" });
  await expect(summary.locator("thead th")).toHaveText(["Assessment year", "2024", "2025", "2026"]);
  const savings = summary.locator("tr", { has: page.getByRole("rowheader", { name: "Tax savings" }) });
  await expect(savings.locator("td").nth(1)).toHaveText("$1,736.12");
  await expect(summary.locator("tr", { has: page.getByRole("rowheader", { name: /Fair market value/ }) }).locator("td").nth(1)).toHaveText("$628,000");
  await expect(page.locator(".ev-facts")).toContainText("Land SF7,501 from acreage");
  await expect(page.getByRole("table", { name: "PIN detail" })).toContainText("05-17-302-010-0000");
  await page.screenshot({ path: "test-results/evaluation-tab.png", fullPage: true });

  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download Excel" }).click()]);
  expect(dl.suggestedFilename()).toBe("05-17-302-010 - Evaluation Worksheet (2026).xlsx");

  await page.getByRole("button", { name: /^Full history/ }).click();
  const ov = page.getByRole("dialog", { name: "Full history" });
  await expect(ov.getByRole("table", { name: "Every assessment year" })).toBeVisible();
  await expect(ov.getByRole("table", { name: "Every assessment year" })).toContainText("BOR: Reduced");
  await page.screenshot({ path: "test-results/evaluation-history.png" });
  const [all] = await Promise.all([page.waitForEvent("download"), ov.getByRole("link", { name: "Download Excel (all years)" }).click()]);
  expect(all.suggestedFilename()).toBe("05-17-302-010 - Evaluation Worksheet (2026) full history.xlsx");
  await page.keyboard.press("Escape");
  await expect(ov).toHaveCount(0);
});

test("co-counsel on a property: terms, share and net fee, and the client's tag", async ({ page }) => {
  await signIn(page);
  const sheridan = await propertyId(page, "1300 Sheridan Rd.");
  await page.goto(`/properties/${sheridan}`);
  await page.locator("dl.facts").getByRole("button", { name: "Edit" }).click();
  const s = page.getByRole("dialog");
  await s.getByText("This property is co-counseled with another firm").click();
  await s.getByLabel("Co-counsel firm").fill("Lakeshore Tax Partners");
  await s.getByLabel("Our firm is the").selectOption("relationship");
  await s.getByLabel("Co-counsel's share of the fee %").fill("30");
  await s.getByLabel("Who bills the client").selectOption("us");
  await s.getByRole("button", { name: "Save fee terms" }).click();
  await expect(s).toHaveCount(0);

  await page.getByRole("tab", { name: "Evaluation" }).click();
  await expect(page.locator(".ev-facts")).toContainText("Lakeshore Tax Partners · we're the relationship firm · their share 30% · we bill");
  const summary = page.getByRole("table", { name: "Summary by assessment year" });
  await expect(summary.getByRole("rowheader", { name: "Lakeshore Tax Partners's share (30%)" })).toBeVisible();
  await expect(summary.getByRole("rowheader", { name: "Our net fee" })).toBeVisible();

  await page.getByRole("link", { name: "Sheridan Shore Apartments LP" }).first().click();
  await expect(page.getByText("Co-counseled · 1 property with Lakeshore Tax Partners")).toBeVisible();

  // Back to how it was, for the specs after this one.
  expect((await page.request.patch(`/api/firm/properties/${sheridan}`, { data: { coCounselFirm: null } })).ok()).toBe(true);
});

test("phone width: the Evaluation tab and the overlay don't scroll the page sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto(`/properties/${await propertyId(page, "1044 Tower Road")}?tab=evaluation`);
  await expect(page.getByRole("table", { name: "Summary by assessment year" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: /^Full history/ }).click();
  await expect(page.getByRole("dialog", { name: "Full history" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
