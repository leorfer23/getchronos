/**
 * The presence sweep: a busy workspace gets one queued look every interval, a quiet one gets
 * nothing, and a QUIET answer never reaches the Desk.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { db, sessions, workspaces } from "./store.js";
import { drainScope, quietSweep, setWakeAsker, setWakeNotifier, setWakePoster, SWEEP_KEY, WAKE_ATTEMPT_CAP } from "./wake-queue.js";
import { setSweepLastIn, setSweepProbe, sweepOnce, sweepSay, workingIn } from "./robert-sweep.js";
import { writeSetting } from "./settings.js";
import type { TermStatus } from "./term-status.js";

const st = (phase: TermStatus["phase"], over: Partial<TermStatus> = {}): TermStatus => ({
  phase, line: "", word: phase, needs_you: false, since: Date.now(), on: null, eta_at: null,
  subagents: 0, progress: null, hooked: true, ...over,
});
let screens = new Map<string, TermStatus>();
let typed = new Map<string, number>();
setSweepProbe((id) => screens.get(id) ?? null);
setSweepLastIn((id) => typed.get(id) ?? null);
setWakeNotifier(async () => {});

let n = 0;
const ws = () => workspaces.create({ slug: "sweep" + ++n, name: "Sweep " + n, config_dir: "/tmp/sweep" + n });
const term = (wsId: string, phase: TermStatus["phase"], over: Partial<TermStatus> = {}, goal = "ship it") => {
  const s = sessions.create({ workspace_id: wsId, goal, cwd: "/tmp" } as any);
  screens.set(s.id, st(phase, over));
  return s;
};
const wakes = () => db.prepare("SELECT * FROM robert_wakes WHERE key LIKE ? ORDER BY generation").all(`${SWEEP_KEY}%`) as any[];
function reset() {
  db.prepare("DELETE FROM robert_wakes").run();
  db.prepare("DELETE FROM sessions").run();
  db.prepare("DELETE FROM workspaces").run();
  screens = new Map();
  typed = new Map();
}

test("workingIn: only goal-bearing terminals that are working count", () => {
  reset();
  const w = ws().id;
  term(w, "working");
  term(w, "waiting", { on: "ci" });
  term(w, "your_turn");
  term(w, "waiting", { on: "robert" });
  term(w, "working", {}, "");
  assert.equal(workingIn(w), 2, "working + waiting on CI; a stop or a scratch window is not work in flight");
});

test("workingIn: a ticked goal with nothing typed since is finished, even while its status reads working", () => {
  reset();
  const w = ws().id;
  const now = Date.now();
  const tick = (s: { id: string }, at: number) => sessions.setGoal(s.id, { goal_done_at: new Date(at).toISOString() });
  // Collage d139188e: ticked, Summary written, and statusOf still said working an hour later.
  const done = term(w, "working");
  tick(done, now - 60 * 60_000);
  assert.equal(workingIn(w, now), 0, "a finished terminal must not wake Robert every interval");
  // Typed to after the tick: the goal moved, so it is work in flight again.
  const more = term(w, "working");
  tick(more, now - 60 * 60_000);
  typed.set(more.id, now - 5 * 60_000);
  // Typed to only BEFORE the tick: still finished.
  const before = term(w, "working");
  tick(before, now - 10 * 60_000);
  typed.set(before.id, now - 20 * 60_000);
  assert.equal(workingIn(w, now), 1);
  // A new goal clears the tick: counted again.
  sessions.setGoal(done.id, { goal: "next thing", goal_done_at: null });
  assert.equal(workingIn(w, now), 2);
});

test("sweepOnce: a busy workspace is queued on its own scope, a quiet one is not", () => {
  reset();
  const busy = ws();
  const quiet = ws();
  term(busy.id, "working");
  term(quiet.id, "your_turn");
  assert.deepEqual(sweepOnce(5), [busy.id]);
  const rows = wakes();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].workspace_id, busy.id, "the drain runs it on that workspace's Robert and account");
  assert.match(JSON.parse(rows[0].payload).say, /PRESENCE SWEEP · Sweep \d+/);
});

test("sweepOnce: a sweep still queued absorbs the next one instead of stacking", () => {
  reset();
  const w = ws().id;
  term(w, "working");
  sweepOnce(5);
  sweepOnce(5);
  const rows = wakes();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hits, 2);
});

test("sweepOnce: a parked sweep is retired, not left to swallow every later one", () => {
  reset();
  const w = ws().id;
  term(w, "working");
  sweepOnce(5);
  db.prepare("UPDATE robert_wakes SET attempts = ? WHERE key LIKE ?").run(WAKE_ATTEMPT_CAP, `${SWEEP_KEY}%`);
  sweepOnce(5);
  const rows = wakes();
  assert.equal(rows.length, 2);
  assert.ok(rows[0].acked_at, "the parked one is off the queue");
  assert.equal(rows[1].acked_at, null, "a fresh sweep is queued");
});

test("sweepOnce: Robert off or the sweep off for a workspace skips it", () => {
  reset();
  const a = ws().id;
  const b = ws().id;
  term(a, "working");
  term(b, "working");
  writeSetting("robert.sweep", false, a);
  writeSetting("robert.enabled", false, b);
  assert.deepEqual(sweepOnce(5), []);
});

test("quietSweep: only an all-sweep turn answering QUIET is silent", () => {
  const sweep = [{ key: `${SWEEP_KEY}x` }];
  assert.equal(quietSweep(sweep, "QUIET"), true);
  assert.equal(quietSweep(sweep, "`QUIET`."), true);
  assert.equal(quietSweep(sweep, "Pushed 1a2b3c4d to open the PR."), false);
  assert.equal(quietSweep([...sweep, { key: "term-drive:abc" }], "QUIET"), false, "a real stop in the batch is always shown");
});

test("drainScope: a QUIET sweep is acked and never posted; a sweep that acted is posted", async () => {
  reset();
  const w = ws().id;
  term(w, "working");
  const posted: string[] = [];
  setWakePoster((p) => posted.push(p.body));
  setWakeAsker(async () => "QUIET");
  sweepOnce(5);
  assert.equal(await drainScope(w), "drained");
  assert.deepEqual(posted, []);
  assert.ok(wakes()[0].acked_at, "acked, so the next interval queues a fresh one");
  setWakeAsker(async () => "Told 1a2b3c4d to open the PR.");
  sweepOnce(5);
  assert.equal(await drainScope(w), "drained");
  assert.deepEqual(posted, ["Told 1a2b3c4d to open the PR."]);
});

test("sweepSay: tells him the cadence, the count and the QUIET contract", () => {
  const say = sweepSay("Initech", 3, 5);
  assert.match(say, /5-minute check while 3 terminal\(s\)/);
  assert.match(say, /exactly QUIET/);
});
