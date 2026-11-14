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
import { normalizeDataDiff } from "./data-diff.js";
import { repoMemory } from "./store/review-memory.js";
import { setRemoteReader } from "./pr-ownership.js";
import { setRepoMemoryEdges } from "./repo-memory.js";
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
  prompts: string[];
  /** The code reviewer (label "code"): its answer, its runs, its prompts and the engine each ran on. */
  diff: string; codeVerdict: string | null; codeReviews: number; codePrompts: string[]; codeEngines: string[]; passing: string[];
  /** Every gh call the repo memory made, GitHub's answer to it, and the helper model's rewrite. */
  gh: string[][]; ghData: unknown; distilled: string | null;
};
let w: World;
let stubs: Partial<V.VerifierDeps> = {};
function stub() {
  w = {
    head: HEAD_A, files: ["src/retry.ts", "src/retry.test.ts"], behind: 0, gitHead: HEAD_A, dirty: false, gates: [{ ok: true }], verdict: 'VERDICT {"pass":true,"reasons":["does what was asked"],"risks":[]}', told: [], reviews: 0, gateRuns: 0, heavy: 0, draft: null, prompts: [],
    diff: "diff --git a/src/retry.ts b/src/retry.ts\n+retry()", codeVerdict: 'REVIEW {"findings":[]}', codeReviews: 0, codePrompts: [], codeEngines: [], passing: [],
    gh: [], ghData: { data: { repository: { pullRequests: { nodes: [] } } } }, distilled: null,
  };
  stubs = {
    prRead: async () => ({ state: "OPEN", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: w.head, baseRefName: "main", files: w.files, ci: null, failing: [], passing: w.passing }),
    behindBy: async () => w.behind,
    prDiff: async () => w.diff,
    gitState: async () => ({ head: w.gitHead, dirty: w.dirty }),
    runGates: async (_ws, _cwd, gates) => { w.gateRuns++; return gates.map((g, i) => ({ name: g.name, cmd: g.cmd, ok: w.gates[i]?.ok ?? true, ms: 1200, output: w.gates[i]?.output ?? "ok" })); },
    heavy: async (_ws, _label, fn) => { w.heavy++; return fn(); },
    review: async (_ws, prompt, o) => {
      if (o.label === "code") { w.codeReviews++; w.codePrompts.push(prompt); w.codeEngines.push(`${o.backend} ${o.model}`); return { text: w.codeVerdict, run_id: `code-${w.codeReviews}`, status: "success" }; }
      w.reviews++; w.prompts.push(prompt); return { text: w.verdict, run_id: "run-1", status: "success" };
    },
    tell: async (sid, text) => { w.told.push({ sid, text }); return null; },
    draftText: async () => w.draft,
  };
  V.setVerifierDeps(stubs);
  // The repo memory reads GitHub and asks a helper model: both stubbed, so a test never reaches either.
  setRepoMemoryEdges({ gh: async (args) => { w.gh.push(args); return JSON.stringify(w.ghData); }, distill: async () => w.distilled });
}

beforeEach(() => {
  db.exec("DELETE FROM request_verifications; DELETE FROM request_checks; DELETE FROM request_decisions; DELETE FROM request_deliverables; DELETE FROM request_terminals; DELETE FROM requests; DELETE FROM asks; DELETE FROM sessions; DELETE FROM code_reviews; DELETE FROM repo_review_memory;");
  L.resetLedgerMemory();
  V.resetVerifierMemory();
  kv.set("ledger.since", "2000-01-01T00:00:00.000Z");
  stub();
});

let n = 0;
type WorldOpts = { repoPath?: string; repoName?: string; remote?: string; backend?: string; model?: string | null; ws?: Record<string, unknown> };
function world(kind: "pr" | "ui" | "investigation" = "pr", gate = true, goal = "retry failed uploads", o: WorldOpts = {}) {
  const ws = workspaces.create({ slug: `acme-${Math.random().toString(36).slice(2, 8)}`, name: "acme", config_dir: `/tmp/vf-${Math.random()}`, ...o.ws } as any);
  const remote = o.remote ?? `https://github.com/acme${n}/app.git`;
  const repo = repos.create({ workspace_id: ws.id, name: o.repoName ?? `app${n}`, path: o.repoPath ?? wt, git_remote: remote, gate_cmds: gate ? JSON.stringify([{ name: "test", cmd: "npm test" }]) : null } as any);
  setRemoteReader(() => null); // drop pr-ownership's memo: the repo above is new
  const s = sessions.create({ workspace_id: ws.id, repo_id: repo.id, cwd: wt, goal, goal_kind: kind, created_by: "operator", backend: o.backend ?? "claude-code", model: o.model === undefined ? "opus" : o.model } as any);
  L.onLedgerEvent({ topic: "session.started", session_id: s.id });
  n++;
  const url = `https://github.com/${remote.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")}/pull/12`;
  return { ws, repo, s: sessions.get(s.id)!, url };
}
/** A checkout on disk with these files: what makes a repo a data repo is read from it. */
const checkout = (files: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verifier-data-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
};
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

/** A Slack draft announced by its terminal's hook, its words on file and bound. */
function draftIn(s: Session, text: string) {
  w.draft = { kind: "slack", to: null, channel: "#team", subject: null, text };
  L.noteDraft(s.id, { label: "Slack draft → #team", tool: { name: "mcp__x__slack_send_message_draft" }, target: { channel: "slack", to: "#team", hash: draftHash({ channel: "slack", to: "#team", subject: "", text }) } });
}
const TRIO = ["queries", "crosscheck", "assumptions"];

test("an analysis whose answer states no figures is not sent back for queries, a cross-check or assumptions", async () => {
  // Anonymized from real hand-offs the verifier sent back for these three alone — with a reader as strict as it was then.
  w.verdict = 'VERDICT {"pass":true,"reasons":["answers it"],"aspects":{"queries":false,"crosscheck":false,"assumptions":false}}';
  const cases: Array<{ goal: string; draft?: string; handoff?: Partial<Outcome> }> = [
    { goal: "Inbox: data tool setup: who gets access to the 3 connections", draft: "Thanks for setting this up! Please add the analytics team and me to the group that can use the 3 connections. We will manage the rest ourselves and add people later." },
    { goal: "Inbox: ask the vendor contact for a cost-report backfill", draft: "Hi! The new cost export is loading fine. One gap is left: the weeks before it started have no cost in our tables. Could you open a support case to backfill the report into the same bucket? Let me know when it lands and I will load it." },
    { goal: "Inbox: is request R-042 the second card-data request?", draft: "Yes, R-042 is the one: the card volume, item counts and rates request. It shipped in #311 and its totals were checked against the source." },
    { goal: "Job check: 1 red — find why", handoff: { ask: "review", summary: "The nightly cleanup job timed out because the machine was asleep when it fired at 02:00; it never reached the API and was killed at the next wake (exit 143).", proof: ["run log: started 02:00:21Z during a dark wake, killed at 02:13:23Z"] } },
  ];
  for (const c of cases) {
    const { s } = world("investigation", true, c.goal);
    if (c.draft) draftIn(s, c.draft);
    if (c.handoff) handOff(s, c.handoff);
    const r = reqOf(s);
    const out = await V.verifyRequest(r.id, { trigger: c.draft ? "draft" : "outcome" });
    for (const name of TRIO) {
      const chk = latestCheck(r.id, name)!;
      assert.equal(chk.status, "na", `${c.goal}: ${name}`);
      assert.match(chk.note!, /no figures/);
    }
    assert.equal(latestCheck(r.id, "matches_request")!.status, "pass");
    assert.equal(out.ready, true, `${c.goal}: ${out.reason ?? ""}`);
    assert.equal(out.told, false, c.goal);
    assert.ok(!/- queries:/.test(w.prompts.at(-1)!), `${c.goal}: the reader is not asked for queries`);
  }
  assert.equal(w.told.length, 0, "no rework round for any of them");
});

test("a numeric answer still owes all three: no query behind its figures is sent back, from a hand-off or a draft", async () => {
  const { s } = world("investigation", true, "Inbox: ask the vendor contact for a cost-report backfill");
  w.verdict = 'VERDICT {"pass":true,"reasons":["answers it"],"aspects":{"queries":false,"crosscheck":true,"assumptions":false}}';
  handOff(s, { ask: "review", summary: "The gap is real: the account's cost is $0/day from the 2nd to the 31st, $310.50 the day before and $455 the day after.", proof: ["the daily cost table, by day"] });
  const r = reqOf(s);
  const out = await V.verifyRequest(r.id);
  assert.match(w.prompts[0], /it states what may be such figures: \$0\/day, \$310\.50, \$455\)/);
  assert.deepEqual(TRIO.map((name) => latestCheck(r.id, name)!.status), ["fail", "pass", "fail"]);
  assert.equal(out.ready, false);
  assert.match(w.told[0].text, /queries: missing: the queries or sources.*assumptions: missing/);
  // A draft with figures is told just the same.
  const d = world("investigation", true, "Inbox: how many migrated accounts got a concession?").s;
  w.verdict = 'VERDICT {"pass":true,"reasons":["answers it"],"aspects":{"queries":false,"crosscheck":false,"assumptions":true}}';
  draftIn(d, "120 of 64.5K migrated accounts got one (0.2%), $180K since 2023.");
  await V.verifyRequest(reqOf(d).id, { trigger: "draft" });
  assert.match(w.told[1].text, /queries: missing.*crosscheck: missing/);
});

test("figures the reader says are not derived from data: n/a with its reason, never a pass; an n/a without one is not counted", async () => {
  const { s } = world("investigation", true, "Inbox: is request R-042 the second card-data request?");
  w.verdict = 'VERDICT {"pass":true,"reasons":["answers it"],"aspects":{"queries":"n/a: the only figure is context quoted from the shipped PR; the answer is a yes/no","crosscheck":"n/a: same","assumptions":"n/a"}}';
  handOff(s, { ask: "review", summary: "Yes, R-042 is the card-data request, shipped in #311. Still open on it: the 1.5-2.5% fee gap." });
  const r = reqOf(s);
  const out = await V.verifyRequest(r.id);
  assert.match(w.prompts[0], /may be such figures: 1\.5-2\.5%\)/);
  assert.equal(latestCheck(r.id, "queries")!.status, "na");
  assert.match(latestCheck(r.id, "queries")!.note!, /says the reader: the only figure is context quoted/);
  assert.equal(latestCheck(r.id, "crosscheck")!.status, "na");
  assert.equal(latestCheck(r.id, "assumptions")!.status, "skip");
  assert.equal(w.told.length, 0);
  assert.equal(out.ready, true, out.reason ?? "");
  const q = L.queueView(undefined).items.find((i) => i.request_id === r.id)!;
  assert.match(q.line, /checks pass \(not checked: assumptions\)/, "an n/a with no reason is said with the yes, as a gap");
});

test("the gates are as strict as before: a draft that says live when nothing was published fails and is told", async () => {
  const { s } = world("investigation", true, "Inbox: is the rebuilt report published?");
  w.verdict = 'VERDICT {"pass":false,"reasons":["it says the report is live, but nothing shows it was published"],"aspects":{"queries":true,"crosscheck":true,"assumptions":true}}';
  draftIn(s, "Yes, it is live: the report was rebuilt and published, and it prints from the page's menu.");
  const r = reqOf(s);
  const out = await V.verifyRequest(r.id, { trigger: "draft" });
  assert.equal(latestCheck(r.id, "matches_request")!.status, "fail");
  assert.equal(out.ready, false);
  assert.equal(w.told.length, 1);
  assert.match(w.told[0].text, /matches_request: it says the report is live/);
  assert.ok(!/queries|crosscheck|assumptions/.test(w.told[0].text), "the analysis slots are not what it is sent back for");
  assert.deepEqual(TRIO.map((name) => latestCheck(r.id, name)!.status), ["na", "na", "na"], "and the reader's true is no pass for them either");
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
  // The daemon's own timers are unref'd, so while the run is held or between its events nothing may
  // keep this test's event loop alive: on CI node cancelled the await before it settled ("Promise
  // resolution is still pending but the event loop has already resolved"). Hold it open here.
  const keepAlive = setInterval(() => {}, 1000);
  const out = await pending.finally(() => clearInterval(keepAlive));
  assert.equal(out.status, "success", "finished, not paused");
  assert.notEqual(runs.get(run.id)!.status, "paused");
});

// ───────────────────────────── data PRs: the data diff ─────────────────────────────

const ORDERS_DIFF = {
  range: "2026-10-01..2026-10-07",
  models: [{ name: "fct_orders", rows: { before: 1200, after: 1188 }, aggregates: [{ name: "sum(amount)", before: 52340, after: 52101 }], cmd: "select count(*), sum(amount) from fct_orders where order_day between '2026-10-01' and '2026-10-07'" }],
  tests: [{ cmd: "dbt build -s fct_orders", result: "Done. PASS=12 WARN=0 ERROR=0 SKIP=0 TOTAL=12" }],
};

test("data_diff is owed only by a data repo's PR that changes models: told back without one, a pass with one, n/a elsewhere", async () => {
  const { s, url } = world("pr", true, "fix the order totals", { repoPath: checkout({ "dbt_project.yml": "name: shop" }) });
  w.files = ["models/marts/fct_orders.sql", "tests/assert_order_totals.sql"];
  handOff(s, { prs: [url] });
  const r = reqOf(s);
  const one = await V.verifyRequest(r.id);
  assert.equal(one.ready, false);
  assert.equal(latestCheck(r.id, "data_diff")!.status, "fail");
  assert.match(w.told[0].text, /data_diff: this PR changes 1 model\/SQL\/transform file \(models\/marts\/fct_orders\.sql\) in a data repo and the hand-off has no data diff/);
  assert.match(w.told[0].text, /--data-diff diff\.json/);
  assert.match(w.told[0].text, /own warehouse tools and vars \(`mc vars`\)/);
  handOff(s, { prs: [url], summary: "order totals fixed, with the data diff", data_diff: normalizeDataDiff(ORDERS_DIFF)! });
  const two = await V.verifyRequest(r.id);
  const dd = latestCheck(r.id, "data_diff")!;
  assert.equal(dd.status, "pass", dd.note!);
  assert.match(dd.note!, /dbt build -s fct_orders → Done\. PASS=12/);
  assert.equal(two.ready, true, two.reason ?? "");
  // The same files in a repo that is not a data repo owe no data diff: n/a — not missing, not a pass.
  const app = world("pr");
  w.files = ["models/marts/fct_orders.sql", "tests/assert_order_totals.sql"];
  handOff(app.s, { prs: [app.url] });
  const r2 = reqOf(app.s);
  const out = await V.verifyRequest(r2.id);
  assert.equal(latestCheck(r2.id, "data_diff")!.status, "na");
  assert.equal(out.ready, true, out.reason ?? "");
  const q = L.queueView(undefined).items.find((i) => i.request_id === r2.id)!;
  assert.match(q.line, /checks pass \(not checked: regression\)/, "an n/a slot is not said as a gap");
});

test("the operator's word on a repo wins: a repo set as a data repo owes the diff, one set as not owes nothing", async () => {
  const yes = world("pr", true, "fix the export", { repoPath: checkout({ "src/export.ts": "" }) });
  repos.update(yes.repo.id, { data_repo: true });
  w.files = ["sql/export.sql", "src/export.test.ts"];
  handOff(yes.s, { prs: [yes.url] });
  await V.verifyRequest(reqOf(yes.s).id);
  assert.equal(latestCheck(reqOf(yes.s).id, "data_diff")!.status, "fail");
  const no = world("pr", true, "fix the export", { repoPath: checkout({ "dbt_project.yml": "" }) });
  repos.update(no.repo.id, { data_repo: false });
  handOff(no.s, { prs: [no.url] });
  await V.verifyRequest(reqOf(no.s).id);
  const c = latestCheck(reqOf(no.s).id, "data_diff")!;
  assert.equal(c.status, "na");
  assert.match(c.note!, /setting says it is not a data repo/);
});

test("a swing past the workspace's threshold is told back until it is explained; the threshold is a setting", async () => {
  const { ws, s, url } = world("pr", true, "fix the activity rollup", { repoPath: checkout({ "pipelines/dags/daily_activity.py": "" }) });
  w.files = ["pipelines/dags/daily_activity.py", "pipelines/dags/tests/test_daily_activity.py"];
  const swing = {
    range: "2026-09-20..2026-09-22",
    models: [{ name: "daily_activity", rows: { before: 3, after: 3 }, aggregates: [{ name: "active_minutes", before: 12400, after: 56300 } as Record<string, unknown>], cmd: "select day, sum(active_minutes) from daily_activity where day between '2026-09-20' and '2026-09-22' group by 1" }],
  };
  handOff(s, { prs: [url], data_diff: normalizeDataDiff(swing)! });
  const r = reqOf(s);
  await V.verifyRequest(r.id);
  assert.equal(latestCheck(r.id, "data_diff")!.status, "fail");
  assert.match(w.told[0].text, /daily_activity\.active_minutes moved 12,400 → 56,300 \(\+354%\), past ±20%, unexplained/);
  // This workspace allows more: the same numbers are no swing to explain.
  writeSetting("verifier.data_swing_pct", 400, ws.id);
  _resetSettingsCache();
  await V.verifyRequest(r.id, { trigger: "manual", force: true });
  assert.equal(latestCheck(r.id, "data_diff")!.status, "pass");
  writeSetting("verifier.data_swing_pct", null, ws.id);
  _resetSettingsCache();
  // Back at ±20%, explained on the hand-off: a pass that says the swing and why.
  swing.models[0].aggregates[0].explain = "late close events now count toward a session's full length; checked against the raw events";
  handOff(s, { prs: [url], summary: "the swing is explained", data_diff: normalizeDataDiff(swing)! });
  await V.verifyRequest(r.id);
  const dd = latestCheck(r.id, "data_diff")!;
  assert.equal(dd.status, "pass", dd.note!);
  assert.match(dd.note!, /explained: daily_activity\.active_minutes \+354% — late close events/);
});

// ───────────────────────────── the independent code review ─────────────────────────────

test("the code review's findings go back as one round; justified while the head stands still they are settled, not re-read", async () => {
  const { s, url } = world("pr");
  w.codeVerdict = 'REVIEW {"findings":[{"where":"src/retry.ts:12","what":"the retry is never awaited","fix":"await it"},{"where":"src/retry.ts:30","what":"no test covers giving up after 3 tries"}]}';
  handOff(s, { prs: [url] });
  const r = reqOf(s);
  const one = await V.verifyRequest(r.id);
  assert.equal(one.ready, false);
  assert.equal(latestCheck(r.id, "code_review")!.status, "fail");
  assert.equal(w.told.length, 1, "every finding in one round");
  assert.match(w.told[0].text, /round 1 of 2.*code_review: 2 findings .*R1 src\/retry\.ts:12 — the retry is never awaited \(fix: await it\); R2 src\/retry\.ts:30 — no test covers giving up/);
  assert.match(w.told[0].text, /--proof "R1 fixed: <how>"/);
  handOff(s, { prs: [url], proof: ["R1 justified: upload() awaits the promise it returns, one level up", "R2 justified: retry.int.test.ts gives up after 3 tries and runs in CI"] });
  const two = await V.verifyRequest(r.id);
  assert.equal(w.codeReviews, 1, "one review for one head");
  const cr = latestCheck(r.id, "code_review")!;
  assert.equal(cr.status, "pass", cr.note!);
  assert.match(cr.note!, /2 findings justified on the hand-off, not re-read .*R1: upload\(\) awaits/);
  assert.deepEqual(cr.evidence.filter((e) => e.ref.startsWith("finding:")).map((e) => e.ref), ["finding:R1", "finding:R2"], "the findings ride on the check, for him");
  assert.equal(two.ready, true, two.reason ?? "");
});

test("a pushed head is read again with the open findings and what the hand-off says of each; one still open is told in the next round", async () => {
  const { s, url } = world("pr");
  w.codeVerdict = 'REVIEW {"findings":[{"where":"src/retry.ts:12","what":"the retry is never awaited"},{"where":"src/api.ts:40","what":"the new route skips the workspace check"}]}';
  handOff(s, { prs: [url] });
  const r = reqOf(s);
  await V.verifyRequest(r.id);
  // R1 fixed by a push (a new head, a new diff), R2 argued; the reviewer takes the fix, not the argument.
  w.head = HEAD_B;
  w.gitHead = HEAD_B;
  w.diff += "\n+await retry()";
  w.codeVerdict = 'REVIEW {"findings":[],"resolved":{"R1":true,"R2":"no: any workspace token can still call it"}}';
  handOff(s, { prs: [url], summary: "awaited it", proof: ["R1 fixed: awaited in upload()", "R2 justified: the route is only linked from the operator's page"] });
  const two = await V.verifyRequest(r.id);
  assert.equal(w.codeReviews, 2, "a new head is read again");
  assert.match(w.codePrompts[1], /R1 · src\/retry\.ts:12 — the retry is never awaited The author says: fixed — awaited in upload\(\)\./);
  assert.match(w.codePrompts[1], /R2 · src\/api\.ts:40 — the new route skips the workspace check The author says: justified — the route is only linked/);
  const cr = latestCheck(r.id, "code_review")!;
  assert.equal(cr.status, "fail");
  assert.match(cr.note!, /R2 src\/api\.ts:40 — the new route skips the workspace check \[not settled: any workspace token can still call it\]/);
  assert.ok(!/R1 src/.test(cr.note!), "the accepted fix is not told again");
  assert.match(w.told[1].text, /round 2 of 2.*code_review/);
  assert.equal(two.ready, false);
  // Arguing it again without a push does not settle what the reviewer turned down at this head.
  handOff(s, { prs: [url], summary: "awaited it", proof: ["R1 fixed: awaited in upload()", "R2 justified: really, only the operator's page links it"] });
  await V.verifyRequest(r.id);
  assert.equal(w.codeReviews, 2);
  assert.match(latestCheck(r.id, "code_review")!.note!, /already turned that down at this head/);
});

test("one code review per head: the same head is not read twice; a clean rebase carries the review over; a new diff is read", async () => {
  const { s, url } = world("pr");
  handOff(s, { prs: [url] });
  const r = reqOf(s);
  await V.verifyRequest(r.id);
  assert.equal(w.codeReviews, 1);
  handOff(s, { prs: [url], summary: "uploads retry now (summary reworded)" });
  await V.verifyRequest(r.id);
  assert.equal(w.codeReviews, 1, "a new hand-off on the same head reads nothing again");
  // Rebased: a new head, byte-for-byte the same diff.
  w.head = HEAD_B;
  w.gitHead = HEAD_B;
  await V.verifyRequest(r.id, { trigger: "head_moved", force: true });
  assert.equal(w.codeReviews, 1, "the same diff on a new head is carried over");
  assert.match(latestCheck(r.id, "code_review")!.note!, /same diff as the review at aaaaaaa: not read again/);
  w.head = "c".repeat(40);
  w.gitHead = w.head;
  w.diff += "\n+backoff()";
  await V.verifyRequest(r.id, { trigger: "head_moved", force: true });
  assert.equal(w.codeReviews, 2, "a changed diff is read");
});

test("the code reviewer is never the engine that wrote the PR", async () => {
  const opus = world("pr");
  handOff(opus.s, { prs: [opus.url] });
  await V.verifyRequest(reqOf(opus.s).id);
  assert.deepEqual(w.codeEngines, ["claude-code sonnet"], "written on opus, read on sonnet");
  const sonnet = world("pr", true, "retry failed uploads", { model: "sonnet" });
  handOff(sonnet.s, { prs: [sonnet.url] });
  await V.verifyRequest(reqOf(sonnet.s).id);
  assert.equal(w.codeEngines[1], "claude-code opus", "written on sonnet, read on opus");
  // No model on the terminal: it ran on its workspace's default, and that is the writer's model.
  const dflt = world("pr", true, "retry failed uploads", { model: null, ws: { default_model: "sonnet" } });
  handOff(dflt.s, { prs: [dflt.url] });
  await V.verifyRequest(reqOf(dflt.s).id);
  assert.equal(w.codeEngines[2], "claude-code opus");
  // The workspace's review engine is the writer's own: nobody independent reads it — a skip that says why.
  const same = world("pr", true, "retry failed uploads", { backend: "codex", model: "gpt-x", ws: { review_backend: "codex", review_model: "gpt-x" } });
  handOff(same.s, { prs: [same.url] });
  await V.verifyRequest(reqOf(same.s).id);
  assert.equal(w.codeEngines.length, 3, "no review dispatched");
  const cr = latestCheck(reqOf(same.s).id, "code_review")!;
  assert.equal(cr.status, "skip");
  assert.match(cr.note!, /same engine as the writer .*no independent review/);
});

test("the reviewer holds a PR to its own workspace's repo memory and corrections — never another workspace's, same repo and remote", async () => {
  const remote = "https://github.com/shared-org/app.git";
  const a = world("pr", true, "retry failed uploads", { repoName: "app", remote });
  const b = world("pr", true, "retry failed uploads", { repoName: "app", remote });
  assert.equal(a.url, b.url);
  repoMemory.save(a.ws.id, a.repo.id, { slug: "shared-org/app", rules: ["Atlas rule: every handler logs its request id."], comments_seen: 2, seen_through: "2026-10-01T00:00:00Z" });
  repoMemory.save(b.ws.id, b.repo.id, { slug: "shared-org/app", rules: ["Cedar rule: money is integer cents."], comments_seen: 1, seen_through: "2026-10-01T00:00:00Z" });
  handOff(a.s, { prs: [a.url] });
  const ra = reqOf(a.s);
  await V.verifyRequest(ra.id);
  assert.match(w.codePrompts[0], /Atlas rule: every handler logs its request id/);
  assert.ok(!w.codePrompts[0].includes("Cedar rule"));
  // The operator asks for changes on A's PR: his words are A's, and only A's next review hears them.
  const said = L.recordDecision({ request: ra.id, decision: "change", words: "never log the upload token" });
  assert.ok(said.ok, JSON.stringify(said));
  handOff(b.s, { prs: [b.url] });
  await V.verifyRequest(reqOf(b.s).id);
  assert.match(w.codePrompts[1], /Cedar rule: money is integer cents/);
  assert.ok(!w.codePrompts[1].includes("Atlas rule"), "another workspace's memory never crosses");
  assert.ok(!w.codePrompts[1].includes("never log the upload token"), "nor its operator notes");
  w.head = HEAD_B;
  w.gitHead = HEAD_B;
  w.diff += "\n+redact(token)";
  handOff(a.s, { prs: [a.url], summary: "token redacted" });
  await V.verifyRequest(reqOf(a.s).id);
  assert.match(w.codePrompts[2], /He asked for changes on https:\/\/github\.com\/shared-org\/app\/pull\/12: never log the upload token/);
  assert.equal(w.gh.length, 0, "both memories were fresh: GitHub was not asked");
});

test("nothing is posted to GitHub: the memory's one read is a query, the findings go only to the terminal, the reviewer is a read-only run", async () => {
  const { s, url } = world("pr");
  w.ghData = { data: { repository: { pullRequests: { nodes: [{ number: 3, author: { login: "builder" }, reviews: { nodes: [{ author: { __typename: "User", login: "rev" }, body: "Always add a regression test next to the fix, please.", submittedAt: "2026-10-01T00:00:00Z", comments: { nodes: [] } }] }, comments: { nodes: [] } }] } } } };
  w.distilled = JSON.stringify(["Add a regression test next to every fix."]);
  w.codeVerdict = 'REVIEW {"findings":[{"where":"src/retry.ts:3","what":"no regression test next to the fix","rule":"Add a regression test next to every fix."}]}';
  handOff(s, { prs: [url] });
  await V.verifyRequest(reqOf(s).id);
  assert.match(w.codePrompts[0], /- Add a regression test next to every fix\./, "what it learned from human review is in the review");
  assert.equal(w.gh.length, 1);
  assert.deepEqual(w.gh[0].slice(0, 2), ["api", "graphql"]);
  assert.ok(!/mutation/i.test(w.gh[0].join(" ")));
  assert.deepEqual(w.told.map((t) => t.sid), [s.id], "the findings were typed into its terminal, nowhere else");
  // The real edge the code review goes through: a `review:` job — read-only, no Bash, no web, no writes.
  const ws = workspaces.create({ slug: `cr-${Math.random().toString(36).slice(2, 8)}`, name: "reviewer", config_dir: `/tmp/vf-${Math.random()}`, sandbox_mode: "off" } as any);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verifier-code-"));
  const keepAlive = setInterval(() => {}, 1000);
  const out = await V.defaultVerifierDeps.review(ws, "code review\n!sleep: 20", { cwd, backend: "mock", model: "", requestId: "c0de0000-1111", label: "code" }).finally(() => clearInterval(keepAlive));
  const job = jobs.list().find((j) => j.workspace_id === ws.id)!;
  assert.equal(job.name, "review:code-c0de0000");
  assert.ok(isReadOnlyRun(job.name));
  assert.match(job.disallowed_tools, /\bEdit\b.*\bWrite\b.*\bBash\b.*\bWebFetch\b.*\bWebSearch\b/);
  assert.equal(out.status, "success");
});
