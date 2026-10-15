import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "./config.js";
import { asks, continuations, db, sessions, workspaces } from "./store.js";
import {
  agentLimits, arm, cancel, continuationMessage, deliver, evaluate, evaluateEvent, fireByHand, handoffBrief,
  parseCheckResult, parseWhen, prMet, scriptVerdict, setRunScript, setViewPr, snapPr, summarizeChecks, sweep,
  LIMITS, RETRY_MS,
} from "./continuations.js";
import * as routes from "./continuation-routes.js";
import { isReadOnlyRun } from "./runner.js";
import type { Continuation } from "./store/continuations.js";

const NOW = new Date(2026, 9, 6, 10, 0, 0, 0).getTime();
const PR = "https://github.com/acme/app/pull/42";

const fakeReq = (headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): any =>
  ({ params: {}, query: {}, body: {}, get: (h: string) => headers[h.toLowerCase()], ...extra });
function fakeRes(): any {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}
const TOK = (wsId: string) => ({ "x-mc-workspace-token": workspaces.get(wsId)!.token! });
const ADMIN = () => ({ "x-mc-admin": CONFIG.adminToken });

let ws: { id: string };
let other: { id: string };

beforeEach(() => {
  db.exec("DELETE FROM continuations; DELETE FROM asks; DELETE FROM sessions; DELETE FROM workspaces;");
  ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  other = workspaces.create({ slug: "beta", name: "Beta", config_dir: "/tmp/beta" });
  setViewPr(null);
  setRunScript(null);
});
after(() => { setViewPr(null); setRunScript(null); });

const term = (wsId = ws.id, extra: Record<string, unknown> = {}) =>
  sessions.create({ workspace_id: wsId, cwd: "/tmp", backend: "claude-code", goal: "ship the export", ...extra } as any);

const spec = (r: any, nowMs = NOW) => {
  const p = parseWhen(r, nowMs);
  assert.ok(p.ok, (p as any).error);
  return (p as any).spec;
};

// ── reading a request ────────────────────────────────────────────────────────────────────────

test("parseWhen reads every kind with sensible defaults", () => {
  const pr = spec({ kind: "pr", target: PR });
  assert.equal(pr.until, "review");
  assert.equal(pr.label, "PR #42 gets a review or comment");
  assert.equal(pr.every_sec, 300);
  assert.equal(pr.timeout_at, new Date(NOW + 3 * 86_400_000).toISOString(), "a wait is never forever");
  assert.equal(pr.next_check_at, new Date(NOW).toISOString(), "first look right away");

  assert.equal(spec({ kind: "pr", target: PR + "/", until: "Approved" }).label, "PR #42 is approved");
  assert.equal(spec({ kind: "terminal", target: "abcdef12" }).until, "done");
  assert.equal(spec({ kind: "check", target: "Ana replied in #data about the schema" }).every_sec, 1800);
  assert.equal(spec({ kind: "script", target: "python3 check.py" }).every_sec, 300);

  const at = spec({ kind: "at", at: "+2h" });
  assert.equal(at.next_check_at, new Date(NOW + 2 * 3_600_000).toISOString());
  assert.equal(at.timeout_at, null, "a time needs no timeout");
  assert.equal(spec({ kind: "at", at: "2h" }).next_check_at, at.next_check_at, "bare durations read as from now");

  const manual = spec({ kind: "manual", note: "Leo signs the contract" });
  assert.equal(manual.next_check_at, manual.timeout_at, "manual only wakes for its timeout");
  assert.equal(spec({ kind: "pr", target: PR, timeout: "6h" }).timeout_at, new Date(NOW + 6 * 3_600_000).toISOString());
});

test("parseWhen says what is wrong in words an agent can act on", () => {
  const bad = (r: any, re: RegExp) => {
    const p = parseWhen(r, NOW);
    assert.equal(p.ok, false);
    assert.match((p as any).error, re);
  };
  bad({ kind: "email" }, /unknown condition/);
  bad({ kind: "pr", target: "#42" }, /PR's URL/);
  bad({ kind: "pr", target: PR, until: "soon" }, /--until is one of/);
  bad({ kind: "at", at: "whenever" }, /can't read the time/);
  bad({ kind: "check", target: "x" }, /condition in words/);
  bad({ kind: "script" }, /needs the command/);
  bad({ kind: "check", target: "Ana replied somewhere", every: "1m" }, /at least 15m/);
  bad({ kind: "pr", target: PR, timeout: "nope" }, /--timeout/);
  bad({ kind: "pr", target: PR, then: "later" }, /--then/);
});

test("agents are capped; a loop of re-arming needs the operator", () => {
  const s = spec({ kind: "pr", target: PR });
  assert.equal(agentLimits(s, { armed: 0, round: 1, nowMs: NOW }), null);
  assert.match(agentLimits(s, { armed: LIMITS.perSession, round: 1, nowMs: NOW })!, /already has/);
  assert.match(agentLimits(s, { armed: 0, round: LIMITS.maxRounds + 1, nowMs: NOW })!, /mc ask/);
  assert.match(agentLimits(spec({ kind: "pr", target: PR, timeout: "30d" }), { armed: 0, round: 1, nowMs: NOW })!, /14 days/);
  assert.match(agentLimits(spec({ kind: "at", at: "+2m" }), { armed: 0, round: 1, nowMs: NOW })!, /5 minutes/);
});

test("a check probe is a read-only run: it never parks on an ask", () => {
  assert.equal(isReadOnlyRun("when-check:abcd1234"), true);
  assert.equal(isReadOnlyRun("fallback:when-check:abcd1234"), true);
});

// ── the PR condition ─────────────────────────────────────────────────────────────────────────

const pr = (p: Partial<{ state: string; reviewDecision: string; reviews: any[]; comments: any[]; statusCheckRollup: any[] }> = {}) =>
  ({ state: "OPEN", reviewDecision: "", reviews: [], comments: [], statusCheckRollup: [], ...p });
const review = (login: string, state: string, body = "") => ({ author: { login }, state, body });

test("summarizeChecks folds check runs and status contexts into one verdict", () => {
  assert.equal(summarizeChecks([]).checks, "none");
  assert.equal(summarizeChecks([{ name: "a", status: "IN_PROGRESS" }]).checks, "pending");
  assert.equal(summarizeChecks([{ name: "a", status: "COMPLETED", conclusion: "SUCCESS" }, { context: "b", state: "SUCCESS" }]).checks, "pass");
  const f = summarizeChecks([{ name: "lint", status: "COMPLETED", conclusion: "FAILURE" }, { name: "t", status: "COMPLETED", conclusion: "SKIPPED" }]);
  assert.deepEqual(f, { checks: "fail", failing: ["lint"] });
  assert.equal(summarizeChecks([{ context: "ci", state: "PENDING" }, { name: "x", status: "COMPLETED", conclusion: "FAILURE" }]).checks, "pending", "not finished until all are");
});

test("prMet compares against the snapshot taken when the wait was armed", () => {
  const base = snapPr(pr({ comments: [{ author: { login: "bot" }, body: "coverage" }] }));
  assert.equal(prMet("review", snapPr(pr({ comments: [{ author: { login: "bot" }, body: "coverage" }] })), base), null, "an old comment is not news");
  assert.match(prMet("review", snapPr(pr({ reviews: [review("ana", "COMMENTED", "nit: rename")] })), base)!, /ana reviewed \(commented\): "nit: rename"/);
  assert.match(prMet("approved", snapPr(pr({ reviewDecision: "APPROVED", reviews: [review("ana", "APPROVED")] })), base)!, /^approved/);
  assert.match(prMet("approved", snapPr(pr({ reviews: [review("ana", "APPROVED")] })), base)!, /ana reviewed \(approved\)/, "repos without required reviews have no decision");
  assert.match(prMet("approved", snapPr(pr({ reviewDecision: "CHANGES_REQUESTED", reviews: [review("ana", "CHANGES_REQUESTED")] })), base)!, /changes requested/, "a reviewer waiting on the agent wakes it");
  assert.equal(prMet("merged", snapPr(pr({ reviewDecision: "APPROVED" })), base), null);
  assert.equal(prMet("merged", snapPr(pr({ state: "MERGED" })), base), "the PR was merged");
  assert.match(prMet("merged", snapPr(pr({ state: "CLOSED" })), base)!, /WITHOUT merging/);
  assert.equal(prMet("review", snapPr(pr({ state: "MERGED" })), base), "the PR was merged", "nothing left to wait for");
  assert.equal(prMet("checks", snapPr(pr({ statusCheckRollup: [{ name: "t", status: "IN_PROGRESS" }] })), base), null);
  assert.match(prMet("checks", snapPr(pr({ statusCheckRollup: [{ name: "t", status: "COMPLETED", conclusion: "FAILURE" }] })), base)!, /CI failed: t/);
  assert.equal(prMet("checks", snapPr(pr({ statusCheckRollup: [{ name: "t", status: "COMPLETED", conclusion: "SUCCESS" }] })), base), "CI passed");
  assert.match(prMet("change", snapPr(pr({ reviewDecision: "REVIEW_REQUIRED" })), base)!, /review decision none → review_required/);
});

test("a PR continuation looks through gh and meets on the condition", async () => {
  const s = term();
  let view = pr();
  setViewPr(async () => view);
  const c = await arm({ workspace_id: ws.id, session_id: s.id, spec: spec({ kind: "pr", target: PR, until: "approved" }), created_by: "agent:x", round: 1 });
  assert.ok(c.baseline, "baseline taken at arm time");
  await evaluate(continuations.get(c.id)!, NOW);
  let row = continuations.get(c.id)!;
  assert.equal(row.status, "armed");
  assert.match(row.last_check!, /open · no decision · 0 reviews/);
  assert.equal(row.next_check_at, new Date(NOW + 300_000).toISOString());

  view = pr({ reviewDecision: "APPROVED", reviews: [review("ana", "APPROVED", "lgtm")] });
  await evaluate(continuations.get(c.id)!, NOW + 300_000);
  row = continuations.get(c.id)!;
  assert.equal(row.status, "met");
  assert.equal(row.outcome, "met");
  assert.match(row.evidence!, /pull\/42: approved — ana reviewed \(approved\): "lgtm"/);
});

test("a look that keeps failing wakes the work as broken instead of waiting forever", async () => {
  setViewPr(async () => { throw new Error("gh: not authenticated"); });
  const c = await arm({ workspace_id: ws.id, session_id: term().id, spec: spec({ kind: "pr", target: PR }), created_by: "x", round: 1 });
  for (let i = 0; i < 5; i++) await evaluate(continuations.get(c.id)!, NOW + i * 1000);
  const row = continuations.get(c.id)!;
  assert.equal(row.status, "met");
  assert.equal(row.outcome, "broken");
  assert.match(row.evidence!, /not authenticated/);
});

// ── script, check, terminal, ask, time ───────────────────────────────────────────────────────

test("script: exit 0 is met, 1 is not yet, anything else is a failed look", async () => {
  assert.deepEqual(scriptVerdict(0, "checking\nreply from ana@x.com: ok\n", ""), { met: true, error: false, out: "checking · reply from ana@x.com: ok" });
  assert.deepEqual(scriptVerdict(1, "", ""), { met: false, error: false, out: "not yet" });
  assert.equal(scriptVerdict(127, "", "sh: python4: not found").error, true);
  assert.equal(scriptVerdict(null, "", "", true).error, true);

  let result = { met: false, error: false, out: "0 new emails" };
  setRunScript(async () => result);
  const c = await arm({ workspace_id: ws.id, session_id: term().id, spec: spec({ kind: "script", target: "python3 inbox.py" }), created_by: "x", round: 1 });
  await evaluate(continuations.get(c.id)!, NOW);
  assert.equal(continuations.get(c.id)!.last_check, "0 new emails");
  result = { met: true, error: false, out: "1 new email from ana: approved" };
  await evaluate(continuations.get(c.id)!, NOW + 300_000);
  assert.equal(continuations.get(c.id)!.evidence, "1 new email from ana: approved");
});

test("check: the probe's last WHEN-RESULT line is the verdict", () => {
  assert.deepEqual(parseCheckResult("looked at #data\nWHEN-RESULT: met — Ana replied 10:42: schema ok https://x"), { met: true, text: "Ana replied 10:42: schema ok https://x" });
  assert.deepEqual(parseCheckResult("WHEN-RESULT: not-yet — no reply since Friday"), { met: false, text: "no reply since Friday" });
  assert.equal(parseCheckResult("**WHEN-RESULT: met** — yes")!.met, true);
  assert.equal(parseCheckResult("I think so"), null);
});

test("check: a probe run is dispatched as when-check:<id8>", async () => {
  const c = await arm({ workspace_id: ws.id, session_id: term().id, spec: spec({ kind: "check", target: "Ana replied in #data about the schema" }), created_by: "x", round: 1 });
  const seen: string[] = [];
  await evaluate(continuations.get(c.id)!, NOW, { dispatch: ((jobId: string, name: string) => { seen.push(name); return { error: "budget wall" }; }) as any });
  assert.deepEqual(seen, [`when-check:${c.id.slice(0, 8)}`]);
  const row = continuations.get(c.id)!;
  assert.equal(row.status, "armed", "a refused probe is not the condition's fault");
  assert.match(row.last_check!, /budget wall/);
  assert.equal(row.errors, 0);
});

test("terminal: met the moment the other terminal ticks its goal", async () => {
  const me = term();
  const them = term(ws.id, { goal: "migrate the table" });
  const c = await arm({ workspace_id: ws.id, session_id: me.id, spec: spec({ kind: "terminal", target: them.id }), created_by: "x", round: 1 });
  assert.equal(continuations.get(c.id)!.status, "armed");
  db.prepare("UPDATE sessions SET goal_done_at=? WHERE id=?").run(new Date(NOW).toISOString(), them.id);
  assert.equal(evaluateEvent(continuations.get(c.id)!, NOW), true);
  assert.match(continuations.get(c.id)!.evidence!, /ticked its goal: migrate the table/);
  assert.equal(evaluateEvent(continuations.get(c.id)!, NOW), false, "met exactly once");
});

test("ask: met when answered, with the answer", async () => {
  const me = term();
  const a = asks.create({ session_id: me.id, workspace_id: ws.id, question: "Which bucket?", route: "operator" } as any);
  const c = await arm({ workspace_id: ws.id, session_id: me.id, spec: spec({ kind: "ask", target: a.id }), created_by: "x", round: 1 });
  db.prepare("UPDATE asks SET status='answered', answer='the eu one', answered_by='leo' WHERE id=?").run(a.id);
  evaluateEvent(continuations.get(c.id)!, NOW);
  assert.match(continuations.get(c.id)!.evidence!, /leo answered "Which bucket\?": the eu one/);
});

test("timeouts still continue the work — told it timed out and what was last seen", async () => {
  setViewPr(async () => pr());
  const c = await arm({ workspace_id: ws.id, session_id: term().id, spec: spec({ kind: "pr", target: PR, timeout: "1h" }), created_by: "x", round: 1 });
  await evaluate(continuations.get(c.id)!, NOW);
  await evaluate(continuations.get(c.id)!, NOW + 2 * 3_600_000);
  const row = continuations.get(c.id)!;
  assert.equal(row.outcome, "timeout");
  assert.match(row.evidence!, /last look: open/);
  assert.match(continuationMessage(row), /TIMED OUT[\s\S]*mc ask/);
});

// ── delivery ─────────────────────────────────────────────────────────────────────────────────

const metRow = async (session_id: string | null, extra: any = {}): Promise<Continuation> => {
  const c = await arm({ workspace_id: ws.id, session_id, spec: spec({ kind: "manual", note: "merge it", goal: extra.goal ?? null, then: extra.then ?? null }), created_by: "x", round: 1 });
  fireByHand(c, "Ana approved on Slack", "operator");
  return continuations.get(c.id)!;
};

test("an idle live terminal gets the news typed into it; a busy one waits", async () => {
  const s = term();
  const c = await metRow(s.id);
  const sent: string[] = [];
  const send = (id: string, r: any) => { sent.push(r.text); return null; };
  const live = { alive: () => true };
  assert.equal(await deliver(c, NOW, { ...live, send: send as any, phase: () => "working" }), null);
  assert.equal(continuations.get(c.id)!.next_check_at, new Date(NOW + RETRY_MS).toISOString());
  assert.equal(sent.length, 0, "never typed over a turn in progress");
  assert.equal(await deliver(continuations.get(c.id)!, NOW, { ...live, send: send as any, phase: () => "decide" }), null, "nor over an open question");
  assert.equal(await deliver(continuations.get(c.id)!, NOW, { ...live, send: send as any, phase: () => "your_turn" }), "typed");
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].includes("\n"), "one line — a newline would submit half of it");
  assert.match(sent[0], /fired .* Ana approved on Slack .* merge it/);
  const row = continuations.get(c.id)!;
  assert.equal(row.status, "fired");
  assert.equal(row.fired_how, "typed");
  assert.equal(await deliver(row, NOW, { ...live, send: send as any, phase: () => "your_turn" }), null, "delivered once, ever");
});

test("a row that says live with no pty behind it is resumed, not typed into forever", async () => {
  const s = term();
  const c = await metRow(s.id);
  const opened: any[] = [];
  const how = await deliver(c, Date.now(), { alive: () => false, send: (() => "terminal is not live") as any, open: (async (o: any) => { opened.push(o); return { id: s.id }; }) as any });
  assert.equal(how, "resumed");
  assert.equal(opened[0].resumeId, s.id);
});

test("a closed terminal is reopened on its own transcript, the news as its next prompt", async () => {
  const s = term();
  sessions.end(s.id);
  const c = await metRow(s.id);
  const opened: any[] = [];
  const open = async (o: any) => { opened.push(o); return { id: s.id } as any; };
  assert.equal(await deliver(c, Date.now(), { open: open as any }), "resumed");
  assert.equal(opened[0].resumeId, s.id);
  assert.equal(opened[0].created_by, "continuation", "an automatic reopen is admission-checked like an agent's");
  assert.match(opened[0].seed, /Ana approved on Slack/);
});

test("with no terminal, or one too old to resume, a fresh terminal gets the handoff", async () => {
  const old = term(ws.id, { goal: "ship the export" });
  sessions.end(old.id);
  db.prepare("UPDATE sessions SET ended_at=?, summary='opened PR 42' WHERE id=?").run(new Date(Date.now() - 60 * 86_400_000).toISOString(), old.id);
  const c = await metRow(old.id);
  const opened: any[] = [];
  const open = async (o: any) => { opened.push(o); return { id: "fresh-1" } as any; };
  assert.equal(await deliver(c, Date.now(), { open: open as any }), "opened");
  assert.equal(opened[0].resumeId, undefined);
  assert.equal(opened[0].goal, "Continue: ship the export");
  assert.match(opened[0].description, /opened PR 42/);
  assert.equal(continuations.get(c.id)!.fired_session_id, "fresh-1");

  const none = await metRow(null, { goal: "follow up with Ana" });
  assert.equal(await deliver(none, Date.now(), { open: open as any }), "opened");
  assert.equal(opened[1].goal, "follow up with Ana");
  assert.match(handoffBrief(none, null, null), /Goal: follow up with Ana/);
});

test("a refused open (seat cap) keeps it met and retries later", async () => {
  const c = await metRow(null, { goal: "x" });
  const open = async () => { throw new Error("workspace at its session cap"); };
  assert.equal(await deliver(c, NOW, { open: open as any }), null);
  const row = continuations.get(c.id)!;
  assert.equal(row.status, "met");
  assert.equal(row.next_check_at, new Date(NOW + RETRY_MS).toISOString());
});

test("sweep: a due time meets and delivers in one pass", async () => {
  const s = term();
  const c = await arm({ workspace_id: ws.id, session_id: s.id, spec: spec({ kind: "at", at: "+1h" }, NOW), created_by: "x", round: 1 });
  const sent: string[] = [];
  const o = { alive: () => true, send: ((id: string, r: any) => { sent.push(r.text); return null; }) as any, phase: () => "your_turn" };
  assert.deepEqual(await sweep(NOW + 30 * 60_000, o), { looked: 0, delivered: 0 }, "not due yet");
  assert.deepEqual(await sweep(NOW + 61 * 60_000, o), { looked: 1, delivered: 1 });
  assert.equal(continuations.get(c.id)!.status, "fired");
  assert.equal(sent.length, 1);
});

test("cancel stops it for good", async () => {
  const c = await arm({ workspace_id: ws.id, session_id: term().id, spec: spec({ kind: "manual" }), created_by: "x", round: 1 });
  assert.equal(cancel(c, "not needed"), true);
  assert.equal(continuations.get(c.id)!.status, "cancelled");
  assert.equal(fireByHand(continuations.get(c.id)!, "late", "x"), false);
});

// ── the doors ───────────────────────────────────────────────────────────────────────────────

test("a terminal parks its own work, not another's — and never across workspaces", async () => {
  const me = term();
  const peer = term();
  const own = fakeRes();
  await routes.createRoute(fakeReq({ ...TOK(ws.id), "x-mc-session": me.id }, { body: { kind: "pr", target: PR } }), own);
  assert.equal(own.statusCode, 201, JSON.stringify(own.body));
  assert.equal(own.body.session_id, me.id);
  assert.equal(own.body.created_by, `agent:${me.id.slice(0, 8)}`);

  const theirs = fakeRes();
  await routes.createRoute(fakeReq({ ...TOK(ws.id), "x-mc-session": me.id }, { body: { kind: "pr", target: PR, session_id: peer.id } }), theirs);
  assert.equal(theirs.statusCode, 403);

  const cross = fakeRes();
  await routes.createRoute(fakeReq({ ...TOK(other.id) }, { body: { kind: "pr", target: PR, session_id: me.id } }), cross);
  assert.equal(cross.statusCode, 404);

  const freshByAgent = fakeRes();
  await routes.createRoute(fakeReq({ ...TOK(ws.id) }, { body: { kind: "manual", goal: "x" } }), freshByAgent);
  assert.equal(freshByAgent.statusCode, 403, "a continuation with no terminal opens one — the executives' hand");

  const robert = fakeRes();
  await routes.createRoute(fakeReq(ADMIN(), { body: { kind: "pr", target: PR, session_id: peer.id.slice(0, 8), by: "robert" } }), robert);
  assert.equal(robert.statusCode, 201, JSON.stringify(robert.body));
  assert.equal(robert.body.created_by, "robert");
});

test("a terminal target must be in the same workspace; ids from elsewhere are a 404", async () => {
  const me = term();
  const foreign = term(other.id);
  const res = fakeRes();
  await routes.createRoute(fakeReq({ ...TOK(ws.id), "x-mc-session": me.id }, { body: { kind: "terminal", target: foreign.id.slice(0, 8) } }), res);
  assert.equal(res.statusCode, 404);
  const self = fakeRes();
  await routes.createRoute(fakeReq({ ...TOK(ws.id), "x-mc-session": me.id }, { body: { kind: "terminal", target: me.id } }), self);
  assert.equal(self.statusCode, 400);
});

test("fire/cancel/list are walled by workspace", async () => {
  const c = await arm({ workspace_id: ws.id, session_id: term().id, spec: spec({ kind: "manual" }), created_by: "x", round: 1 });
  const res = fakeRes();
  routes.fireRoute(fakeReq(TOK(other.id), { params: { id: c.id.slice(0, 8) }, body: { evidence: "x" } }), res);
  assert.equal(res.statusCode, 404);
  const mine = fakeRes();
  routes.fireRoute(fakeReq(TOK(ws.id), { params: { id: c.id.slice(0, 8) }, body: { evidence: "done" } }), mine);
  assert.equal(mine.body.status, "met");
  const list = fakeRes();
  routes.listRoute(fakeReq(TOK(other.id), { query: { workspace: ws.id } }), list);
  assert.deepEqual(list.body, [], "a token sees only its own workspace, whatever it asks for");
});
