import { db } from "./db.js";
import { now } from "./util.js";

// Durable trail of every bus event — the queryable decision log for a 24/7 autonomous system.
export const activity = {
  add(a: { topic: string; actor: string; workspace_id?: string | null; entity?: string | null; detail?: string | null }): void {
    db.prepare(`INSERT INTO activity (ts,topic,actor,workspace_id,entity,detail) VALUES (?,?,?,?,?,?)`)
      .run(now(), a.topic, a.actor, a.workspace_id ?? null, a.entity ?? null, a.detail ?? null);
  },
  list(f: { workspace_id?: string; topic?: string; actor?: string; entity?: string; limit?: number } = {}): any[] {
    const where: string[] = [];
    const p: any = {};
    if (f.workspace_id) { where.push("workspace_id = @workspace_id"); p.workspace_id = f.workspace_id; }
    if (f.topic) { where.push("topic = @topic"); p.topic = f.topic; }
    if (f.actor) { where.push("actor = @actor"); p.actor = f.actor; }
    if (f.entity) { where.push("entity = @entity"); p.entity = f.entity; }
    const lim = Math.min(Math.max(f.limit ?? 100, 1), 1000);
    return db
      .prepare(`SELECT * FROM activity ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${lim}`)
      .all(p);
  },
  prune(cap: number): void {
    // ponytail: full DELETE…NOT IN on every insert — fine at this cap + event rate (run.event excluded).
    try {
      db.prepare(`DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT ?)`).run(cap);
    } catch {}
  },
};
