/**
 * The limit post-mortem (src/limit-postmortem.ts + src/limit-postmortem-run.ts), on fixture transcripts:
 * the reading (one message on several lines counts once, subagents go to their parent, the synthetic
 * wall messages), who spent it, the lever arithmetic, one report per wall across ticks and restarts, the
 * terminal only after the reset and only once — and the wall: a report built from one account's
 * transcripts lands only in workspaces pinned to that account.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, jobs, notes, runs, sessions, workspaces } from "./store.js";
import { writeSetting } from "./settings.js";
import { listRates } from "./pricing.js";
import { _resetUsage, noteClaudeStatusline, onClaudeWall, type ClaudeWallReading } from "./usage-meter.js";
import {
  analyze, categorize, coldRebuilds, creatorOf, isWallLine, jobFamily, renderPostmortem, replay5m, reqCost, scanProfile,
  setReportTimezone, telegramText, terminalBrief, usageOf, type Req, type RunRow, type SessionRow,
} from "./limit-postmortem.js";
import {
  _forgetPostmortemCache, _resetPostmortemState, deliverNotes, listRequest, NOTE_SLUG, noteWall, onDemandRequest, pickWorkspace, POSTMORTEM_BY,
  postmortemTick, resolveProfileDir, runPostmortem, setPostmortemNotifier, stillWalled, wallRecords, wallsFromRuns, windowOfLimit, workspacesOnProfile,
} from "./limit-postmortem-run.js";
import type { Workspace } from "./types.js";

setReportTimezone("UTC");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "limit-pm-"));
const RESET = Date.parse("2026-11-17T17:00:00.000Z");
const START = RESET - 5 * 3600_000;
const min = (m: number) => new Date(START + m * 60_000).toISOString();
const sent: string[] = [];
setPostmortemNotifier((h) => sent.push(h));

// ── fixtures ──

/** A profile directory with a unique basename (the meter names profiles by basename). */
function mkProfile(name: string): string {
  const d = path.join(tmp, randomUUID().slice(0, 6), `.claude-${name}-${randomUUID().slice(0, 4)}`);
  fs.mkdirSync(path.join(d, "projects", "-Users-operator-code"), { recursive: true });
  return d;
}
const mkWs = (name: string, configDir: string, extra: Record<string, unknown> = {}): Workspace =>
  workspaces.create({ slug: `${name}-${randomUUID().slice(0, 6)}`, name, config_dir: configDir, default_dir: path.join(tmp, name), ...extra } as any);

interface Line { m: number; id?: string; req?: string; model?: string; in?: number; out?: number; cr?: number; w5?: number; w1?: number; repeat?: number }
const usage = (l: Line) => ({
  input_tokens: l.in ?? 0, output_tokens: l.out ?? 0, cache_read_input_tokens: l.cr ?? 0,
  cache_creation_input_tokens: (l.w5 ?? 0) + (l.w1 ?? 0), cache_creation: { ephemeral_5m_input_tokens: l.w5 ?? 0, ephemeral_1h_input_tokens: l.w1 ?? 0 },
});
function assistantLines(l: Line, entry: string, cwd: string): object[] {
  const id = l.id ?? `msg_${randomUUID().slice(0, 8)}`;
  const req = l.req ?? `req_${randomUUID().slice(0, 8)}`;
  // A message with thinking + text + a tool call: the CLI writes one line per block, each with the same usage.
  return Array.from({ length: l.repeat ?? 1 }, (_, k) => ({
    parentUuid: null, isSidechain: false, type: "assistant", uuid: randomUUID(), timestamp: min(l.m),
    message: { id, model: l.model ?? "claude-opus-5-5", role: "assistant", type: "message", usage: usage(l), content: [{ type: "text", text: `block ${k}` }] },
    requestId: req, entrypoint: entry, cwd,
  }));
}
const wallLine = (m: number, entry: string, cwd: string) => ({
  type: "assistant", timestamp: min(m), requestId: `req_${randomUUID().slice(0, 8)}`, entrypoint: entry, cwd,
  error: "rate_limit", isApiErrorMessage: true, apiError: "usage_limit_reached",
  quotaLimits: { status: "rejected", rateLimitType: "five_hour", resetsAt: RESET / 1000 },
  message: { id: randomUUID(), model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "You've hit your 5-hour limit · resets 5pm (UTC)" }] },
});
const authLine = (m: number, entry: string) => ({
  type: "assistant", timestamp: min(m), entrypoint: entry, isApiErrorMessage: true,
  message: { id: randomUUID(), model: "<synthetic>", content: [{ type: "text", text: "Login reached its time limit · Please run /login" }] },
});
const userLine = (text: string, entry: string, cwd: string) => ({ type: "user", timestamp: min(0), entrypoint: entry, cwd, message: { role: "user", content: text } });

function writeTranscript(dir: string, sid: string, opts: { entry?: string; cwd?: string; prompt?: string; lines: Line[]; walls?: number[]; extra?: object[]; sub?: string }): string {
  const entry = opts.entry ?? "cli", cwd = opts.cwd ?? "/Users/operator/code";
  const rows: object[] = [];
  if (opts.prompt != null) rows.push(userLine(opts.prompt, entry, cwd));
  for (const l of opts.lines) rows.push(...assistantLines(l, entry, cwd));
  for (const w of opts.walls ?? []) rows.push(wallLine(w, entry, cwd));
  rows.push(...(opts.extra ?? []));
  const proj = path.join(dir, "projects", "-Users-operator-code");
  const f = opts.sub ? path.join(proj, sid, "subagents", `agent-${opts.sub}.jsonl`) : path.join(proj, `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return f;
}

function mkTerminal(ws: Workspace, o: { by?: string; role?: string; lead_id?: string; goal?: string; kind?: string; createdM?: number; endedM?: number | null }) {
  const s = sessions.create({ workspace_id: ws.id, cwd: tmp, goal: o.goal ?? "work", goal_kind: o.kind ?? null, created_by: o.by ?? "operator", role: o.role ?? "human", lead_id: o.lead_id ?? null } as any);
  db.prepare("UPDATE sessions SET created_at=?, ended_at=?, status=? WHERE id=?").run(min(o.createdM ?? 0), o.endedM == null ? null : min(o.endedM), o.endedM == null ? "live" : "ended", s.id);
  return sessions.get(s.id)!;
}
function mkRun(ws: Workspace, name: string, trigger: "cron" | "manual", sid: string, extra: Record<string, unknown> = {}) {
  const j = jobs.create({ name, goal: "g", cwd: tmp, workspace_id: ws.id, trigger_type: trigger, ...(trigger === "cron" ? { cron_expr: "0 * * * *" } : {}) } as any);
  const r = runs.create(j.id, trigger);
  runs.patch(r.id, { session_id: sid, status: "success", started_at: min(1), ...extra } as any);
  return r;
}

const req = (at: number, model: string, u: Partial<Req>): Req => {
  const full = { input: 0, output: 0, cacheRead: 0, cw5: 0, cw1: 0, ...u };
  return { ...full, at, model, sub: false, cost: reqCost(model, full) };
};
const row = (id: string, o: Partial<SessionRow> = {}): SessionRow =>
  ({ id, workspace_id: null, created_by: "operator", role: "human", lead_id: null, model: null, goal: null, goal_kind: null, created_at: min(0), ended_at: null, ...o });

beforeEach(() => {
  _resetPostmortemState();
  _resetUsage();
  sent.length = 0;
});

// ───────────────────────────── reading transcripts ─────────────────────────────

test("one message written on three lines counts once; a copy in another file (a resume) counts once too", async () => {
  const dir = mkProfile("acme");
  const sid = randomUUID();
  writeTranscript(dir, sid, { lines: [{ m: 10, id: "msg_a", req: "req_a", in: 1000, out: 1000, repeat: 3 }, { m: 20, in: 1000, out: 0 }] });
  writeTranscript(dir, randomUUID(), { lines: [{ m: 10, id: "msg_a", req: "req_a", in: 1000, out: 1000 }] });
  const s = await scanProfile(dir, { since: START, until: RESET });
  const reqs = s.flatMap((x) => x.reqs);
  assert.equal(reqs.length, 2, "msg_a once, plus the second message");
  const opus = listRates("claude-opus-5-5");
  const total = reqs.reduce((t, r) => t + r.cost, 0);
  assert.ok(Math.abs(total - (2000 * opus.in + 1000 * opus.out) / 1e6) < 1e-9);
});

test("a subagent's transcript is credited to its parent session, flagged as a subagent request", async () => {
  const dir = mkProfile("acme");
  const sid = randomUUID();
  writeTranscript(dir, sid, { prompt: "Goal: ship it", lines: [{ m: 5, in: 100, out: 100 }] });
  writeTranscript(dir, sid, { sub: "a1", prompt: "Search the repo for X", lines: [{ m: 6, model: "claude-haiku-5-5", in: 5000, out: 100 }] });
  const s = await scanProfile(dir, { since: START, until: RESET });
  assert.equal(s.length, 1);
  assert.equal(s[0].id, sid);
  assert.equal(s[0].head, "Goal: ship it", "the subagent's task never names the session");
  assert.deepEqual(s[0].reqs.map((r) => r.sub), [false, true]);
});

test("wall messages: the limit ones count, an expired login does not; usage without a TTL split is a 5-minute write", async () => {
  const dir = mkProfile("acme");
  writeTranscript(dir, randomUUID(), { entry: "sdk-py", lines: [{ m: 1, in: 10 }], walls: [200, 210, 220], extra: [authLine(230, "sdk-py")] });
  const s = await scanProfile(dir, { since: START, until: RESET });
  assert.deepEqual(s[0].walls.length, 3);
  assert.equal(isWallLine({ type: "assistant", message: { model: "<synthetic>", content: [{ text: "You've hit your individual spend limit · run /usage-credits" }] } }), true);
  assert.equal(isWallLine({ type: "assistant", message: { model: "<synthetic>", content: [{ text: "Failed to authenticate: this login reached its time limit" }] } }), false);
  assert.deepEqual(usageOf({ input_tokens: 1, cache_creation_input_tokens: 500 }), { input: 1, output: 0, cacheRead: 0, cw5: 500, cw1: 0 });
});

// ───────────────────────────── who spent it ─────────────────────────────

test("categorize: Desk creators, Leads and their workers, Robert's turns, job families, verify, SDK apps, the rest by cwd", () => {
  const o = { slugs: ["acme"], home: "/Users/operator" };
  const s = { entry: "cli", cwd: "/Users/operator/code", head: null };
  assert.equal(categorize(s, row("a"), undefined, o).label, "Desk · operator");
  assert.equal(categorize(s, row("a", { created_by: "inbox" }), undefined, o).label, "Desk · inbox");
  assert.equal(categorize(s, row("a", { created_by: "robert" }), undefined, o).label, "Desk · robert");
  assert.equal(categorize(s, row("a", { role: "lead" }), undefined, o).group, "lead");
  assert.equal(categorize(s, row("a", { created_by: "lead:1a2b3c4d", lead_id: "x" }), undefined, o).group, "lead-worker");
  const hl = { entry: "sdk-cli", cwd: "/Users/operator/code", head: null };
  const run = (job_name: string, trigger_type = "manual"): RunRow => ({ session_id: "a", job_name, trigger_type, workspace_id: null });
  assert.deepEqual(categorize(hl, undefined, run("dream:acme"), o), { key: "job:dream", label: "Job · dream", group: "job", background: true });
  assert.equal(categorize(hl, undefined, run("reap-stale-worktrees-acme", "cron"), o).label, "Job · reap-stale-worktrees (cron)");
  assert.equal(categorize(hl, undefined, run("ticket:ACME-12"), o).background, false);
  assert.equal(categorize(hl, undefined, run("review:verify-1a2b3c4d"), o).label, "Verify/review · review:verify");
  assert.equal(categorize({ ...hl, head: "HOSTS: local (brain) cpu 20%…" }, undefined, undefined, o).label, "Robert turns");
  assert.equal(categorize({ ...hl, head: "FLEET NOW (3 open · 1 need the operator…" }, undefined, undefined, o).label, "Robert turns");
  assert.equal(categorize({ ...hl, head: "You are Robert, chief of staff, recording ONE finished…" }, undefined, undefined, o).group, "robert-helper");
  assert.equal(categorize({ entry: "sdk-py", cwd: "/Users/operator/bots/evalbot", head: "q" }, undefined, undefined, o).label, "SDK app outside Chronos · ~/bots/evalbot");
  assert.equal(categorize({ entry: "cli", cwd: "/Users/operator", head: "hi" }, undefined, undefined, o).label, "Interactive, outside the Desk · ~");
  assert.equal(categorize({ ...hl, head: "Title this" }, undefined, undefined, o).group, "headless");
  assert.equal(creatorOf("failover"), "stand-in");
  assert.equal(jobFamily("fallback:inbox-cleanup:acme"), "inbox-cleanup");
  assert.equal(jobFamily("review:ACME-80"), "review");
});

test("analyze: shares by source, the Desk creator × model × kind split, the top sessions with subagents inside, the refused calls by source", () => {
  const ids = { op: "aaaaaaaa-1", inbox: "bbbbbbbb-2", job: "cccccccc-3", sdk: "dddddddd-4" };
  const sessionsIn = [
    { id: ids.op, entry: "cli", cwd: "/w", head: null, walls: [], reqs: [req(START + 60_000, "claude-opus-5-5", { input: 1e6 }), { ...req(START + 120_000, "claude-haiku-5-5", { input: 1e6 }), sub: true }] },
    { id: ids.inbox, entry: "cli", cwd: "/w", head: null, walls: [], reqs: [req(START + 180_000, "claude-sonnet-5-5", { input: 1e6 })] },
    { id: ids.job, entry: "sdk-cli", cwd: "/w", head: "x", walls: [], reqs: [req(START + 240_000, "claude-opus-5-5", { input: 5e5 })] },
    { id: ids.sdk, entry: "sdk-py", cwd: "/Users/operator/evalbot", head: "q", walls: [START + 3 * 3600_000, START + 3 * 3600_000 + 1000], reqs: [req(START + 300_000, "claude-opus-5-5", { input: 1e6 })] },
  ];
  const p = analyze({
    profile: ".claude-acme", window: "5h", start: START, wallAt: null, resetsAt: RESET, until: RESET, sessions: sessionsIn,
    rows: new Map([[ids.op, row(ids.op, { goal: "Fix the flaky test", goal_kind: "pr" })], [ids.inbox, row(ids.inbox, { created_by: "inbox", goal_kind: "investigation" })]]),
    runs: new Map([[ids.job, { session_id: ids.job, job_name: "monitor:acme", trigger_type: "cron", workspace_id: null }]]),
    home: "/Users/operator",
  });
  // $4 opus + $0.10 haiku subagent | $2 sonnet | $2 opus job | $4 opus sdk = $12.10
  assert.ok(Math.abs(p.total - 12.1) < 1e-9, String(p.total));
  assert.equal(p.wallAt, new Date(START + 3 * 3600_000).toISOString(), "the first refused call is the wall");
  assert.equal(p.walled, true);
  assert.deepEqual(p.categories.map((c) => c.label), ["Desk · operator", "SDK app outside Chronos · ~/evalbot", "Desk · inbox", "Job · monitor (cron)"]);
  assert.ok(Math.abs(p.subUsd - 0.1) < 1e-9);
  assert.deepEqual(p.desk.map((d) => `${d.creator}/${d.model}/${d.kind}`), ["operator/opus/pr", "inbox/sonnet/investigation"]);
  assert.equal(p.top[0].id8, "aaaaaaaa");
  assert.equal(p.top[0].goal, "Fix the flaky test");
  assert.equal(p.afterWall.refused, 2);
  assert.deepEqual(p.afterWall.bySource, [{ label: "SDK app outside Chronos · ~/evalbot", n: 2 }]);
  const md = renderPostmortem(p);
  assert.match(md, /# Where the 5-hour window went — acme/);
  assert.match(md, /\| Desk · operator \| \$4\.10 \| 34% \|/);
  assert.match(md, /2 calls refused with a limit message/);
  assert.equal(telegramText(p).tops, "Desk · operator 34%, SDK app outside Chronos · evalbot 33%", "a directory shrinks to its last part on the phone");
});

test("a goal from a workspace on another profile never prints, even if its transcript turned up here", () => {
  const id = "eeeeeeee-5";
  const p = analyze({
    profile: ".claude-acme", window: "5h", start: START, wallAt: null, resetsAt: RESET, until: RESET,
    sessions: [{ id, entry: "cli", cwd: "/w", head: null, walls: [], reqs: [req(START + 1000, "claude-opus-5-5", { input: 1e5 })] }],
    rows: new Map([[id, row(id, { workspace_id: "ws-globex", goal: "Globex quarterly numbers" })]]),
    runs: new Map(), onProfile: new Set(["ws-acme"]),
  });
  assert.equal(p.top[0].goal, "(another profile's terminal)");
  assert.doesNotMatch(renderPostmortem(p), /Globex/);
});

// ───────────────────────────── lever arithmetic ─────────────────────────────

test("replay5m: a burst that never idles 5 minutes pays 1.25× instead of 2× per write; a read after a long gap turns into a write", () => {
  const o = listRates("claude-opus-5-5");
  const burst = [req(0, "claude-opus-5-5", { cw1: 100_000 }), req(60_000, "claude-opus-5-5", { cacheRead: 100_000, cw1: 10_000 })];
  const r = replay5m(burst);
  assert.ok(Math.abs(r.actual - (110_000 * o.in * 2 + 100_000 * o.cacheRead) / 1e6) < 1e-9);
  assert.ok(Math.abs(r.optimistic - (110_000 * o.in * 1.25 + 100_000 * o.cacheRead) / 1e6) < 1e-9);
  assert.equal(r.optimistic, r.pessimistic, "the first request read nothing, so the bounds agree");
  const gap = replay5m([req(0, "claude-opus-5-5", { cacheRead: 50_000 }), req(10 * 60_000, "claude-opus-5-5", { cacheRead: 80_000 })]);
  assert.ok(Math.abs(gap.optimistic - (50_000 * o.cacheRead + 80_000 * o.in * 1.25) / 1e6) < 1e-9, "the read after 10 idle minutes is rewritten");
  assert.ok(Math.abs(gap.pessimistic - ((50_000 + 80_000) * o.in * 1.25) / 1e6) < 1e-9, "pessimistic: the first read too");
});

test("levers: Opus on investigation terminals saves exactly half at list; background past 80%; 1h cache on one-shot runs; rebuilds after idle", () => {
  const inv = "11111111-a", job = "22222222-b";
  const reqs = [req(START + 60_000, "claude-opus-5-5", { input: 1e6, output: 1e5 })];
  // A cron job: a 1h write it never needed, then a late burst after the window passed 80%.
  const jobReqs = [
    req(START + 2 * 60_000, "claude-opus-5-5", { cw1: 400_000 }),
    req(START + 3 * 60_000, "claude-opus-5-5", { cacheRead: 400_000, cw1: 50_000 }),
    req(START + 4 * 3600_000, "claude-opus-5-5", { input: 1.2e6 }),
  ];
  const p = analyze({
    profile: ".claude-acme", window: "5h", start: START, wallAt: START + 4.5 * 3600_000, resetsAt: RESET, until: RESET,
    sessions: [
      { id: inv, entry: "cli", cwd: "/w", head: null, walls: [], reqs },
      { id: job, entry: "sdk-cli", cwd: "/w", head: "x", walls: [], reqs: jobReqs },
    ],
    rows: new Map([[inv, row(inv, { goal_kind: "investigation" })]]),
    runs: new Map([[job, { session_id: job, job_name: "inbox-cleanup:acme", trigger_type: "cron", workspace_id: null }]]),
  });
  const by = Object.fromEntries(p.levers.map((l) => [l.id, l]));
  const opusCost = reqs[0].cost;
  assert.ok(Math.abs(by["opus-investigation"].usd - opusCost / 2) < 1e-9, "Sonnet 5.5 is half of Opus 5.5 on every token class");
  assert.ok(Math.abs(by["background-past-80"].usd - jobReqs[2].cost) < 1e-9, "only the job's spend after the 80% mark");
  const rp = replay5m(jobReqs);
  assert.ok(Math.abs(by["headless-1h-cache"].usd - (rp.actual - rp.pessimistic)) < 1e-9, "the conservative bound");
  assert.ok(p.levers.every((l, i) => i === 0 || p.levers[i - 1].usd >= l.usd), "ranked by saving");
  const rb = coldRebuilds([req(0, "claude-opus-5-5", { cw1: 60_000 }), req(2 * 3600_000, "claude-opus-5-5", { cw1: 60_000 })]);
  const o = listRates("claude-opus-5-5");
  assert.equal(rb.n, 1);
  assert.ok(Math.abs(rb.excess - (60_000 * (o.in * 2 - o.cacheRead)) / 1e6) < 1e-9);
  assert.equal(coldRebuilds([req(0, "claude-opus-5-5", { cw1: 60_000 }), req(30 * 60_000, "claude-opus-5-5", { cw1: 60_000 })]).n, 0, "inside the hour it is not a rebuild");
});

test("against the previous slices: the usual rate is the median of the active ones, and the source that grew is named", () => {
  const id = "33333333-c", bot = "44444444-d";
  const early = (k: number) => START - k * 5 * 3600_000 + 60_000;
  const p = analyze({
    profile: ".claude-acme", window: "5h", start: START, wallAt: START + 3600_000, resetsAt: RESET, until: RESET,
    sessions: [
      { id, entry: "cli", cwd: "/w", head: null, walls: [], reqs: [1, 2, 3].map((k) => req(early(k), "claude-opus-5-5", { input: 5e5 })).concat([req(START + 60_000, "claude-opus-5-5", { input: 5e5 })]) },
      { id: bot, entry: "sdk-py", cwd: "/w/bot", head: "q", walls: [], reqs: [req(START + 120_000, "claude-opus-5-5", { input: 2e6 })] },
    ],
    rows: new Map([[id, row(id)]]), runs: new Map(),
  });
  assert.equal(p.baseline.slices, 3);
  assert.ok(Math.abs((p.baseline.usual ?? 0) - 2) < 1e-9, "each earlier slice: $2 in one active hour");
  assert.ok(Math.abs((p.baseline.ratio ?? 0) - 5) < 1e-9, "$10 in one hour");
  assert.equal(p.baseline.grew?.label, "SDK app outside Chronos · /w/bot");
});

// ───────────────────────────── trigger, delivery, isolation ─────────────────────────────

test("one post-mortem per wall: the meter's reset and a run's clock-parsed reset are the same wall; a restart does not repeat it", () => {
  const dir = mkProfile("acme");
  const a = noteWall({ configDir: dir, window: "5h", resetsAt: RESET, at: RESET - 3600_000, source: "meter" });
  assert.ok(a);
  assert.equal(noteWall({ configDir: dir, window: "5h", resetsAt: RESET + 60_000, at: RESET - 1800_000, source: "run" }), null);
  assert.ok(noteWall({ configDir: dir, window: "week", resetsAt: RESET, at: RESET - 3600_000, source: "meter" }), "the weekly window is its own wall");
  // The in-memory copy gone (a daemon restart): the persisted key still holds.
  _forgetPostmortemCache();
  const before = wallRecords().length;
  assert.equal(noteWall({ configDir: dir, window: "5h", resetsAt: RESET, at: RESET, source: "meter" }), null);
  assert.equal(wallRecords().length, before);
  assert.equal(windowOfLimit("You've hit your org's monthly spend limit · your 5-hour limit resets 2:20pm", 0, 9 * 3600_000), "5h");
  assert.equal(windowOfLimit("You've hit your weekly limit", 0, 3600_000), "week");
});

test("the meter tells the post-mortem when a window reads 100% with its reset ahead", () => {
  const got: ClaudeWallReading[] = [];
  onClaudeWall((w) => got.push(w));
  const now = Date.now();
  noteClaudeStatusline("/Users/operator/.claude-acme", { five_hour: { used_percentage: 100, resets_at: Math.floor((now + 3600_000) / 1000) }, seven_day: { used_percentage: 40 } }, now);
  noteClaudeStatusline("/Users/operator/.claude-acme", { five_hour: { used_percentage: 99, resets_at: Math.floor((now + 3600_000) / 1000) } }, now);
  assert.equal(got.length, 1);
  assert.equal(got[0].scope, ".claude-acme");
  assert.equal(got[0].window, "5h");
});

test("isolation: a report lands only in workspaces pinned to its own profile — one, or every one sharing it", async () => {
  const acmeDir = mkProfile("acme"), globexDir = mkProfile("globex"), shared = mkProfile("shared");
  const acme = mkWs("acme", acmeDir), globex = mkWs("globex", globexDir);
  const initech = mkWs("initech", shared), personal = mkWs("personal", shared, { kind: "personal" });
  // deliverNotes re-checks what its caller hands it: a globex workspace slipped into an acme list gets nothing.
  const out = deliverNotes({ configDir: acmeDir }, "# acme report", [acme, globex]);
  assert.deepEqual(out.map((o) => o.workspace_id), [acme.id]);
  assert.equal(notes.bySlug(globex.id, NOTE_SLUG), undefined);
  assert.deepEqual(workspacesOnProfile(shared).map((w) => w.id).sort(), [initech.id, personal.id].sort());

  // End to end: a wall on the shared profile reports into both sharing workspaces and nowhere else.
  const t = mkTerminal(initech, { goal: "Initech billing export" });
  writeTranscript(shared, t.id, { lines: [{ m: 30, in: 2e5, out: 1e4 }] });
  await postmortemTick(START + 4 * 3600_000, { seen: [{ configDir: shared, window: "5h", resetsAt: RESET, at: START + 4 * 3600_000, source: "meter" }] });
  assert.ok(notes.bySlug(initech.id, NOTE_SLUG));
  assert.ok(notes.bySlug(personal.id, NOTE_SLUG));
  assert.equal(notes.bySlug(acme.id, NOTE_SLUG)?.body, "# acme report", "acme's note untouched by the shared profile's report");
  assert.equal(notes.bySlug(globex.id, NOTE_SLUG), undefined);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /hit its 5-hour limit/);
});

test("the tick: one report and one Telegram line per wall, the terminal only after the reset and only once", async () => {
  const dir = mkProfile("acme");
  const ws = mkWs("acme", dir);
  const t = mkTerminal(ws, { goal: "Refactor the importer", kind: "investigation" });
  writeTranscript(dir, t.id, { lines: [{ m: 10, in: 3e5, out: 2e4 }, { m: 20, cr: 3e5, out: 2e4 }], walls: [250] });
  const opened: any[] = [];
  let walled = true;
  const deps = {
    seen: [{ configDir: dir, window: "5h" as const, resetsAt: RESET, at: START + 250 * 60_000, source: "meter" as const }],
    opener: async (o: any) => { opened.push(o); return { id: randomUUID() }; },
    walled: () => walled,
  };
  await postmortemTick(START + 251 * 60_000, deps);
  await postmortemTick(START + 252 * 60_000, deps);
  assert.equal(wallRecords().length, 1);
  assert.equal(sent.length, 1, "one Telegram line");
  assert.match(notes.bySlug(ws.id, NOTE_SLUG)!.body, /# Where the 5-hour window went/);
  assert.equal(opened.length, 0, "never before the reset");
  await postmortemTick(RESET + 60_000, deps);
  assert.equal(opened.length, 0, "never while the profile is still walled");
  walled = false;
  await postmortemTick(RESET + 2 * 60_000, deps);
  await postmortemTick(RESET + 30 * 60_000, deps);
  assert.equal(opened.length, 1, "one terminal per wall");
  const o = opened[0];
  assert.equal(o.workspace_id, ws.id);
  assert.equal(o.created_by, POSTMORTEM_BY);
  assert.equal(o.model, "sonnet");
  assert.match(o.goal, /^Where the 5-hour window went on acme-\w+ — review the levers with the operator/);
  assert.match(o.description, /mc memo get limit-postmortem/);
  assert.match(o.description, /Apply only what he approves/);
  assert.equal(sent.length, 1, "the reset sends nothing more");
});

test("the terminal: off in Settings → no terminal, recorded as skipped; a refused open is retried, never stacked", async () => {
  const dir = mkProfile("globex");
  const ws = mkWs("globex", dir);
  writeTranscript(dir, randomUUID(), { entry: "sdk-py", cwd: "/Users/operator/evalbot", lines: [{ m: 10, in: 1e5 }] });
  writeSetting("limits.postmortem_terminal", false, ws.id);
  let calls = 0;
  const deps = { seen: [{ configDir: dir, window: "5h" as const, resetsAt: RESET, at: START + 3600_000, source: "meter" as const }], opener: async () => { calls++; return { id: "x" }; }, walled: () => false };
  await postmortemTick(START + 3600_000, deps);
  await postmortemTick(RESET + 60_000, deps);
  assert.equal(calls, 0);
  assert.match(wallRecords()[0].terminal?.skipped ?? "", /off in ⚙ Settings/);
  writeSetting("limits.postmortem_terminal", true, ws.id);

  _resetPostmortemState();
  let fail = true;
  const deps2 = { ...deps, opener: async () => { calls++; if (fail) throw new Error("workspace session cap reached (6/6)"); return { id: randomUUID() }; } };
  await postmortemTick(START + 3600_000, deps2);
  await postmortemTick(RESET + 60_000, deps2);
  assert.equal(calls, 1);
  await postmortemTick(RESET + 65_000, deps2);
  assert.equal(calls, 1, "no retry inside ten minutes");
  fail = false;
  await postmortemTick(RESET + 12 * 60_000, deps2);
  await postmortemTick(RESET + 30 * 60_000, deps2);
  assert.equal(calls, 2, "retried once it can open, then never again");
});

test("pickWorkspace: the pinned workspace that spent most; ties go to the operator's own", () => {
  const dir = mkProfile("shared2");
  const a = mkWs("initech", dir), b = mkWs("personal", dir, { kind: "personal" });
  assert.equal(pickWorkspace({ byWorkspace: { [a.id]: 3, [b.id]: 1 } }, [a, b])?.id, a.id);
  assert.equal(pickWorkspace({ byWorkspace: {} }, [a, b])?.id, b.id);
});

test("routes: a workspace token reads its own account's reports and window only", async () => {
  const acmeDir = mkProfile("acme"), globexDir = mkProfile("globex");
  const acme = mkWs("acme", acmeDir);
  mkWs("globex", globexDir);
  noteWall({ configDir: acmeDir, window: "5h", resetsAt: RESET, at: RESET - 3600_000, source: "meter" });
  noteWall({ configDir: globexDir, window: "5h", resetsAt: RESET, at: RESET - 3600_000, source: "meter" });
  const mine = listRequest({ ws: acme.id }, {});
  assert.equal(mine.status, 200);
  assert.deepEqual((mine.body as any).reports.map((r: any) => r.profile), [path.basename(acmeDir)]);
  assert.equal(listRequest({ ws: acme.id }, { profile: path.basename(globexDir) }).status, 403);
  assert.equal((listRequest({ ws: null }, {}).body as any).reports.length, 2, "the operator sees every account");
  assert.equal(listRequest(null, {}).status, 401);
  assert.equal((await onDemandRequest({ ws: acme.id }, { profile: path.basename(globexDir) })).status, 403);
  let asked: any = null;
  const r = await onDemandRequest({ ws: acme.id }, { window: "5h", at: new Date(RESET).toISOString() }, RESET + 1, async (o) => { asked = o; return runPostmortem(o); });
  assert.equal(r.status, 200);
  assert.equal(asked.configDir, acmeDir);
  assert.equal((r.body as any).report.byWorkspace, undefined, "per-workspace spend stays inside the daemon");
  assert.equal(resolveProfileDir(path.basename(acmeDir)), acmeDir);
  assert.equal(resolveProfileDir(path.basename(acmeDir).replace(/^\.claude-/, "")), acmeDir);
  assert.equal(resolveProfileDir(".claude-nobody-here"), null);
});

test("the brief and the note carry the report, never another account's text", async () => {
  const dir = mkProfile("acme");
  const ws = mkWs("acme", dir);
  const t = mkTerminal(ws, { goal: "Acme importer" });
  writeTranscript(dir, t.id, { lines: [{ m: 10, in: 3e5, out: 1e4 }] });
  const p = await runPostmortem({ configDir: dir, window: "5h", resetsAt: RESET, wallAt: START + 3600_000, now: START + 3600_000 });
  const brief = terminalBrief(p, "`mc memo get limit-postmortem`");
  assert.match(brief, /Top consumers:\n- Desk · operator — 100%/);
  assert.match(renderPostmortem(p), /Acme importer/);
});

test("a run's limit error is a wall too; its clock-style reset is read against the run, so it never rolls to tomorrow", () => {
  const dir = mkProfile("initech");
  const ws = mkWs("initech", dir);
  const started = new Date(2026, 10, 17, 14, 0, 0).getTime(); // 14:00 on this machine's clock
  const fivePm = new Date(2026, 10, 17, 17, 0, 0).getTime();
  const j = jobs.create({ name: "inbox-cleanup:initech", goal: "g", cwd: tmp, workspace_id: ws.id, trigger_type: "manual" } as any);
  const r = runs.create(j.id, "manual");
  runs.patch(r.id, { status: "rate_limited", started_at: new Date(started).toISOString(), error: "You've hit your 5-hour limit · resets 5pm" } as any);
  const later = new Date(2026, 10, 17, 20, 0, 0).getTime();
  const seen = wallsFromRuns(later).filter((w) => w.configDir === dir);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].window, "5h");
  assert.equal(seen[0].resetsAt, fivePm, "17:00 the same day, not tomorrow's");
  assert.equal(stillWalled(dir, new Date(2026, 10, 17, 16, 0, 0).getTime()), true);
  assert.equal(stillWalled(dir, later), false);
});
