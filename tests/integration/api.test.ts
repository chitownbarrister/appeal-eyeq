// Integration tests against a real Postgres and a real running server.
// Requires TEST_DATABASE_URL pointing at a throwaway database whose owner
// is a NON-superuser role (superusers bypass row-level security, which
// would make the isolation tests meaningless).

import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL || "postgres://appeal:appeal@localhost/appeal_test";
process.env.DATABASE_URL = TEST_DB;
process.env.SUPER_ADMIN_EMAIL = "admin@appealeyeq.example";
process.env.SUPER_ADMIN_PASSWORD = "superadmin-pass-1";
process.env.SAMPLE_USER_PASSWORD = "sample-pass-1";

const { getPool, closePool, withContext, query } = await import("../../server/db");
const { runMigrations, ensureSuperAdmin } = await import("../../server/migrate");
const { seedSampleData } = await import("../../server/seed/sample");
const { provisionFirm } = await import("../../server/firms");
const { createApp } = await import("../../server/app");

let server: Server;
let base = "";
let nicholsId = 0;
let otherFirmId = 0;
let dillonId = 0;

const PW = "sample-pass-1";

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
  const cookie = res.headers.get("set-cookie") || "";
  return cookie.split(";")[0];
}

async function api(cookie: string, method: string, url: string, body?: unknown) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { Cookie: cookie, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  const pool = getPool();
  const who = await pool.query<{ rolsuper: boolean }>("SELECT rolsuper FROM pg_roles WHERE rolname = current_user");
  if (who.rows[0].rolsuper) throw new Error("Run integration tests as a non-superuser role, or RLS is bypassed.");
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await runMigrations(() => undefined);
  // Idempotency: re-run every migration file's SQL directly. Must not fail.
  const dir = path.resolve(process.cwd(), "db", "migrations");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), "utf8"));
  }
  await ensureSuperAdmin(() => undefined);
  await seedSampleData(() => undefined);

  nicholsId = (await query<{ id: number }>("SELECT id FROM firms WHERE slug = 'nichols-law'")).rows[0].id;
  dillonId = (await query<{ id: number }>("SELECT id FROM users WHERE email = 'dillon@nicholslaw.example'")).rows[0].id;

  // A second firm with one client and one property, to attack isolation.
  const other = await provisionFirm({
    name: "Other Firm",
    slug: "other-firm",
    firstUser: { name: "Olivia Other", email: "olivia@otherfirm.example", password: PW, role: "attorney" },
  });
  otherFirmId = other.firmId;
  await withContext({ actorKind: "system", userId: null, firmId: otherFirmId }, async (c) => {
    const acct = await c.query<{ id: number }>(`INSERT INTO accounts (firm_id, name) VALUES ($1, 'Other Client') RETURNING id`, [otherFirmId]);
    const cook = (await c.query<{ id: number }>(`SELECT id FROM counties WHERE name = 'Cook'`)).rows[0].id;
    await c.query(
      `INSERT INTO properties (firm_id, account_id, name, county_id) VALUES ($1, $2, '1 Other St', $3)`,
      [otherFirmId, acct.rows[0].id, cook],
    );
  });

  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await closePool();
});

describe("migrations", () => {
  it("re-running the migration runner applies nothing new", async () => {
    const ran = await runMigrations(() => undefined);
    expect(ran).toEqual([]);
  });
});

describe("login and sessions", () => {
  it("rejects a wrong password and sets an HttpOnly cookie on success", async () => {
    const bad = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "dillon@nicholslaw.example", password: "wrong-password" }),
    });
    expect(bad.status).toBe(401);
    const good = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "Dillon@NicholsLaw.example", password: PW }),
    });
    expect(good.status).toBe(200);
    expect(good.headers.get("set-cookie")).toMatch(/aeq_session=.+HttpOnly; SameSite=Lax/);
  });

  it("refuses non-JSON writes", async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "email=dillon@nicholslaw.example&password=x",
    });
    expect(res.status).toBe(415);
  });

  it("returns the user, firm and permissions from /me, and logs out", async () => {
    const cookie = await login("dillon@nicholslaw.example", PW);
    const me = await api(cookie, "GET", "/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ name: "Dillon Nichols", role: "attorney", isSuperAdmin: false });
    expect(me.body.firm).toMatchObject({ name: "Nichols Law", isSample: true });
    expect(me.body.permissions).toHaveLength(11);
    await api(cookie, "POST", "/api/auth/logout", {});
    expect((await api(cookie, "GET", "/api/auth/me")).status).toBe(401);
  });
});

describe("sample data and tax math through the API", () => {
  it("reports the seeded portfolio with savings to the cent", async () => {
    const cookie = await login("dillon@nicholslaw.example", PW);
    const s = await api(cookie, "GET", "/api/firm/summary");
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ accounts: 12, properties: 15, savingsAchieved: "2290.20", savingsInPlay: "274084.32" });
    // Current level per properties.csv: Assessor 2 (820 S. Clinton, 214 S. Third), BOR 11, PTAB 1, Circuit 1.
    expect(s.body.openAppealsByLevel).toEqual({ assessor: 2, bor: 11, ptab: 1, circuit: 1 });
  });
});

describe("tenant isolation", () => {
  it("a second firm sees only its own data", async () => {
    const olivia = await login("olivia@otherfirm.example", PW);
    const s = await api(olivia, "GET", "/api/firm/summary");
    expect(s.body).toMatchObject({ accounts: 1, properties: 1, appeals: 0, savingsAchieved: "0.00" });
    const users = await api(olivia, "GET", "/api/firm/users");
    expect(users.body.users.map((u: { email: string }) => u.email)).toEqual(["olivia@otherfirm.example"]);
  });

  it("refuses to touch another firm's users or grants by id", async () => {
    const olivia = await login("olivia@otherfirm.example", PW);
    expect((await api(olivia, "PATCH", `/api/firm/users/${dillonId}`, { active: false })).status).toBe(404);
    const stillActive = await query<{ active: boolean }>("SELECT active FROM users WHERE id = $1", [dillonId]);
    expect(stillActive.rows[0].active).toBe(true);

    const dillon = await login("dillon@nicholslaw.example", PW);
    const g = await api(dillon, "POST", "/api/firm/support-grants", { hours: 1, reason: "isolation test" });
    expect((await api(olivia, "POST", `/api/firm/support-grants/${g.body.grant.id}/revoke`, {})).status).toBe(404);
    await api(dillon, "POST", `/api/firm/support-grants/${g.body.grant.id}/revoke`, {});
  });

  it("the database lock returns nothing when a firm user's context names another firm", async () => {
    const oliviaId = (await query<{ id: number }>("SELECT id FROM users WHERE email = 'olivia@otherfirm.example'")).rows[0].id;
    const rows = await withContext({ actorKind: "firm_user", userId: oliviaId, firmId: nicholsId }, async (c) =>
      (await c.query("SELECT count(*)::int AS n FROM properties")).rows[0].n,
    );
    expect(rows).toBe(0);
  });

  it("the database lock rejects writing a row into another firm", async () => {
    const oliviaId = (await query<{ id: number }>("SELECT id FROM users WHERE email = 'olivia@otherfirm.example'")).rows[0].id;
    await expect(
      withContext({ actorKind: "firm_user", userId: oliviaId, firmId: otherFirmId }, (c) =>
        c.query(`INSERT INTO accounts (firm_id, name) VALUES ($1, 'Smuggled')`, [nicholsId]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("a property can't point at another firm's client, even under a system context", async () => {
    const nicholsAccount = await withContext({ actorKind: "system", userId: null, firmId: nicholsId }, async (c) =>
      (await c.query<{ id: number }>("SELECT id FROM accounts LIMIT 1")).rows[0].id,
    );
    await expect(
      withContext({ actorKind: "system", userId: null, firmId: otherFirmId }, (c) =>
        c.query(`INSERT INTO properties (firm_id, account_id, name, county_id) VALUES ($1, $2, 'x', 1)`, [otherFirmId, nicholsAccount]),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("with no context at all, firm tables are empty", async () => {
    const n = await query<{ n: number }>("SELECT count(*)::int AS n FROM appeals");
    expect(n.rows[0].n).toBe(0);
  });

  it("firm users can't reach super admin routes", async () => {
    const dillon = await login("dillon@nicholslaw.example", PW);
    expect((await api(dillon, "GET", "/api/admin/firms")).status).toBe(403);
  });
});

describe("super admin and support grants", () => {
  it("is locked out of firm data until the firm grants access, then reads are logged, writes refused, and revocation is immediate", async () => {
    const admin = await login("admin@appealeyeq.example", "superadmin-pass-1");
    const dillon = await login("dillon@nicholslaw.example", PW);

    expect((await api(admin, "GET", "/api/firm/summary")).status).toBe(403);
    expect((await api(admin, "POST", `/api/admin/firms/${nicholsId}/enter`, {})).status).toBe(403);

    // The database agrees: a super admin context without a grant sees nothing.
    const adminId = (await query<{ id: number }>("SELECT id FROM users WHERE is_super_admin")).rows[0].id;
    const before = await withContext({ actorKind: "super_admin", userId: adminId, firmId: nicholsId }, async (c) =>
      (await c.query("SELECT count(*)::int AS n FROM properties")).rows[0].n,
    );
    expect(before).toBe(0);

    const grant = await api(dillon, "POST", "/api/firm/support-grants", { hours: 2, reason: "Help with setup" });
    expect(grant.status).toBe(201);

    expect((await api(admin, "POST", `/api/admin/firms/${nicholsId}/enter`, {})).status).toBe(200);
    const me = await api(admin, "GET", "/api/auth/me");
    expect(me.body.acting).toMatchObject({ firmId: nicholsId, firmName: "Nichols Law" });
    const summary = await api(admin, "GET", "/api/firm/summary");
    expect(summary.status).toBe(200);
    expect(summary.body.properties).toBe(15);

    // Read-only.
    const write = await api(admin, "PUT", "/api/firm/fee-defaults", { level: "bor", percent: "10" });
    expect(write.status).toBe(403);

    // Entering a firm does not open any other firm.
    const otherAttempt = await api(admin, "POST", `/api/admin/firms/${otherFirmId}/enter`, {});
    expect(otherAttempt.status).toBe(403);

    // The firm sees the access in its log.
    const log = await api(dillon, "GET", "/api/firm/support-access-log");
    expect(log.body.entries.some((e: { path: string }) => e.path === "/api/firm/summary")).toBe(true);

    // Revoke: the very next request is refused.
    await api(dillon, "POST", `/api/firm/support-grants/${grant.body.grant.id}/revoke`, {});
    expect((await api(admin, "GET", "/api/firm/summary")).status).toBe(403);
    expect((await api(admin, "GET", "/api/auth/me")).body.acting).toBeNull();
  });

  it("creates a firm with default fees and a working first login", async () => {
    const admin = await login("admin@appealeyeq.example", "superadmin-pass-1");
    const created = await api(admin, "POST", "/api/admin/firms", {
      name: "Prairie Tax Law", slug: "prairie-tax-law",
      attorneyName: "Pat Prairie", attorneyEmail: "pat@prairietax.example", attorneyPassword: "prairie-pass-1",
    });
    expect(created.status).toBe(201);
    const dupe = await api(admin, "POST", "/api/admin/firms", {
      name: "Prairie Again", slug: "prairie-tax-law",
      attorneyName: "X", attorneyEmail: "x@example.com", attorneyPassword: "prairie-pass-1",
    });
    expect(dupe.status).toBe(409);

    const pat = await login("pat@prairietax.example", "prairie-pass-1");
    const fees = await api(pat, "GET", "/api/firm/fee-defaults");
    expect(fees.body.feeDefaults).toEqual([
      { level: "assessor", percent: "40.00", basis: "first_year_savings" },
      { level: "bor", percent: "40.00", basis: "first_year_savings" },
      { level: "ptab", percent: "33.33", basis: "refund" },
      { level: "circuit", percent: "33.33", basis: "refund" },
    ]);
    const firms = await api(admin, "GET", "/api/admin/firms");
    expect(firms.body.firms.map((f: { slug: string }) => f.slug)).toContain("prairie-tax-law");
  });
});

describe("roles, permissions and audit", () => {
  it("a permission switched off for Analyst blocks analysts and is restorable", async () => {
    const dillon = await login("dillon@nicholslaw.example", PW);
    const julie = await login("julie@nicholslaw.example", PW);
    const newUser = { name: "Temp Person", email: "temp@nicholslaw.example", role: "analyst", password: "temp-pass-123" };

    expect((await api(dillon, "PUT", "/api/firm/permissions", { role: "analyst", permission: "users.manage", allowed: false })).status).toBe(200);
    expect((await api(julie, "POST", "/api/firm/users", newUser)).status).toBe(403);
    expect((await api(dillon, "PUT", "/api/firm/permissions", { role: "analyst", permission: "users.manage", allowed: true })).status).toBe(200);
    expect((await api(julie, "POST", "/api/firm/users", newUser)).status).toBe(201);
  });

  it("deactivating a user ends their session", async () => {
    const dillon = await login("dillon@nicholslaw.example", PW);
    const temp = await login("temp@nicholslaw.example", "temp-pass-123");
    const id = (await query<{ id: number }>("SELECT id FROM users WHERE email = 'temp@nicholslaw.example'")).rows[0].id;
    expect((await api(dillon, "PATCH", `/api/firm/users/${id}`, { active: false })).status).toBe(200);
    expect((await api(temp, "GET", "/api/auth/me")).status).toBe(401);
  });

  it("records who changed a fee default, with before and after", async () => {
    const dillon = await login("dillon@nicholslaw.example", PW);
    expect((await api(dillon, "PUT", "/api/firm/fee-defaults", { level: "ptab", percent: "35" })).status).toBe(200);
    const fees = await api(dillon, "GET", "/api/firm/fee-defaults");
    expect(fees.body.feeDefaults.find((f: { level: string }) => f.level === "ptab").percent).toBe("35.00");
    const log = await api(dillon, "GET", "/api/firm/audit-log?limit=20");
    const entry = log.body.entries.find((e: { table_name: string; action: string }) => e.table_name === "fee_defaults" && e.action === "UPDATE");
    expect(entry).toMatchObject({ actor_name: "Dillon Nichols", actor_kind: "firm_user" });
    await api(dillon, "PUT", "/api/firm/fee-defaults", { level: "ptab", percent: "33.33" });
  });

  it("rejects a bad fee percent", async () => {
    const dillon = await login("dillon@nicholslaw.example", PW);
    expect((await api(dillon, "PUT", "/api/firm/fee-defaults", { level: "bor", percent: "140" })).status).toBe(400);
    expect((await api(dillon, "PUT", "/api/firm/fee-defaults", { level: "bor", percent: "40.555" })).status).toBe(400);
  });
});

describe("reference data", () => {
  it("serves windows, equalizers and rates to any signed-in user", async () => {
    const olivia = await login("olivia@otherfirm.example", PW);
    const w = await api(olivia, "GET", "/api/reference/windows?year=2026");
    expect(w.body.windows.length).toBe(14);
    const r = await api(olivia, "GET", "/api/reference/tax-rates?taxCode=23008");
    expect(r.body.taxRates.map((x: { tax_year: number; rate_percent: string }) => [x.tax_year, x.rate_percent])).toEqual([
      [2024, "7.943607"],
      [2023, "7.686000"],
    ]);
    const c = await api(olivia, "GET", "/api/reference/counties");
    expect(c.body.counties).toHaveLength(6);
    expect(c.body.townships.filter((t: { triad: string | null }) => t.triad).length).toBe(38);
  });

  it("requires sign-in", async () => {
    const res = await fetch(`${base}/api/reference/windows`);
    expect(res.status).toBe(401);
  });
});
