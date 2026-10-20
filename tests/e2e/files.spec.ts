import { expect, test, type Page } from "@playwright/test";

// These tests run against the fake Dropbox server started by playwright.config.ts on port 3199.
const PW = "sample-pass-1";
const FAKE = "http://127.0.0.1:3199";

async function signIn(page: Page, email = "dillon@nicholslaw.example", password = PW) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}

const fileName = (page: Page, name: string) => page.locator(".ftable .fname", { hasText: name });
const fileRow = (page: Page, name: string) => page.locator(".ftable tbody tr", { has: page.locator(".fname", { hasText: name }) });

async function openTower(page: Page) {
  await page.goto("/properties");
  await page.getByRole("link", { name: /1044 Tower Road, Winnetka/ }).click();
  await expect(page.getByRole("heading", { name: "1044 Tower Road, Winnetka (New Trier)" })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => { throw err; });
});

test("firm admins and the Operations role: toggles, role change, and the permissions grid", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings");
  await expect(page.locator("th", { hasText: "Firm admin" })).toBeVisible();
  await expect(page.getByLabel("Firm admin: Dillon Nichols")).toHaveAttribute("aria-pressed", "true");

  const julie = page.getByLabel("Firm admin: Julie Ramos");
  await expect(julie).toHaveAttribute("aria-pressed", "false");
  await julie.click();
  await expect(julie).toHaveAttribute("aria-pressed", "true");

  await page.getByLabel("Role for Sana Khan").selectOption("operations");
  await expect(page.getByLabel("Role for Sana Khan")).toHaveValue("operations");

  await page.getByRole("tab", { name: "Roles & permissions" }).click();
  await expect(page.getByLabel("Void invoices for operations")).toBeVisible();
  await page.screenshot({ path: "test-results/permissions-operations.png", fullPage: true });

  // Julie, an analyst who is now a firm admin, can manage users.
  await page.getByRole("button", { name: /^Account menu for/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await signIn(page, "julie@nicholslaw.example");
  await page.goto("/settings");
  await expect(page.getByLabel("Role for Sana Khan")).toBeVisible();

  // Put everything back, and the last-admin guard holds for Dillon once Julie is no longer one.
  await page.getByLabel("Role for Sana Khan").selectOption("analyst");
  await page.getByLabel("Firm admin: Julie Ramos").click();
  await expect(page.getByText("Only a firm admin can do that.").or(page.getByLabel("Role for Sana Khan"))).toBeVisible();
  await page.goto("/settings");
  await expect(page.getByLabel("Role for Sana Khan")).toHaveCount(0);
  await expect(page.getByRole("row", { name: /Julie Ramos/ })).not.toContainText("Firm admin");
});

test("a firm admin connects Dropbox, creates a property folder, uploads and opens files", async ({ page, request }) => {
  await signIn(page);
  await openTower(page);
  await page.getByRole("tab", { name: "Files" }).click();
  await expect(page.getByRole("heading", { name: "Dropbox isn't connected" })).toBeVisible();
  await page.getByRole("link", { name: "Settings, Integrations" }).click();

  await expect(page.getByRole("heading", { name: "Dropbox" })).toBeVisible();
  await expect(page.getByText("Not connected")).toBeVisible();
  await expect(page.getByText("This is a sample firm, so a personal Dropbox account is accepted for testing.")).toBeVisible();
  await page.getByRole("button", { name: "Connect Dropbox" }).click();

  // The fake Dropbox approves straight away and sends the browser back to the app.
  await expect(page.getByText("Dropbox is connected.")).toBeVisible();
  await expect(page).toHaveURL(/\/settings\?tab=integrations&dropbox=connected/);
  await expect(page.getByText("Dropbox team plan · Test Firm Team")).toBeVisible();
  await expect(page.getByText("/Appeal EyeQ in the team space")).toBeVisible();
  await page.screenshot({ path: "test-results/integrations-connected.png", fullPage: true });

  await openTower(page);
  await page.getByRole("tab", { name: "Files" }).click();
  await expect(page.getByRole("heading", { name: "No folder yet" })).toBeVisible();
  await expect(page.getByText("/Appeal EyeQ/Nichols, Dillon/05-17-302-010 – 1044 Tower Road, Winnetka (New Trier)")).toBeVisible();
  await page.getByRole("button", { name: "Create the folder" }).click();
  await expect(page.getByText("Folder ready.")).toBeVisible();

  const files = page.locator(".files");
  await files.getByRole("button", { name: "Appeals", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Folder" })).toContainText("Appeals");
  for (const y of ["2024", "2025", "2026"]) await expect(files.getByRole("button", { name: y, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Property folder" }).click();

  // Upload with the button.
  await page.getByLabel("Choose files to upload").setInputFiles([
    { name: "Engagement letter.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 engagement") },
    { name: "Comps – 2026.xlsx", mimeType: "application/octet-stream", buffer: Buffer.from("comps sheet") },
  ]);
  await expect(page.getByText("Uploaded 2 files.")).toBeVisible();
  await expect(fileName(page, "Engagement letter.pdf")).toBeVisible();
  await expect(fileName(page, "Comps – 2026.xlsx")).toBeVisible();

  // Upload by dragging a file onto the list.
  await page.locator(".files").evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["dropped notes"], "Hearing notes.docx"));
    el.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByText("Uploaded 1 file.")).toBeVisible();
  await expect(fileName(page, "Hearing notes.docx")).toBeVisible();
  await page.screenshot({ path: "test-results/files-tab.png", fullPage: true });

  // Download follows a short-lived Dropbox link to the real bytes.
  await fileRow(page, "Engagement letter.pdf").getByRole("button", { name: "Actions for Engagement letter.pdf" }).click();
  const href = await page.getByRole("menuitem", { name: "Download" }).getAttribute("href");
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(await res.text()).toBe("%PDF-1.4 engagement");

  // Open goes to the file's page on Dropbox, where Open, then the app, starts the desktop app.
  await expect(page.getByRole("menuitem", { name: /^Open in your PDF app/ })).toHaveAttribute("href", /dropbox\.test\/.*Engagement%20letter\.pdf/);
  await page.keyboard.press("Escape");

  // The files are really in the team space, at the expected path.
  const tree = await (await request.get(`${FAKE}/__test/tree`)).json();
  const paths: string[] = JSON.stringify(tree).match(/\/appeal eyeq\/[^"]+/gi) ?? [];
  expect(paths.some((p) => /hearing notes\.docx$/i.test(p))).toBe(true);
});

test("renaming a client flags the folder, and Rename the folder moves it with its files", async ({ page }) => {
  await signIn(page);
  await page.goto("/accounts");
  await page.getByRole("link", { name: "Nichols, Dillon" }).first().click();
  await page.getByRole("button", { name: "Edit" }).first().click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("Name", { exact: true }).fill("Nichols, Dillon S.");
  await sheet.getByRole("button", { name: /^Save/ }).click();
  await expect(page.getByRole("heading", { name: "Nichols, Dillon S." })).toBeVisible();

  await openTower(page);
  await page.getByRole("tab", { name: "Files" }).click();
  await expect(page.getByText("This folder's name no longer matches the client or address.")).toBeVisible();
  await page.getByRole("button", { name: "Rename the folder" }).click();
  await expect(page.getByText("Folder moved. Its files came with it.")).toBeVisible();
  await expect(fileName(page, "Engagement letter.pdf")).toBeVisible();
  await expect(page.getByText("This folder's name no longer matches")).toHaveCount(0);

  // Put the name back for later tests (the folder then shows as out of date again, which is fine).
  await page.goto("/accounts");
  await page.getByRole("link", { name: "Nichols, Dillon S." }).first().click();
  await page.getByRole("button", { name: "Edit" }).first().click();
  await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill("Nichols, Dillon");
  await page.getByRole("dialog").getByRole("button", { name: /^Save/ }).click();
  await expect(page.locator("h1")).toHaveText("Nichols, Dillon");
});

test("a non-admin sees the connection but can't change it, and an analyst can still browse files", async ({ page }) => {
  await signIn(page, "julie@nicholslaw.example");
  await page.goto("/settings?tab=integrations");
  await expect(page.locator(".pill.ok", { hasText: "Connected" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect Dropbox" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Change" })).toHaveCount(0);

  await openTower(page);
  await page.getByRole("tab", { name: "Files" }).click();
  await expect(fileName(page, "Engagement letter.pdf")).toBeVisible();
});

test("adding a PIN that's already a property points to the existing one", async ({ page }) => {
  await signIn(page);
  await page.goto("/properties");
  await page.getByRole("button", { name: "+ New property" }).click();
  const sheet = page.getByRole("dialog", { name: "New property" });
  await sheet.getByLabel("Client").selectOption("new");
  await sheet.getByLabel("New client name").fill("Duplicate Test LLC");
  await sheet.getByLabel("Type", { exact: true }).selectOption("entity");
  await sheet.getByLabel("Address").fill("1044 Tower Rd.");
  await sheet.getByLabel("City").fill("Winnetka");
  await sheet.getByLabel("County").selectOption({ label: "Cook" });
  await sheet.getByLabel("Township").selectOption({ label: "New Trier" });
  await sheet.getByLabel("PIN").fill("05-17-302-010"); // same parcel, written without the trailing 0000
  await sheet.getByLabel("Asset type").selectOption("residential");
  await sheet.getByLabel("Attorney").selectOption({ label: "Dillon Nichols" });
  await sheet.getByRole("button", { name: "Create property" }).click();

  await expect(sheet.getByRole("alert")).toContainText("is already the matter");
  await sheet.getByRole("link", { name: "Open that property" }).click();
  await expect(page.getByRole("heading", { name: "1044 Tower Road, Winnetka (New Trier)" })).toBeVisible();

  // The new client was rolled back with the property.
  await page.goto("/accounts");
  await expect(page.getByRole("link", { name: "Duplicate Test LLC" })).toHaveCount(0);
});

test("disconnecting Dropbox leaves the files in place and the tab asks to reconnect", async ({ page, request }) => {
  await signIn(page);
  await page.goto("/settings?tab=integrations");
  await page.getByRole("button", { name: "Disconnect Dropbox" }).click();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByText("Not connected")).toBeVisible();

  await openTower(page);
  await page.getByRole("tab", { name: "Files" }).click();
  await expect(page.getByRole("heading", { name: "Dropbox isn't connected" })).toBeVisible();
  const tree = JSON.stringify(await (await request.get(`${FAKE}/__test/tree`)).json());
  expect(tree).toMatch(/Engagement letter\.pdf/);
});
