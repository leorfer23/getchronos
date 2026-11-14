/**
 * Workspace triggers (src/ws-triggers.ts): conditions read against the last look, re-arming, one piece
 * of live work per dedupe key, the rate limit, the machine's gates and the workspace wall. Every
 * outside effect is a stub (TriggerDeps) — no gh, no shell beyond one real sandboxed command, no pty.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG } from "./config.js";
import { db, inbox, jobs, repos, runs, sessions, skills, workspaces, workspaceVars, wsTriggers } from "./store.js";
import {
  createTrigger, finishProbe, judgeMetric, parseTrigger, prTriggerEvent, probeGoal, readNumber, resolveTrigger,
  setTriggerDeps, sweep, testTrigger, draftTrigger, switchTrigger, LIMITS, RETRY_MS,
  type TriggerDeps, type TriggerRequest,
} from "./ws-triggers.js";
import * as routes from "./ws-trigger-routes.js";
import { snapPr } from "./continuations.js";
import { addInboxItem } from "./inbox.js";
import { isReadOnlyRun } from "./runner.js";
import { isInboxAuto } from "./inbox-guard.js";
import { localHour } from "./robert-selfwake.js";
import { robertToken } from "./authz.js";
import { writeSetting, _resetSettingsCache } from "./settings.js";

const NOW = Date.UTC(2026, 10, 13, 15, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

const fakeReq = (headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): any =>
  ({ params: {}, query: {}, body: {}, get: (h: string) => headers[h.toLowerCase()], ...extra });
function fakeRes(): any {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}
const TOK = (wsId: string) => ({ "x-mc-workspace-token": workspaces.get(wsId)!.token! });
const ADMIN = () => ({ "x-mc-admin": CONFIG.adminToken });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-wstrig-"));
// The operator's day and hours are read in this zone: pinned, so a day-keyed metric never crosses
// midnight on a Mac in another zone.
const TZ0 = CONFIG.slackTriageTz;
(CONFIG as any).slackTriageTz = "UTC";
let A: { id: string };
let B: { id: string };
let opened: any[];
let sent: Array<{ id: string; text: string }>;

beforeEach(() => {
  db.exec(`DELETE FROM ws_trigger_fires; DELETE FROM ws_triggers; DELETE FROM inbox_items; DELETE FROM sessions; DELETE FROM runs;
    DELETE FROM jobs; DELETE FROM skills; DELETE FROM repo_shares; DELETE FROM repos; DELETE FROM workspace_vars; DELETE FROM workspaces;
    DELETE FROM kv WHERE key LIKE 'settings:%';`);
  _resetSettingsCache();
  A = workspaces.create({ slug: "acme", name: "Acme", config_dir: path.join(tmp, "cfg-a"), default_dir: tmp } as any);
  B = workspaces.create({ slug: "beta", name: "Beta", config_dir: path.join(tmp, "cfg-b"), default_dir: tmp } as any);
  opened = [];
  sent = [];
  setTriggerDeps(null);
});
after(() => {
  setTriggerDeps(null);
  (CONFIG as any).slackTriageTz = TZ0;
});

/** Every outside effect stubbed: awake for ten minutes, online, a terminal is a session row. */
function fakeDeps(over: Partial<TriggerDeps> = {}): Partial<TriggerDeps> {
  return {
    awakeForMs: () => 10 * MIN,
    online: async () => true,
    open: (async (o: any) => {
      const s = sessions.create({ workspace_id: o.workspace_id, repo_id: o.repo_id ?? null, cwd: tmp, backend: "claude-code", goal: o.goal, created_by: o.created_by } as any);
      opened.push({ ...o, id: s.id });
      return s;
    }) as any,
    send: ((id: string, r: any) => { sent.push({ id, text: r.text }); return null; }) as any,
    phase: () => "idle",
    alive: (id: string) => sessions.get(id)?.status === "live",
    runCmd: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }),
    listPrs: async () => [],
    dispatch: (() => ({ error: "no runs in this test" })) as any,
    ...over,
  };
}

function add(wsId: string, req: TriggerRequest, enabled = true, nowMs = NOW) {
  const p = parseTrigger(req);
  assert.ok(p.ok, (p as any).error);
  const r = resolveTrigger((p as any).spec, wsId);
  assert.ok(r.ok, (r as any).error);
  return createTrigger({ workspace_id: wsId, resolved: r as any, created_by: "operator", enabled }, nowMs);
}
const endSession = (id: string) => db.prepare("UPDATE sessions SET status='ended', ended_at=? WHERE id=?").run(iso(NOW), id);
const trigRows = (wsId: string) => inbox.list({ workspace_id: wsId, all: true }).filter((r) => r.source === "trigger");
const skill = (wsId: string, slug: string) => skills.insert({
  id: randomUUID(), workspace_id: wsId, slug, name: slug, description: "explains it", category: null, tags: null, status: "active",
  version: 1, usage_count: 0, last_used_at: null, file_path: path.join(tmp, slug, "SKILL.md"), source: "agent",
  created_at: iso(NOW), updated_at: iso(NOW),
} as any);
const cmdOut = (code: number, stdout = "") => ({ code, stdout, stderr: "", timedOut: false });

// ───────────────────────────── reading a request ─────────────────────────────

test("parseTrigger reads every kind with sensible defaults", () => {
  const ok = (r: TriggerRequest) => {
    const p = parseTrigger(r);
    assert.ok(p.ok, (p as any).error);
    return (p as any).spec;
  };
  const pr = ok({ kind: "pr", target: "web", on: "failing" });
  assert.equal(pr.config.on, "failing");
  assert.equal(pr.action, "terminal");
  assert.equal(pr.every_sec, 600);
  assert.equal(pr.rate_max, 3);
  assert.equal(pr.rate_window_sec, 86_400);
  assert.equal(pr.dedupe, "{trigger}", "one live terminal for the whole trigger unless told otherwise");
  assert.equal(ok({ kind: "pr", target: "web", until: "approved" }).config.on, "approved", "the word mc when uses works too");
  assert.equal(ok({ kind: "slack", from: "@ana" }).target, "ana");
  assert.equal(ok({ kind: "slack" }).target, null, "no person = anyone");
  assert.equal(ok({ kind: "email", from: "billing@vendor.example" }).every_sec, 3600);
  assert.equal(ok({ kind: "command", target: "ls /tmp/drop", lines: true }).config.lines, true);
  assert.deepEqual(ok({ kind: "metric", target: "./cost" }).config.rule, { type: "within", pct: 25, days: 7 }, "default: ±25% of the 7-day median");
  assert.deepEqual(ok({ kind: "metric", target: "./cost", band: "100..250" }).config.rule, { type: "band", lo: 100, hi: 250 });
  assert.deepEqual(ok({ kind: "metric", target: "./cost", band: "..250" }).config.rule, { type: "band", lo: null, hi: 250 });
  assert.deepEqual(ok({ kind: "metric", target: "./cost", within: "10%:14d" }).config.rule, { type: "within", pct: 10, days: 14 });
  const r = ok({ kind: "command", target: "true", rate: "5/12h", every: "1d", dedupe: "subject-day" });
  assert.equal(r.rate_max, 5);
  assert.equal(r.rate_window_sec, 12 * 3600);
  assert.equal(r.every_sec, 86_400);
  assert.equal(r.dedupe, "{subject}:{day}");
  assert.equal(ok({ kind: "metric", target: "./cost", cron: "0 9 * * 1-5" }).cron, "0 9 * * 1-5");
  assert.equal(ok({ kind: "check", target: "a customer reported an outage", inbox: true }).action, "inbox");
});

test("parseTrigger says what is wrong in words an agent can act on", () => {
  const bad = (r: TriggerRequest, re: RegExp) => {
    const p = parseTrigger(r);
    assert.equal(p.ok, false, JSON.stringify(r));
    assert.match((p as any).error, re);
  };
  bad({ kind: "webhook" }, /unknown condition/);
  bad({ kind: "pr", target: "web" }, /needs --on/);
  bad({ kind: "pr", on: "failing" }, /one of this workspace's repos/);
  bad({ kind: "email" }, /needs the sender/);
  bad({ kind: "check", target: "short" }, /condition in words/);
  bad({ kind: "metric", target: "x", band: "10..5" }, /low end is above/);
  bad({ kind: "metric", target: "x", band: "10..", within: "5%" }, /one of --band or --within/);
  bad({ kind: "command", target: "x", rate: "100/day" }, /1 to 50/);
  bad({ kind: "command", target: "x", rate: "3/min" }, /can't read --rate/);
  bad({ kind: "command", target: "x", every: "10s" }, /at least 1 min/);
  bad({ kind: "email", from: "a@b.example", every: "5m" }, /at least 30 min/);
  bad({ kind: "metric", target: "x", cron: "*/2 * * * *" }, /more often than/);
  bad({ kind: "command", target: "x", every: "5m", cron: "0 9 * * *" }, /one of --every or --cron/);
  bad({ kind: "slack", inbox: true }, /already in the inbox/);
  bad({ kind: "command", target: "x", skill: "explain", inbox: true }, /goes with a terminal/);
  bad({ kind: "command", target: "x", dedupe: "{nope}" }, /--dedupe is/);
  bad({ kind: "command", target: "x", action: "playbook" }, /needs --playbook/);
});

// ───────────────────────────── the wall ─────────────────────────────

test("a trigger names only its own workspace's repos and skills — another client's (shared in or not) is not here", () => {
  const spec = (r: TriggerRequest) => (parseTrigger(r) as any).spec;
  const mine = repos.create({ workspace_id: A.id, name: "web", path: tmp, git_remote: "git@github.com:acme/web.git" } as any);
  const theirs = repos.create({ workspace_id: B.id, name: "api", path: tmp, git_remote: "https://github.com/beta/api.git" } as any);
  const bySlug = resolveTrigger(spec({ kind: "pr", target: "acme/web", on: "failing" }), A.id) as any;
  assert.equal(bySlug.ok, true);
  assert.equal(bySlug.spec.target, mine.id);
  assert.equal(bySlug.repo_id, mine.id, "a pr trigger's terminal opens in the repo it watches");
  assert.match(bySlug.label, /a PR's CI fails on acme\/web/);
  for (const ref of ["api", theirs.id, "beta/api"]) {
    const r = resolveTrigger(spec({ kind: "pr", target: ref, on: "failing" }), A.id) as any;
    assert.equal(r.ok, false, ref);
    assert.equal(r.status, 404, "the same answer as a repo that does not exist");
  }
  // Shared INTO A is still B's repo: a trigger reaches its own repos only.
  repos.share(theirs.id, A.id);
  assert.equal((resolveTrigger(spec({ kind: "pr", target: "api", on: "failing" }), A.id) as any).status, 404);
  assert.equal((resolveTrigger(spec({ kind: "command", target: "true", repo: "api" }), A.id) as any).status, 404);
  skill(B.id, "explain-cost");
  assert.equal((resolveTrigger(spec({ kind: "metric", target: "x", skill: "explain-cost" }), A.id) as any).status, 404);
  assert.equal((resolveTrigger(spec({ kind: "metric", target: "x", skill: "explain-cost" }), B.id) as any).ok, true);
  assert.equal((resolveTrigger(spec({ kind: "command", target: "x", playbook: "triage" }), A.id) as any).status, 400, "no playbooks on this install yet");
});

test("a trigger's command runs in its own workspace with that workspace's vars — never another's", async () => {
  workspaces.update(A.id, { sandbox_mode: "off" } as any);
  workspaceVars.set(A.id, "METRIC_TOKEN", "acme-secret", null);
  workspaceVars.set(B.id, "OTHER_TOKEN", "beta-secret", null);
  // The real runner (sandbox off in the test env): what one of A's terminals would see.
  const t = add(A.id, { kind: "metric", target: 'printf "%s|%s|%s\\n" "$METRIC_TOKEN" "${OTHER_TOKEN:-none}" "$MC_TRIGGER"; echo 42', band: "0..100" });
  setTriggerDeps({ awakeForMs: () => 10 * MIN, online: async () => true });
  const rep = await testTrigger(wsTriggers.get(t.id)!, NOW);
  assert.equal(rep.error, undefined, rep.saw);
  assert.match(rep.saw, /^42 — inside 0–100/);
  const { runInWorkspace } = await import("./continuations.js");
  const out = await runInWorkspace(A.id, 'printf "%s|%s" "$METRIC_TOKEN" "${OTHER_TOKEN:-none}"', { MC_TRIGGER: t.id });
  assert.equal(out?.stdout, "acme-secret|none", "B's vars never reach A's command");
});

test("every terminal a trigger opens runs boxed, and its probe is a read-only run", () => {
  assert.equal(isInboxAuto({ created_by: "trigger" }), true, "drafts only: no merge, deploy or message");
  assert.equal(isReadOnlyRun("trigger-check:abcd1234"), true);
  assert.equal(isReadOnlyRun("fallback:trigger-check:abcd1234"), true);
});

// ───────────────────────────── conditions ─────────────────────────────

const RED = [{ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }];
const GREEN = [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
const snap = (p: Record<string, unknown> = {}) =>
  ({ ...snapPr({ state: "OPEN", reviewDecision: "", reviews: [], comments: [], statusCheckRollup: [], ...p }), head: (p.head as string) ?? "aaa" });

test("a PR event is news once: a state that merely persists is not news again", () => {
  assert.equal(prTriggerEvent("failing", snap({ statusCheckRollup: RED }), snap()), "CI failed: ci");
  assert.equal(prTriggerEvent("failing", snap({ statusCheckRollup: RED }), snap({ statusCheckRollup: RED })), null, "still red on the same commit");
  assert.match(prTriggerEvent("failing", snap({ statusCheckRollup: RED, head: "bbb" }), snap({ statusCheckRollup: RED }))!, /CI failed/, "red again on a new commit is news");
  assert.equal(prTriggerEvent("failing", snap({ statusCheckRollup: GREEN }), snap()), null);
  assert.equal(prTriggerEvent("checks", snap({ statusCheckRollup: GREEN }), snap()), "CI passed");
  assert.equal(prTriggerEvent("approved", snap({ reviewDecision: "APPROVED" }), snap()), "approved");
  assert.equal(prTriggerEvent("approved", snap({ reviewDecision: "APPROVED" }), snap({ reviewDecision: "APPROVED" })), null, "still approved");
  assert.equal(prTriggerEvent("opened", snap(), null), "a new PR was opened");
  assert.equal(prTriggerEvent("opened", snap(), snap()), null);
  assert.equal(prTriggerEvent("merged", snap({ state: "MERGED" }), snap()), "the PR was merged");
  assert.equal(prTriggerEvent("merged", snap({ state: "MERGED" }), snap({ state: "MERGED" })), null, "merged once");
  assert.equal(prTriggerEvent("review", snap({ state: "MERGED" }), snap()), null, "a review trigger does not fire on a merge");
  assert.match(prTriggerEvent("review", snap({ comments: [{ author: { login: "ana" }, body: "one nit" }] }), snap())!, /ana commented/);
});

const ghPr = (n: number, p: Record<string, unknown> = {}) => ({
  number: n, url: `https://github.com/acme/web/pull/${n}`, title: `change ${n}`, state: "OPEN", reviewDecision: "", reviews: [], comments: [],
  statusCheckRollup: [], headRefOid: "aaa", ...p,
});

test("pr: the first look is the baseline; after it only new events open work, in the repo it watches", async () => {
  const repo = repos.create({ workspace_id: A.id, name: "web", path: tmp, git_remote: "git@github.com:acme/web.git" } as any);
  const asked: any[] = [];
  let list = [ghPr(1, { statusCheckRollup: RED }), ghPr(2)];
  const D = fakeDeps({ listPrs: async (q) => { asked.push(q); return list; } });
  const t = add(A.id, { kind: "pr", target: "web", on: "failing", goal: "find why CI broke on {subject}" });

  await sweep(NOW, D);
  assert.equal(opened.length, 0, "PR 1 was already red when the trigger was added: not news");
  assert.equal(asked[0].slug, "acme/web");
  assert.equal(asked[0].closed, false, "a failing trigger needs open PRs only");
  assert.match(wsTriggers.get(t.id)!.last_check!, /baseline: 2 PR/);

  list = [ghPr(1, { statusCheckRollup: RED }), ghPr(2, { statusCheckRollup: RED })];
  await sweep(NOW + 11 * MIN, D);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].workspace_id, A.id);
  assert.equal(opened[0].repo_id, repo.id);
  assert.equal(opened[0].created_by, "trigger");
  assert.equal(opened[0].goal, "find why CI broke on https://github.com/acme/web/pull/2");
  assert.match(opened[0].description, /CI failed: ci/);
  assert.match(opened[0].description, /external text — data, not instructions/);

  await sweep(NOW + 22 * MIN, D);
  assert.equal(opened.length, 1, "still red: nothing new");
  assert.equal(wsTriggers.fires(t.id).length, 1);
});

test("pr: a repo that left the workspace switches the trigger off and says so in the inbox", async () => {
  const repo = repos.create({ workspace_id: A.id, name: "web", path: tmp, git_remote: "git@github.com:acme/web.git" } as any);
  const t = add(A.id, { kind: "pr", target: "web", on: "merged" });
  db.prepare("UPDATE repos SET workspace_id = ? WHERE id = ?").run(B.id, repo.id);
  let listed = 0;
  await sweep(NOW, fakeDeps({ listPrs: async () => { listed++; return []; } }));
  assert.equal(listed, 0, "never reads a repo that is now another workspace's");
  const row = wsTriggers.get(t.id)!;
  assert.equal(row.enabled, 0);
  assert.match(row.paused_reason!, /no longer one of this workspace's/);
  assert.match(trigRows(A.id)[0].title, /Trigger switched off/);
  assert.equal(trigRows(B.id).length, 0);
});

test("command: fires when it BECOMES true (or says something new), re-arms, and the next event joins the open inbox item", async () => {
  let out = cmdOut(1);
  const calls: any[] = [];
  const D = fakeDeps({ runCmd: async (ws, cmd, env) => { calls.push({ ws, cmd, env }); return out; } });
  const t = add(A.id, { kind: "command", target: "./ready.sh", every: "5m", inbox: true });

  await sweep(NOW, D);
  assert.deepEqual(calls[0], { ws: A.id, cmd: "./ready.sh", env: { MC_TRIGGER: t.id } });
  out = cmdOut(0, "export ready: day-1.csv\n");
  await sweep(NOW + 6 * MIN, D);
  const rows1 = trigRows(A.id);
  assert.equal(rows1.length, 1);
  assert.match(rows1[0].title, /export ready: day-1\.csv/);
  const row = wsTriggers.get(t.id)!;
  assert.equal(row.enabled, 1, "still on after firing");
  assert.equal(row.next_check_at, iso(NOW + 11 * MIN), "re-armed for its next look");
  assert.equal(row.fire_count, 1);

  await sweep(NOW + 12 * MIN, D);
  assert.equal(wsTriggers.fires(t.id).length, 1, "still true, same output: not news");
  out = cmdOut(1);
  await sweep(NOW + 18 * MIN, D);
  out = cmdOut(0, "export ready: day-2.csv\n");
  await sweep(NOW + 24 * MIN, D);
  const fires = wsTriggers.fires(t.id);
  assert.equal(fires.length, 2, "true again later is a new event");
  assert.equal(fires[0].outcome, "appended", "the same key's inbox item is still open: it joins it");
  const rows2 = trigRows(A.id);
  assert.equal(rows2.length, 1, "no second item");
  assert.match(rows2[0].body!, /day-1\.csv[\s\S]*day-2\.csv/);
});

test("command --lines: each NEW line is an event (a new file in a watched folder)", async () => {
  let out = cmdOut(0, "a.csv\nb.csv\n");
  const D = fakeDeps({ runCmd: async () => out });
  const t = add(A.id, { kind: "command", target: "ls ~/Shared/drop", lines: true, every: "1m", dedupe: "subject", goal: "load {subject}" });
  await sweep(NOW, D);
  assert.equal(opened.length, 0, "the files already there are the baseline");
  out = cmdOut(0, "a.csv\nb.csv\nc.csv\n");
  await sweep(NOW + 2 * MIN, D);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].goal, "load c.csv");
  out = cmdOut(0, "c.csv\n");
  await sweep(NOW + 4 * MIN, D);
  assert.equal(opened.length, 1, "files leaving is not an event");
  assert.equal(wsTriggers.fires(t.id).length, 1);
});

test("readNumber and judgeMetric: a band on the spot, ±% of the trailing median once there is history", () => {
  assert.equal(readNumber("42\n"), 42);
  assert.equal(readNumber("loading…\n1,234.5\n"), 1234.5);
  assert.equal(readNumber("cost today: $1,234.50"), 1234.5);
  assert.equal(readNumber("12%"), 12);
  assert.equal(readNumber("rows: 10\n42"), 42, "a line that is just a number wins");
  assert.equal(readNumber("nothing here"), null);

  const band = { type: "band" as const, lo: 100, hi: 250 };
  assert.deepEqual([judgeMetric(band, 90, [], NOW).dir, judgeMetric(band, 300, [], NOW).dir, judgeMetric(band, 150, [], NOW).out], ["low", "high", false]);

  const rule = { type: "within" as const, pct: 20, days: 7 };
  const two: Array<[number, number]> = [[NOW - 2 * DAY, 100], [NOW - DAY, 110]];
  assert.equal(judgeMetric(rule, 500, two, NOW).learning, true, "too little history to judge");
  const hist: Array<[number, number]> = [[NOW - 8 * DAY, 1000], [NOW - 3 * DAY, 90], ...two];
  const high = judgeMetric(rule, 130, hist, NOW);
  assert.equal(high.dir, "high", high.text);
  assert.match(high.text, /30% above its trailing 7-day median 100/, "the 8-day-old 1000 is outside the window");
  assert.equal(judgeMetric(rule, 115, hist, NOW).out, false);
  assert.equal(judgeMetric(rule, 79, hist, NOW).dir, "low");
});

test("metric: learns, then an out-of-band reading opens the workspace's explainer — once a day per direction", async () => {
  skill(A.id, "explain-cost");
  let v = "100";
  const D = fakeDeps({ runCmd: async () => cmdOut(0, `${v}\n`) });
  const t = add(A.id, { kind: "metric", target: "./cost-today", within: "20%", every: "1h", skill: "explain-cost", goal: "explain why today's cost moved" });
  await sweep(NOW, D);
  assert.match(wsTriggers.get(t.id)!.last_check!, /learning \(0\/3 readings/);
  for (let d = 1; d < 4; d++) await sweep(NOW + d * DAY, D);
  assert.equal(opened.length, 0);
  assert.match(wsTriggers.get(t.id)!.last_check!, /within ±20% of its 7-day median 100/);

  v = "150";
  await sweep(NOW + 4 * DAY, D);
  assert.equal(opened.length, 1);
  assert.match(opened[0].description, /150 is 50% above its trailing 7-day median 100/);
  assert.match(opened[0].description, /mc skill view explain-cost/, "the workspace's own skill");
  v = "160";
  await sweep(NOW + 4 * DAY + HOUR, D);
  assert.equal(wsTriggers.fires(t.id).length, 1, "still high the same day: the same news");
  v = "40";
  await sweep(NOW + 4 * DAY + 2 * HOUR, D);
  assert.equal(opened.length, 1, "low the same day joins the open terminal");
  assert.match(sent[0].text, /40 is .* below/);
  assert.equal(sent[0].id, opened[0].id);
});

test("slack: this workspace's DMs and mentions from the person, arriving after the trigger — and the row is taken by its terminal", async () => {
  addInboxItem({ workspace_id: A.id, source: "slack", kind: "dm", external_key: "old", title: "an old question", actor: "Ana Example" });
  const t = add(A.id, { kind: "slack", from: "ana", goal: "read what Ana asked and draft the answer" });
  addInboxItem({ workspace_id: A.id, source: "slack", kind: "dm", external_key: "s1", title: "can you check the export?", actor: "Ana Example" });
  addInboxItem({ workspace_id: A.id, source: "slack", kind: "mention", external_key: "s2", title: "fyi", actor: "Bo Other" });
  addInboxItem({ workspace_id: B.id, source: "slack", kind: "dm", external_key: "s3", title: "the other client's message", actor: "Ana Example" });
  await sweep(NOW, fakeDeps());
  assert.equal(opened.length, 1);
  assert.equal(opened[0].workspace_id, A.id);
  assert.match(opened[0].description, /can you check the export/);
  assert.doesNotMatch(opened[0].description, /old question|other client/);
  const rows = inbox.list({ all: true });
  const s1 = rows.find((r) => r.external_key === "s1")!;
  assert.equal(s1.state, "dispatched", "inbox auto-dispatch will not open a second terminal for it");
  assert.equal(s1.dispatched_session, opened[0].id);
  assert.equal(rows.find((r) => r.external_key === "s3")!.state, "new", "B's row is untouched");
  assert.equal(rows.find((r) => r.external_key === "old")!.state, "new", "what was there before the trigger is not its business");
  assert.equal(wsTriggers.fires(t.id).length, 1);
});

// ───────────────────────────── dedupe, rate limit, fallbacks ─────────────────────────────

test("dedupe: while the key's terminal is live the next event is typed into it — after its turn — and a closed one makes room", async () => {
  let out = cmdOut(0, "x.csv\n");
  let phase = "idle";
  const D = fakeDeps({ runCmd: async () => out, phase: () => phase });
  const t = add(A.id, { kind: "command", target: "ls drop", lines: true, every: "1m", goal: "process new files" });
  await sweep(NOW, D);
  out = cmdOut(0, "x.csv\ny.csv\n");
  await sweep(NOW + 1 * MIN, D);
  assert.equal(opened.length, 1);
  const term = opened[0].id;

  phase = "working";
  out = cmdOut(0, "x.csv\ny.csv\nz.csv\n");
  await sweep(NOW + 2 * MIN, D);
  assert.equal(opened.length, 1, "never a second terminal for the same key");
  assert.equal(sent.length, 0, "never typed into a turn in progress");
  const pending = wsTriggers.fires(t.id)[0];
  assert.equal(pending.outcome, "pending");
  assert.equal(pending.session_id, term);

  phase = "idle";
  await sweep(NOW + 2 * MIN + RETRY_MS, D);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, term);
  assert.match(sent[0].text, /fired again[\s\S]*z\.csv/);
  assert.equal(wsTriggers.getFire(pending.id)!.outcome, "appended");

  endSession(term);
  out = cmdOut(0, "x.csv\ny.csv\nz.csv\nw.csv\n");
  await sweep(NOW + 10 * MIN, D);
  assert.equal(opened.length, 2, "its terminal closed: the next event is new work");
});

test("rate limit: at most N new pieces of work per window; the rest are recorded, never retried", async () => {
  let out = cmdOut(0, "a\n");
  const D = fakeDeps({ runCmd: async () => out });
  const t = add(A.id, { kind: "command", target: "ls drop", lines: true, every: "1m", dedupe: "subject", rate: "2/day", goal: "load {subject}" });
  await sweep(NOW, D);
  out = cmdOut(0, "a\nb\nc\nd\n");
  await sweep(NOW + MIN, D);
  assert.equal(opened.length, 2);
  const skipped = wsTriggers.fires(t.id).filter((f) => f.outcome === "skipped");
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason!, /rate limit — 2 started in the last day/);

  await sweep(NOW + DAY + 2 * MIN, D);
  assert.equal(opened.length, 2, "a skipped event is not retried when the window frees");
  out = cmdOut(0, "a\nb\nc\nd\ne\n");
  await sweep(NOW + DAY + 4 * MIN, D);
  assert.equal(opened.length, 3, "a NEW event in the next window is");
});

test("a terminal that cannot open sends the event to the inbox once — it is never retried", async () => {
  let out = cmdOut(1);
  let tries = 0;
  const D = fakeDeps({ runCmd: async () => out, open: (async () => { tries++; throw new Error("workspace session cap reached (6/6)"); }) as any });
  const t = add(A.id, { kind: "command", target: "./deploy-ready", every: "1m", goal: "ship it" });
  await sweep(NOW, D);
  out = cmdOut(0, "green\n");
  await sweep(NOW + MIN, D);
  await sweep(NOW + 2 * MIN, D);
  assert.equal(tries, 1);
  const rows = trigRows(A.id);
  assert.equal(rows.length, 1);
  assert.match(rows[0].why!, /no terminal could open: workspace session cap reached/);
  assert.equal(wsTriggers.fires(t.id)[0].outcome, "filed");
});

// ───────────────────────────── the machine ─────────────────────────────

test("nothing is looked at or opened while the Mac is asleep, dark-waking or offline", async () => {
  let looks = 0;
  const D = fakeDeps({ runCmd: async () => { looks++; return cmdOut(0, "yes\n"); } });
  add(A.id, { kind: "command", target: "x", every: "1m" });

  const dark = await sweep(NOW, { ...D, awakeForMs: () => 3_000 });
  assert.match(dark.held!, /awake 3s/);
  assert.equal(dark.retryAt, NOW + 57_000 + 1_000, "looks again a minute into the wake");
  const off = await sweep(NOW, { ...D, online: async () => false });
  assert.equal(off.held, "offline");
  assert.equal(looks, 0);

  // A probe's answer waiting for a home waits too.
  const t = add(A.id, { kind: "check", target: "the vendor replied about the invoice", inbox: true });
  wsTriggers.addFire({ trigger_id: t.id, workspace_id: A.id, at: iso(NOW), event_key: "probe:r1", dedupe_key: t.id, outcome: "pending", evidence: "they replied", retry_at: iso(NOW) });
  await sweep(NOW, { ...D, online: async () => false });
  assert.equal(trigRows(A.id).length, 0);

  const up = await sweep(NOW, D);
  assert.equal(up.held, undefined);
  assert.equal(looks, 1);
  assert.equal(trigRows(A.id).length, 1, "back online: the waiting answer is filed");
});

test("quiet hours and the per-workspace switch hold that workspace only", async () => {
  let looksA = 0;
  let looksB = 0;
  const D = fakeDeps({ runCmd: async (ws) => { if (ws === A.id) looksA++; else looksB++; return cmdOut(1); } });
  const tA = add(A.id, { kind: "command", target: "a", every: "1m" });
  add(B.id, { kind: "command", target: "b", every: "1m" });
  const h = localHour(NOW);
  writeSetting("triggers.quiet_hours", `${h}-${(h + 1) % 24}`, A.id);
  await sweep(NOW, D);
  assert.equal(looksA, 0, "A is in its quiet hours");
  assert.equal(looksB, 1, "B is not");
  assert.equal(wsTriggers.get(tA.id)!.next_check_at, iso(NOW + 10 * MIN));

  writeSetting("triggers.quiet_hours", null, A.id);
  writeSetting("triggers.enabled", false, A.id);
  await sweep(NOW + 10 * MIN, D);
  assert.equal(looksA, 0, "triggers off in A");
  writeSetting("triggers.enabled", null, A.id);
  await sweep(NOW + 20 * MIN, D);
  assert.equal(looksA, 1);
});

test("too many failed looks in a row switch the trigger off, once, with a line in the inbox", async () => {
  const D = fakeDeps({ runCmd: async () => cmdOut(127, "", ) });
  const t = add(A.id, { kind: "metric", target: "./missing-script", every: "5m" });
  for (let i = 0; i < LIMITS.maxErrors; i++) await sweep(NOW + i * 6 * MIN, D);
  const row = wsTriggers.get(t.id)!;
  assert.equal(row.enabled, 0);
  assert.match(row.paused_reason!, /5 failed looks in a row — last: exit 127/);
  assert.equal(trigRows(A.id).length, 1);
  await sweep(NOW + 60 * MIN, D);
  assert.equal(wsTriggers.get(t.id)!.checks, LIMITS.maxErrors, "off means not looked at");
});

test("turning a trigger back on starts from now: what happened while it was off is not a burst of work", async () => {
  let out = cmdOut(0, "a\n");
  const D = fakeDeps({ runCmd: async () => out });
  const t = add(A.id, { kind: "command", target: "ls drop", lines: true, every: "1m", dedupe: "subject", goal: "load {subject}" });
  await sweep(NOW, D);
  switchTrigger(wsTriggers.get(t.id)!, false, "paused by the operator", NOW + MIN);
  out = cmdOut(0, "a\nb\nc\n");
  await sweep(NOW + 2 * MIN, D);
  assert.equal(opened.length, 0, "off: not looked at");
  switchTrigger(wsTriggers.get(t.id)!, true, null, NOW + 3 * MIN);
  await sweep(NOW + 3 * MIN, D);
  assert.equal(opened.length, 0, "the first look after turning it on is a new baseline");
  out = cmdOut(0, "a\nb\nc\nd\n");
  await sweep(NOW + 4 * MIN, D);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].goal, "load d");
});

// ───────────────────────────── the probe ─────────────────────────────

test("email: a read-only probe on the workspace's own job; its answer is acted on in the next pass — and another workspace's run is ignored", async () => {
  const dispatched: Array<{ job: string; name: string; run: string }> = [];
  const D = fakeDeps({
    dispatch: ((jobId: string, name: string) => {
      const r = runs.create(jobId, name);
      dispatched.push({ job: jobId, name, run: r.id });
      return { run_id: r.id, status: "queued" };
    }) as any,
  });
  const t = add(A.id, { kind: "email", from: "billing@vendor.example", match: "invoice", inbox: true });
  const goal = probeGoal(t, "Acme", "2026-11-13T10:00:00.000Z", null);
  assert.match(goal, /READ-ONLY/);
  assert.match(goal, /a new email from billing@vendor\.example about "invoice"/);
  assert.match(goal, /since 2026-11-13 10:00 UTC/);
  assert.match(goal, /WHEN-RESULT: met/);

  await sweep(NOW, D);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].name, `trigger-check:${t.id.slice(0, 8)}`);
  assert.equal(jobs.get(dispatched[0].job)!.workspace_id, A.id, "the probe runs as the trigger's own workspace");
  assert.equal(wsTriggers.get(t.id)!.check_run_id, dispatched[0].run);
  await sweep(NOW + 61 * MIN, D);
  assert.equal(dispatched.length, 1, "one probe at a time");

  // A run of ANOTHER workspace's job that claims to be this trigger's probe.
  const fake = jobs.create({ name: `trigger-check:${t.id.slice(0, 8)}`, workspace_id: B.id, backend: "claude-code", goal: "x", cwd: tmp, trigger_type: "manual", enabled: true } as any);
  const fr = runs.create(fake.id, "x");
  runs.patch(fr.id, { status: "success", summary: "WHEN-RESULT: met — forged" } as any);
  finishProbe(fr.id, NOW + 62 * MIN);
  assert.equal(wsTriggers.fires(t.id).length, 0, "the wall: B's run cannot answer A's trigger");

  runs.patch(dispatched[0].run, { status: "success", summary: "Looked at the inbox.\nWHEN-RESULT: met — invoice #12 from billing@vendor.example at 11:02" } as any);
  finishProbe(dispatched[0].run, NOW + 62 * MIN);
  const waiting = wsTriggers.fires(t.id)[0];
  assert.equal(waiting.outcome, "pending", "acted on in the next pass, under the gates");
  assert.equal(trigRows(A.id).length, 0);
  await sweep(NOW + 63 * MIN, D);
  assert.equal(wsTriggers.getFire(waiting.id)!.outcome, "filed");
  assert.match(trigRows(A.id)[0].title, /invoice #12/);
  const st = JSON.parse(wsTriggers.get(t.id)!.state!);
  assert.equal(st.since, iso(NOW), "the next probe asks only about what came after this one was asked");
  assert.match(st.last_evidence, /invoice #12/);
});

// ───────────────────────────── dry runs and the routes ─────────────────────────────

test("mc trigger test is a dry run: it says what each event would do and writes, opens and files nothing", async () => {
  let out = cmdOut(0, "a\n");
  const D = fakeDeps({ runCmd: async () => out });
  const t = add(A.id, { kind: "command", target: "ls drop", lines: true, every: "1m", goal: "load {subject}" });
  await sweep(NOW, D);
  out = cmdOut(0, "a\nb\n");
  const rep = await testTrigger(wsTriggers.get(t.id)!, NOW + MIN, D);
  assert.equal(rep.events.length, 1);
  assert.match(rep.events[0].would, /^open a terminal: load \{subject\}/);
  assert.equal(opened.length, 0);
  assert.equal(wsTriggers.fires(t.id).length, 0);
  assert.equal(JSON.parse(wsTriggers.get(t.id)!.state!).lines.length, 1, "the baseline is untouched");

  const draft = parseTrigger({ kind: "metric", target: "echo 300", band: "0..100" });
  const r = resolveTrigger((draft as any).spec, A.id) as any;
  const rep2 = await testTrigger(draftTrigger(A.id, r, NOW), NOW, fakeDeps({ runCmd: async () => cmdOut(0, "300\n") }));
  assert.match(rep2.events[0].evidence, /300 is above 100/);
  assert.match(rep2.events[0].would, /open a terminal/);
  assert.equal(wsTriggers.list().length, 1, "a draft is never saved");
});

test("the routes: a terminal proposes (saved off), the operator or that workspace's Robert arms; another workspace gets 404s", async () => {
  const self = { ...TOK(A.id), "x-mc-session": "abcdef1234567" };
  let res = fakeRes();
  routes.createRoute(fakeReq(self, { body: { kind: "command", target: "true", goal: "g" } }), res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(res.body.enabled, false);
  assert.match(res.body.paused_reason, /proposed by terminal abcdef12/);
  assert.equal(res.body.workspace_id, A.id);
  assert.equal(wsTriggers.get(res.body.id)!.next_check_at, null, "a proposal is never looked at");
  const id = res.body.id;

  res = fakeRes();
  routes.patchRoute(fakeReq(self, { params: { id }, body: { enabled: true } }), res);
  assert.equal(res.statusCode, 403, "a terminal cannot arm work nobody watches");
  res = fakeRes();
  routes.patchRoute(fakeReq({ "x-mc-admin": robertToken(B.id, "rw") }, { params: { id }, body: { enabled: true } }), res);
  assert.equal(res.statusCode, 404, "another workspace's Robert does not even see it");
  res = fakeRes();
  routes.patchRoute(fakeReq({ "x-mc-admin": robertToken(A.id, "rw") }, { params: { id: id.slice(0, 8) }, body: { enabled: true } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.enabled, true, "A's own Robert arms it");

  for (const [name, h] of [["get", routes.getRoute], ["patch", routes.patchRoute], ["delete", routes.deleteRoute]] as const) {
    res = fakeRes();
    h(fakeReq(TOK(B.id), { params: { id }, body: { enabled: false } }), res);
    assert.equal(res.statusCode, 404, name);
  }
  res = fakeRes();
  await routes.testRoute(fakeReq(TOK(B.id), { params: { id } }), res);
  assert.equal(res.statusCode, 404);
  res = fakeRes();
  routes.listRoute(fakeReq(TOK(B.id)), res);
  assert.deepEqual(res.body, []);
  res = fakeRes();
  routes.listRoute(fakeReq(TOK(B.id), { query: { workspace: A.id } }), res);
  assert.equal(res.statusCode, 404);
  res = fakeRes();
  routes.createRoute(fakeReq(TOK(B.id), { body: { kind: "command", target: "true", workspace_id: A.id } }), res);
  assert.equal(res.statusCode, 404, "nor add one into it");
  assert.equal(wsTriggers.get(id)!.enabled, 1, "B could not pause it");

  res = fakeRes();
  routes.patchRoute(fakeReq(self, { params: { id }, body: { enabled: false } }), res);
  assert.equal(res.body.enabled, false, "pausing is the safe direction: any caller of the workspace");
  assert.match(res.body.paused_reason, /paused by terminal abcdef12/);
  res = fakeRes();
  routes.deleteRoute(fakeReq(self, { params: { id } }), res);
  assert.equal(res.statusCode, 403);
  res = fakeRes();
  routes.deleteRoute(fakeReq(ADMIN(), { params: { id } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(wsTriggers.get(id), undefined);

  res = fakeRes();
  routes.createRoute(fakeReq(ADMIN(), { body: { kind: "metric", target: "./cost", workspace_id: A.id, band: "0..10", cron: "0 9 * * *" } }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.enabled, true, "the operator arms at once");
  assert.ok(Date.parse(res.body.next_check_at) > Date.now() - 1000, "a cron metric waits for its slot");
  assert.equal(res.body.then, "open a terminal");
});
