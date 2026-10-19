import fs from "node:fs";

/** Minimal RFC 4180 CSV reader: quoted fields, escaped quotes, CRLF. Returns rows keyed by header. */
export function readCsv(file: string): Record<string, string>[] {
  return parseCsv(fs.readFileSync(file, "utf8"));
}

/** Same as readCsv, for CSV text already in memory (an upload). */
export function parseCsv(input: string): Record<string, string>[] {
  const text = input.replace(/^﻿/, "");
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((c) => c !== "")) rows.push(row); }
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

/** "09/15/2026" -> "2026-09-15"; "" -> null; ISO passes through. */
export function toIsoDate(value: string): string | null {
  if (!value) return null;
  const us = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  throw new Error(`Unrecognized date: ${value}`);
}

export function blankToNull(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}
