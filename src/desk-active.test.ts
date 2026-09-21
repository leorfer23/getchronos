import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { activeDeskSessions } from "./api.js";
import { db, sessions, workspaces } from "./store.js";

beforeEach(() => {
  db.exec("DELETE FROM sessions; DELETE FROM workspaces;");
});

test("the Desk bootstrap returns only live sessions; history stays dormant in SQLite", () => {
  const a = workspaces.create({ slug: "desk-a", name: "Desk A", config_dir: "/tmp/desk-a" });
  const b = workspaces.create({ slug: "desk-b", name: "Desk B", config_dir: "/tmp/desk-b" });
  const liveA = sessions.create({ workspace_id: a.id, cwd: "/tmp", backend: "claude-code", goal: "active A" });
  const endedWithGoal = sessions.create({
    workspace_id: a.id,
    cwd: "/tmp",
    backend: "claude-code",
    goal: "must not stay resident",
  });
  const liveB = sessions.create({ workspace_id: b.id, cwd: "/tmp", backend: "claude-code", goal: "active B" });
  sessions.end(endedWithGoal.id);

  assert.deepEqual(activeDeskSessions(null).map((s) => s.id).sort(), [liveA.id, liveB.id].sort());
  assert.deepEqual(activeDeskSessions(a.id).map((s) => s.id), [liveA.id]);
  assert.ok(sessions.get(endedWithGoal.id), "the ended session remains available for on-demand history/reopen");
});
