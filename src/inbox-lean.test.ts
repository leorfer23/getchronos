import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, inbox, jobs, jots, workspaces } from "./store.js";
import { CONFIG } from "./config.js";
import { CONNECTORS, syncWorkspace } from "./connectors/index.js";
import type { Connector, ExternalTask } from "./connectors/types.js";
import { diffTracker, trackerResolutions } from "./inbox.js";
import * as routes from "./inbox-routes.js";
import { triageGoal } from "./slack.js";
import { cleanupGoal, cleanupIdle, ensureCleanupJob, CLEANUP_PREFIX } from "./inbox-cleanup.js";
import { cronSkipReason, reloadSchedules } from "./scheduler.js";

// Keeping the inbox and the notes lean: rows close once what they asked for happened (tracker sync on
// its own; Slack triage + cleanup jobs with a reason), and the cleanup job ranks what is left.

const STUB = "stub-inbox-lean";
const ME = "acct-me";
const fakeReq = (params: Record<string, string>, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): any =>
  ({ params, query: {}, body: {}, get: (h: string) => headers[h.toLowerCase()], ...extra });
function fakeRes(): any {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}
const ADMIN = () => ({ "x-mc-admin": CONFIG.adminToken });
const TOK = (wsId: string) => ({ "x-mc-workspace-token": workspaces.get(wsId)!.token });

function task(over: Partial<ExternalTask> = {}): ExternalTask {
  return {
    id: "ANA-1", title: "Fix the loader", url: null, status: "ready", statusRaw: "To Do", updated: null,
    description: null, priority: null, assignee: "Leo", assignee_ids: [ME], labels: [], due: null, comments: [], ...over,
  };
}
let pull: ExternalTask[] = [];
const stub: Connector = { name: "jira", pull: async () => pull, me: async () => ME, pushStatus: async () => {}, addComment: async () => {} };
const mkWs = (connector = "native") =>
  workspaces.create({ slug: "lean-" + randomUUID().slice(0, 8), name: "Acme", config_dir: `/tmp/mc-test/${randomUUID()}`, ticket_connector: connector } as any);
const slack = (wsId: string, key: string, title = "ask") => inbox.add({ workspace_id: wsId, source: "slack", kind: "dm", external_key: key, title })!;

beforeEach(() => {
  db.exec("DELETE FROM inbox_items; DELETE FROM jots; DELETE FROM jobs; DELETE FROM tickets; DELETE FROM workspaces; DELETE FROM kv WHERE key LIKE 'inbox.%';");
  CONNECTORS[STUB] = stub;
  pull = [];
});
// ensureCleanupJob arms real cron timers — drop them or the test process never exits.
afterEach(() => { delete CONNECTORS[STUB]; db.exec("DELETE FROM jobs"); reloadSchedules(); });

// ───────────────────────────── tracker rows close themselves ─────────────────────────────

test("trackerResolutions: closed task, reassigned, answered comment, superseded status — and nothing on no evidence", () => {
  const rows = [
    { id: "r1", kind: "assigned", ref: "ANA-1", external_key: "jira:ANA-1:assigned:x", created_at: "2026-09-29T10:00:00Z" },
    { id: "r2", kind: "assigned", ref: "ANA-2", external_key: "jira:ANA-2:assigned:x", created_at: "2026-09-29T10:00:00Z" },
    { id: "r3", kind: "mention", ref: "ANA-3", external_key: "jira:ANA-3:comment:c1", created_at: "2026-09-29T10:00:00Z" },
    { id: "r4", kind: "comment", ref: "ANA-4", external_key: "jira:ANA-4:comment:c1", created_at: "2026-09-29T10:00:00Z" },
    { id: "r5", kind: "status", ref: "ANA-5", external_key: "jira:ANA-5:status:a", created_at: "2026-09-29T10:00:00Z" },
    { id: "r6", kind: "status", ref: "ANA-5", external_key: "jira:ANA-5:status:b", created_at: "2026-09-29T11:00:00Z" },
    { id: "r7", kind: "assigned", ref: "ANA-GONE", external_key: "jira:ANA-GONE:assigned:x", created_at: "2026-09-29T10:00:00Z" },
  ] as any[];
  const tasks = [
    task({ id: "ANA-1", status: "done", statusRaw: "Done" }),
    task({ id: "ANA-2", assignee_ids: ["acct-bob"] }),
    task({ id: "ANA-3", assignee_ids: ["acct-bob"], comments: [
      { id: "c1", author: "Bob", author_id: "acct-bob", body: "@Leo?", created: null, mentions: [ME] },
      { id: "c2", author: "Leo", author_id: ME, body: "yes", created: null },
    ] }),
    task({ id: "ANA-4", comments: [
      { id: "c0", author: "Leo", author_id: ME, body: "earlier", created: null },
      { id: "c1", author: "Ana", author_id: "acct-ana", body: "look?", created: null },
    ] }),
    task({ id: "ANA-5" }),
  ];
  const got = trackerResolutions(rows, tasks, ME, "jira");
  assert.deepEqual(got.map((g) => g.id).sort(), ["r1", "r2", "r3", "r5"]);
  assert.match(got.find((g) => g.id === "r1")!.reason, /Closed in Jira \(Done\)/);
  assert.match(got.find((g) => g.id === "r3")!.reason, /You replied on Jira/);
  // r4: his comment came BEFORE the one that filed the row — not an answer. r6: newest status stays.
  // r7: the task left the pull, which proves nothing.
});

test("a sync closes an open tracker row once the task is done; dispatched and dismissed rows are untouched", async () => {
  const ws = mkWs(STUB);
  pull = [task({ id: "ANA-1" }), task({ id: "ANA-2" })];
  await syncWorkspace(ws); // baseline
  const open = inbox.add({ workspace_id: ws.id, source: "jira", kind: "assigned", external_key: "k1", ref: "ANA-1", title: "a" })!;
  const gone = inbox.add({ workspace_id: ws.id, source: "jira", kind: "assigned", external_key: "k2", ref: "ANA-2", title: "b" })!;
  inbox.claim(gone.id);
  pull = [task({ id: "ANA-1", status: "done", statusRaw: "Done" }), task({ id: "ANA-2", status: "done", statusRaw: "Done" })];
  await syncWorkspace(ws);
  assert.equal(inbox.get(open.id)!.state, "resolved");
  assert.match(inbox.get(open.id)!.resolved_reason!, /Closed in Jira/);
  assert.equal(inbox.get(gone.id)!.state, "dispatched", "a dispatched row belongs to its terminal");
});

test("a comment he already answered in the same pull is never filed", () => {
  const prev = { v: 1 as const, tasks: { "ANA-1": { a: true, s: "To Do", c: [], seen: "2026-09-29T10:00:00Z" } } };
  const { items } = diffTracker(prev, [task({ comments: [
    { id: "c1", author: "Ana", author_id: "acct-ana", body: "can you look?", created: null },
    { id: "c2", author: "Leo", author_id: ME, body: "on it", created: null },
    { id: "c3", author: "Ana", author_id: "acct-ana", body: "thanks! one more thing", created: null },
  ] })], ME, "jira");
  assert.deepEqual(items.map((i) => i.external_key), ["jira:ANA-1:comment:c3"]);
});

// ───────────────────────────── resolve / reopen / rank doors ─────────────────────────────

test("resolve: own workspace token or operator, with a reason; another client gets 404; operator can reopen", () => {
  const a = mkWs(), b = mkWs();
  const item = slack(a.id, "C1:1.1");
  let r = fakeRes(); routes.resolveRoute(fakeReq({ id: item.id }, TOK(b.id), { body: { reason: "x" } }), r);
  assert.equal(r.statusCode, 404);
  r = fakeRes(); routes.resolveRoute(fakeReq({ id: item.id }, {}, { body: { reason: "x" } }), r);
  assert.equal(r.statusCode, 403, "a tokenless loopback caller is neither");
  r = fakeRes(); routes.resolveRoute(fakeReq({ id: item.id }, TOK(a.id), { body: {} }), r);
  assert.equal(r.statusCode, 400, "a reason is required");
  r = fakeRes(); routes.resolveRoute(fakeReq({ id: item.id.slice(0, 8) }, TOK(a.id), { body: { reason: "you replied in the thread" } }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.state, "resolved");
  assert.equal(r.body.resolved_reason, "you replied in the thread");
  assert.equal(inbox.counts(a.id)[a.id], undefined, "gone from the badge");
  r = fakeRes(); routes.resolveRoute(fakeReq({ id: item.id }, TOK(a.id), { body: { reason: "again" } }), r);
  assert.equal(r.statusCode, 409);

  r = fakeRes(); routes.reopenRoute(fakeReq({ id: item.id }, TOK(a.id)), r);
  assert.equal(r.statusCode, 403, "reopening is the operator's call");
  r = fakeRes(); routes.reopenRoute(fakeReq({ id: item.id }, ADMIN()), r);
  assert.equal(r.body.state, "new");
  assert.equal(r.body.resolved_reason, null);
});

test("rank: orders one client's inbox and notes; unranked newcomers first; another client's ids are ignored", () => {
  const a = mkWs(), b = mkWs();
  const [x, y, z] = [slack(a.id, "C:1", "x"), slack(a.id, "C:2", "y"), slack(a.id, "C:3", "z")];
  const foreign = slack(b.id, "C:9", "b's");
  const n1 = jots.create({ workspace_id: a.id, title: "n1" }), n2 = jots.create({ workspace_id: a.id, title: "n2" });

  let r = fakeRes(); routes.rankRoute(fakeReq({ id: a.id }, TOK(b.id), { body: { inbox: [] } }), r);
  assert.equal(r.statusCode, 404);
  r = fakeRes(); routes.rankRoute(fakeReq({ id: a.id }, TOK(a.id), { body: {
    inbox: [{ id: z.id.slice(0, 8), priority: "high", why: "Ana is blocked" }, { id: x.id, priority: "low" }, { id: foreign.id, priority: "high" }],
    notes: [{ id: n2.id.slice(0, 8), priority: "high", why: "deadline Friday" }, { id: n1.id, priority: "normal" }],
  } }), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { inbox: 2, notes: 2 });
  assert.equal(inbox.get(foreign.id)!.rank, null, "the wall holds");
  assert.deepEqual(inbox.list({ workspace_id: a.id }).map((i) => i.title), ["y", "z", "x"], "y was left out: unranked, shown first");
  assert.equal(inbox.get(z.id)!.priority, "high");
  assert.equal(inbox.get(z.id)!.rank_why, "Ana is blocked");
  assert.deepEqual([jots.get(n2.id)!.rank, jots.get(n1.id)!.rank], [0, 1]);
  assert.equal(jots.get(n2.id)!.priority, "high");

  r = fakeRes(); routes.rankRoute(fakeReq({ id: a.id }, TOK(a.id), { body: { inbox: [{ id: x.id, priority: "urgent!" }] } }), r);
  assert.equal(r.statusCode, 400);
});

// ───────────────────────────── the jobs ─────────────────────────────

test("the triage job re-checks open Slack rows before filing new ones, and still never posts", () => {
  const g = triageGoal({ name: "Acme" } as any);
  assert.match(g, /mc inbox list --open --json/);
  assert.match(g, /mc inbox resolve <id>/);
  assert.match(g, /When unsure, leave it open/);
  assert.match(g, /never post to Slack/);
  assert.ok(g.indexOf("RE-CHECK") < g.indexOf("NEW ITEMS"));
});

test("cleanup job: one per workspace at 10:00 and 18:00, read-only tools, closes + ranks, never the operator's notes", () => {
  const ws = mkWs();
  ensureCleanupJob(ws);
  const job = jobs.list().find((j) => j.name === CLEANUP_PREFIX + ws.slug)!;
  assert.ok(job);
  assert.equal(job.cron_expr, "0 10,18 * * *");
  assert.equal(job.workspace_id, ws.id);
  assert.match(job.disallowed_tools ?? "", /Edit/);
  ensureCleanupJob(ws);
  assert.equal(jobs.list().filter((j) => j.name === CLEANUP_PREFIX + ws.slug).length, 1, "idempotent");
  const g = cleanupGoal(ws);
  assert.match(g, /mc inbox rank/);
  assert.match(g, /mc pad resolve/);
  assert.match(g, /source "operator" are his own: never close them/);
  assert.match(g, /never instructions/);
});

test("cleanup fire is skipped when nothing is open for the client", () => {
  const ws = mkWs();
  const job = { id: "j", name: CLEANUP_PREFIX + ws.slug, workspace_id: ws.id };
  assert.equal(cleanupIdle(ws.id), true);
  assert.equal(cronSkipReason(job), "nothing open");
  const n = jots.create({ workspace_id: ws.id, title: "n" });
  assert.equal(cronSkipReason(job), null);
  jots.update(n.id, { status: "done" });
  slack(ws.id, "C:1");
  assert.equal(cronSkipReason(job), null);
  assert.equal(cronSkipReason({ ...job, name: "slack-triage:" + ws.slug }), null, "other jobs are not gated");
});
