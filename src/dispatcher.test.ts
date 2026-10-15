import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, jobs, repos, runs, tickets, workspaces } from "./store.js";
import { dispatch, status, setExecutor, setStopBackendResolver, stopRun } from "./dispatcher.js";
import { CONFIG } from "./config.js";
import type { CloudBackend } from "./backends/types.js";
import type { Job, RunStatus } from "./types.js";

// Drive the dispatcher with a scripted executor instead of spawning Claude. The fake mirrors what
// the real runner does to a run row (sets the terminal status + resets_at), since the dispatcher's
// retry logic reads run.status back from the DB.
type Outcome = { status: RunStatus; cost?: number; resetsAt?: string; error?: string };
let calls = 0;
function program(fn: (job: Job, attempt: number, call: number) => Outcome) {
  calls = 0;
  setExecutor(async (job, runId) => {
    const run = runs.get(runId)!;
    const o = fn(job, run.attempt, ++calls);
    runs.patch(runId, {
      status: o.status,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      cost_usd: o.cost ?? 0,
      resets_at: o.resetsAt ?? null,
      error: o.error ?? null,
    });
    return o.status;
  });
}

let n = 0;
const mkJob = (over: Partial<Parameters<typeof jobs.create>[0]> = {}): Job =>
  jobs.create({ name: `j${n++}`, goal: "do the thing", ...over });

// node:test mock timers only expose a *synchronous* tick(), but the dispatcher is promise-driven,
// so we interleave tick() with microtask draining: advance fake time, then let the resulting
// promise chains (execute → retry/chain/resume) run, repeat until the dispatcher goes idle.
async function flushMicro() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
const totalRuns = () => (db.prepare("SELECT COUNT(*) c FROM runs").get() as { c: number }).c;
async function settle(ms = 0) {
  let last = -1;
  for (let i = 0; i < 300; i++) {
    mock.timers.tick(ms);
    await flushMicro();
    const total = totalRuns();
    // Stop only once the dispatcher is idle *and* a tick produced no new work — otherwise a
    // delayed retry/resume timer scheduled just as a run went idle would be missed.
    if (status().active === 0 && status().queued === 0 && total === last) break;
    last = total;
  }
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  db.exec("DELETE FROM run_events; DELETE FROM runs; DELETE FROM jobs; DELETE FROM tickets; DELETE FROM workspaces;");
});
afterEach(() => {
  setExecutor(null);
  mock.timers.reset();
});

test("rejects unknown and disabled jobs without creating runs", () => {
  assert.deepEqual(dispatch("does-not-exist", "manual"), { error: "job not found" });
  const j = mkJob({ enabled: false });
  assert.deepEqual(dispatch(j.id, "manual"), { error: "job disabled" });
  assert.equal(runs.list(j.id).length, 0);
});

test("rejects retired model / unknown backend before creating a run", () => {
  const retired = mkJob({ backend: "opencode", model: "vercel/moonshotai/kimi-k3" });
  const r1 = dispatch(retired.id, "manual");
  assert.ok("error" in r1);
  assert.match(r1.error, /modelo desconocido \(retirado\)/);
  assert.equal(runs.list(retired.id).length, 0);

  const unknown = mkJob({ backend: "not-a-real-backend", model: "sonnet" });
  const r2 = dispatch(unknown.id, "manual");
  assert.ok("error" in r2);
  assert.match(r2.error, /unknown backend/);
  assert.equal(runs.list(unknown.id).length, 0);
});

// The gate itself (src/backends/index.ts validateSpawnTarget) is unit-tested in
// src/backends/cursor-cloud.test.ts. This covers the wiring: dispatch() must actually derive the
// job's repo (job → ticket → repo, same two-step as runner.ts) and pass it through, or the gate
// never fires and a cursor-cloud job against a non-GitHub repo launches happily.
function ticketedJob(over: { git_remote: string | null; delivery: "commit" | "pr" }) {
  const ws = workspaces.create({ slug: `cc-gate-${randomUUID().slice(0, 8)}`, name: "CC Gate", config_dir: "/tmp/cc-gate" } as any);
  const repo = repos.create({
    workspace_id: ws.id, name: "widgets", path: "/tmp/cc-gate-repo",
    git_remote: over.git_remote, default_branch: "main", delivery: over.delivery,
  } as any);
  const t = tickets.create({
    id: randomUUID(), workspace_id: ws.id, repo_id: repo.id, key: "CC-1", slug: "cc-1", title: "t",
    status: "backlog", priority: "P2", complexity: null, backend: null, model: null, assignee: "agent",
    file_path: "/tmp/cc-1.md", external_system: null, external_id: null, external_url: null, tags: null,
  } as any);
  return mkJob({ backend: "cursor-cloud", ticket_id: t.id, cwd: repo.path });
}

test("dispatch refuses cursor-cloud with no ticket at all — fails closed, not a silent pass", () => {
  const j = mkJob({ backend: "cursor-cloud" }); // no ticket_id → no repo resolvable
  const r = dispatch(j.id, "manual");
  assert.ok("error" in r);
  assert.match((r as { error: string }).error, /cursor-cloud refused/);
  assert.match((r as { error: string }).error, /GitHub/);
  assert.equal(runs.list(j.id).length, 0);
});

test("dispatch refuses cursor-cloud when the ticket has no repo_id — fails closed, not a silent pass", () => {
  const ws = workspaces.create({ slug: `cc-gate-norepo-${randomUUID().slice(0, 8)}`, name: "CC Gate no-repo", config_dir: "/tmp/cc-gate-norepo" } as any);
  const t = tickets.create({
    id: randomUUID(), workspace_id: ws.id, repo_id: null, key: "CC-2", slug: "cc-2", title: "t",
    status: "backlog", priority: "P2", complexity: null, backend: null, model: null, assignee: "agent",
    file_path: "/tmp/cc-2.md", external_system: null, external_id: null, external_url: null, tags: null,
  } as any);
  const j = mkJob({ backend: "cursor-cloud", ticket_id: t.id });
  const r = dispatch(j.id, "manual");
  assert.ok("error" in r);
  assert.match((r as { error: string }).error, /cursor-cloud refused/);
  assert.equal(runs.list(j.id).length, 0);
});

test("dispatch refuses cursor-cloud against a non-GitHub repo, naming the repo, before creating a run", () => {
  const j = ticketedJob({ git_remote: "https://gitlab.com/acme/widgets", delivery: "pr" });
  const r = dispatch(j.id, "manual");
  assert.ok("error" in r);
  assert.match((r as { error: string }).error, /widgets/);
  assert.match((r as { error: string }).error, /GitHub/);
  assert.equal(runs.list(j.id).length, 0);
});

test("dispatch refuses cursor-cloud against a GitHub repo with delivery=commit, before creating a run", () => {
  const j = ticketedJob({ git_remote: "https://github.com/acme/widgets", delivery: "commit" });
  const r = dispatch(j.id, "manual");
  assert.ok("error" in r);
  assert.match((r as { error: string }).error, /widgets/);
  assert.match((r as { error: string }).error, /delivery=pr/);
  assert.equal(runs.list(j.id).length, 0);
});

test("dispatch lets cursor-cloud through for a GitHub repo with delivery=pr", async () => {
  program(() => ({ status: "success" }));
  const j = ticketedJob({ git_remote: "https://github.com/acme/widgets", delivery: "pr" });
  const r = dispatch(j.id, "manual");
  assert.ok("run_id" in r);
  await settle();
  assert.equal(runs.list(j.id)[0]?.status, "success");
});

test("success runs once — no retry, no chain", async () => {
  program(() => ({ status: "success" }));
  const j = mkJob({ retry_max: 3, on_failure: "anything" });
  dispatch(j.id, "manual");
  await settle();
  const rs = runs.list(j.id);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].status, "success");
});

test("on_success chains to the next job by name and by id", async () => {
  program(() => ({ status: "success" }));
  const byName = mkJob({ name: "B" });
  const a1 = mkJob({ name: "A", on_success: "B" });
  dispatch(a1.id, "manual");
  await settle();
  assert.equal(runs.list(byName.id).length, 1);
  assert.equal(runs.list(byName.id)[0].trigger_src, "chain:success:A");

  const byId = mkJob({ name: "C" });
  const a2 = mkJob({ name: "A2", on_success: byId.id });
  dispatch(a2.id, "manual");
  await settle();
  assert.equal(runs.list(byId.id).length, 1);
});

test("failure retries up to retry_max, then fires on_failure", async () => {
  program(() => ({ status: "failed" }));
  const fb = mkJob({ name: "F" });
  const a = mkJob({ name: "A", retry_max: 2, retry_backoff_sec: 1, on_failure: "F" });
  dispatch(a.id, "manual");
  await settle(10_000); // cover both backoffs (1s, then 2s)
  const attempts = runs.list(a.id);
  assert.equal(attempts.length, 3); // attempt 1 + 2 retries
  assert.deepEqual([...attempts].map((r) => r.attempt).sort(), [1, 2, 3]);
  const chained = runs.list(fb.id);
  assert.equal(chained.length, 1);
  assert.equal(chained[0].trigger_src, "chain:failed:A");
});

// Build a ticket + two build jobs pointed at the SAME worktree — the ACM-63 shape.
function ticketJobs(cwd: string) {
  const ws = workspaces.create({ slug: "w", name: "W", config_dir: "/tmp/w" });
  const t = tickets.create({
    id: randomUUID(), workspace_id: ws.id, repo_id: null, key: "T-1", slug: "t-1", title: "t",
    status: "backlog", priority: "P2", complexity: null, backend: null, model: null, assignee: "agent",
    file_path: "/tmp/t-1.md", external_system: null, external_id: null, external_url: null, tags: null,
  } as any);
  return {
    a: mkJob({ name: "ticket:T-1", ticket_id: t.id, cwd }),
    b: mkJob({ name: "ticket:T-1", ticket_id: t.id, cwd }),
    reviewer: mkJob({ name: "review:T-1", ticket_id: t.id, cwd }),
  };
}

test("one agent per worktree — a second build in the same cwd is refused, read-only runs are not", async () => {
  // The scripted executor above finishes synchronously, so nothing is ever in flight to collide
  // with. Hold this run open instead, the way a real agent occupies its worktree for minutes.
  const inFlight: Array<() => void> = [];
  setExecutor(
    (_job, runId) =>
      new Promise<RunStatus>((resolve) => {
        inFlight.push(() => {
          runs.patch(runId, { status: "success", ended_at: new Date().toISOString(), cost_usd: 0 });
          resolve("success");
        });
      })
  );
  const finishAll = () => inFlight.splice(0).forEach((f) => f());
  const { a, b, reviewer } = ticketJobs("/tmp/wt/mc-t-1");

  assert.ok("run_id" in dispatch(a.id, "ticket:T-1"));
  // The path that raced before: UI/API "run job" on a second build job for the same worktree.
  const second = dispatch(b.id, "manual");
  assert.ok("error" in second && /already working/.test(second.error));
  assert.equal(runs.list(b.id).length, 0); // refused outright — no run row, no spend
  // Read-only runs still get in (plan/review panels run alongside by design).
  assert.ok("run_id" in dispatch(reviewer.id, "review:T-1"));

  finishAll();
  await settle();
  assert.ok("run_id" in dispatch(b.id, "manual")); // worktree free once the build ends
});

test("the worktree lock leaves non-ticket jobs sharing a checkout alone", async () => {
  program(() => ({ status: "success" }));
  const a = mkJob({ name: "ideas:x", cwd: "/tmp/repo" });
  const b = mkJob({ name: "ideas:y", cwd: "/tmp/repo" });
  assert.ok("run_id" in dispatch(a.id, "manual"));
  assert.ok("run_id" in dispatch(b.id, "manual"));
});

test("a logged-out profile does not retry — retrying can only fail the same way", async () => {
  program(() => ({ status: "failed", error: "Not logged in · Please run /login" }));
  const fb = mkJob({ name: "F" });
  const a = mkJob({ name: "A", retry_max: 3, retry_backoff_sec: 1, on_failure: "F" });
  dispatch(a.id, "manual");
  await settle(10_000);
  assert.equal(runs.list(a.id).length, 1); // one attempt, not 4
  assert.equal(runs.list(fb.id).length, 1); // on_failure still fires so the operator hears about it
});

test("an operator kill is terminal — no retry, no chain", async () => {
  program(() => ({ status: "killed" }));
  const fb = mkJob({ name: "F" });
  const a = mkJob({ name: "A", retry_max: 2, retry_backoff_sec: 1, on_failure: "F" });
  dispatch(a.id, "manual");
  await settle(10_000);
  assert.equal(runs.list(a.id).length, 1); // no replacement spawned
  assert.equal(runs.list(fb.id).length, 0);
});

test("timeout also fires on_failure (no on_success)", async () => {
  program(() => ({ status: "timeout" }));
  const fb = mkJob({ name: "F" });
  const a = mkJob({ name: "A", on_success: "SHOULD-NOT-FIRE", on_failure: "F" });
  dispatch(a.id, "manual");
  await settle();
  assert.equal(runs.list(fb.id).length, 1);
});

test("rate_limited does not retry or chain, and resumes after reset", async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  // First execution hits the wall; the resumed one succeeds.
  program((_job, _attempt, call) =>
    call === 1 ? { status: "rate_limited", resetsAt: future } : { status: "success" }
  );
  const j = mkJob({ name: "R", retry_max: 2, on_failure: "R" }); // neither should engage
  dispatch(j.id, "manual");
  await settle();
  let rs = runs.list(j.id);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].status, "rate_limited");

  await settle(95_000); // reset (60s) + 30s buffer
  rs = runs.list(j.id);
  assert.equal(rs.length, 2);
  assert.ok(rs.some((r) => r.trigger_src === "resume:rate_limit"));
  assert.ok(rs.some((r) => r.status === "success"));
});

test("rate_limited with workspace fallback_backend re-dispatches on fallback, skips resume wait", async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const ws = workspaces.create({
    slug: "fb-ws",
    name: "FB",
    config_dir: "/tmp/fb-ws",
    default_backend: "claude-code",
    fallback_backend: "cursor-agent",
    fallback_model: "auto",
  });
  // Primary rate-limits once; any other job (the fallback clone) succeeds.
  program((job) =>
    job.backend === "claude-code"
      ? { status: "rate_limited", resetsAt: future }
      : { status: "success" }
  );
  const j = mkJob({ name: "primary", workspace_id: ws.id, backend: "claude-code", retry_max: 2 });
  dispatch(j.id, "manual");
  await settle();

  assert.equal(runs.list(j.id).length, 1);
  assert.equal(runs.list(j.id)[0].status, "rate_limited");

  const allJobs = jobs.list().filter((x) => x.name.startsWith("fallback:"));
  assert.equal(allJobs.length, 1);
  assert.equal(allJobs[0].backend, "cursor-agent");
  assert.equal(allJobs[0].model, "auto");
  const fbRuns = runs.list(allJobs[0].id);
  assert.equal(fbRuns.length, 1);
  assert.equal(fbRuns[0].status, "success");
  assert.ok(fbRuns[0].trigger_src?.startsWith("fallback:rate_limit:"));

  // No resume of the original after the wait window — fallback already took over.
  await settle(95_000);
  assert.equal(runs.list(j.id).length, 1);
});

test("rate_limited without fallback still resumes (unchanged)", async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const ws = workspaces.create({
    slug: "no-fb",
    name: "NoFB",
    config_dir: "/tmp/no-fb",
    default_backend: "claude-code",
    // no fallback_backend
  });
  program((_j, _a, call) =>
    call === 1 ? { status: "rate_limited", resetsAt: future } : { status: "success" }
  );
  const j = mkJob({ name: "solo", workspace_id: ws.id, backend: "claude-code" });
  dispatch(j.id, "manual");
  await settle();
  await settle(95_000);
  assert.equal(runs.list(j.id).length, 2);
  assert.ok(runs.list(j.id).some((r) => r.trigger_src === "resume:rate_limit"));
});

test("does not resume when reset is beyond the max wait", async () => {
  const far = new Date(Date.now() + 8 * 3600_000).toISOString(); // 8h > 6h cap
  program((_j, _a, call) => (call === 1 ? { status: "rate_limited", resetsAt: far } : { status: "success" }));
  const j = mkJob({ name: "R2" });
  dispatch(j.id, "manual");
  await settle();
  await settle(10 * 3600_000);
  assert.equal(runs.list(j.id).length, 1); // never resumed
});

test("daily budget cap blocks before executing", async () => {
  // Pre-spend over the $5 test cap.
  const prior = mkJob({ name: "prior" });
  const pr = runs.create(prior.id, "manual");
  runs.patch(pr.id, { cost_usd: 10, started_at: new Date().toISOString() });

  let executed = false;
  program(() => {
    executed = true;
    return { status: "success" };
  });
  const j = mkJob();
  const res = dispatch(j.id, "manual");
  await settle();
  assert.equal((res as any).status, "blocked");
  assert.equal(executed, false);
  assert.equal(runs.list(j.id)[0].status, "blocked");
});

test("per-workspace daily budget blocks that ws while another proceeds", async () => {
  const wsA = workspaces.create({ slug: "wa", name: "A", config_dir: "/tmp/wa", daily_budget_usd: 1 });
  const wsB = workspaces.create({ slug: "wb", name: "B", config_dir: "/tmp/wb" });
  // Pre-spend $2 in ws A (over its $1 cap, still under the $5 global cap).
  const prior = mkJob({ workspace_id: wsA.id });
  const pr = runs.create(prior.id, "manual");
  runs.patch(pr.id, { cost_usd: 2, started_at: new Date().toISOString() });

  program(() => ({ status: "success" }));
  const aJob = mkJob({ workspace_id: wsA.id });
  const bJob = mkJob({ workspace_id: wsB.id });
  const ra = dispatch(aJob.id, "manual");
  dispatch(bJob.id, "manual");
  await settle();
  assert.equal((ra as any).status, "blocked");
  assert.equal(runs.list(aJob.id)[0].status, "blocked");
  assert.equal(runs.list(bJob.id)[0].status, "success");
});

test("per-workspace max_concurrent leaves extra runs queued while another ws proceeds", async () => {
  const wsA = workspaces.create({ slug: "wa", name: "A", config_dir: "/tmp/wa", max_concurrent: 1 });
  const wsB = workspaces.create({ slug: "wb", name: "B", config_dir: "/tmp/wb" });
  // Executor that marks the run running and holds it until released, so slots stay occupied.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  setExecutor(async (job, runId) => {
    runs.patch(runId, { status: "running", started_at: new Date().toISOString() });
    await gate;
    runs.patch(runId, { status: "success", ended_at: new Date().toISOString() });
    return "success" as RunStatus;
  });
  const a1 = mkJob({ workspace_id: wsA.id });
  const a2 = mkJob({ workspace_id: wsA.id });
  const b1 = mkJob({ workspace_id: wsB.id });
  dispatch(a1.id, "manual");
  dispatch(a2.id, "manual");
  dispatch(b1.id, "manual");
  await flushMicro();
  assert.equal(runs.list(a1.id)[0].status, "running"); // ws A slot taken
  assert.equal(runs.list(a2.id)[0].status, "queued");  // ws A at cap → stays queued
  assert.equal(runs.list(b1.id)[0].status, "running"); // different ws still starts
  release();
  await settle();
  assert.equal(runs.list(a2.id)[0].status, "success"); // starts once the slot frees
});

test("chain depth is capped to prevent infinite loops", async () => {
  program(() => ({ status: "success" }));
  const loop = mkJob({ name: "loop", on_success: "loop" });
  dispatch(loop.id, "manual");
  await settle();
  // depth 0..8 inclusive = 9 runs, then the cap stops it.
  assert.equal(runs.list(loop.id).length, 9);
});

// The real PER-80 loop never touched on_success chaining: it went out through the bus (a fallback
// reviewer queued a review of itself) and came back as a fresh job row each hop, so chain depth
// never saw it. The guard keys on the job NAME for exactly that reason.
test("loop guard stops a job name that re-triggers itself, across job rows", async () => {
  program(() => ({ status: "success" }));
  const cap = CONFIG.runsPerJobHourCap;
  const j = mkJob({ name: "review:LOOP-1" });
  let last: ReturnType<typeof dispatch> | undefined;
  for (let i = 0; i < cap + 3; i++) {
    last = dispatch(j.id, "manual");
    await settle();
  }
  assert.equal(runs.list(j.id).length, cap);
  assert.ok(last && "error" in last, "dispatch past the cap must be refused");

  // A loop re-creates the job row every hop — same name, new id. The cap must still hold.
  const clone = mkJob({ name: "review:LOOP-1" });
  const r = dispatch(clone.id, "manual");
  assert.ok("error" in r);
  assert.equal(runs.list(clone.id).length, 0);
});

test("a queued run can be killed: it leaves the queue and never starts", async () => {
  const { stopRun } = await import("./dispatcher.js");
  const ws = workspaces.create({ slug: "wq", name: "Q", config_dir: "/tmp/wq", max_concurrent: 1 });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const started: string[] = [];
  setExecutor(async (job, runId) => {
    started.push(runId);
    runs.patch(runId, { status: "running", started_at: new Date().toISOString() });
    await gate;
    runs.patch(runId, { status: "success", ended_at: new Date().toISOString() });
    return "success" as RunStatus;
  });
  const a = mkJob({ workspace_id: ws.id }), b = mkJob({ workspace_id: ws.id });
  dispatch(a.id, "manual");
  const q = dispatch(b.id, "manual") as { run_id: string };
  await flushMicro();
  assert.equal(runs.get(q.run_id)!.status, "queued");
  assert.equal(stopRun(q.run_id), true);
  assert.equal(runs.get(q.run_id)!.status, "killed");
  release();
  await settle();
  assert.deepEqual(started, [runs.list(a.id)[0].id], "the killed run never took the slot");
});

// ── stopping a cloud run: cancel() decides, not the HTTP response ──────────

function fakeCloudBackend(over: Partial<CloudBackend> = {}): CloudBackend {
  return {
    name: "test-cloud",
    kind: "cloud",
    supportsResume: true,
    bin: () => { throw new Error("cloud backend has no local process"); },
    buildArgs: () => { throw new Error("cloud backend has no local process"); },
    oneShot: () => { throw new Error("cloud backend has no local process"); },
    env: () => ({}),
    parseLine: (line) => ({ type: "raw", payload: { text: line } }),
    extractResult: () => null,
    detectRateLimit: () => null,
    launch: async () => ({ agentId: "bc-x", runId: "run-x", url: null, status: "running" }),
    stream: async function* () {},
    getRun: async () => ({ status: "running", result: null, durationMs: null, branches: [], error: null }),
    usage: async () => ({ tokens_in: null, tokens_out: null, tokens_cache_read: null, tokens_cache_write: null, cost_usd: null }),
    followup: async () => ({ agentId: "bc-x", runId: "run-y", url: null, status: "running" }),
    cancel: async () => {},
    ...over,
  };
}

function mkCloudRun(): { job: Job; runId: string } {
  const job = mkJob({ backend: "test-cloud" });
  const r = runs.create(job.id, "manual");
  runs.patch(r.id, { status: "running", started_at: new Date().toISOString(), cloud_agent_id: "bc-1", cloud_run_id: "run-1" });
  return { job, runId: r.id };
}

test("stopRun on a cloud run: cancel() succeeds → the row is marked killed only after it confirms", async (t) => {
  t.after(() => setStopBackendResolver(null));
  let cancelled = false;
  let resolveCancel!: () => void;
  const gate = new Promise<void>((r) => (resolveCancel = r));
  setStopBackendResolver(() => fakeCloudBackend({ cancel: async () => { cancelled = true; await gate; } }));

  const { runId } = mkCloudRun();
  assert.equal(stopRun(runId), true, "the stop request is accepted synchronously");
  // Not yet — cancel() hasn't resolved, so the row must not lie about being killed.
  assert.equal(runs.get(runId)!.status, "running");
  assert.equal(cancelled, true, "cancel() was actually called");

  resolveCancel();
  await flushMicro();
  assert.equal(runs.get(runId)!.status, "killed");
});

test("stopRun on a cloud run: cancel() fails → NOT marked killed, the failure is recorded loudly", async (t) => {
  t.after(() => setStopBackendResolver(null));
  setStopBackendResolver(() => fakeCloudBackend({ cancel: async () => { throw new Error("provider unreachable"); } }));

  const { runId } = mkCloudRun();
  assert.equal(stopRun(runId), true);
  await flushMicro();

  const row = runs.get(runId)!;
  assert.equal(row.status, "running", "still running — a stop that silently 'succeeds' while billing continues is worse than one that errors");
  assert.match(row.error ?? "", /cloud cancel failed/);
  assert.match(row.error ?? "", /provider unreachable/);
});

test("stopRun on a finished cloud run is a no-op (nothing left to cancel)", async (t) => {
  t.after(() => setStopBackendResolver(null));
  let cancelCalls = 0;
  setStopBackendResolver(() => fakeCloudBackend({ cancel: async () => { cancelCalls++; } }));

  const { runId } = mkCloudRun();
  runs.patch(runId, { status: "success", ended_at: new Date().toISOString() });
  assert.equal(stopRun(runId), false);
  assert.equal(cancelCalls, 0);
});
