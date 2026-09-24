import { hosts } from "../store/hosts.js";
import { parsePolicy, type HostPolicy } from "../hostlink/registry.js";

// Brain-side host policy (HOSTS.md → Security, "two locks on workspace isolation"). This is lock #1:
// the brain refuses to place, spawn or answer for a workspace a host is denied. Lock #2 is the host's
// own CHRONOS_HOST_DENY, which it enforces before it forks anything, whatever the brain sends.
//
// The Desk's Computers panel owns WRITING `hosts.policy_json` (registry.ts / PATCH /api/hosts/:id);
// this module only reads it. Shape: {"deny": ["<workspace id>", ...]} — the Desk writes ids; a slug is
// matched too, since that is how an operator types one. Unreadable reads as an empty list (the host's
// own veto still stands).

export type { HostPolicy } from "../hostlink/registry.js";

export function hostPolicy(hostId: string): HostPolicy {
  return parsePolicy(hosts.get(hostId)?.policy_json);
}

/** Is this workspace on a deny list? Matched by id OR slug, the two ways an operator names one. */
export function workspaceDenied(deny: readonly string[], ws: { id: string; slug?: string | null } | null | undefined): boolean {
  if (!ws) return false;
  return deny.some((d) => d === ws.id || (!!ws.slug && d === ws.slug));
}

/**
 * May NEW work be placed on this host, by the operator's say-so? `draining` takes no new terminals
 * (its running ones finish, and one lost to a host restart may still come back), `disabled` takes
 * nothing. A missing row is a host joined before the registry, treated as online.
 */
export function hostAccepts(hostId: string, fresh: boolean): { ok: true } | { ok: false; reason: string } {
  const st = hosts.get(hostId)?.status;
  if (st === "disabled") return { ok: false, reason: "that computer is disabled" };
  if (st === "draining" && fresh) return { ok: false, reason: "that computer is draining — it takes no new terminals" };
  return { ok: true };
}
