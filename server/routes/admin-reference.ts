// Super admin: publish the global reference data every firm reads (filing
// windows, equalizers, tax rates, townships). Mounted on adminRouter, which
// already requires the super admin. Nothing here reads firm data; changing
// an equalizer or rate refreshes firms' undecided appeals through
// refreshUndecidedAppeals, which works firm by firm under the tenant lock.
//
// Every change lands in reference_change_log (database trigger) with the
// super admin as the actor.

import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { z } from "zod";
import { withContext } from "../db.js";
import { parseCsv, toIsoDate } from "../seed/csv.js";
import { refreshUndecidedAppeals, type RefreshResult } from "../reference-refresh.js";
import { LEVELS, type Level } from "../../shared/domain.js";

export const adminReferenceRouter = Router();

const id = z.coerce.number().int().positive();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates use YYYY-MM-DD");
const year = z.coerce.number().int().min(1990).max(2100);
const optText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));
const factorVal = z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, "Equalizer: a number with up to 4 decimals")).refine((v) => Number(v) > 0, "Equalizer must be above 0");
const rateVal = z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,3}(\.\d{1,6})?$/, "Rate: a percent with up to 6 decimals")).refine((v) => Number(v) > 0, "Rate must be above 0");

function adminCtx(req: Request) {
  return { actorKind: "super_admin" as const, userId: req.auth!.user.id, firmId: null };
}

function bad(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

function zodMessage(err: z.ZodError): string {
  return err.issues.map((i) => i.message).filter((m, i, a) => a.indexOf(m) === i).join(" ");
}

function idParam(req: Request): number | null {
  const n = Number(req.params.id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function checkTownship(c: pg.PoolClient, countyId: number, townshipId: number | null | undefined): Promise<void> {
  const county = await c.query(`SELECT 1 FROM counties WHERE id = $1`, [countyId]);
  if (!county.rowCount) throw Object.assign(new Error("county"), { status: 400, publicMessage: "Unknown county." });
  if (townshipId) {
    const ok = await c.query(`SELECT 1 FROM townships WHERE id = $1 AND county_id = $2`, [townshipId, countyId]);
    if (!ok.rowCount) throw Object.assign(new Error("township"), { status: 400, publicMessage: "That township isn't in the chosen county." });
  }
}

// ---------------------------------------------------------------- filing windows
const WindowBody = z.object({
  countyId: id,
  townshipId: id.nullable().optional(),
  level: z.enum(LEVELS),
  assessmentYear: year,
  opensOn: isoDate,
  closesOn: isoDate,
  note: optText(300),
}).refine((v) => v.closesOn >= v.opensOn, { message: "The window can't close before it opens." });

adminReferenceRouter.post("/windows", async (req, res) => {
  const parsed = WindowBody.safeParse(req.body);
  if (!parsed.success) return bad(res, zodMessage(parsed.error));
  const d = parsed.data;
  const row = await withContext(adminCtx(req), async (c) => {
    await checkTownship(c, d.countyId, d.townshipId);
    const clash = await c.query(
      `SELECT 1 FROM filing_windows WHERE county_id = $1 AND COALESCE(township_id, 0) = COALESCE($2::int, 0) AND level = $3 AND assessment_year = $4`,
      [d.countyId, d.townshipId ?? null, d.level, d.assessmentYear],
    );
    if (clash.rowCount) throw Object.assign(new Error("dupe"), { status: 409, publicMessage: "There's already a window for that township, level and year. Edit it instead." });
    return (await c.query(
      `INSERT INTO filing_windows (county_id, township_id, level, assessment_year, opens_on, closes_on, note, updated_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [d.countyId, d.townshipId ?? null, d.level, d.assessmentYear, d.opensOn, d.closesOn, d.note, req.auth!.user.id],
    )).rows[0];
  });
  res.status(201).json({ id: row.id });
});

adminReferenceRouter.patch("/windows/:id", async (req, res) => {
  const wid = idParam(req);
  const parsed = WindowBody.safeParse(req.body);
  if (!wid) return bad(res, "Invalid window.");
  if (!parsed.success) return bad(res, zodMessage(parsed.error));
  const d = parsed.data;
  const r = await withContext(adminCtx(req), async (c) => {
    await checkTownship(c, d.countyId, d.townshipId);
    return c.query(
      `UPDATE filing_windows SET county_id = $2, township_id = $3, level = $4, assessment_year = $5, opens_on = $6, closes_on = $7,
              note = $8, is_sample = false, updated_by_user_id = $9, updated_at = now()
        WHERE id = $1`,
      [wid, d.countyId, d.townshipId ?? null, d.level, d.assessmentYear, d.opensOn, d.closesOn, d.note, req.auth!.user.id],
    );
  });
  if (!r.rowCount) { res.status(404).json({ error: "Window not found." }); return; }
  res.json({ ok: true });
});

adminReferenceRouter.delete("/windows/:id", async (req, res) => {
  const wid = idParam(req);
  if (!wid) return bad(res, "Invalid window.");
  const r = await withContext(adminCtx(req), (c) => c.query(`DELETE FROM filing_windows WHERE id = $1`, [wid]));
  if (!r.rowCount) { res.status(404).json({ error: "Window not found." }); return; }
  res.json({ ok: true });
});

// ---------------------------------------------------------------- equalizers
const EqualizerBody = z.object({
  countyId: id,
  townshipId: id.nullable().optional(),
  year,
  factor: factorVal,
  source: optText(300),
});

adminReferenceRouter.post("/equalizers", async (req, res) => {
  const parsed = EqualizerBody.safeParse(req.body);
  if (!parsed.success) return bad(res, zodMessage(parsed.error));
  const d = parsed.data;
  const row = await withContext(adminCtx(req), async (c) => {
    await checkTownship(c, d.countyId, d.townshipId);
    const clash = await c.query(
      `SELECT 1 FROM equalizers WHERE county_id = $1 AND COALESCE(township_id, 0) = COALESCE($2::int, 0) AND year = $3`,
      [d.countyId, d.townshipId ?? null, d.year],
    );
    if (clash.rowCount) throw Object.assign(new Error("dupe"), { status: 409, publicMessage: "There's already an equalizer for that county, township and year. Edit it instead." });
    return (await c.query(
      `INSERT INTO equalizers (county_id, township_id, year, factor, source, updated_by_user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [d.countyId, d.townshipId ?? null, d.year, d.factor, d.source, req.auth!.user.id],
    )).rows[0];
  });
  const refresh = await refreshUndecidedAppeals([d.countyId]);
  res.status(201).json({ id: row.id, refresh });
});

adminReferenceRouter.patch("/equalizers/:id", async (req, res) => {
  const eid = idParam(req);
  const parsed = EqualizerBody.safeParse(req.body);
  if (!eid) return bad(res, "Invalid equalizer.");
  if (!parsed.success) return bad(res, zodMessage(parsed.error));
  const d = parsed.data;
  const before = await withContext(adminCtx(req), async (c) => {
    await checkTownship(c, d.countyId, d.townshipId);
    const old = (await c.query<{ county_id: number }>(`SELECT county_id FROM equalizers WHERE id = $1`, [eid])).rows[0];
    if (!old) return null;
    await c.query(
      `UPDATE equalizers SET county_id = $2, township_id = $3, year = $4, factor = $5, source = $6, is_sample = false,
              updated_by_user_id = $7, updated_at = now() WHERE id = $1`,
      [eid, d.countyId, d.townshipId ?? null, d.year, d.factor, d.source, req.auth!.user.id],
    );
    return old;
  });
  if (!before) { res.status(404).json({ error: "Equalizer not found." }); return; }
  const refresh = await refreshUndecidedAppeals([before.county_id, d.countyId]);
  res.json({ ok: true, refresh });
});

adminReferenceRouter.delete("/equalizers/:id", async (req, res) => {
  const eid = idParam(req);
  if (!eid) return bad(res, "Invalid equalizer.");
  const gone = await withContext(adminCtx(req), async (c) =>
    (await c.query<{ county_id: number }>(`DELETE FROM equalizers WHERE id = $1 RETURNING county_id`, [eid])).rows[0] ?? null,
  );
  if (!gone) { res.status(404).json({ error: "Equalizer not found." }); return; }
  const refresh = await refreshUndecidedAppeals([gone.county_id]);
  res.json({ ok: true, refresh });
});

// ---------------------------------------------------------------- tax rates
const RateBody = z.object({
  countyId: id,
  taxCode: z.string().trim().min(1, "Tax code is required").max(20),
  taxYear: year,
  ratePercent: rateVal,
  source: optText(300),
});

adminReferenceRouter.post("/tax-rates", async (req, res) => {
  const parsed = RateBody.safeParse(req.body);
  if (!parsed.success) return bad(res, zodMessage(parsed.error));
  const d = parsed.data;
  const row = await withContext(adminCtx(req), async (c) => {
    await checkTownship(c, d.countyId, null);
    const clash = await c.query(`SELECT 1 FROM tax_rates WHERE county_id = $1 AND tax_code = $2 AND tax_year = $3`, [d.countyId, d.taxCode, d.taxYear]);
    if (clash.rowCount) throw Object.assign(new Error("dupe"), { status: 409, publicMessage: "There's already a rate for that tax code and year. Edit it instead." });
    return (await c.query(
      `INSERT INTO tax_rates (county_id, tax_code, tax_year, rate_percent, source, updated_by_user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [d.countyId, d.taxCode, d.taxYear, d.ratePercent, d.source, req.auth!.user.id],
    )).rows[0];
  });
  const refresh = await refreshUndecidedAppeals([d.countyId]);
  res.status(201).json({ id: row.id, refresh });
});

adminReferenceRouter.patch("/tax-rates/:id", async (req, res) => {
  const rid = idParam(req);
  const parsed = RateBody.safeParse(req.body);
  if (!rid) return bad(res, "Invalid rate.");
  if (!parsed.success) return bad(res, zodMessage(parsed.error));
  const d = parsed.data;
  const before = await withContext(adminCtx(req), async (c) => {
    await checkTownship(c, d.countyId, null);
    const old = (await c.query<{ county_id: number }>(`SELECT county_id FROM tax_rates WHERE id = $1`, [rid])).rows[0];
    if (!old) return null;
    await c.query(
      `UPDATE tax_rates SET county_id = $2, tax_code = $3, tax_year = $4, rate_percent = $5, source = $6, is_sample = false,
              updated_by_user_id = $7, updated_at = now() WHERE id = $1`,
      [rid, d.countyId, d.taxCode, d.taxYear, d.ratePercent, d.source, req.auth!.user.id],
    );
    return old;
  });
  if (!before) { res.status(404).json({ error: "Rate not found." }); return; }
  const refresh = await refreshUndecidedAppeals([before.county_id, d.countyId]);
  res.json({ ok: true, refresh });
});

adminReferenceRouter.delete("/tax-rates/:id", async (req, res) => {
  const rid = idParam(req);
  if (!rid) return bad(res, "Invalid rate.");
  const gone = await withContext(adminCtx(req), async (c) =>
    (await c.query<{ county_id: number }>(`DELETE FROM tax_rates WHERE id = $1 RETURNING county_id`, [rid])).rows[0] ?? null,
  );
  if (!gone) { res.status(404).json({ error: "Rate not found." }); return; }
  const refresh = await refreshUndecidedAppeals([gone.county_id]);
  res.json({ ok: true, refresh });
});

// ---------------------------------------------------------------- townships
const TownshipBody = z.object({
  countyId: id,
  name: z.string().trim().min(2, "Township name is required").max(80),
  triad: z.enum(["City", "North", "South"]).nullable().optional(),
});

adminReferenceRouter.post("/townships", async (req, res) => {
  const parsed = TownshipBody.safeParse(req.body);
  if (!parsed.success) return bad(res, zodMessage(parsed.error));
  const d = parsed.data;
  const row = await withContext(adminCtx(req), async (c) => {
    await checkTownship(c, d.countyId, null);
    const clash = await c.query(`SELECT 1 FROM townships WHERE county_id = $1 AND lower(name) = lower($2)`, [d.countyId, d.name]);
    if (clash.rowCount) throw Object.assign(new Error("dupe"), { status: 409, publicMessage: "That county already has a township with this name." });
    return (await c.query(`INSERT INTO townships (county_id, name, triad) VALUES ($1, $2, $3) RETURNING id`, [d.countyId, d.name, d.triad ?? null])).rows[0];
  });
  res.status(201).json({ id: row.id });
});

// ---------------------------------------------------------------- CSV import
// Upload a whole year at once. Every row is checked first; if any row is
// wrong nothing is saved and the errors come back with their row numbers.
// Rows that already exist are updated, identical rows are left alone.

type Kind = "windows" | "equalizers" | "tax-rates";
const LEVEL_WORDS: Record<string, Level> = {
  assessor: "assessor", "board of review": "bor", bor: "bor", ptab: "ptab", "property tax appeal board": "ptab",
  "circuit court": "circuit", circuit: "circuit", "tax objection": "circuit",
};

const COLUMNS: Record<Kind, Record<string, string[]>> = {
  windows: { county: ["county"], township: ["township"], level: ["level"], year: ["year", "assessment year"], opens: ["opens", "opens on", "open"], closes: ["closes", "closes on", "close"], note: ["note", "notes"] },
  equalizers: { county: ["county"], township: ["township"], year: ["year"], factor: ["factor", "equalizer", "multiplier"], source: ["source"] },
  "tax-rates": { county: ["county"], code: ["tax code", "code"], year: ["tax year", "year"], rate: ["rate", "rate %", "tax rate", "tax rate %", "rate percent"], source: ["source"] },
};
const REQUIRED: Record<Kind, string[]> = {
  windows: ["county", "level", "year", "opens", "closes"],
  equalizers: ["county", "year", "factor"],
  "tax-rates": ["county", "code", "year", "rate"],
};

function pick(row: Record<string, string>, names: string[]): string {
  for (const [k, v] of Object.entries(row)) if (names.includes(k.trim().toLowerCase())) return v.trim();
  return "";
}

/** A real calendar date from "2026-09-14" or "09/14/2026", or null (13/45/2026 is not a date). */
function csvDate(v: string): string | null {
  let d: string | null;
  try { d = toIsoDate(v); } catch { return null; }
  if (!d) return null;
  const [y, m, day] = d.split("-").map(Number);
  const check = new Date(Date.UTC(y, m - 1, day));
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === day ? d : null;
}

adminReferenceRouter.post("/import/:kind", async (req, res) => {
  const kind = req.params.kind as Kind;
  if (!(kind in COLUMNS)) return bad(res, "Unknown import type.");
  const text = typeof req.body?.csv === "string" ? req.body.csv : "";
  if (!text.trim()) return bad(res, "Paste or choose a CSV file first.");
  let rows: Record<string, string>[];
  try { rows = parseCsv(text); } catch { return bad(res, "That file couldn't be read as CSV."); }
  if (!rows.length) return bad(res, "The CSV has a header row but no data rows.");
  const headers = Object.keys(rows[0]).map((h) => h.trim().toLowerCase());
  const missing = REQUIRED[kind].filter((col) => !COLUMNS[kind][col].some((n) => headers.includes(n)));
  if (missing.length) {
    return bad(res, `Missing column${missing.length > 1 ? "s" : ""}: ${missing.map((m) => COLUMNS[kind][m][0].replace(/^./, (x) => x.toUpperCase())).join(", ")}.`);
  }

  const result = await withContext(adminCtx(req), async (c) => {
    const counties = (await c.query<{ id: number; name: string }>(`SELECT id, name FROM counties WHERE state = 'IL'`)).rows;
    const townships = (await c.query<{ id: number; county_id: number; name: string }>(`SELECT id, county_id, name FROM townships`)).rows;
    const countyId = (n: string) => counties.find((x) => x.name.toLowerCase() === n.toLowerCase().replace(/\s+county$/, ""))?.id;
    const townshipId = (cid: number, n: string) => townships.find((t) => t.county_id === cid && t.name.toLowerCase() === n.toLowerCase())?.id;

    const errors: string[] = [];
    const clean: Record<string, unknown>[] = [];
    rows.forEach((r, i) => {
      const line = i + 2; // header is line 1
      const err = (m: string) => errors.push(`Row ${line}: ${m}`);
      const get = (col: string) => pick(r, COLUMNS[kind][col] ?? []);
      const cid = countyId(get("county"));
      if (!cid) return err(`unknown county "${get("county")}"`);
      const yr = Number(get("year"));
      if (!Number.isInteger(yr) || yr < 1990 || yr > 2100) return err(`year "${get("year")}" isn't a year`);
      let tid: number | null = null;
      if (kind !== "tax-rates" && get("township")) {
        tid = townshipId(cid, get("township")) ?? null;
        if (!tid) return err(`"${get("township")}" isn't a township in ${get("county")}. Add it under Townships first`);
      }
      if (kind === "windows") {
        const level = LEVEL_WORDS[get("level").toLowerCase()];
        const opens = csvDate(get("opens")), closes = csvDate(get("closes"));
        if (!level) return err(`level "${get("level")}" should be Assessor, Board of Review, PTAB or Circuit Court`);
        if (!opens || !closes) return err("dates should look like 2026-09-14 or 09/14/2026");
        if (closes < opens) return err("closes before it opens");
        clean.push({ cid, tid, level, yr, opens, closes, note: get("note") || null });
      } else if (kind === "equalizers") {
        const f = factorVal.safeParse(get("factor"));
        if (!f.success) return err(`factor "${get("factor")}" should be a number with up to 4 decimals`);
        clean.push({ cid, tid, yr, factor: f.data, source: get("source") || null });
      } else {
        const code = get("code");
        const rate = rateVal.safeParse(get("rate").replace(/%$/, ""));
        if (!code) return err("tax code is blank");
        if (!rate.success) return err(`rate "${get("rate")}" should be a percent with up to 6 decimals, like 7.943607`);
        clean.push({ cid, code, yr, rate: rate.data, source: get("source") || null });
      }
    });
    if (errors.length) return { errors };

    let added = 0, updated = 0, unchanged = 0;
    const uid = req.auth!.user.id;
    for (const x of clean) {
      let r: pg.QueryResult<{ inserted: boolean }>;
      if (kind === "windows") {
        r = await c.query(
          `INSERT INTO filing_windows (county_id, township_id, level, assessment_year, opens_on, closes_on, note, updated_by_user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (county_id, COALESCE(township_id, 0), level, assessment_year) DO UPDATE
             SET opens_on = EXCLUDED.opens_on, closes_on = EXCLUDED.closes_on, note = EXCLUDED.note, is_sample = false,
                 updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()
           WHERE (filing_windows.opens_on, filing_windows.closes_on, filing_windows.note, filing_windows.is_sample)
                 IS DISTINCT FROM (EXCLUDED.opens_on, EXCLUDED.closes_on, EXCLUDED.note, false)
           RETURNING (xmax = 0) AS inserted`,
          [x.cid, x.tid, x.level, x.yr, x.opens, x.closes, x.note, uid],
        );
      } else if (kind === "equalizers") {
        r = await c.query(
          `INSERT INTO equalizers (county_id, township_id, year, factor, source, updated_by_user_id) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (county_id, COALESCE(township_id, 0), year) DO UPDATE
             SET factor = EXCLUDED.factor, source = EXCLUDED.source, is_sample = false, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()
           WHERE (equalizers.factor, equalizers.source, equalizers.is_sample) IS DISTINCT FROM (EXCLUDED.factor, EXCLUDED.source, false)
           RETURNING (xmax = 0) AS inserted`,
          [x.cid, x.tid, x.yr, x.factor, x.source, uid],
        );
      } else {
        r = await c.query(
          `INSERT INTO tax_rates (county_id, tax_code, tax_year, rate_percent, source, updated_by_user_id) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (county_id, tax_code, tax_year) DO UPDATE
             SET rate_percent = EXCLUDED.rate_percent, source = EXCLUDED.source, is_sample = false, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()
           WHERE (tax_rates.rate_percent, tax_rates.source, tax_rates.is_sample) IS DISTINCT FROM (EXCLUDED.rate_percent, EXCLUDED.source, false)
           RETURNING (xmax = 0) AS inserted`,
          [x.cid, x.code, x.yr, x.rate, x.source, uid],
        );
      }
      if (!r.rowCount) unchanged++;
      else if (r.rows[0].inserted) added++;
      else updated++;
    }
    return { added, updated, unchanged, counties: [...new Set(clean.map((x) => x.cid as number))] };
  });

  if ("errors" in result) {
    res.status(400).json({ error: `Nothing was saved. Fix ${result.errors!.length === 1 ? "this row" : "these rows"} and upload again.`, rows: result.errors!.slice(0, 50) });
    return;
  }
  let refresh: RefreshResult = { appealsUpdated: 0, firmsUpdated: 0 };
  if (kind !== "windows" && (result.added || result.updated)) refresh = await refreshUndecidedAppeals(result.counties);
  res.json({ added: result.added, updated: result.updated, unchanged: result.unchanged, refresh });
});
