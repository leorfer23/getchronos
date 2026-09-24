/**
 * Where things are on THIS Mac — the half of a spawn the brain is never allowed to decide (HOSTS.md →
 * "SpawnSpec: intent, not paths"). Shared by the host's terminals (terminals.ts) and its headless runs
 * and exec (procs.ts), so a run and a terminal on the same ticket resolve the same checkout, the same
 * worktree and the same isolation — with the same code. Store-free: a host never opens a database.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeGitRemote } from "../hostlink/git-remote.js";
import type { CheckoutInfo } from "../hostlink/wire.js";
import { worktreeRootFor } from "../worktree-core.js";

const execFileAsync = promisify(execFile);

/** The env a host supplies itself (the brain sends none of these). Mirrors child-env.ts's allowlist. */
export const HOST_OWN_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "LANG", "LC_ALL", "TZ", "COLORTERM"];
const DEFAULT_LOCALE = "en_US.UTF-8";

/** This process's own base env, with HOME pinned to the host home a spawn runs under. */
export function hostBaseEnv(home: string): Record<string, string> {
  const base: Record<string, string> = {};
  for (const k of HOST_OWN_ENV) if (process.env[k] !== undefined) base[k] = process.env[k]!;
  if (!base.LANG && !base.LC_ALL) base.LANG = DEFAULT_LOCALE;
  base.HOME = home;
  return base;
}

/** One key per repository however it was cloned — the brain's own matcher (hostlink/git-remote.ts). */
export function remoteKey(url: string | null | undefined): string {
  return normalizeGitRemote(url) ?? "";
}

/** The real main checkouts among these paths (`.git` a directory), realpath'd like terminal.ts's. */
export function mainCheckouts(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    try { if (fs.statSync(path.join(p, ".git")).isDirectory()) out.add(fs.realpathSync.native(p)); } catch {}
  }
  return [...out];
}

/** A checkout's worktree root, created if it can be (a strict profile must allow a later `mc worktree`). */
export function ensureRoot(repoPath: string): string | null {
  const root = worktreeRootFor(repoPath);
  try { fs.mkdirSync(root, { recursive: true }); } catch {}
  return fs.existsSync(root) ? root : null;
}

export function isDir(p: string): boolean {
  try { return path.isAbsolute(p) && fs.statSync(p).isDirectory(); } catch { return false; }
}

/** A branch/ref name we will hand to git as an argument: a name, never something that reads as an option. */
export function safeRef(r: unknown): r is string {
  return typeof r === "string" && /^[\w][\w./-]{0,200}$/.test(r) && !r.includes("..");
}

export function signalName(n: number): string {
  for (const [name, num] of Object.entries(os.constants.signals)) if (num === n) return name;
  return `SIG${n}`;
}

/** The workspace deny check both locks share: the host's own list first, then the brain's policy. */
export function vetoReason(local: readonly string[], brain: readonly string[], ws: { id: string; slug: string } | null): string | null {
  if (!ws) return null;
  if (local.some((d) => d === ws.id || d === ws.slug)) return `veto: workspace ${ws.slug} is denied on this host (CHRONOS_HOST_DENY)`;
  if (brain.some((d) => d === ws.id || d === ws.slug)) return `veto: workspace ${ws.slug} is denied on this host by the brain's policy`;
  return null;
}

export type CloneOpts = { autoClone?: boolean; cloneRoot?: () => string | null };

/** Clone a missing repo into the first host root, when (and only when) CHRONOS_HOST_AUTO_CLONE=1. */
export async function maybeClone(o: CloneOpts, remote: string): Promise<string | null> {
  if (!o.autoClone) return null;
  const root = o.cloneRoot?.();
  if (!root) return null;
  const name = remoteKey(remote).split("/").pop() || "repo";
  const dest = path.join(root, name);
  if (fs.existsSync(dest)) return null; // a different repo already sits at that name: never clobber
  fs.mkdirSync(root, { recursive: true });
  await execFileAsync("git", ["clone", "--", remote, dest], { timeout: 10 * 60_000 });
  return fs.realpathSync.native(dest);
}

export type ResolvedRepos = {
  checkouts: CheckoutInfo[];
  /** This workspace's repo, on this Mac (cloned now if auto-clone allowed it), or null. */
  repoPath: string | null;
  /** Every workspace repo this Mac has, the main repo included. */
  wsRepoPaths: string[];
  /** Workspace repo id → its path here (what path tokens in a run's prose expand to). */
  byId: Map<string, string>;
  /**
   * Isolation on a host: every checkout here that is NOT this workspace's, and its worktree root. The
   * host cannot tell whose an unregistered clone is, and is never told another client's repos.
   */
  denyDirs: string[];
};

/**
 * Find a workspace's repos on this Mac by git remote, among the checkouts it scanned. A missing MAIN
 * repo is an error the caller surfaces (the brain placed work here that this Mac cannot do); a missing
 * sibling is just not granted.
 */
export async function resolveRepos(
  o: CloneOpts & { checkouts: () => Promise<CheckoutInfo[]> },
  repo: { id: string; git_remote: string } | null,
  repos: Array<{ id: string; git_remote: string }>,
): Promise<ResolvedRepos> {
  const checkouts = await o.checkouts();
  const byRemote = new Map<string, string>();
  for (const c of checkouts) { const k = remoteKey(c.remote_url); if (k) byRemote.set(k, c.path); }
  let repoPath: string | null = null;
  if (repo) {
    repoPath = byRemote.get(remoteKey(repo.git_remote) || "\0") ?? null;
    if (!repoPath) repoPath = await maybeClone(o, repo.git_remote);
    if (!repoPath) {
      throw new Error(`repo ${repo.git_remote} is not checked out on this host — clone it under CHRONOS_HOST_ROOTS (or set CHRONOS_HOST_AUTO_CLONE=1)`);
    }
  }
  const byId = new Map<string, string>();
  for (const r of repos) { const p = byRemote.get(remoteKey(r.git_remote) || "\0"); if (p) byId.set(r.id, p); }
  if (repo && repoPath) byId.set(repo.id, repoPath);
  const wsRepoPaths = [...new Set(byId.values())];
  const mine = new Set(wsRepoPaths);
  const denyDirs = checkouts.map((c) => c.path).filter((p) => !mine.has(p)).flatMap((p) => [p, worktreeRootFor(p)]);
  return { checkouts, repoPath, wsRepoPaths, byId, denyDirs };
}

const under = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith("/") ? dir : dir + "/");

/**
 * Is `dir` one of this Mac's checkouts or inside one of their worktree roots? What `exec` and a run's
 * explicit cwd are held to: the brain may name a directory the host reported, never an arbitrary one.
 */
export function insideCheckouts(dir: string, checkouts: CheckoutInfo[]): boolean {
  let real = dir;
  try { real = fs.realpathSync.native(dir); } catch {}
  return checkouts.some((c) => {
    const roots = [c.path, worktreeRootFor(c.path)];
    let realC = c.path;
    try { realC = fs.realpathSync.native(c.path); } catch {}
    roots.push(realC, worktreeRootFor(realC));
    return roots.some((r) => under(dir, r) || under(real, r));
  });
}
