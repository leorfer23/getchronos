import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";
import type { Lesson, LessonState, NewLesson } from "../types.js";

export const lessons = {
  list(filter: { workspace_id?: string; repo_id?: string | null; state?: LessonState; topic?: string } = {}): Lesson[] {
    const where: string[] = [];
    const vals: any = {};
    if (filter.workspace_id) { where.push("workspace_id = @workspace_id"); vals.workspace_id = filter.workspace_id; }
    if (filter.state) { where.push("state = @state"); vals.state = filter.state; }
    if (filter.topic) { where.push("topic = @topic"); vals.topic = filter.topic; }
    if (filter.repo_id !== undefined) {
      if (filter.repo_id === null) where.push("repo_id IS NULL");
      else { where.push("(repo_id = @repo_id OR repo_id IS NULL)"); vals.repo_id = filter.repo_id; }
    }
    const sql = `SELECT * FROM lessons${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY hits DESC, created_at DESC`;
    return db.prepare(sql).all(vals) as Lesson[];
  },
  get(id: string): Lesson | undefined {
    return db.prepare("SELECT * FROM lessons WHERE id = ?").get(id) as Lesson | undefined;
  },
  create(l: NewLesson): Lesson {
    const id = randomUUID();
    const ts = now();
    db.prepare(
      `INSERT INTO lessons (id,workspace_id,repo_id,scope,topic,rule,source,source_ref,hits,state,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      l.workspace_id,
      l.repo_id ?? null,
      l.scope ?? null,
      l.topic ?? "build",
      l.rule,
      l.source ?? "operator",
      l.source_ref ?? null,
      0,
      l.state ?? "active",
      ts,
      ts,
    );
    return this.get(id)!;
  },
  update(id: string, p: { rule?: string; scope?: string | null; topic?: string; state?: LessonState; repo_id?: string | null }): Lesson | undefined {
    const sets: string[] = [];
    const vals: any = { id, updated_at: now() };
    for (const k of ["rule", "scope", "topic", "state", "repo_id"] as const)
      if (p[k] !== undefined) { sets.push(`${k}=@${k}`); vals[k] = p[k]; }
    if (!sets.length) return this.get(id);
    db.prepare(`UPDATE lessons SET ${sets.join(", ")}, updated_at=@updated_at WHERE id=@id`).run(vals);
    return this.get(id);
  },
  /** One injection = one hit. `last_fired` is what tells the hygiene sweep a rule is still live. */
  markFired(ids: string[]): void {
    if (!ids.length) return;
    const stmt = db.prepare("UPDATE lessons SET hits = hits + 1, last_fired = ? WHERE id = ?");
    const ts = now();
    db.transaction(() => { for (const id of ids) stmt.run(ts, id); })();
  },
  /** A proposed rule seen again: count the recurrence and promote it once it's no longer a one-off. */
  reinforce(id: string, promoteAt: number): Lesson | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const seen = cur.seen + 1;
    const state: LessonState = cur.state === "proposed" && seen >= promoteAt ? "active" : cur.state;
    db.prepare("UPDATE lessons SET seen=?, state=?, updated_at=? WHERE id=?").run(seen, state, now(), id);
    return this.get(id);
  },
  remove(id: string): void {
    db.prepare("DELETE FROM lessons WHERE id = ?").run(id);
  },
};
