import { randomUUID } from "node:crypto";
import { db } from "./db.js";

/**
 * Robert's run ledger: one row per wake-queue turn (src/wake-queue.ts drainScope), so "how many wakes
 * yesterday, how many said nothing, what did they cost" has an answer. Written for every ending:
 *  - posted  — he said something or took steps
 *  - quiet   — a sweep that came back QUIET
 *  - empty   — no words, no steps
 *  - dropped — Robert is off for the workspace; the wakes were acked unasked
 *  - failed  — the turn threw (`error` keeps why, capped)
 * Tokens and cost are what the engine reported for that turn, NULL when it reported none.
 */
export type RobertRunOutcome = "posted" | "quiet" | "empty" | "dropped" | "failed";
export const ROBERT_RUN_OUTCOMES: RobertRunOutcome[] = ["posted", "quiet", "empty", "dropped", "failed"];

export interface RobertRun {
  id: string;
  /** NULL = the default (fleet-wide) scope. */
  workspace_id: string | null;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  n_wakes: number;
  /** JSON arrays. */
  wake_keys: string;
  topics: string;
  model: string | null;
  engine: string | null;
  outcome: RobertRunOutcome;
  error: string | null;
  steps: number;
  reply_chars: number;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  cost_usd: number | null;
}

export interface NewRobertRun {
  workspace_id: string | null;
  started_at: string;
  ended_at: string;
  wakes: Array<{ key: string; topic: string }>;
  model?: string | null;
  engine?: string | null;
  outcome: RobertRunOutcome;
  error?: string | null;
  steps?: number;
  reply_chars?: number;
  tokens_in?: number | null;
  tokens_out?: number | null;
  tokens_cache_read?: number | null;
  tokens_cache_write?: number | null;
  cost_usd?: number | null;
}

export const RUN_ERROR_CAP = 500;

export interface RunTotals {
  runs: number;
  wakes: number;
  by_outcome: Record<RobertRunOutcome, number>;
  /** Sums over the runs that reported them; `metered` says how many did. */
  tokens: { in: number; out: number; cache_read: number; cache_write: number };
  metered: number;
  /** NULL when no run in the group reported a cost. */
  cost_usd: number | null;
}

export interface RunRollup extends RunTotals {
  by_workspace: Record<string, RunTotals>;
  /** Per wake topic: a run presenting several topics counts once under each. */
  by_topic: Record<string, { runs: number; wakes: number; by_outcome: Record<RobertRunOutcome, number> }>;
}

const outcomes = (): Record<RobertRunOutcome, number> => ({ posted: 0, quiet: 0, empty: 0, dropped: 0, failed: 0 });
const totals = (): RunTotals => ({ runs: 0, wakes: 0, by_outcome: outcomes(), tokens: { in: 0, out: 0, cache_read: 0, cache_write: 0 }, metered: 0, cost_usd: null });

function add(t: RunTotals, r: RobertRun): void {
  t.runs++;
  t.wakes += r.n_wakes;
  if (r.outcome in t.by_outcome) t.by_outcome[r.outcome]++;
  if (r.tokens_in != null || r.tokens_out != null) t.metered++;
  t.tokens.in += r.tokens_in ?? 0;
  t.tokens.out += r.tokens_out ?? 0;
  t.tokens.cache_read += r.tokens_cache_read ?? 0;
  t.tokens.cache_write += r.tokens_cache_write ?? 0;
  if (r.cost_usd != null) t.cost_usd = (t.cost_usd ?? 0) + r.cost_usd;
}

function topicsOf(r: RobertRun): string[] {
  try {
    const v = JSON.parse(r.topics);
    return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string"))] : [];
  } catch {
    return [];
  }
}

/** Pure: the window's totals, per workspace ("default" = the fleet-wide scope) and per topic. */
export function rollupRuns(rows: RobertRun[]): RunRollup {
  const out: RunRollup = { ...totals(), by_workspace: {}, by_topic: {} };
  for (const r of rows) {
    add(out, r);
    add((out.by_workspace[r.workspace_id ?? "default"] ??= totals()), r);
    for (const t of topicsOf(r)) {
      const g = (out.by_topic[t] ??= { runs: 0, wakes: 0, by_outcome: outcomes() });
      g.runs++;
      g.wakes += r.n_wakes;
      if (r.outcome in g.by_outcome) g.by_outcome[r.outcome]++;
    }
  }
  return out;
}

export const robertRuns = {
  record(r: NewRobertRun): RobertRun {
    const row: RobertRun = {
      id: randomUUID(),
      workspace_id: r.workspace_id,
      started_at: r.started_at,
      ended_at: r.ended_at,
      duration_ms: Math.max(0, Date.parse(r.ended_at) - Date.parse(r.started_at)) || 0,
      n_wakes: r.wakes.length,
      wake_keys: JSON.stringify(r.wakes.map((w) => w.key)),
      topics: JSON.stringify(r.wakes.map((w) => w.topic)),
      model: r.model ?? null,
      engine: r.engine ?? null,
      outcome: r.outcome,
      error: r.error == null ? null : String(r.error).slice(0, RUN_ERROR_CAP),
      steps: r.steps ?? 0,
      reply_chars: r.reply_chars ?? 0,
      tokens_in: r.tokens_in ?? null,
      tokens_out: r.tokens_out ?? null,
      tokens_cache_read: r.tokens_cache_read ?? null,
      tokens_cache_write: r.tokens_cache_write ?? null,
      cost_usd: r.cost_usd ?? null,
    };
    db.prepare(
      `INSERT INTO robert_runs (id,workspace_id,started_at,ended_at,duration_ms,n_wakes,wake_keys,topics,model,engine,
        outcome,error,steps,reply_chars,tokens_in,tokens_out,tokens_cache_read,tokens_cache_write,cost_usd)
       VALUES (@id,@workspace_id,@started_at,@ended_at,@duration_ms,@n_wakes,@wake_keys,@topics,@model,@engine,
        @outcome,@error,@steps,@reply_chars,@tokens_in,@tokens_out,@tokens_cache_read,@tokens_cache_write,@cost_usd)`,
    ).run(row);
    return row;
  },

  /**
   * Newest first. `workspace_id`: undefined = every scope, null = only the default scope, an id = that
   * workspace only. `limit` 0 = no cap (the rollup reads the whole window).
   */
  list(f: { since?: string; workspace_id?: string | null; limit?: number } = {}): RobertRun[] {
    const where: string[] = [];
    const p: Record<string, unknown> = {};
    if (f.since) { where.push("started_at >= @since"); p.since = f.since; }
    if (f.workspace_id === null) where.push("workspace_id IS NULL");
    else if (f.workspace_id !== undefined) { where.push("workspace_id = @ws"); p.ws = f.workspace_id; }
    const lim = f.limit === 0 ? "" : ` LIMIT ${Math.min(Math.max(Math.trunc(f.limit ?? 200), 1), 5000)}`;
    return db
      .prepare(`SELECT * FROM robert_runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY started_at DESC${lim}`)
      .all(p) as RobertRun[];
  },

  // ~280 turns on a busy day: the monitor's retention sweep keeps the newest `cap` (src/monitor.ts).
  prune(cap: number): void {
    try {
      db.prepare("DELETE FROM robert_runs WHERE id NOT IN (SELECT id FROM robert_runs ORDER BY started_at DESC LIMIT ?)").run(cap);
    } catch {}
  },
};
