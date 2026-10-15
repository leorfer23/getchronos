/**
 * The host's fence (fence.ts): when it freezes its work, relative to when the brain would move it.
 * The property that matters is the ordering — the host is frozen BEFORE the brain opens a stand-in —
 * so the cases below check it against the brain's own rule (host-failover.ts dueHosts) on one clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FENCE_MARGIN_MAX_MS, fenceAfterMs, fenceReason, type FenceInput } from "./fence.js";

const MIN = 60_000;
const at = (o: Partial<FenceInput>): FenceInput => ({ online: false, lastContact: 0, graceMs: 20 * MIN, rejected: null, now: 0, ...o });

test("fenceAfterMs: the grace less a margin of a quarter, at most 2 minutes; never negative", () => {
  assert.equal(fenceAfterMs(20 * MIN), 18 * MIN);
  assert.equal(fenceAfterMs(5 * MIN), 3.75 * MIN);
  assert.equal(fenceAfterMs(MIN), 45_000);
  assert.equal(fenceAfterMs(0), 0, "a brain that moves at once: freeze at once");
  assert.equal(fenceAfterMs(-5), 0);
  assert.equal(fenceAfterMs(60 * MIN), 60 * MIN - FENCE_MARGIN_MAX_MS);
});

test("fenceReason: online, unknown grace, failover off, or never connected → never", () => {
  assert.equal(fenceReason(at({ online: true, now: 60 * MIN })), null);
  assert.equal(fenceReason(at({ graceMs: null, now: 60 * MIN })), null, "a brain without failover (or an older one)");
  assert.equal(fenceReason(at({ lastContact: null, now: 60 * MIN })), null, "this process never heard a brain: it holds nothing");
  assert.equal(fenceReason(at({ disabled: true, now: 60 * MIN })), null, "CHRONOS_HOST_FENCE=off");
});

test("fenceReason: quiet past the fence point → freeze, with a reason that names both times", () => {
  assert.equal(fenceReason(at({ now: 18 * MIN - 1 })), null);
  assert.match(fenceReason(at({ now: 18 * MIN }))!, /no word from the brain for 18 min — it moves this host's terminals elsewhere after 20 min/);
});

test("refused by the brain → freeze at once, whatever the clock (it will not take these back)", () => {
  assert.match(fenceReason(at({ online: false, now: 1, rejected: { code: 4426, reason: "update this host" } }))!, /refused this host \(4426: update this host\)/);
  assert.match(fenceReason(at({ graceMs: null, lastContact: null, now: 1, rejected: { code: 4401, reason: "revoked" } }))!, /4401/);
});

test("ordering: for any outage the host freezes before the brain's grace runs out (host mark ≤ brain mark + 5s vitals)", () => {
  for (const graceMin of [0, 1, 5, 20, 45]) {
    const grace = graceMin * MIN;
    // Partition at T. The host last heard the brain at T at the latest; the brain last heard the host
    // no earlier than T-5s (vitals every 5s) — its offline clock starts there or later.
    const T = 1_000_000;
    const brainMoves = T - 5_000 + grace;
    let hostFreezes = T;
    while (!fenceReason(at({ lastContact: T, graceMs: grace, now: hostFreezes }))) hostFreezes += 1_000;
    // The host looks every FENCE_TICK_MS (5s): its first look at or after the fence point.
    assert.ok(hostFreezes + 5_000 <= brainMoves || grace === 0, `grace ${graceMin}m: freezes ${hostFreezes - T}ms, brain moves ${brainMoves - T}ms`);
  }
});
