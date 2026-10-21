import { Router } from "express";
import { z } from "zod";
import { query, withContext } from "../db.js";
import {
  clearLoginFailures, clearSessionCookie, createSession, destroySession, loginThrottled,
  readSessionToken, recordLoginFailure, setSessionCookie, verifyPassword, activeGrantId,
  hashPassword, hashSessionToken, PASSWORD_MIN_LENGTH,
} from "../auth.js";

export const authRouter = Router();

const LoginBody = z.object({ email: z.string().trim().email().max(200), password: z.string().min(1).max(200) });

authRouter.post("/login", async (req, res) => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter your email and password." });
    return;
  }
  const email = parsed.data.email.toLowerCase();
  const throttleKey = `${email}|${req.ip}`;
  if (loginThrottled(throttleKey)) {
    res.status(429).json({ error: "Too many attempts. Wait 15 minutes and try again." });
    return;
  }
  const { rows } = await query<{ id: number; password_hash: string; active: boolean; is_super_admin: boolean; firm_status: string | null }>(
    `SELECT u.id, u.password_hash, u.active, u.is_super_admin, f.status AS firm_status
       FROM users u LEFT JOIN firms f ON f.id = u.firm_id WHERE lower(u.email) = $1`,
    [email],
  );
  const user = rows[0];
  const ok = user && user.active && (user.is_super_admin || user.firm_status === "active") && verifyPassword(parsed.data.password, user.password_hash);
  if (!ok) {
    recordLoginFailure(throttleKey);
    res.status(401).json({ error: "That email and password don't match an active account." });
    return;
  }
  clearLoginFailures(throttleKey);
  const token = await createSession(user.id);
  setSessionCookie(req, res, token);
  res.json({ ok: true });
});

authRouter.post("/logout", async (req, res) => {
  const token = readSessionToken(req);
  if (token) await destroySession(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get("/me", async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  const u = auth.user;
  let firm: { id: number; name: string; isSample: boolean } | null = null;
  let acting: { firmId: number; firmName: string; grantExpiresAt: string } | null = null;
  let permissions: string[] = [];

  if (!u.isSuperAdmin && u.firmId) {
    const f = await query<{ id: number; name: string; is_sample: boolean }>(`SELECT id, name, is_sample FROM firms WHERE id = $1`, [u.firmId]);
    firm = { id: f.rows[0].id, name: f.rows[0].name, isSample: f.rows[0].is_sample };
    permissions = await withContext({ actorKind: "firm_user", userId: u.id, firmId: u.firmId }, async (c) => {
      const p = await c.query<{ permission: string }>(
        `SELECT permission FROM role_permissions WHERE firm_id = $1 AND role = $2 AND allowed ORDER BY permission`,
        [u.firmId, u.role],
      );
      return p.rows.map((r) => r.permission);
    });
  } else if (u.isSuperAdmin && auth.actingFirmId) {
    const grantId = await activeGrantId(auth.actingFirmId);
    if (grantId) {
      const g = await query<{ name: string; expires_at: string; is_sample: boolean }>(
        `SELECT f.name, f.is_sample, g.expires_at FROM support_grants g JOIN firms f ON f.id = g.firm_id WHERE g.id = $1`,
        [grantId],
      );
      acting = { firmId: auth.actingFirmId, firmName: g.rows[0].name, grantExpiresAt: g.rows[0].expires_at };
      firm = { id: auth.actingFirmId, name: g.rows[0].name, isSample: g.rows[0].is_sample };
    } else {
      await query("UPDATE sessions SET acting_firm_id = NULL WHERE id = $1", [auth.sessionId]);
    }
  }

  const prefs = (await query<{ show_value_cents: boolean }>(`SELECT show_value_cents FROM users WHERE id = $1`, [u.id])).rows[0];
  res.json({
    user: { id: u.id, name: u.name, email: u.email, role: u.role, isSuperAdmin: u.isSuperAdmin, isFirmAdmin: u.isFirmAdmin },
    firm,
    acting,
    permissions,
    preferences: { showValueCents: prefs?.show_value_cents ?? false },
  });
});

/** The signed-in person's own display choices (today: cents on assessed and market values). */
authRouter.put("/preferences", async (req, res) => {
  if (!req.auth) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  const parsed = z.object({ showValueCents: z.boolean() }).strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid preference." });
    return;
  }
  await query(`UPDATE users SET show_value_cents = $2 WHERE id = $1`, [req.auth.user.id, parsed.data.showValueCents]);
  res.json({ preferences: parsed.data });
});

const PasswordChange = z.object({ current: z.string().min(1).max(200), next: z.string().max(200) });

/**
 * Anyone signed in changes their own password. The current password is required (and throttled like
 * sign-in), every other session for the account ends, and the change is recorded in the firm's audit
 * log without any password material.
 */
authRouter.post("/password", async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  const parsed = PasswordChange.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter your current password and a new one." });
    return;
  }
  const { current, next } = parsed.data;
  const throttleKey = `password|${auth.user.id}`;
  if (loginThrottled(throttleKey)) {
    res.status(429).json({ error: "Too many attempts. Wait 15 minutes and try again." });
    return;
  }
  const row = (await query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [auth.user.id])).rows[0];
  if (!row || !verifyPassword(current, row.password_hash)) {
    recordLoginFailure(throttleKey);
    res.status(400).json({ error: "Your current password isn't right." });
    return;
  }
  clearLoginFailures(throttleKey);
  if (next.length < PASSWORD_MIN_LENGTH) {
    res.status(400).json({ error: `The new password needs at least ${PASSWORD_MIN_LENGTH} characters.` });
    return;
  }
  if (next === current) {
    res.status(400).json({ error: "The new password is the same as the current one." });
    return;
  }
  await query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [auth.user.id, hashPassword(next)]);
  const token = readSessionToken(req);
  await query(`DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2`, [auth.user.id, token ? hashSessionToken(token) : ""]);
  if (!auth.user.isSuperAdmin && auth.user.firmId) {
    await withContext({ actorKind: "firm_user", userId: auth.user.id, firmId: auth.user.firmId }, (c) =>
      c.query(
        `INSERT INTO audit_log (firm_id, actor_user_id, actor_kind, table_name, row_id, action, before, after)
         VALUES ($1, $2, 'firm_user', 'users', $3, 'UPDATE', NULL, $4)`,
        [auth.user.firmId, auth.user.id, String(auth.user.id), { password: "changed" }],
      ),
    );
  }
  res.json({ ok: true });
});
