import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// The store-free half of worktrees.ts: plain git on a path. It is split out so `chronos host`
// (HOSTS.md phase 3) can create a ticket worktree under ITS OWN `.chronos-worktrees` with exactly the
// code the brain uses, without importing the store — worktrees.ts pulls in the DB, and a host must
// never open (or create) a Chronos database of its own.
//
// It started as what worktrees.ts had inline; worktrees.ts re-uses it.

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

/** git's own words for a failed command: its `fatal:`/`error:` line (never a `hint:`), else the error message. */
export function gitError(e: any): string {
  return gitLine(String(e?.stderr || e?.message || e || ""));
}

export function gitLine(stderr: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter((l) => l && !/^hint:/.test(l));
  return (lines.find((l) => /^(fatal|error):/.test(l)) ?? lines[lines.length - 1] ?? "git failed").slice(0, 300);
}

/**
 * Fetch `branch` from origin into `refs/remotes/origin/<branch>` and say whether origin has it.
 * Best-effort: offline, or no origin, falls back to whatever remote-tracking ref is already here.
 */
async function originHas(repoPath: string, branch: string): Promise<boolean> {
  try { await git(repoPath, ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], 20_000); } catch {}
  try {
    await git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Fast-forward a worktree's branch to origin's when it is simply behind (best-effort: diverged or dirty stays as is). */
async function ffToOrigin(wtPath: string, branch: string): Promise<void> {
  try { await git(wtPath, ["merge", "--ff-only", "--quiet", `origin/${branch}`], 30_000); } catch {}
}

/**
 * Ensure (creating if needed) a worktree for `branch` of the checkout at `repoPath`: its path, or
 * git's reason it could not. Idempotent: reuses an existing worktree for the branch, so a build and a
 * terminal on the same ticket land in the same dir.
 *
 * Origin first: the branch may have been worked on — and pushed — from another computer (a terminal
 * moved by host failover, a ticket built on a host). So origin's branch is fetched, a missing local
 * branch is created TRACKING `origin/<branch>` when origin has it (off the default branch only when it
 * does not), and an existing worktree or local branch is fast-forwarded to origin's when it is behind.
 */
export async function tryBranchWorktree(repoPath: string, defaultBranch: string, branch: string): Promise<{ path: string } | { error: string }> {
  if (!repoPath || !fs.existsSync(repoPath)) return { error: `${repoPath || "(no path)"} does not exist` };
  if (!(await isGitRepo(repoPath))) return { error: `${repoPath} is not a git repository` };
  const onOrigin = await originHas(repoPath, branch);

  const existing = await existingWorktree(repoPath, branch);
  if (existing && fs.existsSync(existing)) {
    if (onOrigin) await ffToOrigin(existing, branch);
    return { path: existing };
  }

  const root = worktreeRootFor(repoPath);
  const wtPath = path.join(root, branch.replace(/\//g, "-"));
  try {
    if (fs.existsSync(wtPath)) {
      // Stale dir git doesn't know about → let git reconcile, then reuse.
      try { await git(repoPath, ["worktree", "prune"]); } catch {}
      if (fs.existsSync(wtPath)) return { path: wtPath };
    }
    fs.mkdirSync(root, { recursive: true });
    const branchExists = (await git(repoPath, ["branch", "--list", branch])) !== "";
    const args = branchExists
      ? ["worktree", "add", wtPath, branch]
      : onOrigin
        ? ["worktree", "add", "--track", "-b", branch, wtPath, `origin/${branch}`]
        : ["worktree", "add", "-b", branch, wtPath, await baseRef(repoPath, defaultBranch)];
    await git(repoPath, args, 30_000);
    if (branchExists && onOrigin) await ffToOrigin(wtPath, branch);
    // Canonicalise (git reports worktrees by their realpath, so reuse returns the same string).
    return fs.existsSync(wtPath) ? { path: fs.realpathSync(wtPath) } : { error: `git did not create ${wtPath}` };
  } catch (e) {
    return { error: gitError(e) }; // e.g. branch already checked out in the main tree
  }
}

/**
 * tryBranchWorktree, for callers that fall back to the plain checkout: the path, or null — with git's
 * reason in the log rather than swallowed.
 */
export async function ensureBranchWorktree(repoPath: string, defaultBranch: string, branch: string): Promise<string | null> {
  const r = await tryBranchWorktree(repoPath, defaultBranch, branch);
  if ("error" in r) {
    console.warn(`[worktree] ${branch} in ${repoPath}: ${r.error}`);
    return null;
  }
  return r.path;
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
 * is what was pushed. Unlike ensureBranchWorktree — which, when origin has no such branch, creates
 * it off the default branch — this never invents a branch: no pushed branch means null, and the
 * caller decides.
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
  } catch (e) {
    console.warn(`[worktree] ${branch} from origin in ${repoPath}: ${gitError(e)}`);
    return null;
  }
}

/** What a worktree is holding that removing it would destroy. */
export type WorktreeState = {
  path: string;
  branch: string | null;
  /** Uncommitted edits — the only thing git cannot get back. */
  dirty: boolean;
  dirty_files: number;
  /** Commits on this branch that no remote has. Survive removal (shared object store), but they
   *  become invisible: nothing but the branch name points at them afterwards. */
  unpushed: number;
  /** A terminal is working here right now. */
  busy: boolean;
};

/**
 * Read what a worktree holds, without changing anything — the store-free half of worktrees.ts's
 * worktreeState, so a host answers the same question about its own trees with the same code. `busy`
 * is the caller's to know (the brain reads its sessions, a host its own processes).
 */
export async function worktreeStateAt(repoPath: string, wtPath: string, defaultBranch: string, busy = false): Promise<WorktreeState> {
  const out: WorktreeState = { path: wtPath, branch: null, dirty: false, dirty_files: 0, unpushed: 0, busy };
  try {
    const status = await git(wtPath, ["status", "--porcelain"]);
    out.dirty_files = status ? status.split("\n").filter(Boolean).length : 0;
    out.dirty = out.dirty_files > 0;
  } catch {
    // Unreadable tree — treat as dirty so nothing removes what it could not inspect.
    out.dirty = true;
  }
  try {
    out.branch = (await git(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"])) || null;
  } catch {}
  try {
    // `@{u}` throws when there is no upstream at all — a branch never pushed. Count its commits
    // against the default base instead, so "never pushed" reads as unpushed rather than as zero.
    let range: string;
    try {
      await git(wtPath, ["rev-parse", "--abbrev-ref", "@{u}"]);
      range = "@{u}..HEAD";
    } catch {
      range = `${await baseRef(repoPath, defaultBranch || "main")}..HEAD`;
    }
    const n = Number(await git(wtPath, ["rev-list", "--count", range])) || 0;
    out.unpushed = n && (await alreadyLanded(repoPath, wtPath, defaultBranch)) ? 0 : n;
  } catch {}
  return out;
}

/**
 * Commits that "look unpushed" but are not at risk: the normal end of a PR is a squash-merge that
 * deletes the remote branch, after which `@{u}` is gone and every commit on the branch counts against
 * the base — and the terminal that did everything right is refused its own cleanup. Two ways out:
 * the commits are reachable from SOME remote ref (pushed under another name), or the branch's whole
 * change already sits in the base as one patch (a synthetic squash of HEAD onto the merge-base that
 * `git cherry` finds upstream). Anything else — including a squash the base has since edited over —
 * stays unpushed, so a false "no" costs a `--force` decision and never a lost commit.
 */
async function alreadyLanded(repoPath: string, wtPath: string, defaultBranch: string): Promise<boolean> {
  try {
    if (!(await git(wtPath, ["remote"]))) return false;
    if (Number(await git(wtPath, ["rev-list", "--count", "HEAD", "--not", "--remotes"])) === 0) return true;
    const base = await baseRef(repoPath, defaultBranch || "main");
    if (base === "HEAD") return false;
    const mb = await git(wtPath, ["merge-base", base, "HEAD"]);
    const tree = await git(wtPath, ["rev-parse", "HEAD^{tree}"]);
    const squash = await git(wtPath, ["-c", "user.name=chronos", "-c", "user.email=chronos@localhost", "commit-tree", tree, "-p", mb, "-m", "chronos: squash probe"]);
    return (await git(wtPath, ["cherry", base, squash])).startsWith("-");
  } catch {
    return false;
  }
}

export type RemoveWorktreeResult =
  | { ok: true; removed: string; state: WorktreeState }
  | { ok: false; error: string; state?: WorktreeState };

/**
 * The deliberate-removal rules, store-free (worktrees.ts removeWorktree on the brain, hostd/worktrees.ts
 * on a host): only a Chronos worktree, never the main checkout, never a busy one, and — unless forced —
 * never one holding uncommitted edits or commits no remote has. `busy` is asked after the cheap checks;
 * `owner` only words the refusal ("another terminal").
 */
export async function removeWorktreeAt(
  repoPath: string,
  wtPath: string,
  opts: { force?: boolean; owner?: boolean; defaultBranch: string; busy: () => boolean },
): Promise<RemoveWorktreeResult> {
  if (!repoPath || !wtPath) return { ok: false, error: "need a repo and a worktree path" };
  if (wtPath === repoPath) return { ok: false, error: "that is the main checkout, not a worktree" };
  if (!wtPath.includes(".chronos-worktrees")) return { ok: false, error: "not a Chronos worktree — refusing" };
  if (!fs.existsSync(wtPath)) return { ok: false, error: "no such worktree (already gone?)" };
  if (!(await isGitRepo(repoPath))) return { ok: false, error: "not a git repo" };

  const state = await worktreeStateAt(repoPath, wtPath, opts.defaultBranch, opts.busy());
  if (state.busy)
    return { ok: false, error: `${opts.owner ? "another" : "a"} terminal is working in there right now`, state };
  if (!opts.force) {
    if (state.dirty)
      return { ok: false, error: `${state.dirty_files} uncommitted file(s) — would be lost`, state };
    if (state.unpushed)
      return { ok: false, error: `${state.unpushed} commit(s) not on any remote`, state };
  }
  try {
    await git(repoPath, ["worktree", "remove", "--force", wtPath], 30_000);
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200), state };
  }
  if (fs.existsSync(wtPath)) return { ok: false, error: "git reported success but the path is still there", state };
  return { ok: true, removed: wtPath, state };
}

// Remove a worktree once its terminal ends — but ONLY if clean (no uncommitted changes). The branch
// and its commits live in the shared object store, so removing a clean checkout loses nothing; a
// dirty one is left untouched so no in-progress work is destroyed. No-op unless the path is one of
// this repo's worktrees.
export async function cleanupWorktree(repoPath: string, wtPath: string): Promise<void> {
  try {
    if (!repoPath || !wtPath || wtPath === repoPath || !(await isGitRepo(repoPath))) return;
    if (!wtPath.includes(".chronos-worktrees")) return; // only our own
    const dirty = (await git(wtPath, ["status", "--porcelain"])) !== "";
    if (dirty) return;
    await git(repoPath, ["worktree", "remove", "--force", wtPath]);
  } catch {}
}
