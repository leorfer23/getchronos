import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG, splitPaths } from "./config.js";
import { operatorGhDir } from "./gh-env.js";

/**
 * The home wall: a client profile reads only what it is let read under $HOME.
 *
 * Every other rule in sandbox.ts is a deny list, and a deny list only covers what someone remembered
 * to name. Anything nobody registered stays readable: another client's codex or cursor login, a CSV
 * left in ~, the operator's gh login (which sees every org), ~/.zsh_history, personal folders. So for
 * a workspace on a profile of its own (config_dir is not the default profile), reads under $HOME
 * are an allow list instead:
 *
 *   (deny  file-read*         (subpath $HOME))
 *   (allow file-read-metadata (literal <$HOME and every dir above an allowed path>))
 *   (allow file-read*         <allowed paths>)
 *
 * and the rest of the profile follows unchanged. Its per-workspace denies are file-read* too, and
 * SBPL takes the last matching rule for the same operation, so another workspace's repo inside an
 * allowed dir (a skill linked out of a client checkout, say) is still denied.
 *
 * Two SBPL facts this relies on, checked with sandbox-exec: rules for one operation are last-match;
 * a rule naming a specific operation (file-read-metadata, file-read-data) beats a file-read* rule
 * whatever their order. That is why everything here is file-read* except the ancestor grant, which
 * is metadata-only and literal-only: stat/realpath walk every dir above an allowed path, and that
 * walk must not open the dirs themselves (no listing, no reading the siblings).
 *
 * Allowed: the spawn's own dirs (cwd, add-dirs, read-only checkouts, its config dir and whatever
 * that dir links to), the workspace's sandbox_allow, the config dirs its own env names (its gh login
 * — or the operator's when it carries none — cursor, codex, gcloud), the runtime the CLIs need
 * (HOME_RUNTIME + CHRONOS_HOME_ALLOW_EXTRA), and the default profile's shared instructions (its
 * top-level *.md, skills, commands, agents, hooks, output-styles, and what those link to) — never
 * its transcripts, history, caches or backups.
 *
 * The default profile itself (the operator's own) is not walled: it is meant to see everything.
 * CHRONOS_HOME_WALL=off switches the wall off everywhere; CHRONOS_HOME_WALL_SKIP=<slug,slug> leaves
 * named workspaces out (an operator's second personal profile, a test profile).
 */

export type HomeWall = {
  home: string;
  allow: string[];
  // Dirs the wall reads its allow list from (the default profile: its skills' links). The walled
  // agent must not write them, or it could plant a link that opens more of $HOME on its next spawn —
  // and the hooks and skills there run in the operator's own sessions.
  noWrite: string[];
};

// What every CLI needs to start and work, $HOME-relative. Only entries that exist are emitted.
export const HOME_RUNTIME = [
  ".local/bin",            // claude, uv … (the native installer's links)
  ".local/share/claude",   // claude's native install (what .local/bin/claude links to)
  ".local/share/uv",       // uv-managed pythons/tools
  ".bun",
  ".npm",
  ".nvm",
  ".volta",
  ".cargo/bin",
  "go/bin",
  "go/pkg/mod",            // `go run module@version` MCP servers (+ the checksum db below)
  "go/pkg/sumdb",
  "Library/Application Support/go",
  "Library/Caches/go-build",
  ".cache/uv",             // uvx-launched tools
  ".gitconfig",
  ".gitignore_global",
  ".config/git",
  "Library/Keychains",     // the CLIs' own logins; the keychain is encrypted and securityd-mediated
  ".mc/bin",               // the mc CLI
];

// The default profile's shared, non-private parts a client profile may use (its own config dir
// usually links CLAUDE.md, skills and commands to them).
const DEFAULT_PROFILE_SHARED_DIRS = ["skills", "commands", "agents", "hooks", "output-styles"];

// Env vars that name a per-workspace config dir the workspace's tools read.
const CONFIG_DIR_VARS = ["GH_CONFIG_DIR", "CURSOR_CONFIG_DIR", "CODEX_HOME", "CLOUDSDK_CONFIG"];

const exists = (p: string) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const real = (p: string) => { try { return fs.realpathSync(p); } catch { return null; } };

export function defaultProfileDir(home = os.homedir()): string {
  return path.resolve(CONFIG.profiles.claude ?? path.join(home, ".claude"));
}

export function homeWallEnabled(): boolean {
  return (process.env.CHRONOS_HOME_WALL ?? "on").toLowerCase() !== "off";
}

/** Does a workspace on `configDir` get the wall? Every profile but the default one, unless skipped. */
export function walled(slug: string, configDir: string | null | undefined, home = os.homedir()): boolean {
  if (!homeWallEnabled() || !configDir) return false;
  const skip = (process.env.CHRONOS_HOME_WALL_SKIP ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (skip.includes(slug)) return false;
  return path.resolve(configDir) !== defaultProfileDir(home);
}

const inHome = (p: string, home: string) => {
  const rel = path.relative(home, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** Symlinks directly inside `dir`: where they point (resolved), when that is under $HOME. */
function linkTargets(dir: string, home: string): string[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: string[] = [];
  for (const n of names) {
    const p = path.join(dir, n);
    try {
      if (!fs.lstatSync(p).isSymbolicLink()) continue;
    } catch { continue; }
    const r = real(p);
    if (r && inHome(r, home)) out.push(r);
  }
  return out;
}

/**
 * The wall for one workspace, or null when it is not walled. `env` is the workspace's own env
 * (secrets_file + shared vars, as childEnv builds it): config dirs it names are its own.
 */
export function homeWallFor(
  ws: { slug: string; sandbox_allow?: string | null },
  configDir: string,
  env: Record<string, string | undefined>,
  // The workspace's own places (store: workspaces.ownPlaces — repos, worktrees, landing dir, mirrors).
  places: string[] = [],
  home = os.homedir(),
): HomeWall | null {
  if (!walled(ws.slug, configDir, home)) return null;
  const allow: string[] = [...places];
  for (const rel of HOME_RUNTIME) if (exists(path.join(home, rel))) allow.push(path.join(home, rel));
  for (const p of splitPaths(process.env.CHRONOS_HOME_ALLOW_EXTRA)) allow.push(p.startsWith("~/") ? path.join(home, p.slice(2)) : p);
  // Its gh login: its own when its env names one or carries a token (gh-env.ts gives a token-only
  // workspace ~/.mc/gh/<slug>), the operator's login otherwise.
  const hasToken = !!(env.GH_TOKEN || env.GITHUB_TOKEN);
  if (!env.GH_CONFIG_DIR?.trim()) allow.push(hasToken ? path.join(home, ".mc", "gh", ws.slug) : operatorGhDir(home));
  for (const k of CONFIG_DIR_VARS) {
    const v = env[k]?.trim();
    if (v) allow.push(v.startsWith("~/") ? path.join(home, v.slice(2)) : v.startsWith("$HOME/") ? path.join(home, v.slice(6)) : v);
  }
  // The default profile's shared parts (a client config dir links CLAUDE.md, skills, commands … to
  // them; Seatbelt checks the resolved path) and what its shared dirs link to. Never the client's own
  // config dir links: that dir is the agent's to write, so its links would let it widen its own wall.
  const def = defaultProfileDir(home);
  for (const d of DEFAULT_PROFILE_SHARED_DIRS) {
    const p = path.join(def, d);
    allow.push(p);
    allow.push(...linkTargets(p, home));
    const r = real(p);
    if (r && r !== p) allow.push(r, ...linkTargets(r, home));
  }
  try {
    for (const n of fs.readdirSync(def)) if (n.endsWith(".md")) allow.push(path.join(def, n));
  } catch { /* no default profile */ }
  // Only paths strictly inside $HOME: outside it nothing is walled, and $HOME itself is the wall.
  return { home, allow: [...new Set(allow.map((p) => path.resolve(p)))].filter((p) => inHome(p, home)), noWrite: [def] };
}

/** $HOME and every dir between it and each path: what stat/realpath walk on the way down. */
export function ancestorsUnder(paths: string[], home: string): string[] {
  const out = new Set<string>([home]);
  for (const p of paths) {
    if (!inHome(p, home)) continue;
    let d = path.dirname(p);
    while (inHome(d, home)) { out.add(d); d = path.dirname(d); }
  }
  return [...out];
}
