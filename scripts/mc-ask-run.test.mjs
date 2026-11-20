/**
 * `mc ask-run` against a stand-in API on a loopback port: the command is the agent's words exactly —
 * flags included, quoting kept, or after `--`, or from stdin — only `--why` is mc's; it sends where the
 * agent is (its cwd) as that terminal, and tells the agent to end its turn. Outside a Desk terminal, or
 * with no why, it refuses before asking anything.
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mc");

const posted = [];
let reply = (body) => ({ status: 201, json: { id: "1a2b3c4d-0000-4000-8000-000000000000", status: "open", superseded: [], ...body } });
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/api/sessions/sess-1234/run-asks") {
      const body = JSON.parse(raw);
      posted.push({ body, headers: { ws: req.headers["x-mc-workspace-token"], session: req.headers["x-mc-session"] } });
      const r = reply(body);
      res.statusCode = r.status;
      return res.end(JSON.stringify(r.json));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not here" }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());
beforeEach(() => { posted.length = 0; });
const ENV = { MC_API: `http://127.0.0.1:${server.address().port}/api`, MC_SESSION: "sess-1234", MC_WORKSPACE: "ws-1", MC_WORKSPACE_TOKEN: "tok-ws-1" };
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mc-ask-run-")));

function run(args, { env = ENV, stdin = null } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [mc, ...args], { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
    if (stdin != null) p.stdin.end(stdin); else p.stdin.end();
  });
}

test("the quoted command goes as written — its own flags too — with the why and the cwd, as this terminal", async () => {
  const r = await run(["ask-run", "TO={{your email}} bash /tmp/mail/send.sh --dry-run", "--why", "send the test email to you"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(posted, [{
    body: { command: "TO={{your email}} bash /tmp/mail/send.sh --dry-run", why: "send the test email to you", cwd },
    headers: { ws: "tok-ws-1", session: "sess-1234" },
  }]);
  assert.match(r.stdout, /^asked the operator to run it \(ask 1a2b3c4d\)\. He runs it from his Desk after filling in \{\{your email\}\}, behind this terminal's sandbox/);
  assert.match(r.stdout, /End your turn now/);
});

test("unquoted words are the command, an unknown --flag included; after -- everything is, --why too", async () => {
  let r = await run(["ask-run", "ls", "-la", "--all", "/tmp", "--why=see what is there"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([posted[0].body.command, posted[0].body.why], ["ls -la --all /tmp", "see what is there"]);
  r = await run(["ask-run", "--why", "grep for it", "--", "grep", "--why", "-r", "x"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([posted[1].body.command, posted[1].body.why], ["grep --why -r x", "grep for it"]);
});

test("from stdin, quotes and newlines intact", async () => {
  const script = `printf '%s\\n' "it's here" \\\n  | wc -l`;
  const r = await run(["ask-run", "--why", "count it"], { stdin: script + "\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(posted[0].body.command, script);
});

test("it says so when its ask replaced the one he had not answered", async () => {
  reply = (body) => ({ status: 201, json: { id: "9f8e7d6c-0000-4000-8000-000000000000", status: "open", superseded: ["1a2b3c4d-0000-4000-8000-000000000000"], ...body } });
  const r = await run(["ask-run", "ls", "--why", "look"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\(ask 9f8e7d6c\) — it replaces your earlier ask\./);
});

test("refused before asking: outside a terminal, with no why, with no command — and the daemon's refusal is said as is", async () => {
  let r = await run(["ask-run", "ls", "--why", "look"], { env: { ...ENV, MC_SESSION: "" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only works inside a Desk terminal/);
  r = await run(["ask-run", "ls"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /say why only the operator can run it/);
  r = await run(["ask-run", "--why", "look"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no command/);
  assert.equal(posted.length, 0, "nothing was asked");
  reply = () => ({ status: 409, json: { error: "this terminal runs on m2, not this Mac — run it on that machine yourself" } });
  r = await run(["ask-run", "ls", "--why", "look"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /mc: this terminal runs on m2, not this Mac/);
  r = await run(["ask-run", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^usage: mc ask-run "<exact command>" --why/);
});
