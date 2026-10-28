/**
 * The keeper types `/compact` into an idle terminal before its one-hour prompt cache expires. Every
 * guard here is a way that would go wrong: too early, too late, on the wrong CLI, over a draft.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactLine, FIRE_AFTER_MS, LATEST_MS, whyNot, type KeeperView } from "./cache-keeper.js";
import { PASTE_MIN } from "./terminal.js";

const T = Date.parse("2026-10-28T10:00:00Z");
const MIN = 150_000;
const view = (o: Partial<KeeperView> = {}): KeeperView => ({
  backend: "claude-code",
  live: true,
  cache: { ttl: "1h", last_request_at: T, misses: 0, rewritten: 0, last_miss_at: null, compacted_at: null },
  contextTokens: 400_000,
  phase: "your_turn",
  promptKind: "turn",
  turn: { state: "stopped", at: T + 1000 },
  declared: null,
  lastIn: T - 60_000,
  firedFor: null,
  ...o,
});
const ripe = T + FIRE_AFTER_MS + 60_000;

test("a large idle terminal at its prompt, most of the hour gone: compact", () => {
  assert.equal(whyNot(view(), MIN, ripe), null);
  assert.equal(whyNot(view({ phase: "review" }), MIN, ripe), null, "a reached goal still wakes later — to a summary");
  assert.equal(whyNot(view({ phase: "waiting" }), MIN, ripe), null, "waiting on its own background work is where the cold wake-ups came from");
});

test("not before the operator could just be away for a while, and not once the cache may be gone", () => {
  assert.equal(whyNot(view(), MIN, T + FIRE_AFTER_MS - 1), "not idle long enough");
  assert.equal(whyNot(view(), MIN, T + LATEST_MS + 1), "too late: the cache is expiring");
});

test("only what pays: a 1h cache, a big context, claude, not already compacted or sent", () => {
  assert.equal(whyNot(view({ contextTokens: 90_000 }), MIN, ripe), "small");
  assert.equal(whyNot(view({ backend: "cursor" }), MIN, ripe), "not claude");
  assert.equal(whyNot(view({ cache: { ...view().cache, ttl: "5m" } }), MIN, ripe), "ttl 5m");
  assert.equal(whyNot(view({ cache: { ...view().cache, compacted_at: T + 5_000 } }), MIN, ripe), "already compacted");
  assert.equal(whyNot(view({ firedFor: T }), MIN, ripe), "already sent");
  assert.equal(whyNot(view({ live: false }), MIN, ripe), "not live here");
});

test("never over the operator: not mid-turn, not at a menu, not over an unsent draft", () => {
  assert.equal(whyNot(view({ phase: "working" }), MIN, ripe), "phase working");
  assert.equal(whyNot(view({ phase: "decide" }), MIN, ripe), "phase decide");
  assert.equal(whyNot(view({ promptKind: "select" }), MIN, ripe), "prompt open (select)");
  assert.equal(whyNot(view({ turn: { state: "working", at: T } }), MIN, ripe), "turn not finished");
  assert.equal(whyNot(view({ turn: null }), MIN, ripe), "turn not finished");
  assert.equal(whyNot(view({ lastIn: T + 10 * 60_000 }), MIN, ripe), "a draft may be in the box");
  assert.equal(whyNot(view({ phase: "waiting", declared: "waiting" }), MIN, ripe), "declared waiting", "its `mc state waiting --on ci` would be cleared by the prompt");
  assert.equal(whyNot(view({ phase: "review", declared: "review" }), MIN, ripe), null);
});

test("the line is a slash command typed as keys, never a paste", () => {
  const l = compactLine(47);
  assert.match(l, /^\/compact /);
  assert.ok(l.length < PASTE_MIN);
  assert.ok(!l.includes("\n"));
});
