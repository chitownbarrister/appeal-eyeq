// Sample data for the model tenant "Nichols Law". SAMPLE ONLY.
// Runs only when SEED_SAMPLE_DATA=true, and only once (skips if the firm exists).
// The firm is flagged is_sample, every appeal it creates is data_source 'sample',
// and every reference row it adds is is_sample, so none of it can be mistaken
// for real data. Never enable this on an instance that holds real clients.

import path from "node:path";
import type pg from "pg";
import { query, withContext } from "../db.js";
import { provisionFirm, addFirmUser } from "../firms.js";
import { PASSWORD_MIN_LENGTH } from "../auth.js";
import { readCsv, toIsoDate, blankToNull } from "./csv.js";
import { splitAgreedTotal } from "../../shared/pins.js";
import { computeAppealTax } from "../../shared/valuation.js";
import { centsToString, toCents } from "../../shared/money.js";
import { DEFAULT_FEES, type AppealStatus, type Level, type Substage } from "../../shared/domain.js";
import { seedSamplePhotos } from "../photos.js";

const SEED_DIR = path.resolve(process.cwd(), "db", "seed", "sample");
const FIRM_SLUG = "nichols-law";

const USERS = [
  { name: "Dillon Nichols", email: "dillon@nicholslaw.example", role: "attorney" as const },
  { name: "Marcus Tate", email: "marcus@nicholslaw.example", role: "attorney" as const },
  { name: "Julie Ramos", email: "julie@nicholslaw.example", role: "analyst" as const },
  { name: "Sana Khan", email: "sana@nicholslaw.example", role: "analyst" as const },
];

const LEVEL_FROM_LABEL: Record<string, Level> = {
  Assessor: "assessor",
  "Board of Review": "bor",
  PTAB: "ptab",
  "Circuit Court": "circuit",
};

const SUBSTAGE_FROM_LABEL: Record<string, Substage> = {
  "Under review": "under_review",
  "Fairly assessed": "fairly_assessed",
  "Appeal filed": "appeal_filed",
  "Hearing scheduled": "hearing_scheduled",
  "Decision analysis": "decision_analysis",
  "Invoice sent": "invoice_sent",
};

const STATUS_FROM_LABEL: Record<string, AppealStatus> = {
  "No change": "no_change",
  "Waiting for decision": "waiting_decision",
  Reduced: "reduced",
  Pending: "waiting_decision",
};

// Equalizer and rate for 1044 Tower Road's tax code, from the prior software's
// reduction summary (2024) and implied by its exported 2023 figures.
const SAMPLE_EQUALIZERS = [
  { year: 2023, factor: "3.0163", source: "Sample: Cook final multiplier, to confirm" },
  { year: 2024, factor: "3.0355", source: "Sample: Cook final multiplier per prior software" },
];
const SAMPLE_RATES = [
  { taxCode: "23008", taxYear: 2023, rate: "7.686000", source: "Sample: implied by prior software's exported figures, to confirm" },
  { taxCode: "23008", taxYear: 2024, rate: "7.943607", source: "Sample: prior software reduction summary" },
];

function levelOfAssessment(county: string, assetType: string, csvValue: string): string {
  if (csvValue) return csvValue;
  if (county === "Cook") return assetType === "Residential" ? "10" : "25";
  return "33.33";
}

/** The sample's Asset type and Use columns as one asset type (with units for multi-family). */
function sampleAssetType(type: string, use: string): { assetType: string; units: number | null } {
  const u = use.toLowerCase();
  const units = /\((\d+) units?\)/.exec(u);
  if (u.startsWith("multifamily")) return { assetType: "multifamily", units: units ? Number(units[1]) : null };
  if (u.includes("data center")) return { assetType: "data_center", units: null };
  if (u.includes("medical")) return { assetType: "medical", units: null };
  if (u.startsWith("retail")) return { assetType: "retail", units: null };
  return { assetType: type.toLowerCase(), units: null };
}

/** Class codes on a few sample PINs, so the level of assessment shows where it comes from. */
const SAMPLE_CLASS: Record<string, string> = { "11-19-207-011-0000": "3-15", "17-08-101-022-0000": "5-17" };

function substageForStatus(status: AppealStatus): Substage {
  return status === "waiting_decision" ? "appeal_filed" : "closed";
}

export async function seedSampleData(log: (msg: string) => void = console.log): Promise<void> {
  const exists = await query("SELECT 1 FROM firms WHERE slug = $1", [FIRM_SLUG]);
  if (exists.rowCount) {
    log("Sample data: already present, skipped");
    return;
  }
  const password = process.env.SAMPLE_USER_PASSWORD || "";
  if (password.length < PASSWORD_MIN_LENGTH) {
    log(`Sample data: skipped (set SAMPLE_USER_PASSWORD, at least ${PASSWORD_MIN_LENGTH} characters)`);
    return;
  }

  await seedSampleReference();

  const [first, ...rest] = USERS;
  const { firmId, userId: dillonId } = await provisionFirm({
    name: "Nichols Law",
    slug: FIRM_SLUG,
    isSample: true,
    firstUser: { ...first, password },
  });
  const userIds: Record<string, number> = { [first.name]: dillonId };
  for (const u of rest) userIds[u.name] = await addFirmUser(firmId, { ...u, password });

  await withContext({ actorKind: "system", userId: null, firmId }, async (c) => {
    await c.query(
      `UPDATE firms SET letterhead_name = 'Nichols Law' WHERE id = $1`,
      [firmId],
    );
    await seedFirmContent(c, firmId, userIds);
  });
  log("Sample data: Nichols Law created (sample only)");
}

/**
 * Photos for a sample firm that has none yet (one seeded before photos existed). Runs on every start
 * and does nothing once the firm has any photo, so a photo removed on purpose doesn't come back.
 */
export async function addSamplePhotosIfNone(log: (msg: string) => void = console.log): Promise<void> {
  const firms = (await query<{ id: number }>(`SELECT id FROM firms WHERE is_sample`)).rows;
  for (const f of firms) {
    const n = await withContext({ actorKind: "system", userId: null, firmId: f.id }, async (c) => {
      if ((await c.query(`SELECT 1 FROM property_photos WHERE firm_id = $1 LIMIT 1`, [f.id])).rowCount) return 0;
      return seedSamplePhotos(c, f.id);
    });
    if (n) log(`Sample data: ${n} property photos added`);
  }
}

/** Clients, properties, appeals, tasks and deadlines for the sample firm. */
async function seedFirmContent(c: pg.PoolClient, firmId: number, userIds: Record<string, number>): Promise<void> {
  const accountIds = await seedAccounts(c, firmId, userIds);
  const propertyIds = await seedProperties(c, firmId, userIds, accountIds);
  await seedAppeals(c, firmId, userIds, propertyIds);
  await seedPins(c, firmId, propertyIds);
  await seedWorkItems(c, firmId, userIds, propertyIds);
  await seedSamplePhotos(c, firmId);
}

/**
 * Every sample appeal gets a PIN row per parcel, carrying its values. 1415 W. Grand Ave. is the
 * multi-PIN example: three PINs (one a land-only lot), split the firm's way so each appeal's
 * totals are exactly what they were.
 */
async function seedPins(c: pg.PoolClient, firmId: number, properties: Record<string, { id: number; row: Record<string, string> }>): Promise<void> {
  const grand = properties["17-08-101-022-0000"];
  if (grand) {
    for (const pin of ["17-08-101-023-0000", "17-08-101-024-0000"]) {
      await c.query(
        `INSERT INTO parcels (firm_id, property_id, pin, alternate_pin, parcel_type, class, address, city, state, is_primary)
         VALUES ($1, $2, $3, $3, 'real', NULL, '1415 W. GRAND AVE.', 'CHICAGO', 'IL', false)`,
        [firmId, grand.id, pin],
      );
    }
  }
  await c.query(
    `INSERT INTO appeal_pins (firm_id, appeal_id, parcel_id, on_appeal, orig_land_av, orig_impr_av, orig_av, target_land_av, target_impr_av, target_av,
                              resolved_land_av, resolved_impr_av, resolved_av)
     SELECT a.firm_id, a.id, pc.id, true,
            CASE WHEN one.n = 1 THEN a.orig_land_av END, CASE WHEN one.n = 1 THEN a.orig_impr_av END, CASE WHEN one.n = 1 THEN a.orig_av END,
            CASE WHEN one.n = 1 THEN a.target_land_av END, CASE WHEN one.n = 1 THEN a.target_impr_av END, CASE WHEN one.n = 1 THEN a.target_av END,
            CASE WHEN one.n = 1 THEN a.resolved_land_av END, CASE WHEN one.n = 1 THEN a.resolved_impr_av END, CASE WHEN one.n = 1 THEN a.resolved_av END
       FROM appeals a
       JOIN parcels pc ON pc.firm_id = a.firm_id AND pc.property_id = a.property_id
       JOIN LATERAL (SELECT count(*) AS n FROM parcels x WHERE x.firm_id = a.firm_id AND x.property_id = a.property_id) one ON true
      WHERE a.firm_id = $1
     ON CONFLICT (firm_id, appeal_id, parcel_id) DO NOTHING`,
    [firmId],
  );
  if (!grand) return;
  // The building PIN, a smaller building PIN, and a parking lot: land and building as the county records them.
  const layout = [
    { pin: "17-08-101-022-0000", land: "61875.00", impr: "268125.00" },
    { pin: "17-08-101-023-0000", land: "20625.00", impr: "41250.00" },
    { pin: "17-08-101-024-0000", land: "20625.00", impr: "0.00" },
  ];
  const parcels = (await c.query<{ id: number; pin: string }>(`SELECT id, pin FROM parcels WHERE firm_id = $1 AND property_id = $2`, [firmId, grand.id])).rows;
  const appeals = (await c.query<{ id: number; orig_av: string | null; target_av: string | null; resolved_av: string | null }>(
    `SELECT id, orig_av, target_av, resolved_av FROM appeals WHERE firm_id = $1 AND property_id = $2`, [firmId, grand.id],
  )).rows;
  const base = layout.map((l, i) => ({ key: i, land: l.land, impr: l.impr, av: null }));
  for (const a of appeals) {
    if (!a.orig_av) continue;
    const orig = splitAgreedTotal(base, a.orig_av);
    const target = a.target_av ? splitAgreedTotal(orig, a.target_av) : null;
    const resolved = a.resolved_av ? splitAgreedTotal(orig, a.resolved_av) : null;
    for (const [i, l] of layout.entries()) {
      const parcelId = parcels.find((p) => p.pin === l.pin)!.id;
      await c.query(
        `UPDATE appeal_pins SET orig_land_av = $4, orig_impr_av = $5, orig_av = $6, target_land_av = $7, target_impr_av = $8, target_av = $9,
                resolved_land_av = $10, resolved_impr_av = $11, resolved_av = $12
          WHERE firm_id = $1 AND appeal_id = $2 AND parcel_id = $3`,
        [firmId, a.id, parcelId, orig[i].land, orig[i].impr, orig[i].av, target?.[i].land ?? null, target?.[i].impr ?? null, target?.[i].av ?? null,
          resolved?.[i].land ?? null, resolved?.[i].impr ?? null, resolved?.[i].av ?? null],
      );
    }
  }
}

/**
 * Puts the sample firm back to its starting data: deletes every decision letter
 * upload, client, property, appeal, contact, task and deadline, restores the default fees,
 * and loads the sample set again. Users, permissions and the audit trail
 * are kept. Runs as the signed-in firm user, so the tenant lock applies,
 * and refuses any firm not flagged as a sample.
 */
export async function resetSampleFirm(c: pg.PoolClient, firmId: number): Promise<void> {
  const firm = (await c.query<{ is_sample: boolean }>(`SELECT is_sample FROM firms WHERE id = $1`, [firmId])).rows[0];
  if (!firm?.is_sample) throw Object.assign(new Error("not sample"), { status: 403, publicMessage: "Only a sample firm can be reset." });
  // Decision uploads first (their letters and stored scans go with them), since letters point at appeals.
  // Billing first (payments point at invoices and statements, invoices at appeals), then decision uploads.
  await c.query(`DELETE FROM pay_links WHERE firm_id = $1`, [firmId]);
  for (const t of ["payment_allocations", "payments", "email_log", "trust_entries", "invoices", "statements", "trust_settlements", "expenses", "invoice_counters"]) {
    await c.query(`DELETE FROM ${t} WHERE firm_id = $1`, [firmId]);
  }
  for (const t of ["decision_uploads", "deadlines", "activities", "contacts", "appeals", "parcels", "properties", "accounts"]) {
    await c.query(`DELETE FROM ${t} WHERE firm_id = $1`, [firmId]);
  }
  for (const f of DEFAULT_FEES) {
    await c.query(`UPDATE fee_defaults SET percent = $3, basis = $4 WHERE firm_id = $1 AND level = $2`, [firmId, f.level, f.percent, f.basis]);
  }
  const users = (await c.query<{ id: number; name: string }>(`SELECT id, name FROM users WHERE firm_id = $1`, [firmId])).rows;
  const userIds = Object.fromEntries(users.map((u) => [u.name, u.id]));
  for (const u of USERS) {
    if (!userIds[u.name]) throw Object.assign(new Error("user"), { status: 409, publicMessage: `The sample user ${u.name} is missing, so the sample data can't be reloaded.` });
  }
  await seedFirmContent(c, firmId, userIds);
}

// Dated next steps in properties.csv become deadlines or tasks. Window
// openings and closings are left out: they come from the filing windows.
function workItemFor(nextAction: string): { kind: "hearing" | "evidence" | "filing" | "task"; title: string; time?: string } | null {
  if (/window/i.test(nextAction)) return null;
  const time = nextAction.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  const hhmm = time ? `${String((Number(time[1]) % 12) + (time[3].toUpperCase() === "PM" ? 12 : 0)).padStart(2, "0")}:${time[2]}` : undefined;
  if (/hearing/i.test(nextAction)) return { kind: "hearing", title: nextAction.replace(/,\s*\d{1,2}:\d{2}\s*(AM|PM)/i, ""), time: hhmm };
  if (/evidence/i.test(nextAction)) return { kind: "evidence", title: nextAction };
  if (/filing deadline/i.test(nextAction)) return { kind: "filing", title: nextAction };
  return { kind: "task", title: nextAction };
}

async function seedWorkItems(
  c: pg.PoolClient,
  firmId: number,
  userIds: Record<string, number>,
  properties: Record<string, { id: number; row: Record<string, string> }>,
): Promise<void> {
  for (const { id, row } of Object.values(properties)) {
    const date = blankToNull(row["Next date"]);
    const item = row["Next action"] && date ? workItemFor(row["Next action"]) : null;
    if (!item) continue;
    const appeal = (await c.query<{ id: number; level: string }>(
      `SELECT id, level FROM appeals WHERE firm_id = $1 AND property_id = $2
        ORDER BY assessment_year DESC, array_position(ARRAY['assessor','bor','ptab','circuit']::text[], level) DESC LIMIT 1`,
      [firmId, id],
    )).rows[0];
    if (item.kind === "task") {
      await c.query(
        `INSERT INTO activities (firm_id, property_id, appeal_id, kind, subject, due_on, assigned_user_id, status)
         VALUES ($1, $2, $3, 'task', $4, $5, $6, 'open')`,
        [firmId, id, appeal?.id ?? null, item.title, date, userIds[row.Analyst] ?? null],
      );
    } else {
      await c.query(
        `INSERT INTO deadlines (firm_id, property_id, appeal_id, kind, title, due_on, due_time, source, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [firmId, id, appeal?.id ?? null, item.kind, item.title, date, item.time ?? null,
         item.kind === "hearing" ? "notice" : "manual",
         item.kind === "filing" && /PTAB/.test(item.title) ? "30 days from the Board of Review decision" : null],
      );
    }
  }

  // 1044 Tower Road: the open tasks and parcel record from the prior software's Account Workbook.
  const tower = properties["05-17-302-010-0000"];
  if (tower) {
    await c.query(
      `UPDATE parcels SET owner_name = 'NICHOLS DILLON / NICHOLS MICHELLE B', class = 'Residential', zip = '60093-1850'
        WHERE firm_id = $1 AND property_id = $2 AND pin = '05-17-302-010-0000'`,
      [firmId, tower.id],
    );
    const tasks: [string, string, string | null][] = [
      ["Photos of basement and telephone tile", "Julie Ramos", null],
      ["Settlement statement", "Julie Ramos", null],
      ["2026 temporary easement documents", "Julie Ramos", null],
      ["Request new contingency fee agreement", "Sana Khan", "2025-01-10"],
    ];
    for (const [subject, who, due] of tasks) {
      await c.query(
        `INSERT INTO activities (firm_id, property_id, kind, subject, due_on, assigned_user_id, status) VALUES ($1, $2, 'task', $3, $4, $5, 'open')`,
        [firmId, tower.id, subject, due, userIds[who] ?? null],
      );
    }
  }
}

async function seedSampleReference(): Promise<void> {
  await withContext({ actorKind: "system", userId: null, firmId: null }, async (c) => {
    const cook = (await c.query<{ id: number }>(`SELECT id FROM counties WHERE state = 'IL' AND name = 'Cook'`)).rows[0].id;
    for (const e of SAMPLE_EQUALIZERS) {
      await c.query(
        `INSERT INTO equalizers (county_id, township_id, year, factor, source, is_sample) VALUES ($1, NULL, $2, $3, $4, true)
         ON CONFLICT DO NOTHING`,
        [cook, e.year, e.factor, e.source],
      );
    }
    for (const r of SAMPLE_RATES) {
      await c.query(
        `INSERT INTO tax_rates (county_id, tax_code, tax_year, rate_percent, source, is_sample) VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (county_id, tax_code, tax_year) DO NOTHING`,
        [cook, r.taxCode, r.taxYear, r.rate, r.source],
      );
    }
    for (const w of readCsv(path.join(SEED_DIR, "windows.csv"))) {
      await c.query(
        `INSERT INTO filing_windows (county_id, township_id, level, assessment_year, opens_on, closes_on, note, is_sample)
         SELECT c.id, t.id, $3, 2026, $4, $5, $6, true
           FROM counties c JOIN townships t ON t.county_id = c.id AND t.name = $2
          WHERE c.state = 'IL' AND c.name = $1
         ON CONFLICT DO NOTHING`,
        [w.County, w.Township, LEVEL_FROM_LABEL[w.Level], w.Opens, w.Closes, blankToNull(w.Note)],
      );
    }
  });
}

function parseAddress(full: string): { address1: string; city: string | null; state: string | null; zip: string | null } {
  // "1044 Tower Road, Winnetka, IL 60093"
  const m = full.match(/^(.*),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5})$/);
  if (!m) return { address1: full, city: null, state: null, zip: null };
  return { address1: m[1], city: m[2], state: m[3], zip: m[4] };
}

async function seedAccounts(c: pg.PoolClient, firmId: number, userIds: Record<string, number>): Promise<Record<string, number>> {
  const ids: Record<string, number> = {};
  for (const r of readCsv(path.join(SEED_DIR, "clients.csv"))) {
    const addr = parseAddress(r.Address);
    const custom = r["Fee terms"].match(/^Custom:\s*([\d.]+)%/);
    const { rows } = await c.query<{ id: number }>(
      `INSERT INTO accounts (firm_id, name, account_type, address1, city, state, zip, account_rep_user_id, source,
                             no_fee, fee_percent_first_year, fee_percent_refund, fee_memo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12) RETURNING id`,
      [
        firmId, r.Name, r.Type === "Entity" ? "entity" : "individual", addr.address1, addr.city, addr.state, addr.zip,
        userIds[r.Representative] ?? null, r.Source, r["Fee terms"].startsWith("No fee"),
        custom ? custom[1] : null, r["Fee terms"] === "Standard" ? null : r["Fee terms"],
      ],
    );
    ids[r.Name] = rows[0].id;
  }
  return ids;
}

async function seedProperties(
  c: pg.PoolClient,
  firmId: number,
  userIds: Record<string, number>,
  accountIds: Record<string, number>,
): Promise<Record<string, { id: number; row: Record<string, string> }>> {
  const out: Record<string, { id: number; row: Record<string, string> }> = {};
  for (const r of readCsv(path.join(SEED_DIR, "properties.csv"))) {
    const geo = await c.query<{ county_id: number; township_id: number }>(
      `SELECT c.id AS county_id, t.id AS township_id FROM counties c JOIN townships t ON t.county_id = c.id AND t.name = $2
        WHERE c.state = $3 AND c.name = $1`,
      [r.County, r.Township, r.State],
    );
    if (!geo.rows[0]) throw new Error(`Sample seed: unknown township ${r.Township}, ${r.County}`);
    const is1044 = r.PIN === "05-17-302-010-0000";
    const { rows } = await c.query<{ id: number }>(
      `INSERT INTO properties (firm_id, account_id, name, status, asset_type, use_type, address1, city, state, county_id, township_id,
                               tax_code, tax_code_confirmed, level_of_assessment, attorney_user_id, analyst_user_id, no_fee,
                               year_built, building_sqft, purchase_date, purchase_price, acreage, zip, units)
       VALUES ($1, $2, $3, 'active', $4, $5, $3, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
       RETURNING id`,
      [
        firmId, accountIds[r.Client], r.Address, sampleAssetType(r["Asset type"], r.Use).assetType, r.Use, r.City, r.State,
        geo.rows[0].county_id, geo.rows[0].township_id,
        is1044 ? "23008" : null, is1044,
        levelOfAssessment(r.County, r["Asset type"], r["Level of assessment %"]),
        userIds[r.Attorney], userIds[r.Analyst], r["No fee"] === "Yes",
        blankToNull(r["Year built"]), blankToNull(r["Building sq ft"]),
        is1044 ? "2022-10-06" : null, is1044 ? "628000.00" : null, is1044 ? "0.1722" : null,
        is1044 ? "60093" : null, sampleAssetType(r["Asset type"], r.Use).units,
      ],
    );
    await c.query(
      `INSERT INTO parcels (firm_id, property_id, pin, alternate_pin, parcel_type, class, address, city, state, is_primary)
       VALUES ($1, $2, $3, $3, 'real', $7, $4, $5, $6, true)`,
      [firmId, rows[0].id, r.PIN, r.Address.toUpperCase(), r.City.toUpperCase(), r.State, SAMPLE_CLASS[r.PIN] ?? null],
    );
    if (is1044) {
      await c.query(
        `INSERT INTO contacts (firm_id, account_id, property_id, name, title, role, address1, city, state, zip)
         VALUES ($1, $2, $3, 'Dillon Nichols', 'Mr.', 'billing', '1044 Tower Road', 'Winnetka', 'IL', '60093')`,
        [firmId, accountIds[r.Client], rows[0].id],
      );
    }
    out[r.PIN] = { id: rows[0].id, row: r };
  }
  return out;
}

async function seedAppeals(
  c: pg.PoolClient,
  firmId: number,
  userIds: Record<string, number>,
  properties: Record<string, { id: number; row: Record<string, string> }>,
): Promise<void> {
  const insert = async (a: {
    propertyId: number; assessmentYear: number; taxYear: number; level: Level; substage: Substage; daysInSubstage?: number;
    status: AppealStatus; externalId?: string | null; petitionNo?: string | null; filedOn?: string | null;
    repId: number | null; ratio: string; origAv: string | null; targetAv: string | null; resolvedAv: string | null;
    origLand?: string; origImpr?: string; targetLand?: string; targetImpr?: string; resolvedLand?: string; resolvedImpr?: string;
    equalizer?: string | null; equalizerSource?: string | null; rate?: string | null; rateSource?: string | null;
    imported?: { originalTax: string | null; targetTax: string | null; resolvedTax: string | null; estimatedSavings: string | null; savings: string | null };
    nextAction?: string | null; nextActionOn?: string | null;
  }) => {
    const computed = a.imported
      ? a.imported
      : computeAppealTax({ origAv: a.origAv, targetAv: a.targetAv, resolvedAv: a.resolvedAv, equalizer: a.equalizer ?? null, taxRatePercent: a.rate ?? null });
    await c.query(
      `INSERT INTO appeals (firm_id, property_id, assessment_year, tax_year, level, substage, substage_since, status, external_id,
                            petition_no, filed_on, representative_user_id, assessment_ratio, orig_av, target_av, resolved_av,
                            orig_land_av, orig_impr_av, target_land_av, target_impr_av, resolved_land_av, resolved_impr_av,
                            equalizer, equalizer_source, tax_rate_percent, tax_rate_source,
                            original_tax, target_tax, resolved_tax, estimated_savings, savings, calc_override,
                            next_action, next_action_on, data_source)
       VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(days => $7), $8, $9, $10, $11, $12, $13, $14, $15, $16,
               $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, 'sample')`,
      [
        firmId, a.propertyId, a.assessmentYear, a.taxYear, a.level, a.substage, a.daysInSubstage ?? 0, a.status,
        a.externalId ?? null, a.petitionNo ?? null, a.filedOn ?? null, a.repId, a.ratio, a.origAv, a.targetAv, a.resolvedAv,
        a.origLand ?? null, a.origImpr ?? null, a.targetLand ?? null, a.targetImpr ?? null, a.resolvedLand ?? null, a.resolvedImpr ?? null,
        a.equalizer ?? null, a.equalizerSource ?? null, a.rate ?? null, a.rateSource ?? null,
        computed.originalTax, computed.targetTax, computed.resolvedTax, computed.estimatedSavings, computed.savings,
        Boolean(a.imported), a.nextAction ?? null, a.nextActionOn ?? null,
      ],
    );
  };

  const dillon = userIds["Dillon Nichols"];
  const tower = properties["05-17-302-010-0000"];

  // ---- 1044 Tower Road: five appeals from the prior software export.
  for (const r of readCsv(path.join(SEED_DIR, "1044_appeals.csv"))) {
    const level = LEVEL_FROM_LABEL[r.Level];
    const status = STATUS_FROM_LABEL[r.Status];
    const assessmentYear = Number(r["Assessment year"]);
    const isCurrent = assessmentYear === 2026;
    const base = {
      propertyId: tower.id, assessmentYear, taxYear: Number(r["Tax year"]), level, status,
      substage: isCurrent && status === "waiting_decision" ? ("appeal_filed" as Substage) : status === "no_change" && level === "assessor" ? ("pushed_next_level" as Substage) : ("closed" as Substage),
      daysInSubstage: isCurrent && status === "waiting_decision" ? Number(tower.row["Days in substage"]) : 0,
      externalId: r["Appeal ID"], petitionNo: blankToNull(r["Petition no."]), filedOn: toIsoDate(r.Filed),
      repId: dillon, ratio: "10",
      origAv: blankToNull(r["Original AV"]), targetAv: blankToNull(r["Target AV"]), resolvedAv: blankToNull(r["Resolved AV"]),
    };
    if (assessmentYear === 2025 && level === "bor") {
      // Computed live from the reference tables, with land/improvement split from the reduction summary.
      await insert({
        ...base, equalizer: "3.0355", equalizerSource: "Sample: Cook 2024 final multiplier",
        rate: "7.943607", rateSource: "Sample: tax code 23008, tax year 2024",
        origLand: "20250.00", origImpr: "49750.00", targetLand: "20250.00", targetImpr: "42550.00",
        resolvedLand: "20250.00", resolvedImpr: "42550.00",
      });
    } else if (assessmentYear === 2024 && level === "bor") {
      await insert({
        ...base, equalizer: "3.0163", equalizerSource: "Sample: Cook 2023 final multiplier, to confirm",
        rate: "7.686000", rateSource: "Sample: implied by prior software figures, to confirm",
      });
    } else {
      // Figures as exported by the prior software; kept as entered, not recomputed.
      await insert({
        ...base,
        imported: {
          originalTax: blankToNull(r["Original tax"]), targetTax: blankToNull(r["Target tax"]),
          resolvedTax: blankToNull(r["Resolved tax"]), savings: blankToNull(r.Savings),
          estimatedSavings: r["Original tax"] && r["Target tax"] ? centsToString(toCents(r["Original tax"]) - toCents(r["Target tax"])) : null,
        },
      });
    }
  }

  // ---- Every other property: its current-cycle appeal.
  for (const { id, row } of Object.values(properties)) {
    if (id === tower.id) continue;
    const level = LEVEL_FROM_LABEL[row["Current level"]];
    const substage = SUBSTAGE_FROM_LABEL[row.Substage];
    const isCircuit = level === "circuit";
    await insert({
      propertyId: id,
      assessmentYear: isCircuit ? 2024 : 2026,
      taxYear: isCircuit ? 2024 : 2025,
      level, substage, daysInSubstage: Number(row["Days in substage"]),
      status: substage === "appeal_filed" || substage === "hearing_scheduled" ? "waiting_decision" : "open",
      repId: userIds[row.Attorney], ratio: row["Level of assessment %"],
      origAv: row["Current AV"], targetAv: row["Target AV"], resolvedAv: null,
      imported: { originalTax: null, targetTax: null, resolvedTax: null, savings: null, estimatedSavings: row["Est. first-year savings"] },
      nextAction: blankToNull(row["Next action"]), nextActionOn: blankToNull(row["Next date"]),
    });
  }

  // ---- Prior-cycle results (other than 1044, which has full figures above).
  for (const r of readCsv(path.join(SEED_DIR, "prior_results.csv"))) {
    const prop = properties[r.PIN];
    if (!prop || prop.id === tower.id) continue;
    const status = STATUS_FROM_LABEL[r.Result];
    const year = Number(r.Year);
    const orig = Number(prop.row["Current AV"]);
    const pct = Number(r["Reduction %"]);
    const resolved = status === "reduced" ? Math.round(orig * (1 - pct / 100)).toFixed(2) : status === "no_change" ? orig.toFixed(2) : null;
    await insert({
      propertyId: prop.id, assessmentYear: year, taxYear: year - 1, level: LEVEL_FROM_LABEL[r.Level],
      substage: substageForStatus(status), status, repId: userIds[prop.row.Attorney], ratio: prop.row["Level of assessment %"],
      origAv: orig.toFixed(2), targetAv: null, resolvedAv: resolved,
      imported: { originalTax: null, targetTax: null, resolvedTax: null, estimatedSavings: null, savings: null },
    });
  }
}
