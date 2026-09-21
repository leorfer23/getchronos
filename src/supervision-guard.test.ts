import test from "node:test";
import assert from "node:assert/strict";
import { db, jobs, kv, runs, watches } from "./store.js";
import { touchWakeBeacon, wakeBeaconAgeMs, wakeBeaconFresh } from "./wake-queue.js";
import {
  checkSupervision,
  countInFlight,
  listArmed,
  setSupervisionNotifier,
  supervisionVerdict,
  verdictFrom,
} from "./supervision-guard.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");

let sent: Array<{ text: string; level: string }> = [];
setSupervisionNotifier(async (text, level) => { sent.push({ text, level }); });

function reset() {
  db.exec("DELETE FROM runs; DELETE FROM jobs; DELETE FROM watches; DELETE FROM sessions; DELETE FROM kv;");
  sent = [];
}

test("verdict truth table", () => {
  // Nothing in flight: a cold supervisor is not a problem nobody has.
  assert.equal(verdictFrom(0, [], false, null).ok, true);
  // Work in flight with nothing armed is the state this whole file exists for.
  const blind = verdictFrom(2, [], true, 0);
  assert.equal(blind.ok, false);
  assert.match(blind.reason, /nothing at all is armed/);
  assert.equal(blind.inFlight, 2);
  // Armed, but the loop that turns a queued wake into a turn has stopped beating.
  const stale = verdictFrom(1, ["the event listener"], false, 40 * 60_000);
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /40m ago/);
  assert.match(verdictFrom(1, ["the event listener"], false, null).reason, /never checked in/);
  // Armed and beating.
  const ok = verdictFrom(1, ["the event listener", "the wake drain loop"], true, 1000);
  assert.equal(ok.ok, true);
  assert.match(ok.reason, /armed: the event listener, the wake drain loop/);
});

test("in-flight counts running runs", () => {
  reset();
  const job = jobs.create({ name: "j", goal: "g" });
  const a = runs.create(job.id, "manual");
  const b = runs.create(job.id, "manual");
  assert.equal(countInFlight(), 0, "queued is not in flight");
  runs.setStatus(a.id, "running");
  runs.setStatus(b.id, "running");
  assert.equal(countInFlight(), 2);
  runs.setStatus(b.id, "success");
  assert.equal(countInFlight(), 1);
});

test("armed lists the drain beacon and Robert's own watches", () => {
  reset();
  assert.equal(listArmed(NOW).includes("the wake drain loop"), false);
  touchWakeBeacon(NOW);
  assert.ok(listArmed(NOW).includes("the wake drain loop"));
  assert.equal(wakeBeaconFresh(NOW + 1000), true);
  assert.ok((wakeBeaconAgeMs(NOW + 1000) ?? 0) >= 1000);

  watches.create({ owner: "robert", what: "the PR", mode: "bus", on_topic: "run.ended", until: new Date(NOW + 86400000).toISOString() });
  assert.ok(listArmed(NOW).some((a) => a.includes("1 watch")));
  // Someone else's watch is not supervision of the fleet.
  watches.create({ owner: "someone", what: "x", mode: "bus", on_topic: "run.ended", until: new Date(NOW + 86400000).toISOString() });
  assert.ok(listArmed(NOW).some((a) => a.includes("1 watch")));
});

test("one notice per episode, and recovery clears it quietly", async () => {
  reset();
  const job = jobs.create({ name: "j", goal: "g" });
  const r = runs.create(job.id, "manual");
  runs.setStatus(r.id, "running");

  const first = await checkSupervision(NOW);
  assert.equal(first.ok, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].level, "action");
  assert.match(sent[0].text, /1 thing is running and nothing is set to wake Robert/);

  await checkSupervision(NOW + 60_000);
  assert.equal(sent.length, 1, "the same gap says nothing further");

  touchWakeBeacon(NOW + 60_000);
  watches.create({ owner: "robert", what: "the PR", mode: "bus", on_topic: "run.ended", until: new Date(NOW + 86400000).toISOString() });
  const back = await checkSupervision(NOW + 60_000);
  assert.equal(back.ok, true);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].level, "info", "recovery lands on the board, not on his phone");
  assert.equal(kv.get("robert.supervision.episode"), undefined);

  // A new gap after a recovery is loud again.
  runs.setStatus(r.id, "running");
  const relapse = await checkSupervision(NOW + 90 * 60_000);
  assert.equal(relapse.ok, false);
  assert.equal(sent.length, 3);
});

test("an idle fleet with no supervisor at all is still ok — and says so", () => {
  reset();
  const v = supervisionVerdict(NOW);
  assert.equal(v.ok, true);
  assert.equal(v.inFlight, 0);
  assert.match(v.reason, /nothing is in flight/);
});
