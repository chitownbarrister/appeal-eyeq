// Small pieces shared by the Dropbox connection routes and the property file routes.

import type { Request, Response, NextFunction } from "express";
import { withContext } from "../db.js";
import { friendlyDropboxError } from "../dropbox/folders.js";
import type { Permission } from "../../shared/domain.js";

/** Client documents are never shown under support access, even while a firm has granted it. */
export function noSupportAccess(req: Request, res: Response, next: NextFunction): void {
  if (req.auth?.user.isSuperAdmin) {
    res.status(403).json({ error: "Client files aren't available under support access." });
    return;
  }
  next();
}

export function idParam(req: Request): number | null {
  const n = Number(req.params.id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** An error the app's error handler turns into {status, error}. */
export function httpError(status: number, publicMessage: string, extra?: Record<string, unknown>): Error {
  return Object.assign(new Error(publicMessage), { status, publicMessage, ...(extra ? { extra } : {}) });
}

/** Turns a Dropbox failure into a plain message for the user. */
export async function dropboxCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const friendly = friendlyDropboxError(err);
    if (friendly) throw Object.assign(new Error("dropbox"), friendly);
    throw err;
  }
}

/** Whether the signed-in firm user's role has a permission (the super admin never does). */
export async function hasPermission(req: Request, permission: Permission): Promise<boolean> {
  const auth = req.auth;
  if (!auth || !req.ctx || auth.user.isSuperAdmin) return false;
  return withContext(req.ctx, async (c) => {
    const { rows } = await c.query<{ allowed: boolean }>(
      `SELECT allowed FROM role_permissions WHERE firm_id = $1 AND role = $2 AND permission = $3`,
      [req.ctx!.firmId, auth.user.role, permission],
    );
    return rows[0]?.allowed === true;
  });
}
