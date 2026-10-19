// Calendar, deadlines and the sample-data reset. Mounted under /api/firm
// after requireFirmContext. Every query runs inside withContext (row-level
// security) AND filters on firm_id; joins to users also match firm_id.

import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { z } from "zod";
import { withContext } from "../db.js";
import { requirePermission } from "../auth.js";
import { matterTitle } from "../../shared/domain.js";
import { todayIso } from "../today.js";
import { LEVEL_SHORT } from "../deadlines.js";
import { resetSampleFirm } from "../seed/sample.js";

export const calendarRouter = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates use YYYY-MM-DD");
const optText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));
const timeVal = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Times use HH:MM").nullable().optional().or(z.literal("").transform(() => null));

function bad(res: Response, err: z.ZodError | string): void {
  const message = typeof err === "string" ? err : err.issues.map((i) => i.message).filter((m, i, a) => a.indexOf(m) === i).join(" ");
  res.status(400).json({ error: message || "Invalid input." });
}

function idParam(req: Request): number | null {
  const n = Number(req.params.id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ================================================================ calendar
calendarRouter.get("/calendar", async (req, res) => {
  const from = String(req.query.from ?? "");
  const to = String(req.query.to ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) return bad(res, "Choose a date range.");
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (days > 400) return bad(res, "Choose a range of a year or less.");
  const allWindows = req.query.windows === "all";
  const firmId = req.ctx!.firmId!;
  const me = req.auth!.user.id;

  const data = await withContext(req.ctx!, async (c) => {
    // Windows: the ones touching a township where the firm has an active property, or all of them.
    const windows = (await c.query(
      `SELECT w.id, w.level, w.assessment_year, w.opens_on, w.closes_on, w.note, co.name AS county, t.name AS township,
              (SELECT count(*)::int FROM properties p
                WHERE p.firm_id = $1 AND p.status = 'active' AND p.county_id = w.county_id
                  AND (w.township_id IS NULL OR p.township_id = w.township_id)) AS properties,
              (SELECT count(DISTINCT p.id)::int FROM properties p JOIN appeals a ON a.firm_id = p.firm_id AND a.property_id = p.id
                WHERE p.firm_id = $1 AND p.status = 'active' AND p.county_id = w.county_id
                  AND (w.township_id IS NULL OR p.township_id = w.township_id)
                  AND a.level = w.level AND a.assessment_year = w.assessment_year AND a.substage = 'under_review') AS unfiled,
              (SELECT count(*)::int FROM properties p
                WHERE p.firm_id = $1 AND p.status = 'active' AND p.county_id = w.county_id
                  AND (w.township_id IS NULL OR p.township_id = w.township_id)
                  AND $4 IN (p.attorney_user_id, p.analyst_user_id)) AS mine
         FROM filing_windows w JOIN counties co ON co.id = w.county_id LEFT JOIN townships t ON t.id = w.township_id
        WHERE w.opens_on <= $3 AND w.closes_on >= $2
        ORDER BY w.opens_on, co.name, t.name`,
      [firmId, from, to, me],
    )).rows.filter((w) => allWindows || w.properties > 0);

    const deadlines = (await c.query(
      `SELECT d.id, d.property_id, d.appeal_id, d.kind, d.title, d.due_on, d.due_time, d.location, d.notes, d.status, d.source,
              a.level, p.name, p.address1, p.city, t.name AS township,
              (SELECT x.pin FROM parcels x WHERE x.firm_id = p.firm_id AND x.property_id = p.id ORDER BY x.is_primary DESC, x.id LIMIT 1) AS pin,
              att.name AS attorney_name, ana.name AS analyst_name,
              ($4 IN (p.attorney_user_id, p.analyst_user_id)) AS mine
         FROM deadlines d
         JOIN properties p ON p.firm_id = d.firm_id AND p.id = d.property_id
         LEFT JOIN townships t ON t.id = p.township_id
         LEFT JOIN appeals a ON a.firm_id = d.firm_id AND a.id = d.appeal_id
         LEFT JOIN users att ON att.firm_id = p.firm_id AND att.id = p.attorney_user_id
         LEFT JOIN users ana ON ana.firm_id = p.firm_id AND ana.id = p.analyst_user_id
        WHERE d.firm_id = $1 AND d.due_on BETWEEN $2 AND $3
        ORDER BY d.due_on, d.due_time NULLS LAST`,
      [firmId, from, to, me],
    )).rows;

    const tasks = (await c.query(
      `SELECT ac.id, ac.property_id, ac.account_id, ac.subject, ac.due_on, ac.status, u.name AS assigned_name,
              p.name, p.address1, p.city, t.name AS township, acc.name AS account_name,
              (SELECT x.pin FROM parcels x WHERE x.firm_id = p.firm_id AND x.property_id = p.id ORDER BY x.is_primary DESC, x.id LIMIT 1) AS pin,
              (ac.assigned_user_id = $4) AS mine
         FROM activities ac
         LEFT JOIN users u ON u.firm_id = ac.firm_id AND u.id = ac.assigned_user_id
         LEFT JOIN properties p ON p.firm_id = ac.firm_id AND p.id = ac.property_id
         LEFT JOIN townships t ON t.id = p.township_id
         LEFT JOIN accounts acc ON acc.firm_id = ac.firm_id AND acc.id = COALESCE(ac.account_id, p.account_id)
        WHERE ac.firm_id = $1 AND ac.kind = 'task' AND ac.due_on BETWEEN $2 AND $3
        ORDER BY ac.due_on`,
      [firmId, from, to, me],
    )).rows;
    return { windows, deadlines, tasks };
  });

  const title = (r: { pin: string | null; address1: string | null; name: string | null; city: string | null; township: string | null }) =>
    r.name ? matterTitle(r.pin, r.address1 || r.name, r.city, r.township) : null;
  res.json({
    today: todayIso(),
    windows: data.windows.map((w) => ({ ...w, label: `${w.township ?? `${w.county} County`} ${LEVEL_SHORT[w.level as keyof typeof LEVEL_SHORT]}`, mine: w.mine > 0 })),
    deadlines: data.deadlines.map(({ pin, name, address1, city, township, ...d }) => ({ ...d, property_title: title({ pin, name, address1, city, township }), property_short: address1 || name })),
    tasks: data.tasks.map(({ pin, name, address1, city, township, ...t }) => ({ ...t, property_title: title({ pin, name, address1, city, township }), property_short: address1 || name })),
  });
});

// ================================================================ deadlines
const KINDS = ["hearing", "evidence", "filing", "other"] as const;
const DEFAULT_TITLE: Record<(typeof KINDS)[number], string> = { hearing: "hearing", evidence: "evidence due", filing: "filing deadline", other: "deadline" };

const DeadlineBody = z.object({
  appealId: z.coerce.number().int().positive().nullable().optional(),
  kind: z.enum(KINDS),
  title: optText(200),
  dueOn: isoDate,
  dueTime: timeVal,
  location: optText(200),
  notes: optText(2000),
  source: z.enum(["manual", "notice"]).optional(),
});

const DeadlinePatch = z.object({
  appealId: z.coerce.number().int().positive().nullable().optional(),
  kind: z.enum(KINDS).optional(),
  title: z.string().trim().min(1, "Give the deadline a name").max(200).optional(),
  dueOn: isoDate.optional(),
  dueTime: timeVal,
  location: optText(200),
  notes: optText(2000),
  status: z.enum(["open", "done"]).optional(),
  overrideReason: optText(300),
}).strict();

/** Keep the appeal's hearing date in step with its earliest open hearing deadline. */
async function syncHearing(c: pg.PoolClient, firmId: number, appealId: number | null): Promise<void> {
  if (!appealId) return;
  await c.query(
    `UPDATE appeals SET hearing_at = (
       SELECT (d.due_on + COALESCE(d.due_time, '09:00'::time)) AT TIME ZONE 'America/Chicago' FROM deadlines d
        WHERE d.firm_id = $1 AND d.appeal_id = $2 AND d.kind = 'hearing' AND d.status = 'open'
        ORDER BY d.due_on, d.due_time NULLS LAST LIMIT 1)
      WHERE firm_id = $1 AND id = $2`,
    [firmId, appealId],
  );
}

async function appealLevel(c: pg.PoolClient, firmId: number, propertyId: number, appealId: number | null | undefined): Promise<string | null> {
  if (!appealId) return null;
  const a = (await c.query<{ level: keyof typeof LEVEL_SHORT }>(`SELECT level FROM appeals WHERE firm_id = $1 AND id = $2 AND property_id = $3`, [firmId, appealId, propertyId])).rows[0];
  if (!a) throw Object.assign(new Error("appeal"), { status: 400, publicMessage: "That appeal isn't on this property." });
  return LEVEL_SHORT[a.level];
}

calendarRouter.post("/properties/:id/deadlines", requirePermission("appeals.edit"), async (req, res) => {
  const pid = idParam(req);
  const parsed = DeadlineBody.safeParse(req.body);
  if (!pid) return bad(res, "Invalid property.");
  if (!parsed.success) return bad(res, parsed.error);
  const d = parsed.data;
  const firmId = req.ctx!.firmId!;
  const row = await withContext(req.ctx!, async (c) => {
    const p = await c.query(`SELECT 1 FROM properties WHERE firm_id = $1 AND id = $2`, [firmId, pid]);
    if (!p.rowCount) return null;
    const level = await appealLevel(c, firmId, pid, d.appealId);
    const title = d.title ?? `${level ? `${level} ` : ""}${DEFAULT_TITLE[d.kind]}`.replace(/^./, (x) => x.toUpperCase());
    const r = (await c.query(
      `INSERT INTO deadlines (firm_id, property_id, appeal_id, kind, title, due_on, due_time, location, notes, source, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [firmId, pid, d.appealId ?? null, d.kind, title, d.dueOn, d.dueTime ?? null, d.location, d.notes, d.source ?? "manual", req.auth!.user.id],
    )).rows[0];
    if (d.kind === "hearing") await syncHearing(c, firmId, r.appeal_id);
    return r;
  });
  if (!row) { res.status(404).json({ error: "Property not found." }); return; }
  res.status(201).json({ deadline: row });
});

calendarRouter.patch("/deadlines/:id", requirePermission("appeals.edit"), async (req, res) => {
  const did = idParam(req);
  const parsed = DeadlinePatch.safeParse(req.body);
  if (!did) return bad(res, "Invalid deadline.");
  if (!parsed.success) return bad(res, parsed.error);
  const d = parsed.data;
  const firmId = req.ctx!.firmId!;
  const row = await withContext(req.ctx!, async (c) => {
    const cur = (await c.query(`SELECT * FROM deadlines WHERE firm_id = $1 AND id = $2 FOR UPDATE`, [firmId, did])).rows[0];
    if (!cur) return null;
    if (d.appealId !== undefined) await appealLevel(c, firmId, cur.property_id, d.appealId);
    const next: Record<string, unknown> = {};
    const map: [keyof typeof d, string][] = [
      ["appealId", "appeal_id"], ["kind", "kind"], ["title", "title"], ["dueOn", "due_on"], ["dueTime", "due_time"],
      ["location", "location"], ["notes", "notes"],
    ];
    for (const [k, col] of map) if (d[k] !== undefined) next[col] = d[k];
    // A date the app worked out can be changed, but the reason is kept with it.
    if (cur.source === "computed" && d.dueOn !== undefined && d.dueOn !== cur.due_on) {
      if (!d.overrideReason) throw Object.assign(new Error("reason"), { status: 400, publicMessage: "Give a reason when you change a date the app worked out." });
      next.override_reason = d.overrideReason;
      if (!cur.computed_on) next.computed_on = cur.due_on;
    }
    if (d.status !== undefined && d.status !== cur.status) {
      next.status = d.status;
      next.completed_at = d.status === "done" ? new Date().toISOString() : null;
    }
    const cols = Object.keys(next);
    if (!cols.length) return cur;
    const r = (await c.query(
      `UPDATE deadlines SET ${cols.map((col, i) => `${col} = $${i + 3}`).join(", ")} WHERE firm_id = $1 AND id = $2 RETURNING *`,
      [firmId, did, ...cols.map((col) => next[col])],
    )).rows[0];
    if (cur.kind === "hearing" || r.kind === "hearing") {
      await syncHearing(c, firmId, cur.appeal_id);
      if (r.appeal_id !== cur.appeal_id) await syncHearing(c, firmId, r.appeal_id);
    }
    return r;
  });
  if (!row) { res.status(404).json({ error: "Deadline not found." }); return; }
  res.json({ deadline: row });
});

calendarRouter.delete("/deadlines/:id", requirePermission("appeals.edit"), async (req, res) => {
  const did = idParam(req);
  if (!did) return bad(res, "Invalid deadline.");
  const firmId = req.ctx!.firmId!;
  const ok = await withContext(req.ctx!, async (c) => {
    const gone = (await c.query(`DELETE FROM deadlines WHERE firm_id = $1 AND id = $2 RETURNING appeal_id, kind`, [firmId, did])).rows[0];
    if (!gone) return false;
    if (gone.kind === "hearing") await syncHearing(c, firmId, gone.appeal_id);
    return true;
  });
  if (!ok) { res.status(404).json({ error: "Deadline not found." }); return; }
  res.json({ ok: true });
});

// ================================================================ sample data
calendarRouter.post("/sample/reset", requirePermission("properties.delete"), async (req, res) => {
  await withContext(req.ctx!, (c) => resetSampleFirm(c, req.ctx!.firmId!));
  res.json({ ok: true });
});
