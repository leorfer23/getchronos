/**
 * `mc state waiting --on X` against a stand-in API on a loopback port: the words agents reach for
 * (a long query, a job re-run) are real values, and any other word still records the wait — as
 * `other`, with a note on stderr — instead of exiting 1 and losing the state.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mc");

const posted = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.method === "POST" && req.url === "/api/sessions/sess-1234/status") {
      const body = JSON.parse(raw);
      posted.push(body);
      return res.end(JSON.stringify({ word: body.state, line: `waiting on ${body.on}` }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not here" }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());
const ENV = { MC_API: `http://127.0.0.1:${server.address().port}/api`, MC_SESSION: "sess-1234", MC_WORKSPACE: "ws-1" };

function run(...args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [mc, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...ENV } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("--on query and --on job are recorded as given", async () => {
  for (const on of ["query", "job", "ci"]) {
    posted.length = 0;
    const r = await run("state", "waiting", "warehouse", "--on", on);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.deepEqual(posted, [{ state: "waiting", label: "warehouse", on }]);
  }
});

test("--on run is a job re-run", async () => {
  posted.length = 0;
  const r = await run("state", "waiting", "--on", "run");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.equal(posted[0].on, "job");
});

test("an unknown --on still records the wait, as other, with a one-line note", async () => {
  posted.length = 0;
  const r = await run("state", "waiting", "the migration", "--on", "migration");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(posted.length, 1, "the state reached the API");
  assert.equal(posted[0].on, "other");
  assert.equal(posted[0].label, "the migration");
  assert.match(r.stderr, /'migration'.*recorded as 'other'/);
  assert.equal(r.stderr.trim().split("\n").length, 1);
});
