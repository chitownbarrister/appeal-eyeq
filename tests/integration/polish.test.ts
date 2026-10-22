// Delivery 10a: asset types and their roll-up (with the county's Multi-family rule), the level of
// assessment from the PIN's class code, calendar entries (tagged, firm, private), invoice design
// (logo, accent, remittance, preview) and PDFs attached to an invoice, emailed with it and on the
// pay page. Against a real server and Postgres, stand-in Dropbox and Postmark, with cross-firm attacks.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, call, login, startTestEnv, stopTestEnv, type TestEnv } from "./helpers";
import { startFakeDropbox, FAKE_APP_KEY, FAKE_APP_SECRET, type FakeDropbox } from "../fake-dropbox/server";
import { startFakeStripe, FAKE_STRIPE_KEY, FAKE_WEBHOOK_SECRET, type FakeStripe } from "../fake-stripe/server";

let env: TestEnv;
let dbx: FakeDropbox;
let stripe: FakeStripe;
let dillon = "";
let julie = "";
let olivia = "";
let admin = "";
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const ENV: Record<string, () => string> = {
  DROPBOX_APP_KEY: () => FAKE_APP_KEY, DROPBOX_APP_SECRET: () => FAKE_APP_SECRET, TOKEN_ENCRYPTION_KEY: () => "test-encryption-key-that-is-long-enough-123",
  DROPBOX_API_URL: () => dbx.url, DROPBOX_CONTENT_URL: () => dbx.url, DROPBOX_AUTHORIZE_URL: () => `${dbx.url}/oauth2/authorize`, DROPBOX_WEB_URL: () => "https://www.dropbox.test",
  STRIPE_SECRET_KEY: () => FAKE_STRIPE_KEY, STRIPE_API_URL: () => stripe.url, STRIPE_WEBHOOK_SECRET: () => FAKE_WEBHOOK_SECRET,
  POSTMARK_SERVER_TOKEN: () => "postmark-test-token", POSTMARK_FROM: () => "billing@appealeyeq.test", POSTMARK_API_URL: () => stripe.url,
  PUBLIC_BASE_URL: () => env.base,
};

const get = (cookie: string, url: string) => call(env.base, cookie, "GET", url);
const post = (cookie: string, url: string, body: unknown = {}) => call(env.base, cookie, "POST", url, body);
const patch = (cookie: string, url: string, body: unknown) => call(env.base, cookie, "PATCH", url, body);
const raw = (cookie: string, url: string) => fetch(`${env.base}${url}`, { headers: { Cookie: cookie } });

let props: { id: number; address1: string }[] = [];
const prop = (address: string) => props.find((p) => p.address1 === address)!.id;

beforeAll(async () => {
  env = await startTestEnv();
  dbx = await startFakeDropbox();
  stripe = await startFakeStripe();
  stripe.setWebhook(`${env.base}/api/stripe/webhook`);
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v();
  dillon = await login(env.base, "dillon@nicholslaw.example");
  julie = await login(env.base, "julie@nicholslaw.example");
  olivia = await login(env.base, "olivia@otherfirm.example");
  admin = await login(env.base, ADMIN.email, ADMIN.password);
  props = (await get(dillon, "/api/firm/properties")).body.properties;
}, 120000);

afterAll(async () => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  await dbx?.close();
  await stripe?.close();
  await stopTestEnv(env);
});

describe("asset types and the roll-up", () => {
  it("rolls specialty types up to a main type, and Multi-family by unit count", async () => {
    const list = (await get(dillon, "/api/firm/properties")).body.properties as { address1: string; asset_type: string; asset_group: string }[];
    const by = (a: string) => list.find((p) => p.address1 === a)!;
    expect(by("1300 Sheridan Rd.")).toMatchObject({ asset_type: "multifamily", asset_group: "commercial" }); // 48 units > 6
    expect(by("1415 W. Grand Ave.")).toMatchObject({ asset_type: "retail", asset_group: "commercial" });
    expect(by("1450 Waukegan Rd.")).toMatchObject({ asset_type: "medical", asset_group: "commercial" });
    expect(by("1700 Busse Rd.")).toMatchObject({ asset_type: "data_center", asset_group: "industrial" });
    expect(by("1044 Tower Road")).toMatchObject({ asset_type: "residential", asset_group: "residential" });
    // The dashboard counts by the main type.
    const d = (await get(dillon, "/api/firm/dashboard")).body;
    const counts = Object.fromEntries(d.byAssetType.map((x: { type: string; count: number }) => [x.type, x.count]));
    expect(counts.commercial).toBeGreaterThanOrEqual(5);
  });

  it("follows the county's rule, which the super admin changes for every firm at once", async () => {
    const cook = (await get(dillon, "/api/reference/counties")).body.counties.find((c: { name: string }) => c.name === "Cook");
    expect(cook.multifamily_max_units).toBe(6);
    expect((await call(env.base, dillon, "PUT", `/api/admin/county-rules/${cook.id}`, { multifamilyMaxUnits: 50 })).status).toBe(403);
    expect((await call(env.base, admin, "PUT", `/api/admin/county-rules/${cook.id}`, { multifamilyMaxUnits: 50 })).status).toBe(200);
    expect((await get(dillon, `/api/firm/properties/${prop("1300 Sheridan Rd.")}`)).body.property.asset_group).toBe("residential");
    const log = (await get(admin, "/api/admin/reference-changes")).body.changes[0];
    expect(log).toMatchObject({ table_name: "county_rules", action: "UPDATE", actor_name: expect.any(String) });
    expect((await call(env.base, admin, "PUT", `/api/admin/county-rules/${cook.id}`, { multifamilyMaxUnits: 0 })).status).toBe(400);
    await call(env.base, admin, "PUT", `/api/admin/county-rules/${cook.id}`, { multifamilyMaxUnits: 6 });
    expect((await get(dillon, `/api/firm/properties/${prop("1300 Sheridan Rd.")}`)).body.property.asset_group).toBe("commercial");
  });

  it("lets a Multi-family property be grouped by hand, and only Multi-family", async () => {
    const id = prop("1300 Sheridan Rd.");
    expect((await patch(dillon, `/api/firm/properties/${id}`, { assetGroupOverride: "residential" })).status).toBe(200);
    expect((await get(dillon, `/api/firm/properties/${id}`)).body.property).toMatchObject({ asset_group: "residential", asset_group_override: "residential" });
    expect((await patch(dillon, `/api/firm/properties/${prop("1415 W. Grand Ave.")}`, { assetGroupOverride: "residential" })).status).toBe(400);
    expect((await patch(dillon, `/api/firm/properties/${id}`, { assetType: "retail", assetGroupOverride: "commercial" })).status).toBe(400);
    // Changing the type away from Multi-family drops the override.
    expect((await patch(dillon, `/api/firm/properties/${id}`, { assetType: "commercial" })).status).toBe(200);
    expect((await get(dillon, `/api/firm/properties/${id}`)).body.property).toMatchObject({ asset_type: "commercial", asset_group_override: null });
    await patch(dillon, `/api/firm/properties/${id}`, { assetType: "multifamily" });
    expect((await get(dillon, `/api/firm/properties/${id}`)).body.property.asset_group).toBe("commercial");
  });

  it("needs the unit count (or a grouping) for a new Multi-family property", async () => {
    const geo = (await get(dillon, "/api/reference/counties")).body;
    const cook = geo.counties.find((c: { name: string }) => c.name === "Cook").id;
    const accountId = (await get(dillon, "/api/firm/accounts")).body.accounts[0].id;
    const base = { accountId, address1: "77 Courtyard Ln.", city: "Chicago", countyId: cook, assetType: "multifamily", pin: "17-04-100-077-0000" };
    const r = await post(dillon, "/api/firm/properties", base);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("number of units");
    const ok = await post(dillon, "/api/firm/properties", { ...base, units: 4 });
    expect(ok.status).toBe(201);
    expect((await get(dillon, `/api/firm/properties/${ok.body.id}`)).body.property).toMatchObject({ asset_group: "residential", level_of_assessment: "10.00" });
    expect((await post(dillon, "/api/firm/properties", { ...base, assetType: "warehouse", pin: "17-04-100-078-0000" })).status).toBe(400);
  });
});

describe("level of assessment from the class code", () => {
  it("comes from the primary PIN's class under the county's rules, not the roll-up", async () => {
    const sheridan = (await get(dillon, `/api/firm/properties/${prop("1300 Sheridan Rd.")}`)).body.property;
    // Class 3: apartments of 7+ units, grouped as Commercial but assessed at 10% like residential.
    expect(sheridan).toMatchObject({ asset_group: "commercial", level_of_assessment: "10.00", level_source: { kind: "class", classCode: "3-15" } });
    const grand = (await get(dillon, `/api/firm/properties/${prop("1415 W. Grand Ave.")}`)).body.property;
    expect(grand).toMatchObject({ level_of_assessment: "25.00", level_source: { kind: "class", classCode: "5-17", label: "Commercial and industrial" } });
    const lake = (await get(dillon, `/api/firm/properties/${prop("1180 N. Green Bay Rd.")}`)).body.property;
    expect(lake).toMatchObject({ level_of_assessment: "33.33", level_source: { kind: "county" } });
    const tower = (await get(dillon, `/api/firm/properties/${prop("1044 Tower Road")}`)).body.property;
    expect(tower).toMatchObject({ level_of_assessment: "10.00", level_source: { kind: "default" } }); // class "Residential" isn't a code
  });

  it("can be typed by hand, and cleared back to the class code", async () => {
    const id = prop("1415 W. Grand Ave.");
    expect((await patch(dillon, `/api/firm/properties/${id}`, { levelOfAssessment: "12.5" })).status).toBe(200);
    expect((await get(dillon, `/api/firm/properties/${id}`)).body.property).toMatchObject({ level_of_assessment: "12.50", loa_manual: true, level_source: { kind: "manual" } });
    expect((await patch(dillon, `/api/firm/properties/${id}`, { levelOfAssessment: null })).status).toBe(200);
    expect((await get(dillon, `/api/firm/properties/${id}`)).body.property).toMatchObject({ level_of_assessment: "25.00", loa_manual: false });
  });

  it("follows a class change on the parcel, and the super admin's table; new appeals start at it", async () => {
    const id = prop("1415 W. Grand Ave.");
    const d = (await get(dillon, `/api/firm/properties/${id}`)).body;
    const parcel = d.parcels[0];
    expect((await patch(dillon, `/api/firm/parcels/${parcel.id}`, { class: "2-11" })).status).toBe(200);
    expect((await get(dillon, `/api/firm/properties/${id}`)).body.property.level_of_assessment).toBe("10.00");
    await patch(dillon, `/api/firm/parcels/${parcel.id}`, { class: "5-17" });

    const rows = (await get(dillon, "/api/reference/class-levels")).body.classLevels as { id: number; county: string; class_prefix: string }[];
    const five = rows.find((r) => r.county === "Cook" && r.class_prefix === "5")!;
    expect((await patch(dillon, `/api/admin/class-levels/${five.id}`, { levelPercent: "20" })).status).toBe(403);
    expect((await patch(admin, `/api/admin/class-levels/${five.id}`, { levelPercent: "20" })).status).toBe(200);
    // A more specific class wins over the broad one.
    const cook = (await get(dillon, "/api/reference/counties")).body.counties.find((c: { name: string }) => c.name === "Cook").id;
    const added = await post(admin, "/api/admin/class-levels", { countyId: cook, classPrefix: "5-17", levelPercent: "22", label: "Test: one commercial class" });
    expect(added.status).toBe(201);
    expect((await post(admin, "/api/admin/class-levels", { countyId: cook, classPrefix: "517", levelPercent: "22", label: "dupe" })).status).toBe(409);
    expect((await get(dillon, `/api/firm/properties/${id}`)).body.property.level_of_assessment).toBe("22.00");
    const a = await post(dillon, `/api/firm/properties/${id}/appeals`, { assessmentYear: 2027, level: "assessor" });
    expect(a.status).toBe(201);
    const ap = (await get(dillon, `/api/firm/properties/${id}`)).body.appeals.find((x: { id: number }) => x.id === a.body.id);
    expect(ap.assessment_ratio).toBe("22.00");
    expect((await call(env.base, admin, "DELETE", `/api/admin/class-levels/${added.body.id}`)).status).toBe(200);
    await patch(admin, `/api/admin/class-levels/${five.id}`, { levelPercent: "25" });
    expect((await get(dillon, `/api/firm/properties/${id}`)).body.property.level_of_assessment).toBe("25.00");
    // The appeal keeps the level it was created with.
    expect((await get(dillon, `/api/firm/properties/${id}`)).body.appeals.find((x: { id: number }) => x.id === a.body.id).assessment_ratio).toBe("22.00");
    await call(env.base, dillon, "DELETE", `/api/firm/appeals/${a.body.id}`);
  });
});

describe("calendar entries", () => {
  let firmEntry = 0;
  let privateEntry = 0;

  it("makes a firm entry with times, shown on everyone's calendar", async () => {
    const r = await post(dillon, "/api/firm/activities", { kind: "meeting", subject: "Firm lunch", dueOn: "2026-10-28", startTime: "12:00", endTime: "13:30", location: "Office" });
    expect(r.status).toBe(201);
    firmEntry = r.body.activity.id;
    const cal = (await get(julie, "/api/firm/calendar?from=2026-10-25&to=2026-10-31")).body;
    expect(cal.entries.find((e: { id: number }) => e.id === firmEntry)).toMatchObject({ kind: "meeting", start_time: "12:00:00", end_time: "13:30:00", location: "Office", is_private: false });
  });

  it("keeps a private entry to the person who made it", async () => {
    const r = await post(julie, "/api/firm/activities", { kind: "reminder", subject: "Dentist", dueOn: "2026-10-29", startTime: "08:00", isPrivate: true });
    expect(r.status).toBe(201);
    privateEntry = r.body.activity.id;
    expect((await get(julie, "/api/firm/calendar?from=2026-10-25&to=2026-10-31")).body.entries.some((e: { id: number }) => e.id === privateEntry)).toBe(true);
    expect((await get(dillon, "/api/firm/calendar?from=2026-10-25&to=2026-10-31")).body.entries.some((e: { id: number }) => e.id === privateEntry)).toBe(false);
    expect((await patch(dillon, `/api/firm/activities/${privateEntry}`, { subject: "peek" })).status).toBe(404);
    expect((await call(env.base, dillon, "DELETE", `/api/firm/activities/${privateEntry}`)).status).toBe(404);
    expect((await patch(julie, `/api/firm/activities/${privateEntry}`, { status: "done" })).status).toBe(200);
  });

  it("tags entries consistently and shows a tagged one on the property's activities", async () => {
    const tower = prop("1044 Tower Road");
    const grand = prop("1415 W. Grand Ave.");
    const towerAppeal = (await get(dillon, `/api/firm/properties/${tower}`)).body.appeals[0].id;
    expect((await post(dillon, "/api/firm/activities", { kind: "call", subject: "x", dueOn: "2026-10-28", propertyId: grand, appealId: towerAppeal })).body.error).toBe("That appeal isn't on this property.");
    expect((await post(dillon, "/api/firm/activities", { kind: "call", subject: "x", dueOn: "2026-10-28", propertyId: tower, isPrivate: true })).status).toBe(400);
    expect((await post(dillon, "/api/firm/activities", { kind: "meeting", subject: "x", dueOn: "2026-10-28", startTime: "10:00", endTime: "09:00" })).status).toBe(400);
    expect((await post(dillon, "/api/firm/activities", { kind: "meeting", subject: "No date, no tag" })).status).toBe(400);
    const r = await post(dillon, "/api/firm/activities", { kind: "call", subject: "Call the assessor's analyst", dueOn: "2026-10-30", startTime: "14:00", propertyId: tower, appealId: towerAppeal });
    expect(r.status).toBe(201);
    const acts = (await get(dillon, `/api/firm/properties/${tower}`)).body.activities;
    expect(acts.find((a: { id: number }) => a.id === r.body.activity.id)).toMatchObject({ kind: "call", start_time: "14:00:00" });
    const cal = (await get(dillon, "/api/firm/calendar?from=2026-10-25&to=2026-10-31")).body;
    expect(cal.entries.find((e: { id: number }) => e.id === r.body.activity.id)).toMatchObject({ property_short: "1044 Tower Road", level: expect.any(String) });
    // Tagging later can't make a private entry public by the back door, or vice versa.
    expect((await patch(julie, `/api/firm/activities/${privateEntry}`, { propertyId: tower })).status).toBe(400);
  });

  it("keeps another firm out", async () => {
    expect((await get(olivia, "/api/firm/calendar?from=2026-10-01&to=2026-10-31")).body.entries).toHaveLength(0);
    expect((await patch(olivia, `/api/firm/activities/${firmEntry}`, { subject: "hijacked" })).status).toBe(404);
    expect((await call(env.base, olivia, "DELETE", `/api/firm/activities/${firmEntry}`)).status).toBe(404);
    // Her own entry tagged with Nichols Law's property is refused.
    expect((await post(olivia, "/api/firm/activities", { kind: "meeting", subject: "x", dueOn: "2026-10-28", propertyId: prop("1044 Tower Road") })).status).toBe(400);
    expect((await get(dillon, "/api/firm/calendar?from=2026-10-25&to=2026-10-31")).body.entries.find((e: { id: number }) => e.id === firmEntry).subject).toBe("Firm lunch");
  });
});

describe("invoice design", () => {
  it("saves the accent color and check remittance, and checks them", async () => {
    expect((await call(env.base, dillon, "PUT", "/api/firm/billing/settings", { accentColor: "#123abc", remitTo: "Payable to Nichols Law\nPO Box 12, Winnetka IL 60093" })).status).toBe(200);
    expect((await get(dillon, "/api/firm/billing/settings")).body.settings).toMatchObject({ accent_color: "#123ABC", remit_to: "Payable to Nichols Law\nPO Box 12, Winnetka IL 60093" });
    expect((await call(env.base, dillon, "PUT", "/api/firm/billing/settings", { accentColor: "copper" })).status).toBe(400);
    expect((await call(env.base, julie, "PUT", "/api/firm/billing/settings", { accentColor: "#000000" })).status).toBe(403);
  });

  it("takes a PNG logo from a firm admin only, refuses anything else, and keeps it to the firm", async () => {
    expect((await call(env.base, julie, "PUT", "/api/firm/billing/logo", { contentType: "image/png", data: PNG_1PX })).status).toBe(403);
    expect((await call(env.base, dillon, "PUT", "/api/firm/billing/logo", { contentType: "image/png", data: Buffer.from("not an image").toString("base64") })).status).toBe(400);
    expect((await call(env.base, dillon, "PUT", "/api/firm/billing/logo", { contentType: "image/gif", data: PNG_1PX })).status).toBe(400);
    const r = await call(env.base, dillon, "PUT", "/api/firm/billing/logo", { contentType: "image/png", data: PNG_1PX });
    expect(r.body).toMatchObject({ ok: true, width: 1, height: 1 });
    expect((await get(dillon, "/api/firm/billing/settings")).body.logo).toMatchObject({ width: 1, height: 1 });
    const img = await raw(dillon, "/api/firm/billing/logo");
    expect(img.headers.get("content-type")).toBe("image/png");
    expect((await raw(olivia, "/api/firm/billing/logo")).status).toBe(404);
  });

  it("previews the layout as typed, in a frame on our own pages", async () => {
    const res = await raw(dillon, `/api/firm/billing/invoice-preview?d=${encodeURIComponent(JSON.stringify({ letterheadName: "Preview & Co.", accentColor: "#0A1F44" }))}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    const pdf = Buffer.from(await res.arrayBuffer());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.toString("latin1")).toMatch(/\/Subtype\s*\/Image/); // the logo
    expect((await raw(dillon, `/api/firm/billing/invoice-preview?d=${encodeURIComponent(JSON.stringify({ accentColor: "red" }))}`)).status).toBe(400);
  });
});

describe("PDFs attached to an invoice", () => {
  let propertyId = 0;
  let invoiceId = 0;
  let docId = 0;

  async function connectDropbox() {
    const start = await fetch(`${env.base}/api/firm/integrations/dropbox/connect`, { method: "POST", headers: { Cookie: dillon, "Content-Type": "application/json" }, body: "{}" });
    const stateCookie = (start.headers.get("set-cookie") || "").split(";")[0];
    const { url } = (await start.json()) as { url: string };
    const approve = await fetch(url, { redirect: "manual" });
    await fetch(approve.headers.get("location")!, { redirect: "manual", headers: { Cookie: `${dillon}; ${stateCookie}` } });
  }

  it("lists the property's PDFs and attaches a copy", async () => {
    await connectDropbox();
    const geo = (await get(dillon, "/api/reference/counties")).body;
    const cook = geo.counties.find((c: { name: string }) => c.name === "Cook").id;
    const nt = geo.townships.find((t: { name: string }) => t.name === "New Trier").id;
    const p = await post(dillon, "/api/firm/properties", {
      newAccount: { name: "Attach, Ann", accountType: "individual" }, address1: "5 Attach Ct.", city: "Winnetka", countyId: cook, townshipId: nt, taxCode: "23008",
      assetType: "residential", pin: "05-17-399-005-0000", firstAppeal: { assessmentYear: 2026, level: "bor" },
    });
    propertyId = p.body.id;
    const d = (await get(dillon, `/api/firm/properties/${propertyId}`)).body;
    await post(dillon, "/api/firm/contacts", { accountId: d.property.account_id, name: "Ann billing", role: "billing", email: "ann@example.test" });
    await patch(dillon, `/api/firm/appeals/${d.appeals[0].id}`, { original: { total: "100000" }, target: { total: "88000" } });
    await patch(dillon, `/api/firm/appeals/${d.appeals[0].id}`, { resolved: { total: "90000" }, status: "reduced", substage: "decision_analysis" });
    invoiceId = (await post(dillon, "/api/firm/billing/draft", { appealIds: [d.appeals[0].id] })).body.drafted[0];

    expect((await post(dillon, `/api/firm/properties/${propertyId}/files/ensure`)).status).toBe(200);
    const up = await fetch(`${env.base}/api/firm/properties/${propertyId}/files/upload?${new URLSearchParams({ path: "Appeals/2026/Board of Review", name: "2026 BOR decision.pdf" })}`, {
      method: "POST", headers: { Cookie: dillon, "Content-Type": "application/octet-stream" }, body: "%PDF-1.4 the decision letter",
    });
    expect(up.status).toBe(201);
    await fetch(`${env.base}/api/firm/properties/${propertyId}/files/upload?${new URLSearchParams({ path: "Misc", name: "notes.txt" })}`, {
      method: "POST", headers: { Cookie: dillon, "Content-Type": "application/octet-stream" }, body: "not a pdf",
    });
    const pick = (await get(dillon, `/api/firm/billing/invoices/${invoiceId}/attachable`)).body.files;
    expect(pick.map((f: { name: string }) => f.name)).toEqual(["2026 BOR decision.pdf"]);
    docId = pick[0].id;
    const r = await post(dillon, `/api/firm/billing/invoices/${invoiceId}/attachments`, { documentId: docId });
    expect(r.status).toBe(201);
    expect(r.body.attachments).toEqual([expect.objectContaining({ name: "2026 BOR decision.pdf", size: 28, document_id: docId })]);
    expect((await post(dillon, `/api/firm/billing/invoices/${invoiceId}/attachments`, { documentId: docId })).status).toBe(409);
    const inv = (await get(dillon, `/api/firm/billing/invoices/${invoiceId}`)).body;
    expect(inv.attachments).toHaveLength(1);
    const file = await raw(dillon, `/api/firm/billing/invoices/${invoiceId}/attachments/${inv.attachments[0].id}`);
    expect(await file.text()).toBe("%PDF-1.4 the decision letter");
  });

  it("refuses a file from another property, a non-PDF, and another firm", async () => {
    const other = prop("1044 Tower Road");
    expect((await post(dillon, `/api/firm/properties/${other}/files/ensure`)).status).toBe(200);
    await fetch(`${env.base}/api/firm/properties/${other}/files/upload?${new URLSearchParams({ path: "Misc", name: "tower.pdf" })}`, {
      method: "POST", headers: { Cookie: dillon, "Content-Type": "application/octet-stream" }, body: "%PDF-1.4 tower",
    });
    const towerDoc = (await get(dillon, `/api/firm/properties/${other}/files?path=Misc`)).body.entries.find((e: { name: string }) => e.name === "tower.pdf");
    expect(towerDoc).toBeTruthy();
    const { withContext } = await import("../../server/db");
    const ids = await withContext({ actorKind: "system", userId: null, firmId: env.nicholsId }, async (c) => ({
      tower: (await c.query(`SELECT id FROM documents WHERE firm_id = $1 AND name = 'tower.pdf'`, [env.nicholsId])).rows[0].id,
      txt: (await c.query(`SELECT id FROM documents WHERE firm_id = $1 AND name = 'notes.txt'`, [env.nicholsId])).rows[0].id,
    }));
    expect((await post(dillon, `/api/firm/billing/invoices/${invoiceId}/attachments`, { documentId: ids.tower })).status).toBe(404);
    expect((await post(dillon, `/api/firm/billing/invoices/${invoiceId}/attachments`, { documentId: ids.txt })).status).toBe(400);
    expect((await get(olivia, `/api/firm/billing/invoices/${invoiceId}/attachable`)).status).toBe(404);
    expect((await post(olivia, `/api/firm/billing/invoices/${invoiceId}/attachments`, { documentId: docId })).status).toBe(404);
    const att = (await get(dillon, `/api/firm/billing/invoices/${invoiceId}`)).body.attachments[0].id;
    expect((await raw(olivia, `/api/firm/billing/invoices/${invoiceId}/attachments/${att}`)).status).toBe(404);
    expect((await call(env.base, olivia, "DELETE", `/api/firm/billing/invoices/${invoiceId}/attachments/${att}`)).status).toBe(404);
  });

  it("goes out with the email, prints on the invoice, and is on the client's pay page", async () => {
    const before = (await (await fetch(`${stripe.url}/__test/state`)).json()).emails.length;
    const s = await post(dillon, `/api/firm/billing/invoices/${invoiceId}/send`, { to: ["ann@example.test"], email: true });
    expect(s.body.emailed).toBe(true);
    const emails = (await (await fetch(`${stripe.url}/__test/state`)).json()).emails;
    expect(emails.length).toBe(before + 1);
    expect(emails[emails.length - 1].Attachments).toEqual([`${s.body.invoice.number}.pdf`, "2026 BOR decision.pdf"]);
    const pdf = Buffer.from(await (await raw(dillon, `/api/firm/billing/invoices/${invoiceId}/pdf`)).arrayBuffer());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const token = s.body.link.split("/pay/")[1];
    const page = await (await fetch(`${env.base}/api/pay/${token}`)).json();
    expect(page.attachments).toEqual([expect.objectContaining({ name: "2026 BOR decision.pdf" })]);
    const f = await fetch(`${env.base}/api/pay/${token}/attachments/${page.attachments[0].id}`);
    expect(f.headers.get("content-type")).toBe("application/pdf");
    expect(await f.text()).toBe("%PDF-1.4 the decision letter");
    // Only this bill's own files come through its link.
    const { withContext } = await import("../../server/db");
    const otherAtt = await withContext({ actorKind: "system", userId: null, firmId: env.otherFirmId }, async (c) => {
      const acct = env.otherAccountId;
      const i = (await c.query(`INSERT INTO invoices (firm_id, account_id, property_id, status, total) VALUES ($1, $2, $3, 'draft', 1) RETURNING id`, [env.otherFirmId, acct, env.otherPropertyId])).rows[0].id;
      return (await c.query(`INSERT INTO invoice_attachments (firm_id, invoice_id, name, size, content) VALUES ($1, $2, 'other.pdf', 9, '%PDF-other'::bytea) RETURNING id`, [env.otherFirmId, i])).rows[0].id;
    });
    expect((await fetch(`${env.base}/api/pay/${token}/attachments/${otherAtt}`)).status).toBe(404);
  });

  it("locks attachments once the invoice is paid or void", async () => {
    await post(dillon, `/api/firm/billing/invoices/${invoiceId}/void`, { reason: "Test of attachments" });
    expect((await post(dillon, `/api/firm/billing/invoices/${invoiceId}/attachments`, { documentId: docId })).status).toBe(409);
    const att = (await get(dillon, `/api/firm/billing/invoices/${invoiceId}`)).body.attachments[0].id;
    expect((await call(env.base, dillon, "DELETE", `/api/firm/billing/invoices/${invoiceId}/attachments/${att}`)).status).toBe(409);
  });

  it("keeps client files away from support access", async () => {
    await call(env.base, dillon, "POST", "/api/firm/support-grants", { hours: 1 });
    await call(env.base, admin, "POST", `/api/admin/firms/${env.nicholsId}/enter`, {});
    expect((await get(admin, `/api/firm/billing/invoices/${invoiceId}`)).status).toBe(200);
    expect((await get(admin, `/api/firm/billing/invoices/${invoiceId}/attachable`)).status).toBe(403);
    const att = (await get(admin, `/api/firm/billing/invoices/${invoiceId}`)).body.attachments[0].id;
    expect((await raw(admin, `/api/firm/billing/invoices/${invoiceId}/attachments/${att}`)).status).toBe(403);
    expect((await call(env.base, admin, "PUT", "/api/firm/billing/logo", { contentType: "image/png", data: PNG_1PX })).status).toBe(403);
  });
});
