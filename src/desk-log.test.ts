/**
 * The day's ledger: who opened a terminal, what it was called before the agent knew better, and the
 * numbers that survive the terminal itself.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, sessions, workspaces } from "./store.js";
import { reportAgentState } from "./agent-lifecycle.js";

beforeEach(() => {
  db.exec("DELETE FROM sessions; DELETE FROM workspaces;");
});

let n = 0;
const mkWs = () => workspaces.create({ slug: `log${++n}`, name: "Log", config_dir: "/tmp/log" });

test("a terminal remembers what it was ASKED for, even after the agent renames it", () => {
  const ws = mkWs();
  const s = sessions.create({
    workspace_id: ws.id, cwd: "/tmp", backend: "claude-code",
    goal: "fix the dbt thing", created_by: "operator",
  });
  assert.equal(sessions.get(s.id)!.spawn_goal, "fix the dbt thing");
  assert.equal(sessions.get(s.id)!.created_by, "operator");

  // The agent sharpens the card; the log still knows what the operator originally typed.
  sessions.setGoal(s.id, { goal: "rebuild the late-arriving dedupe in stg_orders", goal_source: "agent" });
  const row = sessions.get(s.id)!;
  assert.equal(row.goal, "rebuild the late-arriving dedupe in stg_orders");
  assert.equal(row.spawn_goal, "fix the dbt thing");
});

test("a terminal Robert opened does not read as one you opened", () => {
  const ws = mkWs();
  const mine = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code", goal: "mine" });
  const his = sessions.create({
    workspace_id: ws.id, cwd: "/tmp", backend: "claude-code", goal: "his", created_by: "robert",
  });
  assert.equal(sessions.get(mine.id)!.created_by, "operator"); // the default is the person at the wall
  assert.equal(sessions.get(his.id)!.created_by, "robert");
});

test("the ledger freezes onto the row, and blocked counts transitions rather than repeats", () => {
  const ws = mkWs();
  const s = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code", goal: "ship it" });
  sessions.setLedger(s.id, { turns: 14, tokens_in: 15088, tokens_out: 107862, cost_usd: 9.37, context_peak: 295029, branch: "acm-52-gff-report" });
  const row = sessions.get(s.id)!;
  assert.equal(row.turns, 14);
  assert.equal(row.cost_usd, 9.37);
  assert.equal(row.context_peak, 295029);
  assert.equal(row.branch, "acm-52-gff-report");

  assert.equal(row.blocked_count, null); // nothing asked of you yet
  reportAgentState(s.id, { state: "blocked", blocked_reason: "question", state_label: "which schema?" });
  reportAgentState(s.id, { state: "blocked", blocked_reason: "question", state_label: "still which schema?" });
  assert.equal(sessions.get(s.id)!.blocked_count, 1, "the same block re-reported is not a second interruption");
  reportAgentState(s.id, { state: "working" });
  reportAgentState(s.id, { state: "blocked", blocked_reason: "approval" });
  assert.equal(sessions.get(s.id)!.blocked_count, 2);
});
