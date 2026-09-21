import { db } from "./db.js";
import { now } from "./util.js";

// History of connector (clickup/jira) syncs — one row per syncWorkspace call, success or error.
export const connectorSyncs = {
  add(s: { workspace_id?: string | null; connector: string; pulled: number; created: number; updated: number; pushed: number; error?: string | null }): void {
    db.prepare(`INSERT INTO connector_syncs (ts,workspace_id,connector,pulled,created,updated,pushed,error) VALUES (?,?,?,?,?,?,?,?)`)
      .run(now(), s.workspace_id ?? null, s.connector, s.pulled, s.created, s.updated, s.pushed, s.error ?? null);
  },
  // Newest sync row per workspace, keyed by workspace_id (for the /workspaces last-sync surface).
  latestByWorkspace(): Record<string, any> {
    const rows = db
      .prepare(
        `SELECT c.* FROM connector_syncs c
         JOIN (SELECT workspace_id, MAX(id) mid FROM connector_syncs GROUP BY workspace_id) m ON m.mid = c.id`
      )
      .all() as any[];
    return Object.fromEntries(rows.map((r) => [r.workspace_id, r]));
  },
  prune(cap: number): void {
    try {
      db.prepare(`DELETE FROM connector_syncs WHERE id NOT IN (SELECT id FROM connector_syncs ORDER BY id DESC LIMIT ?)`).run(cap);
    } catch {}
  },
};
