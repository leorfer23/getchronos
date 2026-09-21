/**
 * Fleet pulse — one band per terminal, showing the PHASE it was in across the last hour.
 *
 * The rail already answers "what is it doing now". The question it cannot answer is "how did it get
 * here": a terminal reading `decide · 40m` looks identical whether it asked once and has been waiting
 * since, or has been flapping working→your_turn→working all morning and just happens to be stuck this
 * minute. Those two want opposite things from the operator, and the difference is entirely in the
 * shape of the last hour.
 *
 * The history is session_phases (migration 119), appended by term-status.ts on every transition; this
 * is its only consumer. Read-only like every widget — the one write in reach is term-status's own
 * append inside statusOf, which the Desk's /desk poll already makes on the same rows every few
 * seconds, so a mounted card adds nothing to it.
 */
import { db, sessions } from "../store.js";
import { statusOf, type Phase } from "../term-status.js";
import type { Widget } from "./index.js";

/** How long an ended terminal stays on the board, dimmed. Long enough to notice it finished. */
export const ENDED_GRACE_MS = 30 * 60 * 1000;
export const DEFAULT_WINDOW_MIN = 60;
/** The rail's triage order (the `PH` table in desk.html), so the card reads top-to-bottom the same. */
export const PHASE_RANK: Record<string, number> = {
  blocked: 0, decide: 1, review: 2, your_turn: 3, stalled: 4, waiting: 5, working: 6, ended: 7,
};

/**
 * Whoever needs you first, then who has waited longest inside a band — the rail's own sort (railOrder
 * in desk.html), so the board and the rail never disagree about which terminal to look at next.
 */
export const byTriage = (a: { phase: string; since: number; id: string }, b: { phase: string; since: number; id: string }): number =>
  (PHASE_RANK[a.phase] ?? 9) - (PHASE_RANK[b.phase] ?? 9) || a.since - b.since || a.id.localeCompare(b.id);

export type Segment = { phase: string; from: number; to: number };
export type PulseRow = {
  id: string;
  workspace_id: string | null;
  /** A fallback only: the page prefers `ctx.chipLabel(ctx.byId(id))`, which clips it the rail's way. */
  title: string;
  phase: Phase;
  /** When the CURRENT phase began — the number under the word on the right of the band. */
  since: number;
  segments: Segment[];
};

/**
 * History rows → the bands actually drawn, clipped to [from, to].
 *
 * Pure and exported because every interesting case here is an edge: a session whose only transition
 * predates the window (one full-width band), a session with no rows at all (its `since` is all we
 * know), and the tail, which is `statusOf`'s answer and not the table's — the in-memory clock moves a
 * phase on a timer (an ETA passing, a hook-working terminal gone silent) and the row for that is
 * written on the next read, so history can lag the truth by one refresh. The truth wins.
 */
export function segmentsFrom(
  rows: { phase: string; at: number }[],
  o: { from: number; to: number; phase: string; since: number },
): Segment[] {
  const tail = Math.min(o.since, o.to);
  const marks = [...rows].sort((a, b) => a.at - b.at).filter((r) => r.at < tail);
  marks.push({ phase: o.phase, at: tail });
  return marks
    .map((m, i) => ({ phase: m.phase, from: m.at, to: marks[i + 1]?.at ?? o.to }))
    .map((s) => ({ phase: s.phase, from: Math.max(s.from, o.from), to: Math.min(s.to, o.to) }))
    .filter((s) => s.to > s.from);
}

const historyOf = (id: string): { phase: string; at: number }[] => {
  try {
    return db.prepare("SELECT phase, at FROM session_phases WHERE session_id = ? ORDER BY at").all(id) as {
      phase: string;
      at: number;
    }[];
  } catch {
    // The table is one migration old; a card is not worth a 500 on a daemon that predates it.
    return [];
  }
};

export function pulseData(q: Record<string, string> = {}, now = Date.now()) {
  const window = Math.min(24 * 60, Math.max(5, Math.round(Number(q.window) || DEFAULT_WINDOW_MIN)));
  const from = now - window * 60_000;
  const rows: PulseRow[] = [];

  for (const s of sessions.list({ limit: 300 })) {
    // Ended long ago is most of the table: skip it before paying for statusOf, which resolves signals,
    // asks and the agent overlay per row.
    const endedAt = Date.parse(s.ended_at ?? "") || null;
    if (s.status !== "live" && !(endedAt && endedAt > now - ENDED_GRACE_MS)) continue;
    const st = statusOf(s.id, now);
    if (!st) continue;
    const hist = historyOf(s.id);
    // `live` on the Desk is a pty, not the row's status (api.ts /desk) — a row still marked live whose
    // process is gone resolves to "ended" here too, and leaves on the same 30-minute clock.
    const ended = st.phase === "ended";
    const lastMark = hist.length ? hist[hist.length - 1].at : null;
    const since = ended ? (endedAt ?? lastMark ?? now) : st.since;
    if (ended && since <= now - ENDED_GRACE_MS) continue;
    rows.push({
      id: s.id,
      workspace_id: s.workspace_id ?? null,
      title: s.goal || s.title || (s.backend ? s.backend.replace("-code", "") + " terminal" : "terminal"),
      phase: st.phase,
      since,
      segments: segmentsFrom(hist, { from, to: now, phase: st.phase, since }),
    });
  }

  rows.sort(byTriage);
  return { now, window, rows };
}

const pulse: Widget = {
  name: "pulse",
  title: "Fleet pulse",
  // status is the transition itself; started/ended are a band appearing and a band closing.
  topics: ["session.status", "session.started", "session.ended"],
  data: (q) => pulseData(q),
};

export default pulse;
