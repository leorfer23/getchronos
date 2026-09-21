/**
 * Plan tomorrow: one planner terminal per client, each handed a brief the daemon assembled from its
 * own tables, each filing dated cards. The brief is pure (rendered from a context object), so these
 * read what the agent would be told; the fan-out is exercised with a stubbed openSession.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, jots, sessions, workspaces } from "./store.js";
import {
  briefPath, collectContext, defaultPlanWorkspaces, nextDayBrief, nextWorkday, planNextDay,
} from "./nextday.js";
import { isSafeProposal } from "./telegram/agent.js";
import type { Session, Ticket, Workspace } from "./types.js";

beforeEach(() => {
  db.exec("DELETE FROM jots; DELETE FROM sessions; DELETE FROM tickets; DELETE FROM repos; DELETE FROM notes; DELETE FROM workspaces;");
});

let n = 0;
const mkWs = (extra: Partial<Parameters<typeof workspaces.create>[0]> = {}) =>
  workspaces.create({ slug: `plan${++n}-${randomUUID().slice(0, 4)}`, name: `Client ${n}`, config_dir: "/tmp/plan", kind: "client", ...extra });

const emptyCtx = { sessions: [], tickets: [], repos: [], parked: [], replaced: 0 };

// ── the day ──
test("nextWorkday: an evening plan is for tomorrow, a small-hours plan is for today, weekends roll to Monday", () => {
  assert.equal(nextWorkday(new Date(2026, 8, 3, 19, 0)), "2026-09-04");   // Thu evening → Fri
  assert.equal(nextWorkday(new Date(2026, 8, 4, 1, 20)), "2026-09-04");   // Fri 01:20 → Fri (the day just started)
  assert.equal(nextWorkday(new Date(2026, 8, 4, 18, 0)), "2026-09-07");   // Fri evening → Mon
  assert.equal(nextWorkday(new Date(2026, 8, 5, 12, 0)), "2026-09-07");   // Sat → Mon
  assert.equal(nextWorkday(new Date(2026, 8, 6, 2, 0)), "2026-09-07");    // Sun small hours → Mon
});

// ── the brief ──
test("steering goes first and outranks the sources; the filing command carries the date", () => {
  const ws = mkWs();
  const b = nextDayBrief(ws, "2026-09-04", { ...emptyCtx, steering: "Ledger tickets before anything else" });
  const steerAt = b.indexOf("What the operator wants weighed in");
  const lookAt = b.indexOf("Where to look");
  assert.ok(steerAt > 0 && steerAt < lookAt, "steering section precedes the sources");
  assert.match(b, /Ledger tickets before anything else/);
  assert.match(b, /mc jot new --date 2026-09-04 --title/);
  assert.match(b, /mc jot list --date 2026-09-04/);
  for (const h of ["## Description", "## Goal", "## Where to look", "## Done when", "## QA for the operator"]) assert.match(b, new RegExp(h));
  assert.match(b, /4–7 cards/);
  assert.match(b, /Tomorrow always gets its own cards/);
  assert.match(b, /context, not a constraint/);
  assert.doesNotMatch(b, /do NOT duplicate/);
  assert.match(b, /Friday/, "names the weekday of the planned date");
});

test("no steering, no steering section", () => {
  const b = nextDayBrief(mkWs(), "2026-09-04", emptyCtx);
  assert.doesNotMatch(b, /What the operator wants weighed in/);
});

test("the tracker line names the tracker and its project but never its credentials", () => {
  const jira = mkWs({ ticket_connector: "jira", connector_config: { base_url: "https://x.atlassian.net", project_key: "ANA", email: "me@x", api_token: "SECRET-TOKEN-123" } });
  const b = nextDayBrief(jira, "2026-09-04", emptyCtx);
  assert.match(b, /\*\*Jira\*\* \(https:\/\/x\.atlassian\.net, project ANA\)/);
  assert.doesNotMatch(b, /SECRET-TOKEN-123/);
  assert.doesNotMatch(b, /me@x/);

  const cu = mkWs({ ticket_connector: "clickup", connector_config: { token: "pk_SECRET", list_id: "9013" } });
  const b2 = nextDayBrief(cu, "2026-09-04", emptyCtx);
  assert.match(b2, /\*\*ClickUp\*\* \(list 9013\)/);
  assert.doesNotMatch(b2, /pk_SECRET/);

  const native = mkWs();
  const b3 = nextDayBrief(native, "2026-09-04", emptyCtx);
  assert.match(b3, /No tracker is mirrored/);
  assert.match(b3, /never invent tickets/);
});

test("sessions, PRs, parked cards and the replaced count all land in the brief", () => {
  const ws = mkWs();
  const s = {
    id: "s1", created_at: "2026-09-03T15:38:00Z", title: "Dual reports shipping investigation", goal: "PR #3734 open",
    goal_kind: "pr", summary: "Reports-shipping PR #3734 open — awaiting review/CI", status: "ended", goal_done_at: null,
  } as unknown as Session;
  const t = {
    key: "ACM-70", title: "Aurora report migration", status: "building", updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    pr_url: "https://github.com/x/y/pull/3734", pr_state: "open", external_url: "https://app.clickup.com/t/abc", external_status: "in progress",
  } as unknown as Ticket;
  const closed = { key: "ACM-1", title: "old", status: "done", updated_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" } as unknown as Ticket;
  const parked = jots.create({ workspace_id: ws.id, title: "ask about WLM", body: "check prod first" });
  const b = nextDayBrief(ws, "2026-09-04", {
    sessions: [s], tickets: [t, closed], repos: [{ name: "shop", path: "/r/shop", git_remote: "git@github.com:x/shop.git" } as any],
    parked: [parked], learnings: "- prefer sql/ convention", replaced: 2,
  });
  assert.match(b, /2026-09-03 · Dual reports shipping investigation \(pr\) — Reports-shipping PR #3734 open/);
  assert.match(b, /ACM-70 · Aurora report migration \[in progress\] https:\/\/app\.clickup\.com\/t\/abc/);
  assert.doesNotMatch(b, /ACM-1 · old/, "closed tickets are not in the open mirror");
  assert.match(b, /ACM-70 · Aurora report migration — open https:\/\/github\.com\/x\/y\/pull\/3734/);
  assert.match(b, /shop: \/r\/shop \(git@github\.com:x\/shop\.git\)/);
  assert.match(b, /ask about WLM — check prod first/);
  assert.match(b, /prefer sql\/ convention/);
  assert.match(b, /2 earlier planner cards were cleared for 2026-09-04/);
});

test("collectContext skips terminals with nothing to say and earlier planners, newest first, eight at most", () => {
  const ws = mkWs();
  for (let i = 0; i < 10; i++) sessions.create({ workspace_id: ws.id, title: `work ${i}`, goal: `ship ${i}`, role: "human", cwd: "/tmp" });
  sessions.create({ workspace_id: ws.id, title: "cwd check", role: "human", cwd: "/tmp" }); // a title but nothing to say
  sessions.create({ workspace_id: ws.id, title: "Next Day 09-04 plan", goal: "Plan 09-04: file tomorrow's cards", role: "human", cwd: "/tmp" });
  const ctx = collectContext(ws, "2026-09-04");
  assert.equal(ctx.sessions.length, 8);
  assert.ok(ctx.sessions.every((s) => /^work \d$/.test(s.title!)));
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

test("one planner per picked client, each told where its brief is; a failing client does not stop the rest", async () => {
  const a = mkWs({ default_dir: "/a" }), b = mkWs({ default_dir: "/b" }), c = mkWs({ default_dir: "/c" });
  const opened: Opened = [], briefs: Record<string, string> = {};
  const r = await planNextDay(
    { workspaces: [a.id, b.id, c.id], steering: { [b.id]: "finish the Aurora port" }, date: "2026-09-04", created_by: "robert" },
    stub(opened, briefs, c.id),
  );
  assert.equal(r.date, "2026-09-04");
  assert.deepEqual(r.planned.map((p) => p.slug), [a.slug, b.slug]);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].workspace_id, c.id);
  assert.match(r.errors[0].error, /cap reached/);
  assert.equal(opened.length, 2);
  const o = opened[1];
  assert.equal(o.workspace_id, b.id);
  assert.equal(o.goal_kind, "investigation");
  assert.equal(o.goal_source, "human", "the planner's card title must survive its own first Understanding");
  assert.equal(o.role, "human");
  assert.equal(o.created_by, "robert");
  assert.equal(o.title, "Next Day 09-04 plan");
  assert.match(o.description, new RegExp(`Read the full brief at /tmp/${b.slug}/2026-09-04.md`));
  assert.match(o.description, /finish the Aurora port/, "the operator's words ride in the first prompt, not only in the file");
  assert.doesNotMatch(opened[0].description, /finish the Aurora port/);
  assert.match(briefs[b.slug], /finish the Aurora port/);
  assert.doesNotMatch(briefs[a.slug], /finish the Aurora port/, "steering is per client");
});

test("a re-plan replaces the day's unrun planner cards and leaves the operator's and the run ones alone", async () => {
  const ws = mkWs({ default_dir: "/a" });
  const mine = jots.create({ workspace_id: ws.id, title: "my own parked thought" });
  const stale = jots.create({ workspace_id: ws.id, title: "stale plan", for_date: "2026-09-04", source: "nextday" });
  const ran = jots.create({ workspace_id: ws.id, title: "ran plan", for_date: "2026-09-04", source: "nextday" });
  jots.ran(ran.id, "some-session");
  const otherDay = jots.create({ workspace_id: ws.id, title: "next week", for_date: "2026-09-08", source: "nextday" });
  const opened: Opened = [], briefs: Record<string, string> = {};
  const r = await planNextDay({ workspaces: [ws.id], date: "2026-09-04" }, stub(opened, briefs));
  assert.equal(r.planned[0].replaced, 1);
  assert.equal(jots.get(stale.id), undefined);
  assert.ok(jots.get(mine.id) && jots.get(ran.id) && jots.get(otherDay.id));
  assert.match(briefs[ws.slug], /1 earlier planner card was cleared for 2026-09-04/);
  assert.match(briefs[ws.slug], /my own parked thought/);
});

test("with no list, the clients you work in are the default: unarchived, kind client, with a default_dir", async () => {
  const yes = mkWs({ default_dir: "/yes" });
  mkWs();                                            // client, no home dir
  mkWs({ default_dir: "/p", kind: "personal" });     // not a client
  const archived = mkWs({ default_dir: "/z" });
  workspaces.update(archived.id, { archived: true } as any);
  assert.deepEqual(defaultPlanWorkspaces().map((w) => w.id), [yes.id]);
  const opened: Opened = [];
  const r = await planNextDay({ date: "2026-09-04" }, stub(opened, {}));
  assert.deepEqual(r.planned.map((p) => p.workspace_id), [yes.id]);
});

test("an unknown workspace id is refused up front; no clients at all is an error, not an empty success", async () => {
  await assert.rejects(planNextDay({ workspaces: ["nope"], date: "2026-09-04" }, stub([], {})), /workspace not found: nope/);
  await assert.rejects(planNextDay({ date: "2026-09-04" }, stub([], {})), /no workspaces to plan/);
});

test("the brief lives under the workspace's tickets dir — a path the sandbox already grants", () => {
  const ws = mkWs();
  assert.match(briefPath(ws, "2026-09-04"), new RegExp(`/tickets/${ws.slug}/nextday/2026-09-04\\.md$`));
});

// ── Robert ──
test("Robert may plan tomorrow without a confirm card: it opens read-only planners and files cards nobody has committed to", () => {
  assert.equal(isSafeProposal({ label: "plan tomorrow", method: "POST", path: "/api/nextday", body: {} }), true);
});
