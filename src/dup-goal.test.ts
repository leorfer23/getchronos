/**
 * The duplicate-work check at open: a goal that reads like a live terminal's in the same workspace is
 * flagged; a different goal, another workspace's terminal, an ended one or the opener's own Lead is not.
 * Robert hears a flagged open on his wake queue, behind the same switch as a terminal stop.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { db, sessions, workspaces } from "./store.js";
import { setWakeAsker, setWakeNotifier, setWakePoster } from "./wake-queue.js";
import { writeSetting } from "./settings.js";
import { DUP_GOAL_KEY, dupGoal, tellRobertDup } from "./dup-goal.js";

// A queued wake must never reach a real model or the operator's Telegram from a test.
setWakeAsker(async () => "noted");
setWakePoster(() => {});
setWakeNotifier(async () => {});

let n = 0;
const ws = () => workspaces.create({ slug: "dup" + ++n, name: "Dup " + n, config_dir: "/tmp/dup" + n });
const term = (wsId: string, goal: string | null, over: Record<string, unknown> = {}) =>
  sessions.create({ workspace_id: wsId, goal, cwd: "/tmp", ...over } as any);
const wakes = () => db.prepare("SELECT * FROM robert_wakes WHERE key LIKE ?").all(`${DUP_GOAL_KEY}%`) as any[];
function reset() {
  db.prepare("DELETE FROM robert_wakes").run();
  db.prepare("DELETE FROM sessions").run();
  db.prepare("DELETE FROM workspaces").run();
}

const GOAL = "Warn when a new terminal's goal duplicates a live one in the same project";
const AGAIN = "Warn (never block) when a new terminal's goal duplicates a live one in the same workspace";

test("a live terminal in the same workspace with the same job → warning naming it", () => {
  reset();
  const w = ws().id;
  const old = term(w, GOAL);
  const opened = term(w, AGAIN);
  const dup = dupGoal(opened);
  assert.ok(dup, "flagged");
  assert.equal(dup.id, old.id);
  assert.ok(dup.score >= 0.5 && dup.score < 1, `score ${dup.score}`);
  assert.match(dup.warning, new RegExp(`live terminal ${old.id.slice(0, 8)} `));
  assert.match(dup.warning, /mc session focus/);
});

test("a different goal in the same workspace → nothing", () => {
  reset();
  const w = ws().id;
  term(w, "Desk window: relaunch itself when WebKit wedges the main thread");
  term(w, "Desk: a printed page link opens the page in place, not in the browser");
  assert.equal(dupGoal(term(w, GOAL)), null);
});

test("another workspace's terminal with the same goal → nothing (client boundary)", () => {
  reset();
  const a = ws().id;
  const b = ws().id;
  term(b, GOAL);
  assert.equal(dupGoal(term(a, GOAL)), null);
});

test("an ended terminal with the same goal → nothing", () => {
  reset();
  const w = ws().id;
  sessions.end(term(w, GOAL).id);
  assert.equal(dupGoal(term(w, GOAL)), null);
});

test("no goal, or the opener's own Lead → nothing; the best of several matches wins", () => {
  reset();
  const w = ws().id;
  const lead = term(w, GOAL, { role: "lead" });
  assert.equal(dupGoal(term(w, GOAL, { lead_id: lead.id })), null, "a worker carries a slice of its Lead's goal by design");
  assert.equal(dupGoal(term(w, null)), null);
  const exact = term(w, AGAIN);
  assert.equal(dupGoal(term(w, AGAIN))?.id, exact.id, "the closer of two matches");
});

test("Robert: one wake per flagged open on his queue; none with drive off, none for a Lead's worker", async () => {
  reset();
  const w = ws().id;
  term(w, GOAL);
  const opened = term(w, AGAIN);
  const dup = dupGoal(opened)!;
  assert.ok(await tellRobertDup(opened, dup));
  const rows = wakes();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, `${DUP_GOAL_KEY}${opened.id}`);
  assert.equal(rows[0].workspace_id, w);
  assert.match(JSON.parse(rows[0].payload).say, new RegExp(`${opened.id.slice(0, 8)}.*${dup.id.slice(0, 8)}`));

  const worker = term(w, AGAIN, { lead_id: term(w, "Lead: something else entirely").id });
  assert.equal(await tellRobertDup(worker, dupGoal(worker)!), null);

  const off = ws().id;
  writeSetting("robert.drive", false, off);
  term(off, GOAL);
  const quiet = term(off, AGAIN);
  assert.equal(await tellRobertDup(quiet, dupGoal(quiet)!), null);
  assert.equal(wakes().length, 1, "still only the first one");
});
