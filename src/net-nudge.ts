/**
 * A live terminal whose turn died on the network is nudged once the network is back — the same
 * terminal, its own transcript, one line typed in, like the deploy nudge in revive.ts.
 *
 * Claude Code retries an unreachable API for a while, then ends the turn ("API Error: Can't reach the
 * API server — check your internet or DNS (ENOTFOUND)", "Your computer went to sleep mid-response") and
 * sits at its prompt. Its StopFailure hook carries that text (`mc hook` → term-status turn.error). On
 * 2026-11-11/12 such terminals sat dead for ~18 hours until someone typed "The network is back. Start
 * over from your brief".
 *
 * What it never does: re-dispatch a run or a ticket (recovery.ts — the operator approves those), open a
 * terminal, or talk over a question. A terminal that is asking, declared blocked/decide, or already
 * working again is left alone. The turn died on an API call, so no tool was cut off mid-way; the line
 * still tells the agent to check before repeating anything that writes outside this machine.
 * Only this computer's terminals: the look is this computer's network, and another host's may differ.
 * At most one nudge per dead turn, and MAX_PER_TERMINAL per terminal per daemon life, so a flapping
 * network cannot loop it.
 */
import { db } from "./store.js";
import { LOCAL_HOST_ID } from "./store/hosts.js";
import { sendInput } from "./terminal.js";
import { statusOf, type Signals } from "./term-status.js";
import { looksOffline, networkUp } from "./net-up.js";

export const NETWORK_NUDGE =
  "Your last turn died because the network was down (or the Mac slept): it is back now. Pick up exactly where you " +
  "left off — re-check the state of whatever you were in the middle of, do not start over, do not ask whether to " +
  "continue. Before re-running anything that writes outside this machine (a push, a deploy, production data, a " +
  "message), check whether it already happened, and never do it twice.";

/** A death this fresh may still be the CLI settling; nudge from here on. */
const SETTLE_MS = 30_000;
/** Older than this is not "the network just came back" any more — the operator has seen it. */
const MAX_AGE_MS = 24 * 3_600_000;
export const MAX_PER_TERMINAL = 3;
const TICK_MS = 60_000;

const nudged = new Map<string, { turnAt: number; n: number }>();

/** Live terminals at their prompt whose last turn ended on a network error, not yet nudged for it. */
export function networkDeaths(nowMs = Date.now()): { session_id: string; error: string; at: number }[] {
  const rows = db.prepare(
    "SELECT st.session_id AS id, st.data AS data FROM session_status st JOIN sessions s ON s.id = st.session_id WHERE s.status = 'live' AND s.host_id = ?",
  ).all(LOCAL_HOST_ID) as { id: string; data: string }[];
  const out: { session_id: string; error: string; at: number }[] = [];
  for (const r of rows) {
    let sig: Signals;
    try { sig = JSON.parse(r.data); } catch { continue; }
    const t = sig.turn;
    if (t?.state !== "stopped" || !looksOffline(t.error)) continue;
    if (nowMs - t.at < SETTLE_MS || nowMs - t.at > MAX_AGE_MS) continue;
    if (sig.asking || sig.declared?.state === "blocked" || sig.declared?.state === "decide") continue;
    const prev = nudged.get(r.id);
    if (prev && (prev.turnAt === t.at || prev.n >= MAX_PER_TERMINAL)) continue;
    out.push({ session_id: r.id, error: t.error!, at: t.at });
  }
  return out;
}

export type NudgeDeps = {
  netUp?: () => Promise<boolean>;
  send?: typeof sendInput;
  phase?: (id: string) => string | null;
};

/** One pass: when something died on the network and the network is up, type the nudge into each. */
export async function nudgeNetworkDeaths(nowMs = Date.now(), d: NudgeDeps = {}): Promise<string[]> {
  const dead = networkDeaths(nowMs);
  if (!dead.length) return [];
  if (!(await (d.netUp ?? networkUp)())) return [];
  const send = d.send ?? sendInput;
  const phase = d.phase ?? ((id: string) => statusOf(id)?.phase ?? null);
  const done: string[] = [];
  for (const x of dead) {
    const ph = phase(x.session_id);
    if (ph === "working" || ph === "blocked" || ph === "decide") continue;
    // Counted whether or not it lands: a terminal that cannot take input (another computer's) is tried once.
    nudged.set(x.session_id, { turnAt: x.at, n: (nudged.get(x.session_id)?.n ?? 0) + 1 });
    const err = send(x.session_id, { text: NETWORK_NUDGE }, "net-nudge");
    if (err) { console.log(`[net] ${x.session_id.slice(0, 8)} died on the network, not nudged: ${err}`); continue; }
    console.log(`[net] network back — nudged ${x.session_id.slice(0, 8)} (its turn died: ${x.error.slice(0, 80)})`);
    done.push(x.session_id);
  }
  return done;
}

/** Tests: forget who was nudged. */
export function resetNetNudge(): void {
  nudged.clear();
}

let started = false;
/** A store-only look every minute; the network itself is looked at only when a terminal died on it. */
export function startNetNudge(): void {
  if (started) return;
  started = true;
  setInterval(() => void nudgeNetworkDeaths().catch((e) => console.warn("[net] nudge", e?.message ?? e)), TICK_MS).unref();
}
