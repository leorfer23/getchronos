import { LOCAL_HOST_ID } from "../store/hosts.js";
import { localHost } from "./local.js";
import type { Host } from "./types.js";

export type * from "./types.js";
export { LOCAL_HOST_ID };

// The host registry (HOSTS.md, "HostRegistry"). `local` (the brain) is always here. A RemoteHost is
// registered the first time its `chronos host` link says hello, and STAYS registered when the link
// drops — offline, not gone: its terminals keep running over there and come back on reconnect.
//
// An unknown id THROWS rather than falling back to local. A row that names a computer this brain
// does not know is a terminal or run that lives somewhere else: signalling its pid here would hit
// whatever unrelated process has that number on this Mac, and reopening its cwd here would point an
// agent at a path from another machine's disk.
const registry = new Map<string, Host>([[LOCAL_HOST_ID, localHost]]);

export function hostById(id: string): Host {
  const h = registry.get(id);
  if (!h) throw new Error(`unknown host \`${id}\` — not connected to this brain (HOSTS.md)`);
  return h;
}

/**
 * The host a session or run lives on. A row with no host_id (one built in memory, a job, a test
 * fixture) is the brain's: that is what the column defaults to in the DB as well.
 */
export function hostFor(row: { host_id?: string | null } | null | undefined): Host {
  return hostById(row?.host_id || LOCAL_HOST_ID);
}

/** Add (or replace) a host. Remote hosts only; `local` is fixed. */
export function registerHost(h: Host): void {
  if (h.id === LOCAL_HOST_ID) throw new Error("the local host cannot be replaced");
  registry.set(h.id, h);
}

/** A registered host by id, or undefined — for callers that must not throw on an unknown id. */
export function findHost(id: string): Host | undefined {
  return registry.get(id);
}

/** Every host that is not the brain. */
export function remoteHosts(): Host[] {
  return [...registry.values()].filter((h) => h.id !== LOCAL_HOST_ID);
}

/**
 * Is this host reachable right now? `local` always is. A remote host is online while its link is up
 * and it has said hello; an unknown id is not online. What the Desk's "host offline" flag reads.
 */
export function hostOnline(id: string | null | undefined): boolean {
  if (!id || id === LOCAL_HOST_ID) return true;
  const h = registry.get(id) as (Host & { online?: boolean }) | undefined;
  return !!h?.online;
}
