/**
 * `mc robert outbox` against a stand-in API: which route it calls with which flags, as whom, and the
 * short lines it prints. The record itself is tested in src/robert-outbox.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mc");
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
const ROWS = [
  { id: "1", workspace: "acme", source: "wake", status: "delivered", reason: null, body: "Merged PR #12 for terminal abc.", created_at: ago(5) },
  { id: "2", workspace: "acme", source: "wake", status: "suppressed", reason: "repeat", body: "Terminal abc is\nwaiting on your OK.", created_at: ago(90) },
  { id: "3", workspace: null, source: "failover", status: "held", reason: "desk posts off", body: "z".repeat(200), created_at: ago(180) },
];

async function withApi(rows, args, extraEnv = {}) {
  const seen = [];
  const srv = http.createServer((q, s) => {
    seen.push({ url: q.url, token: q.headers["x-mc-workspace-token"] ?? null, admin: q.headers["x-mc-admin"] ?? null });
    s.setHeader("content-type", "application/json");
    s.end(JSON.stringify({ rows }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const api = `http://127.0.0.1:${srv.address().port}/api`;
    // A stand-in admin token: the operator's own token file is never read by a test.
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, MC_SESSION: "", MC_WORKSPACE: "", CHRONOS_ADMIN_TOKEN: "test-admin", ...extraEnv, MC_API: api };
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

test("mc robert outbox prints one short line per thing said, newest first, and a count", async () => {
  const r = await withApi(ROWS, ["robert", "outbox"]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.seen.map((s) => s.url), ["/api/robert/outbox?since=24h"]);
  assert.equal(r.seen[0].admin, "test-admin", "the operator's shell asks as the operator");
  const lines = r.out.trimEnd().split("\n");
  assert.equal(lines[0], "●  5m acme · wake · shown · Merged PR #12 for terminal abc.");
  assert.equal(lines[1], "⊘  2h acme · wake · repeat, not posted · Terminal abc is waiting on your OK.");
  assert.equal(lines[2], `○  3h default · failover · held (desk posts off) · ${"z".repeat(109)}…`);
  assert.equal(lines[3], "3 said · 1 shown · 1 held · 1 repeats not posted");
});

test("mc robert outbox passes --since, --ws and --status through, and --json prints the rows as they came", async () => {
  const r = await withApi(ROWS.slice(0, 1), ["robert", "outbox", "--since", "2h", "--ws", "acme", "--status", "held", "--json"]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.seen.map((s) => s.url), ["/api/robert/outbox?since=2h&ws=acme&status=held"]);
  assert.deepEqual(JSON.parse(r.out), ROWS.slice(0, 1));
});

test("inside a terminal it asks as its workspace, and says so when there is nothing", async () => {
  const r = await withApi([], ["robert", "outbox"], { MC_WORKSPACE_TOKEN: "tok-acme" });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.seen[0].token, "tok-acme");
  assert.equal(r.seen[0].admin, null, "never the operator's token from inside a terminal");
  assert.match(r.out, /Robert said nothing on his own in that window/);
});
