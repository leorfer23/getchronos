import { activity, db } from "./store.js";

/**
 * What a revived terminal is told when the daemon restarted under it mid-turn.
 *
 * `claude --resume` brings the transcript back, not the turn: the agent that was writing a file
 * when launchd re-exec'd us comes back sitting at its prompt, and the Desk shows a live card that
 * does nothing. On the 2026-09-13 deploy all four revived terminals sat "waiting" at the resume
 * banner; the operator had to notice. The last `session.activity` event is persisted, so the boot
 * can tell which ones were working and type this in once the CLI has settled (typeSeed).
 *
 * Its background work does not come back either. A terminal that ended its turn while a subagent, a
 * long test or a CI watch kept running in the background is quiet at its prompt ("waiting"), and it
 * relies on that task's completion to wake it — but the task died with the old process and will never
 * report. Its CLI's last Stop hook listed what was still running (inFlightAtRestart), so that counts too.
 *
 * Not the hooks' turn state: a finished terminal's hooks often still say "working" (a late subagent
 * stop, a missed Stop), and on 2026-10-30 that would have nudged two terminals already in review.
 */
export const REVIVE_NUDGE =
  "The Chronos daemon restarted under you (a deploy), mid-task. Your transcript is restored, but anything " +
  "you had running in the background — a subagent, a long command, a CI watch — died with it and will never " +
  "report back. Pick up exactly where you left off and continue the task — re-check the state of any file or " +
  "command you were in the middle of, re-run what was in flight if you still need its result, do not start " +
  "over, do not ask whether to continue.";

/** The Desk state (working | waiting | blocked …) the session last reported before the previous daemon died. */
export function lastActivityState(sessionId: string): string | null {
  const [row] = activity.list({ topic: "session.activity", entity: sessionId, limit: 1 });
  if (!row?.detail) return null;
  try { return JSON.parse(row.detail)?.state ?? null; } catch { return null; }
}

/** Keep in step with SUBAGENT_TTL_MS (term-status.ts): a task silent this long stopped counting there too. */
const BACKGROUND_TTL_MS = 3 * 60 * 60 * 1000;
export type InFlight = { background: number; waitingOnYou: boolean };

/**
 * What its CLI's hooks last recorded (term-status.ts Signals, persisted in session_status): how many
 * tasks were still running in the background when its turn ended — the list its last Stop hook
 * reported — and whether it was waiting on the operator (a question or a declared block), which a
 * nudge must never talk over. Read straight from the table: term-status imports terminal.ts, which
 * imports this file.
 */
export function inFlightAtRestart(sessionId: string, now = Date.now()): InFlight {
  try {
    const row = db.prepare("SELECT data FROM session_status WHERE session_id = ?").get(sessionId) as { data: string } | undefined;
    const sig = row ? JSON.parse(row.data) : {};
    const running = Object.values((sig.subagents ?? {}) as Record<string, { at?: number }>)
      .filter((t) => now - (t?.at ?? 0) < BACKGROUND_TTL_MS).length;
    const declared = sig.declared?.state;
    return {
      background: sig.turn?.state === "stopped" ? running : 0,
      waitingOnYou: !!sig.asking || declared === "blocked" || declared === "decide",
    };
  } catch {
    return { background: 0, waitingOnYou: false };
  }
}

export function reviveSeedFor(state: string | null, inFlight?: InFlight | null): string | null {
  if (state === "working") return REVIVE_NUDGE;
  if (state === "blocked" || !inFlight || inFlight.waitingOnYou) return null;
  return inFlight.background > 0 ? REVIVE_NUDGE : null;
}
