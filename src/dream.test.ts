import { test } from "node:test";
import assert from "node:assert/strict";
import { dueSlot, latestSlot, markSlot } from "./dream.js";
import { parseHours } from "./config.js";

// Local-time constructor: slots are local, so tests build local dates, never ISO-with-Z.
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi);
const H = [13, 22];

// An in-memory kv so each case owns its state; hours are always passed explicitly — the daemon's
// self-deploy runs this suite under the operator's env, never read the real schedule from CONFIG.
function store(init?: Record<string, string>) {
  const m = new Map(Object.entries(init ?? {}));
  return { get: (k: string) => m.get(k), set: (k: string, v: string) => void m.set(k, v), m };
}

test("parseHours: comma list → sorted local hours; empty, -1 and garbage mean off", () => {
  assert.deepEqual(parseHours("13,22"), [13, 22]);
  assert.deepEqual(parseHours(" 22 , 13,13 "), [13, 22]);
  assert.deepEqual(parseHours("3"), [3]);
  assert.deepEqual(parseHours(""), []);
  assert.deepEqual(parseHours(undefined), []);
  assert.deepEqual(parseHours("-1"), []);
  assert.deepEqual(parseHours("24,x,1.5"), []);
});

test("before the day's first slot, last night's missed slot is due", () => {
  const kv = store();
  assert.equal(dueSlot("k", at(2026, 9, 23, 8), H, kv.get), "2026-09-22@22");
});

test("between slots the morning slot is due; after marking it, nothing until 22:00", () => {
  const kv = store({ k: "2026-09-22@22" });
  assert.equal(dueSlot("k", at(2026, 9, 23, 15, 40), H, kv.get), "2026-09-23@13", "woke at 15:40 → catch up now");
  markSlot("k", "2026-09-23@13", kv.set);
  assert.equal(dueSlot("k", at(2026, 9, 23, 18), H, kv.get), null);
  assert.equal(dueSlot("k", at(2026, 9, 23, 22), H, kv.get), "2026-09-23@22");
});

test("both slots ran today → nothing due until tomorrow's first", () => {
  const kv = store({ k: "2026-09-23@22" });
  assert.equal(dueSlot("k", at(2026, 9, 23, 23, 59), H, kv.get), null);
  assert.equal(dueSlot("k", at(2026, 9, 24, 9), H, kv.get), null);
  assert.equal(dueSlot("k", at(2026, 9, 24, 13), H, kv.get), "2026-09-24@13");
});

test("a weekend asleep runs only the latest missed slot, not the backlog", () => {
  const kv = store({ k: "2026-09-18@22" });
  assert.equal(dueSlot("k", at(2026, 9, 21, 9), H, kv.get), "2026-09-20@22");
  markSlot("k", "2026-09-20@22", kv.set);
  assert.equal(dueSlot("k", at(2026, 9, 21, 10), H, kv.get), null, "the older missed slots are not replayed");
});

test("off: no hours → never due, and nothing is marked", () => {
  const kv = store();
  assert.equal(dueSlot("k", at(2026, 9, 23, 22), [], kv.get), null);
  assert.equal(kv.m.size, 0);
});

test("restart idempotency: the mark is the only state, so a fresh process holds the same slot", () => {
  const kv = store();
  const slot = dueSlot("k", at(2026, 9, 23, 13, 5), H, kv.get)!;
  markSlot("k", slot, kv.set);
  // A restarted daemon has nothing in memory — only the persisted key.
  const restarted = store(Object.fromEntries(kv.m));
  assert.equal(dueSlot("k", at(2026, 9, 23, 13, 20), H, restarted.get), null);
  assert.equal(dueSlot("other", at(2026, 9, 23, 13, 20), H, restarted.get), "2026-09-23@13", "keys are independent");
});

test("a clock that went backwards does not re-run an already-marked later slot", () => {
  const kv = store({ k: "2026-09-23@22" });
  assert.equal(dueSlot("k", at(2026, 9, 23, 14), H, kv.get), null);
});

test("late slot: 23:00 wraps past midnight into the next day's early hours", () => {
  assert.equal(latestSlot(at(2026, 9, 23, 23, 30), [23]), "2026-09-23@23");
  assert.equal(latestSlot(at(2026, 9, 24, 2), [23]), "2026-09-23@23");
  assert.equal(latestSlot(at(2026, 3, 1, 5), [23]), "2026-02-28@23", "month boundary");
  assert.equal(latestSlot(at(2027, 1, 1, 0, 10), [23]), "2026-12-31@23", "year boundary");
});

test("DST: slots follow local calendar fields across spring-forward and fall-back", () => {
  const prev = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    // 2026-03-08 02:00 does not exist; the 02 slot is simply past at 03:30.
    const spring = new Date(2026, 2, 8, 3, 30);
    assert.equal(latestSlot(spring, [2, 22]), "2026-03-08@02");
    assert.equal(latestSlot(new Date(2026, 2, 8, 0, 30), [22]), "2026-03-07@22");
    // 2026-11-01 01:xx happens twice; the second pass through it is the same, already-marked slot.
    const kv = store();
    const first = new Date(2026, 10, 1, 1, 30);
    const slot = dueSlot("k", first, [1], kv.get)!;
    assert.equal(slot, "2026-11-01@01");
    markSlot("k", slot, kv.set);
    const second = new Date(first.getTime() + 3600_000);
    assert.equal(second.getHours(), 1, "sanity: the repeated hour");
    assert.equal(dueSlot("k", second, [1], kv.get), null);
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
});
