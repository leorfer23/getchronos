import { LOCAL_HOST_ID } from "../store/hosts.js";
import { localHost } from "./local.js";
import type { Host } from "./types.js";

export type * from "./types.js";
export { LOCAL_HOST_ID };

// The host registry (HOSTS.md, "HostRegistry"). Phase 1 knows exactly one host, the brain itself.
// RemoteHost instances register here in phase 3, when a `chronos host` process says hello.
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
