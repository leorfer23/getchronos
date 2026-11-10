/**
 * The alerts at the API: the record is the operator's alone. A workspace token (any agent) and a
 * project's Robert must not read another client's alerts — or any alerts — nor acknowledge one, nor
 * pretend to be a live call. The operator reads the whole record and its numbers.
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
const { workspaces, sessions } = await import("./store.js");
const { alerts } = await import("./store/alerts.js");
const { robertToken } = await import("./authz.js");
const { voiceCalls, resetVoicePresence } = await import("./voice-presence.js");
const { sinceMs } = await import("./alert-routes.js");
const base = `http://127.0.0.1:${PORT}/api`;
let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); });

const A = workspaces.create({ slug: `alerts-a-${Date.now()}`, name: "A", config_dir: "/tmp/aa" } as any);
const B = workspaces.create({ slug: `alerts-b-${Date.now()}`, name: "B", config_dir: "/tmp/ab" } as any);
const sB = sessions.create({ workspace_id: B.id, goal: "B's private work", cwd: "/tmp" } as any);
const rowB = alerts.insert({
  subject: `session:${sB.id}`, kind: "decide", workspace_id: B.id, session_id: sB.id, title: "B · waiting on your answer",
  text: "In B, the task “B's private work” stopped with a question for you: ship it?", lang: "en", state: "done", stuck_since: Date.now() - 60_000,
})!;
const json = { "content-type": "application/json" };
const asA = { ...json, "x-mc-workspace-token": A.token };
const asRobertA = { ...json, "x-mc-admin": robertToken(A.id, "rw") };
const admin = { ...json, "x-mc-admin": CONFIG.adminToken };
async function call(method: string, p: string, headers: Record<string, string>, body?: unknown) {
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let out: any = null;
  try { out = await r.json(); } catch {}
  return { status: r.status, json: out, raw: JSON.stringify(out) };
}

test("a workspace token can neither read nor touch any alert — not even its own client's", async () => {
  for (const [m, p, body] of [
    ["GET", "/alerts", undefined],
    ["GET", "/alerts?since=7d", undefined],
    ["GET", "/alerts/readiness", undefined],
    ["POST", `/alerts/${rowB.id}/ack`, { via: "x" }],
    ["POST", `/alerts/${rowB.id}/spoken`, { client: "x" }],
    ["POST", "/voice/presence", { client: "evil", live: true }],
  ] as const) {
    const r = await call(m, p, asA, body);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.doesNotMatch(r.raw, /private work/, `${m} ${p} leaked B's words`);
  }
  assert.equal(alerts.get(rowB.id)!.acked_at, null, "nobody but him acknowledges");
  assert.equal(voiceCalls().length, 0, "no agent can pose as his live call");
});

test("a project's Robert (admin of ONE workspace) is refused too — the alerts span every client", async () => {
  const r = await call("GET", "/alerts", asRobertA);
  assert.equal(r.status, 403);
  assert.doesNotMatch(r.raw, /private work/);
  assert.equal((await call("POST", `/alerts/${rowB.id}/ack`, asRobertA, {})).status, 403);
});

test("the operator reads the record and its numbers, acknowledges, and his call registers", async () => {
  const r = await call("GET", "/alerts?since=1h", admin);
  assert.equal(r.status, 200);
  const mine = r.json.alerts.find((a: any) => a.id === rowB.id);
  assert.ok(mine);
  assert.equal(mine.workspace, "B");
  assert.ok("told_ms_p50" in r.json.stats && "coverage" in r.json && Array.isArray(r.json.voice));
  const ack = await call("POST", `/alerts/${rowB.id.slice(0, 8)}/ack`, admin, { via: "mc" });
  assert.equal(ack.status, 200);
  assert.equal(ack.json.alert.acked_via, "mc");
  assert.equal((await call("POST", "/alerts/nope/ack", admin, {})).status, 404);
  resetVoicePresence();
  assert.equal((await call("POST", "/voice/presence", admin, { client: "desk-1", surface: "desk", live: true, lang: "es", lock: null })).status, 200);
  assert.equal(voiceCalls()[0]?.client, "desk-1");
  assert.equal((await call("POST", "/voice/presence", admin, { client: "desk-1", live: false })).status, 200);
  assert.equal(voiceCalls().length, 0, "hanging up takes it off at once");
  assert.equal((await call("POST", "/voice/presence", admin, { live: true })).status, 400, "a call names itself");
  const ready = await call("GET", "/alerts/readiness", admin);
  assert.equal(ready.status, 200);
  assert.deepEqual(ready.json.rungs.map((r: any) => r.rung), ["voice", "push", "telegram", "mac"]);
  assert.ok(ready.json.rungs.every((r: any) => typeof r.line === "string" && r.line.length > 10), "one plain line per rung");
  assert.equal(typeof ready.json.remote_usable, "boolean");
  assert.equal((await call("POST", `/alerts/${rowB.id}/spoken`, admin, { client: "x", stage: "maybe" })).status, 400, "stage is started or done");
});

test("?since takes 90m / 24h / 7d or a date", () => {
  const now = Date.parse("2026-09-15T12:00:00Z");
  assert.equal(sinceMs("90m", now), now - 90 * 60_000);
  assert.equal(sinceMs("24h", now), now - 24 * 3_600_000);
  assert.equal(sinceMs("7d", now), now - 7 * 86_400_000);
  assert.equal(sinceMs("2026-09-01T00:00:00Z", now), Date.parse("2026-09-01T00:00:00Z"));
  assert.equal(sinceMs("", now), undefined);
  assert.equal(sinceMs("soon", now), undefined);
});
