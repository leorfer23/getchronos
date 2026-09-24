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
};
