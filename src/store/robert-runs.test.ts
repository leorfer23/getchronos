import test from "node:test";
import assert from "node:assert/strict";
import { db, robertRuns, rollupRuns } from "../store.js";
import { turnUsageOf } from "../usage-meter.js";

const T0 = "2026-09-12T12:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();

function reset() {
  db.prepare("DELETE FROM robert_runs").run();
}

const run = (over: Partial<Parameters<typeof robertRuns.record>[0]> = {}) =>
  robertRuns.record({
    workspace_id: null,
    started_at: at(0),
    ended_at: at(1),
    wakes: [{ key: "robert-sweep:ws", topic: "robert.sweep" }],
    outcome: "quiet",
    ...over,
  });

test("a run row keeps what it presented, how long it took, and nulls for usage it never got", () => {
  reset();
  const r = run({ wakes: [{ key: "ask:a1", topic: "ask.created" }, { key: "review:r1", topic: "review.created" }], outcome: "posted", model: "sonnet", engine: "claude/sonnet", steps: 2, reply_chars: 40 });
  const [back] = robertRuns.list();
  assert.equal(back.id, r.id);
  assert.equal(back.n_wakes, 2);
  assert.deepEqual(JSON.parse(back.wake_keys), ["ask:a1", "review:r1"]);
  assert.deepEqual(JSON.parse(back.topics), ["ask.created", "review.created"]);
  assert.equal(back.duration_ms, 60_000);
  assert.equal(back.outcome, "posted");
  assert.equal(back.tokens_in, null);
  assert.equal(back.cost_usd, null);
});

test("a failed run's error is capped", () => {
  reset();
  run({ outcome: "failed", error: "x".repeat(5000) });
  assert.equal(robertRuns.list()[0].error!.length, 500);
});

test("list filters by window and scope: undefined = all, null = default scope, an id = that workspace", () => {
  reset();
  run({ workspace_id: null, started_at: at(0), ended_at: at(1) });
  run({ workspace_id: "ws-acme", started_at: at(10), ended_at: at(11) });
  run({ workspace_id: "ws-globex", started_at: at(20), ended_at: at(21) });
  assert.equal(robertRuns.list().length, 3);
  assert.deepEqual(robertRuns.list({ workspace_id: null }).map((r) => r.workspace_id), [null]);
  assert.deepEqual(robertRuns.list({ workspace_id: "ws-acme" }).map((r) => r.workspace_id), ["ws-acme"]);
  assert.deepEqual(robertRuns.list({ since: at(5) }).map((r) => r.workspace_id), ["ws-globex", "ws-acme"], "newest first");
});

test("prune keeps the newest rows", () => {
  reset();
  for (let i = 0; i < 5; i++) run({ started_at: at(i), ended_at: at(i) });
  robertRuns.prune(2);
  assert.deepEqual(robertRuns.list().map((r) => r.started_at), [at(4), at(3)]);
});

test("the rollup counts outcomes, sums only reported usage, and says how many turns reported any", () => {
  reset();
  run({ workspace_id: "ws-acme", outcome: "posted", tokens_in: 10, tokens_out: 5, tokens_cache_read: 100, tokens_cache_write: 7, cost_usd: 0.25 });
  run({ workspace_id: "ws-acme", outcome: "quiet", tokens_in: 2, tokens_out: 1, cost_usd: 0.05 });
  run({ workspace_id: "ws-globex", outcome: "failed", wakes: [{ key: "ask:a", topic: "ask.created" }, { key: "review:b", topic: "review.created" }] });
  const r = rollupRuns(robertRuns.list());
  assert.equal(r.runs, 3);
  assert.equal(r.wakes, 4);
  assert.deepEqual(r.by_outcome, { posted: 1, quiet: 1, empty: 0, dropped: 0, failed: 1 });
  assert.deepEqual(r.tokens, { in: 12, out: 6, cache_read: 100, cache_write: 7 });
  assert.equal(r.metered, 2);
  assert.equal(Math.round(r.cost_usd! * 100), 30);
  assert.equal(r.by_workspace["ws-globex"].cost_usd, null, "no reported cost stays unknown, not $0");
  assert.equal(r.by_workspace["ws-globex"].metered, 0);
  assert.equal(r.by_workspace["ws-acme"].runs, 2);
  assert.equal(r.by_topic["robert.sweep"].runs, 2);
  assert.equal(r.by_topic["ask.created"].by_outcome.failed, 1);
});

test("turnUsageOf reads a claude result line and leaves what it lacks null", () => {
  assert.deepEqual(
    turnUsageOf({ type: "result", total_cost_usd: 0.12, usage: { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 } }),
    { tokens_in: 3, tokens_out: 40, tokens_cache_read: 900, tokens_cache_write: 50, cost_usd: 0.12 },
  );
  assert.deepEqual(turnUsageOf({ type: "result" }), { tokens_in: null, tokens_out: null, tokens_cache_read: null, tokens_cache_write: null, cost_usd: null });
});
