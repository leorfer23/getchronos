/**
 * One honest spend ledger — headless runs + Desk terminals, without double-counting.
 *
 * Runs and sessions are disjoint surfaces (a headless job never writes a Desk session row, and a
 * Desk terminal never writes a run cost). Summing them is the real day; either alone under-reports.
 * Estimates (token-table arithmetic before the CLI writes cost-state, or for backends that never
 * report a dollar) travel labelled, never as metered facts. Budget enforcement in the dispatcher
 * stays runs-only — this module is visibility.
 */
import { db } from "./store/db.js";
import { runs, sessions } from "./store.js";

export type SpendWindow = {
  usd: number;
  tokens_in: number;
  tokens_out: number;
  cache_read?: number;
  cache_write?: number;
  count: number;
  priced: number;
  estimated: number;
  estimated_usd: number;
  unpriced: number;
};

export type CombinedSpend = {
  since: string;
  total_usd: number;
  tokens_in: number;
  tokens_out: number;
  runs: SpendWindow;
  sessions: SpendWindow;
  coverage: {
    /** Dollars from CLI / backend metered totals (runs + sessions not estimated). */
    priced_usd: number;
    /** Dollars from token-table estimates (Desk and/or headless backends without vendor cost). */
    estimated_usd: number;
    priced_runs: number;
    estimated_runs: number;
    priced_sessions: number;
    estimated_sessions: number;
    unpriced_runs: number;
    unpriced_sessions: number;
    unpriced_backends: string[];
  };
};

function runTokens(since: string, workspace_id?: string): { in: number; out: number; cache_read: number; cache_write: number } {
  if (workspace_id) {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(r.tokens_in),0) tin, COALESCE(SUM(r.tokens_out),0) tout,
                COALESCE(SUM(r.cache_read),0) cr, COALESCE(SUM(r.cache_write),0) cw
         FROM runs r JOIN jobs j ON j.id = r.job_id
         WHERE r.started_at >= ? AND j.workspace_id = ?`,
      )
      .get(since, workspace_id) as { tin: number; tout: number; cr: number; cw: number };
    return { in: row.tin, out: row.tout, cache_read: row.cr, cache_write: row.cw };
  }
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(tokens_in),0) tin, COALESCE(SUM(tokens_out),0) tout,
              COALESCE(SUM(cache_read),0) cr, COALESCE(SUM(cache_write),0) cw
       FROM runs WHERE started_at >= ?`,
    )
    .get(since) as { tin: number; tout: number; cr: number; cw: number };
  return { in: row.tin, out: row.tout, cache_read: row.cr, cache_write: row.cw };
}

function runWindow(since: string, workspace_id?: string): SpendWindow & {
  unpriced_backends: string[];
  priced_usd: number;
} {
  const tok = runTokens(since, workspace_id);
  const cov = runs.spendCoverageSince(since, workspace_id);
  return {
    usd: cov.usd,
    tokens_in: tok.in,
    tokens_out: tok.out,
    cache_read: tok.cache_read,
    cache_write: tok.cache_write,
    count: cov.priced + cov.estimated + cov.unpriced,
    priced: cov.priced,
    estimated: cov.estimated,
    estimated_usd: cov.estimated_usd,
    priced_usd: cov.priced_usd,
    unpriced: cov.unpriced,
    unpriced_backends: cov.unpriced_backends,
  };
}

/**
 * Combined spend since `since` (ISO). Optional workspace filter. Runs and sessions are summed once
 * each — never cross-attributed.
 */
export function combinedSpend(
  since: string,
  opts: { workspace_id?: string } = {},
): CombinedSpend {
  const run = runWindow(since, opts.workspace_id);
  const sess = sessions.spendSince(since, { workspace_id: opts.workspace_id });
  const sessionsWin: SpendWindow = {
    usd: sess.usd,
    tokens_in: sess.tokens_in,
    tokens_out: sess.tokens_out,
    cache_read: sess.cache_read,
    cache_write: sess.cache_write,
    count: sess.sessions,
    priced: sess.priced,
    estimated: sess.estimated,
    estimated_usd: sess.estimated_usd,
    unpriced: sess.unpriced,
  };
  return {
    since,
    total_usd: run.usd + sessionsWin.usd,
    tokens_in: run.tokens_in + sessionsWin.tokens_in,
    tokens_out: run.tokens_out + sessionsWin.tokens_out,
    runs: {
      usd: run.usd,
      tokens_in: run.tokens_in,
      tokens_out: run.tokens_out,
      cache_read: run.cache_read,
      cache_write: run.cache_write,
      count: run.count,
      priced: run.priced,
      estimated: run.estimated,
      estimated_usd: run.estimated_usd,
      unpriced: run.unpriced,
    },
    sessions: sessionsWin,
    coverage: {
      priced_usd: run.priced_usd + sess.priced_usd,
      estimated_usd: run.estimated_usd + sess.estimated_usd,
      priced_runs: run.priced,
      estimated_runs: run.estimated,
      priced_sessions: sess.priced,
      estimated_sessions: sess.estimated,
      unpriced_runs: run.unpriced,
      unpriced_sessions: sess.unpriced,
      unpriced_backends: run.unpriced_backends,
    },
  };
}

/** Today / last-N convenience used by /stats and fleet. */
export function spendToday(workspace_id?: string): CombinedSpend {
  return combinedSpend(new Date().toISOString().slice(0, 10), { workspace_id });
}

export function spendSinceDays(days: number, workspace_id?: string): CombinedSpend {
  return combinedSpend(new Date(Date.now() - days * 86_400_000).toISOString(), { workspace_id });
}

/** Per-workspace combined totals for the cost command / fleet strip. */
export function combinedByWorkspace(since: string): Array<{
  workspace_id: string;
  total_usd: number;
  runs_usd: number;
  sessions_usd: number;
  sessions_estimated_usd: number;
  runs: number;
  sessions: number;
}> {
  const runMap = new Map(runs.spentByWorkspace(since).map((r) => [r.workspace_id || "", r]));
  const sessMap = new Map(sessions.spentByWorkspace(since).map((r) => [r.workspace_id || "", r]));
  const ids = new Set([...runMap.keys(), ...sessMap.keys()]);
  const out = [];
  for (const id of ids) {
    const r = runMap.get(id);
    const s = sessMap.get(id);
    out.push({
      workspace_id: id,
      total_usd: (r?.cost ?? 0) + (s?.cost ?? 0),
      runs_usd: r?.cost ?? 0,
      sessions_usd: s?.cost ?? 0,
      sessions_estimated_usd: s?.estimated_usd ?? 0,
      runs: r?.runs ?? 0,
      sessions: s?.sessions ?? 0,
    });
  }
  return out.sort((a, b) => b.total_usd - a.total_usd);
}
