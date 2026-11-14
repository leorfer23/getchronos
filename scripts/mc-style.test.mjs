/**
 * `mc style` against a stand-in API: which route each subcommand calls, with what, and what it prints.
 * The house style itself is tested in src/house-style.test.ts; this is the CLI's half.
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
      seen.push({ method: q.method, url: q.url, body: body ? JSON.parse(body) : null, token: q.headers["x-mc-workspace-token"] ?? null });
      s.setHeader("content-type", "application/json");
      s.end(JSON.stringify(reply(q.method, q.url)));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const api = `http://127.0.0.1:${srv.address().port}/api`;
    const env = { ...process.env, MC_LEAD: "", MC_SESSION: "", MC_WORKSPACE: "ws-a", MC_WORKSPACE_TOKEN: "tok-a", ...extraEnv, MC_API: api };
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

test("mc style --kind report prints this workspace's house style for a report", async () => {
  const r = await withApi(() => ({ text: "# House style — Acme · report\nTHE-BAR" }), ["style", "--kind", "report"]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.seen.map((s) => `${s.method} ${s.url}`), ["GET /api/workspaces/ws-a/style?kind=report"]);
  assert.equal(r.seen[0].token, "tok-a", "as the workspace, with its own token");
  assert.match(r.out, /THE-BAR/);
  const bare = await withApi(() => ({ text: "x" }), ["style", "artifact"]);
  assert.equal(bare.seen[0].url, "/api/workspaces/ws-a/style?kind=artifact");
  const bad = await withApi(() => ({ text: "x" }), ["style", "--kind", "poster"]);
  assert.notEqual(bad.code, 0);
  assert.equal(bad.seen.length, 0);
});

test("mc style add saves his words; mc style critique reads this terminal's verdict", async () => {
  const add = await withApi(() => ({ added: true, note: {} }), ["style", "add", "No", "pie", "charts"], { MC_SESSION: "sess-1" });
  assert.equal(add.code, 0, add.out);
  assert.deepEqual(add.seen.map((s) => [s.method, s.url, s.body]), [["POST", "/api/workspaces/ws-a/style/notes", { text: "No pie charts" }]]);
  assert.match(add.out, /saved ✓/);
  const crit = await withApi(() => ({
    critique: {
      status: "fail", note: "(full list: mc style critique) remove 1: the donut", ran_at: "2026-11-13T10:00:00.000Z",
      evidence: [
        { ref: "run:r1", label: "claude-code sonnet", meta: { remove: "the donut — 9 slices", fixes: "title the revenue chart · phone: stack the tiles" } },
        { ref: "/api/workspaces/ws-a/critic/p/p1-phone-1.png", label: "page · phone", meta: { file: "/tmp/critic/p1-phone-1.png" } },
      ],
    },
  }), ["style", "critique"], { MC_SESSION: "sess-1" });
  assert.equal(crit.code, 0, crit.out);
  assert.equal(crit.seen[0].url, "/api/workspaces/ws-a/style/critique?session=sess-1");
  assert.match(crit.out, /✗ not ready/);
  assert.match(crit.out, /Remove:\n {2}- the donut — 9 slices/);
  assert.match(crit.out, /Fix:\n {2}- title the revenue chart\n {2}- phone: stack the tiles/);
  assert.match(crit.out, /page · phone — \/tmp\/critic\/p1-phone-1\.png/);
});
