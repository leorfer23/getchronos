import { db } from "./db.js";
import { now } from "./util.js";
import type { HostRow, RepoCheckout } from "../types.js";

// The computers that run agent processes for this brain (HOSTS.md). `local` is inserted by
// migration 134 and re-ensured at every boot; every other row is written by the host link
// (src/hostlink/registry.ts): a join inserts it, a hello refreshes it, the Desk edits it.
export const LOCAL_HOST_ID = "local";

/** The columns an update may set. `id` and `created_at` never change once a host exists. */
export type HostPatch = Partial<Omit<HostRow, "id" | "created_at">>;
const PATCHABLE = ["name", "platform", "status", "policy_json", "reserve_json", "token_hash", "cert_fp", "last_seen_at", "capabilities_json"] as const;

export const hosts = {
  list(): HostRow[] {
    // `local` first: it is the brain, and every surface that lists computers leads with it.
    return db.prepare("SELECT * FROM hosts ORDER BY (id = 'local') DESC, name ASC").all() as HostRow[];
  },
  get(id: string): HostRow | undefined {
    return db.prepare("SELECT * FROM hosts WHERE id = ?").get(id) as HostRow | undefined;
  },
  create(r: { id: string; name: string; platform?: string; status?: HostRow["status"]; token_hash?: string | null; cert_fp?: string | null; created_at?: string }): HostRow {
    db.prepare(
      `INSERT INTO hosts (id,name,platform,status,token_hash,cert_fp,created_at) VALUES (@id,@name,@platform,@status,@token_hash,@cert_fp,@created_at)`,
    ).run({
      id: r.id, name: r.name, platform: r.platform ?? "unknown", status: r.status ?? "offline",
      token_hash: r.token_hash ?? null, cert_fp: r.cert_fp ?? null, created_at: r.created_at ?? now(),
    });
    return this.get(r.id)!;
  },
  update(id: string, patch: HostPatch): HostRow | undefined {
    const keys = PATCHABLE.filter((k) => patch[k] !== undefined);
    if (keys.length) {
      const vals: Record<string, unknown> = { id };
      for (const k of keys) vals[k] = patch[k];
      db.prepare(`UPDATE hosts SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`).run(vals);
    }
    return this.get(id);
  },
  /** Live terminals per host, for the Desk's "3 terminals on m2". */
  liveSessionCounts(): Record<string, number> {
    const rows = db.prepare("SELECT host_id, COUNT(*) AS n FROM sessions WHERE status = 'live' GROUP BY host_id").all() as Array<{ host_id: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.host_id, r.n]));
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
  /**
   * A remote host's whole checkout list, as its latest hello reported it: rows it no longer
   * reports are gone. Never for `local`, whose rows mirror `repos.path` (store/repos.ts).
   */
  replaceForHost(hostId: string, rows: Array<{ repo_id: string; path: string }>): void {
    if (hostId === LOCAL_HOST_ID) throw new Error("the local checkouts mirror repos.path; they are not replaced from a hello");
    const at = now();
    db.transaction(() => {
      const keep = new Set(rows.map((r) => r.repo_id));
      for (const c of this.forHost(hostId)) if (!keep.has(c.repo_id)) this.remove(c.repo_id, hostId);
      for (const r of rows) this.upsert({ repo_id: r.repo_id, host_id: hostId, path: r.path, scanned_at: at });
    })();
  },
  remove(repoId: string, hostId: string): void {
    db.prepare("DELETE FROM repo_checkouts WHERE repo_id = ? AND host_id = ?").run(repoId, hostId);
  },
};
