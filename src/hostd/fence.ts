/**
 * The host's fence (HOSTS.md → Reconnect and restarts → The fence). Pure, apart from `signalGroup`.
 *
 * A brain that cannot hear a host for its failover grace reopens that host's terminals somewhere else
 * (src/host-failover.ts). It cannot tell a host that is GONE from one it merely cannot reach — a
 * partition looks the same as a power cut from the other side — so the host fences itself: once it
 * has not heard the brain for a little LESS than that grace, it freezes (SIGSTOP, never SIGKILL) every
 * terminal and run it holds. Whichever side the outage was, two agents never work the same goal: by
 * the time the brain opens a stand-in, the original is stopped.
 *
 * Nothing thaws on its own. When the link is back, the brain's reconcile says per channel: `attach`
 * (still this host's — SIGCONT, carry on) or `kill` (it was moved — salvage, then stop it for good).
 *
 * Both clocks are each machine's own: the host counts from the last frame it heard, the brain from
 * the last it heard (or later: its own boot or wake, hostOfflineSince). The host's mark is never
 * later than the brain's by more than one vitals interval (5s), so a margin of minutes is the
 * guarantee. A host that slept through the grace freezes on its first tick awake, before its link
 * can come back.
 */

/** Largest margin taken off the brain's grace (2 min); smaller graces lose a quarter. */
export const FENCE_MARGIN_MAX_MS = 2 * 60_000;
/** How often the host looks. */
export const FENCE_TICK_MS = 5_000;

/** After this long without the brain, freeze: the grace less its margin. A grace of 0 fences at once. */
export function fenceAfterMs(graceMs: number): number {
  const g = Math.max(0, graceMs);
  return Math.max(0, g - Math.min(FENCE_MARGIN_MAX_MS, g / 4));
}

export type FenceInput = {
  /** The link is up and the brain welcomed this host. */
  online: boolean;
  /** Last frame from the brain while online (ms), or null when this process never had one. */
  lastContact: number | null;
  /** The brain's failover grace, from its last welcome; null = it does not move terminals (or is older). */
  graceMs: number | null;
  /** The brain refused this host (credential, identity, version): it will not take these channels back. */
  rejected: { code: number; reason: string } | null;
  /** CHRONOS_HOST_FENCE=off on this Mac. */
  disabled?: boolean;
  now: number;
};

/** Why this host must freeze its work now, or null when it must not. */
export function fenceReason(i: FenceInput): string | null {
  if (i.disabled) return null;
  if (i.rejected) return `the brain refused this host (${i.rejected.code}: ${i.rejected.reason})`;
  if (i.online || i.graceMs == null || i.lastContact == null) return null;
  const quiet = i.now - i.lastContact;
  const after = fenceAfterMs(i.graceMs);
  if (quiet < after) return null;
  const min = (ms: number) => `${Math.round(ms / 6_000) / 10} min`;
  return `no word from the brain for ${min(quiet)} — it moves this host's terminals elsewhere after ${min(i.graceMs)}`;
}

/**
 * A signal to a child's whole process group (a CLI and the commands it is running), falling back to
 * the child alone. node-pty and `spawn(…, {detached})` children lead their own group; a plain spawn
 * shares ours, so it gets the pid-only signal.
 */
export function signalGroup(pid: number | null | undefined, signal: NodeJS.Signals, ownGroup: boolean): boolean {
  if (!pid || pid <= 0) return false;
  if (ownGroup) {
    try { process.kill(-pid, signal); return true; } catch {}
  }
  try { process.kill(pid, signal); return true; } catch { return false; }
}
