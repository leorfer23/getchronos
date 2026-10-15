/**
 * `/api/browser/*` over real HTTP with the real store and authz (browser-routes.ts), the pool over a
 * fake engine. What is under test is the workspace boundary (CLAUDE.md gotcha #4): a workspace token
 * leases for its own workspace only, and cannot see, beat or release another workspace's lease.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

const { workspaces, sessions } = await import("../store.js");
const routes = await import("./browser-routes.js");
const poolMod = await import("./browser-pool.js");
import type { BrowserEngine, EngineStatus, Opened } from "./browser-engine.js";

class FakeEngine implements BrowserEngine {
  n = 0;
  closed: string[] = [];
  async open(): Promise<Opened> { const n = ++this.n; return { handle: `h${n}`, context_id: `ctx${n}`, ws_endpoint: `ws://127.0.0.1:9/devtools/browser/h${n}` }; }
  async close(h: string): Promise<void> { this.closed.push(h); }
  async touch(): Promise<boolean> { return true; }
  status(): EngineStatus { return { engine: "chrome-headless-shell", version: "153", path: "/x", pid: 7, running: true, handles: 0, idle_stops_at: null, error: null }; }
  onLost(): void {}
  async stop(): Promise<void> {}
}
const engine = new FakeEngine();
poolMod.setBrowserPoolForTest("local", new poolMod.BrowserPool("local", engine, () => ({ cap: 4, perWs: 2 }), () => {}));

const A = workspaces.create({ slug: `bra-${Date.now()}`, name: "A", config_dir: "/tmp/bra" });
const B = workspaces.create({ slug: `brb-${Date.now()}`, name: "B", config_dir: "/tmp/brb" });
const sA = sessions.create({ cwd: "/tmp", title: "a", workspace_id: A.id } as any);
const sB = sessions.create({ cwd: "/tmp", title: "b", workspace_id: B.id } as any);

const app = express();
app.use(express.json());
const api = express.Router();
routes.mountBrowserRoutes(api);
app.use("/api", api);
const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
after(() => { server.close(); poolMod.resetBrowserPools(); });

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { "x-mc-workspace-token": token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: (await r.json()) as any };
}

test("a workspace leases for itself, and only it (and admin) can see, beat and release that lease", async () => {
  const g = await call("POST", "/browser/leases", A.token, { label: "e2e", session_id: sA.id });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  assert.equal(g.json.granted, true);
  assert.equal(g.json.host_id, "local");
  assert.match(g.json.ws_endpoint, /^ws:\/\//);
  const id = g.json.lease_id;

  const mine = await call("GET", "/browser", A.token);
  assert.deepEqual(mine.json.leases.map((l: any) => [l.lease_id, l.workspace_id, l.session_id]), [[id, A.id, sA.id]]);
  assert.equal(mine.json.browser.in_use, 1);
  assert.equal(JSON.stringify(mine.json).includes("ws://"), false, "status never repeats the endpoint");

  const theirs = await call("GET", "/browser", B.token);
  assert.deepEqual(theirs.json.leases, [], "B sees no lease of A's");
  assert.equal((await call("PUT", `/browser/leases/${id}`, B.token)).status, 404, "B cannot keep A's lease alive");
  assert.equal((await call("DELETE", `/browser/leases/${id}`, B.token)).status, 404, "B cannot release A's lease");

  const beat = await call("PUT", `/browser/leases/${id}`, A.token);
  assert.equal(beat.status, 200);
  assert.ok(beat.json.expires_at > Date.now());

  const admin = await call("GET", "/browser", null);
  assert.equal(admin.json.leases.length, 1, "admin sees every lease");

  const rel = await call("DELETE", `/browser/leases/${id}`, A.token);
  assert.deepEqual(rel.json, { released: true });
  assert.ok(engine.closed.includes("h1"));
  assert.equal((await call("PUT", `/browser/leases/${id}`, A.token)).status, 404, "gone after release");
});

test("a lease cannot name another workspace's session or run", async () => {
  const r = await call("POST", "/browser/leases", A.token, { label: "x", session_id: sB.id });
  assert.equal(r.status, 404);
  const r2 = await call("POST", "/browser/leases", A.token, { label: "x", run_id: "no-such-run" });
  assert.equal(r2.status, 404);
});

test("a bad token is a 401, a bad body a 400", async () => {
  assert.equal((await call("POST", "/browser/leases", "forged", { label: "x" })).status, 401);
  assert.equal((await call("GET", "/browser", "forged")).status, 401);
  assert.equal((await call("POST", "/browser/leases", A.token, { label: "x".repeat(500) })).status, 400);
});

test("admin may release any workspace's lease; the session ending releases the rest", async () => {
  const { bus } = await import("../bus.js");
  poolMod.startBrowserPool();
  const g = await call("POST", "/browser/leases", B.token, { label: "b1", session_id: sB.id });
  const g2 = await call("POST", "/browser/leases", B.token, { label: "b2", session_id: sB.id });
  assert.deepEqual((await call("DELETE", `/browser/leases/${g.json.lease_id}`, null)).json, { released: true });
  bus.publish({ topic: "session.ended", session_id: sB.id });
  await new Promise((r) => setImmediate(r));
  assert.equal((await call("PUT", `/browser/leases/${g2.json.lease_id}`, B.token)).status, 404);
  assert.deepEqual((await call("GET", "/browser", null)).json.leases, []);
});
