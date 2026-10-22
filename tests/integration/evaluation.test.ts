// Delivery 10b: the property's Evaluation (three years and the full history), the Excel export
// with live formulas whose results match the app, land and rentable square feet, and co-counsel
// on the property (fee permission, saved as a set, share and net fee). With cross-firm attacks.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { ADMIN, call, login, startTestEnv, stopTestEnv, type TestEnv } from "./helpers";
import { feeAmount, netTax } from "../../shared/money";

let env: TestEnv;
let dillon = "";
let julie = "";
let olivia = "";
let admin = "";
let tower = 0;

const get = (cookie: string, url: string) => call(env.base, cookie, "GET", url);
const patch = (cookie: string, url: string, body: unknown) => call(env.base, cookie, "PATCH", url, body);
async function xlsx(cookie: string, url: string) {
  const res = await fetch(`${env.base}${url}`, { headers: { Cookie: cookie } });
  return { res, buf: res.ok ? Buffer.from(await res.arrayBuffer()) : null };
}

beforeAll(async () => {
  env = await startTestEnv();
  dillon = await login(env.base, "dillon@nicholslaw.example");
  julie = await login(env.base, "julie@nicholslaw.example");
  olivia = await login(env.base, "olivia@otherfirm.example");
  admin = await login(env.base, ADMIN.email, ADMIN.password);
  tower = (await get(dillon, "/api/firm/properties")).body.properties.find((p: { address1: string }) => p.address1 === "1044 Tower Road").id;
}, 120000);

afterAll(async () => { await stopTestEnv(env); });

describe("the evaluation", () => {
  it("shows the facts and the three most recent years, with the app's own tax math", async () => {
    const r = await get(dillon, `/api/firm/properties/${tower}/evaluation`);
    expect(r.status).toBe(200);
    const ev = r.body;
    expect(ev.property).toMatchObject({ client: "Nichols, Dillon", county: "Cook", township: "New Trier", buildingSqft: 1672, landSqft: 7501, landSqftFromAcreage: true, landToBuilding: "4.49", yearBuilt: 1915, age: 111, purchasePrice: "628000.00" });
    expect(ev.recent).toEqual([2024, 2025, 2026]);
    const y2025 = ev.years.find((y: { assessmentYear: number }) => y.assessmentYear === 2025);
    // The 2025 Board of Review reduction: $1,736.12, the same figure as the property page.
    expect(y2025).toMatchObject({ levelReached: "bor", decided: true, avIn: "70000.00", total: "62800.00", land: "20250.00", impr: "42550.00", fmv: "628000.00", savings: "1736.12", noFee: true, fee: "0.00" });
    expect(y2025.tax).toBe(netTax("62800", y2025.equalizer, y2025.ratePercent));
    expect(y2025.taxBefore).toBe(netTax("70000", y2025.equalizer, y2025.ratePercent));
    const page = (await get(dillon, `/api/firm/properties/${tower}`)).body;
    const bor = page.appeals.find((a: { assessment_year: number; level: string }) => a.assessment_year === 2025 && a.level === "bor");
    expect(bor.savings).toBe("1736.12");
    expect(y2025.pins).toHaveLength(1);
    expect(y2025.pins[0]).toMatchObject({ land: "20250.00", impr: "42550.00", total: "62800.00" });
  });

  it("saves land and rentable square feet with the usual edit permission", async () => {
    expect((await patch(julie, `/api/firm/properties/${tower}`, { landSqft: 7600, rentableSqft: 1500 })).status).toBe(200);
    const ev = (await get(dillon, `/api/firm/properties/${tower}/evaluation`)).body;
    expect(ev.property).toMatchObject({ landSqft: 7600, landSqftFromAcreage: false, rentableSqft: 1500, landToBuilding: "4.55" });
    expect((await patch(dillon, `/api/firm/properties/${tower}`, { landSqft: -1 })).status).toBe(400);
    await patch(dillon, `/api/firm/properties/${tower}`, { landSqft: null, rentableSqft: null });
  });
});

describe("co-counsel on the property", () => {
  let id = 0;
  let fee = "";
  it("is saved as a set, and needs the fee permission", async () => {
    // A property with a fee: a decided 2026 BOR reduction in tax code 23008.
    const geo = (await get(dillon, "/api/reference/counties")).body;
    const cook = geo.counties.find((c: { name: string }) => c.name === "Cook").id;
    const nt = geo.townships.find((t: { name: string }) => t.name === "New Trier").id;
    const p = await call(env.base, dillon, "POST", "/api/firm/properties", {
      newAccount: { name: "Cocounsel, Cara", accountType: "individual" }, address1: "9 Shared Way", city: "Winnetka", countyId: cook, townshipId: nt, taxCode: "23008",
      assetType: "commercial", pin: "05-17-398-009-0000", firstAppeal: { assessmentYear: 2026, level: "bor" },
    });
    id = p.body.id;
    const a = (await get(dillon, `/api/firm/properties/${id}`)).body.appeals[0];
    await patch(dillon, `/api/firm/appeals/${a.id}`, { original: { total: "100000" }, target: { total: "88000" } });
    await patch(dillon, `/api/firm/appeals/${a.id}`, { resolved: { total: "90000" }, status: "reduced", substage: "decision_analysis" });

    const { withContext } = await import("../../server/db");
    await withContext({ actorKind: "system", userId: null, firmId: env.nicholsId }, (c) =>
      c.query(`UPDATE role_permissions SET allowed = false WHERE firm_id = $1 AND role = 'analyst' AND permission = 'fees.edit'`, [env.nicholsId]));
    expect((await patch(julie, `/api/firm/properties/${id}`, { coCounselFirm: "Ridge Law", coCounselRole: "relationship", coCounselPercent: "25" })).status).toBe(403);
    await withContext({ actorKind: "system", userId: null, firmId: env.nicholsId }, (c) =>
      c.query(`UPDATE role_permissions SET allowed = true WHERE firm_id = $1 AND role = 'analyst' AND permission = 'fees.edit'`, [env.nicholsId]));

    expect((await patch(dillon, `/api/firm/properties/${id}`, { coCounselFirm: "Ridge Law" })).body.error).toContain("relationship firm or the handling firm");
    expect((await patch(dillon, `/api/firm/properties/${id}`, { coCounselPercent: "25" })).status).toBe(400);
    expect((await patch(dillon, `/api/firm/properties/${id}`, { coCounselFirm: "Ridge Law", coCounselRole: "relationship", coCounselPercent: "125" })).status).toBe(400);
    expect((await patch(dillon, `/api/firm/properties/${id}`, { coCounselFirm: "Ridge Law", coCounselRole: "relationship", coCounselPercent: "25", coCounselBills: "us" })).status).toBe(200);
  });

  it("splits the fee: co-counsel's share and our net fee, and tags the client", async () => {
    const ev = (await get(dillon, `/api/firm/properties/${id}/evaluation`)).body;
    expect(ev.property.coCounsel).toEqual({ firm: "Ridge Law", role: "relationship", percent: "25.00", bills: "us" });
    const y = ev.years[0];
    fee = feeAmount(y.savings, "40.00");
    expect(y.fee).toBe(fee);
    expect(y.coCounselShare).toBe(feeAmount(fee, "25"));
    expect(Number(y.netFee)).toBeCloseTo(Number(fee) - Number(y.coCounselShare), 2);
    const acct = (await get(dillon, `/api/firm/properties/${id}`)).body.property.account_id;
    const client = (await get(dillon, `/api/firm/accounts/${acct}`)).body;
    expect(client.properties[0]).toMatchObject({ co_counsel_firm: "Ridge Law", co_counsel_role: "relationship" });
  });

  it("uses the invoiced fee once there is one", async () => {
    const y0 = (await get(dillon, `/api/firm/properties/${id}/evaluation`)).body.years[0];
    const appealId = (await get(dillon, `/api/firm/properties/${id}`)).body.appeals[0].id;
    const inv = (await call(env.base, dillon, "POST", `/api/firm/billing/appeals/${appealId}/invoice`, {})).body;
    const fl = inv.lines.find((l: { kind: string }) => l.kind === "fee");
    await patch(dillon, `/api/firm/billing/invoices/${inv.id}`, { lines: [{ id: fl.id, description: fl.description, amount: "1000.00" }] });
    // A draft isn't invoiced yet.
    expect((await get(dillon, `/api/firm/properties/${id}/evaluation`)).body.years[0].invoiced).toBeNull();
    await call(env.base, dillon, "POST", `/api/firm/billing/invoices/${inv.id}/send`, { to: [], email: false });
    const y = (await get(dillon, `/api/firm/properties/${id}/evaluation`)).body.years[0];
    expect(y).toMatchObject({ fee: y0.fee, invoiced: "1000.00", coCounselShare: "250.00", netFee: "750.00" });
  });

  it("clears as a set", async () => {
    expect((await patch(dillon, `/api/firm/properties/${id}`, { coCounselFirm: null, coCounselPercent: "10" })).status).toBe(400);
    expect((await patch(dillon, `/api/firm/properties/${id}`, { coCounselFirm: null })).status).toBe(200);
    const p = (await get(dillon, `/api/firm/properties/${id}`)).body.property;
    expect(p).toMatchObject({ co_counsel_firm: null, co_counsel_role: null, co_counsel_percent: null, co_counsel_bills: null });
    expect((await get(dillon, `/api/firm/properties/${id}/evaluation`)).body.years[0].coCounselShare).toBeNull();
  });
});

describe("the Excel export", () => {
  it("writes Summary and PIN Detail with live formulas whose results match the app", async () => {
    const ev = (await get(dillon, `/api/firm/properties/${tower}/evaluation`)).body;
    const { res, buf } = await xlsx(dillon, `/api/firm/properties/${tower}/evaluation.xlsx`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers.get("content-disposition")).toContain(encodeURIComponent("05-17-302-010 - Evaluation Worksheet (2026).xlsx"));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf!);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "PIN Detail"]);
    const ws = wb.getWorksheet("Summary")!;
    expect(ws.getCell("A1").value).toBe("EVALUATION WORKSHEET");
    expect(ws.getCell("A1").fill).toMatchObject({ fgColor: { argb: "FF1F2A44" } });
    // Find a row by its label and read the 2025 column (the second of three years).
    const rowOf = (label: string) => { let n = 0; ws.eachRow((row, i) => { if (row.getCell(1).value === label) n = i; }); return n; };
    const c2025 = ws.getCell(rowOf("Tax savings"), 3).value as ExcelJS.CellFormulaValue;
    expect(c2025.formula).toMatch(/^IF\(AND\(ISNUMBER\(C\d+\),ISNUMBER\(C\d+\)\),C\d+-C\d+,""\)$/);
    expect(c2025.result).toBe(1736.12);
    const tax = ws.getCell(rowOf("Estimated tax"), 3).value as ExcelJS.CellFormulaValue;
    expect(tax.result).toBe(Number(ev.years[1].tax));
    const eq = ws.getCell(rowOf("Equalizer"), 3);
    expect(eq.value).toBe(Number(ev.years[1].equalizer));
    expect(eq.fill).toMatchObject({ fgColor: { argb: "FFFBF6E8" } }); // an input
    expect(ws.getCell(rowOf("Estimated tax"), 3).numFmt).toBe('"$"#,##0.00_);("$"#,##0.00);"–"_)');
    expect(ws.getCell(rowOf("Estimated tax"), 1).font).toMatchObject({ name: "Times New Roman" });
    expect(ws.getCell(rowOf("Estimated tax"), 3).font).toMatchObject({ name: "Cambria" });
    const pd = wb.getWorksheet("PIN Detail")!;
    expect(pd.getCell("A6").value).toBe("05-17-302-010-0000");
  });

  it("exports every year when asked", async () => {
    const ev = (await get(dillon, `/api/firm/properties/${tower}/evaluation`)).body;
    const { buf } = await xlsx(dillon, `/api/firm/properties/${tower}/evaluation.xlsx?years=all`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf!);
    const ws = wb.getWorksheet("Summary")!;
    let header = 0; ws.eachRow((row, i) => { if (row.getCell(1).value === "Assessment year") header = i; });
    const years: unknown[] = [];
    for (let c = 2; c < 2 + ev.years.length; c++) years.push(ws.getCell(header, c).value);
    expect(years).toEqual(ev.years.map((y: { assessmentYear: number }) => y.assessmentYear));
  });

  it("says when there's nothing to export", async () => {
    const geo = (await get(dillon, "/api/reference/counties")).body;
    const cook = geo.counties.find((c: { name: string }) => c.name === "Cook").id;
    const accountId = (await get(dillon, "/api/firm/accounts")).body.accounts[0].id;
    const p = await call(env.base, dillon, "POST", "/api/firm/properties", { accountId, address1: "1 Empty Lot", city: "Chicago", countyId: cook, assetType: "commercial", pin: "17-04-100-001-0000" });
    expect((await get(dillon, `/api/firm/properties/${p.body.id}/evaluation`)).body.years).toEqual([]);
    expect((await xlsx(dillon, `/api/firm/properties/${p.body.id}/evaluation.xlsx`)).res.status).toBe(409);
  });
});

describe("isolation", () => {
  it("keeps another firm out of both", async () => {
    expect((await get(olivia, `/api/firm/properties/${tower}/evaluation`)).status).toBe(404);
    expect((await xlsx(olivia, `/api/firm/properties/${tower}/evaluation.xlsx`)).res.status).toBe(404);
    expect((await patch(olivia, `/api/firm/properties/${tower}`, { coCounselFirm: "x", coCounselRole: "handling" })).status).toBe(404);
    expect((await get(olivia, `/api/firm/properties/${env.otherPropertyId}/evaluation`)).body.years).toEqual([]);
  });

  it("lets support access read it but not change co-counsel", async () => {
    await call(env.base, dillon, "POST", "/api/firm/support-grants", { hours: 1 });
    await call(env.base, admin, "POST", `/api/admin/firms/${env.nicholsId}/enter`, {});
    expect((await get(admin, `/api/firm/properties/${tower}/evaluation`)).status).toBe(200);
    expect((await patch(admin, `/api/firm/properties/${tower}`, { coCounselFirm: "x", coCounselRole: "handling" })).status).toBe(403);
  });
});
