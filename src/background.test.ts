import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  BACKGROUND_OPENERS, backgroundOf, closeQuietBackground, handoffStands, needsOperator, openedInBackground, quietHandoff, waitsOnOperator,
} from "./background.js";
import { db, sessions, workspaces } from "./store.js";
import { _resetSettingsCache, writeSetting } from "./settings.js";
import type { Outcome } from "./types.js";

const MIN = 60_000;
const rnd = () => Math.random().toString(36).slice(2, 8);
const mkWs = () => workspaces.create({ slug: `bg-${rnd()}`, name: "Acme", config_dir: "/tmp/acme" } as any);
const outcome = (o: Partial<Outcome> = {}): Outcome =>
  ({ summary: "1 fixed and green, 0 still red", changes: [], proof: [], prs: [], shots: [], ask: "none", shipped: [], at: new Date().toISOString(), ...o }) as Outcome;

beforeEach(() => {
  writeSetting("desk.background", null, null);
  writeSetting("desk.background_close_min", null, null);
  _resetSettingsCache();
});

test("openedInBackground: the daemon's openers, until the operator types into one", () => {
  for (const by of BACKGROUND_OPENERS) assert.equal(openedInBackground({ created_by: by, role: "human", lead_id: null, operator_inputs: 0 }), true, by);
  assert.equal(openedInBackground({ created_by: "operator", role: "human", lead_id: null, operator_inputs: 0 }), false);
  assert.equal(openedInBackground({ created_by: null, role: "human", lead_id: null, operator_inputs: 0 }), false);
  // Robert opening one on the operator's word, a failover stand-in, a continuation: his, on the rail.
  for (const by of ["robert", "failover", "continuation", "capture", "playbook"])
    assert.equal(openedInBackground({ created_by: by, role: "human", lead_id: null, operator_inputs: 0 }), false, by);
  assert.equal(openedInBackground({ created_by: "inbox", role: "human", lead_id: null, operator_inputs: 1 }), false, "he typed into it");
  assert.equal(openedInBackground({ created_by: "inbox", role: "lead", lead_id: null, operator_inputs: 0 }), false, "a Lead");
  assert.equal(openedInBackground({ created_by: "inbox", role: "worker", lead_id: "L1", operator_inputs: 0 }), false, "a Lead's worker");
});

test("waitsOnOperator: real hand-offs that filed --ask none yet still waited on him", () => {
  const waits = [
    "2 fixed and green, 1 still red: oncall-gate re-ran 'success' but did nothing — Datadog MCP login expired, needs you to re-auth",
    "2 fixed and green; Kin doc itself not written (Okta login needed)",
    "Draft reply to Jason with all-time block list, DM-off and under-18 totals is in his DM thread, unsent.",
    "Both artifacts are exported, and a Slack draft to Larissa is saved in your DM with her",
    "2 fixed and green, 1 still red (Medialab Jira Housekeeping, left for next Friday's run)",
    "Combined Sept run is still unrun and needs your Touch ID.",
    "A reply to Kyle is drafted in Slack, not sent.",
  ];
  for (const w of waits) assert.equal(waitsOnOperator([w]), w, w);
});

test("waitsOnOperator: all-clear reports and his own self-DM copy are not a wait", () => {
  const clear = [
    "1 fixed and green, 0 still red",
    "1 job fixed and green, 1 obsolete job paused; nothing still red",
    "Not an API outage: the probe's HTTP 000 was a failure on the probe host's side.",
    "getchronos#132 is healthy on main and deployed: CI green, migrations in order",
    "draft: self-DM summary in Slack (send not allowed, MC_OPERATOR_SLACK_DM unset)",
    "DM not sent: MC_OPERATOR_SLACK_DM is unset, so the line stays in the terminal",
    "Santa Elena still has nobody invited. As you asked, the reminder is set for Monday 9 Nov at 10:00.",
  ];
  for (const c of clear) assert.equal(waitsOnOperator([c]), null, c);
  assert.equal(waitsOnOperator([null, undefined, "", "  "]), null);
  // Any line counts — the summary or a change.
  assert.equal(waitsOnOperator(["1 fixed and green", "oncall-gate: needs you to re-auth Datadog"]), "oncall-gate: needs you to re-auth Datadog");
});

test("quietHandoff: only --ask none with nothing waiting in its words", () => {
  assert.equal(quietHandoff(outcome()), true);
  assert.equal(quietHandoff(outcome({ ask: "review" })), false);
  assert.equal(quietHandoff(outcome({ ask: "merge", prs: ["https://github.com/o/r/pull/1"] })), false);
  assert.equal(quietHandoff(outcome({ changes: ["Slack draft to Kyle saved, not sent"] })), false);
  assert.equal(quietHandoff(outcome({ summary: "" })), false);
  assert.equal(quietHandoff(null), false);
});

test("handoffStands: a hand-off older than the last thing typed to it answers an older question", () => {
  const at = Date.parse("2026-11-16T02:37:00Z");
  const o = outcome({ at: new Date(at).toISOString() });
  assert.equal(handoffStands(o, null), true);
  assert.equal(handoffStands(o, at - 60_000), true);
  assert.equal(handoffStands(o, at + 1000), true, "within the 2s the seed and the hand-off can cross");
  assert.equal(handoffStands(o, at + 5 * MIN), false);
  assert.equal(handoffStands(null, null), false);
});

test("needsOperator: walls, questions, stalls and a finish that asks for something", () => {
  for (const p of ["blocked", "decide", "stalled"] as const) assert.equal(needsOperator(p, 0, true), true, p);
  for (const p of ["working", "waiting"] as const) assert.equal(needsOperator(p, 0, false), false, p);
  for (const p of ["review", "your_turn"] as const) {
    assert.equal(needsOperator(p, 0, true), false, `${p} with a quiet hand-off`);
    assert.equal(needsOperator(p, 0, false), true, `${p} without one`);
  }
  assert.equal(needsOperator("working", 1, true), true, "an open question of his");
});

test("backgroundOf: on by default, off with the setting, never for an ended or hand-opened one", () => {
  const ws = mkWs();
  const row = { created_by: "job-check", role: "human" as const, lead_id: null, operator_inputs: 0, workspace_id: ws.id, outcome: null };
  assert.equal(backgroundOf(row, "working", 0, null), true);
  assert.equal(backgroundOf(row, "your_turn", 0, null), false, "stopped with no hand-off: shown");
  assert.equal(backgroundOf({ ...row, outcome: outcome() }, "review", 0, null), true, "done, nothing for him");
  assert.equal(backgroundOf({ ...row, outcome: outcome({ ask: "review" }) }, "review", 0, null), false);
  assert.equal(backgroundOf(row, "decide", 0, null), false);
  assert.equal(backgroundOf(row, "ended", 0, null), false);
  assert.equal(backgroundOf({ ...row, created_by: "operator" }, "working", 0, null), false);
  writeSetting("desk.background", false, ws.id);
  _resetSettingsCache();
  assert.equal(backgroundOf(row, "working", 0, null), false, "off for this workspace");
});

// ── the close sweep ───────────────────────────────────────────────────────────────────────────
function seed(wsId: string, o: { by?: string; inputs?: number; outcome?: Outcome | null; host?: string } = {}): string {
  const s = sessions.create({ workspace_id: wsId, cwd: "/tmp", backend: "claude-code", created_by: o.by ?? "job-check", host_id: o.host } as any);
  db.prepare("UPDATE sessions SET operator_inputs=? WHERE id=?").run(o.inputs ?? 0, s.id);
  if (o.outcome !== null) sessions.setOutcome(s.id, o.outcome ?? outcome({ at: new Date(Date.now() - 30 * MIN).toISOString() }), []);
  return s.id;
}
const quietAct = () => ({ live: true, quiet: true, last_out: Date.now() - 30 * MIN, last_in: Date.now() - 40 * MIN, started_at: Date.now() - 50 * MIN });
function deps(over: Record<string, unknown> = {}) {
  const killed: { id: string; reason: string | null | undefined }[] = [];
  return {
    killed,
    d: {
      status: () => ({ phase: "review" as const, since: Date.now() - 20 * MIN }),
      activity: quietAct,
      kill: (id: string, reason?: string | null) => { killed.push({ id, reason }); },
      strands: async () => null,
      ...over,
    },
  };
}
const endAll = () => db.prepare("UPDATE sessions SET status='ended' WHERE status='live'").run();

test("closeQuietBackground: a finished background terminal that asks nothing closes, with its summary as the reason", async () => {
  endAll();
  const ws = mkWs();
  const id = seed(ws.id);
  const { killed, d } = deps();
  assert.deepEqual(await closeQuietBackground(d as any), [id]);
  assert.match(String(killed[0].reason), /^closed itself, nothing for you — 1 fixed and green, 0 still red$/);
});

test("closeQuietBackground: never one that waits on him, one he typed into, or one too fresh", async () => {
  endAll();
  const ws = mkWs();
  seed(ws.id, { outcome: outcome({ summary: "1 still red: login expired", at: new Date(Date.now() - 30 * MIN).toISOString() }) });
  seed(ws.id, { outcome: outcome({ ask: "review", at: new Date(Date.now() - 30 * MIN).toISOString() }) });
  seed(ws.id, { outcome: null });
  seed(ws.id, { inputs: 2 });
  seed(ws.id, { by: "operator" });
  seed(ws.id, { host: "m2-pro" });
  seed(ws.id, { outcome: outcome({ at: new Date(Date.now() - 2 * MIN).toISOString() }) }); // handed off 2 min ago
  const { killed, d } = deps();
  assert.deepEqual(await closeQuietBackground(d as any), []);
  assert.equal(killed.length, 0);
});

test("closeQuietBackground: not while it works, has a question, was asked something after, or would strand work", async () => {
  const ws = mkWs();
  const cases: Record<string, unknown>[] = [
    { status: () => ({ phase: "working", since: Date.now() - 20 * MIN }) },
    { status: () => ({ phase: "review", since: Date.now() - 20 * MIN, asks: 1 }) },
    { status: () => ({ phase: "review", since: Date.now() - 2 * MIN }) },
    { activity: () => ({ ...quietAct(), quiet: false }) },
    { activity: () => ({ ...quietAct(), last_in: Date.now() - 5 * MIN }) }, // typed to after the hand-off
    { strands: async () => "2 uncommitted file(s) in its worktree" },
    { strands: async () => { throw new Error("git said no"); } },
  ];
  for (const c of cases) {
    endAll();
    seed(ws.id);
    const { killed, d } = deps(c);
    assert.deepEqual(await closeQuietBackground(d as any), [], JSON.stringify(Object.keys(c)));
    assert.equal(killed.length, 0);
  }
});

test("closeQuietBackground: the minutes setting, 0 = never, and the master switch", async () => {
  const ws = mkWs();
  endAll();
  const id = seed(ws.id);
  writeSetting("desk.background_close_min", 45, ws.id);
  _resetSettingsCache();
  assert.deepEqual(await closeQuietBackground(deps().d as any), [], "handed off 30 min ago, waits 45");
  writeSetting("desk.background_close_min", 15, ws.id);
  _resetSettingsCache();
  assert.deepEqual(await closeQuietBackground(deps().d as any), [id]);
  writeSetting("desk.background_close_min", 0, ws.id);
  _resetSettingsCache();
  assert.deepEqual(await closeQuietBackground(deps().d as any), []);
  writeSetting("desk.background_close_min", null, ws.id);
  writeSetting("desk.background", false, ws.id);
  _resetSettingsCache();
  assert.deepEqual(await closeQuietBackground(deps().d as any), []);
});
