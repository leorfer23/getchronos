import { test } from "node:test";
import assert from "node:assert/strict";
import { activity, db } from "./store.js";
import { REVIVE_NUDGE, inFlightAtRestart, lastActivityState, reviveSeedFor } from "./revive.js";

test("a terminal that was working when the daemon died gets the continue nudge; one that was waiting or blocked is left at its prompt", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  activity.add({ topic: "session.activity", actor: "system", entity: id, detail: JSON.stringify({ session_id: id, state: "waiting" }) });
  activity.add({ topic: "session.activity", actor: "system", entity: id, detail: JSON.stringify({ session_id: id, state: "working" }) });
  assert.equal(lastActivityState(id), "working", "the latest event wins");
  assert.equal(reviveSeedFor(lastActivityState(id)), REVIVE_NUDGE);
  activity.add({ topic: "session.activity", actor: "system", entity: id, detail: JSON.stringify({ session_id: id, state: "waiting", prompt: { kind: "turn" } }) });
  assert.equal(reviveSeedFor(lastActivityState(id)), null);
  assert.equal(reviveSeedFor(lastActivityState("never-seen")), null, "no history, no nudge");
  assert.equal(reviveSeedFor("blocked"), null, "a question to the human is not resumed by talking over it");
  assert.match(REVIVE_NUDGE, /do not start over/);
});

test("a terminal that ended its turn with work still running in the background is nudged — never one waiting on the operator", () => {
  // Quiet at its prompt (activity "waiting"), relying on a background task's completion to wake it —
  // and that task died with the daemon.
  const id = "22222222-3333-4444-8555-666666666666";
  const save = (data: object) => db.prepare(
    `INSERT INTO session_status (session_id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET data = excluded.data`).run(id, JSON.stringify(data), new Date().toISOString());
  const now = Date.now();

  save({ turn: { state: "stopped", at: now }, subagents: { a: { label: "full suite", at: now - 60_000 } } });
  assert.deepEqual(inFlightAtRestart(id, now), { background: 1, waitingOnYou: false });
  assert.equal(reviveSeedFor("waiting", inFlightAtRestart(id, now)), REVIVE_NUDGE);

  // The hooks' turn state alone is not evidence: a finished terminal's often still says "working"
  // (2026-10-30: two terminals in review would have been nudged).
  save({ turn: { state: "working", at: now }, subagents: {} });
  assert.equal(reviveSeedFor("waiting", inFlightAtRestart(id, now)), null);

  // A task silent for hours had already stopped counting on the card; it does not wake anything now.
  save({ turn: { state: "stopped", at: now }, subagents: { a: { label: "old", at: now - 4 * 3600_000 } } });
  assert.equal(reviveSeedFor("waiting", inFlightAtRestart(id, now)), null);

  // Waiting on the operator — a question, a declared block — is never talked over.
  save({ turn: { state: "stopped", at: now }, subagents: { a: { label: "ci", at: now } }, asking: { question: "Merge it?", options: [], at: now } });
  assert.equal(reviveSeedFor("waiting", inFlightAtRestart(id, now)), null);
  save({ turn: { state: "stopped", at: now }, subagents: { a: { label: "ci", at: now } }, declared: { state: "blocked", label: "auth", at: now } });
  assert.equal(reviveSeedFor("waiting", inFlightAtRestart(id, now)), null);
  assert.equal(reviveSeedFor("blocked", { background: 1, waitingOnYou: false }), null);

  // Finished its turn with nothing running, or no record at all: left at its prompt.
  save({ turn: { state: "stopped", at: now }, subagents: {} });
  assert.equal(reviveSeedFor("waiting", inFlightAtRestart(id, now)), null);
  assert.equal(reviveSeedFor("waiting", inFlightAtRestart("never-seen", now)), null);
  assert.match(REVIVE_NUDGE, /re-run what was in flight/);
});
