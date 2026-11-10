/**
 * The verifier on the real API: checks are read through GET /api/ledger/:id behind the ledger's wall,
 * and only the operator's token re-runs a pass. A workspace token reads its own checks and nothing
 * else — another workspace's request is the same 404 as a missing one, and a re-run is refused.
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
const V = await import("./request-verifier.js");
L.setLedgerPhaseProvider(() => ({ phase: "your_turn", line: null }));
L.setLedgerProgressProvider(() => null);
kv.set("ledger.since", "2000-01-01T00:00:00.000Z");
let reviews = 0;
V.setVerifierDeps({
  review: async () => { reviews++; return { text: 'VERDICT {"pass":true,"reasons":["answers it"],"aspects":{"queries":true,"crosscheck":true,"assumptions":true}}', run_id: null, status: "success" }; },
  tell: async () => null,
  draftText: async () => null,
});

const base = `http://127.0.0.1:${PORT}/api`;
let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); });

const mkWs = (slug: string) =>
  workspaces.create({ slug: `${slug}-${Math.random().toString(36).slice(2, 8)}`, name: slug, config_dir: `/tmp/va-${slug}-${Math.random()}` } as any);
async function call(method: string, p: string, headers: Record<string, string>, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
function analysis(ws: { id: string }) {
  const s = sessions.create({ workspace_id: ws.id, cwd: "/tmp", goal: "count last week's signups", goal_kind: "investigation", created_by: "operator" } as any);
  L.onLedgerEvent({ topic: "session.started", session_id: s.id });
  sessions.setOutcome(s.id, { summary: "412 signups", changes: [], proof: [], prs: [], shots: [], ask: "review", shipped: [], at: new Date(Date.now() + 1000).toISOString() }, []);
  L.syncSession(s.id);
  return requests.get(requests.primaryAt(s.id)!.request_id)!;
}

test("scope: a workspace token reads its own checks, never another workspace's, and re-runs nothing", async () => {
  const atlas = mkWs("atlas");
  const cedar = mkWs("cedar");
  const mine = analysis(cedar);
  const theirs = analysis(atlas);
  const admin = { "x-mc-admin": CONFIG.adminToken };

  // The operator re-runs: the pass runs (a stubbed reader) and its checks land on the request.
  const run = await call("POST", `/ledger/${theirs.id}/verify`, admin);
  assert.ok(run.status === 200 || run.status === 202, JSON.stringify(run.json));
  for (let i = 0; i < 100 && requests.lastVerification(theirs.id)?.status !== "done"; i++) await new Promise((ok) => setTimeout(ok, 10));
  assert.equal(requests.lastVerification(theirs.id)?.trigger, "manual");
  await V.verifyRequest(mine.id, { trigger: "manual", force: true });

  const read = await call("GET", `/ledger/${theirs.id}`, admin);
  assert.equal(read.status, 200);
  assert.ok(read.json.checks.some((c: any) => c.name === "matches_request" && c.status === "pass"));
  assert.equal(read.json.verification.last.trigger, "manual");
  assert.ok(Array.isArray(read.json.readiness));

  const cedarTok = { "x-mc-workspace-token": cedar.token };
  const own = await call("GET", `/ledger/${mine.id}`, cedarTok);
  assert.equal(own.status, 200);
  assert.ok(own.json.checks.length > 0, "its own checks are readable");
  const foreign = await call("GET", `/ledger/${theirs.id}`, cedarTok);
  assert.equal(foreign.status, 404, "another workspace's request is the same 404 as a missing one");
  assert.equal(foreign.json.checks, undefined);
  const q = await call("GET", "/ledger/queue", cedarTok);
  assert.ok(q.json.items.every((i: any) => i.workspace?.id === cedar.id), "the queue's checks are its own only");

  const before = reviews;
  assert.equal((await call("POST", `/ledger/${theirs.id}/verify`, cedarTok)).status, 403, "never another's");
  assert.equal((await call("POST", `/ledger/${mine.id}/verify`, cedarTok)).status, 403, "not even its own: the re-run is the operator's");
  assert.equal((await call("POST", `/ledger/${mine.id}/verify`, {})).status, 401);
  assert.equal(reviews, before, "a refused re-run ran nothing");
});
