// Shared setup for integration tests: a wiped test database with all
// migrations, the super admin, the Nichols Law sample, and a second firm
// ("Other Firm") with one client and property to attack isolation.

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

export const PW = "sample-pass-1";
export const ADMIN = { email: "admin@appealeyeq.example", password: "superadmin-pass-1" };

export function configureEnv(): void {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://appeal:appeal@localhost/appeal_test";
  process.env.SUPER_ADMIN_EMAIL = ADMIN.email;
  process.env.SUPER_ADMIN_PASSWORD = ADMIN.password;
  process.env.SAMPLE_USER_PASSWORD = PW;
  process.env.APP_TODAY = "2026-10-19"; // the sample windows and deadlines are dated around this day
}

export interface TestEnv {
  base: string;
  server: Server;
  nicholsId: number;
  otherFirmId: number;
  otherPropertyId: number;
  otherAccountId: number;
}

export async function startTestEnv(): Promise<TestEnv> {
  configureEnv();
  const { getPool, withContext, query } = await import("../../server/db");
  const { runMigrations, ensureSuperAdmin } = await import("../../server/migrate");
  const { seedSampleData } = await import("../../server/seed/sample");
  const { provisionFirm } = await import("../../server/firms");
  const { createApp } = await import("../../server/app");

  const pool = getPool();
  const who = await pool.query<{ rolsuper: boolean }>("SELECT rolsuper FROM pg_roles WHERE rolname = current_user");
  if (who.rows[0].rolsuper) throw new Error("Run integration tests as a non-superuser role, or RLS is bypassed.");
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await runMigrations(() => undefined);
  await ensureSuperAdmin(() => undefined);
  await seedSampleData(() => undefined);
  const nicholsId = (await query<{ id: number }>("SELECT id FROM firms WHERE slug = 'nichols-law'")).rows[0].id;

  const other = await provisionFirm({
    name: "Other Firm", slug: "other-firm",
    firstUser: { name: "Olivia Other", email: "olivia@otherfirm.example", password: PW, role: "attorney" },
  });
  const ids = await withContext({ actorKind: "system", userId: null, firmId: other.firmId }, async (c) => {
    const acct = await c.query<{ id: number }>(`INSERT INTO accounts (firm_id, name) VALUES ($1, 'Other Client') RETURNING id`, [other.firmId]);
    const cook = (await c.query<{ id: number }>(`SELECT id FROM counties WHERE name = 'Cook'`)).rows[0].id;
    const prop = await c.query<{ id: number }>(
      `INSERT INTO properties (firm_id, account_id, name, address1, city, county_id) VALUES ($1, $2, '1 Other St', '1 Other St', 'Chicago', $3) RETURNING id`,
      [other.firmId, acct.rows[0].id, cook],
    );
    await c.query(`INSERT INTO parcels (firm_id, property_id, pin, is_primary) VALUES ($1, $2, '99-99-999-999-0000', true)`, [other.firmId, prop.rows[0].id]);
    return { accountId: acct.rows[0].id, propertyId: prop.rows[0].id };
  });

  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, server, nicholsId, otherFirmId: other.firmId, otherPropertyId: ids.propertyId, otherAccountId: ids.accountId };
}

export async function stopTestEnv(env: TestEnv): Promise<void> {
  const { closePool } = await import("../../server/db");
  await new Promise((r) => env.server.close(r));
  await closePool();
}

export async function login(base: string, email: string, password = PW): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}

export async function call(base: string, cookie: string, method: string, url: string, body?: unknown) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { Cookie: cookie, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any };
}
