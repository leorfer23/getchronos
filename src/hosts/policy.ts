import { hosts } from "../store/hosts.js";

// Brain-side host policy (HOSTS.md → Security, "two locks on workspace isolation"). This is lock #1:
// the brain refuses to place, spawn or answer for a workspace a host is denied. Lock #2 is the host's
// own CHRONOS_HOST_DENY, which it enforces before it forks anything, whatever the brain sends.
//
// The Desk's Computers panel owns WRITING `hosts.policy_json`; this module only reads it. Shape:
//   {"deny": ["<workspace id or slug>", ...]}
// Anything unreadable reads as "no policy" for the deny list — the host's own veto still stands, and a
// corrupt row must not silently become "deny nothing AND break every spawn": callers log, not throw.

export type HostPolicy = { deny: string[] };

export function parsePolicy(raw: string | null | undefined): HostPolicy {
  if (!raw) return { deny: [] };
  try {
    const v = JSON.parse(raw);
    const deny = Array.isArray(v?.deny) ? v.deny.filter((x: unknown): x is string => typeof x === "string" && !!x.trim()).map((x: string) => x.trim()) : [];
    return { deny };
  } catch {
    console.warn("[hosts] hosts.policy_json is not valid JSON — treating the deny list as empty");
    return { deny: [] };
  }
}

export function hostPolicy(hostId: string): HostPolicy {
  return parsePolicy(hosts.get(hostId)?.policy_json);
}

/** Is this workspace on a deny list? Matched by id OR slug, the two ways an operator names one. */
export function workspaceDenied(deny: readonly string[], ws: { id: string; slug?: string | null } | null | undefined): boolean {
  if (!ws) return false;
  return deny.some((d) => d === ws.id || (!!ws.slug && d === ws.slug));
}
