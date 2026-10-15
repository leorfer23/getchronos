import os from "node:os";
import path from "node:path";
import { CONFIG } from "./config.js";
import { workspaces } from "./store.js";
import { buildProfile, ensureWsTicketsDir, workspaceSandboxAllow } from "./sandbox.js";
import { clampSandbox } from "./spawn-guard.js";
import { worktreeRootFor } from "./worktree-core.js";

/**
 * The Seatbelt profile for a CLI the operator starts by hand (`claude-<client>` in a plain terminal),
 * so a client's profile sees the same Mac outside Chronos that it sees inside a Desk terminal.
 *
 * Same walls as a Desk terminal in that workspace — the workspace's floor mode, every other
 * workspace's repos (+ their worktree roots) and secrets files, the global secrets list, its
 * `sandbox_allow` re-grants — plus one a Desk terminal does not need: every OTHER profile's config
 * dir (`~/.claude-<client>`, which holds that client's transcripts and login). `~/.claude` itself
 * stays readable — client profiles symlink its CLAUDE.md, skills and commands — but its history
 * (transcripts, memory, prompt history, ~/.claude.json) is denied to every other profile.
 *
 * The launcher's cwd is deliberately NOT granted: started inside another client's repo, the deny
 * must win. Only its own config dir and the workspace's tickets dir are.
 */
const DEFAULT_PROFILE_HISTORY = [
  "projects", "history.jsonl", "file-history", "paste-cache", "shell-snapshots", "sessions", "session-env", "todos",
];

export function launcherProfile(workspaceId: string, configDir: string): string | null {
  const ws = workspaces.get(workspaceId);
  if (!ws) throw new Error("workspace not found");
  const own = path.resolve(configDir);
  if (!Object.values(CONFIG.profiles).some((p) => path.resolve(p) === own))
    throw new Error(`not a known profile dir: ${configDir}`);
  const defaultDir = path.join(os.homedir(), ".claude");
  const otherProfiles = Object.values(CONFIG.profiles)
    .map((p) => path.resolve(p))
    .filter((p) => p !== own && p !== defaultDir);
  const defaultHistory = own === defaultDir ? [] : [
    ...DEFAULT_PROFILE_HISTORY.map((p) => path.join(defaultDir, p)),
    path.join(os.homedir(), ".claude.json"),
  ];
  const deny = [
    ...new Set(workspaces.isolationDenyDirs(ws.id).flatMap((p) => [p, worktreeRootFor(p)])),
    ...otherProfiles,
    ...defaultHistory,
  ];
  return buildProfile(
    clampSandbox(null, ws.id),
    own,
    [ensureWsTicketsDir(ws.slug)],
    own,
    deny,
    false,
    [],
    workspaceSandboxAllow(ws.sandbox_allow),
  );
}
