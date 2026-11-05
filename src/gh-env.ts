/**
 * A workspace's own GitHub credential and the operator's login never meet.
 *
 * A workspace may carry its own credential in its env (secrets_file or shared vars):
 *  - `GH_TOKEN`: a fine-grained token limited to its client's org. gh and git (through
 *    `gh auth git-credential`) use it ahead of any stored login.
 *  - `GH_CONFIG_DIR`: a gh login dir of its own (a separate account).
 *
 * Either way its agents must not reach the operator's login (`~/.config/gh`, which sees every org),
 * so the sandbox denies that dir to them (store/workspaces.ts isolationDenyDirs). gh exits when it
 * cannot read its config dir, so a token-only workspace gets a gh dir of its own (`~/.mc/gh/<slug>`,
 * empty is fine) to read instead. No workspace reaches another's gh login dir.
 *
 * Check runs: GitHub offers fine-grained tokens no Checks permission, so `statusCheckRollup` fails
 * with them. The daemon reads PR state and CI for a workspace with the operator's login
 * (`ghReadEnv`). It is not an agent and reads only PRs it already tracks for that workspace. Agents
 * get the same read through `mc pr checks`, limited to their own workspace's PRs.
 */
import os from "node:os";
import path from "node:path";

type Env = Record<string, string | undefined>;

/** The operator's gh login: every org he belongs to. */
export function operatorGhDir(home = os.homedir()): string {
  return path.join(home, ".config", "gh");
}

/** gh's config dir for a workspace that carries only a token. */
export function ownGhDir(slug: string, home = os.homedir()): string {
  return path.join(home, ".mc", "gh", slug);
}

export function hasOwnToken(env: Env): boolean {
  return !!(env.GH_TOKEN || env.GITHUB_TOKEN);
}

/** True when the workspace brings its own GitHub credential (a token, or a login dir of its own). */
export function hasOwnGithub(env: Env): boolean {
  return hasOwnToken(env) || !!env.GH_CONFIG_DIR?.trim();
}

/** `~/x` and `$HOME/x` → absolute, so a deny rule names the real path. */
export function expandHome(p: string, home = os.homedir()): string {
  const v = p.trim();
  if (v === "~" || v === "$HOME") return home;
  if (v.startsWith("~/")) return path.join(home, v.slice(2));
  if (v.startsWith("$HOME/")) return path.join(home, v.slice(6));
  return v;
}

/** childEnv's last step: a token-only workspace reads gh's config from its own dir. */
export function withOwnGhDir<E extends Env>(env: E, slug: string, home = os.homedir()): E {
  if (hasOwnToken(env) && !env.GH_CONFIG_DIR?.trim()) (env as Env).GH_CONFIG_DIR = ownGhDir(slug, home);
  return env;
}

/** The env the DAEMON reads a workspace's PRs with: its env minus the token (and the dir that came with it). */
export function stripOwnToken<E extends Env>(env: E, slug: string, home = os.homedir()): E {
  if (!hasOwnToken(env)) return env;
  const out = { ...env } as Env;
  delete out.GH_TOKEN;
  delete out.GITHUB_TOKEN;
  if (out.GH_CONFIG_DIR === ownGhDir(slug, home)) delete out.GH_CONFIG_DIR;
  return out as E;
}
