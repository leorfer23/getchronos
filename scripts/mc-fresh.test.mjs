/**
 * One goal, one terminal (src/fresh-terminal.ts) as `mc` says it, against a stand-in API:
 * `mc goal set` passes on the daemon's fresh-terminal hint, `mc session send --goal` marks new work and
 * reports the terminal the daemon opened instead, `mc session new --from` carries the hand-off.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mc");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mc-fresh-home-"));

const DONE = "aaaaaaaa-1111-4111-8111-111111111111";
const FRESH = "bbbbbbbb-2222-4222-8222-222222222222";
const seen = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ method: req.method, url: req.url, body });
    const send = (b, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (req.method === "PATCH" && req.url === "/api/sessions/sess-me") {
      return send({
        id: "sess-me", goal: body.goal, done_when: [],
        ...(body.goal === "release the new version"
          ? { fresh: { from_goal: "open the rollback PR", command: 'mc session new --from sess-me --goal "release the new version"', say: '↪ A different goal in a finished terminal: …\n  He or Robert runs it (a terminal cannot open one): mc session new --from sess-me --goal "release the new version"' } }
          : {}),
      });
    }
    if (req.method === "GET" && req.url?.startsWith("/api/sessions")) return send([{ id: DONE, role: "human", workspace_id: "ws-1" }]);
    if (req.method === "POST" && req.url === `/api/sessions/${DONE}/input`) {
      return body.goal
        ? send({ ok: true, from: DONE, from_goal: "open the rollback PR", opened: { id: FRESH, goal: body.goal } }, 201)
        : send({ ok: true });
    }
    if (req.method === "POST" && req.url === "/api/sessions") return send({ id: FRESH, backend: "claude-code", model: null }, 201);
    send({ error: "not here" }, 404);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());
const API = `http://127.0.0.1:${server.address().port}/api`;

function run(env, ...args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [mc, ...args], { env: { PATH: process.env.PATH, HOME, MC_API: API, ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
const last = (method, url) => [...seen].reverse().find((s) => s.method === method && s.url === url);
const TERMINAL = { MC_SESSION: "sess-me", MC_WORKSPACE: "ws-1", MC_WORKSPACE_TOKEN: "ws-token" };
const ROBERT = { CHRONOS_ADMIN: "robert-credential", MC_AGENT_NAME: "robert", MC_WORKSPACE: "ws-1", MC_REPO: "r-unrelated" };

test("mc goal set: the daemon's fresh-terminal hint is printed under the goal; a plain set prints none", async () => {
  const r = await run(TERMINAL, "goal", "set", "release the new version");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^🎯 release the new version/m);
  assert.match(r.stdout, /mc session new --from sess-me --goal "release the new version"/);
  const plain = await run(TERMINAL, "goal", "set", "open the rollback PR against develop");
  assert.equal(plain.status, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /session new --from/);
});

test("mc session send --goal: new work is marked as such, and the fresh terminal is named", async () => {
  const r = await run(ROBERT, "session", "send", "aaaaaaaa", "Cut the release and upload it.", "--goal", "release the new version");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(last("POST", `/api/sessions/${DONE}/input`).body, { text: "Cut the release and upload it.", enter: true, by: "robert", goal: "release the new version" });
  assert.match(r.stdout, /↪ aaaaaaaa had finished its goal \("open the rollback PR"\) — opened bbbbbbbb in the same workspace and repo/);

  const follow = await run(ROBERT, "session", "send", "aaaaaaaa", "fix the review comments");
  assert.equal(follow.status, 0, follow.stderr);
  assert.equal(last("POST", `/api/sessions/${DONE}/input`).body.goal, undefined, "a follow-up carries no goal");
  assert.match(follow.stdout, /^→ aaaaaaaa "fix the review comments"/m);
});

test("mc session new --from: the full id goes up, the repo is the finished terminal's (not this shell's MC_REPO)", async () => {
  const r = await run(ROBERT, "session", "new", "--from", "aaaaaaaa", "--goal", "release the new version");
  assert.equal(r.status, 0, r.stderr);
  const body = last("POST", "/api/sessions").body;
  assert.equal(body.from, DONE);
  assert.equal(body.repo_id, null);
  assert.equal(body.workspace_id, "ws-1");
  assert.equal(body.goal, "release the new version");
  assert.equal(body.role, "human", "it follows an operator's terminal");
  assert.match(r.stdout, /spawned session bbbbbbbb .*with the hand-off from aaaaaaaa/);
});
