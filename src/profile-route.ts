/**
 * Sibling Claude accounts: a new claude session skips a profile that is already walled.
 *
 * A workspace pins ONE config dir (`workspaces.config_dir`), so when that account hit its weekly
 * limit every new Desk terminal opened straight into "You've hit your limit" and only then failed
 * over to grok/cursor. The operator keeps a second login with the same setup for exactly this
 * (e.g. ~/.claude and ~/.claude-leo.osn92, kept in parity outside Chronos); in his words, a new
 * session "should fallback automatically to the second one".
 *
 * CHRONOS_PROFILE_ALTERNATES names the siblings: `claude=claude-leo.osn92` (profile names from
 * CONFIG.profiles or absolute dirs; `,` for several alternates, `;` between groups). At spawn the
 * pinned dir is kept unless the usage meter says one of its windows is at 100% and not yet reset;
 * then the first sibling with room wins. No reading = room: an account we never heard from is not
 * assumed walled. All walled → the pinned dir, and the wall failover takes it from there.
 *
 * Only ever a SIBLING of the pinned dir: a client workspace with no alternates configured never
 * leaves its own account.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG } from "./config.js";
import { claudeWall } from "./usage-meter.js";
import { defineSetting, resolveSetting } from "./settings.js";
import { workspaces } from "./store.js";

const expand = (p: string) => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
const norm = (p: string) => path.resolve(expand(p));

function resolveDir(nameOrDir: string, profiles: Record<string, string>): string | null {
  const s = nameOrDir.trim();
  if (!s) return null;
  if (profiles[s]) return norm(profiles[s]);
  if (s.startsWith("/") || s.startsWith("~/")) return norm(s);
  return null;
}

/** `claude=claude-leo.osn92,claude-x;claude-acme=/abs/.claude-acme2` → dir → [alternate dirs]. */
export function parseAlternates(raw: string, profiles: Record<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const group of raw.split(";")) {
    const at = group.indexOf("=");
    if (at < 1) continue;
    const base = resolveDir(group.slice(0, at), profiles);
    if (!base) continue;
    const alts = group.slice(at + 1).split(",").map((a) => resolveDir(a, profiles)).filter((d): d is string => !!d && d !== base);
    if (alts.length) out.set(base, [...(out.get(base) ?? []), ...alts]);
  }
  return out;
}

/** CHRONOS_PROFILE_ALTERNATES' siblings for one pinned dir, as profile names where it has one. */
export function envAlternatesFor(pinned: string): string[] {
  const dirs = parseAlternates(CONFIG.profileAlternates, CONFIG.profiles).get(norm(pinned)) ?? [];
  const byDir = new Map(Object.entries(CONFIG.profiles).map(([n, d]) => [norm(d), n]));
  return dirs.map((d) => byDir.get(d) ?? d);
}

defineSetting({
  // Per workspace ONLY: a global list would hand a client workspace a personal login (or another
  // client's) the moment its own account walled — the one thing config_dir pinning exists to prevent.
  key: "accounts.alternates", group: "Accounts", level: "ws", type: "list", env: "CHRONOS_PROFILE_ALTERNATES",
  label: "Backup Claude accounts",
  help: "When this workspace's account is at its limit, new Claude sessions start on the first of these with room.",
  options: () => Object.keys(CONFIG.profiles).sort(),
  default: (ws) => envAlternatesFor(ws?.config_dir ?? CONFIG.profiles[CONFIG.defaultProfile] ?? CONFIG.profiles.claude),
});

/** A workspace's siblings from the Settings page, when it (or the global level) set any; else the env map. */
function alternatesFor(pinned: string, workspaceId: string | null | undefined): string[] | undefined {
  const ws = workspaceId ? workspaces.get(workspaceId) : undefined;
  if (ws && ws.config_dir && norm(ws.config_dir) !== norm(pinned)) return undefined;
  const { value, source } = resolveSetting("accounts.alternates", ws?.id ?? null);
  if (source === "default" || !Array.isArray(value)) return undefined;
  return value.map((n) => resolveDir(n, CONFIG.profiles)).filter((d): d is string => !!d && d !== norm(pinned));
}

export interface Routed {
  dir: string;
  /** Set only when the pinned dir was skipped: why, for the log and the Desk card. */
  reason: string | null;
}

export function routeConfigDir(
  pinned: string,
  workspaceId?: string | null,
  now = Date.now(),
  deps: {
    alternates?: Map<string, string[]>;
    wallOf?: (dir: string, now: number) => { window: string; resetsAt: string | null } | null;
    exists?: (dir: string) => boolean;
  } = {},
): Routed {
  const alts = deps.alternates
    ? deps.alternates.get(norm(pinned))
    : alternatesFor(pinned, workspaceId) ?? parseAlternates(CONFIG.profileAlternates, CONFIG.profiles).get(norm(pinned));
  if (!alts?.length) return { dir: pinned, reason: null };
  const wallOf = deps.wallOf ?? claudeWall;
  const wall = wallOf(pinned, now);
  if (!wall) return { dir: pinned, reason: null };
  const exists = deps.exists ?? ((d: string) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  for (const alt of alts) {
    if (!exists(alt) || wallOf(alt, now)) continue;
    const until = wall.resetsAt ? ` until ${wall.resetsAt}` : "";
    return { dir: alt, reason: `${path.basename(pinned)} at its ${wall.window} limit${until} → ${path.basename(alt)}` };
  }
  return { dir: pinned, reason: null };
}
