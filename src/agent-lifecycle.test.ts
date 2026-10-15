/**
 * Tests for herdr-inspired agent lifecycle: derive, name, report, wait, handoff format.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, workspaces, jobs, runs, sessions } from "./store.js";
import {
  deriveRunState,
  deriveSessionState,
  formatHandoff,
  getAgent,
  listAgents,
  reportAgentState,
  setAgentName,
  validateAgentName,
  waitForAgent,
} from "./agent-lifecycle.js";

beforeEach(() => {
  db.exec(
    "DELETE FROM run_events; DELETE FROM runs; DELETE FROM jobs; DELETE FROM sessions; DELETE FROM workspaces;"
  );
});

test("validateAgentName accepts herdr-style names", () => {
  assert.equal(validateAgentName("reviewer"), null);
  assert.equal(validateAgentName("acm-60-builder"), null);
  assert.ok(validateAgentName("Bad Name"));
  assert.ok(validateAgentName("1bad"));
  assert.ok(validateAgentName("a".repeat(40)));
});

test("deriveRunState maps Chronos run statuses", () => {
  assert.deepEqual(deriveRunState({ status: "running" }), { state: "working", blocked_reason: null });
  assert.deepEqual(deriveRunState({ status: "blocked" }), { state: "blocked", blocked_reason: "gate" });
  assert.deepEqual(deriveRunState({ status: "rate_limited" }), {
    state: "blocked",
    blocked_reason: "budget",
  });
  assert.deepEqual(deriveRunState({ status: "success" }), { state: "done", blocked_reason: null });
  assert.deepEqual(deriveRunState({ status: "queued" }), { state: "idle", blocked_reason: null });
});

test("deriveSessionState: live+pty → working, ended → done", () => {
  assert.deepEqual(deriveSessionState({ status: "live" }, true), {
    state: "working",
    blocked_reason: null,
  });
  assert.deepEqual(deriveSessionState({ status: "ended" }, false), {
    state: "done",
    blocked_reason: null,
  });
});

test("deriveSessionState: a silent pty is idle, not working", () => {
  // The Desk wall's whole premise: a terminal that has produced nothing is at rest, whatever its
  // process table says. Reporting it 'working' is what made the old fleet view useless.
  assert.deepEqual(deriveSessionState({ status: "live" }, true, true), {
    state: "idle",
    blocked_reason: null,
  });
  assert.deepEqual(deriveSessionState({ status: "live" }, true, false), {
    state: "working",
    blocked_reason: null,
  });
});

test("sessions.setGoal stores the objective and ticks it off", () => {
  const ws = workspaces.create({ slug: "desk", name: "Desk", config_dir: "/tmp/desk" });
  const s = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code" });
  assert.equal(s.goal, null);
  sessions.setGoal(s.id, { goal: "open the rollback PR" });
  assert.equal(sessions.get(s.id)!.goal, "open the rollback PR");
  sessions.setGoal(s.id, { goal_done: true });
  assert.ok(sessions.get(s.id)!.goal_done_at);
  sessions.setGoal(s.id, { goal_done: false });
  assert.equal(sessions.get(s.id)!.goal_done_at, null);
});

test("formatHandoff builds Ada→Robert structured body", () => {
  const text = formatHandoff({
    goal: "Ship ACM-60",
    context: "the operator asked at dinner",
    deadline: "tomorrow AM",
    from: "ada",
  });
  assert.match(text, /@Robert handoff/);
  assert.match(text, /\*\*Goal:\*\* Ship ACM-60/);
  assert.match(text, /\*\*From:\*\* ada/);
});

test("setAgentName on a session + resolve via getAgent", () => {
  const ws = workspaces.create({ slug: "life", name: "Life", config_dir: "/tmp/life" });
  const s = sessions.create({
    workspace_id: ws.id,
    cwd: "/tmp",
    role: "worker",
    title: "builder",
  });
  const named = setAgentName(s.id, "builder");
  assert.equal(named.ok, true);
  if (!named.ok) return;
  assert.equal(named.agent.name, "builder");
  const byName = getAgent("builder");
  assert.ok(byName);
  assert.equal(byName!.id, s.id);
  assert.equal(setAgentName(s.id, "builder").ok, true); // idempotent
  const clash = sessions.create({ workspace_id: ws.id, cwd: "/tmp", role: "worker" });
  const bad = setAgentName(clash.id, "builder");
  assert.equal(bad.ok, false);
});

test("reportAgentState overlays blocked + wait resolves", async () => {
  const ws = workspaces.create({ slug: "ops", name: "Ops", config_dir: "/tmp/ops" });
  const job = jobs.create({ name: "ticket:OPS-1", goal: "g", workspace_id: ws.id });
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, { status: "running", started_at: new Date().toISOString() });

  const waitP = waitForAgent({ idOrName: run.id, until: "blocked", timeout_ms: 2000 });
  // Give the waiter a tick to register before reporting.
  await new Promise((r) => setTimeout(r, 20));
  const reported = reportAgentState(run.id, {
    state: "blocked",
    blocked_reason: "hitl",
    state_label: "needs the operator",
  });
  assert.equal(reported.ok, true);
  const waited = await waitP;
  assert.equal(waited.ok, true);
  if (!waited.ok) return;
  assert.equal(waited.agent.state, "blocked");
  assert.equal(waited.agent.blocked_reason, "hitl");
});

test("listAgents surfaces active runs as working", () => {
  const ws = workspaces.create({ slug: "fleet", name: "Fleet", config_dir: "/tmp/fleet" });
  const job = jobs.create({ name: "ticket:F-1", goal: "g", workspace_id: ws.id });
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, { status: "running", started_at: new Date().toISOString() });
  const agents = listAgents({ workspace_id: ws.id });
  assert.ok(agents.some((a) => a.kind === "run" && a.id === run.id && a.state === "working"));
});
