/**
 * The Lead inbox table (LEADS.md): what makes a stop durable, what makes it idempotent, and the three
 * timestamps that decide whether it is still the Lead's to answer.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.js";
import { leadEvents } from "./lead-events.js";

beforeEach(() => db.exec("DELETE FROM lead_events;"));

const add = (over: Partial<Parameters<typeof leadEvents.add>[0]> = {}) =>
  leadEvents.add({ lead_id: "lead-a", session_id: "w1", kind: "turn", key: "k1", ...over });

test("add: the row carries its payload back, and the same key inserts once", () => {
  const first = add({ payload: { id8: "w1", goal: "open the PR" } });
  assert.equal(first.deduped, false);
  assert.equal(first.row.lead_id, "lead-a");
  assert.equal(JSON.parse(first.row.payload!).goal, "open the PR");
  assert.match(first.row.created_at, /Z$/, "ISO-8601 with Z, like the rest of the store");

  // The same stop re-armed (a second status event, a restart re-deriving `since`): one row, and the
  // FRESHER payload — the card line moves on while the stop does not.
  const again = add({ payload: { id8: "w1", goal: "open the PR", card_line: "tests green" } });
  assert.equal(again.deduped, true);
  assert.equal(again.row.id, first.row.id);
  assert.equal(JSON.parse(again.row.payload!).card_line, "tests green");
  assert.equal(leadEvents.unseen("lead-a").length, 1);
});

test("add: a NULL key never dedupes — two `ended` events are two events", () => {
  add({ kind: "ended", key: null, session_id: "w1" });
  add({ kind: "ended", key: null, session_id: "w2" });
  assert.equal(leadEvents.unseen("lead-a").length, 2);
});

test("unseen: this Lead's own rows, oldest first — never another Lead's", () => {
  add({ key: "k1", session_id: "w1" });
  add({ key: "k2", session_id: "w2" });
  add({ lead_id: "lead-b", key: "k3", session_id: "w3" });
  assert.deepEqual(leadEvents.unseen("lead-a").map((e) => e.session_id), ["w1", "w2"]);
  assert.deepEqual(leadEvents.unseen("lead-b").map((e) => e.session_id), ["w3"]);
});

test("markSeen / markDelivered: seen leaves the unseen queue, delivered implies seen", () => {
  const a = add({ key: "k1", session_id: "w1" }).row;
  const b = add({ key: "k2", session_id: "w2" }).row;
  leadEvents.markSeen([a.id]);
  assert.deepEqual(leadEvents.unseen("lead-a").map((e) => e.id), [b.id]);
  assert.ok(leadEvents.get(a.id)!.seen_at);
  assert.equal(leadEvents.get(a.id)!.delivered_at, null, "pulled, not typed");

  leadEvents.markDelivered([b.id]);
  const after = leadEvents.get(b.id)!;
  assert.ok(after.delivered_at && after.seen_at, "a digest it was typed is a digest it was handed");
  assert.equal(leadEvents.unseen("lead-a").length, 0);
});

test("ackForWorker: that worker's events stop being outstanding, and stop being unseen", () => {
  const mine = add({ key: "k1", session_id: "w1" }).row;
  const other = add({ key: "k2", session_id: "w2" }).row;
  add({ lead_id: "lead-b", key: "k3", session_id: "w1" });

  assert.equal(leadEvents.ackForWorker("lead-a", "w1"), 1);
  assert.ok(leadEvents.get(mine.id)!.acked_at);
  // Also seen: a Lead that just steered w1 plainly knows w1 stopped — a digest about it afterwards
  // would be telling it what it just did.
  assert.ok(leadEvents.get(mine.id)!.seen_at);
  assert.deepEqual(leadEvents.unseen("lead-a").map((e) => e.id), [other.id]);
  assert.equal(leadEvents.ackForWorker("lead-a", "w1"), 0, "idempotent — nothing left to ack");
  // Lead B's row about the same worker id is untouched: the scope is the LEAD, not the worker.
  assert.equal(leadEvents.unseen("lead-b").length, 1);
});

test("recent: outstanding by default, the whole history with `all`, oldest first, capped by limit", () => {
  const a = add({ key: "k1", session_id: "w1" }).row;
  const b = add({ key: "k2", session_id: "w2" }).row;
  leadEvents.ackForWorker("lead-a", "w1");

  assert.deepEqual(leadEvents.recent("lead-a").map((e) => e.session_id), ["w2"]);
  assert.deepEqual(leadEvents.recent("lead-a", { all: true }).map((e) => e.id), [a.id, b.id]);
  assert.deepEqual(
    leadEvents.recent("lead-a", { all: true, limit: 1 }).map((e) => e.session_id),
    ["w2"],
    "a limit keeps the NEWEST, and still reads oldest-first",
  );
  assert.equal(leadEvents.recent("lead-b", { all: true }).length, 0);
});

test("prune: drops rows past the window, keeps the rest", () => {
  const old = add({ key: "k1", session_id: "w1" }).row;
  const fresh = add({ key: "k2", session_id: "w2" }).row;
  db.prepare("UPDATE lead_events SET created_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 9 * 24 * 60 * 60_000).toISOString(), old.id);
  assert.equal(leadEvents.prune(7), 1);
  assert.deepEqual(leadEvents.unseen("lead-a").map((e) => e.id), [fresh.id]);
});
