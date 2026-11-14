import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { awakeTimeout, resetBrainAwake } from "./brain-awake.js";

// 2026-11-12: reap-stale-worktrees-chronos started in a dark wake, the Mac slept 17m45s, and the 900s
// watchdog killed it 2s after the next wake.
const T0 = Date.parse("2026-11-12T15:05:53.221Z");

afterEach(() => {
  mock.timers.reset();
  resetBrainAwake();
});

test("awakeTimeout: with no sleep it fires once, after ms and not before", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  resetBrainAwake({ lastWake: () => null });
  let fired = 0;
  awakeTimeout(() => fired++, 900_000);
  mock.timers.tick(899_999);
  assert.equal(fired, 0);
  mock.timers.tick(1);
  assert.equal(fired, 1);
  mock.timers.tick(60_000);
  assert.equal(fired, 1);
});

test("awakeTimeout: 2s awake, 17m45s asleep — the sleep does not count", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  let wake = T0 - 270;
  resetBrainAwake({ lastWake: () => wake });
  let fired = 0;
  awakeTimeout(() => fired++, 900_000);
  mock.timers.tick(2_000);
  // Asleep: the clock jumps 1065s while no timer runs; the pending tick comes due in the next wake.
  mock.timers.setTime(Date.now() + 1_065_000);
  wake = Date.now();
  mock.timers.tick(8_000);
  assert.equal(fired, 0, "a run awake for seconds is not timed out on wake");
  // Counted so far: the 8s since the wake (the 2s before the sleep fall inside a tick and are dropped).
  mock.timers.tick(891_999);
  assert.equal(fired, 0);
  mock.timers.tick(1);
  assert.equal(fired, 1);
});

test("awakeTimeout: a late tick with no wake behind it (busy loop, or no wake to read) counts in full", () => {
  for (const lastWake of [() => T0 - 3_600_000, () => null]) {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
    resetBrainAwake({ lastWake });
    let fired = 0;
    awakeTimeout(() => fired++, 60_000);
    mock.timers.tick(5_000);
    mock.timers.setTime(Date.now() + 120_000);
    mock.timers.tick(5_000);
    assert.equal(fired, 1);
    mock.timers.reset();
  }
});

test("awakeTimeout: cancelled, it never fires", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  resetBrainAwake({ lastWake: () => null });
  let fired = 0;
  const cancel = awakeTimeout(() => fired++, 30_000);
  mock.timers.tick(15_000);
  cancel();
  mock.timers.tick(60_000);
  assert.equal(fired, 0);
});
