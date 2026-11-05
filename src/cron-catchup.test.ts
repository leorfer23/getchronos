/**
 * Boot catch-up (src/cron-catchup.ts + catchUpMissedCron in src/scheduler.ts): a cron fire the daemon
 * was down for runs once on boot — the latest one only, inside the window, unless it already ran or
 * was skipped, or the next regular fire is minutes away.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, jobs, runs } from "./store.js";
import { CONFIG } from "./config.js";
import { CATCHUP_SOON_MS, missedFire } from "./cron-catchup.js";
import { catchUpMissedCron, lastCronSkip, registerCronGate } from "./scheduler.js";

const TZ = "America/Argentina/Buenos_Aires";
// 17:00 in Buenos Aires (UTC-3).
const NOW = new Date("2026-11-02T20:00:00.000Z");
const h = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
const DAY = 24 * 3_600_000;
const base = { expr: "0 9 * * *", tz: TZ, createdAt: h(24 * 7), lastStartedAt: null, lastSkipAt: null, windowMs: DAY, now: NOW };

test("the 09:00 fire the daemon was down for is due at 17:00", () => {
  assert.equal(missedFire(base)?.toISOString(), "2026-11-02T12:00:00.000Z");
});

test("a fire that ran or was skipped is not caught up", () => {
  assert.equal(missedFire({ ...base, lastStartedAt: h(8) }), null, "ran at the fire");
  assert.equal(missedFire({ ...base, lastStartedAt: new Date(Date.parse(h(8)) - 60_000).toISOString() }), null, "a minute early is still that fire's run");
  assert.ok(missedFire({ ...base, lastStartedAt: h(30) }), "yesterday's run does not cover today's fire");
  assert.equal(missedFire({ ...base, lastSkipAt: h(8) }), null, "a gate or inflight skip at the fire was on purpose");
});

test("too old, not born yet, off, or a bad expression: nothing to catch up", () => {
  assert.equal(missedFire({ ...base, windowMs: 6 * 3_600_000 }), null, "older than the window");
  assert.equal(missedFire({ ...base, createdAt: h(2) }), null, "the job did not exist at 09:00");
  assert.equal(missedFire({ ...base, windowMs: 0 }), null);
  assert.equal(missedFire({ ...base, expr: "not a cron" }), null);
});

test("many missed fires → only the latest runs", () => {
  // Hourly; the daemon was down 09:00–17:00, so 16:00 is the one.
  assert.equal(missedFire({ ...base, expr: "0 * * * *", now: new Date(NOW.getTime() - 30 * 60_000) })?.toISOString(), "2026-11-02T19:00:00.000Z");
});

test("the next regular fire minutes away just waits for it", () => {
  const every30 = { ...base, expr: "*/30 * * * *" };
  // 16:50 → due 16:30, next 17:00 in 10 min.
  assert.equal(missedFire({ ...every30, now: new Date(NOW.getTime() - 10 * 60_000) }), null);
  // 16:40 → due 16:30, next in 20 min (> CATCHUP_SOON_MS).
  assert.ok(CATCHUP_SOON_MS < 20 * 60_000);
  assert.equal(missedFire({ ...every30, now: new Date(NOW.getTime() - 20 * 60_000) })?.toISOString(), "2026-11-02T19:30:00.000Z");
});

// The wiring, through gates only — a gated fire records a skip and never dispatches a run.
const order: string[] = [];
registerCronGate("catchup-test:", (j) => { order.push(j.name); return "gated in test"; });
registerCronGate("job-check:", (j) => { order.push(j.name); return "gated in test"; });
function mkDaily(name: string, firedHoursAgo: number) {
  const at = new Date(Date.now() - firedHoursAgo * 3_600_000);
  const j = jobs.create({
    name, goal: "do it", cwd: "/tmp", trigger_type: "cron", timezone: "UTC", enabled: true,
    cron_expr: `${at.getUTCMinutes()} ${at.getUTCHours()} * * *`,
  } as any);
  db.prepare("UPDATE jobs SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 7 * DAY).toISOString(), j.id);
  return j;
}
beforeEach(() => {
  order.length = 0;
  db.exec("DELETE FROM runs; DELETE FROM jobs; DELETE FROM kv WHERE key LIKE 'cron.skip.%';");
});

test("boot catch-up fires each missed job once, the job check last, and not again", () => {
  const check = mkDaily("job-check:acme", 2);
  const job = mkDaily("catchup-test:nightly", 3);
  const ran = mkDaily("catchup-test:ran", 4);
  runs.patch(runs.create(ran.id, "cron").id, { status: "success", started_at: new Date(Date.now() - 4 * 3_600_000).toISOString() } as any);
  assert.equal(catchUpMissedCron(), 2);
  assert.deepEqual(order, ["catchup-test:nightly", "job-check:acme"], "the check judges the others, so it goes last");
  assert.equal(lastCronSkip(job.id)?.kind, "gate");
  assert.equal(lastCronSkip(check.id)?.kind, "gate");
  assert.equal(catchUpMissedCron(), 0, "the skip it just recorded covers that fire");
});

test("CHRONOS_CRON_CATCHUP_HOURS=0 turns it off", () => {
  mkDaily("catchup-test:nightly", 3);
  const was = CONFIG.cronCatchupHours;
  (CONFIG as any).cronCatchupHours = 0;
  try { assert.equal(catchUpMissedCron(), 0); } finally { (CONFIG as any).cronCatchupHours = was; }
  assert.deepEqual(order, []);
});
