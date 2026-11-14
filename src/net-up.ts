/**
 * Is the network up? One cheap look, shared by everything that must not start network work into a
 * dead network or blame a condition for an outage:
 *   - continuations.ts: a look that failed while the network was down is not a failed look — it does
 *     not count toward MAX_ERRORS and spends no probe;
 *   - job-check.ts, inbox-autodispatch.ts, jot-followup.ts, continuations.ts deliver(): a terminal the
 *     daemon opens on its own waits for the network instead of dying on its first API call;
 *   - net-nudge.ts: a live terminal whose turn died on the network is nudged once it is back.
 *
 * The look is a TCP connect to the hosts every agent turn needs (the model API, GitHub): up when one of
 * them takes the connection. The Mac in a dark wake, the Wi-Fi gone, DNS down — all fail at once with
 * ENOTFOUND / EHOSTUNREACH or time out. A refused connection is a host that answered, so it counts as up.
 * Cached for 15s, so a sweep over many rows costs one look.
 */
import net from "node:net";

export const PROBE_HOSTS: ReadonlyArray<readonly [string, number]> = [["api.anthropic.com", 443], ["api.github.com", 443]];
const PROBE_TIMEOUT_MS = 5_000;
const FRESH_MS = 15_000;
/** How often a waiter looks again while the network is down. */
export const NET_WAIT_EVERY_MS = 60_000;

export type NetProbe = () => Promise<boolean>;

/** One TCP connect: true when it connects or is refused (a host answered), false on any other error or the timeout. */
export function reach(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const s = net.connect({ host, port });
    const end = (up: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      s.destroy();
      resolve(up);
    };
    const t = setTimeout(() => end(false), timeoutMs);
    t.unref?.();
    s.once("connect", () => end(true));
    s.once("error", (e: NodeJS.ErrnoException) => end(e?.code === "ECONNREFUSED"));
  });
}

const realProbe: NetProbe = () =>
  new Promise((resolve) => {
    let left = PROBE_HOSTS.length;
    for (const [h, p] of PROBE_HOSTS) {
      void reach(h, p).then((up) => {
        if (up) resolve(true);
        else if (--left === 0) resolve(false);
      });
    }
  });

let probe: NetProbe = realProbe;
let last: { at: number; up: boolean } | null = null;
let inflight: Promise<boolean> | null = null;

/** The network, looked at no more than every 15s. */
export function networkUp(): Promise<boolean> {
  if (last && Date.now() - last.at < FRESH_MS) return Promise.resolve(last.up);
  inflight ??= probe()
    .catch(() => false)
    .then((up) => {
      if (last && last.up !== up) console.log(`[net] network ${up ? "is back" : "is down"}`);
      last = { at: Date.now(), up };
      inflight = null;
      return up;
    });
  return inflight;
}

/** Tests: swap the look (null restores the real one) and forget the cached answer. */
export function setNetProbe(fn: NetProbe | null): void {
  probe = fn ?? realProbe;
  last = null;
  inflight = null;
}

/**
 * Resolve once the network is up — at once when it already is. False when it stayed down for `maxMs`.
 * Says so in the log once when it has to wait, and once when it goes ahead.
 */
export async function waitForNetwork(o: { label?: string; maxMs?: number; everyMs?: number } = {}): Promise<boolean> {
  const start = Date.now();
  const every = o.everyMs ?? NET_WAIT_EVERY_MS;
  const max = o.maxMs ?? 12 * 3_600_000;
  let waited = false;
  for (;;) {
    if (await networkUp()) {
      if (waited) console.log(`[net] network back — ${o.label ?? "waiting work"} goes ahead`);
      return true;
    }
    if (!waited) console.log(`[net] network down — ${o.label ?? "work"} waits for it`);
    waited = true;
    if (Date.now() - start >= max) return false;
    await new Promise<void>((r) => setTimeout(r, every).unref?.());
  }
}

/**
 * An error that is the network, not the work: what Claude Code prints when it cannot reach its API
 * ("Can't reach the API server — check your internet or DNS (ENOTFOUND)", "Your computer went to sleep
 * mid-response"), Node's socket errors, gh's and curl's wording.
 */
const OFFLINE_RE =
  /\b(ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENETDOWN|ECONNRESET|ETIMEDOUT)\b|can'?t reach the api|check your internet|went to sleep mid-response|connection error|fetch failed|socket hang up|error connecting to|could not resolve host|temporary failure in name resolution|network is unreachable|getaddrinfo/i;
export function looksOffline(text: string | null | undefined): boolean {
  return !!text && OFFLINE_RE.test(text);
}
