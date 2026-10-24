// Delivery 10e: the customizable Dashboard. Saving, resetting and the firm default (a starting
// point only), the layout check, every module's data on the sample firm, "Your number", and the
// lockouts: another firm's layouts and data, private tasks, and support access.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, call, login, startTestEnv, stopTestEnv, type TestEnv } from "./helpers";
import { BUILT_IN_LAYOUT, MODULE_TYPES, cleanLayout } from "../../shared/dashboard";

let env: TestEnv;
let dillon = "";
let julie = "";
let olivia = "";
let admin = "";
const get = (cookie: string, url: string) => call(env.base, cookie, "GET", url);
const L = "/api/firm/dashboard/layout";

const small = { version: 1, modules: [
  { uid: "deadlines-a1", type: "deadlines", w: 6, h: "m", settings: { scope: "all" } },
  { uid: "kpi-1", type: "customKpi", w: 3, h: "auto", settings: { metric: "savingsAchieved", level: "", group: "", year: "" } },
  { uid: "kpi-2", type: "customKpi", w: 3, h: "auto", settings: { metric: "properties", level: "", group: "commercial", year: "" } },
] };

beforeAll(async () => {
  env = await startTestEnv();
  dillon = await login(env.base, "dillon@nicholslaw.example");
  julie = await login(env.base, "julie@nicholslaw.example");
  olivia = await login(env.base, "olivia@otherfirm.example");
  admin = await login(env.base, ADMIN.email, ADMIN.password);
}, 120000);
afterAll(async () => { await stopTestEnv(env); });

describe("the layout check", () => {
  it("drops unknown modules, repeats and bad sizes, and keeps settings to their choices", () => {
    const l = cleanLayout({ version: 1, modules: [
      { uid: "a", type: "nope", w: 6 },
      { uid: "b", type: "kpis", w: 5, h: "huge" },
      { uid: "c", type: "kpis", w: 12 },
      { uid: "b", type: "tasks", w: 4 },
      { uid: "bad uid!", type: "tasks", w: 4 },
      { uid: "d", type: "tasks", w: 4, settings: { scope: "everyone", extra: "x" } },
      { uid: "e", type: "customKpi", w: 3 }, { uid: "f", type: "customKpi", w: 3, settings: { metric: "collected" } },
    ] })!;
    expect(l.modules.map((m) => m.uid)).toEqual(["b", "d", "e", "f"]);
    expect(l.modules[0]).toEqual({ uid: "b", type: "kpis", w: 12, h: "auto" });
    expect(l.modules[1].settings).toEqual({ scope: "mine" });
    expect(l.modules[3].settings).toMatchObject({ metric: "collected", level: "" });
    expect(cleanLayout("x")).toBeNull();
    expect(cleanLayout({ modules: "x" })).toBeNull();
  });
});

describe("saving, resetting and the firm default", () => {
  it("starts on the built-in Dashboard", async () => {
    const r = await get(julie, L);
    expect(r.status).toBe(200);
    expect(r.body.source).toBe("builtIn");
    expect(r.body.effective).toEqual(BUILT_IN_LAYOUT);
    expect(r.body.canSave).toBe(true);
    expect(r.body.canSetFirmDefault).toBe(false);
    expect((await get(dillon, L)).body.canSetFirmDefault).toBe(true);
  });

  it("saves your own, cleaned, and only you see it", async () => {
    const r = await call(env.base, julie, "PUT", L, { layout: { ...small, modules: [...small.modules, { uid: "x", type: "bogus", w: 4 }] } });
    expect(r.status).toBe(200);
    const g = (await get(julie, L)).body;
    expect(g.source).toBe("mine");
    expect(g.effective.modules.map((m: { uid: string }) => m.uid)).toEqual(["deadlines-a1", "kpi-1", "kpi-2"]);
    expect((await get(dillon, L)).body.source).toBe("builtIn");
    expect((await get(olivia, L)).body.source).toBe("builtIn");
  });

  it("refuses a layout it can't read", async () => {
    expect((await call(env.base, julie, "PUT", L, { layout: { version: 2, modules: [] } })).status).toBe(400);
    expect((await call(env.base, julie, "PUT", L, { nope: 1 })).status).toBe(400);
    expect((await call(env.base, julie, "PUT", L, { layout: { version: 1, modules: Array.from({ length: 41 }, (_, i) => ({ uid: `k${i}`, type: "customKpi", w: 3 })) } })).status).toBe(400);
  });

  it("only a firm admin sets the firm default, and it's a starting point", async () => {
    const firmLayout = { version: 1, modules: [{ uid: "tasks", type: "tasks", w: 6, h: "auto", settings: { scope: "all" } }, { uid: "kpis", type: "kpis", w: 12, h: "auto" }] };
    expect((await call(env.base, julie, "PUT", `${L}/firm`, { layout: firmLayout })).status).toBe(403);
    expect((await call(env.base, dillon, "PUT", `${L}/firm`, { layout: firmLayout })).status).toBe(200);
    // Dillon hasn't arranged his own: he sees the firm default. Julie keeps hers.
    const d = (await get(dillon, L)).body;
    expect(d.source).toBe("firm");
    expect(d.effective.modules.map((m: { type: string }) => m.type)).toEqual(["tasks", "kpis"]);
    expect((await get(julie, L)).body.source).toBe("mine");
    // Julie resets: back to the firm default, not the built-in one.
    expect((await call(env.base, julie, "DELETE", L)).status).toBe(200);
    const j = (await get(julie, L)).body;
    expect(j.source).toBe("firm");
    expect(j.mine).toBeNull();
    // Julie changes her own freely.
    expect((await call(env.base, julie, "PUT", L, { layout: small })).status).toBe(200);
    expect((await get(julie, L)).body.source).toBe("mine");
    // The other firm doesn't see it.
    expect((await get(olivia, L)).body.firm).toBeNull();
  });

  it("clearing the firm default sends people back to the built-in Dashboard", async () => {
    expect((await call(env.base, julie, "DELETE", `${L}/firm`)).status).toBe(403);
    expect((await call(env.base, dillon, "DELETE", `${L}/firm`)).status).toBe(200);
    expect((await get(dillon, L)).body.source).toBe("builtIn");
    expect((await get(julie, L)).body.source).toBe("mine");
  });

  it("another firm's admin can't touch this firm's layouts", async () => {
    expect((await call(env.base, olivia, "PUT", `${L}/firm`, { layout: small })).status).toBe(200); // their own firm
    expect((await get(olivia, L)).body.source).toBe("firm");
    expect((await get(dillon, L)).body.source).toBe("builtIn");
    expect((await get(dillon, L)).body.firm).toBeNull();
    expect((await call(env.base, olivia, "DELETE", L)).status).toBe(200);
    expect((await get(julie, L)).body.source).toBe("mine"); // Julie's survives Olivia's reset
    await call(env.base, olivia, "DELETE", `${L}/firm`);
  });
});

describe("support access", () => {
  it("reads the firm's Dashboard but can't save, reset or set a default, and sees no letters or imports", async () => {
    await call(env.base, dillon, "POST", "/api/firm/support-grants", { hours: 2, reason: "Checking the Dashboard" });
    await call(env.base, admin, "POST", `/api/admin/firms/${env.nicholsId}/enter`, {});
    const r = await get(admin, L);
    expect(r.status).toBe(200);
    expect(r.body.canSave).toBe(false);
    expect(r.body.canSetFirmDefault).toBe(false);
    expect(r.body.mine).toBeNull();
    expect((await call(env.base, admin, "PUT", L, { layout: small })).status).toBe(403);
    expect((await call(env.base, admin, "DELETE", L)).status).toBe(403);
    expect((await call(env.base, admin, "PUT", `${L}/firm`, { layout: small })).status).toBe(403);
    expect((await get(admin, "/api/firm/dashboard/m/decisions")).body).toEqual({ hidden: true });
    expect((await get(admin, "/api/firm/dashboard/m/imports")).body).toEqual({ hidden: true });
    expect((await get(admin, "/api/firm/dashboard/m/deadlines?scope=all")).status).toBe(200);
    expect((await get(julie, L)).body.source).toBe("mine"); // nothing changed
  });
});

describe("module data", () => {
  it("every module answers with the sample firm's data", async () => {
    for (const t of MODULE_TYPES) {
      const r = await get(dillon, `/api/firm/dashboard/m/${t}`);
      if (["kpis", "windowWatch", "byAssetType", "byLevel", "pipeline", "forecast", "winRates", "workload", "reassessment", "retention", "customKpi"].includes(t)) {
        expect(r.status, t).toBe(404); // drawn from /firm/dashboard or /firm/dashboard/kpi
      } else {
        expect(r.status, `${t}: ${JSON.stringify(r.body)}`).toBe(200);
      }
    }
    expect((await get(dillon, "/api/firm/dashboard/m/nothing")).status).toBe(404);
  });

  it("the money modules show two decimals and add up", async () => {
    const aging = (await get(dillon, "/api/firm/dashboard/m/aging")).body;
    expect(aging.buckets.map((b: { key: string }) => b.key)).toEqual(["current", "d30", "d60", "d90", "over"]);
    const total = aging.buckets.reduce((a: number, b: { total: string }) => a + Math.round(Number(b.total) * 100), 0);
    expect(total).toBe(Math.round(Number(aging.total) * 100));
    expect(aging.total).toMatch(/^\d+\.\d\d$/);
    const coll = (await get(dillon, "/api/firm/dashboard/m/collected")).body;
    expect(coll.year).toMatch(/^\d+\.\d\d$/);
    expect(coll.months.length).toBeGreaterThan(0);
    const rtb = (await get(dillon, "/api/firm/dashboard/m/readyToBill")).body;
    expect(rtb.total).toMatch(/^\d+\.\d\d$/);
  });

  it("savings by year match the Dashboard's savings achieved", async () => {
    const byYear = (await get(dillon, "/api/firm/dashboard/m/savingsByYear")).body.years as { savings: string }[];
    const summary = (await get(dillon, "/api/firm/summary")).body;
    const sum = byYear.reduce((a, y) => a + Math.round(Number(y.savings) * 100), 0);
    expect(sum).toBe(Math.round(Number(summary.savingsAchieved) * 100));
  });

  it("recent properties, top clients and co-counsel come from this firm only", async () => {
    const recent = (await get(dillon, "/api/firm/dashboard/m/recentProperties")).body.items as { id: number }[];
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.some((p) => p.id === env.otherPropertyId)).toBe(false);
    const top = (await get(dillon, "/api/firm/dashboard/m/topClients?year=all")).body.items as { accountId: number }[];
    expect(top.some((c) => c.accountId === env.otherAccountId)).toBe(false);
    const theirs = (await get(olivia, "/api/firm/dashboard/m/recentProperties")).body.items as { id: number }[];
    expect(theirs.every((p) => p.id === env.otherPropertyId || !recent.some((x) => x.id === p.id))).toBe(true);
  });

  it("someone else's private task never shows, even under Everyone's", async () => {
    const props = (await get(dillon, "/api/firm/properties")).body.properties as { id: number }[];
    const made = await call(env.base, julie, "POST", "/api/firm/activities", { kind: "task", subject: "Julie private dashboard task", dueOn: "2026-10-22", isPrivate: true });
    const pub = await call(env.base, julie, "POST", "/api/firm/activities", { kind: "task", subject: "Julie shared dashboard task", dueOn: "2026-10-22", propertyId: props[0].id });
    expect(made.status).toBe(201);
    expect(pub.status).toBe(201);
    const dAll = (await get(dillon, "/api/firm/dashboard/m/tasks?scope=all")).body.items as { subject: string }[];
    expect(dAll.some((t) => t.subject === "Julie shared dashboard task")).toBe(true);
    expect(dAll.some((t) => t.subject === "Julie private dashboard task")).toBe(false);
    const jMine = (await get(julie, "/api/firm/dashboard/m/tasks?scope=mine")).body.items as { subject: string }[];
    expect(jMine.some((t) => t.subject === "Julie private dashboard task")).toBe(true);
    const oAll = (await get(olivia, "/api/firm/dashboard/m/tasks?scope=all")).body.items as { subject: string }[];
    expect(oAll.some((t) => t.subject.startsWith("Julie"))).toBe(false);
  });

  it("the week runs Monday to Sunday", async () => {
    const w = (await get(dillon, "/api/firm/dashboard/m/week?scope=all")).body;
    expect(w.days).toHaveLength(7);
    expect(new Date(`${w.days[0].day}T12:00:00Z`).getUTCDay()).toBe(1);
  });
});

describe("Your number", () => {
  it("counts, totals and narrows", async () => {
    const all = (await get(dillon, "/api/firm/dashboard/kpi?metric=properties")).body;
    expect(all.format).toBe("count");
    expect(Number(all.value)).toBe(all.ids.length);
    const com = (await get(dillon, "/api/firm/dashboard/kpi?metric=properties&group=commercial")).body;
    expect(Number(com.value)).toBeLessThanOrEqual(Number(all.value));
    const sav = (await get(dillon, "/api/firm/dashboard/kpi?metric=savingsAchieved")).body;
    expect(sav.format).toBe("money");
    expect(sav.value).toMatch(/^\d+\.\d\d$/);
    expect(Number(sav.value)).toBeCloseTo(Number((await get(dillon, "/api/firm/summary")).body.savingsAchieved), 2);
    for (const metric of ["appeals", "savingsInPlay", "feesBilled", "collected"]) {
      for (const year of ["", "current", "last"]) {
        const r = await get(dillon, `/api/firm/dashboard/kpi?metric=${metric}&year=${year}&level=bor`);
        expect(r.status, `${metric} ${year}`).toBe(200);
      }
    }
    // Unknown choices fall back to the defaults rather than reaching SQL.
    const odd = await get(dillon, "/api/firm/dashboard/kpi?metric=drop%20table&level=x'&group=y");
    expect(odd.status).toBe(200);
    expect(odd.body.metric).toBe("properties");
  });

  it("another firm's figures are its own", async () => {
    const mine = (await get(dillon, "/api/firm/dashboard/kpi?metric=properties")).body;
    const theirs = (await get(olivia, "/api/firm/dashboard/kpi?metric=properties")).body;
    expect(theirs.ids).not.toEqual(mine.ids);
    expect(theirs.ids.some((id: number) => mine.ids.includes(id))).toBe(false);
  });
});
