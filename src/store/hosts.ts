import { db } from "./db.js";
import type { HostRow, RepoCheckout } from "../types.js";

// The computers that run agent processes for this brain (HOSTS.md). Phase 1 has exactly one row,
// `local`, inserted by migration 134 and re-ensured at every boot; joining, status and policy
// arrive with the `chronos host` process in phase 2. Read-mostly until then.
export const LOCAL_HOST_ID = "local";

export const hosts = {
  list(): HostRow[] {
    // `local` first: it is the brain, and every surface that lists computers leads with it.
    return db.prepare("SELECT * FROM hosts ORDER BY (id = 'local') DESC, name ASC").all() as HostRow[];
  },
  get(id: string): HostRow | undefined {
    return db.prepare("SELECT * FROM hosts WHERE id = ?").get(id) as HostRow | undefined;
  },
};

// Where each repo lives on each host. The `local` row mirrors `repos.path` and is written only by
// store/repos.ts, so the two can never disagree: nothing else should set a local checkout directly.
export const repoCheckouts = {
  get(repoId: string, hostId: string): RepoCheckout | undefined {
    return db
      .prepare("SELECT * FROM repo_checkouts WHERE repo_id = ? AND host_id = ?")
      .get(repoId, hostId) as RepoCheckout | undefined;
  },
  forRepo(repoId: string): RepoCheckout[] {
    return db
      .prepare("SELECT * FROM repo_checkouts WHERE repo_id = ? ORDER BY (host_id = 'local') DESC, host_id ASC")
      .all(repoId) as RepoCheckout[];
  },
  forHost(hostId: string): RepoCheckout[] {
    return db.prepare("SELECT * FROM repo_checkouts WHERE host_id = ?").all(hostId) as RepoCheckout[];
  },
  // A path the brain was TOLD, not one a scan found: `head`/`scanned_at` are kept only while the
  // path stays the same. A checkout that moved is a checkout nobody has looked at yet.
  upsert(c: { repo_id: string; host_id: string; path: string; head?: string | null; scanned_at?: string | null }): RepoCheckout {
    db.prepare(
      `INSERT INTO repo_checkouts (repo_id,host_id,path,head,scanned_at) VALUES (@repo_id,@host_id,@path,@head,@scanned_at)
       ON CONFLICT(repo_id,host_id) DO UPDATE SET
         head = CASE WHEN repo_checkouts.path = excluded.path THEN COALESCE(excluded.head, repo_checkouts.head) ELSE excluded.head END,
         scanned_at = CASE WHEN repo_checkouts.path = excluded.path THEN COALESCE(excluded.scanned_at, repo_checkouts.scanned_at) ELSE excluded.scanned_at END,
         path = excluded.path`,
    ).run({ repo_id: c.repo_id, host_id: c.host_id, path: c.path, head: c.head ?? null, scanned_at: c.scanned_at ?? null });
    return this.get(c.repo_id, c.host_id)!;
  },
  remove(repoId: string, hostId: string): void {
    db.prepare("DELETE FROM repo_checkouts WHERE repo_id = ? AND host_id = ?").run(repoId, hostId);
  },
};
