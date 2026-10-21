// Matches a decision letter to its property and appeal, and cross-checks it
// against the matter: PIN, assessment year, level, county, docket or complaint
// number, the values going in, the arithmetic on the letter, and a locked
// stipulation. Each finding is a check:
//   ok      fine, shown with a tick
//   note    worth knowing, doesn't stop "Apply all that matched cleanly"
//   review  a person should look before it's applied (Apply after review)
//   block   it can't be applied until the letter or the matter is corrected
// Runs inside the caller's withContext; every query filters on firm_id.

import type pg from "pg";
import { LEVEL_LABELS, pinKey, type Level } from "../../shared/domain.js";
import { centsToString, formatValueAmount, toCents } from "../../shared/money.js";
import { requestedAchieved, splitAgreedTotal } from "../../shared/pins.js";
import { sameCycle } from "../../shared/reassessment.js";
import { loadPins, pinStage, syncPins, type PinRow } from "../appeal-pins.js";
import type { LetterFields, LetterKind } from "./parse.js";

export type CheckLevel = "ok" | "note" | "review" | "block";
export interface Check { key: string; level: CheckLevel; text: string }

/** Which letter PIN goes to which of the appeal's PINs, and the decided values it gives that PIN. */
export interface PinPlan {
  appealPinId: number; parcelId: number; pin: string;
  origAv: string | null;                     // from the letter, when it prints one
  land: string | null; impr: string | null; av: string;
  onAppeal: boolean;
}

export interface MatchResult {
  propertyId: number | null;
  appealId: number | null;
  status: "review" | "clean";
  checks: Check[];
  plan: PinPlan[];
  summary: { original: string | null; decided: string | null; target: string | null; achieved: string | null } | null;
}

export interface MatchInput {
  fields: LetterFields;
  confidence: number | null;
  hintPropertyId: number | null;
  chosenAppealId: number | null;
  letterId: number | null;
}

const LEVEL_OF: Record<Exclude<LetterKind, "unknown">, Level> = { assessor: "assessor", bor: "bor", ptab: "ptab", circuit: "circuit" };
const DECIDED = ["reduced", "no_change", "increased"];
const OPEN = ["open", "waiting_decision"];
const LOW_CONFIDENCE = 60;
const $ = (v: string | null) => formatValueAmount(v);
const same = (a: string | null, b: string | null) => a !== null && b !== null && toCents(a) === toCents(b);
const normRef = (s: string | null | undefined) => (s ?? "").replace(/\s/g, "").toUpperCase();

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

interface AppealRow {
  id: number; property_id: number; parcel_id: number | null; assessment_year: number; level: Level; status: string; substage: string;
  petition_no: string | null; external_id: string | null; decision_on: string | null; stipulation_locked_at: string | null;
  county: string; triad: string | null;
}

async function loadAppeal(c: pg.PoolClient, firmId: number, id: number): Promise<AppealRow | null> {
  return (await c.query<AppealRow>(
    `SELECT a.id, a.property_id, a.parcel_id, a.assessment_year, a.level, a.status, a.substage, a.petition_no, a.external_id,
            a.decision_on, a.stipulation_locked_at, co.name AS county, t.triad
       FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id
       JOIN counties co ON co.id = p.county_id LEFT JOIN townships t ON t.id = p.township_id
      WHERE a.firm_id = $1 AND a.id = $2`,
    [firmId, id],
  )).rows[0] ?? null;
}

export async function matchLetter(c: pg.PoolClient, firmId: number, input: MatchInput): Promise<MatchResult> {
  const f = input.fields;
  const checks: Check[] = [];
  const add = (key: string, level: CheckLevel, text: string) => checks.push({ key, level, text });
  const done = (propertyId: number | null, appealId: number | null, plan: PinPlan[] = [], summary: MatchResult["summary"] = null): MatchResult => ({
    propertyId, appealId, plan, summary, checks,
    status: checks.some((x) => x.level === "review" || x.level === "block") ? "review" : "clean",
  });

  for (const p of f.problems ?? []) add("read", "review", p);
  if (input.confidence !== null && input.confidence < LOW_CONFIDENCE) {
    add("confidence", "review", `Hard to read (${Math.round(input.confidence)}% confidence). Check the figures against the scan.`);
  }
  if (f.kind === "unknown") { add("kind", "block", "Say what kind of letter this is."); return done(null, null); }
  const level = LEVEL_OF[f.kind];

  // ---------------------------------------------------------- PINs to parcels
  const pinsRead = f.pins.filter((p) => p.pin);
  const parcels = pinsRead.length
    ? (await c.query<{ id: number; property_id: number; pin: string; pin_key: string }>(
        `SELECT id, property_id, pin, pin_key FROM parcels WHERE firm_id = $1 AND pin_key = ANY($2::text[])`,
        [firmId, pinsRead.map((p) => pinKey(p.pin!))],
      )).rows
    : [];
  const parcelFor = (pin: string) => parcels.find((x) => x.pin_key === pinKey(pin)) ?? null;
  for (const p of pinsRead) {
    if (parcelFor(p.pin!)) continue;
    const all = (await c.query<{ pin: string; pin_key: string }>(`SELECT pin, pin_key FROM parcels WHERE firm_id = $1`, [firmId])).rows;
    const near = all.map((x) => ({ x, d: distance(x.pin_key, pinKey(p.pin!)) })).filter((x) => x.d <= 2).sort((a, b) => a.d - b.d)[0];
    add("pin", "block", `PIN ${p.pin} isn't on any of your properties.${near ? ` The closest is ${near.x.pin}; correct the PIN if the scan misread it.` : ""}`);
  }
  if (f.pins.length > 0 && !pinsRead.length) add("pin", "review", "Couldn't read the PIN on the letter.");

  // ---------------------------------------------------------- the property
  let propertyId: number | null = null;
  let appeal: AppealRow | null = null;
  const props = [...new Set(parcels.map((x) => x.property_id))];
  if (props.length > 1) { add("property", "block", "The PINs on this letter belong to different properties."); return done(null, null); }
  if (input.chosenAppealId) {
    appeal = await loadAppeal(c, firmId, input.chosenAppealId);
    if (appeal) { propertyId = appeal.property_id; add("appeal", "ok", "Appeal chosen by hand."); }
  }
  if (!appeal && props.length === 1) propertyId = props[0];
  if (!appeal && !propertyId && f.reference) {
    const col = level === "assessor" ? "external_id" : "petition_no";
    const byRef = (await c.query<{ id: number }>(
      `SELECT id FROM appeals WHERE firm_id = $1 AND level = $2 AND upper(regexp_replace(${col}, '\\s', '', 'g')) = $3`,
      [firmId, level, normRef(f.reference)],
    )).rows;
    if (byRef.length === 1) {
      appeal = await loadAppeal(c, firmId, byRef[0].id);
      propertyId = appeal!.property_id;
      add("reference", "ok", `Matched by ${level === "ptab" ? "docket" : level === "assessor" ? "appeal" : level === "bor" ? "complaint" : "objection"} number ${f.reference}.`);
    }
  }
  if (input.hintPropertyId) {
    if (propertyId && propertyId !== input.hintPropertyId) { add("property", "block", "This letter is for a different property than the one it was uploaded from."); return done(propertyId, null); }
    if (!propertyId) { propertyId = input.hintPropertyId; add("property", "note", "Matched to the property it was uploaded from."); }
  }
  if (!propertyId) { add("property", "block", "Couldn't match this letter to a property. Correct the PIN or choose the appeal."); return done(null, null); }

  const prop = (await c.query<{ county: string }>(
    `SELECT co.name AS county FROM properties p JOIN counties co ON co.id = p.county_id WHERE p.firm_id = $1 AND p.id = $2`, [firmId, propertyId],
  )).rows[0];
  if (f.county && prop && f.county.toLowerCase() !== prop.county.toLowerCase()) add("county", "review", `The letter is from ${f.county} County; the property is in ${prop.county} County.`);

  // ---------------------------------------------------------- the appeal
  if (!appeal) {
    if (!f.year) { add("year", "block", "Couldn't read the assessment year. Enter it to find the appeal."); return done(propertyId, null); }
    const rows = (await c.query<{ id: number; parcel_id: number | null }>(
      `SELECT id, parcel_id FROM appeals WHERE firm_id = $1 AND property_id = $2 AND assessment_year = $3 AND level = $4 ORDER BY (parcel_id IS NULL) DESC, id`,
      [firmId, propertyId, f.year, level],
    )).rows;
    const parcelIds = new Set(parcels.map((x) => x.id));
    const pick = rows.find((r) => r.parcel_id === null) ?? rows.find((r) => r.parcel_id !== null && parcelIds.has(r.parcel_id)) ?? rows[0];
    if (!pick) { add("appeal", "block", `There's no ${f.year} ${LEVEL_LABELS[level]} appeal on this property. Create it, then check again.`); return done(propertyId, null); }
    appeal = await loadAppeal(c, firmId, pick.id);
  }
  const a = appeal!;
  if (a.level !== level) add("level", "block", `The letter is a ${LEVEL_LABELS[level]} decision; the chosen appeal is at ${LEVEL_LABELS[a.level]}.`);
  if (f.year && a.assessment_year !== f.year) add("year", "review", `The letter is for ${f.year}; the chosen appeal is ${a.assessment_year}.`);

  // Another letter already applied to this appeal for the same PINs: a second copy.
  const applied = (await c.query<{ id: number; parcels: number[] | null }>(
    `SELECT id, before_apply->'parcels' AS parcels FROM decision_letters WHERE firm_id = $1 AND appeal_id = $2 AND status = 'applied' AND id <> $3`,
    [firmId, a.id, input.letterId ?? 0],
  )).rows;
  const covered = new Set(applied.flatMap((x) => x.parcels ?? []));

  // ---------------------------------------------------------- PINs on the appeal
  await syncPins(c, firmId, a.id);
  const pins = await loadPins(c, firmId, a.id);
  const onAppeal = pins.filter((p) => p.on_appeal);
  const plan: PinPlan[] = [];
  const rowFor = (parcelId: number) => pins.find((p) => p.parcel_id === parcelId) ?? null;
  const decided = (lp: LetterFields["pins"][number]) => lp.av ?? (lp.land && lp.impr ? centsToString(toCents(lp.land) + toCents(lp.impr)) : null);

  const letterPins = f.pins.length ? f.pins : [{ pin: null, origAv: null, land: null, impr: null, av: null }];
  if (f.total && f.pins.length > 1) {
    // One decided total for several PINs: divided among them the firm's way.
    const rows = f.pins.map((lp) => (lp.pin && parcelFor(lp.pin) ? rowFor(parcelFor(lp.pin)!.id) : null));
    if (rows.some((r) => !r) || !f.total.av) {
      add("pins", "block", "Every PIN under the decided total needs to be on this appeal, with the total readable.");
    } else {
      const orig = rows.map((r) => pinStage(r!, "orig"));
      if (orig.some((o) => o.av === null)) add("pins", "block", "Each PIN needs its original AV on the appeal before a total can be divided.");
      else {
        const parts = splitAgreedTotal(rows.map((r, i) => ({ key: r!.id, land: orig[i].land, impr: orig[i].impr, av: orig[i].av })), f.total.av);
        parts.forEach((p, i) => plan.push({ appealPinId: rows[i]!.id, parcelId: rows[i]!.parcel_id, pin: rows[i]!.pin, origAv: null, land: p.land, impr: p.impr, av: p.av, onAppeal: rows[i]!.on_appeal }));
        add("pins", "note", `The decided total ${$(f.total.av)} is divided among ${rows.length} PINs in proportion to their original values.`);
      }
    }
  } else {
    for (const lp of letterPins) {
      let row: PinRow | null = null;
      if (lp.pin) row = parcelFor(lp.pin) ? rowFor(parcelFor(lp.pin)!.id) : null;
      else if (onAppeal.length === 1) row = onAppeal[0];
      else if (!lp.pin && onAppeal.length > 1) { add("pins", "block", "This appeal has several PINs. Enter the PIN this letter is for."); continue; }
      if (!row) continue;
      const av = decided(lp);
      if (av === null) { add("values", "block", `Couldn't read the decided value${lp.pin ? ` for ${lp.pin}` : ""}.`); continue; }
      plan.push({ appealPinId: row.id, parcelId: row.parcel_id, pin: row.pin, origAv: lp.origAv, land: lp.land, impr: lp.impr, av, onAppeal: row.on_appeal });
    }
  }

  for (const p of plan) {
    const row = pins.find((r) => r.id === p.appealPinId)!;
    const orig = pinStage(row, "orig").av;
    if (!p.onAppeal) add("on-appeal", "review", `PIN ${p.pin} isn't marked as on this appeal. Applying adds it.`);
    if (p.origAv !== null && orig !== null && !same(p.origAv, orig)) {
      add("original", "review", `The letter's starting AV for ${p.pin} is ${$(p.origAv)}; the appeal has ${$(orig)}.`);
    } else if (p.origAv !== null && orig === null) add("original", "note", `The appeal had no original AV for ${p.pin}; the letter's ${$(p.origAv)} will be used.`);
    else if (p.origAv !== null) add("original", "ok", `Starting AV ${$(orig)} matches the appeal.`);
    if (p.land !== null && p.impr !== null && !same(centsToString(toCents(p.land) + toCents(p.impr)), p.av)) {
      add("arithmetic", "review", `Land ${$(p.land)} and building ${$(p.impr)} don't add up to the total ${$(p.av)}.`);
    }
    const lockedRow = a.stipulation_locked_at ? row : null;
    if (lockedRow) {
      const locked = lockedRow.resolved_av;
      if (same(locked, p.av)) add("stipulation", "ok", `Matches the locked stipulation for ${p.pin}.`);
      else add("stipulation", "review", `Differs from the locked stipulation for ${p.pin}: the letter says ${$(p.av)}, the stipulation ${$(locked)}.`);
    }
    if (covered.has(p.parcelId)) add("duplicate", "block", `A letter for ${p.pin} on this appeal was already applied. This looks like a second copy; dismiss it, or undo the other one first.`);
  }
  if (!plan.length && !checks.some((x) => x.level === "block")) add("values", "block", "Nothing on the letter lines up with a PIN on this appeal.");

  // BOR: the change column; Circuit: the excess and the refund.
  for (const lp of f.pins) {
    if (f.kind === "bor" && lp.change && lp.origAv && lp.av && toCents(lp.origAv) - toCents(lp.av) !== toCents(lp.change)) {
      add("arithmetic", "review", `The change column (${$(lp.change)}) doesn't match ${$(lp.origAv)} less ${$(lp.av)}.`);
    }
  }
  if (f.kind === "circuit") {
    const lp = f.pins[0];
    if (lp?.origAv && lp.av && f.excessAv && toCents(lp.origAv) - toCents(lp.av) !== toCents(f.excessAv)) {
      add("arithmetic", "review", `The excess AV (${$(f.excessAv)}) doesn't match ${$(lp.origAv)} less ${$(lp.av)}.`);
    }
    if (f.excessAv && f.equalizer && f.taxRatePercent && f.refund) {
      const eav = Math.floor(Number(f.excessAv) * Number(f.equalizer));
      const expect = Math.round(eav * Number(f.taxRatePercent)) / 100;
      if (Math.abs(expect - Number(f.refund)) > 1) add("refund", "note", `The refund ${formatValueAmount(f.refund, true)} differs from the excess AV times the factor and rate (about ${formatValueAmount(expect.toFixed(2), true)}). The order's figure is used.`);
      else add("refund", "ok", `Refund ${formatValueAmount(f.refund, true)} checks against the excess AV, factor and rate.`);
    }
  }

  // ---------------------------------------------------------- outcome against the numbers
  const origTotal = plan.length ? plan.reduce<bigint | null>((acc, p) => {
    const o = p.origAv ?? pinStage(pins.find((r) => r.id === p.appealPinId)!, "orig").av;
    return acc === null || o === null ? null : acc + toCents(o);
  }, 0n) : null;
  const decidedTotal = plan.length ? plan.reduce((acc, p) => acc + toCents(p.av), 0n) : null;
  if (origTotal !== null && decidedTotal !== null) {
    const byNumbers = decidedTotal < origTotal ? "reduced" : decidedTotal > origTotal ? "increased" : "no_change";
    if (byNumbers === "increased") add("outcome", "review", "The decided value is higher than the value going in. Check before applying.");
    else if (f.outcome === "no_change" && byNumbers !== "no_change") add("outcome", "review", `The letter says no change, but the values differ (${$(centsToString(origTotal))} to ${$(centsToString(decidedTotal))}).`);
    else if (f.outcome === "reduced" && byNumbers !== "reduced") add("outcome", "review", "The letter says reduced, but the values aren't lower.");
    else if (f.outcome === "increased") add("outcome", "review", "The letter says the value was increased. Check before applying.");
  }
  if (f.outcome === "agreed" && !a.stipulation_locked_at) add("stipulation", "note", "Decided by agreement of the parties; there's no locked stipulation to compare it with.");

  // ---------------------------------------------------------- reference numbers
  if (level === "ptab" && f.reference) {
    if (!a.petition_no) add("docket", "note", `Docket ${f.reference} will be saved to the appeal.`);
    else if (normRef(a.petition_no) === normRef(f.reference)) add("docket", "ok", `Docket ${f.reference} matches the appeal.`);
    else add("docket", "review", `Docket ${f.reference} doesn't match the appeal's ${a.petition_no}.`);
  }
  if ((level === "bor" || level === "circuit") && f.reference) {
    if (!a.petition_no) add("reference", "note", `${level === "bor" ? "Complaint" : "Objection"} number ${f.reference} will be saved to the appeal.`);
    else if (normRef(a.petition_no) !== normRef(f.reference)) add("reference", "note", `The letter's ${level === "bor" ? "complaint" : "objection"} number ${f.reference} differs from the appeal's ${a.petition_no}. The appeal's is kept.`);
  }
  if (level === "assessor" && f.reference && a.external_id && normRef(a.external_id) !== normRef(f.reference)) {
    add("reference", "note", `The letter's appeal number ${f.reference} differs from the appeal's ${a.external_id}. The appeal's is kept.`);
  }

  // ---------------------------------------------------------- the appeal's state
  if (DECIDED.includes(a.status) && !covered.size) add("decided", "review", "The appeal already shows a decision. Applying replaces it with the letter's values.");
  else if (!OPEN.includes(a.status)) add("decided", "review", `The appeal is marked ${a.status}. Check before applying.`);

  // Pending PTABs get extra scrutiny: an undecided PTAB earlier in the cycle will set this year's value.
  const pending = (await c.query<{ assessment_year: number }>(
    `SELECT assessment_year FROM appeals WHERE firm_id = $1 AND property_id = $2 AND level = 'ptab' AND status = ANY($3::text[]) AND assessment_year < $4 AND id <> $5`,
    [firmId, propertyId, OPEN, a.assessment_year, a.id],
  )).rows.filter((r) => sameCycle(a.county, a.triad, r.assessment_year, a.assessment_year));
  if (pending.length) add("pending-ptab", "review", `A ${pending.map((r) => r.assessment_year).join(" and ")} PTAB appeal is still pending in this reassessment cycle. When it's decided, its value carries into ${a.assessment_year}.`);

  const others = onAppeal.filter((r) => !plan.some((p) => p.appealPinId === r.id) && !covered.has(r.parcel_id));
  if (plan.length && others.length) add("partial", "note", `This letter covers ${plan.length} of ${plan.length + others.length} PINs on the appeal. It's decided when the rest arrive.`);

  // Of the requested reduction.
  let summary: MatchResult["summary"] = null;
  if (plan.length && origTotal !== null) {
    const targets = plan.map((p) => pins.find((r) => r.id === p.appealPinId)!.target_av);
    const target = targets.every((t) => t !== null) ? centsToString(targets.reduce((acc, t) => acc + toCents(t!), 0n)) : null;
    const achieved = requestedAchieved(centsToString(origTotal), target, centsToString(decidedTotal!));
    summary = { original: centsToString(origTotal), decided: centsToString(decidedTotal!), target, achieved };
    if (achieved) add("requested", "note", `${achieved} of the requested reduction (asked ${$(target)}, decided ${$(centsToString(decidedTotal!))}).`);
  }
  return done(propertyId, a.id, plan, summary);
}
