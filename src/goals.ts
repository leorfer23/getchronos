import { sessions, sessionGoals } from "./store.js";
import type { GoalKind, GoalSource, Session, SessionGoal } from "./types.js";

/**
 * A terminal's goals, as the rest of the daemon sees them.
 *
 * One rule holds the feature together: **the session row always mirrors the current goal.** Every
 * surface that existed before the list — the Desk card, the fleet line, Robert's wake, the phase
 * machine, the day's log — reads `sessions.goal` / `goal_kind` / `goal_done_at` and keeps working
 * unchanged, because those columns now hold the first goal that is not ticked (or, when they all
 * are, the last one plus the moment the list was finished).
 *
 * The other rule is the one the operator feels: `mc goal done` ticks ONE goal. With more queued
 * behind it the card moves on to the next line and the terminal keeps going; only the last tick
 * closes the terminal out.
 */

/** Rewrite the mirror columns from the list. A terminal with no list is left exactly as it is. */
export function syncGoalMirror(sessionId: string): Session | undefined {
  const m = sessionGoals.mirror(sessionId);
  if (!m) return sessions.get(sessionId);
  const cur = sessionGoals.current(sessionId);
  sessions.setGoal(sessionId, {
    goal: m.goal,
    goal_kind: m.goal_kind,
    goal_done_at: m.goal_done_at,
    // Whoever wrote the goal that is now on the card still owns it — a mirror write must not
    // silently relabel an agent's own wording as the operator's (that flag decides whether the
    // Desk title deriver may rename it later, see src/desk-title.ts).
    goal_source: (cur?.source ?? "human") as GoalSource,
  });
  return sessions.get(sessionId);
}

/**
 * Queue one more finish line behind whatever this terminal is already on.
 *
 * The first append to a terminal opened the old way folds its single goal in as item #1 (`adopt`),
 * so no session has to be migrated and "add a second goal" always means what it says.
 */
export function addGoals(
  sessionId: string,
  items: Array<{ text: string; kind?: GoalKind | null }>,
  source: GoalSource = "human",
): { goals: SessionGoal[]; session: Session | undefined } {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("no such session");
  sessionGoals.adopt(s);
  for (const it of items) sessionGoals.add(sessionId, { text: it.text, kind: it.kind ?? null, source });
  return { goals: sessionGoals.list(sessionId), session: syncGoalMirror(sessionId) };
}

/** Replace the whole list in one move — `mc goal set` with several, or the spawn dialog. */
export function setGoals(
  sessionId: string,
  items: Array<{ text: string; kind?: GoalKind | null }>,
  source: GoalSource = "human",
): { goals: SessionGoal[]; session: Session | undefined } {
  if (!sessions.get(sessionId)) throw new Error("no such session");
  sessionGoals.replace(sessionId, items, source);
  if (!items.length) {
    // Back to a terminal with no list: the columns are the goal again, and there is nothing to
    // mirror — clear them rather than leave the last list item standing as a ghost.
    sessions.setGoal(sessionId, { goal: null, goal_kind: null, goal_done_at: null, goal_source: source });
    return { goals: [], session: sessions.get(sessionId) };
  }
  return { goals: sessionGoals.list(sessionId), session: syncGoalMirror(sessionId) };
}

export type TickResult = {
  /** The goal this call ticked off, if there was one open. */
  ticked: SessionGoal | undefined;
  /** What the card moved on to, or undefined when that was the last one. */
  next: SessionGoal | undefined;
  /** True when the terminal itself is finished — nothing is left open. */
  finished: boolean;
  session: Session | undefined;
};

/**
 * `mc goal done`. With a list, ticks the current item and advances; without one, ticks the single
 * goal the row carries. `finished` is what the caller should act on: it is the only case that means
 * "close this terminal out" (freeze the ledger, write the day's log, wake whoever was waiting).
 */
export function tickCurrentGoal(sessionId: string): TickResult {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("no such session");
  if (!sessionGoals.counts(sessionId).total) {
    sessions.setGoal(sessionId, { goal_done: true });
    return { ticked: undefined, next: undefined, finished: true, session: sessions.get(sessionId) };
  }
  const { ticked, next } = sessionGoals.tickCurrent(sessionId);
  const session = syncGoalMirror(sessionId);
  return { ticked, next, finished: !next, session };
}

/** The operator closing a card that is good enough: every open goal ticked at once. */
export function tickAllGoals(sessionId: string): TickResult {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("no such session");
  if (!sessionGoals.counts(sessionId).total) {
    sessions.setGoal(sessionId, { goal_done: true });
    return { ticked: undefined, next: undefined, finished: true, session: sessions.get(sessionId) };
  }
  const last = sessionGoals.list(sessionId).at(-1);
  sessionGoals.tickAll(sessionId);
  return { ticked: last ? sessionGoals.get(last.id) : undefined, next: undefined, finished: true, session: syncGoalMirror(sessionId) };
}

/** Untick — "that is not done after all", from the card or from `mc goal reopen`. */
export function reopenGoal(sessionId: string, goalId?: string): TickResult {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("no such session");
  const list = sessionGoals.list(sessionId);
  if (!list.length) {
    sessions.setGoal(sessionId, { goal_done: false });
    return { ticked: undefined, next: undefined, finished: false, session: sessions.get(sessionId) };
  }
  // No id given: the most recently ticked one — "undo the tick I just made".
  const target = goalId
    ? list.find((g) => g.id === goalId)
    : list.filter((g) => g.done_at).sort((a, b) => (a.done_at! < b.done_at! ? 1 : -1))[0];
  if (!target) return { ticked: undefined, next: sessionGoals.current(sessionId), finished: false, session: s };
  sessionGoals.patch(target.id, { done: false });
  const session = syncGoalMirror(sessionId);
  return { ticked: undefined, next: sessionGoals.current(sessionId), finished: false, session };
}

/** One line per goal, for a terminal, a CLI listing or an agent's seed: `1. ✓ open the PR`. */
export function goalLines(goals: SessionGoal[]): string[] {
  return goals.map((g) => `${g.seq}. ${g.done_at ? "✓" : "·"} ${g.text}${g.kind ? ` [${g.kind}]` : ""}`);
}

/**
 * One goal per line. A goal is a one-line label by definition, so a multi-line one is not a goal —
 * it is a queue that was typed into a box that happens to accept newlines (the Desk's New-terminal
 * dialog, a saved launch, `--goal "$(cat goals.txt)"`). Splitting here means every door that opens a
 * terminal gets the queue for free instead of each one learning the trick.
 */
export function splitGoalText(text: string | null | undefined): string[] {
  return (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*\u2022]\s+/, "").trim())
    .filter(Boolean);
}
