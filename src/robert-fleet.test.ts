/**
 * The fleet-wide Robert is the operator's main work surface: he answers every unscoped turn
 * (thread-router.ts oneRobert) and drives the whole fleet. So two things must hold together:
 *
 *  1. Every write his persona tells him to make on a normal turn passes — no 403. His boundary is a
 *     DENY-list (robert-scope.ts FLEET_OPERATOR_ONLY), not an allow-list, exactly so a route he uses
 *     keeps working. This runs each documented route through the real gate.
 *  2. The sensitive writes a model must never make ARE refused: the executor's own decide/run (gated
 *     by operatorHand, tested in executor-auth.test.ts), anything that loosens a wall
 *     (derivedWriteRefusal), and the FLEET_OPERATOR_ONLY set (secrets, outbound config, the operator's
 *     own surfaces).
 *
 * Part A drives robertGateFor directly (pure). Part B drives the real server for the terminal/hold
 * routes whose gate is inline, not requireAdmin.
 */
import { test, before, after, beforeEach } from "node:test";
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
const { robertToken } = await import("./authz.js");
const { robertGateFor, FLEET_OPERATOR_ONLY } = await import("./robert-scope.js");
const { db, workspaces } = await import("./store.js");

const fleetRw = { ws: null, role: "rw", lane: "operator", fleet: true } as const;
const fleetRo = { ws: null, role: "ro", lane: "wake", fleet: true } as const;

function fakeReq(method: string, pattern: string, body: Record<string, unknown> = {}, params: Record<string, string> = {}): any {
  return { method, route: { path: pattern }, get: () => undefined, params, body, query: {} };
}

// ── Part A: every write Robert's persona documents passes robertGateFor as the fleet rw credential ──
// Curated from agents/robert/web.md + agents/_blocks/mut-endpoints.md, terminal-drive, hosts, watches,
// board — his normal-turn writes. A route added to his persona belongs here.
const PERSONA_WRITES: Array<[string, string]> = [
  // tickets: the core build loop
  ["POST", "/tickets"], ["PATCH", "/tickets/:id"], ["DELETE", "/tickets/:id"],
  ["POST", "/tickets/:id/note"], ["POST", "/tickets/:id/dispatch"], ["POST", "/tickets/:id/dispatch-plan"],
  ["POST", "/tickets/:id/plan"], ["POST", "/tickets/:id/grade"], ["POST", "/tickets/:id/links"],
  ["POST", "/tickets/:id/attachments"], ["POST", "/tickets/:id/ideas/generate"],
  ["POST", "/tickets/:id/push-status"], ["POST", "/tickets/:id/push-hours"],
  // jobs
  ["POST", "/jobs"], ["PATCH", "/jobs/:id"], ["DELETE", "/jobs/:id"], ["POST", "/jobs/:id/run"],
  // reviews — he may ask for changes and kick the AI reviewer, but never approve or merge
  ["POST", "/reviews/:id/changes"], ["POST", "/reviews/:id/dispatch-review"], ["POST", "/reviews/:id/hold"],
  // asks, recovery, messages, board, notes, lessons
  ["POST", "/asks/:id/hold"], ["POST", "/recovery/:id/hold"], ["POST", "/recovery/decide"],
  ["POST", "/board"], ["POST", "/notes"], ["PATCH", "/notes/:id"], ["DELETE", "/notes/:id"],
  ["POST", "/lessons"], ["PATCH", "/lessons/:id"], ["DELETE", "/lessons/:id"],
  // ideas, jots, launches, skills
  ["POST", "/ideas/:id/promote"], ["POST", "/ideas/:id/kill"], ["POST", "/ideas/promote"], ["POST", "/ideas/kill"],
  ["PATCH", "/jots/:id"], ["DELETE", "/jots/:id"], ["POST", "/jots/:id/run"], ["POST", "/jots/:id/follow-up"],
  ["POST", "/jots/:id/follow-up/now"], ["POST", "/launches/:id/run"],
  ["POST", "/skills/:id/approve"], ["POST", "/skills/:id/reject"], ["POST", "/skills/:id/archive"], ["DELETE", "/skills/:id"],
  // per-workspace work he files / starts
  ["POST", "/workspaces/:id/ideas"], ["POST", "/workspaces/:id/ideas/generate"], ["POST", "/workspaces/:id/jots"],
  ["POST", "/workspaces/:id/learn"], ["POST", "/workspaces/:id/sync"], ["POST", "/workspaces/:id/repos"],
  ["PUT", "/workspaces/:id/brief"], ["POST", "/workspaces/:id/brief"],
  ["POST", "/workspaces/:id/launches"], ["POST", "/workspaces/:id/jots/reorder"],
  // workspace create + the autonomy/config knobs he flips (non-wall fields only)
  ["POST", "/workspaces"],
  // repos config he edits (NOT the unsandboxed-command fields — those are walls, tested below)
  ["PATCH", "/repos/:id"], ["DELETE", "/repos/:id"], ["POST", "/repos/:id/accel/graphify/build"],
  // computers
  ["PATCH", "/hosts/:id"], ["POST", "/hosts/:id/update"], ["POST", "/hosts/update-all"], ["DELETE", "/hosts/:id"],
  // his own planner, watches, memory, acks
  ["POST", "/nextday"], ["POST", "/startday"], ["POST", "/robert/proactive"],
  ["POST", "/watches"], ["PATCH", "/watches/:id"], ["DELETE", "/watches/:id"],
  ["POST", "/agents/:name/stow"],
  ["POST", "/robert/wakes/:id/ack"], ["POST", "/alerts/:id/ack"], ["POST", "/calendars/refresh"],
  // settings he changes on the operator's word (a wall-loosening key is a separate wall, tested below)
  ["PUT", "/settings"], ["POST", "/settings"],
];

test("Part A — no write Robert's persona documents is refused for the fleet rw credential", () => {
  const refused: string[] = [];
  for (const [m, p] of PERSONA_WRITES) {
    const why = robertGateFor(fakeReq(m, p), fleetRw);
    if (why !== null) refused.push(`${m} ${p} → ${why}`);
  }
  assert.deepEqual(refused, [], "persona routes a fleet Robert must be able to use, but the gate refuses");
});

test("Part A — his reads pass; a documented route is never in the operator-only deny set", () => {
  for (const p of ["/fleet", "/costs", "/report", "/board", "/watches", "/settings", "/recovery", "/briefs", "/isolation/audit"]) {
    assert.equal(robertGateFor(fakeReq("GET", p), fleetRw), null, `GET ${p} should read`);
  }
  // His clipboard contents are his alone even from the fleet Robert.
  assert.ok(robertGateFor(fakeReq("GET", "/clipboard"), fleetRw));
  for (const [m, p] of PERSONA_WRITES) assert.ok(!FLEET_OPERATOR_ONLY.has(`${m} ${p}`), `${m} ${p} is documented AND operator-only — contradiction`);
});

test("Part A — the operator-only set and every wall ARE refused, for rw and ro alike", () => {
  // The deny set.
  for (const key of FLEET_OPERATOR_ONLY) {
    const [m, ...rest] = key.split(" ");
    const why = robertGateFor(fakeReq(m, rest.join(" ")), fleetRw);
    assert.ok(why && /operator-only/.test(why), `${key} must be refused`);
  }
  // A read-only fleet Robert writes nothing at all.
  assert.ok(robertGateFor(fakeReq("POST", "/tickets"), fleetRo), "ro proposes, never writes");
  assert.equal(robertGateFor(fakeReq("GET", "/fleet"), fleetRo), null, "but ro still reads");
});

test("Part A — wall-loosening writes are refused whatever the deny set says (derivedWriteRefusal)", () => {
  const w = workspaces.create({ slug: `fleet-wall-${Date.now()}`, name: "W", config_dir: "/tmp/fleet-wall", sandbox_mode: "guard" } as any);
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ["PATCH", "/workspaces/:id", { sandbox_mode: "off" }],
    ["PATCH", "/workspaces/:id", { sandbox_allow: ["~/.ssh"] }],
    ["PATCH", "/workspaces/:id", { auto_merge_prs: true }],
    ["PATCH", "/workspaces/:id", { merge_gate: false }],
    ["PATCH", "/repos/:id", { gate_cmds: [{ name: "x", cmd: "cat ~/chronos/.admin-token" }] }],
    ["PATCH", "/repos/:id", { post_merge_cmd: "true" }],
    ["PUT", "/settings", { key: "executor.enabled", value: false }],
    ["PUT", "/settings", { key: "ws.sandbox_mode", value: "off", workspace: w.slug }],
  ];
  for (const [m, p, body] of cases) {
    const why = robertGateFor(fakeReq(m, p, body, { id: w.id }), fleetRw);
    assert.ok(why && /operator-only/.test(why), `${m} ${p} ${JSON.stringify(body)} must be refused, got ${why}`);
  }
  // Tightening the sandbox, and an ordinary autonomy toggle, still pass.
  assert.equal(robertGateFor(fakeReq("PATCH", "/workspaces/:id", { sandbox_mode: "strict" }, { id: w.id }), fleetRw), null);
  assert.equal(robertGateFor(fakeReq("PATCH", "/workspaces/:id", { auto_plan: false }, { id: w.id }), fleetRw), null);
});

// ── Part B: the inline-gated terminal/hold routes allow the fleet rw credential over the real server ──
let server: any;
before(() => { server = startServer(); });
after(() => server?.close?.());

async function call(method: string, p: string, headers: Record<string, string>, body?: unknown) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status };
}

test("Part B — the fleet Robert opens, drives, closes terminals and answers in any workspace (not 401/403)", async () => {
  const H = { "x-mc-admin": robertToken(null, "rw", "operator") };
  // A non-existent id makes the handler 404 AFTER the auth check — so anything but 401/403 proves auth passed.
  const nope = "00000000-0000-0000-0000-000000000000";
  const routes: Array<[string, string, unknown]> = [
    ["POST", `/sessions/${nope}/input`, { text: "next step" }],
    ["POST", `/sessions/${nope}/kill`, {}],          // was operator-only; the fleet Robert now closes terminals
    ["POST", `/sessions/${nope}/resume`, { cols: 80, rows: 24 }],
    ["POST", `/sessions/${nope}/wait`, {}],
    ["POST", `/runs/${nope}/kill`, {}],
    ["POST", `/asks/${nope}/answer`, { answer: "yes", by: "robert" }],
    ["POST", `/asks/${nope}/hold`, { until: "+2h" }],
    ["POST", `/tickets/${nope}/note`, { text: "a note" }],
  ];
  for (const [m, p, body] of routes) {
    const { status } = await call(m, p, H, body);
    assert.ok(status !== 401 && status !== 403, `${m} ${p} refused the fleet Robert (${status})`);
  }
  // The same kill from a PROJECT Robert or the read-only one is still a proposal (403).
  assert.equal((await call("POST", `/sessions/${nope}/kill`, { "x-mc-admin": robertToken(workspaces.list()[0].id, "rw") })).status, 403);
  assert.equal((await call("POST", `/sessions/${nope}/kill`, { "x-mc-admin": robertToken(null, "ro") })).status, 403);
  // And an agent (workspace token) never closes a terminal.
  assert.equal((await call("POST", `/sessions/${nope}/kill`, { "x-mc-workspace-token": workspaces.list()[0].token! })).status, 403);
});

beforeEach(() => {});
