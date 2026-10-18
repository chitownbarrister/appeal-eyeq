// Firm-scoped routes. Every handler runs inside withContext(req.ctx), so
// row-level security applies, and every query also filters on firm_id
// explicitly. Identity tables outside the lock (users, firms,
// support_grants) are always filtered by req.ctx.firmId by hand.

import { Router } from "express";
import { z } from "zod";
import { query, withContext, type DbContext } from "../db.js";
import { hashPassword, PASSWORD_MIN_LENGTH, requireFirmContext, requirePermission } from "../auth.js";
import { LEVELS, PERMISSIONS, ROLES } from "../../shared/domain.js";
import { mattersRouter } from "./matters.js";

export const firmRouter = Router();
firmRouter.use(requireFirmContext);
firmRouter.use(mattersRouter);

// ---------------------------------------------------------------- summary
firmRouter.get("/summary", async (req, res) => {
  const firmId = req.ctx!.firmId;
  const data = await withContext(req.ctx!, async (c) => {
    const counts = await c.query<{ accounts: string; properties: string; active_properties: string; appeals: string }>(
      `SELECT (SELECT count(*) FROM accounts WHERE firm_id = $1) AS accounts,
              (SELECT count(*) FROM properties WHERE firm_id = $1) AS properties,
              (SELECT count(*) FROM properties WHERE firm_id = $1 AND status = 'active') AS active_properties,
              (SELECT count(*) FROM appeals WHERE firm_id = $1) AS appeals`,
      [firmId],
    );
    const money = await c.query<{ achieved: string; in_play: string }>(
      `SELECT COALESCE(sum(savings) FILTER (WHERE status = 'reduced'), 0)::numeric(14,2) AS achieved,
              COALESCE(sum(estimated_savings) FILTER (
                WHERE status IN ('open', 'waiting_decision')
                  AND substage NOT IN ('invoice_sent', 'pushed_next_level', 'closed')
              ), 0)::numeric(14,2) AS in_play
         FROM appeals WHERE firm_id = $1 AND NOT exclude_from_totals`,
      [firmId],
    );
    const byLevel = await c.query<{ level: string; count: string }>(
      `SELECT a.level, count(DISTINCT a.property_id) AS count
         FROM appeals a
         JOIN (SELECT property_id, max(assessment_year) AS yr FROM appeals WHERE firm_id = $1 GROUP BY property_id) cur
           ON cur.property_id = a.property_id AND cur.yr = a.assessment_year
        WHERE a.firm_id = $1 AND a.status IN ('open', 'waiting_decision')
        GROUP BY a.level`,
      [firmId],
    );
    return { counts: counts.rows[0], money: money.rows[0], byLevel: byLevel.rows };
  });
  res.json({
    accounts: Number(data.counts.accounts),
    properties: Number(data.counts.properties),
    activeProperties: Number(data.counts.active_properties),
    appeals: Number(data.counts.appeals),
    savingsAchieved: data.money.achieved,
    savingsInPlay: data.money.in_play,
    openAppealsByLevel: Object.fromEntries(LEVELS.map((l) => [l, Number(data.byLevel.find((r) => r.level === l)?.count ?? 0)])),
  });
});

// ---------------------------------------------------------------- users
firmRouter.get("/users", async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, email, role, active, created_at FROM users WHERE firm_id = $1 ORDER BY active DESC, name`,
    [req.ctx!.firmId],
  );
  res.json({ users: rows });
});

const NewUser = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  role: z.enum(ROLES),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(200),
});

firmRouter.post("/users", requirePermission("users.manage"), async (req, res) => {
  const parsed = NewUser.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: `Name, a valid email, a role, and a password of at least ${PASSWORD_MIN_LENGTH} characters are required.` });
    return;
  }
  const dupe = await query("SELECT 1 FROM users WHERE lower(email) = lower($1)", [parsed.data.email]);
  if (dupe.rowCount) {
    res.status(409).json({ error: "That email is already in use." });
    return;
  }
  const { rows } = await query(
    `INSERT INTO users (firm_id, email, name, password_hash, role) VALUES ($1, lower($2), $3, $4, $5)
     RETURNING id, name, email, role, active, created_at`,
    [req.ctx!.firmId, parsed.data.email, parsed.data.name, hashPassword(parsed.data.password), parsed.data.role],
  );
  await auditUserChange(req.ctx!, rows[0].id, "INSERT", null, rows[0]);
  res.status(201).json({ user: rows[0] });
});

const UpdateUser = z.object({ role: z.enum(ROLES).optional(), active: z.boolean().optional() });

firmRouter.patch("/users/:id", requirePermission("users.manage"), async (req, res) => {
  const parsed = UpdateUser.safeParse(req.body);
  const id = Number(req.params.id);
  if (!parsed.success || !Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid update." });
    return;
  }
  if (id === req.auth!.user.id && parsed.data.active === false) {
    res.status(400).json({ error: "You can't deactivate your own account." });
    return;
  }
  const before = (await query(`SELECT id, name, email, role, active FROM users WHERE id = $1 AND firm_id = $2`, [id, req.ctx!.firmId])).rows[0];
  const { rows } = await query(
    `UPDATE users SET role = COALESCE($3, role), active = COALESCE($4, active)
      WHERE id = $1 AND firm_id = $2 RETURNING id, name, email, role, active, created_at`,
    [id, req.ctx!.firmId, parsed.data.role ?? null, parsed.data.active ?? null],
  );
  if (!rows[0]) {
    res.status(404).json({ error: "User not found." });
    return;
  }
  await auditUserChange(req.ctx!, id, "UPDATE", before, rows[0]);
  if (parsed.data.active === false) await query("DELETE FROM sessions WHERE user_id = $1", [id]);
  res.json({ user: rows[0] });
});

/** Users live outside the tenant lock, so their changes are audited explicitly (never the password hash). */
async function auditUserChange(ctx: DbContext, userId: number, action: "INSERT" | "UPDATE", before: unknown, after: unknown): Promise<void> {
  const strip = (u: unknown) => {
    if (!u || typeof u !== "object") return null;
    const { id, name, email, role, active } = u as Record<string, unknown>;
    return { id, name, email, role, active };
  };
  await withContext(ctx, (c) =>
    c.query(
      `INSERT INTO audit_log (firm_id, actor_user_id, actor_kind, table_name, row_id, action, before, after)
       VALUES ($1, $2, $3, 'users', $4, $5, $6, $7)`,
      [ctx.firmId, ctx.userId, ctx.actorKind, String(userId), action, strip(before), strip(after)],
    ),
  );
}

// ---------------------------------------------------------------- permissions
firmRouter.get("/permissions", async (req, res) => {
  const rows = await withContext(req.ctx!, async (c) =>
    (await c.query(`SELECT role, permission, allowed FROM role_permissions WHERE firm_id = $1 ORDER BY role, permission`, [req.ctx!.firmId])).rows,
  );
  res.json({ permissions: rows });
});

const PermissionChange = z.object({ role: z.enum(ROLES), permission: z.enum(PERMISSIONS), allowed: z.boolean() });

firmRouter.put("/permissions", requirePermission("users.manage"), async (req, res) => {
  const parsed = PermissionChange.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid permission change." });
    return;
  }
  const { role, permission, allowed } = parsed.data;
  if (!allowed && permission === "users.manage" && role === req.auth!.user.role) {
    res.status(400).json({ error: "You can't remove user management from your own role." });
    return;
  }
  await withContext(req.ctx!, (c) =>
    c.query(
      `INSERT INTO role_permissions (firm_id, role, permission, allowed) VALUES ($1, $2, $3, $4)
       ON CONFLICT (firm_id, role, permission) DO UPDATE SET allowed = EXCLUDED.allowed`,
      [req.ctx!.firmId, role, permission, allowed],
    ),
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------- fee defaults
firmRouter.get("/fee-defaults", async (req, res) => {
  const rows = await withContext(req.ctx!, async (c) =>
    (await c.query(
      `SELECT level, percent, basis FROM fee_defaults WHERE firm_id = $1
        ORDER BY array_position(ARRAY['assessor','bor','ptab','circuit'], level)`,
      [req.ctx!.firmId],
    )).rows,
  );
  res.json({ feeDefaults: rows });
});

const FeeChange = z.object({ level: z.enum(LEVELS), percent: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/) });

firmRouter.put("/fee-defaults", requirePermission("fees.edit"), async (req, res) => {
  const parsed = FeeChange.safeParse(req.body);
  if (!parsed.success || Number(parsed.data.percent) > 100) {
    res.status(400).json({ error: "Enter a percent between 0 and 100 with up to 2 decimals." });
    return;
  }
  const updated = await withContext(req.ctx!, (c) =>
    c.query(`UPDATE fee_defaults SET percent = $3 WHERE firm_id = $1 AND level = $2`, [req.ctx!.firmId, parsed.data.level, parsed.data.percent]),
  );
  if (!updated.rowCount) {
    res.status(404).json({ error: "No fee default for that level." });
    return;
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------- support access
firmRouter.get("/support-grants", async (req, res) => {
  const { rows } = await query(
    `SELECT g.id, g.reason, g.expires_at, g.revoked_at, g.created_at,
            gb.name AS granted_by, rb.name AS revoked_by,
            (g.revoked_at IS NULL AND g.expires_at > now()) AS active
       FROM support_grants g
       JOIN users gb ON gb.id = g.granted_by_user_id
       LEFT JOIN users rb ON rb.id = g.revoked_by_user_id
      WHERE g.firm_id = $1
      ORDER BY g.created_at DESC LIMIT 50`,
    [req.ctx!.firmId],
  );
  res.json({ grants: rows });
});

const NewGrant = z.object({ hours: z.number().int().min(1).max(72), reason: z.string().trim().max(500).optional() });

firmRouter.post("/support-grants", requirePermission("support.grant"), async (req, res) => {
  const parsed = NewGrant.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Choose between 1 and 72 hours." });
    return;
  }
  const grant = await withContext(req.ctx!, async (c) => {
    // One active grant at a time: a new grant replaces any open one.
    await c.query(
      `UPDATE support_grants SET revoked_at = now(), revoked_by_user_id = $2
        WHERE firm_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [req.ctx!.firmId, req.auth!.user.id],
    );
    const { rows } = await c.query(
      `INSERT INTO support_grants (firm_id, granted_by_user_id, reason, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(hours => $4)) RETURNING id, reason, expires_at, created_at`,
      [req.ctx!.firmId, req.auth!.user.id, parsed.data.reason ?? null, parsed.data.hours],
    );
    return rows[0];
  });
  res.status(201).json({ grant });
});

firmRouter.post("/support-grants/:id/revoke", requirePermission("support.grant"), async (req, res) => {
  const id = Number(req.params.id);
  const result = await withContext(req.ctx!, (c) =>
    c.query(
      `UPDATE support_grants SET revoked_at = now(), revoked_by_user_id = $3
        WHERE id = $1 AND firm_id = $2 AND revoked_at IS NULL RETURNING id`,
      [id, req.ctx!.firmId, req.auth!.user.id],
    ),
  );
  if (!result.rowCount) {
    res.status(404).json({ error: "No open grant with that id." });
    return;
  }
  // Drop the super admin out of the firm immediately, not on their next request.
  await query("UPDATE sessions SET acting_firm_id = NULL WHERE acting_firm_id = $1", [req.ctx!.firmId]);
  res.json({ ok: true });
});

firmRouter.get("/support-access-log", async (req, res) => {
  const rows = await withContext(req.ctx!, async (c) =>
    (await c.query(
      `SELECT l.id, l.method, l.path, l.at, l.grant_id FROM support_access_log l
        WHERE l.firm_id = $1 ORDER BY l.at DESC LIMIT 200`,
      [req.ctx!.firmId],
    )).rows,
  );
  res.json({ entries: rows });
});

// ---------------------------------------------------------------- audit log
firmRouter.get("/audit-log", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = await withContext(req.ctx!, async (c) =>
    (await c.query(
      `SELECT a.id, a.actor_kind, a.actor_user_id, a.table_name, a.row_id, a.action, a.at
         FROM audit_log a WHERE a.firm_id = $1 ORDER BY a.at DESC, a.id DESC LIMIT $2`,
      [req.ctx!.firmId, limit],
    )).rows,
  );
  // Names for actors come from the identity table, scoped to this firm (or the super admin).
  const ids = [...new Set(rows.map((r) => r.actor_user_id).filter(Boolean))];
  const names = ids.length
    ? (await query<{ id: number; name: string }>(
        `SELECT id, name FROM users WHERE id = ANY($1) AND (firm_id = $2 OR is_super_admin)`,
        [ids, req.ctx!.firmId],
      )).rows
    : [];
  const byId = new Map(names.map((n) => [n.id, n.name]));
  res.json({ entries: rows.map((r) => ({ ...r, actor_name: r.actor_user_id ? byId.get(r.actor_user_id) ?? null : null })) });
});
