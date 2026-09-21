/**
 * "Robert's attention" — what is actually pointed at the fleet right now.
 *
 * "Robert drives the fleet" is a claim the Desk has been asking the operator to take on faith: the
 * standing watches live in `sessions.watch_*`, the armed wakes live in a Map inside robert-drive.ts,
 * the queued ones in `robert_wakes`, and the supervision verdict in a predicate nobody reads unless
 * something already went wrong. Four places, none of them on screen — so the failure mode is not
 * "Robert did the wrong thing", it is "nothing was armed and it looked exactly the same".
 *
 * This reader puts the four in one payload so a card can DRAW them: who he is watching and when he
 * looks next, what he is about to open and in how long, what woke him last and why, and whether the
 * predicate that guarantees any of it still holds.
 *
 * Read-only by contract (src/widgets/index.ts): every number here comes out of state something else
 * owns. The one thing that was not reachable is the armed timers, which exist only in memory — see
 * `armedWakes()` in robert-drive.ts, a pure getter added for this card.
 */
import type { Widget } from "./index.js";
import { armedWakes } from "../robert-drive.js";
import { isWatchLooking, watchView } from "../desk-watch.js";
import { supervisionVerdict } from "../supervision-guard.js";
import { wakeBeaconAgeMs } from "../wake-queue.js";
import { chat, robertWakes, sessions } from "../store.js";
import { statusOf } from "../term-status.js";
import type { RobertWake } from "../store.js";
import type { Session } from "../types.js";

/**
 * How many terminals the graph can hold before it stops being readable. Twelve nodes on a ring with
 * a label each is already the edge of legible; past that the card says "+N more" and keeps the ones
 * that earned their place (see `rankNodes`).
 */
export const NODE_CAP = 12;

/** A wake older than this is history, not something the card should still be drawing an edge for. */
export const WOKE_WINDOW_MS = 2 * 60 * 60_000;

/**
 * Why a stop is Robert's business, in five words. The long form is `driveSay()` in robert-drive.ts —
 * this is the same table said short enough to sit under a node.
 */
export const WAKE_WHY: Record<string, string> = {
  review: "says it's done",
  turn: "turn finished",
  decide: "waiting on a decision",
  blocked: "declared blocked",
  robert: "waiting on Robert",
  "review.created": "a review landed",
  "ask.created": "a worker asked",
  "ticket.updated": "a ticket went blocked",
};

export function whyOf(kind: string): string {
  return WAKE_WHY[kind] ?? kind.replace(/[._-]+/g, " ");
}

/** `session.turn` → `turn`; anything else keeps its topic, which is already the reason. */
export function wakeKindOf(topic: string): string {
  return topic.startsWith("session.") ? topic.slice("session.".length) : topic;
}

/**
 * Which terminal a wake is about, if any. Drive wakes carry it twice (payload and `subject`) and the
 * ticket/review/ask wakes carry neither — those are real wakes with no node to hang an edge on, so
 * the card lists them in the rail and draws nothing.
 */
export function wakeSession(w: Pick<RobertWake, "subject" | "payload">): string | null {
  const m = /^session:(.+)$/.exec(w.subject ?? "");
  if (m) return m[1];
  try {
    const p = w.payload ? JSON.parse(w.payload) : null;
    const id = p && typeof p === "object" ? (p as { session_id?: unknown }).session_id : null;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

export type RobertNode = {
  id: string;
  workspace_id: string | null;
  title: string;
  phase: string;
  /** A standing watch (src/desk-watch.ts): he re-reads this one on a clock. */
  watching?: { every_min: number; next_at: string | null; looking: boolean };
  /** A stop inside its grace (src/robert-drive.ts): he opens it at `fire_at` unless it moves first. */
  armed?: { kind: string; fire_at: number; why: string };
  /** He was woken about this terminal, recently enough to still explain what he is doing. */
  woke?: { at: string; why: string };
};

/** The rail's triage order (src/term-status.ts), for the terminals nothing else distinguishes. */
export const PHASE_RANK: Record<string, number> = {
  blocked: 0, decide: 1, review: 2, your_turn: 3, stalled: 4, waiting: 5, working: 6, ended: 7,
};

/** What earns a node its place when there are more terminals than the graph can hold. */
export function nodeTier(n: RobertNode): number {
  if (n.armed) return 0;
  if (n.watching) return 1;
  if (n.woke) return 2;
  return 3;
}

const stamp = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/**
 * The nodes the card draws, in the order it draws them, capped. Pure: the whole "which twelve" rule
 * is a test rather than something you only see once the operator has thirteen terminals open.
 *
 * Anything Robert is pointed at comes first — armed, then watched, then recently woken — because a
 * card that drops an armed wake to make room for an idle terminal is lying about his attention.
 */
export function rankNodes(nodes: RobertNode[], cap = NODE_CAP): { nodes: RobertNode[]; more: number } {
  const sorted = [...nodes].sort((a, b) => {
    const tier = nodeTier(a) - nodeTier(b);
    if (tier) return tier;
    if (a.armed && b.armed) return a.armed.fire_at - b.armed.fire_at || a.id.localeCompare(b.id);
    if (a.watching && b.watching) return stamp(a.watching.next_at) - stamp(b.watching.next_at) || a.id.localeCompare(b.id);
    if (a.woke && b.woke) return stamp(b.woke.at) - stamp(a.woke.at) || a.id.localeCompare(b.id);
    const ph = (PHASE_RANK[a.phase] ?? 9) - (PHASE_RANK[b.phase] ?? 9);
    return ph || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  });
  return { nodes: sorted.slice(0, cap), more: Math.max(0, sorted.length - cap) };
}

/** One line of "he'll open next". `id` is the terminal when the wake names one, else the wake's own id. */
export type QueueEntry = { id: string; fire_at: number; kind: string; why: string; queued: boolean; label: string | null };

/**
 * Fire order. A queued row is already due — the drain takes it on its next pass — so it sorts by when
 * it was written and lands ahead of anything still inside its grace. Ties break on id so the rail's
 * numbering does not reshuffle between two refreshes that saw the same fleet.
 */
export function orderQueue(entries: QueueEntry[]): QueueEntry[] {
  return [...entries].sort((a, b) => a.fire_at - b.fire_at || a.id.localeCompare(b.id));
}

export type RobertState = { state: "idle" | "busy"; ws: string | null; since: number | null; last_turn_at: string | null };

/**
 * Is he mid-turn, and on whose behalf? Pure over the two durable signals the daemon does expose: a
 * watch that is mid-look (`isWatchLooking`) and a wake row that was claimed but not handled. There is
 * no exported "which warm manager is busy" in telegram/agent.ts, so `last_turn_at` (his last line in
 * the chat) is what an idle card shows instead of inventing a state.
 */
export function robertState(input: {
  looking: { workspace_id: string | null; since: number | null }[];
  claimed: { workspace_id: string | null; claimed_at: string | null }[];
  lastTurnAt: string | null;
}): RobertState {
  const busy = [
    ...input.looking.map((l) => ({ ws: l.workspace_id, at: l.since })),
    ...input.claimed.map((c) => ({ ws: c.workspace_id, at: stamp(c.claimed_at) || null })),
  ];
  if (!busy.length) return { state: "idle", ws: null, since: null, last_turn_at: input.lastTurnAt };
  // Oldest first: the turn that has been running longest is the one worth naming.
  const oldest = busy.reduce((a, b) => ((a.at ?? Infinity) <= (b.at ?? Infinity) ? a : b));
  return { state: "busy", ws: oldest.ws, since: oldest.at, last_turn_at: input.lastTurnAt };
}

const titleOf = (s: Session): string =>
  (s.goal ?? s.spawn_goal ?? (s as { ticket_title?: string | null }).ticket_title ?? "").trim() ||
  `${(s.backend ?? "").replace("-code", "") || "terminal"} terminal`;

const lastRobertTurn = (): string | null => {
  try {
    const rows = chat.recentAll(60) as { reply?: string; source?: string; created_at?: string }[];
    for (let i = rows.length - 1; i >= 0; i--) if ((rows[i].reply ?? "").trim()) return rows[i].created_at ?? null;
  } catch {}
  return null;
};

const robert: Widget = {
  name: "robert",
  title: "Robert's attention",
  // Status changes re-arm wakes, session.updated is what a watch publishes when it looks and when it
  // reports, and agent.push is a turn of his landing in the thread.
  topics: ["session.status", "session.updated", "session.ended", "agent.push"],
  data: () => {
    const now = Date.now();
    const live = sessions.list({ status: "live" });
    const armed = new Map(armedWakes().map((a) => [a.session_id, a]));
    const unacked = robertWakes.unacked();

    // Newest first across both halves of the queue table — `generation` is monotonic, so this is the
    // order things actually happened in, whatever retention has since deleted.
    const wakes = [...unacked, ...robertWakes.recentAcked(30)].sort((a, b) => b.generation - a.generation);
    const wokeBy = new Map<string, RobertWake>();
    for (const w of wakes) {
      const sid = wakeSession(w);
      if (sid && !wokeBy.has(sid) && now - stamp(w.created_at) < WOKE_WINDOW_MS) wokeBy.set(sid, w);
    }
    const newest = wakes[0] ?? null;

    const all: RobertNode[] = live.map((s) => {
      const st = statusOf(s.id);
      const w = watchView(s, now);
      const a = armed.get(s.id);
      const woke = wokeBy.get(s.id);
      return {
        id: s.id,
        workspace_id: s.workspace_id ?? null,
        title: titleOf(s),
        phase: st?.phase ?? "waiting",
        ...(w?.active && w.every_min
          ? { watching: { every_min: w.every_min, next_at: w.next_due, looking: !!w.looking } }
          : {}),
        ...(a ? { armed: { kind: a.kind, fire_at: a.fire_at, why: whyOf(a.kind) } } : {}),
        ...(woke ? { woke: { at: woke.created_at, why: whyOf(wakeKindOf(woke.topic)) } } : {}),
      };
    });
    const { nodes, more } = rankNodes(all);
    const drawn = new Set(nodes.map((n) => n.id));

    const queue = orderQueue([
      ...unacked.map((w) => {
        const sid = wakeSession(w);
        const kind = wakeKindOf(w.topic);
        return {
          id: sid ?? w.id,
          fire_at: stamp(w.created_at),
          kind,
          why: whyOf(kind),
          queued: true,
          label: sid ? null : (w.subject ?? w.key),
        };
      }),
      ...[...armed.values()].map((a) => ({
        id: a.session_id,
        fire_at: a.fire_at,
        kind: a.kind,
        why: whyOf(a.kind),
        queued: false,
        label: null,
      })),
    ]);

    const v = supervisionVerdict(now);
    const lookingRows = live
      .filter((s) => isWatchLooking(s.id))
      .map((s) => ({ workspace_id: s.workspace_id ?? null, since: stamp(s.watch_last_at) || null }));
    const claimed = unacked
      .filter((w) => w.claimed_at && !w.handled_at)
      .map((w) => ({ workspace_id: w.workspace_id, claimed_at: w.claimed_at }));

    return {
      now,
      robert: robertState({ looking: lookingRows, claimed, lastTurnAt: lastRobertTurn() }),
      supervision: {
        ok: v.ok,
        reason: v.reason,
        in_flight: v.inFlight,
        armed: v.armed.length,
        beacon_age_ms: wakeBeaconAgeMs(now),
      },
      nodes,
      more,
      queue,
      last_wake: newest
        ? { id: (() => { const s = wakeSession(newest); return s && drawn.has(s) ? s : null; })(), at: newest.created_at, why: whyOf(wakeKindOf(newest.topic)) }
        : null,
    };
  },
};

export default robert;
