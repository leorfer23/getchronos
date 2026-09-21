import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CONFIG } from "./config.js";
import { asks, db, jobs, kv, reviews, runs, tickets, workspaces } from "./store.js";
import { checkScope } from "./authz.js";
import { filterByBucket, holdBucket, parseBucketFilter } from "./hold-bucket.js";
import {
  agedItems,
  applyHold,
  divergenceLine,
  divergences,
  nudgeAgedHolds,
  resolveHoldTarget,
  resurfaceDueHolds,
} from "./holds.js";
import { holdStall, resurfaceStall, stallHold } from "./recovery.js";

beforeEach(() => {
  db.exec(
    "DELETE FROM asks; DELETE FROM reviews; DELETE FROM run_events; DELETE FROM runs; DELETE FROM jobs; DELETE FROM tickets; DELETE FROM workspaces; DELETE FROM kv; DELETE FROM board_posts;",
  );
});

let n = 0;
const mkWs = () =>
  workspaces.create({ slug: `hold-${n++}-${Math.random().toString(36).slice(2)}`, name: "HoldWS", config_dir: `/tmp/hold-${n}` });
const mkJob = (over: any = {}) => jobs.create({ name: `hold-job-${n++}`, goal: "do it", ...over });
const mkTicket = (ws: any, over: any = {}) =>
  tickets.create({
    id: randomUUID(), workspace_id: ws.id, repo_id: null, key: `HLD-${n++}`, slug: `hld-${n}`, title: "a ticket",
    status: "in_progress", priority: "P2", complexity: null, backend: null, model: null, assignee: "agent",
    file_path: `/tmp/hld-${n}.md`, external_system: null, external_id: null, external_url: null, tags: null,
    ...over,
  } as any);

function mkAsk(ws: any, over: any = {}) {
  const job = mkJob({ workspace_id: ws.id });
  const run = runs.create(job.id, "manual");
  return asks.create({ run_id: run.id, job_id: job.id, workspace_id: ws.id, question: "main or release?", ...over });
}

// req/res fakes — same shape authz.test.ts uses; enough for checkScope.
const fakeReq = (headers: Record<string, string> = {}): any => ({ get: (h: string) => headers[h.toLowerCase()] });
function fakeRes(): any {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}

// ── relative-date parsing (the watches.ts grammar) ──────────────────────────

test("applyHold parses +20m / +2h / +48h / +2d and an ISO date", () => {
  const ws = mkWs();
  const now = Date.parse("2026-09-12T12:00:00.000Z");
  for (const [until, expect] of [
    ["+20m", "2026-09-12T12:20:00.000Z"],
    ["+2h", "2026-09-12T14:00:00.000Z"],
    ["+48h", "2026-09-14T12:00:00.000Z"],
    ["+2d", "2026-09-14T12:00:00.000Z"],
    ["2026-10-01T09:00:00.000Z", "2026-10-01T09:00:00.000Z"],
  ] as const) {
    const a = mkAsk(ws);
    const out = applyHold(resolveHoldTarget("ask", a.id)!, until, "not today", now);
    assert.ok(out.ok, `${until} should parse`);
    assert.equal(out.hold_until, expect, until);
    assert.equal(asks.get(a.id)!.hold_reason, "not today");
  }
});

test("applyHold refuses a garbage date and a date in the past — a hold with no future is not a deferral", () => {
  const ws = mkWs();
  const now = Date.parse("2026-09-12T12:00:00.000Z");
  const a = mkAsk(ws);
  const target = resolveHoldTarget("ask", a.id)!;
  const bad = applyHold(target, "soon", null, now);
  assert.equal(bad.ok, false);
  assert.equal((bad as any).status, 400);
  const past = applyHold(target, "2026-09-11T12:00:00.000Z", null, now);
  assert.equal(past.ok, false);
  assert.equal(asks.get(a.id)!.hold_until, null, "nothing written on a refusal");
});

test("applyHold with until:null lifts the hold and drops the reason; the ask stays OPEN", () => {
  const ws = mkWs();
  const a = mkAsk(ws);
  const target = resolveHoldTarget("ask", a.id)!;
  applyHold(target, "+2d", "next sprint");
  assert.ok(asks.get(a.id)!.hold_until);
  const out = applyHold(target, null, null);
  assert.ok(out.ok);
  const row = asks.get(a.id)!;
  assert.equal(row.hold_until, null);
  assert.equal(row.hold_reason, null);
  assert.equal(row.status, "open", "a hold is never a close");
});

test("an id8 prefix resolves the same as a full id (Telegram callback_data / mc hold)", () => {
  const ws = mkWs();
  const a = mkAsk(ws);
  const target = resolveHoldTarget("ask", a.id.slice(0, 8));
  assert.equal(target?.id, a.id);
});

test("applyHold refuses an already-answered ask — there is nothing left to defer", () => {
  const ws = mkWs();
  const a = mkAsk(ws);
  asks.answer(a.id, "main", "human");
  const out = applyHold(resolveHoldTarget("ask", a.id)!, "+2d", null);
  assert.equal(out.ok, false);
  assert.equal((out as any).status, 409);
});

test("answering an ask lifts its hold in the same statement (an answer IS the unhold)", () => {
  const ws = mkWs();
  const a = mkAsk(ws);
  applyHold(resolveHoldTarget("ask", a.id)!, "+2d", "later");
  const answered = asks.answer(a.id, "release", "human")!;
  assert.equal(answered.hold_until, null);
  assert.equal(answered.hold_reason, null);
  assert.equal(answered.answer, "release");
  assert.equal(answered.answered_by, "human", "the operator's own words, still verbatim");
});

// ── live-only default on open lists ─────────────────────────────────────────

test("the open-ask list defaults to the LIVE bucket: a dated hold is off it, ?bucket=all shows it", () => {
  const ws = mkWs();
  const live = mkAsk(ws, { question: "needs you now" });
  const held = mkAsk(ws, { question: "not today" });
  applyHold(resolveHoldTarget("ask", held.id)!, "+2d", "after the release");

  const open = asks.list({ status: "open", workspace_id: ws.id });
  assert.equal(open.length, 2, "both rows are still open at the SQL layer — a hold closes nothing");
  assert.deepEqual(filterByBucket(open, parseBucketFilter(undefined)).map((a) => a.id), [live.id]);
  assert.deepEqual(filterByBucket(open, parseBucketFilter("dated")).map((a) => a.id), [held.id]);
  assert.equal(filterByBucket(open, parseBucketFilter("all")).length, 2);
  // The dated row still carries the date it comes back on, so a "Next" surface can show it.
  assert.ok(asks.get(held.id)!.hold_until);
});

test("a pending review holds and un-holds the same way; deciding it lifts the hold", () => {
  const ws = mkWs();
  const t = mkTicket(ws);
  const job = mkJob({ workspace_id: ws.id, ticket_id: t.id });
  const run = runs.create(job.id, "manual");
  const r = reviews.create({ run_id: run.id, ticket_id: t.id, diff_ref: "d" });
  applyHold(resolveHoldTarget("review", r.id)!, "+2d", "wait for CI");
  assert.equal(holdBucket(reviews.get(r.id)!), "dated");
  assert.deepEqual(filterByBucket(reviews.list("pending"), "live").map((x) => x.id), []);

  // pending → pending (an AI recommend-approve still wanting a human) must NOT yank it back.
  reviews.setState(r.id, "pending", "ai recommends", "ai:reviewer");
  assert.ok(reviews.get(r.id)!.hold_until, "a non-decision keeps the deferral");

  reviews.setState(r.id, "approved", null, "human");
  assert.equal(reviews.get(r.id)!.hold_until, null, "a real decision lifts it");
});

// ── resurface: exactly once ────────────────────────────────────────────────

test("a due hold resurfaces exactly once: the second sweep finds nothing", async () => {
  const ws = mkWs();
  const a = mkAsk(ws);
  const now = Date.now();
  applyHold(resolveHoldTarget("ask", a.id)!, "+2h", "after lunch", now);

  assert.equal(await resurfaceDueHolds(now), 0, "not due yet");
  assert.ok(asks.get(a.id)!.hold_until, "still held");

  const later = now + 3 * 3_600_000;
  assert.equal(await resurfaceDueHolds(later), 1);
  const back = asks.get(a.id)!;
  assert.equal(back.hold_until, null, "the hold is spent");
  assert.ok(back.resurfaced_at, "stamped, so the card is never sent twice");
  assert.equal(back.status, "open", "it came back as the same open question");
  assert.equal(holdBucket(back, later), "live");

  assert.equal(await resurfaceDueHolds(later), 0, "a second sweep must not re-card it");
});

test("resurface covers reviews and recovery holds too, and each only once", async () => {
  const ws = mkWs();
  const t = mkTicket(ws);
  const job = mkJob({ workspace_id: ws.id, ticket_id: t.id });
  const run = runs.create(job.id, "manual");
  const r = reviews.create({ run_id: run.id, ticket_id: t.id, diff_ref: "d" });
  const now = Date.now();
  applyHold(resolveHoldTarget("review", r.id)!, "+2h", null, now);
  // A stall is a derived row, so its hold lives in kv beside the decision already kept there.
  holdStall("r:deadbeef", new Date(now + 3_600_000).toISOString(), "monday");
  assert.equal(stallHold("r:deadbeef").until !== null, true);

  const later = now + 3 * 3_600_000;
  assert.equal(await resurfaceDueHolds(later), 1, "the review (the stall handle matches no live stall)");
  assert.equal(reviews.get(r.id)!.hold_until, null);
  assert.equal(await resurfaceDueHolds(later), 0);

  // The kv path's own once-only guard, independent of whether a stall is still listed.
  assert.equal(resurfaceStall("r:deadbeef", new Date(later).toISOString()), true);
  assert.equal(resurfaceStall("r:deadbeef", new Date(later).toISOString()), false);
});

// ── aged: a nudge, not a re-card, once per day ──────────────────────────────

test("an undated decision past holdAgedHours is `aged` and nudged once per day", async () => {
  const ws = mkWs();
  const a = mkAsk(ws);
  const old = new Date(Date.now() - (CONFIG.holdAgedHours + 1) * 3_600_000).toISOString();
  db.prepare("UPDATE asks SET created_at = ? WHERE id = ?").run(old, a.id);

  const aged = agedItems();
  assert.deepEqual(aged.map((i) => i.key), [`ask:${a.id}`]);
  assert.equal(await nudgeAgedHolds(), 1);
  assert.equal(await nudgeAgedHolds(), 0, "same day → silent");
  // Tomorrow it speaks again — gently, and still without pulling it back onto the live list.
  assert.equal(await nudgeAgedHolds(Date.now() + 86_400_000), 1);
  assert.equal(holdBucket(asks.get(a.id)!), "aged");
});

// ── workspace scoping (CLAUDE.md gotcha 4) ─────────────────────────────────

test("resolveHoldTarget reports the OWNING workspace, and a foreign token is 404'd by checkScope", () => {
  const mine = mkWs();
  const other = mkWs();
  const a = mkAsk(mine);
  const target = resolveHoldTarget("ask", a.id)!;
  assert.equal(target.workspace_id, mine.id);

  const res = fakeRes();
  assert.equal(checkScope(fakeReq({ "x-mc-workspace-token": other.token }), res, target.workspace_id), false);
  assert.equal(res.statusCode, 404, "another workspace must not even learn it exists");

  const ok = fakeRes();
  assert.equal(checkScope(fakeReq({ "x-mc-workspace-token": mine.token }), ok, target.workspace_id), true);
});

test("a review's owning workspace is resolved through its ticket", () => {
  const ws = mkWs();
  const t = mkTicket(ws);
  const job = mkJob({ workspace_id: ws.id, ticket_id: t.id });
  const run = runs.create(job.id, "manual");
  const r = reviews.create({ run_id: run.id, ticket_id: t.id, diff_ref: null });
  assert.equal(resolveHoldTarget("review", r.id)!.workspace_id, ws.id);
});

// ── divergence: reported from real rows, closes nothing ────────────────────

test("divergences: a done ticket with its ask still open is reported and nothing is closed", () => {
  const ws = mkWs();
  const t = mkTicket(ws, { status: "done" });
  const job = mkJob({ name: `ticket:${t.key}`, workspace_id: ws.id, ticket_id: t.id });
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, { status: "paused" });
  const a = asks.create({ run_id: run.id, job_id: job.id, ticket_id: t.id, workspace_id: ws.id, question: "ship it?" });

  const rows = divergences(ws.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "ask");
  assert.equal(rows[0].id, a.id);
  assert.match(divergenceLine(rows), /divergence: 1 record\(s\) disagree \(nothing was closed\)/);
  assert.equal(asks.get(a.id)!.status, "open", "the report resolves nothing");
  assert.equal(tickets.get(t.id)!.status, "done");
});

test("divergences: a merged PR with its review still pending is reported; an open PR is not", () => {
  const ws = mkWs();
  const t = mkTicket(ws, { status: "review" });
  const job = mkJob({ workspace_id: ws.id, ticket_id: t.id });
  const run = runs.create(job.id, "manual");
  const r = reviews.create({ run_id: run.id, ticket_id: t.id, diff_ref: "d" });

  tickets.update(t.id, { pr_state: "open" } as any);
  assert.deepEqual(divergences(ws.id), []);

  tickets.update(t.id, { pr_state: "merged" } as any);
  const rows = divergences(ws.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "review");
  assert.equal(rows[0].id, r.id);
  assert.equal(reviews.get(r.id)!.state, "pending", "still pending — the report decided nothing");
});

test("divergences is workspace-scoped: another workspace's contradiction is not reported here", () => {
  const mine = mkWs();
  const other = mkWs();
  const t = mkTicket(other, { status: "done" });
  const job = mkJob({ name: `ticket:${t.key}`, workspace_id: other.id, ticket_id: t.id });
  const run = runs.create(job.id, "manual");
  asks.create({ run_id: run.id, job_id: job.id, ticket_id: t.id, workspace_id: other.id, question: "ship?" });

  assert.deepEqual(divergences(mine.id), []);
  assert.equal(divergences(other.id).length, 1);
  assert.equal(divergences(null).length, 1, "unscoped sees the whole fleet");
});

test("divergences: a read-only run's finished ask is not a divergence", () => {
  const ws = mkWs();
  const t = mkTicket(ws, { status: "in_progress" });
  const job = mkJob({ name: `plan:${t.key}`, workspace_id: ws.id, ticket_id: t.id });
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, { status: "success" });
  asks.create({ run_id: run.id, job_id: job.id, ticket_id: t.id, workspace_id: ws.id, question: "which repo?" });
  assert.deepEqual(divergences(ws.id), []);
});

test("divergenceLine is empty when the records agree", () => {
  assert.equal(divergenceLine([]), "");
});

test("the aged nudge marker is per item, so one item's nudge does not silence another", async () => {
  const ws = mkWs();
  const a = mkAsk(ws);
  const b = mkAsk(ws);
  const old = new Date(Date.now() - (CONFIG.holdAgedHours + 1) * 3_600_000).toISOString();
  db.prepare("UPDATE asks SET created_at = ? WHERE id IN (?,?)").run(old, a.id, b.id);
  assert.equal(await nudgeAgedHolds(), 2);
  kv.del(`hold.nudged.ask:${b.id}`);
  assert.equal(await nudgeAgedHolds(), 1, "only the un-marked one speaks");
});
