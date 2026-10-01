/**
 * The GH_CONFIG_DIRs a host should check `gh auth status` for (protocol 1.5): one per distinct dir the
 * workspaces allowed there carry in their env (secrets file or shared vars — the same env a spawn
 * gets, see child-env.ts), written `~/…` so the host resolves it against its own home. Sent in the
 * `policy` frame; the host reports each dir's login in its inventory. Only the dir travels — never
 * another value of the env it was read from.
 */
import os from "node:os";
import { childEnv } from "../child-env.js";
import { hosts, workspaces } from "../store.js";
import { homeRelative } from "../hosts/spawn-spec.js";
import { parsePolicy } from "./registry.js";
import type { Workspace } from "../types.js";

export type GhDir = { dir: string; workspaces: string[] };

export function ghDirsFrom(list: Array<Pick<Workspace, "id" | "slug">>, envOf: (w: Pick<Workspace, "id" | "slug">) => NodeJS.ProcessEnv, deny: string[] = [], home = os.homedir()): GhDir[] {
  const by = new Map<string, string[]>();
  for (const w of list) {
    if (deny.includes(w.id) || deny.includes(w.slug)) continue;
    let v: string | undefined;
    try { v = envOf(w).GH_CONFIG_DIR; } catch { continue; }
    if (!v || !v.trim()) continue;
    const dir = homeRelative(v.trim(), home).value;
    by.set(dir, [...(by.get(dir) ?? []), w.slug]);
  }
  return [...by].map(([dir, ws]) => ({ dir, workspaces: ws.sort() })).sort((a, b) => a.dir.localeCompare(b.dir));
}

/** For one host: every workspace its brain policy allows (its own veto is the host's to apply). */
export function ghDirsForHost(hostId: string): GhDir[] {
  const deny = parsePolicy(hosts.get(hostId)?.policy_json).deny;
  return ghDirsFrom(workspaces.list(), (w) => childEnv(w as Workspace), deny);
}
