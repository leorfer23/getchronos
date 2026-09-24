/**
 * Terminals on other computers, brain side (HOSTS.md phase 3 → Reconnect and restarts).
 *
 * Wires the host link's events to the host registry and to terminal.ts:
 *
 *  - a host says hello → it is registered (once) as a RemoteHost and marked online, then its
 *    `hello.live[]` is RECONCILED against the rows this brain thinks are live there;
 *  - a link drops → the host is marked offline, NOT removed, and nothing ends: its PTYs keep running
 *    over there, output buffering in the host's ring. The Desk greys the cards (`host.offline`);
 *  - data / exit / transcript frames go to the RemoteHost, which feeds the same Live entries a local
 *    pty feeds.
 *
 * Reconcile, per row that is live on that host:
 *  - reported, and this brain still holds it (a link blip) → re-attach: resend after our last seq;
 *  - reported, and this brain does not hold it (the BRAIN restarted) → adopt it into `live`, then
 *    re-attach;
 *  - NOT reported → its process is gone (the host restarted). End it here, and — like a local
 *    terminal after a deploy — reopen it with --resume ON THE SAME HOST when its CLI can resume.
 * And per channel the host reports that no live row here owns (ended while the host was away) → stop
 * it there.
 */
import { bus } from "./bus.js";
import { sessions } from "./store.js";
import { brainLink, type BrainLink } from "./hostlink/brain-link.js";
import { findHost, hostOnline, LOCAL_HOST_ID, registerHost, remoteHosts } from "./hosts/index.js";
import { RemoteHost, type HostLinkPort } from "./hosts/remote.js";
import { adoptRemoteSession, isLive, openSession, remoteResumable, resumeOpts } from "./terminal.js";
import { lastActivityState, reviveSeedFor } from "./revive.js";
import type { Session } from "./types.js";
import type { LiveInfo } from "./hostlink/wire.js";

export type ReconcileResult = { reattached: string[]; adopted: string[]; lost: string[]; orphans: number[] };

/** The RemoteHost for an id, created and registered on first sight. */
export function ensureRemoteHost(id: string, link: HostLinkPort): RemoteHost {
  const h = findHost(id);
  if (h instanceof RemoteHost) return h;
  const r = new RemoteHost(id, link);
  registerHost(r);
  return r;
}

/**
 * Walk what a host just reported against what this brain has. Exported for tests; `revive` is
 * injectable so a test can assert the sticky reopen without spawning.
 */
export async function reconcileHost(
  h: RemoteHost,
  opts: { revive?: (row: Session) => Promise<unknown> } = {},
): Promise<ReconcileResult> {
  const out: ReconcileResult = { reattached: [], adopted: [], lost: [], orphans: [] };
  const reported = new Map<string, LiveInfo>();
  for (const l of h.reportedLive()) reported.set(l.session_id, l);
  const rows = sessions.list({ status: "live" }).filter((s) => s.host_id === h.id);
  const lost: Session[] = [];
  for (const row of rows) {
    const l = reported.get(row.id);
    const held = h.channelFor(row.id);
    if (!l) {
      lost.push(row);
      continue;
    }
    if (held && held.ch === l.ch && isLive(row.id)) {
      held.attach();
      out.reattached.push(row.id);
      continue;
    }
    if (held && held.ch !== l.ch) {
      // A channel this brain holds that the host no longer has: that process is gone (the exit path
      // ends the row), and the one the host reports under this id is stopped below as an orphan.
      h.lose(held);
      continue;
    }
    if (!isLive(row.id)) {
      const c = h.adopt(l, { cwd: row.cwd });
      if (adoptRemoteSession(sessions.get(row.id) ?? row, c)) {
        c.attach();
        out.adopted.push(row.id);
      }
    }
  }
  for (const l of reported.values()) {
    const row = sessions.get(l.session_id);
    if (row && row.status === "live" && row.host_id === h.id) continue;
    // Ended here while the host was away (closed from the Desk, killed by Robert): stop it there.
    // A session this brain has never heard of is left alone and logged — it may be another brain's.
    if (!row) {
      console.warn(`[hosts] ${h.id} reports session ${l.session_id.slice(0, 8)} this brain does not know — leaving it`);
      continue;
    }
    if (!l.exit) h.send({ t: "kill", ch: l.ch });
    h.send({ t: "release", ch: l.ch });
    out.orphans.push(l.ch);
  }
  for (const row of lost) {
    const held = h.channelFor(row.id);
    if (held && isLive(row.id)) h.lose(held); // the ordinary exit path ends the row
    else {
      sessions.end(row.id, `its host ${h.hello?.name ?? h.id} restarted`);
      bus.publish({ topic: "session.ended", session_id: row.id });
    }
    out.lost.push(row.id);
    const ended = sessions.get(row.id);
    if (!ended || ended.status === "live" || !remoteResumable(ended)) continue;
    // Sticky: openSession reads the host from the row, so this reopens on the same machine.
    const revive = opts.revive ?? ((r: Session) => {
      const seed = reviveSeedFor(lastActivityState(r.id));
      return openSession({ ...resumeOpts(r), ...(seed ? { seed } : {}) });
    });
    try {
      await revive(ended);
      console.log(`[hosts] revived ${row.id.slice(0, 8)} on ${h.id} after its host restarted`);
    } catch (e: any) {
      console.warn(`[hosts] revive ${row.id.slice(0, 8)} on ${h.id} failed (stays ended, resumable in UI): ${e?.message ?? e}`);
    }
  }
  return out;
}

/**
 * A host by id or by the name it reported (`m2`), among those that have connected to this brain.
 * Names are what an operator types (`mc session new --host m2`); ids are what rows store.
 */
export function resolveHostRef(ref: string): string | null {
  const r = ref.trim();
  if (!r) return null;
  const all = remoteHosts().filter((h): h is RemoteHost => h instanceof RemoteHost);
  const byId = all.find((h) => h.id === r);
  if (byId) return byId.id;
  const byName = all.filter((h) => (h.hello?.name ?? "").toLowerCase() === r.toLowerCase());
  return byName.length === 1 ? byName[0].id : null;
}

/** Is this session's host disconnected right now? False for local rows and ended ones. */
export function sessionHostOffline(s: Pick<Session, "host_id" | "status">): boolean {
  return !!s.host_id && s.host_id !== LOCAL_HOST_ID && s.status === "live" && !hostOnline(s.host_id);
}

/** Sessions a host runs that are live here: the cards to repaint when it comes and goes. */
function liveOn(hostId: string): Session[] {
  return sessions.list({ status: "live" }).filter((s) => s.host_id === hostId);
}

/** Boot hook (index.ts), after startTerminals: subscribe to the host link. Returns an unsubscribe. */
export function startRemoteTerminals(link: BrainLink = brainLink()): () => void {
  const offs = [
    link.onHostOnline((info) => {
      const h = ensureRemoteHost(info.host_id, link);
      h.setOnline(info.hello);
      bus.publish({ topic: "host.online", host_id: info.host_id, name: info.name });
      void reconcileHost(h)
        .then((r) => {
          if (r.reattached.length || r.adopted.length || r.lost.length || r.orphans.length)
            console.log(`[hosts] ${info.host_id} reconciled — reattached ${r.reattached.length}, adopted ${r.adopted.length}, lost ${r.lost.length}, stopped ${r.orphans.length}`);
          for (const s of liveOn(info.host_id)) bus.publish({ topic: "session.updated", session_id: s.id });
        })
        .catch((e) => console.warn(`[hosts] reconcile ${info.host_id} failed: ${e?.message ?? e}`));
    }),
    link.onHostOffline((id, reason) => {
      const h = findHost(id);
      if (h instanceof RemoteHost) h.setOffline();
      bus.publish({ topic: "host.offline", host_id: id, reason });
      for (const s of liveOn(id)) bus.publish({ topic: "session.updated", session_id: s.id });
    }),
    link.onVitals((id, v) => {
      const h = findHost(id);
      if (h instanceof RemoteHost) h.setVitals(v);
    }),
    link.onData((id, f) => {
      const h = findHost(id);
      if (h instanceof RemoteHost) h.data(f);
    }),
    link.onControl((id, f) => {
      const h = findHost(id);
      if (h instanceof RemoteHost) h.control(f);
    }),
  ];
  return () => { for (const off of offs) off(); };
}
