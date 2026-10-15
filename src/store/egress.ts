import { db } from "./db.js";
import { now } from "./util.js";

// Per-workspace egress audit trail (every outbound host an agent's proxy saw, allow|deny).
export const egressLog = {
  add(e: { workspace_id?: string | null; host: string; port: number; action: "allow" | "deny"; ref?: string | null }): void {
    db.prepare(`INSERT INTO egress_log (ts,workspace_id,host,port,action,ref) VALUES (?,?,?,?,?,?)`)
      .run(now(), e.workspace_id ?? null, e.host, e.port, e.action, e.ref ?? null);
  },
  list(filter: { workspace_id?: string; action?: string; limit?: number } = {}): any[] {
    const where: string[] = [];
    const p: any = {};
    if (filter.workspace_id) { where.push("workspace_id = @workspace_id"); p.workspace_id = filter.workspace_id; }
    if (filter.action) { where.push("action = @action"); p.action = filter.action; }
    const lim = Math.min(Math.max(filter.limit ?? 200, 1), 2000);
    return db
      .prepare(`SELECT * FROM egress_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${lim}`)
      .all(p);
  },
  // Distinct hosts seen for a workspace with allow/deny counts (for an at-a-glance allowlist builder).
  hosts(workspaceId: string, limit = 100): any[] {
    return db
      .prepare(
        `SELECT host, MAX(port) AS port,
            SUM(action='allow') AS allowed, SUM(action='deny') AS denied, MAX(ts) AS last_ts
         FROM egress_log WHERE workspace_id = ? GROUP BY host ORDER BY last_ts DESC LIMIT ?`
      )
      .all(workspaceId, limit);
  },
  prune(cap: number): void {
    try {
      db.prepare(`DELETE FROM egress_log WHERE id NOT IN (SELECT id FROM egress_log ORDER BY id DESC LIMIT ?)`).run(cap);
    } catch {}
  },
};
