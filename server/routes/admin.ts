// Super admin routes. The super admin manages firms and global reference
// data, and can enter a firm only while that firm has an active support
// grant. Nothing here reads firm data tables.

import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { activeGrantId, PASSWORD_MIN_LENGTH, requireSuperAdmin } from "../auth.js";
import { provisionFirm } from "../firms.js";

export const adminRouter = Router();
adminRouter.use(requireSuperAdmin);

adminRouter.get("/firms", async (_req, res) => {
  const { rows } = await query(
    `SELECT f.id, f.name, f.slug, f.status, f.is_sample, f.created_at,
            (SELECT count(*)::int FROM users u WHERE u.firm_id = f.id AND u.active) AS active_users,
            (SELECT max(g.expires_at) FROM support_grants g
              WHERE g.firm_id = f.id AND g.revoked_at IS NULL AND g.expires_at > now()) AS grant_expires_at
       FROM firms f ORDER BY f.name`,
  );
  res.json({ firms: rows });
});

const NewFirm = z.object({
  name: z.string().trim().min(2).max(160),
  slug: z.string().trim().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(60),
  attorneyName: z.string().trim().min(1).max(120),
  attorneyEmail: z.string().trim().email().max(200),
  attorneyPassword: z.string().min(PASSWORD_MIN_LENGTH).max(200),
});

adminRouter.post("/firms", async (req, res) => {
  const parsed = NewFirm.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: `Firm name, a lowercase slug (letters, numbers, hyphens), and the first attorney's name, email and a password of at least ${PASSWORD_MIN_LENGTH} characters are required.`,
    });
    return;
  }
  const d = parsed.data;
  const clash = await query(
    `SELECT (SELECT 1 FROM firms WHERE slug = $1) AS slug_taken, (SELECT 1 FROM users WHERE lower(email) = lower($2)) AS email_taken`,
    [d.slug, d.attorneyEmail],
  );
  if (clash.rows[0].slug_taken || clash.rows[0].email_taken) {
    res.status(409).json({ error: clash.rows[0].slug_taken ? "That slug is taken." : "That email is already in use." });
    return;
  }
  const created = await provisionFirm({
    name: d.name,
    slug: d.slug,
    firstUser: { name: d.attorneyName, email: d.attorneyEmail, password: d.attorneyPassword, role: "attorney" },
  });
  res.status(201).json({ firmId: created.firmId });
});

/** Enter a firm under its active support grant (read-only). */
adminRouter.post("/firms/:id/enter", async (req, res) => {
  const firmId = Number(req.params.id);
  if (!Number.isInteger(firmId)) {
    res.status(400).json({ error: "Invalid firm." });
    return;
  }
  const grantId = await activeGrantId(firmId);
  if (!grantId) {
    res.status(403).json({ error: "This firm hasn't granted support access." });
    return;
  }
  await query("UPDATE sessions SET acting_firm_id = $1 WHERE id = $2", [firmId, req.auth!.sessionId]);
  res.json({ ok: true });
});

adminRouter.post("/exit", async (req, res) => {
  await query("UPDATE sessions SET acting_firm_id = NULL WHERE id = $1", [req.auth!.sessionId]);
  res.json({ ok: true });
});

adminRouter.get("/reference-changes", async (_req, res) => {
  const { rows } = await query(
    `SELECT id, table_name, row_id, action, at FROM reference_change_log ORDER BY at DESC, id DESC LIMIT 200`,
  );
  res.json({ changes: rows });
});
