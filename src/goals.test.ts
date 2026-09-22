/**
 * More than one finish line for one terminal (src/goals.ts).
 *
 * The contract these tests hold down is the one every other surface depends on: the session row
 * keeps mirroring the CURRENT goal, so a terminal with a list looks, to the Desk / Robert / the
 * phase machine, exactly like the single-goal terminal they already know — and a tick is a step,
 * not the end, until the last one.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, sessions, sessionGoals } from "./store.js";
import { addGoals, goalLines, reopenGoal, setGoals, tickAllGoals, tickCurrentGoal } from "./goals.js";

const mk = (goal: string | null = "open the rollback PR") =>
  sessions.create({ cwd: "/tmp", goal, goal_kind: goal ? "pr" : null });

beforeEach(() => db.exec("DELETE FROM session_goals; DELETE FROM sessions;"));

test("a terminal with one goal has no list at all — nothing to migrate, nothing to render", () => {
  const s = mk();
  assert.deepEqual(sessionGoals.list(s.id), []);
  assert.equal(sessions.get(s.id)!.goals_total, 0);
  const t = tickCurrentGoal(s.id);
  assert.equal(t.finished, true, "the single goal IS the terminal — ticking it finishes it");
  assert.ok(sessions.get(s.id)!.goal_done_at, "and the row carries the tick, as it always did");
});

test("the first `goal add` folds the goal already on the row in as item #1", () => {
  const s = mk();
  const { goals } = addGoals(s.id, [{ text: "update the runbook" }], "agent");
  assert.deepEqual(goals.map((g) => [g.seq, g.text]), [
    [1, "open the rollback PR"],
    [2, "update the runbook"],
  ]);
  assert.equal(goals[0].kind, "pr", "item #1 keeps the kind the card was opened with");
  // …and only once: a second add must not re-adopt.
  addGoals(s.id, [{ text: "tell #eng" }]);
  assert.equal(sessionGoals.list(s.id).length, 3);
});

test("the row mirrors the goal the card is ON, and the card moves when one is ticked", () => {
  const s = mk();
  addGoals(s.id, [{ text: "update the runbook" }]);
  assert.equal(sessions.get(s.id)!.goal, "open the rollback PR");

  const t1 = tickCurrentGoal(s.id);
  assert.equal(t1.ticked!.text, "open the rollback PR");
  assert.equal(t1.next!.text, "update the runbook");
  assert.equal(t1.finished, false, "one of two ticked is not a finished terminal");

  const row = sessions.get(s.id)!;
  assert.equal(row.goal, "update the runbook", "the card moved on");
  assert.equal(row.goal_done_at, null, "and the terminal does not read as done");
  assert.equal(row.goals_done, 1);
  assert.equal(row.goals_total, 2);
});

test("the last tick finishes the terminal, stamped with the moment that tick landed", () => {
  const s = mk();
  addGoals(s.id, [{ text: "update the runbook" }]);
  tickCurrentGoal(s.id);
  const t2 = tickCurrentGoal(s.id);
  assert.equal(t2.finished, true);
  assert.equal(t2.next, undefined);
  const row = sessions.get(s.id)!;
  assert.equal(row.goal, "update the runbook", "the card rests on the last thing it did");
  assert.equal(row.goal_done_at, sessionGoals.list(s.id)[1].done_at, "the LAST tick, not a fresh now()");
});

test("the mirror is stable: re-reading a finished list never moves the tick it reports", () => {
  const s = mk();
  addGoals(s.id, [{ text: "update the runbook" }]);
  tickAllGoals(s.id);
  const first = sessions.get(s.id)!.goal_done_at;
  // Any later write re-runs the mirror; the day's log must not shift under it.
  addGoals(s.id, []);
  assert.equal(sessions.get(s.id)!.goal_done_at, first);
});

test("`goal done --all`: the operator closing a card ticks everything still open", () => {
  const s = mk();
  addGoals(s.id, [{ text: "update the runbook" }, { text: "tell #eng" }]);
  const t = tickAllGoals(s.id);
  assert.equal(t.finished, true);
  assert.equal(sessionGoals.list(s.id).filter((g) => !g.done_at).length, 0);
  assert.ok(sessions.get(s.id)!.goal_done_at);
});

test("reopen unticks the most recent tick and the card goes back to it", () => {
  const s = mk();
  addGoals(s.id, [{ text: "update the runbook" }]);
  tickCurrentGoal(s.id);
  tickCurrentGoal(s.id);
  assert.ok(sessions.get(s.id)!.goal_done_at);

  const r = reopenGoal(s.id);
  assert.equal(r.finished, false);
  assert.equal(r.next!.text, "update the runbook");
  assert.equal(sessions.get(s.id)!.goal_done_at, null, "the terminal is not done after all");
});

test("dropping an item closes the gap, so `mc goal drop 2` keeps meaning item two", () => {
  const s = mk("one");
  addGoals(s.id, [{ text: "two" }, { text: "three" }]);
  const two = sessionGoals.list(s.id)[1];
  sessionGoals.remove(two.id);
  assert.deepEqual(sessionGoals.list(s.id).map((g) => [g.seq, g.text]), [[1, "one"], [2, "three"]]);
});

test("setGoals replaces the list outright; an empty list clears the card too", () => {
  const s = mk();
  addGoals(s.id, [{ text: "update the runbook" }]);
  const { goals } = setGoals(s.id, [{ text: "ship the fix", kind: "pr" }, { text: "write it up" }]);
  assert.deepEqual(goals.map((g) => g.text), ["ship the fix", "write it up"]);
  assert.equal(sessions.get(s.id)!.goal, "ship the fix");

  setGoals(s.id, []);
  const row = sessions.get(s.id)!;
  assert.equal(row.goals_total, 0);
  assert.equal(row.goal, null, "no list and no goal — a blank card, not a ghost of the last item");
});

test("a goal needs words", () => {
  const s = mk();
  assert.throws(() => addGoals(s.id, [{ text: "   " }]), /needs words/);
});

test("goalLines is what the agent is shown: numbered, ticked, in order", () => {
  const s = mk("one");
  addGoals(s.id, [{ text: "two", kind: "qa" }]);
  tickCurrentGoal(s.id);
  assert.deepEqual(goalLines(sessionGoals.list(s.id)), ["1. ✓ one [pr]", "2. · two [qa]"]);
});
