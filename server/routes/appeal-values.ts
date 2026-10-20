// An appeal's values by PIN, the offer trail, dividing an agreed total among
// the PINs, and locking a stipulation. Mounted under /api/firm after
// requireFirmContext. Every query runs inside withContext and filters on firm_id.

import { Router, type Request } from "express";
import type pg from "pg";
import { z } from "zod";
import { withContext } from "../db.js";
import { requirePermission } from "../auth.js";
import { avFromFmv, fmvFromAv, pinAv, requestedAchieved, splitAgreedTotal, sumAvs } from "../../shared/pins.js";
import { centsToString, toCents } from "../../shared/money.js";
import { cycleEnd, cycleStart } from "../../shared/reassessment.js";
import {
  applyRollover, loadPins, pinStage, pinTotals, refreshAppealFromPins, rolloverSuggestion, syncPins, takeRollover, writePinStage, type PinRow,
} from "../appeal-pins.js";
import { httpError } from "./files-common.js";

export const appealValuesRouter = Router();

const money = z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, "Use a number with up to 2 decimals"));
const nullableMoney = money.nullable().or(z.literal("").transform(() => null));
const StageValue = z.object({ land: nullableMoney.optional(), impr: nullableMoney.optional(), av: nullableMoney.optional() }).strict();
const PARTIES = ["firm", "assessor", "board_of_review", "states_attorney", "intervenor", "agreed"] as const;

function appealId(req: Request): number {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, "Invalid appeal.");
  return n;
}

async function loadAppeal(c: pg.PoolClient, firmId: number, id: number) {
  const a = (await c.query(
    `SELECT a.*, co.name AS county, t.triad FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id
       JOIN counties co ON co.id = p.county_id LEFT JOIN townships t ON t.id = p.township_id
      WHERE a.firm_id = $1 AND a.id = $2`,
    [firmId, id],
  )).rows[0];
  if (!a) throw httpError(404, "Appeal not found.");
  return a;
}

const stageOut = (r: PinRow, prefix: "orig" | "target" | "resolved") => {
  const own = { land: (r as unknown as Record<string, string | null>)[`${prefix}_land_av`], impr: (r as unknown as Record<string, string | null>)[`${prefix}_impr_av`], av: (r as unknown as Record<string, string | null>)[`${prefix}_av`] };
  return r.on_appeal ? own : pinStage(r, prefix);
};

/** Everything the Values tab needs about the PINs, offers, rollover and lock. */
async function valuesPayload(c: pg.PoolClient, firmId: number, id: number) {
  await syncPins(c, firmId, id);
  const a = await loadAppeal(c, firmId, id);
  const rows = await loadPins(c, firmId, id);
  const { pinMode, totals } = pinTotals(rows);
  const offers = (await c.query(
    `SELECT o.id, o.offered_on, o.party, o.total_av, o.pins, o.note, u.name AS created_by_name, o.created_at
       FROM appeal_offers o LEFT JOIN users u ON u.firm_id = o.firm_id AND u.id = o.created_by
      WHERE o.firm_id = $1 AND o.appeal_id = $2 ORDER BY o.offered_on, o.id`,
    [firmId, id],
  )).rows;
  const rolloverFrom = a.target_source === "rollover" && a.target_source_appeal_id
    ? (await c.query(`SELECT id, assessment_year, decision_on FROM appeals WHERE firm_id = $1 AND id = $2`, [firmId, a.target_source_appeal_id])).rows[0] ?? null
    : null;
  const lockedBy = a.stipulation_locked_by
    ? (await c.query(`SELECT name FROM users WHERE firm_id = $1 AND id = $2`, [firmId, a.stipulation_locked_by])).rows[0]?.name ?? null
    : null;
  const ratio = a.assessment_ratio as string | null;
  const onAppeal = rows.filter((r) => r.on_appeal);
  const sumOn = (prefix: "orig" | "target" | "resolved") => {
    const vals = onAppeal.map((r) => stageOut(r, prefix).av);
    return vals.length ? sumAvs(vals) : null;
  };
  const latest = (pred: (p: string) => boolean) => [...offers].reverse().find((o) => pred(o.party)) ?? null;
  return {
    pinMode,
    ratio,
    pins: rows.map((r) => ({
      id: r.id, parcelId: r.parcel_id, pin: r.pin, isPrimary: r.is_primary, onAppeal: r.on_appeal,
      original: stageOut(r, "orig"), target: stageOut(r, "target"), resolved: stageOut(r, "resolved"),
    })),
    totals: {
      original: { ...totals.orig, fmv: fmvFromAv(totals.orig.av, ratio) },
      target: { ...totals.target, fmv: fmvFromAv(totals.target.av, ratio) },
      resolved: { ...totals.resolved, fmv: fmvFromAv(totals.resolved.av, ratio) },
      onAppeal: { original: sumOn("orig"), target: sumOn("target"), resolved: sumOn("resolved") },
    },
    requestedAchieved: requestedAchieved(totals.orig.av, totals.target.av, totals.resolved.av),
    offers: offers.map((o) => ({ ...o, fmv: fmvFromAv(o.total_av, ratio) })),
    latestOffers: { firm: latest((p) => p === "firm"), other: latest((p) => p !== "firm" && p !== "agreed") },
    targetSource: a.target_source,
    rollover: rolloverFrom ? {
      appealId: rolloverFrom.id, year: rolloverFrom.assessment_year, decisionOn: rolloverFrom.decision_on,
      cycle: { start: cycleStart(a.county, a.triad, a.assessment_year), end: cycleEnd(a.county, a.triad, a.assessment_year) },
    } : null,
    stipulation: a.stipulation_locked_at ? { lockedAt: a.stipulation_locked_at, lockedBy } : null,
    rolloverSuggestion: await rolloverSuggestion(c, firmId, id),
  };
}

appealValuesRouter.get("/appeals/:id/values", async (req, res) => {
  const id = appealId(req);
  res.json(await withContext(req.ctx!, (c) => valuesPayload(c, req.ctx!.firmId!, id)));
});

/** After values change: totals and taxes from the PINs, and a decided PTAB rolls forward. */
async function afterChange(c: pg.PoolClient, firmId: number, id: number): Promise<void> {
  await refreshAppealFromPins(c, firmId, id);
  await applyRollover(c, firmId, id);
}

const PinsBody = z.object({
  pins: z.array(z.object({
    parcelId: z.number().int().positive(),
    onAppeal: z.boolean().optional(),
    original: StageValue.optional(),
    target: StageValue.optional(),
    resolved: StageValue.optional(),
  }).strict()).min(1).max(200),
}).strict();

appealValuesRouter.put("/appeals/:id/pins", requirePermission("appeals.edit"), async (req, res) => {
  const id = appealId(req);
  const parsed = PinsBody.safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const firmId = req.ctx!.firmId!;
  const out = await withContext(req.ctx!, async (c) => {
    const a = await loadAppeal(c, firmId, id);
    await syncPins(c, firmId, id);
    const rows = await loadPins(c, firmId, id);
    const locked = Boolean(a.stipulation_locked_at);
    let targetTouched = false;
    for (const p of parsed.data.pins) {
      const row = rows.find((r) => r.parcel_id === p.parcelId);
      if (!row) throw httpError(400, "That PIN isn't on this property.");
      if (locked && (p.resolved || p.onAppeal !== undefined)) throw httpError(409, "The stipulation is locked. Unlock it before changing the resolved values or which PINs are on the appeal.");
      if (p.onAppeal !== undefined) await c.query(`UPDATE appeal_pins SET on_appeal = $3 WHERE firm_id = $1 AND id = $2`, [firmId, row.id, p.onAppeal]);
      if (p.original) await writePinStage(c, firmId, row.id, "orig", p.original);
      if (p.target) { await writePinStage(c, firmId, row.id, "target", p.target); targetTouched = true; }
      if (p.resolved) await writePinStage(c, firmId, row.id, "resolved", p.resolved);
    }
    if (targetTouched) await c.query(`UPDATE appeals SET target_source = 'manual', target_source_appeal_id = NULL WHERE firm_id = $1 AND id = $2`, [firmId, id]);
    await afterChange(c, firmId, id);
    return valuesPayload(c, firmId, id);
  });
  res.json(out);
});

const SplitBody = z.object({
  stage: z.enum(["target", "resolved"]),
  totalAv: money.optional(),
  fmv: money.optional(),
}).strict().refine((v) => (v.totalAv === undefined) !== (v.fmv === undefined), "Give either the total AV or the market value.");

/** Divides an agreed total (AV, or a market value turned into AV) among the PINs on the appeal, the firm's way. */
appealValuesRouter.post("/appeals/:id/split", requirePermission("appeals.edit"), async (req, res) => {
  const id = appealId(req);
  const parsed = SplitBody.safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const firmId = req.ctx!.firmId!;
  const out = await withContext(req.ctx!, async (c) => {
    const a = await loadAppeal(c, firmId, id);
    if (parsed.data.stage === "resolved" && a.stipulation_locked_at) throw httpError(409, "The stipulation is locked. Unlock it before changing the resolved values.");
    const total = parsed.data.totalAv ?? (a.assessment_ratio ? avFromFmv(parsed.data.fmv!, a.assessment_ratio) : null);
    if (total === null) throw httpError(400, "Set the level of assessment before dividing a market value.");
    await syncPins(c, firmId, id);
    const on = (await loadPins(c, firmId, id)).filter((r) => r.on_appeal);
    if (!on.length) throw httpError(400, "No PINs are on this appeal.");
    const parts = splitAgreedTotal(on.map((r) => ({ key: r.id, land: r.orig_land_av, impr: r.orig_impr_av, av: r.orig_av })), total);
    const prefix = parsed.data.stage === "target" ? "target" : "resolved";
    for (const p of parts) {
      await c.query(`UPDATE appeal_pins SET ${prefix}_land_av = $3, ${prefix}_impr_av = $4, ${prefix}_av = $5 WHERE firm_id = $1 AND id = $2`, [firmId, p.key, p.land, p.impr, p.av]);
    }
    if (prefix === "target") await c.query(`UPDATE appeals SET target_source = 'manual', target_source_appeal_id = NULL WHERE firm_id = $1 AND id = $2`, [firmId, id]);
    await afterChange(c, firmId, id);
    return valuesPayload(c, firmId, id);
  });
  res.json(out);
});

const OfferBody = z.object({
  offeredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Give the offer's date."),
  party: z.enum(PARTIES),
  totalAv: money.optional(),
  fmv: money.optional(),
  pins: z.array(z.object({ parcelId: z.number().int().positive(), land: nullableMoney.optional(), impr: nullableMoney.optional(), av: money }).strict()).optional(),
  note: z.string().trim().max(500).nullable().optional(),
}).strict();

/** The per-PIN split of an offer: the PINs given, or the agreed total divided the firm's way. */
async function offerPins(c: pg.PoolClient, firmId: number, a: Record<string, unknown>, body: z.infer<typeof OfferBody>) {
  const on = (await loadPins(c, firmId, a.id as number)).filter((r) => r.on_appeal);
  if (body.pins?.length) {
    const ids = new Set(on.map((r) => r.parcel_id));
    if (body.pins.some((p) => !ids.has(p.parcelId))) throw httpError(400, "An offer can only cover the PINs on this appeal.");
    const pins = body.pins.map((p) => {
      const land = p.land ?? null;
      const impr = p.impr ?? null;
      const av = land !== null && impr !== null ? pinAv({ land, impr, av: null })! : centsToString(toCents(p.av));
      return { parcelId: p.parcelId, land, impr, av };
    });
    return { total: centsToString(pins.reduce((acc, p) => acc + toCents(p.av), 0n)), pins };
  }
  const total = body.totalAv ?? (body.fmv && a.assessment_ratio ? avFromFmv(body.fmv, a.assessment_ratio as string) : null);
  if (total === null) throw httpError(400, "Give the offer as a total AV or a market value.");
  const parts = splitAgreedTotal(on.map((r) => ({ key: r.parcel_id, land: r.orig_land_av, impr: r.orig_impr_av, av: r.orig_av })), total);
  return { total, pins: parts.map((p) => ({ parcelId: p.key, land: p.land, impr: p.impr, av: p.av })) };
}

appealValuesRouter.post("/appeals/:id/offers", requirePermission("appeals.edit"), async (req, res) => {
  const id = appealId(req);
  const parsed = OfferBody.safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const firmId = req.ctx!.firmId!;
  const out = await withContext(req.ctx!, async (c) => {
    const a = await loadAppeal(c, firmId, id);
    await syncPins(c, firmId, id);
    const o = await offerPins(c, firmId, a, parsed.data);
    await c.query(
      `INSERT INTO appeal_offers (firm_id, appeal_id, offered_on, party, total_av, pins, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [firmId, id, parsed.data.offeredOn, parsed.data.party, o.total, JSON.stringify(o.pins), parsed.data.note || null, req.auth!.user.id],
    );
    return valuesPayload(c, firmId, id);
  });
  res.status(201).json(out);
});

appealValuesRouter.delete("/appeals/:id/offers/:offerId", requirePermission("appeals.edit"), async (req, res) => {
  const id = appealId(req);
  const firmId = req.ctx!.firmId!;
  const out = await withContext(req.ctx!, async (c) => {
    const r = await c.query(`DELETE FROM appeal_offers WHERE firm_id = $1 AND appeal_id = $2 AND id = $3`, [firmId, id, Number(req.params.offerId)]);
    if (!r.rowCount) throw httpError(404, "Offer not found.");
    return valuesPayload(c, firmId, id);
  });
  res.json(out);
});

/** Uses an offer's per-PIN figures as the appeal's resolved (or target) values. */
appealValuesRouter.post("/appeals/:id/offers/:offerId/use", requirePermission("appeals.edit"), async (req, res) => {
  const id = appealId(req);
  const parsed = z.object({ stage: z.enum(["target", "resolved"]) }).safeParse(req.body);
  if (!parsed.success) throw httpError(400, "Say whether the offer becomes the target or the resolved values.");
  const firmId = req.ctx!.firmId!;
  const out = await withContext(req.ctx!, async (c) => {
    const a = await loadAppeal(c, firmId, id);
    if (parsed.data.stage === "resolved" && a.stipulation_locked_at) throw httpError(409, "The stipulation is locked. Unlock it before changing the resolved values.");
    const offer = (await c.query(`SELECT pins FROM appeal_offers WHERE firm_id = $1 AND appeal_id = $2 AND id = $3`, [firmId, id, Number(req.params.offerId)])).rows[0];
    if (!offer) throw httpError(404, "Offer not found.");
    const rows = await loadPins(c, firmId, id);
    const prefix = parsed.data.stage === "target" ? "target" : "resolved";
    for (const p of offer.pins as { parcelId: number; land: string | null; impr: string | null; av: string }[]) {
      const row = rows.find((r) => r.parcel_id === p.parcelId);
      if (row) await c.query(`UPDATE appeal_pins SET ${prefix}_land_av = $3, ${prefix}_impr_av = $4, ${prefix}_av = $5 WHERE firm_id = $1 AND id = $2`, [firmId, row.id, p.land, p.impr, p.av]);
    }
    if (prefix === "target") await c.query(`UPDATE appeals SET target_source = 'manual', target_source_appeal_id = NULL WHERE firm_id = $1 AND id = $2`, [firmId, id]);
    await afterChange(c, firmId, id);
    return valuesPayload(c, firmId, id);
  });
  res.json(out);
});

/** Locks (or unlocks) the resolved per-PIN figures as the stipulation the county will enter. */
appealValuesRouter.post("/appeals/:id/stipulation", requirePermission("appeals.edit"), async (req, res) => {
  const id = appealId(req);
  const parsed = z.object({ lock: z.boolean() }).safeParse(req.body);
  if (!parsed.success) throw httpError(400, "Say whether to lock or unlock.");
  const firmId = req.ctx!.firmId!;
  const out = await withContext(req.ctx!, async (c) => {
    await loadAppeal(c, firmId, id);
    if (parsed.data.lock) {
      const on = (await loadPins(c, firmId, id)).filter((r) => r.on_appeal);
      if (!on.length || on.some((r) => r.resolved_av === null)) throw httpError(400, "Every PIN on the appeal needs its resolved value before the stipulation can be locked.");
      await c.query(`UPDATE appeals SET stipulation_locked_at = now(), stipulation_locked_by = $3 WHERE firm_id = $1 AND id = $2`, [firmId, id, req.auth!.user.id]);
    } else {
      await c.query(`UPDATE appeals SET stipulation_locked_at = NULL, stipulation_locked_by = NULL WHERE firm_id = $1 AND id = $2`, [firmId, id]);
    }
    return valuesPayload(c, firmId, id);
  });
  res.json(out);
});

/** Takes the suggested rollover: the earlier same-cycle PTAB decision becomes this appeal's target. */
appealValuesRouter.post("/appeals/:id/rollover", requirePermission("appeals.edit"), async (req, res) => {
  const id = appealId(req);
  const firmId = req.ctx!.firmId!;
  const out = await withContext(req.ctx!, async (c) => {
    const s = await rolloverSuggestion(c, firmId, id);
    if (!s) throw httpError(409, "There's no PTAB decision earlier in this reassessment cycle to roll over.");
    await takeRollover(c, firmId, id, s.appealId);
    return valuesPayload(c, firmId, id);
  });
  res.json(out);
});
