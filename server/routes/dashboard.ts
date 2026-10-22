// The firm dashboard: window watch, pipeline, fee forecast, win rates,
// analyst workload, reassessment exposure and retention. Mounted under
// /api/firm after requireFirmContext. Every query runs inside withContext
// (row-level security) AND filters on firm_id; joins to users match firm_id.
//
// The fee forecast is a projection only. It never creates an invoice:
// invoices are drafted when a decision is processed (build step 6).

import { Router } from "express";
import { withContext } from "../db.js";
import { todayIso } from "../today.js";
import { daysBetween, LEVEL_SHORT } from "../deadlines.js";
import { LEVELS, type Level, type Substage } from "../../shared/domain.js";
import { effectiveFee, firstYearFee, type FeeBasis } from "../../shared/fees.js";
import { centsToString, toCents } from "../../shared/money.js";
import { isReassessed, reassessmentLabel } from "../../shared/reassessment.js";
import { DECISION_DAYS_AFTER_WINDOW, FORECAST_MONTHS } from "../../shared/forecast.js";
import { readyToBill } from "../billing/core.js";

export const dashboardRouter = Router();

const PIPELINE_SUBSTAGES: Substage[] = ["under_review", "fairly_assessed", "appeal_filed", "hearing_scheduled", "decision_analysis", "invoice_sent"];
const STALLED_DAYS = 14;
const LEVEL_ORDER = `array_position(ARRAY['assessor','bor','ptab','circuit']::text[], a.level)`;

function addDays(iso: string, days: number): string {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + days));
  return d.toISOString().slice(0, 10);
}
const monthOf = (iso: string) => iso.slice(0, 7);
function addMonths(ym: string, n: number): string {
  const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
const sum = (xs: (string | null)[]) => centsToString(xs.reduce((a, x) => a + (x ? toCents(x) : 0n), 0n));

interface Cur {
  property_id: number; address1: string | null; name: string; city: string | null; county: string; county_id: number;
  township: string | null; township_id: number | null; triad: string | null; asset_type: string; analyst_user_id: number | null;
  analyst_name: string | null; account_name: string; appeal_id: number; level: Level; substage: Substage; status: string;
  assessment_year: number; days: number; estimated_savings: string | null;
}

dashboardRouter.get("/dashboard", async (req, res) => {
  const firmId = req.ctx!.firmId!;
  const today = todayIso();
  const cycle = Number(today.slice(0, 4));

  const d = await withContext(req.ctx!, async (c) => {
    // The current appeal of every active property.
    const cur = (await c.query<Cur>(
      `SELECT DISTINCT ON (p.id) p.id AS property_id, p.address1, p.name, p.city, co.name AS county, p.county_id,
              t.name AS township, p.township_id, t.triad, app_asset_group(p.asset_type, p.units, p.county_id, p.asset_group_override) AS asset_type, p.analyst_user_id, ana.name AS analyst_name, ac.name AS account_name,
              a.id AS appeal_id, a.level, a.substage, a.status, a.assessment_year, a.estimated_savings,
              GREATEST(0, EXTRACT(day FROM now() - a.substage_since))::int AS days
         FROM properties p
         JOIN accounts ac ON ac.firm_id = p.firm_id AND ac.id = p.account_id
         JOIN counties co ON co.id = p.county_id
         LEFT JOIN townships t ON t.id = p.township_id
         LEFT JOIN users ana ON ana.firm_id = p.firm_id AND ana.id = p.analyst_user_id
         JOIN appeals a ON a.firm_id = p.firm_id AND a.property_id = p.id
        WHERE p.firm_id = $1 AND p.status = 'active'
        ORDER BY p.id, a.assessment_year DESC, ${LEVEL_ORDER} DESC`,
      [firmId],
    )).rows;
    const activeProps = (await c.query<{ id: number; asset_type: string; county: string; county_id: number; township: string | null; township_id: number | null; triad: string | null }>(
      `SELECT p.id, app_asset_group(p.asset_type, p.units, p.county_id, p.asset_group_override) AS asset_type, co.name AS county, p.county_id, t.name AS township, p.township_id, t.triad
         FROM properties p JOIN counties co ON co.id = p.county_id LEFT JOIN townships t ON t.id = p.township_id
        WHERE p.firm_id = $1 AND p.status = 'active'`,
      [firmId],
    )).rows;
    const windows = (await c.query<{ id: number; county_id: number; township_id: number | null; county: string; township: string | null; level: Level; assessment_year: number; opens_on: string; closes_on: string; note: string | null }>(
      `SELECT w.id, w.county_id, w.township_id, co.name AS county, t.name AS township, w.level, w.assessment_year, w.opens_on, w.closes_on, w.note
         FROM filing_windows w JOIN counties co ON co.id = w.county_id LEFT JOIN townships t ON t.id = w.township_id
        WHERE w.assessment_year >= $1 ORDER BY w.closes_on, w.opens_on`,
      [cycle - 1],
    )).rows;
    const decided = (await c.query<{ level: Level; status: string; orig_av: string | null; resolved_av: string | null; asset_type: string; township: string | null; analyst_name: string | null }>(
      `SELECT a.level, a.status, a.orig_av, a.resolved_av, app_asset_group(p.asset_type, p.units, p.county_id, p.asset_group_override) AS asset_type, t.name AS township, ana.name AS analyst_name
         FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id
         LEFT JOIN townships t ON t.id = p.township_id
         LEFT JOIN users ana ON ana.firm_id = p.firm_id AND ana.id = p.analyst_user_id
        WHERE a.firm_id = $1 AND a.status IN ('reduced', 'no_change', 'increased', 'dismissed') AND NOT a.exclude_from_totals`,
      [firmId],
    )).rows;
    const forecastRows = (await c.query(
      `SELECT a.id, a.property_id, a.level, a.substage, a.status, a.assessment_year, a.filed_on, a.savings, a.estimated_savings, a.fee_percent,
              p.address1, p.name, p.county_id, p.township_id, p.no_fee, p.fee_percent_first_year, p.fee_percent_refund,
              ac.name AS account_name, ac.no_fee AS account_no_fee, ac.fee_percent_first_year AS account_fee_first_year, ac.fee_percent_refund AS account_fee_refund
         FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id
         JOIN accounts ac ON ac.firm_id = p.firm_id AND ac.id = p.account_id
        WHERE a.firm_id = $1 AND p.status = 'active' AND NOT a.exclude_from_totals
          AND a.substage NOT IN ('invoice_sent', 'pushed_next_level', 'closed', 'fairly_assessed')
          AND a.status IN ('open', 'waiting_decision', 'reduced') AND a.billing_skipped_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.firm_id = a.firm_id AND i.appeal_id = a.id AND i.status <> 'void')`,
      [firmId],
    )).rows;
    const feeDefaults = (await c.query<{ level: Level; percent: string; basis: FeeBasis }>(`SELECT level, percent, basis FROM fee_defaults WHERE firm_id = $1`, [firmId])).rows;
    const users = (await c.query<{ id: number; name: string; role: string }>(
      `SELECT id, name, role FROM users WHERE firm_id = $1 AND active ORDER BY name`, [firmId],
    )).rows;
    const filed = (await c.query<{ analyst_user_id: number | null; n: number; ids: number[] }>(
      `SELECT p.analyst_user_id, count(*)::int AS n, array_agg(DISTINCT p.id) AS ids FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id
        WHERE a.firm_id = $1 AND a.assessment_year = $2
          AND (a.filed_on IS NOT NULL OR a.substage IN ('appeal_filed', 'hearing_scheduled', 'decision_analysis', 'invoice_sent', 'pushed_next_level'))
        GROUP BY p.analyst_user_id`,
      [firmId, cycle],
    )).rows;
    const hearings = (await c.query<{ analyst_user_id: number | null; n: number; ids: number[] }>(
      `SELECT p.analyst_user_id, count(*)::int AS n, array_agg(DISTINCT p.id) AS ids FROM deadlines d JOIN properties p ON p.firm_id = d.firm_id AND p.id = d.property_id
        WHERE d.firm_id = $1 AND d.kind = 'hearing' AND d.status = 'open' AND d.due_on BETWEEN $2 AND $3
        GROUP BY p.analyst_user_id`,
      [firmId, today, addDays(today, 30)],
    )).rows;
    const history = (await c.query<{ property_id: number; earlier: boolean; last_no_change: boolean }>(
      `SELECT p.id AS property_id,
              EXISTS (SELECT 1 FROM appeals x WHERE x.firm_id = p.firm_id AND x.property_id = p.id AND x.assessment_year < $2) AS earlier,
              COALESCE((SELECT x.status = 'no_change' FROM appeals x
                         WHERE x.firm_id = p.firm_id AND x.property_id = p.id AND x.assessment_year < $2
                           AND x.status IN ('reduced', 'no_change', 'increased', 'dismissed')
                         ORDER BY x.assessment_year DESC, array_position(ARRAY['assessor','bor','ptab','circuit']::text[], x.level) DESC LIMIT 1), false) AS last_no_change
         FROM properties p WHERE p.firm_id = $1 AND p.status = 'active'`,
      [firmId, cycle],
    )).rows;
    const inPlay = (await c.query<{ v: string; ids: number[] | null; achieved_ids: number[] | null }>(
      `SELECT COALESCE(sum(estimated_savings), 0)::numeric(14,2) AS v,
              array_agg(DISTINCT property_id) FILTER (WHERE estimated_savings > 0) AS ids,
              (SELECT array_agg(DISTINCT x.property_id) FROM appeals x
                WHERE x.firm_id = $1 AND x.status = 'reduced' AND x.savings > 0 AND NOT x.exclude_from_totals) AS achieved_ids
         FROM appeals
        WHERE firm_id = $1 AND NOT exclude_from_totals AND status IN ('open', 'waiting_decision')
          AND substage NOT IN ('invoice_sent', 'pushed_next_level', 'closed')`,
      [firmId],
    )).rows[0];
    // "Fees ready to bill" is Billing's own figure, so the two pages always agree.
    const billReady = await readyToBill(c, firmId);
    return { cur, activeProps, windows, decided, forecastRows, feeDefaults, users, filed, hearings, history, inPlay, billReady };
  });

  const inTownship = (p: { county_id: number; township_id: number | null }, w: { county_id: number; township_id: number | null }) =>
    p.county_id === w.county_id && (w.township_id === null || p.township_id === w.township_id);
  const short = (x: { address1: string | null; name: string }) => x.address1 || x.name;

  // ---- window watch
  const unfiledIds = new Set<number>();
  const windowWatch = d.windows
    .filter((w) => w.closes_on >= today)
    .map((w) => {
      const taggedProps = d.activeProps.filter((p) => inTownship(p, w));
      const unfiled = d.cur.filter((p) => inTownship(p, w) && p.level === w.level && p.assessment_year === w.assessment_year && p.substage === "under_review");
      const open = w.opens_on <= today;
      if (open) unfiled.forEach((p) => unfiledIds.add(p.property_id));
      return {
        id: w.id, label: `${w.township ?? `${w.county} County`}`, county: w.county, level: w.level, levelShort: LEVEL_SHORT[w.level],
        opens_on: w.opens_on, closes_on: w.closes_on, note: w.note, open,
        days_left: daysBetween(today, w.closes_on), days_to_open: open ? 0 : daysBetween(today, w.opens_on),
        tagged: taggedProps.length, unfiled: unfiled.length,
        tagged_ids: taggedProps.map((p) => p.id), unfiled_ids: unfiled.map((p) => p.property_id),
      };
    })
    .filter((w) => w.tagged > 0);

  // ---- pipeline
  const pipeline = LEVELS.map((level) => {
    const rows = d.cur.filter((p) => p.level === level);
    return {
      level,
      cells: PIPELINE_SUBSTAGES.map((s) => {
        const q = rows.filter((p) => p.substage === s);
        return { substage: s, count: q.length, avgDays: q.length ? Math.round(q.reduce((a, p) => a + p.days, 0) / q.length) : null, ids: q.map((p) => p.property_id) };
      }),
      total: rows.filter((p) => PIPELINE_SUBSTAGES.includes(p.substage)).length,
      ids: rows.filter((p) => PIPELINE_SUBSTAGES.includes(p.substage)).map((p) => p.property_id),
    };
  });
  const stalled = d.cur
    .filter((p) => p.substage === "decision_analysis" && p.days > STALLED_DAYS)
    .map((p) => ({ property_id: p.property_id, short: short(p), days: p.days, level: p.level }));

  // ---- win rate and average reduction
  type Group = { key: string; decided: number; won: number; avgReduction: number | null };
  const winBy = (keyOf: (r: (typeof d.decided)[number]) => string | null): Group[] => {
    const g = new Map<string, { n: number; w: number; red: number[] }>();
    for (const r of d.decided) {
      const k = keyOf(r) ?? "Not set";
      const e = g.get(k) ?? { n: 0, w: 0, red: [] };
      e.n++;
      if (r.status === "reduced") {
        e.w++;
        if (r.orig_av && r.resolved_av && Number(r.orig_av) > 0) e.red.push(((Number(r.orig_av) - Number(r.resolved_av)) / Number(r.orig_av)) * 100);
      }
      g.set(k, e);
    }
    return [...g.entries()]
      .map(([key, e]) => ({ key, decided: e.n, won: e.w, avgReduction: e.red.length ? Math.round((e.red.reduce((a, x) => a + x, 0) / e.red.length) * 10) / 10 : null }))
      .sort((a, b) => b.decided - a.decided || a.key.localeCompare(b.key));
  };
  const winRates = {
    level: winBy((r) => LEVEL_SHORT[r.level]),
    assetType: winBy((r) => r.asset_type.charAt(0).toUpperCase() + r.asset_type.slice(1)),
    township: winBy((r) => r.township),
    analyst: winBy((r) => r.analyst_name),
  };
  const levelWinRate = (level: Level) => {
    const rows = d.decided.filter((r) => r.level === level);
    return rows.length ? rows.filter((r) => r.status === "reduced").length / rows.length : null;
  };

  // ---- fee forecast (Assessor and BOR; PTAB and Court fees come from the refund check)
  const thisMonth = monthOf(today);
  const months = Array.from({ length: FORECAST_MONTHS }, (_, i) => addMonths(thisMonth, i));
  const items: { appeal_id: number; property_id: number; short: string; account: string; level: Level; kind: "decided" | "expected"; month: string; fee: string; likely: string | null; basis: string }[] = [];
  let refundLevelOpen = 0;
  let noFeeSkipped = 0;
  for (const a of d.forecastRows) {
    if (a.level === "ptab" || a.level === "circuit") { refundLevelOpen++; continue; }
    const fee = effectiveFee(a.level, {
      firmDefaults: d.feeDefaults,
      account: { fee_percent_first_year: a.account_fee_first_year, fee_percent_refund: a.account_fee_refund, no_fee: a.account_no_fee },
      property: { fee_percent_first_year: a.fee_percent_first_year, fee_percent_refund: a.fee_percent_refund, no_fee: a.no_fee },
      appeal: { fee_percent: a.fee_percent },
    });
    const decidedIn = a.substage === "decision_analysis" || a.status === "reduced";
    const base = decidedIn && a.status === "reduced" && a.savings && Number(a.savings) > 0 ? a.savings : a.estimated_savings;
    if (!base || Number(base) <= 0) continue;
    if (fee.noFee) { noFeeSkipped++; continue; }
    const amount = firstYearFee(base, fee)!;
    if (decidedIn) {
      items.push({ appeal_id: a.id, property_id: a.property_id, short: short(a), account: a.account_name, level: a.level, kind: "decided", month: thisMonth, fee: amount, likely: amount, basis: a.status === "reduced" ? "Decided, savings recorded" : "Decision in, at estimated savings" });
      continue;
    }
    const w = d.windows.find((x) => inTownship(a, x) && x.level === a.level && x.assessment_year === a.assessment_year)
      ?? null;
    const anchor = w?.closes_on ?? a.filed_on ?? today;
    let expected = addDays(anchor, DECISION_DAYS_AFTER_WINDOW[a.level as "assessor" | "bor"]);
    if (expected < today) expected = today;
    const rate = levelWinRate(a.level);
    items.push({
      appeal_id: a.id, property_id: a.property_id, short: short(a), account: a.account_name, level: a.level, kind: "expected", month: monthOf(expected), fee: amount,
      likely: rate === null ? null : centsToString((toCents(amount) * BigInt(Math.round(rate * 10000)) + 5000n) / 10000n),
      basis: `Expected decision ${monthOf(expected)}, at target`,
    });
  }
  items.sort((x, y) => x.month.localeCompare(y.month) || Number(y.fee) - Number(x.fee));
  const last = months[months.length - 1];
  const forecast = {
    months: months.map((m) => ({
      month: m,
      decided: sum(items.filter((i) => i.kind === "decided" && i.month === m).map((i) => i.fee)),
      expected: sum(items.filter((i) => i.kind === "expected" && i.month === m).map((i) => i.fee)),
      ids: [...new Set(items.filter((i) => i.month === m).map((i) => i.property_id))],
    })),
    readyToBillIds: [...new Set(items.filter((i) => i.kind === "decided").map((i) => i.property_id))],
    nextSixMonthsIds: [...new Set(items.filter((i) => i.month <= months[months.length - 1]).map((i) => i.property_id))],
    later: sum(items.filter((i) => i.month > last).map((i) => i.fee)),
    readyToBill: sum(items.filter((i) => i.kind === "decided").map((i) => i.fee)),
    nextSixMonths: sum(items.filter((i) => i.month <= last).map((i) => i.fee)),
    likelySixMonths: items.some((i) => i.kind === "expected" && i.likely === null) ? null : sum(items.filter((i) => i.month <= last).map((i) => i.likely)),
    winRateUsed: { assessor: levelWinRate("assessor"), bor: levelWinRate("bor") },
    items,
    refundLevelOpen,
    noFeeSkipped,
    assumptions: DECISION_DAYS_AFTER_WINDOW,
  };

  // ---- analyst workload
  const analystIds = new Set<number>([...d.users.filter((u) => u.role === "analyst").map((u) => u.id), ...d.cur.map((p) => p.analyst_user_id).filter((x): x is number => x !== null)]);
  const workload = d.users
    .filter((u) => analystIds.has(u.id))
    .map((u) => ({
      user_id: u.id, name: u.name,
      open: d.cur.filter((p) => p.analyst_user_id === u.id && !["invoice_sent"].includes(p.substage)).length,
      openIds: d.cur.filter((p) => p.analyst_user_id === u.id && !["invoice_sent"].includes(p.substage)).map((p) => p.property_id),
      filedThisCycle: d.filed.find((f) => f.analyst_user_id === u.id)?.n ?? 0,
      filedIds: d.filed.find((f) => f.analyst_user_id === u.id)?.ids ?? [],
      hearings30: d.hearings.find((h) => h.analyst_user_id === u.id)?.n ?? 0,
      hearingIds: d.hearings.find((h) => h.analyst_user_id === u.id)?.ids ?? [],
    }));

  // ---- reassessment exposure next year
  const nextYear = cycle + 1;
  const exposed = d.activeProps.filter((p) => isReassessed(p.county, p.triad, nextYear));
  const reassessment = {
    year: nextYear,
    label: reassessmentLabel(nextYear),
    properties: exposed.length,
    ids: exposed.map((p) => p.id),
    townships: [...new Set(exposed.map((p) => p.township ?? `${p.county} County`))].sort(),
  };

  // ---- retention
  const curById = new Map(d.cur.map((p) => [p.property_id, p]));
  const atRisk = d.history
    .filter((h) => h.last_no_change || curById.get(h.property_id)?.substage === "fairly_assessed")
    .map((h) => {
      const p = curById.get(h.property_id);
      return { property_id: h.property_id, short: p ? short(p) : "", reason: p?.substage === "fairly_assessed" ? "Fairly assessed this cycle" : "No change last cycle" };
    })
    .filter((x) => x.short);
  const retention = {
    active: d.activeProps.length,
    carriedOver: d.history.filter((h) => h.earlier).length,
    carriedOverIds: d.history.filter((h) => h.earlier).map((h) => h.property_id),
    atRiskIds: atRisk.map((r) => r.property_id),
    atRisk,
  };

  const billable = new Set(d.billReady.map((r) => r.appealId));
  const pending = items.filter((i) => i.kind === "decided" && !billable.has(i.appeal_id));

  // ---- counts
  const byAssetType = ["residential", "commercial", "industrial"].map((t) => ({ type: t, count: d.activeProps.filter((p) => p.asset_type === t).length }));
  const byLevel = LEVELS.map((l) => ({ level: l, count: d.cur.filter((p) => p.level === l).length }));
  const nextClose = windowWatch.find((w) => w.open && w.unfiled > 0) ?? windowWatch.find((w) => w.open) ?? null;

  res.json({
    today,
    cycle,
    kpis: {
      unfiled: unfiledIds.size,
      savingsInPlay: d.inPlay.v,
      readyToBill: sum(d.billReady.map((r) => r.fee)),
      // Decisions in but not billable yet (outcome or tax figures still to enter), at estimated savings.
      decisionsPending: sum(pending.map((i) => i.fee)),
      decisionsPendingCount: pending.length,
      forecastSixMonths: forecast.nextSixMonths,
      stalled: stalled.length,
    },
    // Property ids behind each headline number, so the dashboard can link to exactly those properties.
    links: {
      unfiled: [...unfiledIds],
      inPlay: d.inPlay.ids ?? [],
      achieved: d.inPlay.achieved_ids ?? [],
      readyToBill: [...new Set(d.billReady.map((r) => r.propertyId))],
      forecastSixMonths: forecast.nextSixMonthsIds,
    },
    nextClose,
    windowWatch,
    byAssetType,
    byLevel,
    pipeline,
    stalled,
    winRates,
    forecast,
    workload,
    reassessment,
    retention,
  });
});
