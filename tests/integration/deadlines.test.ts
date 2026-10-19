// Delivery 3: deadlines, the calendar, the unfiled flag, super admin
// reference publishing (with the refresh of undecided appeals), CSV
// upload, and the sample-data reset. Real server, real Postgres, with
// cross-firm attacks on every new route. "Today" is pinned to 2026-10-19.

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, call, login, startTestEnv, stopTestEnv, type TestEnv } from "./helpers";
import { computeAppealTax } from "../../shared/valuation";

let env: TestEnv;
let dillon = "";
let julie = "";
let olivia = "";
let admin = "";
let towerId = 0;
let brookdaleId = 0;
let bor2026Id = 0;
let cookId = 0;

type Prop = { id: number; address1: string; unfiled_window_open: boolean; next_title: string | null; next_on: string | null; next_kind: string | null };

beforeAll(async () => {
  env = await startTestEnv();
  dillon = await login(env.base, "dillon@nicholslaw.example");
  julie = await login(env.base, "julie@nicholslaw.example");
  olivia = await login(env.base, "olivia@otherfirm.example");
  admin = await login(env.base, ADMIN.email, ADMIN.password);
  const list = await call(env.base, dillon, "GET", "/api/firm/properties");
  towerId = list.body.properties.find((p: Prop) => p.address1 === "1044 Tower Road").id;
  brookdaleId = list.body.properties.find((p: Prop) => p.address1 === "1440 Brookdale Rd.").id;
  const detail = await call(env.base, dillon, "GET", `/api/firm/properties/${towerId}`);
  bor2026Id = detail.body.appeals.find((a: { assessment_year: number; level: string }) => a.assessment_year === 2026 && a.level === "bor").id;
  const geo = await call(env.base, dillon, "GET", "/api/reference/counties");
  cookId = geo.body.counties.find((c: { name: string }) => c.name === "Cook").id;
});

afterAll(async () => {
  await stopTestEnv(env);
});

const sys = async <T>(firmId: number, fn: (c: import("pg").PoolClient) => Promise<T>) => {
  const { withContext } = await import("../../server/db");
  return withContext({ actorKind: "system", userId: null, firmId }, fn);
};

describe("migration 005", () => {
  it("locks the deadlines table to its firm", async () => {
    const { query } = await import("../../server/db");
    const t = await query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'deadlines'`,
    );
    expect(t.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    // With no firm context, nothing is visible even though rows exist.
    const none = await query(`SELECT count(*)::int AS n FROM deadlines`);
    expect(none.rows[0].n).toBe(0);
  });

  it("carries a hearing typed on an appeal into deadlines once, and is safe to run again", async () => {
    await sys(env.nicholsId, (c) => c.query(`UPDATE appeals SET hearing_at = '2026-12-01T15:00:00Z' WHERE firm_id = $1 AND id = $2`, [env.nicholsId, bor2026Id]));
    const { getPool } = await import("../../server/db");
    const sql = fs.readFileSync(path.resolve("db/migrations/005_deadlines.sql"), "utf8");
    await getPool().query(sql);
    await getPool().query(sql);
    const rows = await sys(env.nicholsId, async (c) =>
      (await c.query(`SELECT kind, title, due_on, due_time FROM deadlines WHERE firm_id = $1 AND appeal_id = $2`, [env.nicholsId, bor2026Id])).rows,
    );
    expect(rows).toEqual([{ kind: "hearing", title: "BOR hearing", due_on: "2026-12-01", due_time: "09:00:00" }]);
    await sys(env.nicholsId, (c) => c.query(`DELETE FROM deadlines WHERE firm_id = $1 AND appeal_id = $2`, [env.nicholsId, bor2026Id]));
    await sys(env.nicholsId, (c) => c.query(`UPDATE appeals SET hearing_at = NULL WHERE firm_id = $1 AND id = $2`, [env.nicholsId, bor2026Id]));
  });
});

describe("property grid: unfiled flag and next date", () => {
  it("flags the five properties still under review while their township's window is open", async () => {
    const list = await call(env.base, dillon, "GET", "/api/firm/properties");
    expect(list.body.today).toBe("2026-10-19");
    const flagged = list.body.properties.filter((p: Prop) => p.unfiled_window_open).map((p: Prop) => p.address1).sort();
    expect(flagged).toEqual(["1027 N. Euclid Ave.", "1415 W. Grand Ave.", "1450 Waukegan Rd.", "1700 Busse Rd.", "3800 E. Main St."]);
  });

  it("shows the earliest of a deadline and the window close as the next date", async () => {
    const list = await call(env.base, dillon, "GET", "/api/firm/properties");
    const by = (a: string) => list.body.properties.find((p: Prop) => p.address1 === a) as Prop;
    expect(by("1440 Brookdale Rd.")).toMatchObject({ next_title: "BOR hearing", next_on: "2026-10-22", next_kind: "hearing" });
    expect(by("1700 Busse Rd.")).toMatchObject({ next_title: "Elk Grove BOR window closes", next_on: "2026-10-27", next_kind: "window" });
    expect(by("1450 Waukegan Rd.")).toMatchObject({ next_title: "PTAB filing deadline", next_on: "2026-10-28", next_kind: "filing" });
    expect(by("2200 Pratt Blvd.")).toMatchObject({ next_title: "Evidence due", next_on: "2026-11-03", next_kind: "evidence" });
  });
});

describe("deadlines on the property", () => {
  it("lists stored deadlines with the township window, upcoming first", async () => {
    const d = await call(env.base, dillon, "GET", `/api/firm/properties/${brookdaleId}`);
    expect(d.body.deadlines.map((x: { title: string; status: string; days: number }) => [x.title, x.status, x.days])).toEqual([
      ["BOR hearing", "open", 3],
      ["Lisle BOR window closed", "done", -26],
    ]);
    expect(d.body.deadlines[0]).toMatchObject({ due_time: "10:30:00", source: "notice", kind: "hearing" });
  });

  it("adds, edits, completes and deletes a deadline, keeping the appeal's hearing date in step", async () => {
    const add = await call(env.base, dillon, "POST", `/api/firm/properties/${towerId}/deadlines`, { kind: "hearing", appealId: bor2026Id, dueOn: "2026-11-12", dueTime: "13:30", location: "Room 601" });
    expect(add.status).toBe(201);
    expect(add.body.deadline).toMatchObject({ title: "BOR hearing", kind: "hearing", due_on: "2026-11-12", due_time: "13:30:00", source: "manual" });
    let a = await call(env.base, dillon, "GET", `/api/firm/appeals/${bor2026Id}`);
    expect(new Date(a.body.appeal.hearing_at).toISOString()).toBe("2026-11-12T19:30:00.000Z"); // 1:30 PM Chicago (CST)

    const ev = await call(env.base, dillon, "POST", `/api/firm/properties/${towerId}/deadlines`, { kind: "evidence", appealId: bor2026Id, dueOn: "2026-10-30" });
    expect(ev.body.deadline.title).toBe("BOR evidence due");
    const d = await call(env.base, dillon, "GET", `/api/firm/properties/${towerId}`);
    expect(d.body.deadlines.slice(0, 2).map((x: { title: string }) => x.title)).toEqual(["BOR evidence due", "BOR hearing"]);

    const done = await call(env.base, julie, "PATCH", `/api/firm/deadlines/${ev.body.deadline.id}`, { status: "done" });
    expect(done.body.deadline.status).toBe("done");
    expect(done.body.deadline.completed_at).not.toBeNull();

    const moved = await call(env.base, dillon, "PATCH", `/api/firm/deadlines/${add.body.deadline.id}`, { dueOn: "2026-11-19", dueTime: "10:00" });
    expect(moved.status).toBe(200);
    a = await call(env.base, dillon, "GET", `/api/firm/appeals/${bor2026Id}`);
    expect(new Date(a.body.appeal.hearing_at).toISOString()).toBe("2026-11-19T16:00:00.000Z");

    expect((await call(env.base, dillon, "DELETE", `/api/firm/deadlines/${add.body.deadline.id}`)).status).toBe(200);
    a = await call(env.base, dillon, "GET", `/api/firm/appeals/${bor2026Id}`);
    expect(a.body.appeal.hearing_at).toBeNull();
    expect((await call(env.base, dillon, "DELETE", `/api/firm/deadlines/${ev.body.deadline.id}`)).status).toBe(200);
  });

  it("requires a reason to move a date the app worked out, and keeps the original", async () => {
    const id = await sys(env.nicholsId, async (c) =>
      (await c.query(`INSERT INTO deadlines (firm_id, property_id, kind, title, due_on, source) VALUES ($1, $2, 'filing', 'PTAB filing deadline', '2026-11-20', 'computed') RETURNING id`, [env.nicholsId, towerId])).rows[0].id,
    );
    const noReason = await call(env.base, dillon, "PATCH", `/api/firm/deadlines/${id}`, { dueOn: "2026-11-23" });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toMatch(/reason/);
    const ok = await call(env.base, dillon, "PATCH", `/api/firm/deadlines/${id}`, { dueOn: "2026-11-23", overrideReason: "Decision mailed three days late" });
    expect(ok.body.deadline).toMatchObject({ due_on: "2026-11-23", computed_on: "2026-11-20", override_reason: "Decision mailed three days late" });
    await call(env.base, dillon, "DELETE", `/api/firm/deadlines/${id}`);
  });

  it("rejects a deadline tied to another property's appeal, and bad input", async () => {
    const other = (await call(env.base, dillon, "GET", "/api/firm/properties")).body.properties.find((p: Prop) => p.address1 === "1700 Busse Rd.").id;
    const r = await call(env.base, dillon, "POST", `/api/firm/properties/${other}/deadlines`, { kind: "evidence", appealId: bor2026Id, dueOn: "2026-11-01" });
    expect(r.status).toBe(400);
    expect((await call(env.base, dillon, "POST", `/api/firm/properties/${towerId}/deadlines`, { kind: "evidence", dueOn: "11/01/2026" })).status).toBe(400);
    expect((await call(env.base, dillon, "POST", `/api/firm/properties/${towerId}/deadlines`, { kind: "party", dueOn: "2026-11-01" })).status).toBe(400);
    expect((await call(env.base, dillon, "POST", `/api/firm/properties/${towerId}/deadlines`, { kind: "evidence", dueOn: "2026-13-45" })).status).toBe(400);
  });
});

describe("calendar", () => {
  it("returns the firm's windows, deadlines and tasks for a range", async () => {
    const cal = await call(env.base, dillon, "GET", "/api/firm/calendar?from=2026-09-27&to=2026-11-07");
    expect(cal.status).toBe(200);
    const labels = cal.body.windows.map((w: { label: string }) => w.label);
    expect(labels).toContain("Elk Grove BOR");
    expect(labels).toContain("Northfield PTAB");
    const elk = cal.body.windows.find((w: { label: string }) => w.label === "Elk Grove BOR");
    expect(elk).toMatchObject({ properties: 2, unfiled: 1, opens_on: "2026-09-28", closes_on: "2026-10-27" });
    expect(cal.body.deadlines.map((d: { title: string }) => d.title).sort()).toEqual(["BOR hearing", "Evidence due", "PTAB filing deadline"]);
    expect(cal.body.tasks.map((t: { subject: string }) => t.subject).sort()).toEqual([
      "Client letter: fairly assessed", "Decision received Sep 21: invoice or push to PTAB", "Push to BOR or close",
    ]);
    const hearing = cal.body.deadlines.find((d: { title: string }) => d.title === "BOR hearing");
    expect(hearing).toMatchObject({ due_time: "10:30:00", property_short: "1440 Brookdale Rd.", attorney_name: "Marcus Tate", mine: false });
  });

  it("marks what belongs to the signed-in user", async () => {
    const cal = await call(env.base, julie, "GET", "/api/firm/calendar?from=2026-10-01&to=2026-11-30");
    const mine = cal.body.tasks.filter((t: { mine: boolean }) => t.mine).map((t: { subject: string }) => t.subject);
    // Julie is the analyst on 512 Dole Ave. and 1300 Sheridan Rd., so their tasks are assigned to her.
    expect(mine.sort()).toEqual(["Client letter: fairly assessed", "Decision received Sep 21: invoice or push to PTAB"]);
    const deadlines = cal.body.deadlines as { mine: boolean; attorney_name: string; analyst_name: string; property_short: string }[];
    expect(deadlines.filter((d) => d.mine).map((d) => d.property_short).sort()).toEqual(["2200 Pratt Blvd.", "2400 Channahon Rd.", "2550 Channahon Rd."]);
    expect(deadlines.every((d) => d.mine === (d.analyst_name === "Julie Ramos" || d.attorney_name === "Julie Ramos"))).toBe(true);
  });

  it("only shows windows for the firm's townships unless asked for all", async () => {
    const mineOnly = await call(env.base, olivia, "GET", "/api/firm/calendar?from=2026-07-01&to=2026-12-31");
    expect(mineOnly.body.windows).toHaveLength(0);
    const all = await call(env.base, olivia, "GET", "/api/firm/calendar?from=2026-07-01&to=2026-12-31&windows=all");
    expect(all.body.windows.length).toBe(14);
    expect(all.body.windows.every((w: { properties: number; unfiled: number }) => w.properties === 0 && w.unfiled === 0)).toBe(true);
  });

  it("rejects a missing or oversized range", async () => {
    expect((await call(env.base, dillon, "GET", "/api/firm/calendar")).status).toBe(400);
    expect((await call(env.base, dillon, "GET", "/api/firm/calendar?from=2026-01-01&to=2027-06-30")).status).toBe(400);
  });
});

describe("firm isolation on the new routes", () => {
  it("keeps another firm from reading, changing or attaching to Nichols Law's deadlines", async () => {
    const ev = await call(env.base, dillon, "POST", `/api/firm/properties/${towerId}/deadlines`, { kind: "other", title: "Isolation check", dueOn: "2026-10-25" });
    const id = ev.body.deadline.id;
    expect((await call(env.base, olivia, "PATCH", `/api/firm/deadlines/${id}`, { title: "hijacked" })).status).toBe(404);
    expect((await call(env.base, olivia, "DELETE", `/api/firm/deadlines/${id}`)).status).toBe(404);
    expect((await call(env.base, olivia, "POST", `/api/firm/properties/${towerId}/deadlines`, { kind: "other", title: "x", dueOn: "2026-10-25" })).status).toBe(404);
    // Her own property, but Nichols Law's appeal id.
    expect((await call(env.base, olivia, "POST", `/api/firm/properties/${env.otherPropertyId}/deadlines`, { kind: "hearing", appealId: bor2026Id, dueOn: "2026-10-25" })).status).toBe(400);
    const cal = await call(env.base, olivia, "GET", "/api/firm/calendar?from=2026-01-01&to=2026-12-31");
    expect(cal.body.deadlines).toHaveLength(0);
    expect(cal.body.tasks).toHaveLength(0);
    const still = await call(env.base, dillon, "GET", `/api/firm/properties/${towerId}`);
    expect(still.body.deadlines.find((d: { id: number }) => d.id === id).title).toBe("Isolation check");
    await call(env.base, dillon, "DELETE", `/api/firm/deadlines/${id}`);
  });

  it("lets the super admin read the calendar under a grant, but not change deadlines", async () => {
    const g = await call(env.base, dillon, "POST", "/api/firm/support-grants", { hours: 1 });
    await call(env.base, admin, "POST", `/api/admin/firms/${env.nicholsId}/enter`, {});
    expect((await call(env.base, admin, "GET", "/api/firm/calendar?from=2026-10-01&to=2026-10-31")).body.deadlines.length).toBeGreaterThan(0);
    expect((await call(env.base, admin, "POST", `/api/firm/properties/${towerId}/deadlines`, { kind: "other", title: "x", dueOn: "2026-10-25" })).status).toBe(403);
    expect((await call(env.base, admin, "POST", "/api/firm/sample/reset", {})).status).toBe(403);
    await call(env.base, dillon, "POST", `/api/firm/support-grants/${g.body.grant.id}/revoke`, {});
    await call(env.base, admin, "POST", "/api/admin/exit", {});
  });
});

describe("super admin reference data", () => {
  it("is closed to firm users", async () => {
    expect((await call(env.base, dillon, "POST", "/api/admin/windows", {})).status).toBe(403);
    expect((await call(env.base, dillon, "POST", "/api/admin/import/tax-rates", { csv: "x" })).status).toBe(403);
    expect((await call(env.base, olivia, "PATCH", "/api/admin/equalizers/1", {})).status).toBe(403);
  });

  it("adds, edits and deletes a window, refuses duplicates and mismatched townships, and logs each change", async () => {
    const geo = (await call(env.base, admin, "GET", "/api/reference/counties")).body;
    const lake = geo.counties.find((c: { name: string }) => c.name === "Lake").id;
    const newTrier = geo.townships.find((t: { name: string }) => t.name === "New Trier").id;
    const shields = geo.townships.find((t: { name: string }) => t.name === "Shields").id;
    expect((await call(env.base, admin, "POST", "/api/admin/windows", { countyId: lake, townshipId: newTrier, level: "bor", assessmentYear: 2027, opensOn: "2027-08-01", closesOn: "2027-08-31" })).status).toBe(400);
    expect((await call(env.base, admin, "POST", "/api/admin/windows", { countyId: lake, townshipId: shields, level: "bor", assessmentYear: 2027, opensOn: "2027-08-31", closesOn: "2027-08-01" })).status).toBe(400);
    const add = await call(env.base, admin, "POST", "/api/admin/windows", { countyId: lake, townshipId: shields, level: "bor", assessmentYear: 2027, opensOn: "2027-08-01", closesOn: "2027-08-31" });
    expect(add.status).toBe(201);
    expect((await call(env.base, admin, "POST", "/api/admin/windows", { countyId: lake, townshipId: shields, level: "bor", assessmentYear: 2027, opensOn: "2027-08-02", closesOn: "2027-08-30" })).status).toBe(409);
    expect((await call(env.base, admin, "PATCH", `/api/admin/windows/${add.body.id}`, { countyId: lake, townshipId: shields, level: "bor", assessmentYear: 2027, opensOn: "2027-08-03", closesOn: "2027-09-02", note: "Corrected" })).status).toBe(200);
    const seen = (await call(env.base, dillon, "GET", "/api/reference/windows?year=2027")).body.windows;
    expect(seen).toEqual([expect.objectContaining({ township: "Shields", opens_on: "2027-08-03", closes_on: "2027-09-02", note: "Corrected", is_sample: false })]);
    expect((await call(env.base, admin, "DELETE", `/api/admin/windows/${add.body.id}`)).status).toBe(200);
    const log = (await call(env.base, admin, "GET", "/api/admin/reference-changes")).body.changes.filter((c: { table_name: string; row_id: string }) => c.table_name === "filing_windows" && c.row_id === String(add.body.id));
    expect(log.map((c: { action: string }) => c.action)).toEqual(["DELETE", "UPDATE", "INSERT"]);
    expect(log.every((c: { actor_name: string }) => c.actor_name === "Super Admin")).toBe(true);
  });

  it("adds a township to a county", async () => {
    const geo = (await call(env.base, admin, "GET", "/api/reference/counties")).body;
    const lake = geo.counties.find((c: { name: string }) => c.name === "Lake").id;
    expect((await call(env.base, admin, "POST", "/api/admin/townships", { countyId: lake, name: "Libertyville" })).status).toBe(201);
    expect((await call(env.base, admin, "POST", "/api/admin/townships", { countyId: lake, name: "libertyville" })).status).toBe(409);
  });
});

describe("publishing a rate refreshes undecided appeals in every firm", () => {
  let openId = 0;
  let decidedId = 0;
  let manualId = 0;
  let oliviaAppealId = 0;

  it("sets up appeals on tax code 23008 in two firms", async () => {
    // Nichols Law: a new Cook property on tax code 23008 with an open 2026 BOR appeal.
    const p = await call(env.base, dillon, "POST", "/api/firm/properties", {
      newAccount: { name: "Refresh Test LLC", accountType: "entity" }, address1: "1 Refresh Way", city: "Winnetka", countyId: cookId,
      taxCode: "23008", assetType: "residential", pin: "05-17-999-001-0000", firstAppeal: { assessmentYear: 2026, level: "bor" },
    });
    const d = await call(env.base, dillon, "GET", `/api/firm/properties/${p.body.id}`);
    openId = d.body.appeals[0].id;
    expect(d.body.appeals[0]).toMatchObject({ equalizer: "3.0355", tax_rate_percent: "7.943607", tax_year: 2024 });
    await call(env.base, dillon, "PATCH", `/api/firm/appeals/${openId}`, { original: { total: "70000" }, target: { total: "62800" } });

    // A decided appeal not yet invoiced, and one with a rate typed by hand.
    const a2 = await call(env.base, dillon, "POST", `/api/firm/properties/${p.body.id}/appeals`, { assessmentYear: 2025, level: "bor" });
    decidedId = a2.body.id;
    await call(env.base, dillon, "PATCH", `/api/firm/appeals/${decidedId}`, { original: { total: "70000" }, resolved: { total: "62800" }, status: "reduced", substage: "decision_analysis" });
    const a3 = await call(env.base, dillon, "POST", `/api/firm/properties/${p.body.id}/appeals`, { assessmentYear: 2025, level: "assessor" });
    manualId = a3.body.id;
    await call(env.base, dillon, "PATCH", `/api/firm/appeals/${manualId}`, { original: { total: "70000" }, target: { total: "65000" }, taxRatePercent: "8.000000", overrideReason: "Clerk's preliminary figure" });

    // Other Firm: its property moves onto tax code 23008 with an open appeal.
    await call(env.base, olivia, "PATCH", `/api/firm/properties/${env.otherPropertyId}`, { taxCode: "23008" });
    const oa = await call(env.base, olivia, "POST", `/api/firm/properties/${env.otherPropertyId}/appeals`, { assessmentYear: 2026, level: "assessor" });
    oliviaAppealId = oa.body.id;
    await call(env.base, olivia, "PATCH", `/api/firm/appeals/${oliviaAppealId}`, { original: { total: "50000" }, target: { total: "45000" } });
  });

  it("recalculates undecided appeals in both firms and flags the rest", async () => {
    const eq = await call(env.base, admin, "POST", "/api/admin/equalizers", { countyId: cookId, year: 2025, factor: "3.0163", source: "Test multiplier" });
    expect(eq.status).toBe(201);
    // The equalizer alone doesn't change anything yet: the latest rate is still tax year 2024, which pairs with the 2024 equalizer.
    expect(eq.body.refresh).toEqual({ appealsUpdated: 0, firmsUpdated: 0 });
    const rate = await call(env.base, admin, "POST", "/api/admin/tax-rates", { countyId: cookId, taxCode: "23008", taxYear: 2025, ratePercent: "8.123456", source: "Test clerk report" });
    expect(rate.status).toBe(201);
    expect(rate.body.refresh).toEqual({ appealsUpdated: 2, firmsUpdated: 2 });

    const expected = computeAppealTax({ origAv: "70000.00", targetAv: "62800.00", resolvedAv: null, equalizer: "3.0163", taxRatePercent: "8.123456" });
    const open = (await call(env.base, dillon, "GET", `/api/firm/appeals/${openId}`)).body.appeal;
    expect(open).toMatchObject({ equalizer: "3.0163", tax_rate_percent: "8.123456", tax_year: 2025, original_tax: expected.originalTax, target_tax: expected.targetTax, estimated_savings: expected.estimatedSavings });
    expect(open.tax_rate_source).toBe("Test clerk report (tax year 2025)");

    const theirs = (await call(env.base, olivia, "GET", `/api/firm/appeals/${oliviaAppealId}`)).body.appeal;
    expect(theirs).toMatchObject({ equalizer: "3.0163", tax_rate_percent: "8.123456" });

    const detail = await call(env.base, dillon, "GET", `/api/firm/properties/${open.property_id}`);
    const by = (id: number) => detail.body.appeals.find((a: { id: number }) => a.id === id);
    expect(by(openId).reference_update).toBeNull();
    expect(by(decidedId)).toMatchObject({ equalizer: "3.0355", tax_rate_percent: "7.943607", reference_update: { equalizer: "3.0163", ratePercent: "8.123456", taxYear: 2025, manual: false } });
    expect(by(manualId)).toMatchObject({ tax_rate_percent: "8.000000", reference_update: { manual: true } });

    // One click applies it to the decided appeal, and the flag goes away.
    expect((await call(env.base, dillon, "POST", `/api/firm/appeals/${decidedId}/use-reference`, {})).status).toBe(200);
    const after = await call(env.base, dillon, "GET", `/api/firm/properties/${open.property_id}`);
    expect(after.body.appeals.find((a: { id: number }) => a.id === decidedId).reference_update).toBeNull();
  });

  it("leaves settled and hand-entered appeals alone, and records refreshes under the system", async () => {
    // 1044 Tower Road's figures were entered from the prior software, so they never move.
    const tower = await call(env.base, dillon, "GET", `/api/firm/properties/${towerId}`);
    const bor2025 = tower.body.appeals.find((a: { assessment_year: number; level: string }) => a.assessment_year === 2025 && a.level === "bor");
    expect(bor2025).toMatchObject({ savings: "1736.12", equalizer: "3.0355", reference_update: null });
    const log = await call(env.base, dillon, "GET", "/api/firm/audit-log?limit=200");
    const sysRow = log.body.entries.find((e: { table_name: string; row_id: string; actor_kind: string }) => e.table_name === "appeals" && e.row_id === String(openId) && e.actor_kind === "system");
    expect(sysRow).toBeTruthy();
  });

  it("deleting the newer rate falls back to the previous one", async () => {
    const rates = (await call(env.base, admin, "GET", "/api/reference/tax-rates?taxCode=23008")).body.taxRates;
    const r2025 = rates.find((r: { tax_year: number }) => r.tax_year === 2025);
    const del = await call(env.base, admin, "DELETE", `/api/admin/tax-rates/${r2025.id}`);
    expect(del.body.refresh.appealsUpdated).toBe(2);
    const open = (await call(env.base, dillon, "GET", `/api/firm/appeals/${openId}`)).body.appeal;
    expect(open).toMatchObject({ equalizer: "3.0355", tax_rate_percent: "7.943607", estimated_savings: "1736.12" });
  });
});

describe("CSV upload", () => {
  it("saves nothing when any row is wrong, and says which rows", async () => {
    const csv = "County,Township,Level,Year,Opens,Closes\nCook,New Trier,Board of Review,2027,2027-07-20,2027-08-19\nCook,Atlantis,BOR,2027,2027-07-20,2027-08-19\nLake,Shields,Board of Review,2027,13/45/2027,2027-08-19\nCook,Evanston,Supreme Court,2027,2027-07-20,2027-08-19";
    const r = await call(env.base, admin, "POST", "/api/admin/import/windows", { csv });
    expect(r.status).toBe(400);
    expect(r.body.rows).toEqual([
      expect.stringMatching(/^Row 3: "Atlantis" isn't a township in Cook/),
      expect.stringMatching(/^Row 4: dates should look like/),
      expect.stringMatching(/^Row 5: level "Supreme Court"/),
    ]);
    expect((await call(env.base, admin, "GET", "/api/reference/windows?year=2027")).body.windows).toHaveLength(0);
  });

  it("names missing columns", async () => {
    const r = await call(env.base, admin, "POST", "/api/admin/import/tax-rates", { csv: "County,Tax year\nCook,2025" });
    expect(r.body.error).toBe("Missing columns: Tax code, Rate.");
  });

  it("adds new rows, updates changed ones, skips identical ones, and refreshes appeals for rates", async () => {
    const csv = "County,Township,Level,Assessment year,Opens,Closes,Note\nCook,New Trier,Board of Review,2027,07/20/2027,08/19/2027,\nCook,,Assessor,2027,2027-05-01,2027-06-01,County-wide test";
    const first = await call(env.base, admin, "POST", "/api/admin/import/windows", { csv });
    expect(first.body).toMatchObject({ added: 2, updated: 0, unchanged: 0 });
    const again = await call(env.base, admin, "POST", "/api/admin/import/windows", { csv: csv.replace("08/19/2027", "08/21/2027") });
    expect(again.body).toMatchObject({ added: 0, updated: 1, unchanged: 1 });
    const rates = await call(env.base, admin, "POST", "/api/admin/import/tax-rates", { csv: "County,Tax code,Tax year,Rate %,Source\nCook,23008,2025,8.5%,Upload test\nCook,23009,2025,7.1,Upload test" });
    expect(rates.body).toMatchObject({ added: 2, updated: 0, unchanged: 0, refresh: { appealsUpdated: 2, firmsUpdated: 2 } });
  });
});

describe("sample data reset", () => {
  it("restores the sample set after changes, and leaves other firms alone", async () => {
    const before = await call(env.base, olivia, "GET", "/api/firm/properties");
    const busse = (await call(env.base, dillon, "GET", "/api/firm/properties")).body.properties.find((p: Prop) => p.address1 === "1700 Busse Rd.").id;
    expect((await call(env.base, dillon, "DELETE", `/api/firm/properties/${busse}`)).status).toBe(200);
    expect((await call(env.base, dillon, "PUT", "/api/firm/fee-defaults", { level: "bor", percent: "35" })).status).toBe(200);

    expect((await call(env.base, olivia, "POST", "/api/firm/sample/reset", {})).status).toBe(403);
    const r = await call(env.base, julie, "POST", "/api/firm/sample/reset", {});
    expect(r.status).toBe(200);

    const list = await call(env.base, dillon, "GET", "/api/firm/properties");
    expect(list.body.properties).toHaveLength(15);
    expect(list.body.properties.map((p: Prop) => p.address1)).toContain("1700 Busse Rd.");
    const tower = list.body.properties.find((p: Prop) => p.address1 === "1044 Tower Road");
    const d = await call(env.base, dillon, "GET", `/api/firm/properties/${tower.id}`);
    expect(d.body.activities.map((a: { subject: string }) => a.subject)).toContain("Request new contingency fee agreement");
    expect(d.body.parcels[0]).toMatchObject({ owner_name: "NICHOLS DILLON / NICHOLS MICHELLE B", class: "Residential", zip: "60093-1850" });
    const fees = await call(env.base, dillon, "GET", "/api/firm/fee-defaults");
    expect(fees.body.feeDefaults.find((f: { level: string }) => f.level === "bor").percent).toBe("40.00");
    const cal = await call(env.base, dillon, "GET", "/api/firm/calendar?from=2026-10-01&to=2026-11-30");
    expect(cal.body.deadlines).toHaveLength(5);

    const after = await call(env.base, olivia, "GET", "/api/firm/properties");
    expect(after.body.properties.map((p: { id: number }) => p.id)).toEqual(before.body.properties.map((p: { id: number }) => p.id));
  });
});
