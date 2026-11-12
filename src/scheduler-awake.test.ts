import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { jobs } from "./store.js";
import { resetBrainAwake } from "./brain-awake.js";
import { cronFireWait, fireCronWhenAwake, registerCronGate } from "./scheduler.js";

// 2026-11-12: the Mac slept through reap-stale-worktrees-chronos's 15:03Z fire; it came due in a 2s
// dark wake at 15:05:53 (no network), the Mac slept again, and the run timed out on the next wake.
const T0 = Date.parse("2026-11-12T15:05:53.221Z");
const DAY = 86_400_000;

// Through a gate only: a gated fire records a skip and never dispatches a run.
const fired: string[] = [];
registerCronGate("awake-test:", (j) => { fired.push(j.name); return "gated in test"; });
const mkJob = (name: string) =>
  jobs.create({ name, goal: "do it", cwd: "/tmp", trigger_type: "cron", timezone: "UTC", enabled: true, cron_expr: "3 15 * * *" });

afterEach(() => {
  mock.timers.reset();
  resetBrainAwake();
  fired.length = 0;
});

test("cronFireWait: a minute of awake time, never more", () => {
  assert.equal(cronFireWait(T0, T0 - 270), 59_730);
  assert.equal(cronFireWait(T0, T0 - 60_000), 0);
  assert.equal(cronFireWait(T0, T0 - DAY), 0);
  assert.equal(cronFireWait(T0, T0 + 5_000), 60_000, "a wake stamped ahead of the clock waits a minute, not more");
});

test("a Mac awake for a while fires at once", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  resetBrainAwake({ bootAt: T0 - DAY, lastWake: () => T0 - 3_600_000 });
  fireCronWhenAwake(mkJob("awake-test:awake"));
  assert.deepEqual(fired, ["awake-test:awake"]);
});

test("a fire in a dark wake waits — through the next dark wake too — and runs once, a minute into the real wake", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  let wake = T0 - 270;
  resetBrainAwake({ bootAt: T0 - DAY, lastWake: () => wake });
  const job = mkJob("awake-test:dark");
  fireCronWhenAwake(job);
  fireCronWhenAwake(job); // a second fire while it waits does not stack
  assert.deepEqual(fired, []);
  // Asleep 1065s: the clock jumps while no timer runs; the held fire comes due in the next dark wake.
  mock.timers.setTime(Date.now() + 1_065_000);
  wake = Date.now() + 59_730 - 100;
  mock.timers.tick(59_730);
  assert.deepEqual(fired, [], "a second dark wake waits again");
  // The real wake: awake a full minute now.
  mock.timers.tick(59_900);
  assert.deepEqual(fired, ["awake-test:dark"]);
  mock.timers.tick(5 * 60_000);
  assert.deepEqual(fired, ["awake-test:dark"], "once");
});

test("a job turned off while its fire waited does not run", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  resetBrainAwake({ bootAt: T0 - DAY, lastWake: () => T0 - 270 });
  const job = mkJob("awake-test:off");
  fireCronWhenAwake(job);
  jobs.update(job.id, { enabled: false });
  mock.timers.tick(5 * 60_000);
  assert.deepEqual(fired, []);
});
