// Delivery 7: several PINs per appeal (land, building, AV, FMV), dividing an agreed
// total the firm's way, the offer trail, locked stipulations, PTAB rollover within a
// reassessment cycle, pending PTAB flags, and cross-firm lockouts. Real server and Postgres.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, login, startTestEnv, stopTestEnv, type TestEnv } from "./helpers";

let env: TestEnv;
let dillon = "";
let julie = "";
let olivia = "";
let threePinId = 0;
let threeAppealId = 0;
let parcels: { id: number; pin: string }[] = [];

const values = (cookie: string, id: number) => call(env.base, cookie, "GET", `/api/firm/appeals/${id}/values`);
const putPins = (cookie: string, id: number, pins: unknown[]) => call(env.base, cookie, "PUT", `/api/firm/appeals/${id}/pins`, { pins });

beforeAll(async () => {
  env = await startTestEnv();
  dillon = await login(env.base, "dillon@nicholslaw.example");
  julie = await login(env.base, "julie@nicholslaw.example");
  olivia = await login(env.base, "olivia@otherfirm.example");
});
afterAll(async () => { await stopTestEnv(env); });

describe("the sample data", () => {
  it("keeps every firm figure the same, with 1415 W. Grand Ave. as a three-PIN property", async () => {
    expect((await call(env.base, dillon, "GET", "/api/firm/summary")).body).toMatchObject({ savingsAchieved: "2290.20", savingsInPlay: "274084.32" });
    const list = (await call(env.base, dillon, "GET", "/api/firm/properties")).body.properties;
    const grand = list.find((p: { address1: string }) => p.address1 === "1415 W. Grand Ave.");
    const d = (await call(env.base, dillon, "GET", `/api/firm/properties/${grand.id}`)).body;
    expect(d.parcels.map((p: { pin: string }) => p.pin)).toEqual(["17-08-101-022-0000", "17-08-101-023-0000", "17-08-101-024-0000"]);
    const v = (await values(dillon, d.appeals[0].id)).body;
    expect(v.pinMode).toBe(true);
    expect(v.totals.original).toMatchObject({ av: "412500.00", fmv: "1650000.00" });
    expect(v.pins.map((p: { original: { land: string; impr: string; av: string } }) => p.original)).toEqual([
      { land: "61875.00", impr: "268125.00", av: "330000.00" },
      { land: "20625.00", impr: "41250.00", av: "61875.00" },
      { land: "20625.00", impr: "0.00", av: "20625.00" },
    ]);
    expect(v.totals.target.av).toBe(d.appeals[0].target_av);
  });
});

describe("several PINs on one appeal", () => {
  it("builds Dillon's three-PIN example: land and building per PIN, totals and FMV to the penny", async () => {
    const geo = (await call(env.base, dillon, "GET", "/api/reference/counties")).body;
    const cook = geo.counties.find((c: { name: string }) => c.name === "Cook");
    const elk = geo.townships.find((t: { name: string }) => t.name === "Elk Grove");
    const r = await call(env.base, dillon, "POST", "/api/firm/properties", {
      newAccount: { name: "Busse Industrial LLC", accountType: "entity" }, address1: "2200 Busse Rd.", city: "Elk Grove Village",
      countyId: cook.id, townshipId: elk.id, assetType: "industrial", pin: "08-35-301-012-0000", firstAppeal: { assessmentYear: 2026, level: "bor" },
    });
    expect(r.status).toBe(201);
    threePinId = r.body.id;
    for (const pin of ["08-35-301-013-0000", "08-35-301-014-0000"]) {
      expect((await call(env.base, dillon, "POST", `/api/firm/properties/${threePinId}/parcels`, { pin })).status).toBe(201);
    }
    const d = (await call(env.base, dillon, "GET", `/api/firm/properties/${threePinId}`)).body;
    threeAppealId = d.appeals[0].id;
    parcels = d.parcels;
    const v0 = (await values(dillon, threeAppealId)).body;
    expect(v0.pins).toHaveLength(3);
    expect(v0.pins.map((p: { onAppeal: boolean }) => p.onAppeal)).toEqual([true, false, false]); // PINs added later start off the appeal
    const pins = [
      { parcelId: parcels[0].id, onAppeal: true, original: { land: "19270", impr: "81270" } },
      { parcelId: parcels[1].id, onAppeal: true, original: { land: "1872", impr: "1000" } },
      { parcelId: parcels[2].id, onAppeal: true, original: { land: "1872", impr: "1000" } },
    ];
    const v = (await putPins(dillon, threeAppealId, pins)).body;
    expect(v.pins.map((p: { original: { av: string } }) => p.original.av)).toEqual(["100540.00", "2872.00", "2872.00"]);
    expect(v.totals.original).toMatchObject({ land: "23014.00", impr: "83270.00", av: "106284.00", fmv: "425136.00" });
    const a = (await call(env.base, dillon, "GET", `/api/firm/appeals/${threeAppealId}`)).body.appeal;
    expect(a).toMatchObject({ orig_av: "106284.00", orig_land_av: "23014.00", orig_impr_av: "83270.00" });
  });

  it("divides an agreed market value among the PINs the firm's way: land held, building takes the cut", async () => {
    const r = await call(env.base, dillon, "POST", `/api/firm/appeals/${threeAppealId}/split`, { stage: "resolved", fmv: "369868.32" });
    expect(r.status).toBe(200);
    expect(r.body.pins.map((p: { resolved: unknown }) => p.resolved)).toEqual([
      { land: "19270.00", impr: "68199.80", av: "87469.80" },
      { land: "1872.00", impr: "626.64", av: "2498.64" },
      { land: "1872.00", impr: "626.64", av: "2498.64" },
    ]);
    expect(r.body.totals.resolved).toMatchObject({ av: "92467.08", fmv: "369868.32" });
    expect((await call(env.base, dillon, "POST", `/api/firm/appeals/${threeAppealId}/split`, { stage: "target", totalAv: "85027.20" })).body.totals.target.av).toBe("85027.20");
    const v = (await values(dillon, threeAppealId)).body;
    expect(v.requestedAchieved).toBe("65.0%"); // 13,816.92 of 21,256.80
  });

  it("keeps a PIN that isn't on the appeal at its original value in the property total", async () => {
    const v = (await putPins(dillon, threeAppealId, [{ parcelId: parcels[2].id, onAppeal: false }])).body;
    expect(v.pins[2].resolved).toEqual({ land: "1872.00", impr: "1000.00", av: "2872.00" });
    expect(v.totals.resolved.av).toBe("92840.44"); // 87,469.80 + 2,498.64 + 2,872.00
    expect(v.totals.onAppeal.resolved).toBe("89968.44");
    await putPins(dillon, threeAppealId, [{ parcelId: parcels[2].id, onAppeal: true }]);
  });

  it("puts an AV typed on its own onto the building, keeping the land", async () => {
    const v = (await putPins(dillon, threeAppealId, [{ parcelId: parcels[0].id, target: { av: "80000" } }])).body;
    expect(v.pins[0].target).toEqual({ land: "19270.00", impr: "60730.00", av: "80000.00" });
    expect(v.targetSource).toBe("manual");
  });

  it("refuses property totals typed straight onto a multi-PIN appeal, and keeps a one-PIN appeal's PIN in step", async () => {
    const r = await call(env.base, dillon, "PATCH", `/api/firm/appeals/${threeAppealId}`, { target: { total: "90000" } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/several PINs/);
    const tower = (await call(env.base, dillon, "GET", "/api/firm/properties")).body.properties.find((p: { address1: string }) => p.address1 === "1044 Tower Road");
    const t = (await call(env.base, dillon, "GET", `/api/firm/properties/${tower.id}`)).body;
    const bor = t.appeals.find((a: { assessment_year: number; level: string }) => a.assessment_year === 2026 && a.level === "bor");
    await call(env.base, dillon, "PATCH", `/api/firm/appeals/${bor.id}`, { target: { land: "20250", impr: "40000" } });
    expect((await values(dillon, bor.id)).body.pins[0].target).toEqual({ land: "20250.00", impr: "40000.00", av: "60250.00" });
    await call(env.base, dillon, "PATCH", `/api/firm/appeals/${bor.id}`, { target: { land: null, impr: null, total: "62800" } });
  });

  it("refuses to delete a PIN that still has values", async () => {
    const r = await call(env.base, dillon, "DELETE", `/api/firm/parcels/${parcels[2].id}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/has values for this PIN/);
  });
});

describe("the offer trail", () => {
  it("records every round, divides each across the PINs, and shows the latest from each side", async () => {
    const firm = await call(env.base, dillon, "POST", `/api/firm/appeals/${threeAppealId}/offers`, { offeredOn: "2026-06-02", party: "firm", fmv: "350000", note: "Opening offer" });
    expect(firm.status).toBe(201);
    await call(env.base, dillon, "POST", `/api/firm/appeals/${threeAppealId}/offers`, { offeredOn: "2026-06-20", party: "board_of_review", totalAv: "97000" });
    const v = (await call(env.base, dillon, "POST", `/api/firm/appeals/${threeAppealId}/offers`, { offeredOn: "2026-07-08", party: "firm", fmv: "365375" })).body;
    expect(v.offers).toHaveLength(3);
    expect(v.offers[0]).toMatchObject({ party: "firm", total_av: "87500.00", fmv: "350000.00", note: "Opening offer", created_by_name: "Dillon Nichols" });
    expect(v.latestOffers.firm).toMatchObject({ total_av: "91343.75" }); // 365,375 x 25%
    expect(v.latestOffers.other).toMatchObject({ party: "board_of_review", total_av: "97000.00" });
    const sum = v.latestOffers.firm.pins.reduce((acc: number, p: { av: string }) => acc + Math.round(Number(p.av) * 100), 0);
    expect(sum).toBe(9134375);
    expect(v.latestOffers.firm.pins[1]).toMatchObject({ land: "1872.00" });
  });

  it("uses an agreed offer as the resolved values, and deletes an offer", async () => {
    const agreed = (await call(env.base, dillon, "POST", `/api/firm/appeals/${threeAppealId}/offers`, { offeredOn: "2026-08-05", party: "agreed", totalAv: "92467.08" })).body;
    const id = agreed.offers.at(-1).id;
    const used = (await call(env.base, dillon, "POST", `/api/firm/appeals/${threeAppealId}/offers/${id}/use`, { stage: "resolved" })).body;
    expect(used.pins[0].resolved).toEqual({ land: "19270.00", impr: "68199.80", av: "87469.80" });
    expect((await call(env.base, dillon, "DELETE", `/api/firm/appeals/${threeAppealId}/offers/${agreed.offers[0].id}`)).body.offers).toHaveLength(3);
    expect((await call(env.base, dillon, "POST", `/api/firm/appeals/${threeAppealId}/offers`, { offeredOn: "2026-08-05", party: "firm" })).status).toBe(400);
    expect((await call(env.base, dillon, "POST", `/api/firm/appeals/${threeAppealId}/offers`, { offeredOn: "2026-08-05", party: "landlord", totalAv: "1" })).status).toBe(400);
  });
});

describe("locked stipulations", () => {
  it("freezes the resolved PIN values until unlocked", async () => {
    const locked = (await call(env.base, dillon, "POST", `/api/firm/appeals/${threeAppealId}/stipulation`, { lock: true })).body;
    expect(locked.stipulation).toMatchObject({ lockedBy: "Dillon Nichols" });
    expect((await putPins(dillon, threeAppealId, [{ parcelId: parcels[0].id, resolved: { av: "1" } }])).status).toBe(409);
    expect((await call(env.base, dillon, "POST", `/api/firm/appeals/${threeAppealId}/split`, { stage: "resolved", totalAv: "1" })).status).toBe(409);
    expect((await putPins(dillon, threeAppealId, [{ parcelId: parcels[0].id, target: { av: "81000" } }])).status).toBe(200); // the target can still move
    expect((await call(env.base, dillon, "POST", `/api/firm/appeals/${threeAppealId}/stipulation`, { lock: false })).body.stipulation).toBeNull();
  });

  it("won't lock until every PIN on the appeal has its resolved value", async () => {
    await putPins(dillon, threeAppealId, [{ parcelId: parcels[1].id, resolved: { land: null, impr: null, av: null } }]);
    expect((await call(env.base, dillon, "POST", `/api/firm/appeals/${threeAppealId}/stipulation`, { lock: true })).status).toBe(400);
  });
});

describe("PTAB rollover and pending PTABs", () => {
  let towerId = 0;
  let ptab2025 = 0;
  let bor2026 = 0;

  it("flags a pending PTAB on the property, with its docket number", async () => {
    towerId = (await call(env.base, dillon, "GET", "/api/firm/properties")).body.properties.find((p: { address1: string }) => p.address1 === "1044 Tower Road").id;
    const r = await call(env.base, dillon, "POST", `/api/firm/properties/${towerId}/appeals`, { assessmentYear: 2025, level: "ptab" });
    ptab2025 = r.body.id;
    await call(env.base, dillon, "PATCH", `/api/firm/appeals/${ptab2025}`, { petitionNo: "2025-004417.001-R-1", status: "waiting_decision" });
    const d = (await call(env.base, dillon, "GET", `/api/firm/properties/${towerId}`)).body;
    expect(d.pendingPtab).toEqual([{ appealId: ptab2025, year: 2025, docket: "2025-004417.001-R-1" }]);
    bor2026 = d.appeals.find((a: { assessment_year: number; level: string }) => a.assessment_year === 2026 && a.level === "bor").id;
    const row = (await call(env.base, dillon, "GET", "/api/firm/properties")).body.properties.find((p: { id: number }) => p.id === towerId);
    expect(row.pending_ptab_years).toEqual([2025]);
  });

  it("offers a same-cycle PTAB decision as the target when the target was already set, and fills it when asked", async () => {
    // New Trier (North) was reassessed in 2025, so 2025 and 2026 are one cycle.
    await putPins(dillon, ptab2025, [{ parcelId: (await values(dillon, ptab2025)).body.pins[0].parcelId, resolved: { land: "20250", impr: "38000" } }]);
    await call(env.base, dillon, "PATCH", `/api/firm/appeals/${ptab2025}`, { status: "reduced", decisionOn: "2026-09-30" });
    const v = (await values(dillon, bor2026)).body;
    expect(v.targetSource).not.toBe("rollover"); // its target was entered before, so it isn't overwritten
    expect(v.rolloverSuggestion).toEqual({ appealId: ptab2025, year: 2025, totalAv: "58250.00" });
    const took = (await call(env.base, dillon, "POST", `/api/firm/appeals/${bor2026}/rollover`, {})).body;
    expect(took.targetSource).toBe("rollover");
    expect(took.totals.target.av).toBe("58250.00");
    expect(took.rollover).toMatchObject({ appealId: ptab2025, year: 2025, cycle: { start: 2025, end: 2027 } });
    expect(took.rolloverSuggestion).toBeNull();
    expect((await call(env.base, dillon, "GET", `/api/firm/properties/${towerId}`)).body.pendingPtab).toEqual([]);
  });

  it("fills an empty target on its own, and updates rolled-over targets when the PTAB result changes", async () => {
    const r = await call(env.base, dillon, "POST", `/api/firm/properties/${towerId}/appeals`, { assessmentYear: 2027, level: "assessor" });
    const v = (await values(dillon, r.body.id)).body;
    expect(v).toMatchObject({ targetSource: "rollover", rollover: { year: 2025 } });
    expect(v.totals.target.av).toBe("58250.00");
    await putPins(dillon, ptab2025, [{ parcelId: v.pins[0].parcelId, resolved: { land: "20250", impr: "37000" } }]);
    expect((await values(dillon, r.body.id)).body.totals.target.av).toBe("57250.00");
    expect((await values(dillon, bor2026)).body.totals.target.av).toBe("57250.00");
    // Typing a target by hand takes it out of the rollover.
    await putPins(dillon, r.body.id, [{ parcelId: v.pins[0].parcelId, target: { av: "56000" } }]);
    await putPins(dillon, ptab2025, [{ parcelId: v.pins[0].parcelId, resolved: { land: "20250", impr: "36000" } }]);
    expect((await values(dillon, r.body.id)).body).toMatchObject({ targetSource: "manual", totals: { target: { av: "56000.00" } } });
  });

  it("doesn't roll a PTAB decision into another reassessment cycle", async () => {
    const r = await call(env.base, dillon, "POST", `/api/firm/properties/${towerId}/appeals`, { assessmentYear: 2028, level: "assessor" });
    const v = (await values(dillon, r.body.id)).body;
    expect(v.targetSource).toBeNull();
    expect(v.rolloverSuggestion).toBeNull();
    expect((await call(env.base, dillon, "POST", `/api/firm/appeals/${r.body.id}/rollover`, {})).status).toBe(409);
  });

  it("lets a deleted PTAB go without breaking the appeals that rolled from it", async () => {
    expect((await call(env.base, dillon, "DELETE", `/api/firm/appeals/${ptab2025}`)).status).toBe(200);
    const v = (await values(dillon, bor2026)).body;
    expect(v.totals.target.av).toBe("56250.00"); // the last rolled-over value is kept
    expect(v.rollover).toBeNull();
  });
});

describe("lockouts", () => {
  it("keeps another firm and read-only roles out", async () => {
    expect((await values(olivia, threeAppealId)).status).toBe(404);
    expect((await putPins(olivia, threeAppealId, [{ parcelId: parcels[0].id, onAppeal: false }])).status).toBe(404);
    expect((await call(env.base, olivia, "POST", `/api/firm/appeals/${threeAppealId}/offers`, { offeredOn: "2026-01-01", party: "firm", totalAv: "1" })).status).toBe(404);
    expect((await call(env.base, olivia, "POST", `/api/firm/appeals/${threeAppealId}/stipulation`, { lock: true })).status).toBe(404);
    // Another firm's parcel can't be written onto this appeal.
    const other = (await call(env.base, olivia, "GET", `/api/firm/properties/${env.otherPropertyId}`)).body.parcels[0].id;
    expect((await putPins(dillon, threeAppealId, [{ parcelId: other, onAppeal: true }])).status).toBe(400);
    // Julie can read; with appeals.edit switched off for analysts, she can't write.
    expect((await values(julie, threeAppealId)).status).toBe(200);
    await call(env.base, dillon, "PUT", "/api/firm/permissions", { role: "analyst", permission: "appeals.edit", allowed: false });
    expect((await putPins(julie, threeAppealId, [{ parcelId: parcels[0].id, target: { av: "1" } }])).status).toBe(403);
    await call(env.base, dillon, "PUT", "/api/firm/permissions", { role: "analyst", permission: "appeals.edit", allowed: true });
  });
});
