/**
 * "No turn ends blind" — the predicate that says whether anything is still set to wake Robert.
 *
 * Borrowed from firstmate's turn-end guard (docs/turnend-guard.md "Current invariant"): work in
 * flight plus no armed supervisor is the one state nobody notices until hours later, because every
 * surface still looks normal — the terminals are there, the runs are there, and nothing is coming.
 * So it is checked at the three moments it can change (daemon start, the end of a Robert turn, the
 * monitor sweep) and said ONCE per episode in plain language.
 *
 * It never fixes anything. Killing or restarting a supervisor on a predicate's say-so is how a
 * guard turns into the outage; this one only tells the operator.
 */
import { kv, runs, sessions, watches } from "./store.js";
import { getAgent } from "./agent-lifecycle.js";
import { isLive, sessionActivity } from "./terminal.js";
import { sessionGoalReached } from "./term-status.js";
import { esc, notify, notifyInfo } from "./telegram/api.js";
import { wakeBeaconAgeMs, wakeBeaconFresh, wakeBeaconGraceMs, wakeBusArmed } from "./wake-queue.js";

export interface SupervisionVerdict {
  ok: boolean;
  reason: string;
  inFlight: number;
  armed: string[];
}

const EPISODE_KEY = "robert.supervision.episode";

type Notifier = (text: string, level: "action" | "info") => Promise<unknown>;
let notifier: Notifier = (text, level) => (level === "info" ? notifyInfo(text) : notify(text));
export function setSupervisionNotifier(fn: Notifier): void { notifier = fn; }

/** Work that would go unnoticed: live runs, plus desk terminals with a goal that are still at it. */
export function countInFlight(): number {
  let n = runs.runningCount();
  for (const s of sessions.list({ status: "live" })) {
    // A ticked goal is not in flight — unless the operator asked for more since, which puts the
    // terminal back to work and back under supervision (goalReachedStands).
    if (sessionGoalReached(s, sessionActivity(s.id))) continue;
    if (!(s.goal ?? s.spawn_goal)) continue;
    if (!isLive(s.id)) continue;
    const state = getAgent(s.id)?.state;
    if (state === "working" || state === "blocked") n++;
  }
  return n;
}

/** Everything that would wake him, named the way the notice needs to name it. */
export function listArmed(nowMs = Date.now()): string[] {
  const armed: string[] = [];
  if (wakeBusArmed()) armed.push("the event listener");
  if (wakeBeaconFresh(nowMs)) armed.push("the wake drain loop");
  const own = watches.list({ owner: "robert", enabled: true }).length;
  if (own) armed.push(`${own} watch${own === 1 ? "" : "es"}`);
  const desk = sessions.watched().length;
  if (desk) armed.push(`${desk} standing desk watch${desk === 1 ? "" : "es"}`);
  return armed;
}

/**
 * Pure core, so the truth table is a test and not a daemon you have to break on purpose. A fresh
 * drain beacon is required whenever anything is in flight: the other arms only carry an event to
 * the queue, and it is the drain that turns a queued wake into a turn.
 */
export function verdictFrom(inFlight: number, armed: string[], beaconFresh: boolean, beaconAgeMs: number | null): SupervisionVerdict {
  if (inFlight === 0) return { ok: true, reason: "nothing is in flight", inFlight, armed };
  if (!armed.length)
    return { ok: false, reason: "nothing at all is armed to wake him", inFlight, armed };
  if (!beaconFresh) {
    const mins = beaconAgeMs == null ? null : Math.round(beaconAgeMs / 60_000);
    return {
      ok: false,
      reason:
        beaconAgeMs == null
          ? "the wake drain loop has never checked in"
          : `the wake drain loop last checked in ${mins}m ago (it should every minute)`,
      inFlight,
      armed,
    };
  }
  return { ok: true, reason: `armed: ${armed.join(", ")}`, inFlight, armed };
}

export function supervisionVerdict(nowMs = Date.now()): SupervisionVerdict {
  return verdictFrom(countInFlight(), listArmed(nowMs), wakeBeaconFresh(nowMs), wakeBeaconAgeMs(nowMs));
}

/**
 * One notice per episode. A gap that persists says nothing further (the operator was told); recovery
 * clears the episode quietly, on the board rather than on his phone, so the next gap is loud again.
 */
export async function checkSupervision(nowMs = Date.now()): Promise<SupervisionVerdict> {
  const v = supervisionVerdict(nowMs);
  const open = kv.get(EPISODE_KEY);
  if (!v.ok) {
    if (open) return v;
    kv.set(EPISODE_KEY, v.reason);
    await notifier(
      `🕳 <b>Nothing is watching</b> — ${v.inFlight} thing${v.inFlight === 1 ? " is" : "s are"} running and nothing ` +
        `is set to wake Robert: ${esc(v.reason)}. <code>mc robert wakes</code> · <code>GET /api/robert/supervision</code>`,
      "action",
    ).catch(() => {});
  } else if (open) {
    kv.del(EPISODE_KEY);
    await notifier(`👁 <b>Supervision back</b> — ${esc(v.reason)}.`, "info").catch(() => {});
  }
  return v;
}

/** Debug/UI detail: the grace the beacon is judged against. */
export const supervisionGraceMs = wakeBeaconGraceMs;
