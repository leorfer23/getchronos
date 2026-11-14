/**
 * `mc trigger` against a stand-in API: what each subcommand sends, and that `--help` sends nothing.
 * The engine and its routes are tested in src/ws-triggers.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mc");

/** Run mc with a stand-in API that records every request (method, url, body) and answers with reply(). */
async function withApi(reply, args) {
  const seen = [];
  const srv = http.createServer((q, s) => {
    let raw = "";
    q.on("data", (b) => (raw += b));
    q.on("end", () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch {}
      seen.push({ method: q.method, url: q.url, body });
      s.setHeader("content-type", "application/json");
      s.end(JSON.stringify(reply(q.method, q.url)));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const api = `http://127.0.0.1:${srv.address().port}/api`;
    // A workspace token of its own, so mc never reaches for the operator's admin token on this Mac.
    const env = { ...process.env, MC_API: api, MC_WORKSPACE_TOKEN: "test-ws-token", MC_WORKSPACE: "", MC_SESSION: "", MC_LEAD: "" };
    const child = spawn(process.execPath, [mc, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    const code = await new Promise((r) => child.on("close", r));
    return { code, out, seen };
  } finally {
    srv.close();
  }
}

const ROW = {
  id: "1a2b3c4d-0000-0000-0000-000000000000", kind: "metric", name: "cost today", label: "`./cost-today` moves more than 20% from its 7-day median",
  then: "open a terminal: explain it (skill explain-cost)", enabled: true, next_check_at: null, last_check: "100 — within ±20%",
  last_fire: null, target: "./cost-today", dedupe: "{trigger}", rate_max: 3, rate_window_sec: 86400, every_sec: null, cron: "0 9 * * *", fires: [],
};

test("mc trigger add sends the condition, the action and the knobs", async () => {
  const r = await withApi(() => ROW, [
    "trigger", "add", "metric", "./cost-today", "--within", "20%", "--cron", "0 9 * * *", "--skill", "explain-cost", "--goal", "explain it", "--rate", "1/day",
  ]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.seen.length, 1);
  assert.equal(r.seen[0].method, "POST");
  assert.equal(r.seen[0].url, "/api/ws-triggers");
  const b = r.seen[0].body;
  assert.equal(b.kind, "metric");
  assert.equal(b.target, "./cost-today");
  assert.equal(b.within, "20%");
  assert.equal(b.cron, "0 9 * * *");
  assert.equal(b.skill, "explain-cost");
  assert.equal(b.goal, "explain it");
  assert.equal(b.rate, "1/day");
  assert.equal(b.lines, null, "a flag not given is not sent as false");
  assert.match(r.out, /⚡ 1a2b3c4d armed: when `\.\/cost-today` moves more than 20%/);
});

test("mc trigger test: an id8 tests the saved one, a condition tests a draft — boolean flags after the words", async () => {
  const report = { saw: "3 line(s) · 1 new", held: ["quiet hours (22-07)"], events: [{ evidence: "c.csv", would: "open a terminal: load {subject}" }] };
  const saved = await withApi(() => report, ["trigger", "test", "1a2b3c4d"]);
  assert.equal(saved.code, 0, saved.out);
  assert.deepEqual(saved.seen.map((s) => `${s.method} ${s.url}`), ["POST /api/ws-triggers/1a2b3c4d/test"]);
  assert.match(saved.out, /would wait: quiet hours/);
  assert.match(saved.out, /event: c\.csv\n {4}→ open a terminal/);
  assert.match(saved.out, /a dry run: nothing was opened/);

  const draft = await withApi(() => report, ["trigger", "test", "command", "ls", "~/drop", "--lines", "--inbox"]);
  assert.equal(draft.code, 0, draft.out);
  assert.equal(draft.seen[0].url, "/api/ws-triggers/test");
  assert.equal(draft.seen[0].body.kind, "command");
  assert.equal(draft.seen[0].body.target, "ls ~/drop");
  assert.equal(draft.seen[0].body.lines, true);
  assert.equal(draft.seen[0].body.inbox, true);
});

test("mc trigger pause / resume / rm / list", async () => {
  const pause = await withApi(() => ({ ...ROW, enabled: false }), ["trigger", "pause", "1a2b3c4d", "too", "noisy"]);
  assert.equal(pause.code, 0, pause.out);
  assert.deepEqual(pause.seen[0], { method: "PATCH", url: "/api/ws-triggers/1a2b3c4d", body: { enabled: false, why: "too noisy" } });
  const resume = await withApi(() => ROW, ["trigger", "resume", "1a2b3c4d"]);
  assert.deepEqual(resume.seen[0].body, { enabled: true });
  const rm = await withApi(() => ({ ok: true }), ["trigger", "rm", "1a2b3c4d"]);
  assert.equal(rm.seen[0].method, "DELETE");
  const list = await withApi(() => [ROW, { ...ROW, id: "9f8e7d6c-0000", enabled: false, paused_reason: "proposed by terminal abcdef12" }], ["trigger", "list"]);
  assert.equal(list.code, 0, list.out);
  assert.match(list.out, /● 1a2b3c4d \[metric\] cost today\n {4}when .* → open a terminal: explain it .* · never fired/);
  assert.match(list.out, /○ 9f8e7d6c .*\n.*\n {4}off: proposed by terminal abcdef12/);
});

test("mc trigger add --help prints usage and sends nothing", async () => {
  const r = await withApi(() => ROW, ["trigger", "add", "--help"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.seen.length, 0);
  assert.match(r.out, /mc trigger add <condition>/);
});
