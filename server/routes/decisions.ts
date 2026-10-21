// Decisions: upload decision letters (one or a stack), see what was read and how
// each letter matched, correct a misread, apply letters one at a time or all that
// matched cleanly, undo, start the next level, and track refunds awaited at PTAB and
// the Circuit Court. Mounted under /api/firm after requireFirmContext. Every query
// runs inside withContext and filters on firm_id. Decision letters are client
// documents, so none of this is open under support access.

import express, { Router, type Request } from "express";
import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { withContext } from "../db.js";
import { requirePermission } from "../auth.js";
import { LEVEL_LABELS, matterTitle, type Level } from "../../shared/domain.js";
import { safeName } from "../dropbox/folders.js";
import { todayIso } from "../today.js";
import { httpError, idParam } from "./files-common.js";
import { sniffType } from "../decisions/read-file.js";
import { enqueueUpload } from "../decisions/queue.js";
import { LETTER_KINDS, OUTCOMES, type LetterFields } from "../decisions/parse.js";
import { applyLetter, loadLetter, nextStepFor, refreshMatch, undoLetter, type ApplyResult, type LetterRow } from "../decisions/apply.js";
import { fileLetter, loadLetterFile, purgeIfFinished } from "../decisions/file.js";
import { startNextLevel } from "./matters.js";
import { refundReceived, refundUndone } from "../billing/trust.js";
import { toCents } from "../../shared/money.js";
import { ensureAppealFolder } from "./property-files.js";

export const decisionsRouter = Router();
decisionsRouter.use("/decisions", (req, res, next) => {
  if (req.auth?.user.isSuperAdmin) {
    res.status(403).json({ error: "Decision letters aren't available under support access." });
    return;
  }
  next();
});

const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
const VIEWS = ["review", "clean", "applied", "dismissed"] as const;

// ---------------------------------------------------------------- shaping a letter for the page
interface SummaryRow extends LetterRow {
  page_from: number; page_to: number; file_name: string; upload_created_at: string; text_source: string; checks: { key: string; level: string; text: string }[];
  applied_by_name: string | null; filed_path: string | null; file_error: string | null; document_id: number | null; dismissed_reason: string | null;
  p_address1: string | null; p_name: string | null; p_city: string | null; p_township: string | null; p_pin: string | null; p_client: string | null;
  a_year: number | null; a_level: Level | null; a_status: string | null; a_refund_status: string | null; has_file: boolean; created_at: string;
}

const SUMMARY_SQL = `
  SELECT l.*, u.property_id AS hint_property_id, u.file_name, u.created_at AS upload_created_at, ab.name AS applied_by_name,
         p.address1 AS p_address1, p.name AS p_name, p.city AS p_city, t.name AS p_township, ac.name AS p_client,
         (SELECT x.pin FROM parcels x WHERE x.firm_id = p.firm_id AND x.property_id = p.id ORDER BY x.is_primary DESC, x.id LIMIT 1) AS p_pin,
         a.assessment_year AS a_year, a.level AS a_level, a.status AS a_status, a.refund_status AS a_refund_status,
         EXISTS (SELECT 1 FROM decision_upload_files f WHERE f.firm_id = l.firm_id AND f.upload_id = l.upload_id) AS has_file
    FROM decision_letters l
    JOIN decision_uploads u ON u.firm_id = l.firm_id AND u.id = l.upload_id
    LEFT JOIN users ab ON ab.firm_id = l.firm_id AND ab.id = l.applied_by
    LEFT JOIN properties p ON p.firm_id = l.firm_id AND p.id = l.property_id
    LEFT JOIN townships t ON t.id = p.township_id
    LEFT JOIN accounts ac ON ac.firm_id = p.firm_id AND ac.id = p.account_id
    LEFT JOIN appeals a ON a.firm_id = l.firm_id AND a.id = l.appeal_id`;

const SEVERITY: Record<string, number> = { block: 3, review: 2, note: 1, ok: 0 };

function summary(r: SummaryRow, latestApplied: Set<number>) {
  const checks = r.checks ?? [];
  const worst = [...checks].sort((x, y) => SEVERITY[y.level] - SEVERITY[x.level])[0];
  const achieved = checks.find((x) => x.key === "requested")?.text.match(/^(-?[\d.]+%)/)?.[1] ?? null;
  return {
    id: r.id, uploadId: r.upload_id, fileName: r.file_name, pages: r.page_from === r.page_to ? `${r.page_from}` : `${r.page_from}–${r.page_to}`,
    kind: r.kind, status: r.status, textSource: r.text_source, confidence: r.confidence === null ? null : Number(r.confidence),
    letterDate: r.fields.letterDate, year: r.fields.year, outcome: r.fields.outcome, reference: r.fields.reference, county: r.fields.county,
    pins: (r.fields.pins ?? []).map((p) => ({ pin: p.pin, origAv: p.origAv, av: p.av ?? null })),
    refund: r.fields.refund ?? null,
    property: r.property_id ? {
      id: r.property_id,
      title: matterTitle(r.p_pin, r.p_address1 || r.p_name || "", r.p_city, r.p_township),
      client: r.p_client,
    } : null,
    appeal: r.appeal_id && r.a_level ? { id: r.appeal_id, year: r.a_year, level: r.a_level, status: r.a_status, refundStatus: r.a_refund_status } : null,
    checks,
    headline: worst && worst.level !== "ok" ? worst : null,
    achieved,
    createdAt: r.created_at, appliedAt: r.applied_at, appliedBy: r.applied_by_name,
    filedPath: r.filed_path, fileError: r.file_error, documentId: r.document_id, hasFile: r.has_file,
    dismissedReason: r.dismissed_reason,
    canUndo: r.status === "applied" && latestApplied.has(r.id),
    nextStep: r.status === "applied" && r.a_level && r.a_status ? nextStepFor(r.a_level, r.a_status, ["reduced", "no_change", "increased"].includes(r.a_status)) : null,
  };
}

async function latestAppliedIds(c: pg.PoolClient, firmId: number): Promise<Set<number>> {
  return new Set((await c.query<{ id: number }>(
    `SELECT DISTINCT ON (appeal_id) id FROM decision_letters WHERE firm_id = $1 AND status = 'applied' AND appeal_id IS NOT NULL ORDER BY appeal_id, applied_at DESC`, [firmId],
  )).rows.map((r) => r.id));
}

async function letterSummary(c: pg.PoolClient, firmId: number, id: number) {
  const r = (await c.query<SummaryRow>(`${SUMMARY_SQL} WHERE l.firm_id = $1 AND l.id = $2`, [firmId, id])).rows[0];
  if (!r) throw httpError(404, "Letter not found.");
  return summary(r, await latestAppliedIds(c, firmId));
}

async function letterDetail(c: pg.PoolClient, firmId: number, id: number) {
  const l = await loadLetter(c, firmId, id);
  if (!l) throw httpError(404, "Letter not found.");
  if (l.status === "review" || l.status === "clean") await refreshMatch(c, firmId, l);
  const s = await letterSummary(c, firmId, id);
  const raw = (await c.query<{ raw_text: string; parsed_fields: LetterFields; corrected_at: string | null }>(
    `SELECT raw_text, parsed_fields, corrected_at FROM decision_letters WHERE firm_id = $1 AND id = $2`, [firmId, id],
  )).rows[0];
  const appeals = s.property ? (await c.query(
    `SELECT id, assessment_year AS year, level, status FROM appeals WHERE firm_id = $1 AND property_id = $2
      ORDER BY assessment_year DESC, array_position(ARRAY['assessor','bor','ptab','circuit']::text[], level) DESC`,
    [firmId, s.property.id],
  )).rows : [];
  return { ...s, fields: l.fields, parsedFields: raw.parsed_fields, corrected: Boolean(raw.corrected_at), rawText: raw.raw_text, appealChosen: l.appeal_chosen, appeals };
}

function letterId(req: Request): number {
  const n = idParam(req);
  if (!n) throw httpError(400, "Invalid letter.");
  return n;
}

// ---------------------------------------------------------------- upload
decisionsRouter.post(
  "/decisions/upload",
  requirePermission("appeals.edit"),
  express.raw({ type: "application/octet-stream", limit: MAX_UPLOAD_BYTES }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw httpError(400, "The file is empty.");
    const type = sniffType(req.body);
    if (!type) throw httpError(415, "Upload decision letters as PDF, JPG or PNG files.");
    const name = safeName(String(req.query.name ?? "")).slice(0, 200) || "Decision letter";
    const propertyId = req.query.propertyId ? Number(req.query.propertyId) : null;
    if (propertyId !== null && (!Number.isInteger(propertyId) || propertyId <= 0)) throw httpError(400, "Invalid property.");
    const firmId = req.ctx!.firmId!;
    const sha = createHash("sha256").update(req.body).digest("hex");
    const out = await withContext(req.ctx!, async (c) => {
      if (propertyId && !(await c.query(`SELECT 1 FROM properties WHERE firm_id = $1 AND id = $2`, [firmId, propertyId])).rowCount) throw httpError(404, "Property not found.");
      const earlier = (await c.query<{ id: number; created_at: string }>(
        `SELECT id, created_at FROM decision_uploads WHERE firm_id = $1 AND sha256 = $2 ORDER BY id DESC LIMIT 1`, [firmId, sha],
      )).rows[0] ?? null;
      const up = (await c.query<{ id: number }>(
        `INSERT INTO decision_uploads (firm_id, property_id, file_name, content_type, size, sha256, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [firmId, propertyId, name, type, req.body.length, sha, req.auth!.user.id],
      )).rows[0];
      await c.query(`INSERT INTO decision_upload_files (firm_id, upload_id, data) VALUES ($1, $2, $3)`, [firmId, up.id, req.body]);
      return { id: up.id, duplicateOf: earlier };
    });
    enqueueUpload(firmId, out.id);
    res.status(201).json({ upload: { id: out.id, fileName: name, status: "queued" }, sameFileUploadedBefore: out.duplicateOf ? { uploadId: out.duplicateOf.id, at: out.duplicateOf.created_at } : null });
  },
);

/** A whole upload, while nothing in it has been applied (a wrong file, a test). */
decisionsRouter.delete("/decisions/uploads/:id", requirePermission("appeals.edit"), async (req, res) => {
  const id = idParam(req);
  if (!id) throw httpError(400, "Invalid upload.");
  await withContext(req.ctx!, async (c) => {
    const up = (await c.query(`SELECT status FROM decision_uploads WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id])).rows[0];
    if (!up) throw httpError(404, "Upload not found.");
    if (up.status === "queued" || up.status === "reading") throw httpError(409, "Wait for the file to finish reading.");
    if ((await c.query(`SELECT 1 FROM decision_letters WHERE firm_id = $1 AND upload_id = $2 AND status = 'applied'`, [req.ctx!.firmId, id])).rowCount) {
      throw httpError(409, "A letter in this upload has been applied. Undo it first, or dismiss the other letters instead.");
    }
    await c.query(`DELETE FROM decision_uploads WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id]);
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- the queue
decisionsRouter.get("/decisions", async (req, res) => {
  const view = (VIEWS as readonly string[]).includes(String(req.query.view)) ? String(req.query.view) : "review";
  const propertyId = req.query.propertyId ? Number(req.query.propertyId) : null;
  const firmId = req.ctx!.firmId!;
  const out = await withContext(req.ctx!, async (c) => {
    // Letters not yet applied are checked again, so a fix made elsewhere (a PIN, a new appeal) shows up here.
    // The page's polling while files are read passes recheck=0.
    const open = req.query.recheck === "0" ? [] : (await c.query<{ id: number }>(`SELECT id FROM decision_letters WHERE firm_id = $1 AND status IN ('review', 'clean') ORDER BY id LIMIT 500`, [firmId])).rows;
    for (const o of open) {
      const l = await loadLetter(c, firmId, o.id);
      if (l) await refreshMatch(c, firmId, l);
    }
    const counts = (await c.query<{ status: string; n: string }>(`SELECT status, count(*) AS n FROM decision_letters WHERE firm_id = $1 GROUP BY status`, [firmId])).rows;
    const uploads = (await c.query(
      `SELECT u.id, u.file_name, u.status, u.page_count, u.pages_read, u.error, u.created_at, u.property_id, uu.name AS uploaded_by_name,
              (SELECT count(*)::int FROM decision_letters l WHERE l.firm_id = u.firm_id AND l.upload_id = u.id) AS letters
         FROM decision_uploads u LEFT JOIN users uu ON uu.firm_id = u.firm_id AND uu.id = u.uploaded_by
        WHERE u.firm_id = $1 AND (u.status IN ('queued', 'reading', 'failed') OR u.created_at > now() - interval '1 day')
          AND ($2::int IS NULL OR u.property_id = $2)
        ORDER BY u.id DESC LIMIT 50`,
      [firmId, propertyId],
    )).rows;
    const rows = (await c.query<SummaryRow>(
      `${SUMMARY_SQL} WHERE l.firm_id = $1 AND l.status = $2 AND ($3::int IS NULL OR l.property_id = $3 OR u.property_id = $3)
        ORDER BY ${view === "applied" ? "l.applied_at DESC" : view === "dismissed" ? "l.dismissed_at DESC" : "l.id"} LIMIT 300`,
      [firmId, view, propertyId],
    )).rows;
    const refunds = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM appeals WHERE firm_id = $1 AND refund_status = 'awaiting'`, [firmId])).rows[0];
    const latest = await latestAppliedIds(c, firmId);
    return {
      counts: {
        review: Number(counts.find((x) => x.status === "review")?.n ?? 0),
        clean: Number(counts.find((x) => x.status === "clean")?.n ?? 0),
        applied: Number(counts.find((x) => x.status === "applied")?.n ?? 0),
        dismissed: Number(counts.find((x) => x.status === "dismissed")?.n ?? 0),
        awaitingRefund: Number(refunds.n),
      },
      uploads,
      letters: rows.map((r) => summary(r, latest)),
    };
  });
  res.json(out);
});

decisionsRouter.get("/decisions/letters/:id", async (req, res) => {
  const id = letterId(req);
  res.json(await withContext(req.ctx!, (c) => letterDetail(c, req.ctx!.firmId!, id)));
});

/** The letter itself (its pages as a PDF), for the preview beside the fields. */
decisionsRouter.get("/decisions/letters/:id/file", async (req, res) => {
  const id = letterId(req);
  const exists = await withContext(req.ctx!, async (c) => (await c.query(`SELECT 1 FROM decision_letters WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, id])).rowCount);
  if (!exists) throw httpError(404, "Letter not found.");
  const f = await loadLetterFile(req, id);
  if (!f) throw httpError(410, "The scan is filed in Dropbox now. Open it from the property's Files tab.");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="decision-letter-${id}.pdf"`);
  res.setHeader("Cache-Control", "private, no-store");
  // Shown in a frame on our own page only.
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'self'");
  res.end(f.pdf);
});

// ---------------------------------------------------------------- corrections
const amount = z.union([z.string(), z.number()]).transform((v) => String(v).replace(/[$,\s]/g, "")).pipe(z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Use a number with up to 2 decimals")).nullable();
const FieldsBody = z.object({
  kind: z.enum(LETTER_KINDS as [string, ...string[]]),
  county: z.string().trim().max(40).nullable(),
  year: z.number().int().min(1990).max(2100).nullable(),
  letterDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  outcome: z.enum(OUTCOMES as [string, ...string[]]).nullable(),
  reference: z.string().trim().max(60).nullable(),
  pins: z.array(z.object({
    pin: z.string().trim().max(40).nullable(),
    origAv: amount, land: amount, impr: amount, av: amount,
  })).max(50),
  refund: amount.optional(),
}); // anything else the page sends back (what the parser noted) is ignored

decisionsRouter.put("/decisions/letters/:id", requirePermission("appeals.edit"), async (req, res) => {
  const id = letterId(req);
  const parsed = z.object({ fields: FieldsBody.optional(), appealId: z.number().int().positive().nullable().optional() }).strict().safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  const firmId = req.ctx!.firmId!;
  const out = await withContext(req.ctx!, async (c) => {
    const l = await loadLetter(c, firmId, id, true);
    if (!l) throw httpError(404, "Letter not found.");
    if (l.status === "applied") throw httpError(409, "Undo the letter before changing what it says.");
    if (parsed.data.fields) {
      const f = parsed.data.fields;
      const fields: LetterFields = {
        ...l.fields, kind: f.kind as LetterFields["kind"], county: f.county || null, year: f.year, letterDate: f.letterDate,
        outcome: f.outcome as LetterFields["outcome"], reference: f.reference || null,
        pins: f.pins.map((p, i) => ({ ...(l.fields.pins?.[i] ?? {}), pin: p.pin || null, origAv: p.origAv, land: p.land, impr: p.impr, av: p.av })),
        refund: f.refund === undefined ? l.fields.refund ?? null : f.refund,
        total: f.pins.length > 1 ? l.fields.total ?? null : null,
        problems: [], // a person has read it now
      };
      await c.query(`UPDATE decision_letters SET fields = $3, kind = $4, corrected_by = $5, corrected_at = now() WHERE firm_id = $1 AND id = $2`, [firmId, id, JSON.stringify(fields), fields.kind, req.auth!.user.id]);
    }
    if (parsed.data.appealId !== undefined) {
      if (parsed.data.appealId !== null && !(await c.query(`SELECT 1 FROM appeals WHERE firm_id = $1 AND id = $2`, [firmId, parsed.data.appealId])).rowCount) throw httpError(404, "Appeal not found.");
      await c.query(`UPDATE decision_letters SET appeal_id = $3, appeal_chosen = $4 WHERE firm_id = $1 AND id = $2`, [firmId, id, parsed.data.appealId, parsed.data.appealId !== null]);
    }
    const fresh = await loadLetter(c, firmId, id);
    if (fresh!.status === "dismissed") return letterDetail(c, firmId, id);
    await refreshMatch(c, firmId, fresh!);
    return letterDetail(c, firmId, id);
  });
  res.json(out);
});

// ---------------------------------------------------------------- applying
async function afterApply(req: Request, results: ApplyResult[]): Promise<{ letterId: number; filedPath: string | null; fileError: string | null }[]> {
  const out = [];
  for (const r of results) {
    const f = await fileLetter(req, r.letterId);
    out.push({ letterId: r.letterId, filedPath: f.filedPath, fileError: f.error });
  }
  return out;
}

decisionsRouter.post("/decisions/letters/:id/apply", requirePermission("decisions.apply"), async (req, res) => {
  const id = letterId(req);
  const parsed = z.object({ acknowledged: z.boolean().optional() }).strict().safeParse(req.body ?? {});
  if (!parsed.success) throw httpError(400, "Invalid request.");
  const firmId = req.ctx!.firmId!;
  const result = await withContext(req.ctx!, (c) => applyLetter(c, firmId, req.auth!.user.id, id, Boolean(parsed.data.acknowledged)));
  const filed = await afterApply(req, [result]);
  const letter = await withContext(req.ctx!, (c) => letterDetail(c, firmId, id));
  res.json({ result, filed: filed[0], letter });
});

/** "Apply all that matched cleanly": every clean letter (or the ones listed), each in its own transaction. */
decisionsRouter.post("/decisions/apply-clean", requirePermission("decisions.apply"), async (req, res) => {
  const parsed = z.object({ ids: z.array(z.number().int().positive()).max(500).optional() }).strict().safeParse(req.body ?? {});
  if (!parsed.success) throw httpError(400, "Invalid request.");
  const firmId = req.ctx!.firmId!;
  const ids = await withContext(req.ctx!, async (c) => {
    const open = (await c.query<{ id: number }>(`SELECT id FROM decision_letters WHERE firm_id = $1 AND status IN ('review', 'clean') ORDER BY id`, [firmId])).rows;
    for (const o of open) { const l = await loadLetter(c, firmId, o.id); if (l) await refreshMatch(c, firmId, l); }
    return (await c.query<{ id: number }>(
      `SELECT id FROM decision_letters WHERE firm_id = $1 AND status = 'clean' AND ($2::int[] IS NULL OR id = ANY($2::int[])) ORDER BY id`, [firmId, parsed.data.ids ?? null],
    )).rows.map((r) => r.id);
  });
  const applied: ApplyResult[] = [];
  const skipped: { letterId: number; reason: string }[] = [];
  for (const id of ids) {
    try {
      // acknowledged=false: anything that turned up a review item since is left for a person.
      applied.push(await withContext(req.ctx!, (c) => applyLetter(c, firmId, req.auth!.user.id, id, false)));
    } catch (err) {
      skipped.push({ letterId: id, reason: (err as { publicMessage?: string }).publicMessage ?? "Couldn't apply this letter." });
    }
  }
  const filed = await afterApply(req, applied);
  res.json({
    applied: applied.length, skipped,
    results: applied.map((r) => ({ ...r, ...filed.find((f) => f.letterId === r.letterId) })),
    startBor: applied.filter((r) => r.nextStep === "start_bor").map((r) => r.letterId),
  });
});

decisionsRouter.post("/decisions/letters/:id/undo", requirePermission("decisions.apply"), async (req, res) => {
  const id = letterId(req);
  const firmId = req.ctx!.firmId!;
  const letter = await withContext(req.ctx!, async (c) => {
    await undoLetter(c, firmId, id);
    return letterDetail(c, firmId, id);
  });
  res.json({ letter });
});

decisionsRouter.post("/decisions/letters/:id/file", requirePermission("appeals.edit"), async (req, res) => {
  const id = letterId(req);
  const f = await fileLetter(req, id);
  const letter = await withContext(req.ctx!, (c) => letterDetail(c, req.ctx!.firmId!, id));
  if (f.error) throw httpError(409, f.error);
  res.json({ filedPath: f.filedPath, letter });
});

decisionsRouter.post("/decisions/letters/:id/dismiss", requirePermission("appeals.edit"), async (req, res) => {
  const id = letterId(req);
  const parsed = z.object({ reason: z.string().trim().max(300).nullable().optional() }).strict().safeParse(req.body ?? {});
  if (!parsed.success) throw httpError(400, "Keep the reason under 300 characters.");
  const firmId = req.ctx!.firmId!;
  const letter = await withContext(req.ctx!, async (c) => {
    const l = await loadLetter(c, firmId, id, true);
    if (!l) throw httpError(404, "Letter not found.");
    if (l.status === "applied") throw httpError(409, "Undo the letter before dismissing it.");
    await c.query(
      `UPDATE decision_letters SET status = 'dismissed', dismissed_by = $3, dismissed_at = now(), dismissed_reason = $4 WHERE firm_id = $1 AND id = $2`,
      [firmId, id, req.auth!.user.id, parsed.data.reason || null],
    );
    await purgeIfFinished(c, firmId, l.upload_id);
    return letterDetail(c, firmId, id);
  });
  res.json({ letter });
});

decisionsRouter.post("/decisions/letters/:id/restore", requirePermission("appeals.edit"), async (req, res) => {
  const id = letterId(req);
  const firmId = req.ctx!.firmId!;
  const letter = await withContext(req.ctx!, async (c) => {
    const l = await loadLetter(c, firmId, id, true);
    if (!l || l.status !== "dismissed") throw httpError(409, "Only a dismissed letter can be restored.");
    await c.query(`UPDATE decision_letters SET status = 'review', dismissed_by = NULL, dismissed_at = NULL, dismissed_reason = NULL WHERE firm_id = $1 AND id = $2`, [firmId, id]);
    const fresh = await loadLetter(c, firmId, id);
    await refreshMatch(c, firmId, fresh!);
    return letterDetail(c, firmId, id);
  });
  res.json({ letter });
});

/** One click after "no change at the Assessor": the Board of Review appeal for the same year, for each letter given. */
decisionsRouter.post("/decisions/start-bor", requirePermission("appeals.edit"), async (req, res) => {
  const parsed = z.object({ letterIds: z.array(z.number().int().positive()).min(1).max(500) }).strict().safeParse(req.body);
  if (!parsed.success) throw httpError(400, "Choose the letters.");
  const firmId = req.ctx!.firmId!;
  const started: { letterId: number; appealId: number; propertyId: number; created: boolean }[] = [];
  const skipped: { letterId: number; reason: string }[] = [];
  for (const lid of parsed.data.letterIds) {
    try {
      const r = await withContext(req.ctx!, async (c) => {
        const l = (await c.query<{ appeal_id: number | null; status: string }>(`SELECT appeal_id, status FROM decision_letters WHERE firm_id = $1 AND id = $2`, [firmId, lid])).rows[0];
        if (!l || l.status !== "applied" || !l.appeal_id) throw httpError(409, "Apply the letter first.");
        const a = (await c.query<{ level: Level }>(`SELECT level FROM appeals WHERE firm_id = $1 AND id = $2`, [firmId, l.appeal_id])).rows[0];
        if (a.level !== "assessor") throw httpError(409, "Only an Assessor decision goes on to the Board of Review this way.");
        return startNextLevel(c, req, l.appeal_id, "bor");
      });
      started.push({ letterId: lid, ...r });
    } catch (err) {
      skipped.push({ letterId: lid, reason: (err as { publicMessage?: string }).publicMessage ?? "Couldn't start the Board of Review appeal." });
    }
  }
  for (const s of started.filter((x) => x.created)) {
    const yr = await withContext(req.ctx!, async (c) => (await c.query<{ assessment_year: number }>(`SELECT assessment_year FROM appeals WHERE firm_id = $1 AND id = $2`, [firmId, s.appealId])).rows[0].assessment_year);
    await ensureAppealFolder(req, s.propertyId, yr, "bor").catch(() => null);
  }
  res.json({ started, skipped });
});

// ---------------------------------------------------------------- refunds
decisionsRouter.get("/decisions/refunds", async (req, res) => {
  const firmId = req.ctx!.firmId!;
  const rows = await withContext(req.ctx!, async (c) => (await c.query(
    `SELECT a.id, a.property_id, a.assessment_year AS year, a.level, a.status, a.refund_status, a.refund_expected, a.refund_received, a.refund_received_on,
            a.decision_on, a.savings, p.address1, p.name, p.city, t.name AS township, ac.name AS client,
            (SELECT x.pin FROM parcels x WHERE x.firm_id = p.firm_id AND x.property_id = p.id ORDER BY x.is_primary DESC, x.id LIMIT 1) AS pin,
            GREATEST(0, CURRENT_DATE - a.decision_on)::int AS days_waiting
       FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id
       JOIN accounts ac ON ac.firm_id = p.firm_id AND ac.id = p.account_id LEFT JOIN townships t ON t.id = p.township_id
      WHERE a.firm_id = $1 AND a.refund_status IS NOT NULL
      ORDER BY (a.refund_status = 'received'), a.decision_on NULLS LAST, a.id`,
    [firmId],
  )).rows);
  res.json({
    refunds: rows.map((r) => ({
      appealId: r.id, propertyId: r.property_id, year: r.year, level: r.level, levelLabel: LEVEL_LABELS[r.level as Level], status: r.refund_status,
      expected: r.refund_expected, expectedIsEstimate: r.level === "ptab", received: r.refund_received, receivedOn: r.refund_received_on,
      decisionOn: r.decision_on, daysWaiting: r.days_waiting, client: r.client, title: matterTitle(r.pin, r.address1 || r.name, r.city, r.township),
    })),
  });
});

const RefundBody = z.object({
  receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Give the date the check arrived."),
  amount: z.union([z.string(), z.number()]).transform((v) => String(v).replace(/[$,\s]/g, "")).pipe(z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Give the amount received, refund and interest together.")),
}).strict();

/** Records the refund check (refund plus interest). Delivery 9 takes it from here into trust and the client's disbursement. */
decisionsRouter.post("/decisions/refunds/:id", requirePermission("appeals.edit"), async (req, res) => {
  const id = idParam(req);
  if (!id) throw httpError(400, "Invalid appeal.");
  const parsed = RefundBody.safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues[0].message);
  if (parsed.data.receivedOn > todayIso()) throw httpError(400, "The date received can't be in the future.");
  const firmId = req.ctx!.firmId!;
  await withContext(req.ctx!, async (c) => {
    const a = (await c.query(`SELECT refund_status FROM appeals WHERE firm_id = $1 AND id = $2 FOR UPDATE`, [firmId, id])).rows[0];
    if (!a) throw httpError(404, "Appeal not found.");
    if (!a.refund_status) throw httpError(409, "This appeal isn't waiting for a refund.");
    if (toCents(parsed.data.amount) <= 0n) throw httpError(400, "Give the amount received, refund and interest together.");
    // Recording it again (a corrected amount) replaces the deposit and the draft settlement.
    if (a.refund_status === "received") await refundUndone(c, firmId, id);
    await c.query(
      `UPDATE appeals SET refund_status = 'received', refund_received = $3, refund_received_on = $4 WHERE firm_id = $1 AND id = $2`,
      [firmId, id, parsed.data.amount, parsed.data.receivedOn],
    );
    // Into trust: the deposit, and the settlement drafted (fee, fronted expenses, the client's share).
    return refundReceived(c, firmId, req.auth!.user.id, id);
  }).then((settlementId) => res.json({ ok: true, settlementId }));
  return;
});

decisionsRouter.delete("/decisions/refunds/:id", requirePermission("appeals.edit"), async (req, res) => {
  const id = idParam(req);
  if (!id) throw httpError(400, "Invalid appeal.");
  await withContext(req.ctx!, async (c) => {
    await refundUndone(c, req.ctx!.firmId!, id);
    const r = await c.query(
      `UPDATE appeals SET refund_status = 'awaiting', refund_received = NULL, refund_received_on = NULL WHERE firm_id = $1 AND id = $2 AND refund_status = 'received'`,
      [req.ctx!.firmId, id],
    );
    if (!r.rowCount) throw httpError(404, "No received refund to take back.");
  });
  res.json({ ok: true });
});


