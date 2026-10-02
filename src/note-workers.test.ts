import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, jobs, jots, runs, workspaces } from "./store.js";
import { CONFIG } from "./config.js";
import {
  expireStaleNotes, finishWorker, notesInFlight, onRunEnded, parseVerdict, pickNotes, startNoteWorkers,
  triedRecently, unlinkDeadWorkers, workerGoal, WORKER_PREFIX,
} from "./note-workers.js";
import { cleanupGoal, CLEANUP_PREFIX } from "./inbox-cleanup.js";
import { cronSkipReason, reloadSchedules } from "./scheduler.js";
import { genericWhyError, rankRoute } from "./inbox-routes.js";
import type { Workspace } from "./types.js";

// The daemon's half of the notes cleanup: stale agent notes close themselves, the top-ranked notes get
// headless workers after a cleanup run, and a worker's verdict is read back onto its note. Never the
// real executor (CLAUDE.md gotcha #2): dispatch is a stub that only writes the run row.

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-02T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const mkWs = (): Workspace =>
  workspaces.create({ slug: "nw-" + randomUUID().slice(0, 8), name: "Acme", config_dir: `/tmp/mc-test/${randomUUID()}` } as any);

/** A note with whatever fields the case needs, written straight to the row. */
function note(wsId: string, over: Record<string, unknown> = {}) {
  const j = jots.create({ workspace_id: wsId, title: (over.title as string) ?? "n-" + randomUUID().slice(0, 4), source: (over.source as any) ?? "agent" });
  const sets = Object.keys(over).filter((k) => k !== "title" && k !== "source");
  if (sets.length) db.prepare(`UPDATE jots SET ${sets.map((k) => `${k}=@${k}`).join(",")} WHERE id=@id`).run({ id: j.id, ...over });
  return jots.get(j.id)!;
}

/** Stub dispatch: a queued→running run row, nothing spawned. Records every call. */
function stubDispatch() {
  const calls: string[] = [];
  const fn = ((jobId: string) => {
    calls.push(jobId);
    const r = runs.create(jobId, "test");
    runs.patch(r.id, { status: "running" });
    return { run_id: r.id, status: "queued" };
  }) as any;
  return { fn, calls };
}
const jobFor = (noteId: string) => jobs.list().find((j) => j.name === WORKER_PREFIX + noteId.slice(0, 8))!;

let knobs: Record<string, number>;
beforeEach(() => {
  db.exec("DELETE FROM runs; DELETE FROM jots; DELETE FROM jobs; DELETE FROM workspaces;");
  knobs = { noteWorkers: CONFIG.noteWorkers, noteStaleDays: CONFIG.noteStaleDays, noteWorkerRetryDays: CONFIG.noteWorkerRetryDays };
  Object.assign(CONFIG, { noteWorkers: 3, noteStaleDays: 10, noteWorkerRetryDays: 7 });
});
afterEach(() => { Object.assign(CONFIG, knobs); db.exec("DELETE FROM runs; DELETE FROM jobs"); reloadSchedules(); });

// ───────────────────────────── picking ─────────────────────────────

test("pickNotes: high > normal > low > unranked, then the cleanup's rank; at most n", () => {
  const ws = mkWs();
  const low = note(ws.id, { title: "low", priority: "low", rank: 0 });
  const un = note(ws.id, { title: "unranked" });
  const n2 = note(ws.id, { title: "normal-2", priority: "normal", rank: 2 });
  const hi = note(ws.id, { title: "high", priority: "high", rank: 5 });
  const n1 = note(ws.id, { title: "normal-1", priority: "normal", rank: 1 });
  assert.deepEqual(pickNotes(ws.id, 3, NOW).map((j) => j.title), ["high", "normal-1", "normal-2"]);
  assert.deepEqual(pickNotes(ws.id, 10, NOW).map((j) => j.id), [hi.id, n1.id, n2.id, low.id, un.id]);
  assert.deepEqual(pickNotes(ws.id, 0, NOW), []);
});

test("pickNotes skips: follow-up pending, future-dated card, done, another client's, a worker in flight", () => {
  const ws = mkWs(), other = mkWs();
  note(ws.id, { title: "fu", priority: "high", follow_up_at: iso(NOW + DAY) });
  note(ws.id, { title: "tomorrow", priority: "high", for_date: "2099-01-01", source: "nextday" });
  note(ws.id, { title: "done", priority: "high", status: "done" });
  note(other.id, { title: "theirs", priority: "high" });
  const busy = note(ws.id, { title: "busy", priority: "high" });
  const job = jobs.create({ name: WORKER_PREFIX + busy.id.slice(0, 8), goal: "x", workspace_id: ws.id, trigger_type: "manual" });
  const r = runs.create(job.id, "t");
  note(ws.id, { title: "free", priority: "low" });
  assert.deepEqual(pickNotes(ws.id, 5, NOW).map((j) => j.title), ["free"]);
  assert.ok(notesInFlight(ws.id).has(busy.id.slice(0, 8)));
  runs.patch(r.id, { status: "success" });
  assert.deepEqual(pickNotes(ws.id, 5, NOW).map((j) => j.title), ["busy", "free"], "ended run frees the note");
});

test("triedRecently: not until the note is edited after the attempt, or the retry window passes", () => {
  const at = iso(NOW - DAY);
  assert.equal(triedRecently({ worker_at: null, updated_at: at }, NOW, 7), false);
  assert.equal(triedRecently({ worker_at: at, updated_at: at }, NOW, 7), true);
  assert.equal(triedRecently({ worker_at: at, updated_at: iso(NOW - 1000) }, NOW, 7), false, "edited since");
  assert.equal(triedRecently({ worker_at: iso(NOW - 8 * DAY), updated_at: iso(NOW - 8 * DAY) }, NOW, 7), false, "window passed");
});

// ───────────────────────────── starting ─────────────────────────────

test("startNoteWorkers: top 3 get a headless run each, linked; a second fire never double-dispatches", () => {
  const ws = mkWs();
  const ns = ["a", "b", "c", "d"].map((t, i) => note(ws.id, { title: t, priority: "normal", rank: i }));
  const d = stubDispatch();
  const out = startNoteWorkers(ws, { dispatch: d.fn, nowMs: NOW });
  assert.equal(out.length, 3);
  assert.equal(d.calls.length, 3);
  for (const n of ns.slice(0, 3)) {
    const j = jots.get(n.id)!;
    assert.ok(j.worker_run_id, "linked for the Desk");
    assert.equal(j.status, "open", "starting a worker does not close the note");
    assert.equal(j.updated_at, n.updated_at, "starting is not an edit");
    const job = jobFor(n.id);
    assert.equal(job.workspace_id, ws.id);
    assert.equal(job.backend, ws.default_backend);
    assert.equal(job.sandbox, ws.sandbox_mode);
    assert.equal(job.retry_max, 0);
  }
  assert.equal(jots.get(ns[3].id)!.worker_run_id ?? null, null);
  // All three still running: the cap is full, nothing new and nothing twice.
  assert.deepEqual(startNoteWorkers(ws, { dispatch: d.fn, nowMs: NOW }), []);
  assert.equal(d.calls.length, 3);
  // One finishes → one slot → the 4th note, never one of the three again.
  const r0 = jots.get(ns[0].id)!.worker_run_id!;
  runs.patch(r0, { status: "success", summary: "NOTE-RESULT: blocked — needs Leo" });
  assert.equal(finishWorker(jobFor(ns[0].id), runs.get(r0)!, NOW), "reported");
  const again = startNoteWorkers(ws, { dispatch: d.fn, nowMs: NOW });
  assert.deepEqual(again.map((o) => o.note), [ns[3].id.slice(0, 8)]);
  assert.equal(jobs.list().filter((j) => j.name.startsWith(WORKER_PREFIX)).length, 4, "one job per note");
});

test("knob 0 disables workers; a dispatch error stops the batch and leaves the notes alone", () => {
  const ws = mkWs();
  const a = note(ws.id, { priority: "high" }), b = note(ws.id, { priority: "normal" });
  const d = stubDispatch();
  CONFIG.noteWorkers = 0;
  assert.deepEqual(startNoteWorkers(ws, { dispatch: d.fn, nowMs: NOW }), []);
  assert.equal(d.calls.length, 0);
  CONFIG.noteWorkers = 3;
  let n = 0;
  const failing = (() => { n++; return { error: "loop guard: tripped" }; }) as any;
  const out = startNoteWorkers(ws, { dispatch: failing, nowMs: NOW });
  assert.equal(n, 1, "stopped after the first refusal");
  assert.equal(out[0].error, "loop guard: tripped");
  for (const id of [a.id, b.id]) {
    assert.equal(jots.get(id)!.worker_run_id ?? null, null);
    assert.equal(jots.get(id)!.worker_at ?? null, null, "not counted as an attempt");
  }
});

test("a cleanup run that succeeded starts workers; a failed one does not", () => {
  const ws = mkWs();
  note(ws.id, { priority: "high" });
  const cj = jobs.create({ name: CLEANUP_PREFIX + ws.slug, goal: "x", workspace_id: ws.id, trigger_type: "manual" });
  const d = stubDispatch();
  const failed = runs.create(cj.id, "cron"); runs.patch(failed.id, { status: "failed" });
  onRunEnded(failed.id, CLEANUP_PREFIX, { dispatch: d.fn });
  assert.equal(d.calls.length, 0);
  const ok = runs.create(cj.id, "cron"); runs.patch(ok.id, { status: "success" });
  onRunEnded(ok.id, CLEANUP_PREFIX, { dispatch: d.fn });
  assert.equal(d.calls.length, 1);
});

test("the worker's goal: decide first, PR never merge, never message anyone, the verdict line", () => {
  const ws = mkWs();
  const n = note(ws.id, { title: "Fix the flyway rollback", body: "check prod first", source: "operator", priority: "high", rank_why: "Ana waits" });
  const g = workerGoal(ws, n, [{ name: "api", path: "/r/api" }]);
  assert.match(g, /Fix the flyway rollback/);
  assert.match(g, /check prod first/);
  assert.match(g, /- api: \/r\/api \(worktrees go under \/r\/\.chronos-worktrees\/api\/\)/);
  assert.match(g, /DECIDE FIRST/);
  assert.match(g, /gh pr list --state all/);
  assert.match(g, /NEVER merge, NEVER deploy/);
  assert.match(g, /NEVER message people/);
  assert.match(g, /NOTE-RESULT: done/);
  assert.match(g, /NOTE-RESULT: blocked/);
});

// ───────────────────────────── verdicts ─────────────────────────────

test("parseVerdict: the last NOTE-RESULT line wins; dashes, markdown and a PR link", () => {
  assert.deepEqual(parseVerdict("did it\nNOTE-RESULT: done — PR opened https://github.com/acme/api/pull/42"),
    { verdict: "done", reason: "PR opened https://github.com/acme/api/pull/42", pr: "https://github.com/acme/api/pull/42" });
  assert.equal(parseVerdict("NOTE-RESULT: blocked - needs Leo's call")!.reason, "needs Leo's call");
  assert.equal(parseVerdict("**NOTE-RESULT: dismissed** — superseded by ANA-9")!.verdict, "dismissed");
  assert.equal(parseVerdict("NOTE-RESULT: blocked — x\nNOTE-RESULT: done — y")!.verdict, "done");
  assert.equal(parseVerdict("note-result: DONE: merged")!.verdict, "done");
  assert.equal(parseVerdict("NOTE-RESULT: maybe — ?"), null);
  assert.equal(parseVerdict("all good"), null);
  assert.equal(parseVerdict(null), null);
});

function endedRun(noteId: string, wsId: string, status: string, summary: string | null, error: string | null = null) {
  const job = jobFor(noteId) ?? jobs.create({ name: WORKER_PREFIX + noteId.slice(0, 8), goal: "x", workspace_id: wsId, trigger_type: "manual" });
  const r = runs.create(job.id, "t");
  jots.workerStarted(noteId, r.id, iso(NOW - 3600_000));
  runs.patch(r.id, { status: status as any, summary, error });
  return { job, run: runs.get(r.id)! };
}

test("done/dismissed resolve the note — the operator's own too — with the reason and the PR link", () => {
  const ws = mkWs();
  const mine = note(ws.id, { source: "operator", title: "mine" });
  const { job, run } = endedRun(mine.id, ws.id, "success", "Opened it.\nhttps://github.com/acme/api/pull/7\nNOTE-RESULT: done — fix pushed for review");
  assert.equal(finishWorker(job, run, NOW), "resolved");
  const j = jots.get(mine.id)!;
  assert.equal(j.status, "done");
  assert.equal(j.worker_run_id, null);
  assert.match(j.body!, /✓ Resolved 2026-10-02 — done \(worker [0-9a-f]{8}\): fix pushed for review https:\/\/github\.com\/acme\/api\/pull\/7/);
  // Reversible: ↩ reopen is the ordinary status patch.
  assert.equal(jots.update(mine.id, { status: "open" })!.status, "open");

  const other = note(ws.id, { title: "obsolete" });
  const e = endedRun(other.id, ws.id, "success", "NOTE-RESULT: dismissed — superseded by note 3f2a91c0");
  finishWorker(e.job, e.run, NOW);
  assert.match(jots.get(other.id)!.body!, /dismissed \(worker .{8}\): superseded by note 3f2a91c0$/);
});

test("blocked / failed / no verdict keep the note open with a dated line, and count as an attempt", () => {
  const ws = mkWs();
  const cases: Array<[string, string | null, string | null, RegExp]> = [
    ["success", "NOTE-RESULT: blocked — needs Leo to pick the vendor", null, /2026-10-02 worker .{8}: blocked — needs Leo to pick the vendor$/],
    ["success", "I looked around.", null, /worker .{8}: no verdict$/],
    ["timeout", null, "timed out after 3600s\nstack", /worker .{8}: timeout — timed out after 3600s$/],
    ["success", null, null, /no verdict$/],
  ];
  for (const [status, summary, error, re] of cases) {
    const n = note(ws.id, { body: "the brief", updated_at: iso(NOW - 5 * DAY) });
    const { job, run } = endedRun(n.id, ws.id, status, summary, error);
    assert.equal(finishWorker(job, run, NOW), "reported");
    const j = jots.get(n.id)!;
    assert.equal(j.status, "open");
    assert.match(j.body!, /^the brief\n/);
    assert.match(j.body!, re);
    assert.equal(j.worker_run_id, null, "Desk mark cleared");
    assert.equal(j.worker_at, j.updated_at, "our own append is not an edit");
    assert.equal(triedRecently(j, NOW + 60_000), true, "not re-picked until edited");
    assert.equal(pickNotes(ws.id, 10, NOW + 60_000).some((x) => x.id === n.id), false);
  }
});

test("a worker still running, or a note he closed meanwhile, is left alone", () => {
  const ws = mkWs();
  const n = note(ws.id, {});
  const { job, run } = endedRun(n.id, ws.id, "running", null);
  assert.equal(finishWorker(job, run, NOW), null);
  assert.ok(jots.get(n.id)!.worker_run_id);
  jots.update(n.id, { status: "done" });
  const body = jots.get(n.id)!.body;
  runs.patch(run.id, { status: "success", summary: "NOTE-RESULT: blocked — x" });
  assert.equal(finishWorker(job, runs.get(run.id)!, NOW), null);
  assert.equal(jots.get(n.id)!.body, body);
  assert.equal(jots.get(n.id)!.worker_run_id, null);
});

// ───────────────────────────── stale sweep ─────────────────────────────

test("stale sweep: agent/nextday notes untouched N days close; operator, high, follow-up, fresh, worked stay", () => {
  const ws = mkWs();
  const old = iso(NOW - 12 * DAY);
  const stale = note(ws.id, { source: "agent", updated_at: old });
  const card = note(ws.id, { source: "nextday", for_date: "2026-09-01", updated_at: old, priority: "low" });
  const mine = note(ws.id, { source: "operator", updated_at: old });
  const high = note(ws.id, { source: "agent", priority: "high", updated_at: old });
  const fu = note(ws.id, { source: "agent", updated_at: old, follow_up_at: iso(NOW + DAY) });
  const fresh = note(ws.id, { source: "agent", updated_at: iso(NOW - 3 * DAY) });
  const wj = jobs.create({ name: "note-work:xxxxxxxx", goal: "x", workspace_id: ws.id, trigger_type: "manual" });
  const live = runs.create(wj.id, "t"); runs.patch(live.id, { status: "running" });
  const worked = note(ws.id, { source: "agent", updated_at: old, worker_run_id: live.id });
  const orphan = note(ws.id, { source: "agent", updated_at: old, worker_run_id: "run-that-is-gone" });
  assert.equal(expireStaleNotes(ws.id, NOW, 10), 3, "a link to a run that is gone does not protect it");
  assert.equal(jots.get(orphan.id)!.status, "done");
  assert.equal(jots.get(stale.id)!.status, "done");
  assert.match(jots.get(stale.id)!.body!, /✓ Resolved 2026-10-02 — stale: untouched 12 days$/);
  assert.equal(jots.get(card.id)!.status, "done");
  for (const k of [mine, high, fu, fresh, worked]) assert.equal(jots.get(k.id)!.status, "open", k.title);
  assert.equal(expireStaleNotes(ws.id, NOW, 0), 0, "0 = off");
  // Reopened by hand → fresh again, not swept on the next fire.
  jots.update(stale.id, { status: "open" });
  assert.equal(expireStaleNotes(ws.id, Date.now(), 10), 0);
});

test("unlinkDeadWorkers: a mark whose run is over is dropped, a live one stays", () => {
  const ws = mkWs();
  const wj = jobs.create({ name: "note-work:yyyyyyyy", goal: "x", workspace_id: ws.id, trigger_type: "manual" });
  const live = runs.create(wj.id, "t"); runs.patch(live.id, { status: "running" });
  const dead = runs.create(wj.id, "t"); runs.patch(dead.id, { status: "interrupted" });
  const a = note(ws.id, { worker_run_id: live.id }), b = note(ws.id, { worker_run_id: dead.id });
  assert.equal(unlinkDeadWorkers(ws.id), 1);
  assert.equal(jots.get(a.id)!.worker_run_id, live.id);
  assert.equal(jots.get(b.id)!.worker_run_id, null);
});

test("the cleanup's cron gate sweeps stale notes before deciding the fire", () => {
  const ws = mkWs();
  const s = note(ws.id, { source: "agent", updated_at: iso(Date.now() - 30 * DAY) });
  const job = { id: "j", name: CLEANUP_PREFIX + ws.slug, workspace_id: ws.id };
  assert.equal(cronSkipReason(job), "nothing open", "the only note was stale → swept → nothing left to clean");
  assert.equal(jots.get(s.id)!.status, "done");
});

// ───────────────────────────── the cleanup agent ─────────────────────────────

test("cleanup goal: verify with PRs/git/tracker before keeping, evidence in the why, specific rank whys", () => {
  const ws = mkWs();
  const g = cleanupGoal(ws, [{ name: "api", path: "/r/api" }]);
  assert.match(g, /VERIFY, THEN CLOSE/);
  assert.match(g, /- api: \/r\/api/);
  assert.match(g, /gh pr list --state all/);
  assert.match(g, /git -C <path> log/);
  assert.match(g, /PR #12 merged 09-30/);
  assert.match(g, /Never a generic label/);
  assert.doesNotMatch(g, /When unsure, keep it/);
});

test("rank: generic whys and one why pasted over >3 rows are refused", () => {
  assert.match(genericWhyError("notes", [{ why: "Routine follow-up" }])!, /generic why/);
  assert.match(genericWhyError("notes", [{ why: "Someday / on hold or nice-to-have" }])!, /generic why/);
  const same = Array.from({ length: 4 }, () => ({ why: "Waiting on vendor quote." }));
  assert.match(genericWhyError("notes", same)!, /same why "Waiting on vendor quote\." on 4 rows/);
  assert.equal(genericWhyError("notes", same.slice(0, 3)), null);
  assert.equal(genericWhyError("notes", [{ why: "Ana blocked on loader fix" }, {}, { why: "" }]), null);

  const ws = mkWs();
  const n = note(ws.id, {});
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  const req: any = { params: { id: ws.id }, query: {}, body: { notes: [{ id: n.id, priority: "normal", why: "Routine follow-up" }] },
    get: (h: string) => (h.toLowerCase() === "x-mc-workspace-token" ? workspaces.get(ws.id)!.token : undefined) };
  rankRoute(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /ranking not saved/);
  assert.equal(jots.get(n.id)!.priority, null, "nothing written");
});
