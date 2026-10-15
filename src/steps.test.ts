import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, events, jobs, runs, steps, workspaces } from "./store.js";
import { getAgent } from "./agent-lifecycle.js";

beforeEach(() => {
  db.exec("DELETE FROM run_steps; DELETE FROM run_events; DELETE FROM runs; DELETE FROM jobs; DELETE FROM workspaces;");
});

const mkRun = () => {
  const ws = workspaces.create({ slug: "steps-" + Math.random().toString(36).slice(2), name: "Steps", config_dir: "/tmp/steps" });
  const job = jobs.create({ name: "ticket:ST-1", goal: "g", workspace_id: ws.id });
  return runs.create(job.id, "manual").id;
};

test("declare replaces any existing checklist, 1-based idx", () => {
  const runId = mkRun();
  steps.declare(runId, ["a", "b"]);
  const second = steps.declare(runId, ["x", "y", "z"]);
  assert.deepEqual(second.map((s) => [s.idx, s.label, s.status]), [
    [1, "x", "todo"],
    [2, "y", "todo"],
    [3, "z", "todo"],
  ]);
  assert.equal(steps.list(runId).length, 3);
});

test("set updates status/note and leaves other steps alone; progress reflects done/active/current", () => {
  const runId = mkRun();
  steps.declare(runId, ["one", "two", "three"]);

  assert.equal(steps.progress(runId)?.current, null);

  steps.set(runId, 1, { status: "active" });
  assert.deepEqual(steps.progress(runId), { done: 0, total: 3, current: "one" });

  steps.set(runId, 1, { status: "done", note: "shipped" });
  // no auto-transition: step 2 stays 'todo' even though step 1 finished — current falls back to last done
  assert.deepEqual(steps.progress(runId), { done: 1, total: 3, current: "one" });
  assert.equal(steps.list(runId)[1].status, "todo");

  steps.set(runId, 2, { status: "active" });
  assert.deepEqual(steps.progress(runId), { done: 1, total: 3, current: "two" });

  assert.equal(steps.set(runId, 99, { status: "done" }), undefined);
});

test("progress is null when no steps declared", () => {
  const runId = mkRun();
  assert.equal(steps.progress(runId), null);
});

test("occupantFromRun surfaces '<done>/<total> · <current>' as progress", () => {
  const runId = mkRun();
  runs.patch(runId, { status: "running", started_at: new Date().toISOString() });
  steps.declare(runId, ["fix root cause", "add test", "ship"]);
  steps.set(runId, 1, { status: "done" });
  steps.set(runId, 2, { status: "active" });
  const occ = getAgent(runId);
  assert.equal(occ?.progress, "1/3 · add test");
});

test("occupantFromRun backstop: no declared steps + running run → latest tool activity from run_events", () => {
  const runId = mkRun();
  runs.patch(runId, { status: "running", started_at: new Date().toISOString() });
  events.add(runId, "assistant", {
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] },
  });
  const occ = getAgent(runId);
  assert.equal(occ?.progress, "· run npm test");
});

test("occupantFromRun: no steps, not running → progress null (no backstop for settled runs)", () => {
  const runId = mkRun();
  runs.patch(runId, { status: "success", started_at: new Date().toISOString(), ended_at: new Date().toISOString() });
  events.add(runId, "assistant", {
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] },
  });
  const occ = getAgent(runId);
  assert.equal(occ?.progress, null);
});

test("events.lastActivity parses a claude-style tool_use payload", () => {
  const runId = mkRun();
  events.add(runId, "assistant", { type: "assistant", message: { content: [{ type: "text", text: "thinking" }] } });
  events.add(runId, "assistant", {
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/a/b.ts" } }] },
  });
  assert.equal(events.lastActivity(runId), "· Edit /a/b.ts");
});

test("events.lastActivity is defensive: garbage/unexpected payload shapes never throw, return null", () => {
  const runId = mkRun();
  events.add(runId, "weird", "just a string, not an object");
  events.add(runId, "weird2", { totally: "unrelated shape" });
  events.add(runId, "weird3", null);
  assert.equal(events.lastActivity(runId), null);
});

test("events.lastActivity finds the newest tool_use across recent rows", () => {
  const runId = mkRun();
  events.add(runId, "assistant", {
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "TODO" } }] },
  });
  events.add(runId, "assistant", { type: "assistant", message: { content: [{ type: "text", text: "no tool here" }] } });
  events.add(runId, "assistant", {
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/x.ts" } }] },
  });
  assert.equal(events.lastActivity(runId), "· Write /x.ts");
});
