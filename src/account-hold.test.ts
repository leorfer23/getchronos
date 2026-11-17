import assert from "node:assert/strict";
import test from "node:test";
import { accountHold, accountNotice, isBackgroundTrigger, type HoldJob } from "./account-hold.js";
import { deferDelay } from "./scheduler.js";
import type { QuotaEntry, QuotaSnapshot } from "./quota-gate.js";

const NOW = Date.parse("2026-11-17T16:00:00Z");
const SOON = "2026-11-17T17:00:00.000Z";
const PAST = "2026-11-17T15:00:00.000Z";
const DIR = "/Users/operator/.claude-acme";
const job: HoldJob = { name: "monitor:acme-app", backend: "claude-code", workspace_id: null };

function entry(over: Partial<QuotaEntry>): QuotaEntry {
  return {
    provider: "anthropic", scope: "profile:.claude-acme", effectivePercentRemaining: 0, runway: "exhausted_now",
    resetsAt: SOON, usableRunwaySeconds: 0, confidence: "measured", auth: "indeterminate", inUse: true, attention: [], spendPriority: null,
    ...over,
  };
}
const snap = (...entries: QuotaEntry[]) => (): QuotaSnapshot => ({ at: new Date(NOW).toISOString(), entries, attention: [] });
const base = { now: NOW, dirOf: () => DIR, reservePct: () => 80, holdOnWall: () => true, window5h: () => null, snapshot: snap() };

test("accountHold: a measured wall with its reset ahead holds background work until the reset", () => {
  const h = accountHold(job, { ...base, snapshot: snap(entry({})) });
  assert.equal(h?.kind, "wall");
  assert.equal(h?.until, SOON);
  assert.equal(h?.account, ".claude-acme");
  assert.match(h!.why, /out of allowance/);
});

test("accountHold: an inferred runway, a reset already past, or another account's wall never holds", () => {
  assert.equal(accountHold(job, { ...base, snapshot: snap(entry({ confidence: "inferred" })) }), null);
  assert.equal(accountHold(job, { ...base, snapshot: snap(entry({ resetsAt: PAST })) }), null);
  assert.equal(accountHold(job, { ...base, snapshot: snap(entry({ scope: "profile:.claude-globex" })) }), null);
  assert.equal(accountHold(job, { ...base, snapshot: snap(entry({ runway: "projected_exhaustion" })) }), null);
});

test("accountHold: the wall hold can be switched off", () => {
  assert.equal(accountHold(job, { ...base, holdOnWall: () => false, snapshot: snap(entry({})) }), null);
});

test("accountHold: past the reserve line the window's rest stays with the operator", () => {
  const h = accountHold(job, { ...base, window5h: () => ({ usedPct: 86, resetsAt: SOON }) });
  assert.equal(h?.kind, "reserve");
  assert.equal(h?.until, SOON);
  assert.match(h!.why, /86% of its 5-hour window/);
  assert.equal(accountHold(job, { ...base, window5h: () => ({ usedPct: 79.9, resetsAt: SOON }) }), null);
  // 0 = off, even at 100%.
  assert.equal(accountHold(job, { ...base, reservePct: () => 0, window5h: () => ({ usedPct: 100, resetsAt: SOON }) }), null);
});

test("accountHold: only claude jobs — other backends' windows are not measured per account here", () => {
  assert.equal(accountHold({ ...job, backend: "grok" }, { ...base, snapshot: snap(entry({})) }), null);
});

test("accountNotice: warns the opener of a walled or nearly spent account, says nothing otherwise", () => {
  assert.match(accountNotice(DIR, { now: NOW, snapshot: snap(entry({})), window5h: () => null })!, /will stop at its first message/);
  assert.match(accountNotice(DIR, { now: NOW, snapshot: snap(), window5h: () => ({ usedPct: 91, resetsAt: SOON }) })!, /91% of its 5-hour window/);
  assert.equal(accountNotice(DIR, { now: NOW, snapshot: snap(), window5h: () => ({ usedPct: 40, resetsAt: SOON }) }), null);
});

test("isBackgroundTrigger: cron fires, dream passes and idea mining — never work someone is waiting on", () => {
  for (const t of ["cron", "cron:catchup", "dream:acme", "ideas:miner"]) assert.equal(isBackgroundTrigger(t), true, t);
  for (const t of ["manual", "ticket:ACM-1", "verifier", "review:ACM-1", "once", "answer:12345678", "chain:success:x", "cronjob-ish"])
    assert.equal(isBackgroundTrigger(t), false, t);
});

test("deferDelay: one fire after the reset, unless the next regular fire comes first", () => {
  const now = NOW;
  // Reset in 1h, next regular fire tomorrow → fire 90s after the reset.
  assert.equal(deferDelay(SOON, "2026-11-18T09:00:00.000Z", now), 3_600_000 + 90_000);
  // Next regular fire before the reset (an hourly monitor) → nothing extra.
  assert.equal(deferDelay(SOON, "2026-11-17T16:30:00.000Z", now), null);
  // Unknown reset, or one further out than a 5-hour window (a weekly wall) → nothing extra.
  assert.equal(deferDelay(null, null, now), null);
  assert.equal(deferDelay("2026-11-20T09:00:00.000Z", null, now), null);
  // A reset already past (clock skew) → shortly after now.
  assert.equal(deferDelay(PAST, null, now), 90_000);
});
