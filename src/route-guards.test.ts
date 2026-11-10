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
const { sessions, workspaces, repos, asks, memoryUsage } = await import("./store.js");
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
    ["GET", `/repos/${repo.id}/shares`],
    ["POST", `/repos/${repo.id}/shares`, { workspace_id: B.id }],
    ["DELETE", `/repos/${repo.id}/shares/${B.id}`],
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
  assert.equal(memoryUsage.list(A.id).filter((r: any) => r.kind === "memo_get").length, 0, "a refused read is not recorded as a use");
  assert.equal((await call("GET", `/notes/${note.id}?use=1`, asA)).status, 200);
  assert.equal(memoryUsage.list(A.id).filter((r: any) => r.kind === "memo_get").length, 1);

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

test("a Lead answers its own worker's ask, as itself — and nobody else's", async () => {
  const worker = sessions.create({ workspace_id: A.id, role: "worker", goal: "the migration", cwd: tmp, lead_id: leadA.id } as any);
  const neighbour = sessions.create({ workspace_id: A.id, role: "worker", goal: "theirs", cwd: tmp, lead_id: null } as any);
  const theirs = asks.create({ session_id: neighbour.id, workspace_id: A.id, route: "lead", question: "rebaseline?", options: ["yes", "no"] } as any);
  assert.equal((await call("POST", `/asks/${theirs.id}/answer`, asLeadA, { answer: "yes" })).status, 404);
  const mine = asks.create({ session_id: worker.id, workspace_id: A.id, route: "lead", question: "rebaseline?", options: ["yes", "no"] } as any);
  assert.equal((await call("POST", `/asks/${mine.id}/answer`, asLeadB, { answer: "yes" })).status, 404, "another workspace's Lead");
  const r = await call("POST", `/asks/${mine.id}/answer`, asLeadA, { answer: "yes" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(asks.get(mine.id)!.answered_by, `lead:${leadA.id.slice(0, 8)}`);
  assert.equal(asks.get(theirs.id)!.status, "open");
});

test("a Lead's board and broadcast reach its own slices and workers — not a neighbour Lead's in the same workspace", async () => {
  const lead2 = sessions.create({ workspace_id: A.id, role: "lead", cwd: tmp } as any);
  const asLead2 = { ...json, "x-mc-lead": sessions.leadToken(lead2.id)! };
  const mine = sessions.create({ workspace_id: A.id, role: "worker", goal: "slice", cwd: tmp, lead_id: leadA.id } as any);
  const theirs = sessions.create({ workspace_id: A.id, role: "worker", goal: "slice", cwd: tmp, lead_id: lead2.id } as any);
  assert.equal((await call("POST", "/leads/me/board", asLeadA, { title: "mine" })).status, 201);
  assert.equal((await call("GET", "/leads/me/board", asLead2)).json.slices.length, 0, "the neighbour sees none of it");
  await call("PATCH", "/leads/me/board/1", asLead2, { status: "done" });
  assert.equal((await call("GET", "/leads/me/board", asLeadA)).json.slices[0].status, "todo", "nor moves it");
  const point = await call("PATCH", "/leads/me/board/1", asLeadA, { session_id: theirs.id });
  assert.equal(point.status, 404, "a slice cannot name another Lead's worker");
  assert.equal((await call("PATCH", "/leads/me/board/1", asLeadA, { session_id: mine.id.slice(0, 8) })).status, 200);
  assert.equal((await call("GET", "/leads/me/board", asB)).status, 401, "a workspace token is not a Lead");
  const sent = await call("POST", "/leads/me/broadcast", asLeadA, { text: "rebase on main" });
  const reached = sent.json.sent.map((x: any) => x.id8);
  assert.ok(reached.includes(mine.id.slice(0, 8)) && !reached.includes(theirs.id.slice(0, 8)), JSON.stringify(reached));
});

test("widget modules are served by bare name, uncached, and nothing outside static/desk-widgets is reachable", async () => {
  const root = `http://127.0.0.1:${PORT}`;
  const lib = await fetch(`${root}/desk-widgets/lib.js`);
  assert.equal(lib.status, 200);
  assert.match(lib.headers.get("cache-control") ?? "", /no-store/);
  for (const p of ["..%2F..%2Fsrc%2Fapi.ts", "..%2Fdesk.html", "lib.js.map", "LIB.js"]) {
    const r = await fetch(`${root}/desk-widgets/${p}`);
    const body = await r.text();
    assert.equal(r.status, 404, `${p}: ${r.status}`);
    assert.doesNotMatch(body, /import |<html/i, p);
  }
});

test("a Lead lists its own workers only; a Ship terminal's question always goes to the operator", async () => {
  const lead2 = sessions.create({ workspace_id: A.id, role: "lead", cwd: tmp } as any);
  const mine = sessions.create({ workspace_id: A.id, role: "worker", goal: "w", cwd: tmp, lead_id: leadA.id } as any);
  const theirs = sessions.create({ workspace_id: A.id, role: "worker", goal: "w", cwd: tmp, lead_id: lead2.id } as any);
  const w = await call("GET", "/leads/me/workers", asLeadA);
  assert.equal(w.status, 200, JSON.stringify(w.json));
  const ids = w.json.workers.map((x: any) => x.id);
  assert.ok(ids.includes(mine.id) && !ids.includes(theirs.id), JSON.stringify(ids));
  for (const p of ["/leads/me/workers", "/leads/me/events"]) assert.equal((await call("GET", p, asA)).status, 401, `${p}: a workspace token is not a Lead`);

  // ship-guard.ts: nobody may say yes for him — not Robert, not a Lead, whatever the CLI asked for.
  const ship = sessions.create({ workspace_id: A.id, cwd: tmp, goal: "merge #12?", created_by: "ship" } as any);
  for (const route of ["robert", "lead"]) {
    const r = await call("POST", "/asks", asA, { session_id: ship.id, question: "merge it?", route });
    assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.json));
    assert.equal(asks.get(r.json.id)!.route, "operator", `asked for ${route}`);
  }
});

test("Lead doors: adopt only an ended Lead of its own workspace; worklog only in its own; close-done only its own workers", async () => {
  const live2 = sessions.create({ workspace_id: A.id, role: "lead", cwd: tmp } as any);
  const endedB = sessions.create({ workspace_id: B.id, role: "lead", cwd: tmp } as any);
  sessions.end(endedB.id);
  assert.equal((await call("POST", "/leads/me/adopt", asA, { lead_id: live2.id })).status, 401);
  assert.equal((await call("POST", "/leads/me/adopt", asLeadA, { lead_id: live2.id })).status, 409, "a live Lead is not adoptable");
  assert.equal((await call("POST", "/leads/me/adopt", asLeadA, { lead_id: endedB.id })).status, 404, "another workspace's Lead does not exist for it");

  const entry = { what: "shipped the fix", outcome: "merged" };
  assert.equal((await call("POST", `/workspaces/${B.id}/worklog`, asLeadA, entry)).status, 404);
  assert.equal((await call("POST", `/workspaces/${A.id}/worklog`, asA, entry)).status, 403, "a workspace token does not write the worklog");

  const theirs = sessions.create({ workspace_id: A.id, role: "worker", goal: "w", cwd: tmp, lead_id: live2.id } as any);
  await call("POST", "/leads/me/close-done", asLeadA, { ids: [theirs.id] });
  assert.equal(sessions.get(theirs.id)!.status, "live", "a neighbour Lead's worker stays open");
});

test("a repo is shared only from its owner to another workspace that exists", async () => {
  const repoDir = path.join(tmp, "repo-share");
  fs.mkdirSync(repoDir, { recursive: true });
  const repo = repos.create({ workspace_id: A.id, name: "share", path: repoDir });
  assert.equal((await call("POST", `/repos/${repo.id}/shares`, admin, { workspace_id: A.id })).status, 400, "not with its owner");
  assert.equal((await call("POST", `/repos/${repo.id}/shares`, admin, { workspace_id: "no-such-ws" })).status, 404);
  assert.equal((await call("POST", "/repos/no-such-repo/shares", admin, { workspace_id: B.id })).status, 404);
});
