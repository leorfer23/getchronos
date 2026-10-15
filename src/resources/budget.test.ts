import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetOf, capacityOf, cleanWeight, isOver, median, sharesOf, slotBudgetOf, strainOf } from "./budget.js";

const ONE = () => 1;

test("capacity: RAM keeps max(3 GB, 20%) for the OS, the daemon and the Desk; CPU = ncpu × 100%", () => {
  // The incident brain: 18 GB, 12 cores, 2 slots → 20% (3.6 GB) is the larger reserve.
  assert.deepEqual(capacityOf(18 * 1024, 12, 2), { rssMb: 18 * 1024 * 0.8, cpu: 1200, slots: 2 });
  // An 8 GB Mac: 20% is only 1.6 GB, so the 3 GB floor wins.
  assert.deepEqual(capacityOf(8 * 1024, 8, 1), { rssMb: 5 * 1024, cpu: 800, slots: 1 });
  // Never negative, never zero slots or cores.
  assert.deepEqual(capacityOf(2048, 0, 0), { rssMb: 0, cpu: 100, slots: 1 });
  assert.equal(capacityOf(16 * 1024, 8, 1, { minMb: 1024, pct: 50 }).rssMb, 8 * 1024);
});

test("shares: a lone workspace gets the whole machine", () => {
  assert.deepEqual(sharesOf(["a"], ONE).get("a"), { weight: 1, share: 1 });
});

test("shares: an idle workspace is not in the sum — its share is lent to the active ones", () => {
  const two = sharesOf(["a", "b"], ONE);
  assert.equal(two.get("a")!.share, 0.5);
  assert.equal(two.get("b")!.share, 0.5);
  // c goes idle (not active): a and b keep half each, and c's line shows what it WOULD get.
  const lent = sharesOf(["a", "b"], ONE, ["c"]);
  assert.equal(lent.get("a")!.share, 0.5);
  assert.equal(Math.round(lent.get("c")!.share * 1000) / 1000, 0.333);
});

test("shares: weights — a weight-2 workspace gets twice a weight-1 workspace's share", () => {
  const w = sharesOf(["a", "b"], (ws) => (ws === "a" ? 2 : 1));
  assert.equal(Math.round(w.get("a")!.share * 1000) / 1000, 0.667);
  assert.equal(Math.round(w.get("b")!.share * 1000) / 1000, 0.333);
  // A nonsense weight reads as the default 1, never as zero or negative share.
  assert.equal(cleanWeight(0), 1);
  assert.equal(cleanWeight(-3), 1);
  assert.equal(cleanWeight("2"), 1);
  assert.equal(cleanWeight(0.5), 0.5);
  assert.equal(sharesOf(["a", "b"], (ws) => (ws === "a" ? Number.NaN : 1)).get("a")!.share, 0.5);
});

test("budget: share × capacity; slots max(1, floor(share × slots))", () => {
  const cap = capacityOf(18 * 1024, 12, 2);
  assert.deepEqual(budgetOf(1, cap), { rssMb: cap.rssMb, cpu: 1200, slots: 2 }, "a lone workspace may hold every slot");
  assert.deepEqual(budgetOf(0.5, cap), { rssMb: cap.rssMb / 2, cpu: 600, slots: 1 }, "two equal workspaces: one slot each");
  assert.equal(budgetOf(1 / 3, cap).slots, 1, "three workspaces on two slots: nobody is starved to zero");
  assert.equal(budgetOf(2 / 3, { ...cap, slots: 3 }).slots, 2, "floor(2.0000) is 2, not 1, despite float error");
});

test("over: RAM or CPU over budget; slots alone are lending, not over", () => {
  const b = { rssMb: 1000, cpu: 300, slots: 1 };
  assert.equal(isOver({ rssMb: 1001, cpu: 0, slots: 0 }, b), true);
  assert.equal(isOver({ rssMb: 0, cpu: 301, slots: 0 }, b), true);
  assert.equal(isOver({ rssMb: 1000, cpu: 300, slots: 2 }, b), false);
});

test("median: of the last ticks, so one compile spike is not a verdict", () => {
  assert.equal(median([]), 0);
  assert.equal(median([100, 900, 120]), 120);
  assert.equal(median([100, 300]), 200);
});

test("slot budget: weighs the machine's active workspaces plus the pool's contenders", () => {
  // Lone workspace: every slot.
  assert.equal(slotBudgetOf("a", ["a"], 2, [], ONE), 2);
  // b is active on the machine (has a live terminal) even though it is not in the pool: a is held to 1.
  assert.equal(slotBudgetOf("a", ["a"], 2, ["a", "b"], ONE), 1);
  // A waiter is a contender even when the ledger cannot see it (a host's pool).
  assert.equal(slotBudgetOf("a", ["a", "b"], 2, [], ONE), 1);
  // Weights: a weight-3 workspace next to a weight-1 one, 4 slots → 3.
  assert.equal(slotBudgetOf("a", ["a", "b"], 4, [], (ws) => (ws === "a" ? 3 : 1)), 3);
});

test("strain: memory pressure ≥ warning or load per core over the line; critical = pressure critical", () => {
  assert.deepEqual(strainOf({ loadPerCore: 1, pressureLevel: 1 }, 2.5), { strained: false, critical: false });
  assert.deepEqual(strainOf({ loadPerCore: 2.5, pressureLevel: null }, 2.5), { strained: false, critical: false }, "the line itself is not over");
  assert.deepEqual(strainOf({ loadPerCore: 2.6, pressureLevel: 1 }, 2.5), { strained: true, critical: false });
  assert.deepEqual(strainOf({ loadPerCore: 0.5, pressureLevel: 2 }, 2.5), { strained: true, critical: false });
  assert.deepEqual(strainOf({ loadPerCore: 0.5, pressureLevel: 4 }, 2.5), { strained: true, critical: true });
});
