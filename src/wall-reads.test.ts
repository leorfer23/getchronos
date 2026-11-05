/**
 * The workspace wall at the API, for the cross-workspace reads the route audit found (2026-11-05):
 * with only workspace A's token an agent must not list other clients, write notes or lessons into
 * them, read operator rollups (fleet, costs, report, recovery, usage, calendars…), read the
 * operator's clipboard, decide reviews, link to another client's ticket, or touch another's slots.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
const PORT = await freePort();
process.env.CHRONOS_PORT = String(PORT);
process.env.CHRONOS_CLAUDE_BIN = "/usr/bin/true";

const { startServer } = await import("./api.js");
const { CONFIG } = await import("./config.js");
const { lessons, workspaces } = await import("./store.js");
const base = `http://127.0.0.1:${PORT}/api`;
let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); });

const A = workspaces.create({ slug: `reads-a-${Date.now()}`, name: "A", config_dir: "/tmp/ra" } as any);
const B = workspaces.create({ slug: `reads-b-${Date.now()}`, name: "B", config_dir: "/tmp/rb" } as any);
const asA = { "content-type": "application/json", "x-mc-workspace-token": A.token };
const admin = { "content-type": "application/json", "x-mc-admin": CONFIG.adminToken };
async function call(method: string, p: string, headers: Record<string, string>, body?: unknown) {
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

test("GET /workspaces: a workspace token sees only itself; the operator sees all", async () => {
  const mine = await call("GET", "/workspaces", asA);
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.json.map((w: any) => w.id), [A.id]);
  const all = await call("GET", "/workspaces", admin);
  assert.ok(all.json.some((w: any) => w.id === B.id));
});

test("notes and lessons: written only into your own workspace, and an agent's lesson is a proposal", async () => {
  assert.equal((await call("POST", "/notes", asA, { workspace_id: B.id, title: "planted", body: "x", context: true })).status, 404);
  const own = await call("POST", "/notes", asA, { workspace_id: A.id, title: "mine", body: "x" });
  assert.equal(own.status, 201);
  assert.equal(own.json.workspace_id, A.id);

  assert.equal((await call("POST", "/lessons", asA, { workspace_id: B.id, rule: "always do the thing" })).status, 404);
  assert.equal((await call("POST", "/lessons", asA, { workspace_id: A.id, rule: "always do the thing", source: "operator" })).status, 403);
  const l = await call("POST", "/lessons", asA, { workspace_id: A.id, rule: "always run the tests first" });
  assert.equal(l.status, 201);
  assert.equal(lessons.get(l.json.id)!.state, "proposed", "not straight into prompts");
  assert.notEqual(lessons.get(l.json.id)!.source, "operator");
  assert.equal((await call("PATCH", `/lessons/${l.json.id}`, asA, { state: "active" })).status, 403);
  const bl = lessons.create({ workspace_id: B.id, rule: "b's private rule here" } as any);
  const list = await call("GET", "/lessons", asA);
  assert.ok(!list.json.some((x: any) => x.id === bl.id), "never another workspace's lessons");
  assert.equal((await call("GET", `/lessons?workspace=${B.id}`, asA)).status, 404);
});

test("operator rollups and actions are refused to a workspace token", async () => {
  for (const [m, p] of [
    ["GET", "/fleet"], ["GET", "/flow"], ["GET", "/report"], ["GET", "/costs"], ["GET", "/costs/daily"],
    ["GET", "/stats"], ["GET", "/recovery"], ["GET", "/watches"], ["GET", "/calendars"], ["GET", "/operational"],
    ["GET", "/quota"], ["GET", "/usage"], ["GET", "/clipboard"], ["POST", "/backends/grok/login"],
    [`POST`, `/workspaces/${B.id}/sync`], ["POST", "/reviews/x/approve"], ["POST", "/reviews/x/merge"],
    ["POST", "/reviews/x/changes"], ["POST", "/reviews/x/dismiss"], ["POST", "/asks/x/hold"],
  ] as const) {
    assert.equal((await call(m, p, asA, m === "POST" ? {} : undefined)).status, 403, `${m} ${p}`);
  }
});

test("/health: liveness for anyone, the rollup for the operator", async () => {
  const anon = await call("GET", "/health", {});
  assert.deepEqual(anon.json, { ok: true });
  const ws = await call("GET", "/health", asA);
  assert.deepEqual(ws.json, { ok: true });
  const op = await call("GET", "/health", admin);
  assert.ok("operational" in op.json);
});

test("a ticket link never reaches another workspace's ticket", async () => {
  const a = (await call("POST", "/tickets", asA, { workspace_id: A.id, title: "a's ticket" })).json;
  const b = (await call("POST", "/tickets", admin, { workspace_id: B.id, title: "b's ticket" })).json;
  assert.equal((await call("POST", `/tickets/${a.id}/links`, asA, { to_id: b.id, type: "blocks" })).status, 404);
});
