import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";
import { repos } from "./repos.js";
import type { AcceleratorTool, RepoAccelerator } from "../types.js";

export const ACCELERATOR_TOOLS: AcceleratorTool[] = ["graphify", "ast-grep", "repomix"];

export function isAcceleratorTool(v: string): v is AcceleratorTool {
  return (ACCELERATOR_TOOLS as string[]).includes(v);
}

export const repoAccelerators = {
  /** Every tool row a repo has ever touched — a repo with no rows has never enabled anything. */
  listByRepo(repoId: string): RepoAccelerator[] {
    return db.prepare("SELECT * FROM repo_accelerators WHERE repo_id=? ORDER BY tool")
      .all(repoId) as RepoAccelerator[];
  },
  /** For dashboards/audits — never used to gate a single repo's own request (use listByRepo). */
  listByWorkspace(workspaceId: string): RepoAccelerator[] {
    return db.prepare("SELECT * FROM repo_accelerators WHERE workspace_id=? ORDER BY repo_id, tool")
      .all(workspaceId) as RepoAccelerator[];
  },
  get(repoId: string, tool: AcceleratorTool): RepoAccelerator | undefined {
    return db.prepare("SELECT * FROM repo_accelerators WHERE repo_id=? AND tool=?")
      .get(repoId, tool) as RepoAccelerator | undefined;
  },
  /**
   * Upsert by (repo, tool) — flipping the switch never grows a history, it just moves one row.
   * `mode` omitted leaves the current mode alone; passed (including null) replaces it.
   *
   * Verifies (workspaceId, repoId) against the repos table itself on every call, not just against a
   * previously-stored row — the API route always derives workspaceId from the repo it just looked
   * up, so this can't fire through it, but any other caller passing a mismatched pair (copy-paste of
   * the wrong id, a future cross-workspace bug) gets a thrown error instead of a row that lets one
   * workspace's accelerator live under another's id.
   */
  setEnabled(
    workspaceId: string,
    repoId: string,
    tool: AcceleratorTool,
    enabled: boolean,
    mode?: string | null,
  ): RepoAccelerator {
    const repo = repos.get(repoId);
    if (!repo || repo.workspace_id !== workspaceId) {
      throw new Error(`repo ${repoId} does not belong to workspace ${workspaceId}`);
    }
    const cur = repoAccelerators.get(repoId, tool);
    const ts = now();
    if (cur) {
      const nextMode = mode !== undefined ? mode : cur.mode;
      db.prepare("UPDATE repo_accelerators SET enabled=?, mode=?, updated_at=? WHERE id=?")
        .run(enabled ? 1 : 0, nextMode, ts, cur.id);
      return repoAccelerators.get(repoId, tool)!;
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO repo_accelerators (id,workspace_id,repo_id,tool,enabled,mode,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(id, workspaceId, repoId, tool, enabled ? 1 : 0, mode ?? null, ts, ts);
    return repoAccelerators.get(repoId, tool)!;
  },
  remove(repoId: string, tool: AcceleratorTool): void {
    db.prepare("DELETE FROM repo_accelerators WHERE repo_id=? AND tool=?").run(repoId, tool);
  },
};
