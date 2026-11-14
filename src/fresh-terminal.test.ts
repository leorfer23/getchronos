/**
 * One goal, one terminal (src/fresh-terminal.ts): new work for a terminal whose goal is finished
 * opens a fresh one in the same workspace and repo with a hand-off; a follow-up on that goal, and
 * anything said without a goal, still goes to the terminal itself. Asked of the running API.
 */
import { test, before, after, beforeEach } from "node:test";
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
const { robertToken } = await import("./authz.js");
const { asks, repos, sessions, workspaces } = await import("./store.js");
const { arm, parseWhen } = await import("./continuations.js");
const fresh = await import("./fresh-terminal.js");
import type { Session } from "./types.js";

const base = `http://127.0.0.1:${PORT}/api`;
let server: any;
before(() => { server = startServer(); });
after(() => { fresh.setFreshOpener(null); server?.close?.(); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-fresh-"));
const A = workspaces.create({ slug: `fr-a-${Date.now()}`, name: "Acme", config_dir: path.join(tmp, "cfg-a"), default_dir: path.join(tmp, "a") } as any);
const B = workspaces.create({ slug: `fr-b-${Date.now()}`, name: "Initech", config_dir: path.join(tmp, "cfg-b"), default_dir: path.join(tmp, "b") } as any);
fs.mkdirSync(path.join(tmp, "repo-a"), { recursive: true });
const repoA = repos.create({ workspace_id: A.id, name: "web", path: path.join(tmp, "repo-a") });
const json = { "content-type": "application/json" };
const admin = { ...json, "x-mc-admin": CONFIG.adminToken };
const asRobertA = { ...json, "x-mc-admin": robertToken(A.id, "rw") };
const asA = { ...json, "x-mc-workspace-token": workspaces.get(A.id)!.token! };

async function call(method: string, p: string, headers: Record<string, string>, body?: unknown) {
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let out: any = null;
  try { out = await r.json(); } catch {}
  return { status: r.status, json: out };
}

const PR = "https://github.com/acme/web/pull/12";
const SHIPPED_GOAL = "open the flyway rollback PR";

/** A terminal that finished its goal: ticked, PR merged, its branch on the row. */
function finishedTerminal(ws = A.id, extra: Record<string, unknown> = {}): Session {
  const s = sessions.create({ workspace_id: ws, repo_id: ws === A.id ? repoA.id : null, cwd: tmp, backend: "claude-code", goal: SHIPPED_GOAL, ...extra } as any);
  sessions.setOutcome(s.id, { summary: "The rollback PR is merged; staging runs it clean.", changes: [], proof: [], prs: [PR], shots: [], ask: "merge", shipped: ["merged #12"], at: new Date(Date.now() - 60_000).toISOString() });
  sessions.setWorktree(s.id, { path: path.join(tmp, "wt"), branch: "lf/flyway-rollback" });
  sessions.setGoal(s.id, { goal_done: true });
  return sessions.get(s.id)!;
}

let opened: any[] = [];
let refuse: string | null = null;
beforeEach(() => {
  opened = [];
  refuse = null;
  fresh.setFreshOpener(async (opts: any) => {
    if (refuse) throw new Error(refuse);
    opened.push(opts);
    return { ...sessions.create({ ...opts, cwd: tmp } as any) };
  });
});

// ── the pieces ───────────────────────────────────────────────────────────────────────────────

test("sameGoal: a repeat or a sharpening is the same work, another job is not", () => {
  assert.equal(fresh.sameGoal("open the flyway rollback PR", "Open the Flyway rollback PR"), true);
  assert.equal(fresh.sameGoal("open the flyway rollback PR", "open the flyway rollback PR against develop"), true);
  assert.equal(fresh.sameGoal("open the flyway rollback PR", "release the new version to the shared folder"), false);
  assert.equal(fresh.sameGoal("", "anything"), false);
});

test("finished: ticked or shipped — and no longer once a new goal is written onto the card", () => {
  const working = sessions.create({ workspace_id: A.id, cwd: tmp, goal: "still at it" } as any);
  assert.equal(fresh.finishedGoal(working), null, "no tick, nothing shipped");

  const ticked = finishedTerminal();
  assert.equal(fresh.finishedGoal(ticked)?.goal, SHIPPED_GOAL);
  assert.deepEqual(fresh.finishedGoal(ticked)?.shipped, ["merged #12"]);

  // Shipped but never ticked still counts: the hand-off says the work went out.
  const shippedOnly = sessions.create({ workspace_id: A.id, cwd: tmp, goal: "fix the fee rounding" } as any);
  sessions.setOutcome(shippedOnly.id, { summary: "merged", changes: [], proof: [], prs: [], shots: [], ask: "merge", shipped: ["merged #7"], at: new Date().toISOString() });
  assert.equal(fresh.finishedGoal(sessions.get(shippedOnly.id)!)?.goal, "fix the fee rounding");

  // goal_done_at is a sticky record: after a new goal is set, the card is not finished any more —
  // even when that goal lands in the same millisecond as the tick — until the new goal is ticked.
  fresh.noteGoalSet(sessions.get(ticked.id)!);
  sessions.setGoal(ticked.id, { goal: "release the new version" });
  assert.equal(fresh.finishedGoal(sessions.get(ticked.id)!), null);
  sessions.setGoal(ticked.id, { goal_done_at: new Date(Date.now() + 5_000).toISOString() });
  assert.equal(fresh.finishedGoal(sessions.get(ticked.id)!)?.goal, "release the new version");
});

test("the hand-off: what it shipped, its links and branch, what is still open, and how to look it up", async () => {
  const prev = finishedTerminal();
  const parked = (note: string) => (parseWhen({ kind: "manual", note }) as any).spec;
  await arm({ workspace_id: A.id, session_id: prev.id, spec: parked("the client signs the contract"), created_by: "x", round: 1 });
  asks.create({ session_id: prev.id, workspace_id: A.id, question: "tag the release too?" });
  // Another terminal's parked work is not this hand-off's business.
  const other = sessions.create({ workspace_id: A.id, cwd: tmp, goal: "other work" } as any);
  await arm({ workspace_id: A.id, session_id: other.id, spec: parked("not mine"), created_by: "x", round: 1 });

  const h = fresh.handoffFrom(prev);
  assert.match(h, new RegExp(`Hand-off from terminal ${prev.id.slice(0, 8)}`));
  assert.match(h, /It worked on: open the flyway rollback PR/);
  assert.match(h, /Shipped: merged #12/);
  assert.match(h, /What it did: The rollback PR is merged/);
  assert.match(h, new RegExp(`Link: ${PR}`));
  assert.match(h, /Its branch: lf\/flyway-rollback/);
  assert.match(h, /parked until the client signs the contract/);
  assert.match(h, /open question: tag the release too\?/);
  assert.ok(!h.includes("not mine"), "another terminal's continuation stays out");
  assert.match(h, new RegExp(`mc session focus ${prev.id.slice(0, 8)}`));
  assert.ok(h.length < 2000, "short: it is the first prompt, not a transcript");
});

test("routeNewWork: a different goal for a finished terminal opens a fresh one in its workspace and repo", async () => {
  const prev = finishedTerminal();
  const r = await fresh.routeNewWork(prev, { goal: "release the new version to the shared folder", text: "Cut the release and upload it.", by: "robert" });
  assert.ok(r && "opened" in r, JSON.stringify(r));
  assert.equal(opened.length, 1);
  assert.equal(opened[0].workspace_id, A.id);
  assert.equal(opened[0].repo_id, repoA.id);
  assert.equal(opened[0].goal, "release the new version to the shared folder");
  assert.equal(opened[0].created_by, "robert");
  assert.equal(opened[0].cwd, undefined, "never inside the finished terminal's checkout");
  assert.match(opened[0].description, /Hand-off from terminal/);
  assert.match(opened[0].description, /## Your work now\nCut the release and upload it\./);

  // The same goal again is a follow-up; a terminal still at its goal, or a Lead, keeps the work.
  assert.equal(await fresh.routeNewWork(prev, { goal: "open the flyway rollback PR", text: "fix the review comments", by: "robert" }), null);
  const working = sessions.create({ workspace_id: A.id, cwd: tmp, goal: "still at it" } as any);
  assert.equal(await fresh.routeNewWork(working, { goal: "something else", text: "x", by: "robert" }), null);
  const lead = finishedTerminal(A.id, { role: "lead" });
  assert.equal(await fresh.routeNewWork(lead, { goal: "something else", text: "x", by: "robert" }), null);
  assert.equal(opened.length, 1);

  refuse = "workspace session cap reached (6/6)";
  const no = await fresh.routeNewWork(prev, { goal: "something else entirely", text: "x", by: "robert" });
  assert.deepEqual(no, { refused: "workspace session cap reached (6/6)" });
});

// ── through the API ──────────────────────────────────────────────────────────────────────────

test("Robert routing new work with its goal to a finished terminal: a fresh terminal, not a second goal in that one", async () => {
  const prev = finishedTerminal();
  const r = await call("POST", `/sessions/${prev.id}/input`, asRobertA, { text: "Cut the release and upload it.", goal: "release the new version to the shared folder" });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.from, prev.id);
  assert.equal(r.json.from_goal, SHIPPED_GOAL);
  assert.equal(r.json.opened.workspace_id, A.id);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].created_by, "robert", "his credential signs it, whatever the body says");
});

test("a follow-up — no goal, or the finished goal itself — still goes to that terminal", async () => {
  const prev = finishedTerminal();
  // Not live in a test, so reaching the typing path answers "terminal is not live": no fresh terminal.
  const plain = await call("POST", `/sessions/${prev.id}/input`, asRobertA, { text: "fix the review comments" });
  assert.equal(plain.status, 409);
  assert.match(plain.json.error, /not live/);
  const same = await call("POST", `/sessions/${prev.id}/input`, asRobertA, { text: "fix the review comments", goal: "open the flyway rollback PR" });
  assert.equal(same.status, 409);
  assert.equal(opened.length, 0);
  // A refused open falls through to typing (here: the same not-live answer), never a dropped message.
  refuse = "workspace session cap reached (6/6)";
  const capped = await call("POST", `/sessions/${prev.id}/input`, asRobertA, { text: "x", goal: "release the new version" });
  assert.equal(capped.status, 409);
  assert.match(capped.json.error, /not live/);
});

test("another workspace's terminal: a 404, and nothing opens anywhere", async () => {
  const theirs = finishedTerminal(B.id);
  const r = await call("POST", `/sessions/${theirs.id}/input`, asRobertA, { text: "x", goal: "release the new version" });
  assert.equal(r.status, 404);
  assert.equal(opened.length, 0);
});

test("mc goal set after the goal is done: told about a fresh terminal, with the command — once, and not for a sharpening", async () => {
  const s = finishedTerminal();
  const sharpen = await call("PATCH", `/sessions/${s.id}`, asA, { goal: "open the flyway rollback PR against develop", goal_source: "agent" });
  assert.equal(sharpen.status, 200);
  assert.equal(sharpen.json.fresh, undefined, "the same work, sharpened");
  assert.ok(fresh.finishedGoal(sessions.get(s.id)!), "a sharpened title is still the finished work");

  const s2 = finishedTerminal();
  const other = await call("PATCH", `/sessions/${s2.id}`, asA, { goal: "release the new version to the shared folder", goal_source: "agent" });
  assert.equal(other.status, 200);
  assert.equal(other.json.goal, "release the new version to the shared folder", "never forced: the goal is set");
  assert.equal(other.json.fresh.from_goal, SHIPPED_GOAL);
  assert.equal(other.json.fresh.command, `mc session new --from ${s2.id.slice(0, 8)} --goal "release the new version to the shared folder"`);
  assert.match(other.json.fresh.say, /merged #12/);

  // It is the new goal's card now: setting it again says nothing more.
  const again = await call("PATCH", `/sessions/${s2.id}`, asA, { goal: "upload the release zip and the readme", goal_source: "agent" });
  assert.equal(again.json.fresh, undefined);
});

test("mc session new --from: in that terminal's workspace only — another's is a 404, crossing over a 400", async () => {
  const theirs = finishedTerminal(B.id);
  const cross = await call("POST", "/sessions", asRobertA, { from: theirs.id, goal: "x" });
  assert.equal(cross.status, 404);
  assert.match(cross.json.error, /session not found in this workspace/);
  // A quiet workspace of its own, so its seat cap is not what answers below.
  const C = workspaces.create({ slug: `fr-c-${Date.now()}`, name: "Hooli", config_dir: path.join(tmp, "cfg-c"), default_dir: path.join(tmp, "c") } as any);
  const mine = finishedTerminal(C.id);
  const over = await call("POST", "/sessions", admin, { from: mine.id, workspace_id: B.id, goal: "x" });
  assert.equal(over.status, 400);
  assert.match(over.json.error, /stays in its own workspace/);
  // Past the walls it is an ordinary open (a taken agent name stops it just before any pty spawns).
  sessions.create({ workspace_id: C.id, cwd: tmp, agent_name: "probe-fresh" } as any);
  const ok = await call("POST", "/sessions", { ...json, "x-mc-admin": robertToken(C.id, "rw") }, { from: mine.id, goal: "release it", agent_name: "probe-fresh" });
  assert.equal(ok.status, 400);
  assert.match(ok.json.error, /agent_name `probe-fresh` already in use/);
});

test("withHandoff: the hand-off first, the caller's brief under it, the finished terminal's repo by default", () => {
  const prev = finishedTerminal();
  const b = fresh.withHandoff({ workspace_id: null, repo_id: null, description: "Upload the zip." }, prev);
  assert.equal(b.workspace_id, A.id);
  assert.equal(b.repo_id, repoA.id);
  assert.match(b.description!, /^## Hand-off from terminal/);
  assert.match(b.description!, /## Your work now\nUpload the zip\.$/);
  assert.equal(fresh.withHandoff({ repo_id: "r-other" }, prev).repo_id, "r-other", "a repo the caller named wins (the wall checks it)");
});
