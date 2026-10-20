import { expect, test, type Page } from "@playwright/test";

// Delivery 6, in the browser, against the stand-in Dropbox (port 3199). Runs after files.spec.ts,
// which ends by disconnecting Dropbox, so the first test connects again.
const PW = "sample-pass-1";
const FAKE = "http://127.0.0.1:3199";
const TOWER = "/Appeal EyeQ/Nichols, Dillon/05-17-302-010 – 1044 Tower Road, Winnetka (New Trier)";
const BRIEF = "05-17-302-010 – CCAO Brief (2026).docx";

async function signIn(page: Page, email = "dillon@nicholslaw.example") {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PW);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}

async function towerFiles(page: Page) {
  await page.goto("/properties");
  await page.getByRole("link", { name: /1044 Tower Road, Winnetka/ }).click();
  await page.getByRole("tab", { name: "Files" }).click();
  await expect(page.getByRole("navigation", { name: "Folder" })).toBeVisible();
}

const files = (page: Page) => page.locator(".files");
const row = (page: Page, name: string) => page.locator(".ftable tbody tr", { has: page.locator(".fname", { hasText: name }) });
const openFolder = (page: Page, name: string) => files(page).locator(".ftable").getByRole("button", { name, exact: true }).click();
async function rowAction(page: Page, name: string, action: string | RegExp) {
  await row(page, name).getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: action }).click();
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => { throw err; });
});

test("the folder template, folder guidance, profiles, firm naming and the in-app preview", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings?tab=integrations");
  await page.getByRole("button", { name: "Connect Dropbox" }).click();
  await expect(page.getByText("Dropbox is connected.")).toBeVisible();

  await towerFiles(page);
  if (await page.getByRole("button", { name: "Rename the folder" }).count()) {
    await page.getByRole("button", { name: "Rename the folder" }).click();
    await expect(page.getByText("Folder moved.")).toBeVisible();
  }
  await page.getByRole("button", { name: "More folder actions" }).click();
  await page.getByRole("menuitem", { name: "Apply the folder template" }).click();
  await expect(page.getByText("Template applied.")).toBeVisible();
  const folders = files(page).locator(".ftable tbody tr .fname");
  await expect(folders.first()).toHaveText("Engagement Agreements");
  for (const f of ["Property Documents", "Correspondence", "Evaluation Worksheets", "Appeals", "Billing", "Misc"]) await expect(files(page).locator(".fname", { hasText: f }).first()).toBeVisible();

  await openFolder(page, "Appeals");
  await openFolder(page, "2026");
  await expect(files(page).locator(".ftable .fname").first()).toHaveText("Assessor");
  await openFolder(page, "Assessor");
  await expect(page.getByLabel("What belongs in this folder")).toContainText("CCAO Brief");
  await expect(page.getByLabel("What belongs in this folder")).toContainText("Decision Letter");

  await page.getByLabel("Choose files to upload").setInputFiles([{ name: "brief draft.docx", mimeType: "application/octet-stream", buffer: Buffer.from("brief v1") }]);
  await expect(page.getByText("Uploaded 1 file.")).toBeVisible();
  await expect(row(page, "brief draft.docx")).toContainText("Not profiled");

  // Click: the panel opens on the preview (Dropbox renders Word as PDF, shown here).
  await row(page, "brief draft.docx").click();
  const panel = page.getByRole("complementary", { name: "File: brief draft.docx" });
  await expect(panel.locator("iframe[title='Preview of brief draft.docx']")).toBeVisible();
  await expect(panel.getByRole("link", { name: "Open in Word" })).toHaveAttribute("href", /dropbox\.test/);

  // Space hides and shows it, like Quick Look.
  await row(page, "brief draft.docx").focus();
  await page.keyboard.press("Space");
  await expect(panel).toHaveCount(0);
  await page.keyboard.press("Space");
  await expect(page.getByRole("complementary", { name: "File: brief draft.docx" })).toBeVisible();

  await panel.getByRole("tab", { name: "Profile" }).click();
  await panel.getByLabel("Document type").selectOption({ label: "CCAO Brief (protected)" });
  await panel.getByLabel("Status").selectOption("draft");
  await panel.getByLabel("Tags").fill("comps, uniformity");
  await panel.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile saved.")).toBeVisible();
  await expect(row(page, "brief draft.docx")).toContainText("CCAO Brief");
  await expect(row(page, "brief draft.docx")).toContainText("Draft");

  const p2 = page.getByRole("complementary", { name: "File: brief draft.docx" });
  await p2.getByRole("tab", { name: "Profile" }).click();
  await expect(p2.locator(".suggest")).toContainText(BRIEF);
  await page.screenshot({ path: "test-results/documents-profile.png", fullPage: true });
  await p2.getByRole("button", { name: "Rename to this" }).click();
  await expect(page.getByText(`Renamed to ${BRIEF}.`)).toBeVisible();
  await expect(row(page, BRIEF)).toBeVisible();
  await expect(row(page, BRIEF).locator(".lock")).toBeVisible();
});

test("version history: a save in Word shows up, and an older version can be made current", async ({ page, request }) => {
  await request.post(`${FAKE}/__test/edit`, { data: { path: `${TOWER}/Appeals/2026/Assessor/${BRIEF}`.toLowerCase(), content: "brief v2 from Word" } });
  await signIn(page);
  await towerFiles(page);
  await openFolder(page, "Appeals");
  await openFolder(page, "2026");
  await openFolder(page, "Assessor");
  await rowAction(page, BRIEF, "Version history");
  const panel = page.getByRole("complementary", { name: `File: ${BRIEF}` });
  await expect(panel.locator(".versions li")).toHaveCount(2);
  await expect(panel.locator(".versions li").first()).toContainText("Current");
  await panel.getByRole("button", { name: "Make current" }).click();
  await panel.getByRole("button", { name: "Yes" }).click();
  await expect(page.getByText("That version is current again.")).toBeVisible();
  await expect(page.getByRole("complementary", { name: `File: ${BRIEF}` }).locator(".versions li")).toHaveCount(3);
});

test("an analyst can't delete a protected brief; deleted files go to Recently deleted and come back", async ({ page }) => {
  await signIn(page, "julie@nicholslaw.example");
  await towerFiles(page);
  await openFolder(page, "Appeals");
  await openFolder(page, "2026");
  await openFolder(page, "Assessor");
  await row(page, BRIEF).getByRole("button", { name: `Actions for ${BRIEF}` }).click();
  await expect(page.getByRole("menuitem", { name: /^Delete/ })).toBeDisabled();
  await page.keyboard.press("Escape");

  await page.getByLabel("Choose files to upload").setInputFiles([{ name: "scratch notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") }]);
  await expect(row(page, "scratch notes.txt")).toBeVisible();
  await rowAction(page, "scratch notes.txt", "Delete");
  await row(page, "scratch notes.txt").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("scratch notes.txt deleted.")).toBeVisible();
  await expect(row(page, "scratch notes.txt")).toHaveCount(0);

  await page.getByRole("button", { name: "More folder actions" }).click();
  await page.getByRole("menuitem", { name: "Recently deleted" }).click();
  const deletedRow = page.getByRole("row", { name: /scratch notes\.txt/ });
  await expect(deletedRow).toContainText("by Julie Ramos");
  await page.screenshot({ path: "test-results/documents-recently-deleted.png", fullPage: true });
  await deletedRow.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("scratch notes.txt is back where it was.")).toBeVisible();
  await page.getByRole("button", { name: "Back to files" }).click();
  await expect(row(page, "scratch notes.txt")).toBeVisible();
});

test("new folders, renaming, and template folders keeping their names", async ({ page }) => {
  await signIn(page);
  await towerFiles(page);
  await openFolder(page, "Evaluation Worksheets");
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("New folder name").fill("Comps 2026");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText("Folder Comps 2026 created.")).toBeVisible();
  await rowAction(page, "Comps 2026", "Rename");
  await page.getByLabel("New name for Comps 2026").fill("Sales comps 2026");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row(page, "Sales comps 2026")).toBeVisible();

  await page.getByRole("button", { name: "Property folder" }).click();
  await row(page, "Billing").getByRole("button", { name: "Actions for Billing" }).click();
  await expect(page.getByRole("menuitem", { name: "Rename" })).toHaveCount(0); // template folders keep their names
});

test("an .eml email reads in the panel", async ({ page }) => {
  await signIn(page);
  await towerFiles(page);
  await openFolder(page, "Correspondence");
  const eml = [
    "From: Board of Review <notices@cookcountyboardofreview.example>", "To: dillon@nicholslaw.example", "Subject: Hearing notice, 05-17-302-010",
    "Date: Wed, 14 Oct 2026 09:00:00 -0500", "Content-Type: text/plain; charset=utf-8", "", "Your hearing is set for November 3.",
  ].join("\r\n");
  await page.getByLabel("Choose files to upload").setInputFiles([{ name: "hearing notice.eml", mimeType: "message/rfc822", buffer: Buffer.from(eml) }]);
  await row(page, "hearing notice.eml").click();
  const panel = page.getByRole("complementary", { name: "File: hearing notice.eml" });
  await expect(panel.getByRole("heading", { name: "Hearing notice, 05-17-302-010" })).toBeVisible();
  await expect(panel).toContainText("Board of Review <notices@cookcountyboardofreview.example>");
  await expect(panel).toContainText("Your hearing is set for November 3.");
  await expect(panel.getByRole("link", { name: "Open in Outlook" })).toBeVisible();
});

test("search finds a document and opens it on the Files tab", async ({ page }) => {
  await signIn(page);
  const search = page.getByLabel("Search properties, clients, appeals and documents");
  await search.fill("2026 assessor brief");
  await expect(page.getByRole("option", { name: new RegExp(BRIEF.replace(/[()]/g, "\\$&")) })).toBeVisible();
  await page.getByRole("option", { name: new RegExp(BRIEF.replace(/[()]/g, "\\$&")) }).click();
  await expect(page.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("complementary", { name: `File: ${BRIEF}` })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Folder" })).toContainText("Assessor");
});

test("a closed matter's folder moves to Deadzone and back", async ({ page }) => {
  await signIn(page);
  await towerFiles(page);
  const id = page.url().match(/properties\/(\d+)/)![1];
  expect((await page.request.patch(`/api/firm/properties/${id}`, { data: { status: "closed" } })).status()).toBe(200);
  await page.reload();
  await page.getByRole("tab", { name: "Files" }).click();
  await page.getByRole("button", { name: "Move to Deadzone" }).click();
  await expect(page.getByText("Moved to Deadzone with every file and profile.")).toBeVisible();
  await expect(page.getByText("This matter's folder is in Deadzone")).toBeVisible();
  await page.getByRole("button", { name: "Move back" }).click();
  await expect(page.getByText("Moved back to the active client folders.")).toBeVisible();
  expect((await page.request.patch(`/api/firm/properties/${id}`, { data: { status: "active" } })).status()).toBe(200);
});

test("Settings, Documents: firm admins edit the template and types, others read them", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings?tab=documents");
  await expect(page.getByRole("heading", { name: "Property folder template" })).toBeVisible();
  await expect(page.locator(".tpl-list").first()).toContainText("Engagement Agreements");
  await page.getByLabel("New document type name").fill("Conflict Check");
  await page.getByLabel("Where the new type is saved").selectOption({ label: "Misc" });
  await page.getByRole("button", { name: "Add type" }).click();
  await expect(page.getByText("Conflict Check added.")).toBeVisible();
  await expect(page.getByLabel("Where Conflict Check is saved")).toHaveValue(/\d+/);
  await page.getByLabel("Protected: Conflict Check").click();
  await expect(page.getByLabel("Protected: Conflict Check")).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: "test-results/settings-documents.png", fullPage: true });

  await page.getByRole("button", { name: /^Account menu for/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await signIn(page, "julie@nicholslaw.example");
  await page.goto("/settings?tab=documents");
  await expect(page.getByText("A firm admin can change the template and the document types.")).toBeVisible();
  await expect(page.getByLabel("Protected: Conflict Check")).toBeDisabled();
});

test("phone width: the Files tab and its panel don't scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await signIn(page);
  await towerFiles(page);
  await openFolder(page, "Correspondence");
  await row(page, "hearing notice.eml").click();
  await expect(page.getByRole("complementary", { name: "File: hearing notice.eml" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.screenshot({ path: "test-results/documents-phone.png", fullPage: true });
});
