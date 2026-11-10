/**
 * Who may call what, asked of the running API rather than read out of api.ts.
 *
 * Operator-only routes refuse every credential short of the admin token: another workspace's
 * token, a Lead's, none at all. Per-workspace routes answer the owning workspace and give another
 * workspace a 404 — the same answer an id that does not exist gets, so ids cannot be probed.
 * Each refusal is paired with a call that gets through, so a route that vanished (404 for
 * everyone) cannot pass for one that is guarded.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const PORT = await new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
process.env.CHRONOS_PORT = String(PORT);

const { startServer } = await import("./api.js");
const { CONFIG } = await import("./config.js");
const { sessions, workspaces, repos, asks } = await import("./store.js");
const noteSvc = await import("./notes.js");

const base = `http://127.0.0.1:${PORT}/api`;
let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-guards-"));
const A = workspaces.create({ slug: `gd-a-${Date.now()}`, name: "Acme", config_dir: path.join(tmp, "cfg-a"), default_dir: path.join(tmp, "a") } as any);
const B = workspaces.create({ slug: `gd-b-${Date.now()}`, name: "Initech", config_dir: path.join(tmp, "cfg-b"), default_dir: path.join(tmp, "b") } as any);
const json = { "content-type": "application/json" };
const admin = { ...json, "x-mc-admin": CONFIG.adminToken };
const asA = { ...json, "x-mc-workspace-token": workspaces.get(A.id)!.token };
const asB = { ...json, "x-mc-workspace-token": workspaces.get(B.id)!.token };
const leadA = sessions.create({ workspace_id: A.id, role: "lead", cwd: tmp } as any);
const asLeadA = { ...json, "x-mc-lead": sessions.leadToken(leadA.id)! };
const leadB = sessions.create({ workspace_id: B.id, role: "lead", cwd: tmp } as any);
const asLeadB = { ...json, "x-mc-lead": sessions.leadToken(leadB.id)! };

async function call(method: string, p: string, headers: Record<string, string>, body?: unknown) {
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let out: any = null;
  try { out = await r.json(); } catch {}
  return { status: r.status, json: out };
}

test("operator-only routes refuse a workspace token, a Lead token and no token at all", async () => {
  const s = sessions.create({ workspace_id: A.id, cwd: tmp, goal: "a work" } as any);
  const repoDir = path.join(tmp, "repo-a");
  fs.mkdirSync(repoDir, { recursive: true });
  const repo = repos.create({ workspace_id: A.id, name: "a", path: repoDir });
  const routes: [string, string, unknown?][] = [
    ["POST", "/agent", { text: "hi" }],
    ["GET", "/agent/model"],
    ["POST", "/agent/model", { model: "opus" }],
    ["POST", "/agent/attach"],
    ["GET", "/attachments/chat/x"],
    ["GET", "/desk/quick-actions"],
    ["PUT", "/desk/quick-actions", { actions: [] }],
    ["POST", "/desk/close-done", {}],
    ["POST", "/speak", { text: "hola" }],
    ["GET", "/widgets"],
    ["GET", "/widgets/pulse"],
    ["GET", "/drafts"],
    ["GET", "/thread/route?text=x"],
    ["POST", "/thread/sticky", {}],
    ["POST", `/workspaces/${A.id}/vars`, { key: "K", value: "v" }],
    ["POST", `/repos/${repo.id}/accel/graphify/build`, {}],
    ["POST", `/sessions/${s.id}/drop`, {}],
  ];
  for (const [method, p, body] of routes) {
    for (const [who, h] of [["workspace A", asA], ["Lead of A", asLeadA], ["nobody", json]] as const) {
      const r = await call(method, p, h, body);
      assert.ok(r.status === 401 || r.status === 403, `${method} ${p} as ${who}: ${r.status} ${JSON.stringify(r.json)}`);
    }
  }
  // Control: the same routes exist and let the operator through (read-only ones, no side effects).
  for (const p of ["/agent/model", "/desk/quick-actions", "/widgets", "/drafts"]) {
    const r = await call("GET", p, admin);
    assert.equal(r.status, 200, `GET ${p} as operator: ${r.status}`);
  }
});

test("per-terminal routes: the owning workspace gets in, another workspace gets the 404 a missing id gets", async () => {
  const s = sessions.create({ workspace_id: A.id, cwd: tmp, goal: "a work" } as any);
  const missing = await call("GET", "/sessions/00000000-0000-0000-0000-000000000000/decisions", asB);
  const cases: [string, string, unknown?][] = [
    ["GET", `/sessions/${s.id}/decisions`],
    ["POST", `/sessions/${s.id}/show`, { shots: [{ name: "x.png" }] }],
    ["POST", `/sessions/${s.id}/worktree`, { repo: "nope" }],
  ];
  for (const [method, p, body] of cases) {
    const theirs = await call(method, p, asB, body);
    assert.equal(theirs.status, 404, `${method} ${p} as workspace B: ${theirs.status} ${JSON.stringify(theirs.json)}`);
    assert.equal(theirs.status, missing.status);
  }
  const mine = await call("GET", `/sessions/${s.id}/decisions`, asA);
  assert.equal(mine.status, 200, JSON.stringify(mine.json));
});

test("a note, a repo's graph and an ask answer only to their own workspace", async () => {
  const note = noteSvc.createNote({ workspace_id: A.id, title: "acme secret", body: "only acme" } as any);
  assert.equal((await call("GET", `/notes/${note.id}`, asB)).status, 404);
  assert.equal((await call("GET", `/notes/${note.id}?use=1`, asB)).status, 404);
  assert.equal((await call("GET", `/notes/${note.id}`, asA)).status, 200);

  const repoDir = path.join(tmp, "repo-q");
  fs.mkdirSync(repoDir, { recursive: true });
  const repo = repos.create({ workspace_id: A.id, name: "q", path: repoDir });
  const q = await call("POST", `/repos/${repo.id}/accel/graphify/query`, asB, { question: "where is auth?" });
  assert.equal(q.status, 404, JSON.stringify(q.json));
  assert.notEqual((await call("POST", `/repos/${repo.id}/accel/graphify/query`, asA, { question: "where is auth?" })).status, 404);

  const s = sessions.create({ workspace_id: A.id, cwd: tmp, goal: "a work" } as any);
  const ask = asks.create({ session_id: s.id, route: "robert", question: "ship it?" } as any);
  for (const h of [asB, asLeadB, asLeadA]) {
    const r = await call("POST", `/asks/${ask.id}/answer`, h, { answer: "yes" });
    assert.equal(r.status, 404, JSON.stringify(r.json));
  }
  assert.equal(asks.get(ask.id)!.status, "open", "nobody outside answered it");
});

test("only the operator grants ship: an agent cannot widen its own permission", async () => {
  const s = sessions.create({ workspace_id: A.id, cwd: tmp, goal: "a work" } as any);
  for (const h of [asA, asLeadA]) {
    const r = await call("PATCH", `/sessions/${s.id}`, h, { ship: "deploy", goal: "rewritten" });
    assert.equal(r.status, 403, JSON.stringify(r.json));
  }
  assert.equal(sessions.get(s.id)!.ship ?? "ask", "ask");
  assert.equal(sessions.get(s.id)!.goal, "a work", "refused before anything was written");
  // The same caller may edit the rest of its card: it is the ship field that is refused.
  assert.equal((await call("PATCH", `/sessions/${s.id}`, asA, { goal: "its own words" })).status, 200);
  const ok = await call("PATCH", `/sessions/${s.id}`, admin, { ship: "merge" });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(sessions.get(s.id)!.ship, "merge");
});
