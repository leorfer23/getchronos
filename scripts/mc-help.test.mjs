/**
 * `mc session new --help` must print usage and NEVER open a terminal.
 *
 * Regression: parse() used to swallow `--help` as an ignored option, then
 * `session new` POSTed /sessions with no goal → blank card on the Desk.
 * Robert's workaround was "never run mc session new --help" (memory-robert.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mc");
// Anything that actually hits the API would fail hard against this port.
const env = { ...process.env, MC_API: "http://127.0.0.1:1/api" };

function run(...args) {
  return spawnSync(process.execPath, [mc, ...args], { env, encoding: "utf8" });
}

for (const args of [
  ["session", "new", "--help"],
  ["session", "new", "-h"],
  ["--help"],
  ["session", "new", "--backend", "grok", "--help"],
]) {
  test(`mc ${args.join(" ")} prints usage and does not spawn`, () => {
    const r = run(...args);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /mc session new/);
    assert.doesNotMatch(
      `${r.stdout}${r.stderr}`,
      /spawned session|ECONNREFUSED|fetch failed|connect/i,
    );
  });
}

// mc against a stand-in API: records every request, answers with reply(method, url).
async function withApi(reply, args, extraEnv = {}) {
  const seen = [];
  const srv = http.createServer((q, s) => {
    seen.push(`${q.method} ${q.url}`);
    s.setHeader("content-type", "application/json");
    s.end(JSON.stringify(reply(q.method, q.url)));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const api = `http://127.0.0.1:${srv.address().port}/api`;
    const child = spawn(process.execPath, [mc, ...args], { env: { ...env, MC_WORKSPACE: "", MC_SESSION: "", MC_LEAD: "", ...extraEnv, MC_API: api }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    const code = await new Promise((r) => child.on("close", r));
    return { code, out, seen };
  } finally {
    srv.close();
  }
}

test("mc host is mc hosts — never 'unknown command'", async () => {
  const r = await withApi(() => ({ hosts: [] }), ["host", "list"]);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.seen.length && r.seen.every((u) => u.startsWith("GET /api/hosts")), JSON.stringify(r.seen));
  assert.doesNotMatch(r.out, /unknown command/);
});

test("a new terminal's line says which computer it landed on", async () => {
  const remote = await withApi(() => ({ id: "aaaaaaaa1111", backend: "claude-code", model: null, host_name: "m2", placement: "least loaded" }), ["session", "new", "--goal", "x"]);
  assert.equal(remote.code, 0, remote.out);
  assert.match(remote.out, /spawned session aaaaaaaa \(claude-code\/·\) → m2 \(least loaded\)/);
  const here = await withApi(() => ({ id: "bbbbbbbb2222", backend: "claude-code", host_name: null }), ["lead", "new", "ship", "it"]);
  assert.equal(here.code, 0, here.out);
  assert.match(here.out, /spawned lead bbbbbbbb → the brain — ship it/);
});

for (const [args, extra] of [
  [["ask"], { MC_RUN: "run-x" }],
  [["ask-robert"], { MC_SESSION: "sess-x" }],
  [["ask-lead"], { MC_SESSION: "sess-x" }],
]) {
  test(`mc ${args[0]}: an over-long question fails in one plain line, before anything is filed`, () => {
    const r = spawnSync(process.execPath, [mc, ...args, "x".repeat(1001)], { env: { ...env, ...extra }, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /question is 1001 chars; max 1000/);
    assert.doesNotMatch(r.stderr, /ECONNREFUSED|fetch failed|too_big|ZodError/i);
  });
}

test("the ask cap is in the help", () => {
  const r = run("--help");
  for (const c of ["mc ask ", "mc ask-robert ", "mc ask-lead "]) {
    const line = r.stdout.split("\n").find((l) => l.trimStart().startsWith(c));
    assert.match(line ?? "", /≤1000 chars/, c);
  }
});

// `mc browser run -- <cmd>`: lease, hand the command the endpoint + context in its env, give the lease
// back when it exits — with the command's own exit code.
test("mc browser run exports the lease to the command and releases it on exit", async () => {
  const lease = { granted: true, lease_id: "lease-1", ws_endpoint: "ws://127.0.0.1:9/devtools/browser/h", context_id: "CTX1", expires_at: 1, host_id: "local" };
  const r = await withApi(
    (m) => (m === "POST" ? lease : { released: true }),
    ["browser", "run", "--", process.execPath, "-e", "console.log('ENV', process.env.CHRONOS_BROWSER_WS, process.env.CHRONOS_BROWSER_CONTEXT); process.exit(3)"],
  );
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /ENV ws:\/\/127\.0\.0\.1:9\/devtools\/browser\/h CTX1/);
  assert.deepEqual(r.seen, ["POST /api/browser/leases", "DELETE /api/browser/leases/lease-1"]);
});

test("mc browser run with no engine fails in one line and never runs the command", async () => {
  const srv = http.createServer((q, s) => { s.statusCode = 503; s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ granted: false, error: "no headless browser installed on this machine — install one: npx x" })); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const api = `http://127.0.0.1:${srv.address().port}/api`;
    // Async spawn: a spawnSync would block this process's stand-in API and deadlock.
    const child = spawn(process.execPath, [mc, "browser", "run", "--", process.execPath, "-e", "console.log('RAN')"], { env: { ...env, MC_API: api }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    const code = await new Promise((r) => child.on("close", r));
    assert.equal(code, 1);
    assert.match(stderr, /mc: no browser lease — no headless browser installed/);
    assert.doesNotMatch(stdout, /RAN/);
  } finally {
    srv.close();
  }
});

test("mc browser status prints the machine's browser and the caller's leases", async () => {
  const r = await withApi(() => ({
    host_id: "local",
    browser: { engine: "chrome-headless-shell", version: "153.0", pid: 42, running: true, in_use: 1, cap: 8, per_ws: 4, waiting: 0, idle_stops_at: null },
    leases: [{ lease_id: "abcdef0123", label: "npm run e2e", held_ms: 5000, session_id: "sess-1234567", host_id: "local" }],
  }), ["browser", "status"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /browser running \(pid 42\) · chrome-headless-shell 153\.0 · contexts 1\/8 \(4\/workspace fair share\)/);
  assert.match(r.out, /abcdef01\s+npm run e2e/);
});
