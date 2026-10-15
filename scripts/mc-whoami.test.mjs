/**
 * `mc whoami`, and the computer column in `mc session list` / `mc repo list` (HOSTS.md → "Agents know
 * where they are"), against a stand-in API on a loopback port — the shape the brain (or a host's mc
 * forwarder in front of it) answers with.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mc");

const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, session: req.headers["x-mc-session"] });
  const send = (body, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/api/sessions/sess-old-1234") return send({ id: "sess-old-1234", host_id: "h_m5", host_name: "m5" });
  if (req.url?.startsWith("/api/sessions/")) return send({ id: "x", host_id: "h_m2", host_name: "m2" });
  if (req.url?.startsWith("/api/sessions?")) return send([
    { id: "aaaaaaaa1111", host_id: "local", host_name: "atlas", backend: "claude-code", model: null, role: "human", title: "here" },
    { id: "bbbbbbbb2222", host_id: "h_m2", host_name: "m2", backend: "claude-code", model: null, role: "worker", title: "there" },
  ]);
  if (req.url?.startsWith("/api/workspaces")) return send([{ id: "ws-1-abcdefgh", slug: "acme", repos: [
    { id: "r-web-0001", name: "web", path: "/Users/brain/web", host_path: "/Users/op/code/web" },
    { id: "r-api-0002", name: "api", path: "/Users/brain/api", host_path: null },
  ] }]);
  send({ error: "not here" }, 404);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());
const API = `http://127.0.0.1:${server.address().port}/api`;

function run(env, ...args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [mc, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const ON_M2 = { MC_API: API, MC_HOST_ID: "h_m2", MC_HOST_NAME: "m2", MC_HOST_BRAIN: "0", MC_SESSION: "sess-m2-5678", MC_WORKSPACE: "ws-1-abcdefgh", MC_WORKSPACE_NAME: "Acme", MC_REPO: "r-web-0001", MC_REPO_NAME: "web" };

test("mc whoami on a host: the computer first, and that its localhost is not the operator's", async () => {
  const r = await run(ON_M2, "whoami");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^host\s+m2 \(h_m2\) — another computer/m);
  assert.match(r.stdout, /^workspace\s+Acme \(ws-1-abc\)/m);
  assert.match(r.stdout, /^repo\s+web \(r-web-00\)/m);
  assert.match(r.stdout, /^session\s+sess-m2-/m);
  assert.match(r.stdout, /^cwd\s+\//m);
  assert.match(r.stdout, new RegExp(`^api\\s+${API.replace(/[.]/g, "\\.")}`, "m"));
  assert.match(r.stdout, /^brain\s+reachable/m);
  assert.ok(seen.some((s) => s.url === "/api/sessions/sess-m2-5678" && s.session === "sess-m2-5678"), "asked the brain about itself, as itself");
});

test("mc whoami on the brain, and --json", async () => {
  const r = await run({ MC_API: API, MC_HOST_ID: "local", MC_HOST_NAME: "atlas", MC_HOST_BRAIN: "1" }, "whoami", "--json");
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.host_id, "local");
  assert.equal(j.host_name, "atlas");
  assert.equal(j.brain, true);
  assert.equal(j.session, null);
  assert.equal(j.brain_reachable, null, "no session to ask about: no call");
});

test("mc whoami without MC_HOST_* (an older terminal) asks the brain where it runs", async () => {
  const r = await run({ MC_API: API, MC_SESSION: "sess-old-1234" }, "whoami", "--json");
  const j = JSON.parse(r.stdout);
  assert.deepEqual([j.host_id, j.host_name, j.brain], ["h_m5", "m5", false]);
});

test("mc whoami still answers when the brain does not", async () => {
  const r = await run({ ...ON_M2, MC_API: "http://127.0.0.1:1/api" }, "whoami");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^host\s+m2/m);
  assert.match(r.stdout, /^brain\s+unreachable/m);
});

test("mc session list shows each terminal's computer", async () => {
  const r = await run({ MC_API: API }, "session", "list");
  assert.equal(r.status, 0, r.stderr);
  const rows = r.stdout.trim().split("\n").map((l) => l.split("\t"));
  assert.deepEqual(rows.map((c) => [c[0], c[1]]), [["aaaaaaaa", "atlas"], ["bbbbbbbb", "m2"]]);
});

test("mc repo list from a host shows that host's checkout, or that it has none", async () => {
  const r = await run(ON_M2, "repo", "list");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\tweb\t\/Users\/op\/code\/web\t/);
  assert.match(r.stdout, /\tapi\t\(not on this host\)\t/);
  assert.doesNotMatch(r.stdout, /\/Users\/brain\//, "never the brain's path");
});

test("mc help lists whoami", async () => {
  const r = await run({ MC_API: "http://127.0.0.1:1/api" }, "help");
  assert.match(r.stdout, /mc whoami/);
});
