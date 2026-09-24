// The Jobs page's read model (Desk → ⏱ Jobs): every job with its last runs as a strip, its health
// over a window, and a day-by-day histogram of the whole fleet — one query each, so a board of a
// few hundred jobs and thousands of runs is still one round trip. The runs feed is the same rows
// flattened across jobs, newest first, for the "what failed today" view.
import { db } from "./store.js";
import type { Job, RunStatus } from "./types.js";
import { isInternalJob } from "./job-name.js";

export type JobKind = "operator" | "internal" | "all";

/** Statuses the board counts as a failure: the run ended and did not do its job. */
export const FAILED_STATUSES: RunStatus[] = ["failed", "timeout", "interrupted", "blocked"];
/** A run holding (or waiting for) a slot right now. */
export const LIVE_STATUSES: RunStatus[] = ["running", "queued"];

export interface StripRun {
  id: string;
  status: RunStatus;
  started_at: string | null;
  ended_at: string | null;
  cost_usd: number | null;
  trigger_src: string | null;
}

export interface JobStats {
  runs: number;
  success: number;
  failed: number;
  other: number;
  live: number;
  cost: number;
  avg_sec: number | null;
  max_sec: number | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  /** Consecutive failures at the head of the history — 3 means the last three runs all failed. */
  streak_failed: number;
}

export type BoardJob = Job & { recent: StripRun[]; stats: JobStats };

export interface DayBucket { day: string; success: number; failed: number; other: number; cost: number }

export interface BoardOpts {
  ws?: string | null;
  kind?: JobKind;
  days?: number;
  strip?: number;
  /** Minutes east of UTC is negative, like Date#getTimezoneOffset — day buckets follow the viewer's clock. */
  tzOffsetMin?: number;
  now?: Date;
}

const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const FAILED_SQL = inList(FAILED_STATUSES);
const LIVE_SQL = inList(LIVE_STATUSES);
const clampInt = (n: unknown, lo: number, hi: number, dflt: number) => {
  const x = Math.round(Number(n));
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;
};

function jobsFor(ws: string | null, kind: JobKind): Job[] {
  const rows = (ws === null
    ? db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all()
    : db.prepare("SELECT * FROM jobs WHERE workspace_id = ? ORDER BY created_at DESC").all(ws)) as Job[];
  return rows.filter((j) => kind === "all" || (kind === "internal") === isInternalJob(j.name));
}

export interface Board {
  jobs: BoardJob[];
  days: DayBucket[];
  /** The same histogram per client ("" = jobs with no client), so a filtered page draws its own. */
  days_by_ws: Record<string, DayBucket[]>;
  since: string;
}

export function jobsBoard(opts: BoardOpts = {}): Board {
  const ws = opts.ws ?? null;
  const kind = opts.kind ?? "operator";
  const days = clampInt(opts.days, 1, 90, 14);
  const strip = clampInt(opts.strip, 1, 60, 30);
  const tz = clampInt(opts.tzOffsetMin, -900, 900, 0);
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();

  const list = jobsFor(ws, kind);
  if (!list.length) return { jobs: [], days: emptyDays(now, days, tz), days_by_ws: {}, since };
  const ids = new Set(list.map((j) => j.id));

  // The strip: the last `strip` runs of every job, newest first. A queued run has no started_at
  // yet and sorts to the head, where it belongs.
  const recent = new Map<string, StripRun[]>();
  const stripRows = db.prepare(
    `SELECT job_id, id, status, started_at, ended_at, cost_usd, trigger_src FROM (
       SELECT r.*, ROW_NUMBER() OVER (PARTITION BY r.job_id ORDER BY COALESCE(r.started_at, '9999') DESC, r.rowid DESC) AS rn FROM runs r
     ) WHERE rn <= ? ORDER BY job_id, rn`
  ).all(strip) as Array<StripRun & { job_id: string }>;
  for (const { job_id, ...r } of stripRows) {
    if (!ids.has(job_id)) continue;
    (recent.get(job_id) ?? recent.set(job_id, []).get(job_id)!).push(r);
  }

  const statRows = db.prepare(
    `SELECT job_id,
       COUNT(*) AS runs,
       SUM(status = 'success') AS success,
       SUM(status IN (${FAILED_SQL})) AS failed,
       SUM(status IN (${LIVE_SQL})) AS live,
       COALESCE(SUM(cost_usd), 0) AS cost,
       AVG(CASE WHEN status = 'success' AND ended_at IS NOT NULL THEN (julianday(ended_at) - julianday(started_at)) * 86400 END) AS avg_sec,
       MAX(CASE WHEN ended_at IS NOT NULL THEN (julianday(ended_at) - julianday(started_at)) * 86400 END) AS max_sec
     FROM runs WHERE started_at >= ? OR status IN (${LIVE_SQL}) GROUP BY job_id`
  ).all(since) as Array<{ job_id: string; runs: number; success: number; failed: number; live: number; cost: number; avg_sec: number | null; max_sec: number | null }>;
  const stats = new Map(statRows.map((s) => [s.job_id, s]));

  const lastRows = db.prepare(
    `SELECT job_id,
       MAX(CASE WHEN status = 'success' THEN COALESCE(ended_at, started_at) END) AS last_success_at,
       MAX(CASE WHEN status IN (${FAILED_SQL}) THEN COALESCE(ended_at, started_at) END) AS last_failure_at
     FROM runs GROUP BY job_id`
  ).all() as Array<{ job_id: string; last_success_at: string | null; last_failure_at: string | null }>;
  const last = new Map(lastRows.map((r) => [r.job_id, r]));

  const out: BoardJob[] = list.map((j) => {
    const s = stats.get(j.id);
    const l = last.get(j.id);
    const rec = recent.get(j.id) ?? [];
    let streak = 0;
    for (const r of rec) {
      if (LIVE_STATUSES.includes(r.status)) continue;
      if (FAILED_STATUSES.includes(r.status)) streak++; else break;
    }
    const runs = s?.runs ?? 0, success = s?.success ?? 0, failed = s?.failed ?? 0, live = s?.live ?? 0;
    return {
      ...j,
      recent: rec,
      stats: {
        runs, success, failed, live, other: Math.max(0, runs - success - failed - live),
        cost: Math.round((s?.cost ?? 0) * 10_000) / 10_000,
        avg_sec: s?.avg_sec == null ? null : Math.round(s.avg_sec),
        max_sec: s?.max_sec == null ? null : Math.round(s.max_sec),
        last_success_at: l?.last_success_at ?? null,
        last_failure_at: l?.last_failure_at ?? null,
        streak_failed: streak,
      },
    };
  });

  const wsOf = new Map(list.map((j) => [j.id, j.workspace_id ?? ""]));
  return { jobs: out, ...dayBuckets(wsOf, since, now, days, tz), since };
}

function emptyDays(now: Date, days: number, tz: number): DayBucket[] {
  const out: DayBucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000 - tz * 60_000);
    out.push({ day: d.toISOString().slice(0, 10), success: 0, failed: 0, other: 0, cost: 0 });
  }
  return out;
}

function dayBuckets(wsOf: Map<string, string>, since: string, now: Date, days: number, tz: number): Pick<Board, "days" | "days_by_ws"> {
  const all = emptyDays(now, days, tz);
  const byWs: Record<string, DayBucket[]> = {};
  const idx = new Map(all.map((b, i) => [b.day, i]));
  const rows = db.prepare(
    `SELECT job_id, date(started_at, ?) AS day, status, COALESCE(cost_usd, 0) AS cost FROM runs WHERE started_at >= ?`
  ).all(`${-tz} minutes`, since) as Array<{ job_id: string; day: string; status: RunStatus; cost: number }>;
  const add = (b: DayBucket, r: { status: RunStatus; cost: number }) => {
    if (r.status === "success") b.success++;
    else if (FAILED_STATUSES.includes(r.status)) b.failed++;
    else b.other++;
    b.cost += r.cost;
  };
  for (const r of rows) {
    const ws = wsOf.get(r.job_id);
    const i = idx.get(r.day);
    if (ws === undefined || i === undefined) continue;
    add(all[i], r);
    add((byWs[ws] ??= emptyDays(now, days, tz))[i], r);
  }
  const round = (bs: DayBucket[]) => { for (const b of bs) b.cost = Math.round(b.cost * 10_000) / 10_000; return bs; };
  for (const k of Object.keys(byWs)) round(byWs[k]);
  return { days: round(all), days_by_ws: byWs };
}

export type FeedRun = StripRun & {
  job_id: string; job_name: string; workspace_id: string | null;
  num_turns: number | null; summary: string | null; error: string | null; attempt: number;
};

export interface FeedOpts {
  ws?: string | null;
  kind?: JobKind;
  /** "failed" | "live" | "success" | a single RunStatus | "all". */
  status?: string;
  days?: number;
  limit?: number;
  now?: Date;
}

export function runsFeed(opts: FeedOpts = {}): FeedRun[] {
  const ws = opts.ws ?? null;
  const kind = opts.kind ?? "operator";
  const days = clampInt(opts.days, 1, 90, 7);
  const limit = clampInt(opts.limit, 1, 1000, 200);
  const since = new Date((opts.now ?? new Date()).getTime() - days * 86_400_000).toISOString();
  const st = opts.status ?? "all";
  const statusSql =
    st === "failed" ? `AND r.status IN (${FAILED_SQL})`
    : st === "live" ? `AND r.status IN (${LIVE_SQL})`
    : st === "all" ? ""
    : `AND r.status = @status`;
  const rows = db.prepare(
    `SELECT r.id, r.job_id, r.status, r.started_at, r.ended_at, r.cost_usd, r.trigger_src, r.num_turns, r.attempt,
            substr(r.summary, 1, 300) AS summary, substr(r.error, 1, 300) AS error,
            j.name AS job_name, j.workspace_id
     FROM runs r JOIN jobs j ON j.id = r.job_id
     WHERE (r.started_at >= @since OR r.status IN (${LIVE_SQL})) ${statusSql} ${ws === null ? "" : "AND j.workspace_id = @ws"}
     ORDER BY COALESCE(r.started_at, '9999') DESC, r.rowid DESC`
  ).all({ since, ...(statusSql.includes("@status") ? { status: st } : {}), ...(ws === null ? {} : { ws }) }) as FeedRun[];
  const out: FeedRun[] = [];
  for (const r of rows) {
    if (kind !== "all" && (kind === "internal") !== isInternalJob(r.job_name)) continue;
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}
