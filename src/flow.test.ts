import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, workspaces, sessions } from "./store.js";
import { createTicket } from "./tickets.js";
import { flowData } from "./flow.js";

beforeEach(() => {
  db.exec(
    "DELETE FROM run_events; DELETE FROM runs; DELETE FROM jobs; DELETE FROM sessions; DELETE FROM reviews; DELETE FROM tickets; DELETE FROM workspaces;"
  );
});

test("flow splits open queue vs shipped and enriches shipped with the latest session summary", () => {
  const ws = workspaces.create({
    slug: "flow-" + randomUUID().slice(0, 8),
    name: "Flow",
    config_dir: "/tmp/flow-" + randomUUID().slice(0, 8),
  } as any);
  const queued = createTicket({ workspace_id: ws.id, title: "Open work", status: "in_progress" } as any);
  const review = createTicket({ workspace_id: ws.id, title: "Ready to ship", status: "review" } as any);
  const s = sessions.create({ ticket_id: review.id, workspace_id: ws.id, cwd: "/tmp" } as any);
  sessions.setMeta(s.id, { summary: "did the thing", tags: ["a", "b"] });

  const data = flowData();

  assert.ok(data.queue.some((t) => t.id === queued.id), "in_progress ticket lands in queue");
  assert.ok(!data.queue.some((t) => t.id === review.id), "review ticket is not in queue");

  const shipped = data.shipped.find((t) => t.id === review.id);
  assert.ok(shipped, "review ticket lands in shipped");
  assert.equal(shipped!.summary, "did the thing");
  assert.equal(shipped!.tags, JSON.stringify(["a", "b"]));
  assert.equal(shipped!.review_state, null);

  assert.equal(data.state.needs_you, 1);
  assert.equal(data.state.live_sessions, 1);
  assert.equal(data.state.running, 1);
  assert.equal(data.state.blocked, 0);
});
