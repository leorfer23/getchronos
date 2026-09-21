/**
 * Altitude — the fleet from above: spend, usage and terminals over a window, bucketed.
 *
 * Everything else in Chronos reports on NOW (the wall, /fleet, /flow) or on ONE DAY (/desk/log).
 * This is the other axis: a quarter of work as a shape you can point at. Same honest ledger rule as
 * src/spend.ts — headless runs and Desk terminals are disjoint surfaces, so they are summed once
 * each and never cross-attributed, and estimated dollars travel labelled rather than as metered fact.
 *
 * Two deliberate departures from the older /costs endpoints:
 *
 * 1. **Buckets are LOCAL days, not UTC prefixes.** costReport/dailyCosts group on
 *    `substr(started_at,1,10)`, which is the UTC date. For an operator at UTC-3 that files every
 *    terminal opened after 21:00 under tomorrow — and "current month" then starts on the wrong
 *    evening. A dashboard whose whole job is date filtering cannot be off by a timezone, so rows
 *    are read raw and bucketed in JS against the daemon's local clock.
 * 2. **Aggregation happens here, not in SQL.** The window is bounded (a quarter is a few hundred
 *    runs and a few dozen terminals) and every breakdown then comes from ONE pass over the same
 *    rows — no chance of two panels on the same screen disagreeing because their WHERE clauses
 *    drifted apart. It also makes the whole thing unit-testable without SQL date math.
 */
import { db } from "./store/db.js";
import { workspaces } from "./store.js";

export type Bucket = "day" | "week" | "month";

/** The windows the UI offers, plus `custom` for an explicit from/to. */
export type RangePreset =
  | "today"
  | "yesterday"
  | "7d"
  | "30d"
  | "90d"
  | "mtd"
  | "last-month"
  | "qtd"
  | "last-quarter"
  | "ytd"
  | "all"
  | "custom";

// `short` is what the header strip actually renders: eleven full labels overflow the one-row bar and
// push "Last quarter" — a window the operator asks for by name — behind a horizontal scroll.
export const RANGE_PRESETS: Array<{ key: RangePreset; label: string; short: string; bucket: Bucket }> = [
  { key: "today", label: "Today", short: "Today", bucket: "day" },
  { key: "yesterday", label: "Yesterday", short: "Yest", bucket: "day" },
  { key: "7d", label: "Last 7 days", short: "7d", bucket: "day" },
  { key: "30d", label: "Last 30 days", short: "30d", bucket: "day" },
  { key: "90d", label: "Last 90 days", short: "90d", bucket: "week" },
  { key: "mtd", label: "This month", short: "MTD", bucket: "day" },
  { key: "last-month", label: "Last month", short: "Last mo", bucket: "day" },
  { key: "qtd", label: "This quarter", short: "QTD", bucket: "week" },
  { key: "last-quarter", label: "Last quarter", short: "Last Q", bucket: "week" },
  { key: "ytd", label: "This year", short: "YTD", bucket: "month" },
  { key: "all", label: "All time", short: "All", bucket: "month" },
];

export interface ResolvedRange {
  preset: RangePreset;
  label: string;
  /** Inclusive start, ISO instant. */
  from: string;
  /** Exclusive end, ISO instant. */
  to: string;
  bucket: Bucket;
  days: number;
}

const DAY_MS = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const quarterStart = (d: Date) => new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1);

/**
 * Turn a preset into a concrete half-open window [from, to) in local time.
 *
 * Half-open on purpose: "today" must include a terminal opened one second ago, and a month boundary
 * must belong to exactly one month. `to` is therefore the first instant NOT in the window.
 * `now` is injectable so the tests aren't hostage to the clock they run on.
 */
export function resolveRange(
  preset: RangePreset | string | undefined,
  opts: { from?: string; to?: string; bucket?: Bucket; now?: Date } = {},
): ResolvedRange {
  const now = opts.now ?? new Date();
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const known = RANGE_PRESETS.find((p) => p.key === preset);
  const p: RangePreset = opts.from || opts.to ? "custom" : (known?.key ?? "30d");

  let from: Date;
  let to: Date;
  let label: string;
  switch (p) {
    case "custom": {
      // An explicit from/to wins over any preset. A bare date ("2026-09-01") means that whole local
      // day, so `to` is nudged to the following midnight — otherwise the last day always reads empty.
      from = opts.from ? parseBoundary(opts.from, false) : addDays(today, -29);
      to = opts.to ? parseBoundary(opts.to, true) : tomorrow;
      label = "Custom";
      break;
    }
    case "today": from = today; to = tomorrow; label = "Today"; break;
    case "yesterday": from = addDays(today, -1); to = today; label = "Yesterday"; break;
    case "7d": from = addDays(today, -6); to = tomorrow; label = "Last 7 days"; break;
    case "30d": from = addDays(today, -29); to = tomorrow; label = "Last 30 days"; break;
    case "90d": from = addDays(today, -89); to = tomorrow; label = "Last 90 days"; break;
    case "mtd": from = new Date(now.getFullYear(), now.getMonth(), 1); to = tomorrow; label = "This month"; break;
    case "last-month":
      from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      to = new Date(now.getFullYear(), now.getMonth(), 1);
      label = "Last month";
      break;
    case "qtd": from = quarterStart(now); to = tomorrow; label = "This quarter"; break;
    case "last-quarter": {
      const qs = quarterStart(now);
      from = new Date(qs.getFullYear(), qs.getMonth() - 3, 1);
      to = qs;
      label = "Last quarter";
      break;
    }
    case "ytd": from = new Date(now.getFullYear(), 0, 1); to = tomorrow; label = "This year"; break;
    case "all": from = new Date(2000, 0, 1); to = tomorrow; label = "All time"; break;
  }

  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_MS));
  // A default bucket that keeps the chart readable: a year of daily bars is 365 hairlines.
  const bucket: Bucket =
    opts.bucket ?? known?.bucket ?? (days > 180 ? "month" : days > 45 ? "week" : "day");
  return { preset: p, label, from: from.toISOString(), to: to.toISOString(), bucket, days };
}

/** "2026-09-01" → local midnight; a full ISO instant is taken as-is. `end` nudges a bare date to the next midnight. */
function parseBoundary(s: string, end: boolean): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return end ? addDays(d, 1) : d;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? new Date() : new Date(t);
}

/** The bucket an instant belongs to, as a sortable key. Weeks start Monday. */
export function bucketKey(iso: string, bucket: Bucket): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  if (bucket === "month") return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  if (bucket === "week") {
    const mon = addDays(d, -((d.getDay() + 6) % 7));
    return `${mon.getFullYear()}-${pad(mon.getMonth() + 1)}-${pad(mon.getDate())}`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Every bucket in [from,to), in order — so an idle Tuesday is a gap in the chart, not a missing bar. */
export function bucketsBetween(from: string, to: string, bucket: Bucket): string[] {
  const end = new Date(to).getTime();
  const out: string[] = [];
  let cur = new Date(from);
  if (bucket === "month") cur = new Date(cur.getFullYear(), cur.getMonth(), 1);
  else if (bucket === "week") cur = addDays(startOfDay(cur), -((cur.getDay() + 6) % 7));
  else cur = startOfDay(cur);
  // A month window can be 28-31 days long; step by calendar unit, never by a fixed ms count.
  while (cur.getTime() < end && out.length < 400) {
    out.push(bucketKey(cur.toISOString(), bucket));
    cur =
      bucket === "month"
        ? new Date(cur.getFullYear(), cur.getMonth() + 1, 1)
        : addDays(cur, bucket === "week" ? 7 : 1);
  }
  return out;
}

// ── rows ──────────────────────────────────────────────────────────────────────────────────────

interface RunRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  cost_usd: number | null;
  cost_estimated: number;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read: number | null;
  cache_write: number | null;
  num_turns: number | null;
  ws: string;
  model: string;
  backend: string | null;
  job_name: string;
}

interface SessionRow {
  id: string;
  created_at: string;
  ended_at: string | null;
  status: string;
  ws: string;
  backend: string | null;
  model: string | null;
  cost_usd: number | null;
  cost_estimated: number;
  turns: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read: number | null;
  cache_write: number | null;
  context_peak: number | null;
  lines_added: number | null;
  lines_removed: number | null;
  model_ms: number | null;
  agent_name: string | null;
  created_by: string | null;
  goal_kind: string | null;
  goal_done_at: string | null;
  blocked_count: number | null;
  goal: string | null;
  spawn_goal: string | null;
  title: string | null;
  branch: string | null;
}

function runRows(from: string, to: string, ws?: string): RunRow[] {
  const params: any[] = [from, to];
  let wsClause = "";
  if (ws) { wsClause = "AND COALESCE(j.workspace_id,'') = ?"; params.push(ws); }
  return db
    .prepare(
      `SELECT r.id, r.started_at, r.ended_at, r.status, r.cost_usd,
              COALESCE(r.cost_estimated,0) AS cost_estimated,
              r.tokens_in, r.tokens_out,
              r.cache_read, r.cache_write, r.num_turns,
              COALESCE(j.workspace_id,'') AS ws,
              COALESCE(NULLIF(j.model,''),'unknown') AS model,
              j.backend AS backend,
              COALESCE(j.name,'') AS job_name
       FROM runs r LEFT JOIN jobs j ON j.id = r.job_id
       WHERE r.started_at IS NOT NULL AND r.started_at >= ? AND r.started_at < ? ${wsClause}`,
    )
    .all(...params) as RunRow[];
}

function sessionRows(from: string, to: string, ws?: string): SessionRow[] {
  const params: any[] = [from, to];
  let wsClause = "";
  if (ws) { wsClause = "AND COALESCE(s.workspace_id,'') = ?"; params.push(ws); }
  return db
    .prepare(
      `SELECT s.id, s.created_at, s.ended_at, s.status, COALESCE(s.workspace_id,'') AS ws,
              s.backend, s.model, s.cost_usd, COALESCE(s.cost_estimated,0) AS cost_estimated,
              s.turns, s.tokens_in, s.tokens_out, s.cache_read, s.cache_write,
              s.context_peak, s.lines_added, s.lines_removed,
              s.model_ms, s.agent_name, s.created_by, s.goal_kind, s.goal_done_at, s.blocked_count,
              s.goal, s.spawn_goal, s.title, s.branch
       FROM sessions s
       WHERE s.created_at >= ? AND s.created_at < ? ${wsClause}`,
    )
    .all(...params) as SessionRow[];
}

/** Same stage convention as runs.costReport — the dashboard must not invent a second taxonomy. */
export function stageOf(jobName: string): string {
  if (jobName.startsWith("plan:")) return "plan";
  if (jobName.startsWith("ticket:")) return "build";
  if (jobName.startsWith("review:")) return "review";
  if (jobName.startsWith("distill:")) return "distill";
  if (jobName.startsWith("grade:")) return "grade";
  if (jobName.startsWith("ideas:")) return "ideas";
  if (jobName.startsWith("intake:")) return "intake";
  return "other";
}

// ── shapes ────────────────────────────────────────────────────────────────────────────────────

export interface Totals {
  usd: number;
  runs_usd: number;
  sessions_usd: number;
  estimated_usd: number;
  priced_usd: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  tokens_total: number;
  runs: number;
  sessions: number;
  live_sessions: number;
  turns: number;
  model_minutes: number;
  open_minutes: number;
  lines_added: number;
  lines_removed: number;
  blocked: number;
  goals_reached: number;
  ok: number;
  failed: number;
  success_rate: number | null;
}

export interface SeriesPoint extends Record<string, unknown> {
  bucket: string;
  usd: number;
  runs_usd: number;
  sessions_usd: number;
  estimated_usd: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  runs: number;
  sessions: number;
  turns: number;
  model_minutes: number;
  /** workspace id → dollars in this bucket, for the stacked bars. */
  by_ws: Record<string, number>;
}

export interface WorkspaceRow {
  workspace_id: string;
  name: string;
  slug: string;
  kind: string | null;
  usd: number;
  runs_usd: number;
  sessions_usd: number;
  estimated_usd: number;
  runs: number;
  sessions: number;
  tokens_in: number;
  tokens_out: number;
  turns: number;
  model_minutes: number;
  lines_added: number;
  lines_removed: number;
  blocked: number;
  share: number;
  daily_budget_usd: number | null;
  /** Spend today against that workspace's daily budget — the only number here that ignores the window. */
  today_usd: number;
}

export interface Analytics {
  range: ResolvedRange & { workspace_id: string | null };
  totals: Totals;
  previous: Pick<Totals, "usd" | "tokens_total" | "runs" | "sessions" | "turns">;
  delta: { usd: number | null; tokens_total: number | null; runs: number | null; sessions: number | null };
  series: SeriesPoint[];
  by_workspace: WorkspaceRow[];
  by_model: Array<{ model: string; usd: number; runs: number; sessions: number; tokens_in: number; tokens_out: number; turns: number }>;
  by_stage: Array<{ stage: string; usd: number; runs: number; tokens_in: number; tokens_out: number; ok: number; failed: number }>;
  by_backend: Array<{ backend: string; usd: number; runs: number; sessions: number }>;
  by_opener: Array<{ opener: string; sessions: number; usd: number; turns: number; model_minutes: number }>;
  by_goal_kind: Array<{ kind: string; sessions: number; usd: number; reached: number }>;
  outcomes: Record<string, number>;
  /** Local hour (0-23) × weekday (0=Mon) — when the money actually gets spent. */
  heat: Array<{ dow: number; hour: number; usd: number; events: number }>;
  top_terminals: Array<{
    id: string; started: string; ended: string | null; live: boolean; workspace_id: string;
    title: string; usd: number; estimated: boolean; turns: number; tokens_in: number; tokens_out: number;
    context_peak: number; minutes: number; model_minutes: number; lines_added: number; lines_removed: number;
    opened_by: string; model: string | null; backend: string | null; branch: string | null; reached: boolean;
    blocked: number;
  }>;
  top_jobs: Array<{ job: string; stage: string; workspace_id: string; usd: number; runs: number; ok: number; failed: number; tokens_in: number; tokens_out: number }>;
  coverage: {
    priced_usd: number;
    estimated_usd: number;
    unpriced_runs: number;
    unpriced_sessions: number;
    estimated_runs: number;
    estimated_sessions: number;
    unpriced_backends: string[];
  };
  workspaces: Array<{ id: string; name: string; slug: string; kind: string; archived: boolean }>;
  generated_at: string;
}

// ── the pass ──────────────────────────────────────────────────────────────────────────────────

const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round2 = (v: number) => Math.round(v * 100) / 100;
const pct = (cur: number, prev: number): number | null =>
  prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null;

function minutesBetween(from: string, to: string | null): number {
  const end = to ? Date.parse(to) : Date.now();
  const start = Date.parse(from);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return 0;
  return Math.max(0, Math.round((end - start) / 60_000));
}

/** Sum a window without building the full payload — used for the previous-period delta. */
function windowTotals(from: string, to: string, ws?: string) {
  const runsR = runRows(from, to, ws);
  const sessR = sessionRows(from, to, ws);
  const usd =
    runsR.reduce((a, r) => a + n(r.cost_usd), 0) + sessR.reduce((a, s) => a + n(s.cost_usd), 0);
  const tokens =
    runsR.reduce((a, r) => a + n(r.tokens_in) + n(r.tokens_out) + n(r.cache_read) + n(r.cache_write), 0) +
    sessR.reduce((a, s) => a + n(s.tokens_in) + n(s.tokens_out), 0);
  const turns =
    runsR.reduce((a, r) => a + n(r.num_turns), 0) + sessR.reduce((a, s) => a + n(s.turns), 0);
  return { usd: round2(usd), tokens_total: tokens, runs: runsR.length, sessions: sessR.length, turns };
}

/**
 * One window, every breakdown, one pass over the rows.
 *
 * `workspace_id` narrows everything including the previous-period comparison, so a client view is a
 * real client view and not the fleet's shape with one bar highlighted.
 */
export function analytics(
  opts: {
    preset?: RangePreset | string;
    from?: string;
    to?: string;
    bucket?: Bucket;
    workspace_id?: string;
    /**
     * The caller's own workspace when it authenticated with a workspace token, or null for the
     * operator. Distinct from `workspace_id`, which is only a filter: the operator filtering to one
     * client still needs the whole client list to draw the filter strip, while a scoped caller must
     * not learn that the other clients exist (CLAUDE.md #4 — the workspace boundary).
     */
    scope_ws?: string | null;
    now?: Date;
    /** How many rows the two "top" tables carry. */
    top?: number;
  } = {},
): Analytics {
  const range = resolveRange(opts.preset, { from: opts.from, to: opts.to, bucket: opts.bucket, now: opts.now });
  const ws = opts.workspace_id || undefined;
  const top = Math.min(200, Math.max(1, opts.top ?? 25));
  const runsR = runRows(range.from, range.to, ws);
  const sessR = sessionRows(range.from, range.to, ws);

  const wsList = workspaces.list(true) as any[];
  const wsById = new Map<string, any>(wsList.map((w: any) => [w.id, w]));

  const totals: Totals = {
    usd: 0, runs_usd: 0, sessions_usd: 0, estimated_usd: 0, priced_usd: 0,
    tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, tokens_total: 0,
    runs: runsR.length, sessions: sessR.length, live_sessions: 0, turns: 0,
    model_minutes: 0, open_minutes: 0, lines_added: 0, lines_removed: 0,
    blocked: 0, goals_reached: 0, ok: 0, failed: 0, success_rate: null,
  };

  const emptyPoint = (b: string): SeriesPoint => ({
    bucket: b, usd: 0, runs_usd: 0, sessions_usd: 0, estimated_usd: 0,
    tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0,
    runs: 0, sessions: 0, turns: 0, model_minutes: 0, by_ws: {},
  });
  const points = new Map<string, SeriesPoint>();
  for (const b of bucketsBetween(range.from, range.to, range.bucket)) points.set(b, emptyPoint(b));
  const point = (iso: string): SeriesPoint => {
    const k = bucketKey(iso, range.bucket);
    let p = points.get(k);
    if (!p) { p = emptyPoint(k); points.set(k, p); }
    return p;
  };

  type WsAcc = Omit<WorkspaceRow, "name" | "slug" | "kind" | "share" | "daily_budget_usd" | "today_usd">;
  const byWs = new Map<string, WsAcc>();
  const wsAcc = (id: string): WsAcc => {
    let a = byWs.get(id);
    if (!a) {
      a = {
        workspace_id: id, usd: 0, runs_usd: 0, sessions_usd: 0, estimated_usd: 0, runs: 0, sessions: 0,
        tokens_in: 0, tokens_out: 0, turns: 0, model_minutes: 0, lines_added: 0, lines_removed: 0, blocked: 0,
      };
      byWs.set(id, a);
    }
    return a;
  };

  const byModel = new Map<string, Analytics["by_model"][number]>();
  const model = (m: string) => {
    let a = byModel.get(m);
    if (!a) { a = { model: m, usd: 0, runs: 0, sessions: 0, tokens_in: 0, tokens_out: 0, turns: 0 }; byModel.set(m, a); }
    return a;
  };
  const byStage = new Map<string, Analytics["by_stage"][number]>();
  const byBackend = new Map<string, Analytics["by_backend"][number]>();
  const backend = (b: string) => {
    let a = byBackend.get(b);
    if (!a) { a = { backend: b, usd: 0, runs: 0, sessions: 0 }; byBackend.set(b, a); }
    return a;
  };
  const byOpener = new Map<string, Analytics["by_opener"][number]>();
  const byGoalKind = new Map<string, Analytics["by_goal_kind"][number]>();
  const outcomes: Record<string, number> = {};
  const heat = new Map<string, { dow: number; hour: number; usd: number; events: number }>();
  const hit = (iso: string, usd: number) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return;
    const dow = (d.getDay() + 6) % 7; // 0 = Monday
    const hour = d.getHours();
    const k = `${dow}:${hour}`;
    let c = heat.get(k);
    if (!c) { c = { dow, hour, usd: 0, events: 0 }; heat.set(k, c); }
    c.usd += usd;
    c.events += 1;
  };
  const unpricedBackends = new Set<string>();
  const jobAcc = new Map<string, Analytics["top_jobs"][number]>();

  // ── headless runs ──
  for (const r of runsR) {
    const usd = n(r.cost_usd);
    const est = r.cost_estimated === 1;
    const tin = n(r.tokens_in), tout = n(r.tokens_out);
    const cr = n(r.cache_read), cw = n(r.cache_write);
    totals.runs_usd += usd;
    if (est) totals.estimated_usd += usd;
    totals.tokens_in += tin; totals.tokens_out += tout;
    totals.cache_read += cr; totals.cache_write += cw;
    totals.turns += n(r.num_turns);
    outcomes[r.status] = (outcomes[r.status] ?? 0) + 1;
    if (r.status === "success") totals.ok += 1;
    else if (r.status === "failed" || r.status === "timeout" || r.status === "error") totals.failed += 1;
    // A finished run with no cost is a hole in the ledger, not a free run — name the backend.
    if (r.cost_usd == null && r.ended_at) unpricedBackends.add(r.backend || "claude-code");

    const p = point(r.started_at);
    p.usd += usd; p.runs_usd += usd; p.runs += 1;
    if (est) p.estimated_usd += usd;
    p.tokens_in += tin; p.tokens_out += tout; p.cache_read += cr; p.cache_write += cw;
    p.turns += n(r.num_turns);
    p.by_ws[r.ws] = (p.by_ws[r.ws] ?? 0) + usd;

    const a = wsAcc(r.ws);
    a.usd += usd; a.runs_usd += usd; a.runs += 1; a.tokens_in += tin; a.tokens_out += tout; a.turns += n(r.num_turns);
    if (est) a.estimated_usd += usd;

    const m = model(r.model || "unknown");
    m.usd += usd; m.runs += 1; m.tokens_in += tin; m.tokens_out += tout; m.turns += n(r.num_turns);
    const b = backend(r.backend || "claude-code");
    b.usd += usd; b.runs += 1;

    const stage = stageOf(r.job_name);
    let st = byStage.get(stage);
    if (!st) { st = { stage, usd: 0, runs: 0, tokens_in: 0, tokens_out: 0, ok: 0, failed: 0 }; byStage.set(stage, st); }
    st.usd += usd; st.runs += 1; st.tokens_in += tin; st.tokens_out += tout;
    if (r.status === "success") st.ok += 1;
    else if (r.status === "failed" || r.status === "timeout" || r.status === "error") st.failed += 1;

    // Jobs are grouped by name, not id: a cron job re-created by a config change is still the same
    // line item to whoever is reading the bill.
    const jk = `${r.ws}::${r.job_name || "(unnamed)"}`;
    let j = jobAcc.get(jk);
    if (!j) {
      j = { job: r.job_name || "(unnamed)", stage, workspace_id: r.ws, usd: 0, runs: 0, ok: 0, failed: 0, tokens_in: 0, tokens_out: 0 };
      jobAcc.set(jk, j);
    }
    j.usd += usd; j.runs += 1; j.tokens_in += tin; j.tokens_out += tout;
    if (r.status === "success") j.ok += 1;
    else if (r.status === "failed" || r.status === "timeout" || r.status === "error") j.failed += 1;

    hit(r.started_at, usd);
  }

  // ── Desk terminals ──
  for (const s of sessR) {
    const usd = n(s.cost_usd);
    const est = s.cost_estimated === 1;
    const tin = n(s.tokens_in), tout = n(s.tokens_out);
    const cr = n(s.cache_read), cw = n(s.cache_write);
    totals.sessions_usd += usd;
    if (est) totals.estimated_usd += usd; else if (s.cost_usd != null) totals.priced_usd += usd;
    totals.tokens_in += tin; totals.tokens_out += tout;
    totals.cache_read += cr; totals.cache_write += cw;
    totals.turns += n(s.turns);
    totals.model_minutes += n(s.model_ms) / 60_000;
    totals.open_minutes += minutesBetween(s.created_at, s.ended_at);
    totals.lines_added += n(s.lines_added); totals.lines_removed += n(s.lines_removed);
    totals.blocked += n(s.blocked_count);
    if (s.goal_done_at) totals.goals_reached += 1;
    if (s.status === "live") totals.live_sessions += 1;

    const p = point(s.created_at);
    p.usd += usd; p.sessions_usd += usd; p.sessions += 1;
    if (est) p.estimated_usd += usd;
    p.tokens_in += tin; p.tokens_out += tout; p.cache_read += cr; p.cache_write += cw;
    p.turns += n(s.turns); p.model_minutes += n(s.model_ms) / 60_000;
    p.by_ws[s.ws] = (p.by_ws[s.ws] ?? 0) + usd;

    const a = wsAcc(s.ws);
    a.usd += usd; a.sessions_usd += usd; a.sessions += 1;
    if (est) a.estimated_usd += usd;
    a.tokens_in += tin; a.tokens_out += tout; a.turns += n(s.turns);
    a.model_minutes += n(s.model_ms) / 60_000;
    a.lines_added += n(s.lines_added); a.lines_removed += n(s.lines_removed);
    a.blocked += n(s.blocked_count);

    const m = model(s.model || "unknown");
    m.usd += usd; m.sessions += 1; m.tokens_in += tin; m.tokens_out += tout; m.turns += n(s.turns);
    const b = backend(s.backend || "claude-code");
    b.usd += usd; b.sessions += 1;

    const opener = s.agent_name || s.created_by || "operator";
    let o = byOpener.get(opener);
    if (!o) { o = { opener, sessions: 0, usd: 0, turns: 0, model_minutes: 0 }; byOpener.set(opener, o); }
    o.sessions += 1; o.usd += usd; o.turns += n(s.turns); o.model_minutes += n(s.model_ms) / 60_000;

    const kind = s.goal_kind || "unset";
    let g = byGoalKind.get(kind);
    if (!g) { g = { kind, sessions: 0, usd: 0, reached: 0 }; byGoalKind.set(kind, g); }
    g.sessions += 1; g.usd += usd; if (s.goal_done_at) g.reached += 1;

    if (s.cost_usd == null && s.ended_at) unpricedBackends.add(s.backend || "claude-code");
    hit(s.created_at, usd);
  }

  totals.usd = round2(totals.runs_usd + totals.sessions_usd);
  totals.runs_usd = round2(totals.runs_usd);
  totals.sessions_usd = round2(totals.sessions_usd);
  totals.estimated_usd = round2(totals.estimated_usd);
  // Metered dollars only: vendor totals on runs + non-estimated Desk sessions.
  const estimatedRunsUsd = runsR.reduce((s, r) => s + (r.cost_estimated === 1 ? n(r.cost_usd) : 0), 0);
  totals.priced_usd = round2(totals.priced_usd + (totals.runs_usd - estimatedRunsUsd));
  totals.tokens_total = totals.tokens_in + totals.tokens_out + totals.cache_read + totals.cache_write;
  totals.model_minutes = Math.round(totals.model_minutes);
  const decided = totals.ok + totals.failed;
  totals.success_rate = decided ? Math.round((totals.ok / decided) * 100) : null;

  for (const p of points.values()) {
    p.usd = round2(p.usd); p.runs_usd = round2(p.runs_usd); p.sessions_usd = round2(p.sessions_usd);
    p.estimated_usd = round2(p.estimated_usd);
    p.model_minutes = Math.round(p.model_minutes);
    for (const k of Object.keys(p.by_ws)) p.by_ws[k] = round2(p.by_ws[k]);
  }
  const series = [...points.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));

  // Today's spend per workspace rides along so a budget bar can be drawn whatever window is picked —
  // `daily_budget_usd` is a property of today, not of the window you happen to be looking at.
  const todayFrom = startOfDay(opts.now ?? new Date()).toISOString();
  const todayTo = addDays(startOfDay(opts.now ?? new Date()), 1).toISOString();
  const todayByWs = new Map<string, number>();
  for (const r of runRows(todayFrom, todayTo, ws)) todayByWs.set(r.ws, (todayByWs.get(r.ws) ?? 0) + n(r.cost_usd));
  for (const s of sessionRows(todayFrom, todayTo, ws)) todayByWs.set(s.ws, (todayByWs.get(s.ws) ?? 0) + n(s.cost_usd));

  const by_workspace: WorkspaceRow[] = [...byWs.values()]
    .map((a) => {
      const w = wsById.get(a.workspace_id);
      return {
        ...a,
        usd: round2(a.usd), runs_usd: round2(a.runs_usd), sessions_usd: round2(a.sessions_usd),
        estimated_usd: round2(a.estimated_usd), model_minutes: Math.round(a.model_minutes),
        name: w?.name ?? (a.workspace_id ? "(deleted)" : "Unscoped"),
        slug: w?.slug ?? (a.workspace_id ? a.workspace_id.slice(0, 8) : "unscoped"),
        kind: w?.kind ?? null,
        daily_budget_usd: w?.daily_budget_usd ?? null,
        today_usd: round2(todayByWs.get(a.workspace_id) ?? 0),
        share: totals.usd > 0 ? Math.round((a.usd / totals.usd) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.usd - a.usd || b.sessions + b.runs - (a.sessions + a.runs));

  const top_terminals = sessR
    .map((s) => ({
      id: s.id,
      started: s.created_at,
      ended: s.ended_at,
      live: s.status === "live",
      workspace_id: s.ws,
      title: s.goal || s.spawn_goal || s.title || "(no goal)",
      usd: round2(n(s.cost_usd)),
      estimated: s.cost_estimated === 1,
      turns: n(s.turns),
      tokens_in: n(s.tokens_in),
      tokens_out: n(s.tokens_out),
      context_peak: n(s.context_peak),
      minutes: minutesBetween(s.created_at, s.ended_at),
      model_minutes: Math.round((n(s.model_ms) / 60_000) * 10) / 10,
      lines_added: n(s.lines_added),
      lines_removed: n(s.lines_removed),
      opened_by: s.agent_name || s.created_by || "operator",
      model: s.model,
      backend: s.backend,
      branch: s.branch,
      reached: !!s.goal_done_at,
      blocked: n(s.blocked_count),
    }))
    .sort((a, b) => b.usd - a.usd || b.turns - a.turns)
    .slice(0, top);

  return {
    range: { ...range, workspace_id: ws ?? null },
    totals,
    previous: (() => {
      // The same length of time immediately before the window — "is this month worse than last?"
      const span = new Date(range.to).getTime() - new Date(range.from).getTime();
      const prevTo = range.from;
      const prevFrom = new Date(new Date(range.from).getTime() - span).toISOString();
      return windowTotals(prevFrom, prevTo, ws);
    })(),
    delta: { usd: null, tokens_total: null, runs: null, sessions: null }, // filled below
    series,
    by_workspace,
    by_model: [...byModel.values()].map((m) => ({ ...m, usd: round2(m.usd) })).sort((a, b) => b.usd - a.usd),
    by_stage: [...byStage.values()].map((s) => ({ ...s, usd: round2(s.usd) })).sort((a, b) => b.usd - a.usd),
    by_backend: [...byBackend.values()].map((b) => ({ ...b, usd: round2(b.usd) })).sort((a, b) => b.usd - a.usd),
    by_opener: [...byOpener.values()]
      .map((o) => ({ ...o, usd: round2(o.usd), model_minutes: Math.round(o.model_minutes) }))
      .sort((a, b) => b.usd - a.usd || b.sessions - a.sessions),
    by_goal_kind: [...byGoalKind.values()].map((g) => ({ ...g, usd: round2(g.usd) })).sort((a, b) => b.sessions - a.sessions),
    outcomes,
    heat: [...heat.values()].map((h) => ({ ...h, usd: round2(h.usd) })),
    top_terminals,
    top_jobs: [...jobAcc.values()].map((j) => ({ ...j, usd: round2(j.usd) })).sort((a, b) => b.usd - a.usd).slice(0, top),
    coverage: {
      priced_usd: totals.priced_usd,
      estimated_usd: totals.estimated_usd,
      unpriced_runs: runsR.filter((r) => r.cost_usd == null && r.ended_at).length,
      unpriced_sessions: sessR.filter((s) => s.cost_usd == null && s.ended_at).length,
      estimated_runs: runsR.filter((r) => r.cost_estimated === 1 && r.cost_usd != null).length,
      estimated_sessions: sessR.filter((s) => s.cost_estimated === 1 && s.cost_usd != null).length,
      unpriced_backends: [...unpricedBackends].sort(),
    },
    workspaces: (opts.scope_ws ? wsList.filter((w: any) => w.id === opts.scope_ws) : wsList).map((w: any) => ({
      id: w.id, name: w.name, slug: w.slug, kind: w.kind, archived: !!w.archived,
    })),
    generated_at: new Date().toISOString(),
  };
}

/** `analytics()` with the previous-period deltas computed — what every caller actually wants. */
export function analyticsWithDelta(opts: Parameters<typeof analytics>[0] = {}): Analytics {
  const a = analytics(opts);
  a.delta = {
    usd: pct(a.totals.usd, a.previous.usd),
    tokens_total: pct(a.totals.tokens_total, a.previous.tokens_total),
    runs: pct(a.totals.runs, a.previous.runs),
    sessions: pct(a.totals.sessions, a.previous.sessions),
  };
  return a;
}
