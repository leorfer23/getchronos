import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asks, db, events, jobs, runs } from "./store.js";
import { dispatch } from "./dispatcher.js";
import { listBackends } from "./backends/index.js";
import { parseDirectives } from "./backends/mock.js";
import type { Job, NewJob } from "./types.js";

// End-to-end coverage of the REAL execute() — spawn, stream parsing, watchdog, rate-limit, park,
// verifier — made safe by the scripted mock backend (spawns `node -e`, no tokens, milliseconds per
// run). Everything flows through dispatch(), the production choke point. Real timers throughout:
// no run here may leave a live retry/resume timer behind (retry_max=0, resets beyond the cap), or
// the suite hangs on a timer that keeps the event loop alive.

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-exec-"));
let n = 0;
const mkJob = (goal: string, over: Partial<NewJob> = {}): Job =>
  jobs.create({ name: `exec${n++}`, goal, cwd, sandbox: "off", backend: "mock", retry_max: 0, ...over });

async function finished(runId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = runs.get(runId)!;
    if (r.status !== "queued" && r.status !== "running") return r;
    if (Date.now() > deadline) throw new Error(`run ${runId} still ${r.status} after ${timeoutMs}ms`);
    await new Promise((res) => setTimeout(res, 25));
  }
}

function dispatched(job: Job, context?: string | null): string {
  const r = dispatch(job.id, "test", 0, context);
  assert.ok(!("error" in r), `dispatch refused: ${(r as any).error}`);
  return (r as any).run_id;
}

beforeEach(() => {
  db.exec("DELETE FROM run_events; DELETE FROM asks; DELETE FROM runs; DELETE FROM jobs;");
});

test("mock directives parse", () => {
  assert.deepEqual(parseDirectives("do stuff\n!error: boom\n!cost: 0.25"), [
    { name: "error", arg: "boom" },
    { name: "cost", arg: "0.25" },
  ]);
  assert.deepEqual(parseDirectives("no directives here"), []);
});

test("success: result event lands on the run row and the event log", async () => {
  const runId = dispatched(mkJob("say hello"));
  const r = await finished(runId);
  assert.equal(r.status, "success");
  assert.equal(r.summary, "mock: say hello");
  assert.equal(r.cost_usd, 0.01);
  assert.equal(r.tokens_in, 100);
  assert.equal(r.tokens_out, 50);
  assert.equal(r.num_turns, 1);
  assert.equal(r.exit_code, 0);
  assert.ok(r.session_id);
  const types = events.list(runId).map((e) => e.type);
  assert.ok(types.includes("system"));
  assert.ok(types.includes("result"));
});

test("trigger context reaches the spawned process (directives in context take effect)", async () => {
  const runId = dispatched(mkJob("ctx run"), "!cost: 0.25");
  const r = await finished(runId);
  assert.equal(r.status, "success");
  assert.equal(r.cost_usd, 0.25);
});

test("a zero-cost run reports 0, not the 0.01 default", async () => {
  const runId = dispatched(mkJob("free run\n!cost: 0"));
  const r = await finished(runId);
  assert.equal(r.status, "success");
  assert.equal(r.cost_usd, 0);
});

test("mock resolves by name but is not advertised to the UI/API backend list", () => {
  assert.ok(!listBackends().some((b) => b.name === "mock"));
});

test("agent-reported error: is_error result fails the run with the result text", async () => {
  const runId = dispatched(mkJob("work\n!error: boom"));
  const r = await finished(runId);
  assert.equal(r.status, "failed");
  assert.equal(r.error, "boom");
});

test("non-zero exit without a result fails with the stderr tail", async () => {
  const runId = dispatched(mkJob("work\n!stderr: kaboom\n!exit: 2"));
  const r = await finished(runId);
  assert.equal(r.status, "failed");
  assert.equal(r.exit_code, 2);
  assert.match(r.error ?? "", /kaboom/);
});

test("clean exit with no result event is a failure, not a silent success", async () => {
  const runId = dispatched(mkJob("work\n!no-result"));
  const r = await finished(runId);
  assert.equal(r.status, "failed");
  assert.equal(r.exit_code, 0);
});

test("watchdog: a run past timeout_sec ends as timeout", async () => {
  const runId = dispatched(mkJob("work\n!sleep: 30000", { timeout_sec: 1 }));
  const r = await finished(runId);
  assert.equal(r.status, "timeout");
});

test("rate limit: rejected event becomes rate_limited with resets_at recorded", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 30 * 3600;
  const runId = dispatched(mkJob(`work\n!rate-limit: ${resetsAt}`));
  const r = await finished(runId);
  assert.equal(r.status, "rate_limited");
  assert.equal(r.resets_at, new Date(resetsAt * 1000).toISOString());
  assert.match(r.error ?? "", /rate limited/);
});

test("verifier: a failing verdict flips success to failed and stores the verdict", async () => {
  const runId = dispatched(mkJob('build the thing\n!verdict: {"met": false, "reason": "file missing"}', { verify: true }));
  const r = await finished(runId);
  assert.equal(r.status, "failed");
  assert.equal(r.error, "verifier: file missing");
  const verdict = JSON.parse(r.verify_verdict!);
  assert.equal(verdict.met, false);
  assert.equal(verdict.reason, "file missing");
});

test("verifier: a passing verdict keeps success", async () => {
  const runId = dispatched(mkJob("build the thing", { verify: true }));
  const r = await finished(runId);
  assert.equal(r.status, "success");
  assert.equal(JSON.parse(r.verify_verdict!).met, true);
});

test("park: success with an open ask becomes paused", async () => {
  const job = mkJob("work\n!sleep: 600");
  const runId = dispatched(job);
  assert.equal(runs.get(runId)!.status, "running");
  asks.create({ run_id: runId, job_id: job.id, question: "which color?" });
  const r = await finished(runId);
  assert.equal(r.status, "paused");
});

test("park exemption: a read-only run with an open ask still finishes", async () => {
  const job = mkJob("check\n!sleep: 400", { name: "review:park-exempt" });
  const runId = dispatched(job);
  asks.create({ run_id: runId, job_id: job.id, question: "fire-and-forget" });
  const r = await finished(runId);
  assert.equal(r.status, "success");
});

// PER-35: intake: was missing from READONLY_RUN_PREFIXES — clean exit + stray ask → paused.
test("park exemption: an intake sweep with an open ask still finishes", async () => {
  const job = mkJob("Sweep complete.\n!sleep: 400", { name: "intake:personal" });
  const runId = dispatched(job);
  asks.create({ run_id: runId, job_id: job.id, question: "list" });
  const r = await finished(runId);
  assert.equal(r.status, "success");
});
