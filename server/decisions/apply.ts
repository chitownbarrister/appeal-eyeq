// Applying a decision letter to its appeal, and undoing that. Runs inside the
// caller's withContext; every query filters on firm_id.
//
// Applying writes each PIN's decided values (PTAB gives land and building; the
// other letters give the total, so land is held and the building takes the change,
// the firm's method), fills the docket or complaint number when the appeal has none,
// sets the decision date, and once every PIN on the appeal is decided, the result
// (reduced, no change, increased) and the Decision analysis substage. A reduction at
// PTAB or the Circuit Court is marked Awaiting refund. A decided PTAB carries forward
// to later appeals in the same reassessment cycle.

import type pg from "pg";
import type { Level } from "../../shared/domain.js";
import { centsToString, toCents } from "../../shared/money.js";
import { applyRollover, loadPins, pinTotals, refreshAppealFromPins, writePinStage } from "../appeal-pins.js";
import { todayIso } from "../today.js";
import { matchLetter, type MatchResult } from "./match.js";
import { draftInvoice } from "../billing/core.js";
import type { LetterFields } from "./parse.js";

export type NextStep = "start_bor" | "bor_judgment" | "invoice" | "awaiting_refund" | "waiting_rest" | null;

const APPEAL_SNAPSHOT_COLS = [
  "status", "substage", "substage_since", "decision_on", "petition_no", "external_id",
  "refund_status", "refund_expected", "stipulation_locked_at", "stipulation_locked_by",
] as const;
const PIN_SNAPSHOT_COLS = ["on_appeal", "orig_land_av", "orig_impr_av", "orig_av", "resolved_land_av", "resolved_impr_av", "resolved_av"] as const;

export interface LetterRow {
  id: number; upload_id: number; kind: string; status: string; fields: LetterFields; confidence: string | null;
  property_id: number | null; appeal_id: number | null; appeal_chosen: boolean; checks: unknown; hint_property_id: number | null;
  applied_at: string | null; before_apply: Snapshot | null;
}

/** What applying replaced (for Undo), and which of the appeal's parcels this letter decided. */
interface Snapshot { appeal: Record<string, unknown>; pins: Record<string, unknown>[]; parcels: number[] }

export async function loadLetter(c: pg.PoolClient, firmId: number, id: number, lock = false): Promise<LetterRow | null> {
  return (await c.query<LetterRow>(
    `SELECT l.*, u.property_id AS hint_property_id FROM decision_letters l JOIN decision_uploads u ON u.firm_id = l.firm_id AND u.id = l.upload_id
      WHERE l.firm_id = $1 AND l.id = $2 ${lock ? "FOR UPDATE OF l" : ""}`,
    [firmId, id],
  )).rows[0] ?? null;
}

export function matchInputFor(l: LetterRow) {
  return {
    fields: l.fields, confidence: l.confidence === null ? null : Number(l.confidence), hintPropertyId: l.hint_property_id,
    chosenAppealId: l.appeal_chosen ? l.appeal_id : null, letterId: l.id,
  };
}

/** Re-checks an unapplied letter and stores the result, writing only when something changed. */
export async function refreshMatch(c: pg.PoolClient, firmId: number, l: LetterRow): Promise<MatchResult> {
  const m = await matchLetter(c, firmId, matchInputFor(l));
  if (l.status === "applied" || l.status === "dismissed") return m;
  const changed = l.status !== m.status || l.property_id !== m.propertyId || (!l.appeal_chosen && l.appeal_id !== m.appealId)
    || JSON.stringify(l.checks) !== JSON.stringify(m.checks);
  if (changed) {
    await c.query(
      `UPDATE decision_letters SET status = $3, property_id = $4, appeal_id = $5, checks = $6 WHERE firm_id = $1 AND id = $2`,
      [firmId, l.id, m.status, m.propertyId, l.appeal_chosen ? l.appeal_id : m.appealId, JSON.stringify(m.checks)],
    );
    Object.assign(l, { status: m.status, property_id: m.propertyId, appeal_id: l.appeal_chosen ? l.appeal_id : m.appealId, checks: m.checks });
  }
  return m;
}

function httpError(status: number, publicMessage: string): Error {
  return Object.assign(new Error(publicMessage), { status, publicMessage });
}

/** What to do next once a level is decided. */
export function nextStepFor(level: Level, status: string, allDecided: boolean): NextStep {
  if (!allDecided) return "waiting_rest";
  if (level === "assessor") return "start_bor";
  if (level === "bor") return status === "reduced" ? "invoice" : "bor_judgment";
  if ((level === "ptab" || level === "circuit") && status === "reduced") return "awaiting_refund";
  return null;
}

export interface ApplyResult { letterId: number; appealId: number; propertyId: number; level: Level; status: string; allDecided: boolean; nextStep: NextStep; unlocked: boolean }

/**
 * Applies one letter. A letter with "review" checks needs `acknowledged` (a person looked);
 * one with a "block" check can't be applied at all.
 */
export async function applyLetter(c: pg.PoolClient, firmId: number, userId: number, letterId: number, acknowledged: boolean): Promise<ApplyResult> {
  const l = await loadLetter(c, firmId, letterId, true);
  if (!l) throw httpError(404, "Letter not found.");
  if (l.status === "applied") throw httpError(409, "This letter is already applied.");
  if (l.status === "dismissed") throw httpError(409, "This letter was dismissed. Restore it first.");
  const m = await refreshMatch(c, firmId, l);
  const blocked = m.checks.find((x) => x.level === "block");
  if (blocked) throw httpError(409, blocked.text);
  if (m.status === "review" && !acknowledged) throw httpError(409, "This letter has items to review. Check them, then apply.");
  const appealId = m.appealId!;
  const a = (await c.query(`SELECT * FROM appeals WHERE firm_id = $1 AND id = $2 FOR UPDATE`, [firmId, appealId])).rows[0];
  const f = l.fields;

  // What this replaces, for Undo.
  const before: Snapshot = {
    appeal: Object.fromEntries(APPEAL_SNAPSHOT_COLS.map((k) => [k, a[k]])),
    pins: (await c.query(`SELECT id, ${PIN_SNAPSHOT_COLS.join(", ")} FROM appeal_pins WHERE firm_id = $1 AND appeal_id = $2`, [firmId, appealId])).rows,
    parcels: m.plan.map((p) => p.parcelId),
  };

  let unlocked = false;
  if (a.stipulation_locked_at && m.checks.some((x) => x.key === "stipulation" && x.level === "review")) {
    // The tribunal's letter is the official result; the lock gives way to it.
    await c.query(`UPDATE appeals SET stipulation_locked_at = NULL, stipulation_locked_by = NULL WHERE firm_id = $1 AND id = $2`, [firmId, appealId]);
    unlocked = true;
  }
  for (const p of m.plan) {
    if (!p.onAppeal) await c.query(`UPDATE appeal_pins SET on_appeal = true WHERE firm_id = $1 AND id = $2`, [firmId, p.appealPinId]);
    const row = (await c.query(`SELECT orig_av FROM appeal_pins WHERE firm_id = $1 AND id = $2`, [firmId, p.appealPinId])).rows[0];
    if (row.orig_av === null && p.origAv !== null) await writePinStage(c, firmId, p.appealPinId, "orig", { av: p.origAv });
    if (p.land !== null && p.impr !== null) await writePinStage(c, firmId, p.appealPinId, "resolved", { land: p.land, impr: p.impr });
    else await writePinStage(c, firmId, p.appealPinId, "resolved", { av: p.av });
  }

  const sets: Record<string, unknown> = { decision_on: f.letterDate ?? todayIso() };
  if (f.reference) {
    if (a.level === "assessor" && !a.external_id) sets.external_id = f.reference.slice(0, 60);
    if (a.level !== "assessor" && !a.petition_no) sets.petition_no = f.reference.slice(0, 60);
  }
  await c.query(
    `UPDATE appeals SET ${Object.keys(sets).map((k, i) => `${k} = $${i + 3}`).join(", ")} WHERE firm_id = $1 AND id = $2`,
    [firmId, appealId, ...Object.values(sets)],
  );
  const updated = await refreshAppealFromPins(c, firmId, appealId);

  // Decided once a letter has come in for every PIN on the appeal (one letter per PIN is the norm;
  // figures typed in or locked as a stipulation don't count until the tribunal's letter confirms them).
  const pins = await loadPins(c, firmId, appealId);
  const on = pins.filter((p) => p.on_appeal);
  const covered = new Set([...(await decidedParcels(c, firmId, appealId, l.id)), ...before.parcels]);
  const allDecided = on.length > 0 && on.every((p) => p.resolved_av !== null && covered.has(p.parcel_id));
  let status = a.status as string;
  if (allDecided) {
    const { totals } = pinTotals(pins);
    const o = totals.orig.av, r = totals.resolved.av;
    status = o !== null && r !== null ? (toCents(r) < toCents(o) ? "reduced" : toCents(r) > toCents(o) ? "increased" : "no_change") : f.outcome === "no_change" ? "no_change" : "reduced";
    const refund = (a.level === "ptab" || a.level === "circuit") && status === "reduced";
    let expected: string | null = null;
    if (refund) {
      // Circuit Court orders state the refund; for PTAB it's the tax saved for that year, an estimate until the check arrives.
      const fromOrders = (await c.query<{ refund: string | null }>(
        `SELECT fields->>'refund' AS refund FROM decision_letters WHERE firm_id = $1 AND appeal_id = $2 AND status = 'applied' AND id <> $3`, [firmId, appealId, l.id],
      )).rows.map((x) => x.refund).filter((x): x is string => !!x);
      if (a.level === "circuit" && f.refund) expected = centsToString([...fromOrders, f.refund].reduce((acc, x) => acc + toCents(x), 0n));
      else expected = (updated.savings as string | null) ?? null;
    }
    await c.query(
      `UPDATE appeals SET status = $3,
              substage = CASE WHEN substage IN ('invoice_sent', 'pushed_next_level', 'closed') THEN substage ELSE 'decision_analysis' END,
              substage_since = CASE WHEN substage IN ('invoice_sent', 'pushed_next_level', 'closed', 'decision_analysis') THEN substage_since ELSE now() END,
              refund_status = CASE WHEN $4 THEN COALESCE(refund_status, 'awaiting') ELSE refund_status END,
              refund_expected = CASE WHEN $4 THEN $5 ELSE refund_expected END
        WHERE firm_id = $1 AND id = $2`,
      [firmId, appealId, status, refund, expected],
    );
  } else if (a.status === "open") {
    status = "waiting_decision";
    await c.query(`UPDATE appeals SET status = 'waiting_decision' WHERE firm_id = $1 AND id = $2`, [firmId, appealId]);
  }
  if (a.level === "ptab") await applyRollover(c, firmId, appealId);
  // A reduction at the Assessor or Board of Review drafts its invoice (nothing is sent until someone sends it).
  if (allDecided && status === "reduced" && (a.level === "assessor" || a.level === "bor")) await draftInvoice(c, firmId, userId, appealId);

  await c.query(
    `UPDATE decision_letters SET status = 'applied', applied_by = $3, applied_at = now(), before_apply = $4, property_id = $5, appeal_id = $6, checks = $7
      WHERE firm_id = $1 AND id = $2`,
    [firmId, l.id, userId, JSON.stringify(before), m.propertyId, appealId, JSON.stringify(m.checks)],
  );
  return { letterId: l.id, appealId, propertyId: m.propertyId!, level: a.level, status, allDecided, nextStep: nextStepFor(a.level, status, allDecided), unlocked };
}

/** The parcels already decided on an appeal by its other applied letters. */
export async function decidedParcels(c: pg.PoolClient, firmId: number, appealId: number, exceptLetterId: number | null): Promise<number[]> {
  const rows = (await c.query<{ parcels: number[] | null }>(
    `SELECT before_apply->'parcels' AS parcels FROM decision_letters WHERE firm_id = $1 AND appeal_id = $2 AND status = 'applied' AND id <> $3`,
    [firmId, appealId, exceptLetterId ?? 0],
  )).rows;
  return rows.flatMap((r) => r.parcels ?? []);
}

/** Puts the appeal back the way it was before this letter, if no later letter has been applied to it since. */
export async function undoLetter(c: pg.PoolClient, firmId: number, letterId: number): Promise<void> {
  const l = await loadLetter(c, firmId, letterId, true);
  if (!l) throw httpError(404, "Letter not found.");
  if (l.status !== "applied" || !l.before_apply || !l.appeal_id) throw httpError(409, "Only an applied letter can be undone.");
  const later = (await c.query(
    `SELECT 1 FROM decision_letters x WHERE x.firm_id = $1 AND x.appeal_id = $2 AND x.status = 'applied' AND x.id <> $3
        AND x.applied_at > (SELECT applied_at FROM decision_letters WHERE firm_id = $1 AND id = $3)`,
    [firmId, l.appeal_id, l.id],
  )).rowCount;
  if (later) throw httpError(409, "A later letter was applied to this appeal. Undo that one first.");
  await c.query(`SELECT 1 FROM appeals WHERE firm_id = $1 AND id = $2 FOR UPDATE`, [firmId, l.appeal_id]);
  // A sent invoice is in the client's hands: undoing the decision under it isn't allowed. A draft just goes.
  const inv = (await c.query<{ status: string }>(`SELECT status FROM invoices WHERE firm_id = $1 AND appeal_id = $2 AND status <> 'void'`, [firmId, l.appeal_id])).rows[0];
  if (inv && inv.status !== "draft") throw httpError(409, `This appeal's invoice is ${inv.status}. Void it in Billing before undoing the letter.`);
  await c.query(`DELETE FROM invoices WHERE firm_id = $1 AND appeal_id = $2 AND status = 'draft'`, [firmId, l.appeal_id]);
  if ((await c.query(`SELECT 1 FROM trust_entries WHERE firm_id = $1 AND appeal_id = $2`, [firmId, l.appeal_id])).rowCount) {
    throw httpError(409, "This appeal's refund is recorded in trust. Take the refund back on Decisions, Awaiting refund before undoing the letter.");
  }
  const snap = l.before_apply;
  const cols = Object.keys(snap.appeal).filter((k) => (APPEAL_SNAPSHOT_COLS as readonly string[]).includes(k));
  await c.query(
    `UPDATE appeals SET ${cols.map((k, i) => `${k} = $${i + 3}`).join(", ")} WHERE firm_id = $1 AND id = $2`,
    [firmId, l.appeal_id, ...cols.map((k) => snap.appeal[k])],
  );
  for (const p of snap.pins) {
    await c.query(
      `UPDATE appeal_pins SET ${PIN_SNAPSHOT_COLS.map((k, i) => `${k} = $${i + 3}`).join(", ")} WHERE firm_id = $1 AND id = $2`,
      [firmId, p.id, ...PIN_SNAPSHOT_COLS.map((k) => p[k])],
    );
  }
  await refreshAppealFromPins(c, firmId, l.appeal_id);
  await c.query(
    `UPDATE decision_letters SET status = 'review', applied_by = NULL, applied_at = NULL, before_apply = NULL WHERE firm_id = $1 AND id = $2`,
    [firmId, l.id],
  );
  const fresh = await loadLetter(c, firmId, l.id);
  await refreshMatch(c, firmId, fresh!);
}

/** Before an appeal or property is deleted: its letters lose the match and go back to review. */
export async function detachLetters(c: pg.PoolClient, firmId: number, where: { appealId?: number; propertyId?: number }): Promise<void> {
  await c.query(
    `UPDATE decision_letters SET appeal_id = NULL, property_id = NULL, appeal_chosen = false, document_id = CASE WHEN $3::int IS NULL THEN document_id END,
            status = CASE WHEN status = 'dismissed' THEN status ELSE 'review' END,
            before_apply = NULL, applied_at = NULL, applied_by = NULL
      WHERE firm_id = $1 AND (appeal_id = $2 OR property_id = $3 OR appeal_id IN (SELECT id FROM appeals WHERE firm_id = $1 AND property_id = $3))`,
    [firmId, where.appealId ?? null, where.propertyId ?? null],
  );
}
