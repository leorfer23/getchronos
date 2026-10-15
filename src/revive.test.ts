import { test } from "node:test";
import assert from "node:assert/strict";
import { activity } from "./store.js";
import { REVIVE_NUDGE, lastActivityState, reviveSeedFor } from "./revive.js";

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
