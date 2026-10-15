/**
 * Panels — more than one agent on the work that deserves it.
 *
 * Every stage of the loop is one agent: one scout, one builder, one reviewer. That is right for most
 * tickets and wrong for two kinds. A hard ticket fails on *coverage* — one scout reads the code from
 * one angle and the builder inherits whatever it happened not to look at. A risky change fails on
 * *blind spots* — one reviewer with one set of instincts, and whatever that reviewer doesn't think
 * about ships.
 *
 * Neither is fixed by running the same agent twice. Both are fixed by giving each agent a different
 * question to answer, which is what a lens is.
 */
import type { GateResult, Review, RiskTier } from "./types.js";

export interface Lens {
  id: string;
  label: string;
  /** Appended to the stage's normal prompt — what THIS agent is responsible for finding. */
  brief: string;
}

// ───────────────────────────── scouting ─────────────────────────────

/**
 * Scout lenses. Deliberately three different searches, not three opinions: the planner in this
 * system is a scout and not an architect (see dispatchPlan), and a panel that argued about approach
 * would be a different, worse feature.
 */
export const SCOUT_LENSES: Lens[] = [
  {
    id: "map",
    label: "map",
    brief:
      `Your lens is THE MAP. What exists today and how it connects: the files, modules and symbols this ticket ` +
      `touches, with real paths; the call sites and data flow through them; the configs and entry points ` +
      `involved. Trace it end to end rather than listing what is near the keyword.`,
  },
  {
    id: "prior-art",
    label: "prior art",
    brief:
      `Your lens is PRIOR ART. How this codebase has already solved this shape of problem: the closest existing ` +
      `implementation, the helper or pattern the builder should reuse instead of writing new, the tests and ` +
      `fixtures that cover this area, the repo conventions that apply. Reinventing something that already lives ` +
      `two files over is the most common failure here — your job is to make it impossible.`,
  },
  {
    id: "risk",
    label: "risk",
    brief:
      `Your lens is RISK. What breaks: every other caller of what this ticket will change, the edge cases and ` +
      `error paths, the migrations/auth/deploy/money surfaces in blast radius, the ambiguities in the ticket ` +
      `that a builder would resolve by guessing. Ambiguities are findings — surface them, do not resolve them.`,
  },
];

// ───────────────────────────── reviewer count ─────────────────────────────

/**
 * 0-reviewer lane. Below this graded difficulty a build skips the AI reviewer entirely: the review
 * takes the approve lane unseen, where repo.human_gate still decides ship vs. wait-for-human — so
 * "no reviewer" never means "no gate". Returns the reason to skip, or null to dispatch a reviewer.
 * Ungraded tickets always get one: no grade is no evidence the change is easy.
 */
const LEGACY_DIFFICULTY: Record<string, number> = { trivial: 1, easy: 2, medium: 3, hard: 4 }; // mirrors tickets.ts (importing it here would cycle)
export function reviewSkipReason(
  minDifficulty: number | null | undefined,
  complexity: string | null | undefined,
): string | null {
  const min = minDifficulty ?? 0;
  if (min <= 0) return null;
  // Deliberately NOT difficultyOf(): that maps ungraded to 3, and "grading never ran" must not be
  // enough evidence to skip a review — here ungraded/garbage stays 0 and always gets a reviewer.
  const n = Number(complexity);
  const d = Number.isInteger(n) && n >= 1 && n <= 5 ? n : LEGACY_DIFFICULTY[complexity ?? ""] ?? 0;
  if (d < 1 || d >= min) return null;
  return `difficulty ${d} < review threshold ${min}`;
}

// ───────────────────────────── review ─────────────────────────────

/**
 * Review lenses. Three reviewers with the same instructions mostly agree with each other; three with
 * different questions catch different things. Used on high-risk changes, where the cost of a missed
 * defect is the reason that tier exists.
 */
export const REVIEW_LENSES: Lens[] = [
  {
    id: "spec",
    label: "spec conformance",
    brief:
      `Your lens is THE SPEC. Does this do what the ticket asked — all of it, and nothing it didn't ask for? ` +
      `Walk each acceptance criterion against the diff and say which change satisfies it. Silent scope creep and ` +
      `a criterion quietly dropped are both failures, even when the code is good.`,
  },
  {
    id: "correctness",
    label: "correctness",
    brief:
      `Your lens is CORRECTNESS. Where is this wrong: edge cases, error paths, null/empty/boundary inputs, ` +
      `concurrency, ordering, off-by-one, resource leaks, and regressions in code the diff touches indirectly. ` +
      `Give a concrete failing input or sequence for anything you flag — a worry you can't make fail is not a finding.`,
  },
  {
    id: "blast-radius",
    label: "blast radius",
    brief:
      `Your lens is BLAST RADIUS. If this is wrong in production, how bad and how fast: data loss or corruption, ` +
      `irreversible migrations, auth/permission changes, secret handling, cost blowups, anything hard to roll back. ` +
      `Also: what an operator should watch after it ships, and whether the change can be undone.`,
  },
];

// ───────────────────────────── votes ─────────────────────────────

export type VoteDecision = "approve" | "changes" | "abstain";

export interface PanelVote {
  lens: string;
  decision: VoteDecision;
  notes?: string | null;
  at: string;
}

export interface PanelState {
  lenses: string[];
  votes: PanelVote[];
}

export function parsePanel(json: string | null | undefined): PanelState | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json);
    if (!p || !Array.isArray(p.lenses)) return null;
    return { lenses: p.lenses.map(String), votes: Array.isArray(p.votes) ? p.votes : [] };
  } catch {
    return null;
  }
}

export const isPanelReview = (r: Pick<Review, "panel_json">): boolean => (parsePanel(r.panel_json)?.lenses.length ?? 0) > 1;

/** Record one lens's vote, replacing any earlier vote from that same lens (a re-run supersedes). */
export function addVote(state: PanelState, vote: PanelVote): PanelState {
  return { lenses: state.lenses, votes: [...state.votes.filter((v) => v.lens !== vote.lens), vote] };
}

export type PanelOutcome =
  | { decision: "pending" }
  | { decision: "changes"; notes: string }
  | { decision: "approve"; notes: string };

/**
 * Resolve a panel.
 *
 * One lens asking for changes ends it immediately — the code is going back either way, and spending
 * the other reviewers on a diff that's about to be rewritten buys nothing. Approval needs every
 * dispatched lens to have reported and at least `quorum` of them to actually approve, so a panel
 * where two agents crashed can't be mistaken for a panel that agreed.
 */
export function resolvePanel(state: PanelState, quorum: number): PanelOutcome {
  const changes = state.votes.filter((v) => v.decision === "changes");
  if (changes.length) {
    const notes = changes
      .map((v) => `**${v.lens}** requested changes:\n${(v.notes ?? "(no detail given)").trim()}`)
      .join("\n\n");
    return { decision: "changes", notes };
  }
  if (state.votes.length < state.lenses.length) return { decision: "pending" };
  const approvals = state.votes.filter((v) => v.decision === "approve");
  if (approvals.length < Math.min(quorum, state.lenses.length)) {
    const abstained = state.votes.filter((v) => v.decision === "abstain").map((v) => v.lens);
    return {
      decision: "changes",
      notes:
        `Review panel did not reach quorum: only ${approvals.length} of ${state.lenses.length} lenses approved` +
        (abstained.length ? ` (no verdict from: ${abstained.join(", ")})` : "") +
        `. Re-run the review, or approve it yourself.`,
    };
  }
  const summary = approvals
    .map((v) => `**${v.lens}**: ${(v.notes ?? "approved").trim().split("\n")[0].slice(0, 200)}`)
    .join("\n");
  return { decision: "approve", notes: `Review panel approved (${approvals.length}/${state.lenses.length} lenses).\n${summary}` };
}

/** Whether this change is risky enough to be worth three reviewers instead of one. */
export function wantsReviewPanel(risk: RiskTier | null, gates: GateResult[] | null, enabled: boolean): boolean {
  if (!enabled) return false;
  // Unknown risk is treated as high everywhere else in the system; be consistent here too.
  return (risk ?? "high") === "high";
}
