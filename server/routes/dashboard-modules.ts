// The customizable Dashboard (10e): each person's saved layout, the firm default, and the data for
// the modules added in 10e (the original modules still come from GET /dashboard). Mounted under
// /api/firm after requireFirmContext. Every query runs inside withContext (row-level security) and
// filters on firm_id. Support access reads the firm default's modules but saves nothing, and never
// sees decision letters or imports (as on their own pages).

import { Router, type Request } from "express";
import type pg from "pg";
import { z } from "zod";
import { withContext } from "../db.js";
import { requireFirmAdmin } from "../auth.js";
import { LEVEL_LABELS, LEVELS, matterTitle, type Level } from "../../shared/domain.js";
import { centsToString, toCents } from "../../shared/money.js";
import { BUILT_IN_LAYOUT, cleanLayout, KPI_GROUPS, KPI_LEVELS, KPI_METRICS, KPI_YEARS, MODULE_TYPES, type Layout } from "../../shared/dashboard.js";
import { todayIso } from "../today.js";
import { needsTaxFigures, readyToBill } from "../billing/core.js";
import { balances, expenseRows } from "../billing/trust.js";
import { httpError } from "./files-common.js";

export const dashboardModulesRouter = Router();

const sum = (xs: (string | null | undefined)[]) => centsToString(xs.reduce((a, x) => a + (x ? toCents(x) : 0n), 0n));
const PIN_SQL = `(SELECT x.pin FROM parcels x WHERE x.firm_id = p.firm_id AND x.property_id = p.id ORDER BY x.is_primary DESC, x.id LIMIT 1)`;
const titleOf = (r: { pin: string | null; address1: string | null; pname?: string; name?: string; city: string | null; township: string | null }) =>
  matterTitle(r.pin, r.address1 || r.pname || r.name || "", r.city, r.township);
function addDays(iso: string, days: number): string {
  return new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + days)).toISOString().slice(0, 10);
}
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// ---------------------------------------------------------------- layouts
const LayoutBody = z.object({ layout: z.object({ version: z.literal(1), modules: z.array(z.unknown()).max(40) }).passthrough() }).strict();

async function layouts(c: pg.PoolClient, firmId: number, userId: number | null) {
  const rows = (await c.query<{ user_id: number | null; layout: unknown; updated_at: string }>(
    `SELECT user_id, layout, updated_at FROM dashboard_layouts WHERE firm_id = $1 AND (user_id IS NULL OR user_id = $2)`, [firmId, userId],
  )).rows;
  const firm = rows.find((r) => r.user_id === null);
  const mine = userId ? rows.find((r) => r.user_id === userId) : undefined;
  return { mine: mine ? cleanLayout(mine.layout) : null, firm: firm ? cleanLayout(firm.layout) : null, firmUpdatedAt: firm?.updated_at ?? null };
}

dashboardModulesRouter.get("/dashboard/layout", async (req, res) => {
  const support = req.auth!.user.isSuperAdmin;
  const l = await withContext(req.ctx!, (c) => layouts(c, req.ctx!.firmId!, support ? null : req.auth!.user.id));
  res.json({
    ...l, builtIn: BUILT_IN_LAYOUT, effective: l.mine ?? l.firm ?? BUILT_IN_LAYOUT,
    source: l.mine ? "mine" : l.firm ? "firm" : "builtIn", canSetFirmDefault: !support && req.auth!.user.isFirmAdmin, canSave: !support,
  });
});

function parseLayout(req: Request): Layout {
  const parsed = LayoutBody.safeParse(req.body);
  if (!parsed.success) throw httpError(400, "That layout couldn't be read.");
  const l = cleanLayout(parsed.data.layout);
  if (!l) throw httpError(400, "That layout couldn't be read.");
  return l;
}
async function saveLayout(c: pg.PoolClient, firmId: number, userId: number | null, by: number, layout: Layout) {
  await c.query(
    userId === null
      ? `INSERT INTO dashboard_layouts (firm_id, user_id, layout, updated_by) VALUES ($1, NULL, $2, $3)
         ON CONFLICT (firm_id) WHERE user_id IS NULL DO UPDATE SET layout = EXCLUDED.layout, updated_by = EXCLUDED.updated_by`
      : `INSERT INTO dashboard_layouts (firm_id, user_id, layout, updated_by) VALUES ($1, $4, $2, $3)
         ON CONFLICT (firm_id, user_id) WHERE user_id IS NOT NULL DO UPDATE SET layout = EXCLUDED.layout, updated_by = EXCLUDED.updated_by`,
    userId === null ? [firmId, JSON.stringify(layout), by] : [firmId, JSON.stringify(layout), by, userId],
  );
}

/** Your own layout. Anyone at the firm (support access only reads). */
dashboardModulesRouter.put("/dashboard/layout", async (req, res) => {
  if (req.auth!.user.isSuperAdmin) throw httpError(403, "Support access is read-only.");
  const layout = parseLayout(req);
  await withContext(req.ctx!, (c) => saveLayout(c, req.ctx!.firmId!, req.auth!.user.id, req.auth!.user.id, layout));
  res.json({ layout });
});

/** Back to the firm default (or the built-in one). */
dashboardModulesRouter.delete("/dashboard/layout", async (req, res) => {
  if (req.auth!.user.isSuperAdmin) throw httpError(403, "Support access is read-only.");
  await withContext(req.ctx!, (c) => c.query(`DELETE FROM dashboard_layouts WHERE firm_id = $1 AND user_id = $2`, [req.ctx!.firmId, req.auth!.user.id]));
  res.json({ ok: true });
});

/** The firm default: where new people (and anyone who resets) start. A starting point only. */
dashboardModulesRouter.put("/dashboard/layout/firm", requireFirmAdmin, async (req, res) => {
  const layout = parseLayout(req);
  await withContext(req.ctx!, (c) => saveLayout(c, req.ctx!.firmId!, null, req.auth!.user.id, layout));
  res.json({ layout });
});
dashboardModulesRouter.delete("/dashboard/layout/firm", requireFirmAdmin, async (req, res) => {
  await withContext(req.ctx!, (c) => c.query(`DELETE FROM dashboard_layouts WHERE firm_id = $1 AND user_id IS NULL`, [req.ctx!.firmId]));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- module data
type Handler = (c: pg.PoolClient, req: Request, firmId: number, today: string) => Promise<unknown>;
const mine = (req: Request) => req.query.scope === "mine" && !req.auth!.user.isSuperAdmin;

const HANDLERS: Partial<Record<(typeof MODULE_TYPES)[number], Handler>> = {
  async deadlines(c, req, firmId, today) {
    const until = addDays(today, 14);
    const rows = (await c.query(
      `SELECT d.id, d.kind, d.title, d.due_on, d.due_time, d.location, p.id AS property_id, p.address1, p.name AS pname, p.city, t.name AS township, ${PIN_SQL} AS pin
         FROM deadlines d JOIN properties p ON p.firm_id = d.firm_id AND p.id = d.property_id LEFT JOIN townships t ON t.id = p.township_id
        WHERE d.firm_id = $1 AND d.status = 'open' AND d.due_on BETWEEN $2 AND $3
          AND ($4::int IS NULL OR $4 IN (p.attorney_user_id, p.analyst_user_id))
        ORDER BY d.due_on, d.due_time NULLS LAST, d.id LIMIT 30`,
      [firmId, today, until, mine(req) ? req.auth!.user.id : null],
    )).rows;
    const overdue = (await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM deadlines d JOIN properties p ON p.firm_id = d.firm_id AND p.id = d.property_id
        WHERE d.firm_id = $1 AND d.status = 'open' AND d.due_on < $2 AND ($3::int IS NULL OR $3 IN (p.attorney_user_id, p.analyst_user_id))`,
      [firmId, today, mine(req) ? req.auth!.user.id : null],
    )).rows[0].n;
    return {
      overdue,
      items: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, dueOn: r.due_on, time: r.due_time ? String(r.due_time).slice(0, 5) : null, location: r.location, inDays: dayDiff(today, r.due_on), propertyId: r.property_id, property: titleOf(r) })),
    };
  },

  async tasks(c, req, firmId, today) {
    const me = req.auth!.user.id;
    const rows = (await c.query(
      `SELECT ac.id, ac.kind, ac.subject, ac.due_on, ac.start_time, ac.property_id, ac.account_id, u.name AS assigned_name,
              p.address1, p.name AS pname, p.city, t.name AS township, ${PIN_SQL} AS pin, a2.name AS client
         FROM activities ac
         LEFT JOIN properties p ON p.firm_id = ac.firm_id AND p.id = ac.property_id LEFT JOIN townships t ON t.id = p.township_id
         LEFT JOIN accounts a2 ON a2.firm_id = ac.firm_id AND a2.id = ac.account_id
         LEFT JOIN users u ON u.firm_id = ac.firm_id AND u.id = ac.assigned_user_id
        WHERE ac.firm_id = $1 AND ac.status = 'open' AND ac.kind IN ('task', 'reminder', 'call')
          AND (NOT ac.is_private OR ac.created_by_user_id = $2)
          AND ($3::boolean IS FALSE OR ac.assigned_user_id = $2 OR (ac.assigned_user_id IS NULL AND ac.created_by_user_id = $2))
        ORDER BY ac.due_on NULLS LAST, ac.id LIMIT 30`,
      [firmId, me, mine(req)],
    )).rows;
    return {
      items: rows.map((r) => ({
        id: r.id, kind: r.kind, subject: r.subject, dueOn: r.due_on, time: r.start_time ? String(r.start_time).slice(0, 5) : null,
        overdue: Boolean(r.due_on && r.due_on < today), assigned: r.assigned_name,
        propertyId: r.property_id, accountId: r.account_id, about: r.property_id ? titleOf(r) : r.client,
      })),
    };
  },

  async week(c, req, firmId, today) {
    // Monday to Sunday of this week.
    const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    const from = addDays(today, -dow), to = addDays(from, 6);
    const me = req.auth!.user.id;
    const scoped = mine(req) ? me : null;
    const deadlines = (await c.query(
      `SELECT d.id, d.kind, d.title, d.due_on AS day, d.due_time AS time, p.id AS property_id, p.address1, p.name AS pname
         FROM deadlines d JOIN properties p ON p.firm_id = d.firm_id AND p.id = d.property_id
        WHERE d.firm_id = $1 AND d.status = 'open' AND d.due_on BETWEEN $2 AND $3 AND ($4::int IS NULL OR $4 IN (p.attorney_user_id, p.analyst_user_id))`,
      [firmId, from, to, scoped],
    )).rows;
    const acts = (await c.query(
      `SELECT ac.id, ac.kind, ac.subject, ac.due_on AS day, ac.start_time AS time, ac.property_id
         FROM activities ac
        WHERE ac.firm_id = $1 AND ac.status = 'open' AND ac.due_on BETWEEN $2 AND $3 AND ac.kind IN ('meeting', 'call', 'reminder', 'task')
          AND (NOT ac.is_private OR ac.created_by_user_id = $4)
          AND ($5::boolean IS FALSE OR ac.assigned_user_id = $4 OR (ac.assigned_user_id IS NULL AND ac.created_by_user_id = $4))`,
      [firmId, from, to, me, Boolean(scoped)],
    )).rows;
    const windows = (await c.query(
      `SELECT w.id, w.level, w.closes_on AS day, co.name AS county, t.name AS township
         FROM filing_windows w JOIN counties co ON co.id = w.county_id LEFT JOIN townships t ON t.id = w.township_id
        WHERE w.closes_on BETWEEN $2 AND $3
          AND EXISTS (SELECT 1 FROM properties p WHERE p.firm_id = $1 AND p.status = 'active' AND p.county_id = w.county_id AND (w.township_id IS NULL OR p.township_id = w.township_id))`,
      [firmId, from, to],
    )).rows;
    const days = Array.from({ length: 7 }, (_, i) => addDays(from, i)).map((day) => ({
      day,
      items: [
        ...windows.filter((w) => w.day === day).map((w) => ({ kind: "window", title: `${w.township ?? `${w.county} County`} ${LEVEL_LABELS[w.level as Level]} window closes`, time: null, to: `/calendar?date=${day}` })),
        ...deadlines.filter((d) => d.day === day).map((d) => ({ kind: d.kind, title: `${d.title} · ${d.address1 || d.pname}`, time: d.time ? String(d.time).slice(0, 5) : null, to: `/properties/${d.property_id}` })),
        ...acts.filter((a) => a.day === day).map((a) => ({ kind: a.kind, title: a.subject, time: a.time ? String(a.time).slice(0, 5) : null, to: a.property_id ? `/properties/${a.property_id}?tab=activities` : `/calendar?date=${day}` })),
      ].sort((x, y) => (x.time ?? "99").localeCompare(y.time ?? "99")),
    }));
    return { from, to, today, days };
  },

  async decisions(c, req, firmId) {
    if (req.auth!.user.isSuperAdmin) return { hidden: true };
    const counts = (await c.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM decision_letters WHERE firm_id = $1 AND status IN ('review', 'clean') GROUP BY status`, [firmId])).rows;
    const rows = (await c.query(
      `SELECT l.id, l.status, l.created_at, l.kind, p.id AS property_id, p.address1, p.name AS pname, p.city, t.name AS township, ${PIN_SQL} AS pin
         FROM decision_letters l LEFT JOIN properties p ON p.firm_id = l.firm_id AND p.id = l.property_id LEFT JOIN townships t ON t.id = p.township_id
        WHERE l.firm_id = $1 AND l.status IN ('review', 'clean') ORDER BY (l.status = 'review') DESC, l.id DESC LIMIT 6`,
      [firmId],
    )).rows;
    const reading = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM decision_uploads WHERE firm_id = $1 AND status IN ('queued', 'reading')`, [firmId])).rows[0].n;
    return {
      review: counts.find((x) => x.status === "review")?.n ?? 0, clean: counts.find((x) => x.status === "clean")?.n ?? 0, reading,
      items: rows.map((r) => ({ id: r.id, status: r.status, kind: r.kind, readOn: new Date(r.created_at).toISOString().slice(0, 10), property: r.property_id ? titleOf(r) : null })),
    };
  },

  async refunds(c, _req, firmId) {
    const rows = (await c.query(
      `SELECT a.id, a.property_id, a.assessment_year AS year, a.level, a.refund_expected, GREATEST(0, CURRENT_DATE - a.decision_on)::int AS days,
              p.address1, p.name AS pname, p.city, t.name AS township, ${PIN_SQL} AS pin, ac.name AS client
         FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id JOIN accounts ac ON ac.firm_id = p.firm_id AND ac.id = p.account_id
         LEFT JOIN townships t ON t.id = p.township_id
        WHERE a.firm_id = $1 AND a.refund_status = 'awaiting' ORDER BY a.decision_on NULLS LAST, a.id`,
      [firmId],
    )).rows;
    return {
      count: rows.length, total: sum(rows.map((r) => r.refund_expected)), ids: [...new Set(rows.map((r) => r.property_id))],
      items: rows.slice(0, 8).map((r) => ({ appealId: r.id, propertyId: r.property_id, property: titleOf(r), client: r.client, appeal: `${r.year} ${LEVEL_LABELS[r.level as Level]}`, expected: r.refund_expected, days: r.days })),
    };
  },

  async readyToBill(c, _req, firmId) {
    const ready = await readyToBill(c, firmId);
    const needs = await needsTaxFigures(c, firmId);
    return {
      count: ready.length, total: sum(ready.map((r) => r.fee)), needsTax: needs.length, ids: [...new Set(ready.map((r) => r.propertyId))],
      items: ready.slice(0, 6).map((r) => ({ appealId: r.appealId, propertyId: r.propertyId, property: r.title, client: r.client, appeal: `${r.year} ${LEVEL_LABELS[r.level as Level]}`, fee: r.fee })),
    };
  },

  async aging(c, _req, firmId, today) {
    const rows = (await c.query<{ id: number; total: string; due_on: string | null; issued_on: string | null }>(
      `SELECT i.id, i.total, i.due_on, i.issued_on FROM invoices i WHERE i.firm_id = $1 AND i.status = 'sent'`, [firmId],
    )).rows;
    const buckets = [["current", "Not yet due"], ["d30", "1 to 30 days"], ["d60", "31 to 60 days"], ["d90", "61 to 90 days"], ["over", "Over 90 days"]] as const;
    const late = (r: { due_on: string | null }) => (r.due_on && r.due_on < today ? dayDiff(r.due_on, today) : 0);
    const keyOf = (n: number) => (n <= 0 ? "current" : n <= 30 ? "d30" : n <= 60 ? "d60" : n <= 90 ? "d90" : "over");
    return {
      total: sum(rows.map((r) => r.total)), count: rows.length,
      buckets: buckets.map(([key, label]) => {
        const xs = rows.filter((r) => keyOf(late(r)) === key);
        return { key, label, count: xs.length, total: sum(xs.map((r) => r.total)) };
      }),
    };
  },

  async collected(c, _req, firmId, today) {
    const year = today.slice(0, 4);
    const rows = (await c.query<{ m: string; s: string }>(
      `SELECT to_char(received_on, 'YYYY-MM') AS m, sum(amount)::numeric(14,2) AS s FROM payments
        WHERE firm_id = $1 AND status = 'succeeded' AND received_on >= $2::date AND received_on <= $3::date GROUP BY 1 ORDER BY 1`,
      [firmId, `${year}-01-01`, today],
    )).rows;
    const lastYtd = (await c.query<{ s: string }>(
      `SELECT COALESCE(sum(amount), 0)::numeric(14,2) AS s FROM payments WHERE firm_id = $1 AND status = 'succeeded' AND received_on BETWEEN $2::date AND $3::date`,
      [firmId, `${Number(year) - 1}-01-01`, `${Number(year) - 1}${today.slice(4)}`],
    )).rows[0].s;
    const months = Array.from({ length: Number(today.slice(5, 7)) }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
    return {
      month: rows.find((r) => r.m === today.slice(0, 7))?.s ?? "0.00", year: sum(rows.map((r) => r.s)), lastYearToDate: lastYtd,
      months: months.map((m) => ({ month: m, total: rows.find((r) => r.m === m)?.s ?? "0.00" })),
    };
  },

  async trust(c, _req, firmId) {
    const bal = await balances(c, firmId);
    return { total: sum(bal.map((b) => b.balance)), clients: bal.length, items: [...bal].sort((a, b) => Number(b.balance) - Number(a.balance)).slice(0, 8) };
  },

  async expenses(c, _req, firmId) {
    const rows = (await expenseRows(c, firmId, `e.written_off_at IS NULL`, [])).filter((e) => e.state !== "recovered" && e.state !== "written_off");
    return {
      total: sum(rows.map((e) => e.amount)), count: rows.length, open: rows.filter((e) => e.state === "open").length,
      items: rows.slice(0, 6).map((e) => ({ id: e.id, propertyId: e.propertyId, property: e.title, vendor: e.vendor, description: e.description, amount: e.amount, state: e.state, incurredOn: e.incurredOn })),
    };
  },

  async topClients(c, req, firmId, today) {
    const cycle = Number(today.slice(0, 4));
    const which = req.query.year === "last" ? cycle - 1 : req.query.year === "all" ? null : cycle;
    const rows = (await c.query<{ account_id: number; name: string; savings: string; appeals: number }>(
      `SELECT ac.id AS account_id, ac.name, sum(a.savings)::numeric(14,2) AS savings, count(*)::int AS appeals
         FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id JOIN accounts ac ON ac.firm_id = p.firm_id AND ac.id = p.account_id
        WHERE a.firm_id = $1 AND a.status = 'reduced' AND a.savings > 0 AND NOT a.exclude_from_totals AND ($2::int IS NULL OR a.assessment_year = $2)
        GROUP BY ac.id, ac.name ORDER BY sum(a.savings) DESC, ac.name LIMIT 8`,
      [firmId, which],
    )).rows;
    return { year: which, items: rows.map((r) => ({ accountId: r.account_id, client: r.name, savings: r.savings, appeals: r.appeals })) };
  },

  async savingsByYear(c, _req, firmId) {
    const rows = (await c.query<{ year: number; savings: string; appeals: number; ids: number[] }>(
      `SELECT a.assessment_year AS year, sum(a.savings)::numeric(14,2) AS savings, count(*)::int AS appeals, array_agg(DISTINCT a.property_id) AS ids
         FROM appeals a WHERE a.firm_id = $1 AND a.status = 'reduced' AND a.savings > 0 AND NOT a.exclude_from_totals
        GROUP BY a.assessment_year ORDER BY a.assessment_year DESC LIMIT 8`,
      [firmId],
    )).rows;
    return { years: rows.reverse() };
  },

  async recentProperties(c, _req, firmId) {
    const rows = (await c.query(
      `SELECT p.id, p.address1, p.name AS pname, p.city, p.asset_type, p.created_at, t.name AS township, ac.name AS client, ${PIN_SQL} AS pin,
              (SELECT ph.updated_at FROM property_photos ph WHERE ph.firm_id = p.firm_id AND ph.property_id = p.id) AS photo_at
         FROM properties p JOIN accounts ac ON ac.firm_id = p.firm_id AND ac.id = p.account_id LEFT JOIN townships t ON t.id = p.township_id
        WHERE p.firm_id = $1 ORDER BY p.created_at DESC, p.id DESC LIMIT 8`,
      [firmId],
    )).rows;
    return { items: rows.map((r) => ({ id: r.id, title: titleOf(r), client: r.client, assetType: r.asset_type, photoAt: r.photo_at, addedOn: String(new Date(r.created_at).toISOString()).slice(0, 10) })) };
  },

  async coCounsel(c, _req, firmId) {
    const rows = (await c.query(
      `SELECT p.id, p.address1, p.name AS pname, p.city, t.name AS township, ${PIN_SQL} AS pin, p.co_counsel_firm, p.co_counsel_role, p.co_counsel_percent, ac.name AS client
         FROM properties p JOIN accounts ac ON ac.firm_id = p.firm_id AND ac.id = p.account_id LEFT JOIN townships t ON t.id = p.township_id
        WHERE p.firm_id = $1 AND p.co_counsel_firm IS NOT NULL ORDER BY p.co_counsel_firm, p.address1`,
      [firmId],
    )).rows;
    const firms = [...new Set(rows.map((r) => r.co_counsel_firm as string))];
    return {
      count: rows.length, ids: rows.map((r) => r.id),
      firms: firms.map((f) => ({ firm: f, items: rows.filter((r) => r.co_counsel_firm === f).map((r) => ({ propertyId: r.id, property: titleOf(r), client: r.client, role: r.co_counsel_role, percent: r.co_counsel_percent })) })),
    };
  },

  async imports(c, req, firmId) {
    if (req.auth!.user.isSuperAdmin) return { hidden: true };
    const rows = (await c.query(
      `SELECT b.id, b.purpose, b.status, b.summary, b.created_at, b.committed_at, u.name AS by_name,
              (SELECT count(*)::int FROM import_files f WHERE f.firm_id = b.firm_id AND f.batch_id = b.id) AS files
         FROM import_batches b LEFT JOIN users u ON u.firm_id = b.firm_id AND u.id = COALESCE(b.committed_by, b.created_by)
        WHERE b.firm_id = $1 ORDER BY b.created_at DESC LIMIT 5`,
      [firmId],
    )).rows;
    return {
      items: rows.map((r) => {
        const applied = r.summary?.applied as { created?: Record<string, number>; updated?: Record<string, number> } | undefined;
        const n = (m?: Record<string, number>) => Object.values(m ?? {}).reduce((a, x) => a + x, 0);
        return { id: r.id, purpose: r.purpose, status: r.status, files: r.files, by: r.by_name, at: r.committed_at ?? r.created_at, added: n(applied?.created), changed: n(applied?.updated) };
      }),
    };
  },
};

dashboardModulesRouter.get("/dashboard/m/:type", async (req, res) => {
  const type = String(req.params.type) as (typeof MODULE_TYPES)[number];
  const h = HANDLERS[type];
  if (!h) throw httpError(404, "No such module.");
  const out = await withContext(req.ctx!, (c) => h(c, req, req.ctx!.firmId!, todayIso()));
  res.json(out);
});

// ---------------------------------------------------------------- "Your number"
const pick = (v: unknown, choices: [string, string][]) => (choices.some(([c]) => c === v) ? String(v) : choices[0][0]);

dashboardModulesRouter.get("/dashboard/kpi", async (req, res) => {
  const metric = pick(req.query.metric, KPI_METRICS);
  const level = pick(req.query.level, KPI_LEVELS) as Level | "";
  const group = pick(req.query.group, KPI_GROUPS);
  const yearKey = pick(req.query.year, KPI_YEARS);
  const today = todayIso();
  const cycle = Number(today.slice(0, 4));
  const year = yearKey === "current" ? cycle : yearKey === "last" ? cycle - 1 : null;
  const firmId = req.ctx!.firmId!;
  const groupSql = `($3::text = '' OR app_asset_group(p.asset_type, p.units, p.county_id, p.asset_group_override) = $3)`;
  const out = await withContext(req.ctx!, async (c) => {
    if (metric === "properties") {
      // Active properties; a level narrows to those whose appeals include that level (in the year, if one is chosen).
      const r = (await c.query<{ ids: number[] | null }>(
        `SELECT array_agg(p.id ORDER BY p.id) AS ids FROM properties p
          WHERE p.firm_id = $1 AND p.status = 'active' AND ${groupSql}
            AND ($2::text = '' OR EXISTS (SELECT 1 FROM appeals a WHERE a.firm_id = p.firm_id AND a.property_id = p.id AND a.level = $2 AND ($4::int IS NULL OR a.assessment_year = $4)))`,
        [firmId, level, group, year],
      )).rows[0];
      return { value: String(r.ids?.length ?? 0), format: "count", ids: r.ids ?? [] };
    }
    if (metric === "appeals" || metric === "savingsAchieved" || metric === "savingsInPlay") {
      const where = metric === "savingsAchieved" ? `a.status = 'reduced' AND a.savings > 0 AND NOT a.exclude_from_totals`
        : metric === "savingsInPlay" ? `a.status IN ('open', 'waiting_decision') AND a.substage NOT IN ('invoice_sent', 'pushed_next_level', 'closed') AND NOT a.exclude_from_totals`
        : `true`;
      const r = (await c.query<{ n: number; s: string; ids: number[] | null }>(
        `SELECT count(*)::int AS n, COALESCE(sum(${metric === "savingsInPlay" ? "a.estimated_savings" : "a.savings"}), 0)::numeric(14,2) AS s, array_agg(DISTINCT a.property_id) AS ids
           FROM appeals a JOIN properties p ON p.firm_id = a.firm_id AND p.id = a.property_id
          WHERE a.firm_id = $1 AND ${where} AND ($2::text = '' OR a.level = $2) AND ${groupSql} AND ($4::int IS NULL OR a.assessment_year = $4)`,
        [firmId, level, group, year],
      )).rows[0];
      return metric === "appeals" ? { value: String(r.n), format: "count", ids: r.ids ?? [] } : { value: r.s, format: "money", ids: r.ids ?? [] };
    }
    // Money by calendar year: invoices issued (not void), payments received.
    const from = year ? `${year}-01-01` : null, to = year ? `${year}-12-31` : null;
    const r = metric === "feesBilled"
      ? (await c.query<{ s: string; ids: number[] | null }>(
        `SELECT COALESCE(sum(i.total), 0)::numeric(14,2) AS s, array_agg(DISTINCT i.property_id) AS ids
           FROM invoices i JOIN properties p ON p.firm_id = i.firm_id AND p.id = i.property_id LEFT JOIN appeals a ON a.firm_id = i.firm_id AND a.id = i.appeal_id
          WHERE i.firm_id = $1 AND i.status IN ('sent', 'paid') AND ($2::text = '' OR a.level = $2) AND ${groupSql}
            AND ($4::date IS NULL OR i.issued_on BETWEEN $4::date AND $5::date)`,
        [firmId, level, group, from, to],
      )).rows[0]
      : (await c.query<{ s: string; ids: number[] | null }>(
        `SELECT COALESCE(sum(y.amount), 0)::numeric(14,2) AS s, NULL::int[] AS ids FROM payments y
          WHERE y.firm_id = $1 AND y.status = 'succeeded' AND ($4::date IS NULL OR y.received_on BETWEEN $4::date AND $5::date)
            AND ($2::text = '' AND $3::text = '' OR EXISTS (
              SELECT 1 FROM invoices i JOIN properties p ON p.firm_id = i.firm_id AND p.id = i.property_id LEFT JOIN appeals a ON a.firm_id = i.firm_id AND a.id = i.appeal_id
               WHERE i.firm_id = y.firm_id AND (i.id = y.invoice_id OR i.statement_id = y.statement_id) AND ($2::text = '' OR a.level = $2) AND ${groupSql}))`,
        [firmId, level, group, from, to],
      )).rows[0];
    return { value: r.s, format: "money", ids: r.ids ?? [] };
  });
  res.json({ ...out, metric, level, group, year: yearKey, levels: LEVELS });
});
