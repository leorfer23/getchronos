/**
 * Robert's presence sweep — a look over each busy workspace every few minutes.
 *
 * robert-drive.ts wakes him when a terminal STOPS. That misses the slow failures: a terminal that
 * keeps "working" in circles, a stop whose wake was eaten by a cap or a restart, two terminals that
 * should hand off and don't. The operator asked for Robert to be present while work is happening
 * ("5 min only when terminals are active … if no terminals working no need to wake up").
 *
 *  - **Only while something works.** A workspace is swept only when one of its live, goal-bearing
 *    terminals is working right now (isStopped false). A quiet fleet costs nothing.
 *  - **Per workspace.** The wake carries the workspace, so the drain runs it on that workspace's
 *    Robert — and on its own Claude account (webProfileDir: gfm → ~/.claude-gfm, medialab →
 *    ~/.claude-medialab, the rest on the operator's).
 *  - **One at a time.** The key is fixed per workspace, so a sweep still queued absorbs the next one
 *    instead of stacking up behind a slow turn.
 *  - **Silent when there is nothing to do.** A reply of exactly QUIET is acked and never posted
 *    (wake-queue.ts), so the Desk thread only hears from a sweep that did something.
 */
import { CONFIG } from "./config.js";
import { db, robertWakes, sessions, workspaces } from "./store.js";
import { enqueueWake, QUIET_REPLY, SWEEP_KEY, WAKE_ATTEMPT_CAP } from "./wake-queue.js";
import { isStopped } from "./robert-drive.js";
import { statusOf, type TermStatus } from "./term-status.js";
import { settingOn } from "./settings.js";

type Probe = (id: string) => TermStatus | null;
let probe: Probe = (id) => statusOf(id);
export function setSweepProbe(fn: Probe): void { probe = fn; }

const goalOf = (s: { goal?: string | null; spawn_goal?: string | null }) => (s.goal ?? s.spawn_goal ?? "").trim();

/** Live terminals in this workspace that are working right now. */
export function workingIn(wsId: string): number {
  return sessions
    .list({ workspace_id: wsId, status: "live", limit: 200 })
    .filter((s) => !!goalOf(s))
    .filter((s) => {
      const st = probe(s.id);
      return !!st && !isStopped(st);
    }).length;
}

export function sweepSay(wsName: string, working: number, everyMin: number): string {
  return (
    `PRESENCE SWEEP · ${wsName} — your ${everyMin}-minute check while ${working} terminal(s) here are working. ` +
    `FLEET NOW above is this workspace. For every terminal ask: is it moving toward its goal? ` +
    `A stopped one nobody answered → give it the next step (\`mc session send <id> "..."\`), close it if the goal is met, ` +
    `or hand it to the operator in one line with your recommendation. A working one → look (\`mc session focus <id>\`) ` +
    `only if it looks stuck, looping, or off its goal. Leave alone anything the operator typed into in the last few minutes. ` +
    `If nothing needs you, reply with exactly ${QUIET_REPLY} and nothing else.`
  );
}

/** One pass: queue a sweep for every workspace with work in flight. Returns the workspace ids swept. */
export function sweepOnce(everyMin = CONFIG.robertSweepMin): string[] {
  const swept: string[] = [];
  for (const ws of workspaces.list()) {
    if (!settingOn("robert.enabled", ws.id) || !settingOn("robert.sweep", ws.id)) continue;
    const working = workingIn(ws.id);
    if (!working) continue;
    const key = `${SWEEP_KEY}${ws.id}`;
    // A sweep is a snapshot: one that failed its way to parked is stale, and left unacked it would
    // absorb every later sweep for this workspace (same key) and silence it for good.
    const parked = db
      .prepare("SELECT id FROM robert_wakes WHERE key = ? AND acked_at IS NULL AND attempts >= ?")
      .all(key, WAKE_ATTEMPT_CAP) as { id: string }[];
    for (const p of parked) robertWakes.ack(p.id);
    enqueueWake({
      topic: "robert.sweep",
      key,
      subject: null,
      workspace_id: ws.id,
      payload: { say: sweepSay(ws.name, working, everyMin), working },
    });
    swept.push(ws.id);
  }
  return swept;
}

export function startRobertSweep(): void {
  const every = CONFIG.robertSweepMin;
  if (!every) {
    console.log("[robert-sweep] off (CHRONOS_ROBERT_SWEEP_MIN=0)");
    return;
  }
  setInterval(() => {
    try {
      const swept = sweepOnce(every);
      if (swept.length) console.log(`[robert-sweep] swept ${swept.length} workspace(s) with terminals working`);
    } catch (e) {
      console.error("[robert-sweep]", e);
    }
  }, every * 60_000).unref?.();
  console.log(`[robert-sweep] Robert checks each workspace every ${every}m while a terminal there is working`);
}
