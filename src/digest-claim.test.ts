import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, sessions, workspaces, kv } from "./store.js";
import { closeOutSession, digestClaimed } from "./terminal.js";

beforeEach(() => {
  db.exec("DELETE FROM sessions; DELETE FROM workspaces; DELETE FROM kv;");
});

test("closeOutSession claims the digest once — a second call is a no-op for the LLM slot", () => {
  const ws = workspaces.create({
    slug: "dig-" + randomUUID().slice(0, 6),
    name: "Digest",
    config_dir: "/tmp/dig",
  } as any);
  const s = sessions.create({
    workspace_id: ws.id,
    cwd: "/tmp",
    backend: "claude-code",
    goal: "ship the thing",
  });
  assert.equal(digestClaimed(s.id), false);
  closeOutSession(s.id, { transcript: "Understanding: doing the work\nSummary: done shipping" });
  assert.equal(digestClaimed(s.id), true);
  const key = `session.digest:${s.id}`;
  const first = kv.get(key);
  assert.ok(first);
  // Second close (pty onExit after goal-done) must not rewrite the claim timestamp / re-fire.
  closeOutSession(s.id, { transcript: "Understanding: doing the work\nSummary: done shipping again" });
  assert.equal(kv.get(key), first);
});
