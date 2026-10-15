import fs from "node:fs";
import { repos, workspaces } from "./store.js";
import { mainCheckouts } from "./hostd/resolve.js";
import type { Repo } from "./types.js";

/**
 * The main checkouts of every repo shared INTO this workspace — to hand any sandbox built with
 * `isolationDenyDirs(ws)` as read-only dirs. That deny-list leaves a shared repo out (it is reachable
 * now), and under `guard` (allow-by-default) "not denied" would otherwise mean WRITABLE: the owner's
 * checkout must stay read-only to a borrower on every path, not just the ones that list repos.
 */
export function sharedInReadonly(workspaceId: string | null | undefined): string[] {
  if (!workspaceId) return [];
  return mainCheckouts(repos.sharedWith(workspaceId).map((r) => r.path).filter((p) => p && fs.existsSync(p)));
}

/** A repo shared INTO a workspace, as the API and the Desk show it: who owns it rides along. */
export type SharedRepoView = { id: string; name: string; path: string; git_remote: string | null; owner_id: string; owner_slug: string | null; owner_name: string | null };

export function sharedRepoViews(workspaceId: string): SharedRepoView[] {
  return repos.sharedWith(workspaceId).map((r: Repo) => {
    const owner = workspaces.get(r.workspace_id);
    return { id: r.id, name: r.name, path: r.path, git_remote: r.git_remote ?? null, owner_id: r.workspace_id, owner_slug: owner?.slug ?? null, owner_name: owner?.name ?? null };
  });
}

/**
 * The line an agent is told about repos shared into its workspace, or "" when there are none. Without
 * it the agent only sees its own workspace's repos and would never think to look at a path the sandbox
 * lets it reach. A terminal on another computer gets names only: the paths are the brain's.
 */
export function sharedReposBlock(workspaceId: string, o: { paths?: boolean } = {}): string {
  let list: SharedRepoView[];
  try {
    list = sharedRepoViews(workspaceId);
  } catch {
    return "";
  }
  if (!list.length) return "";
  const withPaths = o.paths !== false;
  const lines = list.map((r) => `- ${r.name} (shared from ${r.owner_name || r.owner_slug || "another workspace"})${withPaths && r.path ? `: ${r.path}` : ""}`);
  return [
    "## Repos shared into this workspace",
    "Another workspace owns these and shared them with you. You may read them and work in them exactly like your own repos: the main checkout is read-only, so claim a worktree first (`mc worktree <name>`) and work there.",
    ...lines,
  ].join("\n");
}
