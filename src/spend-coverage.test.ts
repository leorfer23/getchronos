import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { jobs, runs, workspaces } from "./store.js";

/**
 * PER-24: `cost_usd` is null-preserving, so SUM() silently skips every run a backend never priced.
 * On 2026-08-05 that was 63 of 69 personal runs and the reported total ($33.94) was read as the
 * day's spend. These tests pin the coverage figure that has to travel with the number.
 */

const today = () => new Date().toISOString().slice(0, 10);

function seedRun(backend: string, cost: number | null, ended = true) {
  const ws = workspaces.create({
    slug: "cov-" + randomUUID().slice(0, 8),
    name: "Cov",
    config_dir: "/tmp/cov",
  } as any);
  const job = jobs.create({ name: "j-" + randomUUID().slice(0, 6), goal: "g", workspace_id: ws.id, cwd: "/tmp", backend } as any);
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, {
    // started_at is set at dispatch, not creation — and it is what the coverage window filters on.
    started_at: new Date().toISOString(),
    status: ended ? "success" : "running",
    ...(ended ? { ended_at: new Date().toISOString() } : {}),
    ...(cost === null ? {} : { cost_usd: cost }),
  });
  return run;
}

test("spendCoverageSince separates what was priced from what was merely reported as $0", () => {
  const before = runs.spendCoverageSince(today());

  seedRun("claude-code", 2.5);
  seedRun("claude-code", 1.5);
  seedRun("grok", null);
  seedRun("grok", null);
  seedRun("cursor-agent", null);

  const cov = runs.spendCoverageSince(today());
  assert.equal(Number((cov.usd - before.usd).toFixed(2)), 4, "only the metered runs contribute dollars");
  assert.equal(cov.priced - before.priced, 2);
  assert.equal(cov.unpriced - before.unpriced, 3, "the three unpriced runs must be counted, not dropped");
  // The names matter: "which backends am I blind to" is the actionable half of the signal.
  assert.ok(cov.unpriced_backends.includes("grok"));
  assert.ok(cov.unpriced_backends.includes("cursor-agent"));
  assert.ok(!cov.unpriced_backends.includes("claude-code"));
});

test("a run still in flight is not counted as unpriced", () => {
  const before = runs.spendCoverageSince(today());
  seedRun("grok", null, false); // running: no cost yet because it has not finished
  const cov = runs.spendCoverageSince(today());
  assert.equal(cov.unpriced, before.unpriced, "in-flight runs have no cost yet — that is not blindness");
  assert.equal(cov.priced, before.priced);
});

test("an all-unpriced window reports zero dollars but does not claim nothing happened", () => {
  const since = new Date(Date.now() + 60_000).toISOString(); // empty window, then fill it
  const empty = runs.spendCoverageSince(since);
  assert.equal(empty.usd, 0);
  assert.equal(empty.unpriced, 0);
  assert.deepEqual(empty.unpriced_backends, [], "no runs at all → nothing to be blind about");

  const before = runs.spendCoverageSince(today());
  seedRun("grok", null);
  const cov = runs.spendCoverageSince(today());
  assert.equal(cov.usd, before.usd, "$0.00 of new metered spend...");
  assert.equal(cov.unpriced, before.unpriced + 1, "...but the run is visible as unpriced");
});

test("dispatcher status ships the qualifiers with the number", async () => {
  const { status } = await import("./dispatcher.js");
  seedRun("grok", null);
  const s = status();
  assert.equal(s.spend_scope, "global", "the figure is every workspace, not the caller's");
  assert.ok(typeof s.unpriced_runs_today === "number");
  assert.ok(s.unpriced_runs_today > 0);
  assert.ok(Array.isArray(s.unpriced_backends));
});
