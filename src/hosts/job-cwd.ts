/**
 * `mc job new` from a terminal on another computer (HOSTS.md → "`mc` on a host"). The directory it
 * sends is a path on THAT computer, so the brain cannot check it against its own disk — and must not
 * quietly swap it for the brain's `$HOME`, which is what used to happen. Instead the job is pinned to
 * that host (jobs.host_id, the same pin a ticket worktree a host made gets; run-placement.ts keeps it
 * there), and only when the directory is one the host itself reported for this workspace: a checkout
 * of one of its repos, a folder inside one, or a worktree under that checkout's `.chronos-worktrees`.
 * The host holds the run to the same line again when it spawns it (hostd/procs.ts insideCheckouts).
 */
import path from "node:path";
import { hosts, repoCheckouts, repos } from "../store.js";
import { worktreeRootFor } from "../worktree-core.js";

const under = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith("/") ? dir : dir + "/");

/** The pin for a job created through host `hostId`, or why it cannot be made there. */
export function hostJobPin(
  hostId: string,
  workspaceId: string | null | undefined,
  cwd: string,
): { ok: true; host_id: string; cwd: string } | { ok: false; error: string } {
  const name = hosts.get(hostId)?.name ?? hostId;
  const where = `this terminal runs on ${name}, so its job runs there too`;
  if (!workspaceId) return { ok: false, error: `${where} — and a job from another computer needs a workspace` };
  if (!path.isAbsolute(cwd)) return { ok: false, error: `${where} — pass an absolute --cwd` };
  const dir = path.posix.normalize(cwd).replace(/\/+$/, "") || "/";
  const mine = new Set(repos.list(workspaceId).map((r) => r.id));
  const checkouts = repoCheckouts.forHost(hostId).filter((c) => mine.has(c.repo_id));
  if (checkouts.some((c) => under(dir, c.path) || under(dir, worktreeRootFor(c.path)))) return { ok: true, host_id: hostId, cwd: dir };
  const known = checkouts.map((c) => c.path);
  return {
    ok: false,
    error:
      `${where}, but ${dir} is not one of this workspace's checkouts on ${name} (or a worktree of one)` +
      (known.length ? ` — cd into one (${known.slice(0, 4).join(", ")}) or pass --cwd` : ` — ${name} has reported no checkout of this workspace's repos`),
  };
}
