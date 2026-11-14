/**
 * awakeTimeout: a run's watchdog counts the time the computer was awake, not the time it slept.
 * A sleep is simulated by moving the mocked clock forward without the timers firing in between, which
 * is what a sleeping Mac does to a Node process: on wake the overdue timer fires with a huge gap.
 */
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { awakeTimeout } from "./awake-timeout.js";

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-11-02T07:31:09Z") }));
afterEach(() => mock.timers.reset());

/** Awake time passing: the timers fire as they come due, one second at a time. */
function awake(ms: number) {
  for (let i = 0; i < ms; i += 1000) mock.timers.tick(Math.min(1000, ms - i));
}
/** The computer asleep: the clock moves on, no timer runs until the wake. */
function asleep(ms: number) {
  mock.timers.setTime(Date.now() + ms);
  mock.timers.tick(0);
}

test("fires once the time awake reaches the timeout, not before", () => {
  let fired = 0;
  awakeTimeout(() => fired++, 900_000);
  awake(899_000);
  assert.equal(fired, 0);
  awake(1000);
  assert.equal(fired, 1);
  awake(120_000);
  assert.equal(fired, 1, "fires once");
});

test("a sleep does not run the clock out: run 32ca4b2e, 6 s awake then 1008 s asleep", () => {
  let fired = 0;
  awakeTimeout(() => fired++, 900_000);
  awake(6000);
  asleep(1_008_000);
  assert.equal(fired, 0, "a wall-clock setTimeout fires here, on the wake");
  // The step the sleep fell in counts nothing (its 6 s awake included): the full 900 s are left.
  awake(899_000);
  assert.equal(fired, 0);
  awake(1000);
  assert.equal(fired, 1);
});

test("a night of dark wakes on battery adds nothing; the run gets its awake time in the morning", () => {
  let fired = 0;
  awakeTimeout(() => fired++, 900_000);
  awake(300_000);
  // 00:00–09:00: asleep ~17 min, then a dark wake of a few seconds, all night.
  for (let i = 0; i < 30; i++) {
    asleep(1_000_000);
    awake(5000);
  }
  assert.equal(fired, 0);
  // 600 s left; the last wake's 5 s count, as nothing slept after them.
  awake(594_000);
  assert.equal(fired, 0);
  awake(1000);
  assert.equal(fired, 1);
});

test("a timer that fires a little late (a busy event loop) still counts in full", () => {
  let fired = 0;
  awakeTimeout(() => fired++, 60_000);
  // Each 30 s step lands 20 s late: within a tick of its due time, so not read as sleep.
  mock.timers.setTime(Date.now() + 50_000);
  mock.timers.tick(0);
  assert.equal(fired, 0);
  mock.timers.setTime(Date.now() + 30_000);
  mock.timers.tick(0);
  assert.equal(fired, 1);
});

test("clear() stops it", () => {
  let fired = 0;
  const t = awakeTimeout(() => fired++, 60_000);
  awake(30_000);
  t.clear();
  awake(120_000);
  assert.equal(fired, 0);
});

test("a short timeout is exact; the tick is configurable", () => {
  let fired = 0;
  awakeTimeout(() => fired++, 1500, { tickMs: 500 });
  awake(1000);
  assert.equal(fired, 0);
  awake(1000);
  assert.equal(fired, 1);
});
