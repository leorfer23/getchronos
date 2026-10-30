/**
 * Two terminals on the same job, caught when the second one OPENS — before this it only showed when
 * one of them stopped and Robert read both screens.
 *
 *  - **Warn, never refuse.** The terminal is open by the time this runs; the opener hears it in the
 *    open response (`mc session new` prints it, the Desk toasts it) and Robert on his wake queue.
 *  - **Cheap and local.** The shared Jaccard over goal words (text-similarity.ts) — no model call on
 *    the open path.
 *  - **Same workspace, live terminals only.** A workspace is a client boundary: one client's goals are
 *    never read against another's. An ended terminal is not doing the work any more.
 *
 * DUP_GOAL_MIN: over the Chronos workspace's 49 goals up to 2026-10-30, the two real repeats scored
 * 0.80 and 0.83 and every other pair 0.33 or less. 0.5 sits in that gap.
 */
import { similarity } from "./text-similarity.js";
import { sessions, workspaces } from "./store.js";
import type { Session } from "./types.js";

export const DUP_GOAL_MIN = 0.5;
/** Wake key prefix: one notice per opened terminal. */
export const DUP_GOAL_KEY = "term-dup:";

export interface DupGoal {
  /** The live terminal that already has this job. */
  id: string;
  goal: string;
  /** Jaccard over goal words, 0..1. */
  score: number;
  /** One line for whoever opened the new terminal. */
  warning: string;
}

type Opened = Pick<Session, "id" | "workspace_id" | "goal" | "spawn_goal" | "lead_id">;

const goalOf = (s: Pick<Session, "goal" | "spawn_goal">) => (s.goal ?? s.spawn_goal ?? "").trim();
const id8 = (id: string) => id.slice(0, 8);
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Pure: the live terminal in the opener's own workspace whose goal reads most like its own, or null. */
export function dupGoalAmong(opened: Opened, others: Session[], min = DUP_GOAL_MIN): DupGoal | null {
  const goal = goalOf(opened);
  if (!goal || !opened.workspace_id) return null;
  let best: { o: Session; goal: string; score: number } | null = null;
  for (const o of others) {
    if (o.id === opened.id || o.workspace_id !== opened.workspace_id || o.status !== "live") continue;
    // A Lead's worker carries a slice of that Lead's own goal by design.
    if (o.id === opened.lead_id) continue;
    const g = goalOf(o);
    if (!g) continue;
    const score = similarity(goal, g);
    if (score >= min && (!best || score > best.score)) best = { o, goal: g, score };
  }
  if (!best) return null;
  const { o, score } = best;
  return {
    id: o.id,
    goal: best.goal,
    score,
    warning:
      `same work? live terminal ${id8(o.id)} has a goal ${pct(score)} like this one: "${best.goal.slice(0, 120)}". ` +
      `Check it before you start (mc session focus ${id8(o.id)}).`,
  };
}

/** The same check against the store: this workspace's live terminals, nobody else's. */
export function dupGoal(opened: Opened): DupGoal | null {
  if (!opened.workspace_id) return null;
  return dupGoalAmong(opened, sessions.list({ workspace_id: opened.workspace_id, status: "live", limit: 200 }));
}

/** What Robert is told — the wake row itself, so a test can read it without a drain. */
export function dupWake(opened: Opened, dup: DupGoal) {
  const ws = opened.workspace_id ? workspaces.get(opened.workspace_id)?.name ?? "?" : "unscoped";
  return {
    topic: "session.duplicate",
    key: `${DUP_GOAL_KEY}${opened.id}`,
    subject: `session:${opened.id}`,
    workspace_id: opened.workspace_id,
    payload: {
      say:
        `DUPLICATE WORK? · ${ws} — terminal ${id8(opened.id)} just opened with "${goalOf(opened).slice(0, 160)}", ` +
        `${pct(dup.score)} like live terminal ${id8(dup.id)} ("${dup.goal.slice(0, 160)}"). It was opened anyway. ` +
        `Same job → tell the newer one to stand down or split the work with the older (\`mc session send <id> "..."\`); ` +
        `different work → leave both.`,
      session_id: opened.id,
      duplicate_of: dup.id,
      score: dup.score,
    },
  };
}

/**
 * Robert hears it the way he hears a terminal stop: a row on his wake queue, behind the same switch
 * (robert-drive's driveEnabled). Not for a Lead's worker — the Lead opened it and read the warning in
 * its own `mc session new`. Imported lazily: robert-drive and wake-queue both import terminal.ts.
 */
export async function tellRobertDup(opened: Opened, dup: DupGoal): Promise<string | null> {
  if (opened.lead_id) return null;
  const [drive, queue] = await Promise.all([import("./robert-drive.js"), import("./wake-queue.js")]);
  if (!drive.driveEnabled(opened.workspace_id)) return null;
  return queue.enqueueWake(dupWake(opened, dup));
}
