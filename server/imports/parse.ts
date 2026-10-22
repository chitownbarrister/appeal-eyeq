// Reads an uploaded CSV or Excel workbook into sheets of plain strings: each sheet's header row
// (found as the first row with at least three filled cells, so a title row or a blank first column
// doesn't matter) and its data rows. It also picks up what a one-client or one-property report says
// once at the top instead of on every row: the client's name (Account Summary or Overview, cell A1)
// and the property's name (Overview's "Property Name").

import ExcelJS from "exceljs";
import { parseCsv } from "../seed/csv.js";

export interface ParsedSheet {
  name: string;
  headers: string[];
  rows: string[][];
  headerRow: number;              // 1-based row of the headers in the original sheet
  context: { client?: string; property?: string };
}

export const MAX_ROWS = 50000;

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    // Excel dates come back as UTC midnight (or a time on that day); keep the calendar date.
    return isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  }
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return v.trim();
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if ("richText" in o && Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join("").trim();
    if ("result" in o) return cellText(o.result as ExcelJS.CellValue);
    if ("text" in o) return String(o.text ?? "").trim();
    if ("error" in o) return "";
  }
  return String(v).trim();
}

function shape(name: string, grid: string[][], firstRowHeaders = false): ParsedSheet | null {
  const headerIdx = firstRowHeaders ? 0 : grid.slice(0, 15).findIndex((r) => r.filter((c) => c !== "").length >= 3);
  if (headerIdx < 0) return { name, headers: [], rows: [], headerRow: 0, context: {} };
  const raw = grid[headerIdx];
  const cols = raw.map((h, i) => ({ h: h.trim(), i })).filter((x) => x.h !== "");
  // Two columns with the same header keep both, the second as "Name (2)".
  const seen = new Map<string, number>();
  const headers = cols.map(({ h }) => { const n = (seen.get(h) ?? 0) + 1; seen.set(h, n); return n > 1 ? `${h} (${n})` : h; });
  const rows = grid.slice(headerIdx + 1).map((r) => cols.map(({ i }) => (r[i] ?? "").trim())).filter((r) => r.some((c) => c !== ""));
  return { name, headers, rows, headerRow: headerIdx + 1, context: {} };
}

/** Label/value pairs from a report page laid out as "Label | value" in two or more column blocks (merged cells repeat). */
export function labelPairs(grid: string[][]): Record<string, string> {
  const KNOWN = /^(property name|address 1|city|county|purchase date|year built)$/i;
  const labelCols = new Set<number>();
  for (const r of grid) (r ?? []).forEach((v, i) => { if (KNOWN.test(v) && r[i - 1] !== v) labelCols.add(i); });
  const cols = [...labelCols].sort((a, b) => a - b);
  const out: Record<string, string> = {};
  for (const r of grid) {
    if (!r) continue;
    cols.forEach((col, k) => {
      const label = (r[col] ?? "").trim();
      if (!label || label in out) return;
      const end = cols[k + 1] ?? r.length;
      let j = col + 1;
      while (j < end && r[j] === label) j++;
      while (j < end && !r[j]) j++;
      const value = j < end ? r[j] : "";
      if (value && value !== label) out[label] = value;
      else out[label] = "";
    });
  }
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return out;
}

/** The lines under a client's name on a summary page: street, "City, ST 60093", phone. */
function clientBlock(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lines) {
    if (!l) break;
    const csz = /^(.+?),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/.exec(l);
    if (csz) { out.City ??= csz[1]; out.State ??= csz[2].toUpperCase(); out.Zip ??= csz[3]; continue; }
    if (/^[\d\s().+-]{7,}$/.test(l)) { out.Phone ??= l; continue; }
    if (/@/.test(l)) { out.Email ??= l; continue; }
    if (/^[a-z ]+:/i.test(l)) break;
    out.Address ??= l;
  }
  return out;
}

function oneRow(name: string, rec: Record<string, string>): ParsedSheet {
  const headers = Object.keys(rec);
  return { name, headers, rows: [headers.map((h) => rec[h])], headerRow: 1, context: {} };
}

export async function parseFile(fileName: string, body: Buffer): Promise<ParsedSheet[]> {
  const isZip = body.subarray(0, 2).toString("latin1") === "PK";
  if (!isZip) {
    if (!/\.(csv|txt)$/i.test(fileName) && body.subarray(0, 8).includes(0)) throw Object.assign(new Error("type"), { status: 415, publicMessage: `${fileName} isn't a CSV or Excel (.xlsx) file.` });
    const records = parseCsv(body.toString("utf8"));
    const headers = records.length ? Object.keys(records[0]) : [];
    const grid = [headers, ...records.map((r) => headers.map((h) => r[h] ?? ""))];
    const s = shape(fileName.replace(/\.[^.]+$/, ""), grid, true);
    return s ? [s] : [];
  }
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(body as unknown as ArrayBuffer);
  } catch {
    throw Object.assign(new Error("xlsx"), { status: 415, publicMessage: `${fileName} couldn't be read as an Excel workbook. Save it as .xlsx or .csv and try again.` });
  }
  const sheets: ParsedSheet[] = [];
  let client: string | undefined;
  let property: string | undefined;
  const synthetic: ParsedSheet[] = [];
  for (const ws of wb.worksheets) {
    const grid: string[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const vals: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, c) => { vals[c - 1] = cellText(cell.value); });
      grid[n - 1] = Array.from(vals, (v) => v ?? "");
    });
    for (let i = 0; i < grid.length; i++) grid[i] ??= [];
    if (/^(account summary|overview)$/i.test(ws.name.trim())) {
      // The client's name is the first thing on the page (row 1 on Overview, a few rows down on Account Summary).
      const top = grid.slice(0, 8).map((r) => (r ?? []).find((v) => v) ?? "");
      const at = top.findIndex((v) => v && !/^(account summary|overview)$/i.test(v));
      if (at >= 0 && !client) {
        client = top[at];
        if (/^account summary$/i.test(ws.name.trim())) {
          const extra = clientBlock(top.slice(at + 1));
          if (Object.keys(extra).length) synthetic.push(oneRow("Client (from Account Summary)", { "Client Name": client, ...extra }));
        }
      }
      if (/^overview$/i.test(ws.name.trim())) {
        const pairs = labelPairs(grid);
        const name = pairs["Property Name"];
        if (name) property ??= name;
        if (Object.keys(pairs).length >= 3) synthetic.push(oneRow("Property (from Overview)", pairs));
      }
    }
    const s = shape(ws.name, grid);
    if (s) sheets.push(s);
  }
  // A sheet made from a report's summary page only when the workbook has no proper sheet for the same thing.
  for (const syn of synthetic) {
    const kind = /^client/i.test(syn.name) ? /client|account/i : /propert/i;
    if (!sheets.some((x) => kind.test(x.name) && !/^(account summary|overview)$/i.test(x.name) && x.rows.length)) sheets.push(syn);
  }
  for (const s of sheets) s.context = { client, property };
  const total = sheets.reduce((a, s) => a + s.rows.length, 0);
  if (total > MAX_ROWS) throw Object.assign(new Error("big"), { status: 413, publicMessage: `${fileName} has ${total.toLocaleString("en-US")} rows; one import takes up to ${MAX_ROWS.toLocaleString("en-US")}. Split it into smaller files.` });
  return sheets;
}
