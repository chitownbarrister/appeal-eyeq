// The PINs on an appeal: keeping a row for every parcel of the property,
// working the property totals from them, recalculating taxes, and carrying a
// PTAB decision forward to later appeals in the same reassessment cycle.
// Every function runs inside the caller's withContext and filters on firm_id.

import type pg from "pg";
import { computeAppealTax } from "../shared/valuation.js";
import { centsToString, toCents } from "../shared/money.js";
import { pinAv } from "../shared/pins.js";
import { sameCycle } from "../shared/reassessment.js";
import type { Level } from "../shared/domain.js";

export const STAGES = [["original", "orig"], ["target", "target"], ["resolved", "resolved"]] as const;
export type StageKey = (typeof STAGES)[number][0];

export interface PinRow {
  id: number; parcel_id: number; on_appeal: boolean; pin: string; is_primary: boolean;
  orig_land_av: string | null; orig_impr_av: string | null; orig_av: string | null;
  target_land_av: string | null; target_impr_av: string | null; target_av: string | null;
  resolved_land_av: string | null; resolved_impr_av: string | null; resolved_av: string | null;
}

/** Makes sure the appeal has a row for each of the property's parcels (a PIN added later starts off the appeal). */
export async function syncPins(c: pg.PoolClient, firmId: number, appealId: number): Promise<void> {
  await c.query(
    `INSERT INTO appeal_pins (firm_id, appeal_id, parcel_id, on_appeal)
     SELECT a.firm_id, a.id, pc.id, false
       FROM appeals a JOIN parcels pc ON pc.firm_id = a.firm_id AND pc.property_id = a.property_id
      WHERE a.firm_id = $1 AND a.id = $2
     ON CONFLICT (firm_id, appeal_id, parcel_id) DO NOTHING`,
    [firmId, appealId],
  );
}

export async function loadPins(c: pg.PoolClient, firmId: number, appealId: number): Promise<PinRow[]> {
  return (await c.query<PinRow>(
    `SELECT ap.*, pc.pin, pc.is_primary FROM appeal_pins ap JOIN parcels pc ON pc.firm_id = ap.firm_id AND pc.id = ap.parcel_id
      WHERE ap.firm_id = $1 AND ap.appeal_id = $2 ORDER BY pc.is_primary DESC, pc.id`,
    [firmId, appealId],
  )).rows;
}

const val = (row: PinRow, prefix: string, part: "land" | "impr" | "" ) => (row as unknown as Record<string, string | null>)[part ? `${prefix}_${part}_av` : `${prefix}_av`];

/** A PIN's value at a stage. A PIN not on the appeal keeps its original value at every stage. */
export function pinStage(row: PinRow, prefix: "orig" | "target" | "resolved"): { land: string | null; impr: string | null; av: string | null } {
  const p = row.on_appeal ? prefix : "orig";
  return { land: val(row, p, "land"), impr: val(row, p, "impr"), av: val(row, p, "") };
}

/**
 * Property totals from the PINs. A stage's total is known only when every PIN has a value for it;
 * otherwise it's null, so a half-entered stage never shows a wrong total. "pinMode" is false when
 * even the original values aren't all entered (older multi-parcel appeals), in which case the
 * appeal's own totals stay as they were.
 */
export function pinTotals(rows: PinRow[]): { pinMode: boolean; totals: Record<"orig" | "target" | "resolved", { land: string | null; impr: string | null; av: string | null }> } {
  const sum = (xs: (string | null)[]) => (xs.length && xs.every((x) => x !== null) ? centsToString(xs.reduce((a, x) => a + toCents(x!), 0n)) : null);
  const out = {} as Record<"orig" | "target" | "resolved", { land: string | null; impr: string | null; av: string | null }>;
  for (const prefix of ["orig", "target", "resolved"] as const) {
    const vals = rows.map((r) => pinStage(r, prefix));
    const anyOn = rows.some((r) => r.on_appeal && pinStage(r, prefix).av !== null);
    out[prefix] = {
      land: sum(vals.map((v) => v.land)),
      impr: sum(vals.map((v) => v.impr)),
      av: prefix === "orig" || anyOn ? sum(vals.map((v) => v.av)) : null,
    };
  }
  return { pinMode: rows.length > 0 && out.orig.av !== null, totals: out };
}

/**
 * Writes one PIN's values for a stage. With land and building both known, AV is their sum.
 * An AV typed on its own keeps the land and puts the rest on the building.
 */
export async function writePinStage(
  c: pg.PoolClient, firmId: number, pinId: number, prefix: "orig" | "target" | "resolved",
  v: { land?: string | null; impr?: string | null; av?: string | null },
): Promise<void> {
  const cur = (await c.query(`SELECT ${prefix}_land_av AS land, ${prefix}_impr_av AS impr, ${prefix}_av AS av FROM appeal_pins WHERE firm_id = $1 AND id = $2`, [firmId, pinId])).rows[0];
  let land: string | null = v.land !== undefined ? v.land : cur.land;
  let impr: string | null = v.impr !== undefined ? v.impr : cur.impr;
  let av: string | null;
  if (v.land !== undefined || v.impr !== undefined) {
    av = land !== null && impr !== null ? pinAv({ land, impr, av: null }) : v.av !== undefined ? v.av : null;
  } else if (v.av !== undefined) {
    // An AV on its own: land stays and the building takes the difference (the firm's method);
    // with no land on file, there's no split to keep.
    av = v.av === null ? null : pinAv({ land: null, impr: null, av: v.av });
    if (av === null) { land = null; impr = null; }
    else if (land === null) impr = null;
    else if (toCents(av) - toCents(land) < 0n) { land = av; impr = "0.00"; }
    else impr = centsToString(toCents(av) - toCents(land));
  } else {
    av = cur.av;
  }
  await c.query(
    `UPDATE appeal_pins SET ${prefix}_land_av = $3, ${prefix}_impr_av = $4, ${prefix}_av = $5 WHERE firm_id = $1 AND id = $2`,
    [firmId, pinId, land, impr, av],
  );
}

/**
 * Brings the appeal's property totals and taxes in line with its PINs (when every PIN's original is
 * known) and returns the updated appeal row. Personal property and value adjustments stay on the appeal
 * and are added on top.
 */
export async function refreshAppealFromPins(c: pg.PoolClient, firmId: number, appealId: number): Promise<Record<string, unknown>> {
  const a = (await c.query(`SELECT * FROM appeals WHERE firm_id = $1 AND id = $2`, [firmId, appealId])).rows[0];
  const rows = await loadPins(c, firmId, appealId);
  const { pinMode, totals } = pinTotals(rows);
  if (!pinMode) return a;
  const next: Record<string, string | null> = {};
  for (const prefix of ["orig", "target", "resolved"] as const) {
    const t = totals[prefix];
    const extra = [a[`${prefix}_personal_av`], a[`${prefix}_adjust_av`]].filter((x) => x !== null && x !== undefined) as string[];
    next[`${prefix}_land_av`] = t.land;
    next[`${prefix}_impr_av`] = t.impr;
    next[`${prefix}_av`] = t.av === null ? null : centsToString(extra.reduce((acc, x) => acc + toCents(x), toCents(t.av)));
  }
  if (!a.calc_override) {
    const tax = computeAppealTax({ origAv: next.orig_av, targetAv: next.target_av, resolvedAv: next.resolved_av, equalizer: a.equalizer, taxRatePercent: a.tax_rate_percent });
    Object.assign(next, { original_tax: tax.originalTax, target_tax: tax.targetTax, resolved_tax: tax.resolvedTax, estimated_savings: tax.estimatedSavings, savings: tax.savings });
  }
  const cols = Object.keys(next);
  return (await c.query(
    `UPDATE appeals SET ${cols.map((col, i) => `${col} = $${i + 3}`).join(", ")} WHERE firm_id = $1 AND id = $2 RETURNING *`,
    [firmId, appealId, ...cols.map((col) => next[col])],
  )).rows[0];
}

/** Gives a new appeal its PINs, with original values carried from the given earlier appeal's results (by PIN). */
export async function seedPinsForNewAppeal(c: pg.PoolClient, firmId: number, appealId: number, fromAppealId: number | null, onlyParcelId: number | null): Promise<void> {
  await syncPins(c, firmId, appealId);
  await c.query(`UPDATE appeal_pins SET on_appeal = ($3::int IS NULL OR parcel_id = $3) WHERE firm_id = $1 AND appeal_id = $2`, [firmId, appealId, onlyParcelId]);
  if (!fromAppealId) return;
  await c.query(
    `UPDATE appeal_pins n SET
        orig_land_av = CASE WHEN o.on_appeal AND o.resolved_av IS NOT NULL THEN o.resolved_land_av ELSE o.orig_land_av END,
        orig_impr_av = CASE WHEN o.on_appeal AND o.resolved_av IS NOT NULL THEN o.resolved_impr_av ELSE o.orig_impr_av END,
        orig_av      = CASE WHEN o.on_appeal AND o.resolved_av IS NOT NULL THEN o.resolved_av ELSE o.orig_av END
       FROM appeal_pins o
      WHERE n.firm_id = $1 AND n.appeal_id = $2 AND o.firm_id = $1 AND o.appeal_id = $3 AND o.parcel_id = n.parcel_id`,
    [firmId, appealId, fromAppealId],
  );
}

const DECIDED = ["reduced", "no_change", "increased"];
const OPEN = ["open", "waiting_decision"];

/**
 * A decided PTAB appeal sets the property's value for the rest of its reassessment cycle. Later open
 * appeals on the property in the same cycle, whose target nobody has set by hand, take the PTAB's
 * resolved values as their target (marked as a rollover). Returns the appeal ids it changed.
 */
export async function applyRollover(c: pg.PoolClient, firmId: number, ptabAppealId: number): Promise<number[]> {
  const src = (await c.query(
    `SELECT a.id, a.property_id, a.assessment_year, a.level, a.status, co.name AS county, t.triad
       FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id
       JOIN counties co ON co.id = p.county_id LEFT JOIN townships t ON t.id = p.township_id
      WHERE a.firm_id = $1 AND a.id = $2`,
    [firmId, ptabAppealId],
  )).rows[0];
  if (!src || src.level !== "ptab" || !DECIDED.includes(src.status)) return [];
  const srcPins = await loadPins(c, firmId, ptabAppealId);
  if (!srcPins.length || srcPins.some((r) => pinStage(r, "resolved").av === null)) return [];
  const later = (await c.query<{ id: number; assessment_year: number }>(
    `SELECT id, assessment_year FROM appeals
      WHERE firm_id = $1 AND property_id = $2 AND assessment_year > $3 AND status = ANY($4::text[])
        AND (target_source = 'rollover' OR (target_source IS NULL AND target_av IS NULL)) AND stipulation_locked_at IS NULL`,
    [firmId, src.property_id, src.assessment_year, OPEN],
  )).rows.filter((r) => sameCycle(src.county, src.triad, src.assessment_year, r.assessment_year));
  const changed: number[] = [];
  for (const l of later) {
    await syncPins(c, firmId, l.id);
    const pins = await loadPins(c, firmId, l.id);
    for (const p of pins) {
      const s = srcPins.find((x) => x.parcel_id === p.parcel_id);
      if (!s || !p.on_appeal) continue;
      const v = pinStage(s, "resolved");
      await c.query(`UPDATE appeal_pins SET target_land_av = $3, target_impr_av = $4, target_av = $5 WHERE firm_id = $1 AND id = $2`, [firmId, p.id, v.land, v.impr, v.av]);
    }
    await c.query(`UPDATE appeals SET target_source = 'rollover', target_source_appeal_id = $3 WHERE firm_id = $1 AND id = $2`, [firmId, l.id, ptabAppealId]);
    await refreshAppealFromPins(c, firmId, l.id);
    changed.push(l.id);
  }
  return changed;
}

/** For a new appeal: a decided PTAB earlier in the same cycle supplies its starting target. */
export async function rolloverIntoNewAppeal(c: pg.PoolClient, firmId: number, appealId: number): Promise<void> {
  const a = (await c.query(`SELECT property_id, assessment_year FROM appeals WHERE firm_id = $1 AND id = $2`, [firmId, appealId])).rows[0];
  const src = (await c.query<{ id: number }>(
    `SELECT id FROM appeals WHERE firm_id = $1 AND property_id = $2 AND level = 'ptab' AND assessment_year < $3 AND status = ANY($4::text[])
      ORDER BY assessment_year DESC LIMIT 1`,
    [firmId, a.property_id, a.assessment_year, DECIDED],
  )).rows[0];
  if (src) await applyRollover(c, firmId, src.id);
}

/**
 * The rollover an appeal could take but hasn't (its target was set another way): the latest decided
 * PTAB earlier in the same reassessment cycle, with its resolved total. Null when there's none.
 */
export async function rolloverSuggestion(c: pg.PoolClient, firmId: number, appealId: number): Promise<{ appealId: number; year: number; totalAv: string } | null> {
  const a = (await c.query(
    `SELECT a.property_id, a.assessment_year, a.status, a.target_source, co.name AS county, t.triad
       FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id
       JOIN counties co ON co.id = p.county_id LEFT JOIN townships t ON t.id = p.township_id
      WHERE a.firm_id = $1 AND a.id = $2`,
    [firmId, appealId],
  )).rows[0];
  if (!a || a.target_source === "rollover" || !OPEN.includes(a.status)) return null;
  const srcs = (await c.query<{ id: number; assessment_year: number }>(
    `SELECT id, assessment_year FROM appeals WHERE firm_id = $1 AND property_id = $2 AND level = 'ptab' AND assessment_year < $3 AND status = ANY($4::text[])
      ORDER BY assessment_year DESC`,
    [firmId, a.property_id, a.assessment_year, DECIDED],
  )).rows.filter((x) => sameCycle(a.county, a.triad, x.assessment_year, a.assessment_year));
  if (!srcs.length) return null;
  const pins = await loadPins(c, firmId, srcs[0].id);
  const { totals } = pinTotals(pins);
  return totals.resolved.av === null ? null : { appealId: srcs[0].id, year: srcs[0].assessment_year, totalAv: totals.resolved.av };
}

/** Takes a suggested rollover: the PTAB's resolved PIN values become this appeal's target. */
export async function takeRollover(c: pg.PoolClient, firmId: number, appealId: number, ptabAppealId: number): Promise<void> {
  const srcPins = await loadPins(c, firmId, ptabAppealId);
  await syncPins(c, firmId, appealId);
  for (const p of await loadPins(c, firmId, appealId)) {
    const s = srcPins.find((x) => x.parcel_id === p.parcel_id);
    if (!s || !p.on_appeal) continue;
    const v = pinStage(s, "resolved");
    await c.query(`UPDATE appeal_pins SET target_land_av = $3, target_impr_av = $4, target_av = $5 WHERE firm_id = $1 AND id = $2`, [firmId, p.id, v.land, v.impr, v.av]);
  }
  await c.query(`UPDATE appeals SET target_source = 'rollover', target_source_appeal_id = $3 WHERE firm_id = $1 AND id = $2`, [firmId, appealId, ptabAppealId]);
  await refreshAppealFromPins(c, firmId, appealId);
}

export type { Level };
