import { expect, test, type Page } from "@playwright/test";

// Delivery 10f in the browser: property photos as avatars on the grid, the client page and search,
// the photo panel on the property page (open, change, remove), and the firm logo in Firm profile
// and the top bar.
const PW = "sample-pass-1";

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

test("avatars on the grid, the client page and search", async ({ page }) => {
  await signIn(page);
  await page.goto("/properties");
  const row = page.locator("tr", { hasText: "1300 Sheridan Rd." });
  const avatar = row.getByRole("img", { name: "Photo of 1300 Sheridan Rd." });
  await expect(avatar).toBeVisible();
  await expect.poll(() => avatar.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);
  await expect(page.locator("table.grid-table img.pavatar")).toHaveCount(15);
  await page.screenshot({ path: "test-results/photos-grid.png" });

  await row.getByRole("link", { name: "Sheridan Shore Apartments LP" }).click();
  await expect(page.locator("tr", { hasText: "1300 Sheridan Rd." }).locator("img.pavatar")).toBeVisible();

  await page.getByLabel("Search properties, clients, appeals and documents").fill("Busse");
  await expect(page.locator(".search-results img.pavatar")).toBeVisible();
  await page.screenshot({ path: "test-results/photos-search.png" });
});

test("the photo panel: open it, change it, remove it, and add it back", async ({ page }) => {
  await signIn(page);
  const props = (await (await page.request.get("/api/firm/properties")).json()).properties as { id: number; address1: string }[];
  const id = props.find((p) => p.address1 === "214 S. Third St.")!.id;
  await page.goto(`/properties/${id}`);
  const panel = page.locator(".pphoto");
  await expect(panel.getByRole("img", { name: "Photo of 214 S. Third St., Geneva" })).toBeVisible();
  await page.screenshot({ path: "test-results/photos-property.png" });

  await panel.getByRole("button", { name: /^Open the photo/ }).click();
  await expect(page.getByRole("dialog", { name: /^Photo of/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Replace it with another of the sample photos (any JPEG will do).
  const before = await panel.locator("img").getAttribute("src");
  await page.getByLabel("Choose a photo of the property").setInputFiles("db/seed/sample/photos/1440-brookdale.jpg");
  await expect.poll(() => panel.locator("img").getAttribute("src")).not.toBe(before);

  page.once("dialog", (d) => void d.accept());
  await panel.getByRole("button", { name: "Remove" }).click();
  await expect(panel.getByText("No photo yet")).toBeVisible();
  await page.goto("/properties");
  await expect(page.locator("tr", { hasText: "214 S. Third St." }).locator(".pavatar.empty")).toBeVisible();

  await page.goto(`/properties/${id}`);
  await page.getByLabel("Choose a photo of the property").setInputFiles("db/seed/sample/photos/214-s-third.jpg");
  await expect(panel.getByRole("img", { name: /^Photo of 214 S. Third St./ })).toBeVisible();
});

test("the firm logo: set in Firm profile, shown in the top bar, then removed", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: /^Account menu for/ }).click();
  await page.getByRole("menuitem", { name: "Firm settings" }).click();
  await expect(page.getByRole("tab", { name: "Firm profile" })).toHaveAttribute("aria-selected", "true");
  await page.getByLabel("Choose a logo image").setInputFiles("db/seed/sample/photos/820-s-clinton.jpg");
  await expect(page.getByText(/^Logo saved\./)).toBeVisible();
  await expect(page.locator("header.topbar").getByRole("img", { name: "Nichols Law logo" })).toBeVisible();
  await page.screenshot({ path: "test-results/firm-profile-logo.png" });
  await page.getByRole("tab", { name: "Billing" }).click();
  await expect(page.getByRole("img", { name: "Your letterhead logo" })).toBeVisible();
  await page.getByRole("tab", { name: "Firm profile" }).click();
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Logo removed.")).toBeVisible();
  await expect(page.locator("header.topbar img")).toHaveCount(0);
});

test("phone width: the property page with its photo doesn't scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const props = (await (await page.request.get("/api/firm/properties")).json()).properties as { id: number; address1: string }[];
  await page.goto(`/properties/${props.find((p) => p.address1 === "1700 Busse Rd.")!.id}`);
  await expect(page.locator(".pphoto img")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "test-results/photos-phone.png", fullPage: true });
});
