// The import engine: turns mapped rows into a plan (what each row would create, change, leave
// alone, or can't take, and why), and applies that plan inside one transaction, recording every
// row it creates or changes so the whole import can be undone. The same code makes the preview and
// the commit, so what was previewed is what happens (the plan is worked out again at commit time,
// against the data as it is then).
//
// Everything runs on the caller's PoolClient inside withContext, so row-level security applies,
// and every query also filters on firm_id.

import type pg from "pg";
import { ASSET_TYPE_LABELS, ASSET_TYPES, matterTitle, pinKey, type AssetType, type Level } from "../../shared/domain.js";
import { centsToString, toCents } from "../../shared/money.js";
import { computeAppealTax } from "../../shared/valuation.js";
import { referenceFor } from "../reference-lookup.js";
import { propertyLevel } from "../assessment.js";
import { refreshAppealFromPins, syncPins } from "../appeal-pins.js";
import { draftInvoice } from "../billing/core.js";
import { todayIso } from "../today.js";
import { FIELDS, type Entity } from "./fields.js";
import type { ParsedSheet } from "./parse.js";

// ---------------------------------------------------------------- inputs
export interface SheetMapping { fileId: number; sheet: string; entity: Entity | "skip"; columns: Record<string, string> }
export interface ImportOptions {
  updateMode: "fill" | "overwrite";       // fill: only empty fields; overwrite: replace what's there
  skipProblems: boolean;                 // commit the good rows and leave the problem rows out
  markHistoryBilled: boolean;            // decided Assessor/BOR reductions are taken off Ready to bill
  applyAsDecision: boolean;              // a result that becomes decided is handled like a decision letter
}
export const PURPOSE_DEFAULTS: Record<"migration" | "new" | "update", ImportOptions> = {
  migration: { updateMode: "fill", skipProblems: false, markHistoryBilled: true, applyAsDecision: false },
  new: { updateMode: "fill", skipProblems: false, markHistoryBilled: false, applyAsDecision: false },
  update: { updateMode: "overwrite", skipProblems: false, markHistoryBilled: false, applyAsDecision: false },
};
export interface FileSheets { id: number; name: string; sheets: ParsedSheet[] }

interface Src { file: string; sheet: string; row: number }
interface Rec { entity: Entity; src: Src; v: Record<string, string>; ctx: { client?: string; property?: string } }

export interface PlanRow {
  entity: Entity; action: "new" | "update" | "unchanged" | "problem"; label: string; message: string | null;
  changes: Record<string, [unknown, unknown]> | null; src: Src | null;
}

// ---------------------------------------------------------------- value cleaning
const LEVEL_WORDS: [RegExp, Level][] = [
  [/^(assessor|ccao|assessor'?s office|township assessor|supervisor of assessments|soa)$/i, "assessor"],
  [/^(board of review|bor|board)$/i, "bor"],
  [/^(ptab|property tax appeal board|state)$/i, "ptab"],
  [/^(circuit|circuit court|tax objection|court)$/i, "circuit"],
];
const STATUS_WORDS: [RegExp, string][] = [
  [/^(wfd|waiting|waiting for decision|pending|filed|appeal filed|in progress)$/i, "waiting_decision"],
  [/^(open|new|not filed|under review)$/i, "open"],
  [/^(reduced|reduction|won|granted|settled|stipulated)$/i, "reduced"],
  [/^(no change|nochange|denied|no reduction|affirmed|fairly assessed)$/i, "no_change"],
  [/^(increased|increase)$/i, "increased"],
  [/^(withdrawn|withdraw)$/i, "withdrawn"],
  [/^(dismissed|dismiss)$/i, "dismissed"],
];
const PROPERTY_STATUS: [RegExp, string][] = [[/^active$/i, "active"], [/^closed$/i, "closed"], [/^inactive$/i, "inactive"], [/^sold$/i, "sold"]];
const DECIDED = ["reduced", "no_change", "increased"];
const MONEY_ZERO_BLANK = new Set(["origAv", "origLand", "origImpr", "targetAv", "resolvedAv", "resolvedLand", "resolvedImpr", "origTax", "targetTax", "resolvedTax", "estimatedSavings", "savings", "purchasePrice"]);

class Bad extends Error {}

function money(raw: string, key: string): string | null {
  let s = raw.replace(/[$,\s]/g, "");
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith("-")) { neg = !neg; s = s.slice(1); }
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Bad(`"${raw}" isn't an amount`);
  const cents = toCents(Number(s).toFixed(2));
  if (cents === 0n && MONEY_ZERO_BLANK.has(key)) return null; // the old export writes 0 for "nothing yet"
  return centsToString(neg ? -cents : cents);
}
function isoDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? (Number(m[3]) > 50 ? `19${m[3]}` : `20${m[3]}`) : m[3];
    const d = new Date(Date.UTC(Number(y), Number(m[1]) - 1, Number(m[2])));
    if (d.getUTCMonth() !== Number(m[1]) - 1) throw new Bad(`"${raw}" isn't a date`);
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) { // an Excel serial date
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  throw new Bad(`"${raw}" isn't a date`);
}
function clean(type: string, raw: string, key: string): unknown {
  const s = (raw ?? "").trim();
  if (s === "") return null;
  switch (type) {
    case "money": return money(s, key);
    case "int": { const n = Number(s.replace(/,/g, "")); if (!Number.isFinite(n)) throw new Bad(`"${s}" isn't a number`); return n === 0 && key === "units" ? null : Math.round(n); }
    case "decimal": { const n = Number(s.replace(/,/g, "")); if (!Number.isFinite(n)) throw new Bad(`"${s}" isn't a number`); return n === 0 ? null : String(n); }
    case "year": { const n = Number(s); if (!Number.isInteger(n) || n < 1700 || n > 2100) throw new Bad(`"${s}" isn't a year`); return n; }
    case "date": return isoDate(s);
    case "level": { const hit = LEVEL_WORDS.find(([re]) => re.test(s)); if (!hit) throw new Bad(`"${s}" isn't a level (Assessor, Board of Review, PTAB, Circuit Court)`); return hit[1]; }
    case "status": { const hit = STATUS_WORDS.find(([re]) => re.test(s)); if (!hit) throw new Bad(`"${s}" isn't a status Appeal EyeQ knows (Reduced, No change, WFD...)`); return hit[1]; }
    case "propstatus": return PROPERTY_STATUS.find(([re]) => re.test(s))?.[1] ?? "active";
    case "asset": return assetFrom(s);
    case "bool": { if (/^(true|yes|y|1|x)$/i.test(s)) return true; if (/^(false|no|n|0)$/i.test(s)) return false; throw new Bad(`"${s}" isn't yes or no`); }
    case "pin": { if (s.replace(/\D/g, "").length < 5) throw new Bad(`"${s}" isn't a PIN`); return s; }
    default: return s;
  }
}
function assetFrom(s: string): AssetType | null {
  const t = s.toLowerCase();
  const byLabel = ASSET_TYPES.find((k) => ASSET_TYPE_LABELS[k].toLowerCase() === t || k === t.replace(/[\s-]/g, "_"));
  if (byLabel) return byLabel;
  if (/multi|apartment|flat/.test(t)) return "multifamily";
  if (/data cent/.test(t)) return "data_center";
  if (/medical|clinic|hospital/.test(t)) return "medical";
  if (/retail|store|shop|restaurant/.test(t)) return "retail";
  if (/hotel|motel/.test(t)) return "hospitality";
  if (/flex/.test(t)) return "flex";
  if (/warehouse|industrial|manufactur/.test(t)) return "industrial";
  if (/office|commercial/.test(t)) return "commercial";
  if (/single|residential|condo|home|house/.test(t)) return "residential";
  return null;
}

/** "Dillon Nichols", "Nichols, Dillon" and "NICHOLS DILLON" are the same name for matching. */
export const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");
const addrKey = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\b(road|rd|street|st|avenue|ave|boulevard|blvd|drive|dr|lane|ln|court|ct)\b\.?/g, (w) => w.slice(0, 2)).replace(/[^a-z0-9]/g, "");
const isEntityName = (s: string) => /\b(llc|l\.l\.c|inc|corp|corporation|company|co\.|lp|llp|trust|partners|partnership|ltd|association|church|bank|fund|properties|holdings|group)\b/i.test(s);

// ---------------------------------------------------------------- reading the mapped sheets
function recordsFrom(files: FileSheets[], mappings: SheetMapping[]): { recs: Rec[]; problems: PlanRow[] } {
  const recs: Rec[] = [];
  const problems: PlanRow[] = [];
  for (const m of mappings) {
    if (m.entity === "skip") continue;
    const file = files.find((f) => f.id === m.fileId);
    const sheet = file?.sheets.find((s) => s.name === m.sheet);
    if (!file || !sheet) continue;
    const fields = FIELDS[m.entity];
    sheet.rows.forEach((row, i) => {
      const src = { file: file.name, sheet: sheet.name, row: sheet.headerRow + 1 + i };
      const v: Record<string, string> = {};
      for (const f of fields) {
        const h = m.columns[f.key];
        if (!h) continue;
        const idx = sheet.headers.indexOf(h);
        if (idx >= 0) v[f.key] = row[idx] ?? "";
      }
      recs.push({ entity: m.entity as Entity, src, v, ctx: sheet.context ?? {} });
    });
  }
  return { recs, problems };
}

/** A record's values cleaned to their types; a value that can't be read becomes a problem. */
function cleaned(r: Rec): { val: Record<string, unknown>; error: string | null } {
  const val: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const f of FIELDS[r.entity]) {
    if (!(f.key in r.v)) continue;
    try { val[f.key] = clean(f.type, r.v[f.key], f.key); } catch (e) { if (e instanceof Bad) errors.push(`${f.label}: ${e.message}`); else throw e; }
  }
  return { val, error: errors.length ? errors.join("; ") : null };
}

// ---------------------------------------------------------------- the plan
interface ClientP { key: string; name: string; number: string | null; val: Record<string, unknown>; existing: Record<string, any> | null; id: number | null; src: Src | null; row: PlanRow }
interface PropertyP {
  key: string; client: ClientP; val: Record<string, unknown>; existing: Record<string, any> | null; id: number | null; src: Src | null; row: PlanRow;
  countyId: number | null; townshipId: number | null; pins: Set<string>; problem: string | null;
}
interface ParcelP { pinKey: string; pin: string; property: PropertyP; val: Record<string, unknown>; existing: Record<string, any> | null; id: number | null; src: Src | null; row: PlanRow }
interface AppealP { key: string; property: PropertyP; year: number; level: Level; shared: Record<string, unknown>; pins: { pinKey: string; val: Record<string, unknown> }[]; existing: Record<string, any> | null; id: number | null; src: Src | null; row: PlanRow }
interface ContactP { client: ClientP | null; property: PropertyP | null; val: Record<string, unknown>; existing: Record<string, any> | null; src: Src | null; row: PlanRow }
interface ActivityP { client: ClientP | null; property: PropertyP | null; val: Record<string, unknown>; src: Src | null; row: PlanRow }

export interface Plan {
  rows: PlanRow[];
  clients: ClientP[]; properties: PropertyP[]; parcels: ParcelP[]; appeals: AppealP[]; contacts: ContactP[]; activities: ActivityP[];
  users: { id: number; name: string }[];
}

const CLIENT_COLS: Record<string, string> = { accountNumber: "account_number", address1: "address1", city: "city", state: "state", zip: "zip", phone: "phone", email: "email", notes: "notes" };
const PROPERTY_COLS: Record<string, string> = {
  name: "name", propertyNumber: "property_number", noFee: "no_fee", address2: "address2", city: "city", state: "state", zip: "zip", taxCode: "tax_code", status: "status", use: "use_type", purchaseDate: "purchase_date",
  purchasePrice: "purchase_price", yearBuilt: "year_built", acreage: "acreage", units: "units", buildingSqft: "building_sqft", landSqft: "land_sqft", notes: "notes", assetType: "asset_type",
};
const PARCEL_COLS: Record<string, string> = { alternatePin: "alternate_pin", owner: "owner_name", class: "class", address: "address", city: "city", state: "state", zip: "zip" };
const APPEAL_COLS: Record<string, string> = {
  taxYear: "tax_year", status: "status", externalId: "external_id", petitionNo: "petition_no", filedOn: "filed_on", decisionOn: "decision_on",
  origAv: "orig_av", targetAv: "target_av", resolvedAv: "resolved_av", origLand: "orig_land_av", origImpr: "orig_impr_av", resolvedLand: "resolved_land_av", resolvedImpr: "resolved_impr_av",
  origTax: "original_tax", targetTax: "target_tax", resolvedTax: "resolved_tax", estimatedSavings: "estimated_savings", savings: "savings",
};
const CONTACT_COLS: Record<string, string> = { title: "title", email: "email", phone: "phone", mobile: "mobile", address: "address1", notes: "notes" };

const same = (a: unknown, b: unknown) => {
  if (a === null || a === undefined || a === "") return b === null || b === undefined || b === "";
  if (b === null || b === undefined || b === "") return false;
  const na = Number(a), nb = Number(b);
  if (typeof a !== "boolean" && Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== "" && String(b).trim() !== "") return na === nb;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
};
const empty = (v: unknown) => v === null || v === undefined || v === "";

/** The column changes an update would make: in fill mode only where Appeal EyeQ has nothing yet. */
function diff(existing: Record<string, any>, val: Record<string, unknown>, cols: Record<string, string>, mode: "fill" | "overwrite"): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const [k, col] of Object.entries(cols)) {
    if (!(k in val) || empty(val[k])) continue;
    const cur = existing[col];
    if (same(cur, val[k])) continue;
    if (mode === "fill" && !empty(cur)) continue;
    out[col] = [cur ?? null, val[k]];
  }
  return out;
}

const rowOf = (entity: Entity, label: string, src: Src | null): PlanRow => ({ entity, action: "new", label, message: null, changes: null, src });
const problem = (r: PlanRow, msg: string) => { r.action = "problem"; r.message = r.message ? `${msg} ${r.message}` : msg; };
const note = (r: PlanRow, msg: string) => { r.message = r.message ? `${r.message} ${msg}` : msg; };

export async function buildPlan(c: pg.PoolClient, firmId: number, files: FileSheets[], mappings: SheetMapping[], opts: ImportOptions): Promise<Plan> {
  const { recs } = recordsFrom(files, mappings);
  const rows: PlanRow[] = [];

  // What's already here.
  const accounts = (await c.query(`SELECT * FROM accounts WHERE firm_id = $1`, [firmId])).rows;
  const props = (await c.query(`SELECT p.*, co.name AS county_name FROM properties p JOIN counties co ON co.id = p.county_id WHERE p.firm_id = $1`, [firmId])).rows;
  const parcels = (await c.query(`SELECT * FROM parcels WHERE firm_id = $1`, [firmId])).rows;
  const appeals = (await c.query(`SELECT * FROM appeals WHERE firm_id = $1 AND parcel_id IS NULL`, [firmId])).rows;
  const contacts = (await c.query(`SELECT * FROM contacts WHERE firm_id = $1`, [firmId])).rows;
  const activities = (await c.query(`SELECT id, account_id, property_id, subject, due_on FROM activities WHERE firm_id = $1`, [firmId])).rows;
  const users = (await c.query<{ id: number; name: string }>(`SELECT id, name FROM users WHERE firm_id = $1 AND active`, [firmId])).rows;
  const counties = (await c.query<{ id: number; name: string }>(`SELECT id, name FROM counties`)).rows;
  const townships = (await c.query<{ id: number; county_id: number; name: string }>(`SELECT id, county_id, name FROM townships`)).rows;
  const parcelByKey = new Map(parcels.map((x) => [x.pin_key as string, x]));
  // Lookups by key, so a whole firm's migration plans in a few seconds.
  const group = <T, K>(xs: T[], key: (x: T) => K) => { const m = new Map<K, T[]>(); for (const x of xs) { const k = key(x); const l = m.get(k); if (l) l.push(x); else m.set(k, [x]); } return m; };
  const accById = new Map(accounts.map((a) => [a.id as number, a]));
  const accByNum = group(accounts.filter((a) => a.account_number), (a) => String(a.account_number).trim().toLowerCase());
  const accByName = group(accounts, (a) => nameKey(a.name));
  const propById = new Map(props.map((p) => [p.id as number, p]));
  const propsByAccount = group(props, (p) => p.account_id as number);
  const appealByKey0 = new Map(appeals.map((a) => [`${a.property_id}|${a.assessment_year}|${a.level}`, a]));
  const contactsByAccount = group(contacts.filter((x) => x.account_id), (x) => x.account_id as number);
  const contactsByProperty = group(contacts.filter((x) => x.property_id), (x) => x.property_id as number);
  const actKey = (propertyId: number | null, accountId: number | null, subject: string, due: string | null) => `${propertyId ?? ""}|${propertyId ? "" : accountId ?? ""}|${subject.trim().toLowerCase()}|${due ?? ""}`;
  const activitySet = new Set(activities.map((a) => actKey(a.property_id, a.account_id, String(a.subject), a.due_on)));

  // ---- clients
  const clients = new Map<string, ClientP>();
  const clientFor = (name: string | null | undefined, number: string | null | undefined, src: Src | null, val: Record<string, unknown> = {}): ClientP | null => {
    const n = (name ?? "").trim();
    const num = (number ?? "").trim() || null;
    if (!n && !num) return null;
    const key = num ? `#${num.toLowerCase()}` : `n:${nameKey(n)}`;
    const have = clients.get(key) ?? (n ? clients.get(`n:${nameKey(n)}`) : undefined);
    if (have) { for (const [k, v] of Object.entries(val)) if (empty(have.val[k]) && !empty(v)) have.val[k] = v; return have; }
    const cp: ClientP = { key, name: n, number: num, val: { ...val }, existing: null, id: null, src, row: rowOf("client", n || `Client ${num}`, src) };
    // Match: the client number first, then the name in any order.
    const byNum = num ? accByNum.get(num.toLowerCase()) ?? [] : [];
    const byName = n ? accByName.get(nameKey(n)) ?? [] : [];
    const hits = byNum.length ? byNum : byName;
    if (hits.length > 1) problem(cp.row, `${hits.length} clients in Appeal EyeQ match "${n || num}". Add a client number to tell them apart.`);
    else if (hits.length === 1) {
      cp.existing = hits[0]; cp.id = hits[0].id; cp.row.action = "unchanged"; cp.row.label = hits[0].name;
      if (n && hits[0].name !== n && !byNum.length) note(cp.row, `Matched "${n}" to ${hits[0].name}.`);
    } else if (!n) problem(cp.row, `No client with number ${num}, and no name to make one.`);
    clients.set(key, cp);
    if (n) clients.set(`n:${nameKey(n)}`, cp);
    rows.push(cp.row);
    return cp;
  };

  const clientRecs = recs.filter((r) => r.entity === "client");
  for (const r of clientRecs) {
    const { val, error } = cleaned(r);
    const cp = clientFor(val.name as string, val.accountNumber as string, r.src, val);
    if (!cp) { const pr = rowOf("client", "(no name)", r.src); problem(pr, "A client needs a name."); rows.push(pr); continue; }
    if (error) problem(cp.row, error);
  }
  const fileClient = (r: Rec, val: Record<string, unknown>) =>
    clientFor((val.client as string) || r.ctx.client, (val.clientNumber as string) || null, r.src);

  // ---- properties
  const properties: PropertyP[] = [];
  const propByKey = new Map<string, PropertyP>();
  const propKey = (cp: ClientP | null, name: string) => `${cp?.key ?? "?"}|${nameKey(name)}`;
  const findCounty = (s: unknown) => (s ? counties.find((x) => x.name.toLowerCase() === String(s).toLowerCase().replace(/\s+county$/, "").trim()) ?? null : null);

  const addProperty = (r: Rec | null, cp: ClientP | null, val: Record<string, unknown>, src: Src | null, error: string | null): PropertyP => {
    const name = String(val.name || val.address1 || "").trim();
    const key = propKey(cp, name);
    const have = propByKey.get(key);
    if (have) { for (const [k, v] of Object.entries(val)) if (empty(have.val[k]) && !empty(v)) have.val[k] = v; return have; }
    const pp: PropertyP = { key, client: cp!, val: { ...val }, existing: null, id: null, src, row: rowOf("property", name || "(no address)", src), countyId: null, townshipId: null, pins: new Set(), problem: null };
    if (!cp) problem(pp.row, "Which client is this for? Map a client name column, or import it from that client's report.");
    else if (cp.row.action === "problem") problem(pp.row, "Its client can't be imported.");
    if (error) problem(pp.row, error);
    if (val.pin) pp.pins.add(pinKey(String(val.pin)));
    properties.push(pp);
    propByKey.set(key, pp);
    rows.push(pp.row);
    void r;
    return pp;
  };
  for (const r of recs.filter((x) => x.entity === "property")) {
    const { val, error } = cleaned(r);
    addProperty(r, fileClient(r, val), val, r.src, error);
  }
  // A property named in a sheet but not described in one (a PIN listing without the property tab) is looked up by name.
  const propertyRef = (r: Rec, val: Record<string, unknown>): PropertyP | null => {
    const cp = fileClient(r, val);
    const name = String(val.property || r.ctx.property || "").trim();
    if (name) {
      const pp = propByKey.get(propKey(cp, name)) ?? (!cp ? properties.find((p) => nameKey(String(p.val.name ?? "")) === nameKey(name)) : undefined);
      if (pp) return pp;
      const ex = (cp?.id ? propsByAccount.get(cp.id) ?? [] : cp ? [] : props).find((p) => nameKey(p.name) === nameKey(name) || addrKey(p.address1) === addrKey(name));
      if (ex && cp) {
        const pp2 = addProperty(null, cp, { name: ex.name, address1: ex.address1 }, null, null);
        pp2.existing = ex; pp2.id = ex.id;
        return pp2;
      }
    }
    if (!name && properties.length === 1) return properties[0];
    return null;
  };

  // ---- PINs
  const parcelsP: ParcelP[] = [];
  const parcelByPin = new Map<string, ParcelP>();
  const addParcel = (pin: string, pp: PropertyP, val: Record<string, unknown>, src: Src | null, error: string | null, implicit = false) => {
    const k = pinKey(pin);
    const have = parcelByPin.get(k);
    if (have) { for (const [kk, v] of Object.entries(val)) if (empty(have.val[kk]) && !empty(v)) have.val[kk] = v; return have; }
    const row = rowOf("parcel", pin, src);
    const pc: ParcelP = { pinKey: k, pin, property: pp, val: { ...val }, existing: null, id: null, src, row };
    if (pp.row.action === "problem") problem(row, "Its property can't be imported.");
    if (error) problem(row, error);
    if (implicit && row.action !== "problem") note(row, "Added from the property's row.");
    pp.pins.add(k);
    parcelsP.push(pc); parcelByPin.set(k, pc);
    rows.push(row);
    return pc;
  };
  for (const pp of properties) if (pp.val.pin) addParcel(String(pp.val.pin), pp, {}, pp.src, null, true);
  for (const r of recs.filter((x) => x.entity === "parcel")) {
    const { val, error } = cleaned(r);
    if (!val.pin) { const pr = rowOf("parcel", "(no PIN)", r.src); problem(pr, error ?? "A PIN is required."); rows.push(pr); continue; }
    const pp = propertyRef(r, val) ?? (() => { const ex = parcelByKey.get(pinKey(String(val.pin))); return ex ? null : null; })();
    if (!pp) {
      const ex = parcelByKey.get(pinKey(String(val.pin)));
      const pr = rowOf("parcel", String(val.pin), r.src);
      if (ex) { pr.action = "unchanged"; note(pr, "Already in Appeal EyeQ; no property named in this row."); }
      else problem(pr, "Which property is this PIN on? Map a property name column, or import the Properties sheet with it.");
      rows.push(pr); continue;
    }
    addParcel(String(val.pin), pp, val, r.src, error);
  }

  // Properties: now that their PINs are known, find the ones already in Appeal EyeQ.
  for (const pp of properties) {
    if (pp.existing || pp.row.action === "problem") continue;
    const owners = new Set([...pp.pins].map((k) => parcelByKey.get(k)?.property_id).filter((x): x is number => Boolean(x)));
    if (owners.size > 1) { problem(pp.row, "Its PINs are on different properties in Appeal EyeQ."); continue; }
    let ex = owners.size === 1 ? propById.get([...owners][0]) ?? null : null;
    if (!ex && pp.client.id) ex = (propsByAccount.get(pp.client.id) ?? []).find((p) => addrKey(p.address1) === addrKey(String(pp.val.address1 ?? "")) && addrKey(p.address1) !== "") ?? null;
    if (ex) {
      if (pp.client.id && ex.account_id !== pp.client.id) { problem(pp.row, `Its PIN is already on ${ex.address1 || ex.name}, which belongs to another client.`); continue; }
      pp.existing = ex; pp.id = ex.id;
      if (!pp.client.id) { problem(pp.row, `Its PIN is already on ${ex.address1 || ex.name} in Appeal EyeQ, under a different client.`); continue; }
      pp.row.label = matterTitle(null, ex.address1 || ex.name, ex.city, null);
      const ch = diff(ex, pp.val, PROPERTY_COLS, opts.updateMode);
      if (ch.asset_type && ex.asset_type === "multifamily") delete ch.asset_type;
      pp.row.action = Object.keys(ch).length ? "update" : "unchanged";
      pp.row.changes = Object.keys(ch).length ? ch : null;
    } else {
      const missing = (["address1", "city", "county"] as const).filter((k) => empty(pp.val[k]));
      if (missing.length) { problem(pp.row, `A new property needs ${missing.map((k) => ({ address1: "an address", city: "a city", county: "a county" })[k]).join(", ")}.`); continue; }
      const co = findCounty(pp.val.county);
      if (!co) { problem(pp.row, `"${pp.val.county}" isn't a county Appeal EyeQ has. The super admin adds counties.`); continue; }
      pp.countyId = co.id;
      if (pp.val.township) {
        const tw = townships.find((t) => t.county_id === co.id && t.name.toLowerCase() === String(pp.val.township).toLowerCase());
        if (tw) pp.townshipId = tw.id; else note(pp.row, `Township "${pp.val.township}" isn't listed for ${co.name}; left blank.`);
      }
      if (!pp.val.assetType) {
        const guess = pp.val.use ? assetFrom(String(pp.val.use)) : null;
        pp.val.assetType = guess ?? "residential";
        if (!guess) note(pp.row, "Asset type set to Residential; change it on the property if that's wrong.");
      }
      if (pp.val.assetType === "multifamily" && !pp.val.units) note(pp.row, "Multi-family without a unit count groups as Residential until units are entered.");
    }
  }
  // Clients that will be made new, and their kind.
  for (const cp of new Set(clients.values())) {
    if (!cp.existing && cp.row.action !== "problem") {
      cp.row.action = "new";
      if (!cp.val.accountType) cp.val.accountType = isEntityName(cp.name) ? "entity" : "individual";
    } else if (cp.existing && cp.row.action !== "problem") {
      const ch = diff(cp.existing, cp.val, CLIENT_COLS, opts.updateMode);
      if (Object.keys(ch).length) { cp.row.action = "update"; cp.row.changes = ch; }
    }
  }
  // PINs: new, or already here (on this property).
  for (const pc of parcelsP) {
    if (pc.row.action === "problem") continue;
    const ex = parcelByKey.get(pc.pinKey);
    if (pc.property.row.action === "problem") { pc.row.message = null; problem(pc.row, "Its property can't be imported."); continue; }
    if (ex) {
      if (pc.property.id && ex.property_id !== pc.property.id) { problem(pc.row, "This PIN is already on another property in Appeal EyeQ."); continue; }
      pc.existing = ex; pc.id = ex.id;
      const val = { ...pc.val, status: undefined };
      const ch = diff(ex, val, PARCEL_COLS, opts.updateMode);
      pc.row.action = Object.keys(ch).length ? "update" : "unchanged";
      pc.row.changes = Object.keys(ch).length ? ch : null;
    }
  }

  // ---- appeals, one per property, year and level; each row is one PIN's values
  const appealsP: AppealP[] = [];
  const appealByKey = new Map<string, AppealP>();
  for (const r of recs.filter((x) => x.entity === "appeal")) {
    const { val, error } = cleaned(r);
    const label = `${val.pin ?? "?"} · ${val.assessmentYear ?? "?"} ${val.level ? ({ assessor: "Assessor", bor: "BOR", ptab: "PTAB", circuit: "Circuit" } as Record<string, string>)[String(val.level)] : "?"}`;
    if (error || !val.pin || !val.assessmentYear || !val.level) {
      const pr = rowOf("appeal", label, r.src);
      problem(pr, error ?? `Needs ${[!val.pin && "a PIN", !val.assessmentYear && "an assessment year", !val.level && "a level"].filter(Boolean).join(", ")}.`);
      rows.push(pr); continue;
    }
    const k = pinKey(String(val.pin));
    let pp = parcelByPin.get(k)?.property ?? propertyRef(r, val);
    if (!pp) {
      const ex = parcelByKey.get(k);
      if (ex) {
        const exProp = propById.get(ex.property_id)!;
        const exClient = accById.get(exProp.account_id)!;
        const cp = clientFor(exClient.name, null, null)!;
        pp = addProperty(null, cp, { name: exProp.name, address1: exProp.address1 }, null, null);
        pp.existing = exProp; pp.id = exProp.id; pp.row.action = "unchanged"; pp.row.label = matterTitle(null, exProp.address1 || exProp.name, exProp.city, null);
        pp.pins.add(k);
      }
    }
    if (!pp) { const pr = rowOf("appeal", label, r.src); problem(pr, "This PIN isn't in Appeal EyeQ or in the file."); rows.push(pr); continue; }
    if (!parcelByPin.get(k) && !parcelByKey.get(k)) addParcel(String(val.pin), pp, {}, r.src, null, true);
    const key = `${pp.key}|${val.assessmentYear}|${val.level}`;
    let ap = appealByKey.get(key);
    if (!ap) {
      ap = { key, property: pp, year: val.assessmentYear as number, level: val.level as Level, shared: {}, pins: [], existing: null, id: null, src: r.src, row: rowOf("appeal", label.replace(/^[^·]+· /, `${pp.row.label} · `), r.src) };
      appealByKey.set(key, ap); appealsP.push(ap); rows.push(ap.row);
    }
    for (const kk of ["taxYear", "status", "externalId", "petitionNo", "representative", "filedOn", "decisionOn"]) if (empty(ap.shared[kk]) && !empty(val[kk])) ap.shared[kk] = val[kk];
    if (!ap.pins.some((x) => x.pinKey === k)) ap.pins.push({ pinKey: k, val });
  }
  for (const ap of appealsP) {
    if (ap.property.row.action === "problem") { problem(ap.row, "Its property can't be imported."); continue; }
    const totals = appealTotals(ap);
    Object.assign(ap.shared, totals);
    if (ap.pins.length > 1) note(ap.row, `${ap.pins.length} PINs.`);
    if (ap.shared.representative && !users.some((u) => nameKey(u.name) === nameKey(String(ap.shared.representative)))) note(ap.row, `Representative "${ap.shared.representative}" isn't a user here; left blank.`);
    const ex = ap.property.id ? appealByKey0.get(`${ap.property.id}|${ap.year}|${ap.level}`) ?? null : null;
    if (ex) {
      ap.existing = ex; ap.id = ex.id;
      const ch = diff(ex, ap.shared, APPEAL_COLS, opts.updateMode);
      ap.row.action = Object.keys(ch).length ? "update" : "unchanged";
      ap.row.changes = Object.keys(ch).length ? ch : null;
      if (opts.applyAsDecision && ch.status && DECIDED.includes(String(ch.status[1])) && !DECIDED.includes(String(ex.status))) note(ap.row, "Handled as a decision.");
    } else {
      ap.row.changes = Object.fromEntries(Object.entries(APPEAL_COLS).filter(([k]) => !empty(ap.shared[k])).map(([k, col]) => [col, [null, ap.shared[k]]]));
      if (!Object.keys(ap.row.changes).length) ap.row.changes = null;
    }
  }

  // ---- contacts
  const contactsP: ContactP[] = [];
  const seenContact = new Set<string>();
  for (const r of recs.filter((x) => x.entity === "contact")) {
    const { val, error } = cleaned(r);
    const row = rowOf("contact", String(val.name ?? "(no name)"), r.src);
    rows.push(row);
    if (!val.name) { problem(row, "A contact needs a name."); continue; }
    const pp = val.property ? propertyRef(r, val) : null;
    const cp = pp?.client ?? fileClient(r, val);
    if (!cp && !pp) { problem(row, "Which client or property is this contact for?"); continue; }
    if ((cp && cp.row.action === "problem") || (pp && pp.row.action === "problem")) { problem(row, "Its client or property can't be imported."); continue; }
    if (error) { problem(row, error); continue; }
    const dk = `${cp?.key ?? ""}|${pp?.key ?? ""}|${nameKey(String(val.name))}`;
    if (seenContact.has(dk)) { row.action = "unchanged"; note(row, "Same contact as an earlier row."); continue; }
    seenContact.add(dk);
    const ex = [...(cp?.id ? contactsByAccount.get(cp.id) ?? [] : []), ...(pp?.id ? contactsByProperty.get(pp.id) ?? [] : [])].find((x) => (nameKey(x.name) === nameKey(String(val.name)) || (val.email && x.email && String(x.email).toLowerCase() === String(val.email).toLowerCase())));
    const ct: ContactP = { client: cp, property: pp, val, existing: ex ?? null, src: r.src, row };
    if (ex) {
      const ch = diff(ex, val, CONTACT_COLS, opts.updateMode);
      row.action = Object.keys(ch).length ? "update" : "unchanged";
      row.changes = Object.keys(ch).length ? ch : null;
    }
    contactsP.push(ct);
  }

  // ---- activities (the same note in two reports comes in once)
  const activitiesP: ActivityP[] = [];
  const seenAct = new Set<string>();
  for (const r of recs.filter((x) => x.entity === "activity")) {
    const { val, error } = cleaned(r);
    const subject = String(val.subject ?? "").trim();
    const row = rowOf("activity", subject.slice(0, 80) || "(no note)", r.src);
    rows.push(row);
    if (!subject) { problem(row, "An activity needs its note."); continue; }
    if (error) { problem(row, error); continue; }
    const onClient = /^(account|client)$/i.test(String(val.scope ?? ""));
    let pp = !onClient ? (val.pin ? parcelByPin.get(pinKey(String(val.pin)))?.property ?? null : null) ?? propertyRef(r, val) : null;
    const cp = pp?.client ?? fileClient(r, val);
    if (onClient) pp = null;
    if (!pp && !cp) { problem(row, "Which client or property is this for?"); continue; }
    if ((pp && pp.row.action === "problem") || (cp && cp.row.action === "problem")) { problem(row, "Its client or property can't be imported."); continue; }
    const dk = `${pp?.key ?? cp?.key}|${subject.toLowerCase()}|${val.dueOn ?? ""}`;
    const exists = pp?.id ? activitySet.has(actKey(pp.id, null, subject, (val.dueOn as string) ?? null)) : !pp && cp?.id ? activitySet.has(actKey(null, cp.id, subject, (val.dueOn as string) ?? null)) : false;
    if (seenAct.has(dk) || exists) { row.action = "unchanged"; note(row, exists ? "Already in Appeal EyeQ." : "Same note as an earlier row."); continue; }
    seenAct.add(dk);
    if (val.assignedTo && !users.some((u) => nameKey(u.name) === nameKey(String(val.assignedTo)))) note(row, `"${val.assignedTo}" isn't a user here; left unassigned.`);
    activitiesP.push({ client: cp, property: pp, val, src: r.src, row });
  }

  return { rows, clients: [...new Set(clients.values())], properties, parcels: parcelsP, appeals: appealsP, contacts: contactsP, activities: activitiesP, users };
}

/** The appeal's totals from its PINs' rows; a stage is totalled only when every PIN has it. */
function appealTotals(ap: AppealP): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const k of ["origAv", "targetAv", "resolvedAv", "origLand", "origImpr", "resolvedLand", "resolvedImpr", "origTax", "targetTax", "resolvedTax", "estimatedSavings", "savings"]) {
    const vs = ap.pins.map((p) => p.val[k] as string | null | undefined);
    out[k] = vs.length && vs.every((v) => !empty(v)) ? centsToString(vs.reduce((a, v) => a + toCents(v as string), 0n)) : null;
  }
  return out;
}

export function summarize(plan: Plan) {
  const by: Record<string, Record<string, number>> = {};
  for (const r of plan.rows) { by[r.entity] ??= { new: 0, update: 0, unchanged: 0, problem: 0 }; by[r.entity][r.action]++; }
  return { byEntity: by, problems: plan.rows.filter((r) => r.action === "problem").length, total: plan.rows.length };
}

// ---------------------------------------------------------------- applying the plan
interface Applied { created: Record<string, number>; updated: Record<string, number>; skipped: number; notes: string[] }

/** What the import did, written in batches (a migration makes tens of thousands). */
class Effects {
  private buf: { table_name: string; row_id: number; op: string; before: unknown }[] = [];
  constructor(private c: pg.PoolClient, private firmId: number, private batchId: number) {}
  async add(table: string, rowId: number, op: "insert" | "update", before: unknown = null) {
    this.buf.push({ table_name: table, row_id: rowId, op, before });
    if (this.buf.length >= 1000) await this.flush();
  }
  async flush() {
    if (!this.buf.length) return;
    const rows = this.buf;
    this.buf = [];
    await this.c.query(
      `INSERT INTO import_effects (firm_id, batch_id, table_name, row_id, op, before)
       SELECT $1, $2, x.table_name, x.row_id, x.op, x.before FROM jsonb_to_recordset($3::jsonb) AS x(n int, table_name text, row_id int, op text, before jsonb) ORDER BY x.n`,
      [this.firmId, this.batchId, JSON.stringify(rows.map((r, n) => ({ n, ...r })))],
    );
  }
}

async function update(c: pg.PoolClient, firmId: number, fx: Effects, table: string, id: number, changes: Record<string, [unknown, unknown]>) {
  const cols = Object.keys(changes);
  if (!cols.length) return;
  await c.query(`UPDATE ${table} SET ${cols.map((col, i) => `${col} = $${i + 3}`).join(", ")} WHERE firm_id = $1 AND id = $2`, [firmId, id, ...cols.map((col) => changes[col][1])]);
  await fx.add(table, id, "update", { before: Object.fromEntries(cols.map((col) => [col, changes[col][0]])), after: Object.fromEntries(cols.map((col) => [col, changes[col][1]])) });
}

export async function applyPlan(
  c: pg.PoolClient, firmId: number, userId: number, batchId: number, plan: Plan, opts: ImportOptions, purpose: string,
  progress: (done: number, total: number) => void = () => undefined,
): Promise<Applied> {
  const out: Applied = { created: {}, updated: {}, skipped: 0, notes: [] };
  const fx = new Effects(c, firmId, batchId);
  const total = plan.clients.length + plan.properties.length + plan.parcels.length + plan.appeals.length + plan.contacts.length + plan.activities.length;
  let done = 0;
  const tick = () => { done++; if (done % 50 === 0 || done === total) progress(done, total); };
  const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
  const ok = (r: PlanRow) => r.action !== "problem";
  const userId_ = (name: unknown) => (name ? plan.users.find((u) => nameKey(u.name) === nameKey(String(name)))?.id ?? null : null);
  out.skipped = plan.rows.filter((r) => r.action === "problem").length;

  for (const cp of plan.clients) {
    tick();
    if (!ok(cp.row)) continue;
    if (cp.row.action === "new") {
      const v = cp.val;
      cp.id = (await c.query<{ id: number }>(
        `INSERT INTO accounts (firm_id, name, account_number, account_type, address1, city, state, zip, phone, email, notes, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [firmId, cp.name, cp.number ?? v.accountNumber ?? null, v.accountType === "entity" || /entity/i.test(String(v.accountType)) ? "entity" : "individual",
          v.address1 ?? null, v.city ?? null, v.state ?? null, v.zip ?? null, v.phone ?? null, v.email ?? null, v.notes ?? null, purpose === "migration" ? "Imported" : null],
      )).rows[0].id;
      await fx.add("accounts", cp.id, "insert"); bump(out.created, "client");
    } else if (cp.row.action === "update" && cp.row.changes) { await update(c, firmId, fx, "accounts", cp.id!, cp.row.changes); bump(out.updated, "client"); }
  }

  for (const pp of plan.properties) {
    tick();
    if (!ok(pp.row)) continue;
    if (!pp.client.id) continue;
    if (!pp.existing && pp.row.action === "new") {
      const v = pp.val;
      pp.id = (await c.query<{ id: number }>(
        `INSERT INTO properties (firm_id, account_id, name, address1, address2, city, state, zip, county_id, township_id, tax_code, status, asset_type, use_type,
                                 purchase_date, purchase_price, year_built, acreage, units, building_sqft, land_sqft, notes, property_number, no_fee)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'IL'),$8,$9,$10,$11,COALESCE($12,'active'),$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,COALESCE($24,false)) RETURNING id`,
        [firmId, pp.client.id, String(v.name || v.address1), v.address1, v.address2 ?? null, v.city, v.state ? String(v.state).toUpperCase().slice(0, 2) : null, v.zip ?? null,
          pp.countyId, pp.townshipId, v.taxCode ?? null, v.status ?? null, v.assetType, v.use ?? null, v.purchaseDate ?? null, v.purchasePrice ?? null, v.yearBuilt ?? null,
          v.acreage ?? null, v.units ?? null, v.buildingSqft ?? null, v.landSqft ?? null, v.notes ?? null, v.propertyNumber ?? null, v.noFee ?? null],
      )).rows[0].id;
      await fx.add("properties", pp.id, "insert"); bump(out.created, "property");
    } else if (pp.row.action === "update" && pp.row.changes) { await update(c, firmId, fx, "properties", pp.id!, pp.row.changes); bump(out.updated, "property"); }
  }

  const hasParcels = new Set((await c.query<{ property_id: number }>(`SELECT DISTINCT property_id FROM parcels WHERE firm_id = $1`, [firmId])).rows.map((r) => r.property_id));
  for (const pc of plan.parcels) {
    tick();
    if (!ok(pc.row) || !pc.property.id) continue;
    if (!pc.existing && pc.row.action === "new") {
      const v = pc.val;
      const first = !hasParcels.has(pc.property.id);
      hasParcels.add(pc.property.id);
      pc.id = (await c.query<{ id: number }>(
        `INSERT INTO parcels (firm_id, property_id, pin, alternate_pin, owner_name, parcel_type, class, address, city, state, zip, is_primary, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [firmId, pc.property.id, pc.pin, v.alternatePin ?? null, v.owner ?? null, /personal/i.test(String(v.parcelType ?? "")) ? "personal" : "real", v.class ?? null,
          v.address ?? null, v.city ?? null, v.state ? String(v.state).toUpperCase().slice(0, 2) : null, v.zip ?? null, first, !/inactive/i.test(String(v.status ?? ""))],
      )).rows[0].id;
      await fx.add("parcels", pc.id, "insert"); bump(out.created, "parcel");
    } else if (pc.row.action === "update" && pc.row.changes) { await update(c, firmId, fx, "parcels", pc.id!, pc.row.changes); bump(out.updated, "parcel"); }
  }

  // Thousands of new rows in one transaction leave the planner's row counts far behind; refresh them so
  // the per-appeal statements use their indexes. (Best effort: without the privilege it just runs slower.)
  if ((out.created.parcel ?? 0) + (out.created.property ?? 0) > 500) {
    await c.query("SAVEPOINT import_analyze");
    try { await c.query("ANALYZE parcels, properties, accounts"); await c.query("RELEASE SAVEPOINT import_analyze"); }
    catch { await c.query("ROLLBACK TO SAVEPOINT import_analyze"); }
  }
  const today = todayIso();
  // A property's reference values and level of assessment, looked up once for all its appeals.
  const propInfo = new Map<number, Promise<{ ref: Awaited<ReturnType<typeof referenceFor>>; ratio: string | null }>>();
  const infoFor = (propertyId: number) => {
    let p = propInfo.get(propertyId);
    if (!p) {
      p = (async () => {
        const prop = (await c.query(`SELECT county_id, township_id, tax_code FROM properties WHERE firm_id = $1 AND id = $2`, [firmId, propertyId])).rows[0];
        return { ref: await referenceFor(c, prop.county_id, prop.township_id, prop.tax_code), ratio: (await propertyLevel(c, firmId, propertyId))?.percent ?? null };
      })();
      propInfo.set(propertyId, p);
    }
    return p;
  };
  for (const ap of plan.appeals) {
    tick();
    if (!ok(ap.row) || !ap.property.id) continue;
    const s = ap.shared;
    const status = (s.status as string) ?? (ap.existing?.status ?? "open");
    const decided = DECIDED.includes(status);
    const asDecision = opts.applyAsDecision && decided && !(ap.existing && DECIDED.includes(ap.existing.status));
    if (!ap.existing) {
      // Tax: with the county's equalizer and rate for the tax code, worked out; otherwise the amounts in the file, kept as imported.
      const importedTax = !empty(s.origTax) || !empty(s.resolvedTax) || !empty(s.savings);
      const info = await infoFor(ap.property.id);
      const ref = importedTax ? null : info.ref;
      const eq = ref?.equalizer?.factor ?? null, rate = ref?.rate?.ratePercent ?? null;
      const tax = !importedTax ? computeAppealTax({ origAv: s.origAv as string | null, targetAv: s.targetAv as string | null, resolvedAv: s.resolvedAv as string | null, equalizer: eq, taxRatePercent: rate }) : null;
      const ratio = info.ratio;
      const substage = asDecision ? "decision_analysis" : status === "waiting_decision" ? "appeal_filed" : status === "open" ? "under_review" : "closed";
      ap.id = (await c.query<{ id: number }>(
        `INSERT INTO appeals (firm_id, property_id, assessment_year, tax_year, level, substage, status, external_id, petition_no, representative_user_id, filed_on, decision_on,
                              orig_av, orig_land_av, orig_impr_av, target_av, resolved_av, resolved_land_av, resolved_impr_av, assessment_ratio,
                              equalizer, equalizer_source, tax_rate_percent, tax_rate_source,
                              original_tax, target_tax, resolved_tax, estimated_savings, savings, calc_override, data_source, billing_skipped_at, billing_skip_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,'import',
                 CASE WHEN $31::text IS NULL THEN NULL ELSE now() END, $31) RETURNING id`,
        [firmId, ap.property.id, ap.year, s.taxYear ?? ap.year - 1, ap.level, substage, status, s.externalId ?? null, s.petitionNo ?? null, userId_(s.representative),
          s.filedOn ?? null, s.decisionOn ?? (asDecision ? today : null),
          s.origAv ?? null, s.origLand ?? null, s.origImpr ?? null, s.targetAv ?? null, s.resolvedAv ?? null, s.resolvedLand ?? null, s.resolvedImpr ?? null, ratio,
          eq, ref?.equalizer?.source ?? null, rate, ref?.rate?.source ?? null,
          importedTax ? s.origTax ?? null : tax!.originalTax, importedTax ? s.targetTax ?? null : tax!.targetTax, importedTax ? s.resolvedTax ?? null : tax!.resolvedTax,
          importedTax ? s.estimatedSavings ?? null : tax!.estimatedSavings, importedTax ? s.savings ?? null : tax!.savings, importedTax,
          // Decided Assessor and BOR reductions from before Appeal EyeQ were billed there, so they stay off Ready to bill.
          opts.markHistoryBilled && status === "reduced" && (ap.level === "assessor" || ap.level === "bor") && !asDecision ? "Imported from earlier software" : null],
      )).rows[0].id;
      await fx.add("appeals", ap.id, "insert"); bump(out.created, "appeal");
      await writePins(c, firmId, ap, importedTax, true);
    } else if (ap.row.action === "update" && ap.row.changes) {
      const ch = { ...ap.row.changes };
      if (asDecision) {
        ch.substage = [ap.existing.substage, "decision_analysis"];
        if (!ch.decision_on && !ap.existing.decision_on) ch.decision_on = [null, today];
      }
      const refundAfter = asDecision && status === "reduced" && (ap.level === "ptab" || ap.level === "circuit") && !ap.existing.refund_status;
      // Recompute tax from the appeal's own equalizer and rate when it has them and wasn't entered by hand.
      if (!ap.existing.calc_override && ap.existing.equalizer !== null && ap.existing.tax_rate_percent !== null && (ch.orig_av || ch.target_av || ch.resolved_av)) {
        for (const col of ["original_tax", "target_tax", "resolved_tax", "estimated_savings", "savings"]) delete ch[col];
        const pick = (col: string) => (ch[col] ? ch[col][1] : ap.existing![col]) as string | null;
        const t = computeAppealTax({ origAv: pick("orig_av"), targetAv: pick("target_av"), resolvedAv: pick("resolved_av"), equalizer: ap.existing.equalizer, taxRatePercent: ap.existing.tax_rate_percent });
        for (const [col, v] of [["original_tax", t.originalTax], ["target_tax", t.targetTax], ["resolved_tax", t.resolvedTax], ["estimated_savings", t.estimatedSavings], ["savings", t.savings]] as const) {
          if (!same(ap.existing[col], v)) ch[col] = [ap.existing[col], v];
        }
      }
      if (refundAfter) {
        // A PTAB or Circuit reduction: the refund is now awaited, for the savings as they stand after this change.
        const sv = (ch.savings ? ch.savings[1] : ap.existing.savings) as string | null;
        ch.refund_status = [null, "awaiting"];
        ch.refund_expected = [ap.existing.refund_expected ?? null, sv];
      }
      await update(c, firmId, fx, "appeals", ap.id!, ch);
      bump(out.updated, "appeal");
      if (ap.pins.length > 1) await writePins(c, firmId, ap, Boolean(ap.existing.calc_override));
    }
    if (asDecision) {
      const a = (await c.query(`SELECT status, level, savings FROM appeals WHERE firm_id = $1 AND id = $2`, [firmId, ap.id])).rows[0];
      if (a.status === "reduced" && (a.level === "ptab" || a.level === "circuit")) {
        if (ap.existing) continue; // set with the update above, so undo puts it back
        await c.query(`UPDATE appeals SET refund_status = 'awaiting', refund_expected = $3 WHERE firm_id = $1 AND id = $2 AND refund_status IS NULL`, [firmId, ap.id, a.savings]);
      } else if (a.status === "reduced") {
        const d = await draftInvoice(c, firmId, userId, ap.id!);
        if (d.id) { await fx.add("invoices", d.id, "insert"); bump(out.created, "invoice"); }
      }
    }
  }

  for (const ct of plan.contacts) {
    tick();
    if (!ok(ct.row)) continue;
    const v = ct.val;
    if (!ct.existing && ct.row.action === "new") {
      const accountId = ct.client?.id ?? null, propertyId = ct.property?.id ?? null;
      if (!accountId && !propertyId) continue;
      const role = /bill/i.test(String(v.role ?? "")) ? "billing" : /owner/i.test(String(v.role ?? "")) ? "owner" : /primary|main/i.test(String(v.role ?? "")) ? "primary" : "other";
      const id = (await c.query<{ id: number }>(
        `INSERT INTO contacts (firm_id, account_id, property_id, name, title, role, email, phone, mobile, address1, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [firmId, accountId, propertyId, v.name, v.title ?? null, role, v.email ?? null, v.phone ?? null, v.mobile ?? null, v.address ?? null, v.notes ?? null],
      )).rows[0].id;
      await fx.add("contacts", id, "insert"); bump(out.created, "contact");
    } else if (ct.row.action === "update" && ct.row.changes && ct.existing) { await update(c, firmId, fx, "contacts", ct.existing.id, ct.row.changes); bump(out.updated, "contact"); }
  }

  for (const at of plan.activities) {
    tick();
    if (!ok(at.row)) continue;
    const v = at.val;
    const propertyId = at.property?.id ?? null;
    const accountId = propertyId ? null : at.client?.id ?? null;
    if (!propertyId && !accountId) continue;
    const done = /closed|done|complete/i.test(String(v.status ?? ""));
    const id = (await c.query<{ id: number }>(
      `INSERT INTO activities (firm_id, account_id, property_id, kind, subject, due_on, assigned_user_id, status, completed_at, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [firmId, accountId, propertyId, v.dueOn && !done ? "task" : "note", String(v.subject).slice(0, 300), v.dueOn ?? null, userId_(v.assignedTo), done ? "done" : "open", done ? new Date().toISOString() : null, userId],
    )).rows[0].id;
    await fx.add("activities", id, "insert"); bump(out.created, "activity");
  }
  await fx.flush();
  progress(total, total);
  return out;
}

/** Each PIN's values on a new (or multi-PIN) appeal, then the totals from them, as the appeal screen does. */
async function writePins(c: pg.PoolClient, firmId: number, ap: AppealP, keepTax: boolean, isNew = false) {
  const V = `jsonb_to_recordset($3::jsonb) AS v(pin_key text, orig_av numeric, orig_land_av numeric, orig_impr_av numeric, target_av numeric, resolved_av numeric, resolved_land_av numeric, resolved_impr_av numeric)`;
  if (isNew) {
    // A new appeal: a row for each of the property's PINs in one statement, on the appeal with its values where the file has them.
    await c.query(
      `INSERT INTO appeal_pins (firm_id, appeal_id, parcel_id, on_appeal, orig_av, orig_land_av, orig_impr_av, target_av, resolved_av, resolved_land_av, resolved_impr_av)
       SELECT $1, $2, pc.id, v.pin_key IS NOT NULL, v.orig_av, v.orig_land_av, v.orig_impr_av, v.target_av, v.resolved_av, v.resolved_land_av, v.resolved_impr_av
         FROM parcels pc LEFT JOIN ${V} ON v.pin_key = pc.pin_key
        WHERE pc.firm_id = $1 AND pc.property_id = $4`,
      [firmId, ap.id, pinsJson(ap), ap.property.id],
    );
  } else {
    await syncPins(c, firmId, ap.id!);
    await c.query(
      `UPDATE appeal_pins x SET on_appeal = true, orig_av = v.orig_av, orig_land_av = v.orig_land_av, orig_impr_av = v.orig_impr_av, target_av = v.target_av,
              resolved_av = v.resolved_av, resolved_land_av = v.resolved_land_av, resolved_impr_av = v.resolved_impr_av
         FROM parcels pc, ${V}
        WHERE x.firm_id = $1 AND x.appeal_id = $2 AND pc.firm_id = x.firm_id AND pc.id = x.parcel_id AND pc.pin_key = v.pin_key`,
      [firmId, ap.id, pinsJson(ap)],
    );
  }
  if (ap.pins.length > 1 && !keepTax) await refreshAppealFromPins(c, firmId, ap.id!);
}
const pinsJson = (ap: AppealP) => JSON.stringify(ap.pins.map(({ pinKey: k, val: v }) => ({
      pin_key: k, orig_av: v.origAv ?? null, orig_land_av: v.origLand ?? null, orig_impr_av: v.origImpr ?? null, target_av: v.targetAv ?? null,
      resolved_av: v.resolvedAv ?? null, resolved_land_av: v.resolvedLand ?? null, resolved_impr_av: v.resolvedImpr ?? null,
})));

// ---------------------------------------------------------------- undo
const UNDO_NAMES: Record<string, string> = {
  activities: "activities", contacts: "contacts", expenses: "expenses", invoices: "invoices", payments: "payments", properties: "properties", statements: "statements",
  stripe_customers: "card payment records", trust_entries: "trust entries", trust_settlements: "settlements", appeals: "appeals", appeal_offers: "offers", deadlines: "deadlines",
  decision_letters: "decision letters", decision_uploads: "decision letter uploads", documents: "documents", parcels: "PINs", property_folders: "Dropbox folders",
  property_photos: "photos",
};
/** Why an import can't be undone as it stands (work added since to what it made), or null. */
export async function undoCheck(c: pg.PoolClient, firmId: number, batchId: number): Promise<string | null> {
  const effects = (await c.query<{ table_name: string; row_id: number; op: string }>(
    `SELECT table_name, row_id, op FROM import_effects WHERE firm_id = $1 AND batch_id = $2 AND op = 'insert'`, [firmId, batchId],
  )).rows;
  const inserted = (t: string) => effects.filter((e) => e.table_name === t).map((e) => e.row_id);
  const blockers: string[] = [];
  for (const [parent, col] of [["accounts", "account_id"], ["properties", "property_id"], ["appeals", "appeal_id"]] as const) {
    const ids = inserted(parent);
    if (!ids.length) continue;
    const tables = (await c.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = $1
          AND table_name NOT IN ('appeal_pins', 'file_deletions', 'firm_integrations', 'import_effects')
          AND table_name IN (SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'firm_id')`,
      [col],
    )).rows.map((r) => r.table_name);
    for (const t of tables) {
      const n = (await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${t} WHERE firm_id = $1 AND ${col} = ANY($2::int[]) AND NOT (id = ANY($3::int[]))`, [firmId, ids, inserted(t)],
      )).rows[0].n;
      if (n) blockers.push(`${n} ${UNDO_NAMES[t] ?? t.replace(/_/g, " ")}`);
    }
  }
  if (blockers.length) return `Since this import, work was added to what it brought in (${[...new Set(blockers)].join(", ")}). Undo would remove that too, so it's stopped. Remove that work first, or keep the import.`;
  const sent = (await c.query<{ number: string | null }>(`SELECT number FROM invoices WHERE firm_id = $1 AND id = ANY($2::int[]) AND status <> 'draft' ORDER BY id LIMIT 1`, [firmId, inserted("invoices")])).rows[0];
  if (sent) return `An invoice from this import${sent.number ? ` (${sent.number})` : ""} has been sent. Void it first, then undo.`;
  return null;
}

export async function undoBatch(c: pg.PoolClient, firmId: number, batchId: number): Promise<{ removed: number; restored: number; kept: number }> {
  const effects = (await c.query<{ id: number; table_name: string; row_id: number; op: string; before: { before: Record<string, unknown>; after: Record<string, unknown> } | null }>(
    `SELECT id, table_name, row_id, op, before FROM import_effects WHERE firm_id = $1 AND batch_id = $2 ORDER BY id DESC`, [firmId, batchId],
  )).rows;
  const inserted = (t: string) => effects.filter((e) => e.op === "insert" && e.table_name === t).map((e) => e.row_id);
  const why = await undoCheck(c, firmId, batchId);
  if (why) throw Object.assign(new Error("in use"), { status: 409, publicMessage: why });
  let removed = 0, restored = 0, kept = 0;
  // Changes put back first (newest first), then what the import made, removed a table at a time.
  for (const e of effects) {
    if (e.op !== "update" || !e.before) continue;
    const cols = Object.keys(e.before.before);
    const cur = (await c.query(`SELECT ${cols.join(", ")} FROM ${e.table_name} WHERE firm_id = $1 AND id = $2`, [firmId, e.row_id])).rows[0];
    if (!cur) continue;
    const untouched = cols.filter((col) => same(cur[col], e.before!.after[col]));
    if (untouched.length < cols.length) kept += cols.length - untouched.length;
    if (!untouched.length) continue;
    await c.query(`UPDATE ${e.table_name} SET ${untouched.map((col, i) => `${col} = $${i + 3}`).join(", ")} WHERE firm_id = $1 AND id = $2`, [firmId, e.row_id, ...untouched.map((col) => e.before!.before[col])]);
    restored++;
  }
  for (const t of ["invoices", "activities", "contacts", "appeal_pins", "appeals", "parcels", "properties", "accounts"]) {
    const ids = inserted(t);
    if (!ids.length) continue;
    try {
      await c.query("SAVEPOINT undo_rows");
      for (let i = 0; i < ids.length; i += 5000) {
        removed += (await c.query(`DELETE FROM ${t} WHERE firm_id = $1 AND id = ANY($2::int[])`, [firmId, ids.slice(i, i + 5000)])).rowCount ?? 0;
      }
      await c.query("RELEASE SAVEPOINT undo_rows");
    } catch (err) {
      await c.query("ROLLBACK TO SAVEPOINT undo_rows");
      if ((err as { code?: string }).code === "23503") {
        throw Object.assign(new Error("in use"), { status: 409, publicMessage: "Something from this import is in use since (an invoice, payment, settlement or file is attached to it), so it can't be undone as a whole." });
      }
      throw err;
    }
  }
  // Rows removed along with their parent (a new property's PINs) count once each.
  removed = inserted("accounts").length + inserted("properties").length + inserted("parcels").length + inserted("appeals").length + inserted("contacts").length + inserted("activities").length + inserted("invoices").length;
  return { removed, restored, kept };
}
