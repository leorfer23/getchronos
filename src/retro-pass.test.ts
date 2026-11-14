/**
 * The weekly self-retro (src/retro-pass.ts, src/retro.ts, src/retro-routes.ts, src/widgets/retro.ts):
 * gather → candidates and verifier proposals → the job's rules (model stubbed: the plan is written
 * here) → the operator's approve / dismiss → next week's "rule not holding". And the walls: one
 * workspace's report, candidates and rules never reach another; the only cross-workspace flow is the
 * product workspace's sum, which carries enums and counts only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG } from "./config.js";
import { db, jobs, kv, notes, repos, sessions, tickets, workspaces } from "./store.js";
import { requests } from "./store/requests.js";
import { retroProposals, retroRuns } from "./store/retro.js";
import { markInput } from "./turn-source.js";
import { REVIVE_NUDGE } from "./revive.js";
import { tellLine } from "./verify-model.js";
import { INDEX_SLUG } from "./memory-tree.js";
import { REPO_ROOT } from "./repo-root.js";
import {
  aggregateFindings, applyRetro, aspectRule, decideProposal, findingsOf, gatherRetro, isFindingKey, kpisOf, retroContext,
  RetroError, retroView, RULE_TOPIC, type GatherDeps, type RetroStats,
} from "./retro-pass.js";
import { AWAKE_MIN_MS, maybeRetro, productWorkspace, RETRO_KV, startRetro, weekBefore, weeklyLine, weeklySlot } from "./retro.js";
import * as routes from "./retro-routes.js";
import { retroRows } from "./widgets/retro.js";
import { isReadOnlyRun } from "./runner.js";
import { isInternalJob } from "./job-name.js";
import { EPHEMERAL_JOB_PREFIXES } from "./hygiene.js";
import { BRAIN_ONLY_KINDS } from "./hosts/run-placement.js";
import type { Workspace } from "./types.js";

const SINCE = "2026-11-02T08:00:00.000Z";
const UNTIL = "2026-11-09T08:00:00.000Z";
const at = (h: number, base = SINCE) => new Date(Date.parse(base) + h * 3600_000).toISOString();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-pass-"));
const files = new Map<string, string>();
const deps: GatherDeps = { locate: (s) => files.get(s.id) ?? null };

const mkWs = (name: string, extra: Record<string, unknown> = {}): Workspace =>
  workspaces.create({ slug: `${name}-${randomUUID().slice(0, 6)}`, name, config_dir: `/tmp/retro-test/${name}-${randomUUID()}`, ...extra } as any);

function mkSession(ws: Workspace, o: { h: number; endH?: number | null; goal?: string; by?: string; backend?: string; firstPrompt?: string }) {
  const s = sessions.create({ workspace_id: ws.id, cwd: "/tmp", goal: o.goal ?? null, created_by: o.by ?? "operator", backend: o.backend ?? "claude-code" } as any);
  db.prepare("UPDATE sessions SET created_at=?, ended_at=?, status=? WHERE id=?").run(at(o.h), o.endH == null ? null : at(o.endH), o.endH == null ? "live" : "ended", s.id);
  if (o.firstPrompt) sessions.setMeta(s.id, { first_prompt: o.firstPrompt });
  return sessions.get(s.id)!;
}

/** A claude transcript: [text, hour] typed turns, plus raw lines. */
function transcript(sessionId: string, turns: Array<[string, number]>, raw: unknown[] = []) {
  const line = (text: string, h: number) => ({ type: "user", entrypoint: "cli", timestamp: at(h), origin: { kind: "human" }, promptSource: "typed", message: { role: "user", content: text } });
  const f = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(f, [...turns.map(([t, h]) => line(t, h)), ...raw].map((l) => JSON.stringify(l)).join("\n") + "\n");
  files.set(sessionId, f);
}

/** One verifier round typed back into a terminal, failing these checks. */
function round(ws: Workspace, h: number, names: string[], sessionId: string | null = null, reason = "not ready") {
  const r = requests.create({ workspace_id: ws.id, words: "do the thing", via: "typed" });
  db.prepare(`INSERT INTO request_verifications (id,request_id,workspace_id,trigger,target_key,status,ready,reason,told,round,session_id,started_at,finished_at)
    VALUES (?,?,?,'outcome','k','done',0,?,1,1,?,?,?)`).run(randomUUID(), r.id, ws.id, reason, sessionId, at(h), at(h + 0.05));
  for (const n of names) {
    db.prepare("INSERT INTO request_checks (id,request_id,name,status,note,ran_by,ran_at,created_at) VALUES (?,?,?,'fail','x','verifier',?,?)")
      .run(randomUUID(), r.id, n, at(h + 0.01), at(h + 0.01));
  }
}

const outcome = (h: number) => ({ summary: "done", changes: [], proof: [], prs: [], shots: [], ask: "none" as const, shipped: [], at: at(h) });

/**
 * A week in one workspace: a seeded terminal the daemon typed into (verifier round, revive nudge,
 * Robert's tell), the operator correcting and repeating himself across terminals, an API outage, a
 * bad mc flag, a duplicate terminal and a codex terminal (not read).
 */
function seedWeek(ws: Workspace, words = { fix: "always put the csv in downloads", dm: "DM me when done" }) {
  const seed = `Goal: fix the login redirect and ${words.dm.toLowerCase()}`;
  const s1 = mkSession(ws, { h: 1, endH: 30, goal: `fix the login redirect and ${words.dm.toLowerCase()}`, firstPrompt: seed });
  sessions.setOutcome(s1.id, outcome(20));
  markInput({ session_id: s1.id, workspace_id: ws.id, kind: "robert", by: "robert", text: "Robert here: split the migration in two", at: at(9) });
  transcript(s1.id, [
    [seed, 1.01],
    [tellLine(1, ["tests: the repo's checks fail"]), 5],
    [REVIVE_NUDGE, 8],
    [`no, ${words.fix}`, 9.5],
    ["Robert here: split the migration in two", 9.01],
  ], [
    { type: "assistant", entrypoint: "cli", timestamp: at(10), message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "mc goal set --bogus" } }] } },
    { type: "user", entrypoint: "cli", timestamp: at(10.1), toolUseResult: {}, message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "mc goal set: unknown option --bogus" }] } },
    { type: "assistant", entrypoint: "cli", timestamp: at(11), isApiErrorMessage: true, error: "server_error", message: { content: [{ type: "text", text: "API Error: Can't reach the API server (ENOTFOUND)" }] } },
  ]);
  const s2 = mkSession(ws, { h: 40, endH: 60, goal: "export the weekly numbers" });
  sessions.setOutcome(s2.id, outcome(50));
  transcript(s2.id, [["put the csv in downloads please", 41], [words.dm, 42]]);
  const s3 = mkSession(ws, { h: 45, endH: 70, goal: "export the weekly numbers again" });
  transcript(s3.id, [[words.dm, 46]]);
  const s4 = mkSession(ws, { h: 47, endH: 48, goal: "a codex chore", backend: "codex" });
  round(ws, 21, ["queries"], s1.id, "queries: the numbers have no query behind them");
  round(ws, 51, ["queries", "crosscheck"], s2.id);
  round(ws, 52, ["matches_request"], s2.id);
  return { s1, s2, s3, s4, words };
}

const newRun = (ws: Workspace, since = SINCE, until = UNTIL) => retroRuns.create({ workspace_id: ws.id, source: "manual", since, until });
const statsOf = (runId: string) => JSON.parse(retroRuns.get(runId)!.stats!) as RetroStats;

function errOf(fn: () => unknown): RetroError {
  try { fn(); } catch (e) { if (e instanceof RetroError) return e; throw e; }
  assert.fail("expected a RetroError");
}
async function errOfAsync(fn: () => Promise<unknown>): Promise<RetroError> {
  try { await fn(); } catch (e) { if (e instanceof RetroError) return e; throw e; }
  assert.fail("expected a RetroError");
}

const fakeReq = (params: Record<string, string>, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): any =>
  ({ params, query: {}, body: {}, get: (h: string) => headers[h.toLowerCase()], ...extra });
function fakeRes(): any {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}

// ───────────────────────────── gather ─────────────────────────────

test("gather: his turns told from the daemon's, the week's numbers, and a report that says what hurt most", async () => {
  const ws = mkWs("atlas");
  seedWeek(ws);
  const run = await gatherRetro(ws, newRun(ws).id, deps);
  assert.equal(run.status, "gathered");
  const s = statsOf(run.id);
  assert.equal(s.sessions, 3, "three claude transcripts read");
  assert.equal(s.sessions_skipped, 1, "the codex terminal is not read");
  assert.deepEqual(s.injected, { seed: 1, verifier: 1, revive: 1, robert: 1 }, "the daemon's lines, each by who typed it");
  assert.equal(s.operator_turns, 4, "only his own lines");
  assert.equal(s.sessions_typed, 3);
  assert.equal(s.handoffs, 2);
  assert.deepEqual(s.verifier.aspects, { queries: 2, crosscheck: 1, matches_request: 1 });
  assert.equal(s.verifier.rejections, 3);
  assert.equal(s.verifier.generic, 1, "only the catch-all reader verdict failed");
  assert.deepEqual(s.infra, { revive: 1, network: 0, api_network: 1, sessions_hit: 1 });
  assert.deepEqual(s.tool_errors, { "mc-cli-invalid-flag": 1 });
  assert.equal(s.duplicates, 1, "the second export terminal opened while the first was live");
  const k = kpisOf(s);
  assert.equal(k.rejection_rate, 1.5);
  assert.equal(k.infra, 2);
  assert.ok(s.repeats.times >= 2, "DM me when done, said in three terminals");
  assert.match(run.report!, /Verifier sent work back 3× — 1\.50 per hand-off/);
  assert.match(run.report!, /Lines the daemon typed \(not counted as yours\)/);
  assert.match(run.report!, /DM me when done/i);
});

test("gather: candidates are his corrections and repeated asks; a verifier aspect sent back twice is a proposal by itself", async () => {
  const ws = mkWs("birch");
  seedWeek(ws);
  const run = await gatherRetro(ws, newRun(ws).id, deps);
  const cands = JSON.parse(run.candidates!) as { id: string; kind: string; text: string; count: number }[];
  const fix = cands.find((c) => /downloads/.test(c.text));
  const dm = cands.find((c) => /dm me when done/i.test(c.text));
  assert.equal(fix?.kind, "correction");
  assert.equal(dm?.kind, "repeat");
  assert.equal(dm?.count, 3, "his spawn goal counts as his words; the seed that carried it does not count again");
  assert.ok(!cands.some((c) => /verifier|daemon restarted|split the migration/i.test(c.text)), "no daemon line becomes a candidate");
  const props = retroProposals.list(ws.id);
  assert.deepEqual(props.map((p) => [p.source, p.key, p.status]), [["verifier", "verifier:queries", "pending"]], "queries twice → a proposal; crosscheck and matches_request once → none");
  assert.equal(props[0].text, aspectRule("queries"));
  // Gathering again proposes nothing twice.
  await gatherRetro(ws, newRun(ws).id, deps);
  assert.equal(retroProposals.list(ws.id).length, 1);
});

test("findings: enum → count only, every key from the closed lists, no word of his", async () => {
  const ws = mkWs("cedar");
  const { words } = seedWeek(ws, { fix: "always put the quarterly ledger in downloads", dm: "Ping me when the ledger lands" });
  const run = await gatherRetro(ws, newRun(ws).id, deps);
  const f = JSON.parse(run.findings!) as Record<string, number>;
  assert.ok(Object.keys(f).length > 5);
  for (const [k, v] of Object.entries(f)) {
    assert.ok(isFindingKey(k), `${k} is a closed enum key`);
    assert.ok(Number.isInteger(v) && v > 0, `${k} is a count`);
  }
  assert.equal(f["verifier_aspect:queries"], 2);
  assert.equal(f["tool_error:mc-cli-invalid-flag"], 1);
  assert.equal(f["infra:revive"], 1);
  const blob = JSON.stringify(f).toLowerCase();
  for (const w of ["ledger", "downloads", "login", ws.slug, ws.name.toLowerCase(), words.dm.toLowerCase()]) assert.ok(!blob.includes(w), `findings carry no "${w}"`);
  assert.deepEqual(findingsOf(statsOf(run.id)), f);
});

test("aggregateFindings: whatever a row holds, only closed enum keys with whole counts are summed", () => {
  const agg = aggregateFindings([
    { verifier_rejections: 3, "tool_error:mc-cli-invalid-flag": 1, "a client said: ship it friday": 5, injected: 2, "verifier_aspect:bogus": 2, "tool_error:other": 1.5, "infra:revive": -1, "api_error:network": "7" },
    JSON.parse('{"__proto__": 9, "verifier_rejections": 2}'),
    "a string", null, [1, 2],
  ]);
  assert.deepEqual(agg, { workspaces: 2, counts: { verifier_rejections: 5, "tool_error:mc-cli-invalid-flag": 1 } });
});

// ───────────────────────────── apply (model stubbed) + the operator's tap ─────────────────────────────

test("apply: refuses a malformed plan with every problem at once; a good one files pending proposals and the notes", async () => {
  const ws = mkWs("dune");
  seedWeek(ws);
  const run = await gatherRetro(ws, newRun(ws).id, deps);
  const cands = JSON.parse(run.candidates!) as { id: string; text: string }[];
  const fix = cands.find((c) => /downloads/.test(c.text))!;
  const dm = cands.find((c) => /dm me/i.test(c.text))!;
  const bad = errOf(() => applyRetro(ws, {
    run: run.id,
    rules: [{ from: ["nope"], rule: "too short" }, { from: [fix.id], rule: "line one\nline two that is long enough" }, { from: [], rule: "A rule with nothing behind it at all." }],
    product: [{ title: "Not this workspace's to propose", why: "x", change: "y" }],
  }));
  assert.equal(bad.status, 400);
  assert.ok(bad.problems.length >= 5, bad.problems.join("\n"));
  assert.equal(retroRuns.get(run.id)!.status, "gathered", "nothing written on a refusal");

  const out = applyRetro(ws, {
    run: run.id,
    rules: [
      { from: [fix.id], rule: "Save every exported CSV to ~/Downloads and say the path in the hand-off." },
      { from: [dm.id], rule: "DM the operator when a task is done." },
    ],
    notes: "Fewer rounds than last week; the CSV location keeps coming up.",
  });
  assert.equal(out.proposed.length, 2);
  assert.deepEqual(out.proposed.map((p) => p.source), ["correction", "repeat"]);
  const after = retroRuns.get(run.id)!;
  assert.equal(after.status, "applied");
  assert.match(after.report!, /\*\*Notes\*\*\nFewer rounds than last week/);
  assert.equal(errOf(() => applyRetro(ws, { run: run.id, rules: [] })).status, 409, "an applied run is closed");
  assert.equal(notes.bySlug(ws.id, INDEX_SLUG), undefined, "nothing reaches memory before his tap");
});

test("decide: approve writes the rule into the memory index; dismiss keeps the row so it never comes back; each only once", async () => {
  const ws = mkWs("elm");
  seedWeek(ws);
  const run = await gatherRetro(ws, newRun(ws).id, deps);
  const cands = JSON.parse(run.candidates!) as { id: string; text: string }[];
  const out = applyRetro(ws, {
    run: run.id,
    rules: [
      { from: [cands.find((c) => /downloads/.test(c.text))!.id], rule: "Save every exported CSV to ~/Downloads and say the path." },
      { from: [cands.find((c) => /dm me/i.test(c.text))!.id], rule: "DM the operator when a task is done." },
    ],
  });
  const [save, dmRule] = out.proposed;
  const approved = await decideProposal(ws, save.id, { decision: "approve", by: "operator" });
  assert.equal(approved.status, "approved");
  const index = notes.bySlug(ws.id, INDEX_SLUG)!.body;
  assert.match(index, new RegExp(`## ${RULE_TOPIC}\\n- Save every exported CSV to ~/Downloads and say the path\\.`));
  assert.equal((await errOfAsync(() => decideProposal(ws, save.id, { decision: "dismiss", by: "operator" }))).status, 409);
  assert.equal((await decideProposal(ws, dmRule.id, { decision: "dismiss", by: "operator" })).status, "dismissed");
  assert.doesNotMatch(notes.bySlug(ws.id, INDEX_SLUG)!.body, /DM the operator/);

  // The same week read again: both asks are answered by a proposal (approved or dismissed), so neither
  // is a candidate — and a rule worded like the dismissed one is skipped, never proposed again.
  const s6 = mkSession(ws, { h: 80, endH: 90, goal: "tidy the docs" });
  transcript(s6.id, [["never paste tokens into the chat", 81]]);
  const again = await gatherRetro(ws, newRun(ws).id, deps);
  const left = JSON.parse(again.candidates!) as { id: string; text: string }[];
  assert.ok(!left.some((c) => /downloads|dm me/i.test(c.text)), JSON.stringify(left));
  const fresh = left.find((c) => /tokens/.test(c.text))!;
  const re = applyRetro(ws, { run: again.id, rules: [{ from: [fresh.id], rule: "Send the operator a DM when a task is done." }] });
  assert.equal(re.proposed.length, 0);
  assert.match(re.skipped[0].why, /dismissed before/);
  // An edited approval saves his words, not the job's.
  const edit = retroProposals.add({ workspace_id: ws.id, run_id: null, kind: "rule", source: "correction", key: "rule:edit-test", text: "Use the staging schema." });
  await decideProposal(ws, edit!.id, { decision: "approve", by: "operator", text: "Use the staging schema for every test query." });
  assert.match(notes.bySlug(ws.id, INDEX_SLUG)!.body, /Use the staging schema for every test query\./);
  assert.equal(retroProposals.get(edit!.id)!.text, "Use the staging schema for every test query.");
});

test("next week: an approved rule whose ask comes back is flagged as not holding, and its ask is no candidate any more", async () => {
  const ws = mkWs("fir");
  seedWeek(ws);
  const run = await gatherRetro(ws, newRun(ws).id, deps);
  const fix = (JSON.parse(run.candidates!) as { id: string; text: string }[]).find((c) => /downloads/.test(c.text))!;
  const [p] = applyRetro(ws, { run: run.id, rules: [{ from: [fix.id], rule: "Save every exported CSV to ~/Downloads and say the path." }] }).proposed;
  await decideProposal(ws, p.id, { decision: "approve", by: "operator" });
  // The approval happened at the end of week one (backdate it so week two is after it).
  db.prepare("UPDATE retro_proposals SET decided_at=? WHERE id=?").run(UNTIL, p.id);
  const s5 = mkSession(ws, { h: 7 * 24 + 5, endH: 7 * 24 + 9, goal: "the monthly export" });
  transcript(s5.id, [["put the csv in downloads, again", 7 * 24 + 6]]);
  const wk2 = await gatherRetro(ws, newRun(ws, UNTIL, at(7 * 24, UNTIL)).id, deps);
  const s = statsOf(wk2.id);
  assert.deepEqual(s.rules_failed.map((r) => [r.id, r.times]), [[p.id, 1]]);
  assert.equal(kpisOf(s).rules_failed, 1);
  assert.ok(!(JSON.parse(wk2.candidates!) as { text: string }[]).some((c) => /downloads/.test(c.text)), "a rule already answers it");
  assert.match(wk2.report!, /not holding: "Save every exported CSV/);
  const view = retroView(ws);
  assert.deepEqual(view.failing.map((f) => f.id), [p.id]);
  assert.ok(view.last_week, "week two shows week one beside it");
});

// ───────────────────────────── the job ─────────────────────────────

test("startRetro: numbers first, then one read-only job on the workspace's own profile — only when there is something to judge", async () => {
  const ws = mkWs("grove");
  seedWeek(ws);
  const seen: string[] = [];
  const r = await startRetro(ws, { source: "slot", slot: "2026-11-09@08", now: new Date(UNTIL), gather: deps, dispatch: ((jobId: string) => { seen.push(jobId); return { run_id: "fake-run", status: "queued" }; }) as any });
  assert.equal(r.error, undefined);
  const job = jobs.get(seen[0])!;
  assert.equal(job.name, `retro:${ws.slug}`);
  assert.equal(job.workspace_id, ws.id);
  assert.equal(job.backend, "claude-code");
  assert.equal(job.model, null);
  assert.equal(job.disallowed_tools, "Edit,Write,MultiEdit,NotebookEdit");
  assert.equal(job.retry_max, 0);
  assert.match(job.append_system!, /You are the RETRO/);
  assert.match(job.goal, new RegExp(`mc retro context --run ${r.run}`));
  assert.doesNotMatch(job.goal, /product/);
  const run = retroRuns.get(r.run!)!;
  assert.equal(run.status, "dispatched");
  assert.equal(run.run_id, "fake-run");
  assert.ok(run.stats, "the week's numbers exist before any model ran");
  assert.equal(run.since, weekBefore(new Date(2026, 10, 9, 8)).since);

  const quiet = mkWs("hollow");
  const q = await startRetro(quiet, { source: "manual", gather: deps, dispatch: (() => assert.fail("nothing to judge — no job")) as any });
  assert.match(q.skipped!, /numbers only/);
  assert.equal(retroRuns.get(q.run!)!.status, "applied");
  const ivy = mkWs("ivy");
  mkSession(ivy, { h: 30, endH: 40, goal: "an unreadable transcript" });
  const unread = await startRetro(ivy, { source: "manual", now: new Date(UNTIL), gather: { ...deps, locate: () => { throw new Error("disk gone"); } }, dispatch: (() => assert.fail("nothing to judge")) as any });
  assert.equal(unread.error, undefined, "a transcript that cannot be read is skipped, not a lost week");
  assert.equal(statsOf(unread.run!).sessions_skipped, 1);
});

test("retro: runs are read-only, internal, reaped as ephemeral, and stay on the brain", () => {
  assert.equal(isReadOnlyRun("retro:initech"), true);
  assert.equal(isReadOnlyRun("fallback:retro:initech"), true);
  assert.equal(isInternalJob("retro:initech"), true);
  assert.ok(EPHEMERAL_JOB_PREFIXES.includes("retro:"));
  assert.ok(BRAIN_ONLY_KINDS["retro:"]);
});

test("weeklySlot: the latest Monday 08:00 at or before now, on local calendar fields", () => {
  const L = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi);
  assert.equal(weeklySlot(L(2026, 11, 11, 15), 1, 8), "2026-11-09@08", "Wednesday → this week's Monday");
  assert.equal(weeklySlot(L(2026, 11, 9, 7, 59), 1, 8), "2026-11-02@08", "Monday before 08:00 → last week's");
  assert.equal(weeklySlot(L(2026, 11, 9, 8, 0), 1, 8), "2026-11-09@08");
  assert.equal(weeklySlot(L(2026, 11, 15, 23), 1, 8), "2026-11-09@08", "Sunday night → the Monday before");
  assert.equal(weeklySlot(L(2027, 1, 2, 9), 1, 8), "2026-12-28@08", "across a year");
});

test("maybeRetro: due once a week, not in a fresh wake, not into a dead network — and the slot is marked only when it starts", async () => {
  kv.del(RETRO_KV);
  const now = new Date(2026, 10, 11, 15);
  const calls: string[] = [];
  const all = (async (_s: string, slot: string | null) => { calls.push(String(slot)); return []; }) as any;
  assert.equal(await maybeRetro({ now, awakeSince: () => now.getTime() - AWAKE_MIN_MS + 60_000, all }), null, "woke a minute short");
  assert.equal(kv.get(RETRO_KV), undefined);
  assert.equal(await maybeRetro({ now, awakeSince: () => 0, network: async () => false, all }), null, "network down");
  assert.equal(kv.get(RETRO_KV), undefined);
  const said: string[] = [];
  assert.equal(await maybeRetro({ now, awakeSince: () => 0, network: async () => true, all, lineDelayMs: 0, notify: (t) => { said.push(t); } }), "2026-11-09@08");
  assert.equal(kv.get(RETRO_KV), "2026-11-09@08");
  assert.equal(await maybeRetro({ now: new Date(2026, 10, 13, 10), awakeSince: () => 0, all }), null, "already ran this week");
  assert.deepEqual(calls, ["2026-11-09@08"]);
  // His one line for the week: names and counts of what waits on him, nothing else.
  assert.equal(said.length, 1, "earlier weeks in this file left rules waiting");
  assert.equal(said[0], weeklyLine());
});

test("weeklyLine: which workspaces have rules waiting and which approved rules are not holding — counts only", () => {
  const ws = mkWs("line-ws");
  const other = mkWs("line-quiet");
  retroProposals.add({ workspace_id: ws.id, run_id: null, kind: "rule", source: "correction", key: "rule:line-1", text: "Never ship on a Friday afternoon." });
  const line = weeklyLine([ws, other])!;
  assert.match(line, /1 rule wait on you: line-ws 1 — Desk → Fleet board → Weekly retro/);
  assert.doesNotMatch(line, /Friday|line-quiet/, "the rule's words and quiet workspaces stay out of it");
  assert.equal(weeklyLine([other]), null, "nothing waiting, nothing sent");
});

// ───────────────────────────── the walls ─────────────────────────────

test("isolation: A's report, candidates and proposals never appear in B — bundle, view, widget, and every id is A's alone", async () => {
  const A = mkWs("atlas-wall");
  const B = mkWs("birch-wall");
  seedWeek(A, { fix: "always attach the vendor invoice pdf", dm: "Ping me when the invoice batch lands" });
  seedWeek(B);
  const runA = await gatherRetro(A, newRun(A).id, deps);
  const runB = await gatherRetro(B, newRun(B).id, deps);
  const secret = ["vendor invoice", "invoice batch"];
  const bBundle = JSON.stringify(retroContext(B, runB.id)).toLowerCase();
  const bView = JSON.stringify(retroView(B)).toLowerCase();
  const bWidget = JSON.stringify(retroRows({ ws: B.id })).toLowerCase();
  for (const w of secret) {
    assert.ok(JSON.stringify(retroContext(A, runA.id)).toLowerCase().includes(w), `A's own bundle has "${w}" (the test is real)`);
    for (const [name, blob] of [["bundle", bBundle], ["view", bView], ["widget", bWidget]] as const) assert.ok(!blob.includes(w), `B's ${name} has none of A's "${w}"`);
  }
  assert.deepEqual(retroRows({ ws: B.id }).map((r) => r.workspace_id), [B.id], "a locked Desk reads that workspace alone");
  assert.equal(errOf(() => retroContext(B, runA.id)).status, 404);
  const candA = (JSON.parse(runA.candidates!) as { id: string }[])[0].id;
  assert.equal(errOf(() => applyRetro(B, { run: runA.id, rules: [{ from: [candA], rule: "Attach the vendor invoice to every hand-off." }] })).status, 404);
  const [pA] = retroProposals.list(A.id);
  assert.equal((await errOfAsync(() => decideProposal(B, pA.id, { decision: "approve", by: "operator" }))).status, 404);
  assert.equal(retroProposals.get(pA.id)!.status, "pending");
  // A run of B cannot cite A's candidates either.
  assert.equal(errOf(() => applyRetro(B, { run: runB.id, rules: [{ from: [candA], rule: "Attach the vendor invoice to every hand-off." }] })).status, 400);
});

test("isolation: every retro door is walled — another workspace's token gets 404; a decision needs the operator's own hand", async () => {
  const A = mkWs("atlas-door");
  const B = mkWs("birch-door");
  seedWeek(A);
  const runA = await gatherRetro(A, newRun(A).id, deps);
  const [pA] = retroProposals.list(A.id);
  const tokA = { "x-mc-workspace-token": workspaces.get(A.id)!.token! };
  const tokB = { "x-mc-workspace-token": workspaces.get(B.id)!.token! };
  const calls: [string, (req: any, res: any) => unknown, any][] = [
    ["show", routes.showRoute, fakeReq({ id: A.id }, tokB)],
    ["runs", routes.runsRoute, fakeReq({ id: A.id }, tokB)],
    ["context", routes.contextRoute, fakeReq({ id: A.id }, tokB, { query: { run: runA.id } })],
    ["apply", routes.applyRoute, fakeReq({ id: A.id }, tokB, { body: { run: runA.id } })],
    ["decide", routes.decideRoute, fakeReq({ id: A.id, pid: pA.id }, tokB, { body: { decision: "approve" } })],
  ];
  for (const [name, fn, req] of calls) {
    const res = fakeRes();
    await fn(req, res);
    assert.equal(res.statusCode, 404, `${name} crossed the wall`);
  }
  // B's own door, A's run id: still not found.
  const r1 = fakeRes();
  routes.contextRoute(fakeReq({ id: B.id }, tokB, { query: { run: runA.id } }), r1);
  assert.equal(r1.statusCode, 404);
  // A's own token reads A, but cannot decide: that is the operator's hand, and only his.
  const r2 = fakeRes();
  routes.showRoute(fakeReq({ id: A.id }, tokA), r2);
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.body.pending[0].id, pA.id);
  const denied: Record<string, string>[] = [tokA, { "x-mc-admin": CONFIG.adminToken }, { "x-mc-admin": CONFIG.adminToken, "x-mc-operator": "1", "x-mc-session": "s1" }];
  for (const h of denied) {
    const res = fakeRes();
    await routes.decideRoute(fakeReq({ id: A.id, pid: pA.id }, h, { body: { decision: "approve" } }), res);
    assert.equal(res.statusCode, 403, JSON.stringify(Object.keys(h)));
  }
  assert.equal(retroProposals.get(pA.id)!.status, "pending");
  const ok = fakeRes();
  await routes.decideRoute(fakeReq({ id: A.id, pid: pA.id }, { "x-mc-admin": CONFIG.adminToken, "x-mc-operator": "1" }, { body: { decision: "dismiss" } }), ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(retroProposals.get(pA.id)!.status, "dismissed");
  const admin = fakeRes();
  await routes.runNowRoute(fakeReq({}, tokA, { body: { workspace: A.slug } }), admin);
  assert.equal(admin.statusCode, 403, "a workspace token never starts a retro");
});

test("isolation: the product workspace's sum is the only cross-workspace flow, and it is enums and counts — its own proposals become a backlog ticket on his yes", async () => {
  const A = mkWs("atlas-prod");
  seedWeek(A, { fix: "always redact the payroll export", dm: "Ping me when payroll is reconciled" });
  await startRetro(A, { source: "slot", slot: "2026-11-09@08", now: new Date(UNTIL), gather: deps, dispatch: (() => ({ run_id: "r-a" })) as any });
  const P = mkWs("home", { kind: "personal" });
  repos.create({ workspace_id: P.id, name: "chronos", path: REPO_ROOT });
  assert.equal(productWorkspace()?.id, P.id, "the workspace holding Chronos's own checkout");
  const seen: string[] = [];
  const r = await startRetro(P, { source: "slot", slot: "2026-11-09@08", now: new Date(UNTIL), product: true, gather: deps, dispatch: ((j: string) => { seen.push(j); return { run_id: "r-p" }; }) as any });
  assert.ok(seen.length, "the product step dispatches even on a quiet week of its own");
  assert.match(jobs.get(seen[0])!.goal, /improvement proposals for Chronos/);
  const bundle = retroContext(P, r.run!);
  const sum = bundle.product!.this_week as { workspaces: number; counts: Record<string, number> };
  assert.ok(sum.workspaces >= 2);
  for (const [k, v] of Object.entries(sum.counts)) { assert.ok(isFindingKey(k), k); assert.equal(typeof v, "number"); }
  assert.ok(sum.counts["verifier_aspect:queries"] >= 2, "A's counts are in the sum");
  const blob = JSON.stringify(bundle.product).toLowerCase();
  for (const w of ["payroll", "redact", A.slug, "atlas"]) assert.ok(!blob.includes(w), `the sum carries no "${w}"`);
  assert.equal(errOf(() => applyRetro(A, { run: retroRuns.list(A.id, 1)[0].id, product: [{ title: "Name the missing aspect in every verifier round", why: "generic 1", change: "x" }] })).status, 400, "only the product run proposes product changes");
  const out = applyRetro(P, { run: r.run!, product: [{ title: "Name the missing aspect in every verifier round", why: "verifier_aspect:queries 2 this week, 0 last week", change: "Put the failed aspect's ask in tellLine." }] });
  assert.equal(out.proposed[0].kind, "product");
  const approved = await decideProposal(P, out.proposed[0].id, { decision: "approve", by: "operator" });
  const t = tickets.list({ workspace_id: P.id }).find((x) => x.key === approved.ref)!;
  assert.equal(t.status, "backlog");
  assert.equal(t.repo_id, null, "no repo: nothing plans or builds it on its own");
});
