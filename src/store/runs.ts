import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import type { Run, RunStatus } from "../types.js";

export const runs = {
  create(job_id: string, trigger_src: string, attempt = 1): Run {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO runs (id,job_id,status,trigger_src,attempt) VALUES (?,?,?,?,?)"
    ).run(id, job_id, "queued", trigger_src, attempt);
    return this.get(id)!;
  },
  get(id: string): Run | undefined {
    return db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Run | undefined;
  },
  // Live runs on a ticket, newest first, with the job name so callers can exclude read-only runs.
  // Used by mc tell's live-steer delivery to find the build run a ticket-scoped message should
  // reach right now (the mailbox row stays the durable path either way).
  runningForTicket(ticketId: string): Array<Run & { job_name: string }> {
    return db
      .prepare(
        `SELECT r.*, j.name AS job_name FROM runs r JOIN jobs j ON j.id = r.job_id
         WHERE j.ticket_id = ? AND r.status = 'running' ORDER BY r.rowid DESC`
      )
      .all(ticketId) as Array<Run & { job_name: string }>;
  },
  // The latest run that owned a session — how a resume dispatch finds the prior run whose event
  // log to replay when the backend can't reopen the session natively (see replay.ts).
  bySession(sessionId: string): Run | undefined {
    return db
      .prepare("SELECT * FROM runs WHERE session_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(sessionId) as Run | undefined;
  },
  /** Resolve a short id prefix (id8) to at most one run — used by lifecycle / recovery. */
  findByIdPrefix(prefix: string): Run | undefined {
    const p = prefix.trim();
    if (p.length < 6) return undefined;
    const rows = db
      .prepare("SELECT * FROM runs WHERE id LIKE ? ORDER BY rowid DESC LIMIT 2")
      .all(`${p}%`) as Run[];
    return rows.length === 1 ? rows[0] : rows.find((r) => r.id.startsWith(p));
  },
  latestForTicket(ticketId: string): Run | undefined {
    return db
      .prepare(
        "SELECT r.* FROM runs r JOIN jobs j ON r.job_id = j.id WHERE j.ticket_id = ? ORDER BY r.rowid DESC LIMIT 1"
      )
      .get(ticketId) as Run | undefined;
  },
  // Is a job whose name starts with `prefix` (e.g. "grade:") currently in flight for this ticket?
  // Lets the build pump hold a ticket until its k3 grading pass finishes.
  hasActiveJob(ticketId: string, prefix: string): boolean {
    return !!db
      .prepare(
        "SELECT 1 FROM runs r JOIN jobs j ON r.job_id = j.id WHERE j.ticket_id = ? AND j.name LIKE ? AND r.status IN ('running','queued') LIMIT 1"
      )
      .get(ticketId, `${prefix}%`);
  },
  // Exact job name (unlike hasActiveJob's prefix match). Used by dispatchReview so a concurrent
  // no-lens `review:KEY` is refused while a panel's `review:KEY:spec` siblings can still fan out.
  hasActiveJobNamed(ticketId: string, name: string): boolean {
    return !!db
      .prepare(
        "SELECT 1 FROM runs r JOIN jobs j ON r.job_id = j.id WHERE j.ticket_id = ? AND j.name = ? AND r.status IN ('running','queued') LIMIT 1"
      )
      .get(ticketId, name);
  },
  // How many runs of a job with this exact name started since `sinceIso`. Job ROWS are recreated on
  // every dispatch (review:KEY, ideas:feeder:KEY, their fallback: clones), so the name is the only
  // stable identity a re-trigger loop has — and a name running a dozen times an hour is a loop, not
  // work. Backs the dispatcher's loop guard.
  countRecentByJobName(name: string, sinceIso: string): number {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM runs r JOIN jobs j ON j.id = r.job_id WHERE j.name = ? AND r.started_at >= ?"
      )
      .get(name, sinceIso) as { n: number };
    return row.n;
  },
  // In-flight TICKET runs working in `cwd` (a ticket worktree), with the job name so the caller can
  // tell builds from read-only runs. Backs the one-agent-per-worktree lock in the dispatcher.
  // Ticket-bound only: unrelated cron/ideas/hygiene jobs share a repo checkout on purpose.
  activeTicketRunsInCwd(cwd: string): Array<{ run_id: string; job_name: string | null }> {
    return db
      .prepare(
        "SELECT r.id AS run_id, j.name AS job_name FROM runs r JOIN jobs j ON r.job_id = j.id WHERE j.cwd = ? AND j.ticket_id IS NOT NULL AND r.status IN ('running','queued')"
      )
      .all(cwd) as Array<{ run_id: string; job_name: string | null }>;
  },
  list(job_id?: string, limit = 100): Run[] {
    if (job_id)
      return db
        .prepare("SELECT * FROM runs WHERE job_id = ? ORDER BY rowid DESC LIMIT ?")
        .all(job_id, limit) as Run[];
    return db
      .prepare("SELECT * FROM runs ORDER BY rowid DESC LIMIT ?")
      .all(limit) as Run[];
  },
  // Every run for a ticket (all attempts/jobs), unbounded by the global feed cap.
  listForTicket(ticketId: string, limit = 500): Run[] {
    return db
      .prepare(
        "SELECT r.* FROM runs r JOIN jobs j ON r.job_id = j.id WHERE j.ticket_id = ? ORDER BY r.rowid DESC LIMIT ?"
      )
      .all(ticketId, limit) as Run[];
  },
  runningCount(): number {
    return (
      db.prepare("SELECT COUNT(*) c FROM runs WHERE status = 'running'").get() as {
        c: number;
      }
    ).c;
  },
  // verify verdict of the most recent run of the most recent job for a ticket (Flow shipped enrichment).
  verdictForTicket(ticketId: string): string | null {
    const row = db
      .prepare(
        `SELECT r.verify_verdict v FROM runs r JOIN jobs j ON j.id = r.job_id
         WHERE j.ticket_id = ? ORDER BY j.created_at DESC, r.rowid DESC LIMIT 1`
      )
      .get(ticketId) as { v: string | null } | undefined;
    return row?.v ?? null;
  },
  // Per-run cache totals since `since` for /api/stats cache-health aggregation (cache-health.ts).
  cacheRowsSince(since: string): Array<{ cache_read: number | null; cache_write: number | null; num_turns: number | null }> {
    return db
      .prepare(
        "SELECT cache_read, cache_write, num_turns FROM runs WHERE started_at >= ? AND (cache_read IS NOT NULL OR cache_write IS NOT NULL)"
      )
      .all(since) as Array<{ cache_read: number | null; cache_write: number | null; num_turns: number | null }>;
  },
  spentTodayUsd(): number {
    const row = db
      .prepare(
        "SELECT COALESCE(SUM(cost_usd),0) s FROM runs WHERE started_at >= ?"
      )
      .get(new Date().toISOString().slice(0, 10)) as { s: number };
    return row.s;
  },
  /**
   * How much of a window's spend the dollar figure actually covers (PER-24).
   *
   * `cost_usd` is null-preserving by design: a backend that never reports cost leaves it NULL, and
   * SUM() skips those rows. So `spentTodayUsd()` is not "what was spent today", it is "what the
   * metered backends reported" — on 2026-08-05 that was 6 of 69 personal runs, and the other 63
   * (grok 44, cursor 10, opencode 9) were invisible. Reporting the sum with no coverage next to it
   * is what led to a $27-vs-$20 alarm against a workspace that had actually spent $14.
   *
   * Unpriced is derived, not stored: a run that has ENDED with no cost is one nobody priced. Runs
   * still in flight are excluded — they have no cost yet because they are not finished.
   */
  spendCoverageSince(sinceIso: string, workspace_id?: string): {
    usd: number;
    priced_usd: number;
    estimated_usd: number;
    priced: number;
    estimated: number;
    unpriced: number;
    unpriced_backends: string[];
  } {
    const params: any[] = [sinceIso];
    let wsJoin = "";
    let wsClause = "";
    if (workspace_id) {
      wsJoin = "JOIN jobs j ON j.id = r.job_id";
      wsClause = "AND j.workspace_id = ?";
      params.push(workspace_id);
    }
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(r.cost_usd),0) usd,
                COALESCE(SUM(CASE WHEN r.cost_usd IS NOT NULL AND COALESCE(r.cost_estimated,0) = 0 THEN r.cost_usd ELSE 0 END),0) priced_usd,
                COALESCE(SUM(CASE WHEN r.cost_estimated = 1 THEN r.cost_usd ELSE 0 END),0) estimated_usd,
                SUM(CASE WHEN r.cost_usd IS NOT NULL AND COALESCE(r.cost_estimated,0) = 0 THEN 1 ELSE 0 END) priced,
                SUM(CASE WHEN r.cost_usd IS NOT NULL AND r.cost_estimated = 1 THEN 1 ELSE 0 END) estimated,
                SUM(CASE WHEN r.cost_usd IS NULL AND r.ended_at IS NOT NULL THEN 1 ELSE 0 END) unpriced
         FROM runs r ${wsJoin}
         WHERE r.started_at >= ? ${wsClause}`,
      )
      .get(...params) as {
        usd: number;
        priced_usd: number;
        estimated_usd: number;
        priced: number | null;
        estimated: number | null;
        unpriced: number | null;
      };
    const backendParams = [...params];
    const backends = db
      .prepare(
        workspace_id
          ? `SELECT DISTINCT COALESCE(j.backend,'?') b FROM runs r JOIN jobs j ON j.id = r.job_id
             WHERE r.started_at >= ? AND j.workspace_id = ? AND r.cost_usd IS NULL AND r.ended_at IS NOT NULL ORDER BY b`
          : `SELECT DISTINCT COALESCE(j.backend,'?') b FROM runs r JOIN jobs j ON j.id = r.job_id
             WHERE r.started_at >= ? AND r.cost_usd IS NULL AND r.ended_at IS NOT NULL ORDER BY b`,
      )
      .all(...backendParams) as Array<{ b: string }>;
    return {
      usd: row.usd,
      priced_usd: row.priced_usd,
      estimated_usd: row.estimated_usd,
      priced: row.priced ?? 0,
      estimated: row.estimated ?? 0,
      unpriced: row.unpriced ?? 0,
      unpriced_backends: backends.map((r) => r.b),
    };
  },
  // Every run started since `sinceIso`, across all jobs. Backs the global burn-velocity guard: the
  // count is the signal that survives a loop reporting $0.00 (rate-limited runs, fallback backends).
  countStartedSince(sinceIso: string): number {
    return (
      db.prepare("SELECT COUNT(*) n FROM runs WHERE started_at >= ?").get(sinceIso) as { n: number }
    ).n;
  },
  spentSince(sinceIso: string): number {
    return (
      db
        .prepare("SELECT COALESCE(SUM(cost_usd),0) s FROM runs WHERE started_at >= ?")
        .get(sinceIso) as { s: number }
    ).s;
  },
  // Spend grouped by workspace since a date (jobs carry workspace_id; legacy/null → "").
  spentByWorkspace(sinceIso: string): Array<{ workspace_id: string; cost: number; runs: number }> {
    return db
      .prepare(
        `SELECT COALESCE(j.workspace_id,'') workspace_id, COALESCE(SUM(r.cost_usd),0) cost, COUNT(*) runs
         FROM runs r LEFT JOIN jobs j ON j.id = r.job_id
         WHERE r.started_at >= ? GROUP BY j.workspace_id`
      )
      .all(sinceIso) as any[];
  },
  // Today's spend for one workspace (jobs carry workspace_id). Mirrors spentTodayUsd's date logic.
  spentTodayUsdForWorkspace(wsId: string): number {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(r.cost_usd),0) s FROM runs r JOIN jobs j ON j.id = r.job_id
         WHERE j.workspace_id = ? AND r.started_at >= ?`
      )
      .get(wsId, new Date().toISOString().slice(0, 10)) as { s: number };
    return row.s;
  },
  // In-flight runs for one workspace (status='running'), matching the global runningCount() semantics.
  runningCountForWorkspace(wsId: string): number {
    return (
      db
        .prepare(
          `SELECT COUNT(*) c FROM runs r JOIN jobs j ON j.id = r.job_id
           WHERE j.workspace_id = ? AND r.status = 'running'`
        )
        .get(wsId) as { c: number }
    ).c;
  },
  // Everything in flight right now — running plus not-yet-started. Backs `stop all`.
  listActive(): Run[] {
    return db
      .prepare("SELECT * FROM runs WHERE status IN ('running','queued') ORDER BY rowid DESC")
      .all() as Run[];
  },
  // Runs a daemon stop/crash orphaned (see the startup reconciliation in db.ts), newest first, bounded
  // to a recent window — an interruption from last week is history, not a decision anyone still wants.
  interruptedSince(sinceIso: string): Run[] {
    return db
      .prepare(
        "SELECT * FROM runs WHERE status = 'interrupted' AND COALESCE(ended_at, started_at) >= ? ORDER BY rowid DESC"
      )
      .all(sinceIso) as Run[];
  },
  // Runs still 'running' that started before `beforeIso` — candidates for stuck/looping detection.
  runningSince(beforeIso: string): Run[] {
    return db
      .prepare("SELECT * FROM runs WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?")
      .all(beforeIso) as Run[];
  },
  statusCounts(sinceIso: string): Record<string, number> {
    const rows = db
      .prepare("SELECT status, COUNT(*) c FROM runs WHERE started_at >= ? GROUP BY status")
      .all(sinceIso) as Array<{ status: string; c: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.c]));
  },
  costByJob(sinceIso: string, limit = 5): Array<{ job_id: string; name: string; runs: number; cost: number }> {
    return db
      .prepare(
        `SELECT r.job_id, COALESCE(j.name,'(deleted)') name, COUNT(*) runs,
           COALESCE(SUM(r.cost_usd),0) cost
         FROM runs r LEFT JOIN jobs j ON j.id = r.job_id
         WHERE r.started_at >= ? GROUP BY r.job_id ORDER BY cost DESC LIMIT ?`
      )
      .all(sinceIso, limit) as any[];
  },
  // Per-client cost ledger: rows grouped by workspace + pipeline stage over a date window. Stage is
  // derived from the job-name prefix convention (same one activity.ts uses). Null-workspace runs
  // (incl. deleted jobs) fall in the "unscoped" bucket. `to` is compared as a string, so pass a full
  // ISO timestamp (or a date + end-of-day) to include a whole day. ponytail: string compare, no tz math.
  costReport(opts: { workspace_id?: string; from?: string; to?: string } = {}): Array<{
    workspace_id: string | null; ws_slug: string; stage: string;
    runs: number; cost_usd: number; tokens_in: number; tokens_out: number;
  }> {
    const p: any = { from: opts.from ?? "0000", to: opts.to ?? "9999" };
    let wsClause = "";
    if (opts.workspace_id) { wsClause = "AND j.workspace_id = @workspace_id"; p.workspace_id = opts.workspace_id; }
    return db
      .prepare(
        `SELECT j.workspace_id AS workspace_id, COALESCE(w.slug,'unscoped') AS ws_slug,
           CASE
             WHEN j.name LIKE 'plan:%' THEN 'plan'
             WHEN j.name LIKE 'ticket:%' THEN 'build'
             WHEN j.name LIKE 'review:%' THEN 'review'
             WHEN j.name LIKE 'distill:%' THEN 'distill'
             ELSE 'other'
           END AS stage,
           COUNT(*) AS runs, COALESCE(SUM(r.cost_usd),0) AS cost_usd,
           COALESCE(SUM(r.tokens_in),0) AS tokens_in, COALESCE(SUM(r.tokens_out),0) AS tokens_out
         FROM runs r
         LEFT JOIN jobs j ON j.id = r.job_id
         LEFT JOIN workspaces w ON w.id = j.workspace_id
         WHERE r.started_at >= @from AND r.started_at <= @to ${wsClause}
         GROUP BY j.workspace_id, stage
         ORDER BY ws_slug ASC, cost_usd DESC`
      )
      .all(p) as any[];
  },
  // Daily cost/token time-series, one row per (day, model, workspace) over a date window. Day is the
  // YYYY-MM-DD prefix of started_at (string compare, no tz math — same convention costReport uses).
  // The Fleet daily-trend charts pivot these flat rows client-side (by model, by workspace, % share).
  dailyCosts(opts: { workspace_id?: string; from?: string; to?: string } = {}): Array<{
    day: string; model: string; workspace_id: string; ws_slug: string;
    runs: number; cost_usd: number; tokens_in: number; tokens_out: number;
  }> {
    const p: any = { from: opts.from ?? "0000", to: opts.to ?? "9999" };
    let wsClause = "";
    if (opts.workspace_id) { wsClause = "AND j.workspace_id = @workspace_id"; p.workspace_id = opts.workspace_id; }
    return db
      .prepare(
        `SELECT substr(r.started_at,1,10) AS day,
           COALESCE(NULLIF(j.model,''),'unknown') AS model,
           COALESCE(j.workspace_id,'') AS workspace_id,
           COALESCE(w.slug,'unscoped') AS ws_slug,
           COUNT(*) AS runs, COALESCE(SUM(r.cost_usd),0) AS cost_usd,
           COALESCE(SUM(r.tokens_in),0) AS tokens_in, COALESCE(SUM(r.tokens_out),0) AS tokens_out
         FROM runs r
         LEFT JOIN jobs j ON j.id = r.job_id
         LEFT JOIN workspaces w ON w.id = j.workspace_id
         WHERE r.started_at >= @from AND r.started_at <= @to AND r.started_at IS NOT NULL ${wsClause}
         GROUP BY day, model, workspace_id
         ORDER BY day ASC`
      )
      .all(p) as any[];
  },
  // Build outcomes for one workspace over a date window: ticket-build runs (job name 'ticket:%',
  // same stage convention costReport uses) grouped by run status. `to` is a string compare like
  // costReport — pass a full ISO timestamp to bound the day. For the client report's success rate.
  buildOutcomes(opts: { workspace_id?: string; from?: string; to?: string } = {}): Array<{ status: string; count: number }> {
    const p: any = { from: opts.from ?? "0000", to: opts.to ?? "9999" };
    let wsClause = "";
    if (opts.workspace_id) { wsClause = "AND j.workspace_id = @workspace_id"; p.workspace_id = opts.workspace_id; }
    return db
      .prepare(
        `SELECT r.status status, COUNT(*) count
         FROM runs r LEFT JOIN jobs j ON j.id = r.job_id
         WHERE r.started_at >= @from AND r.started_at <= @to AND j.name LIKE 'ticket:%' ${wsClause}
         GROUP BY r.status`
      )
      .all(p) as any[];
  },
  // Overnight build outcomes per workspace since `sinceIso`: ticket-build runs (job name 'ticket:%',
  // same stage convention costReport uses) grouped by workspace + run status.
  buildOutcomesSince(sinceIso: string): Array<{ workspace_id: string; status: string; count: number }> {
    return db
      .prepare(
        `SELECT COALESCE(j.workspace_id,'') workspace_id, r.status status, COUNT(*) count
         FROM runs r JOIN jobs j ON j.id = r.job_id
         WHERE r.started_at >= ? AND j.name LIKE 'ticket:%'
         GROUP BY j.workspace_id, r.status`
      )
      .all(sinceIso) as any[];
  },
  // Fleet board: in-flight runs (running + queued) PLUS paused runs that still have an open `mc ask`
  // (parked HITL — still occupying attention even though nothing is executing). A paused run whose
  // ask was already answered (or cancelled) is a ghost: answerAsk used to leave status=paused while
  // dispatching the resume as a new row, so those phantoms poisoned /api/agents/rollup forever
  // (PER-17). Joined to their job for workspace, name (plan:/ticket:/…), model and cost. Oldest
  // first. A run always has a job (cascade delete), so an inner JOIN is safe. Callers split by
  // status; a caller that only wants truly in-flight work (concurrency counting, worktree locking)
  // filters status itself or uses a narrower query — see runningCountForWorkspace /
  // activeTicketRunsInCwd.
  activeByWorkspace(): Array<{ id: string; workspace_id: string; status: string; job_name: string; model: string | null; started_at: string | null; cost_usd: number | null }> {
    return db
      .prepare(
        `SELECT r.id, COALESCE(j.workspace_id,'') workspace_id, r.status status,
           j.name job_name, j.model model, r.started_at, r.cost_usd
         FROM runs r JOIN jobs j ON j.id = r.job_id
         WHERE r.status IN ('running','queued')
            OR (r.status = 'paused' AND EXISTS (
                  SELECT 1 FROM asks a WHERE a.run_id = r.id AND a.status = 'open'
                ))
         ORDER BY r.started_at ASC`
      )
      .all() as any[];
  },
  // Fleet board window stats per workspace in ONE pass: subscription-limit token proxy (in+out over
  // runs started since `tokenSinceIso`, ~5h) plus the latest rate-limit reset among rate_limited runs
  // since `sinceIso` (~24h). `sinceIso` is the broader window so its WHERE covers both aggregates.
  windowByWorkspace(tokenSinceIso: string, sinceIso: string): Array<{ workspace_id: string; tokens: number; resets_at: string | null }> {
    return db
      .prepare(
        `SELECT COALESCE(j.workspace_id,'') workspace_id,
           COALESCE(SUM(CASE WHEN r.started_at >= @tok THEN COALESCE(r.tokens_in,0)+COALESCE(r.tokens_out,0) ELSE 0 END),0) tokens,
           MAX(CASE WHEN r.status='rate_limited' THEN r.resets_at END) resets_at
         FROM runs r JOIN jobs j ON j.id = r.job_id
         WHERE r.started_at >= @since
         GROUP BY j.workspace_id`
      )
      .all({ tok: tokenSinceIso, since: sinceIso }) as any[];
  },
  // ── quota gate evidence (src/quota-gate.ts) ────────────────────────────────
  // What the repo already recorded about provider walls, read back as evidence instead of guessed.
  // `backend` + the workspace's `config_dir` together name the CREDENTIAL a run spent (claude-code
  // bills a different account per CLAUDE_CONFIG_DIR), which is the granularity the gate reasons at.
  limitEvidenceSince(sinceIso: string): Array<{
    id: string;
    status: string;
    resets_at: string | null;
    error: string | null;
    started_at: string | null;
    backend: string | null;
    model: string | null;
    workspace_id: string | null;
    config_dir: string | null;
  }> {
    return db
      .prepare(
        `SELECT r.id, r.status, r.resets_at, r.error, r.started_at,
           j.backend backend, j.model model, j.workspace_id workspace_id, w.config_dir config_dir
         FROM runs r JOIN jobs j ON j.id = r.job_id
         LEFT JOIN workspaces w ON w.id = j.workspace_id
         WHERE r.started_at >= @since AND r.status IN ('rate_limited','failed','blocked','timeout')
         ORDER BY r.started_at DESC LIMIT 200`
      )
      .all({ since: sinceIso }) as any[];
  },
  // Tokens charged to each credential over the window — the 5h subscription proxy, grouped the way
  // the gate needs it rather than per workspace (two workspaces can share one profile, and do).
  tokensByCredentialSince(sinceIso: string): Array<{ backend: string | null; config_dir: string | null; tokens: number }> {
    return db
      .prepare(
        `SELECT j.backend backend, w.config_dir config_dir,
           COALESCE(SUM(COALESCE(r.tokens_in,0)+COALESCE(r.tokens_out,0)),0) tokens
         FROM runs r JOIN jobs j ON j.id = r.job_id
         LEFT JOIN workspaces w ON w.id = j.workspace_id
         WHERE r.started_at >= @since
         GROUP BY j.backend, w.config_dir`
      )
      .all({ since: sinceIso }) as any[];
  },
  // How long this workspace's finished runs at this difficulty actually took, newest first. The gate
  // takes the median as its completion horizon — a tier-1 tweak and a tier-5 redesign are not one bet.
  durationsForDifficulty(workspace_id: string, complexities: string[], limit = 40): number[] {
    if (!complexities.length) return [];
    const holes = complexities.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT (julianday(r.ended_at) - julianday(r.started_at)) * 86400 secs
         FROM runs r JOIN jobs j ON j.id = r.job_id JOIN tickets t ON t.id = j.ticket_id
         WHERE j.workspace_id = ? AND COALESCE(t.complexity,'3') IN (${holes})
           AND r.status = 'success' AND r.started_at IS NOT NULL AND r.ended_at IS NOT NULL
         ORDER BY r.started_at DESC LIMIT ?`
      )
      .all(workspace_id, ...complexities, Math.max(1, limit)) as Array<{ secs: number | null }>;
    return rows.map((r) => Number(r.secs)).filter((n) => Number.isFinite(n) && n > 0);
  },
  patch(id: string, p: Partial<Run>): void {
    const keys = Object.keys(p);
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = @${k}`).join(", ");
    db.prepare(`UPDATE runs SET ${set} WHERE id = @id`).run({ ...p, id } as any);
  },
  setStatus(id: string, status: RunStatus): void {
    db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(status, id);
  },
};
