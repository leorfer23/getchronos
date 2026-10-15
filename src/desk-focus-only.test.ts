import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, sessions, workspaces } from "./store.js";

beforeEach(() => {
  db.exec("DELETE FROM sessions; DELETE FROM workspaces;");
});

test("a new terminal is not Focus-only unless the spawn asks for it", () => {
  const ws = workspaces.create({ slug: "focus-only", name: "Focus", config_dir: "/tmp/focus-only" });
  const plain = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code", goal: "plain" });
  const only = sessions.create({
    workspace_id: ws.id,
    cwd: "/tmp",
    backend: "claude-code",
    goal: "story only",
    focus_only: true,
  });
  assert.equal(plain.focus_only, false);
  assert.equal(only.focus_only, true);
  assert.equal(sessions.get(only.id)?.focus_only, true);
});
