// Delivery 10d: the bulk importer. A whole-firm migration from the prior software's own reports
// (an Account Workbook and a Property Detail, real exports with the contact details changed),
// a batch of CSV files opening new clients and matters, a bulk update of appeal results handled
// as decisions, preview, commit, undo, saved mappings, permissions, and cross-firm attacks.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ADMIN, call, login, startTestEnv, stopTestEnv, type TestEnv } from "./helpers";

let env: TestEnv;
let dillon = "";
let julie = "";
let olivia = "";
let admin = "";
const FIX = "tests/fixtures/imports";
const workbook = readFileSync(`${FIX}/AccountWorkbook.xlsx`);
const detail = readFileSync(`${FIX}/PropertyDetail.xlsx`);

const get = (cookie: string, url: string) => call(env.base, cookie, "GET", url);
const post = (cookie: string, url: string, body: unknown = {}) => call(env.base, cookie, "POST", url, body);
const put = (cookie: string, url: string, body: unknown) => call(env.base, cookie, "PUT", url, body);
async function upload(cookie: string, id: number, name: string, body: Buffer | string, type = "application/octet-stream") {
  const res = await fetch(`${env.base}/api/firm/imports/${id}/files?name=${encodeURIComponent(name)}`, { method: "POST", headers: { Cookie: cookie, "Content-Type": type }, body });
  return { status: res.status, body: await res.json() };
}
async function db<T>(firmId: number, fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const { withContext } = await import("../../server/db");
  return withContext({ actorKind: "system", userId: null, firmId }, fn);
}
async function start(cookie: string, purpose: string, files: [string, Buffer | string][]) {
  const id = (await post(cookie, "/api/firm/imports", { purpose })).body.id as number;
  for (const [n, b] of files) expect((await upload(cookie, id, n, typeof b === "string" ? Buffer.from(b) : b)).status).toBe(201);
  return id;
}

beforeAll(async () => {
  env = await startTestEnv();
  dillon = await login(env.base, "dillon@nicholslaw.example");
  julie = await login(env.base, "julie@nicholslaw.example");
  olivia = await login(env.base, "olivia@otherfirm.example");
  admin = await login(env.base, ADMIN.email, ADMIN.password);
}, 120000);

afterAll(async () => { await stopTestEnv(env); });

describe("fields and templates", () => {
  it("lists every kind of record with its fields, and serves a CSV template for each", async () => {
    const f = (await get(dillon, "/api/firm/imports/fields")).body.entities;
    expect(f.map((e: { key: string }) => e.key)).toEqual(["client", "property", "parcel", "appeal", "contact", "activity"]);
    const res = await fetch(`${env.base}/api/firm/imports/templates/appeal.csv`, { headers: { Cookie: dillon } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("Appeal EyeQ import - Appeals and values.csv");
    expect((await res.text()).split("\r\n")[0]).toMatch(/^PIN,Property name,Assessment year,Tax year,Level,/);
    expect((await fetch(`${env.base}/api/firm/imports/templates/nope.csv`, { headers: { Cookie: dillon } })).status).toBe(404);
  });
});

describe("a whole-firm migration from the prior software's reports", () => {
  let id = 0;
  it("reads both workbooks: each sheet's kind, the client and property named once at the top, and the summary pages", async () => {
    id = await start(olivia, "migration", [["AccountWorkbook.xlsx", workbook], ["PropertyDetail.xlsx", detail]]);
    const b = (await get(olivia, `/api/firm/imports/${id}`)).body;
    const kinds = Object.fromEntries(b.files.flatMap((f: { name: string; sheets: { name: string; entity: string }[] }) => f.sheets.map((s) => [`${f.name}:${s.name}`, s.entity])));
    expect(kinds).toEqual({
      "AccountWorkbook.xlsx:Account Summary": "skip", "AccountWorkbook.xlsx:Properties": "property", "AccountWorkbook.xlsx:Parcels": "parcel",
      "AccountWorkbook.xlsx:Current Activities": "activity", "AccountWorkbook.xlsx:Active Appeals": "skip", "AccountWorkbook.xlsx:All Appeals": "appeal",
      "AccountWorkbook.xlsx:Contacts": "contact", "AccountWorkbook.xlsx:Client (from Account Summary)": "client",
      "PropertyDetail.xlsx:Overview": "skip", "PropertyDetail.xlsx:Parcel Listing": "parcel", "PropertyDetail.xlsx:Values by Year": "skip",
      "PropertyDetail.xlsx:Appeals by Parcel": "skip", "PropertyDetail.xlsx:Appeals": "appeal", "PropertyDetail.xlsx:Activities": "activity",
      "PropertyDetail.xlsx:Property (from Overview)": "property",
    });
    const all = b.files[0].sheets.find((s: { name: string }) => s.name === "All Appeals");
    expect(all.columns).toMatchObject({ pin: "Parcel #", assessmentYear: "Asmt Year", level: "Appeal Type", status: "Appeal Status", origAv: "Orig  AV", savings: "Resolved Savings" });
    expect(all.samples["Appeal Type"]).toEqual(["Assessor", "Board of Review", "Assessor"]);
    expect(b.files[1].sheets[0].context).toEqual({ client: "Dillon Nichols", property: "1044 Tower Road" });
  });

  it("previews every row: one client, property and PIN from both reports, four appeals, and the same notes only once", async () => {
    const p = (await post(olivia, `/api/firm/imports/${id}/preview`)).body.summary;
    expect(p.problems).toBe(0);
    expect(p.byEntity).toEqual({
      client: { new: 1, update: 0, unchanged: 0, problem: 0 }, property: { new: 1, update: 0, unchanged: 0, problem: 0 }, parcel: { new: 1, update: 0, unchanged: 0, problem: 0 },
      appeal: { new: 4, update: 0, unchanged: 0, problem: 0 }, contact: { new: 1, update: 0, unchanged: 0, problem: 0 }, activity: { new: 10, update: 0, unchanged: 4, problem: 0 },
    });
    const rows = (await get(olivia, `/api/firm/imports/${id}/rows?entity=appeal`)).body.rows;
    expect(rows.map((r: { label: string }) => r.label)).toEqual(["1044 Tower Road · 2026 Assessor", "1044 Tower Road · 2024 BOR", "1044 Tower Road · 2025 Assessor", "1044 Tower Road · 2025 BOR"]);
    expect(rows[0]).toMatchObject({ action: "new", file: "AccountWorkbook.xlsx", sheet: "All Appeals", row: 2, message: 'Representative "George J. Relias" isn\'t a user here; left blank.' });
    expect(rows[0].changes).toMatchObject({ status: [null, "waiting_decision"], orig_av: [null, "70000.00"], target_av: [null, "64916.00"] });
    expect(rows[0].changes.resolved_av).toBeUndefined(); // the export's 0 means "not decided yet"
    const dup = (await get(olivia, `/api/firm/imports/${id}/rows?action=unchanged`)).body.rows;
    expect(dup.map((r: { message: string }) => r.message)).toEqual(Array(4).fill("Same note as an earlier row."));
  });

  it("needs a firm admin to commit a migration", async () => {
    // Olivia is Other Firm's admin; a Nichols analyst can't commit Nichols's own migration either.
    const nid = await start(julie, "migration", [["AccountWorkbook.xlsx", workbook]]);
    expect((await post(julie, `/api/firm/imports/${nid}/preview`)).status).toBe(200);
    const r = await post(julie, `/api/firm/imports/${nid}/commit`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("Only a firm admin can import a firm's data or add clients and properties in bulk.");
    expect((await call(env.base, julie, "DELETE", `/api/firm/imports/${nid}`)).status).toBe(200);
  });

  it("commits: the client, property, PIN, appeal history kept as imported, contacts and activities", async () => {
    const r = await post(olivia, `/api/firm/imports/${id}/commit`);
    expect(r.status).toBe(200);
    expect(r.body.applied.created).toEqual({ client: 1, property: 1, parcel: 1, appeal: 4, contact: 1, activity: 10 });
    const got = await db(env.otherFirmId, async (c) => {
      const acct = (await c.query(`SELECT * FROM accounts WHERE firm_id = $1 AND name = 'Dillon Nichols'`, [env.otherFirmId])).rows[0];
      const prop = (await c.query(`SELECT p.*, t.name AS township FROM properties p LEFT JOIN townships t ON t.id = p.township_id WHERE p.firm_id = $1 AND p.account_id = $2`, [env.otherFirmId, acct.id])).rows;
      const pins = (await c.query(`SELECT pin, owner_name, class, is_primary, parcel_type FROM parcels WHERE firm_id = $1 AND property_id = $2`, [env.otherFirmId, prop[0].id])).rows;
      const appeals = (await c.query(
        `SELECT assessment_year, tax_year, level, status, substage, external_id, orig_av, target_av, resolved_av, original_tax, resolved_tax, savings, estimated_savings, calc_override, data_source,
                billing_skip_reason, representative_user_id, (SELECT count(*)::int FROM appeal_pins ap WHERE ap.firm_id = a.firm_id AND ap.appeal_id = a.id AND ap.on_appeal) AS pins
           FROM appeals a WHERE firm_id = $1 AND property_id = $2 ORDER BY assessment_year, level`, [env.otherFirmId, prop[0].id])).rows;
      const contacts = (await c.query(`SELECT name, email, phone, account_id, property_id FROM contacts WHERE firm_id = $1 AND account_id = $2`, [env.otherFirmId, acct.id])).rows;
      const acts = (await c.query(`SELECT kind, subject, due_on, status, account_id, property_id FROM activities WHERE firm_id = $1 AND (account_id = $2 OR property_id = $3) ORDER BY id`, [env.otherFirmId, acct.id, prop[0].id])).rows;
      return { acct, prop, pins, appeals, contacts, acts };
    });
    expect(got.acct).toMatchObject({ account_type: "individual", address1: "1044 Tower Road", city: "Winnetka", state: "IL", zip: "60093", phone: "3125550100", source: "Imported" });
    expect(got.prop).toHaveLength(1);
    expect(got.prop[0]).toMatchObject({
      name: "1044 Tower Road", address1: "1044 Tower Road", city: "Winnetka", zip: "60093", township: "New Trier", tax_code: "23008", status: "active", asset_type: "residential",
      use_type: "Residential", purchase_date: "2022-10-06", purchase_price: "628000.00", year_built: 1915, acreage: "0.1722", units: null, building_sqft: 1672, no_fee: true,
    });
    expect(got.pins).toEqual([{ pin: "05-17-302-010-0000", owner_name: "NICHOLS DILLON / NICHOLS MICHELLE B", class: "Residential", is_primary: true, parcel_type: "real" }]);
    expect(got.appeals.map((a) => [a.assessment_year, a.level, a.status, a.substage, a.resolved_av, a.savings, a.billing_skip_reason])).toEqual([
      [2024, "bor", "reduced", "closed", "60410.00", "554.08", "Imported from earlier software"],
      [2025, "assessor", "no_change", "closed", "70000.00", null, null],
      [2025, "bor", "reduced", "closed", "62800.00", "1736.12", "Imported from earlier software"],
      [2026, "assessor", "waiting_decision", "appeal_filed", null, null, null],
    ]);
    for (const a of got.appeals) expect(a).toMatchObject({ calc_override: true, data_source: "import", representative_user_id: null, pins: 1 });
    expect(got.appeals[3]).toMatchObject({ tax_year: 2024, external_id: "2771867", original_tax: "16848.39", estimated_savings: "1223.67" });
    expect(got.contacts).toEqual([{ name: "Dillon Nichols", email: "dillon@example.com", phone: "3125550100", account_id: got.acct.id, property_id: null }]);
    expect(got.acts).toHaveLength(10);
    expect(got.acts.filter((a) => a.account_id).map((a) => a.subject)).toEqual(["https://files.example.com/clients/Nichols-Dillon/05-17-302-010-1044-Tower-Road"]);
    expect(got.acts.find((a) => a.subject === "Request new CFA")).toMatchObject({ kind: "task", due_on: "2025-01-10", status: "open" });
    expect(got.acts.find((a) => a.subject.startsWith("Letter File Front"))).toMatchObject({ kind: "note", status: "done" });
  });

  it("brings in nothing twice: the same files again preview as already there", async () => {
    const again = await start(olivia, "migration", [["AccountWorkbook.xlsx", workbook], ["PropertyDetail.xlsx", detail]]);
    const p = (await post(olivia, `/api/firm/imports/${again}/preview`)).body.summary;
    for (const e of Object.values(p.byEntity) as Record<string, number>[]) expect(e.new).toBe(0);
    expect(p.problems).toBe(0);
    expect((await call(env.base, olivia, "DELETE", `/api/firm/imports/${again}`)).status).toBe(200);
  });

  it("won't undo over work added since, then undoes the whole import once it's cleared", async () => {
    const prop = (await get(olivia, "/api/firm/properties")).body.properties.find((p: { address1: string }) => p.address1 === "1044 Tower Road");
    const act = await post(olivia, "/api/firm/activities", { propertyId: prop.id, kind: "note", subject: "Called the client" });
    expect(act.status).toBe(201);
    const blocked = await post(olivia, `/api/firm/imports/${id}/undo`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain("(1 activities)");
    expect((await call(env.base, olivia, "DELETE", `/api/firm/activities/${act.body.activity.id}`)).status).toBe(200);
    const u = await post(olivia, `/api/firm/imports/${id}/undo`);
    expect(u.status).toBe(200);
    expect(u.body.removed).toBeGreaterThanOrEqual(18);
    const left = await db(env.otherFirmId, async (c) => (await c.query(`SELECT count(*)::int AS n FROM accounts WHERE firm_id = $1 AND name = 'Dillon Nichols'`, [env.otherFirmId])).rows[0].n);
    expect(left).toBe(0);
    const h = (await get(olivia, "/api/firm/imports")).body.imports.find((x: { id: number }) => x.id === id);
    expect(h).toMatchObject({ status: "undone", committedBy: "Olivia Other", files: 2, fileNames: "AccountWorkbook.xlsx, PropertyDetail.xlsx" });
    expect((await post(olivia, `/api/firm/imports/${id}/undo`)).status).toBe(409);
  });
});

describe("matching what's already in Appeal EyeQ", () => {
  it("finds the client by name in either order, and the property, PIN and appeals by PIN; fills only what's empty", async () => {
    const id = await start(dillon, "migration", [["AccountWorkbook.xlsx", workbook], ["PropertyDetail.xlsx", detail]]);
    const p = (await post(dillon, `/api/firm/imports/${id}/preview`)).body.summary;
    expect(p.byEntity.client).toEqual({ new: 0, update: 1, unchanged: 0, problem: 0 });
    expect(p.byEntity.property.new + p.byEntity.parcel.new + p.byEntity.appeal.new).toBe(0);
    const c = (await get(dillon, `/api/firm/imports/${id}/rows?entity=client`)).body.rows[0];
    expect(c).toMatchObject({ label: "Nichols, Dillon", action: "update", message: 'Matched "Dillon Nichols" to Nichols, Dillon.' });
    expect(Object.keys(c.changes)).not.toContain("address1"); // Nichols already has an address; fill mode leaves it
    expect((await call(env.base, dillon, "DELETE", `/api/firm/imports/${id}`)).status).toBe(200);
  });
});

describe("new clients and matters in bulk, from a batch of CSV files", () => {
  const clients = "Client name,Client number,Email\nPrairie Holdings LLC,C-100,ap@prairie.example\nMaria Lopez,C-101,\n";
  const properties = "Client number,Property name,Address,City,County,Township,Tax code,PIN,Use\n"
    + "C-100,Prairie Plaza,400 W. Lake St.,Chicago,Cook,West Chicago,76001,17-09-100-001-0000,Retail strip\n"
    + "C-101,,77 Elm Ave.,Wheaton,DuPage,,,05-16-200-010,Single family\n"
    + "C-101,Lake cabin,9 Shore Dr.,Nowhere,Nowhere County,,,99-01-000-001,\n";
  const appeals = "PIN,Assessment year,Level,Status,Original AV,Target AV\n"
    + "17-09-100-001-0000,2026,BOR,Open,\"$400,000\",350000\n"
    + "17-09-100-002-0000,2026,Board of Review,Open,100000,90000\n"
    + "05-16-200-010,2026,Assessor,Pending,n/a,\n";
  const parcels = "Property name,PIN,Class\nPrairie Plaza,17-09-100-002-0000,5-17\n";
  let id = 0;

  it("previews across the files, with the rows that can't come in and why", async () => {
    id = await start(dillon, "new", [["clients.csv", clients], ["properties.csv", properties], ["more pins.csv", parcels], ["appeals.csv", appeals]]);
    const b = (await get(dillon, `/api/firm/imports/${id}`)).body;
    expect(b.files.map((f: { sheets: { entity: string }[] }) => f.sheets[0].entity)).toEqual(["client", "property", "parcel", "appeal"]);
    const p = (await post(dillon, `/api/firm/imports/${id}/preview`)).body.summary;
    expect(p.byEntity.client).toEqual({ new: 2, update: 0, unchanged: 0, problem: 0 });
    expect(p.byEntity.property).toEqual({ new: 2, update: 0, unchanged: 0, problem: 1 });
    const probs = (await get(dillon, `/api/firm/imports/${id}/rows?action=problem`)).body.rows;
    expect(probs.map((r: { label: string; message: string }) => [r.label, r.message])).toEqual([
      ["Lake cabin", "\"Nowhere County\" isn't a county Appeal EyeQ has. The super admin adds counties."],
      ["99-01-000-001", "Its property can't be imported."],
      ["05-16-200-010 · 2026 Assessor", "Original AV: \"n/a\" isn't an amount"],
    ]);
    const csv = await (await fetch(`${env.base}/api/firm/imports/${id}/problems.csv`, { headers: { Cookie: dillon } })).text();
    expect(csv.split("\r\n")[0]).toBe("File,Sheet,Row,Kind,Record,Problem");
    expect(csv).toContain("properties.csv,properties,4,Properties,Lake cabin,");
  });

  it("won't commit with problems until told to leave them out", async () => {
    const r = await post(dillon, `/api/firm/imports/${id}/commit`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/can't be imported\. Fix them in the file, or choose to leave them out\.$/);
    expect((await put(dillon, `/api/firm/imports/${id}/mapping`, { options: { skipProblems: true } })).status).toBe(200);
    expect((await post(dillon, `/api/firm/imports/${id}/commit`)).status).toBe(409); // the mapping changed, so preview again
    expect((await post(dillon, `/api/firm/imports/${id}/preview`)).status).toBe(200);
    const ok = await post(dillon, `/api/firm/imports/${id}/commit`);
    expect(ok.status).toBe(200);
    expect(ok.body.applied.created).toMatchObject({ client: 2, property: 2, parcel: 3, appeal: 1 });
  });

  it("made one BOR appeal on Prairie Plaza with both PINs, totals from them, and the entity named an entity", async () => {
    const got = await db(env.nicholsId, async (c) => {
      const acct = (await c.query(`SELECT * FROM accounts WHERE firm_id = $1 AND account_number = 'C-100'`, [env.nicholsId])).rows[0];
      const prop = (await c.query(`SELECT p.*, t.name AS township FROM properties p LEFT JOIN townships t ON t.id = p.township_id WHERE p.firm_id = $1 AND p.account_id = $2`, [env.nicholsId, acct.id])).rows[0];
      const a = (await c.query(`SELECT * FROM appeals WHERE firm_id = $1 AND property_id = $2`, [env.nicholsId, prop.id])).rows;
      const pins = (await c.query(`SELECT pc.pin, ap.orig_av, ap.target_av, ap.on_appeal FROM appeal_pins ap JOIN parcels pc ON pc.firm_id = ap.firm_id AND pc.id = ap.parcel_id WHERE ap.firm_id = $1 AND ap.appeal_id = $2 ORDER BY pc.pin`, [env.nicholsId, a[0].id])).rows;
      const elm = (await c.query(`SELECT asset_type, name FROM properties WHERE firm_id = $1 AND address1 = '77 Elm Ave.'`, [env.nicholsId])).rows[0];
      return { acct, prop, a, pins, elm };
    });
    expect(got.acct).toMatchObject({ name: "Prairie Holdings LLC", account_type: "entity", email: "ap@prairie.example" });
    expect(got.prop).toMatchObject({ name: "Prairie Plaza", township: "West Chicago", tax_code: "76001", asset_type: "retail" });
    expect(got.a).toHaveLength(1);
    expect(got.a[0]).toMatchObject({ assessment_year: 2026, tax_year: 2025, level: "bor", status: "open", substage: "under_review", orig_av: "500000.00", target_av: "440000.00", data_source: "import" });
    expect(got.pins).toEqual([
      { pin: "17-09-100-001-0000", orig_av: "400000.00", target_av: "350000.00", on_appeal: true },
      { pin: "17-09-100-002-0000", orig_av: "100000.00", target_av: "90000.00", on_appeal: true },
    ]);
    expect(got.elm).toEqual({ asset_type: "residential", name: "77 Elm Ave." });
  });

  it("undoes it cleanly", async () => {
    const u = await post(dillon, `/api/firm/imports/${id}/undo`);
    expect(u.status).toBe(200);
    const n = await db(env.nicholsId, async (c) => (await c.query(`SELECT count(*)::int AS n FROM accounts WHERE firm_id = $1 AND account_number IN ('C-100', 'C-101')`, [env.nicholsId])).rows[0].n);
    expect(n).toBe(0);
  });
});

describe("updating appeal results in bulk", () => {
  let id = 0;
  let appealId = 0;
  let pin = "";
  beforeAll(async () => {
    const props = (await get(dillon, "/api/firm/properties")).body.properties;
    const gb = props.find((p: { address1: string }) => p.address1 === "1180 N. Green Bay Rd.");
    const detailP = (await get(dillon, `/api/firm/properties/${gb.id}`)).body;
    pin = detailP.parcels[0].pin;
    appealId = detailP.appeals.find((a: { assessment_year: number; level: string; parcel_id: number | null }) => a.assessment_year === 2026 && a.level === "bor" && !a.parcel_id).id;
  });

  it("previews the change against what's there, and handles a new result as a decision", async () => {
    id = await start(dillon, "update", [["results.csv", `PIN,Asmt Year,Appeal Type,Result,Decided AV\n${pin},2026,Board of Review,Reduced,530000\n`]]);
    expect((await put(dillon, `/api/firm/imports/${id}/mapping`, { options: { applyAsDecision: true } })).status).toBe(200);
    const p = (await post(dillon, `/api/firm/imports/${id}/preview`)).body.summary;
    expect(p.byEntity.appeal).toEqual({ new: 0, update: 1, unchanged: 0, problem: 0 });
    const row = (await get(dillon, `/api/firm/imports/${id}/rows`)).body.rows.find((r: { entity: string }) => r.entity === "appeal");
    expect(row.changes).toEqual({ status: ["waiting_decision", "reduced"], resolved_av: [null, "530000.00"] });
    expect(row.message).toContain("Handled as a decision.");
  });

  it("an analyst with appeals.edit and decisions.apply can commit it; the appeal moves to decision analysis", async () => {
    const r = await post(julie, `/api/firm/imports/${id}/commit`);
    expect(r.status).toBe(200);
    const a = await db(env.nicholsId, async (c) => (await c.query(`SELECT status, substage, resolved_av, decision_on FROM appeals WHERE firm_id = $1 AND id = $2`, [env.nicholsId, appealId])).rows[0]);
    expect(a).toMatchObject({ status: "reduced", substage: "decision_analysis", resolved_av: "530000.00", decision_on: "2026-10-19" });
  });

  it("undo puts the appeal back as it was", async () => {
    expect((await post(julie, `/api/firm/imports/${id}/undo`)).status).toBe(200);
    const a = await db(env.nicholsId, async (c) => (await c.query(`SELECT status, substage, resolved_av, decision_on FROM appeals WHERE firm_id = $1 AND id = $2`, [env.nicholsId, appealId])).rows[0]);
    expect(a).toMatchObject({ status: "waiting_decision", substage: "appeal_filed", resolved_av: null, decision_on: null });
  });
});

describe("saved mappings", () => {
  it("saves a batch's mapping by name and applies it to the next batch with the same sheets", async () => {
    const csv = "Customer,Street,Town,Cnty\nAcme Corp,1 Main St.,Elgin,Kane\n";
    const id = await start(dillon, "new", [["acme.csv", csv]]);
    const b = (await get(dillon, `/api/firm/imports/${id}`)).body;
    const f = b.files[0];
    expect(f.sheets[0].entity).toBe("client");
    const set = await put(dillon, `/api/firm/imports/${id}/mapping`, { sheets: [{ fileId: f.id, sheet: f.sheets[0].name, entity: "property", columns: { client: "Customer", address1: "Street", city: "Town", county: "Cnty" } }] });
    expect(set.status).toBe(200);
    expect((await post(dillon, "/api/firm/import-mappings", { name: "Acme export", importId: id })).status).toBe(201);
    const list = (await get(dillon, "/api/firm/import-mappings")).body.mappings;
    expect(list).toEqual([expect.objectContaining({ name: "Acme export", sheets: 1 })]);

    const next = await start(dillon, "new", [["acme.csv", csv.replace("Acme Corp", "Acme Two Inc")]]);
    expect((await put(dillon, `/api/firm/imports/${next}/mapping`, { mappingId: list[0].id })).status).toBe(200);
    const nb = (await get(dillon, `/api/firm/imports/${next}`)).body;
    expect(nb.import.mappingName).toBe("Acme export");
    expect(nb.files[0].sheets[0]).toMatchObject({ entity: "property", columns: { client: "Customer", address1: "Street", city: "Town", county: "Cnty" } });
    const p = (await post(dillon, `/api/firm/imports/${next}/preview`)).body.summary;
    expect(p.byEntity.property).toEqual({ new: 1, update: 0, unchanged: 0, problem: 0 });

    // A mapping can't name a column the sheet doesn't have.
    const bad = await put(dillon, `/api/firm/imports/${next}/mapping`, { sheets: [{ fileId: nb.files[0].id, sheet: nb.files[0].sheets[0].name, entity: "property", columns: { city: "Nope" } }] });
    expect(bad.status).toBe(400);
    for (const x of [id, next]) expect((await call(env.base, dillon, "DELETE", `/api/firm/imports/${x}`)).status).toBe(200);
  });
});

describe("a large import runs in the background", () => {
  async function settle(id: number) {
    for (let i = 0; i < 600; i++) {
      const b = (await get(dillon, `/api/firm/imports/${id}`)).body.import;
      if (b.status !== "committing" && b.status !== "undoing") return b;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("import never finished");
  }
  it("commits 700 new clients in the background, shows progress, and undoes them the same way", async () => {
    let csv = "Client name,Client number\n";
    for (let i = 0; i < 700; i++) csv += `Bulk Client ${i},B-${i}\n`;
    const id = await start(dillon, "new", [["bulk.csv", csv]]);
    expect((await post(dillon, `/api/firm/imports/${id}/preview`)).body.summary.byEntity.client.new).toBe(700);
    const r = await post(dillon, `/api/firm/imports/${id}/commit`);
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ running: true, total: 700 });
    const during = (await get(dillon, `/api/firm/imports/${id}`)).body.import;
    expect(["committing", "committed"]).toContain(during.status);
    expect((await post(dillon, `/api/firm/imports/${id}/preview`)).status).toBe(during.status === "committing" ? 409 : 409);
    const done = await settle(id);
    expect(done).toMatchObject({ status: "committed", error: null, job: null });
    expect(done.summary.applied.created).toEqual({ client: 700 });
    expect((await post(dillon, `/api/firm/imports/${id}/undo`)).status).toBe(202);
    expect(await settle(id)).toMatchObject({ status: "undone", error: null });
    const n = await db(env.nicholsId, async (c) => (await c.query(`SELECT count(*)::int AS n FROM accounts WHERE firm_id = $1 AND account_number LIKE 'B-%'`, [env.nicholsId])).rows[0].n);
    expect(n).toBe(0);
  }, 120000);
});

describe("files and the upload check", () => {
  it("refuses a file that isn't CSV or Excel, an empty file, and a form-encoded post", async () => {
    const id = (await post(dillon, "/api/firm/imports", { purpose: "new" })).body.id;
    const bin = Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 1, 2, 3, 0, 0]);
    expect((await upload(dillon, id, "letter.pdf", bin)).status).toBe(415);
    expect((await upload(dillon, id, "empty.csv", "")).status).toBe(400);
    expect((await upload(dillon, id, "x.csv", "a,b,c\n1,2,3\n", "text/plain")).status).toBe(415);
    const zipNotXlsx = Buffer.concat([Buffer.from("PK"), Buffer.alloc(30)]);
    const r = await upload(dillon, id, "broken.xlsx", zipNotXlsx);
    expect(r.status).toBe(415);
    expect(r.body.error).toBe("broken.xlsx couldn't be read as an Excel workbook. Save it as .xlsx or .csv and try again.");
    expect((await call(env.base, dillon, "DELETE", `/api/firm/imports/${id}`)).status).toBe(200);
  });
});

describe("another firm's imports", () => {
  let id = 0;
  let mapping = 0;
  beforeAll(async () => {
    id = await start(dillon, "new", [["clients.csv", "Client name\nSecret Client LLC\n"]]);
    await post(dillon, `/api/firm/imports/${id}/preview`);
    mapping = (await post(dillon, "/api/firm/import-mappings", { name: "Nichols only", importId: id })).body.id;
  });

  it("are out of reach: not found to read, upload to, map, preview, commit, undo, export or delete", async () => {
    expect((await get(olivia, `/api/firm/imports/${id}`)).status).toBe(404);
    expect((await get(olivia, `/api/firm/imports/${id}/rows`)).status).toBe(404);
    expect((await fetch(`${env.base}/api/firm/imports/${id}/problems.csv`, { headers: { Cookie: olivia } })).status).toBe(404);
    expect((await upload(olivia, id, "x.csv", "Client name\nX\n")).status).toBe(404);
    expect((await put(olivia, `/api/firm/imports/${id}/mapping`, { options: { skipProblems: true } })).status).toBe(404);
    expect((await post(olivia, `/api/firm/imports/${id}/preview`)).status).toBe(404);
    expect((await post(olivia, `/api/firm/imports/${id}/commit`)).status).toBe(404);
    expect((await post(olivia, `/api/firm/imports/${id}/undo`)).status).toBe(404);
    expect((await call(env.base, olivia, "DELETE", `/api/firm/imports/${id}`)).status).toBe(404);
    expect((await post(olivia, "/api/firm/import-mappings", { name: "steal", importId: id })).status).toBe(404);
    expect((await call(env.base, olivia, "DELETE", `/api/firm/import-mappings/${mapping}`)).status).toBe(404);
    const own = await start(olivia, "new", [["c.csv", "Client name\nMine\n"]]);
    expect((await put(olivia, `/api/firm/imports/${own}/mapping`, { mappingId: mapping })).status).toBe(404);
    expect((await get(olivia, "/api/firm/imports")).body.imports.map((x: { id: number }) => x.id)).not.toContain(id);
    expect((await get(olivia, "/api/firm/import-mappings")).body.mappings).toEqual([]);
  });

  it("an import only ever sees its own firm: Other Firm's PIN and client aren't matched from Nichols", async () => {
    const x = await start(dillon, "update", [["pins.csv", "PIN,Asmt Year,Level,Status\n99-99-999-999-0000,2026,BOR,Reduced\n"]]);
    await post(dillon, `/api/firm/imports/${x}/preview`);
    const r = (await get(dillon, `/api/firm/imports/${x}/rows`)).body.rows[0];
    expect(r).toMatchObject({ action: "problem", message: "This PIN isn't in Appeal EyeQ or in the file." });
    const y = await start(dillon, "new", [["c.csv", "Client name\nOther Client\n"]]);
    await post(dillon, `/api/firm/imports/${y}/preview`);
    expect((await get(dillon, `/api/firm/imports/${y}/rows`)).body.rows[0]).toMatchObject({ action: "new", label: "Other Client" });
  });

  it("support access can't import", async () => {
    expect((await get(admin, "/api/firm/imports")).status).toBe(403);
  });
});
