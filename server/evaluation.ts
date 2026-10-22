// The property's Evaluation: the facts, and for each assessment year the equalizer, rate, values,
// level of assessment, FMV, estimated tax, savings, fee and co-counsel share, plus each PIN's values.
// Built only from what Appeal EyeQ already stores. Exact money math (cents, BigInt) as elsewhere.
//
// Per year: the first level's AV going in, and the furthest level that has a result (else the latest
// level filed) for the year's AV. Savings = tax on the AV going in minus tax on the year's AV, at that
// level's equalizer and rate, so the worksheet's own formulas give the same figure.

import type pg from "pg";
import { LEVELS, type Level } from "../shared/domain.js";
import { centsToString, feeAmount, netTax, toCents } from "../shared/money.js";
import { fmvFromAv, pinAv } from "../shared/pins.js";
import { effectiveFee, type FeeBasis } from "../shared/fees.js";
import { propertyLevel } from "./assessment.js";

const SQFT_PER_ACRE = 43560;
const DECIDED = ["reduced", "no_change", "increased"];

export interface EvalPin { parcelId: number; pin: string; class: string | null; land: string | null; impr: string | null; total: string | null }

export interface EvalYear {
  assessmentYear: number;
  taxYear: number;
  levelReached: Level;
  decided: boolean;
  status: string;
  levels: { level: Level; status: string; origAv: string | null; resolvedAv: string | null; reduction: string | null }[];
  equalizer: string | null;
  ratePercent: string | null;
  equalizedRatePercent: string | null;
  /** false when the year has no equalizer and rate, so its tax figures are the amounts entered on the appeals */
  taxFromRates: boolean;
  avIn: string | null;
  land: string | null;
  impr: string | null;
  total: string | null;
  levelOfAssessment: string | null;
  fmv: string | null;
  fmvPerUnit: string | null;
  taxBefore: string | null;
  tax: string | null;
  taxPerUnit: string | null;
  savings: string | null;
  feePercent: string;
  feeBasis: FeeBasis;
  noFee: boolean;
  fee: string | null;
  invoiced: string | null;
  coCounselShare: string | null;
  netFee: string | null;
  pins: EvalPin[];
}

export interface Evaluation {
  property: {
    id: number; client: string; address: string; city: string | null; state: string; county: string; township: string | null;
    assetType: string; assetGroup: string; units: number | null; buildingSqft: number | null; rentableSqft: number | null;
    landSqft: number | null; landSqftFromAcreage: boolean; landToBuilding: string | null; yearBuilt: number | null; age: number | null;
    purchasePrice: string | null; purchaseDate: string | null; taxCode: string | null;
    coCounsel: { firm: string; role: "relationship" | "handling"; percent: string | null; bills: "us" | "co_counsel" | null } | null;
    levelOfAssessment: string | null;
  };
  pins: { parcelId: number; pin: string; class: string | null; isPrimary: boolean }[];
  years: EvalYear[];
  firmName: string;
}

const perUnit = (amount: string | null, units: number | null) =>
  amount !== null && units && units > 0 ? centsToString((toCents(amount) * 2n + BigInt(units)) / (2n * BigInt(units))) : null;

/** Equalizer x rate, as a percent of AV, to six places (display only; money math uses the exact inputs). */
function equalizedRate(eq: string | null, rate: string | null): string | null {
  if (eq === null || rate === null) return null;
  return (Number(eq) * Number(rate)).toFixed(6);
}

export async function buildEvaluation(c: pg.PoolClient, firmId: number, propertyId: number, today: string): Promise<Evaluation | null> {
  const p = (await c.query(
    `SELECT p.*, ac.name AS client, ac.no_fee AS account_no_fee, ac.fee_percent_first_year AS account_fee_first_year,
            ac.fee_percent_refund AS account_fee_refund, co.name AS county, t.name AS township,
            app_asset_group(p.asset_type, p.units, p.county_id, p.asset_group_override) AS asset_group
       FROM properties p JOIN accounts ac ON ac.firm_id = p.firm_id AND ac.id = p.account_id
       JOIN counties co ON co.id = p.county_id LEFT JOIN townships t ON t.id = p.township_id
      WHERE p.firm_id = $1 AND p.id = $2`,
    [firmId, propertyId],
  )).rows[0];
  if (!p) return null;
  const firm = (await c.query<{ name: string; letterhead_name: string | null }>(`SELECT name, letterhead_name FROM firms WHERE id = $1`, [firmId])).rows[0];
  const parcels = (await c.query<{ id: number; pin: string; class: string | null; is_primary: boolean }>(
    `SELECT id, pin, class, is_primary FROM parcels WHERE firm_id = $1 AND property_id = $2 ORDER BY is_primary DESC, id`, [firmId, propertyId],
  )).rows;
  const appeals = (await c.query(
    `SELECT * FROM appeals WHERE firm_id = $1 AND property_id = $2 ORDER BY assessment_year, array_position(ARRAY['assessor','bor','ptab','circuit']::text[], level), id`,
    [firmId, propertyId],
  )).rows;
  const pinRows = (await c.query(
    `SELECT ap.* FROM appeal_pins ap JOIN appeals a ON a.firm_id = ap.firm_id AND a.id = ap.appeal_id
      WHERE ap.firm_id = $1 AND a.property_id = $2`,
    [firmId, propertyId],
  )).rows;
  const invoiced = (await c.query<{ appeal_id: number; fee: string }>(
    `SELECT i.appeal_id, COALESCE(sum(l.amount), 0)::numeric(14,2) AS fee
       FROM invoices i JOIN invoice_lines l ON l.firm_id = i.firm_id AND l.invoice_id = i.id AND l.kind = 'fee'
      WHERE i.firm_id = $1 AND i.property_id = $2 AND i.status IN ('sent', 'paid') AND i.appeal_id IS NOT NULL
      GROUP BY i.appeal_id`,
    [firmId, propertyId],
  )).rows;
  const settled = (await c.query<{ appeal_id: number; fee: string }>(
    `SELECT appeal_id, fee_amount AS fee FROM trust_settlements WHERE firm_id = $1 AND property_id = $2 AND status IN ('approved', 'paid')`,
    [firmId, propertyId],
  )).rows;
  const feeDefaults = (await c.query<{ level: Level; percent: string; basis: FeeBasis }>(`SELECT level, percent, basis FROM fee_defaults WHERE firm_id = $1`, [firmId])).rows;
  const level = await propertyLevel(c, firmId, propertyId);

  const units = p.units ?? null;
  const landSqft = p.land_sqft ?? (p.acreage !== null ? Math.round(Number(p.acreage) * SQFT_PER_ACRE) : null);
  const coPct = p.co_counsel_firm ? p.co_counsel_percent : null;
  const sources = {
    firmDefaults: feeDefaults,
    account: { fee_percent_first_year: p.account_fee_first_year, fee_percent_refund: p.account_fee_refund, no_fee: p.account_no_fee },
    property: { fee_percent_first_year: p.fee_percent_first_year, fee_percent_refund: p.fee_percent_refund, no_fee: p.no_fee },
  };

  const byYear = new Map<number, typeof appeals>();
  for (const a of appeals) byYear.set(a.assessment_year, [...(byYear.get(a.assessment_year) ?? []), a]);

  const years: EvalYear[] = [...byYear.entries()].sort((x, y) => x[0] - y[0]).map(([year, list]) => {
    const first = list[0];
    const decidedOnes = list.filter((a) => DECIDED.includes(a.status));
    const final = decidedOnes.length ? decidedOnes[decidedOnes.length - 1] : list[list.length - 1];
    const isDecided = DECIDED.includes(final.status);
    const resolved = isDecided && final.resolved_av !== null;
    const eq = final.equalizer ?? first.equalizer ?? null;
    const rate = final.tax_rate_percent ?? first.tax_rate_percent ?? null;
    const avIn = first.orig_av ?? null;
    const total = resolved ? final.resolved_av : final.orig_av;
    const land = resolved ? final.resolved_land_av : final.orig_land_av;
    const impr = resolved ? final.resolved_impr_av : final.orig_impr_av;
    const ratio = final.assessment_ratio ?? level?.percent ?? null;
    const fmv = fmvFromAv(total, ratio);
    const ready = eq !== null && rate !== null;
    // Without an equalizer and rate (figures entered by hand or brought over from earlier software),
    // the tax amounts the appeals carry are used as they are.
    const tax = ready && total !== null ? netTax(total, eq, rate) : (resolved ? final.resolved_tax : final.original_tax) ?? null;
    const taxBefore = ready && avIn !== null ? netTax(avIn, eq, rate) : first.original_tax ?? null;
    const savings = isDecided && tax !== null && taxBefore !== null ? centsToString(toCents(taxBefore) - toCents(tax)) : null;
    const fee = effectiveFee(final.level, { ...sources, appeal: { fee_percent: final.fee_percent } });
    const feeAmt = savings !== null && toCents(savings) > 0n && !fee.noFee ? feeAmount(savings, fee.percent) : savings !== null ? "0.00" : null;
    const billed = [...invoiced.filter((i) => list.some((a) => a.id === i.appeal_id)), ...settled.filter((s) => list.some((a) => a.id === s.appeal_id))];
    const invoicedAmt = billed.length ? centsToString(billed.reduce((acc, b) => acc + toCents(b.fee), 0n)) : null;
    const basisForSplit = invoicedAmt ?? feeAmt;
    const share = basisForSplit !== null && coPct !== null ? feeAmount(basisForSplit, coPct) : null;
    const netFee = basisForSplit !== null ? centsToString(toCents(basisForSplit) - (share !== null ? toCents(share) : 0n)) : null;
    // Each PIN's values for the year, from the same level as the year's AV.
    const pins: EvalPin[] = parcels.map((x) => {
      const r = pinRows.find((v) => v.appeal_id === final.id && v.parcel_id === x.id);
      const l = r ? (resolved && r.resolved_av !== null ? r.resolved_land_av : r.orig_land_av) : null;
      const i = r ? (resolved && r.resolved_av !== null ? r.resolved_impr_av : r.orig_impr_av) : null;
      const t = r ? (resolved && r.resolved_av !== null ? r.resolved_av : r.orig_av) ?? pinAv({ land: l, impr: i, av: null }) : null;
      return { parcelId: x.id, pin: x.pin, class: x.class, land: l, impr: i, total: t };
    });
    // A single-PIN property without PIN rows takes the year's own figures.
    if (parcels.length === 1 && pins[0].total === null) Object.assign(pins[0], { land, impr, total });
    return {
      assessmentYear: year, taxYear: final.tax_year, levelReached: final.level, decided: isDecided, status: final.status,
      levels: list.map((a) => ({
        level: a.level, status: a.status, origAv: a.orig_av, resolvedAv: a.resolved_av,
        reduction: DECIDED.includes(a.status) && a.orig_av !== null && a.resolved_av !== null ? centsToString(toCents(a.orig_av) - toCents(a.resolved_av)) : null,
      })),
      equalizer: eq, ratePercent: rate, equalizedRatePercent: equalizedRate(eq, rate), taxFromRates: ready,
      avIn, land, impr, total, levelOfAssessment: ratio, fmv, fmvPerUnit: perUnit(fmv, units),
      taxBefore, tax, taxPerUnit: perUnit(tax, units), savings,
      feePercent: fee.percent, feeBasis: fee.basis, noFee: fee.noFee, fee: feeAmt, invoiced: invoicedAmt, coCounselShare: share, netFee, pins,
    };
  });

  const yearBuilt = p.year_built ?? null;
  return {
    firmName: firm.letterhead_name || firm.name,
    property: {
      id: p.id, client: p.client, address: p.address1 || p.name, city: p.city, state: p.state, county: p.county, township: p.township,
      assetType: p.asset_type, assetGroup: p.asset_group, units, buildingSqft: p.building_sqft ?? null, rentableSqft: p.rentable_sqft ?? null,
      landSqft, landSqftFromAcreage: p.land_sqft === null && landSqft !== null,
      landToBuilding: landSqft !== null && p.building_sqft ? (landSqft / p.building_sqft).toFixed(2) : null,
      yearBuilt, age: yearBuilt ? Number(today.slice(0, 4)) - yearBuilt : null,
      purchasePrice: p.purchase_price ?? null, purchaseDate: p.purchase_date ?? null, taxCode: p.tax_code ?? null,
      coCounsel: p.co_counsel_firm ? { firm: p.co_counsel_firm, role: p.co_counsel_role, percent: p.co_counsel_percent, bills: p.co_counsel_bills } : null,
      levelOfAssessment: level?.percent ?? null,
    },
    pins: parcels.map((x) => ({ parcelId: x.id, pin: x.pin, class: x.class, isPrimary: x.is_primary })),
    years,
  };
}

export const LEVEL_NAMES: Record<Level, string> = { assessor: "Assessor", bor: "Board of Review", ptab: "PTAB", circuit: "Circuit Court" };
export const levelOrder = (l: Level) => LEVELS.indexOf(l);
