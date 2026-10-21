import { formatMoney, formatValueAmount } from "../../shared/money";

export { formatMoney };

// Each person chooses whether assessed and market values show cents (Your account).
let valueCents = false;
export function setValueCents(on: boolean): void { valueCents = on; }
export function valueCentsOn(): boolean { return valueCents; }

/**
 * Assessed and market values (AV, FMV, land, building, offers) in accounting format:
 * "$70,000", whole dollars the way notices print them, with any cents kept so PINs
 * visibly add up ("$19,000.33"), or always with cents for someone who chose that.
 * Negatives in parentheses: "($1,250)". Taxes, savings and fees use formatMoney (2 decimals).
 */
export function formatValue(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  return formatValueAmount(String(v), valueCents);
}

/** Fair market value from AV and the level of assessment, to the penny (33.33% is one third exactly). */
export { fmvFromAv } from "../../shared/pins";

/** "10.3%" reduction from original to resolved. */
export function reductionPct(orig: string | null, resolved: string | null): string {
  if (!orig || resolved === null || resolved === undefined) return "—";
  const o = Number(orig), r = Number(resolved);
  if (!o) return "—";
  return `${(((o - r) / o) * 100).toFixed(1)}%`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function formatDate(isoDate: string | null | undefined): string {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function titleCase(s: string | null | undefined): string {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Today's date as YYYY-MM-DD in the viewer's time zone. */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Turn "" into null for optional fields sent to the API. */
export function nn(v: string | null | undefined): string | null {
  return v === undefined || v === null || v.trim() === "" ? null : v.trim();
}

/** Strip commas and dollar signs a user may type into a number field; "(1,250)" is negative. */
export function cleanNumber(v: string): string {
  const neg = /^\s*\(.*\)\s*$/.test(v);
  const s = v.replace(/[$,\s()]/g, "");
  return neg && s && !s.startsWith("-") ? `-${s}` : s;
}

/**
 * A matter title is "PIN – Address, City (Township)". Shown on screen, the PIN
 * gets its own line so a street number never reads as part of it.
 */
export function splitMatterTitle(title: string): { pin: string | null; place: string } {
  const i = title.indexOf(" – ");
  if (i < 0 || !/^[\d-]+$/.test(title.slice(0, i))) return { pin: null, place: title };
  return { pin: title.slice(0, i), place: title.slice(i + 3) };
}
