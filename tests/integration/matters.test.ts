// Properties, appeals (tax math), accounts, contacts, activities, search:
// against a real server and Postgres, including cross-firm attacks.

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, call, login, startTestEnv, stopTestEnv, type TestEnv } from "./helpers";

let env: TestEnv;
let dillon = "";
let olivia = "";
let towerId = 0;
let bor2026Id = 0;
let bor2025Id = 0;

beforeAll(async () => {
  env = await startTestEnv();
  dillon = await login(env.base, "dillon@nicholslaw.example");
  olivia = await login(env.base, "olivia@otherfirm.example");
  const list = await call(env.base, dillon, "GET", "/api/firm/properties");
  towerId = list.body.properties.find((p: { address1: string }) => p.address1 === "1044 Tower Road").id;
  const detail = await call(env.base, dillon, "GET", `/api/firm/properties/${towerId}`);
  bor2026Id = detail.body.appeals.find((a: { assessment_year: number; level: string }) => a.assessment_year === 2026 && a.level === "bor").id;
  bor2025Id = detail.body.appeals.find((a: { assessment_year: number; level: string }) => a.assessment_year === 2025 && a.level === "bor").id;
});

afterAll(async () => {
  await stopTestEnv(env);
});

describe("migration 004", () => {
  it("adds accounts.edit to firms that existed before it, and is safe to run again", async () => {
    const { withContext } = await import("../../server/db");
    const count = () =>
      withContext({ actorKind: "system", userId: null, firmId: env.nicholsId }, async (c) =>
        (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM role_permissions WHERE firm_id = $1 AND permission = 'accounts.edit'`, [env.nicholsId])).rows[0].n,
      );
    await withContext({ actorKind: "system", userId: null, firmId: env.nicholsId }, (c) =>
      c.query(`DELETE FROM role_permissions WHERE firm_id = $1 AND permission = 'accounts.edit'`, [env.nicholsId]),
    );
    expect(await count()).toBe(0);
    const sql = fs.readFileSync(path.resolve("db/migrations/004_accounts_permission.sql"), "utf8");
    const { getPool } = await import("../../server/db");
    await getPool().query(sql);
    await getPool().query(sql);
    expect(await count()).toBe(2);
  });
});

describe("property grid", () => {
  it("lists all 15 sample properties with matter titles and current stage", async () => {
    const r = await call(env.base, dillon, "GET", "/api/firm/properties");
    expect(r.status).toBe(200);
    expect(r.body.properties).toHaveLength(15);
    const tower = r.body.properties.find((p: { id: number }) => p.id === towerId);
    expect(tower).toMatchObject({
      title: "05-17-302-010 – 1044 Tower Road, Winnetka (New Trier)",
      account_name: "Nichols, Dillon", county: "Cook", township: "New Trier", level: "bor", substage: "appeal_filed",
      attorney_name: "Dillon Nichols", analyst_name: "Julie Ramos", estimated_savings: "1404.32",
    });
    expect(tower.days_in_substage).toBe(28);
  });
});

describe("property detail and tax math", () => {
  it("returns appeals with the 2025 BOR at $1,736.12 and a 40% fee of $694.45, waived for a no-fee property", async () => {
    const r = await call(env.base, dillon, "GET", `/api/firm/properties/${towerId}`);
    expect(r.status).toBe(200);
    expect(r.body.appeals).toHaveLength(5);
    const bor2025 = r.body.appeals.find((a: { id: number }) => a.id === bor2025Id);
    expect(bor2025).toMatchObject({ savings: "1736.12", original_tax: "16878.97", resolved_tax: "15142.85", fee_amount: "694.45" });
    expect(bor2025.fee).toMatchObject({ percent: "40.00", source: "firm", noFee: true });
    expect(r.body.reference.rate).toMatchObject({ taxYear: 2024, ratePercent: "7.943607" });
    expect(r.body.reference.equalizer).toMatchObject({ year: 2024, factor: "3.0355" });
    expect(r.body.parcels).toHaveLength(1);
    expect(r.body.contacts.map((c: { name: string }) => c.name)).toContain("Dillon Nichols");
  });

  it("recalculates live: reference rates, then target and resolved values from land and improvement", async () => {
    // The imported 2026 BOR row carries prior-software figures. Switch to computed, apply the published rates.
    let r = await call(env.base, dillon, "PATCH", `/api/firm/appeals/${bor2026Id}`, { calcOverride: false });
    expect(r.status).toBe(200);
    r = await call(env.base, dillon, "POST", `/api/firm/appeals/${bor2026Id}/use-reference`, {});
    expect(r.status).toBe(200);
    expect(r.body.appeal).toMatchObject({ equalizer: "3.0355", tax_rate_percent: "7.943607", tax_year: 2024, original_tax: "16878.97", target_tax: "15142.85", estimated_savings: "1736.12" });

    r = await call(env.base, dillon, "PATCH", `/api/firm/appeals/${bor2026Id}`, {
      resolved: { land: "20250", impr: "42550" }, status: "reduced", substage: "decision_analysis", decisionOn: "2026-10-16",
    });
    expect(r.status).toBe(200);
    expect(r.body.appeal).toMatchObject({ resolved_av: "62800.00", resolved_tax: "15142.85", savings: "1736.12", status: "reduced", substage: "decision_analysis" });
  });

  it("requires a reason to change the equalizer or rate by hand, and records it as the source", async () => {
    let r = await call(env.base, dillon, "PATCH", `/api/firm/appeals/${bor2026Id}`, { equalizer: "3.0163" });
    expect(r.status).toBe(400);
    r = await call(env.base, dillon, "PATCH", `/api/firm/appeals/${bor2026Id}`, { equalizer: "3.0163", overrideReason: "Testing a prior-year factor" });
    expect(r.status).toBe(200);
    expect(r.body.appeal.equalizer_source).toBe("Entered by Dillon Nichols: Testing a prior-year factor");
    expect(r.body.appeal.original_tax).toBe("16772.21"); // 70,000 x 3.0163 x 7.943607%
    r = await call(env.base, dillon, "POST", `/api/firm/appeals/${bor2026Id}/use-reference`, {});
    expect(r.body.appeal.equalizer).toBe("3.0355");
  });

  it("rejects bad numbers", async () => {
    expect((await call(env.base, dillon, "PATCH", `/api/firm/appeals/${bor2026Id}`, { target: { total: "62,800" } })).status).toBe(400);
    expect((await call(env.base, dillon, "PATCH", `/api/firm/appeals/${bor2026Id}`, { taxRatePercent: "7.1234567", overrideReason: "x" })).status).toBe(400);
    expect((await call(env.base, dillon, "PATCH", `/api/firm/appeals/${bor2026Id}`, { substage: "nonsense" })).status).toBe(400);
  });

  it("chains the next level from the prior level's result, and refuses duplicates", async () => {
    const r = await call(env.base, dillon, "POST", `/api/firm/properties/${towerId}/appeals`, { assessmentYear: 2026, level: "ptab" });
    expect(r.status).toBe(201);
    const a = await call(env.base, dillon, "GET", `/api/firm/appeals/${r.body.id}`);
    expect(a.body.appeal).toMatchObject({ orig_av: "62800.00", orig_land_av: "20250.00", orig_impr_av: "42550.00", substage: "under_review", equalizer: "3.0355", original_tax: "15142.85" });
    const dupe = await call(env.base, dillon, "POST", `/api/firm/properties/${towerId}/appeals`, { assessmentYear: 2026, level: "ptab" });
    expect(dupe.status).toBe(409);
  });
});

describe("creating properties, parcels and clients", () => {
  let newPropId = 0;

  it("creates a property with a new client, a first appeal, and Cook residential at 10%", async () => {
    const counties = await call(env.base, dillon, "GET", "/api/reference/counties");
    const cook = counties.body.counties.find((c: { name: string }) => c.name === "Cook");
    const evanston = counties.body.townships.find((t: { name: string }) => t.name === "Evanston");
    const r = await call(env.base, dillon, "POST", "/api/firm/properties", {
      newAccount: { name: "Greenleaf Trust", accountType: "entity" },
      address1: "900 Greenleaf Ave.", city: "Evanston", zip: "60202", countyId: cook.id, townshipId: evanston.id,
      assetType: "residential", useType: "Two-flat", pin: "11-18-100-001-0000",
      firstAppeal: { assessmentYear: 2026, level: "bor" },
    });
    expect(r.status).toBe(201);
    newPropId = r.body.id;
    const d = await call(env.base, dillon, "GET", `/api/firm/properties/${newPropId}`);
    expect(d.body.property).toMatchObject({ title: "11-18-100-001 – 900 Greenleaf Ave., Evanston (Evanston)", level_of_assessment: "10.00", account_name: "Greenleaf Trust" });
    expect(d.body.appeals).toHaveLength(1);
    expect(d.body.appeals[0]).toMatchObject({ level: "bor", assessment_year: 2026, equalizer: "3.0355", tax_rate_percent: null });
  });

  it("rejects a township from another county and a PIN already on file", async () => {
    const counties = await call(env.base, dillon, "GET", "/api/reference/counties");
    const lake = counties.body.counties.find((c: { name: string }) => c.name === "Lake");
    const evanston = counties.body.townships.find((t: { name: string }) => t.name === "Evanston");
    const accounts = await call(env.base, dillon, "GET", "/api/firm/accounts");
    const base = { accountId: accounts.body.accounts[0].id, address1: "1 Test", city: "X", assetType: "residential" };
    expect((await call(env.base, dillon, "POST", "/api/firm/properties", { ...base, countyId: lake.id, townshipId: evanston.id, pin: "12-34-567-890-0000" })).status).toBe(400);
    expect((await call(env.base, dillon, "POST", "/api/firm/properties", { ...base, countyId: lake.id, pin: "05-17-302-010-0000" })).status).toBe(409);
  });

  it("adds, edits and removes parcels, keeping at least one", async () => {
    const add = await call(env.base, dillon, "POST", `/api/firm/properties/${newPropId}/parcels`, { pin: "11-18-100-002-0000", ownerName: "GREENLEAF TRUST" });
    expect(add.status).toBe(201);
    expect((await call(env.base, dillon, "PATCH", `/api/firm/parcels/${add.body.parcel.id}`, { class: "2-11" })).body.parcel.class).toBe("2-11");
    expect((await call(env.base, dillon, "DELETE", `/api/firm/parcels/${add.body.parcel.id}`)).status).toBe(200);
    const d = await call(env.base, dillon, "GET", `/api/firm/properties/${newPropId}`);
    expect((await call(env.base, dillon, "DELETE", `/api/firm/parcels/${d.body.parcels[0].id}`)).status).toBe(400);
  });

  it("edits a property and keeps fields it wasn't sent", async () => {
    const r = await call(env.base, dillon, "PATCH", `/api/firm/properties/${newPropId}`, { useType: "Three-flat", yearBuilt: 1925 });
    expect(r.status).toBe(200);
    const d = await call(env.base, dillon, "GET", `/api/firm/properties/${newPropId}`);
    expect(d.body.property).toMatchObject({ use_type: "Three-flat", year_built: 1925, state: "IL", city: "Evanston" });
  });

  it("sets client fee terms that flow down to the property's appeals", async () => {
    const d = await call(env.base, dillon, "GET", `/api/firm/properties/${newPropId}`);
    await call(env.base, dillon, "PATCH", `/api/firm/accounts/${d.body.property.account_id}`, { feePercentFirstYear: "30", feePercentRefund: "30" });
    const after = await call(env.base, dillon, "GET", `/api/firm/properties/${newPropId}`);
    expect(after.body.fees.firstYear).toMatchObject({ percent: "30.00", source: "account" });
    await call(env.base, dillon, "PATCH", `/api/firm/properties/${newPropId}`, { feePercentFirstYear: "35" });
    const prop = await call(env.base, dillon, "GET", `/api/firm/properties/${newPropId}`);
    expect(prop.body.fees.firstYear).toMatchObject({ percent: "35.00", source: "property" });
    expect(prop.body.appeals[0].fee).toMatchObject({ percent: "35.00", source: "property" });
  });

  it("lists clients with achieved savings and shows a client's page", async () => {
    const list = await call(env.base, dillon, "GET", "/api/firm/accounts");
    const nichols = list.body.accounts.find((a: { name: string }) => a.name === "Nichols, Dillon");
    expect(nichols.properties).toBe(1);
    const d = await call(env.base, dillon, "GET", `/api/firm/accounts/${nichols.id}`);
    expect(d.body.properties[0].title).toBe("05-17-302-010 – 1044 Tower Road, Winnetka (New Trier)");
    // 2025 BOR 1,736.12 + 2024 BOR 554.08 + the 2026 BOR reduction recorded above, 1,736.12
    expect(d.body.achievedSavings).toBe("4026.32");
    expect(d.body.account.no_fee).toBe(true);
  });
});

describe("contacts and activities", () => {
  it("adds a contact and an activity, completes the activity, and removes both", async () => {
    const c = await call(env.base, dillon, "POST", "/api/firm/contacts", { propertyId: towerId, name: "Pat Lender", role: "other", email: "pat@example.com" });
    expect(c.status).toBe(201);
    const a = await call(env.base, dillon, "POST", "/api/firm/activities", { propertyId: towerId, kind: "task", subject: "Pull 2026 assessment notice", dueOn: "2026-10-30" });
    expect(a.status).toBe(201);
    const done = await call(env.base, dillon, "PATCH", `/api/firm/activities/${a.body.activity.id}`, { status: "done" });
    expect(done.body.activity.status).toBe("done");
    expect(done.body.activity.completed_at).not.toBeNull();
    const d = await call(env.base, dillon, "GET", `/api/firm/properties/${towerId}`);
    // Open tasks come first (1044 has four sample tasks), finished ones last.
    expect(d.body.activities.at(-1)).toMatchObject({ subject: "Pull 2026 assessment notice", status: "done", created_by_name: "Dillon Nichols" });
    expect((await call(env.base, dillon, "DELETE", `/api/firm/contacts/${c.body.contact.id}`)).status).toBe(200);
    expect((await call(env.base, dillon, "DELETE", `/api/firm/activities/${a.body.activity.id}`)).status).toBe(200);
  });

  it("refuses a contact or activity attached to nothing", async () => {
    expect((await call(env.base, dillon, "POST", "/api/firm/contacts", { name: "Nobody" })).status).toBe(400);
    expect((await call(env.base, dillon, "POST", "/api/firm/activities", { subject: "Floating" })).status).toBe(400);
  });
});

describe("search", () => {
  it("finds properties by PIN digits, address and city; clients by name; appeals by petition number", async () => {
    const pin = await call(env.base, dillon, "GET", "/api/firm/search?q=05-17-302");
    expect(pin.body.properties.map((p: { id: number }) => p.id)).toContain(towerId);
    const pinDigits = await call(env.base, dillon, "GET", "/api/firm/search?q=0517302010");
    expect(pinDigits.body.properties.map((p: { id: number }) => p.id)).toContain(towerId);
    const addr = await call(env.base, dillon, "GET", "/api/firm/search?q=tower");
    expect(addr.body.properties[0].title).toContain("1044 Tower Road");
    const client = await call(env.base, dillon, "GET", "/api/firm/search?q=halsted");
    expect(client.body.accounts[0].name).toBe("Halsted Row Partners LLC");
    const petition = await call(env.base, dillon, "GET", "/api/firm/search?q=23-21615");
    expect(petition.body.appeals[0]).toMatchObject({ property_id: towerId, petition_no: "23-21615" });
    const pct = await call(env.base, dillon, "GET", "/api/firm/search?q=%25%25");
    expect(pct.body.properties).toHaveLength(0);
  });
});

describe("tenant isolation for matters", () => {
  it("another firm can't read, change or attach to Nichols Law records by id", async () => {
    expect((await call(env.base, olivia, "GET", `/api/firm/properties/${towerId}`)).status).toBe(404);
    expect((await call(env.base, olivia, "PATCH", `/api/firm/properties/${towerId}`, { notes: "x" })).status).toBe(404);
    expect((await call(env.base, olivia, "DELETE", `/api/firm/properties/${towerId}`)).status).toBe(404);
    expect((await call(env.base, olivia, "GET", `/api/firm/appeals/${bor2025Id}`)).status).toBe(404);
    expect((await call(env.base, olivia, "PATCH", `/api/firm/appeals/${bor2025Id}`, { status: "withdrawn" })).status).toBe(404);
    expect((await call(env.base, olivia, "POST", `/api/firm/appeals/${bor2025Id}/use-reference`, {})).status).toBe(404);
    expect((await call(env.base, olivia, "POST", `/api/firm/properties/${towerId}/appeals`, { assessmentYear: 2027, level: "assessor" })).status).toBe(404);
    expect((await call(env.base, olivia, "POST", `/api/firm/properties/${towerId}/parcels`, { pin: "88-88-888-888-0000" })).status).toBe(404);

    const nicholsAccount = (await call(env.base, dillon, "GET", "/api/firm/accounts")).body.accounts[0].id;
    expect((await call(env.base, olivia, "GET", `/api/firm/accounts/${nicholsAccount}`)).status).toBe(404);
    expect((await call(env.base, olivia, "PATCH", `/api/firm/accounts/${nicholsAccount}`, { name: "Hijacked" })).status).toBe(404);
    // Linking Olivia's new property or contact to a Nichols client is refused by the database itself.
    const cook = (await call(env.base, olivia, "GET", "/api/reference/counties")).body.counties.find((c: { name: string }) => c.name === "Cook");
    expect((await call(env.base, olivia, "POST", "/api/firm/properties", { accountId: nicholsAccount, address1: "2 Other", city: "X", countyId: cook.id, assetType: "commercial", pin: "77-77-777-777-0000" })).status).toBe(400);
    expect((await call(env.base, olivia, "POST", "/api/firm/contacts", { accountId: nicholsAccount, name: "Spy" })).status).toBe(400);
    expect((await call(env.base, olivia, "POST", "/api/firm/activities", { propertyId: towerId, subject: "Spy" })).status).toBe(400);

    // Nothing changed for Nichols.
    const d = await call(env.base, dillon, "GET", `/api/firm/properties/${towerId}`);
    expect(d.body.appeals.find((a: { id: number }) => a.id === bor2025Id).status).toBe("reduced");
  });

  it("a firm's lists and search never include another firm's rows, and the same PIN can exist in two firms", async () => {
    const list = await call(env.base, olivia, "GET", "/api/firm/properties");
    expect(list.body.properties.map((p: { id: number }) => p.id)).toEqual([env.otherPropertyId]);
    expect((await call(env.base, olivia, "GET", "/api/firm/search?q=tower")).body.properties).toHaveLength(0);
    expect((await call(env.base, olivia, "GET", "/api/firm/search?q=0517302010")).body.properties).toHaveLength(0);
    expect((await call(env.base, dillon, "GET", "/api/firm/search?q=99-99-999")).body.properties).toHaveLength(0);
    const p = await call(env.base, olivia, "POST", `/api/firm/properties/${env.otherPropertyId}/parcels`, { pin: "05-17-302-010-0000" });
    expect(p.status).toBe(201);
    expect((await call(env.base, dillon, "GET", `/api/firm/properties/${env.otherPropertyId}`)).status).toBe(404);
  });
});

describe("permissions and support access on matters", () => {
  it("an analyst without appeals.edit can read but not change appeals; fees.edit guards fee terms only", async () => {
    const julie = await login(env.base, "julie@nicholslaw.example");
    await call(env.base, dillon, "PUT", "/api/firm/permissions", { role: "analyst", permission: "appeals.edit", allowed: false });
    expect((await call(env.base, julie, "GET", `/api/firm/appeals/${bor2025Id}`)).status).toBe(200);
    expect((await call(env.base, julie, "PATCH", `/api/firm/appeals/${bor2025Id}`, { nextAction: "x" })).status).toBe(403);
    await call(env.base, dillon, "PUT", "/api/firm/permissions", { role: "analyst", permission: "appeals.edit", allowed: true });

    await call(env.base, dillon, "PUT", "/api/firm/permissions", { role: "analyst", permission: "fees.edit", allowed: false });
    expect((await call(env.base, julie, "PATCH", `/api/firm/properties/${towerId}`, { feePercentFirstYear: "50" })).status).toBe(403);
    expect((await call(env.base, julie, "PATCH", `/api/firm/properties/${towerId}`, { notes: "Gate code 1234" })).status).toBe(200);
    expect((await call(env.base, julie, "PATCH", `/api/firm/appeals/${bor2025Id}`, { feePercent: "10" })).status).toBe(403);
    await call(env.base, dillon, "PUT", "/api/firm/permissions", { role: "analyst", permission: "fees.edit", allowed: true });
  });

  it("the super admin under a grant can view matters but not change them", async () => {
    const admin = await login(env.base, ADMIN.email, ADMIN.password);
    const g = await call(env.base, dillon, "POST", "/api/firm/support-grants", { hours: 1 });
    await call(env.base, admin, "POST", `/api/admin/firms/${env.nicholsId}/enter`, {});
    expect((await call(env.base, admin, "GET", `/api/firm/properties/${towerId}`)).status).toBe(200);
    expect((await call(env.base, admin, "GET", "/api/firm/search?q=tower")).body.properties).toHaveLength(1);
    expect((await call(env.base, admin, "PATCH", `/api/firm/appeals/${bor2025Id}`, { nextAction: "x" })).status).toBe(403);
    expect((await call(env.base, admin, "POST", "/api/firm/activities", { propertyId: towerId, subject: "x" })).status).toBe(403);
    await call(env.base, dillon, "POST", `/api/firm/support-grants/${g.body.grant.id}/revoke`, {});
    expect((await call(env.base, admin, "GET", `/api/firm/properties/${towerId}`)).status).toBe(403);
  });

  it("records appeal changes in the audit log under the user who made them", async () => {
    const log = await call(env.base, dillon, "GET", "/api/firm/audit-log?limit=200");
    const entry = log.body.entries.find((e: { table_name: string; row_id: string; action: string }) => e.table_name === "appeals" && e.row_id === String(bor2026Id) && e.action === "UPDATE");
    expect(entry).toMatchObject({ actor_name: "Dillon Nichols", actor_kind: "firm_user" });
  });
});
