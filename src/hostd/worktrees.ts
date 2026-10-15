/**
 * This host's Chronos worktrees, for the brain (HOSTS.md → "`mc worktree` on a host"): the `worktree_list`
 * and `worktree_remove` rpc ops. A terminal here claims its worktree under this Mac's checkout
 * (terminals.ts claimWorktree) and a build makes its ticket worktree here (procs.ts worktreeEnsure), so
 * reading and removing them happens here too — with the brain's own rules (worktree-core.ts), on this
 * disk. The brain decides WHO may remove a tree (removeWorktreeAs); this module only holds the line on
 * WHAT may be removed: a `.chronos-worktrees` tree of one of this host's checkouts, never the checkout
 * itself, never one a process here is working in, and never uncommitted edits or unpushed commits
 * unless the caller forces it.
 *
 * Store-free, like everything under hostd/: the brain names repos by git remote and sends each one's
 * default branch (the base "unpushed" is counted against), because a host has no database to look it up in.
 */
import fs from "node:fs";
import path from "node:path";
import type { CheckoutInfo } from "../hostlink/wire.js";
import { cleanupWorktree, isGitRepo, listWorktrees, removeWorktreeAt, worktreeRootFor, worktreeStateAt, type RemoveWorktreeResult, type WorktreeState } from "../worktree-core.js";
import { remoteKey } from "./resolve.js";

/** A repo the brain asks about, by remote — the host finds its own checkout of it. */
export type HostRepoRef = { git_remote: string; default_branch?: string | null };
export type WorktreeListArgs = { repos: HostRepoRef[] };
/**
 * `mode: "cleanup"` is the brain's end-of-terminal / reaper removal (cleanupWorktree): only a clean
 * tree goes, unpushed commits or not — the branch keeps them. `remove` (the default) is `mc worktree rm`.
 */
export type WorktreeRemoveArgs = HostRepoRef & { path: string; force?: boolean; owner?: string | null; mode?: "remove" | "cleanup" };
/** One tree as the host reports it. `repo_path` is this host's checkout (a path here, never the brain's). */
export type HostWorktree = WorktreeState & { git_remote: string; repo_path: string };

export type HostWorktreeDeps = {
  checkouts: () => Promise<CheckoutInfo[]>;
  /** Is a process on this host working in `dir`? `ignoreSession`: the owner removing its own tree. */
  busy: (dir: string, ignoreSession?: string | null) => boolean;
};

const real = (p: string) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
export const sameDir = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && (path.resolve(a) === path.resolve(b) || real(a) === real(b));

function refsOf(raw: unknown): Map<string, HostRepoRef> {
  const out = new Map<string, HostRepoRef>();
  const list = Array.isArray((raw as WorktreeListArgs)?.repos) ? (raw as WorktreeListArgs).repos : [];
  for (const r of list) {
    const k = remoteKey(r?.git_remote);
    if (k && !out.has(k)) out.set(k, { git_remote: String(r.git_remote), default_branch: typeof r.default_branch === "string" ? r.default_branch : null });
  }
  return out;
}

/** Every Chronos worktree of the checkouts here that match the repos the brain asked about. */
export async function listHostWorktrees(d: HostWorktreeDeps, raw: unknown): Promise<HostWorktree[]> {
  const want = refsOf(raw);
  const out: HostWorktree[] = [];
  if (!want.size) return out;
  for (const c of await d.checkouts()) {
    const ref = want.get(remoteKey(c.remote_url));
    if (!ref || !(await isGitRepo(c.path))) continue;
    for (const wt of await listWorktrees(c.path)) {
      if (!wt.path.includes(".chronos-worktrees")) continue;
      const st = await worktreeStateAt(c.path, wt.path, ref.default_branch || "main", d.busy(wt.path));
      out.push({ ...st, branch: st.branch ?? wt.branch, git_remote: ref.git_remote, repo_path: c.path });
    }
  }
  return out;
}

/**
 * Remove one of this host's Chronos worktrees. Answers a result rather than throwing for a refusal, so
 * the brain can hand the operator the sentence ("3 uncommitted file(s) — would be lost") as it does for
 * a tree on its own disk.
 */
export async function removeHostWorktree(d: HostWorktreeDeps, raw: unknown): Promise<RemoveWorktreeResult> {
  const a = (raw ?? {}) as WorktreeRemoveArgs;
  const want = remoteKey(a.git_remote);
  if (!want || typeof a.path !== "string" || !path.isAbsolute(a.path)) return { ok: false, error: "need a repo remote and an absolute worktree path" };
  // Only a worktree git itself lists for one of this host's checkouts of that repo — a path the brain
  // names is never trusted to be one just because it looks like one.
  let repoPath: string | null = null;
  let wtPath: string | null = null;
  for (const c of await d.checkouts()) {
    if (remoteKey(c.remote_url) !== want) continue;
    if (sameDir(c.path, a.path)) return { ok: false, error: "that is the main checkout, not a worktree" };
    const hit = (await listWorktrees(c.path)).find((w) => sameDir(w.path, a.path));
    if (hit && !sameDir(hit.path, c.path) && sameDir(path.dirname(hit.path), worktreeRootFor(c.path))) {
      repoPath = c.path;
      wtPath = hit.path;
      break;
    }
  }
  if (!repoPath || !wtPath) return { ok: false, error: `no Chronos worktree at ${a.path} on this host` };
  const owner = typeof a.owner === "string" && a.owner ? a.owner : null;
  if (a.mode === "cleanup") {
    if (d.busy(wtPath)) return { ok: false, error: "a terminal is working in there right now" };
    await cleanupWorktree(repoPath, wtPath);
    return fs.existsSync(wtPath)
      ? { ok: false, error: "left in place: uncommitted changes (or git refused)" }
      : { ok: true, removed: wtPath, state: { path: wtPath, branch: null, dirty: false, dirty_files: 0, unpushed: 0, busy: false } };
  }
  return removeWorktreeAt(repoPath, wtPath, {
    force: !!a.force,
    owner: !!owner,
    defaultBranch: a.default_branch || "main",
    busy: () => d.busy(wtPath!, owner),
  });
}
