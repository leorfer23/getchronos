import fs from "node:fs";
import { repos, tickets } from "./store.js";
import type { Job, Repo } from "./types.js";

/**
 * The repo a job works in: its ticket's, else the registered repo whose root `job.cwd` sits in
 * (exact, or a worktree living under it). Jobs carry no repo_id directly. Shared by dispatch's
 * cursor-cloud gate and executeCloud's launch so the two can't disagree — a ticketless Desk cloud
 * terminal (src/desk-cloud.ts) used to pass the gate on the cwd match and then fail at launch,
 * which only looked at the ticket.
 *
 * job.cwd was realpath'd by sanitizeCwd() at job creation (spawn-guard.ts checkCwd); a repo's own
 * `path` column usually was NOT (it is whatever the operator typed when the repo was registered).
 * A comparison without realpath'ing both sides misses every repo living behind a symlinked parent
 * (macOS's /tmp -> /private/tmp, /var -> /private/var) — resolve each candidate the same way
 * allowedRoots() does, and skip one that no longer exists on disk rather than throw.
 */
export function jobRepo(job: Pick<Job, "ticket_id" | "cwd" | "workspace_id">): Repo | undefined {
  const realpath = (p: string): string | null => { try { return fs.realpathSync(p); } catch { return null; } };
  const ticket = job.ticket_id ? tickets.get(job.ticket_id) : undefined;
  if (ticket?.repo_id) {
    const r = repos.get(ticket.repo_id);
    if (r) return r;
  }
  const cwd = job.cwd;
  if (!cwd) return undefined;
  return repos
    .list(job.workspace_id ?? undefined)
    .map((r) => ({ r, real: r.path ? realpath(r.path) : null }))
    .filter((x): x is { r: Repo; real: string } => x.real !== null && (cwd === x.real || cwd.startsWith(x.real + "/")))
    .sort((a, b) => b.real.length - a.real.length)[0]?.r;
}
