import { db } from "./db.js";
import { now } from "./util.js";
import type { Skill } from "../types.js";

export const skills = {
  list(filter: { workspace_id?: string; status?: string } = {}): Skill[] {
    const where: string[] = [];
    const p: any = {};
    if (filter.workspace_id) { where.push("workspace_id=@workspace_id"); p.workspace_id = filter.workspace_id; }
    if (filter.status) { where.push("status=@status"); p.status = filter.status; }
    return db.prepare(`SELECT * FROM skills ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY usage_count DESC, name ASC`).all(p) as Skill[];
  },
  get(id: string): Skill | undefined {
    return db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as Skill | undefined;
  },
  bySlug(workspace_id: string, slug: string): Skill | undefined {
    return db.prepare("SELECT * FROM skills WHERE workspace_id = ? AND slug = ?").get(workspace_id, slug) as Skill | undefined;
  },
  // L0 progressive-disclosure index: just the active skills' name/desc/category for one workspace.
  active(workspace_id: string): Skill[] {
    return db.prepare("SELECT * FROM skills WHERE workspace_id = ? AND status = 'active' ORDER BY usage_count DESC, name ASC").all(workspace_id) as Skill[];
  },
  insert(s: Skill): Skill {
    db.prepare(
      `INSERT INTO skills (id,workspace_id,slug,name,description,category,tags,status,version,usage_count,last_used_at,file_path,source,created_at,updated_at)
       VALUES (@id,@workspace_id,@slug,@name,@description,@category,@tags,@status,@version,@usage_count,@last_used_at,@file_path,@source,@created_at,@updated_at)`
    ).run(s);
    return this.get(s.id)!;
  },
  update(id: string, p: Partial<Skill> & { updated_at: string }) {
    const cols = ["name", "description", "category", "tags", "status", "version", "usage_count", "last_used_at", "file_path"] as const;
    const sets: string[] = ["updated_at=@updated_at"];
    for (const c of cols) if ((p as any)[c] !== undefined) sets.push(`${c}=@${c}`);
    db.prepare(`UPDATE skills SET ${sets.join(", ")} WHERE id=@id`).run({ id, ...p });
    return this.get(id);
  },
  bumpUsage(id: string) {
    db.prepare("UPDATE skills SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?").run(now(), id);
  },
  remove(id: string) {
    db.prepare("DELETE FROM skills WHERE id = ?").run(id);
  },
};
