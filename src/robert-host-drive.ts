/**
 * Robert hears about the COMPUTERS, not only the terminals (HOSTS.md → Robert and the fleet).
 *
 * robert-drive.ts wakes him when a terminal stops. Nothing woke him when the machine under five of
 * them went away, when host failover could not find anywhere to put one, when placement refused a
 * workspace on a computer it may not use, when a CLI on a host was logged out (so placement quietly
 * skipped that host), or when a host sat behind the brain for a day. This is that, on the same queue:
 *
 *  - **Bus events, not polling, where there is an event**: `host.offline` (armed past the failover
 *    grace, so the wake can say what failover did), `session.host_failover` mode `stuck`,
 *    `host.policy_violation`. A sweep (every 10 min and just after a host says hello) reads
 *    `hostsView()` for what has no event: behind the brain, a needed CLI logged out, and hosts that
 *    were already offline with work on them when the brain restarted.
 *  - **Once per host per state.** The key names the host, the kind and the state (the offline
 *    episode, the policy, the brain commit, the CLI + day); a handled key never wakes him again.
 *  - **Same switches and ceiling.** robert.enabled (master) + robert.hosts, and every new wake counts
 *    against robert.per_hour with the terminal wakes (chargeFleetWake).
 *
 * What he may do once woken is policy and lives in agents/_blocks/hosts.md: look, then tell the
 * operator; draining, disabling, policy and updates are confirm-first.
 */
import { createHash } from "node:crypto";
import { CONFIG } from "./config.js";
import { bus, type BusEvent } from "./bus.js";
import { db, hosts, sessions, workspaces, LOCAL_HOST_ID } from "./store.js";
import type { Session } from "./types.js";
import { enqueueWake } from "./wake-queue.js";
import { settingOn } from "./settings.js";
import { chargeFleetWake } from "./robert-drive.js";
import { hostOnline } from "./hosts/index.js";
import { cliFor } from "./hosts/placement.js";
import { brainLink } from "./hostlink/brain-link.js";
import { parseCapabilities } from "./hostlink/registry.js";
import { hostsView, type HostView } from "./hostlink/view.js";

export const HOST_DRIVE_KEY = "host-drive:";
export type HostWakeKind = "offline" | "stuck" | "policy" | "behind" | "logged_out";

const HOUR = 60 * 60_000;
const SWEEP_MS = 10 * 60_000;
/** Stuck terminals of one host arrive one event each, in one failover pass: one wake for the pass. */
const STUCK_BATCH_MS = 5_000;
/** Past failover's own grace, so the wake can say what it moved and what it could not. */
export const offlineGraceMs = () => (CONFIG.hostFailoverGraceMin + 2) * 60_000;

const id8 = (id: string) => id.slice(0, 8);
const nameOf = (id: string) => hosts.get(id)?.name || id;
const hostLive = (id: string): Session[] => sessions.list({ status: "live" }).filter((s) => s.host_id === id);
const titleOf = (s: Pick<Session, "id" | "goal" | "spawn_goal" | "title" | "workspace_id">) => {
  const ws = s.workspace_id ? workspaces.get(s.workspace_id)?.name : null;
  const what = (s.goal || s.spawn_goal || s.title || "(no goal)").replace(/\s+/g, " ").trim().slice(0, 70);
  return `\`${id8(s.id)}\` ${ws ? `${ws}: ` : ""}${what}`;
};
const minsSince = (t: number, now: number) => Math.max(0, Math.round((now - t) / 60_000));

/** Robert is on, and wants to hear about computers (⚙ Settings → Robert). Read per wake. */
export const hostWakesEnabled = (wsId: string | null = null): boolean =>
  settingOn("robert.enabled", wsId) && settingOn("robert.hosts");

const handled = (key: string): boolean =>
  !!db.prepare("SELECT 1 FROM robert_wakes WHERE key = ? AND acked_at IS NOT NULL LIMIT 1").get(key);
const queued = (key: string): boolean =>
  !!db.prepare("SELECT 1 FROM robert_wakes WHERE key = ? AND acked_at IS NULL LIMIT 1").get(key);

/**
 * Queue one host wake, or null with the reason left to the guards: switched off, already handled,
 * over the hourly ceiling. A repeat of a still-queued key refreshes its payload and costs nothing.
 */
export function hostWake(w: { host_id: string; kind: HostWakeKind; state: string; say: string; workspace_id?: string | null }, nowMs = Date.now()): string | null {
  if (!hostWakesEnabled(w.workspace_id ?? null)) return null;
  const key = `${HOST_DRIVE_KEY}${w.host_id}:${w.kind}:${w.state}`;
  if (handled(key)) return null;
  const repeat = queued(key);
  if (!repeat && !chargeFleetWake(nowMs)) {
    console.warn(`[host-drive] cap reached — ${nameOf(w.host_id)} ${w.kind} not sent`);
    return null;
  }
  const id = enqueueWake({
    topic: `host.${w.kind}`,
    key,
    subject: `host:${w.host_id}:${w.kind}`,
    // Computers belong to the whole fleet: the wake lands in Robert's all-workspaces thread.
    workspace_id: null,
    payload: { say: w.say, host_id: w.host_id, kind: w.kind },
  });
  if (!repeat) console.log(`[host-drive] woke Robert: ${nameOf(w.host_id)} ${w.kind}`);
  return id;
}

const LOOK = "Look first: `mc hosts show NAME` (or GET /api/hosts).";
const CONFIRM = "Draining, disabling, revoking, policy and updates are the operator's call — propose it in one line (a UI ask), do not do it.";

// ──────────────────────────── offline / stuck ────────────────────────────

type Episode = {
  /** When the link went down (or, after a brain restart, when the host was last seen). */
  since: number;
  reason: string;
  /** Live terminals there when it went — what failover had to move. */
  liveAt: number;
  stuck: Map<string, string>;
  /** The offline wake fired (or was decided against): later stuck terminals get their own. */
  told: boolean;
  timer: NodeJS.Timeout | null;
};
const episodes = new Map<string, Episode>();
const behindSince = new Map<string, { target: string; since: number }>();
const loggedOut = new Set<string>();
let sweepTimer: NodeJS.Timeout | null = null;

export function resetHostDriveState(): void {
  for (const e of episodes.values()) if (e.timer) clearTimeout(e.timer);
  episodes.clear();
  behindSince.clear();
  loggedOut.clear();
}

function arm(hostId: string, ep: Episode, ms: number, fire: () => void): void {
  if (ep.timer) clearTimeout(ep.timer);
  ep.timer = setTimeout(() => {
    ep.timer = null;
    try { fire(); } catch (e) { console.error("[host-drive]", e); }
  }, Math.max(0, ms));
  ep.timer.unref?.();
}

const operatorTookItDown = (hostId: string) => {
  const row = hosts.get(hostId);
  return !row || !row.token_hash || row.status === "disabled";
};

export function noteHostOffline(hostId: string, reason: string, nowMs = Date.now(), schedule = true): void {
  if (hostId === LOCAL_HOST_ID || operatorTookItDown(hostId)) return;
  const prev = episodes.get(hostId);
  if (prev?.timer) clearTimeout(prev.timer);
  const ep: Episode = { since: nowMs, reason, liveAt: hostLive(hostId).length, stuck: new Map(), told: false, timer: null };
  episodes.set(hostId, ep);
  if (schedule) arm(hostId, ep, offlineGraceMs(), () => fireOffline(hostId));
}

export function noteHostOnline(hostId: string): void {
  const ep = episodes.get(hostId);
  if (ep?.timer) clearTimeout(ep.timer);
  episodes.delete(hostId);
}

/** A terminal failover could not move off this host. Joins the episode; a late one gets its own wake. */
export function noteStuck(hostId: string, sessionId: string, why: string, nowMs = Date.now(), schedule = true): void {
  let ep = episodes.get(hostId);
  if (!ep) {
    // The brain restarted while the host was gone: the episode began when it was last heard from.
    const seen = Date.parse(hosts.get(hostId)?.last_seen_at ?? "");
    ep = { since: Number.isFinite(seen) ? seen : nowMs, reason: "not back since the brain restarted", liveAt: 0, stuck: new Map(), told: true, timer: null };
    episodes.set(hostId, ep);
  }
  ep.stuck.set(sessionId, why);
  // Before the offline wake: it will carry these. After it (or with none coming): one wake per pass.
  if (ep.told && schedule) arm(hostId, ep, STUCK_BATCH_MS, () => fireStuck(hostId));
}

function stuckLines(ep: Episode): string {
  return [...ep.stuck].map(([sid, why]) => {
    const s = sessions.get(sid);
    return `- ${s ? titleOf(s) : `\`${id8(sid)}\``} — ${why}`;
  }).join("\n");
}

/** The offline wake, past the grace. Null when it came back, the operator took it down, or nothing was on it. */
export function fireOffline(hostId: string, nowMs = Date.now()): string | null {
  const ep = episodes.get(hostId);
  if (!ep || ep.told) return null;
  ep.told = true;
  if (hostOnline(hostId) || operatorTookItDown(hostId)) return null;
  const left = hostLive(hostId);
  // A laptop lid closed on an idle computer is not news: nothing was running there, nothing waits.
  if (!ep.liveAt && !left.length && !ep.stuck.size) return null;
  const name = nameOf(hostId);
  const say =
    `a computer is OFFLINE: ${name} has not been heard from for ${minsSince(ep.since, nowMs)}m (${ep.reason}).\n` +
    `${ep.liveAt} terminal(s) were running there; ${left.length} still wait on it` +
    (left.length ? `:\n${left.slice(0, 8).map((s) => `- ${titleOf(s)}`).join("\n")}` : ".") + "\n" +
    (ep.stuck.size ? `HOST FAILOVER COULD NOT MOVE:\n${stuckLines(ep)}\n` : "") +
    `They keep running over there and re-attach when it comes back; failover moves what it can. ${LOOK} ` +
    `Then tell the operator in one line what is stuck and what you recommend. ${CONFIRM}`;
  return hostWake({ host_id: hostId, kind: "offline", state: String(ep.since), say }, nowMs);
}

export function fireStuck(hostId: string, nowMs = Date.now()): string | null {
  const ep = episodes.get(hostId);
  if (!ep || !ep.stuck.size || hostOnline(hostId)) return null;
  const name = nameOf(hostId);
  const say =
    `${name} is offline (${minsSince(ep.since, nowMs)}m) and HOST FAILOVER COULD NOT MOVE ${ep.stuck.size} terminal(s) off it:\n` +
    `${stuckLines(ep)}\n` +
    `They stay on ${name} until it comes back. ${LOOK} If one matters now, open a fresh terminal for it elsewhere ` +
    `(\`mc session new --goal ... --description ...\`, placement picks the computer) and say so. ${CONFIRM}`;
  return hostWake({ host_id: hostId, kind: "stuck", state: String(ep.since), say }, nowMs);
}

// ──────────────────────────── policy ────────────────────────────

export function onPolicyViolation(e: { host_id: string; workspace_id: string | null; session_id: string | null; reason: string }, nowMs = Date.now()): string | null {
  if (!e.host_id || e.host_id === LOCAL_HOST_ID) return null;
  const row = hosts.get(e.host_id);
  const ws = e.workspace_id ? workspaces.get(e.workspace_id) : undefined;
  // One wake per workspace per policy: the same refusal again under the same rules is the same news.
  const veto = parseCapabilities(row?.capabilities_json)?.veto ?? [];
  const state = createHash("sha1").update(`${e.workspace_id ?? ""}|${row?.policy_json ?? ""}|${JSON.stringify(veto)}`).digest("hex").slice(0, 12);
  const s = e.session_id ? sessions.get(e.session_id) : undefined;
  const say =
    `placement tried to put ${ws?.name ?? "a workspace"} on ${nameOf(e.host_id)}, which it may NOT use: ${e.reason}\n` +
    (s ? `THE TERMINAL: ${titleOf(s)}\n` : "") +
    `Something pinned it there (a --host pin, a terminal reopened where it lived, a ticket's worktree). ${LOOK} ` +
    `Its checklist.workspaces says who may run there. Never loosen the policy yourself: tell the operator which ` +
    `work tried and offer the fix (open it on another computer, or he lifts the deny).`;
  return hostWake({ host_id: e.host_id, kind: "policy", state, say, workspace_id: e.workspace_id }, nowMs);
}

// ──────────────────────────── sweep: behind, logged out, offline across a restart ────────────────────────────

type ViewProbe = () => HostView[];
let viewProbe: ViewProbe = () => hostsView(brainLink());
export function setHostViewProbe(fn: ViewProbe): void { viewProbe = fn; }

/** CLIs placement would need on this host: the default backend of every workspace allowed there. */
function neededClis(h: HostView): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const w of h.checklist.workspaces) {
    if (!w.allowed) continue;
    const cli = cliFor(workspaces.get(w.id)?.default_backend || "claude-code");
    if (cli) out.set(cli, [...(out.get(cli) ?? []), w.name]);
  }
  return out;
}

export function sweepHosts(nowMs = Date.now()): string[] {
  const woke: string[] = [];
  if (!hosts.list().some((h) => h.id !== LOCAL_HOST_ID && !!h.token_hash)) return woke;
  const push = (id: string | null) => { if (id) woke.push(id); };
  for (const h of viewProbe()) {
    if (h.is_brain) continue;
    // Offline with work on it, and no episode (the brain restarted while it was gone).
    if (!h.connected && h.status !== "disabled" && h.live_sessions && !episodes.has(h.id)) {
      const seen = Date.parse(h.last_seen_at ?? "");
      noteHostOffline(h.id, "not back since the brain restarted", Number.isFinite(seen) ? seen : nowMs, false);
      const ep = episodes.get(h.id);
      if (ep) {
        if (nowMs - ep.since >= offlineGraceMs()) push(fireOffline(h.id, nowMs));
        else arm(h.id, ep, ep.since + offlineGraceMs() - nowMs, () => fireOffline(h.id));
      }
    }
    if (!h.connected) continue;

    const u = h.update;
    if (u?.available) {
      const target = u.target.commit ?? u.target.version ?? "?";
      const b = behindSince.get(h.id);
      if (!b || b.target !== target) behindSince.set(h.id, { target, since: nowMs });
      else if (nowMs - b.since >= CONFIG.robertDrive.hostBehindHours * HOUR) {
        const how = u.supported
          ? `The Desk can update it: \`mc hosts update ${h.name}\` (POST /api/hosts/${h.id}/update). Updating ends its terminals while it restarts; the brain resumes them there after.`
          : u.manual
            ? `It cannot update itself from the Desk; on that Mac, once: ${u.manual}`
            : `It cannot be updated from the Desk (a hand-run or dev install) — the operator updates it there.`;
        push(hostWake({
          host_id: h.id, kind: "behind", state: target.slice(0, 12),
          say:
            `${h.name} has been BEHIND the brain for over ${CONFIG.robertDrive.hostBehindHours}h ` +
            `(it runs ${(h.commit ?? h.version ?? "?").slice(0, 8)}, the brain ${target.slice(0, 8)}; ${h.live_sessions} live terminal(s) there).\n` +
            `${how} Suggest it to the operator for a quiet moment. ${CONFIRM}`,
        }, nowMs));
      }
    } else {
      behindSince.delete(h.id);
    }

    const out = new Set(h.checklist.clis.filter((c) => c.auth === "no").map((c) => c.name));
    for (const k of [...loggedOut]) if (k.startsWith(`${h.id}:`) && !out.has(k.slice(h.id.length + 1))) loggedOut.delete(k);
    for (const [cli, wsNames] of neededClis(h)) {
      const k = `${h.id}:${cli}`;
      if (!out.has(cli) || loggedOut.has(k)) continue;
      loggedOut.add(k);
      push(hostWake({
        host_id: h.id, kind: "logged_out", state: `${cli}:${new Date(nowMs).toISOString().slice(0, 10)}`,
        say:
          `${cli} is NOT LOGGED IN on ${h.name}, and it is what ${wsNames.slice(0, 5).join(", ")} run on — placement skips ` +
          `${h.name} for their work until someone logs in there. Logging in is the operator's hands on that Mac; ` +
          `tell him in one line (which computer, which CLI). Nothing to change in Chronos.`,
      }, nowMs));
    }
  }
  return woke;
}

export function startHostDrive(): void {
  bus.on("event", (e: BusEvent) => {
    try {
      if (e.topic === "host.offline") noteHostOffline(e.host_id, e.reason);
      else if (e.topic === "host.online") {
        noteHostOnline(e.host_id);
        // Its hello just stored fresh capabilities and version: read them once it has settled.
        const t = setTimeout(() => { try { sweepHosts(); } catch (err) { console.error("[host-drive]", err); } }, 10_000);
        t.unref?.();
      } else if (e.topic === "session.host_failover" && e.mode === "stuck") noteStuck(e.from_host, e.session_id, e.reason);
      else if (e.topic === "host.policy_violation") onPolicyViolation(e);
    } catch (err) {
      console.error("[host-drive]", err);
    }
  });
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = setInterval(() => { try { sweepHosts(); } catch (err) { console.error("[host-drive]", err); } }, SWEEP_MS);
  sweepTimer.unref?.();
  console.log(`[host-drive] Robert woken on computer trouble: offline with work, stuck failover, policy refusals, logged-out CLIs, ${CONFIG.robertDrive.hostBehindHours}h behind the brain`);
}
