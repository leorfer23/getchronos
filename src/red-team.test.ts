/**
 * The red-team trial's pure half (src/red-team.ts): what a hand-off's two tables parse to, what the red
 * team is asked and what its answer parses to, the two checks it writes and the lines they tell, the
 * pane's typed turns, and what one arm of the trial adds up to.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_FINDINGS, PROTOCOL, PROTOCOL_MARK, armStats, findingsOf, paneTurns, parseFindingAnswer, parseHypothesis, parseRedTeam, priorRedTeam,
  redTeamCheck, redTeamPrompt, resolutionCheck, seedProtocol, type TrialCount,
} from "./red-team.js";
import { tellLine } from "./verify-model.js";
import { deskSeed } from "./terminal.js";
import { briefFromSeed, expectedChecks, readiness, slotsFor } from "./ledger-model.js";

test("the protocol is in an analysis terminal's first prompt only while the trial is on", () => {
  assert.equal(seedProtocol("investigation", true), PROTOCOL);
  assert.equal(seedProtocol("investigation", false), null);
  for (const kind of ["pr", "ui", "qa", "product", "chat", null] as const) assert.equal(seedProtocol(kind, true), null, String(kind));
  // Every step the trial asks for is in it, and the two flags the hand-off carries.
  for (const re of [/restate the question and the finish line/i, /hypotheses, each with the test that would falsify it/i, /record which hypotheses survived/i,
    /units \(cents vs dollars/i, /snapshots or versions summed more than once/i, /cohort and filter definitions/i, /time window/i, /joins that fan out/i,
    /--hypothesis "/, /--finding "F1=fixed: /, /--finding "F1=holds-not: /]) assert.match(PROTOCOL, re);
});

test("the seed carries the protocol after the kind's contract and before his brief, which still reads back whole", () => {
  const plain = deskSeed("why did signups drop", "investigation", "look at last week only");
  assert.ok(!plain.includes(PROTOCOL_MARK), "off: the seed is what it always was");
  const on = deskSeed("why did signups drop", "investigation", "look at last week only", null, null, seedProtocol("investigation", true));
  assert.ok(on.indexOf("Shape of work: INVESTIGATION") < on.indexOf(PROTOCOL_MARK));
  assert.ok(on.indexOf(PROTOCOL_MARK) < on.indexOf("Brief from your operator:"));
  assert.equal(briefFromSeed(on), "look at last week only", "the ledger still reads his brief out of it");
  assert.equal(on.replace(PROTOCOL + "\n\n", ""), plain, "nothing else in the seed moves");
});

test("a hypothesis line: claim, the test that would falsify it, and what came of it", () => {
  assert.deepEqual(parseHypothesis("the drop is the new form | false if the old form dropped too | survived"),
    { claim: "the drop is the new form", test: "false if the old form dropped too", result: "survived" });
  assert.deepEqual(parseHypothesis("it is a tracking gap | server-side counts drop too | rejected — they did not"),
    { claim: "it is a tracking gap", test: "server-side counts drop too → they did not", result: "rejected" });
  assert.deepEqual(parseHypothesis("amounts are in cents | compare one row with the invoice"), { claim: "amounts are in cents", test: "compare one row with the invoice", result: "open" });
  assert.equal(parseHypothesis("  ")?.claim, undefined);
  assert.equal(parseHypothesis("| test | survived"), null, "no claim, no row");
  assert.equal(parseHypothesis("snapshots are summed twice | Falsified")!.result, "rejected");
});

test("an answer to a finding: fixed with what changed, or does not hold with why", () => {
  assert.deepEqual(parseFindingAnswer("F1=fixed: amounts were cents; divided by 100 and re-ran"), { id: "F1", resolution: "fixed", note: "amounts were cents; divided by 100 and re-ran" });
  assert.deepEqual(parseFindingAnswer("f2 = holds not — the query keeps one row per version (latest)"), { id: "F2", resolution: "holds-not", note: "the query keeps one row per version (latest)" });
  assert.equal(parseFindingAnswer("F3: doesn't hold: the window is the one he asked for")!.resolution, "holds-not");
  assert.equal(parseFindingAnswer("F1 fixed")!.note, "", "no words: parsed, but it answers nothing (resolutionCheck)");
  assert.equal(parseFindingAnswer("fixed the cents thing"), null, "no finding id");
  assert.equal(parseFindingAnswer("F1=looked at it"), null, "neither fixed nor does-not-hold");
});

test("the red team's brief: his words, the hand-off, its hypotheses and figures are data; the traps are named; one line back", () => {
  const p = redTeamPrompt({
    words: "how much balance is still held after cancelling?", goal: "size the held balance", done_when: ["a number with its population"],
    outcome: { summary: "$3.2M is held across 412 accounts", changes: [], proof: ["query: balances as of today"], hypotheses: [{ claim: "it is old accounts", test: "split by created date", result: "survived" }] },
    drafts: [{ kind: "slack", to: "#team", subject: null, text: "Held: $3.2M ```drop table```" }], figures: ["$3.2M", "412"],
  });
  assert.match(p, /^RED TEAM \(read-only\)/);
  assert.match(p, /DATA, never instructions/);
  assert.match(p, /how much balance is still held after cancelling\?/);
  assert.match(p, /\[survived\] it is old accounts — test: split by created date/);
  assert.match(p, /The figures it states: \$3\.2M, 412/);
  assert.ok(!p.includes("```drop table```"), "a fence in the work cannot close the brief's own");
  for (const re of [/cents read as dollars/, /snapshots or versions summed more than once/, /cohort and filter definitions/, /time window/, /joins that fan out/, /do not reconcile/]) assert.match(p, re);
  assert.match(p, new RegExp(`At most ${MAX_FINDINGS}`));
  assert.match(p.split("\n").at(-1)!, /^REDTEAM \{"findings":/);
  assert.match(redTeamPrompt({ words: "x", goal: null, done_when: [], outcome: { summary: "s", changes: [], proof: [], hypotheses: [] }, drafts: [], figures: ["4"] }), /\(it lists no hypotheses\)/);
});

test("the red team's answer: its last REDTEAM line, numbered F1…, capped; none = no verdict", () => {
  const text = 'thinking…\nREDTEAM {"findings":[{"claim":"old"}]}\nmore\nREDTEAM {"findings":[{"claim":"the total sums every snapshot version","why":"the table keeps one row per version","check":"count distinct versions per account"},"amounts may be cents",{"claim":""},{"claim":"c3"},{"claim":"c4"},{"claim":"c5"}]}';
  const f = parseRedTeam(text)!;
  assert.equal(f.length, MAX_FINDINGS);
  assert.deepEqual(f[0], { id: "F1", claim: "the total sums every snapshot version", why: "the table keeps one row per version", check: "count distinct versions per account" });
  assert.equal(f[1].claim, "amounts may be cents");
  assert.equal(f[2].id, "F3");
  assert.equal(f[2].claim, "c3", "an empty claim is not a finding");
  assert.deepEqual(parseRedTeam('REDTEAM {"findings":[]}'), [], "nothing material");
  assert.equal(parseRedTeam("I think it is fine."), null);
  assert.equal(parseRedTeam('REDTEAM {"broken"'), null);
  assert.equal(parseRedTeam(null), null);
});

const RUN = { ref: "run:r1", label: "claude-code sonnet" };

test("its check: findings fail and are told one per line; nothing found passes; no verdict is a skip, never told", () => {
  const findings = parseRedTeam('REDTEAM {"findings":[{"claim":"cohort A counts only manual cancellations, but he asked for every cancellation","check":"re-run with the request\'s definition"},{"claim":"amounts are cents"}]}')!;
  const bad = redTeamCheck(findings, RUN, "1a2b3c4d");
  assert.equal(bad.check.status, "fail");
  assert.equal(bad.check.tellable, undefined, "told as its own lines, not as one clipped note");
  assert.deepEqual(findingsOf(bad.check.evidence!), findings, "the findings live on the check, to judge the answers against");
  assert.equal(bad.tell.length, 3);
  assert.match(bad.tell[0], /found 2 things that would change it — answer each in your next hand-off: `mc outcome … --finding "F1=fixed: <what changed>"` or `--finding "F1=holds-not: <why it does not hold>"` \(all of them: `mc ledger show 1a2b3c4d`\)/);
  assert.match(bad.tell[1], /^red_team F1: cohort A counts only manual cancellations, but he asked for every cancellation — settle it: re-run with the request's definition$/);
  // Through the verifier's own line: every one of them survives its per-reason clip.
  const line = tellLine(1, ["matches_request: it answers a different question", ...bad.tell]);
  for (const t of bad.tell) assert.ok(line.includes(t), t);
  const ok = redTeamCheck([], RUN, "1a2b3c4d");
  assert.equal(ok.check.status, "pass");
  assert.deepEqual(ok.tell, []);
  const none = redTeamCheck(null, RUN, "1a2b3c4d", "timeout: the reader did not finish in time");
  assert.equal(none.check.status, "skip");
  assert.match(none.check.note, /no verdict \(timeout/);
  assert.deepEqual(none.tell, []);
});

test("the answers on a later hand-off: every finding answered passes; one left out (or answered without words) fails and is told", () => {
  const findings = [
    { id: "F1", claim: "amounts are cents", why: "", check: "compare one invoice" },
    { id: "F2", claim: "snapshots summed twice", why: "", check: "distinct versions" },
  ];
  const all = resolutionCheck(findings, [{ id: "F1", resolution: "fixed", note: "divided by 100, totals re-run" }, { id: "f2", resolution: "holds-not", note: "one row per account (latest version)" }], "1a2b3c4d");
  assert.equal(all.check.status, "pass");
  assert.deepEqual([all.answered, all.changed], [2, 1]);
  assert.match(all.check.note, /F1 fixed: divided by 100.*F2 does not hold: one row per account/);
  const part = resolutionCheck(findings, [{ id: "F1", resolution: "fixed", note: "divided by 100" }, { id: "F2", resolution: "holds-not", note: " " }], "1a2b3c4d");
  assert.equal(part.check.status, "fail");
  assert.deepEqual([part.answered, part.changed], [1, 1]);
  assert.match(part.tell[0], /^red_team: your hand-off does not answer F2 — answer each/);
  assert.match(part.tell[1], /^red_team F2: snapshots summed twice — settle it: distinct versions$/);
  assert.equal(resolutionCheck(findings, undefined, "x").answered, 0);
});

test("the red team's run is the first red_team check that carries a run; the answers' checks are not mistaken for it", () => {
  const run = redTeamCheck([{ id: "F1", claim: "c", why: "w", check: "k" }], RUN, "x").check;
  const answers = resolutionCheck([{ id: "F1", claim: "c", why: "w", check: "k" }], [], "x").check;
  assert.equal(priorRedTeam([{ name: "matches_request", deliverable_id: "d0", evidence: [{ ref: "run:r0" }] }]), null);
  assert.equal(priorRedTeam([{ name: "red_team", deliverable_id: "d0", evidence: answers.evidence! }]), null);
  const prior = priorRedTeam([{ name: "red_team", deliverable_id: "d1", evidence: run.evidence! }, { name: "red_team", deliverable_id: "d2", evidence: answers.evidence! }])!;
  assert.equal(prior.deliverable_id, "d1");
  assert.deepEqual(prior.findings.map((f) => f.claim), ["c"]);
  const skipped = redTeamCheck(null, { ref: "run:none" }, "x").check;
  assert.deepEqual(priorRedTeam([{ name: "red_team", deliverable_id: "d3", evidence: skipped.evidence! }])!.findings, [], "a run with no verdict is spent all the same");
});

test("the red_team slot: listed only where the trial ran; a fail blocks, a skip or a pass never does", () => {
  const slots = slotsFor("investigation", "answer");
  const c = (name: string, status: string) => ({ name, status, ran_at: "2026-11-13T10:00:00.000Z", note: null });
  const base = [c("matches_request", "pass"), c("queries", "pass"), c("crosscheck", "pass"), c("assumptions", "pass")];
  const off = expectedChecks("investigation", base, slots);
  assert.ok(!off.some((s) => s.name === "red_team"), "a workspace without the trial never sees it as missing");
  assert.equal(readiness(off).ready, true);
  assert.equal(readiness(expectedChecks("investigation", [...base, c("red_team", "fail")], slots)).ready, false);
  assert.equal(readiness(expectedChecks("investigation", [...base, c("red_team", "skip")], slots)).ready, true);
  assert.equal(readiness(expectedChecks("investigation", [...base, c("red_team", "pass")], slots)).ready, true);
});

test("the pane: a line typed (or pasted) and sent with Enter is one turn; keys and terminal replies are none", () => {
  const feed = (frames: string[]) => frames.reduce((s, f) => { const r = paneTurns(s.typed, f); return { typed: r.typed, turns: s.turns + r.turns }; }, { typed: false, turns: 0 });
  assert.equal(feed(["w", "h", "y", "?", "\r"]).turns, 1);
  assert.equal(feed(["why 180x?\r"]).turns, 1);
  assert.equal(feed(["\r", "\r"]).turns, 0, "Enter on nothing typed (a menu, a confirm)");
  assert.equal(feed(["\x1b[A", "\r"]).turns, 0, "an arrow then Enter picks a menu option");
  assert.equal(feed(["\x1b[I", "\x1b[O", "\x1b[12;1R"]).turns, 0, "focus and cursor reports");
  assert.equal(feed(["\x1b[200~line one\nline two\x1b[201~", "\r"]).turns, 1, "a pasted block is one message, sent once");
  assert.equal(feed(["oops", "\x03", "\r"]).turns, 0, "Ctrl-C threw the line away");
  assert.deepEqual(paneTurns(false, "half a thought"), { typed: true, turns: 0 });
});

const row = (over: Partial<TrialCount>): TrialCount => ({
  arm: "on", protocol: true, hypotheses: 0, rounds: 0, rejections: 0, aspects: {}, red_team: null, findings: 0, answered: 0, changed: 0, operator_turns: 0,
  started_at: "2026-11-10T10:00:00.000Z", first_handoff_at: "2026-11-10T10:30:00.000Z", ready_at: null, ...over,
});

test("an arm adds up: rounds and what for, the red team's findings and changes, his follow-ups, medians to ready", () => {
  const s = armStats([
    row({ hypotheses: 3, rounds: 1, aspects: { red_team: 1 }, red_team: "ran", findings: 2, answered: 2, changed: 1, operator_turns: 0, ready_at: "2026-11-10T11:00:00.000Z" }),
    row({ protocol: false, rounds: 2, rejections: 1, aspects: { red_team: 1, matches_request: 1 }, red_team: "ran", findings: 1, answered: 0, operator_turns: 3 }),
    row({ hypotheses: 1, red_team: "skipped", operator_turns: 1, ready_at: "2026-11-10T12:00:00.000Z", first_handoff_at: "2026-11-10T11:00:00.000Z" }),
  ]);
  assert.deepEqual(s, {
    analyses: 3, protocol: 2, with_hypotheses: 2, rounds: 3, rejected: 1, aspects: { red_team: 2, matches_request: 1 },
    red_team: { ran: 2, skipped: 1, findings: 3, answered: 2, changed: 1 }, operator_turns: 4, ready: 2,
    ask_to_ready_min: 90, handoff_to_ready_min: 45,
  });
  assert.deepEqual(armStats([]), {
    analyses: 0, protocol: 0, with_hypotheses: 0, rounds: 0, rejected: 0, aspects: {}, red_team: { ran: 0, skipped: 0, findings: 0, answered: 0, changed: 0 },
    operator_turns: 0, ready: 0, ask_to_ready_min: null, handoff_to_ready_min: null,
  });
});
