import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { repos } from "./store/repos.js";
import { workspaces } from "./store/workspaces.js";
import { wsTicketsDir, type SandboxMode } from "./sandbox.js";
import { CONFIG } from "./config.js";

// Hardens the inputs an API caller (or a compromised/buggy internal flow) can hand to a job/session
// spawn — cwd, add_dirs, sandbox mode — so none of them can point a headless agent or PTY outside its
// own workspace, or downgrade the isolation the workspace operator configured.

const home = os.homedir();

interface Root {
  path: string;
  exact?: boolean; // true → only an exact match counts (no subpaths)
}

// Directories a workspace's jobs/sessions may legitimately point cwd/add_dirs at: its own repos (+
// their sibling worktree checkouts) and ticket-files dir, plus $HOME itself (bare/no-repo chats land
// there). No workspace → only $HOME (nothing else to trust it against).
function allowedRoots(workspaceId?: string | null): Root[] {
  const roots: Root[] = [{ path: fs.realpathSync(home), exact: true }];
  if (!workspaceId) return roots;
  for (const r of repos.list(workspaceId)) {
    if (!r.path) continue;
    try {
      const realRepoPath = fs.realpathSync(r.path);
      roots.push({ path: realRepoPath });
      roots.push({ path: path.join(path.dirname(realRepoPath), ".chronos-worktrees", path.basename(realRepoPath)) });
    } catch {
      // repo path doesn't exist; skip it rather than crashing
    }
  }
  const ws = workspaces.get(workspaceId);
  if (ws?.default_dir) {
    // The workspace's landing dir (admin-set; the symlink farm holding its checkouts) is where its
    // repo-less terminals already open — a job may run there too.
    try {
      roots.push({ path: fs.realpathSync(ws.default_dir) });
    } catch {
      // landing dir doesn't exist; skip it
    }
  }
  if (ws) {
    const ticketsDir = wsTicketsDir(ws.slug);
    try {
      roots.push({ path: fs.realpathSync(ticketsDir) });
    } catch {
      // tickets dir doesn't exist yet; skip it
    }
  }
  return roots;
}

function withinRoot(candidate: string, root: Root): boolean {
  if (root.exact) return candidate === root.path;
  const rel = path.relative(root.path, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string };

// A client-supplied cwd must resolve inside a workspace's own repos/worktrees/landing dir/ticket dir
// (or exactly $HOME). The reason is for API callers: a rejected path must come back as a 4xx that says
// why, never as a silent fallback to some other directory.
export function checkCwd(candidate: string, workspaceId?: string | null): PathCheck {
  const resolved = path.resolve(candidate);
  if (!fs.existsSync(resolved)) return { ok: false, reason: `${candidate} does not exist` };
  let realpath: string;
  try {
    realpath = fs.realpathSync(resolved);
  } catch (e) {
    return { ok: false, reason: `${candidate} cannot be resolved (${(e as Error).message})` };
  }
  const roots = allowedRoots(workspaceId);
  if (roots.some((r) => withinRoot(realpath, r))) return { ok: true, path: realpath };
  const allowed = roots.map((r) => (r.exact ? `${r.path} (exactly)` : r.path)).join(", ");
  return {
    ok: false,
    reason: workspaceId
      ? `${candidate} is outside the workspace's allowed directories (its repos, their worktrees, its landing dir, its tickets dir): ${allowed}`
      : `${candidate} is not allowed without a workspace — only ${allowed}; set workspace_id to use that workspace's repos`,
  };
}

// Internal-caller flavour: drop a disallowed cwd (null) so the caller falls back to its own computed
// default. API routes must use checkCwd and reject instead.
export function sanitizeCwd(candidate: string | null | undefined, workspaceId?: string | null): string | null {
  if (!candidate) return null;
  const r = checkCwd(candidate, workspaceId);
  return r.ok ? r.path : null;
}

// First add_dirs entry that sanitizeAddDirs would drop, with the reason — for API rejection.
export function addDirsError(candidates: string[] | null | undefined, workspaceId?: string | null): string | null {
  for (const c of candidates ?? []) {
    if (!c) return "add_dirs entries must be non-empty paths";
    const r = checkCwd(c, workspaceId);
    if (!r.ok) return r.reason;
  }
  return null;
}

// Same allowlist for add_dirs: a job/session may only request extra read/write access to directories it
// could already legitimately use as a cwd, never an arbitrary absolute path from the request body.
export function sanitizeAddDirs(candidates: string[] | null | undefined, workspaceId?: string | null): string[] {
  if (!candidates?.length) return [];
  const roots = allowedRoots(workspaceId);
  const out: string[] = [];
  for (const c of candidates) {
    if (typeof c !== "string" || !c) continue;
    const resolved = path.resolve(c);
    if (!fs.existsSync(resolved)) continue;
    let realpath: string;
    try {
      realpath = fs.realpathSync(resolved);
    } catch {
      continue;
    }
    if (roots.some((r) => withinRoot(realpath, r))) out.push(realpath);
  }
  return out;
}

const STRICTNESS: Record<SandboxMode, number> = { off: 0, guard: 1, strict: 2 };

function sandboxFloor(workspaceId?: string | null): SandboxMode {
  return (
    (workspaceId ? (workspaces.get(workspaceId)?.sandbox_mode as SandboxMode | undefined) : undefined) ??
    CONFIG.sandbox.defaultMode
  );
}

// Why a requested sandbox mode would be clamped (weaker than the floor), or null when it stands as-is.
export function sandboxError(requested: SandboxMode | null | undefined, workspaceId?: string | null): string | null {
  if (!requested) return null;
  const floor = sandboxFloor(workspaceId);
  return STRICTNESS[requested] >= STRICTNESS[floor]
    ? null
    : `sandbox "${requested}" is weaker than the ${workspaceId ? "workspace's" : "daemon's default"} floor "${floor}" — use "${floor}" or stricter`;
}

// A job/session may only run at least as sandboxed as its workspace's configured floor — never
// weaker (a job body claiming sandbox:"off" can't downgrade a workspace pinned to "strict").
export function clampSandbox(requested: SandboxMode | null | undefined, workspaceId?: string | null): SandboxMode {
  const floor = sandboxFloor(workspaceId);
  const want = requested ?? floor;
  return STRICTNESS[want] >= STRICTNESS[floor] ? want : floor;
}

type SpawnFields = { workspace_id?: string | null; cwd?: string; add_dirs?: string[] | null; sandbox?: SandboxMode };

// cwd / add_dirs / sandbox are hardened in the store (sanitizeCwd/sanitizeAddDirs/clampSandbox), which
// silently drops or clamps a value it won't trust. Behind the API that reads as "200 but ignored" —
// so the job routes call these first and reject with the reason instead.
function spawnFieldsError(f: SpawnFields, workspaceId: string | null | undefined): string | null {
  if (f.cwd !== undefined) {
    const c = checkCwd(f.cwd, workspaceId);
    if (!c.ok) return `cwd rejected: ${c.reason}`;
  }
  const ad = addDirsError(f.add_dirs, workspaceId);
  if (ad) return `add_dirs rejected: ${ad}`;
  return sandboxError(f.sandbox, workspaceId);
}

export function jobCreateSpawnError(body: SpawnFields): string | null {
  return spawnFieldsError(body, body.workspace_id);
}

// A full-form save (the Desk sends every field) re-sends stored values, which may have gone stale (a
// pruned worktree, a raised floor); only judge what changes — unless the workspace itself moves, then
// every provided value is re-checked against the new one.
export function jobPatchSpawnError(
  cur: { workspace_id: string | null; cwd: string; add_dirs: string | null; sandbox: SandboxMode },
  patch: SpawnFields,
): string | null {
  const wsMoves = patch.workspace_id !== undefined && patch.workspace_id !== cur.workspace_id;
  const pick = <K extends "cwd" | "add_dirs" | "sandbox">(k: K, stored: unknown): SpawnFields[K] =>
    wsMoves || JSON.stringify(patch[k] ?? null) !== JSON.stringify(stored ?? null) ? patch[k] : undefined;
  return spawnFieldsError(
    {
      cwd: pick("cwd", cur.cwd),
      add_dirs: pick("add_dirs", cur.add_dirs ? JSON.parse(cur.add_dirs) : null),
      sandbox: pick("sandbox", cur.sandbox),
    },
    wsMoves ? patch.workspace_id : cur.workspace_id,
  );
}
