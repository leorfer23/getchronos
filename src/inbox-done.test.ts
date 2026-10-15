import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { db, inbox, kv, workspaces, tickets } from "./store.js";
import { CONFIG } from "./config.js";
import { CONNECTORS, syncWorkspace } from "./connectors/index.js";
import { clickup } from "./connectors/clickup.js";
import type { Connector, ExternalTask } from "./connectors/types.js";
import { addInboxItem, emitTrackerInbox, isMuted } from "./inbox.js";
import { INBOX_DONE_ACTOR } from "./inbox-done.js";
import * as routes from "./inbox-routes.js";

// CLAUDE.md: never a real tracker. A stub connector registered on CONNECTORS stands in for Jira or
// ClickUp (its `name` is what the inbox row's source must match) and records every write.
const STUB = "stub-inbox-done";
const ME = "acct-me";

const fakeReq = (params: Record<string, string>, headers: Record<string, string> = {}, body: unknown = {}): any =>
  ({ params, query: {}, body, get: (h: string) => headers[h.toLowerCase()] });
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
    id: "ANA-1", title: "Fix the loader", url: "https://acme.atlassian.net/browse/ANA-1", status: "in_progress", statusRaw: "In Progress",
    updated: "2026-09-24T10:00:00.000Z", description: null, priority: null, assignee: "Leo", assignee_ids: [ME], labels: [], due: null, comments: [],
    ...over,
  };
}

type Call = [string, ...unknown[]];
let calls: Call[] = [];
let fail: Partial<Record<"pushStatus" | "setHours" | "logTime" | "addComment", string>> = {};
let pull: ExternalTask[] = [];
function stubFor(name: "jira" | "clickup"): Connector {
  const rec = (m: keyof typeof fail) => async (_cfg: any, ...a: unknown[]) => {
    calls.push([m, ...a]);
    if (fail[m]) throw new Error(fail[m]);
  };
  return {
    name,
    pull: async () => pull,
    me: async () => ME,
    pushStatus: rec("pushStatus"),
    addComment: rec("addComment"),
    ...(name === "jira" ? { setHours: rec("setHours") } : { logTime: rec("logTime") }),
  };
}

const mkWs = (cfg: Record<string, unknown> | null = null) =>
  workspaces.create({
    slug: "ibd-" + randomUUID().slice(0, 8), name: "Acme", config_dir: `/tmp/mc-test/${randomUUID()}`,
    ticket_connector: STUB, connector_config: cfg,
  } as any);
const row = (wsId: string, over: Record<string, unknown> = {}) =>
  addInboxItem({ workspace_id: wsId, source: "jira", kind: "assigned", external_key: "k-" + randomUUID(), title: "Fix the loader", ref: "ANA-1", ...over } as any)!;
const done = async (id: string, body: unknown = {}, headers = ADMIN()) => {
  const r = fakeRes();
  await routes.doneRoute(fakeReq({ id }, headers, body), r);
  return r;
};

beforeEach(() => {
  db.exec("DELETE FROM inbox_items; DELETE FROM tickets; DELETE FROM workspaces; DELETE FROM kv WHERE key LIKE 'inbox.%';");
  CONNECTORS[STUB] = stubFor("jira");
  calls = []; fail = {}; pull = [];
});
afterEach(() => { delete CONNECTORS[STUB]; });

// ───────────────────────────── Won't do ─────────────────────────────

test("won't do mutes the task: no new comment, status move or re-assign files for that ref again", async () => {
  const ws = mkWs();
  pull = [task(), task({ id: "ANA-2", url: null })];
  await syncWorkspace(ws); // baseline
  const a = row(ws.id);
  const sibling = row(ws.id, { kind: "comment" });
  const r = fakeRes(); routes.wontdoRoute(fakeReq({ id: a.id }, ADMIN()), r);
  assert.equal(r.body.state, "muted");
  assert.equal(inbox.get(sibling.id)!.state, "muted", "the other open rows about the task go with it");
  assert.ok(isMuted(ws.id, "jira", "ANA-1"));
  assert.deepEqual(calls, [], "nothing is written to the tracker");

  const comment = { id: "c1", author: "Ana", author_id: "acct-ana", body: "any news?", created: null, mentions: [ME] };
  pull = [task({ statusRaw: "In Review", status: "review", comments: [comment] }), task({ id: "ANA-2", url: null, statusRaw: "Blocked", status: "blocked", comments: [comment] })];
  await syncWorkspace(ws);
  const fresh = inbox.list({ workspace_id: ws.id });
  assert.deepEqual([...new Set(fresh.map((i) => i.ref))], ["ANA-2"], "only the unmuted task files");
  // Unassigned and assigned again: still silent.
  assert.equal(emitTrackerInbox(ws.id, "jira", ME, [task({ assignee_ids: [] })]), 0);
  assert.equal(emitTrackerInbox(ws.id, "jira", ME, [task({ updated: "2026-09-26T00:00:00.000Z" })]), 0);
  assert.equal(addInboxItem({ workspace_id: ws.id, source: "jira", kind: "mention", external_key: "x", title: "t", ref: "ANA-1" }), null);
  // The mute is per workspace and per source.
  const other = mkWs();
  assert.ok(addInboxItem({ workspace_id: other.id, source: "jira", kind: "mention", external_key: "x", title: "t", ref: "ANA-1" }));
  assert.ok(addInboxItem({ workspace_id: ws.id, source: "clickup", kind: "mention", external_key: "x", title: "t", ref: "ANA-1" }));
});

test("won't do on a Slack row with no ref mutes just that row", () => {
  const ws = mkWs();
  const a = addInboxItem({ workspace_id: ws.id, source: "slack", kind: "dm", external_key: "D1:1", title: "hi" })!;
  const b = addInboxItem({ workspace_id: ws.id, source: "slack", kind: "dm", external_key: "D1:2", title: "hi again" })!;
  const r = fakeRes(); routes.wontdoRoute(fakeReq({ id: a.id }, ADMIN()), r);
  assert.equal(r.body.state, "muted");
  assert.equal(inbox.get(b.id)!.state, "new");
  assert.ok(addInboxItem({ workspace_id: ws.id, source: "slack", kind: "dm", external_key: "D1:3", title: "a third" }));
});

// ───────────────────────────── Done ─────────────────────────────

test("done on a Jira row: hours set first, then the close carries them, then the comment; the row and its siblings are done", async () => {
  const ws = mkWs({ base_url: "https://acme.atlassian.net" });
  emitTrackerInbox(ws.id, "jira", ME, [task()]); // baseline, no mirror ticket
  const a = row(ws.id);
  const sibling = row(ws.id, { kind: "comment" });
  const r = await done(a.id, { hours: 1.5, comment: "  Shipped the fix.  " });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.item.state, "done");
  assert.equal(r.body.target, "done", "no status_map: the default 'done' (Jira matches labels case-insensitively)");
  assert.deepEqual(calls, [["setHours", "ANA-1", 1.5], ["pushStatus", "ANA-1", "done", 1.5], ["addComment", "ANA-1", "Shipped the fix."]]);
  assert.equal(inbox.get(sibling.id)!.state, "done");
  assert.equal(inbox.list({ workspace_id: ws.id }).length, 0);
  assert.equal(emitTrackerInbox(ws.id, "jira", ME, [task({ status: "done", statusRaw: "Done" })]), 0, "his own close echoing back is not news");
  assert.equal(emitTrackerInbox(ws.id, "jira", ME, [task({ status: "in_progress", statusRaw: "Reopened" })]), 1, "a reopen after it is");
});

test("done uses the workspace's status_map, and without hours writes no hours", async () => {
  const ws = mkWs({ status_map: { done: "Closed" } });
  const r = await done(row(ws.id).id);
  assert.equal(r.body.target, "Closed");
  assert.deepEqual(calls, [["pushStatus", "ANA-1", "Closed", undefined]]);
});

test("done on a ClickUp row: done_status wins, hours become a time entry after the close", async () => {
  CONNECTORS[STUB] = stubFor("clickup");
  const ws = mkWs({ done_status: "complete", status_map: { done: "shipped" } });
  const a = row(ws.id, { source: "clickup", ref: "86abc" });
  const r = await done(a.id, { hours: 2 });
  assert.equal(r.body.target, "complete");
  assert.deepEqual(calls, [["pushStatus", "86abc", "complete", 2], ["logTime", "86abc", 2]]);

  // A failed time entry after a good close is a warning, not a failure: the task IS closed, and a
  // retry would log the time twice.
  calls = []; fail = { logTime: "clickup time entry 500" };
  const b = row(ws.id, { source: "clickup", ref: "86def" });
  const r2 = await done(b.id, { hours: 1 });
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.body.item.state, "done");
  assert.match(r2.body.warning, /closed, but the 1h time entry failed: clickup time entry 500/);
});

test("a tracker refusal returns the error and leaves the row as it was", async () => {
  const ws = mkWs();
  const a = row(ws.id);
  fail = { pushStatus: "jira push 400: Hours Spent estimate must be provided" };
  const r = await done(a.id);
  assert.equal(r.statusCode, 502);
  assert.match(r.body.error, /ANA-1: jira push 400: Hours Spent estimate must be provided/);
  assert.equal(inbox.get(a.id)!.state, "new");
  assert.equal(kv.get(`inbox.closed:${ws.id}:jira:ANA-1`), undefined);

  fail = { setHours: "jira: no field named \"Hours Spent\"" };
  calls = [];
  assert.equal((await done(a.id, { hours: 1 })).statusCode, 502);
  assert.deepEqual(calls.map((c) => c[0]), ["setHours"], "nothing moved when the hours could not be written");
  assert.equal(inbox.get(a.id)!.state, "new");
});

test("done on a row from another tracker than the workspace's is refused", async () => {
  const ws = mkWs();
  const a = row(ws.id, { source: "clickup", ref: "86abc" });
  const r = await done(a.id);
  assert.equal(r.statusCode, 502);
  assert.match(r.body.error, /no clickup connector/);
  assert.deepEqual(calls, []);
});

test("done on a Slack row just resolves it; hours or a comment there are a 400", async () => {
  const ws = mkWs();
  const a = addInboxItem({ workspace_id: ws.id, source: "slack", kind: "dm", external_key: "D1:1", title: "hi" })!;
  assert.equal((await done(a.id, { hours: 1 })).statusCode, 400);
  const r = await done(a.id);
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.body.item.state, r.body.target], ["done", null]);
  assert.deepEqual(calls, []);
});

test("state transitions: done twice is a 409; snoozed and dispatched rows can be done; a muted row can still be done", async () => {
  const ws = mkWs();
  const a = row(ws.id);
  assert.equal((await done(a.id)).statusCode, 200);
  assert.equal((await done(a.id)).statusCode, 409);

  const s = row(ws.id, { ref: "ANA-7" });
  inbox.snooze(s.id, "2099-01-01T00:00:00.000Z");
  assert.equal((await done(s.id)).body.item.state, "done");
  const d = row(ws.id, { ref: "ANA-8" });
  inbox.claim(d.id);
  assert.equal((await done(d.id)).body.item.state, "done");
  const m = row(ws.id, { ref: "ANA-9" });
  routes.wontdoRoute(fakeReq({ id: m.id }, ADMIN()), fakeRes());
  assert.equal((await done(m.id)).body.item.state, "done");
  assert.equal((await done(m.id, { hours: -1 })).statusCode, 400);
});

test("done and won't do are the operator's: another workspace gets a 404, the workspace's own token a 403", async () => {
  const ws = mkWs();
  const other = mkWs();
  const a = row(ws.id);
  assert.equal((await done(a.id, {}, TOK(other.id))).statusCode, 404);
  assert.equal((await done(a.id, {}, TOK(ws.id))).statusCode, 403);
  let r = fakeRes(); routes.wontdoRoute(fakeReq({ id: a.id }, TOK(other.id)), r);
  assert.equal(r.statusCode, 404);
  r = fakeRes(); routes.wontdoRoute(fakeReq({ id: a.id }, TOK(ws.id)), r);
  assert.equal(r.statusCode, 403);
  assert.equal(inbox.get(a.id)!.state, "new");
  assert.deepEqual(calls, []);
  assert.equal((await done("nope")).statusCode, 404);
});

test("done closes a mirror ticket as the inbox (not a write-back trigger), and the next sync's echo files nothing", async () => {
  const ws = mkWs();
  pull = [task()];
  await syncWorkspace(ws); // baseline + mirror ticket
  const mirror = tickets.byExternal("jira", "ANA-1")!;
  assert.ok(mirror);
  const events: any[] = [];
  const { bus } = await import("./bus.js");
  const on = (e: any) => events.push(e);
  bus.on("event", on);
  const a = row(ws.id);
  await done(a.id, { hours: 3 });
  bus.off("event", on);
  const t = tickets.get(mirror.id)!;
  assert.equal(t.status, "done");
  assert.equal(t.status_source, "external");
  assert.ok(events.some((e) => e.topic === "ticket.updated" && e.status === "done" && e.actor === INBOX_DONE_ACTOR));
  assert.ok(events.some((e) => e.topic === "inbox.updated" && e.item_id === a.id));
  assert.match(fs.readFileSync(path.join(import.meta.dirname, "writeback.ts"), "utf8"), /e\.actor === "inbox-done"\) return;/);

  pull = [task({ status: "done", statusRaw: "Done" })];
  await syncWorkspace(ws);
  assert.equal(inbox.list({ workspace_id: ws.id }).length, 0, "his own close is not 'your task moved'");
});

// ───────────────────────────── ClickUp time entry ─────────────────────────────

function stubFetch(routes: Record<string, { status?: number; body?: any }>) {
  const seen: { url: string; method: string; headers: any; body: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    seen.push({ url: u, method: init.method ?? "GET", headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const hit = Object.entries(routes).find(([k]) => u.includes(k))?.[1];
    const status = hit?.status ?? 200;
    return { ok: status < 400, status, json: async () => hit?.body ?? {}, text: async () => JSON.stringify(hit?.body ?? {}) } as any;
  }) as any;
  return { seen, restore: () => { globalThis.fetch = real; } };
}

test("clickup.logTime: team from the task (cached per list), one time entry ending now", async () => {
  const f = stubFetch({ "/task/86abc": { body: { id: "86abc", team_id: "9001" } }, "/time_entries": { body: { data: {} } } });
  try {
    const cfg = { token: "pk_1", list_id: "L-" + randomUUID() };
    const before = Date.now();
    await clickup.logTime!(cfg, "86abc", 1.5);
    await clickup.logTime!(cfg, "86abc", 0.25);
    assert.deepEqual(f.seen.map((c) => [c.method, c.url]), [
      ["GET", "https://api.clickup.com/api/v2/task/86abc"],
      ["POST", "https://api.clickup.com/api/v2/team/9001/time_entries"],
      ["POST", "https://api.clickup.com/api/v2/team/9001/time_entries"],
    ]);
    const post = f.seen[1];
    assert.equal(post.headers.Authorization, "pk_1");
    assert.equal(post.headers["content-type"], "application/json");
    assert.deepEqual(Object.keys(post.body).sort(), ["duration", "start", "tid"]);
    assert.equal(post.body.tid, "86abc");
    assert.equal(post.body.duration, 5_400_000);
    assert.ok(post.body.start >= before - 5_400_000 && post.body.start <= Date.now() - 5_400_000);
    assert.equal(f.seen[2].body.duration, 900_000);
  } finally { f.restore(); }
});

test("clickup.logTime: cfg.team_id skips the lookup, time_billable is passed through, a refusal throws", async () => {
  const f = stubFetch({ "/time_entries": { status: 400, body: { err: "bad" } } });
  try {
    await assert.rejects(clickup.logTime!({ token: "pk_1", team_id: "77", time_billable: true }, "86x", 1), /clickup time entry 400/);
    assert.equal(f.seen.length, 1);
    assert.equal(f.seen[0].url, "https://api.clickup.com/api/v2/team/77/time_entries");
    assert.equal(f.seen[0].body.billable, true);
  } finally { f.restore(); }
});

// ───────────────────────────── Desk + CLI ─────────────────────────────

test("the Desk row: ✓ Done (hours prompt for tracker rows), Won't do behind ⋯, ✕ unchanged", () => {
  const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
  assert.match(html, /data-a="done"/);
  assert.match(html, /class="ib-hours" type="number"/);
  assert.match(html, /data-a="more" title="More">⋯</);
  assert.match(html, /data-a="wontdo"/);
  assert.match(html, /data-a="dismiss" title="Dismiss">✕</);
  assert.match(html, /api\("\/inbox\/" \+ id \+ "\/done", \{ method: "POST"/);
  assert.match(html, /api\("\/inbox\/" \+ id \+ "\/wontdo", \{ method: "POST"/);
  assert.match(html, /\$\{esc\(IB\.err\[i\.id\]\)\}/, "errors are escaped and shown on the row");
});

async function mcAgainst(args: string[], reply: (url: string) => unknown) {
  const got: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
  const server = http.createServer((req, res) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      got.push({ method: req.method, url: req.url, headers: req.headers, body: d ? JSON.parse(d) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply(req.url!)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const mc = path.join(import.meta.dirname, "..", "scripts", "mc");
  try {
    const out = await new Promise<string>((resolve, reject) =>
      execFile(process.execPath, [mc, ...args], {
        env: { ...process.env, MC_API: `http://127.0.0.1:${port}/api`, CHRONOS_ADMIN_TOKEN: "adm", MC_SESSION: "", MC_RUN: "", MC_WORKSPACE: "" },
      }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))));
    return { out, got };
  } finally { server.close(); }
}

test("mc inbox done <prefix> --hours N resolves the row and posts the hours as the operator", async () => {
  const id = "abcdef12-0000-0000-0000-000000000000";
  const item = { id, ref: "ANA-1", title: "Fix the loader", state: "done" };
  const { out, got } = await mcAgainst(["inbox", "done", "abcdef12", "--hours", "1.5"], (u) =>
    u.startsWith("/api/inbox?") ? { items: [item, { ...item, id: "99999999-0000" }] } : { item, target: "Done" });
  assert.deepEqual(got.map((g) => [g.method, g.url]), [["GET", "/api/inbox?all=1"], ["POST", `/api/inbox/${id}/done`]]);
  assert.deepEqual(got[1].body, { hours: 1.5 });
  assert.equal(got[1].headers["x-mc-admin"], "adm");
  assert.match(out, /✓ done — ANA-1 → Done \(1\.5h\)/);
});

test("mc inbox wontdo <full id> goes straight to the route", async () => {
  const id = "abcdef12-0000-0000-0000-000000000000";
  const { out, got } = await mcAgainst(["inbox", "wontdo", id], () => ({ id, ref: "ANA-1", title: "Fix the loader", state: "muted" }));
  assert.deepEqual(got.map((g) => [g.method, g.url]), [["POST", `/api/inbox/${id}/wontdo`]]);
  assert.match(out, /muted ANA-1/);
});
