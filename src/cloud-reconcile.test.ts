/**
 * The reconciler's job: pick a cloud run back up whenever it's alive, with no in-memory state to
 * lean on — a daemon restart is indistinguishable from "the last tick finished". No network: every
 * test drives a hand-written fake CloudBackend (see CLAUDE.md #2 — never the real execute()/a real
 * backend). `node --import tsx --test`, matching every other suite in this repo.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTicket } from "./tickets.js";
import { db, jobs, repos, runs, tickets, workspaces } from "./store.js";
import {
  isCloudTimedOut,
  reconcileOne,
  resetCloudReconcileForTest,
  setBackendResolver,
  tick,
  isReconcileArmed,
} from "./cloud-reconcile.js";
import { isCloudStreaming, streamCloudRun } from "./runner.js";
import type { CloudBackend, CloudLaunch, CloudRunState, CloudUsage } from "./backends/types.js";
import type { Job, Run } from "./types.js";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-cloud-reconcile-"));
let n = 0;

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
    launch: async (): Promise<CloudLaunch> => ({ agentId: "bc-x", runId: "run-x", url: "https://cursor.com/agents/bc-x", status: "running" }),
    stream: async function* () {},
    getRun: async (): Promise<CloudRunState> => ({ status: "finished", result: "done", durationMs: 1000, branches: [], error: null }),
    usage: async (): Promise<CloudUsage> => ({ tokens_in: 10, tokens_out: 5, tokens_cache_read: null, tokens_cache_write: null, cost_usd: 0.01 }),
    followup: async (): Promise<CloudLaunch> => ({ agentId: "bc-x", runId: "run-y", url: null, status: "running" }),
    cancel: async () => {},
    ...over,
  };
}

// A ticket + a running cloud run, with no real git anywhere: repo.path === job.cwd keeps
// createForRun's git add/commit path a no-op (see reviews.ts inWorktree), so a ticket-bound run
// exercises pr_url + review-queueing without needing a real checkout.
function seed(opts: { ticket?: boolean; timeoutSec?: number } = {}): { job: Job; run: Run } {
  const id = n++;
  const ws = workspaces.create({ slug: `cloudrec-${id}`, name: "CloudRec", config_dir: cwd, default_backend: "mock", sandbox_mode: "off" });
  let ticketId: string | null = null;
  if (opts.ticket !== false) {
    const repo = repos.create({ workspace_id: ws.id, name: "r", path: cwd, default_branch: "main", git_remote: "https://github.com/acme/widget.git" });
    const t = createTicket({ workspace_id: ws.id, repo_id: repo.id, title: `Cloud ticket ${id}` });
    ticketId = t.id;
  }
  const job = jobs.create({
    name: ticketId ? `ticket:CLD-${id}` : `cloud-job-${id}`,
    goal: "do the cloud thing",
    workspace_id: ws.id,
    ticket_id: ticketId,
    cwd,
    sandbox: "off",
    backend: "test-cloud",
    timeout_sec: opts.timeoutSec ?? 3600,
    retry_max: 0,
  });
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, {
    status: "running",
    started_at: new Date().toISOString(),
    cloud_agent_id: `bc-${id}`,
    cloud_run_id: `run-${id}`,
    cloud_url: `https://cursor.com/agents/bc-${id}`,
  });
  return { job, run: runs.get(run.id)! };
}

beforeEach(() => {
  db.exec("DELETE FROM run_events; DELETE FROM reviews; DELETE FROM runs; DELETE FROM jobs; DELETE FROM tickets; DELETE FROM repos; DELETE FROM workspaces;");
  resetCloudReconcileForTest();
});

// ── the definition-of-done scenario ─────────────────────────────────────────

test("stream dies mid-run (daemon restart): the reconciler finds it, finalizes with the right status/cost/summary/PR url", async () => {
  const { job, run } = seed();
  const backend = fakeCloudBackend({
    // No live stream in THIS process (isCloudStreaming(run.id) is false — nothing ever attached),
    // exactly what a fresh daemon process sees after a restart.
    getRun: async () => ({
      status: "finished",
      result: "shipped the widget",
      durationMs: 5000,
      branches: [{ repoUrl: "https://github.com/acme/widget", branch: "cursor/widget-1", prUrl: "https://github.com/acme/widget/pull/9" }],
      error: null,
    }),
    usage: async () => ({ tokens_in: 1000, tokens_out: 200, tokens_cache_read: 50, tokens_cache_write: 10, cost_usd: 0.42 }),
  });

  await reconcileOne(job, run, backend);

  const row = runs.get(run.id)!;
  assert.equal(row.status, "success");
  assert.equal(row.summary, "shipped the widget");
  assert.equal(row.cost_usd, 0.42);
  assert.equal(row.cost_estimated, 0);
  assert.equal(row.tokens_in, 1000);
  assert.equal(row.tokens_out, 200);
  assert.equal(row.cache_read, 50);
  assert.equal(row.cache_write, 10);
  assert.ok(row.ended_at);

  const t = tickets.get(job.ticket_id!)!;
  assert.equal(t.pr_url, "https://github.com/acme/widget/pull/9");
  assert.equal(t.pr_state, "open");
});

// ── terminal status mapping ─────────────────────────────────────────────────

for (const [providerStatus, expected] of [
  ["finished", "success"],
  ["error", "failed"],
  ["cancelled", "killed"],
  ["expired", "timeout"],
] as const) {
  test(`terminal status maps correctly: ${providerStatus} → ${expected}`, async () => {
    const { job, run } = seed({ ticket: false });
    const backend = fakeCloudBackend({
      getRun: async () => ({ status: providerStatus, result: providerStatus === "error" ? null : "x", durationMs: 1, branches: [], error: providerStatus === "error" ? "boom" : null }),
    });
    await reconcileOne(job, run, backend);
    assert.equal(runs.get(run.id)!.status, expected);
  });
}

// ── a disconnect alone changes nothing ──────────────────────────────────────

test("a disconnect alone (provider still RUNNING) changes no status — only reattaches", async () => {
  const { job, run } = seed({ ticket: false });
  let getRunCalls = 0;
  const backend = fakeCloudBackend({
    getRun: async () => {
      getRunCalls++;
      return { status: "running", result: null, durationMs: null, branches: [], error: null };
    },
    // The stream immediately ends without a terminal frame — a disconnect, not a finish.
    stream: async function* () {},
  });

  await reconcileOne(job, run, backend);
  // reconcileOne fires the reattach and returns without waiting for it to drain.
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(getRunCalls, 1);
  assert.equal(runs.get(run.id)!.status, "running", "still running — a disconnect is not a failure");
  assert.equal(runs.get(run.id)!.error, null);
});

// ── resume uses cloud_last_event_id ─────────────────────────────────────────

test("reattach resumes the stream from cloud_last_event_id, not from the start", async () => {
  const { job, run } = seed({ ticket: false });
  runs.patch(run.id, { cloud_last_event_id: "evt-42" });
  const row = runs.get(run.id)!;

  let seenLastEventId: string | null | undefined;
  const backend = fakeCloudBackend({
    getRun: async () => ({ status: "running", result: null, durationMs: null, branches: [], error: null }),
    stream: async function* (_ref, lastEventId) {
      seenLastEventId = lastEventId;
    },
  });

  await reconcileOne(job, row, backend);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(seenLastEventId, "evt-42");
});

test("reconcileOne skips the poll entirely when this process already has the stream attached", async () => {
  const { job, run } = seed({ ticket: false });
  let getRunCalls = 0;
  const backend = fakeCloudBackend({ getRun: async () => { getRunCalls++; return { status: "finished", result: "x", durationMs: 1, branches: [], error: null }; } });

  // Simulate an in-flight attach from executeCloud by holding the stream open.
  let releaseStream: () => void = () => {};
  const held = new Promise<void>((res) => (releaseStream = res));
  const holdingBackend = fakeCloudBackend({
    stream: async function* (): AsyncGenerator<any> {
      await held;
    },
  });
  // streamCloudRun marks the run as attached synchronously, before its first await — no sleep to
  // race (a 10ms setTimeout against a dynamic import() lost on a loaded macOS CI runner).
  const attachPromise = streamCloudRun(holdingBackend, { agentId: run.cloud_agent_id!, runId: run.cloud_run_id!, workspaceId: null }, run.id, null);
  assert.equal(isCloudStreaming(run.id), true);

  await reconcileOne(job, run, backend);
  assert.equal(getRunCalls, 0, "no API call spent — the live attach owns this run");

  releaseStream();
  await attachPromise;
});

// ── timeout cancels ──────────────────────────────────────────────────────────

test("isCloudTimedOut: pure age check against job.timeout_sec", () => {
  const old = { started_at: new Date(Date.now() - 3600_000).toISOString() };
  assert.equal(isCloudTimedOut(old, 1800), true);
  assert.equal(isCloudTimedOut(old, 7200), false);
  assert.equal(isCloudTimedOut({ started_at: null }, 10), false);
  assert.equal(isCloudTimedOut(old, 0), false, "0 = no timeout configured");
});

test("a run older than job.timeout_sec is cancelled and finalized as timeout", async () => {
  const { job, run } = seed({ ticket: false, timeoutSec: 1 });
  runs.patch(run.id, { started_at: new Date(Date.now() - 5000).toISOString() });
  let cancelled = false;
  const backend = fakeCloudBackend({
    cancel: async () => { cancelled = true; },
    // Even if the provider hasn't caught up yet, forceStatus wins.
    getRun: async () => ({ status: "running", result: null, durationMs: null, branches: [], error: null }),
  });

  await reconcileOne(job, runs.get(run.id)!, backend);

  assert.equal(cancelled, true);
  assert.equal(runs.get(run.id)!.status, "timeout");
});

test("cancel failing (non-rate-limit) still finalizes as timeout — the clock, not the provider, decides", async () => {
  const { job, run } = seed({ ticket: false, timeoutSec: 1 });
  runs.patch(run.id, { started_at: new Date(Date.now() - 5000).toISOString() });
  const backend = fakeCloudBackend({
    cancel: async () => { throw new Error("network blip"); },
    getRun: async () => ({ status: "finished", result: "x", durationMs: 1, branches: [], error: null }),
  });

  await reconcileOne(job, runs.get(run.id)!, backend);
  assert.equal(runs.get(run.id)!.status, "timeout");
});

// ── the timer only exists when there's something to watch ──────────────────

test("the timer does not start when no cloud run is live", async () => {
  assert.equal(isReconcileArmed(), false);
  await tick();
  assert.equal(isReconcileArmed(), false);
});

test("the timer arms while a cloud run is running, and drops once it's the only one and it finishes", async () => {
  const { job, run } = seed({ ticket: false });
  setBackendResolver((name) => (name === "test-cloud" ? fakeCloudBackend({ getRun: async () => ({ status: "running", result: null, durationMs: null, branches: [], error: null }), stream: async function* () {} }) : fakeCloudBackend()));

  await tick();
  assert.equal(isReconcileArmed(), true);

  runs.patch(run.id, { status: "success", ended_at: new Date().toISOString() });
  void job; // job row itself is untouched by this assertion
  await tick();
  assert.equal(isReconcileArmed(), false);
});

// ── budget: a resolved-but-non-cloud backend is skipped defensively ────────

test("tick skips a run whose job backend no longer resolves to a cloud backend", async () => {
  const { run } = seed({ ticket: false });
  setBackendResolver(() => ({ name: "local", supportsResume: false, bin: () => "x", buildArgs: () => [], oneShot: () => ({ cmd: "x", args: [], env: {} }), env: () => ({}), parseLine: () => ({ type: "raw", payload: {} }), extractResult: () => null, detectRateLimit: () => null }));
  await tick();
  // Untouched — still running, because the (now local) backend was skipped rather than finalized.
  assert.equal(runs.get(run.id)!.status, "running");
});
