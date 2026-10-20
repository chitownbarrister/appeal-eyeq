// Delivery 5: firm admins and the Operations role, one matter per PIN, and
// Dropbox (connect, team-plan check, folders from the template, upload,
// download, rename, token refresh, revocation, disconnect), against a real
// server and Postgres and a stand-in Dropbox, with cross-firm attacks.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, call, login, startTestEnv, stopTestEnv, type TestEnv } from "./helpers";
import { startFakeDropbox, FAKE_APP_KEY, FAKE_APP_SECRET, type FakeDropbox } from "../fake-dropbox/server";

let env: TestEnv;
let fake: FakeDropbox;
let dillon = "";
let julie = "";
let olivia = "";
let towerId = 0;
const EXPECTED_TOWER = "/Appeal EyeQ/Nichols, Dillon/05-17-302-010 – 1044 Tower Road, Winnetka (New Trier)";

function setDropboxEnv(on: boolean) {
  const vars: Record<string, string> = {
    DROPBOX_APP_KEY: FAKE_APP_KEY, DROPBOX_APP_SECRET: FAKE_APP_SECRET, TOKEN_ENCRYPTION_KEY: "test-encryption-key-that-is-long-enough-123",
    DROPBOX_API_URL: fake.url, DROPBOX_CONTENT_URL: fake.url, DROPBOX_AUTHORIZE_URL: `${fake.url}/oauth2/authorize`, DROPBOX_WEB_URL: "https://www.dropbox.test",
  };
  for (const [k, v] of Object.entries(vars)) { if (on) process.env[k] = v; else delete process.env[k]; }
}

/** Runs the whole sign-in: Connect, Dropbox's approval (the stand-in approves at once), then the callback. */
async function connect(cookie: string): Promise<string> {
  const start = await fetch(`${env.base}/api/firm/integrations/dropbox/connect`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
  if (start.status !== 200) throw new Error(`connect: ${start.status} ${await start.text()}`);
  const stateCookie = (start.headers.get("set-cookie") || "").split(";")[0];
  const { url } = (await start.json()) as { url: string };
  const approve = await fetch(url, { redirect: "manual" });
  const callback = approve.headers.get("location")!;
  const done = await fetch(callback, { redirect: "manual", headers: { Cookie: `${cookie}; ${stateCookie}` } });
  return done.headers.get("location") || `status ${done.status}`;
}

async function upload(cookie: string, pid: number, rel: string, name: string, body: string | Buffer, type = "application/octet-stream") {
  const res = await fetch(`${env.base}/api/firm/properties/${pid}/files/upload?${new URLSearchParams({ path: rel, name })}`, {
    method: "POST", headers: { Cookie: cookie, "Content-Type": type }, body,
  });
  return { status: res.status, body: await res.json() };
}

async function auditRows(table: string) {
  const { withContext } = await import("../../server/db");
  return withContext({ actorKind: "system", userId: null, firmId: env.nicholsId }, async (c) =>
    (await c.query<{ action: string; actor_user_id: number | null; before: unknown; after: unknown }>(
      `SELECT action, actor_user_id, before, after FROM audit_log WHERE firm_id = $1 AND table_name = $2 ORDER BY id DESC`, [env.nicholsId, table],
    )).rows,
  );
}

const tree = async () => (await (await fetch(`${fake.url}/__test/tree`)).json()) as Record<string, string[]>;

beforeAll(async () => {
  env = await startTestEnv();
  fake = await startFakeDropbox();
  setDropboxEnv(true);
  dillon = await login(env.base, "dillon@nicholslaw.example");
  julie = await login(env.base, "julie@nicholslaw.example");
  olivia = await login(env.base, "olivia@otherfirm.example");
  const list = await call(env.base, dillon, "GET", "/api/firm/properties");
  towerId = list.body.properties.find((p: { address1: string }) => p.address1 === "1044 Tower Road").id;
});

afterAll(async () => {
  setDropboxEnv(false);
  await fake.close();
  await stopTestEnv(env);
});

describe("firm admins and the Operations role", () => {
  it("makes each firm's first attorney its firm admin and reports it", async () => {
    expect((await call(env.base, dillon, "GET", "/api/auth/me")).body.user.isFirmAdmin).toBe(true);
    expect((await call(env.base, julie, "GET", "/api/auth/me")).body.user.isFirmAdmin).toBe(false);
    expect((await call(env.base, olivia, "GET", "/api/auth/me")).body.user.isFirmAdmin).toBe(true);
  });

  it("lets only firm admins manage users, permissions and support access", async () => {
    const add = { name: "Ops Person", email: "ops@nicholslaw.example", role: "operations", password: "ops-pass-12345" };
    const denied = await call(env.base, julie, "POST", "/api/firm/users", add);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("Only a firm admin can do that.");
    expect((await call(env.base, julie, "PUT", "/api/firm/permissions", { role: "analyst", permission: "fees.edit", allowed: false })).status).toBe(403);
    expect((await call(env.base, julie, "POST", "/api/firm/support-grants", { hours: 1 })).status).toBe(403);
    const ok = await call(env.base, dillon, "POST", "/api/firm/users", add);
    expect(ok.status).toBe(201);
    expect(ok.body.user).toMatchObject({ role: "operations", is_firm_admin: false });
  });

  it("can make a non-attorney a firm admin, and never leaves a firm without one", async () => {
    const users = (await call(env.base, dillon, "GET", "/api/firm/users")).body.users;
    const ops = users.find((u: { email: string }) => u.email === "ops@nicholslaw.example");
    const me = users.find((u: { email: string }) => u.email === "dillon@nicholslaw.example");
    const lone = await call(env.base, dillon, "PATCH", `/api/firm/users/${me.id}`, { isFirmAdmin: false });
    expect(lone.status).toBe(400);
    expect(lone.body.error).toMatch(/at least one active firm admin/);
    expect((await call(env.base, dillon, "PATCH", `/api/firm/users/${ops.id}`, { isFirmAdmin: true })).body.user.is_firm_admin).toBe(true);
    const opsCookie = await login(env.base, "ops@nicholslaw.example", "ops-pass-12345");
    expect((await call(env.base, opsCookie, "GET", "/api/auth/me")).body.user).toMatchObject({ role: "operations", isFirmAdmin: true });
    // Now Dillon can step down, and the operations admin can put him back.
    expect((await call(env.base, dillon, "PATCH", `/api/firm/users/${me.id}`, { isFirmAdmin: false })).status).toBe(200);
    expect((await call(env.base, opsCookie, "PATCH", `/api/firm/users/${me.id}`, { isFirmAdmin: true })).status).toBe(200);
    dillon = await login(env.base, "dillon@nicholslaw.example"); // fresh session picks up the flag
    const log = await auditRows("users");
    expect(log.some((e) => (e.after as { is_firm_admin?: boolean } | null)?.is_firm_admin === true && e.actor_user_id !== null)).toBe(true);
  });

  it("gives Operations its own column of permissions and retires the admin ones", async () => {
    const perms = (await call(env.base, dillon, "GET", "/api/firm/permissions")).body.permissions as { role: string; permission: string }[];
    expect(new Set(perms.map((p) => p.role))).toEqual(new Set(["attorney", "analyst", "operations"]));
    expect(perms.filter((p) => p.role === "operations")).toHaveLength(10);
    expect(perms.some((p) => ["users.manage", "support.grant", "settings.edit"].includes(p.permission))).toBe(false);
  });
});

describe("one matter per PIN", () => {
  it("refuses a property whose PIN another matter already has, in any format, and names that matter", async () => {
    const accounts = (await call(env.base, dillon, "GET", "/api/firm/accounts")).body.accounts;
    const geo = (await call(env.base, dillon, "GET", "/api/reference/counties")).body;
    const cook = geo.counties.find((c: { name: string }) => c.name === "Cook").id;
    const body = { accountId: accounts[0].id, address1: "1044 Tower Rd", city: "Winnetka", countyId: cook, assetType: "residential", pin: "05-17-302-010" };
    const r = await call(env.base, dillon, "POST", "/api/firm/properties", body);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("PIN 05-17-302-010-0000 is already the matter 05-17-302-010 – 1044 Tower Road, Winnetka (New Trier). Open that property instead of adding it again.");
    expect(r.body.existingPropertyId).toBe(towerId);
    expect((await call(env.base, dillon, "POST", "/api/firm/properties", { ...body, pin: "05 17 302 010 0000" })).status).toBe(409);
    expect((await call(env.base, dillon, "POST", `/api/firm/properties/${towerId}/parcels`, { pin: "0517302010" })).status).toBe(409);
  });

  it("lets another firm hold the same PIN, without revealing anything about it", async () => {
    const geo = (await call(env.base, olivia, "GET", "/api/reference/counties")).body;
    const cook = geo.counties.find((c: { name: string }) => c.name === "Cook").id;
    const r = await call(env.base, olivia, "POST", "/api/firm/properties", { accountId: env.otherAccountId, address1: "1044 Tower Road", city: "Winnetka", countyId: cook, assetType: "residential", pin: "05-17-302-010-0000" });
    expect(r.status).toBe(201);
  });

  it("is enforced by the database too", async () => {
    const { withContext } = await import("../../server/db");
    const err = await withContext({ actorKind: "system", userId: null, firmId: env.nicholsId }, (c) =>
      c.query(`INSERT INTO parcels (firm_id, property_id, pin) VALUES ($1, $2, '05-17-302-010')`, [env.nicholsId, towerId]),
    ).then(() => null, (e) => e);
    expect((err as { code?: string }).code).toBe("23505");
  });
});

describe("connecting Dropbox", () => {
  it("says when the server isn't set up for Dropbox", async () => {
    setDropboxEnv(false);
    expect((await call(env.base, dillon, "GET", "/api/firm/integrations")).body.dropbox).toMatchObject({ configured: false, connected: false });
    const r = await call(env.base, dillon, "POST", "/api/firm/integrations/dropbox/connect", {});
    expect(r.status).toBe(503);
    setDropboxEnv(true);
  });

  it("is for firm admins only", async () => {
    expect((await call(env.base, julie, "POST", "/api/firm/integrations/dropbox/connect", {})).status).toBe(403);
  });

  it("turns away a personal Dropbox account for a real firm, and revokes what it was given", async () => {
    await fetch(`${fake.url}/__test/next-account`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "basic" }) });
    const where = await connect(olivia);
    expect(where).toMatch(/^\/settings\?tab=integrations&dropbox=error&reason=That%27s\+a\+personal\+Dropbox\+account/);
    expect((await call(env.base, olivia, "GET", "/api/firm/integrations")).body.dropbox.connected).toBe(false);
    expect(fake.state.refresh.size).toBe(0);
  });

  it("rejects a callback that doesn't carry the sign-in it started", async () => {
    const r = await fetch(`${env.base}/api/firm/dropbox/callback?code=x&state=forged`, { redirect: "manual", headers: { Cookie: dillon } });
    expect(r.headers.get("location")).toMatch(/dropbox=error/);
  });

  it("says what Dropbox objected to when the sign-in fails, such as a wrong app secret", async () => {
    process.env.DROPBOX_APP_SECRET = "mistyped-secret";
    try {
      const where = decodeURIComponent((await connect(dillon)).replace(/\+/g, " "));
      expect(where).toContain("Dropbox didn't complete the sign-in (token exchange: invalid_client");
      expect(where).toContain("check the Dropbox app key and secret");
      expect(where).not.toContain("mistyped-secret");
      expect((await call(env.base, dillon, "GET", "/api/firm/integrations")).body.dropbox.connected).toBe(false);
    } finally {
      process.env.DROPBOX_APP_SECRET = FAKE_APP_SECRET;
    }
  });

  it("uses Dropbox's standard code flow: no PKCE challenge, the secret stays on the server", async () => {
    const start = await fetch(`${env.base}/api/firm/integrations/dropbox/connect`, { method: "POST", headers: { Cookie: dillon, "Content-Type": "application/json" }, body: "{}" });
    const url = new URL(((await start.json()) as { url: string }).url);
    expect(url.searchParams.get("code_challenge")).toBeNull();
    expect(url.searchParams.get("client_secret")).toBeNull();
    expect(url.searchParams.get("token_access_type")).toBe("offline");
    expect(url.searchParams.get("redirect_uri")).toMatch(/\/api\/firm\/dropbox\/callback$/);
  });

  it("connects a team account for Nichols Law and stores only encrypted tokens", async () => {
    await fetch(`${fake.url}/__test/next-account`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "business" }) });
    expect(await connect(dillon)).toBe("/settings?tab=integrations&dropbox=connected");
    const st = (await call(env.base, julie, "GET", "/api/firm/integrations")).body.dropbox;
    expect(st).toMatchObject({ connected: true, accountType: "business", teamName: "Test Firm Team", usesTeamSpace: true, rootFolder: "/Appeal EyeQ", connectedBy: "Dillon Nichols" });
    const raw = await (await import("../../server/db")).withContext({ actorKind: "system", userId: null, firmId: env.nicholsId }, async (c) =>
      (await c.query(`SELECT refresh_token_enc, access_token_enc FROM firm_integrations WHERE firm_id = $1`, [env.nicholsId])).rows[0],
    );
    expect(raw.refresh_token_enc).toMatch(/^v1\./);
    expect(JSON.stringify(raw)).not.toMatch(/rt-|at-/);
    const entry = (await auditRows("firm_integrations"))[0];
    expect(entry.after).toMatchObject({ provider: "dropbox", account_type: "business", team_name: "Test Firm Team" });
    expect(JSON.stringify(entry)).not.toMatch(/token/);
  });
});

describe("a property's Dropbox folder", () => {
  it("shows where the folder will go before it exists", async () => {
    const r = await call(env.base, julie, "GET", `/api/firm/properties/${towerId}/files`);
    expect(r.body).toMatchObject({ connected: true, folder: null, expectedPath: EXPECTED_TOWER });
  });

  it("creates the template in the team space, with a folder for each appeal, and never duplicates it", async () => {
    const r = await call(env.base, julie, "POST", `/api/firm/properties/${towerId}/files/ensure`, {});
    expect(r.body).toMatchObject({ path: EXPECTED_TOWER, linked: true });
    expect(fake.state.lastPathRoot).toBe(JSON.stringify({ ".tag": "root", root: "ns-team-1" }));
    const team = (await tree())["ns-team-1"];
    for (const sub of [
      "Engagement Agreements", "Property Documents", "Correspondence", "Evaluation Worksheets", "Billing", "Misc",
      "Appeals/2026/Board of Review", "Appeals/2026/Assessor", "Appeals/2025/Board of Review", "Appeals/2025/Assessor", "Appeals/2024/Board of Review",
    ]) {
      expect(team).toContain(`D ${EXPECTED_TOWER}/${sub}`);
    }
    const before = team.length;
    expect((await call(env.base, julie, "POST", `/api/firm/properties/${towerId}/files/ensure`, {})).body.linked).toBe(false);
    expect((await tree())["ns-team-1"]).toHaveLength(before);
    const list = await call(env.base, julie, "GET", `/api/firm/properties/${towerId}/files?path=Appeals`);
    expect(list.body.entries.map((e: { name: string }) => e.name)).toEqual(["2026", "2025", "2024"]); // newest year first
    expect(list.body.breadcrumbs).toEqual([{ name: "Appeals", relPath: "Appeals" }]);
    expect(list.body.folder.outOfDate).toBe(false);
  });

  it("reuses a folder already at the template path instead of making a second", async () => {
    const { withContext } = await import("../../server/db");
    await withContext({ actorKind: "system", userId: null, firmId: env.nicholsId }, (c) => c.query(`DELETE FROM property_folders WHERE firm_id = $1 AND property_id = $2`, [env.nicholsId, towerId]));
    const before = (await tree())["ns-team-1"].length;
    expect((await call(env.base, julie, "POST", `/api/firm/properties/${towerId}/files/ensure`, {})).body).toMatchObject({ path: EXPECTED_TOWER, linked: true });
    expect((await tree())["ns-team-1"]).toHaveLength(before);
  });

  it("uploads into a subfolder, keeps both copies of a repeated name, and downloads", async () => {
    const r = await upload(julie, towerId, "Appeals/2026/Board of Review", "Decision – 2026 BOR.pdf", "%PDF-1 sample");
    expect(r).toMatchObject({ status: 201, body: { name: "Decision – 2026 BOR.pdf", size: 13 } });
    expect((await upload(julie, towerId, "Appeals/2026/Board of Review", "Decision – 2026 BOR.pdf", "second")).body.name).toBe("Decision – 2026 BOR (1).pdf");
    const list = await call(env.base, julie, "GET", `/api/firm/properties/${towerId}/files?path=${encodeURIComponent("Appeals/2026/Board of Review")}`);
    const file = list.body.entries.find((e: { name: string }) => e.name === "Decision – 2026 BOR.pdf");
    expect(file).toMatchObject({ kind: "file", size: 13, relPath: "Appeals/2026/Board of Review/Decision – 2026 BOR.pdf" });
    expect(file.webUrl).toBe(`https://www.dropbox.test/home${EXPECTED_TOWER.split("/").map(encodeURIComponent).join("/")}/Appeals/2026/Board%20of%20Review?preview=Decision%20%E2%80%93%202026%20BOR.pdf`);
    const dl = await fetch(`${env.base}/api/firm/properties/${towerId}/files/download?${new URLSearchParams({ path: file.relPath })}`, { redirect: "manual", headers: { Cookie: julie } });
    expect(dl.status).toBe(302);
    expect(await (await fetch(dl.headers.get("location")!)).text()).toBe("%PDF-1 sample");
  });

  it("refuses paths that climb out of the property folder, and uploads sent any other way", async () => {
    expect((await call(env.base, julie, "GET", `/api/firm/properties/${towerId}/files?path=../..`)).status).toBe(400);
    expect((await upload(julie, towerId, "Appeals/../../..", "x.pdf", "x")).status).toBe(400);
    expect((await upload(julie, towerId, "", "x.pdf", "x", "text/plain")).status).toBe(415);
    expect((await upload(julie, towerId, "", "empty.pdf", "")).status).toBe(400);
  });

  it("flags a folder whose name no longer matches the client, and moves it with its files", async () => {
    const accountId = (await call(env.base, dillon, "GET", `/api/firm/properties/${towerId}`)).body.property.account_id;
    await call(env.base, dillon, "PATCH", `/api/firm/accounts/${accountId}`, { name: "Nichols Family Trust" });
    const stale = await call(env.base, julie, "GET", `/api/firm/properties/${towerId}/files`);
    expect(stale.body.folder.outOfDate).toBe(true);
    expect(stale.body.expectedPath).toBe("/Appeal EyeQ/Nichols Family Trust/05-17-302-010 – 1044 Tower Road, Winnetka (New Trier)");
    const moved = await call(env.base, julie, "POST", `/api/firm/properties/${towerId}/files/move`, {});
    expect(moved.body.path).toBe(stale.body.expectedPath);
    const after = await call(env.base, julie, "GET", `/api/firm/properties/${towerId}/files?path=${encodeURIComponent("Appeals/2026/Board of Review")}`);
    expect(after.body.folder.outOfDate).toBe(false);
    expect(after.body.entries).toHaveLength(2);
    await call(env.base, dillon, "PATCH", `/api/firm/accounts/${accountId}`, { name: "Nichols, Dillon" });
  });

  it("refreshes an expired access token on its own", async () => {
    await fetch(`${fake.url}/__test/expire-access`, { method: "POST" });
    const r = await call(env.base, julie, "GET", `/api/firm/properties/${towerId}/files`);
    expect(r.status).toBe(200);
    expect(r.body.folder.outOfDate).toBe(true); // the client was renamed back
  });

  it("explains when the team folder can't be created, instead of failing silently", async () => {
    const list = (await call(env.base, dillon, "GET", "/api/firm/properties")).body.properties;
    const busse = list.find((p: { address1: string }) => p.address1 === "1700 Busse Rd.").id;
    expect((await call(env.base, dillon, "PATCH", "/api/firm/integrations/dropbox", { rootFolder: "Client Files" })).body.rootFolder).toBe("/Client Files");
    await fetch(`${fake.url}/__test/team-root-readonly`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: true }) });
    const r = await call(env.base, julie, "POST", `/api/firm/properties/${busse}/files/ensure`, {});
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Ask your Dropbox team admin to create the Appeal EyeQ team folder/);
    await fetch(`${fake.url}/__test/team-root-readonly`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: false }) });
    expect((await call(env.base, julie, "POST", `/api/firm/properties/${busse}/files/ensure`, {})).body.path).toBe("/Client Files/Lakeshore Data Partners LLC/08-27-401-031 – 1700 Busse Rd., Elk Grove Village (Elk Grove)");
    await call(env.base, dillon, "PATCH", "/api/firm/integrations/dropbox", { rootFolder: "Appeal EyeQ" });
  });

  it("forgets a folder that was deleted in Dropbox", async () => {
    const team = fake.state.trees.get("ns-team-1")!;
    for (const [k, n] of team) if (n.path_display.startsWith("/Client Files")) team.delete(k);
    const list = (await call(env.base, dillon, "GET", "/api/firm/properties")).body.properties;
    const busse = list.find((p: { address1: string }) => p.address1 === "1700 Busse Rd.").id;
    const r = await call(env.base, julie, "GET", `/api/firm/properties/${busse}/files`);
    expect(r.body.folder).toBeNull();
  });
});

describe("isolation and support access", () => {
  it("keeps another firm out of Nichols Law's files", async () => {
    expect((await call(env.base, olivia, "GET", `/api/firm/properties/${towerId}/files`)).status).toBe(404);
    expect((await call(env.base, olivia, "POST", `/api/firm/properties/${towerId}/files/ensure`, {})).status).toBe(404);
    expect((await upload(olivia, towerId, "", "x.pdf", "x")).status).toBe(404);
    const dl = await fetch(`${env.base}/api/firm/properties/${towerId}/files/download?path=Appeals`, { redirect: "manual", headers: { Cookie: olivia } });
    expect(dl.status).toBe(404);
    // Her firm isn't connected; Nichols Law's connection is never used for it.
    expect((await call(env.base, olivia, "GET", `/api/firm/properties/${env.otherPropertyId}/files`)).body.connected).toBe(false);
    expect((await call(env.base, olivia, "GET", "/api/firm/integrations")).body.dropbox.connected).toBe(false);
  });

  it("never shows client files to the super admin, even with a grant", async () => {
    const admin = await login(env.base, ADMIN.email, ADMIN.password);
    const g = await call(env.base, dillon, "POST", "/api/firm/support-grants", { hours: 1 });
    await call(env.base, admin, "POST", `/api/admin/firms/${env.nicholsId}/enter`, {});
    expect((await call(env.base, admin, "GET", `/api/firm/properties/${towerId}`)).status).toBe(200);
    const r = await call(env.base, admin, "GET", `/api/firm/properties/${towerId}/files`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("Client files aren't available under support access.");
    expect((await call(env.base, admin, "GET", "/api/firm/integrations")).status).toBe(200);
    expect((await call(env.base, admin, "DELETE", "/api/firm/integrations/dropbox")).status).toBe(403);
    await call(env.base, dillon, "POST", `/api/firm/support-grants/${g.body.grant.id}/revoke`, {});
  });
});

describe("losing and ending the connection", () => {
  it("asks for a reconnect when Dropbox revokes access", async () => {
    await fetch(`${fake.url}/__test/revoke-all`, { method: "POST" });
    await fetch(`${fake.url}/__test/expire-access`, { method: "POST" });
    const r = await call(env.base, julie, "GET", `/api/firm/properties/${towerId}/files`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/reconnect Dropbox in Settings, Integrations/);
  });

  it("lets a firm admin disconnect, and records it", async () => {
    expect((await call(env.base, julie, "DELETE", "/api/firm/integrations/dropbox")).status).toBe(403);
    expect((await call(env.base, dillon, "DELETE", "/api/firm/integrations/dropbox")).status).toBe(200);
    expect((await call(env.base, julie, "GET", `/api/firm/properties/${towerId}/files`)).body.connected).toBe(false);
    const log = (await call(env.base, dillon, "GET", "/api/firm/audit-log?limit=50")).body.entries;
    expect(log.some((e: { table_name: string; action: string }) => e.table_name === "firm_integrations" && e.action === "DELETE")).toBe(true);
  });
});
