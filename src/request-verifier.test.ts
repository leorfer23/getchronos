/**
 * The verifier (src/request-verifier.ts) over real ledger rows: hand-offs filed the way the daemon
 * files them, the world's edges (gh, git, the repo's checks, the second reader, the terminal) stubbed.
 * One test drives the reader's real dispatch with the mock backend, to prove it never parks on an ask.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asks, db, jobs, kv, repos, runs, sessions, workspaces } from "./store.js";
import { requests } from "./store/requests.js";
import * as L from "./ledger.js";
import * as V from "./request-verifier.js";
import { draftHash } from "./ledger-model.js";
import { setRemoteReader } from "./pr-ownership.js";
import { writeSetting, _resetSettingsCache } from "./settings.js";
import { isReadOnlyRun } from "./runner.js";
import type { Outcome, Session } from "./types.js";

L.setLedgerPhaseProvider(() => ({ phase: "your_turn", line: null }));
L.setLedgerProgressProvider(() => null);
V.setVerifierDelay(0);

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const wt = fs.mkdtempSync(path.join(os.tmpdir(), "verifier-wt-"));

type World = {
  head: string; files: string[] | null; behind: number | null; gitHead: string; dirty: boolean;
  gates: Array<{ ok: boolean; output?: string }>; verdict: string | null; told: Array<{ sid: string; text: string }>;
  reviews: number; gateRuns: number; heavy: number; draft: { kind: "slack" | "email"; to: string | null; channel: string | null; subject: string | null; text: string | null } | null;
};
let w: World;
let stubs: Partial<V.VerifierDeps> = {};
function stub() {
  w = { head: HEAD_A, files: ["src/retry.ts", "src/retry.test.ts"], behind: 0, gitHead: HEAD_A, dirty: false, gates: [{ ok: true }], verdict: 'VERDICT {"pass":true,"reasons":["does what was asked"],"risks":[]}', told: [], reviews: 0, gateRuns: 0, heavy: 0, draft: null };
  stubs = {
    prRead: async () => ({ state: "OPEN", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: w.head, baseRefName: "main", files: w.files, ci: null, failing: [] }),
    behindBy: async () => w.behind,
    prDiff: async () => "diff --git a/src/retry.ts b/src/retry.ts\n+retry()",
    gitState: async () => ({ head: w.gitHead, dirty: w.dirty }),
    runGates: async (_ws, _cwd, gates) => { w.gateRuns++; return gates.map((g, i) => ({ name: g.name, cmd: g.cmd, ok: w.gates[i]?.ok ?? true, ms: 1200, output: w.gates[i]?.output ?? "ok" })); },
    heavy: async (_ws, _label, fn) => { w.heavy++; return fn(); },
    review: async () => { w.reviews++; return { text: w.verdict, run_id: "run-1", status: "success" }; },
    tell: async (sid, text) => { w.told.push({ sid, text }); return null; },
    draftText: async () => w.draft,
  };
  V.setVerifierDeps(stubs);
}

beforeEach(() => {
  db.exec("DELETE FROM request_verifications; DELETE FROM request_checks; DELETE FROM request_decisions; DELETE FROM request_deliverables; DELETE FROM request_terminals; DELETE FROM requests; DELETE FROM asks; DELETE FROM sessions;");
  L.resetLedgerMemory();
  V.resetVerifierMemory();
  kv.set("ledger.since", "2000-01-01T00:00:00.000Z");
  stub();
});

let n = 0;
function world(kind: "pr" | "ui" | "investigation" = "pr", gate = true) {
  const ws = workspaces.create({ slug: `acme-${Math.random().toString(36).slice(2, 8)}`, name: "acme", config_dir: `/tmp/vf-${Math.random()}` } as any);
  const repo = repos.create({ workspace_id: ws.id, name: `app${n}`, path: wt, git_remote: `https://github.com/acme${n}/app.git`, gate_cmds: gate ? JSON.stringify([{ name: "test", cmd: "npm test" }]) : null } as any);
  setRemoteReader(() => null); // drop pr-ownership's memo: the repo above is new
  const s = sessions.create({ workspace_id: ws.id, repo_id: repo.id, cwd: wt, goal: "retry failed uploads", goal_kind: kind, created_by: "operator", backend: "claude-code", model: "opus" } as any);
  L.onLedgerEvent({ topic: "session.started", session_id: s.id });
  const url = `https://github.com/acme${n++}/app/pull/12`;
  return { ws, repo, s: sessions.get(s.id)!, url };
}
let tick = 0;
function handOff(s: Session, over: Partial<Outcome> = {}): Outcome {
  const cur = sessions.get(s.id)!;
  const o: Outcome = { summary: "uploads retry now", changes: [], proof: [], prs: [], shots: [], ask: "merge", shipped: [], at: new Date(Date.now() + 1000 + tick++).toISOString(), ...over };
  sessions.setOutcome(s.id, o, cur.outcome ? [...cur.outcome_prev, cur.outcome] : cur.outcome_prev);
  L.syncSession(s.id);
  return o;
}
const reqOf = (s: Session) => requests.get(requests.primaryAt(s.id)!.request_id)!;
const mergeItem = (rid: string) => requests.items(rid).find((i) => i.action === "merge" && (i.status === "open" || i.status === "held"))!;
const latestCheck = (rid: string, name: string) => requests.checks(rid).filter((c) => c.name === name).pop();

test("a merge hand-off is checked, its PR head bound, and it is ready only once every gate passed", async () => {
  const { s, url } = world("pr");
  handOff(s, { prs: [url] });
  const r = reqOf(s);
  const out = await V.verifyRequest(r.id, { trigger: "outcome" });
  assert.equal(out.status, "done", out.reason ?? "");
  assert.equal(out.ready, true, out.reason ?? "");
  const item = mergeItem(r.id);
  assert.equal(item.target_hash, HEAD_A, "the PR head is bound onto the item");
  assert.equal(requests.deliverable(item.deliverable_id!)!.target_hash, HEAD_A);
  for (const name of ["pr_ready", "tests", "goal_test", "matches_request"]) assert.equal(latestCheck(r.id, name)?.status, "pass", name);
  assert.equal(latestCheck(r.id, "regression")?.status, "skip");
  assert.equal(latestCheck(r.id, "tests")!.target_hash, HEAD_A);
  assert.equal(latestCheck(r.id, "tests")!.evidence[0].meta?.output, "ok", "the check command's output is kept");
  assert.equal(w.heavy, 1, "the re-run holds a heavy slot");
  const q = L.queueView(undefined).items.find((i) => i.item_id === item.id)!;
  assert.equal(q.rank, 1);
  assert.match(q.line, /checks pass \(not checked: regression\)/);
  assert.equal(q.verification.ready, true);
  assert.equal(w.told.length, 0);
  // Same targets again: not repeated.
  assert.equal((await V.verifyRequest(r.id)).status, "skipped");
  assert.equal(w.reviews, 1);
});

test("the PR head moves: its checks go stale and it is not ready until checked again", async () => {
  const { s, url } = world("pr");
  handOff(s, { prs: [url] });
  const r = reqOf(s);
  await V.verifyRequest(r.id);
  const item = mergeItem(r.id);
  assert.equal(L.itemReadiness(r, item).ready, true);
  // Someone pushes: the sweep reads the new head and re-binds the item to it.
  w.head = HEAD_B;
  w.gitHead = HEAD_B;
  V.setVerifierDelay(60_000); // keep the re-check the sweep schedules from running inside this test
  await V.sweepVerifier();
  V.setVerifierDelay(0);
  const moved = mergeItem(r.id);
  assert.equal(moved.target_hash, HEAD_B);
  const rd = L.itemReadiness(requests.get(r.id)!, moved);
  assert.equal(rd.ready, false, "a pass on the old head is no pass on this one");
  assert.ok(rd.stale >= 4);
  const q = L.queueView(undefined).items.find((i) => i.item_id === moved.id)!;
  assert.equal(q.rank, 2);
  assert.match(q.line, /not ready/);
  // A yes given to the old head cannot be recorded.
  const yes = L.recordDecision({ request: r.id, decision: "yes", target_hash: HEAD_A });
  assert.equal(yes.ok, false);
  V.resetVerifierMemory();
  const again = await V.verifyRequest(r.id, { trigger: "head_moved" });
  assert.equal(again.ready, true);
  assert.equal(latestCheck(r.id, "tests")!.target_hash, HEAD_B);
  const detail = L.detailOf(requests.get(r.id)!, { operator: true });
  assert.ok(detail.checks.some((c: any) => c.stale && c.target_hash === HEAD_A));
  assert.ok(detail.checks.filter((c: any) => c.target_hash === HEAD_B).every((c: any) => !c.stale));
});

test("a UI hand-off without before/after screenshots fails, and the terminal is told why", async () => {
  const { s, url } = world("ui");
  handOff(s, { prs: [url], shots: [] });
  const r = reqOf(s);
  const out = await V.verifyRequest(r.id);
  assert.equal(out.ready, false);
  const shots = latestCheck(r.id, "shots")!;
  assert.equal(shots.status, "fail");
  assert.match(shots.note!, /before\/after screenshots/);
  assert.equal(w.told.length, 1);
  assert.equal(w.told[0].sid, s.id);
  assert.match(w.told[0].text, /\[verifier\] Not ready.*round 1 of 2.*before\/after screenshots/);
  const q = L.queueView(undefined).items.find((i) => i.request_id === r.id)!;
  assert.equal(q.rank, 5, "a failing item is heard last");
  assert.ok(q.verification.failed.some((f: any) => f.name === "shots"));
});

test("a UI hand-off with a phone and a desktop pair carries them as evidence for the approval card", async () => {
  const { s, url } = world("ui");
  sessions.addShown(s.id, { caption: "step 1: open the uploads page", shots: [{ name: "w1.png", label: "step" }], at: new Date(Date.now() + 500).toISOString() });
  handOff(s, {
    prs: [url],
    shots: [
      { name: "b1.png", label: "before-uploads-phone" }, { name: "a1.png", label: "after-uploads-phone" },
      { name: "b2.png", label: "before-uploads-desktop" }, { name: "a2.png", label: "after-uploads-desktop" },
    ],
  });
  const r = reqOf(s);
  const out = await V.verifyRequest(r.id);
  assert.equal(latestCheck(r.id, "shots")!.status, "pass");
  assert.equal(latestCheck(r.id, "walkthrough")!.status, "pass");
  assert.equal(out.ready, true, out.reason ?? "");
  const q = L.queueView(undefined).items.find((i) => i.request_id === r.id)!;
  const shots = q.verification.evidence.find((c: any) => c.name === "shots")!;
  assert.deepEqual(shots.evidence.map((e: any) => `${e.meta.side}/${e.meta.viewport}`).sort(), ["after/desktop", "after/phone", "before/desktop", "before/phone"]);
});

test("no check command configured: tests is a skip with that reason — never a pass", async () => {
  const { s, url } = world("pr", false);
  handOff(s, { prs: [url] });
  const r = reqOf(s);
  await V.verifyRequest(r.id);
  const t = latestCheck(r.id, "tests")!;
  assert.equal(t.status, "skip");
  assert.match(t.note!, /no check command is configured/);
  assert.equal(w.gateRuns, 0);
  const q = L.queueView(undefined).items.find((i) => i.request_id === r.id)!;
  assert.match(q.line, /not checked: tests, regression/, "the gap is said with the item");
});

test("the worktree is not at the PR head: the suite is not run against something else", async () => {
  const { s, url } = world("pr");
  w.dirty = true;
  handOff(s, { prs: [url] });
  const r = reqOf(s);
  await V.verifyRequest(r.id);
  assert.equal(latestCheck(r.id, "tests")!.status, "skip");
  assert.match(latestCheck(r.id, "tests")!.note!, /uncommitted changes/);
  assert.equal(w.gateRuns, 0);
});

test("a red suite fails with its output and goes back to the terminal", async () => {
  const { s, url } = world("pr");
  w.gates = [{ ok: false, output: "1 failing\n  retry › gives up after 3\n[exit 1]" }];
  handOff(s, { prs: [url] });
  const r = reqOf(s);
  const out = await V.verifyRequest(r.id);
  assert.equal(out.ready, false);
  const t = latestCheck(r.id, "tests")!;
  assert.equal(t.status, "fail");
  assert.match(String(t.evidence[0].meta?.output), /gives up after 3/);
  assert.match(w.told[0].text, /tests: the repo's checks fail/);
});

test("two rounds at most: the third failure is not told — the request surfaces as not ready with the reason", async () => {
  const { s, url } = world("pr");
  w.verdict = 'VERDICT {"pass":false,"reasons":["the retry is never awaited"]}';
  handOff(s, { prs: [url] });
  const r = reqOf(s);
  const one = await V.verifyRequest(r.id);
  assert.equal(one.told, true);
  handOff(s, { prs: [url], summary: "awaited it now" }); // round 2: a new hand-off
  const two = await V.verifyRequest(r.id);
  assert.equal(two.told, true);
  assert.match(w.told[1].text, /round 2 of 2.*last round/);
  handOff(s, { prs: [url], summary: "really awaited now" });
  const three = await V.verifyRequest(r.id);
  assert.equal(three.told, false);
  assert.equal(w.told.length, 2, "no third line typed into the terminal");
  assert.match(three.reason!, /not ready after 2 rounds: matches_request: the retry is never awaited/);
  assert.equal(requests.roundsTold(r.id), 2);
  const detail = L.detailOf(requests.get(r.id)!, { operator: true });
  assert.equal(detail.verification.rounds_told, 2);
  assert.match(detail.verification.last!.reason!, /not ready after 2 rounds/);
});

test("a backend PR with code and no test fails goal_test", async () => {
  const { s, url } = world("pr");
  w.files = ["src/retry.ts"];
  handOff(s, { prs: [url] });
  const r = reqOf(s);
  await V.verifyRequest(r.id);
  assert.equal(latestCheck(r.id, "goal_test")!.status, "fail");
});

test("the reader gave no verdict: matches_request is skipped, and a skipped gate is not ready", async () => {
  const { s, url } = world("pr");
  w.verdict = "mock: I could not decide";
  handOff(s, { prs: [url] });
  const r = reqOf(s);
  const out = await V.verifyRequest(r.id);
  assert.equal(latestCheck(r.id, "matches_request")!.status, "skip");
  assert.equal(out.ready, false);
  assert.equal(w.told.length, 0, "nothing the terminal can fix: not told");
});

test("a PR of another workspace's repo is never read with this workspace's credentials", async () => {
  const { s } = world("pr");
  const other = world("pr");
  handOff(s, { prs: [other.url] });
  const r = reqOf(s);
  let reads = 0;
  V.setVerifierDeps({ ...stubs, prRead: async () => { reads++; throw new Error("must not be called"); } });
  await V.verifyRequest(r.id);
  assert.equal(reads, 0);
  assert.match(latestCheck(r.id, "pr_ready")!.note!, /belongs to another workspace/);
  assert.equal(w.reviews, 0, "nor is it handed to a reader");
});

test("a draft: its words re-hashed with the ledger's own draftHash and bound; changed words fail", async () => {
  const { s } = world("investigation");
  w.draft = { kind: "slack", to: null, channel: "#ops", subject: null, text: "signups are up 12%" };
  const hash = draftHash({ channel: "slack", to: "#ops", subject: "", text: "signups are up 12%" });
  L.noteDraft(s.id, { label: "Slack draft → #ops", tool: { name: "mcp__x__slack_send_message_draft" }, target: { channel: "slack", to: "#ops", hash } });
  const r = reqOf(s);
  await V.verifyRequest(r.id, { trigger: "draft" });
  assert.equal(latestCheck(r.id, "draft_bound")!.status, "pass");
  assert.equal(latestCheck(r.id, "draft_bound")!.target_hash, hash);
  // Unbound by the hook (no hash): the verifier binds it to the words on file.
  const s2 = world("investigation").s;
  L.noteDraft(s2.id, { label: "Slack draft → #ops", tool: { name: "mcp__x__slack_send_message_draft" }, target: { channel: "slack", to: "#ops" } });
  const r2 = reqOf(s2);
  assert.equal(requests.items(r2.id).find((i) => i.action === "send")!.target_hash, null);
  await V.verifyRequest(r2.id, { trigger: "draft" });
  assert.equal(requests.items(r2.id).find((i) => i.action === "send")!.target_hash, hash, "bound to exactly these words");
  // Words that differ from what the hook bound: not ready.
  const s3 = world("investigation").s;
  L.noteDraft(s3.id, { label: "Slack draft → #ops", tool: { name: "mcp__x__slack_send_message_draft" }, target: { channel: "slack", to: "#ops", hash: draftHash({ channel: "slack", to: "#ops", text: "older words" }) } });
  const r3 = reqOf(s3);
  await V.verifyRequest(r3.id, { trigger: "draft" });
  assert.equal(latestCheck(r3.id, "draft_bound")!.status, "fail");
});

test("an analysis: the reader judges whether it answers the question and states its sources", async () => {
  const { s } = world("investigation");
  w.verdict = 'VERDICT {"pass":true,"reasons":["answers it"],"aspects":{"queries":false,"crosscheck":true,"assumptions":true}}';
  handOff(s, { ask: "review", summary: "412 signups last week" });
  const r = reqOf(s);
  const out = await V.verifyRequest(r.id);
  assert.equal(latestCheck(r.id, "matches_request")!.status, "pass");
  assert.equal(latestCheck(r.id, "queries")!.status, "fail");
  assert.equal(out.ready, false);
  assert.match(w.told[0].text, /queries: missing: the queries or sources/);
});

test("the verifier off for a workspace: nothing runs on its own — the operator's re-run still does", async () => {
  const { ws, s, url } = world("pr");
  writeSetting("verifier.enabled", false, ws.id);
  _resetSettingsCache();
  handOff(s, { prs: [url] });
  const r = reqOf(s);
  assert.equal(V.verifierOn(ws.id), false);
  assert.equal((await V.verifyRequest(r.id, { trigger: "outcome" })).status, "skipped");
  V.onVerifierEvent({ topic: "ledger.item_raised", request_id: r.id, workspace_id: ws.id, action: "merge" });
  await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(requests.verifications(r.id).length, 0);
  assert.equal((await V.verifyRequest(r.id, { trigger: "manual", force: true })).status, "done");
});

test("a hand-off raising a merge triggers a pass through the bus event the ledger publishes", async () => {
  const { s, url } = world("pr");
  const seen: any[] = [];
  const { bus } = await import("./bus.js");
  const on = (e: any) => { if (e.topic === "ledger.item_raised") { seen.push(e); V.onVerifierEvent(e); } };
  bus.on("event", on);
  try {
    handOff(s, { prs: [url] });
    const r = reqOf(s);
    assert.equal(seen.length, 1);
    for (let i = 0; i < 100 && requests.lastVerification(r.id)?.status !== "done"; i++) await new Promise((ok) => setTimeout(ok, 10));
    assert.equal(requests.lastVerification(r.id)?.status, "done");
    assert.equal(requests.lastVerification(r.id)?.trigger, "outcome");
  } finally {
    bus.off("event", on);
  }
});

test("the second reader is a read-only run: it never parks on an ask, and cannot write or run commands", async () => {
  const ws = workspaces.create({ slug: `rd-${Math.random().toString(36).slice(2, 8)}`, name: "reader", config_dir: `/tmp/vf-${Math.random()}`, sandbox_mode: "off" } as any);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verifier-reader-"));
  const pending = V.defaultVerifierDeps.review(ws, "check the hand-off\n!sleep: 600", { cwd, backend: "mock", model: "", requestId: "feedface-0000" });
  let job: any;
  for (let i = 0; i < 200 && !job; i++) {
    job = jobs.list().find((j) => j.workspace_id === ws.id && j.name.startsWith("review:verify-"));
    if (!job) await new Promise((ok) => setTimeout(ok, 5));
  }
  assert.ok(job, "a reader job was dispatched");
  assert.ok(isReadOnlyRun(job.name), "review: is a read-only run (runner.ts READONLY_RUN_PREFIXES)");
  assert.match(job.disallowed_tools, /\bEdit\b.*\bWrite\b.*\bBash\b/);
  const run = db.prepare("SELECT * FROM runs WHERE job_id = ?").get(job.id) as any;
  // The reader asks something mid-run — exactly what a writing run would park on.
  asks.create({ run_id: run.id, job_id: job.id, question: "should I also check the docs?" });
  const out = await pending;
  assert.equal(out.status, "success", "finished, not paused");
  assert.notEqual(runs.get(run.id)!.status, "paused");
});
