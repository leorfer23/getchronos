/**
 * The `/api/leads/me/*` surface (LEADS.md): who may read it, and what a Lead sees when it does.
 *
 * The authz rule under test is narrower than the workspace wall the rest of the API is built on — a
 * Lead sees ITS OWN workers and ITS OWN events, never its neighbour Lead's, even though both are
 * behind the same workspace token. No pty and no server: the gate and the two shapers are pure.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db, leadEvents, sessions, workspaces } from "./store.js";
import { leadGate, leadWorkerRows, publicLeadEvent } from "./api.js";

beforeEach(() => db.exec("DELETE FROM lead_events; DELETE FROM sessions; DELETE FROM workspaces;"));

function fakeReq(headers: Record<string, string> = {}): any {
  return { get: (h: string) => headers[h.toLowerCase()] };
}
function fakeRes(): any {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}

let n = 0;
const mkWs = () => workspaces.create({ slug: `inbox${++n}`, name: "Acme", config_dir: "/tmp/inbox" + n });
const mkLead = (wsId: string) => sessions.create({ workspace_id: wsId, role: "lead", goal: "ship X", cwd: "/tmp" });
const mkWorker = (wsId: string, leadId: string, over: Record<string, unknown> = {}) =>
  sessions.create({ workspace_id: wsId, role: "worker", goal: "open the PR", cwd: "/tmp", lead_id: leadId, ...over } as any);

// ─────────────────────────────── the gate ───────────────────────────────

test("leadGate: no credential at all is a 401, and nothing is returned to act on", () => {
  const res = fakeRes();
  assert.equal(leadGate(fakeReq(), res), null);
  assert.equal(res.statusCode, 401);
});

test("leadGate: a credential that is not a live Lead's is a 403 — a worker's, an ended Lead's", () => {
  const ws = mkWs();
  const worker = sessions.create({ workspace_id: ws.id, role: "worker", cwd: "/tmp" });
  db.prepare("UPDATE sessions SET lead_token=? WHERE id=?").run("forged", worker.id);
  const a = fakeRes();
  assert.equal(leadGate(fakeReq({ "x-mc-lead": "forged" }), a), null);
  assert.equal(a.statusCode, 403);

  const lead = mkLead(ws.id);
  const tok = sessions.leadToken(lead.id)!;
  sessions.end(lead.id);
  const b = fakeRes();
  assert.equal(leadGate(fakeReq({ "x-mc-lead": tok }), b), null);
  assert.equal(b.statusCode, 403);
});

test("leadGate: a live Lead's own credential resolves to ITS id — never to its workspace at large", () => {
  const ws = mkWs();
  const a = mkLead(ws.id);
  const b = mkLead(ws.id);
  const res = fakeRes();
  assert.deepEqual(leadGate(fakeReq({ "x-mc-lead": sessions.leadToken(a.id)! }), res), { ws: ws.id, leadId: a.id });
  assert.equal(res.statusCode, 200, "a pass writes no response");
  // The second Lead's token resolves to the second Lead. Two Leads, one workspace, two walls.
  assert.deepEqual(
    leadGate(fakeReq({ "x-mc-lead": sessions.leadToken(b.id)! }), fakeRes()),
    { ws: ws.id, leadId: b.id },
  );
});

// ──────────────────────── the scope: A can never read B ────────────────────────

test("Lead A cannot read Lead B's events or list Lead B's workers", () => {
  const ws = mkWs();
  const a = mkLead(ws.id);
  const b = mkLead(ws.id);
  const mine = mkWorker(ws.id, a.id, { goal: "mine" });
  const theirs = mkWorker(ws.id, b.id, { goal: "theirs" });
  leadEvents.add({ lead_id: a.id, session_id: mine.id, kind: "turn", key: "ka", payload: { id8: mine.id.slice(0, 8) } });
  leadEvents.add({ lead_id: b.id, session_id: theirs.id, kind: "blocked", key: "kb", payload: { id8: theirs.id.slice(0, 8) } });

  assert.deepEqual(leadEvents.recent(a.id).map((e) => e.session_id), [mine.id]);
  assert.deepEqual(leadEvents.unseen(a.id).map((e) => e.session_id), [mine.id]);
  assert.deepEqual(leadWorkerRows(a.id).map((w) => w.id), [mine.id]);
  assert.deepEqual(leadWorkerRows(b.id).map((w) => w.id), [theirs.id]);
  // And a terminal the operator opened in the same workspace belongs to neither.
  const bystander = sessions.create({ workspace_id: ws.id, role: "human", cwd: "/tmp", goal: "scratch" });
  assert.ok(!leadWorkerRows(a.id).some((w) => w.id === bystander.id));
});

// ──────────────────────── what the rows carry (and never carry) ────────────────────────

test("publicLeadEvent unpacks the payload and never leaks a credential", () => {
  const ws = mkWs();
  const lead = mkLead(ws.id);
  const worker = mkWorker(ws.id, lead.id);
  const { row } = leadEvents.add({
    lead_id: lead.id, session_id: worker.id, kind: "review", key: "k1",
    payload: {
      id8: worker.id.slice(0, 8), goal: "open the rollback PR", card_line: "tests green",
      last_result: "PR #214 open\nsuite green", last_said: null, phase: "review", progress: { n: 2, of: 3 },
    },
  });
  const out = publicLeadEvent(row);
  assert.equal(out.kind, "review");
  assert.equal(out.goal, "open the rollback PR");
  assert.equal(out.line, "tests green");
  assert.match(out.last_result!, /\n/, "newlines survive into the inbox — this is read, not typed");
  assert.deepEqual(out.progress, { n: 2, of: 3 });
  assert.equal(out.session_id, worker.id);
  assert.equal("lead_token" in out, false);
  assert.equal("payload" in out, false, "the raw JSON blob never rides out");
  assert.equal("lead_id" in out, false, "a Lead already knows which Lead it is");

  // An event whose payload was never written (or is corrupt) degrades to the ids, it does not throw.
  const bare = publicLeadEvent({ ...row, payload: "{not json" });
  assert.equal(bare.id8, worker.id.slice(0, 8));
  assert.equal(bare.goal, null);
});

test("leadWorkerRows: live first, then the ones closed today; a worker closed yesterday is gone", () => {
  const ws = mkWs();
  const lead = mkLead(ws.id);
  const live = mkWorker(ws.id, lead.id, { goal: "still going" });
  const closedToday = mkWorker(ws.id, lead.id, { goal: "closed today" });
  const closedBefore = mkWorker(ws.id, lead.id, { goal: "closed yesterday" });
  sessions.end(closedToday.id);
  sessions.end(closedBefore.id);
  db.prepare("UPDATE sessions SET ended_at=? WHERE id=?")
    .run(new Date(Date.now() - 36 * 60 * 60_000).toISOString(), closedBefore.id);

  const rows = leadWorkerRows(lead.id);
  assert.deepEqual(rows.map((w) => w.id), [live.id, closedToday.id]);
  assert.equal(rows[0].status, "live");
  assert.equal(rows[1].status, "ended");
  assert.equal(rows[1].phase, "ended");
  assert.ok(rows.every((w) => !("lead_token" in w)), "never the credential of a terminal it may type into");
  assert.ok(rows.every((w) => typeof w.minutes_live === "number" && w.minutes_live >= 0));
});

test("leadWorkerRows: the fields a Lead triages by, including the branch it will have to merge", () => {
  const ws = mkWs();
  const lead = mkLead(ws.id);
  const worker = mkWorker(ws.id, lead.id, { goal: "open the rollback PR" });
  sessions.setWorktree(worker.id, { path: "/tmp/wt", branch: "lf/feat/rollback", repo_id: null });
  const [row] = leadWorkerRows(lead.id);
  assert.deepEqual(Object.keys(row).sort(), [
    "cost_estimated", "cost_usd", "goal", "goal_done", "id", "id8", "line", "minutes_live",
    "phase", "progress", "status", "tokens_in", "tokens_out", "turns", "word", "worktree_branch",
  ]);
  assert.equal(row.worktree_branch, "lf/feat/rollback");
  assert.equal(row.goal, "open the rollback PR");
  assert.equal(row.goal_done, false);
});

// ──────────────────────── the routes actually use the gate ────────────────────────

test("every /leads/me route is gated by leadGate and scoped to leadScope.leadId, not to the workspace", () => {
  const api = fs.readFileSync(path.join(process.cwd(), "src/api.ts"), "utf8");
  for (const route of ["/leads/me/events/wait", "/leads/me/events", "/leads/me/workers"]) {
    const at = api.indexOf(`api.get("${route}"`);
    assert.ok(at > 0, `missing route ${route}`);
    const body = api.slice(at, at + 700);
    assert.ok(body.includes("leadGate(req, res)"), `${route} must go through leadGate`);
    assert.ok(body.includes("lead.leadId"), `${route} must scope by the Lead's id`);
    assert.ok(!body.includes("lead.ws"), `${route} must NOT widen to the Lead's whole workspace`);
  }
  const closeAt = api.indexOf('api.post("/leads/me/close-done"');
  assert.ok(closeAt > 0, "missing /leads/me/close-done");
  const closeBody = api.slice(closeAt, closeAt + 700);
  assert.ok(closeBody.includes("leadGate(req, res)"), "close-done must go through leadGate");
});
