/**
 * Since when this Mac (the brain) has been continuously awake: its boot, or its last wake from sleep —
 * dark wakes included (`kern.waketime`). Time the brain spent asleep is never anybody's absence:
 *   - host-failover.ts: a host is never "offline for 5 minutes" before the brain has been awake that
 *     long (2026-09-30: a sweep in a dark wake moved four live terminals off a host that was fine);
 *   - term-status.ts: a terminal is never "silent for 3 minutes mid-turn" when the Mac slept through them;
 *   - runner.ts: a run's timeout counts awake time only (awakeTimeout);
 *   - scheduler.ts: a cron fire waits until the Mac has been awake a minute, not a 2-second dark wake.
 *
 * Node's clocks cannot tell: its monotonic clock keeps counting through sleep (checked: hrtime 30.5h vs
 * CLOCK_UPTIME_RAW 17.6h on the same boot), so a sleep looks like a slow timer. No imports beyond
 * child_process, so anything can read it without dragging a module graph along.
 */
import { execFileSync } from "node:child_process";

let awakeSince = Date.now();
let probedAt = 0;
/** kern.waketime is a sysctl (a child process): read at most this often on the read path. */
const PROBE_EVERY_MS = 30_000;

/** When macOS last woke, dark wakes included, or null elsewhere / when it cannot be read. */
export function macLastWake(): number | null {
  if (process.platform !== "darwin") return null;
  try {
    const m = /sec = (\d+), usec = (\d+)/.exec(execFileSync("sysctl", ["-n", "kern.waketime"], { encoding: "utf8", timeout: 2_000 }));
    return m ? Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1000) : null;
  } catch {
    return null;
  }
}
let lastWake: () => number | null = macLastWake;

/** Move the awake mark up to the latest wake. */
export function noteBrainWake(): void {
  const w = lastWake();
  if (w === null || w <= awakeSince) return;
  if (w - awakeSince > 60_000) console.log(`[awake] brain woke at ${new Date(w).toISOString()} — silences and absences count from here`);
  awakeSince = w;
}

/** The mark as it stands (no probe) — for a caller that just ran noteBrainWake itself. */
export const awakeMark = (): number => awakeSince;

/** The mark, freshly probed when the last probe is older than 30s. */
export function brainAwakeSince(nowMs = Date.now()): number {
  if (nowMs - probedAt >= PROBE_EVERY_MS) {
    probedAt = nowMs;
    noteBrainWake();
  }
  return awakeSince;
}

/**
 * setTimeout on awake time: time the Mac slept does not count toward `ms`. A run's watchdog the Mac slept
 * through fired on the next wake and killed a run that had been awake for 4 seconds (2026-11-12,
 * reap-stale-worktrees-chronos). A tick that comes late across a wake counts only the time since that
 * wake; the awake time before the sleep (under one tick) is dropped. Returns the cancel.
 */
export function awakeTimeout(fn: () => void, ms: number, tickMs = 10_000): () => void {
  let left = ms;
  let last = Date.now();
  let t: ReturnType<typeof setTimeout>;
  const arm = () => {
    t = setTimeout(tick, Math.max(1, Math.min(tickMs, left)));
    t.unref?.();
  };
  const tick = () => {
    const now = Date.now();
    const w = now - last > 2 * tickMs ? lastWake() : null;
    left -= w !== null && w > last && w <= now ? now - w : now - last;
    last = now;
    if (left > 0) return arm();
    fn();
  };
  arm();
  return () => clearTimeout(t);
}

/** Tests (and host-failover's own reset): a boot time and a fake "last wake". */
export function resetBrainAwake(o: { bootAt?: number; lastWake?: () => number | null } = {}): void {
  awakeSince = o.bootAt ?? Date.now();
  lastWake = o.lastWake ?? macLastWake;
  probedAt = 0;
}
