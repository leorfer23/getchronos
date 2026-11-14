/**
 * One goal, one terminal.
 *
 * A terminal that finished its goal kept being handed new ones — another request, another PR, a
 * release step — partly by the operator typing into it and partly by Robert routing follow-ups there.
 * One ran 25 hours on a stack of unrelated goals (~700 turns, ~230M cache-read tokens) and its
 * verifier caught it claiming the wrong things were done. A long mixed context costs more on every
 * turn, blurs what each piece of work did, and the day's log only ever gets the first goal's row.
 *
 *  - A router that hands a terminal NEW work says what it is for (`goal` on POST /sessions/:id/input,
 *    `mc session send --goal`). When that terminal's goal is finished — ticked, or its hand-off says
 *    it shipped — and the new goal is a different one, a fresh terminal opens in the same workspace and
 *    repo, seeded with a short hand-off (routeNewWork). No `goal` = a follow-up: typed in, as before.
 *  - `mc goal set` replacing a finished goal with a different one hears so (freshHint), with the one
 *    command that opens the fresh terminal — `mc session new --from <id>` (withHandoff). The agent
 *    offers it; it is never forced: the operator typing straight into a terminal is his choice.
 *
 * Inside one workspace, always: the hand-off reads one terminal's own row (and its own parked work
 * and questions), and the fresh terminal opens in that terminal's workspace and repo.
 */
import { asks, continuations, kv } from "./store.js";
import { openSession } from "./terminal.js";
import { similarity } from "./text-similarity.js";
import { DUP_GOAL_MIN } from "./dup-goal.js";
import type { Session } from "./types.js";

const id8 = (id: string) => id.slice(0, 8);
const one = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").trim();
const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

/** Two goals are the same work when their words overlap like a repeat does (dup-goal.ts calibration). */
export function sameGoal(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = one(a).toLowerCase(), y = one(b).toLowerCase();
  if (!x || !y) return false;
  return x === y || similarity(x, y) >= DUP_GOAL_MIN;
}

type Marks = Pick<Session, "id" | "goal_done_at" | "outcome">;
/** When the work on the card was last called finished: its tick, or the hand-off that says it shipped. */
const finishMark = (s: Marks): number =>
  Math.max(Date.parse(s.goal_done_at ?? "") || 0, s.outcome?.shipped?.length ? Date.parse(s.outcome.at) || 0 : 0);

const SET_KEY = (sessionId: string) => `goal.set:${sessionId}`;
/**
 * A goal is being written onto this card (PATCH /sessions/:id, a goal list): whatever finish it carries
 * now belongs to the goal before, so remember that mark. Not a clock: a later tick is a later mark, and
 * a tick and a goal in the same millisecond cannot be mistaken for each other.
 */
export function noteGoalSet(s: Marks): void {
  kv.set(SET_KEY(s.id), String(finishMark(s)));
}

export interface Finished {
  goal: string;
  at: string;
  shipped: string[];
}

/**
 * The goal on this terminal's card is finished: ticked (`mc goal done`), or its hand-off on top says
 * it shipped (`mc outcome --shipped`) — and that finish is newer than the last goal written onto the
 * card. Null while it is still at it, or once it has been given a new goal: `goal_done_at` is a sticky
 * record (goalReachedStands), so the tick alone cannot tell.
 */
export function finishedGoal(s: Marks & Pick<Session, "goal" | "spawn_goal">): Finished | null {
  const goal = one(s.goal ?? s.spawn_goal);
  if (!goal) return null;
  const at = finishMark(s);
  if (!at || at <= (Number(kv.get(SET_KEY(s.id))) || 0)) return null;
  return { goal, at: new Date(at).toISOString(), shipped: s.outcome?.shipped ?? [] };
}

/** The short brief a fresh terminal opens with: what the finished one did, where, and what is still open. */
export function handoffFrom(prev: Session): string {
  const o = prev.outcome;
  const goal = one(prev.goal ?? prev.spawn_goal) || "(no goal recorded)";
  const did = clip(one(o?.summary) || one(prev.summary), 400);
  const links = [...new Set(o?.prs ?? [])].slice(0, 4);
  const open: string[] = [];
  if (o && !o.shipped.length && o.ask !== "none")
    open.push(o.ask === "review" ? "its hand-off is waiting for the operator to read it" : `its ${o.ask} is waiting for the operator's yes`);
  for (const c of continuations.list({ session_id: prev.id, status: ["armed", "met"], limit: 5 }))
    open.push(`parked until ${clip(one(c.label), 120)} (mc when show ${id8(c.id)})`);
  for (const a of asks.forSession(prev.id).filter((x) => x.status === "open").slice(0, 3))
    open.push(`open question: ${clip(one(a.question), 160)}`);
  return [
    `## Hand-off from terminal ${id8(prev.id)} (its goal is done)`,
    `It worked on: ${clip(goal, 200)}`,
    o?.shipped.length ? `Shipped: ${o.shipped.join(" · ")}` : null,
    did ? `What it did: ${did}` : null,
    ...links.map((u) => `Link: ${u}`),
    prev.worktree_branch ? `Its branch: ${prev.worktree_branch} — that checkout is its own; claim yours with \`mc worktree\` before you edit.` : null,
    ...(open.length ? ["Still open:", ...open.map((x) => `- ${x}`)] : []),
    `Its whole conversation: \`mc session focus ${id8(prev.id)}\` (full id ${prev.id}) — read it only if you need more than this. That terminal stays as it is.`,
  ].filter((l): l is string => l !== null).join("\n");
}

/**
 * `mc session new --from <id>`: the new terminal's body carries the finished one's hand-off, in its
 * workspace and (unless the caller named one) its repo. The caller has already checked `prev` is in its
 * own scope; a different workspace is refused there, never here.
 */
export function withHandoff<T extends { workspace_id?: string | null; repo_id?: string | null; description?: string | null }>(body: T, prev: Session): T {
  return {
    ...body,
    workspace_id: prev.workspace_id,
    repo_id: body.repo_id ?? prev.repo_id ?? null,
    description: [handoffFrom(prev), one(body.description) ? `\n## Your work now\n${body.description!.trim()}` : null].filter(Boolean).join("\n"),
  };
}

/** What `mc goal set` hears when it replaces a finished goal with a different one. */
export function freshHint(s: Pick<Session, "id">, done: Finished, goal: string) {
  const command = `mc session new --from ${id8(s.id)} --goal "${clip(one(goal), 200).replace(/"/g, "'")}"`;
  const shipped = done.shipped.length ? ` (${done.shipped.join(", ")})` : "";
  return {
    from_goal: done.goal,
    command,
    say: [
      `↪ A different goal in a finished terminal: this one already did "${clip(done.goal, 120)}"${shipped}.`,
      "  Offer the operator a fresh terminal for it, in one line — a long mixed context costs more and blurs what each piece of work did.",
      "  It opens in this workspace and repo with your hand-off (what you shipped, links, open items, this terminal's id).",
      `  He or Robert runs it (a terminal cannot open one): ${command}`,
      "  If he keeps you here, carry on — his call.",
    ].join("\n"),
  };
}

/** Test seam: how the fresh terminal is opened. */
type Opener = (opts: Parameters<typeof openSession>[0]) => Promise<Session>;
let opener: Opener = openSession;
export function setFreshOpener(fn: Opener | null): void { opener = fn ?? openSession; }

export type Routed = { opened: Session; from_goal: string } | { refused: string };

/**
 * New work routed into `target` with the goal it is for. A fresh terminal, when the target's goal is
 * finished and this is a different one; null = type it into the target as before (a follow-up on its
 * goal, a terminal still at it, a Lead, a cloud terminal). A refused open (the workspace's seat cap,
 * placement) comes back as `refused`, and the caller types it in anyway: work is never dropped for
 * want of a seat.
 */
export async function routeNewWork(
  target: Session,
  work: { goal: string; text: string; by: string; leadId?: string | null },
): Promise<Routed | null> {
  if (!target.workspace_id || target.role === "lead" || target.cloud_agent_id) return null;
  try {
    const done = finishedGoal(target);
    if (!done || sameGoal(work.goal, done.goal)) return null;
    // No cwd: it starts where any new terminal of that repo starts (resolveSessionCwd) and claims its
    // own worktree — never inside the finished terminal's checkout, which holds that work's branch.
    const fresh = await opener({
      workspace_id: target.workspace_id,
      repo_id: target.repo_id ?? null,
      goal: clip(one(work.goal), 400),
      description: `${handoffFrom(target)}\n\n## Your work now\n${clip(work.text.trim(), 12_000)}`,
      created_by: work.by,
      role: target.role === "worker" ? "worker" : "human",
      ...(work.leadId ? { lead_id: work.leadId } : {}),
    } as unknown as Parameters<typeof openSession>[0]);
    console.log(`[fresh] ${id8(target.id)} finished "${clip(done.goal, 60)}" — new work opened in ${id8(fresh.id)} (${work.by})`);
    return { opened: fresh, from_goal: done.goal };
  } catch (e: any) {
    return { refused: clip(String(e?.message ?? e), 200) };
  }
}
