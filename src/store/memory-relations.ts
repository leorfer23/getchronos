import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";
import type { MemoryRelation, MemoryRelationVerb, NewMemoryRelation } from "../types.js";

/**
 * Shortest id prefix `resolveRef` will act on. A one- or two-character prefix would usually be
 * ambiguous anyway, but it would fail as a 409 — a confusing answer to what is really a typo.
 * Eight is what the CLI prints, so anything a user copies from it clears this comfortably.
 */
export const MIN_REF_PREFIX = 4;

export const memoryRelations = {
  list(
    filter: { workspace_id?: string; status?: string; relation?: MemoryRelationVerb; ref?: string; limit?: number } = {},
  ): MemoryRelation[] {
    const where: string[] = [];
    const vals: any = {};
    if (filter.workspace_id) { where.push("workspace_id = @workspace_id"); vals.workspace_id = filter.workspace_id; }
    if (filter.status) { where.push("status = @status"); vals.status = filter.status; }
    if (filter.relation) { where.push("relation = @relation"); vals.relation = filter.relation; }
    if (filter.ref) { where.push("(source_ref = @ref OR target_ref = @ref)"); vals.ref = filter.ref; }
    const sql =
      `SELECT * FROM memory_relations${where.length ? ` WHERE ${where.join(" AND ")}` : ""}` +
      ` ORDER BY confidence DESC, created_at DESC${filter.limit ? " LIMIT @limit" : ""}`;
    if (filter.limit) vals.limit = filter.limit;
    return db.prepare(sql).all(vals) as MemoryRelation[];
  },

  get(id: string): MemoryRelation | undefined {
    return db.prepare("SELECT * FROM memory_relations WHERE id = ?").get(id) as MemoryRelation | undefined;
  },

  /**
   * Resolve a relation from what a human actually has in front of them.
   *
   * Every surface prints the short form — `mc memory conflicts` lists eight characters — so a full
   * uuid is the one thing a caller is least likely to be holding. Accept either, and refuse to
   * guess when a prefix matches more than one row: settling the wrong contradiction silently is
   * worse than making someone type two more characters.
   *
   * Scoped to one workspace, so a prefix can never reach another client's memory, and ambiguity is
   * judged only among rows the caller can already see.
   */
  resolveRef(workspace_id: string, ref: string): { row?: MemoryRelation; ambiguous?: number } {
    const needle = ref.trim().toLowerCase();
    if (needle.length < MIN_REF_PREFIX) return {};
    const rows = db
      .prepare("SELECT * FROM memory_relations WHERE workspace_id = ? AND lower(id) LIKE ? || '%' LIMIT 2")
      .all(workspace_id, needle) as MemoryRelation[];
    if (!rows.length) return {};
    if (rows.length > 1) {
      // Only now is the exact count worth a query — it goes into the error the caller reads.
      const c = db
        .prepare("SELECT COUNT(*) c FROM memory_relations WHERE workspace_id = ? AND lower(id) LIKE ? || '%'")
        .get(workspace_id, needle) as { c: number };
      return { ambiguous: c.c };
    }
    return { row: rows[0] };
  },

  /**
   * Record one judged pair. Idempotent per (workspace, source_ref, target_ref): a pair already on
   * file is left as it is rather than re-judged, so re-running capture over the same vault is free
   * and never overwrites a verdict the operator already resolved.
   */
  record(r: NewMemoryRelation): MemoryRelation | undefined {
    const id = randomUUID();
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO memory_relations
           (id,workspace_id,source_kind,source_ref,source_text,target_kind,target_ref,target_text,
            relation,confidence,reason,judged_by,status,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        r.workspace_id,
        r.source_kind,
        r.source_ref,
        r.source_text,
        r.target_kind,
        r.target_ref,
        r.target_text,
        r.relation,
        r.confidence ?? null,
        r.reason ?? null,
        r.judged_by ?? null,
        r.status ?? "open",
        now(),
      );
    return info.changes ? this.get(id) : undefined;
  },

  /** True when this pair has already been judged — the cheap check before spending an LLM call. */
  judged(workspace_id: string, source_ref: string, target_ref: string): boolean {
    const row = db
      .prepare(
        `SELECT 1 FROM memory_relations
          WHERE workspace_id = ?
            AND ((source_ref = ? AND target_ref = ?) OR (source_ref = ? AND target_ref = ?))
          LIMIT 1`,
      )
      .get(workspace_id, source_ref, target_ref, target_ref, source_ref);
    return !!row;
  },

  resolve(id: string, status: "resolved" | "dismissed"): MemoryRelation | undefined {
    db.prepare("UPDATE memory_relations SET status=?, resolved_at=? WHERE id=?").run(status, now(), id);
    return this.get(id);
  },

  countOpen(workspace_id: string, relation: MemoryRelationVerb = "conflicts_with"): number {
    const row = db
      .prepare("SELECT COUNT(*) c FROM memory_relations WHERE workspace_id=? AND status='open' AND relation=?")
      .get(workspace_id, relation) as { c: number };
    return row.c;
  },

  remove(id: string): void {
    db.prepare("DELETE FROM memory_relations WHERE id = ?").run(id);
  },
};
