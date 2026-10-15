import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, jobs, runs } from "./store.js";
import { dispatch } from "./dispatcher.js";
import { cacheStats, hitShare, isStablePrefixMiss } from "./cache-health.js";
import { foldUsage } from "./runner.js";
import { claudeBackend } from "./backends/claude.js";
import type { Job, NewJob } from "./types.js";

test("hitShare: read share of cached tokens, null when nothing reported", () => {
  assert.equal(hitShare({ cache_read: 90_000, cache_write: 10_000 }), 0.9);
  assert.equal(hitShare({ cache_read: null, cache_write: null }), null);
  assert.equal(hitShare({ cache_read: 0, cache_write: 0 }), null);
  assert.equal(hitShare({ cache_read: null, cache_write: 60_000 }), 0);
});

test("isStablePrefixMiss: a single-turn run is a cold start, never churn", () => {
  // One API call writes the prefix and has nothing to read back — big write, zero reads, not churn.
  assert.equal(isStablePrefixMiss({ cache_read: 0, cache_write: 200_000, num_turns: 1 }), false);
  // Same numbers over many turns DID churn: the prefix was re-written instead of re-read.
  assert.equal(isStablePrefixMiss({ cache_read: 0, cache_write: 200_000, num_turns: 40 }), true);
  // Unknown turn count stays flaggable.
  assert.equal(isStablePrefixMiss({ cache_read: 0, cache_write: 200_000, num_turns: null }), true);
});

test("isStablePrefixMiss: flags churn, spares cold starts and healthy runs", () => {
  // Healthy long run: one prefix write, re-read on every later API call.
  assert.equal(isStablePrefixMiss({ cache_read: 900_000, cache_write: 60_000 }), false);
  // Cold start / short run: big-ish write but under the floor.
  assert.equal(isStablePrefixMiss({ cache_read: 5_000, cache_write: 40_000 }), false);
  // Churn: writes rival reads at scale — the prefix is being invalidated repeatedly.
  assert.equal(isStablePrefixMiss({ cache_read: 50_000, cache_write: 200_000 }), true);
  assert.equal(isStablePrefixMiss({ cache_read: null, cache_write: 80_000 }), true);
  // Nothing reported → unknown, never flagged.
  assert.equal(isStablePrefixMiss({ cache_read: null, cache_write: null }), false);
});

test("cacheStats: totals + miss count, rows with no data excluded from hit share", () => {
  const out = cacheStats([
    { cache_read: 900_000, cache_write: 60_000 },
    { cache_read: 50_000, cache_write: 200_000 }, // miss
    { cache_read: null, cache_write: null }, // non-claude backend — ignored
  ]);
  assert.equal(out.read, 950_000);
  assert.equal(out.write, 260_000);
  assert.equal(out.prefix_miss_runs, 1);
  assert.ok(out.hit_share! > 0.78 && out.hit_share! < 0.79);
  assert.equal(cacheStats([]).hit_share, null);
});

test("foldUsage: cumulative backends replace, per-step backends sum", () => {
  // claude reports running totals per result event — summing them would double-count once steer
  // mode makes it emit one result per user message.
  assert.equal(foldUsage(100, 250, true), 250);
  assert.equal(foldUsage(null, 250, true), 250);
  // opencode's step_finish reports this step only.
  assert.equal(foldUsage(100, 250, false), 350);
  assert.equal(foldUsage(null, 250, false), 250);
  // A field the backend never reports stays null under either mode (grok's null cost).
  assert.equal(foldUsage(null, null, true), null);
  assert.equal(foldUsage(7, undefined, false), 7);
});

test("claude extractResult marks usage cumulative", () => {
  const r = claudeBackend.extractResult({ type: "result", payload: { type: "result", result: "x", usage: {} } })!;
  assert.equal(r.usage_cumulative, true);
});

test("claude extractResult surfaces cache token fields", () => {
  const r = claudeBackend.extractResult({
    type: "result",
    payload: {
      type: "result",
      result: "done",
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1234, cache_creation_input_tokens: 567 },
    },
  })!;
  assert.equal(r.tokens_cache_read, 1234);
  assert.equal(r.tokens_cache_write, 567);
  const bare = claudeBackend.extractResult({ type: "result", payload: { type: "result", result: "x", usage: {} } })!;
  assert.equal(bare.tokens_cache_read, null);
  assert.equal(bare.tokens_cache_write, null);
});

// End-to-end through the real execute(): cache totals land on the run row and in cacheRowsSince.
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-cache-"));
let n = 0;
const mkJob = (goal: string, over: Partial<NewJob> = {}): Job =>
  jobs.create({ name: `cache${n++}`, goal, cwd, sandbox: "off", backend: "mock", retry_max: 0, ...over });

async function finished(runId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = runs.get(runId)!;
    if (r.status !== "queued" && r.status !== "running") return r;
    if (Date.now() > deadline) throw new Error(`run ${runId} still ${r.status}`);
    await new Promise((res) => setTimeout(res, 25));
  }
}

beforeEach(() => {
  db.exec("DELETE FROM run_events; DELETE FROM runs; DELETE FROM jobs;");
});

test("cache tokens flow from the result event onto the run row", async () => {
  const r = dispatch(mkJob("work\n!cache-read: 80000\n!cache-write: 12000").id, "test");
  assert.ok(!("error" in r));
  const run = await finished((r as any).run_id);
  assert.equal(run.status, "success");
  assert.equal(run.cache_read, 80_000);
  assert.equal(run.cache_write, 12_000);
  const rows = runs.cacheRowsSince(new Date(Date.now() - 60_000).toISOString());
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { cache_read: 80_000, cache_write: 12_000, num_turns: 1 });
});

test("runs without cache data stay null and out of the stats rows", async () => {
  const r = dispatch(mkJob("plain work").id, "test");
  const run = await finished((r as any).run_id);
  assert.equal(run.status, "success");
  assert.equal(run.cache_read, null);
  assert.equal(run.cache_write, null);
  assert.equal(runs.cacheRowsSince(new Date(Date.now() - 60_000).toISOString()).length, 0);
});
