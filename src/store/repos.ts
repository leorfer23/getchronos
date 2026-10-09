import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";
import { LOCAL_HOST_ID, repoCheckouts } from "./hosts.js";
import type { NewRepo, Repo } from "../types.js";

// `repos.path` is the brain's own checkout, and every caller keeps reading it. Its mirror in
// repo_checkouts (host 'local', HOSTS.md) is written here and only here, in the same transaction as
// the repo row, so the two cannot drift: a remote host's checkout is its own row, never this one.
const syncLocalCheckout = (repoId: string, p: string) =>
  repoCheckouts.upsert({ repo_id: repoId, host_id: LOCAL_HOST_ID, path: p });

export const repos = {
  list(workspaceId?: string): Repo[] {
    if (workspaceId)
      return db
        .prepare("SELECT * FROM repos WHERE workspace_id = ? ORDER BY name ASC")
        .all(workspaceId) as Repo[];
    return db.prepare("SELECT * FROM repos ORDER BY name ASC").all() as Repo[];
  },
  get(id: string): Repo | undefined {
    return db.prepare("SELECT * FROM repos WHERE id = ?").get(id) as Repo | undefined;
  },
  create(r: NewRepo): Repo {
    const id = randomUUID();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO repos (id,workspace_id,parent_id,name,path,git_remote,default_branch,delivery,done_criteria,verify_cmd,gate_cmds,risk_paths,human_gate,review_min_difficulty,post_merge_cmd,ideas_enabled,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id,
        r.workspace_id,
        r.parent_id ?? null,
        r.name,
        r.path,
        r.git_remote ?? null,
        r.default_branch ?? "main",
        r.delivery ?? "pr",
        r.done_criteria ?? null,
        r.verify_cmd ?? null,
        r.gate_cmds ?? null,
        r.risk_paths ?? null,
        r.human_gate ?? "always", // a new repo keeps the operator in the loop until they hand a lane over
        r.review_min_difficulty ?? null, // null = inherit the workspace's threshold
        r.post_merge_cmd ?? null,
        r.ideas_enabled === false ? 0 : 1,
        now(),
      );
      syncLocalCheckout(id, r.path);
    })();
    return this.get(id)!;
  },
  update(
    id: string,
    p: {
      name?: string;
      path?: string;
      git_remote?: string | null;
      default_branch?: string;
      delivery?: string;
      done_criteria?: string | null;
      verify_cmd?: string | null;
      gate_cmds?: string | null;
      risk_paths?: string | null;
      human_gate?: string;
      review_min_difficulty?: number | null;
      post_merge_cmd?: string | null;
      ideas_enabled?: boolean | number;
    },
  ): Repo | undefined {
    const sets: string[] = [];
    const vals: any = { id };
    for (const k of ["name", "path", "git_remote", "default_branch", "delivery", "done_criteria", "verify_cmd", "gate_cmds", "risk_paths", "human_gate", "review_min_difficulty", "post_merge_cmd"] as const)
      if (p[k] !== undefined) {
        sets.push(`${k}=@${k}`);
        vals[k] = p[k];
      }
    if (p.ideas_enabled !== undefined) {
      sets.push("ideas_enabled=@ideas_enabled");
      vals.ideas_enabled = p.ideas_enabled === false || p.ideas_enabled === 0 ? 0 : 1;
    }
    if (!sets.length) return this.get(id);
    db.transaction(() => {
      const changed = db.prepare(`UPDATE repos SET ${sets.join(", ")} WHERE id=@id`).run(vals).changes;
      if (changed && p.path !== undefined) syncLocalCheckout(id, p.path);
    })();
    return this.get(id);
  },
  remove(id: string): void {
    db.prepare("DELETE FROM repos WHERE id = ?").run(id);
  },

  // ── Sharing (migration 146). `list(ws)` stays OWNED only: everything that plans, files or lists a
  // workspace's own work reads that. `accessible(ws)` is for one question only — may this workspace's
  // agent touch this repo (sandbox grants, `mc worktree`, spawn cwd checks). A share widens access for
  // exactly the workspace named in the row and for no one else.

  /** Workspace ids this repo is shared with (never its owner). */
  sharesOf(repoId: string): string[] {
    return (
      db.prepare("SELECT workspace_id FROM repo_shares WHERE repo_id = ? ORDER BY created_at ASC").all(repoId) as Array<{ workspace_id: string }>
    ).map((r) => r.workspace_id);
  },
  /** Share `repoId` into `workspaceId`. Idempotent. Throws for an unknown repo or for its own owner. */
  share(repoId: string, workspaceId: string): void {
    const repo = this.get(repoId);
    if (!repo) throw new Error(`repo not found: ${repoId}`);
    if (repo.workspace_id === workspaceId) throw new Error("a repo cannot be shared with the workspace that owns it");
    db.prepare("INSERT OR IGNORE INTO repo_shares (repo_id, workspace_id, created_at) VALUES (?,?,?)").run(repoId, workspaceId, now());
  },
  /** Stop sharing. True when a share was removed. */
  unshare(repoId: string, workspaceId: string): boolean {
    return db.prepare("DELETE FROM repo_shares WHERE repo_id = ? AND workspace_id = ?").run(repoId, workspaceId).changes > 0;
  },
  /** Repos OTHER workspaces shared into this one. The owner's own rows never appear here. */
  sharedWith(workspaceId: string): Repo[] {
    return db
      .prepare(
        `SELECT r.* FROM repos r JOIN repo_shares s ON s.repo_id = r.id
         WHERE s.workspace_id = ? AND r.workspace_id != ? ORDER BY r.name ASC`,
      )
      .all(workspaceId, workspaceId) as Repo[];
  },
  /** Owned ∪ shared-in, deduped by id: every repo this workspace's agents may reach. */
  accessible(workspaceId: string): Repo[] {
    const out = new Map<string, Repo>();
    for (const r of [...this.list(workspaceId), ...this.sharedWith(workspaceId)]) if (!out.has(r.id)) out.set(r.id, r);
    return [...out.values()];
  },
  /** May `workspaceId` reach `repo` — its owner, or a workspace it was shared with. */
  canAccess(repo: Pick<Repo, "id" | "workspace_id">, workspaceId: string): boolean {
    if (repo.workspace_id === workspaceId) return true;
    return !!db.prepare("SELECT 1 FROM repo_shares WHERE repo_id = ? AND workspace_id = ?").get(repo.id, workspaceId);
  },
};
