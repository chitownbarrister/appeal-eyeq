import { centsToString, formatMoney, toCents } from "../../shared/money";

export { formatMoney };

/**
 * Assessed and market values are valuations, shown as whole numbers the way
 * notices and the prior software show them ("70,000"). Any cents are kept.
 * Taxes, savings and fees always use formatMoney (2 decimals).
 */
export function formatValue(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  const s = centsToString(toCents(String(v)));
  const [whole, frac] = s.split(".");
  const neg = whole.startsWith("-");
  const grouped = (neg ? whole.slice(1) : whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${frac === "00" ? "" : `.${frac}`}`;
}

/** Fair market value from an assessed value and a level of assessment (percent). */
export function fmvFromAv(av: string | null | undefined, ratioPercent: string | null | undefined): string | null {
  if (av === null || av === undefined || !ratioPercent || Number(ratioPercent) === 0) return null;
  const cents = toCents(av);
  const ratioBp = toCents(ratioPercent); // percent with 2 decimals, as hundredths
  const fmvCents = (cents * 10000n + ratioBp / 2n) / ratioBp; // cents * 100 / (ratio%)
  return centsToString(((fmvCents + 50n) / 100n) * 100n); // to whole dollars
}

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

/** Strip commas and dollar signs a user may type into a number field. */
export function cleanNumber(v: string): string {
  return v.replace(/[$,\s]/g, "");
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
