// Changing your own password: the current one is required and throttled, other sessions end,
// the firm's audit log records it without password material, and nobody can change someone else's.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, PW, call, login, startTestEnv, stopTestEnv, type TestEnv } from "./helpers";

let env: TestEnv;
const NEW = "marcus-new-pass-2";

beforeAll(async () => { env = await startTestEnv(); });
afterAll(async () => { await stopTestEnv(env); });

describe("change password", () => {
  it("requires the right current password", async () => {
    const marcus = await login(env.base, "marcus@nicholslaw.example");
    const r = await call(env.base, marcus, "POST", "/api/auth/password", { current: "wrong-password", next: NEW });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Your current password isn't right.");
  });

  it("refuses a short or unchanged new password", async () => {
    const marcus = await login(env.base, "marcus@nicholslaw.example");
    expect((await call(env.base, marcus, "POST", "/api/auth/password", { current: PW, next: "short" })).body.error).toMatch(/at least 10 characters/);
    expect((await call(env.base, marcus, "POST", "/api/auth/password", { current: PW, next: PW })).body.error).toMatch(/same as the current one/);
    expect((await call(env.base, marcus, "POST", "/api/auth/password", { next: NEW })).status).toBe(400);
  });

  it("is only for someone signed in", async () => {
    const r = await call(env.base, "", "POST", "/api/auth/password", { current: PW, next: NEW });
    expect(r.status).toBe(401);
  });

  it("changes it, keeps this session, ends the others, and logs it without the password", async () => {
    const here = await login(env.base, "marcus@nicholslaw.example");
    const elsewhere = await login(env.base, "marcus@nicholslaw.example");
    const julie = await login(env.base, "julie@nicholslaw.example");
    const r = await call(env.base, here, "POST", "/api/auth/password", { current: PW, next: NEW });
    expect(r.status).toBe(200);

    expect((await call(env.base, here, "GET", "/api/auth/me")).status).toBe(200);
    expect((await call(env.base, elsewhere, "GET", "/api/auth/me")).status).toBe(401);
    expect((await call(env.base, julie, "GET", "/api/auth/me")).status).toBe(200); // other people stay signed in

    await expect(login(env.base, "marcus@nicholslaw.example", PW)).rejects.toThrow();
    const fresh = await login(env.base, "marcus@nicholslaw.example", NEW);

    const { query } = await import("../../server/db");
    const marcusId = (await query<{ id: number }>(`SELECT id FROM users WHERE email = 'marcus@nicholslaw.example'`)).rows[0].id;
    const { withContext } = await import("../../server/db");
    const rows = await withContext({ actorKind: "system", userId: null, firmId: env.nicholsId }, async (c) =>
      (await c.query<{ actor_user_id: number; row_id: string; after: unknown; before: unknown }>(
        `SELECT actor_user_id, row_id, before, after FROM audit_log WHERE firm_id = $1 AND table_name = 'users' ORDER BY id DESC LIMIT 1`, [env.nicholsId],
      )).rows,
    );
    expect(rows[0]).toMatchObject({ actor_user_id: marcusId, row_id: String(marcusId), before: null, after: { password: "changed" } });
    expect(JSON.stringify(rows)).not.toContain(NEW);

    // Put it back for any later test.
    expect((await call(env.base, fresh, "POST", "/api/auth/password", { current: NEW, next: PW })).status).toBe(200);
  });

  it("changes only the caller's own password, whatever the body says", async () => {
    const julie = await login(env.base, "julie@nicholslaw.example");
    const r = await call(env.base, julie, "POST", "/api/auth/password", { current: PW, next: "julie-new-pass-9", userId: 1, email: "dillon@nicholslaw.example" });
    expect(r.status).toBe(200);
    expect(await login(env.base, "dillon@nicholslaw.example", PW)).toBeTruthy();
    await login(env.base, "julie@nicholslaw.example", "julie-new-pass-9");
    const back = await login(env.base, "julie@nicholslaw.example", "julie-new-pass-9");
    expect((await call(env.base, back, "POST", "/api/auth/password", { current: "julie-new-pass-9", next: PW })).status).toBe(200);
  });

  it("works for the super admin, with no firm audit row", async () => {
    const admin = await login(env.base, ADMIN.email, ADMIN.password);
    expect((await call(env.base, admin, "POST", "/api/auth/password", { current: ADMIN.password, next: "superadmin-pass-2" })).status).toBe(200);
    const again = await login(env.base, ADMIN.email, "superadmin-pass-2");
    expect((await call(env.base, again, "POST", "/api/auth/password", { current: "superadmin-pass-2", next: ADMIN.password })).status).toBe(200);
  });

  it("locks out guessing after repeated wrong current passwords", async () => {
    const sana = await login(env.base, "sana@nicholslaw.example");
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call(env.base, sana, "POST", "/api/auth/password", { current: `guess-${i}`, next: NEW })).status;
    expect(last).toBe(429);
    expect((await call(env.base, sana, "POST", "/api/auth/password", { current: PW, next: NEW })).status).toBe(429);
  });
});
