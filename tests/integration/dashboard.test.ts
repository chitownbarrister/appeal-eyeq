// Delivery 4: the dashboard. Real server and Postgres, sample data,
// "today" pinned to 2026-10-19. Checks the figures, that the forecast
// never writes anything, and that one firm's numbers never include another's.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, call, login, startTestEnv, stopTestEnv, type TestEnv } from "./helpers";

let env: TestEnv;
let dillon = "";
let olivia = "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let d: any;

beforeAll(async () => {
  env = await startTestEnv();
  dillon = await login(env.base, "dillon@nicholslaw.example");
  olivia = await login(env.base, "olivia@otherfirm.example");
  d = (await call(env.base, dillon, "GET", "/api/firm/dashboard")).body;
});

afterAll(async () => {
  await stopTestEnv(env);
});

describe("dashboard figures on the sample data", () => {
  it("headline numbers", () => {
    expect(d.today).toBe("2026-10-19");
    expect(d.cycle).toBe(2026);
    // Ready to bill is Billing's figure (nothing billable in the sample: 1044 Tower is no-fee); the two
    // decisions in at estimated savings show as pending until their outcomes are entered.
    expect(d.kpis).toEqual({ unfiled: 5, savingsInPlay: "274084.32", readyToBill: "0.00", decisionsPending: "15060.00", decisionsPendingCount: 2, forecastSixMonths: "94452.00", stalled: 2 });
    expect(d.nextClose).toMatchObject({ label: "Elk Grove", levelShort: "BOR", closes_on: "2026-10-27", days_left: 8, unfiled: 1 });
  });

  it("window watch lists open windows where the firm has properties, soonest close first", () => {
    expect(d.windowWatch.map((w: { label: string; levelShort: string }) => `${w.label} ${w.levelShort}`)).toEqual([
      "Joliet BOR", "Elk Grove BOR", "Northfield PTAB", "Oak Park BOR", "St. Charles BOR", "Geneva BOR", "West Chicago BOR",
    ]);
    expect(d.windowWatch.find((w: { label: string }) => w.label === "Joliet")).toMatchObject({ tagged: 2, unfiled: 0, days_left: 2 });
    expect(d.windowWatch.find((w: { label: string }) => w.label === "West Chicago")).toMatchObject({ open: true, days_left: 29, tagged: 1, unfiled: 1 });
  });

  it("counts by asset type and current level, and the pipeline", () => {
    expect(d.byAssetType).toEqual([{ type: "residential", count: 6 }, { type: "commercial", count: 5 }, { type: "industrial", count: 4 }]);
    expect(d.byLevel).toEqual([{ level: "assessor", count: 2 }, { level: "bor", count: 11 }, { level: "ptab", count: 1 }, { level: "circuit", count: 1 }]);
    const bor = d.pipeline.find((p: { level: string }) => p.level === "bor");
    expect(bor.cells.map((c: { count: number }) => c.count)).toEqual([4, 1, 4, 1, 1, 0]);
    expect(bor.total).toBe(11);
    expect(d.stalled.map((s: { short: string; days: number }) => [s.short, s.days])).toEqual([["820 S. Clinton St.", 19], ["1300 Sheridan Rd.", 24]]);
  });

  it("win rates and average reductions from decided appeals", () => {
    expect(d.winRates.level).toEqual([
      { key: "BOR", decided: 11, won: 8, avgReduction: 6.6 },
      { key: "Assessor", decided: 5, won: 3, avgReduction: 6.4 },
    ]);
    expect(d.winRates.analyst).toEqual([
      { key: "Julie Ramos", decided: 10, won: 5, avgReduction: 7.4 },
      { key: "Sana Khan", decided: 6, won: 6, avgReduction: 5.9 },
    ]);
  });

  it("forecasts Assessor and BOR fees by month, using each property's own fee terms", () => {
    const f = d.forecast;
    expect(f.months.map(({ ids: _ids, ...m }: { ids: number[] }) => m)).toEqual([
      { month: "2026-10", decided: "15060.00", expected: "0.00" },
      { month: "2026-11", decided: "0.00", expected: "0.00" },
      { month: "2026-12", decided: "0.00", expected: "924.00" },
      { month: "2027-01", decided: "0.00", expected: "59332.00" },
      { month: "2027-02", decided: "0.00", expected: "19136.00" },
      { month: "2027-03", decided: "0.00", expected: "0.00" },
    ]);
    const by = (s: string) => f.items.find((i: { short: string }) => i.short === s);
    // Decision in, 40% of estimated savings: 14,900.00 and 22,750.00
    expect(by("1300 Sheridan Rd.")).toMatchObject({ kind: "decided", fee: "5960.00", month: "2026-10" });
    expect(by("820 S. Clinton St.")).toMatchObject({ kind: "decided", fee: "9100.00" });
    // Prairie Crossing's custom 30%: 19,800.00 × 30%, decision 90 days after Joliet's Oct 21 close
    expect(by("2400 Channahon Rd.")).toMatchObject({ kind: "expected", fee: "5940.00", month: "2027-01" });
    // 1044 Tower Road is no fee, PTAB and Circuit Court fees come from the refund check
    expect(by("1044 Tower Road")).toBeUndefined();
    expect(f.noFeeSkipped).toBe(1);
    expect(f.refundLevelOpen).toBe(3);
    expect(f.winRateUsed.assessor).toBeCloseTo(0.6);
    expect(f.likelySixMonths).toBe("72801.81");
  });

  it("analyst workload, reassessment exposure and retention", () => {
    expect(d.workload).toMatchObject([
      { name: "Julie Ramos", open: 8, filedThisCycle: 6, hearings30: 1 },
      { name: "Sana Khan", open: 6, filedThisCycle: 3, hearings30: 1 },
    ]);
    expect(d.reassessment).toMatchObject({
      year: 2027,
      label: "the City of Chicago townships and the collar counties' general reassessment",
      properties: 9,
      townships: ["Algonquin", "Geneva", "Joliet", "Lisle", "Shields", "South Chicago", "St. Charles", "West Chicago"],
    });
    expect(d.retention.carriedOver).toBe(14);
    expect(d.retention.atRisk.map((r: { short: string }) => r.short)).toEqual(["1300 Sheridan Rd.", "512 Dole Ave.", "2550 Channahon Rd."]);
  });
});

describe("links behind the numbers", () => {
  it("carries the exact property ids for each headline number and table cell", async () => {
    const list = (await call(env.base, dillon, "GET", "/api/firm/properties")).body.properties as { id: number; address1: string; unfiled_window_open: boolean }[];
    const idOf = (a: string) => list.find((p) => p.address1 === a)!.id;
    const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
    expect(sorted(d.links.unfiled)).toEqual(sorted(list.filter((p) => p.unfiled_window_open).map((p) => p.id)));
    expect(d.links.readyToBill).toEqual([]);
    expect(d.links.forecastSixMonths).toHaveLength(10);
    const elk = d.windowWatch.find((w: { label: string }) => w.label === "Elk Grove");
    expect(sorted(elk.tagged_ids)).toEqual(sorted([idOf("1700 Busse Rd."), idOf("2200 Pratt Blvd.")]));
    expect(elk.unfiled_ids).toEqual([idOf("1700 Busse Rd.")]);
    const bor = d.pipeline.find((p: { level: string }) => p.level === "bor");
    expect(bor.cells[0].ids).toHaveLength(4);
    expect(bor.ids).toHaveLength(11);
    expect(d.forecast.months.find((m: { month: string }) => m.month === "2027-01").ids).toHaveLength(4);
    const julie = d.workload.find((w: { name: string }) => w.name === "Julie Ramos");
    expect(julie.openIds).toHaveLength(8);
    expect(julie.hearingIds).toEqual([idOf("2550 Channahon Rd.")]);
    expect(d.reassessment.ids).toHaveLength(9);
    expect(d.retention.carriedOverIds).toHaveLength(14);
  });
});

describe("the dashboard only reads", () => {
  it("writes nothing to the audit trail", async () => {
    const before = (await call(env.base, dillon, "GET", "/api/firm/audit-log?limit=500")).body.entries.length;
    await call(env.base, dillon, "GET", "/api/firm/dashboard");
    await call(env.base, dillon, "GET", "/api/firm/dashboard");
    const after = (await call(env.base, dillon, "GET", "/api/firm/audit-log?limit=500")).body.entries.length;
    expect(after).toBe(before);
  });
});

describe("firm isolation", () => {
  it("another firm's dashboard has none of Nichols Law's figures, and its own appeals don't leak in", async () => {
    const o = (await call(env.base, olivia, "GET", "/api/firm/dashboard")).body;
    expect(o.kpis).toEqual({ unfiled: 0, savingsInPlay: "0.00", readyToBill: "0.00", decisionsPending: "0.00", decisionsPendingCount: 0, forecastSixMonths: "0.00", stalled: 0 });
    expect(o.windowWatch).toEqual([]);
    expect(o.winRates.level).toEqual([]);
    expect(o.forecast.items).toEqual([]);
    expect(o.workload).toEqual([]);

    // Other Firm opens a BOR appeal with a large estimate in Elk Grove.
    const geo = (await call(env.base, olivia, "GET", "/api/reference/counties")).body;
    const elk = geo.townships.find((t: { name: string }) => t.name === "Elk Grove").id;
    await call(env.base, olivia, "PATCH", `/api/firm/properties/${env.otherPropertyId}`, { townshipId: elk });
    const a = await call(env.base, olivia, "POST", `/api/firm/properties/${env.otherPropertyId}/appeals`, { assessmentYear: 2026, level: "bor" });
    await call(env.base, olivia, "PATCH", `/api/firm/appeals/${a.body.id}`, { calcOverride: true, manualTaxes: { original: "500000", target: "400000" } });
    const o2 = (await call(env.base, olivia, "GET", "/api/firm/dashboard")).body;
    expect(o2.kpis.unfiled).toBe(1);
    expect(o2.forecast.items).toHaveLength(1);
    expect(o2.forecast.items[0].fee).toBe("40000.00");

    const n = (await call(env.base, dillon, "GET", "/api/firm/dashboard")).body;
    expect(n.kpis).toEqual(d.kpis);
    expect(n.windowWatch.find((w: { label: string }) => w.label === "Elk Grove")).toMatchObject({ tagged: 2, unfiled: 1 });
    expect(n.forecast.items).toHaveLength(d.forecast.items.length);
  });

  it("the super admin can read it only under a grant", async () => {
    const admin = await login(env.base, ADMIN.email, ADMIN.password);
    expect((await call(env.base, admin, "GET", "/api/firm/dashboard")).status).toBe(403);
    const g = await call(env.base, dillon, "POST", "/api/firm/support-grants", { hours: 1 });
    await call(env.base, admin, "POST", `/api/admin/firms/${env.nicholsId}/enter`, {});
    expect((await call(env.base, admin, "GET", "/api/firm/dashboard")).body.kpis.unfiled).toBe(5);
    await call(env.base, dillon, "POST", `/api/firm/support-grants/${g.body.grant.id}/revoke`, {});
    expect((await call(env.base, admin, "GET", "/api/firm/dashboard")).status).toBe(403);
  });
});
