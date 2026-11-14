/**
 * `mc retro` — the weekly retro job's own loop against a stand-in API: context needs the run it was
 * given, apply posts the plan to its own workspace with its workspace token, and a refusal lists every
 * problem; show prints the week and what waits on the operator.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mc");

async function withApi(reply, args, extraEnv = {}, stdin = null) {
  const seen = [];
  const srv = http.createServer((q, s) => {
    let body = "";
    q.on("data", (c) => (body += c));
    q.on("end", () => {
      seen.push({ line: `${q.method} ${q.url}`, token: q.headers["x-mc-workspace-token"] ?? null, body });
      const [status, json] = reply(q.method, q.url, body);
      s.statusCode = status;
      s.setHeader("content-type", "application/json");
      s.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const api = `http://127.0.0.1:${srv.address().port}/api`;
    const child = spawn(process.execPath, [mc, ...args], {
      env: { ...process.env, MC_SESSION: "", MC_LEAD: "", MC_WORKSPACE: "ws-1", MC_WORKSPACE_TOKEN: "tok-1", ...extraEnv, MC_API: api },
      stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (stdin !== null) { child.stdin.write(stdin); child.stdin.end(); }
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    const code = await new Promise((r) => child.on("close", r));
    return { code, out, seen };
  } finally {
    srv.close();
  }
}

test("mc retro context needs the run it was given, and reads its own workspace's bundle", async () => {
  const none = await withApi(() => [200, {}], ["retro", "context"]);
  assert.equal(none.code, 1);
  assert.match(none.out, /needs --run/);
  assert.equal(none.seen.length, 0, "nothing is asked of the daemon without a run");
  const r = await withApi(() => [200, { run: "run-1", candidates: [] }], ["retro", "context", "--run", "run-1"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.seen[0].line, "GET /api/workspaces/ws-1/retro/context?run=run-1");
  assert.equal(r.seen[0].token, "tok-1");
});

test("mc retro apply posts the plan with the workspace token; a refusal prints every problem and exits 1", async () => {
  const plan = JSON.stringify({ run: "run-1", rules: [{ from: ["c1"], rule: "Save every export to ~/Downloads." }] });
  const ok = await withApi(() => [200, { run: "run-1", proposed: [{ text: "Save every export to ~/Downloads." }], skipped: [{ text: "DM the operator when done.", why: "dismissed before — never proposed again" }] }], ["retro", "apply"], {}, plan);
  assert.equal(ok.code, 0, ok.out);
  assert.equal(ok.seen[0].line, "POST /api/workspaces/ws-1/retro/apply");
  assert.equal(ok.seen[0].token, "tok-1");
  assert.deepEqual(JSON.parse(ok.seen[0].body), JSON.parse(plan));
  assert.match(ok.out, /1 proposal\(s\) waiting on the operator/);
  assert.match(ok.out, /skipped "DM the operator when done\." — dismissed before/);
  const bad = await withApi(() => [400, { error: "x", problems: ["rules[0]: c9 is not a candidate of this run", "notes is 1300/1200 chars — cut it"] }], ["retro", "apply"], {}, plan);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /- rules\[0\]: c9 is not a candidate of this run\n- notes is 1300\/1200 chars/);
  const notJson = await withApi(() => [200, {}], ["retro", "apply"], {}, "{nope");
  assert.equal(notJson.code, 1);
  assert.match(notJson.out, /not valid JSON/);
  assert.equal(notJson.seen.length, 0);
});

test("mc retro show prints the week, the KPIs beside last week, and what waits on the operator", async () => {
  const r = await withApi(() => [200, {
    run: { report: "## Weekly retro · Acme\n- Verifier sent work back 3×" },
    kpis: { rejection_rate: 0.5, repeat_asks: 4, infra: 2, duplicates: 0 },
    last_week: { rejection_rate: 0.75, repeat_asks: 1, infra: 2, duplicates: 1 },
    pending: [{ id: "abcdef0123", text: "Save every export to ~/Downloads." }],
  }], ["retro"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.seen[0].line, "GET /api/workspaces/ws-1/retro");
  assert.match(r.out, /Verifier sent work back 3×/);
  assert.match(r.out, /verifier 0\.5\/hand-off \(last week 0\.75\) · repeat asks 4 \(last week 1\)/);
  assert.match(r.out, /abcdef01  Save every export to ~\/Downloads\./);
});
