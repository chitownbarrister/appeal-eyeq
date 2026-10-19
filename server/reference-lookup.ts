// Lookups against the global reference tables (filing windows, equalizers,
// tax rates). These tables carry no firm data, so any context may read them.

import type pg from "pg";
import type { Level } from "../shared/domain.js";

export interface ReferenceValues {
  rate: { taxYear: number; ratePercent: string; source: string } | null;
  equalizer: { year: number; factor: string; source: string } | null;
}

/** Most recent published equalizer and composite rate for a property, with sources. */
export async function referenceFor(c: pg.PoolClient, countyId: number, townshipId: number | null, taxCode: string | null): Promise<ReferenceValues> {
  const rate = taxCode
    ? (await c.query<{ tax_year: number; rate_percent: string; source: string | null }>(
        `SELECT tax_year, rate_percent, source FROM tax_rates WHERE county_id = $1 AND tax_code = $2 ORDER BY tax_year DESC LIMIT 1`,
        [countyId, taxCode],
      )).rows[0] ?? null
    : null;
  // Equalizer for the rate's year if there is one, else the latest; township-specific beats county-wide.
  const eqSql = `SELECT year, factor, source, township_id FROM equalizers
                  WHERE county_id = $1 AND (township_id IS NULL OR township_id = $2) AND ($3::int IS NULL OR year = $3)
                  ORDER BY year DESC, township_id NULLS LAST LIMIT 1`;
  const eq = (await c.query<{ year: number; factor: string; source: string | null }>(eqSql, [countyId, townshipId, rate?.tax_year ?? null])).rows[0]
    ?? (await c.query<{ year: number; factor: string; source: string | null }>(eqSql, [countyId, townshipId, null])).rows[0]
    ?? null;
  return {
    rate: rate ? { taxYear: rate.tax_year, ratePercent: rate.rate_percent, source: `${rate.source ?? "Reference table"} (tax year ${rate.tax_year})` } : null,
    equalizer: eq ? { year: eq.year, factor: eq.factor, source: `${eq.source ?? "Reference table"} (${eq.year})` } : null,
  };
}

/** True when an appeal's equalizer/rate differ from the latest published ones. */
export function differsFromReference(a: { equalizer: string | null; tax_rate_percent: string | null }, ref: ReferenceValues): boolean {
  if (!ref.rate || !ref.equalizer) return false;
  const same = (x: string | null, y: string) => x !== null && Number(x) === Number(y);
  return !same(a.equalizer, ref.equalizer.factor) || !same(a.tax_rate_percent, ref.rate.ratePercent);
}

/** A manual entry ("Entered by <name>: <reason>") is never replaced automatically. */
export function isManualSource(source: string | null): boolean {
  return Boolean(source && source.startsWith("Entered by "));
}

export interface WindowRow {
  id: number; level: Level; assessment_year: number; opens_on: string; closes_on: string; note: string | null;
  township: string | null; county: string;
}

/** The filing window for a property at one level and assessment year (township-specific beats county-wide). */
export async function windowFor(
  c: pg.PoolClient, countyId: number, townshipId: number | null, level: Level, assessmentYear: number,
): Promise<WindowRow | null> {
  return (await c.query<WindowRow>(
    `SELECT w.id, w.level, w.assessment_year, w.opens_on, w.closes_on, w.note, t.name AS township, co.name AS county
       FROM filing_windows w JOIN counties co ON co.id = w.county_id LEFT JOIN townships t ON t.id = w.township_id
      WHERE w.county_id = $1 AND (w.township_id IS NULL OR w.township_id = $2) AND w.level = $3 AND w.assessment_year = $4
      ORDER BY w.township_id NULLS LAST LIMIT 1`,
    [countyId, townshipId, level, assessmentYear],
  )).rows[0] ?? null;
}
