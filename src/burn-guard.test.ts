import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "./config.js";
import { jobs, runs } from "./store.js";
import { burnState, burnHalted } from "./burn-guard.js";

function makeRuns(n: number, cost: number | null) {
  const job = jobs.create({ name: `burn-test-${n}-${cost}`, goal: "x", cwd: process.cwd(), trigger_type: "manual" });
  for (let i = 0; i < n; i++) {
    const r = runs.create(job.id, "manual");
    const now = new Date().toISOString();
    runs.patch(r.id, { status: "success", cost_usd: cost, started_at: now, ended_at: now });
  }
}

// The 2026-07-30 shape: a loop whose runs were rate-limited or on a fallback backend and reported
// $0.00. A dollars-only alarm stayed silent through 225 runs — the count is what catches it.
test("run count trips the guard even when every run reports zero cost", () => {
  CONFIG.burnAlertRunsPerHour = 5;
  CONFIG.burnHaltRunsPerHour = 8;
  CONFIG.burnAlertUsdPerHour = 1000;
  CONFIG.burnHaltUsdPerHour = 1000;

  assert.equal(burnState().level, "ok");
  assert.equal(burnHalted(), null);

  makeRuns(6, 0);
  assert.equal(burnState().level, "alert");
  assert.equal(burnHalted(), null, "alert does not block dispatch");

  makeRuns(4, 0);
  assert.equal(burnState().level, "halt");
  assert.match(burnHalted() ?? "", /burn guard: \d+ runs/);
});

test("spend trips the guard when the run count stays low", () => {
  CONFIG.burnAlertRunsPerHour = 0; // count thresholds off
  CONFIG.burnHaltRunsPerHour = 0;
  CONFIG.burnAlertUsdPerHour = 1e9;
  CONFIG.burnHaltUsdPerHour = 1e9;
  assert.equal(burnState().level, "ok");

  makeRuns(2, 50);
  const usd = burnState().usd;
  CONFIG.burnHaltUsdPerHour = usd; // at-or-above the threshold halts
  assert.equal(burnState().level, "halt");
});
