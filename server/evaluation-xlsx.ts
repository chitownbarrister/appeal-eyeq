// The Evaluation as an Excel workbook in the look of Dillon's Evaluation Worksheet 3: a navy title
// bar with the property at the right, pale section bands, Times New Roman labels and Cambria figures,
// accounting formats with a dash for zero, tan input cells, and live formulas so the sheet still
// works when someone changes an input. Delivery 10b writes Summary and PIN Detail; 11 adds the rest.

import ExcelJS from "exceljs";
import type { Evaluation, EvalYear } from "./evaluation.js";
import { ASSET_TYPE_LABELS, type AssetType } from "../shared/domain.js";
import { LEVEL_NAMES } from "./evaluation.js";

const NAVY = "FF1F2A44";
const BAND = "FFE9EDF4";
const TAN = "FFFBF6E8";
const TAN_LINE = "FFD9C7A0";
const ROW = "FFF5F7FA";
const GREY = "FF7A7F88";
const LABEL_FONT = { name: "Times New Roman", size: 10, color: { argb: "FF14233F" } };
const NUM_FONT = { name: "Cambria", size: 10, color: { argb: "FF14233F" } };

const DOLLARS = '"$"#,##0_);("$"#,##0);"–"_)';
const CENTS = '"$"#,##0.00_);("$"#,##0.00);"–"_)';
const PCT2 = '0.00"%"_);(0.00"%");"–"_)';
const RATE = '0.000000"%"';
const FACTOR = "0.0000";
const INT = '#,##0_);(#,##0);"–"_)';

const col = (n: number) => { let s = ""; for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s; return s; };
const num = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? null : Number(v));
const fmtDate = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : "");

function titleBar(ws: ExcelJS.Worksheet, lastCol: number, title: string, right: string) {
  ws.getRow(1).height = 26;
  for (let c = 1; c <= lastCol; c++) ws.getCell(1, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  const t = ws.getCell(1, 1);
  t.value = title;
  t.font = { name: "Times New Roman", size: 14, bold: true, color: { argb: "FFFFFFFF" } };
  t.alignment = { vertical: "middle", indent: 1 };
  if (lastCol > 1) {
    ws.mergeCells(1, 2, 1, lastCol);
    const r = ws.getCell(1, 2);
    r.value = right;
    r.font = { name: "Times New Roman", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    r.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
  }
}

function helper(ws: ExcelJS.Worksheet, row: number, lastCol: number, text: string) {
  ws.mergeCells(row, 1, row, lastCol);
  const c = ws.getCell(row, 1);
  c.value = text;
  c.font = { name: "Times New Roman", size: 8, italic: true, color: { argb: GREY } };
  c.alignment = { wrapText: true, vertical: "top" };
  if (text.length > 110) ws.getRow(row).height = 24;
}

function band(ws: ExcelJS.Worksheet, row: number, lastCol: number, text: string) {
  for (let c = 1; c <= lastCol; c++) ws.getCell(row, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };
  const c = ws.getCell(row, 1);
  c.value = text.toUpperCase();
  c.font = { name: "Times New Roman", size: 10, bold: true, color: { argb: "FF0A1F44" } };
  ws.getRow(row).height = 18;
}

function input(cell: ExcelJS.Cell) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TAN } };
  const side = { style: "thin" as const, color: { argb: TAN_LINE } };
  cell.border = { top: side, left: side, bottom: side, right: side };
}

function label(ws: ExcelJS.Worksheet, row: number, text: string, opts: { bold?: boolean; indent?: number } = {}) {
  const c = ws.getCell(row, 1);
  c.value = text;
  c.font = { ...LABEL_FONT, bold: opts.bold };
  c.alignment = { indent: opts.indent ?? 1 };
}

function figure(cell: ExcelJS.Cell, value: ExcelJS.CellValue, fmt: string, opts: { input?: boolean; bold?: boolean } = {}) {
  cell.value = value;
  cell.numFmt = fmt;
  cell.font = { ...NUM_FONT, bold: opts.bold };
  cell.alignment = { horizontal: "right" };
  if (opts.input) input(cell);
}

const f = (formula: string, result: number | string | null) => ({ formula, result: result ?? undefined }) as ExcelJS.CellFormulaValue;

function yearStatus(y: EvalYear): string {
  return y.levels.map((l) => {
    const s = l.status === "reduced" ? `reduced${l.reduction ? ` by ${Number(l.reduction).toLocaleString("en-US")}` : ""}`
      : l.status === "no_change" ? "no change" : l.status === "increased" ? "increased" : l.status === "waiting_decision" ? "waiting" : l.status === "open" ? "open" : l.status.replace(/_/g, " ");
    return `${LEVEL_NAMES[l.level]}: ${s}`;
  }).join("; ");
}

export async function evaluationWorkbook(ev: Evaluation, years: EvalYear[], today: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = ev.firmName;
  wb.created = new Date(`${today}T12:00:00Z`);
  const p = ev.property;
  const where = `${p.address}${p.city ? `, ${p.city}` : ""}`;
  const n = years.length;
  const first = 2; // first year column (B)
  const last = Math.max(first + n - 1, 3);

  // ============================================================ Summary
  const ws = wb.addWorksheet("Summary", { views: [{ state: "frozen", xSplit: 1, ySplit: 0, showGridLines: false }], pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.getColumn(1).width = 36;
  for (let c = first; c <= last; c++) ws.getColumn(c).width = 18;
  titleBar(ws, last, "EVALUATION WORKSHEET", where);
  helper(ws, 2, last, `Prepared by ${ev.firmName} on ${fmtDate(today)} from Appeal EyeQ. Tan-shaded cells are inputs: change one and the sheet recalculates.`);

  // Where each year's figures sit, filled in below, so the bottom line and property block can point at them.
  let r = 4;
  const rows: Record<string, number> = {};
  // Reserve the bottom line (5 rows) and the property block; write them once the table rows are known.
  const bottomStart = r;
  r += 7;
  const propStart = r;
  const propRows: [string, ExcelJS.CellValue, string | null, boolean?][] = [
    ["Client", p.client, null],
    ["Property", where, null],
    ["PINs", ev.pins.map((x) => x.pin).join(", "), null],
    ["County and township", `${p.county} County${p.township ? `, ${p.township}` : ""}`, null],
    ["Class", ev.pins.map((x) => x.class ?? "not set").join(", "), null],
    ["Asset type", `${ASSET_TYPE_LABELS[p.assetType as AssetType] ?? p.assetType}${p.assetGroup !== p.assetType ? ` (${ASSET_TYPE_LABELS[p.assetGroup as AssetType]})` : ""}`, null],
    ["Units", num(p.units), INT, true],
    ["Building SF (gross)", num(p.buildingSqft), INT, true],
    ["Rentable SF", num(p.rentableSqft), INT, true],
    ["Land SF", num(p.landSqft), INT, true],
    ["Land to building", null, "0.00"],
    ["Year built", num(p.yearBuilt), "0", true],
    ["Age (years)", null, "0"],
    ["Sale price", num(p.purchasePrice), DOLLARS, true],
    ["Sale date", p.purchaseDate ? fmtDate(p.purchaseDate) : null, null],
    ["Co-counsel", p.coCounsel ? `${p.coCounsel.firm} (${p.coCounsel.role === "relationship" ? "we are the relationship firm" : "we are the handling firm"}${p.coCounsel.bills ? `; ${p.coCounsel.bills === "us" ? "we bill the client" : "co-counsel bills the client"}` : ""})` : "None", null],
    ["Co-counsel's share of the fee", num(p.coCounsel?.percent ?? 0), PCT2, true],
  ];
  band(ws, r, last, "Property");
  r++;
  const propRow: Record<string, number> = {};
  for (const [k, v, fmt, isInput] of propRows) {
    label(ws, r, k);
    const cell = ws.getCell(r, first);
    if (fmt) figure(cell, v, fmt, { input: isInput });
    else { cell.value = v; cell.font = LABEL_FONT; if (last > first) ws.mergeCells(r, first, r, last); }
    propRow[k] = r;
    r++;
  }
  const B = (k: string) => `$${col(first)}$${propRow[k]}`;
  figure(ws.getCell(propRow["Land to building"], first), f(`IF(AND(${B("Land SF")}>0,${B("Building SF (gross)")}>0),ROUND(${B("Land SF")}/${B("Building SF (gross)")},2),"")`, num(p.landToBuilding)), "0.00");
  figure(ws.getCell(propRow["Age (years)"], first), f(`IF(${B("Year built")}>0,${today.slice(0, 4)}-${B("Year built")},"")`, num(p.age)), "0");
  if (p.landSqftFromAcreage) ws.getCell(propRow["Land SF"], first).note = "Worked out from the acreage (43,560 square feet an acre).";
  void propStart;

  // Assessment and tax by year.
  r++;
  band(ws, r, last, "Assessment and tax by year");
  r++;
  label(ws, r, "Assessment year", { bold: true });
  years.forEach((y, i) => { const c = ws.getCell(r, first + i); c.value = y.assessmentYear; c.font = { ...NUM_FONT, bold: true }; c.alignment = { horizontal: "right" }; c.border = { bottom: { style: "thin", color: { argb: "FF0A1F44" } } }; });
  ws.getCell(r, 1).border = { bottom: { style: "thin", color: { argb: "FF0A1F44" } } };
  r++;
  const line = (key: string, text: string, value: (y: EvalYear, c: string) => ExcelJS.CellValue, fmt: string | null, opts: { input?: (y: EvalYear) => boolean; bold?: boolean; indent?: number } = {}) => {
    rows[key] = r;
    label(ws, r, text, { bold: opts.bold, indent: opts.indent });
    years.forEach((y, i) => {
      const cell = ws.getCell(r, first + i);
      const v = value(y, col(first + i));
      if (fmt) figure(cell, v, fmt, { input: opts.input?.(y), bold: opts.bold });
      else { cell.value = v; cell.font = { ...LABEL_FONT, size: 9 }; cell.alignment = { horizontal: "right", wrapText: true }; }
    });
    if ((r - rows.taxYear) % 2 === 1) for (let c = 1; c <= first + n - 1; c++) if (!ws.getCell(r, c).fill || (ws.getCell(r, c).fill as ExcelJS.FillPattern).fgColor?.argb !== TAN) ws.getCell(r, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ROW } };
    r++;
  };
  const at = (key: string, c: string) => `${c}${rows[key]}`;
  line("taxYear", "Tax year", (y) => y.taxYear, "0");
  line("result", "Appeals that year", (y) => yearStatus(y), null);
  ws.getRow(rows.result).height = 30;
  line("eq", "Equalizer", (y) => num(y.equalizer), FACTOR, { input: () => true });
  line("rate", "Tax rate", (y) => num(y.ratePercent), RATE, { input: () => true });
  line("eqRate", "Equalized tax rate (equalizer × rate)", (y, c) => f(`IF(AND(ISNUMBER(${at("eq", c)}),ISNUMBER(${at("rate", c)})),${at("eq", c)}*${at("rate", c)},"")`, num(y.equalizedRatePercent)), RATE);
  line("land", "Land AV", (y) => num(y.land), DOLLARS, { input: () => true, indent: 2 });
  line("impr", "Building AV", (y) => num(y.impr), DOLLARS, { input: () => true, indent: 2 });
  // With land and building, the total adds them up; without, the total itself is the input.
  line("total", "Total AV", (y, c) => (y.land !== null && y.impr !== null ? f(`${at("land", c)}+${at("impr", c)}`, num(y.total)) : num(y.total)), DOLLARS, { input: (y) => !(y.land !== null && y.impr !== null), bold: true });
  line("loa", "Level of assessment", (y) => num(y.levelOfAssessment), PCT2, { input: () => true });
  line("fmv", "Fair market value (AV ÷ level)", (y, c) => f(`IF(AND(ISNUMBER(${at("total", c)}),${at("loa", c)}>0),IF(ROUND(${at("loa", c)},2)=33.33,${at("total", c)}*3,ROUND(${at("total", c)}/(${at("loa", c)}/100),2)),"")`, num(y.fmv)), DOLLARS, { bold: true });
  line("fmvUnit", "FMV per unit", (y, c) => f(`IF(AND(ISNUMBER(${at("fmv", c)}),${B("Units")}>0),ROUND(${at("fmv", c)}/${B("Units")},2),"")`, num(y.fmvPerUnit)), DOLLARS);
  line("avIn", "AV going into the first appeal", (y) => num(y.avIn), DOLLARS, { input: () => true });
  const taxF = (av: string, c: string) => `IF(AND(ISNUMBER(${av}),ISNUMBER(${at("eq", c)}),ISNUMBER(${at("rate", c)})),ROUND(${av}*${at("eq", c)}*${at("rate", c)}/100,2),"")`;
  // A year without an equalizer and rate keeps the tax amounts entered on its appeals, as inputs.
  line("taxBefore", "Tax before the appeal", (y, c) => (y.taxFromRates ? f(taxF(at("avIn", c), c), num(y.taxBefore)) : num(y.taxBefore)), CENTS, { input: (y) => !y.taxFromRates });
  line("tax", "Estimated tax", (y, c) => (y.taxFromRates ? f(taxF(at("total", c), c), num(y.tax)) : num(y.tax)), CENTS, { bold: true, input: (y) => !y.taxFromRates });
  line("taxUnit", "Tax per unit", (y, c) => f(`IF(AND(ISNUMBER(${at("tax", c)}),${B("Units")}>0),ROUND(${at("tax", c)}/${B("Units")},2),"")`, num(y.taxPerUnit)), CENTS);
  line("savings", "Tax savings", (y, c) => f(`IF(AND(ISNUMBER(${at("taxBefore", c)}),ISNUMBER(${at("tax", c)})),${at("taxBefore", c)}-${at("tax", c)},"")`, num(y.savings ?? (y.tax !== null && y.taxBefore !== null ? Number(y.taxBefore) - Number(y.tax) : null))), CENTS, { bold: true });
  line("feePct", "Fee percent", (y) => (y.noFee ? 0 : num(y.feePercent)), PCT2, { input: () => true });
  line("fee", "Fee on the savings", (y, c) => f(`IF(ISNUMBER(${at("savings", c)}),ROUND(MAX(${at("savings", c)},0)*${at("feePct", c)}/100,2),"")`, num(y.fee)), CENTS);
  line("invoiced", "Fee invoiced or taken from a refund", (y) => num(y.invoiced), CENTS, { input: () => true });
  line("ccShare", "Co-counsel's share", (y, c) => f(`IF(OR(ISNUMBER(${at("invoiced", c)}),ISNUMBER(${at("fee", c)})),ROUND(IF(ISNUMBER(${at("invoiced", c)}),${at("invoiced", c)},${at("fee", c)})*${B("Co-counsel's share of the fee")}/100,2),"")`, num(y.coCounselShare ?? (p.coCounsel ? null : 0))), CENTS);
  line("net", "Firm's net fee", (y, c) => f(`IF(OR(ISNUMBER(${at("invoiced", c)}),ISNUMBER(${at("fee", c)})),IF(ISNUMBER(${at("invoiced", c)}),${at("invoiced", c)},${at("fee", c)})-N(${at("ccShare", c)}),"")`, num(y.netFee)), CENTS, { bold: true });
  helper(ws, r + 1, last, "Tax = AV × equalizer × rate, to the cent. FMV = AV ÷ level of assessment (33.33% counts as one third exactly). Savings = tax on the AV going into the first appeal minus tax on the year's AV, at that year's equalizer and rate.");

  // The bottom line for the latest year.
  // The latest year that has its tax figures (a new year often waits on the equalizer and rate).
  const latestIdx = Math.max(0, years.map((y) => y.tax !== null).lastIndexOf(true));
  const latest = years[latestIdx] ?? years[years.length - 1];
  const latestCol = col(first + (years.some((y) => y.tax !== null) ? latestIdx : n - 1));
  band(ws, bottomStart, last, `Bottom line, ${latest?.assessmentYear ?? ""} assessment year`);
  const bl: [string, string, string | null][] = [
    ["Estimated tax", "tax", latest?.tax ?? null], ["Tax savings", "savings", latest?.savings ?? null], ["Fee", "fee", latest?.fee ?? null],
    ["Co-counsel's share", "ccShare", latest?.coCounselShare ?? null], ["Firm's net fee", "net", latest?.netFee ?? null],
  ];
  bl.forEach(([text, key, value], i) => {
    const row = bottomStart + 1 + i;
    label(ws, row, text, { bold: key === "net" });
    figure(ws.getCell(row, first), f(`${latestCol}${rows[key]}`, num(value)), CENTS, { bold: key === "net" });
  });

  // ============================================================ PIN Detail
  const pd = wb.addWorksheet("PIN Detail", { views: [{ state: "frozen", xSplit: 2, ySplit: 5, showGridLines: false }], pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const pLast = 2 + n * 3;
  pd.getColumn(1).width = 24;
  pd.getColumn(2).width = 10;
  for (let c = 3; c <= pLast; c++) pd.getColumn(c).width = 14;
  titleBar(pd, Math.max(pLast, 3), "PIN DETAIL", where);
  helper(pd, 2, Math.max(pLast, 3), "Land, building and total AV for each PIN, by assessment year (the decided value when there is one). Tan-shaded cells are inputs.");
  band(pd, 3, Math.max(pLast, 3), "Assessed value by PIN");
  years.forEach((y, i) => {
    const c0 = 3 + i * 3;
    pd.mergeCells(4, c0, 4, c0 + 2);
    const h = pd.getCell(4, c0);
    h.value = `${y.assessmentYear}${y.decided ? "" : " (pending)"}`;
    h.font = { ...NUM_FONT, bold: true };
    h.alignment = { horizontal: "center" };
    ["Land", "Building", "Total"].forEach((t, j) => {
      const s = pd.getCell(5, c0 + j);
      s.value = t;
      s.font = { ...LABEL_FONT, bold: true };
      s.alignment = { horizontal: "right" };
      s.border = { bottom: { style: "thin", color: { argb: "FF0A1F44" } } };
    });
  });
  for (const [k, t] of [[1, "PIN"], [2, "Class"]] as [number, string][]) {
    const c = pd.getCell(5, k);
    c.value = t;
    c.font = { ...LABEL_FONT, bold: true };
    c.border = { bottom: { style: "thin", color: { argb: "FF0A1F44" } } };
  }
  let pr = 6;
  ev.pins.forEach((pin, idx) => {
    pd.getCell(pr, 1).value = pin.pin;
    pd.getCell(pr, 1).font = NUM_FONT;
    pd.getCell(pr, 2).value = pin.class ?? "";
    pd.getCell(pr, 2).font = LABEL_FONT;
    years.forEach((y, i) => {
      const v = y.pins.find((x) => x.parcelId === pin.parcelId);
      const c0 = 3 + i * 3;
      const both = v?.land != null && v?.impr != null;
      figure(pd.getCell(pr, c0), num(v?.land), DOLLARS, { input: true });
      figure(pd.getCell(pr, c0 + 1), num(v?.impr), DOLLARS, { input: true });
      figure(pd.getCell(pr, c0 + 2), both ? f(`${col(c0)}${pr}+${col(c0 + 1)}${pr}`, num(v?.total)) : num(v?.total), DOLLARS, { input: !both });
    });
    if (idx % 2 === 1) for (let c = 1; c <= 2; c++) pd.getCell(pr, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ROW } };
    pr++;
  });
  pd.getCell(pr, 1).value = "Total";
  pd.getCell(pr, 1).font = { ...LABEL_FONT, bold: true };
  for (let c = 3; c <= pLast; c++) {
    const cell = pd.getCell(pr, c);
    const sum = years[Math.floor((c - 3) / 3)].pins.reduce<number | null>((a, x) => {
      const v = num([x.land, x.impr, x.total][(c - 3) % 3]);
      return v === null ? a : (a ?? 0) + v;
    }, null);
    figure(cell, f(`SUM(${col(c)}6:${col(c)}${pr - 1})`, sum), DOLLARS, { bold: true });
    cell.border = { top: { style: "thin", color: { argb: "FF0A1F44" } } };
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
