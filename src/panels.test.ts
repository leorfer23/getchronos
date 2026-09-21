import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  REVIEW_LENSES,
  SCOUT_LENSES,
  addVote,
  isPanelReview,
  parsePanel,
  resolvePanel,
  reviewSkipReason,
  wantsReviewPanel,
  type PanelState,
} from "./panels.js";
import { wantsScoutPanel } from "./tickets.js";
import { CONFIG } from "./config.js";
import type { Review, Workspace } from "./types.js";

const vote = (lens: string, decision: "approve" | "changes" | "abstain", notes?: string) => ({
  lens, decision, notes: notes ?? null, at: "2026-07-25T00:00:00.000Z",
});
const state = (lenses: string[], votes: ReturnType<typeof vote>[] = []): PanelState => ({ lenses, votes });
const three = ["spec", "correctness", "blast-radius"];

// ───────────────────────────── lenses ─────────────────────────────

test("every lens asks a different question — a panel of clones catches nothing extra", () => {
  for (const set of [SCOUT_LENSES, REVIEW_LENSES]) {
    const ids = set.map((l) => l.id);
    assert.equal(new Set(ids).size, ids.length, "lens ids must be unique — they key the votes");
    assert.ok(set.length >= 3);
    for (const l of set) assert.ok(l.brief.length > 80, `${l.id} needs a brief specific enough to steer`);
  }
});

// ───────────────────────────── votes ─────────────────────────────

test("a re-run replaces that lens's earlier vote instead of stacking one", () => {
  let s = state(three, [vote("spec", "changes", "missing criterion")]);
  s = addVote(s, vote("spec", "approve", "fixed"));
  assert.equal(s.votes.length, 1);
  assert.equal(s.votes[0].decision, "approve");
});

test("one lens asking for changes ends it — the diff is going back either way", () => {
  const out = resolvePanel(state(three, [vote("correctness", "changes", "null deref on empty input")]), 2);
  assert.equal(out.decision, "changes");
  assert.match((out as any).notes, /correctness/);
  assert.match((out as any).notes, /null deref/);
});

test("changes-notes from several lenses are all handed back, not just the first", () => {
  const out = resolvePanel(
    state(three, [vote("spec", "changes", "criterion 3 dropped"), vote("blast-radius", "changes", "migration is irreversible")]),
    2,
  );
  assert.match((out as any).notes, /criterion 3 dropped/);
  assert.match((out as any).notes, /migration is irreversible/);
});

test("a panel stays pending until every dispatched lens reports", () => {
  assert.equal(resolvePanel(state(three, [vote("spec", "approve")]), 2).decision, "pending");
  assert.equal(resolvePanel(state(three, [vote("spec", "approve"), vote("correctness", "approve")]), 2).decision, "pending");
  assert.equal(
    resolvePanel(state(three, three.map((l) => vote(l, "approve"))), 2).decision,
    "approve",
  );
});

test("two lenses crashing is not the same as two lenses agreeing", () => {
  const out = resolvePanel(state(three, [vote("spec", "approve"), vote("correctness", "abstain"), vote("blast-radius", "abstain")]), 2);
  assert.equal(out.decision, "changes", "one surviving approve cannot pass a high-risk change");
  assert.match((out as any).notes, /quorum/);
  assert.match((out as any).notes, /correctness/);
});

test("one abstention with quorum still approves", () => {
  const out = resolvePanel(state(three, [vote("spec", "approve"), vote("correctness", "approve"), vote("blast-radius", "abstain")]), 2);
  assert.equal(out.decision, "approve");
  assert.match((out as any).notes, /2\/3/);
});

test("quorum can't exceed the lenses that were actually dispatched", () => {
  const out = resolvePanel(state(["spec"], [vote("spec", "approve")]), 2);
  assert.equal(out.decision, "approve", "a one-lens panel must not deadlock on a quorum of 2");
});

test("the approve summary names the lenses that passed it", () => {
  const out = resolvePanel(state(three, three.map((l) => vote(l, "approve", `${l} looked fine`))), 2);
  for (const l of three) assert.match((out as any).notes, new RegExp(l));
});

// ───────────────────────────── parsing ─────────────────────────────

test("parsePanel survives legacy and malformed rows", () => {
  assert.equal(parsePanel(null), null);
  assert.equal(parsePanel("not json"), null);
  assert.equal(parsePanel('{"votes":[]}'), null, "no lenses = not a panel");
  assert.deepEqual(parsePanel('{"lenses":["a"]}'), { lenses: ["a"], votes: [] });
});

test("isPanelReview only counts a real panel", () => {
  const r = (panel_json: string | null) => ({ panel_json }) as Review;
  assert.equal(isPanelReview(r(null)), false);
  assert.equal(isPanelReview(r('{"lenses":["spec"],"votes":[]}')), false, "one reviewer is the normal path");
  assert.equal(isPanelReview(r('{"lenses":["spec","correctness"],"votes":[]}')), true);
});

// ───────────────────────────── gating ─────────────────────────────

test("review panels are for high risk, and off unless the workspace asks", () => {
  assert.equal(wantsReviewPanel("high", null, true), true);
  assert.equal(wantsReviewPanel("med", null, true), false);
  assert.equal(wantsReviewPanel("low", null, true), false);
  assert.equal(wantsReviewPanel("high", null, false), false, "opt-in per workspace");
  assert.equal(wantsReviewPanel(null, null, true), true, "unknown risk is treated as high, as everywhere else");
});

test("scout panels are for tickets graded hard, and off unless the workspace asks", () => {
  const ws = (plan_panel: number) => ({ plan_panel }) as Workspace;
  const t = (complexity: string | null) => ({ complexity });
  assert.equal(wantsScoutPanel(t("5"), ws(1)), true);
  assert.equal(wantsScoutPanel(t(String(CONFIG.panelMinDifficulty)), ws(1)), true);
  assert.equal(wantsScoutPanel(t(String(CONFIG.panelMinDifficulty - 1)), ws(1)), false);
  assert.equal(wantsScoutPanel(t(null), ws(1)), false, "ungraded is a 3 everywhere else, and a 3 isn't panel work");
  assert.equal(wantsScoutPanel(t("5"), ws(0)), false, "opt-in per workspace");
});

test("legacy difficulty words still gate correctly", () => {
  const ws = { plan_panel: 1 } as Workspace;
  assert.equal(wantsScoutPanel({ complexity: "hard" }, ws), true, "legacy 'hard' maps to 4");
  assert.equal(wantsScoutPanel({ complexity: "medium" }, ws), false);
});

// ───────────────────────────── shape ─────────────────────────────

test("a fresh panel round-trips through its stored json", () => {
  const s: PanelState = { lenses: REVIEW_LENSES.map((l) => l.id), votes: [] };
  const back = parsePanel(JSON.stringify(s));
  assert.deepEqual(back, s);
  assert.notEqual(randomUUID(), randomUUID()); // sanity: distinct ids for the review rows keyed by this
});

// ───────────────────────────── 0-reviewer lane ─────────────────────────────

test("reviewSkipReason skips only graded-easy tickets below the threshold", () => {
  // Threshold off (null/0) → always review.
  assert.equal(reviewSkipReason(null, "2"), null);
  assert.equal(reviewSkipReason(0, "1"), null);
  // Below the floor → skip, with a human-readable reason.
  assert.match(reviewSkipReason(4, "2") ?? "", /difficulty 2 < review threshold 4/);
  assert.ok(reviewSkipReason(4, "3"));
  // At or above the floor → review.
  assert.equal(reviewSkipReason(4, "4"), null);
  assert.equal(reviewSkipReason(4, "5"), null);
});

test("reviewSkipReason understands legacy word grades", () => {
  assert.ok(reviewSkipReason(4, "easy")); // legacy 'easy' = 2 → below a floor of 4
  assert.equal(reviewSkipReason(4, "hard"), null); // legacy 'hard' = 4 → reviewed
});

test("reviewSkipReason never skips an ungraded or garbage-graded ticket", () => {
  assert.equal(reviewSkipReason(4, null), null); // never graded
  assert.equal(reviewSkipReason(4, undefined), null);
  assert.equal(reviewSkipReason(4, ""), null); // Number("") is 0, not a grade
  assert.equal(reviewSkipReason(4, "gnarly"), null); // not a grade at all
  assert.equal(reviewSkipReason(4, "0"), null); // not a real 1-5 grade
});
