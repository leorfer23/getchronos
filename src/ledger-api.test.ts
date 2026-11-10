/**
 * The ledger as mounted on the real API (api.ts): the routes are there behind the daemon's own
 * gates, and a terminal's draft hook lands on its request with the hash its `mc hook` computed.
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
const { kv, sessions, workspaces } = await import("./store.js");
const { requests } = await import("./store/requests.js");
const L = await import("./ledger.js");
const { draftHash } = await import("./ledger-model.js");
L.setLedgerPhaseProvider(() => ({ phase: "working", line: null }));
L.setLedgerProgressProvider(() => null);
kv.set("ledger.since", "2000-01-01T00:00:00.000Z");

const base = `http://127.0.0.1:${PORT}/api`;
let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); });

const mkWs = (slug: string) =>
  workspaces.create({ slug: `${slug}-${Math.random().toString(36).slice(2, 8)}`, name: slug, config_dir: `/tmp/la-${slug}-${Math.random()}` } as any);
async function call(method: string, p: string, headers: Record<string, string>, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

test("mounted on the API: the operator reads, a workspace reads its own, a stranger reads nothing", async () => {
  const atlas = mkWs("atlas");
  const cedar = mkWs("cedar");
  for (const w of [atlas, cedar]) {
    const s = sessions.create({ workspace_id: w.id, cwd: "/tmp", goal: `work in ${w.name}`, goal_kind: "pr", created_by: "operator" } as any);
    L.onLedgerEvent({ topic: "session.started", session_id: s.id });
  }
  const all = await call("GET", "/ledger", { "x-mc-admin": CONFIG.adminToken });
  assert.equal(all.status, 200);
  assert.ok(all.json.length >= 2);
  // ?workspace= by slug goes through the daemon's own resolver (ws-ref.ts) before the route.
  const narrowed = await call("GET", `/ledger?workspace=${atlas.slug}`, { "x-mc-admin": CONFIG.adminToken });
  assert.deepEqual(narrowed.json.map((r: any) => r.workspace_id), [atlas.id]);
  const own = await call("GET", "/ledger", { "x-mc-workspace-token": cedar.token });
  assert.ok(own.json.length >= 1 && own.json.every((r: any) => r.workspace_id === cedar.id));
  assert.equal((await call("GET", "/ledger", {})).status, 401);
});

test("a terminal's draft hook: a deliverable on its request and a send bound to the words", async () => {
  const cedar = mkWs("cedar");
  const s = sessions.create({ workspace_id: cedar.id, cwd: "/tmp", goal: "answer the numbers question", goal_kind: "investigation", created_by: "operator" } as any);
  L.onLedgerEvent({ topic: "session.started", session_id: s.id });
  const hash = draftHash({ channel: "slack", to: "#ops", text: "numbers are up" });
  const r = await call("POST", `/sessions/${s.id}/hook`, { "x-mc-workspace-token": cedar.token }, {
    event: "draft", label: "Slack draft → #ops: numbers are up", tool: { name: "mcp__x__slack_send_message_draft" }, target: { channel: "slack", to: "#ops", hash },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const req = requests.get(requests.primaryAt(s.id)!.request_id)!;
  const item = requests.items(req.id).find((i) => i.action === "send");
  assert.equal(item?.target_hash, hash);
  assert.equal(requests.get(req.id)!.state, "needs_operator");
  // A malformed target is dropped — the hook (and the operator's draft notice) still goes through,
  // and the draft is recorded unbound: nothing a yes could be bound to.
  const bad = await call("POST", `/sessions/${s.id}/hook`, { "x-mc-workspace-token": cedar.token }, { event: "draft", label: "Email draft → x", tool: { name: "mcp__y__create_draft" }, target: { channel: "slack", to: "#ops", hash: "not-a-hash" } });
  assert.equal(bad.status, 200);
  const unbound = requests.items(req.id).find((i) => i.action === "send" && i.label === "Email draft → x");
  assert.equal(unbound?.target_hash, null);
});
