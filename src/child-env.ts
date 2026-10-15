import path from "node:path";
import type { Workspace } from "./types.js";
import { parseEnvFile } from "./env-file.js";
import { workspaceVars } from "./store/workspace-vars.js";

// Re-exported for the ~few call sites that already imported it from here. The parser itself lives
// in env-file.ts — this module reads the store, and boot must not pull the store in that early.
export { parseEnvFile };

// Env vars every child needs regardless of workspace. Mostly non-secret; the daemon's ambient
// per-client secrets stay excluded. EXCEPTION: AI_GATEWAY_API_KEY — a single shared Vercel AI Gateway
// token the operator opted to expose to ALL workspaces (opencode routes through it via {env:...}), so
// it passes through from the daemon's .secrets rather than being duplicated into every secrets_file.
// SSH_AUTH_SOCK is deliberately NOT here: it's a live IPC socket to the host's ssh-agent, not a file
// a deny-list can block — passing it to every scoped child would let any workspace's agent auth as
// The operator (git push, ssh) with no explicit opt-in. A workspace that needs it can set it in its
// own secrets_file.
const ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "LANG", "LC_ALL", "TZ", "COLORTERM", "AI_GATEWAY_API_KEY"];
const warned = new Set<string>();

// Env for a spawned agent: minimal allowlist always, plus (ws present) that workspace's own
// secrets_file only, so one client's secrets never leak into another's runs. A falsy ws (legacy/
// unscoped job) does NOT fall back to the full daemon env — the daemon's own process.env can hold
// ambient operator secrets (.secrets is loaded into it at boot), and an unscoped job has no workspace
// to scope them to, so it gets the same restricted allowlist as everyone else. Later env spreads
// (backend.env, mcEnv, egressEnv) still win.
// launchd hands a gui agent no locale at all, and macOS command-line tools that go through
// CoreFoundation (pbcopy/pbpaste above all) then assume MacRoman rather than UTF-8: an agent that
// copies "│ ❯" out of its terminal puts "‚îÇ ‚ùØ" on the clipboard. Force UTF-8 rather than merely
// passing LANG through, so a child is never at the mercy of how the daemon happened to be started.
export const DEFAULT_LOCALE = "en_US.UTF-8";

export function childEnv(ws: Workspace | null | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];
  if (!env.LANG && !env.LC_ALL) env.LANG = DEFAULT_LOCALE;
  if (!ws) return env;
  if (ws.secrets_file) {
    const file = path.resolve(process.cwd(), ws.secrets_file);
    try {
      Object.assign(env, parseEnvFile(file));
    } catch {
      if (!warned.has(file)) {
        warned.add(file);
        console.warn(`[child-env] secrets_file not readable: ${file}`);
      }
    }
  }
  // Shared vars: what the operator handed THIS workspace from the Desk ("here's X_TOKEN for 12
  // hours"). Merged after secrets_file so the deliberate, dated thing wins over the static file —
  // that is the whole point of adding one, and a var that lost to a stale file would look broken.
  // Live rows only: workspaceVars.active() filters and purges anything past its expiry, so an
  // expired token simply stops being in the environment of the next spawn.
  try {
    if (ws.id) Object.assign(env, workspaceVars.active(ws.id));
  } catch (e) {
    // Never let a store hiccup stop a terminal from opening — a missing var is a failed command,
    // an unspawnable terminal is a dead workspace.
    console.warn(`[child-env] could not load shared vars for ${ws.slug}: ${String((e as Error)?.message ?? e)}`);
  }
  if (ws.git_name) { env.GIT_AUTHOR_NAME = ws.git_name; env.GIT_COMMITTER_NAME = ws.git_name; }
  if (ws.git_email) { env.GIT_AUTHOR_EMAIL = ws.git_email; env.GIT_COMMITTER_EMAIL = ws.git_email; }
  return env;
}
