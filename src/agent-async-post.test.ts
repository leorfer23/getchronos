/**
 * POST /api/agent must return before the manager runs. A long Robert turn used to hold the
 * Cloudflare tunnel open until it dropped (~100s); phone and Desk then showed "connection dropped"
 * even though the turn kept going. The reply always belonged on agent.push — now the POST says so.
 *
 * No live manager in these tests (CLAUDE.md gotcha 2): assert the wiring in the sources the clients
 * and the route actually ship.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const api = fs.readFileSync(path.join(root, "src/api.ts"), "utf8");
const desk = fs.readFileSync(path.join(root, "static/desk.html"), "utf8");
const phone = fs.readFileSync(path.join(root, "static/phone.html"), "utf8");
const app = fs.readFileSync(path.join(root, "static/app.html"), "utf8");

/** Slice the POST /agent handler so other routes' res.json({ reply patterns do not confuse us. */
function agentRoute(): string {
  const start = api.indexOf('api.post("/agent", requireAdmin, validate(AgentTextSchema)');
  assert.ok(start >= 0, "POST /agent route present");
  const next = api.indexOf('api.post("/agent/exec/:id"', start + 1);
  assert.ok(next > start, "POST /agent/exec follows POST /agent");
  return api.slice(start, next);
}

test("POST /agent accepts immediately and runs the manager detached", () => {
  const route = agentRoute();
  // Ask stays synchronous — nothing to wait for on the bus.
  assert.match(route, /if \(turn\.ask && named\.length < 2\) \{\s*return res\.json\(\{ reply: askLine/);
  // Accepted BEFORE askManagerWeb: the HTTP response must not wait on the model.
  const acceptAt = route.indexOf("res.json({ accepted: true, turn: turnId, ws, how: turn.how })");
  const runAt = route.indexOf("await askManagerWeb(");
  assert.ok(acceptAt >= 0, "returns { accepted, turn, ws, how }");
  assert.ok(runAt > acceptAt, "askManagerWeb runs after the response is sent");
  assert.match(route, /void \(async \(\) => \{/);
  // Reply + error both land on the bus; neither writes the HTTP body after accept.
  assert.match(route, /topic: "agent\.push"/);
  // The voice front (src/talker.ts) accepts the same way: answer first, then run detached (t.go()).
  const frontAccept = route.indexOf('res.json({ accepted: true, turn: t.turn, ws: t.ws, how: "front" })');
  assert.ok(frontAccept >= 0 && route.indexOf("void t.go()") > frontAccept, "the front accepts before it streams");
  assert.equal((route.match(/res\.json\(/g) || []).length, 3, "only ask + the two accepts write the HTTP body");
  assert.doesNotMatch(route, /res\.status\(500\)/);
});

test("Desk holds the queue on the turn id until agent.push (or a history re-read)", () => {
  assert.match(desk, /awaitTurn: null, awaitT: 0/);
  assert.match(desk, /function ovAwait\(turn\)/);
  assert.match(desk, /function ovRelease\(turn\)/);
  assert.match(desk, /if \(r\?\.accepted && r\?\.turn\) \{ OV\.drawn\.set\(r\.turn, item\.bub\); ovAwait\(r\.turn\); hold = true; \}/);
  assert.match(desk, /if \(OV\.awaitTurn && \(OV\.awaitTurn === e\.turn \|\| OV\.awaitTurn === "lost"\)\) ovRelease/);
  assert.match(desk, /ovHistory\(true\)\.catch\(\(\) => \{\}\)\.finally\(\(\) => ovRelease\(null\)\)/);
  assert.doesNotMatch(desk, /connection dropped/);
});

test("Phone holds the outbox on the turn id until agent.push (or a history re-read)", () => {
  assert.match(phone, /awaitTurn: null, awaitT: 0/);
  assert.match(phone, /function robAwait\(turn\)/);
  assert.match(phone, /function robRelease\(turn\)/);
  assert.match(phone, /if \(r\?\.accepted && r\?\.turn\) \{[\s\S]*?robAwait\(r\.turn\); hold = true; return;/);
  assert.match(phone, /R\.pend\.set\(r\.turn, b\); R\.mine = null; R\.pend\.delete\("\?"\)/);
  assert.match(phone, /if \(R\.awaitTurn && \(R\.awaitTurn === e\.turn \|\| R\.awaitTurn === "lost"\)\) robRelease/);
  // On reconnect the thread is re-read; the composer is freed only once the turn's row is there
  // (recoverPending clears R.pending) — a turn still running keeps it until its push or the 3-min net.
  assert.match(phone, /robertHistory\(\)\.finally\(\(\) => \{ if \(waiting && !R\.pending\) robRelease\(null\); \}\)/);
  assert.match(phone, /function recoverPending\(rows\)/);
  assert.doesNotMatch(phone, /connection dropped/);
});

test("Mission UI treats Robert's accepted POST like a push-wait, not a sync reply", () => {
  assert.match(app, /if \(r\?\.accepted \|\| \(agent\.id === "robert" && r\?\.turn && r\.reply == null\)\)/);
  assert.match(app, /awaitingPush = true/);
});
