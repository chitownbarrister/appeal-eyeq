import pg from "pg";

const { Pool, types } = pg;

// Keep DATE columns as "YYYY-MM-DD" strings (no timezone shifting).
// NUMERIC already comes back as a string, which the money helpers expect.
types.setTypeParser(1082, (v: string) => v);

export type ActorKind = "firm_user" | "super_admin" | "system";

export interface DbContext {
  actorKind: ActorKind;
  userId: number | null;
  firmId: number | null;
}

function sslFor(url: string): pg.PoolConfig["ssl"] {
  // Render's internal URL needs no TLS; its external URL (*.render.com) does.
  if (process.env.PGSSL === "true" || /\.render\.com/.test(url)) return { rejectUnauthorized: false };
  return undefined;
}

let poolInstance: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!poolInstance) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    poolInstance = new Pool({ connectionString: url, ssl: sslFor(url), max: 10 });
  }
  return poolInstance;
}

export async function closePool(): Promise<void> {
  if (poolInstance) {
    await poolInstance.end();
    poolInstance = null;
  }
}

/**
 * Run work inside one transaction with the tenant-lock settings applied.
 * Row-level security reads these settings, so every query in `fn` can only
 * see the firm the context allows (see db/migrations/001_foundation.sql).
 */
export async function withContext<T>(ctx: DbContext, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('app.actor_kind', $1, true),
              set_config('app.user_id', $2, true),
              set_config('app.firm_id', $3, true)`,
      [ctx.actorKind, ctx.userId === null ? "" : String(ctx.userId), ctx.firmId === null ? "" : String(ctx.firmId)],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** For identity tables that sit outside the tenant lock (users, sessions, firms). */
export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<R>> {
  return getPool().query<R>(text, params);
}
