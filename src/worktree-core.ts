import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// The store-free half of worktrees.ts: plain git on a path. It is split out so `chronos host`
// (HOSTS.md phase 3) can create a ticket worktree under ITS OWN `.chronos-worktrees` with exactly the
// code the brain uses, without importing the store — worktrees.ts pulls in the DB, and a host must
// never open (or create) a Chronos database of its own.
//
// Everything here is behaviour-identical to what worktrees.ts had inline; worktrees.ts re-uses it.

const execFileAsync = promisify(execFile);

// Async (execFile, not execFileSync): these run on the same Node process as the HTTP/WS server —
// a sync git call would block the whole event loop (every other request, WS heartbeat, timer) for
// as long as fetch/worktree-add takes.
export async function git(repoPath: string, args: string[], timeoutMs = 10_000): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return stdout.trim();
}

export async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    await git(repoPath, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

/** Sibling of the repo (never inside its working tree): `<parent>/.chronos-worktrees/<repo>`. */
export function worktreeRootFor(repoPath: string): string {
  return path.join(path.dirname(repoPath), ".chronos-worktrees", path.basename(repoPath));
}

// Every worktree this repo has checked out, as [path, branch]. Parses `git worktree list --porcelain`
// (records separated by blank lines: "worktree <path>" … "branch refs/heads/<name>").
export async function listWorktrees(repoPath: string): Promise<Array<{ path: string; branch: string }>> {
  let out: string;
  try {
    out = await git(repoPath, ["worktree", "list", "--porcelain"]);
  } catch {
    return [];
  }
  const found: Array<{ path: string; branch: string }> = [];
  let cur: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) cur = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch refs/heads/") && cur) {
      found.push({ path: cur, branch: line.slice("branch refs/heads/".length).trim() });
      cur = null;
    }
  }
  return found;
}

// The path a worktree for `branch` is checked out at, if one already exists.
export async function existingWorktree(repoPath: string, branch: string): Promise<string | null> {
  return (await listWorktrees(repoPath)).find((w) => w.branch === branch)?.path ?? null;
}

// Best-effort "pull from main": fetch the default branch, then pick the freshest base ref available
// (origin/<default> > local <default> > HEAD). Offline / no-remote degrades gracefully.
export async function baseRef(repoPath: string, defaultBranch: string): Promise<string> {
  try {
    await git(repoPath, ["fetch", "origin", defaultBranch], 20_000);
  } catch {}
  for (const ref of [`origin/${defaultBranch}`, defaultBranch]) {
    try {
      await git(repoPath, ["rev-parse", "--verify", "--quiet", ref]);
      return ref;
    } catch {}
  }
  return "HEAD";
}

/**
 * Ensure (creating if needed) a worktree for `branch` of the checkout at `repoPath` and return its
 * path, or null to tell the caller to fall back to the plain checkout. Idempotent: reuses an existing
 * worktree for the branch, so a build and a terminal on the same ticket land in the same dir.
 */
export async function ensureBranchWorktree(repoPath: string, defaultBranch: string, branch: string): Promise<string | null> {
  if (!repoPath || !fs.existsSync(repoPath) || !(await isGitRepo(repoPath))) return null;

  const existing = await existingWorktree(repoPath, branch);
  if (existing && fs.existsSync(existing)) return existing;

  const root = worktreeRootFor(repoPath);
  const wtPath = path.join(root, branch.replace(/\//g, "-"));
  try {
    if (fs.existsSync(wtPath)) {
      // Stale dir git doesn't know about → let git reconcile, then reuse.
      try { await git(repoPath, ["worktree", "prune"]); } catch {}
      if (fs.existsSync(wtPath)) return wtPath;
    }
    fs.mkdirSync(root, { recursive: true });
    const branchExists = (await git(repoPath, ["branch", "--list", branch])) !== "";
    const args = branchExists
      ? ["worktree", "add", wtPath, branch]
      : ["worktree", "add", "-b", branch, wtPath, await baseRef(repoPath, defaultBranch)];
    await git(repoPath, args, 30_000);
    // Canonicalise (git reports worktrees by their realpath, so reuse returns the same string).
    return fs.existsSync(wtPath) ? fs.realpathSync(wtPath) : null;
  } catch {
    return null; // e.g. branch already checked out in the main tree — fall back to repo path
  }
}

// Sandbox dir adjustments for a ticket that builds in an ISOLATED worktree (job.cwd) of `repoPath`.
// The shared main checkout must be WRITE-denied (guard is allow-by-default) so the agent — handed
// absolute repo paths in its context — can't edit it, `cd` there, and `git add -A && commit`, sweeping
// other concurrent builds' work onto main (the PER-36 incident). It stays READ-allowed: a linked
// worktree's git must read the main checkout (commondir) to operate, and blocking reads breaks git
// entirely. Two sub-paths are re-granted WRITE via addDirs: `.git` (shared objectstore/refs the
// worktree commits through) and `.mc` (gitignored runtime ticket store, absent from the worktree, that
// the agent reads + logs to). allow-own runs after the write-deny, so these narrower grants win.
// Empty when there's no repo or the run isn't in a worktree. (`mc` CLI lives at ~/.mc/bin, outside repo.)
export function worktreeSandboxDirs(
  repoPath: string | undefined | null,
  cwd: string,
): { readonly: string[]; grant: string[] } {
  if (!repoPath || path.resolve(repoPath) === path.resolve(cwd)) return { readonly: [], grant: [] };
  return { readonly: [repoPath], grant: [path.join(repoPath, ".git"), path.join(repoPath, ".mc")] };
}

/**
 * A worktree for `branch` AS IT IS ON ORIGIN, or null when origin has no such branch (or git fails).
 *
 * For work that moves to this checkout from another computer (host failover, src/host-failover.ts):
 * the other Mac's worktree went down with it, and the only copy of its commits this machine can reach
 * is what was pushed. Unlike ensureBranchWorktree — which creates a missing branch off the default
 * branch — this never invents a branch: no pushed branch means null, and the caller decides.
 * Reuses a worktree this checkout already has for the branch; an existing local branch is
 * fast-forwarded to origin's when it can be (best-effort — a diverged local branch is left as is).
 */
export async function ensureOriginBranchWorktree(repoPath: string, branch: string): Promise<string | null> {
  if (!repoPath || !branch || !fs.existsSync(repoPath) || !(await isGitRepo(repoPath))) return null;
  try {
    await git(repoPath, ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], 30_000);
    await git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
  } catch {
    return null;
  }
  const existing = await existingWorktree(repoPath, branch);
  if (existing && fs.existsSync(existing)) {
    try { await git(existing, ["merge", "--ff-only", `origin/${branch}`], 30_000); } catch {}
    return existing;
  }
  const root = worktreeRootFor(repoPath);
  let wtPath = path.join(root, branch.replace(/\//g, "-"));
  if (fs.existsSync(wtPath)) {
    try { await git(repoPath, ["worktree", "prune"]); } catch {}
    // A directory git does not know about: never write into it, take a sibling name instead.
    if (fs.existsSync(wtPath)) wtPath = `${wtPath}-moved-${Date.now().toString(36)}`;
  }
  try {
    fs.mkdirSync(root, { recursive: true });
    const local = (await git(repoPath, ["branch", "--list", branch])) !== "";
    if (local) {
      await git(repoPath, ["worktree", "add", wtPath, branch], 30_000);
      try { await git(wtPath, ["merge", "--ff-only", `origin/${branch}`], 30_000); } catch {}
    } else {
      await git(repoPath, ["worktree", "add", "--track", "-b", branch, wtPath, `origin/${branch}`], 30_000);
    }
    return fs.existsSync(wtPath) ? fs.realpathSync(wtPath) : null;
  } catch {
    return null;
  }
}
