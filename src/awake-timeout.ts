/**
 * A timeout measured in time the computer was AWAKE. A plain setTimeout counts sleep: on battery the
 * Mac sleeps for ~17 min between dark wakes, and a 900 s watchdog armed before the sleep fires on the
 * next wake with the run ~20 s old (run 32ca4b2e, pmset log 2026-11-02 07:31:15 → 07:48:07). Node has
 * no clock that stops in sleep (process.hrtime counts it on macOS too), so sleep is read off the timers.
 *
 * The deadline is walked in steps of at most `tickMs`. A step that fires within a tick of when it was
 * due counts its wall-clock gap; one that fires later slept through it (or the clock jumped) and counts
 * nothing. So a sleep never runs the clock out: each one costs the run at most the step it fell in
 * (≤ one tick of awake time not counted), and the dark wakes of a night on battery add nothing.
 * No imports: the brain (runner.ts) and a host (hostd/procs.ts) both use it.
 */
export type AwakeTimeout = { clear(): void };

export function awakeTimeout(fn: () => void, ms: number, o: { tickMs?: number } = {}): AwakeTimeout {
  const tick = Math.max(1, o.tickMs ?? 30_000);
  let spent = 0;
  let last = Date.now();
  let wait = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    wait = Math.max(0, Math.min(tick, ms - spent));
    timer = setTimeout(step, wait);
    timer.unref?.();
  };
  const step = () => {
    const now = Date.now();
    const gap = Math.max(0, now - last);
    last = now;
    if (gap <= wait + tick) spent += gap;
    if (spent >= ms) {
      timer = null;
      fn();
    } else arm();
  };
  arm();
  return {
    clear() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
