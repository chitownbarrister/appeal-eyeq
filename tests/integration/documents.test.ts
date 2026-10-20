// Delivery 6: Appeal EyeQ as the document system, Dropbox as storage. The firm's
// folder template and document types, the old short level names renamed in place,
// profiles that follow a file through renames and moves, new folders, rename,
// delete with protected files, Recently deleted and restore (including files
// deleted outside the app), version history, previews, .eml reading, Deadzone,
// and cross-firm and support-access lockouts. Real server and Postgres, stand-in Dropbox.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, call, login, startTestEnv, stopTestEnv, type TestEnv } from "./helpers";
import { startFakeDropbox, FAKE_APP_KEY, FAKE_APP_SECRET, type FakeDropbox } from "../fake-dropbox/server";

let env: TestEnv;
let fake: FakeDropbox;
let dillon = "";
let julie = "";
let sana = "";
let olivia = "";
let towerId = 0;
const TOWER = "/Appeal EyeQ/Nichols, Dillon/05-17-302-010 – 1044 Tower Road, Winnetka (New Trier)";
const ASSESSOR_2026 = "Appeals/2026/Assessor";

async function connect(cookie: string): Promise<void> {
  const start = await fetch(`${env.base}/api/firm/integrations/dropbox/connect`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
  const stateCookie = (start.headers.get("set-cookie") || "").split(";")[0];
  const { url } = (await start.json()) as { url: string };
  const approve = await fetch(url, { redirect: "manual" });
  const done = await fetch(approve.headers.get("location")!, { redirect: "manual", headers: { Cookie: `${cookie}; ${stateCookie}` } });
  if (!String(done.headers.get("location")).includes("dropbox=connected")) throw new Error(`connect failed: ${done.headers.get("location")}`);
}

async function upload(cookie: string, rel: string, name: string, body: string) {
  const res = await fetch(`${env.base}/api/firm/properties/${towerId}/files/upload?${new URLSearchParams({ path: rel, name })}`, {
    method: "POST", headers: { Cookie: cookie, "Content-Type": "application/octet-stream" }, body,
  });
  return { status: res.status, body: await res.json() };
}

const files = (cookie: string, rel = "") => call(env.base, cookie, "GET", `/api/firm/properties/${towerId}/files?${new URLSearchParams({ path: rel })}`);
const details = (cookie: string, rel: string) => call(env.base, cookie, "GET", `/api/firm/properties/${towerId}/files/details?${new URLSearchParams({ path: rel })}`);
const post = (cookie: string, what: string, body: unknown) => call(env.base, cookie, "POST", `/api/firm/properties/${towerId}/files/${what}`, body);
const tree = async () => (await (await fetch(`${fake.url}/__test/tree`)).json())["ns-team-1"] as string[];
const typeId = async (name: string) => ((await call(env.base, dillon, "GET", "/api/firm/documents/template")).body.types as { id: number; name: string }[]).find((t) => t.name === name)!.id;

async function sys<T>(fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const { withContext } = await import("../../server/db");
  return withContext({ actorKind: "system", userId: null, firmId: env.nicholsId }, fn);
}
/** The index re-reads a folder at most every two minutes; tests make it read now. */
const forceIndex = () => sys((c) => c.query(`UPDATE property_folders SET indexed_at = NULL WHERE firm_id = $1`, [env.nicholsId]));

beforeAll(async () => {
  env = await startTestEnv();
  fake = await startFakeDropbox();
  Object.assign(process.env, {
    DROPBOX_APP_KEY: FAKE_APP_KEY, DROPBOX_APP_SECRET: FAKE_APP_SECRET, TOKEN_ENCRYPTION_KEY: "test-encryption-key-that-is-long-enough-123",
    DROPBOX_API_URL: fake.url, DROPBOX_CONTENT_URL: fake.url, DROPBOX_AUTHORIZE_URL: `${fake.url}/oauth2/authorize`, DROPBOX_WEB_URL: "https://www.dropbox.test",
  });
  dillon = await login(env.base, "dillon@nicholslaw.example");
  julie = await login(env.base, "julie@nicholslaw.example");
  sana = await login(env.base, "sana@nicholslaw.example");
  olivia = await login(env.base, "olivia@otherfirm.example");
  towerId = (await call(env.base, dillon, "GET", "/api/firm/properties")).body.properties.find((p: { address1: string }) => p.address1 === "1044 Tower Road").id;
  await connect(dillon);
});

afterAll(async () => {
  for (const k of ["DROPBOX_APP_KEY", "DROPBOX_APP_SECRET", "TOKEN_ENCRYPTION_KEY", "DROPBOX_API_URL", "DROPBOX_CONTENT_URL", "DROPBOX_AUTHORIZE_URL", "DROPBOX_WEB_URL"]) delete process.env[k];
  await fake.close();
  await stopTestEnv(env);
});

describe("the firm's folder template and document types", () => {
  it("starts every firm, new or existing, with the default template", async () => {
    const t = (await call(env.base, julie, "GET", "/api/firm/documents/template")).body;
    expect(t.folders.map((f: { name: string }) => f.name)).toEqual(["Engagement Agreements", "Property Documents", "Correspondence", "Evaluation Worksheets", "Appeals", "Billing", "Misc"]);
    expect(t.levels.map((l: { name: string }) => l.name)).toEqual(["Assessor", "Board of Review", "Property Tax Appeal Board", "Circuit Court"]);
    expect(t.types).toHaveLength(24);
    expect(t.types.filter((x: { protected: boolean }) => x.protected).map((x: { name: string }) => x.name).sort()).toEqual(["CCAO Brief", "CCBOR Brief", "CFA", "Decision Letter", "Invoice", "Refund"]);
    const other = (await call(env.base, olivia, "GET", "/api/firm/documents/template")).body;
    expect(other.types).toHaveLength(24);
    expect(other.types[0].id).not.toBe(t.types[0].id);
  });

  it("lets only firm admins change it, and keeps Appeals and the level folders in place", async () => {
    expect((await call(env.base, julie, "POST", "/api/firm/documents/template/folders", { name: "Litigation" })).status).toBe(403);
    const add = await call(env.base, dillon, "POST", "/api/firm/documents/template/folders", { name: "Litigation" });
    expect(add.status).toBe(201);
    expect((await call(env.base, dillon, "PATCH", `/api/firm/documents/template/folders/${add.body.id}`, { name: "Litigation Hold" })).body.name).toBe("Litigation Hold");
    const t = (await call(env.base, dillon, "GET", "/api/firm/documents/template")).body;
    const appeals = t.folders.find((f: { kind: string }) => f.kind === "appeals");
    expect((await call(env.base, dillon, "PATCH", `/api/firm/documents/template/folders/${appeals.id}`, { name: "Cases" })).status).toBe(409);
    expect((await call(env.base, dillon, "DELETE", `/api/firm/documents/template/folders/${appeals.id}`)).status).toBe(409);
    const ids = t.folders.map((f: { id: number }) => f.id).reverse();
    expect((await call(env.base, dillon, "PUT", "/api/firm/documents/template/order", { ids })).status).toBe(200);
    expect((await call(env.base, dillon, "PUT", "/api/firm/documents/template/order", { ids: ids.slice(1) })).status).toBe(400);
    expect((await call(env.base, dillon, "PUT", "/api/firm/documents/template/order", { ids: ids.reverse() })).status).toBe(200);
    expect((await call(env.base, dillon, "DELETE", `/api/firm/documents/template/folders/${add.body.id}`)).status).toBe(200);
  });

  it("adds and edits document types, refusing duplicates and other firms' folders", async () => {
    const t = (await call(env.base, dillon, "GET", "/api/firm/documents/template")).body;
    const misc = t.folders.find((f: { name: string }) => f.name === "Misc").id;
    const made = await call(env.base, dillon, "POST", "/api/firm/documents/types", { name: "Conflict Check", templateId: misc });
    expect(made.status).toBe(201);
    expect((await call(env.base, dillon, "POST", "/api/firm/documents/types", { name: "conflict check", templateId: misc })).status).toBe(409);
    const otherMisc = (await call(env.base, olivia, "GET", "/api/firm/documents/template")).body.folders.find((f: { name: string }) => f.name === "Misc").id;
    expect((await call(env.base, dillon, "POST", "/api/firm/documents/types", { name: "Sneaky", templateId: otherMisc })).status).toBe(400);
    expect((await call(env.base, dillon, "PATCH", `/api/firm/documents/types/${made.body.id}`, { protected: true, active: false })).status).toBe(200);
    expect((await call(env.base, olivia, "PATCH", `/api/firm/documents/types/${made.body.id}`, { name: "Mine now" })).status).toBe(404);
    expect((await call(env.base, julie, "PATCH", `/api/firm/documents/types/${made.body.id}`, { active: true })).status).toBe(403);
  });
});

describe("a property's folder from the template", () => {
  it("renames the old short level folders in place instead of duplicating them", async () => {
    // A folder made before Delivery 6 (or moved in by a firm), with short level names and a file inside.
    await post(dillon, "ensure", {});
    const t = await tree();
    expect(t).toContain(`D ${TOWER}/Appeals/2026/Assessor`);
    // Rebuild the 2024 BOR folder under its old name with a file in it.
    expect((await post(dillon, "rename", { path: "Appeals/2024/Board of Review", name: "x" })).status).toBe(409); // template folders keep their names
    await sys(async () => undefined);
    await fetch(`${fake.url}/__test/delete-outside`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: `${TOWER}/Appeals/2024/Board of Review`.toLowerCase() }) });
    expect((await post(dillon, "folder", { path: "Appeals/2024", name: "BOR" })).status).toBe(201);
    expect((await upload(dillon, "Appeals/2024/BOR", "2024 BOR decision.pdf", "%PDF old")).status).toBe(201);
    const r = await post(dillon, "ensure", {});
    expect(r.body.renamed).toBe(1);
    const after = await tree();
    expect(after).toContain(`D ${TOWER}/Appeals/2024/Board of Review`);
    expect(after).not.toContain(`D ${TOWER}/Appeals/2024/BOR`);
    expect(after.some((x) => x.endsWith("/Appeals/2024/Board of Review/2024 BOR decision.pdf"))).toBe(true);
  });

  it("lists template folders in the template's order, then years newest first and levels in order", async () => {
    await post(dillon, "folder", { path: "", name: "Aardvark notes" });
    const root = (await files(julie)).body;
    expect(root.entries.filter((e: { kind: string }) => e.kind === "folder").map((e: { name: string }) => e.name)).toEqual([
      "Engagement Agreements", "Property Documents", "Correspondence", "Evaluation Worksheets", "Appeals", "Billing", "Misc", "Aardvark notes",
    ]);
    expect(root.entries.find((e: { name: string }) => e.name === "Appeals").templateFolder).toBe(true);
    expect(root.entries.find((e: { name: string }) => e.name === "Aardvark notes").templateFolder).toBe(false);
    expect(root.pin).toBe("05-17-302-010");
    const levels = (await files(julie, "Appeals/2026")).body;
    expect(levels.entries.map((e: { name: string }) => e.name)).toEqual(["Assessor", "Board of Review"]);
  });

  it("tells staff what belongs in each folder", async () => {
    const assr = (await files(julie, ASSESSOR_2026)).body.here;
    expect(assr).toMatchObject({ year: 2026, level: "assessor", templateFolder: true });
    expect(assr.types.map((t: { name: string }) => t.name)).toEqual(["Photograph Affidavit", "CCAO Authorization", "CCAO Brief", "CCAO Photograph", "Supporting Documentation", "Decision Letter"]);
    expect((await files(julie, "Property Documents")).body.here.types.map((t: { name: string }) => t.name)).toEqual(["Appraisal", "Blueprints", "Settlement Statement", "Tax Bill", "Assessor Document", "Photo"]);
    expect((await files(julie, "Aardvark notes")).body.here.types).toEqual([]);
  });
});

describe("a new appeal level", () => {
  it("creates its year and level folder in the property's folder right away", async () => {
    const r = await call(env.base, dillon, "POST", `/api/firm/properties/${towerId}/appeals`, { assessmentYear: 2024, level: "ptab" });
    expect(r.status).toBe(201);
    expect(r.body.folder).toBe(`${TOWER}/Appeals/2024/Property Tax Appeal Board`);
    expect(await tree()).toContain(`D ${TOWER}/Appeals/2024/Property Tax Appeal Board`);
    await call(env.base, dillon, "DELETE", `/api/firm/appeals/${r.body.id}`);
  });
});

describe("profiles", () => {
  it("records who uploaded a file, and its year and level from the folder", async () => {
    expect((await upload(julie, ASSESSOR_2026, "brief draft.docx", "brief v1")).status).toBe(201);
    const d = (await details(julie, `${ASSESSOR_2026}/brief draft.docx`)).body;
    expect(d.profile).toMatchObject({ uploadedBy: "Julie Ramos", year: 2026, level: "assessor", docType: null, status: null, protected: false });
    expect(d.format).toBe("DOCX");
    expect(d.preview).toBe("office");
    expect(d.suggestedTypes).toContain(await typeId("CCAO Brief"));
  });

  it("saves a profile, suggests the naming convention, and shows it in the folder list", async () => {
    const r = await call(env.base, julie, "PUT", `/api/firm/properties/${towerId}/files/profile`, {
      path: `${ASSESSOR_2026}/brief draft.docx`, docTypeId: await typeId("CCAO Brief"), status: "draft", docDate: "2026-10-01",
      author: "Julie Ramos", tags: ["comps", "comps", "uniformity"], notes: "First pass", year: 2026, level: "assessor",
    });
    expect(r.status).toBe(200);
    const d = (await details(julie, `${ASSESSOR_2026}/brief draft.docx`)).body;
    expect(d.profile).toMatchObject({ docType: "CCAO Brief", status: "draft", docDate: "2026-10-01", author: "Julie Ramos", tags: ["comps", "uniformity"], notes: "First pass", profiledBy: "Julie Ramos", protected: true });
    expect(d.suggestedName).toBe("05-17-302-010 – CCAO Brief (2026).docx");
    const entry = (await files(julie, ASSESSOR_2026)).body.entries.find((e: { name: string }) => e.name === "brief draft.docx");
    expect(entry).toMatchObject({ protected: true, profile: { docType: "CCAO Brief", status: "draft", profiled: true } });
  });

  it("rejects a bad profile and another firm's document type", async () => {
    const otherType = (await call(env.base, olivia, "GET", "/api/firm/documents/template")).body.types[0].id;
    expect((await call(env.base, julie, "PUT", `/api/firm/properties/${towerId}/files/profile`, { path: `${ASSESSOR_2026}/brief draft.docx`, docTypeId: otherType })).status).toBe(400);
    expect((await call(env.base, julie, "PUT", `/api/firm/properties/${towerId}/files/profile`, { path: `${ASSESSOR_2026}/brief draft.docx`, status: "lost" })).status).toBe(400);
    expect((await call(env.base, julie, "PUT", `/api/firm/properties/${towerId}/files/profile`, { path: `${ASSESSOR_2026}/brief draft.docx`, docDate: "10/01/2026" })).status).toBe(400);
  });

  it("follows the file through a rename, keeping its extension", async () => {
    const r = await post(julie, "rename", { path: `${ASSESSOR_2026}/brief draft.docx`, name: "05-17-302-010 – CCAO Brief (2026)" });
    expect(r.body).toMatchObject({ name: "05-17-302-010 – CCAO Brief (2026).docx", tooLongForWindows: false });
    const d = (await details(julie, `${ASSESSOR_2026}/05-17-302-010 – CCAO Brief (2026).docx`)).body;
    expect(d.profile).toMatchObject({ docType: "CCAO Brief", notes: "First pass" });
    expect((await upload(julie, ASSESSOR_2026, "other.docx", "x")).status).toBe(201);
    expect((await post(julie, "rename", { path: `${ASSESSOR_2026}/other.docx`, name: "05-17-302-010 – CCAO Brief (2026).docx" })).status).toBe(409);
  });

  it("follows a file renamed or moved outside Appeal EyeQ, by its Dropbox id", async () => {
    const before = (await files(julie, ASSESSOR_2026)).body.entries.find((e: { name: string }) => e.name.startsWith("05-17-302-010 – CCAO Brief"));
    const { FirmDropbox } = await import("../../server/dropbox/client");
    const dbx = (await FirmDropbox.open({ actorKind: "system", userId: null, firmId: env.nicholsId }))!;
    await dbx.rpc("files/move_v2", { from_path: before.id, to_path: `${TOWER}/${ASSESSOR_2026}/Brief renamed in Finder.docx` });
    await forceIndex();
    const after = (await files(julie, ASSESSOR_2026)).body.entries.find((e: { name: string }) => e.name === "Brief renamed in Finder.docx");
    expect(after.profile).toMatchObject({ docType: "CCAO Brief" });
    await dbx.rpc("files/move_v2", { from_path: before.id, to_path: `${TOWER}/${ASSESSOR_2026}/05-17-302-010 – CCAO Brief (2026).docx` });
  });

  it("warns when a path would be too long for Windows", async () => {
    const r = await post(julie, "folder", { path: "Correspondence", name: "A very long folder name ".repeat(5).trim() });
    expect(r.status).toBe(201);
    expect(r.body.tooLongForWindows).toBe(true);
    expect((await post(julie, "folder", { path: "Correspondence", name: "A very long folder name ".repeat(5).trim() })).status).toBe(409);
    expect((await post(julie, "folder", { path: "../..", name: "Escape" })).status).toBe(400);
  });
});

describe("deleting and restoring", () => {
  it("lets an analyst delete an ordinary file, then restore it with its profile", async () => {
    await upload(julie, "Property Documents", "photo.jpg", "jpeg bytes");
    await call(env.base, julie, "PUT", `/api/firm/properties/${towerId}/files/profile`, { path: "Property Documents/photo.jpg", docTypeId: await typeId("Photo"), notes: "Front elevation" });
    const del = await post(julie, "delete", { path: "Property Documents/photo.jpg" });
    expect(del.status).toBe(200);
    expect((await files(julie, "Property Documents")).body.entries.some((e: { name: string }) => e.name === "photo.jpg")).toBe(false);
    const list = (await call(env.base, julie, "GET", `/api/firm/properties/${towerId}/files/deleted`)).body.deleted;
    expect(list[0]).toMatchObject({ name: "photo.jpg", kind: "file", deleted_by: "Julie Ramos", outside: false, was_protected: false, relPath: "Property Documents/photo.jpg" });
    const back = await post(julie, "restore", { deletionId: list[0].id });
    expect(back.body).toMatchObject({ restored: 1, failed: [] });
    expect((await details(julie, "Property Documents/photo.jpg")).body.profile).toMatchObject({ docType: "Photo", notes: "Front elevation" });
    expect((await post(julie, "restore", { deletionId: list[0].id })).status).toBe(409);
  });

  it("keeps protected documents and template folders for attorneys and firm admins", async () => {
    const brief = `${ASSESSOR_2026}/05-17-302-010 – CCAO Brief (2026).docx`;
    const r = await post(julie, "delete", { path: brief });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("05-17-302-010 – CCAO Brief (2026).docx is a protected document (CCAO Brief). Your role can't delete protected files; an attorney or a firm admin can.");
    expect((await post(julie, "delete", { path: ASSESSOR_2026 })).body.error).toMatch(/one of the firm's template folders/);
    await post(julie, "folder", { path: "Correspondence", name: "Loose" });
    await upload(julie, "Correspondence/Loose", "letter.pdf", "%PDF letter");
    await call(env.base, julie, "PUT", `/api/firm/properties/${towerId}/files/profile`, { path: "Correspondence/Loose/letter.pdf", docTypeId: await typeId("Letter"), status: "filed" });
    expect((await post(julie, "delete", { path: "Correspondence/Loose" })).body.error).toMatch(/holds protected documents \(letter\.pdf\)/);

    // An analyst who is a firm admin may; so may an attorney.
    const julieId = (await call(env.base, dillon, "GET", "/api/firm/users")).body.users.find((u: { name: string }) => u.name === "Julie Ramos").id;
    await call(env.base, dillon, "PATCH", `/api/firm/users/${julieId}`, { isFirmAdmin: true });
    const folderDel = await post(julie, "delete", { path: "Correspondence/Loose" });
    expect(folderDel.body).toMatchObject({ files: 1 });
    await call(env.base, dillon, "PATCH", `/api/firm/users/${julieId}`, { isFirmAdmin: false });
    const deleted = (await call(env.base, dillon, "GET", `/api/firm/properties/${towerId}/files/deleted`)).body.deleted;
    expect(deleted[0]).toMatchObject({ kind: "folder", name: "Loose", files: 1, was_protected: true });
    expect((await post(dillon, "restore", { deletionId: deleted[0].id })).body.restored).toBe(1);
    expect((await details(julie, "Correspondence/Loose/letter.pdf")).body.profile).toMatchObject({ docType: "Letter", status: "filed" });
  });

  it("follows the permission switches in Roles & permissions", async () => {
    const sanaId = (await call(env.base, dillon, "GET", "/api/firm/users")).body.users.find((u: { name: string }) => u.name === "Sana Khan").id;
    await call(env.base, dillon, "PATCH", `/api/firm/users/${sanaId}`, { role: "operations" });
    await call(env.base, dillon, "PUT", "/api/firm/permissions", { role: "operations", permission: "files.delete", allowed: false });
    await upload(julie, "Misc", "scrap.txt", "scrap");
    const r = await post(sana, "delete", { path: "Misc/scrap.txt" });
    expect(r.status).toBe(403);
    await call(env.base, dillon, "PUT", "/api/firm/permissions", { role: "operations", permission: "files.delete_protected", allowed: true });
    await call(env.base, dillon, "PUT", "/api/firm/permissions", { role: "operations", permission: "files.delete", allowed: true });
    expect((await post(sana, "delete", { path: "Misc/scrap.txt" })).status).toBe(200);
    expect((await files(sana, "Misc")).body.can).toMatchObject({ delete: true, deleteProtected: true });
    await call(env.base, dillon, "PUT", "/api/firm/permissions", { role: "operations", permission: "files.delete_protected", allowed: false });
    await call(env.base, dillon, "PATCH", `/api/firm/users/${sanaId}`, { role: "analyst" });
  });

  it("notices files deleted outside Appeal EyeQ and offers them back", async () => {
    await upload(julie, "Billing", "Invoice 2025.pdf", "%PDF invoice");
    await call(env.base, julie, "PUT", `/api/firm/properties/${towerId}/files/profile`, { path: "Billing/Invoice 2025.pdf", docTypeId: await typeId("Invoice") });
    await fetch(`${fake.url}/__test/delete-outside`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: `${TOWER}/Billing/Invoice 2025.pdf`.toLowerCase() }) });
    await forceIndex();
    await files(julie, "Billing");
    const d = (await call(env.base, julie, "GET", `/api/firm/properties/${towerId}/files/deleted`)).body.deleted[0];
    expect(d).toMatchObject({ name: "Invoice 2025.pdf", outside: true, deleted_by: null, was_protected: true });
    expect((await post(julie, "restore", { deletionId: d.id })).body.restored).toBe(1);
    expect((await details(julie, "Billing/Invoice 2025.pdf")).body.profile.docType).toBe("Invoice");
  });
});

describe("versions", () => {
  const brief = `${ASSESSOR_2026}/05-17-302-010 – CCAO Brief (2026).docx`;
  it("lists every saved version, downloads an old one, and restores it", async () => {
    await fetch(`${fake.url}/__test/edit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: `${TOWER}/${brief}`.toLowerCase(), content: "brief v2 saved in Word" }) });
    const d = (await details(julie, brief)).body;
    expect(d.revisions).toHaveLength(2);
    expect(d.revisions[0].current).toBe(true);
    const old = d.revisions[1].rev;
    const dl = await fetch(`${env.base}/api/firm/properties/${towerId}/files/download?${new URLSearchParams({ path: brief, rev: old })}`, { redirect: "manual", headers: { Cookie: julie } });
    expect(await (await fetch(dl.headers.get("location")!)).text()).toBe("brief v1");
    expect((await fetch(`${env.base}/api/firm/properties/${towerId}/files/download?${new URLSearchParams({ path: brief, rev: "0123456789abcdef" })}`, { redirect: "manual", headers: { Cookie: julie } })).status).toBe(404);
    expect((await post(julie, "revisions/restore", { path: brief, rev: old })).status).toBe(200);
    const now = await fetch(`${env.base}/api/firm/properties/${towerId}/files/download?${new URLSearchParams({ path: brief })}`, { redirect: "manual", headers: { Cookie: julie } });
    expect(await (await fetch(now.headers.get("location")!)).text()).toBe("brief v1");
    expect((await details(julie, brief)).body.revisions).toHaveLength(3);
  });
});

describe("previews inside Appeal EyeQ", () => {
  const get = (rel: string, what: string) => fetch(`${env.base}/api/firm/properties/${towerId}/files/${what}?${new URLSearchParams({ path: rel })}`, { headers: { Cookie: julie } });

  it("shows Word files as PDF, spreadsheets as sandboxed HTML, and PDFs and images as they are", async () => {
    const office = await get(`${ASSESSOR_2026}/05-17-302-010 – CCAO Brief (2026).docx`, "preview");
    expect(office.headers.get("content-type")).toBe("application/pdf");
    expect(office.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(await office.text()).toMatch(/^%PDF/);

    await upload(julie, "Evaluation Worksheets", "comps.xlsx", "xlsx bytes");
    const sheet = await get("Evaluation Worksheets/comps.xlsx", "preview");
    expect(sheet.headers.get("content-type")).toMatch(/^text\/html/);
    expect(sheet.headers.get("content-security-policy")).toMatch(/^sandbox;/); // Dropbox's HTML can't run script on our site
    expect(await sheet.text()).toContain("comps.xlsx");

    const pdf = await get("Correspondence/Loose/letter.pdf", "raw");
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toMatch(/^inline/);
    expect(await pdf.text()).toBe("%PDF letter");

    await upload(julie, "Property Documents", "drawing.svg", "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    expect((await get("Property Documents/drawing.svg", "raw")).headers.get("content-security-policy")).toMatch(/^sandbox;/);
  });

  it("says plainly when something can't be previewed", async () => {
    await upload(julie, "Misc", "archive.zip", "PK zip");
    expect((await get("Misc/archive.zip", "raw")).status).toBe(415);
    expect((await get("Misc/archive.zip", "preview")).status).toBe(415);
    expect((await get("Misc/missing.pdf", "raw")).status).toBe(404);
  });

  it("reads an .eml email: who, when, subject, message and attachments", async () => {
    const eml = [
      "From: Assessor Office <notices@cookcountyassessor.example>", "To: Dillon Nichols <dillon@nicholslaw.example>", "Cc: julie@nicholslaw.example",
      "Subject: =?UTF-8?Q?Re:_2026_appeal_=E2=80=93_05-17-302-010?=", "Date: Tue, 13 Oct 2026 10:15:00 -0500", "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b1"', "", "--b1", "Content-Type: text/plain; charset=utf-8", "", "Your appeal was received.", "--b1",
      'Content-Type: application/pdf; name="receipt.pdf"', "Content-Disposition: attachment; filename=\"receipt.pdf\"", "Content-Transfer-Encoding: base64", "",
      Buffer.from("%PDF receipt").toString("base64"), "--b1--", "",
    ].join("\r\n");
    await upload(julie, "Correspondence", "assessor reply.eml", eml);
    const r = await (await get("Correspondence/assessor reply.eml", "email")).json();
    expect(r).toMatchObject({
      from: "Assessor Office <notices@cookcountyassessor.example>", to: ["Dillon Nichols <dillon@nicholslaw.example>"], cc: ["julie@nicholslaw.example"],
      subject: "Re: 2026 appeal – 05-17-302-010", attachments: [{ filename: "receipt.pdf", mimeType: "application/pdf", size: 12 }],
    });
    expect(r.text.trim()).toBe("Your appeal was received.");
  });
});

describe("search", () => {
  it("finds documents by name, type, tags, year and level, across the firm only", async () => {
    const r = (await call(env.base, dillon, "GET", `/api/firm/search?q=${encodeURIComponent("2026 assessor brief")}`)).body;
    expect(r.documents.map((d: { name: string }) => d.name)).toContain("05-17-302-010 – CCAO Brief (2026).docx");
    expect(r.documents[0]).toMatchObject({ propertyId: towerId, type: "CCAO Brief", relPath: `${ASSESSOR_2026}/05-17-302-010 – CCAO Brief (2026).docx`, property: "1044 Tower Road" });
    expect((await call(env.base, dillon, "GET", "/api/firm/search?q=uniformity")).body.documents).toHaveLength(1); // a tag
    expect((await call(env.base, dillon, "GET", `/api/firm/search?q=${encodeURIComponent("2026 ptab brief")}`)).body.documents).toHaveLength(0);
    expect((await call(env.base, olivia, "GET", "/api/firm/search?q=uniformity")).body.documents).toHaveLength(0);
  });
});

describe("Deadzone", () => {
  it("moves a closed matter aside with its files and profiles, and back", async () => {
    const r = await post(dillon, "deadzone", { to: "deadzone" });
    expect(r.body).toEqual({ path: `/Appeal EyeQ/Deadzone/Nichols, Dillon/05-17-302-010 – 1044 Tower Road, Winnetka (New Trier)`, inDeadzone: true });
    const t = await tree();
    expect(t).not.toContain("D /Appeal EyeQ/Nichols, Dillon"); // the empty client folder is cleaned up
    const list = (await files(julie)).body;
    expect(list.folder).toMatchObject({ inDeadzone: true, outOfDate: false });
    expect((await details(julie, `${ASSESSOR_2026}/05-17-302-010 – CCAO Brief (2026).docx`)).body.profile.docType).toBe("CCAO Brief");
    expect((await call(env.base, dillon, "GET", "/api/firm/search?q=uniformity")).body.documents).toHaveLength(0); // archived matters stay out of search
    const back = await post(dillon, "deadzone", { to: "active" });
    expect(back.body).toEqual({ path: TOWER, inDeadzone: false });
    expect(await tree()).not.toContain("D /Appeal EyeQ/Deadzone/Nichols, Dillon");
    expect((await post(dillon, "deadzone", { to: "elsewhere" })).status).toBe(400);
  });
});

describe("lockouts", () => {
  it("keeps another firm out of every document route", async () => {
    const rel = `${ASSESSOR_2026}/05-17-302-010 – CCAO Brief (2026).docx`;
    for (const what of ["details", "raw", "preview", "email", "deleted", "download"]) {
      const r = await call(env.base, olivia, "GET", `/api/firm/properties/${towerId}/files/${what}?${new URLSearchParams({ path: rel })}`);
      expect([404, 409]).toContain(r.status);
    }
    for (const [what, body] of [["delete", { path: rel }], ["rename", { path: rel, name: "x" }], ["folder", { path: "", name: "x" }], ["restore", { deletionId: 1 }], ["deadzone", { to: "deadzone" }]] as const) {
      expect([403, 404, 409]).toContain((await post(olivia, what, body)).status);
    }
    expect((await call(env.base, olivia, "PUT", `/api/firm/properties/${towerId}/files/profile`, { path: rel, notes: "x" })).status).toBe(404);
    // And Nichols Law's documents never appear in the other firm's rows.
    const { withContext } = await import("../../server/db");
    const seen = await withContext({ actorKind: "system", userId: null, firmId: env.otherFirmId }, async (c) => (await c.query(`SELECT count(*)::int AS n FROM documents`)).rows[0].n);
    expect(seen).toBe(0);
  });

  it("never shows documents to the super admin, even with a grant", async () => {
    const admin = await login(env.base, ADMIN.email, ADMIN.password);
    const g = await call(env.base, dillon, "POST", "/api/firm/support-grants", { hours: 1 });
    await call(env.base, admin, "POST", `/api/admin/firms/${env.nicholsId}/enter`, {});
    for (const what of ["details", "raw", "preview", "email", "deleted"]) {
      const r = await call(env.base, admin, "GET", `/api/firm/properties/${towerId}/files/${what}?path=Misc`);
      expect(r.status).toBe(403);
    }
    const search = await call(env.base, admin, "GET", "/api/firm/search?q=uniformity");
    expect(search.status).toBe(200);
    expect(search.body.documents).toEqual([]);
    await call(env.base, dillon, "POST", `/api/firm/support-grants/${g.body.grant.id}/revoke`, {});
  });
});
