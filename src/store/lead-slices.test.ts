/**
 * `lead_slices` (LEADS.md) — a Lead's plan as rows, so it survives the compaction that eats its
 * context window. The numbering is the contract: `n` is what `--slice 3` and `mc lead board set 3`
 * mean, so it must be per-Lead, stable, and never reused.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, leadSlices } from "../store.js";

beforeEach(() => db.exec("DELETE FROM lead_slices;"));

test("slices are numbered 1,2,3… per Lead — two Leads each start at 1", () => {
  const a = "lead-a", b = "lead-b";
  assert.equal(leadSlices.add(a, "the migration").n, 1);
  assert.equal(leadSlices.add(a, "the rollback").n, 2);
  assert.equal(leadSlices.add(b, "something else").n, 1, "a Lead's numbering is its own");
  assert.deepEqual(leadSlices.list(a).map((s) => [s.n, s.title]), [[1, "the migration"], [2, "the rollback"]]);
  assert.deepEqual(leadSlices.list(b).map((s) => s.title), ["something else"]);
});

test("a number is never reused: deleting nothing, a third add after two is 3", () => {
  const lead = "lead-a";
  leadSlices.add(lead, "one");
  leadSlices.add(lead, "two");
  assert.equal(leadSlices.add(lead, "three").n, 3);
  // …and the UNIQUE index is the wall if max+1 ever raced itself.
  assert.throws(
    () => db.prepare("INSERT INTO lead_slices (lead_id,n,title,status,created_at,updated_at) VALUES (?,3,'dup','todo','x','x')").run(lead),
    /UNIQUE/,
  );
});

test("a new slice starts `todo` with nothing attached", () => {
  const s = leadSlices.add("lead-a", "the migration");
  assert.equal(s.status, "todo");
  assert.equal(s.session_id, null);
  assert.equal(s.pr_url, null);
  assert.equal(s.note, null);
});

test("patch moves only what was passed; null clears a field and an empty patch is a no-op", () => {
  const lead = "lead-a";
  leadSlices.add(lead, "the migration");
  leadSlices.patch(lead, 1, { status: "doing", session_id: "sess-1", note: "careful with 121" });
  let s = leadSlices.get(lead, 1)!;
  assert.equal(s.status, "doing");
  assert.equal(s.session_id, "sess-1");

  leadSlices.patch(lead, 1, { pr_url: "https://e.com/1" });
  s = leadSlices.get(lead, 1)!;
  assert.equal(s.pr_url, "https://e.com/1");
  assert.equal(s.status, "doing", "an omitted field keeps its value");
  assert.equal(s.note, "careful with 121");

  leadSlices.patch(lead, 1, { note: null, session_id: null });
  s = leadSlices.get(lead, 1)!;
  assert.equal(s.note, null);
  assert.equal(s.session_id, null);
  assert.equal(s.title, "the migration");

  assert.equal(leadSlices.patch(lead, 1, {})!.title, "the migration");
  assert.equal(leadSlices.patch(lead, 99, { status: "done" }), undefined, "a slice that is not there");
  assert.equal(leadSlices.patch("lead-b", 1, { status: "done" }), undefined, "another Lead's number 1");
});

test("forSession finds the slice a worker is on, and only within that Lead's own board", () => {
  leadSlices.add("lead-a", "one");
  leadSlices.add("lead-a", "two");
  leadSlices.patch("lead-a", 2, { session_id: "sess-1" });
  leadSlices.add("lead-b", "theirs");
  leadSlices.patch("lead-b", 1, { session_id: "sess-1" });

  assert.equal(leadSlices.forSession("lead-a", "sess-1")!.n, 2);
  assert.equal(leadSlices.forSession("lead-b", "sess-1")!.n, 1);
  assert.equal(leadSlices.forSession("lead-a", "sess-nobody"), undefined);
});

test("the tally counts done over total, and a dropped slice is off the board entirely", () => {
  const lead = "lead-a";
  for (const t of ["one", "two", "three", "four"]) leadSlices.add(lead, t);
  leadSlices.patch(lead, 1, { status: "done" });
  leadSlices.patch(lead, 2, { status: "review" });
  leadSlices.patch(lead, 4, { status: "dropped" });
  assert.deepEqual(leadSlices.tally(lead), { done: 1, total: 3 });
  assert.deepEqual(leadSlices.tally("lead-nobody"), { done: 0, total: 0 });
});
