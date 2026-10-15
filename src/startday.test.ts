/**
 * Start the day: one terminal per workspace, each handed a brief the daemon assembled from its own
 * tables, each proposing today's work and waiting. The brief is pure (rendered from a context
 * object), so these read what the agent would be told; the fan-out is exercised with a stubbed
 * openSession. The Desk half is read as text, the way desk-nextday.test.ts reads its own.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { wsTicketsDir } from "./sandbox.js";
import { db, inbox, jots, sessions, workspaces } from "./store.js";
import { collectContext } from "./nextday.js";
import {
  collectStartContext, defaultStartWorkspaces, startBriefPath, startDay, startDayBrief, today,
} from "./startday.js";
import { isSafeProposal } from "./telegram/agent.js";
import { StartDaySchema } from "./validation.js";
import type { Session, Ticket, Workspace } from "./types.js";

beforeEach(() => {
  db.exec("DELETE FROM inbox_items; DELETE FROM jots; DELETE FROM sessions; DELETE FROM tickets; DELETE FROM repos; DELETE FROM notes; DELETE FROM workspaces;");
});

let n = 0;
const mkWs = (extra: Partial<Parameters<typeof workspaces.create>[0]> = {}) =>
  workspaces.create({ slug: `start${++n}-${randomUUID().slice(0, 4)}`, name: `Client ${n}`, config_dir: "/tmp/start", kind: "client", ...extra });

const emptyCtx = { sessions: [], tickets: [], repos: [], inbox: [], cards: [], parked: [] };
const DAY = "2026-10-13";

// ── the day and who gets a terminal ──
test("today is the calendar day on the operator's clock, weekend or not", () => {
  assert.equal(today(new Date(2026, 9, 13, 8, 30)), "2026-10-13");
  assert.equal(today(new Date(2026, 9, 17, 23, 59)), "2026-10-17"); // a Saturday stays Saturday
  assert.equal(today(new Date(2026, 9, 14, 0, 40)), "2026-10-14");
});

test("the default is every workspace that is not archived — no kind or default_dir filter", () => {
  const a = mkWs({ default_dir: "/a" });
  const b = mkWs();
  const c = mkWs({ kind: "personal" });
  const gone = mkWs();
  workspaces.update(gone.id, { archived: true });
  assert.deepEqual(defaultStartWorkspaces().map((w) => w.id).sort(), [a.id, b.id, c.id].sort());
});

// ── the brief ──
test("the brief is read-only until the operator answers, and its output is a proposal he waits on", () => {
  const b = startDayBrief(mkWs(), DAY, emptyCtx);
  assert.match(b, /^# Start 2026-10-13 \(Tuesday\)/);
  assert.match(b, /Until he answers you are read-only/);
  assert.match(b, /you do not post or reply anywhere/);
  for (const h of ["## Waiting on you", "## Overnight", "## Today, in order", "## Not today", "## Could not reach"]) assert.match(b, new RegExp(h));
  assert.match(b, /Then stop and wait for him\. Do not run `mc goal done` yet\./);
  assert.ok(b.indexOf("## What to propose") < b.indexOf("## After he answers"), "filing comes after the answer");
  assert.match(b, /mc jot new --date 2026-10-13 --title/);
  assert.doesNotMatch(b, /What the operator wants weighed in/);
});

test("steering goes first and outranks the sources", () => {
  const b = startDayBrief(mkWs(), DAY, { ...emptyCtx, steering: "Ledger tickets before anything else" });
  const steerAt = b.indexOf("What the operator wants weighed in");
  assert.ok(steerAt > 0 && steerAt < b.indexOf("Where to look"));
  assert.match(b, /Ledger tickets before anything else/);
});

test("every source the operator asked for is named: inbox, tracker, Slack, the client's tools, the last work in Chronos", () => {
  const jira = mkWs({ ticket_connector: "jira", connector_config: { base_url: "https://x.atlassian.net", project_key: "ANA", api_token: "SECRET-TOKEN-123" } });
  const b = startDayBrief(jira, DAY, emptyCtx);
  assert.match(b, /mc inbox list --open/);
  assert.match(b, /\*\*Jira\*\* \(https:\/\/x\.atlassian\.net, project ANA\)/);
  assert.doesNotMatch(b, /SECRET-TOKEN-123/);
  assert.match(b, /3\. Slack — use the Slack tools your profile exposes/);
  assert.match(b, /Airflow, Jenkins, CI/);
  assert.match(b, /mc cal --days 1/);
  assert.match(b, /mc worklog/);
  assert.match(b, /mc when list/);
  assert.match(b, /mc pad due/);
  assert.match(b, /review-requested:@me/);

  const wired = mkWs({ slack_config: { enabled: true, bot_token: "xoxb-SECRET" } });
  const b2 = startDayBrief(wired, DAY, emptyCtx);
  assert.match(b2, /3\. Slack — this workspace has its Slack tools wired in\./);
  assert.doesNotMatch(b2, /xoxb-SECRET/);
});

test("inbox rows, sessions, PRs, today's cards and parked rows all land in the brief", () => {
  const ws = mkWs();
  const s = {
    id: "s1", created_at: "2026-10-12T15:38:00Z", title: "Dual reports shipping", goal: "PR #3734 open",
    goal_kind: "pr", summary: "PR #3734 open — awaiting review", status: "ended", goal_done_at: null,
  } as unknown as Session;
  const t = {
    key: "ACM-70", title: "Aurora report migration", status: "building", updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    pr_url: "https://github.com/x/y/pull/3734", pr_state: "open", external_url: "https://app.clickup.com/t/abc", external_status: "in progress",
  } as unknown as Ticket;
  const item = { source: "slack", kind: "dm", title: "can you look at the WLM queue?", actor: "Dana", why: "direct question", url: "https://x.slack.com/p1", urgent: 1 } as any;
  const card = jots.create({ workspace_id: ws.id, title: "Ship the Aurora port", for_date: DAY, source: "nextday" });
  const parked = jots.create({ workspace_id: ws.id, title: "ask about WLM", body: "check prod first" });
  const b = startDayBrief(ws, DAY, {
    sessions: [s], tickets: [t], repos: [{ name: "shop", path: "/r/shop", git_remote: null } as any],
    inbox: [item], cards: [card], parked: [card, parked], learnings: "- prefer sql/ convention",
  });
  assert.match(b, /‼ \[slack\/dm\] can you look at the WLM queue\? — Dana — direct question https:\/\/x\.slack\.com\/p1/);
  assert.match(b, /2026-10-12 · Dual reports shipping \(pr\) — PR #3734 open — awaiting review/);
  assert.match(b, /ACM-70 · Aurora report migration \[in progress\]/);
  assert.match(b, /ACM-70 · Aurora report migration — open https:\/\/github\.com\/x\/y\/pull\/3734/);
  assert.match(b, /shop: \/r\/shop/);
  assert.match(b, /mc jot list --date 2026-10-13/);
  assert.match(b, /   - Ship the Aurora port\n/);
  assert.match(b, /ask about WLM — check prod first/);
  assert.match(b, /prefer sql\/ convention/);
});

test("collectStartContext: open inbox rows, today's open cards, and no planner or start-day terminals", () => {
  const ws = mkWs(), other = mkWs();
  inbox.add({ workspace_id: ws.id, source: "slack", kind: "dm", external_key: "k1", title: "ping" });
  inbox.add({ workspace_id: other.id, source: "slack", kind: "dm", external_key: "k2", title: "someone else's" });
  jots.create({ workspace_id: ws.id, title: "today's card", for_date: DAY, source: "nextday" });
  jots.create({ workspace_id: ws.id, title: "tomorrow's card", for_date: "2026-10-14", source: "nextday" });
  sessions.create({ workspace_id: ws.id, title: "real work", goal: "ship it", role: "human", cwd: "/tmp" });
  sessions.create({ workspace_id: ws.id, title: "Start Day 10-12", goal: "Start 10-12: propose today's work", role: "human", cwd: "/tmp" });
  sessions.create({ workspace_id: ws.id, title: "Next Day 10-13 plan", goal: "Plan 10-13: file tomorrow's cards", role: "human", cwd: "/tmp" });
  const ctx = collectStartContext(ws, DAY, "steer");
  assert.deepEqual(ctx.inbox.map((i) => i.title), ["ping"]);
  assert.deepEqual(ctx.cards.map((j) => j.title), ["today's card"]);
  assert.deepEqual(ctx.sessions.map((s) => s.title), ["real work"]);
  assert.equal(ctx.steering, "steer");
  // The evening planner does not pick up a morning terminal as a thread either.
  assert.deepEqual(collectContext(ws, "2026-10-14").sessions.map((s) => s.title), ["real work"]);
});

// ── the fan-out ──
type Opened = Array<Record<string, any>>;
const stub = (opened: Opened, briefs: Record<string, string>, failFor?: string) => ({
  open: async (o: any) => {
    if (o.workspace_id === failFor) throw new Error("workspace session cap reached (4/4)");
    opened.push(o);
    return { id: `sess-${opened.length}` } as Session;
  },
  writeBrief: (ws: Workspace, date: string, text: string) => { briefs[ws.slug] = text; return `/tmp/${ws.slug}/${date}.md`; },
});
const NOW = new Date(2026, 9, 13, 8, 30);

test("one terminal per picked workspace, each told where its brief is; a failing one does not stop the rest", async () => {
  const a = mkWs(), b = mkWs(), c = mkWs();
  const card = jots.create({ workspace_id: a.id, title: "last night's card", for_date: DAY, source: "nextday" });
  const opened: Opened = [], briefs: Record<string, string> = {};
  const r = await startDay({ workspaces: [a.id, b.id, c.id], steering: { [b.id]: "finish the Aurora port" }, created_by: "robert" }, stub(opened, briefs, c.id), NOW);
  assert.equal(r.date, DAY);
  assert.deepEqual(r.started.map((p) => p.workspace_id), [a.id, b.id]);
  assert.deepEqual(r.errors.map((e) => [e.workspace_id, e.error]), [[c.id, "workspace session cap reached (4/4)"]]);
  assert.equal(opened.length, 2);
  assert.equal(opened[0].title, "Start Day 10-13");
  assert.equal(opened[0].goal, "Start 10-13: propose today's work");
  assert.equal(opened[0].goal_kind, "investigation");
  assert.equal(opened[0].created_by, "robert");
  assert.equal(opened[0].host_id, "local", "the brief is a file on the brain's disk");
  assert.match(opened[0].description, new RegExp(`Read the full brief at /tmp/${a.slug}/${DAY}\\.md`));
  assert.doesNotMatch(opened[0].description, /wants weighed in/);
  assert.match(opened[1].description, /^What your operator wants weighed in for .* today[^\n]*\nfinish the Aurora port\n\nRead the full brief/);
  assert.match(briefs[b.slug], /finish the Aurora port/);
  // Today's cards are an input, never cleared.
  assert.equal(jots.get(card.id)?.status, "open");
  assert.match(briefs[a.slug], /last night's card/);
});

test("no list means every unarchived workspace; an unknown id is refused before anything opens", async () => {
  const a = mkWs({ default_dir: "/a" }), b = mkWs({ kind: "personal" });
  const opened: Opened = [];
  const r = await startDay({}, stub(opened, {}), NOW);
  assert.deepEqual(r.started.map((p) => p.workspace_id).sort(), [a.id, b.id].sort());
  const twice = await startDay({ workspaces: [a.id, a.id] }, stub([], {}), NOW);
  assert.equal(twice.started.length, 1, "a workspace named twice gets one terminal");
  await assert.rejects(() => startDay({ workspaces: [a.id, "nope"] }, stub(opened, {}), NOW), /workspace not found: nope/);
  assert.equal(opened.length, 2);
});

test("the brief lives in the workspace's tickets dir, beside plan-tomorrow's and apart from it", () => {
  const ws = mkWs();
  assert.equal(startBriefPath(ws, DAY), path.join(wsTicketsDir(ws.slug), "startday", `${DAY}.md`));
});

// ── the request, Robert, and the Desk ──
test("the request: optional ids and steering keyed by id; Robert may call it without confirmation", () => {
  assert.equal(StartDaySchema.safeParse({}).success, true);
  assert.equal(StartDaySchema.safeParse({ workspaces: ["a"], steering: { a: "x" } }).success, true);
  assert.equal(StartDaySchema.safeParse({ workspaces: [] }).success, false);
  assert.equal(isSafeProposal({ method: "POST", path: "/api/startday", body: {} } as any), true);
});

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");

test("the button sits in the bar right before the inbox, and the dialog posts the ticked workspaces to /startday", () => {
  assert.match(html, /<div class="tools">\s*<button class="icon" id="btn-startday"[^>]*>☀️<\/button>\s*<button class="icon" id="btn-inbox"/);
  assert.match(html, /<dialog id="dlg-startday">/);
  assert.match(html, /api\("\/startday", \{ method: "POST", body: JSON\.stringify\(\{ workspaces, steering \}\) \}\)/);
  assert.match(html, /qs\("#btn-startday"\)\.onclick = openStartDay/);
});

test("every workspace starts ticked; only what the operator unticked is remembered", () => {
  assert.match(html, /S\.workspaces\.filter\(\(w\) => !skip\.has\(w\.id\)\)/);
  assert.match(html, /localStorage\.setItem\("mc-start-off"/);
  assert.match(html, /id="start-all"/);
  // Both day dialogs build their rows with the same helper.
  assert.equal((html.match(/fillPlanRows\(/g) ?? []).length, 3);
});
