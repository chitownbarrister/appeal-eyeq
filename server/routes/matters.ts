// Properties (the matter), parcels, appeals, accounts (clients), contacts,
// activities and global search. Mounted under /api/firm after
// requireFirmContext, so req.ctx is always set. Every query runs inside
// withContext (row-level security applies) AND filters on firm_id.
// Users live outside the tenant lock, so joins to users also match firm_id.

import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { z } from "zod";
import { withContext } from "../db.js";
import { requirePermission } from "../auth.js";
import { LEVELS, LEVEL_LABELS, SUBSTAGES, APPEAL_STATUSES, matterTitle, pinKey, type Level } from "../../shared/domain.js";
import { computeAppealTax } from "../../shared/valuation.js";
import { centsToString, toCents } from "../../shared/money.js";
import { effectiveFee, firstYearFee, type FeeBasis } from "../../shared/fees.js";
import { referenceFor, differsFromReference, isManualSource, windowFor } from "../reference-lookup.js";
import { todayIso } from "../today.js";
import { LEVEL_SHORT, WINDOW_ACTIVE_SUBSTAGES, buildDeadlineList, windowItem, type DeadlineRow } from "../deadlines.js";
import { applyRollover, refreshAppealFromPins, rolloverIntoNewAppeal, seedPinsForNewAppeal } from "../appeal-pins.js";
import { ensureAppealFolder } from "./property-files.js";
import { detachLetters } from "../decisions/apply.js";

export const mattersRouter = Router();

// ---------------------------------------------------------------- helpers
const money = z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, "Use a number with up to 2 decimals"));
const equalizerVal = z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, "Equalizer: up to 4 decimals"));
const rateVal = z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,3}(\.\d{1,6})?$/, "Rate: a percent with up to 6 decimals"));
const percentVal = z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, "Percent: up to 2 decimals")).refine((v) => Number(v) <= 100, "Percent can't exceed 100");
const optText = (max = 500) => z.string().trim().max(max).nullable().optional().transform((v) => (v === "" ? null : v));
const optDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().or(z.literal("").transform(() => null));
const id = z.coerce.number().int().positive();

function idParam(req: Request): number | null {
  const n = Number(req.params.id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function bad(res: Response, err: z.ZodError | string): void {
  const message = typeof err === "string" ? err : err.issues.map((i) => i.message).filter((m, i, a) => a.indexOf(m) === i).join(" ");
  res.status(400).json({ error: message || "Invalid input." });
}

const LEVEL_ORDER = `array_position(ARRAY['assessor','bor','ptab','circuit']::text[], a.level)`;

/** Default level of assessment: Cook residential 10%, Cook commercial/industrial 25%, collar counties 33.33%. */
function defaultRatio(countyName: string, assetType: string): string {
  if (countyName === "Cook") return assetType === "residential" ? "10.00" : "25.00";
  return "33.33";
}

/** Substages after which an appeal's figures are settled (invoiced, pushed on, or closed). */
const SETTLED_SUBSTAGES = ["invoice_sent", "pushed_next_level", "closed"];

/**
 * When a newer equalizer or rate is published than an appeal uses, and the
 * appeal wasn't refreshed automatically (it's decided, or its figures were
 * entered by hand), say so, so someone can apply it with one click.
 */
function referenceUpdate(a: Record<string, any>, ref: Awaited<ReturnType<typeof referenceFor>>) {
  if (a.calc_override || SETTLED_SUBSTAGES.includes(a.substage)) return null;
  if (!differsFromReference(a as { equalizer: string | null; tax_rate_percent: string | null }, ref)) return null;
  return {
    equalizer: ref.equalizer!.factor, equalizerYear: ref.equalizer!.year,
    ratePercent: ref.rate!.ratePercent, taxYear: ref.rate!.taxYear,
    manual: isManualSource(a.equalizer_source) || isManualSource(a.tax_rate_source),
  };
}

async function firmFeeDefaults(c: pg.PoolClient, firmId: number) {
  return (await c.query<{ level: Level; percent: string; basis: FeeBasis }>(`SELECT level, percent, basis FROM fee_defaults WHERE firm_id = $1`, [firmId])).rows;
}

function sumParts(parts: (string | null | undefined)[]): string | null {
  const present = parts.filter((p): p is string => p !== null && p !== undefined);
  if (present.length === 0) return null;
  return centsToString(present.reduce((a, p) => a + toCents(p), 0n));
}

/**
 * One matter per PIN: refuses a PIN another property (or another parcel) in the firm already uses,
 * and says which matter has it.
 */
async function assertPinFree(c: pg.PoolClient, firmId: number, pin: string, exceptParcelId: number | null = null): Promise<void> {
  const key = pinKey(pin);
  if (!key) throw Object.assign(new Error("pin"), { status: 400, publicMessage: "Enter a PIN with its digits." });
  const hit = (await c.query<{ property_id: number; pin: string; address1: string | null; name: string; city: string | null; township: string | null }>(
    `SELECT x.property_id, x.pin, p.address1, p.name, p.city, t.name AS township
       FROM parcels x JOIN properties p ON p.firm_id = x.firm_id AND p.id = x.property_id
       LEFT JOIN townships t ON t.id = p.township_id
      WHERE x.firm_id = $1 AND x.pin_key = $2 AND ($3::int IS NULL OR x.id <> $3) LIMIT 1`,
    [firmId, key, exceptParcelId],
  )).rows[0];
  if (hit) {
    throw Object.assign(new Error("dupe pin"), {
      status: 409,
      publicMessage: `PIN ${hit.pin} is already the matter ${matterTitle(hit.pin, hit.address1 || hit.name, hit.city, hit.township)}. Open that property instead of adding it again.`,
      extra: { existingPropertyId: hit.property_id },
    });
  }
}

// ================================================================ properties
mattersRouter.get("/properties", async (req, res) => {
  const firmId = req.ctx!.firmId;
  const rows = await withContext(req.ctx!, async (c) =>
    (await c.query(
      `WITH cur AS (
         SELECT DISTINCT ON (a.property_id) a.*
           FROM appeals a WHERE a.firm_id = $1
          ORDER BY a.property_id, a.assessment_year DESC, ${LEVEL_ORDER} DESC
       )
       SELECT p.id, p.name, p.address1, p.city, p.state, p.zip, p.status, p.asset_type, p.use_type, p.tax_code,
              co.name AS county, t.name AS township, p.account_id, ac.name AS account_name,
              p.attorney_user_id, att.name AS attorney_name, p.analyst_user_id, ana.name AS analyst_name,
              pp.pin, p.no_fee,
              cur.id AS appeal_id, cur.level, cur.substage, cur.status AS appeal_status, cur.assessment_year,
              GREATEST(0, EXTRACT(day FROM now() - cur.substage_since))::int AS days_in_substage,
              cur.orig_av AS current_av, cur.target_av, cur.estimated_savings, cur.next_action, cur.next_action_on,
              win.opens_on AS window_opens_on, win.closes_on AS window_closes_on,
              nd.title AS deadline_title, nd.due_on AS deadline_on, nd.kind AS deadline_kind,
              COALESCE(pt.years, '{}') AS pending_ptab_years
         FROM properties p
         JOIN accounts ac ON ac.firm_id = p.firm_id AND ac.id = p.account_id
         JOIN counties co ON co.id = p.county_id
         LEFT JOIN townships t ON t.id = p.township_id
         LEFT JOIN users att ON att.firm_id = p.firm_id AND att.id = p.attorney_user_id
         LEFT JOIN users ana ON ana.firm_id = p.firm_id AND ana.id = p.analyst_user_id
         LEFT JOIN LATERAL (
           SELECT x.pin FROM parcels x WHERE x.firm_id = p.firm_id AND x.property_id = p.id
            ORDER BY x.is_primary DESC, x.id LIMIT 1
         ) pp ON true
         LEFT JOIN cur ON cur.property_id = p.id
         LEFT JOIN LATERAL (
           SELECT w.opens_on, w.closes_on FROM filing_windows w
            WHERE w.county_id = p.county_id AND (w.township_id IS NULL OR w.township_id = p.township_id)
              AND w.level = cur.level AND w.assessment_year = cur.assessment_year
            ORDER BY w.township_id NULLS LAST LIMIT 1
         ) win ON true
         LEFT JOIN LATERAL (
           SELECT array_agg(DISTINCT x.assessment_year ORDER BY x.assessment_year) AS years FROM appeals x
            WHERE x.firm_id = p.firm_id AND x.property_id = p.id AND x.level = 'ptab' AND x.status IN ('open', 'waiting_decision')
         ) pt ON true
         LEFT JOIN LATERAL (
           SELECT d.title, d.due_on, d.kind FROM deadlines d
            WHERE d.firm_id = p.firm_id AND d.property_id = p.id AND d.status = 'open'
            ORDER BY d.due_on, d.due_time NULLS LAST LIMIT 1
         ) nd ON true
        WHERE p.firm_id = $1
        ORDER BY p.name`,
      [firmId],
    )).rows,
  );
  const today = todayIso();
  res.json({
    today,
    properties: rows.map((r) => {
      const unfiledSubstage = r.substage && WINDOW_ACTIVE_SUBSTAGES.includes(r.substage);
      const unfiled = Boolean(unfiledSubstage && r.window_opens_on && r.window_opens_on <= today && today <= r.window_closes_on);
      // The next date: the earliest open deadline, or the window close for an appeal not yet filed.
      const candidates: { title: string; on: string; kind: string }[] = [];
      if (r.deadline_on) candidates.push({ title: r.deadline_title, on: r.deadline_on, kind: r.deadline_kind });
      if (unfiledSubstage && r.window_closes_on && r.window_closes_on >= today) {
        const label = `${r.township ?? r.county} ${LEVEL_SHORT[r.level as Level]} window ${r.window_opens_on > today ? "opens" : "closes"}`;
        candidates.push({ title: label, on: r.window_opens_on > today ? r.window_opens_on : r.window_closes_on, kind: "window" });
      }
      candidates.sort((a, b) => a.on.localeCompare(b.on));
      const next = candidates[0] ?? (r.next_action_on || r.next_action ? { title: r.next_action ?? "", on: r.next_action_on, kind: "note" } : null);
      const { deadline_title: _t, deadline_on: _o, deadline_kind: _k, ...rest } = r;
      return {
        ...rest,
        title: matterTitle(r.pin, r.address1 || r.name, r.city, r.township),
        unfiled_window_open: unfiled,
        next_title: next?.title ?? null,
        next_on: next?.on ?? null,
        next_kind: next?.kind ?? null,
      };
    }),
  });
});

const PropertyFields = {
  name: z.string().trim().min(1).max(200).optional(),
  address1: z.string().trim().min(1, "Address is required").max(200),
  address2: optText(200),
  city: z.string().trim().min(1, "City is required").max(120),
  state: z.string().trim().length(2).default("IL"),
  zip: optText(10),
  countyId: id,
  townshipId: id.nullable().optional(),
  taxCode: optText(20),
  taxCodeConfirmed: z.boolean().optional(),
  assetType: z.enum(["residential", "commercial", "industrial"]),
  useType: optText(120),
  levelOfAssessment: percentVal.nullable().optional(),
  attorneyUserId: id.nullable().optional(),
  analystUserId: id.nullable().optional(),
  status: z.enum(["active", "closed", "inactive", "sold"]).optional(),
  purchaseDate: optDate,
  purchasePrice: money.nullable().optional(),
  yearBuilt: z.coerce.number().int().min(1700).max(2100).nullable().optional(),
  buildingSqft: z.coerce.number().int().min(0).nullable().optional(),
  units: z.coerce.number().int().min(0).nullable().optional(),
  acreage: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,6}(\.\d{1,4})?$/)).nullable().optional(),
  notes: optText(4000),
};

const NewProperty = z.object({
  ...PropertyFields,
  accountId: id.optional(),
  newAccount: z.object({ name: z.string().trim().min(1).max(200), accountType: z.enum(["individual", "entity"]) }).optional(),
  pin: z.string().trim().min(5, "PIN is required").max(40),
  ownerName: optText(200),
  firstAppeal: z.object({ assessmentYear: z.coerce.number().int().min(2000).max(2100), level: z.enum(LEVELS) }).optional(),
}).refine((v) => v.accountId || v.newAccount, { message: "Choose a client or create a new one." });

mattersRouter.post("/properties", requirePermission("properties.edit"), async (req, res) => {
  const parsed = NewProperty.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed.error);
  const d = parsed.data;
  const firmId = req.ctx!.firmId!;
  const created = await withContext(req.ctx!, async (c) => {
    let accountId = d.accountId ?? null;
    if (!accountId && d.newAccount) {
      accountId = (await c.query<{ id: number }>(
        `INSERT INTO accounts (firm_id, name, account_type) VALUES ($1, $2, $3) RETURNING id`,
        [firmId, d.newAccount.name, d.newAccount.accountType],
      )).rows[0].id;
    }
    await assertPinFree(c, firmId, d.pin);
    const county = (await c.query<{ name: string }>(`SELECT name FROM counties WHERE id = $1`, [d.countyId])).rows[0];
    if (!county) throw Object.assign(new Error("county"), { status: 400, publicMessage: "Unknown county." });
    if (d.townshipId) {
      const ok = await c.query(`SELECT 1 FROM townships WHERE id = $1 AND county_id = $2`, [d.townshipId, d.countyId]);
      if (!ok.rowCount) throw Object.assign(new Error("township"), { status: 400, publicMessage: "That township isn't in the chosen county." });
    }
    const prop = (await c.query<{ id: number }>(
      `INSERT INTO properties (firm_id, account_id, name, address1, address2, city, state, zip, county_id, township_id, tax_code,
                               tax_code_confirmed, asset_type, use_type, level_of_assessment, attorney_user_id, analyst_user_id,
                               status, purchase_date, purchase_price, year_built, building_sqft, units, acreage, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,COALESCE($18,'active'),$19,$20,$21,$22,$23,$24,$25)
       RETURNING id`,
      [
        firmId, accountId, d.name || d.address1, d.address1, d.address2 ?? null, d.city, d.state, d.zip ?? null, d.countyId,
        d.townshipId ?? null, d.taxCode ?? null, d.taxCodeConfirmed ?? false, d.assetType, d.useType ?? null,
        d.levelOfAssessment ?? defaultRatio(county.name, d.assetType), d.attorneyUserId ?? null, d.analystUserId ?? null,
        d.status ?? null, d.purchaseDate ?? null, d.purchasePrice ?? null, d.yearBuilt ?? null, d.buildingSqft ?? null,
        d.units ?? null, d.acreage ?? null, d.notes ?? null,
      ],
    )).rows[0];
    await c.query(
      `INSERT INTO parcels (firm_id, property_id, pin, alternate_pin, owner_name, address, city, state, zip, is_primary)
       VALUES ($1, $2, $3, $3, $4, upper($5), upper($6), $7, $8, true)`,
      [firmId, prop.id, d.pin, d.ownerName ?? null, d.address1, d.city, d.state, d.zip ?? null],
    );
    if (d.firstAppeal) {
      await createAppeal(c, req, prop.id, { assessmentYear: d.firstAppeal.assessmentYear, level: d.firstAppeal.level });
    }
    return prop.id;
  });
  res.status(201).json({ id: created });
});

mattersRouter.get("/properties/:id", async (req, res) => {
  const pid = idParam(req);
  if (!pid) return bad(res, "Invalid property.");
  const firmId = req.ctx!.firmId!;
  const data = await withContext(req.ctx!, async (c) => {
    const p = (await c.query(
      `SELECT p.*, co.name AS county, t.name AS township, ac.name AS account_name, ac.account_type, ac.no_fee AS account_no_fee,
              ac.fee_percent_first_year AS account_fee_first_year, ac.fee_percent_refund AS account_fee_refund,
              att.name AS attorney_name, ana.name AS analyst_name
         FROM properties p
         JOIN accounts ac ON ac.firm_id = p.firm_id AND ac.id = p.account_id
         JOIN counties co ON co.id = p.county_id
         LEFT JOIN townships t ON t.id = p.township_id
         LEFT JOIN users att ON att.firm_id = p.firm_id AND att.id = p.attorney_user_id
         LEFT JOIN users ana ON ana.firm_id = p.firm_id AND ana.id = p.analyst_user_id
        WHERE p.firm_id = $1 AND p.id = $2`,
      [firmId, pid],
    )).rows[0];
    if (!p) return null;
    const parcels = (await c.query(
      `SELECT * FROM parcels WHERE firm_id = $1 AND property_id = $2 ORDER BY is_primary DESC, id`, [firmId, pid],
    )).rows;
    const appeals = (await c.query(
      `SELECT a.*, u.name AS representative_name,
              GREATEST(0, EXTRACT(day FROM now() - a.substage_since))::int AS days_in_substage
         FROM appeals a LEFT JOIN users u ON u.firm_id = a.firm_id AND u.id = a.representative_user_id
        WHERE a.firm_id = $1 AND a.property_id = $2
        ORDER BY a.assessment_year DESC, ${LEVEL_ORDER} DESC, a.id DESC`,
      [firmId, pid],
    )).rows;
    const contacts = (await c.query(
      `SELECT * FROM contacts WHERE firm_id = $1 AND (property_id = $2 OR (account_id = $3 AND property_id IS NULL)) ORDER BY role, name`,
      [firmId, pid, p.account_id],
    )).rows;
    const activities = (await c.query(
      `SELECT ac.*, u.name AS assigned_name, cb.name AS created_by_name
         FROM activities ac
         LEFT JOIN users u ON u.firm_id = ac.firm_id AND u.id = ac.assigned_user_id
         LEFT JOIN users cb ON cb.firm_id = ac.firm_id AND cb.id = ac.created_by_user_id
        WHERE ac.firm_id = $1 AND ac.property_id = $2
        ORDER BY (ac.status = 'done'), ac.due_on NULLS LAST, ac.created_at DESC`,
      [firmId, pid],
    )).rows;
    const reference = await referenceFor(c, p.county_id, p.township_id, p.tax_code);
    const feeDefaults = await firmFeeDefaults(c, firmId);
    const deadlineRows = (await c.query<DeadlineRow>(
      `SELECT d.*, a.level FROM deadlines d LEFT JOIN appeals a ON a.firm_id = d.firm_id AND a.id = d.appeal_id
        WHERE d.firm_id = $1 AND d.property_id = $2`,
      [firmId, pid],
    )).rows;
    const cur = appeals[0] ?? null;
    const win = cur ? await windowFor(c, p.county_id, p.township_id, cur.level, cur.assessment_year) : null;
    const letters = (await c.query(
      `SELECT l.id, l.status, l.kind, l.appeal_id, l.applied_at, l.filed_path, l.file_error, l.document_id, l.fields->>'letterDate' AS letter_date
         FROM decision_letters l JOIN decision_uploads u ON u.firm_id = l.firm_id AND u.id = l.upload_id
        WHERE l.firm_id = $1 AND (l.property_id = $2 OR u.property_id = $2) AND l.status <> 'dismissed'
        ORDER BY l.id DESC`,
      [firmId, pid],
    )).rows;
    return { p, parcels, appeals, contacts, activities, reference, feeDefaults, deadlineRows, cur, win, letters };
  });
  if (!data) {
    res.status(404).json({ error: "Property not found." });
    return;
  }
  const { p } = data;
  const today = todayIso();
  const feeSources = {
    firmDefaults: data.feeDefaults,
    account: { fee_percent_first_year: p.account_fee_first_year, fee_percent_refund: p.account_fee_refund, no_fee: p.account_no_fee },
    property: { fee_percent_first_year: p.fee_percent_first_year, fee_percent_refund: p.fee_percent_refund, no_fee: p.no_fee },
  };
  const primary = data.parcels.find((x) => x.is_primary) ?? data.parcels[0];
  res.json({
    property: { ...p, title: matterTitle(primary?.pin ?? null, p.address1 || p.name, p.city, p.township) },
    parcels: data.parcels,
    appeals: data.appeals.map((a) => {
      const fee = effectiveFee(a.level, { ...feeSources, appeal: { fee_percent: a.fee_percent } });
      return {
        ...a, fee, fee_amount: firstYearFee(a.savings, fee), estimated_fee: firstYearFee(a.estimated_savings, fee),
        reference_update: referenceUpdate(a, data.reference),
      };
    }),
    deadlines: buildDeadlineList(data.deadlineRows, windowItem(data.win, data.cur, today), today),
    pendingPtab: data.appeals
      .filter((a) => a.level === "ptab" && ["open", "waiting_decision"].includes(a.status))
      .map((a) => ({ appealId: a.id, year: a.assessment_year, docket: a.petition_no ?? null }))
      .sort((x, y) => x.year - y.year),
    today,
    decisionLetters: data.letters.map((l) => ({
      id: l.id, status: l.status, kind: l.kind, appealId: l.appeal_id, appliedAt: l.applied_at, letterDate: l.letter_date,
      filedPath: l.filed_path, fileError: l.file_error, filed: l.document_id !== null,
    })),
    contacts: data.contacts,
    activities: data.activities,
    reference: data.reference,
    fees: {
      firstYear: effectiveFee("bor", feeSources),
      refund: effectiveFee("ptab", feeSources),
    },
  });
});

const UpdateProperty = z.object(PropertyFields).partial().extend({
  accountId: id.optional(),
  noFee: z.boolean().optional(),
  feePercentFirstYear: percentVal.nullable().optional(),
  feePercentRefund: percentVal.nullable().optional(),
}).strict();

const PROPERTY_COLUMNS: Record<string, string> = {
  name: "name", address1: "address1", address2: "address2", city: "city", state: "state", zip: "zip", countyId: "county_id",
  townshipId: "township_id", taxCode: "tax_code", taxCodeConfirmed: "tax_code_confirmed", assetType: "asset_type",
  useType: "use_type", levelOfAssessment: "level_of_assessment", attorneyUserId: "attorney_user_id",
  analystUserId: "analyst_user_id", status: "status", purchaseDate: "purchase_date", purchasePrice: "purchase_price",
  yearBuilt: "year_built", buildingSqft: "building_sqft", units: "units", acreage: "acreage", notes: "notes",
  accountId: "account_id", noFee: "no_fee", feePercentFirstYear: "fee_percent_first_year", feePercentRefund: "fee_percent_refund",
};
const FEE_FIELDS = ["noFee", "feePercentFirstYear", "feePercentRefund"];

mattersRouter.patch("/properties/:id", requirePermission("properties.edit"), async (req, res) => {
  const pid = idParam(req);
  const parsed = UpdateProperty.safeParse(req.body);
  if (!pid) return bad(res, "Invalid property.");
  if (!parsed.success) return bad(res, parsed.error);
  const changes = Object.entries(parsed.data).filter(([, v]) => v !== undefined);
  if (changes.some(([k]) => FEE_FIELDS.includes(k))) {
    const ok = await hasPermission(req, "fees.edit");
    if (!ok) {
      res.status(403).json({ error: "Your role does not allow changing fee terms." });
      return;
    }
  }
  if (!changes.length) return bad(res, "Nothing to change.");
  const sets = changes.map(([k], i) => `${PROPERTY_COLUMNS[k]} = $${i + 3}`);
  const updated = await withContext(req.ctx!, async (c) => {
    const tw = parsed.data.townshipId, co = parsed.data.countyId;
    if (tw || co) {
      const cur = (await c.query(`SELECT county_id, township_id FROM properties WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, pid])).rows[0];
      if (cur) {
        const county = co ?? cur.county_id, township = tw === undefined ? cur.township_id : tw;
        if (township) {
          const ok = await c.query(`SELECT 1 FROM townships WHERE id = $1 AND county_id = $2`, [township, county]);
          if (!ok.rowCount) throw Object.assign(new Error("township"), { status: 400, publicMessage: "That township isn't in the chosen county." });
        }
      }
    }
    return c.query(`UPDATE properties SET ${sets.join(", ")} WHERE firm_id = $1 AND id = $2 RETURNING id`, [
      req.ctx!.firmId, pid, ...changes.map(([, v]) => v),
    ]);
  });
  if (!updated.rowCount) {
    res.status(404).json({ error: "Property not found." });
    return;
  }
  res.json({ ok: true });
});

mattersRouter.delete("/properties/:id", requirePermission("properties.delete"), async (req, res) => {
  const pid = idParam(req);
  if (!pid) return bad(res, "Invalid property.");
  const r = await withContext(req.ctx!, async (c) => {
    // Invoices are part of the firm's billing record; drafts can go, anything sent stays.
    if ((await c.query(`SELECT 1 FROM invoices WHERE firm_id = $1 AND property_id = $2 AND status <> 'draft'`, [req.ctx!.firmId, pid])).rowCount) {
      throw Object.assign(new Error("invoices"), { status: 409, publicMessage: "This property has invoices, which stay in the billing record. Mark it Closed or Sold instead of deleting it." });
    }
    await c.query(`DELETE FROM invoices WHERE firm_id = $1 AND property_id = $2 AND status = 'draft'`, [req.ctx!.firmId, pid]);
    // Decision letters matched to it go back to review instead of blocking the delete.
    await detachLetters(c, req.ctx!.firmId!, { propertyId: pid });
    return c.query(`DELETE FROM properties WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, pid]);
  });
  if (!r.rowCount) {
    res.status(404).json({ error: "Property not found." });
    return;
  }
  res.json({ ok: true });
});

async function hasPermission(req: Request, permission: string): Promise<boolean> {
  if (req.auth?.user.isSuperAdmin) return false;
  return withContext(req.ctx!, async (c) =>
    (await c.query(`SELECT allowed FROM role_permissions WHERE firm_id = $1 AND role = $2 AND permission = $3`, [
      req.ctx!.firmId, req.auth!.user.role, permission,
    ])).rows[0]?.allowed === true,
  );
}

// ================================================================ parcels
const ParcelBody = z.object({
  pin: z.string().trim().min(5, "PIN is required").max(40),
  alternatePin: optText(40),
  ownerName: optText(200),
  parcelType: z.enum(["real", "personal"]).default("real"),
  class: optText(40),
  address: optText(200),
  city: optText(120),
  state: optText(2),
  zip: optText(10),
  active: z.boolean().optional(),
});

mattersRouter.post("/properties/:id/parcels", requirePermission("properties.edit"), async (req, res) => {
  const pid = idParam(req);
  const parsed = ParcelBody.safeParse(req.body);
  if (!pid) return bad(res, "Invalid property.");
  if (!parsed.success) return bad(res, parsed.error);
  const d = parsed.data;
  const row = await withContext(req.ctx!, async (c) => {
    const p = await c.query(`SELECT 1 FROM properties WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, pid]);
    if (!p.rowCount) return null;
    await assertPinFree(c, req.ctx!.firmId!, d.pin);
    return (await c.query(
      `INSERT INTO parcels (firm_id, property_id, pin, alternate_pin, owner_name, parcel_type, class, address, city, state, zip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.ctx!.firmId, pid, d.pin, d.alternatePin ?? null, d.ownerName ?? null, d.parcelType, d.class ?? null, d.address ?? null, d.city ?? null, d.state ?? null, d.zip ?? null],
    )).rows[0];
  });
  if (!row) {
    res.status(404).json({ error: "Property not found." });
    return;
  }
  res.status(201).json({ parcel: row });
});

mattersRouter.patch("/parcels/:id", requirePermission("properties.edit"), async (req, res) => {
  const pid = idParam(req);
  const parsed = ParcelBody.partial().strict().safeParse(req.body);
  if (!pid) return bad(res, "Invalid parcel.");
  if (!parsed.success) return bad(res, parsed.error);
  const map: Record<string, string> = { pin: "pin", alternatePin: "alternate_pin", ownerName: "owner_name", parcelType: "parcel_type", class: "class", address: "address", city: "city", state: "state", zip: "zip", active: "active" };
  const changes = Object.entries(parsed.data).filter(([, v]) => v !== undefined);
  if (!changes.length) return bad(res, "Nothing to change.");
  const r = await withContext(req.ctx!, async (c) => {
    if (parsed.data.pin) await assertPinFree(c, req.ctx!.firmId!, parsed.data.pin, pid);
    return c.query(`UPDATE parcels SET ${changes.map(([k], i) => `${map[k]} = $${i + 3}`).join(", ")} WHERE firm_id = $1 AND id = $2 RETURNING *`, [
      req.ctx!.firmId, pid, ...changes.map(([, v]) => v),
    ]);
  });
  if (!r.rowCount) {
    res.status(404).json({ error: "Parcel not found." });
    return;
  }
  res.json({ parcel: r.rows[0] });
});

mattersRouter.delete("/parcels/:id", requirePermission("properties.edit"), async (req, res) => {
  const pid = idParam(req);
  if (!pid) return bad(res, "Invalid parcel.");
  const result = await withContext(req.ctx!, async (c) => {
    const parcel = (await c.query(`SELECT property_id, is_primary FROM parcels WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, pid])).rows[0];
    if (!parcel) return "missing";
    const count = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM parcels WHERE firm_id = $1 AND property_id = $2`, [req.ctx!.firmId, parcel.property_id])).rows[0].n;
    if (count <= 1) return "last";
    const used = await c.query(
      `SELECT 1 FROM appeals WHERE firm_id = $1 AND parcel_id = $2
       UNION ALL SELECT 1 FROM appeal_pins WHERE firm_id = $1 AND parcel_id = $2
         AND COALESCE(orig_av, target_av, resolved_av, orig_land_av, orig_impr_av) IS NOT NULL
       LIMIT 1`,
      [req.ctx!.firmId, pid],
    );
    if (used.rowCount) return "used";
    await c.query(`DELETE FROM appeal_pins WHERE firm_id = $1 AND parcel_id = $2`, [req.ctx!.firmId, pid]);
    await c.query(`DELETE FROM parcels WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, pid]);
    if (parcel.is_primary) {
      await c.query(
        `UPDATE parcels SET is_primary = true WHERE id = (SELECT id FROM parcels WHERE firm_id = $1 AND property_id = $2 ORDER BY id LIMIT 1)`,
        [req.ctx!.firmId, parcel.property_id],
      );
    }
    return "ok";
  });
  if (result === "missing") { res.status(404).json({ error: "Parcel not found." }); return; }
  if (result === "last") return bad(res, "A property needs at least one parcel.");
  if (result === "used") return bad(res, "An appeal has values for this PIN. Clear them, or remove the appeal, first.");
  res.json({ ok: true });
});

// ================================================================ appeals
const PREV_LEVEL: Record<Level, Level | null> = { assessor: null, bor: "assessor", ptab: "bor", circuit: "bor" };

/** Creates an appeal with sensible defaults: the AV going into this level, the property's ratio, and the latest reference rates. */
async function createAppeal(
  c: pg.PoolClient,
  req: Request,
  propertyId: number,
  a: { assessmentYear: number; level: Level; parcelId?: number | null },
): Promise<number> {
  const firmId = req.ctx!.firmId!;
  const p = (await c.query(
    `SELECT p.*, co.name AS county_name FROM properties p JOIN counties co ON co.id = p.county_id WHERE p.firm_id = $1 AND p.id = $2`,
    [firmId, propertyId],
  )).rows[0];
  if (!p) throw Object.assign(new Error("property"), { status: 404, publicMessage: "Property not found." });
  const dupe = await c.query(
    `SELECT 1 FROM appeals WHERE firm_id = $1 AND property_id = $2 AND assessment_year = $3 AND level = $4 AND parcel_id IS NOT DISTINCT FROM $5`,
    [firmId, propertyId, a.assessmentYear, a.level, a.parcelId ?? null],
  );
  if (dupe.rowCount) throw Object.assign(new Error("dupe"), { status: 409, publicMessage: "That property already has an appeal at this level for that assessment year." });

  // AV going into this level: the prior level's result this year, else the latest known AV.
  const prev = PREV_LEVEL[a.level];
  const prevAppeal = prev
    ? (await c.query(
        `SELECT id, resolved_av, orig_av, resolved_land_av, resolved_impr_av FROM appeals
          WHERE firm_id = $1 AND property_id = $2 AND assessment_year = $3 AND level = $4 ORDER BY id DESC LIMIT 1`,
        [firmId, propertyId, a.assessmentYear, prev],
      )).rows[0]
    : null;
  const latest = (await c.query(
    `SELECT id, COALESCE(resolved_av, orig_av) AS av FROM appeals a WHERE firm_id = $1 AND property_id = $2
      ORDER BY assessment_year DESC, ${LEVEL_ORDER} DESC LIMIT 1`,
    [firmId, propertyId],
  )).rows[0];
  const origAv = prevAppeal ? prevAppeal.resolved_av ?? prevAppeal.orig_av : latest?.av ?? null;
  const ref = await referenceFor(c, p.county_id, p.township_id, p.tax_code);
  const ratio = p.level_of_assessment ?? defaultRatio(p.county_name, p.asset_type);
  const taxYear = ref.rate?.taxYear ?? ref.equalizer?.year ?? a.assessmentYear - 1;
  const taxes = computeAppealTax({
    origAv, targetAv: null, resolvedAv: null,
    equalizer: ref.equalizer?.factor ?? null, taxRatePercent: ref.rate?.ratePercent ?? null,
  });
  const row = (await c.query<{ id: number }>(
    `INSERT INTO appeals (firm_id, property_id, parcel_id, assessment_year, tax_year, level, substage, status, representative_user_id,
                          orig_av, orig_land_av, orig_impr_av, assessment_ratio, equalizer, equalizer_source, tax_rate_percent, tax_rate_source,
                          original_tax)
     VALUES ($1,$2,$3,$4,$5,$6,'under_review','open',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [
      firmId, propertyId, a.parcelId ?? null, a.assessmentYear, taxYear, a.level, p.attorney_user_id, origAv,
      prevAppeal?.resolved_land_av ?? null, prevAppeal?.resolved_impr_av ?? null, ratio,
      ref.equalizer?.factor ?? null, ref.equalizer?.source ?? null, ref.rate?.ratePercent ?? null, ref.rate?.source ?? null,
      taxes.originalTax,
    ],
  )).rows[0];
  // Its PINs: originals carried from the earlier appeal's results, PIN by PIN; then totals from them,
  // and a decided PTAB earlier in the same reassessment cycle supplies the target.
  await seedPinsForNewAppeal(c, firmId, row.id, prevAppeal?.id ?? latest?.id ?? null, a.parcelId ?? null);
  await refreshAppealFromPins(c, firmId, row.id);
  await rolloverIntoNewAppeal(c, firmId, row.id);
  return row.id;
}

const NewAppeal = z.object({
  assessmentYear: z.coerce.number().int().min(2000).max(2100),
  level: z.enum(LEVELS),
  parcelId: id.nullable().optional(),
});

mattersRouter.post("/properties/:id/appeals", requirePermission("appeals.edit"), async (req, res) => {
  const pid = idParam(req);
  const parsed = NewAppeal.safeParse(req.body);
  if (!pid) return bad(res, "Invalid property.");
  if (!parsed.success) return bad(res, parsed.error);
  const newId = await withContext(req.ctx!, (c) => createAppeal(c, req, pid, parsed.data));
  // The property's Dropbox folder gets this appeal's year and level folder right away (when there is one).
  const folder = await ensureAppealFolder(req, pid, parsed.data.assessmentYear, parsed.data.level).catch(() => null);
  res.status(201).json({ id: newId, folder });
});

const valueCols = ["land", "impr", "personal", "adjust"] as const;
const ValueSet = z.object({
  land: money.nullable().optional(),
  impr: money.nullable().optional(),
  personal: money.nullable().optional(),
  adjust: money.nullable().optional(),
  total: money.nullable().optional(),
}).strict();

const UpdateAppeal = z.object({
  assessmentYear: z.coerce.number().int().min(2000).max(2100).optional(),
  taxYear: z.coerce.number().int().min(2000).max(2100).optional(),
  substage: z.enum(SUBSTAGES).optional(),
  status: z.enum(APPEAL_STATUSES).optional(),
  externalId: optText(60),
  petitionNo: optText(60),
  filedOn: optDate,
  hearingAt: z.string().datetime({ offset: true }).nullable().optional().or(z.literal("").transform(() => null)),
  decisionOn: optDate,
  representativeUserId: id.nullable().optional(),
  parcelId: id.nullable().optional(),
  original: ValueSet.optional(),
  target: ValueSet.optional(),
  resolved: ValueSet.optional(),
  assessmentRatio: percentVal.nullable().optional(),
  equalizer: equalizerVal.nullable().optional(),
  taxRatePercent: rateVal.nullable().optional(),
  overrideReason: optText(300),
  calcOverride: z.boolean().optional(),
  manualTaxes: z.object({ original: money.nullable().optional(), target: money.nullable().optional(), resolved: money.nullable().optional() }).optional(),
  excludeFromTotals: z.boolean().optional(),
  feePercent: percentVal.nullable().optional(),
  nextAction: optText(300),
  nextActionOn: optDate,
}).strict();

const NEXT_LEVELS: Record<Level, Level[]> = { assessor: ["bor"], bor: ["ptab", "circuit"], ptab: [], circuit: [] };

/**
 * Pushes an appeal on to the next level for the same assessment year: marks it Pushed to next
 * level and creates the next level's appeal (or returns the one already there). Assessor goes to
 * the Board of Review; the Board of Review goes to PTAB, or the Circuit Court instead.
 */
export async function startNextLevel(c: pg.PoolClient, req: Request, appealId: number, level?: Level): Promise<{ appealId: number; propertyId: number; created: boolean }> {
  const firmId = req.ctx!.firmId!;
  const a = (await c.query<{ id: number; property_id: number; assessment_year: number; level: Level; substage: string }>(
    `SELECT id, property_id, assessment_year, level, substage FROM appeals WHERE firm_id = $1 AND id = $2 FOR UPDATE`, [firmId, appealId],
  )).rows[0];
  if (!a) throw Object.assign(new Error("appeal"), { status: 404, publicMessage: "Appeal not found." });
  const next = level ?? NEXT_LEVELS[a.level][0];
  if (!next || !NEXT_LEVELS[a.level].includes(next)) {
    throw Object.assign(new Error("level"), { status: 400, publicMessage: `A ${LEVEL_LABELS[a.level]} appeal can't go on to that level.` });
  }
  const existing = (await c.query<{ id: number }>(
    `SELECT id FROM appeals WHERE firm_id = $1 AND property_id = $2 AND assessment_year = $3 AND level = $4 ORDER BY (parcel_id IS NULL) DESC, id LIMIT 1`,
    [firmId, a.property_id, a.assessment_year, next],
  )).rows[0];
  if (a.substage !== "pushed_next_level" && a.substage !== "closed" && a.level !== "ptab" && a.level !== "circuit") {
    await c.query(`UPDATE appeals SET substage = 'pushed_next_level', substage_since = now() WHERE firm_id = $1 AND id = $2`, [firmId, a.id]);
  }
  if (existing) return { appealId: existing.id, propertyId: a.property_id, created: false };
  const id = await createAppeal(c, req, a.property_id, { assessmentYear: a.assessment_year, level: next });
  return { appealId: id, propertyId: a.property_id, created: true };
}

mattersRouter.post("/appeals/:id/next-level", requirePermission("appeals.edit"), async (req, res) => {
  const aid = idParam(req);
  if (!aid) return bad(res, "Invalid appeal.");
  const parsed = z.object({ level: z.enum(LEVELS).optional() }).strict().safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, parsed.error);
  const r = await withContext(req.ctx!, (c) => startNextLevel(c, req, aid, parsed.data.level));
  const yr = await withContext(req.ctx!, async (c) => (await c.query<{ assessment_year: number; level: Level }>(`SELECT assessment_year, level FROM appeals WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, r.appealId])).rows[0]);
  const folder = r.created ? await ensureAppealFolder(req, r.propertyId, yr.assessment_year, yr.level).catch(() => null) : null;
  res.status(r.created ? 201 : 200).json({ id: r.appealId, created: r.created, folder });
});

mattersRouter.get("/appeals/:id", async (req, res) => {
  const aid = idParam(req);
  if (!aid) return bad(res, "Invalid appeal.");
  const row = await withContext(req.ctx!, async (c) => (await c.query(`SELECT * FROM appeals WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, aid])).rows[0]);
  if (!row) { res.status(404).json({ error: "Appeal not found." }); return; }
  res.json({ appeal: row });
});

mattersRouter.patch("/appeals/:id", requirePermission("appeals.edit"), async (req, res) => {
  const aid = idParam(req);
  const parsed = UpdateAppeal.safeParse(req.body);
  if (!aid) return bad(res, "Invalid appeal.");
  if (!parsed.success) return bad(res, parsed.error);
  const d = parsed.data;
  if (d.feePercent !== undefined && !(await hasPermission(req, "fees.edit"))) {
    res.status(403).json({ error: "Your role does not allow changing fee terms." });
    return;
  }
  const userName = req.auth!.user.name;
  const result = await withContext(req.ctx!, async (c) => {
    const a = (await c.query(`SELECT * FROM appeals WHERE firm_id = $1 AND id = $2 FOR UPDATE`, [req.ctx!.firmId, aid])).rows[0];
    if (!a) return null;
    const next: Record<string, unknown> = {};
    const simple: [keyof typeof d, string][] = [
      ["assessmentYear", "assessment_year"], ["taxYear", "tax_year"], ["status", "status"], ["externalId", "external_id"],
      ["petitionNo", "petition_no"], ["filedOn", "filed_on"], ["hearingAt", "hearing_at"], ["decisionOn", "decision_on"],
      ["representativeUserId", "representative_user_id"], ["parcelId", "parcel_id"], ["assessmentRatio", "assessment_ratio"],
      ["excludeFromTotals", "exclude_from_totals"], ["feePercent", "fee_percent"], ["nextAction", "next_action"],
      ["nextActionOn", "next_action_on"], ["calcOverride", "calc_override"],
    ];
    for (const [k, col] of simple) if (d[k] !== undefined) next[col] = d[k];
    if (d.substage !== undefined && d.substage !== a.substage) {
      next.substage = d.substage;
      next.substage_since = new Date().toISOString();
    }

    // Values: components sum into the total when any component is given.
    for (const [key, prefix] of [["original", "orig"], ["target", "target"], ["resolved", "resolved"]] as const) {
      const v = d[key];
      if (!v) continue;
      for (const part of valueCols) if (v[part] !== undefined) next[`${prefix}_${part}_av`] = v[part];
      const parts = valueCols.map((part) => (v[part] !== undefined ? v[part] : a[`${prefix}_${part}_av`]));
      const total = parts.some((x) => x !== null && x !== undefined) ? sumParts(parts) : v.total !== undefined ? v.total : a[`${prefix}_av`];
      next[`${prefix}_av`] = total;
    }

    // Equalizer and rate: a manual change needs a reason, which becomes the recorded source.
    for (const [k, col, srcCol] of [["equalizer", "equalizer", "equalizer_source"], ["taxRatePercent", "tax_rate_percent", "tax_rate_source"]] as const) {
      const v = d[k];
      if (v === undefined || v === a[col]) continue;
      if (!d.overrideReason) throw Object.assign(new Error("reason"), { status: 400, publicMessage: "Give a reason when you change the equalizer or tax rate by hand." });
      next[col] = v;
      next[srcCol] = `Entered by ${userName}: ${d.overrideReason}`;
    }

    // Values typed as property totals: fine for a one-PIN property (the PIN follows below);
    // with several PINs, each PIN's values are edited instead.
    const pinRows = (await c.query<{ id: number }>(`SELECT id FROM appeal_pins WHERE firm_id = $1 AND appeal_id = $2`, [req.ctx!.firmId, aid])).rows;
    const totalsTyped = (["original", "target", "resolved"] as const).filter((k) => d[k] && (["land", "impr", "total"] as const).some((x) => d[k]![x] !== undefined));
    if (pinRows.length > 1 && totalsTyped.length) {
      throw Object.assign(new Error("pins"), { status: 400, publicMessage: "This property has several PINs. Enter land and building for each PIN instead of the totals." });
    }
    const merged = { ...a, ...next };
    const override = Boolean(merged.calc_override);
    if (!override) {
      const t = computeAppealTax({
        origAv: merged.orig_av, targetAv: merged.target_av, resolvedAv: merged.resolved_av,
        equalizer: merged.equalizer, taxRatePercent: merged.tax_rate_percent,
      });
      Object.assign(next, { original_tax: t.originalTax, target_tax: t.targetTax, resolved_tax: t.resolvedTax, estimated_savings: t.estimatedSavings, savings: t.savings });
    } else if (d.manualTaxes) {
      const o = d.manualTaxes.original !== undefined ? d.manualTaxes.original : merged.original_tax;
      const tg = d.manualTaxes.target !== undefined ? d.manualTaxes.target : merged.target_tax;
      const rs = d.manualTaxes.resolved !== undefined ? d.manualTaxes.resolved : merged.resolved_tax;
      const diff = (x: string | null, y: string | null) => (x != null && y != null ? centsToString(toCents(x) - toCents(y)) : null);
      Object.assign(next, { original_tax: o, target_tax: tg, resolved_tax: rs, estimated_savings: diff(o, tg), savings: diff(o, rs) });
    }

    const cols = Object.keys(next);
    if (!cols.length) return a;
    const r = await c.query(
      `UPDATE appeals SET ${cols.map((col, i) => `${col} = $${i + 3}`).join(", ")} WHERE firm_id = $1 AND id = $2 RETURNING *`,
      [req.ctx!.firmId, aid, ...cols.map((col) => next[col])],
    );
    if (pinRows.length === 1 && totalsTyped.length) {
      const row = r.rows[0];
      for (const k of totalsTyped) {
        const prefix = k === "original" ? "orig" : k;
        const extra = [row[`${prefix}_personal_av`], row[`${prefix}_adjust_av`]].filter((x: string | null) => x !== null);
        const total = row[`${prefix}_av`];
        const av = total === null ? null : extra.length ? centsToString(extra.reduce((acc: bigint, x: string) => acc - toCents(x), toCents(total))) : total;
        if (k === "target") await c.query(`UPDATE appeals SET target_source = 'manual', target_source_appeal_id = NULL WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, aid]);
        await c.query(
          `UPDATE appeal_pins SET ${prefix}_land_av = $3, ${prefix}_impr_av = $4, ${prefix}_av = $5 WHERE firm_id = $1 AND id = $2`,
          [req.ctx!.firmId, pinRows[0].id, row[`${prefix}_land_av`], row[`${prefix}_impr_av`], av],
        );
      }
    }
    // A PTAB decision carries forward to later appeals in the same reassessment cycle.
    if (r.rows[0].level === "ptab") await applyRollover(c, req.ctx!.firmId!, aid);
    return r.rows[0];
  });
  if (!result) { res.status(404).json({ error: "Appeal not found." }); return; }
  res.json({ appeal: result });
});

/** Re-apply the latest published equalizer and rate from the reference tables. */
mattersRouter.post("/appeals/:id/use-reference", requirePermission("appeals.edit"), async (req, res) => {
  const aid = idParam(req);
  if (!aid) return bad(res, "Invalid appeal.");
  const result = await withContext(req.ctx!, async (c) => {
    const a = (await c.query(
      `SELECT a.*, p.county_id, p.township_id, p.tax_code FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id
        WHERE a.firm_id = $1 AND a.id = $2`,
      [req.ctx!.firmId, aid],
    )).rows[0];
    if (!a) return null;
    const ref = await referenceFor(c, a.county_id, a.township_id, a.tax_code);
    if (!ref.rate || !ref.equalizer) return "none";
    const t = a.calc_override ? null : computeAppealTax({ origAv: a.orig_av, targetAv: a.target_av, resolvedAv: a.resolved_av, equalizer: ref.equalizer.factor, taxRatePercent: ref.rate.ratePercent });
    return (await c.query(
      `UPDATE appeals SET equalizer = $3, equalizer_source = $4, tax_rate_percent = $5, tax_rate_source = $6, tax_year = $7,
              original_tax = COALESCE($8, original_tax), target_tax = CASE WHEN $13 THEN target_tax ELSE $9 END,
              resolved_tax = CASE WHEN $13 THEN resolved_tax ELSE $10 END,
              estimated_savings = CASE WHEN $13 THEN estimated_savings ELSE $11 END,
              savings = CASE WHEN $13 THEN savings ELSE $12 END
        WHERE firm_id = $1 AND id = $2 RETURNING *`,
      [
        req.ctx!.firmId, aid, ref.equalizer.factor, ref.equalizer.source, ref.rate.ratePercent, ref.rate.source, ref.rate.taxYear,
        t?.originalTax ?? null, t?.targetTax ?? null, t?.resolvedTax ?? null, t?.estimatedSavings ?? null, t?.savings ?? null, Boolean(a.calc_override),
      ],
    )).rows[0];
  });
  if (result === null) { res.status(404).json({ error: "Appeal not found." }); return; }
  if (result === "none") return bad(res, "No published rate and equalizer for this property's tax code yet. Set the tax code, or enter them by hand with a reason.");
  res.json({ appeal: result });
});

mattersRouter.delete("/appeals/:id", requirePermission("appeals.edit"), async (req, res) => {
  const aid = idParam(req);
  if (!aid) return bad(res, "Invalid appeal.");
  const r = await withContext(req.ctx!, async (c) => {
    // Appeals whose target rolled over from this one keep the values but lose the link,
    // and decision letters matched to it go back to review.
    await c.query(`UPDATE appeals SET target_source_appeal_id = NULL WHERE firm_id = $1 AND target_source_appeal_id = $2`, [req.ctx!.firmId, aid]);
    await detachLetters(c, req.ctx!.firmId!, { appealId: aid });
    if ((await c.query(`SELECT 1 FROM invoices WHERE firm_id = $1 AND appeal_id = $2 AND status IN ('sent', 'paid')`, [req.ctx!.firmId, aid])).rowCount) {
      throw Object.assign(new Error("invoices"), { status: 409, publicMessage: "This appeal has an invoice that was sent. Void it in Billing first; the invoice itself stays in the record." });
    }
    await c.query(`DELETE FROM invoices WHERE firm_id = $1 AND appeal_id = $2 AND status = 'draft'`, [req.ctx!.firmId, aid]);
    await c.query(`UPDATE invoices SET appeal_id = NULL WHERE firm_id = $1 AND appeal_id = $2 AND status = 'void'`, [req.ctx!.firmId, aid]);
    return c.query(`DELETE FROM appeals WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, aid]);
  });
  if (!r.rowCount) { res.status(404).json({ error: "Appeal not found." }); return; }
  res.json({ ok: true });
});

// ================================================================ accounts
mattersRouter.get("/accounts", async (req, res) => {
  const rows = await withContext(req.ctx!, async (c) =>
    (await c.query(
      `SELECT ac.id, ac.name, ac.account_type, ac.city, ac.state, ac.status, ac.source, ac.no_fee,
              ac.fee_percent_first_year, ac.fee_percent_refund, u.name AS rep_name,
              (SELECT count(*)::int FROM properties p WHERE p.firm_id = ac.firm_id AND p.account_id = ac.id) AS properties,
              (SELECT COALESCE(sum(a.savings), 0)::numeric(14,2) FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id
                WHERE a.firm_id = ac.firm_id AND p.account_id = ac.id AND a.status = 'reduced' AND NOT a.exclude_from_totals) AS achieved_savings
         FROM accounts ac LEFT JOIN users u ON u.firm_id = ac.firm_id AND u.id = ac.account_rep_user_id
        WHERE ac.firm_id = $1 ORDER BY ac.name`,
      [req.ctx!.firmId],
    )).rows,
  );
  res.json({ accounts: rows });
});

const AccountFields = {
  name: z.string().trim().min(1, "Name is required").max(200),
  accountType: z.enum(["individual", "entity"]),
  accountNumber: optText(60),
  address1: optText(200), address2: optText(200), city: optText(120), state: optText(2), zip: optText(10),
  phone: optText(40), email: z.string().trim().email().max(200).nullable().optional().or(z.literal("").transform(() => null)),
  accountRepUserId: id.nullable().optional(),
  source: optText(200),
  status: z.enum(["active", "inactive"]).optional(),
  feeType: z.enum(["contingency", "flat"]).optional(),
  feePercentFirstYear: percentVal.nullable().optional(),
  feePercentRefund: percentVal.nullable().optional(),
  feeCap: money.nullable().optional(),
  flatFee: money.nullable().optional(),
  feeMemo: optText(1000),
  noFee: z.boolean().optional(),
  coCounsel: optText(300), coCounselFee: optText(100), ownersOfRecord: optText(500), notes: optText(4000),
};
const ACCOUNT_COLUMNS: Record<string, string> = {
  name: "name", accountType: "account_type", accountNumber: "account_number", address1: "address1", address2: "address2", city: "city",
  state: "state", zip: "zip", phone: "phone", email: "email", accountRepUserId: "account_rep_user_id", source: "source", status: "status",
  feeType: "fee_type", feePercentFirstYear: "fee_percent_first_year", feePercentRefund: "fee_percent_refund", feeCap: "fee_cap",
  flatFee: "flat_fee", feeMemo: "fee_memo", noFee: "no_fee", coCounsel: "co_counsel", coCounselFee: "co_counsel_fee",
  ownersOfRecord: "owners_of_record", notes: "notes",
};
const ACCOUNT_FEE_FIELDS = ["feeType", "feePercentFirstYear", "feePercentRefund", "feeCap", "flatFee", "feeMemo", "noFee"];

mattersRouter.post("/accounts", requirePermission("accounts.edit"), async (req, res) => {
  const parsed = z.object(AccountFields).safeParse(req.body);
  if (!parsed.success) return bad(res, parsed.error);
  const entries = Object.entries(parsed.data).filter(([, v]) => v !== undefined);
  if (entries.some(([k]) => ACCOUNT_FEE_FIELDS.includes(k)) && !(await hasPermission(req, "fees.edit"))) {
    res.status(403).json({ error: "Your role does not allow changing fee terms." });
    return;
  }
  const cols = ["firm_id", ...entries.map(([k]) => ACCOUNT_COLUMNS[k])];
  const r = await withContext(req.ctx!, (c) =>
    c.query<{ id: number }>(`INSERT INTO accounts (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`, [
      req.ctx!.firmId, ...entries.map(([, v]) => v),
    ]),
  );
  res.status(201).json({ id: r.rows[0].id });
});

mattersRouter.get("/accounts/:id", async (req, res) => {
  const aid = idParam(req);
  if (!aid) return bad(res, "Invalid client.");
  const firmId = req.ctx!.firmId!;
  const data = await withContext(req.ctx!, async (c) => {
    const account = (await c.query(
      `SELECT ac.*, u.name AS rep_name FROM accounts ac LEFT JOIN users u ON u.firm_id = ac.firm_id AND u.id = ac.account_rep_user_id
        WHERE ac.firm_id = $1 AND ac.id = $2`,
      [firmId, aid],
    )).rows[0];
    if (!account) return null;
    const properties = (await c.query(
      `WITH cur AS (
         SELECT DISTINCT ON (a.property_id) a.* FROM appeals a WHERE a.firm_id = $1
          ORDER BY a.property_id, a.assessment_year DESC, ${LEVEL_ORDER} DESC
       )
       SELECT p.id, p.name, p.address1, p.city, p.state, p.status, p.asset_type, co.name AS county, t.name AS township,
              (SELECT x.pin FROM parcels x WHERE x.firm_id = p.firm_id AND x.property_id = p.id ORDER BY x.is_primary DESC, x.id LIMIT 1) AS pin,
              cur.level, cur.substage
         FROM properties p JOIN counties co ON co.id = p.county_id LEFT JOIN townships t ON t.id = p.township_id
         LEFT JOIN cur ON cur.property_id = p.id
        WHERE p.firm_id = $1 AND p.account_id = $2 ORDER BY p.name`,
      [firmId, aid],
    )).rows;
    const savings = (await c.query(
      `SELECT a.assessment_year, sum(a.savings)::numeric(14,2) AS savings
         FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id
        WHERE a.firm_id = $1 AND p.account_id = $2 AND a.status = 'reduced' AND NOT a.exclude_from_totals AND a.savings IS NOT NULL
        GROUP BY a.assessment_year ORDER BY a.assessment_year DESC`,
      [firmId, aid],
    )).rows;
    const activeAppeals = (await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id
        WHERE a.firm_id = $1 AND p.account_id = $2 AND a.status = 'waiting_decision'`,
      [firmId, aid],
    )).rows[0].n;
    const contacts = (await c.query(`SELECT * FROM contacts WHERE firm_id = $1 AND account_id = $2 ORDER BY role, name`, [firmId, aid])).rows;
    const activities = (await c.query(
      `SELECT ac.*, u.name AS assigned_name, p.name AS property_name
         FROM activities ac LEFT JOIN users u ON u.firm_id = ac.firm_id AND u.id = ac.assigned_user_id
         LEFT JOIN properties p ON p.firm_id = ac.firm_id AND p.id = ac.property_id
        WHERE ac.firm_id = $1 AND (ac.account_id = $2 OR p.account_id = $2)
        ORDER BY (ac.status = 'done'), ac.due_on NULLS LAST, ac.created_at DESC`,
      [firmId, aid],
    )).rows;
    const feeDefaults = await firmFeeDefaults(c, firmId);
    return { account, properties, savings, activeAppeals, contacts, activities, feeDefaults };
  });
  if (!data) { res.status(404).json({ error: "Client not found." }); return; }
  const src = { firmDefaults: data.feeDefaults, account: data.account };
  res.json({
    ...data,
    properties: data.properties.map((p) => ({ ...p, title: matterTitle(p.pin, p.address1 || p.name, p.city, p.township) })),
    fees: { firstYear: effectiveFee("bor", src), refund: effectiveFee("ptab", src) },
    achievedSavings: centsToString(data.savings.reduce((a, s) => a + toCents(s.savings), 0n)),
  });
});

mattersRouter.patch("/accounts/:id", requirePermission("accounts.edit"), async (req, res) => {
  const aid = idParam(req);
  const parsed = z.object(AccountFields).partial().strict().safeParse(req.body);
  if (!aid) return bad(res, "Invalid client.");
  if (!parsed.success) return bad(res, parsed.error);
  const entries = Object.entries(parsed.data).filter(([, v]) => v !== undefined);
  if (!entries.length) return bad(res, "Nothing to change.");
  if (entries.some(([k]) => ACCOUNT_FEE_FIELDS.includes(k)) && !(await hasPermission(req, "fees.edit"))) {
    res.status(403).json({ error: "Your role does not allow changing fee terms." });
    return;
  }
  const r = await withContext(req.ctx!, (c) =>
    c.query(`UPDATE accounts SET ${entries.map(([k], i) => `${ACCOUNT_COLUMNS[k]} = $${i + 3}`).join(", ")} WHERE firm_id = $1 AND id = $2 RETURNING id`, [
      req.ctx!.firmId, aid, ...entries.map(([, v]) => v),
    ]),
  );
  if (!r.rowCount) { res.status(404).json({ error: "Client not found." }); return; }
  res.json({ ok: true });
});

// ================================================================ contacts
const ContactBody = z.object({
  accountId: id.nullable().optional(),
  propertyId: id.nullable().optional(),
  name: z.string().trim().min(1, "Name is required").max(200),
  title: optText(80),
  role: z.enum(["primary", "billing", "owner", "other"]).default("other"),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal("").transform(() => null)),
  phone: optText(40), mobile: optText(40), address1: optText(200), city: optText(120), state: optText(2), zip: optText(10),
  notes: optText(2000),
});
const CONTACT_COLUMNS: Record<string, string> = {
  accountId: "account_id", propertyId: "property_id", name: "name", title: "title", role: "role", email: "email", phone: "phone",
  mobile: "mobile", address1: "address1", city: "city", state: "state", zip: "zip", notes: "notes",
};

mattersRouter.post("/contacts", requirePermission("accounts.edit"), async (req, res) => {
  const parsed = ContactBody.refine((v) => v.accountId || v.propertyId, { message: "Attach the contact to a client or a property." }).safeParse(req.body);
  if (!parsed.success) return bad(res, parsed.error);
  const entries = Object.entries(parsed.data).filter(([, v]) => v !== undefined);
  const cols = ["firm_id", ...entries.map(([k]) => CONTACT_COLUMNS[k])];
  const r = await withContext(req.ctx!, (c) =>
    c.query(`INSERT INTO contacts (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`, [
      req.ctx!.firmId, ...entries.map(([, v]) => v),
    ]),
  );
  res.status(201).json({ contact: r.rows[0] });
});

mattersRouter.patch("/contacts/:id", requirePermission("accounts.edit"), async (req, res) => {
  const cid = idParam(req);
  const parsed = ContactBody.partial().strict().safeParse(req.body);
  if (!cid) return bad(res, "Invalid contact.");
  if (!parsed.success) return bad(res, parsed.error);
  const entries = Object.entries(parsed.data).filter(([, v]) => v !== undefined);
  if (!entries.length) return bad(res, "Nothing to change.");
  const r = await withContext(req.ctx!, (c) =>
    c.query(`UPDATE contacts SET ${entries.map(([k], i) => `${CONTACT_COLUMNS[k]} = $${i + 3}`).join(", ")} WHERE firm_id = $1 AND id = $2 RETURNING *`, [
      req.ctx!.firmId, cid, ...entries.map(([, v]) => v),
    ]),
  );
  if (!r.rowCount) { res.status(404).json({ error: "Contact not found." }); return; }
  res.json({ contact: r.rows[0] });
});

mattersRouter.delete("/contacts/:id", requirePermission("accounts.edit"), async (req, res) => {
  const cid = idParam(req);
  if (!cid) return bad(res, "Invalid contact.");
  const r = await withContext(req.ctx!, (c) => c.query(`DELETE FROM contacts WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, cid]));
  if (!r.rowCount) { res.status(404).json({ error: "Contact not found." }); return; }
  res.json({ ok: true });
});

// ================================================================ activities
const ActivityBody = z.object({
  accountId: id.nullable().optional(),
  propertyId: id.nullable().optional(),
  appealId: id.nullable().optional(),
  kind: z.enum(["note", "call", "email", "task"]).default("task"),
  subject: z.string().trim().min(1, "Subject is required").max(300),
  body: optText(4000),
  dueOn: optDate,
  assignedUserId: id.nullable().optional(),
  status: z.enum(["open", "done"]).optional(),
});
const ACTIVITY_COLUMNS: Record<string, string> = {
  accountId: "account_id", propertyId: "property_id", appealId: "appeal_id", kind: "kind", subject: "subject", body: "body",
  dueOn: "due_on", assignedUserId: "assigned_user_id", status: "status",
};

mattersRouter.post("/activities", async (req, res) => {
  if (req.auth!.user.isSuperAdmin) { res.status(403).json({ error: "Support access is read-only." }); return; }
  const parsed = ActivityBody.refine((v) => v.accountId || v.propertyId || v.appealId, { message: "Attach the activity to a client, property or appeal." }).safeParse(req.body);
  if (!parsed.success) return bad(res, parsed.error);
  const entries = Object.entries(parsed.data).filter(([, v]) => v !== undefined);
  const cols = ["firm_id", "created_by_user_id", ...entries.map(([k]) => ACTIVITY_COLUMNS[k])];
  const r = await withContext(req.ctx!, (c) =>
    c.query(`INSERT INTO activities (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`, [
      req.ctx!.firmId, req.auth!.user.id, ...entries.map(([, v]) => v),
    ]),
  );
  res.status(201).json({ activity: r.rows[0] });
});

mattersRouter.patch("/activities/:id", async (req, res) => {
  if (req.auth!.user.isSuperAdmin) { res.status(403).json({ error: "Support access is read-only." }); return; }
  const aid = idParam(req);
  const parsed = ActivityBody.partial().strict().safeParse(req.body);
  if (!aid) return bad(res, "Invalid activity.");
  if (!parsed.success) return bad(res, parsed.error);
  const entries = Object.entries(parsed.data).filter(([, v]) => v !== undefined);
  if (!entries.length) return bad(res, "Nothing to change.");
  const sets = entries.map(([k], i) => `${ACTIVITY_COLUMNS[k]} = $${i + 3}`);
  if (parsed.data.status === "done") sets.push("completed_at = now()");
  if (parsed.data.status === "open") sets.push("completed_at = NULL");
  const r = await withContext(req.ctx!, (c) =>
    c.query(`UPDATE activities SET ${sets.join(", ")} WHERE firm_id = $1 AND id = $2 RETURNING *`, [req.ctx!.firmId, aid, ...entries.map(([, v]) => v)]),
  );
  if (!r.rowCount) { res.status(404).json({ error: "Activity not found." }); return; }
  res.json({ activity: r.rows[0] });
});

mattersRouter.delete("/activities/:id", async (req, res) => {
  if (req.auth!.user.isSuperAdmin) { res.status(403).json({ error: "Support access is read-only." }); return; }
  const aid = idParam(req);
  if (!aid) return bad(res, "Invalid activity.");
  const r = await withContext(req.ctx!, (c) => c.query(`DELETE FROM activities WHERE firm_id = $1 AND id = $2`, [req.ctx!.firmId, aid]));
  if (!r.rowCount) { res.status(404).json({ error: "Activity not found." }); return; }
  res.json({ ok: true });
});

// ================================================================ search
mattersRouter.get("/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim().slice(0, 100);
  if (q.length < 2) {
    res.json({ properties: [], accounts: [], appeals: [], documents: [] });
    return;
  }
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const digits = q.replace(/\D/g, "");
  const firmId = req.ctx!.firmId;
  const data = await withContext(req.ctx!, async (c) => {
    const properties = (await c.query(
      `SELECT DISTINCT ON (p.id) p.id, p.name, p.address1, p.city, t.name AS township, ac.name AS account_name,
              (SELECT x.pin FROM parcels x WHERE x.firm_id = p.firm_id AND x.property_id = p.id ORDER BY x.is_primary DESC, x.id LIMIT 1) AS pin
         FROM properties p
         JOIN accounts ac ON ac.firm_id = p.firm_id AND ac.id = p.account_id
         LEFT JOIN townships t ON t.id = p.township_id
         LEFT JOIN parcels px ON px.firm_id = p.firm_id AND px.property_id = p.id
        WHERE p.firm_id = $1
          AND (p.name ILIKE $2 OR p.address1 ILIKE $2 OR p.city ILIKE $2
               OR ($3 <> '' AND length($3) >= 4 AND regexp_replace(px.pin, '\\D', '', 'g') LIKE '%' || $3 || '%'))
        ORDER BY p.id LIMIT 8`,
      [firmId, like, digits],
    )).rows;
    const accounts = (await c.query(
      `SELECT id, name, city FROM accounts WHERE firm_id = $1 AND name ILIKE $2 ORDER BY name LIMIT 6`, [firmId, like],
    )).rows;
    const appeals = (await c.query(
      `SELECT a.id, a.property_id, a.assessment_year, a.level, a.external_id, a.petition_no, p.name AS property_name
         FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id
        WHERE a.firm_id = $1 AND (a.external_id ILIKE $2 OR a.petition_no ILIKE $2) ORDER BY a.assessment_year DESC LIMIT 6`,
      [firmId, like],
    )).rows;
    // Documents: every word must match the name, type, tags, notes, author, year or level
    // ("2026 bor decision"). Deleted files and Deadzone matters are left out, and the super
    // admin never sees client documents, even under support access.
    const words = q.toLowerCase().split(/\s+/).filter((w) => w.length >= 2).slice(0, 6).map((w) => `%${w.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    const documents = req.auth!.user.isSuperAdmin || !words.length ? [] : (await c.query(
      `SELECT d.id, d.property_id, d.name, d.path_display, d.assessment_year, d.level, t.name AS type_name, pf.path_display AS folder_path,
              p.name AS property_name, p.address1, p.city
         FROM documents d
         JOIN properties p ON p.firm_id = d.firm_id AND p.id = d.property_id
         JOIN property_folders pf ON pf.firm_id = d.firm_id AND pf.property_id = d.property_id AND NOT pf.in_deadzone
         LEFT JOIN document_types t ON t.firm_id = d.firm_id AND t.id = d.doc_type_id
        WHERE d.firm_id = $1 AND d.deleted_at IS NULL
          AND (SELECT bool_and(concat_ws(' ', d.name, t.name, array_to_string(d.tags, ' '), d.notes, d.author, d.assessment_year::text,
                 CASE d.level WHEN 'assessor' THEN 'assessor assr ccao' WHEN 'bor' THEN 'bor board of review ccbor'
                              WHEN 'ptab' THEN 'ptab property tax appeal board' WHEN 'circuit' THEN 'circuit court spob tax objection' END) ILIKE w)
                 FROM unnest($2::text[]) AS w)
        ORDER BY d.server_modified DESC NULLS LAST LIMIT 8`,
      [firmId, words],
    )).rows;
    return { properties, accounts, appeals, documents };
  });
  res.json({
    properties: data.properties.map((p) => ({ id: p.id, title: matterTitle(p.pin, p.address1 || p.name, p.city, p.township), sub: p.account_name })),
    accounts: data.accounts,
    appeals: data.appeals,
    documents: data.documents.map((d) => {
      const base = String(d.folder_path).toLowerCase();
      const rel = String(d.path_display).toLowerCase().startsWith(`${base}/`) ? String(d.path_display).slice(String(d.folder_path).length + 1) : null;
      return { id: d.id, propertyId: d.property_id, name: d.name, type: d.type_name, year: d.assessment_year, level: d.level, relPath: rel, property: d.address1 || d.property_name, city: d.city };
    }),
  });
});
