import { db } from "./db.js";
import { now } from "./util.js";

/**
 * One use of a piece of workspace memory (migration 132, src/memory-usage.ts).
 *
 *  - `recall`           an `mc recall` query. `ref` is null; `hits` is how many came back.
 *  - `recall_hit`       one hit that query returned — `ref` is the note/skill/session/lesson id.
 *  - `memo_get`         an agent opened a memo in full (`mc memo get`).
 *  - `skill_view`       an agent opened a skill in full (`mc skill view`).
 *  - `relevance_inject` the relevance block put a memo/skill in front of a fresh agent unasked.
 *
 * Append-only and content-light: a recall query is kept (truncated) because the query IS the
 * evidence of what agents look for; nothing else stores text.
 */
export const MEMORY_USAGE_KINDS = ["recall", "recall_hit", "memo_get", "skill_view", "relevance_inject"] as const;
export type MemoryUsageKind = (typeof MEMORY_USAGE_KINDS)[number];
export type MemoryRefKind = "note" | "skill" | "session" | "lesson";

export interface MemoryUsageRow {
  id: number;
  workspace_id: string;
  kind: MemoryUsageKind;
  ref_kind: MemoryRefKind | null;
  ref: string | null;
  query: string | null;
  hits: number | null;
  /** Which door it came through: api (mc/HTTP), command (Telegram/desk command), dispatch, spawn. */
  source: string | null;
  session_id: string | null;
  ts: string;
}

export type NewMemoryUsage = Omit<MemoryUsageRow, "id" | "ts" | "ref_kind" | "ref" | "query" | "hits" | "source" | "session_id"> &
  Partial<Pick<MemoryUsageRow, "ref_kind" | "ref" | "query" | "hits" | "source" | "session_id" | "ts">>;

/** Per-ref roll-up — what the dream pass ranks and prunes on. */
export interface MemoryUsageAggregate {
  ref_kind: MemoryRefKind;
  ref: string;
  count: number;
  last_used: string;
  kinds: Partial<Record<MemoryUsageKind, number>>;
  sessions: number;
}

/** A recall query that came back empty — memory someone looked for and did not find. */
export interface MemoryUsageMiss {
  query: string;
  count: number;
  last_used: string;
}

export const QUERY_CAP = 200;

export const memoryUsage = {
  add(u: NewMemoryUsage): void {
    db.prepare(
      `INSERT INTO memory_usage (workspace_id, kind, ref_kind, ref, query, hits, source, session_id, ts)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      u.workspace_id, u.kind, u.ref_kind ?? null, u.ref ?? null,
      u.query == null ? null : u.query.slice(0, QUERY_CAP),
      u.hits ?? null, u.source ?? null, u.session_id ?? null, u.ts ?? now(),
    );
  },

  /** Several rows in one transaction — a recall writes its query plus one row per hit. */
  addMany(rows: NewMemoryUsage[]): void {
    if (!rows.length) return;
    db.transaction(() => { for (const r of rows) memoryUsage.add(r); })();
  },

  list(workspace_id: string, since = ""): MemoryUsageRow[] {
    return db.prepare("SELECT * FROM memory_usage WHERE workspace_id=? AND ts >= ? ORDER BY id")
      .all(workspace_id, since) as MemoryUsageRow[];
  },

  /** Per-ref counts for ONE workspace. Never unscoped: the wall holds in the query, not the caller. */
  aggregate(workspace_id: string, since = ""): MemoryUsageAggregate[] {
    if (!workspace_id) return [];
    const rows = db.prepare(
      `SELECT ref_kind, ref, kind, COUNT(*) n, MAX(ts) last_used
       FROM memory_usage
       WHERE workspace_id=? AND ts >= ? AND ref IS NOT NULL AND ref_kind IS NOT NULL
       GROUP BY ref_kind, ref, kind`,
    ).all(workspace_id, since) as { ref_kind: MemoryRefKind; ref: string; kind: MemoryUsageKind; n: number; last_used: string }[];
    // Distinct sessions per ref across kinds needs its own pass (a per-kind COUNT DISTINCT can't be summed).
    const sess = new Map(
      (db.prepare(
        `SELECT ref_kind, ref, COUNT(DISTINCT session_id) s FROM memory_usage
         WHERE workspace_id=? AND ts >= ? AND ref IS NOT NULL AND ref_kind IS NOT NULL GROUP BY ref_kind, ref`,
      ).all(workspace_id, since) as { ref_kind: string; ref: string; s: number }[]).map((r) => [`${r.ref_kind}\0${r.ref}`, r.s]),
    );
    const out = new Map<string, MemoryUsageAggregate>();
    for (const r of rows) {
      const key = `${r.ref_kind}\0${r.ref}`;
      const a = out.get(key) ?? { ref_kind: r.ref_kind, ref: r.ref, count: 0, last_used: r.last_used, kinds: {}, sessions: sess.get(key) ?? 0 };
      a.count += r.n;
      a.kinds[r.kind] = (a.kinds[r.kind] ?? 0) + r.n;
      if (r.last_used > a.last_used) a.last_used = r.last_used;
      out.set(key, a);
    }
    return [...out.values()].sort((a, b) => b.count - a.count || b.last_used.localeCompare(a.last_used));
  },

  /** Recall queries that found nothing, most asked first. */
  misses(workspace_id: string, since = "", limit = 20): MemoryUsageMiss[] {
    if (!workspace_id) return [];
    return db.prepare(
      `SELECT query, COUNT(*) count, MAX(ts) last_used FROM memory_usage
       WHERE workspace_id=? AND ts >= ? AND kind='recall' AND hits=0 AND query IS NOT NULL
       GROUP BY query ORDER BY count DESC, last_used DESC LIMIT ?`,
    ).all(workspace_id, since, limit) as MemoryUsageMiss[];
  },

  /** How many recall queries were asked (with or without hits). */
  recallCount(workspace_id: string, since = ""): number {
    return (db.prepare("SELECT COUNT(*) n FROM memory_usage WHERE workspace_id=? AND ts >= ? AND kind='recall'")
      .get(workspace_id, since) as { n: number }).n;
  },

  /** Retention: drop every row older than `before` (ISO). Returns rows removed. */
  pruneBefore(before: string): number {
    return db.prepare("DELETE FROM memory_usage WHERE ts < ?").run(before).changes;
  },
};
