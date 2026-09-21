/**
 * One-time jobs: trigger_type "once" with a `run_at`. The scheduler arms a single fire at that
 * time; when it fires, `run_at` is cleared and the job stays as an ordinary manual job with its
 * run in the history (re-runnable, re-schedulable). A fire the daemon slept through is caught up
 * on boot if it is recent and never ran; anything older is dropped rather than fired at a random
 * later hour.
 */
export const ONCE_CATCHUP_MS = 12 * 60 * 60 * 1000;

export type OnceDecision = "schedule" | "fire" | "retire";

export function onceDecision(runAt: string | null | undefined, hasRunSince: boolean, now = Date.now()): OnceDecision {
  const at = runAt ? Date.parse(runAt) : NaN;
  if (Number.isNaN(at)) return "retire";
  if (at > now) return "schedule";
  if (hasRunSince) return "retire";
  return now - at < ONCE_CATCHUP_MS ? "fire" : "retire";
}
