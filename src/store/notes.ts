import { db } from "./db.js";
import type { Note } from "../types.js";

// repo_ids is a JSON TEXT column in SQLite; hydrate it to a string[] (or null) on every read so the
// rest of the app only ever sees arrays.
function hydrate<T extends { repo_ids?: unknown } | undefined>(row: T): T {
  if (!row) return row;
  const raw = (row as any).repo_ids;
  if (raw == null || raw === "") { (row as any).repo_ids = null; return row; }
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    (row as any).repo_ids = Array.isArray(arr) && arr.length ? arr : null;
  } catch { (row as any).repo_ids = null; }
  return row;
}
const serializeRepoIds = (ids?: string[] | null): string | null =>
  ids && ids.length ? JSON.stringify(ids) : null;

export const notes = {
  list(workspace_id?: string): Note[] {
    const sql = "SELECT * FROM notes" + (workspace_id ? " WHERE workspace_id = ?" : "") +
      " ORDER BY pinned DESC, updated_at DESC";
    const rows = (workspace_id ? db.prepare(sql).all(workspace_id) : db.prepare(sql).all()) as Note[];
    return rows.map((r) => hydrate(r));
  },
  get(id: string): Note | undefined {
    return hydrate(db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as Note | undefined);
  },
  bySlug(workspace_id: string, slug: string): Note | undefined {
    return hydrate(db.prepare("SELECT * FROM notes WHERE workspace_id = ? AND slug = ?").get(workspace_id, slug) as Note | undefined);
  },
  // Notes flagged to auto-seed into every agent's system prompt for this workspace (operator-curated).
  contextNotes(workspace_id: string): Note[] {
    return (db.prepare("SELECT * FROM notes WHERE workspace_id = ? AND context = 1 ORDER BY pinned DESC, slug").all(workspace_id) as Note[]).map((r) => hydrate(r));
  },
  // Operator-profile notes (scope='global', context-flagged) — auto-injected into EVERY workspace's
  // agents regardless of home workspace. Deliberately not workspace-scoped.
  globalContextNotes(): Note[] {
    return (db.prepare("SELECT * FROM notes WHERE scope = 'global' AND context = 1 ORDER BY pinned DESC, slug").all() as Note[]).map((r) => hydrate(r));
  },
  insert(n: Note): Note {
    db.prepare(
      `INSERT INTO notes (id,workspace_id,title,slug,file_path,body,pinned,context,scope,repo_ids,created_at,updated_at)
       VALUES (@id,@workspace_id,@title,@slug,@file_path,@body,@pinned,@context,@scope,@repo_ids,@created_at,@updated_at)`
    ).run({ ...n, repo_ids: serializeRepoIds(n.repo_ids) });
    return this.get(n.id)!;
  },
  update(id: string, p: { title?: string; body?: string; pinned?: number; context?: number; scope?: string; repo_ids?: string[] | null; updated_at: string }) {
    const sets: string[] = ["updated_at=@updated_at"];
    if (p.title != null) sets.push("title=@title");
    if (p.body != null) sets.push("body=@body");
    if (p.pinned != null) sets.push("pinned=@pinned");
    if (p.context != null) sets.push("context=@context");
    if (p.scope != null) sets.push("scope=@scope");
    // repo_ids: undefined = leave as-is; null = clear (back to workspace-wide); array = set.
    if (p.repo_ids !== undefined) sets.push("repo_ids=@repo_ids");
    db.prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id=@id`).run({
      id, ...p, repo_ids: p.repo_ids === undefined ? undefined : serializeRepoIds(p.repo_ids),
    });
    return this.get(id);
  },
  remove(id: string) {
    db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  },
};
