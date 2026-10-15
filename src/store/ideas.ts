import { db } from "./db.js";
import { now } from "./util.js";
import type { Idea } from "../types.js";

// Idea Pool — proposed cards awaiting promote/kill. Soft decisions only (rows stay for promote-rate stats).
export const ideas = {
  list(filter: { workspace_id?: string; status?: string } = {}): Idea[] {
    const where: string[] = [];
    const p: any = {};
    if (filter.workspace_id) { where.push("workspace_id=@workspace_id"); p.workspace_id = filter.workspace_id; }
    if (filter.status) { where.push("status=@status"); p.status = filter.status; }
    return db.prepare(
      `SELECT * FROM ideas ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC`
    ).all(p) as Idea[];
  },
  get(id: string): Idea | undefined {
    return db.prepare("SELECT * FROM ideas WHERE id = ?").get(id) as Idea | undefined;
  },
  insert(row: Idea): Idea {
    db.prepare(
      `INSERT INTO ideas (id,workspace_id,repo_id,title,pitch,acceptance,kind,source,source_ref,status,model,promoted_ticket_id,created_at,decided_at)
       VALUES (@id,@workspace_id,@repo_id,@title,@pitch,@acceptance,@kind,@source,@source_ref,@status,@model,@promoted_ticket_id,@created_at,@decided_at)`
      // Default the columns added after this writer shipped: better-sqlite3 throws on a missing
      // named parameter, so a caller built against the older Idea shape would fail at runtime.
    ).run({ ...row, acceptance: row.acceptance ?? null });
    return this.get(row.id)!;
  },
  decide(id: string, p: { status: string; promoted_ticket_id?: string | null }): Idea | undefined {
    db.prepare(
      `UPDATE ideas SET status=@status, promoted_ticket_id=COALESCE(@promoted_ticket_id, promoted_ticket_id), decided_at=@decided_at WHERE id=@id`
    ).run({
      id,
      status: p.status,
      promoted_ticket_id: p.promoted_ticket_id ?? null,
      decided_at: now(),
    });
    return this.get(id);
  },
  // Flip proposed ideas older than `days` to expired. Cheap idempotent UPDATE for the monitor tick.
  expireOld(days = 14): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const r = db.prepare(
      `UPDATE ideas SET status='expired', decided_at=? WHERE status='proposed' AND created_at < ?`
    ).run(now(), cutoff);
    return r.changes;
  },
  stats(workspace_id: string): Array<{ source: string; kind: string; total: number; promoted: number; killed: number }> {
    return db.prepare(
      `SELECT source, kind, COUNT(*) AS total,
              SUM(CASE WHEN status='promoted' THEN 1 ELSE 0 END) AS promoted,
              SUM(CASE WHEN status='killed' THEN 1 ELSE 0 END) AS killed
       FROM ideas WHERE workspace_id=? AND status!='proposed'
       GROUP BY source, kind`
    ).all(workspace_id) as Array<{ source: string; kind: string; total: number; promoted: number; killed: number }>;
  },
};
