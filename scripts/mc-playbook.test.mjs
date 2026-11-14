/**
 * `mc playbook` against a stand-in API: what an agent's commands send, and that a refused step makes
 * mc exit non-zero (the agent stops) — the daemon's side is src/playbook-routes.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mc");

async function withApi(reply, args, extraEnv = {}) {
  const seen = [];
  const srv = http.createServer((q, s) => {
    let body = "";
    q.on("data", (b) => (body += b));
    q.on("end", () => {
      seen.push({ method: q.method, url: q.url, session: q.headers["x-mc-session"] ?? null, body: body ? JSON.parse(body) : null });
      const [status, out] = reply(q.method, q.url);
      s.statusCode = status;
      s.setHeader("content-type", "application/json");
      s.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const api = `http://127.0.0.1:${srv.address().port}/api`;
    const child = spawn(process.execPath, [mc, ...args], {
      env: { ...process.env, MC_WORKSPACE_TOKEN: "ws-token", MC_SESSION: "sess1234-0000", MC_WORKSPACE: "", ...extraEnv, MC_API: api },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    const code = await new Promise((r) => child.on("close", r));
    return { code, out, seen };
  } finally {
    srv.close();
  }
}

const view = { id: "pb1", name: "release", workspace_slug: "acme", steps: [{}, {}], gates: [{ idx: 1, gate: "merge" }], text: "[merge] gh pr merge {{pr}}\nmake release", source: "session", notes: ["started at the first merge"] };
const run = { id: "run12345-aaaa", name: "release", state: "running", reason: null, progress: { done: 1, total: 3 }, pr_url: null, steps: [] };

test("mc playbook save --from-session drafts from THIS terminal", async () => {
  const r = await withApi(() => [201, view], ["playbook", "save", "release", "--from-session"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.seen.length, 1);
  assert.equal(r.seen[0].method, "POST");
  assert.equal(r.seen[0].url, "/api/playbooks");
  assert.deepEqual(r.seen[0].body, { name: "release", from_session: "sess1234-0000" });
  assert.match(r.out, /saved release \(acme\)[\s\S]*a DRAFT from what the terminal ran/);
});

test("mc playbook step works this terminal's live run and prints exactly what to run", async () => {
  const r = await withApi((m, u) => (m === "GET" ? [200, [run]] : [200, { run, step: 2, command: "make release", carried: null, kind: "shell" }]), ["playbook", "step", "2", "start"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.seen[0].url, "/api/playbook-runs?limit=1&session=sess1234-0000");
  assert.equal(r.seen[1].url, `/api/playbook-runs/${run.id}/steps/2/start`);
  assert.equal(r.seen[1].session, "sess1234-0000", "the call says which terminal it is");
  assert.match(r.out, /▶ step 2 — do exactly this[\s\S]*\nmake release\n/);
});

test("a refused step exits non-zero, and a failure needs its reason", async () => {
  const refused = await withApi((m) => (m === "GET" ? [200, [run]] : [409, { error: "the PR head moved after the OK", stop: true }]), ["playbook", "step", "3", "start", "--run", run.id]);
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /step 3 start refused — the PR head moved after the OK/);
  const bare = await withApi(() => [200, {}], ["playbook", "step", "3", "fail"]);
  assert.equal(bare.code, 1);
  assert.equal(bare.seen.length, 0, "nothing is sent without saying what failed");
  const failed = await withApi((m) => (m === "GET" ? [200, [run]] : [200, { run: { ...run, state: "failed" }, step: 3 }]), ["playbook", "step", "3", "fail", "upload", "timed", "out"]);
  assert.equal(failed.code, 0, failed.out);
  assert.deepEqual(failed.seen[1].body, { error: "upload timed out" });
  assert.match(failed.out, /the run stopped and the operator was asked/);
});
