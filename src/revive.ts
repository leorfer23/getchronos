import { activity } from "./store.js";

/**
 * What a revived terminal is told when the daemon restarted under it mid-turn.
 *
 * `claude --resume` brings the transcript back, not the turn: the agent that was writing a file
 * when launchd re-exec'd us comes back sitting at its prompt, and the Desk shows a live card that
 * does nothing. On the 2026-09-13 deploy all four revived terminals sat "waiting" at the resume
 * banner; the operator had to notice. The last `session.activity` event is persisted, so the boot
 * can tell which ones were working and type this in once the CLI has settled (typeSeed).
 */
export const REVIVE_NUDGE =
  "The Chronos daemon restarted under you (a deploy), mid-turn. Your transcript is restored. " +
  "Pick up exactly where you left off and continue the task — re-check the state of any file or " +
  "command you were in the middle of, do not start over, do not ask whether to continue.";

/** The Desk state (working | waiting | blocked …) the session last reported before the previous daemon died. */
export function lastActivityState(sessionId: string): string | null {
  const [row] = activity.list({ topic: "session.activity", entity: sessionId, limit: 1 });
  if (!row?.detail) return null;
  try { return JSON.parse(row.detail)?.state ?? null; } catch { return null; }
}

export function reviveSeedFor(state: string | null): string | null {
  return state === "working" ? REVIVE_NUDGE : null;
}
