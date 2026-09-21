import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, asks, jobs, runs, tickets, workspaces } from "./store.js";
import { deriveRunState, getAgent, listAgents } from "./agent-lifecycle.js";
import { shouldPark, isReadOnlyRun } from "./runner.js";
import { answerAsk, waitForAskAnswer } from "./asks.js";
import { bus } from "./bus.js";
import { dispatch, setExecutor } from "./dispatcher.js";
import type { Job, RunStatus } from "./types.js";

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  db.exec("DELETE FROM asks; DELETE FROM run_events; DELETE FROM run_steps; DELETE FROM runs; DELETE FROM jobs; DELETE FROM tickets; DELETE FROM workspaces;");
});
afterEach(() => {
  setExecutor(null);
  mock.timers.reset();
});

async function flushMicro() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

let n = 0;
function mkWs(over: Partial<Parameters<typeof workspaces.create>[0]> = {}) {
  return workspaces.create({ slug: "ask-" + n++ + "-" + Math.random().toString(36).slice(2), name: "AskWS", config_dir: "/tmp/ask-" + n, ...over });
}
function mkJob(over: Partial<Parameters<typeof jobs.create>[0]> = {}): Job {
  return jobs.create({ name: `ask-job-${n++}`, goal: "do the thing", ...over });
}

// ── store: create / answer / double-answer / openForRun ─────────────────────

test("asks.create defaults status open, stores options as JSON", () => {
  const ws = mkWs();
  const job = mkJob({ workspace_id: ws.id });
  const run = runs.create(job.id, "manual");
  const a = asks.create({ run_id: run.id, job_id: job.id, workspace_id: ws.id, question: "main or release?", options: ["main", "release"] });
  assert.equal(a.status, "open");
  assert.deepEqual(JSON.parse(a.options!), ["main", "release"]);
  assert.equal(a.answer, null);
  assert.deepEqual(asks.openForRun(run.id).map((x) => x.id), [a.id]);
});

test("asks.answer transitions open → answered; a second answer is rejected and leaves the first intact", () => {
  const job = mkJob();
  const run = runs.create(job.id, "manual");
  const a = asks.create({ run_id: run.id, job_id: job.id, question: "q" });
  const answered = asks.answer(a.id, "yes", "human");
  assert.equal(answered?.status, "answered");
  assert.equal(answered?.answer, "yes");
  assert.equal(asks.openForRun(run.id).length, 0);

  const second = asks.answer(a.id, "no", "telegram");
  assert.equal(second, undefined);
  assert.equal(asks.get(a.id)!.answer, "yes"); // untouched by the rejected second answer
});

test("asks.findByIdPrefix resolves a unique id8", () => {
  const job = mkJob();
  const run = runs.create(job.id, "manual");
  const a = asks.create({ run_id: run.id, job_id: job.id, question: "q" });
  assert.equal(asks.findByIdPrefix(a.id.slice(0, 8))?.id, a.id);
  assert.equal(asks.findByIdPrefix("00000000"), undefined);
});

// ── lifecycle: paused → blocked/question ─────────────────────────────────────

test("deriveRunState('paused') → blocked/question", () => {
  assert.deepEqual(deriveRunState({ status: "paused" }), { state: "blocked", blocked_reason: "question" });
});

test("a paused run with an open ask surfaces in listAgents as blocked/question, and getAgent resolves it directly", () => {
  const ws = mkWs();
  const job = mkJob({ workspace_id: ws.id, ticket_id: null });
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, { status: "paused", started_at: new Date().toISOString(), ended_at: new Date().toISOString() });
  asks.create({ run_id: run.id, job_id: job.id, workspace_id: ws.id, question: "main or release?" });

  const found = listAgents({ workspace_id: ws.id }).find((a) => a.id === run.id);
  assert.ok(found, "paused run with open ask must appear in listAgents");
  assert.equal(found!.state, "blocked");
  assert.equal(found!.blocked_reason, "question");

  const direct = getAgent(run.id);
  assert.equal(direct?.state, "blocked");
  assert.equal(direct?.blocked_reason, "question");
});

// PER-17: a parked run whose ask was answered (or never left open) must not poison the rollup as
// blocked forever. Concrete ghost: ea5006c6 stayed paused after its ask was answered + ticket done.
test("a paused run whose ask is already answered does not appear in listAgents / rollup blocked", () => {
  const ws = mkWs();
  const job = mkJob({ workspace_id: ws.id, ticket_id: null });
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, {
    status: "paused",
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    exit_code: 0,
  });
  const a = asks.create({ run_id: run.id, job_id: job.id, workspace_id: ws.id, question: "how to close?" });
  asks.answer(a.id, "dismiss", "human");

  assert.equal(asks.openForRun(run.id).length, 0);
  assert.ok(!runs.activeByWorkspace().some((r) => r.id === run.id), "must leave activeByWorkspace");
  assert.ok(!listAgents({ workspace_id: ws.id }).some((a) => a.id === run.id), "must not list as an agent");
});

test("a paused run with an open ask on a done ticket does not appear in listAgents", () => {
  const ws = mkWs();
  const t = tickets.create({
    id: randomUUID(), workspace_id: ws.id, repo_id: null, key: "ASK-DONE", slug: "ask-done", title: "t",
    status: "done", priority: "P2", complexity: null, backend: null, model: null, assignee: "agent",
    file_path: "/tmp/ask-done.md", external_system: null, external_id: null, external_url: null, tags: null,
  } as any);
  const job = mkJob({ name: "ticket:ASK-DONE", workspace_id: ws.id, ticket_id: t.id });
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, { status: "paused", started_at: new Date().toISOString(), ended_at: new Date().toISOString() });
  asks.create({ run_id: run.id, job_id: job.id, ticket_id: t.id, workspace_id: ws.id, question: "still?" });

  assert.ok(runs.activeByWorkspace().some((r) => r.id === run.id), "still active at the SQL layer (open ask)");
  assert.ok(!listAgents({ workspace_id: ws.id }).some((a) => a.id === run.id), "closed ticket → drop from rollup");
});

// ── shouldPark: pure decision (runner park logic lives inside execute()'s
// close handler, which spawns a real process — this is the extracted, testable part) ──

test("shouldPark: success + an open ask → park; success with none → finish normally", () => {
  assert.equal(shouldPark("success", true), true);
  assert.equal(shouldPark("success", false), false);
});

test("shouldPark: a crash is a crash — failed/timeout/killed never park even with an open ask", () => {
  for (const s of ["failed", "timeout", "killed", "rate_limited"] as RunStatus[]) {
    assert.equal(shouldPark(s, true), false, `${s} must not park`);
  }
});

// runner.ts's close handler gates the real park decision with `!isReadOnlyRun(job.name) && shouldPark(...)` —
// a planner (`mc ask --wait 0`) or reviewer (short-wait `mc ask`, then `changes`) that finishes with an
// open ask must NOT park: nothing resumes a read-only run in a way that helps, and parking it would
// stall the plan/review pipeline. Same for intake:/ideas: feeders (PER-35). Mirrors that composition
// here since execute() spawns a real process.
test("a plan/review/intake run with an open ask never parks — a ticket build with one does", () => {
  const parks = (jobName: string, hasOpenAsk: boolean) => !isReadOnlyRun(jobName) && shouldPark("success", hasOpenAsk);
  assert.equal(parks("plan:PER-1", true), false);
  assert.equal(parks("review:PER-1", true), false);
  assert.equal(parks("fallback:review:PER-1", true), false);
  assert.equal(parks("intake:personal", true), false);
  assert.equal(parks("ideas:miner:personal", true), false);
  assert.equal(parks("fallback:intake:personal", true), false);
  assert.equal(parks("ticket:PER-1", true), true);
  assert.equal(parks("ticket:PER-1", false), false);
});

// ── paused excluded from concurrency/worktree-busy accounting, included in the fleet board ──

test("a paused run does not count toward runningCountForWorkspace", () => {
  const ws = mkWs({ max_concurrent: 1 });
  const job = mkJob({ workspace_id: ws.id });
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, { status: "paused", started_at: new Date().toISOString() });
  assert.equal(runs.runningCountForWorkspace(ws.id), 0);
});

test("a paused run does not hold the one-agent-per-worktree lock — a resume dispatch is not blocked by its own predecessor", async () => {
  setExecutor(async () => "success" as RunStatus);
  const ws = mkWs();
  const t = tickets.create({
    id: randomUUID(), workspace_id: ws.id, repo_id: null, key: "ASK-1", slug: "ask-1", title: "t",
    status: "in_progress", priority: "P2", complexity: null, backend: null, model: null, assignee: "agent",
    file_path: "/tmp/ask-1.md", external_system: null, external_id: null, external_url: null, tags: null,
  } as any);
  const cwd = "/tmp/wt/ask-1";
  const parked = mkJob({ name: "ticket:ASK-1", ticket_id: t.id, cwd });
  const parkedRun = runs.create(parked.id, "manual");
  runs.patch(parkedRun.id, { status: "paused", started_at: new Date().toISOString() });

  const resume = mkJob({ name: "ticket:ASK-1", ticket_id: t.id, cwd });
  const out = dispatch(resume.id, "answer:12345678");
  assert.ok("run_id" in out, "must not be refused as 'already working' by its own parked predecessor");
  await flushMicro();
});

// ── answer → resume dispatch, and paused excludes it from the fleet's "live" count ──

test("answering an ENDED (paused) run's ask re-dispatches the same job with an answer context, threading resume_session for a supportsResume backend", async () => {
  setExecutor(async () => "success" as RunStatus);
  const ws = mkWs();
  const job = mkJob({ workspace_id: ws.id, backend: "claude-code" });
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, { status: "paused", session_id: "old-session-abc", started_at: new Date().toISOString(), ended_at: new Date().toISOString() });
  const a = asks.create({ run_id: run.id, job_id: job.id, workspace_id: ws.id, question: "main or release?" });

  const out = await answerAsk(a.id, "release-2.4", "human");
  assert.ok(out.ok);
  assert.equal(out.ask.status, "answered");
  assert.equal(out.ask.answer, "release-2.4");
  // Park is over: predecessor must leave the active/rollup set (PER-17).
  assert.equal(runs.get(run.id)?.status, "success");
  assert.ok(!runs.activeByWorkspace().some((r) => r.id === run.id));

  // Park resolved — the asking run must leave the fleet board (no longer `paused`).
  assert.equal(runs.get(run.id)!.status, "success", "paused asking run must clear after answer");

  const resumeRun = runs.list(job.id).find((r) => r.id !== run.id);
  assert.ok(resumeRun, "a new run must have been dispatched for the same job");
  assert.equal(resumeRun!.trigger_src, `answer:${a.id.slice(0, 8)}`);
  assert.equal(resumeRun!.resume_session, "old-session-abc");
  assert.ok((resumeRun!.context ?? "").includes("release-2.4"));
  await flushMicro();
});

test("park → answer → resume: escalate ws rejects by:robert but by:telegram|human lands and clears the pause", async () => {
  // Regression PER-15: Robert's Telegram PROPOSE stamped by:"robert" → 403 on escalate → ask stayed
  // open → worker paused forever. Telegram fire() now stamps by:"telegram"; humans always pass.
  // Also: after a successful answer the paused run must not remain paused (fleet ghost).
  setExecutor(async () => "success" as RunStatus);
  const ws = mkWs({ ask_policy: "escalate" });
  const job = mkJob({ workspace_id: ws.id, name: "ticket:ASK-PARK", backend: "claude-code" });
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, {
    status: "paused",
    session_id: "park-sess",
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
  });
  const a = asks.create({
    run_id: run.id,
    job_id: job.id,
    workspace_id: ws.id,
    question: "which option?",
  });

  const blocked = await answerAsk(a.id, "option-a", "robert");
  assert.equal(blocked.ok, false);
  assert.equal(asks.get(a.id)!.status, "open");
  assert.equal(runs.get(run.id)!.status, "paused", "rejected answer must leave the park intact");

  const out = await answerAsk(a.id, "option-a", "telegram");
  assert.ok(out.ok);
  assert.equal(out.ask.status, "answered");
  assert.equal(runs.get(run.id)!.status, "success");
  const resumeRun = runs.list(job.id).find((r) => r.id !== run.id);
  assert.ok(resumeRun, "resume must dispatch after a landed answer");
  assert.equal(resumeRun!.trigger_src, `answer:${a.id.slice(0, 8)}`);
  assert.equal(resumeRun!.resume_session, "park-sess");
  await flushMicro();
});

test("a NON-resume backend's answered ask still threads resume_session — execute() turns it into a transcript replay, not a silent fresh start", async () => {
  // Regression: gating resume_session on backend.supportsResume in asks.ts starved the replay
  // path in execute() — a grok worker resumed after an answer had never heard of its own question.
  setExecutor(async () => "success" as RunStatus);
  const ws = mkWs();
  const job = mkJob({ workspace_id: ws.id, backend: "grok" });
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, { status: "paused", session_id: "grok-sess-1", started_at: new Date().toISOString(), ended_at: new Date().toISOString() });
  const a = asks.create({ run_id: run.id, job_id: job.id, workspace_id: ws.id, question: "which env?" });

  const out = await answerAsk(a.id, "staging", "human");
  assert.ok(out.ok);
  const resumeRun = runs.list(job.id).find((r) => r.id !== run.id);
  assert.equal(resumeRun!.resume_session, "grok-sess-1");
  await flushMicro();
});

test("resume_session is visible to the executor AT INVOCATION — not patched after dispatch returns", async () => {
  // Regression: pump() starts the executor synchronously inside dispatch(), and the real execute()
  // reads resume_session in its synchronous prologue. A post-dispatch runs.patch() passes the
  // row-after-the-fact test above while the actual spawn already went out with --session-id (fresh
  // transcript, prior conversation silently lost). So assert on what the executor SAW, not the row.
  let seenAtInvocation: string | null | undefined = "sentinel-not-called";
  setExecutor(async (_job, runId) => {
    seenAtInvocation = runs.get(runId)?.resume_session;
    return "success" as RunStatus;
  });
  const ws = mkWs();
  const job = mkJob({ workspace_id: ws.id, backend: "claude-code" });
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, { status: "paused", session_id: "old-session-xyz", started_at: new Date().toISOString(), ended_at: new Date().toISOString() });
  const a = asks.create({ run_id: run.id, job_id: job.id, workspace_id: ws.id, question: "which branch?" });

  const out = await answerAsk(a.id, "main", "human");
  assert.ok(out.ok);
  assert.equal(seenAtInvocation, "old-session-xyz");
  await flushMicro();
});

test("answering an ended run on a non-resuming backend STILL threads resume_session — execute() replays the transcript instead of --resume", async () => {
  // This used to assert resume_session === null: asks.ts gated the session on supportsResume, which
  // starved execute()'s replay path — the "resumed" cursor/grok agent silently started fresh.
  setExecutor(async () => "success" as RunStatus);
  const job = mkJob({ backend: "cursor-agent" }); // supportsResume: false → replay path
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, { status: "failed", session_id: "whatever", ended_at: new Date().toISOString() });
  const a = asks.create({ run_id: run.id, job_id: job.id, question: "q" });

  const out = await answerAsk(a.id, "an answer", "human");
  assert.ok(out.ok);
  const resumeRun = runs.list(job.id).find((r) => r.id !== run.id);
  assert.ok(resumeRun);
  assert.equal(resumeRun!.resume_session, "whatever");
  await flushMicro();
});

test("answering a READ-ONLY run's ask (plan:/review:/intake:) never re-dispatches — their asks are advisory", async () => {
  // A planner files `mc ask --wait 0` and finishes its brief; a reviewer falls back to `changes`.
  // Both runs end success with the ask still open. Re-dispatching on answer would re-run a whole
  // plan/review that already delivered its output — the answer is for the thread, not a resume.
  // Same for intake: (PER-35): answering a stray ask must not re-fire the cron sweep.
  setExecutor(async () => "success" as RunStatus);
  for (const name of ["plan:ASK-9", "review:ASK-9", "fallback:review:ASK-9", "intake:personal", "ideas:miner:personal"]) {
    const job = mkJob({ name });
    const run = runs.create(job.id, "manual");
    runs.patch(run.id, { status: "success", session_id: "s", ended_at: new Date().toISOString() });
    const a = asks.create({ run_id: run.id, job_id: job.id, question: "q" });
    const out = await answerAsk(a.id, "an answer", "human");
    assert.ok(out.ok);
    assert.equal(runs.list(job.id).length, 1, `${name}: no second run may be dispatched`);
  }
  await flushMicro();
});

test("answering a STILL-RUNNING run's ask does not dispatch a second run — the long-poll delivers it", async () => {
  setExecutor(async () => "success" as RunStatus);
  const job = mkJob();
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, { status: "running", started_at: new Date().toISOString() });
  const a = asks.create({ run_id: run.id, job_id: job.id, question: "q" });

  const out = await answerAsk(a.id, "an answer", "human");
  assert.ok(out.ok);
  assert.equal(runs.list(job.id).length, 1, "no resume dispatch while the asking run is still alive");
});

// ── ask_policy gate (item 2): "escalate" blocks Robert's by:"robert" answers, humans always pass ──

test("answerAsk: workspace ask_policy 'escalate' rejects by:'robert' with a 403 status", async () => {
  const ws = mkWs({ ask_policy: "escalate" });
  const job = mkJob({ workspace_id: ws.id });
  const run = runs.create(job.id, "manual");
  const a = asks.create({ run_id: run.id, job_id: job.id, workspace_id: ws.id, question: "q" });

  const out = await answerAsk(a.id, "an answer", "robert");
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.status, 403);
    assert.match(out.error, /human/i);
  }
  assert.equal(asks.get(a.id)!.status, "open", "the ask must stay open — not mutated by the rejected answer");
});

test("answerAsk: workspace ask_policy 'escalate' still accepts a human by (mc answer / telegram)", async () => {
  const ws = mkWs({ ask_policy: "escalate" });
  const job = mkJob({ workspace_id: ws.id });
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, { status: "running", started_at: new Date().toISOString() });
  for (const by of ["human", "telegram", "leo"]) {
    const a = asks.create({ run_id: run.id, job_id: job.id, workspace_id: ws.id, question: `q-${by}` });
    const out = await answerAsk(a.id, "an answer", by);
    assert.ok(out.ok, `by:${by} must pass the escalate gate`);
  }
});

test("answerAsk: ask_policy null (default) accepts both robert and human answers", async () => {
  const ws = mkWs(); // ask_policy null
  const job = mkJob({ workspace_id: ws.id });
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, { status: "running", started_at: new Date().toISOString() });
  for (const by of ["robert", "human"]) {
    const a = asks.create({ run_id: run.id, job_id: job.id, workspace_id: ws.id, question: `q-${by}` });
    const out = await answerAsk(a.id, "an answer", by);
    assert.ok(out.ok, `by:${by} must pass with no policy set`);
  }
});

test("answerAsk: an ask with no workspace_id is never gated (nothing to look up)", async () => {
  const job = mkJob();
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, { status: "running", started_at: new Date().toISOString() });
  const a = asks.create({ run_id: run.id, job_id: job.id, question: "q" });
  const out = await answerAsk(a.id, "an answer", "robert");
  assert.ok(out.ok);
});

test("a double-answer race (two concurrent callers) only resumes once", async () => {
  setExecutor(async () => "success" as RunStatus);
  const job = mkJob();
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, { status: "paused", ended_at: new Date().toISOString() });
  const a = asks.create({ run_id: run.id, job_id: job.id, question: "q" });

  const [r1, r2] = await Promise.all([answerAsk(a.id, "first", "human"), answerAsk(a.id, "second", "telegram")]);
  const results = [r1, r2];
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok).length, 1);
  assert.equal(runs.list(job.id).filter((r) => r.id !== run.id).length, 1, "exactly one resume dispatch");
  await flushMicro();
});

// ── long-poll ─────────────────────────────────────────────────────────────

test("waitForAskAnswer resolves immediately for an already-answered ask", async () => {
  const job = mkJob();
  const run = runs.create(job.id, "manual");
  const a = asks.create({ run_id: run.id, job_id: job.id, question: "q" });
  asks.answer(a.id, "yep", "human");
  const got = await waitForAskAnswer(a.id, 5000);
  assert.equal(got.status, "answered");
  assert.equal(got.answer, "yep");
});

test("waitForAskAnswer resolves as soon as ask.answered publishes, not at the timeout", async () => {
  const job = mkJob();
  const run = runs.create(job.id, "manual");
  const a = asks.create({ run_id: run.id, job_id: job.id, question: "q" });

  const waited = waitForAskAnswer(a.id, 60_000);
  await flushMicro();
  asks.answer(a.id, "resolved fast", "human");
  bus.publish({ topic: "ask.answered", ask_id: a.id, run_id: run.id, job_id: job.id, answer: "resolved fast", answered_by: "human" });
  const got = await waited;
  assert.equal(got.status, "answered");
  assert.equal(got.answer, "resolved fast");
});

test("waitForAskAnswer times out with the still-open row when nothing answers", async () => {
  const job = mkJob();
  const run = runs.create(job.id, "manual");
  const a = asks.create({ run_id: run.id, job_id: job.id, question: "q" });
  const waited = waitForAskAnswer(a.id, 5000);
  mock.timers.tick(5000);
  const got = await waited;
  assert.equal(got.status, "open");
});
