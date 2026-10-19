// A stand-in Dropbox for tests. It speaks the parts of the Dropbox API that
// Appeal EyeQ uses: the OAuth sign-in (with PKCE), token refresh, account info,
// folders, listing, moves, uploads and temporary links, with the same error
// shapes Dropbox returns. A team account works in a shared team space when the
// request carries the Dropbox-API-Path-Root header, and in its own home
// otherwise, like the real thing.
//
// Run standalone (browser tests): PORT=3199 npx tsx tests/fake-dropbox/server.ts
// Or import startFakeDropbox() (integration tests).

import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { type Request, type Response } from "express";

export const FAKE_APP_KEY = "test-app-key";
export const FAKE_APP_SECRET = "test-app-secret";

interface Node { tag: "file" | "folder"; id: string; name: string; path_display: string; size: number; content: Buffer; modified: string }
interface Account { id: string; type: "business" | "basic"; email: string; name: string; team: string | null; homeNs: string; teamNs: string | null }

export interface FakeDropbox {
  url: string;
  server: Server;
  state: {
    nextAccount: Account["type"];
    accounts: Map<string, Account>;
    trees: Map<string, Map<string, Node>>;
    access: Map<string, { accountId: string; expires: number }>;
    refresh: Map<string, string>;
    codes: Map<string, { accountId: string; challenge: string | null; redirect: string }>;
    teamRootReadOnly: boolean;
    lastPathRoot: string | null;
    calls: string[];
  };
  close: () => Promise<void>;
}

function fail(res: Response, status: number, summary: string) {
  res.status(status).json({ error_summary: summary, error: { ".tag": summary.split("/")[0] } });
}

export function createFakeDropbox() {
  const state: FakeDropbox["state"] = {
    nextAccount: "business",
    accounts: new Map(),
    trees: new Map(),
    access: new Map(),
    refresh: new Map(),
    codes: new Map(),
    teamRootReadOnly: false,
    lastPathRoot: null,
    calls: [],
  };
  let seq = 0;
  const newId = (p: string) => `${p}${++seq}${randomBytes(3).toString("hex")}`;
  const tree = (ns: string) => {
    if (!state.trees.has(ns)) state.trees.set(ns, new Map());
    return state.trees.get(ns)!;
  };

  const app = express();
  let base = "";

  // ---------------------------------------------------------------- test controls
  app.post("/__test/next-account", express.json(), (req, res) => { state.nextAccount = req.body.type; res.json({ ok: true }); });
  app.post("/__test/expire-access", (_req, res) => { for (const v of state.access.values()) v.expires = 0; res.json({ ok: true }); });
  app.post("/__test/revoke-all", (_req, res) => { state.access.clear(); state.refresh.clear(); res.json({ ok: true }); });
  app.post("/__test/team-root-readonly", express.json(), (req, res) => { state.teamRootReadOnly = Boolean(req.body.on); res.json({ ok: true }); });
  app.get("/__test/tree", (_req, res) => {
    res.json(Object.fromEntries([...state.trees].map(([ns, t]) => [ns, [...t.values()].map((n) => `${n.tag === "folder" ? "D" : "F"} ${n.path_display}`).sort()])));
  });
  app.get("/__file/:id", (req, res) => {
    for (const t of state.trees.values()) for (const n of t.values()) if (n.id === req.params.id && n.tag === "file") { res.type("application/octet-stream").send(n.content); return; }
    res.status(404).send("gone");
  });

  // ---------------------------------------------------------------- OAuth
  app.get("/oauth2/authorize", (req, res) => {
    const q = req.query as Record<string, string>;
    if (q.client_id !== FAKE_APP_KEY) { res.status(400).send("bad client_id"); return; }
    if ((q.code_challenge && q.code_challenge_method !== "S256") || q.token_access_type !== "offline") { res.status(400).send("bad request"); return; }
    const kind = state.nextAccount;
    const n = state.accounts.size + 1;
    const acct: Account = {
      id: `dbid:acct${n}`, type: kind, email: `owner${n}@${kind === "business" ? "firm" : "home"}.example`, name: `Test Owner ${n}`,
      team: kind === "business" ? "Test Firm Team" : null, homeNs: `ns-home-${n}`, teamNs: kind === "business" ? "ns-team-1" : null,
    };
    state.accounts.set(acct.id, acct);
    const code = newId("code-");
    state.codes.set(code, { accountId: acct.id, challenge: q.code_challenge || null, redirect: q.redirect_uri });
    res.redirect(302, `${q.redirect_uri}?${new URLSearchParams({ code, state: q.state })}`);
  });

  app.post("/oauth2/token", express.urlencoded({ extended: false }), (req, res) => {
    const b = req.body as Record<string, string>;
    if (b.client_id !== FAKE_APP_KEY || b.client_secret !== FAKE_APP_SECRET) { fail(res, 400, "invalid_client"); return; }
    const issue = (accountId: string, withRefresh: boolean) => {
      const access = newId("at-");
      state.access.set(access, { accountId, expires: Date.now() + 4 * 3600_000 });
      const out: Record<string, unknown> = { access_token: access, token_type: "bearer", expires_in: 14400, account_id: accountId };
      if (withRefresh) { const r = newId("rt-"); state.refresh.set(r, accountId); out.refresh_token = r; }
      return out;
    };
    if (b.grant_type === "authorization_code") {
      const c = state.codes.get(b.code);
      state.codes.delete(b.code);
      if (!c || c.redirect !== b.redirect_uri) { fail(res, 400, "invalid_grant"); return; }
      if (c.challenge && createHash("sha256").update(b.code_verifier ?? "").digest("base64url") !== c.challenge) { fail(res, 400, "invalid_grant"); return; }
      res.json(issue(c.accountId, true));
      return;
    }
    if (b.grant_type === "refresh_token") {
      const accountId = state.refresh.get(b.refresh_token);
      if (!accountId) { fail(res, 400, "invalid_grant"); return; }
      res.json(issue(accountId, false));
      return;
    }
    fail(res, 400, "unsupported_grant_type");
  });

  // ---------------------------------------------------------------- RPC
  function who(req: Request, res: Response): { acct: Account; ns: string } | null {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    const t = state.access.get(token);
    if (!t) { fail(res, 401, "invalid_access_token/"); return null; }
    if (t.expires < Date.now()) { fail(res, 401, "expired_access_token/"); return null; }
    const acct = state.accounts.get(t.accountId)!;
    const rootHeader = req.headers["dropbox-api-path-root"];
    state.lastPathRoot = typeof rootHeader === "string" ? rootHeader : null;
    let ns = acct.homeNs;
    if (typeof rootHeader === "string") {
      const r = JSON.parse(rootHeader) as { root: string };
      if (r.root !== acct.teamNs && r.root !== acct.homeNs) { fail(res, 422, "invalid_root/"); return null; }
      ns = r.root;
    }
    return { acct, ns };
  }

  const lower = (p: string) => p.toLowerCase();
  const norm = (p: string) => `/${p.split("/").filter(Boolean).join("/")}`;
  const meta = (n: Node) => ({
    ".tag": n.tag, id: n.id, name: n.name, path_display: n.path_display, path_lower: lower(n.path_display),
    ...(n.tag === "file" ? { size: n.size, server_modified: n.modified, client_modified: n.modified } : {}),
  });
  function resolve(t: Map<string, Node>, path: string): Node | undefined {
    if (path.startsWith("id:")) { for (const n of t.values()) if (n.id === path) return n; return undefined; }
    return t.get(lower(norm(path)));
  }
  function mkdirs(t: Map<string, Node>, path: string): Node {
    const parts = norm(path).split("/").filter(Boolean);
    let cur = "";
    let node: Node | undefined;
    for (const p of parts) {
      cur += `/${p}`;
      node = t.get(lower(cur));
      if (!node) {
        node = { tag: "folder", id: newId("id:"), name: p, path_display: cur, size: 0, content: Buffer.alloc(0), modified: new Date().toISOString() };
        t.set(lower(cur), node);
      } else {
        cur = node.path_display;
      }
    }
    return node!;
  }

  // ---------------------------------------------------------------- content
  app.post("/2/files/upload", express.raw({ type: () => true, limit: "60mb" }), (req, res) => {
    state.calls.push("files/upload");
    const w = who(req, res);
    if (!w) return;
    const t = tree(w.ns);
    const arg = JSON.parse(String(req.headers["dropbox-api-arg"])) as { path: string; autorename: boolean };
    let path = norm(arg.path);
    const parent = path.slice(0, path.lastIndexOf("/"));
    const parentNode = parent ? t.get(lower(parent)) : undefined;
    if (parent && !parentNode) mkdirs(t, parent);
    if (t.get(lower(path))) {
      const dot = path.lastIndexOf(".");
      const stem = dot > path.lastIndexOf("/") ? path.slice(0, dot) : path;
      const ext = dot > path.lastIndexOf("/") ? path.slice(dot) : "";
      let i = 1;
      while (t.get(lower(`${stem} (${i})${ext}`))) i++;
      path = `${stem} (${i})${ext}`;
    }
    const realParent = parent ? t.get(lower(parent))!.path_display : "";
    const name = path.slice(path.lastIndexOf("/") + 1);
    const node: Node = { tag: "file", id: newId("id:"), name, path_display: `${realParent}/${name}`, size: (req.body as Buffer).length, content: req.body as Buffer, modified: new Date().toISOString() };
    t.set(lower(node.path_display), node);
    res.json(meta(node));
  });

  app.post("/2/:a/:b", express.json({ type: () => true, limit: "1mb" }), (req, res) => handle(`${req.params.a}/${req.params.b}`, req, res));
  app.post("/2/:a/:b/:c", express.json({ type: () => true, limit: "1mb" }), (req, res) => handle(`${req.params.a}/${req.params.b}/${req.params.c}`, req, res));

  function handle(endpoint: string, req: Request, res: Response) {
    state.calls.push(endpoint);
    const w = who(req, res);
    if (!w) return;
    const t = tree(w.ns);
    const body = (req.body ?? {}) as Record<string, string | boolean>;
    switch (endpoint) {
      case "users/get_current_account": {
        const a = w.acct;
        res.json({
          account_id: a.id, email: a.email, name: { display_name: a.name }, account_type: { ".tag": a.type },
          team: a.team ? { name: a.team, id: "dbtid:team1" } : null,
          root_info: a.teamNs ? { ".tag": "team", root_namespace_id: a.teamNs, home_namespace_id: a.homeNs } : { ".tag": "user", root_namespace_id: a.homeNs, home_namespace_id: a.homeNs },
        });
        return;
      }
      case "auth/token/revoke": {
        const token = (req.headers.authorization || "").replace(/^Bearer /, "");
        const accountId = state.access.get(token)?.accountId;
        state.access.delete(token);
        for (const [r, acc] of state.refresh) if (acc === accountId) state.refresh.delete(r);
        res.send("null");
        return;
      }
      case "files/create_folder_v2": {
        const path = norm(String(body.path));
        const existing = t.get(lower(path));
        if (existing) { fail(res, 409, `path/conflict/${existing.tag}/`); return; }
        // Members can't create new top-level (team) folders when the team admin has locked that down.
        if (state.teamRootReadOnly && w.ns === w.acct.teamNs && !t.get(lower(`/${path.split("/").filter(Boolean)[0]}`))) { fail(res, 409, "path/no_write_permission/"); return; }
        res.json({ metadata: meta(mkdirs(t, path)) });
        return;
      }
      case "files/get_metadata": {
        const n = resolve(t, String(body.path));
        if (!n) { fail(res, 409, "path/not_found/"); return; }
        res.json(meta(n));
        return;
      }
      case "files/list_folder": {
        const folder = resolve(t, String(body.path));
        if (!folder || folder.tag !== "folder") { fail(res, 409, "path/not_found/"); return; }
        const prefix = `${lower(folder.path_display)}/`;
        const entries = [...t.values()].filter((n) => lower(n.path_display).startsWith(prefix) && !lower(n.path_display).slice(prefix.length).includes("/"));
        res.json({ entries: entries.map(meta), cursor: "c0", has_more: false });
        return;
      }
      case "files/list_folder/continue":
        res.json({ entries: [], cursor: "c0", has_more: false });
        return;
      case "files/move_v2": {
        const from = resolve(t, String(body.from_path));
        const to = norm(String(body.to_path));
        if (!from) { fail(res, 409, "from_lookup/not_found/"); return; }
        if (t.get(lower(to))) { fail(res, 409, "to/conflict/folder/"); return; }
        const oldPrefix = from.path_display;
        const moved = [...t.values()].filter((n) => n === from || lower(n.path_display).startsWith(`${lower(oldPrefix)}/`));
        for (const n of moved) t.delete(lower(n.path_display));
        const parent = to.slice(0, to.lastIndexOf("/"));
        if (parent) mkdirs(t, parent);
        for (const n of moved) {
          n.path_display = to + n.path_display.slice(oldPrefix.length);
          if (n === from) n.name = to.slice(to.lastIndexOf("/") + 1);
          t.set(lower(n.path_display), n);
        }
        res.json({ metadata: meta(from) });
        return;
      }
      case "files/get_temporary_link": {
        const n = resolve(t, String(body.path));
        if (!n || n.tag !== "file") { fail(res, 409, "path/not_found/"); return; }
        res.json({ metadata: meta(n), link: `${base}/__file/${n.id}` });
        return;
      }
      default:
        res.status(404).json({ error_summary: `unknown endpoint ${endpoint}` });
    }
  }

  return { app, state, setBase: (u: string) => { base = u; } };
}

export async function startFakeDropbox(port = 0): Promise<FakeDropbox> {
  const { app, state, setBase } = createFakeDropbox();
  const server = app.listen(port);
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setBase(url);
  return { url, server, state, close: () => new Promise((r) => server.close(() => r())) };
}

if (process.argv[1] && /fake-dropbox[\\/]server\.ts$/.test(process.argv[1])) {
  void startFakeDropbox(Number(process.env.PORT || 3199)).then((f) => console.log(`Fake Dropbox on ${f.url}`));
}
