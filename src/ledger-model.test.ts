/**
 * The request ledger's pure half (src/ledger-model.ts): the state roll-up, the order the approval
 * queue is heard in, the compact text, and the small readers it is built from.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  briefFromSeed, deliveredLinks, derivePrereqs, draftHash, expectedChecks, ledgerLines, PICKUP_GRACE_MS, queueOrder, rollUp, viaOf, WORK, wordsOfSession,
  type ItemView, type QueueCandidate, type RollUpInput, type TerminalView,
} from "./ledger-model.js";
import { GOAL_KINDS } from "./validation.js";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const term = (over: Partial<TerminalView> = {}): TerminalView => ({
  session_id: "s1", primary: true, current: true, live: true, phase: "working", line: "2/5 · writing the migration",
  kind: "pr", outcome_at: null, goal_reached: false, ...over,
});
const item = (over: Partial<ItemView> = {}): ItemView => ({
  action: "merge", status: "open", label: "PR #12 (atlas/api)", decision: null, hold_until: null, deliverable_state: "open", ...over,
});
const roll = (over: Partial<RollUpInput>) =>
  rollUp({ closed_at: null, closed_reason: null, asked_at: "2026-11-09T11:00:00.000Z", terminals: [], items: [], now: NOW, ...over });

test("one terminal: each phase maps to one request state", () => {
  assert.equal(roll({ terminals: [term()] }).state, "working");
  assert.equal(roll({ terminals: [term({ phase: "waiting", line: "waiting on ci" })] }).state, "working");
  assert.deepEqual(roll({ terminals: [term({ phase: "decide", line: "which schema? (a / b)" })] }), { state: "needs_operator", line: "which schema? (a / b)" });
  assert.equal(roll({ terminals: [term({ phase: "blocked", line: "needs a login" })] }).state, "needs_operator");
  assert.equal(roll({ terminals: [term({ phase: "stalled", line: "silent 40m with no sign of life" })] }).state, "stuck");
  // Stopped without handing anything off: someone has to look.
  const short = roll({ terminals: [term({ phase: "your_turn", line: "finished its turn" })] });
  assert.equal(short.state, "stuck");
  assert.match(short.line, /stopped without a hand-off/);
  // Stopped after handing off: finished, and the open terminal is all that keeps it from closing.
  const handed = roll({ terminals: [term({ phase: "your_turn", outcome_at: "2026-11-09T11:30:00.000Z" })] });
  assert.equal(handed.state, "done");
  assert.match(handed.line, /still open/);
  assert.equal(roll({ terminals: [term({ phase: "review", line: "goal reached" })] }).state, "done");
  // A chat has nothing to hand off: idle is finished.
  assert.equal(roll({ terminals: [term({ phase: "your_turn", kind: "chat" })] }).state, "done");
});

test("ended terminals: a hand-off closes the request, none leaves it stuck", () => {
  assert.deepEqual(roll({ terminals: [term({ live: false, phase: "ended", outcome_at: "2026-11-09T11:30:00.000Z" })] }), { state: "closed", line: "finished" });
  assert.equal(roll({ terminals: [term({ live: false, phase: "ended", goal_reached: true })] }).state, "closed");
  const died = roll({ terminals: [term({ live: false, phase: "ended" })] });
  assert.equal(died.state, "stuck");
  assert.match(died.line, /ended without a hand-off/);
});

test("several terminals roll up to the most urgent one", () => {
  const working = term({ session_id: "a" });
  const stalled = term({ session_id: "b", phase: "stalled", line: "silent 30m" });
  const asks = term({ session_id: "c", phase: "decide", line: "merge into main or release?" });
  const done = term({ session_id: "d", live: false, phase: "ended", outcome_at: "2026-11-09T11:30:00.000Z" });
  assert.equal(roll({ terminals: [working, done] }).state, "working");
  assert.equal(roll({ terminals: [working, stalled, done] }).state, "stuck");
  assert.equal(roll({ terminals: [working, stalled, asks, done] }).state, "needs_operator");
  // Two parts in the same state say so once, with a count.
  assert.match(roll({ terminals: [term({ session_id: "a" }), term({ session_id: "b", line: "1/3" })] }).line, /\(\+1 more\)/);
});

test("an open decision item outranks everything a terminal says", () => {
  const out = roll({ terminals: [term()], items: [item()] });
  assert.equal(out.state, "needs_operator");
  assert.equal(out.line, "merge: PR #12 (atlas/api)");
  assert.match(roll({ terminals: [term()], items: [item(), item({ action: "send", label: "Slack draft → #ops" })] }).line, /\(\+1 more\)/);
});

test("held, approved-not-yet-carried-out, and decided items: done until nothing is left", () => {
  const ended = term({ live: false, phase: "ended", outcome_at: "2026-11-09T11:30:00.000Z" });
  assert.match(roll({ terminals: [ended], items: [item({ status: "held", decision: "later" })] }).line, /held for later/);
  assert.equal(roll({ terminals: [ended], items: [item({ status: "held", decision: "later" })] }).state, "done");
  const approved = roll({ terminals: [ended], items: [item({ status: "decided", decision: "yes" })] });
  assert.equal(approved.state, "done");
  assert.match(approved.line, /approved — merge waits to be carried out/);
  // The executor merged it (the deliverable moved): nothing is left.
  assert.equal(roll({ terminals: [ended], items: [item({ status: "decided", decision: "yes", deliverable_state: "merged" })] }).state, "closed");
  // A no, a change asked for, a superseded item: none of them keep it open.
  assert.equal(roll({ terminals: [ended], items: [item({ status: "decided", decision: "no" }), item({ status: "superseded" })] }).state, "closed");
});

test("a question he put off parks a terminal that stopped on it: done (held), not stuck", () => {
  const stopped = term({ phase: "your_turn", line: "finished its turn" });
  assert.equal(roll({ terminals: [stopped] }).state, "stuck");
  const parked = roll({ terminals: [stopped], items: [item({ action: "answer", status: "held", decision: null, label: "ship it friday?", deliverable_state: null })] });
  assert.deepEqual(parked, { state: "done", line: "answer held for later: ship it friday?" });
  // A stall is not explained by a held question.
  assert.equal(roll({ terminals: [term({ phase: "stalled" })], items: [item({ status: "held" })] }).state, "stuck");
});

test("explicitly closed wins over everything", () => {
  assert.deepEqual(roll({ closed_at: "2026-11-09T11:59:00.000Z", closed_reason: "closed by voice: drop it", terminals: [term({ phase: "decide" })], items: [item()] }), {
    state: "closed", line: "closed by voice: drop it",
  });
});

test("nothing picked it up: working inside the grace, stuck after", () => {
  const asked = new Date(NOW - 60_000).toISOString();
  assert.equal(roll({ asked_at: asked }).state, "working");
  assert.equal(roll({ asked_at: new Date(NOW - PICKUP_GRACE_MS - 1).toISOString() }).state, "stuck");
});

test("handed over: a request whose links all moved on before a hand-off is closed as continued", () => {
  const moved = term({ current: false, live: true, phase: "working" });
  assert.deepEqual(roll({ terminals: [moved] }), { state: "closed", line: "continued in a later request" });
  // …but one that got its hand-off first keeps it, and finishes on its own terms.
  const handedFirst = term({ current: false, outcome_at: "2026-11-09T11:10:00.000Z" });
  assert.equal(roll({ terminals: [handedFirst] }).state, "closed");
  assert.equal(roll({ terminals: [handedFirst], items: [item()] }).state, "needs_operator");
});

test("a steer (secondary link) follows its terminal until it hands off, then closes into it", () => {
  const steer = term({ primary: false, phase: "working" });
  assert.equal(roll({ terminals: [steer] }).state, "working");
  assert.equal(roll({ terminals: [term({ primary: false, phase: "decide", line: "asks" })] }).state, "needs_operator");
  const after = roll({ terminals: [term({ primary: false, phase: "your_turn", outcome_at: "2026-11-09T11:40:00.000Z" })] });
  assert.equal(after.state, "closed");
  assert.match(after.line, /carried into its terminal's own request/);
});

test("a fleet-wide request is as urgent as its most urgent project", () => {
  const out = roll({ children: [{ state: "working", line: "atlas: working" }, { state: "needs_operator", line: "cedar: merge PR #3" }] });
  assert.deepEqual(out, { state: "needs_operator", line: "cedar: merge PR #3" });
  assert.equal(roll({ children: [{ state: "closed", line: "finished" }] }).state, "closed");
  assert.equal(roll({ children: [{ state: "done", line: "finished" }, { state: "closed", line: "finished" }] }).state, "done");
});

// ── the queue ───────────────────────────────────────────────────────────────────────────────────
const cand = (over: Partial<QueueCandidate> & { item_id: string }): QueueCandidate => ({
  action: "merge", status: "open", target_hash: "a".repeat(40), hold_until: null, created_at: "2026-11-09T10:00:00.000Z",
  checks: { pass: 0, fail: 0, missing_required: 3 }, ...over,
});

test("the queue: blocked answers, then verified and bound, bound, reviews, unbound, failing; oldest first inside", () => {
  const items = [
    cand({ item_id: "unbound", target_hash: null, created_at: "2026-11-09T09:00:00.000Z" }),
    cand({ item_id: "review", action: "review", target_hash: null }),
    cand({ item_id: "bound-new", created_at: "2026-11-09T11:00:00.000Z" }),
    cand({ item_id: "bound-old", created_at: "2026-11-09T08:00:00.000Z" }),
    cand({ item_id: "ready", checks: { pass: 4, fail: 0, missing_required: 0 }, created_at: "2026-11-09T11:30:00.000Z" }),
    cand({ item_id: "failing", checks: { pass: 2, fail: 1, missing_required: 0 } }),
    cand({ item_id: "answer", action: "answer", target_hash: null, created_at: "2026-11-09T11:59:00.000Z" }),
    cand({ item_id: "held", status: "held", hold_until: "2026-11-10T09:00:00.000Z" }),
  ];
  assert.deepEqual(queueOrder(items).map((i) => i.item_id), ["answer", "ready", "bound-old", "bound-new", "review", "unbound", "failing"]);
  assert.deepEqual(queueOrder(items).map((i) => i.rank), [0, 1, 2, 2, 3, 4, 5]);
});

// ── the compact text ────────────────────────────────────────────────────────────────────────────
test("ledgerLines: open requests only, most urgent first, ids only where he may act, capped", () => {
  const rows = [
    { id: "aaaaaaaa-1111", state: "working" as const, title: "add retries to the uploader", state_line: "3/5 · tests", via: "voice" as const, progress: "3/5", workspace: "atlas" },
    { id: "bbbbbbbb-2222", state: "needs_operator" as const, title: "fix the login redirect", state_line: "merge: PR #12 (atlas/api)", via: "typed" as const, workspace: "atlas" },
    { id: "cccccccc-3333", state: "closed" as const, title: "old thing", state_line: "finished", via: "hand" as const },
    { id: "dddddddd-4444", state: "stuck" as const, title: "nightly export check", state_line: "stopped without a hand-off", via: "robert" as const, workspace: "cedar" },
  ];
  const text = ledgerLines(rows, { withWorkspace: true });
  const lines = text.split("\n");
  assert.equal(lines[0], "LEDGER (3 open · 1 need you):");
  assert.match(lines[1], /^- needs you · atlas · fix the login redirect — merge: PR #12 \(atlas\/api\) \[bbbbbbbb\]$/);
  assert.match(lines[2], /^- stuck · cedar · Robert's own · nightly export check — stopped without a hand-off$/);
  assert.match(lines[3], /^- working · atlas · add retries to the uploader · 3\/5 — 3\/5 · tests$/);
  assert.ok(!text.includes("old thing"), "closed rows are not open work");
  assert.ok(!lines[2].includes("dddddddd") && !lines[3].includes("aaaaaaaa"), "no ids where nothing is his to do");
  // A project's own view carries no workspace names.
  assert.ok(!ledgerLines(rows).includes("atlas ·"));
  // Capped in count and width.
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `id${i}`, state: "working" as const, title: `task ${i} ` + "x".repeat(300), state_line: null, via: "typed" as const }));
  const capped = ledgerLines(many, { max: 5, width: 100 }).split("\n");
  assert.equal(capped.length, 1 + 5 + 1);
  assert.match(capped[6], /… 25 more/);
  assert.ok(capped.slice(1, 6).every((l) => l.length <= 100), "every line within the width");
  assert.equal(ledgerLines([]), "LEDGER: nothing open.");
});

// ── readers ─────────────────────────────────────────────────────────────────────────────────────
test("viaOf: every opener the daemon has today", () => {
  const cases: Record<string, string> = {
    operator: "hand", "": "hand", ticket: "hand", robert: "robert", proactive: "robert", capture: "capture", inbox: "inbox",
    "job-check": "job-check", "follow-up": "follow-up", continuation: "continuation", ship: "ship", failover: "daemon",
    handoff: "daemon", "lead:ab12cd34": "lead", "agent:ab12cd34": "agent", dreamer: "agent",
  };
  for (const [by, via] of Object.entries(cases)) assert.equal(viaOf(by), via, by);
  assert.equal(viaOf(null), "hand");
});

test("briefFromSeed reads his dialog brief back out of the seed, and only that", () => {
  const seed = [
    "Goal: fix the login redirect",
    "Shape of work: PR. Done means a pull request is open…",
    "Brief from your operator:\nit loops on /callback\n\nonly on the phone",
    "When the work is green: open the PR (if it is code), file `mc outcome`, and stop.",
    "You are one card on your operator's Desk, and the goal above is its title.",
    "Start now.",
  ].join("\n\n");
  assert.equal(briefFromSeed(seed), "it loops on /callback\n\nonly on the phone");
  assert.equal(briefFromSeed("Goal: x\n\nStart now."), null);
  assert.equal(briefFromSeed(null), null);
  assert.equal(
    wordsOfSession({ spawn_goal: "fix the login redirect", goal: "sharpened goal", first_prompt: seed }, "hand"),
    "fix the login redirect\n\nit loops on /callback\n\nonly on the phone",
  );
  // A capture's brief is the page he captured, not his words.
  assert.equal(wordsOfSession({ spawn_goal: "check this", first_prompt: seed }, "capture"), "check this");
  assert.equal(wordsOfSession({}, "hand"), "(no goal given)");
});

test("draftHash: stable over recipient spelling, changes with a word, channel or subject", () => {
  const a = draftHash({ channel: "slack", to: "#ops", text: "deploy is done" });
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.equal(draftHash({ channel: "Slack", to: "  #OPS ", text: "deploy is done" }), a);
  assert.notEqual(draftHash({ channel: "slack", to: "#ops", text: "deploy is done." }), a);
  assert.notEqual(draftHash({ channel: "email", to: "#ops", text: "deploy is done" }), a);
  assert.notEqual(draftHash({ channel: "slack", to: "#ops", subject: "x", text: "deploy is done" }), a);
});

test("every work type is described, and its evidence slots read as missing until checks exist", () => {
  for (const k of GOAL_KINDS) assert.ok(WORK[k]?.label && WORK[k].done, k);
  assert.deepEqual(WORK.ui.evidence.filter((e) => e.required).map((e) => e.name), ["tests", "regression", "shots", "walkthrough", "pr_ready", "matches_request"]);
  assert.deepEqual(WORK.investigation.actions, ["send", "review"]);
  assert.ok(WORK.product.deliverables.includes("deploy") && WORK.product.deliverables.includes("email_draft"));
  const slots = expectedChecks("pr", [
    { name: "tests", status: "fail", ran_at: "2026-11-09T10:00:00.000Z" },
    { name: "tests", status: "pass", ran_at: "2026-11-09T11:00:00.000Z" },
  ]);
  assert.equal(slots.find((s) => s.name === "tests")?.status, "pass", "the newest run counts");
  assert.equal(slots.find((s) => s.name === "regression")?.status, "missing");
  assert.deepEqual(expectedChecks(null, []), []);
});

test("deliveredLinks: what a hand-off says it delivered, by link — never its PRs, never its proof", () => {
  const links = deliveredLinks({
    summary: "Numbers are on https://bi.example.com/dashboard/42 and written up at https://docs.example.com/d/abc.",
    changes: ["opened https://github.com/atlas/api/pull/12", "same page again: https://docs.example.com/d/abc"],
  });
  assert.deepEqual(links, [
    { kind: "dashboard", url: "https://bi.example.com/dashboard/42" },
    { kind: "doc", url: "https://docs.example.com/d/abc" },
  ]);
  assert.deepEqual(deliveredLinks({ summary: "no links here", changes: [] }), []);
});

test("prerequisites: an analysis in a workspace with a VPN needs it up first; code work does not", () => {
  const ws = { vpn_config: JSON.stringify({ kind: "example" }) };
  assert.deepEqual(derivePrereqs("investigation", ws).map((p) => p.kind), ["vpn"]);
  assert.deepEqual(derivePrereqs("pr", ws), []);
  assert.deepEqual(derivePrereqs("investigation", { vpn_config: null }), []);
});
