import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { query, withContext, type DbContext } from "./db.js";
import type { Permission, Role } from "../shared/domain.js";

export const SESSION_COOKIE = "aeq_session";
const SESSION_IDLE_HOURS = 12;

export interface AuthUser {
  id: number;
  firmId: number | null;
  email: string;
  name: string;
  role: Role | null;
  isSuperAdmin: boolean;
  isFirmAdmin: boolean;
}

export interface AuthState {
  user: AuthUser;
  sessionId: number;
  actingFirmId: number | null; // super admin only
}

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthState;
    ctx?: DbContext;
    grantId?: number;
  }
}

// ---------------------------------------------------------------- passwords
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = (stored || "").split(":");
  if (!salt || !hash) return false;
  const derived = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export const PASSWORD_MIN_LENGTH = 10;

// ---------------------------------------------------------------- sessions
export function hashSessionToken(token: string): string {
  return hashToken(token);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`,
    [hashToken(token), userId, SESSION_IDLE_HOURS],
  );
  return token;
}

export async function destroySession(token: string): Promise<void> {
  await query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}

export function readSessionToken(req: Request): string | null {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  const secure = req.secure || process.env.NODE_ENV === "production";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_IDLE_HOURS * 3600}${secure ? "; Secure" : ""}`,
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

// ---------------------------------------------------------------- middleware
/** Loads the signed-in user (if any). Slides the idle timeout on each request. */
export async function loadAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = readSessionToken(req);
  if (!token) return next();
  const { rows } = await query<{
    session_id: number; acting_firm_id: number | null; id: number; firm_id: number | null; email: string;
    name: string; role: Role | null; is_super_admin: boolean; is_firm_admin: boolean; firm_status: string | null;
  }>(
    `UPDATE sessions s SET last_seen_at = now(), expires_at = now() + make_interval(hours => $2)
       FROM users u LEFT JOIN firms f ON f.id = u.firm_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.id = s.user_id AND u.active
      RETURNING s.id AS session_id, s.acting_firm_id, u.id, u.firm_id, u.email, u.name, u.role,
                u.is_super_admin, u.is_firm_admin, f.status AS firm_status`,
    [hashToken(token), SESSION_IDLE_HOURS],
  );
  const row = rows[0];
  if (row && (row.is_super_admin || row.firm_status === "active")) {
    req.auth = {
      sessionId: row.session_id,
      actingFirmId: row.acting_firm_id,
      user: {
        id: row.id, firmId: row.firm_id, email: row.email, name: row.name,
        role: row.role, isSuperAdmin: row.is_super_admin, isFirmAdmin: row.is_firm_admin && !row.is_super_admin,
      },
    };
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  next();
}

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  if (!req.auth.user.isSuperAdmin) {
    res.status(403).json({ error: "Super admin only" });
    return;
  }
  next();
}

/** Returns the active support grant id for a firm, or null. */
export async function activeGrantId(firmId: number): Promise<number | null> {
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM support_grants WHERE firm_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY expires_at DESC LIMIT 1`,
    [firmId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Sets req.ctx for firm-data routes.
 * Firm users act for their own firm. The super admin acts for a firm only
 * while it holds an active grant, only reads, and every read is logged.
 */
export async function requireFirmContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  if (!auth.user.isSuperAdmin) {
    req.ctx = { actorKind: "firm_user", userId: auth.user.id, firmId: auth.user.firmId };
    return next();
  }
  if (!auth.actingFirmId) {
    res.status(403).json({ error: "Super admin has no firm access. A firm must grant support access first." });
    return;
  }
  const grantId = await activeGrantId(auth.actingFirmId);
  if (!grantId) {
    await query("UPDATE sessions SET acting_firm_id = NULL WHERE id = $1", [auth.sessionId]);
    res.status(403).json({ error: "This firm's support access has expired or was revoked." });
    return;
  }
  if (req.method !== "GET") {
    res.status(403).json({ error: "Support access is read-only." });
    return;
  }
  req.ctx = { actorKind: "super_admin", userId: auth.user.id, firmId: auth.actingFirmId };
  req.grantId = grantId;
  await withContext(req.ctx, (c) =>
    c.query(
      `INSERT INTO support_access_log (firm_id, grant_id, super_admin_user_id, method, path) VALUES ($1, $2, $3, $4, $5)`,
      [auth.actingFirmId, grantId, auth.user.id, req.method, req.originalUrl.split("?")[0]],
    ),
  );
  next();
}

/** Checks a role permission for firm users. The super admin never writes, so it never passes. */
export function requirePermission(permission: Permission) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const auth = req.auth;
    if (!auth || !req.ctx) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    if (auth.user.isSuperAdmin) {
      res.status(403).json({ error: "Support access is read-only." });
      return;
    }
    const allowed = await withContext(req.ctx, async (c) => {
      const { rows } = await c.query<{ allowed: boolean }>(
        `SELECT allowed FROM role_permissions WHERE firm_id = $1 AND role = $2 AND permission = $3`,
        [req.ctx!.firmId, auth.user.role, permission],
      );
      return rows[0]?.allowed === true;
    });
    if (!allowed) {
      res.status(403).json({ error: "Your role does not allow this." });
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------- login throttle
const attempts = new Map<string, { count: number; first: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

export function loginThrottled(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.first > WINDOW_MS) return false;
  return entry.count >= MAX_ATTEMPTS;
}

export function recordLoginFailure(key: string): void {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.first > WINDOW_MS) attempts.set(key, { count: 1, first: now });
  else entry.count += 1;
}

export function clearLoginFailures(key: string): void {
  attempts.delete(key);
}

/**
 * Firm admins manage users, roles and permissions, support access and
 * integrations. The super admin never writes, so it never passes.
 */
export function requireFirmAdmin(req: Request, res: Response, next: NextFunction): void {
  const auth = req.auth;
  if (!auth || !req.ctx) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  if (auth.user.isSuperAdmin) {
    res.status(403).json({ error: "Support access is read-only." });
    return;
  }
  if (!auth.user.isFirmAdmin) {
    res.status(403).json({ error: "Only a firm admin can do that." });
    return;
  }
  next();
}
