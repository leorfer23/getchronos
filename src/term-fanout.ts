import type { WebSocket } from "ws";

// pty → sockets fan-out. One flush of coalesced pty output is handed to every attached socket, but
// each socket sets its own pace: the pane you are reading gets every frame, a pane on the far side
// of the wall asks for four a second, a window in the background for two. The bytes are never
// dropped for a paced socket — they accumulate and go out as one frame when its slot comes round —
// so a TUI's screen is still exact, it just repaints less often. A socket that stops draining
// (backgrounded tab, slow link) is cut off past LAG_HIGH and resynced from the scrollback buffer
// once it drains; the pty is never paused.
export const FLUSH_MS = 16;
export const LAG_HIGH = 1_500_000;
export const LAG_LOW = 64 * 1024;
/** A paced socket that has this much waiting is resynced from scrollback instead — cheaper than the backlog. */
export const ACC_CAP = 256 * 1024;
/** Slowest pace a client may ask for: nobody watches a terminal that repaints once a minute. */
export const RATE_MAX_MS = 5000;

export type TermClient = WebSocket & {
  _lagging?: boolean;
  /** ms between frames this socket wants; 0/undefined = every flush. */
  _rate?: number;
  _acc?: string;
  _lastSend?: number;
};

export type FanOut = {
  /** ms until this entry needs another tick with no new pty output (0 = none). */
  again: number;
  /** sockets that must be resynced from the scrollback buffer (recovered laggards, overflowed accumulators). */
  resync: TermClient[];
};

export function clampRate(ms: unknown): number {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= FLUSH_MS) return 0;
  return Math.min(RATE_MAX_MS, Math.floor(n));
}

export function fanOut(clients: Iterable<TermClient>, out: string, now: number): FanOut {
  let again = 0;
  const resync: TermClient[] = [];
  const sooner = (ms: number) => { again = again ? Math.min(again, ms) : ms; };
  for (const c of clients) {
    if (c.readyState !== 1) continue;
    if (c._lagging) {
      if (c.bufferedAmount <= LAG_LOW) { c._lagging = false; c._acc = ""; resync.push(c); }
      else sooner(250);
      continue;
    }
    if (c.bufferedAmount > LAG_HIGH) { c._lagging = true; c._acc = ""; sooner(250); continue; }
    if (out) c._acc = (c._acc ?? "") + out;
    if (!c._acc) continue;
    if (c._acc.length > ACC_CAP) { c._acc = ""; c._lastSend = now; resync.push(c); continue; }
    const rate = c._rate ?? 0;
    const due = (c._lastSend ?? 0) + rate;
    if (!rate || now >= due) { c.send(c._acc); c._acc = ""; c._lastSend = now; }
    else sooner(due - now);
  }
  return { again, resync };
}
