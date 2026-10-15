/**
 * GET /desk/cockpit — the Robert panel's PRs and today's spend. `gh` is injected (CLAUDE.md), the
 * store is the in-memory one, and the route is exercised through its real handler so the workspace
 * wall is tested against the code that serves it.
 */
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { CONFIG } from "./config.js";
import { db, repos, sessions, sessionPrs, tickets, workspaces } from "./store.js";
import { setViewPr, clearPrCache } from "./session-artifacts.js";
import { cockpitData, cockpitRoute } from "./desk-cockpit.js";
import type { FocusEvent } from "./focus.js";

const rnd = () => randomUUID().slice(0, 8);
const mkWs = (auto = false) =>
  workspaces.create({ slug: `ck-${rnd()}`, name: "Cockpit", config_dir: `/tmp/mc-test/${rnd()}`, auto_merge_prs: auto } as any);
const say = (text: string, seq = 1): FocusEvent => ({ seq, kind: "say", text } as FocusEvent);
const GREEN = [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
const RED = [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "FAILURE" }];

function mkTicket(wsId: string, key: string, pr: string, ci: string | null) {
  const repo = repos.create({ workspace_id: wsId, name: "r-" + rnd(), path: "/tmp/mc-test/repo" } as any);
  const t = tickets.create({
    id: randomUUID(), workspace_id: wsId, repo_id: repo.id, key, slug: key.toLowerCase(), title: "ship it",
    status: "review", priority: "P2", complexity: null, backend: null, model: null, assignee: "agent",
    file_path: `/tmp/mc-test/${key}.md`, external_system: null, external_id: null, external_url: null, tags: null,
  } as any);
  tickets.update(t.id, { pr_url: pr, pr_state: "open", ci_state: ci } as any);
  return t;
}

const fakeReq = (headers: Record<string, string> = {}): any => ({ params: {}, query: {}, body: {}, get: (h: string) => headers[h.toLowerCase()] });
function fakeRes(): any {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}

beforeEach(() => {
  db.exec("DELETE FROM session_prs; DELETE FROM sessions; DELETE FROM tickets; DELETE FROM repos; DELETE FROM workspaces;");
});
afterEach(() => {
  setViewPr(null);
  clearPrCache();
});

test("open PRs only, green first, with CI read off the same gh lookup the companion uses", async () => {
  const ws = mkWs();
  const s = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code", role: "human" } as any);
  const feed: Record<string, FocusEvent[]> = {
    [s.id]: [
      say("opened https://github.com/o/r/pull/1", 1),
      say("CI red on https://github.com/o/r/pull/2", 2),
      say("that old one https://github.com/o/r/pull/3 is merged", 3),
    ],
  };
  setViewPr(async (url) =>
    url.endsWith("/1") ? { state: "OPEN", title: "one", statusCheckRollup: GREEN }
    : url.endsWith("/2") ? { state: "OPEN", title: "two", statusCheckRollup: RED }
    : { state: "MERGED", title: "three" });
  const out = await cockpitData(null, (id) => feed[id] ?? []);
  assert.deepEqual(out.prs.map((p) => [p.num, p.ci, p.session_id]), [[1, "passing", s.id], [2, "failing", s.id]]);
  assert.equal(out.prs[0].merge, null, "a feed PR has no merge door of its own — it opens on GitHub");
  assert.equal(typeof out.spend.today_usd, "number");
});

test("a ticket PR with green CI carries the existing merge route; a red one does not", async () => {
  const ws = mkWs();
  const green = mkTicket(ws.id, "CK-1", "https://github.com/o/r/pull/10", "passing");
  mkTicket(ws.id, "CK-2", "https://github.com/o/r/pull/11", "failing");
  const out = await cockpitData(null, () => []);
  assert.deepEqual(out.prs.map((p) => [p.num, p.merge?.ticket_id ?? null]), [[10, green.id], [11, null]]);
  assert.equal(out.prs[0].title, "CK-1 — ship it");
});

test("an auto-merge workspace's PR says so, and outlives its terminal", async () => {
  const ws = mkWs(true);
  const s = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code", role: "human" } as any);
  sessionPrs.record({ url: "https://github.com/o/r/pull/20", session_id: s.id, workspace_id: ws.id, cwd: "/tmp" });
  sessionPrs.update("https://github.com/o/r/pull/20", { ci_state: "pending" });
  sessions.end(s.id);
  const out = await cockpitData(null, () => []);
  assert.equal(out.prs.length, 1);
  assert.equal(out.prs[0].auto_merge, true);
  assert.equal(out.prs[0].ci, "pending");
  assert.equal(out.prs[0].session_id, s.id);
});

test("the route is scoped like /desk: a workspace token sees only its own PRs; a bad token is refused", async () => {
  const a = mkWs(true), b = mkWs(true);
  const sa = sessions.create({ workspace_id: a.id, cwd: "/tmp", backend: "claude-code", role: "human" } as any);
  const sb = sessions.create({ workspace_id: b.id, cwd: "/tmp", backend: "claude-code", role: "human" } as any);
  sessionPrs.record({ url: "https://github.com/o/a/pull/1", session_id: sa.id, workspace_id: a.id, cwd: "/tmp" });
  sessionPrs.record({ url: "https://github.com/o/b/pull/1", session_id: sb.id, workspace_id: b.id, cwd: "/tmp" });
  mkTicket(b.id, "CKB-1", "https://github.com/o/b/pull/2", "passing");
  const route = cockpitRoute(() => []);

  const asA = fakeRes();
  await route(fakeReq({ "x-mc-workspace-token": workspaces.get(a.id)!.token! }), asA);
  assert.equal(asA.statusCode, 200);
  assert.deepEqual(asA.body.prs.map((p: any) => p.url), ["https://github.com/o/a/pull/1"]);

  const admin = fakeRes();
  await route(fakeReq({ "x-mc-admin": CONFIG.adminToken }), admin);
  assert.equal(admin.body.prs.length, 3);

  const bad = fakeRes();
  await route(fakeReq({ "x-mc-workspace-token": "nope" }), bad);
  assert.equal(bad.statusCode, 401);
});

// ── the page half: static/desk-cockpit.js, run in a vm the way the other Desk scripts are ──────────
const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const pageCtx: any = {};
vm.runInNewContext(read("static/desk-cockpit.js"), pageCtx);
const CK = pageCtx.DeskCockpit;

test("the panel lists stopped terminals — blocked first, oldest first — and never one already asked as a question", () => {
  const rows = CK.pickTerms([
    { id: "w", phase: "working", since: 1 },
    { id: "r", phase: "review", since: 1 },
    { id: "t2", phase: "your_turn", since: 20 },
    { id: "t1", phase: "your_turn", since: 10 },
    { id: "b", phase: "blocked", since: 99 },
    { id: "q", phase: "decide", since: 5 },
    { id: "s", phase: "stalled", since: 5 },
    { id: "wait", phase: "waiting", since: 5 },
  ], new Set(["term:q"]));
  assert.deepEqual(Array.from(rows, (r: any) => r.id), ["b", "s", "t1", "t2", "r"]);
});

test("today's follow-ups: due today or overdue, or being worked — never tomorrow's, never a done note", () => {
  const now = new Date(2026, 8, 25, 10, 0).getTime();
  const at = (h: number, d = 25) => new Date(2026, 8, d, h, 0).toISOString();
  const rows = CK.todayFollowUps([
    { id: "late", status: "open", follow_up_at: at(18) },
    { id: "over", status: "open", follow_up_at: at(9, 24) },
    { id: "tmrw", status: "open", follow_up_at: at(9, 26) },
    { id: "done", status: "done", follow_up_at: at(11) },
    { id: "live", status: "open", follow_up_at: null, follow_up_session: "s1" },
    { id: "none", status: "open", follow_up_at: null, follow_up_session: null },
  ], now, (id: string) => id === "s1");
  assert.deepEqual(Array.from(rows, (r: any) => r.id), ["over", "late", "live"]);
});

test("the Desk carries the panel and the full-screen toggle; the Ask widget exposes what the panel reuses", () => {
  const html = read("static/desk.html");
  assert.match(html, /<script src="\/desk-cockpit\.js"><\/script>/);
  assert.match(html, /<div class="ck" id="cockpit" hidden><\/div>/);
  assert.match(html, /id="chat-full"/);
  assert.match(html, /desk-chat-full/, "full screen is remembered per viewer");
  // Reply-to (#74) and the Ask cards (#75) keep their anchors inside the reorganised pane.
  for (const id of ["chat-log", "chat-att", "chat-ask", "chat-input", "askpop", "chat-asks"]) assert.match(html, new RegExp(`id="${id}"`));
  const ask: any = {};
  vm.runInNewContext(read("static/ask-card.js"), ask);
  for (const k of ["items", "onChange", "host", "wire", "answer"]) assert.equal(typeof ask.AskCard[k], "function", k);
});
