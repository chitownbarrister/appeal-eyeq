import { expect, test, type Page } from "@playwright/test";

// Delivery 7: values per PIN, dividing an agreed total, offers, the stipulation lock,
// the same-cycle PTAB rollover and the pending PTAB flag.
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

test("three PINs: itemized values, a divided agreed total, an offer and a locked stipulation", async ({ page }) => {
  await signIn(page);
  await page.goto("/properties");
  await page.getByRole("link", { name: /1415 W\. Grand Ave\./ }).click();
  await expect(page.locator(".pin-head")).toContainText("and 2 more");
  await page.getByRole("tab", { name: "Values" }).click();
  await page.getByLabel("Choose an appeal").selectOption({ label: "2026 Board of Review · Open" });

  const table = page.locator("table.pintable");
  await expect(table).toContainText("17-08-101-022");
  await expect(table).toContainText("17-08-101-023");
  await expect(table).toContainText("17-08-101-024");
  await expect(table.locator("tr.ptotal").first()).toContainText("412,500");
  await expect(page.locator(".vtile", { hasText: "Original AV" })).toContainText("412,500");

  // The agreed 380,000 AV: land held, building takes the change; the lot has no building, so its land does.
  await page.getByRole("button", { name: "Divide an agreed total" }).click();
  const divide = page.locator("form.divide");
  await divide.getByLabel("Set", { exact: true }).selectOption("resolved");
  await divide.getByLabel("Agreed as").selectOption("av");
  await divide.getByLabel(/Total AV for the PINs on the appeal/).fill("380,000");
  await divide.getByRole("button", { name: "Divide", exact: true }).click();
  await expect(page.getByText("Divided among the PINs: land held, building takes the change.")).toBeVisible();
  await expect(page.getByLabel("17-08-101-022-0000 Resolved building")).toHaveValue(/242,?125/);
  await expect(page.getByLabel("17-08-101-023-0000 Resolved building")).toHaveValue(/36,?375/);
  await expect(page.getByLabel("17-08-101-024-0000 Resolved land")).toHaveValue(/19,?000/);
  await expect(page.locator(".vtile", { hasText: "Resolved AV" })).toContainText("380,000");
  await expect(page.locator(".vtile", { hasText: "Of the requested reduction" })).toContainText("%");
  await page.screenshot({ path: "test-results/pins-divided.png", fullPage: true });

  // An offer from the Board, recorded as a market value and split the same way.
  await page.getByRole("button", { name: /Offer history/ }).click();
  const form = page.getByRole("form", { name: "Record an offer" });
  await form.getByLabel("From").selectOption("board_of_review");
  await form.getByLabel("As").selectOption("fmv");
  await form.getByLabel("Amount").fill("1,560,000");
  await form.getByRole("button", { name: "Record offer" }).click();
  await expect(page.getByRole("button", { name: "Hide offer history" })).toBeVisible();
  await expect(page.locator(".pinvals")).toContainText("1,560,000");
  await page.getByRole("button", { name: "Show offers" }).click();
  await expect(table.locator("thead")).toContainText("Board of Review offer");

  // Locking the stipulation freezes the resolved figures.
  await page.getByRole("button", { name: "Lock stipulation" }).click();
  await expect(page.locator(".pill", { hasText: "Stipulation locked" })).toBeVisible();
  await expect(page.getByLabel("17-08-101-022-0000 Resolved building")).toHaveCount(0);
  await page.screenshot({ path: "test-results/pins-locked.png", fullPage: true });
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("button", { name: "Lock stipulation" })).toBeVisible();
});

test("a same-cycle PTAB decision rolls into the later appeal's target, and pending PTABs are flagged", async ({ page }) => {
  await signIn(page);
  const ref = await (await page.request.get("/api/reference/counties")).json();
  const cook = ref.counties.find((c: { name: string }) => c.name === "Cook").id;
  const lakeView = ref.townships.find((t: { name: string; county_id: number }) => t.name === "Lake View" && t.county_id === cook).id;
  const prop = await (await page.request.post("/api/firm/properties", { data: {
    newAccount: { name: "Belmont Harbor LLC", accountType: "entity" }, address1: "3150 N. Sheridan Rd.", city: "Chicago", countyId: cook,
    townshipId: lakeView, assetType: "residential", pin: "14-28-118-030-0000", firstAppeal: { assessmentYear: 2024, level: "ptab" },
  } })).json();
  const detail = await (await page.request.get(`/api/firm/properties/${prop.id}`)).json();
  const ptabId = detail.appeals[0].id;
  await page.request.patch(`/api/firm/appeals/${ptabId}`, { data: { original: { total: "90000" }, status: "waiting_decision" } });
  await page.request.post(`/api/firm/properties/${prop.id}/appeals`, { data: { assessmentYear: 2026, level: "bor" } });

  // While the PTAB is pending, the property page and the grid both say so.
  await page.goto(`/properties/${prop.id}`);
  await expect(page.locator(".ptab-flag")).toContainText("Pending PTAB");
  await expect(page.locator(".ptab-flag")).toContainText("2024");
  await page.goto("/properties");
  await page.getByRole("button", { name: /with a pending PTAB/ }).click();
  await expect(page.getByRole("link", { name: /3150 N\. Sheridan Rd\./ })).toBeVisible();
  await expect(page.locator("tbody tr", { hasText: "3150 N. Sheridan Rd." })).toContainText("PTAB pending");
  await expect(page.locator("tbody tr", { hasText: "1700 Busse Rd." })).toBeVisible();
  await expect(page.locator("tbody tr", { hasText: "1044 Tower Road" })).toHaveCount(0);

  // The PTAB is decided at 81,000. The 2026 BOR, in the same 2024 to 2026 cycle, takes it as the target.
  await page.request.patch(`/api/firm/appeals/${ptabId}`, { data: { resolved: { total: "81000" }, status: "reduced" } });
  await page.goto(`/properties/${prop.id}`);
  await expect(page.locator(".ptab-flag")).toHaveCount(0);
  await page.getByRole("tab", { name: "Values" }).click();
  await page.getByLabel("Choose an appeal").selectOption({ label: "2026 Board of Review · Open" });
  const target = page.locator(".vtile", { hasText: "Target AV" });
  await expect(target).toContainText("81,000");
  await expect(target.locator(".pill", { hasText: "Rollover" })).toBeVisible();
  await expect(target).toContainText("From the 2024 PTAB decision, same cycle");
  await page.screenshot({ path: "test-results/pins-rollover.png", fullPage: true });
});
