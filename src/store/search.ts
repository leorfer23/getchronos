import { db } from "./db.js";
import { now } from "./util.js";
import type { Job } from "../types.js";

// ───────────────────────────── full-text search (FTS5) ─────────────────────────────

function extractEventText(type: string, payload: any): string {
  if (type === "result") return typeof payload?.result === "string" ? payload.result : "";
  if (type === "assistant") {
    const blocks = payload?.message?.content ?? [];
    return (Array.isArray(blocks) ? blocks : [])
      .map((b: any) => (b.type === "text" ? b.text : b.type === "tool_use" ? `tool:${b.name}` : ""))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

const ftsTokens = (q: string) =>
  q.trim().split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, "")}"`);

// Turn a user query into a forgiving FTS5 MATCH expression (implicit AND of quoted tokens).
function ftsQuery(q: string): string {
  return ftsTokens(q).join(" ");
}

/**
 * The same tokens joined with OR — the fallback for a query that reads like a sentence.
 *
 * AND is the right default: it is what makes a two-word query precise. But an agent asks in prose
 * ("which branch do pull requests go to"), and ANDing eight tokens matches nothing even when the
 * answer is sitting in the vault — measured, on this index and on engram's: every long query
 * returned zero. So when AND finds nothing we widen to OR rather than answering "no memory", and
 * mark the hits `lax` so a caller can tell an exact match from a salvaged one.
 */
function ftsQueryAny(q: string): string {
  return ftsTokens(q).join(" OR ");
}

// Column weights for bm25(). search_fts indexes (title, body); the UNINDEXED columns that follow
// never match, and FTS5 defaults any weight we omit to 1.0. A title is a deliberate label written
// by the author, a body is prose that may mention the term in passing — so a title hit is worth
// several body hits. Weight borrowed from engram (MIT, Gentleman-Programming/engram), which uses
// 5.0/1.0 for the same reason; the value is a starting point calibrated on their corpus, not ours.
const BM25_TITLE_WEIGHT = 5.0;
const BM25_BODY_WEIGHT = 1.0;

const insertFts = db.prepare(
  "INSERT INTO search_fts (title,body,kind,ref_id,workspace,ts) VALUES (@title,@body,@kind,@ref_id,@workspace,@ts)"
);
const eventMeta = db.prepare(
  "SELECT j.workspace_id ws, j.name name FROM runs r JOIN jobs j ON j.id = r.job_id WHERE r.id = ?"
);

export interface SearchHit {
  kind: string;
  ref_id: string;
  workspace: string | null;
  title: string;
  snippet: string;
  ts: string;
  score: number;
  /** True when this hit came from the OR fallback: every token matched, but not all in one row. */
  lax?: boolean;
}

export const searchIndex = {
  add(row: { kind: string; ref_id: string; workspace: string | null; title: string; body: string; ts?: string }): void {
    if (!row.body?.trim() && !row.title?.trim()) return;
    insertFts.run({
      title: row.title ?? "",
      body: row.body ?? "",
      kind: row.kind,
      ref_id: row.ref_id,
      workspace: row.workspace ?? "",
      ts: row.ts ?? now(),
    });
  },
  removeRef(refId: string): void {
    db.prepare("DELETE FROM search_fts WHERE ref_id = ?").run(refId);
  },
  // Companion to events.prune(): once a run's events are pruned out of run_events, its indexed
  // 'event' rows here have nothing left to point at — drop them too, or search surfaces snippets
  // for a run whose actual event log is already gone.
  pruneOrphanEvents(): void {
    try {
      db.prepare(
        `DELETE FROM search_fts WHERE kind = 'event' AND ref_id NOT IN (SELECT DISTINCT run_id FROM run_events)`
      ).run();
    } catch {}
  },
  indexEvent(run_id: string, type: string, payload: unknown): void {
    if (type !== "assistant" && type !== "result") return;
    const body = extractEventText(type, payload);
    if (!body.trim()) return;
    const meta = eventMeta.get(run_id) as { ws: string | null; name: string } | undefined;
    this.add({
      kind: "event",
      ref_id: run_id,
      workspace: meta?.ws ?? "",
      title: meta?.name ?? "",
      body,
    });
  },
  indexJob(job: Job): void {
    this.add({
      kind: "job",
      ref_id: job.id,
      workspace: job.workspace_id ?? "",
      title: job.name,
      body: job.goal,
      ts: job.created_at,
    });
  },
  search(
    q: string,
    opts: { workspace?: string; kind?: string; since?: string; limit?: number } = {}
  ): SearchHit[] {
    if (!q.trim()) return [];
    const clauses = ["search_fts MATCH @q"];
    const params: any = { limit: opts.limit ?? 100 };
    if (opts.workspace) { clauses.push("workspace = @workspace"); params.workspace = opts.workspace; }
    if (opts.kind) { clauses.push("kind = @kind"); params.kind = opts.kind; }
    if (opts.since) { clauses.push("ts >= @since"); params.since = opts.since; }
    const stmt = db.prepare(
      `SELECT kind, ref_id, workspace, title, ts,
         snippet(search_fts, 1, '[', ']', '…', 12) AS snippet,
         bm25(search_fts, ${BM25_TITLE_WEIGHT}, ${BM25_BODY_WEIGHT}) AS score
       FROM search_fts WHERE ${clauses.join(" AND ")}
       ORDER BY score LIMIT @limit`
    );

    // A malformed MATCH expression is a thrown SqliteError, not an empty result. A user query is
    // arbitrary text, so treat "this query does not parse" as "no hits" rather than a 500.
    const run = (match: string): SearchHit[] => {
      try {
        return stmt.all({ ...params, q: match }) as SearchHit[];
      } catch {
        return [];
      }
    };

    let rows = run(ftsQuery(q));
    let lax = false;
    if (!rows.length) {
      const any = ftsQueryAny(q);
      // Single-token queries are identical in both forms — no point paying for the second query.
      if (any !== ftsQuery(q)) {
        rows = run(any);
        lax = rows.length > 0;
      }
    }

    // Collapse multiple event rows for the same run to its best-scoring hit.
    const best = new Map<string, SearchHit>();
    for (const r of rows) {
      const k = `${r.kind}:${r.ref_id}`;
      const prev = best.get(k);
      if (!prev || r.score < prev.score) best.set(k, lax ? { ...r, lax: true } : r);
    }
    return [...best.values()].sort((a, b) => a.score - b.score);
  },
  // One-time hydrate from existing run_events + jobs (skips if already populated).
  backfill(): void {
    const count = (db.prepare("SELECT COUNT(*) c FROM search_fts").get() as { c: number }).c;
    if (count > 0) return;
    const tx = db.transaction(() => {
      for (const j of db.prepare("SELECT * FROM jobs").all() as Job[]) this.indexJob(j);
      const evs = db
        .prepare("SELECT run_id, type, payload FROM run_events WHERE type IN ('assistant','result')")
        .all() as Array<{ run_id: string; type: string; payload: string }>;
      for (const e of evs) {
        try {
          this.indexEvent(e.run_id, e.type, JSON.parse(e.payload));
        } catch {}
      }
    });
    tx();
    const after = (db.prepare("SELECT COUNT(*) c FROM search_fts").get() as { c: number }).c;
    console.log(`[chronos] search index backfilled ${after} rows`);
  },
};
