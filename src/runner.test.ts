import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCloudRepos,
  executeCloud,
  githubHttpsUrl,
  isReadOnlyRun,
  launchCloudWithRetry,
  shouldFileReviewOnEnd,
  worktreeSandboxDirs,
} from "./runner.js";
import { createTicket } from "./tickets.js";
import { db, jobs, repos, runs, workspaces } from "./store.js";
import type { CloudBackend, CloudLaunch, CloudLaunchOpts } from "./backends/types.js";
import type { Repo } from "./types.js";

// Building in a worktree must WRITE-DENY the shared main checkout (guard is allow-by-default) while
// re-granting its .git (worktree commits) + .mc (ticket store) — else the agent commits its edits
// onto main (PER-36). Read stays allowed (readonly, not deny) so linked-worktree git still works.
test("worktreeSandboxDirs marks the shared checkout readonly, re-grants .git + .mc", () => {
  const r = worktreeSandboxDirs("/Users/dev/chronos", "/Users/dev/.chronos-worktrees/chronos/mc-per-36");
  assert.deepEqual(r.readonly, ["/Users/dev/chronos"]);
  assert.deepEqual(r.grant, ["/Users/dev/chronos/.git", "/Users/dev/chronos/.mc"]);
});

test("worktreeSandboxDirs is a no-op when not in a worktree (cwd === repo) or no repo", () => {
  assert.deepEqual(worktreeSandboxDirs("/Users/dev/chronos", "/Users/dev/chronos"), { readonly: [], grant: [] });
  assert.deepEqual(worktreeSandboxDirs(null, "/anywhere"), { readonly: [], grant: [] });
  assert.deepEqual(worktreeSandboxDirs(undefined, "/anywhere"), { readonly: [], grant: [] });
});

// Regression: `grade:` was missing from the read-only list, so difficulty-grader runs created
// reviews and git-add-A-committed the shared checkout onto main. `intake:` was missing the same
// way — a clean-exit intake sweep parked on a stray ask (PER-35). All read-only kinds must be caught.
test("isReadOnlyRun excludes every read-only run kind, includes builds", () => {
  for (const name of [
    "plan:PER-1", "review:PER-1", "distill:PER-1", "grade:PER-1",
    "ideas:miner:personal", "intake:personal",
  ]) {
    assert.equal(isReadOnlyRun(name), true, `${name} must be read-only`);
  }
  assert.equal(isReadOnlyRun("build:PER-1"), false);
  assert.equal(isReadOnlyRun("slack-triage:globex"), false);
  // The rate-limit fallback clones a job as `fallback:<name>`. Read as a build, a stand-in reviewer
  // queued a review of its own run → auto-dispatch → rate limit → fallback → 200 runs on PER-80.
  for (const name of [
    "fallback:review:PER-1", "fallback:plan:PER-1",
    "fallback:ideas:followups:PER-1", "fallback:intake:personal",
  ]) {
    assert.equal(isReadOnlyRun(name), true, `${name} must be read-only`);
  }
  assert.equal(isReadOnlyRun("fallback:ticket:PER-1"), false);
  assert.equal(isReadOnlyRun(null), false);
  assert.equal(isReadOnlyRun(undefined), false);
});

// merge-gate:/ci-fix: write in the ticket worktree, so they stay OFF isReadOnlyRun (worktree lock).
// Ending them must still skip createForRun — otherwise review.created → auto-review → approve →
// merge() re-arms delivery and the gate runs again (PER-4 / PER-13).
test("shouldFileReviewOnEnd skips read-only and post-build gates; keeps real builds", () => {
  for (const name of ["plan:PER-1", "review:PER-1", "merge-gate:PER-1", "ci-fix:PER-1", "fallback:merge-gate:PER-1", "fallback:ci-fix:PER-1"]) {
    assert.equal(shouldFileReviewOnEnd(name), false, `${name} must not file a review on end`);
  }
  // Still take the worktree lock — not classified as read-only.
  assert.equal(isReadOnlyRun("merge-gate:PER-1"), false);
  assert.equal(isReadOnlyRun("ci-fix:PER-1"), false);
  assert.equal(shouldFileReviewOnEnd("ticket:PER-1"), true);
  assert.equal(shouldFileReviewOnEnd("build:PER-1"), true);
  assert.equal(shouldFileReviewOnEnd("fallback:ticket:PER-1"), true);
  assert.equal(shouldFileReviewOnEnd(null), false);
});

// ───────────────────────────── cloud helpers ─────────────────────────────

test("githubHttpsUrl normalizes every remote shape CloudLaunchOpts.repos needs (https urls)", () => {
  assert.equal(githubHttpsUrl("git@github.com:acme/widget.git"), "https://github.com/acme/widget");
  assert.equal(githubHttpsUrl("ssh://git@github.com/acme/widget.git"), "https://github.com/acme/widget");
  assert.equal(githubHttpsUrl("https://github.com/acme/widget.git"), "https://github.com/acme/widget");
  assert.equal(githubHttpsUrl("https://github.com/acme/widget"), "https://github.com/acme/widget");
  assert.equal(githubHttpsUrl("https://github.com/acme/widget/"), "https://github.com/acme/widget");
  assert.equal(githubHttpsUrl(null), null);
  assert.equal(githubHttpsUrl(""), null);
  assert.equal(githubHttpsUrl("not a remote"), null);
});

const mkRepo = (over: Partial<Repo> = {}): Repo => ({
  id: "r1", workspace_id: "w1", parent_id: null, name: "widget", path: "/repo",
  git_remote: "git@github.com:acme/widget.git", default_branch: "main", delivery: "pr",
  done_criteria: null, verify_cmd: null, gate_cmds: null, risk_paths: null, human_gate: "always",
  review_min_difficulty: null, post_merge_cmd: null, ideas_enabled: 0, created_at: "now",
  ...over,
});

test("buildCloudRepos: work repo first with its default branch as startingRef", () => {
  const out = buildCloudRepos(mkRepo(), []);
  assert.deepEqual(out, [{ url: "https://github.com/acme/widget", startingRef: "main" }]);
});

test("buildCloudRepos: add_dirs repos with a GitHub remote are appended, no remote is dropped", () => {
  const extra = mkRepo({ id: "r2", name: "sibling", git_remote: "https://github.com/acme/sibling.git", default_branch: "develop" });
  const noRemote = mkRepo({ id: "r3", name: "local-only", git_remote: null });
  const out = buildCloudRepos(mkRepo(), [extra, noRemote]);
  assert.deepEqual(out, [
    { url: "https://github.com/acme/widget", startingRef: "main" },
    { url: "https://github.com/acme/sibling", startingRef: "develop" },
  ]);
});

test("buildCloudRepos: no work repo, no GitHub remote at all → empty (executeCloud fails the run)", () => {
  assert.deepEqual(buildCloudRepos(undefined, []), []);
  assert.deepEqual(buildCloudRepos(mkRepo({ git_remote: null }), []), []);
});

test("buildCloudRepos: dedupes and caps at 20", () => {
  const dupe = mkRepo({ id: "r2" }); // same git_remote as the work repo
  assert.equal(buildCloudRepos(mkRepo(), [dupe]).length, 1);
  const many = Array.from({ length: 25 }, (_, i) => mkRepo({ id: `x${i}`, git_remote: `git@github.com:acme/repo${i}.git` }));
  assert.equal(buildCloudRepos(mkRepo(), many).length, 20);
});

test("launchCloudWithRetry: succeeds first try, no retry", async () => {
  let calls = 0;
  const launch: CloudLaunch = { agentId: "bc-1", runId: "run-1", url: null, status: "running" };
  const backend: any = { launch: async () => { calls++; return launch; } };
  const out = await launchCloudWithRetry(backend, { runId: "r" } as CloudLaunchOpts);
  assert.equal(out, launch);
  assert.equal(calls, 1);
});

test("launchCloudWithRetry: retries a 429 up to 3 tries, honouring retryAfter, then succeeds", async () => {
  let calls = 0;
  const waited: number[] = [];
  const realSetTimeout = global.setTimeout;
  // @ts-expect-error test shim — collapse the backoff waits so the test stays fast
  global.setTimeout = (fn: () => void, ms: number) => { waited.push(ms); return realSetTimeout(fn, 0); };
  try {
    const launch: CloudLaunch = { agentId: "bc-1", runId: "run-1", url: null, status: "running" };
    const backend: any = {
      launch: async () => {
        calls++;
        if (calls < 3) { const e: any = new Error("rate limited"); e.status = 429; e.retryAfter = 5; throw e; }
        return launch;
      },
    };
    const out = await launchCloudWithRetry(backend, { runId: "r" } as CloudLaunchOpts);
    assert.equal(out, launch);
    assert.equal(calls, 3);
    assert.deepEqual(waited, [5000, 5000]);
  } finally {
    global.setTimeout = realSetTimeout;
  }
});

test("launchCloudWithRetry: a non-429 error throws immediately, no retry", async () => {
  let calls = 0;
  const backend: any = { launch: async () => { calls++; throw new Error("bad request"); } };
  await assert.rejects(() => launchCloudWithRetry(backend, { runId: "r" } as CloudLaunchOpts), /bad request/);
  assert.equal(calls, 1);
});

// ───────────────────────────── executeCloud ─────────────────────────────

const cloudCwd = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-execute-cloud-"));
let cn = 0;

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
    launch: async () => ({ agentId: "bc-x", runId: "run-x", url: "https://cursor.com/agents/bc-x", status: "running" }),
    stream: async function* () {},
    getRun: async () => ({ status: "finished", result: "done", durationMs: 1000, branches: [], error: null }),
    usage: async () => ({ tokens_in: 10, tokens_out: 5, tokens_cache_read: null, tokens_cache_write: null, cost_usd: 0.01 }),
    followup: async () => ({ agentId: "bc-x", runId: "run-y", url: null, status: "running" }),
    cancel: async () => {},
    ...over,
  };
}

function seedCloudJob(): { job: ReturnType<typeof jobs.create>; runId: string } {
  const id = cn++;
  const ws = workspaces.create({ slug: `execloud-${id}`, name: "ExecCloud", config_dir: cloudCwd, default_backend: "mock", sandbox_mode: "off" });
  const repo = repos.create({ workspace_id: ws.id, name: "r", path: cloudCwd, default_branch: "main", git_remote: "https://github.com/acme/widget.git" });
  const t = createTicket({ workspace_id: ws.id, repo_id: repo.id, title: `Cloud exec ${id}` });
  const job = jobs.create({
    name: `ticket:CLE-${id}`, goal: "g", workspace_id: ws.id, ticket_id: t.id,
    cwd: cloudCwd, sandbox: "off", backend: "test-cloud", timeout_sec: 3600, retry_max: 0,
  });
  const run = runs.create(job.id, "test");
  return { job, runId: run.id };
}

beforeEach(() => {
  db.exec("DELETE FROM run_events; DELETE FROM reviews; DELETE FROM runs; DELETE FROM jobs; DELETE FROM tickets; DELETE FROM repos; DELETE FROM workspaces;");
});

test("executeCloud: launch → terminal stream → finalize, persisting the ids up front", async () => {
  const { job, runId } = seedCloudJob();
  const backend = fakeCloudBackend({
    stream: async function* (): AsyncGenerator<any> {
      yield { eventId: "e1", event: { type: "assistant", payload: { text: "hi" } }, terminal: false };
      yield { eventId: "e2", event: { type: "result", payload: {} }, terminal: true };
    },
    getRun: async () => ({
      status: "finished", result: "shipped", durationMs: 1,
      branches: [{ repoUrl: "https://github.com/acme/widget", branch: "cursor/widget-1", prUrl: "https://github.com/acme/widget/pull/3" }],
      error: null,
    }),
  });

  const status = await executeCloud(job, runId, backend);

  assert.equal(status, "success");
  const row = runs.get(runId)!;
  assert.equal(row.cloud_agent_id, "bc-x");
  assert.equal(row.cloud_run_id, "run-x");
  assert.equal(row.cloud_url, "https://cursor.com/agents/bc-x");
  assert.equal(row.summary, "shipped");
});

test("executeCloud: a disconnected stream (no terminal frame) leaves the run running for the reconciler", async () => {
  const { job, runId } = seedCloudJob();
  const backend = fakeCloudBackend({
    // Ends without ever yielding a terminal frame — Mac slept, wifi dropped, whatever.
    stream: async function* (): AsyncGenerator<any> {
      yield { eventId: "e1", event: { type: "status", payload: {} }, terminal: false };
    },
  });

  const status = await executeCloud(job, runId, backend);

  assert.equal(status, "running");
  const row = runs.get(runId)!;
  assert.equal(row.status, "running");
  assert.equal(row.error, null);
  assert.equal(row.cloud_agent_id, "bc-x", "ids are still persisted even though the run isn't finished");
});

test("executeCloud: no repo with a GitHub remote fails fast without ever calling launch", async () => {
  const id = cn++;
  const ws = workspaces.create({ slug: `execloud-norepo-${id}`, name: "NoRepo", config_dir: cloudCwd, default_backend: "mock", sandbox_mode: "off" });
  const job = jobs.create({ name: `cloud-job-${id}`, goal: "g", workspace_id: ws.id, cwd: cloudCwd, sandbox: "off", backend: "test-cloud", retry_max: 0 });
  const run = runs.create(job.id, "test");
  let launchCalled = false;
  const backend = fakeCloudBackend({ launch: async () => { launchCalled = true; throw new Error("must not be called"); } });

  const status = await executeCloud(job, run.id, backend);

  assert.equal(status, "failed");
  assert.equal(launchCalled, false);
  assert.match(runs.get(run.id)!.error ?? "", /GitHub remote/);
});
