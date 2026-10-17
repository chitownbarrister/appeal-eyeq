import type pg from "pg";
import { getPool, withContext } from "./db.js";
import { hashPassword } from "./auth.js";
import { DEFAULT_FEES, PERMISSIONS, ROLES, type Role } from "../shared/domain.js";

export interface NewFirmInput {
  name: string;
  slug: string;
  isSample?: boolean;
  firstUser: { name: string; email: string; password: string; role: Role };
}

/**
 * Creates a firm with its defaults (role permissions, fee terms) and its
 * first user, in one transaction. Firm defaults are written under a
 * 'system' context for that firm, so row-level security still applies.
 */
export async function provisionFirm(input: NewFirmInput): Promise<{ firmId: number; userId: number }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const firm = await client.query<{ id: number }>(
      `INSERT INTO firms (name, slug, is_sample) VALUES ($1, $2, $3) RETURNING id`,
      [input.name, input.slug, input.isSample ?? false],
    );
    const firmId = firm.rows[0].id;
    const user = await client.query<{ id: number }>(
      `INSERT INTO users (firm_id, email, name, password_hash, role) VALUES ($1, lower($2), $3, $4, $5) RETURNING id`,
      [firmId, input.firstUser.email, input.firstUser.name, hashPassword(input.firstUser.password), input.firstUser.role],
    );
    await client.query(
      `SELECT set_config('app.actor_kind', 'system', true), set_config('app.user_id', '', true), set_config('app.firm_id', $1, true)`,
      [String(firmId)],
    );
    await writeFirmDefaults(client, firmId);
    await client.query("COMMIT");
    return { firmId, userId: user.rows[0].id };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function writeFirmDefaults(client: pg.PoolClient, firmId: number): Promise<void> {
  for (const role of ROLES) {
    for (const permission of PERMISSIONS) {
      await client.query(
        `INSERT INTO role_permissions (firm_id, role, permission, allowed) VALUES ($1, $2, $3, true)
         ON CONFLICT (firm_id, role, permission) DO NOTHING`,
        [firmId, role, permission],
      );
    }
  }
  for (const fee of DEFAULT_FEES) {
    await client.query(
      `INSERT INTO fee_defaults (firm_id, level, percent, basis) VALUES ($1, $2, $3, $4)
       ON CONFLICT (firm_id, level) DO NOTHING`,
      [firmId, fee.level, fee.percent, fee.basis],
    );
  }
}

/** Used by the sample seed to add more users to an existing firm. */
export async function addFirmUser(firmId: number, u: { name: string; email: string; password: string; role: Role }): Promise<number> {
  return withContext({ actorKind: "system", userId: null, firmId }, async (c) => {
    const { rows } = await c.query<{ id: number }>(
      `INSERT INTO users (firm_id, email, name, password_hash, role) VALUES ($1, lower($2), $3, $4, $5) RETURNING id`,
      [firmId, u.email, u.name, hashPassword(u.password), u.role],
    );
    return rows[0].id;
  });
}
