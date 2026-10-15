// Prompt-cache health (qm's stableSystemBytes/isStablePrefixMiss idea, adapted to per-run totals).
// Chronos runs on subscription quota, so cache churn is real money: every ★context memo, lesson
// or skills-index block that shifts between API calls re-WRITES the whole prompt prefix (1.25x)
// instead of READING it (0.1x). The per-run read/write totals make that visible: a healthy long
// agentic run re-reads its prefix on every API call (read >> write); a run whose writes rival its
// reads is churning something that should be stable.

export interface CacheUsage {
  cache_read: number | null;
  cache_write: number | null;
  // Turns the run reported. A ONE-turn run writes its prefix and legitimately never reads it back —
  // that's a cold start, not churn — so single-turn runs are never flagged. Unknown (null) is
  // treated as multi-turn: better a rare false positive than silently missing real churn.
  num_turns?: number | null;
}

// Share of cached-prefix tokens served from cache. null = the backend reported nothing (non-claude
// backends, old rows) — unknown, not zero.
export function hitShare(u: CacheUsage): number | null {
  const read = u.cache_read ?? 0;
  const write = u.cache_write ?? 0;
  if (u.cache_read == null && u.cache_write == null) return null;
  if (read + write === 0) return null;
  return read / (read + write);
}

// A run whose prompt prefix churned: it wrote a lot of cache and read comparatively little back.
// Two guards keep cold starts out: a single-turn run never counts (one API call writes the prefix
// and has nothing to read it back), and a big prefix on a short run stays under minWrite. A long
// healthy run's reads dwarf its one initial write, so readShare clears easily. Deliberately
// conservative — flag only clear churn.
export function isStablePrefixMiss(
  u: CacheUsage,
  opts: { minWrite?: number; maxReadShare?: number } = {},
): boolean {
  const minWrite = opts.minWrite ?? 50_000;
  const maxReadShare = opts.maxReadShare ?? 0.5;
  if (u.num_turns != null && u.num_turns <= 1) return false;
  const write = u.cache_write ?? 0;
  if (write < minWrite) return false;
  const share = hitShare(u);
  return share !== null && share <= maxReadShare;
}

// Aggregate for /api/stats: fleet totals + how many runs look like prefix churn.
export function cacheStats(rows: CacheUsage[]): {
  read: number;
  write: number;
  hit_share: number | null;
  prefix_miss_runs: number;
} {
  let read = 0;
  let write = 0;
  let miss = 0;
  let any = false;
  for (const r of rows) {
    if (r.cache_read == null && r.cache_write == null) continue;
    any = true;
    read += r.cache_read ?? 0;
    write += r.cache_write ?? 0;
    if (isStablePrefixMiss(r)) miss++;
  }
  return {
    read,
    write,
    hit_share: any && read + write > 0 ? read / (read + write) : null,
    prefix_miss_runs: miss,
  };
}
