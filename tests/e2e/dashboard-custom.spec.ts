import { expect, test, type Page } from "@playwright/test";

// Delivery 10e in the browser: customizing the Dashboard (add, remove, settings, resize by the
// corner, drag to reorder, the keyboard moves), saving and reloading, Reset, the firm default as a
// starting point for someone else, and phone width. Each test puts the layouts back afterwards so
// the other specs see the original Dashboard.
const PW = "sample-pass-1";

async function signIn(page: Page, email = "dillon@nicholslaw.example") {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PW);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}
const order = (page: Page) => page.locator(".dash-grid > .dcell").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.uid!.replace(/-.*/, "")));
const cell = (page: Page, type: string) => page.locator(`.dash-grid > .dcell[data-uid^="${type}"]`);

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => { throw err; });
  page.on("dialog", (d) => void d.accept());
});
test.afterEach(async ({ page }) => {
  await page.request.delete("/api/firm/dashboard/layout").catch(() => undefined);
  await page.request.delete("/api/firm/dashboard/layout/firm").catch(() => undefined);
});

test("customize: add, set up, move, remove, save, reload and reset", async ({ page }) => {
  await signIn(page);
  await page.goto("/dashboard");
  await expect(cell(page, "kpis")).toBeVisible();
  expect(await order(page)).toEqual(["kpis", "windowWatch", "byAssetType", "byLevel", "pipeline", "forecast", "winRates", "workload", "reassessment", "retention"]);

  await page.getByRole("button", { name: "Customize" }).click();
  await expect(page.getByRole("toolbar", { name: "Customize the Dashboard" })).toBeVisible();
  await page.getByRole("button", { name: "+ Add module" }).click();
  await expect(page.getByRole("dialog")).toContainText("Deadlines and work");
  await expect(page.getByRole("dialog").locator(".addmod", { hasText: "Window watch" })).toContainText("On your Dashboard");
  await page.getByRole("button", { name: "Add Tasks" }).click();
  await page.getByRole("button", { name: "Add Your number" }).click();
  await page.getByRole("button", { name: "Add Your number" }).click(); // more than one is allowed
  await page.getByRole("button", { name: "Add Aged receivables" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await order(page)).slice(0, 4)).toEqual(["aging", "customKpi", "customKpi", "tasks"]);

  // Settings on one "Your number": savings achieved at the Board of Review.
  const kpi = cell(page, "customKpi").first();
  await kpi.getByRole("button", { name: "Size and settings for Your number" }).click();
  await kpi.getByLabel("Figure for Your number").selectOption("savingsAchieved");
  await kpi.getByLabel("Level for Your number").selectOption("bor");
  await kpi.getByLabel("Height of Your number").selectOption("auto");
  await expect(kpi.locator(".value")).toContainText("$");

  // Tasks: everyone's, half width, then one place down with the keyboard buttons.
  const tasks = cell(page, "tasks");
  await tasks.getByRole("button", { name: "Size and settings for Tasks" }).click();
  await tasks.getByLabel("Whose for Tasks").selectOption("all");
  await tasks.getByLabel("Width of Tasks").selectOption("6");
  await expect(tasks).toHaveClass(/\bw6\b/);
  await tasks.getByRole("button", { name: "Move Tasks down" }).click();
  expect((await order(page)).slice(3, 5)).toEqual(["kpis", "tasks"]);
  await cell(page, "aging").getByRole("button", { name: "Move Aged receivables up" }).isDisabled();

  // Remove Retention.
  await cell(page, "retention").getByRole("button", { name: "Remove Retention" }).click();
  await expect(cell(page, "retention")).toHaveCount(0);
  // Module content can't be clicked while customizing.
  await expect(cell(page, "kpis").locator(".dcell-body")).toHaveAttribute("inert", "");
  await page.screenshot({ path: "test-results/dashboard-customize.png", fullPage: true });

  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator("main .ok[role=status]")).toContainText("Your Dashboard is saved.");
  await page.reload();
  await expect(cell(page, "aging")).toBeVisible();
  expect(await order(page)).toEqual(["aging", "customKpi", "customKpi", "kpis", "tasks", "windowWatch", "byAssetType", "byLevel", "pipeline", "forecast", "winRates", "workload", "reassessment"]);
  await expect(cell(page, "tasks")).toHaveClass(/\bw6\b/);
  await expect(cell(page, "aging")).toContainText("Aged receivables");
  await expect(cell(page, "customKpi").first().locator(".label")).toHaveText("Savings achieved");
  await expect(cell(page, "customKpi").first().locator(".note")).toHaveText("Board of Review");
  await page.screenshot({ path: "test-results/dashboard-saved.png", fullPage: true });

  // Cancel throws away changes.
  await page.getByRole("button", { name: "Customize" }).click();
  await cell(page, "aging").getByRole("button", { name: "Remove Aged receivables" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(cell(page, "aging")).toBeVisible();

  // Reset: back to the original.
  await page.getByRole("button", { name: "Customize" }).click();
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page.locator("main .ok[role=status]")).toContainText("Back to the original Dashboard.");
  expect(await order(page)).toEqual(["kpis", "windowWatch", "byAssetType", "byLevel", "pipeline", "forecast", "winRates", "workload", "reassessment", "retention"]);
});

test("resize by the corner, and drag a module by its handle", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await signIn(page);
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Customize" }).click();

  // Pull Properties by asset type's corner right: Medium (4 of 12) to Half (6 of 12).
  const asset = cell(page, "byAssetType");
  await expect(asset).toHaveClass(/\bw4\b/);
  await asset.locator(".dcell-resize").scrollIntoViewIfNeeded();
  const grid = await page.locator(".dash-grid").boundingBox();
  const corner = await asset.locator(".dcell-resize").boundingBox();
  const col = (grid!.width + 16) / 12;
  await page.mouse.move(corner!.x + 9, corner!.y + 9);
  await page.mouse.down();
  await page.mouse.move(corner!.x + 9 + col, corner!.y + 9, { steps: 6 });
  await page.mouse.move(corner!.x + 9 + col * 2, corner!.y + 9, { steps: 6 });
  await page.mouse.up();
  await expect(asset).toHaveClass(/\bw6\b/);
  // And down, to a fixed height that scrolls inside.
  await asset.locator(".dcell-resize").scrollIntoViewIfNeeded();
  const c2 = await asset.locator(".dcell-resize").boundingBox();
  await page.mouse.move(c2!.x + 9, c2!.y + 9);
  await page.mouse.down();
  await page.mouse.move(c2!.x + 9, c2!.y + 9 + 260, { steps: 10 });
  await page.mouse.up();
  await expect(asset).toHaveClass(/\bh-(s|m)\b/);

  // Drag Properties at each level onto the Headline numbers, before them.
  await page.evaluate(() => window.scrollTo(0, 0));
  const handle = cell(page, "byLevel").locator(".dbar-handle");
  const target = cell(page, "kpis");
  const tb = await target.boundingBox();
  await handle.dragTo(target, { targetPosition: { x: 20, y: 10 } });
  expect(tb).not.toBeNull();
  await expect.poll(async () => (await order(page))[0]).toBe("byLevel");

  await page.getByRole("button", { name: "Done" }).click();
  await page.reload();
  await expect(cell(page, "byLevel")).toBeVisible();
  expect((await order(page)).slice(0, 2)).toEqual(["byLevel", "kpis"]);
  await expect(cell(page, "byAssetType")).toHaveClass(/\bw6\b/);
});

test("the firm default is where someone else starts, and they can still change their own", async ({ page, browser }) => {
  await signIn(page);
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Customize" }).click();
  for (const t of ["Pipeline by level and substage", "When fees land", "Win rate and average reduction"]) {
    await page.getByRole("button", { name: `Remove ${t}` }).click();
  }
  await page.getByRole("button", { name: "+ Add module" }).click();
  await page.getByRole("button", { name: "Add Deadlines and hearings, next 14 days" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Save as firm default" }).click();
  await expect(page.locator("main .ok[role=status]")).toContainText("Saved as the firm's default");

  const ctx = await browser.newContext();
  const julie = await ctx.newPage();
  julie.on("dialog", (d) => void d.accept());
  await signIn(julie, "julie@nicholslaw.example");
  await julie.goto("/dashboard");
  await expect(cell(julie, "deadlines")).toBeVisible();
  await expect(cell(julie, "pipeline")).toHaveCount(0);
  // An analyst can't set the firm default.
  await julie.getByRole("button", { name: "Customize" }).click();
  await expect(julie.getByRole("button", { name: "Save as firm default" })).toHaveCount(0);
  await cell(julie, "deadlines").getByRole("button", { name: "Remove Deadlines and hearings, next 14 days" }).click();
  await julie.getByRole("button", { name: "Done" }).click();
  await julie.reload();
  await expect(cell(julie, "kpis")).toBeVisible();
  await expect(cell(julie, "deadlines")).toHaveCount(0);
  // Her Reset goes back to the firm default, not the original.
  await julie.getByRole("button", { name: "Customize" }).click();
  await julie.getByRole("button", { name: "Reset" }).click();
  await expect(julie.locator("main .ok[role=status]")).toContainText("the firm's default");
  await expect(cell(julie, "deadlines")).toBeVisible();
  await julie.request.delete("/api/firm/dashboard/layout");
  await ctx.close();

  // Dillon stops using a firm default.
  await page.request.delete("/api/firm/dashboard/layout");
  await page.reload();
  await expect(page.getByText("You're seeing the firm's default Dashboard.")).toBeVisible();
  await page.getByRole("button", { name: "Stop using a firm default" }).click();
  await expect(page.locator("main .ok[role=status]")).toContainText("The firm default is cleared.");
  await expect(cell(page, "pipeline")).toBeVisible();
});

test("phone width: one column, customizing included, no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/dashboard");
  await expect(cell(page, "kpis")).toBeVisible();
  const noSideways = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(await noSideways()).toBe(true);
  const widths = await page.locator(".dash-grid > .dcell").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
  expect(new Set(widths).size).toBe(1);
  await page.getByRole("button", { name: "Customize" }).click();
  await page.getByRole("button", { name: "+ Add module" }).click();
  await page.getByRole("button", { name: "Add This week" }).click();
  await page.keyboard.press("Escape");
  expect(await noSideways()).toBe(true);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(cell(page, "week")).toContainText("This week");
  expect(await noSideways()).toBe(true);
  await page.screenshot({ path: "test-results/dashboard-phone.png", fullPage: true });
});

test("every module draws on a wide Dashboard", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page);
  const types = ["deadlines", "tasks", "week", "decisions", "refunds", "readyToBill", "aging", "collected", "trust", "expenses", "topClients", "savingsByYear", "recentProperties", "coCounsel", "imports", "customKpi"];
  const widths: Record<string, number> = { week: 8, aging: 6, collected: 6, savingsByYear: 6, customKpi: 3 };
  const layout = { version: 1, modules: types.map((t) => ({ uid: t, type: t, w: widths[t] ?? 4, h: "auto" })) };
  expect((await page.request.put("/api/firm/dashboard/layout", { data: { layout } })).ok()).toBe(true);
  await page.goto("/dashboard");
  for (const t of types) await expect(cell(page, t)).toBeVisible();
  await expect(page.locator(".dash-grid")).not.toContainText("Loading");
  await expect(page.locator(".dash-grid .error")).toHaveCount(0);
  await page.screenshot({ path: "test-results/dashboard-all-modules.png", fullPage: true });
});
