import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { batteryPct, shouldHold, startCaffeinate } from "./caffeinate.js";

test("batteryPct reads the internal battery's charge from pmset -g ps", () => {
  assert.equal(batteryPct("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging; 5:01 remaining present: true"), 80);
  assert.equal(batteryPct("Now drawing from 'AC Power'\n"), null, "a desktop Mac");
});

test("shouldHold: work + AC holds; on battery only when the policy says so, and above the floor", () => {
  const brain = { onBattery: false, minBatteryPct: 100 };
  const host = { onBattery: true, minBatteryPct: 20 };
  assert.equal(shouldHold(false, { ac: true, pct: null }, host), false, "idle never holds");
  assert.equal(shouldHold(true, { ac: true, pct: null }, brain), true);
  assert.equal(shouldHold(true, { ac: false, pct: 90 }, brain), false, "the brain lets an unplugged laptop sleep");
  assert.equal(shouldHold(true, { ac: false, pct: 90 }, host), true, "a host with live work stays up on battery");
  assert.equal(shouldHold(true, { ac: false, pct: 19 }, host), false, "…but not down to a flat battery");
  assert.equal(shouldHold(true, { ac: false, pct: null }, host), true);
});

test("startCaffeinate: one caffeinate while busy, killed when idle", () => {
  let busy = true;
  const spawned: Array<EventEmitter & { kill(): void; killed?: boolean }> = [];
  const c = startCaffeinate({
    tag: "[test]", busy: () => busy, policy: { onBattery: true, minBatteryPct: 20 }, everyMs: 3_600_000,
    power: () => ({ ac: false, pct: 50 }),
    spawnCaffeinate: () => {
      const p = Object.assign(new EventEmitter(), { kill() { p.killed = true; p.emit("exit"); } }) as any;
      spawned.push(p);
      return p;
    },
  });
  c.tick();
  c.tick();
  assert.equal(spawned.length, 1);
  assert.equal(c.held(), true);
  busy = false;
  c.tick();
  assert.equal(spawned[0].killed, true);
  assert.equal(c.held(), false);
  c.stop();
});
