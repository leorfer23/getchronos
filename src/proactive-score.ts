/**
 * Was it worth opening? A score for every terminal the daemon opens on its own.
 *
 * Proactivity failed twice here as noise: Robert's messages went unread by the thousand, and of the
 * inbox's auto-opened terminals only about a quarter reached an outcome, against most of the ones the
 * operator opened himself. The rule we hold every proactive surface to: after a week, count how many
 * of its offers he was glad to get. This module does the counting, per workspace × kind, and lets
 * the newest proactive openers back off where he ignores them.
 *
 *  - **Kind** = who opened it (`sessions.created_by`): inbox, ship, job-check, follow-up, continuation,
 *    robert, lead (any `lead:<id8>`), … — and `proactive` for Robert's self-started ones (tag
 *    `proactive`). The operator's own terminals are not offers; neither is a failover or a cloud
 *    handoff (each replaces a terminal that already existed).
 *  - **Buckets.** engaged = he typed into it (sessions.operator_inputs, persisted here) · useful = it
 *    reached its goal or filed a hand-off without him typing · ignored = neither, and ended (or live
 *    and untouched for 24h) · pending = live, younger than 24h, untouched. rate = (engaged + useful) /
 *    decided, decided = opened − pending.
 *  - **The gate.** Only `ship` and `proactive` are gated (GATED_KINDS): over the last 7 days in a
 *    workspace, ≥ 8 decided and rate < 30% → that kind stops opening there until the window improves.
 *    Nothing sticky: the query is the state. Every other kind is measured only — the operator chose
 *    those openers himself, and turning one off is his call (`mc proactive` shows him the numbers).
 *    `robert.proactive_autotune` off → always allowed.
 */
import { db, kv, sessions, workspaces } from "./store.js";
import { settingOn } from "./settings.js";
import type { CallerScope } from "./authz.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** A live terminal nobody touched for this long is ignored, not pending. */
export const PENDING_MS = DAY;
export const BACKOFF_DAYS = 7;
export const BACKOFF_MIN_DECIDED = 8;
export const BACKOFF_RATE = 0.3;
/** The kinds proactiveAllowed can say no to. Everything else is scored, never stopped. */
export const GATED_KINDS: ReadonlySet<string> = new Set(["ship", "proactive"]);
/** Openers that replace a terminal rather than offer one. */
const NOT_OFFERS = new Set(["operator", "failover", "handoff"]);

function hasTag(tags: string | string[] | null | undefined, tag: string): boolean {
  if (!tags) return false;
  if (Array.isArray(tags)) return tags.includes(tag);
  try {
    const v = JSON.parse(tags);
    if (Array.isArray(v)) return v.map(String).includes(tag);
  } catch { /* not JSON: a plain comma list */ }
  return tags.split(",").map((t) => t.trim()).includes(tag);
}

/** What kind of offer this terminal was, or null when it was not one (the operator's own, a failover). */
export function proactiveKind(s: { created_by?: string | null; tags?: string | string[] | null }): string | null {
  const by = (s.created_by ?? "").trim() || "operator";
  if (NOT_OFFERS.has(by)) return null;
  if (by === "robert" && hasTag(s.tags, "proactive")) return "proactive";
  if (by.startsWith("lead:")) return "lead";
  return by;
}

export type Bucket = "engaged" | "useful" | "ignored" | "pending";
type Row = {
  workspace_id: string | null;
  created_by: string | null;
  tags: string | null;
  status: string;
  created_at: string;
  goal_done_at: string | null;
  outcome: string | null;
  operator_inputs: number | null;
};

/** One terminal's verdict. Pure. */
export function bucketOf(r: Pick<Row, "status" | "created_at" | "goal_done_at" | "outcome" | "operator_inputs">, nowMs = Date.now()): Bucket {
  if ((r.operator_inputs ?? 0) > 0) return "engaged";
  if (r.goal_done_at || (r.outcome && r.outcome !== "null")) return "useful";
  if (r.status !== "live") return "ignored";
  return nowMs - Date.parse(r.created_at) >= PENDING_MS ? "ignored" : "pending";
}

export type EngagementRow = {
  workspace_id: string | null;
  workspace: string | null;
  kind: string;
  opened: number;
  engaged: number;
  useful: number;
  ignored: number;
  pending: number;
  decided: number;
  /** (engaged + useful) / decided; null while nothing is decided. */
  rate: number | null;
};

/**
 * When counting began: migration 154's time on a DB that already had terminals (their operator input
 * was never recorded, so they would all read as ignored), else null — every row counts.
 */
export function countedSince(): string | null {
  try { return kv.get("proactive.counted_since") ?? null; } catch { return null; }
}

/** Per workspace × kind over the last `days` (default 7), never before countedSince(). */
export function engagement(opts: { days?: number; workspace_id?: string; nowMs?: number } = {}): EngagementRow[] {
  const nowMs = opts.nowMs ?? Date.now();
  const window = new Date(nowMs - (opts.days ?? BACKOFF_DAYS) * DAY).toISOString();
  const floor = countedSince();
  const since = floor && floor > window ? floor : window;
  const params: unknown[] = [since];
  let sql =
    "SELECT workspace_id, created_by, tags, status, created_at, goal_done_at, outcome, operator_inputs FROM sessions " +
    "WHERE created_at >= ? AND created_by IS NOT NULL AND created_by != 'operator'";
  if (opts.workspace_id) { sql += " AND workspace_id = ?"; params.push(opts.workspace_id); }
  const rows = db.prepare(sql).all(...params) as Row[];
  const out = new Map<string, EngagementRow>();
  for (const r of rows) {
    const kind = proactiveKind(r);
    if (!kind) continue;
    const key = `${r.workspace_id ?? ""}\u0000${kind}`;
    let e = out.get(key);
    if (!e) {
      e = { workspace_id: r.workspace_id, workspace: null, kind, opened: 0, engaged: 0, useful: 0, ignored: 0, pending: 0, decided: 0, rate: null };
      out.set(key, e);
    }
    e.opened++;
    e[bucketOf(r, nowMs)]++;
  }
  const slugs = new Map<string, string | null>();
  const slug = (id: string | null) => {
    if (!id) return null;
    if (!slugs.has(id)) slugs.set(id, workspaces.get(id)?.slug ?? null);
    return slugs.get(id)!;
  };
  return [...out.values()]
    .map((e) => {
      e.decided = e.opened - e.pending;
      e.rate = e.decided > 0 ? (e.engaged + e.useful) / e.decided : null;
      e.workspace = slug(e.workspace_id);
      return e;
    })
    .sort((a, b) => (a.workspace ?? "").localeCompare(b.workspace ?? "") || b.opened - a.opened || a.kind.localeCompare(b.kind));
}

/** Below the bar: enough decided to judge, and too few of them worth it. Pure over one 7-day row. */
export function belowBar(r: Pick<EngagementRow, "decided" | "rate"> | undefined): boolean {
  return !!r && r.decided >= BACKOFF_MIN_DECIDED && r.rate !== null && r.rate < BACKOFF_RATE;
}

const backedOffSeen = new Set<string>();
export function resetProactiveScore(): void {
  backedOffSeen.clear();
}

/**
 * May the daemon open (or type) an offer of this kind in this workspace now? Ungated kinds and the
 * setting off → always yes. Logs once when a (workspace, kind) flips to backed off, and forgets it
 * when it recovers so the next flip logs again.
 */
export function proactiveAllowed(kind: string, wsId: string, nowMs = Date.now()): boolean {
  if (!GATED_KINDS.has(kind)) return true;
  if (!settingOn("robert.proactive_autotune", wsId)) return true;
  const row = engagement({ days: BACKOFF_DAYS, workspace_id: wsId, nowMs }).find((r) => r.kind === kind);
  const key = `${wsId}\u0000${kind}`;
  if (!belowBar(row)) {
    backedOffSeen.delete(key);
    return true;
  }
  if (!backedOffSeen.has(key)) {
    backedOffSeen.add(key);
    const ws = workspaces.get(wsId)?.slug ?? wsId.slice(0, 8);
    console.log(
      `[proactive] ${ws}: backing off "${kind}" — ${row!.engaged + row!.useful} of ${row!.decided} decided in ${BACKOFF_DAYS}d were engaged or useful (${Math.round((row!.rate ?? 0) * 100)}% < ${BACKOFF_RATE * 100}%); resumes when the week improves`,
    );
  }
  return false;
}

// ──────────────────────────── the read surface ────────────────────────────

export type StatsRow = EngagementRow & { gated: boolean; backed_off: boolean; below_bar: boolean };

/**
 * GET /api/proactive/stats. Workspace scoping is the security boundary (CLAUDE.md #4): a workspace
 * token reads only its own workspace — naming another is the same 404 an unknown one gets.
 */
export function proactiveStats(
  scope: CallerScope,
  q: { days?: unknown; workspace?: unknown },
  nowMs = Date.now(),
): { status: number; body: unknown } {
  if (scope === null) return { status: 401, body: { error: "invalid workspace token" } };
  const daysRaw = Number(q.days ?? BACKOFF_DAYS);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(90, daysRaw) : BACKOFF_DAYS;
  let wsId: string | undefined = scope.ws ?? undefined;
  const asked = typeof q.workspace === "string" && q.workspace && q.workspace !== "all" ? q.workspace : null;
  if (asked) {
    const ws = workspaces.get(asked) ?? workspaces.getBySlug(asked);
    if (!ws || (scope.ws !== null && ws.id !== scope.ws)) return { status: 404, body: { error: "not found" } };
    wsId = ws.id;
  }
  const rows = engagement({ days, workspace_id: wsId, nowMs });
  // The gate always reads the 7-day window, whatever window the caller asked to look at.
  const week = days === BACKOFF_DAYS ? rows : engagement({ days: BACKOFF_DAYS, workspace_id: wsId, nowMs });
  const weekOf = (r: EngagementRow) => week.find((w) => w.workspace_id === r.workspace_id && w.kind === r.kind);
  const out: StatsRow[] = rows.map((r) => {
    const gated = GATED_KINDS.has(r.kind);
    const below = belowBar(weekOf(r));
    const on = !!r.workspace_id && settingOn("robert.proactive_autotune", r.workspace_id);
    return { ...r, gated, below_bar: below, backed_off: gated && below && on };
  });
  return { status: 200, body: { days, workspace_id: wsId ?? null, counted_since: countedSince(), rows: out } };
}

// ──────────────────────────── operator engagement, persisted ────────────────────────────

/** At most one write per terminal per window; the counts in between ride the next write. */
export const INPUT_FLUSH_MS = 30_000;
type Pending = { n: number; atMs: number; timer: ReturnType<typeof setTimeout> | null };
const pendingInputs = new Map<string, Pending>();
type InputWriter = (sessionId: string, n: number, atIso: string) => void;
let writeInputs: InputWriter = (id, n, at) => sessions.addOperatorInputs(id, n, at);
/** Tests swap the DB write; null restores it. */
export function setOperatorInputWriter(fn: InputWriter | null): void {
  writeInputs = fn ?? ((id, n, at) => sessions.addOperatorInputs(id, n, at));
}

function write(id: string, n: number, atMs: number): void {
  try { writeInputs(id, n, new Date(atMs).toISOString()); }
  catch (e: any) { console.warn(`[proactive] could not record operator input on ${id.slice(0, 8)}: ${e?.message ?? e}`); }
}

function arm(id: string, p: Pending): void {
  p.timer = setTimeout(() => {
    p.timer = null;
    if (p.n > 0) {
      write(id, p.n, p.atMs);
      p.n = 0;
      arm(id, p);
    } else pendingInputs.delete(id);
  }, INPUT_FLUSH_MS);
  p.timer.unref?.();
}

/**
 * The operator's own input reached this terminal: one Desk-pane keystroke frame, one composer send,
 * one notification tap. The first one in a quiet window is written at once (so "he engaged" survives
 * a crash a second later); the rest are counted and written when the window closes.
 *
 * Call it ONLY on the operator's paths — never from sendInput, which every daemon hand also uses.
 */
export function noteOperatorInput(sessionId: string, nowMs = Date.now()): void {
  if (!sessionId) return;
  const p = pendingInputs.get(sessionId);
  if (p) {
    p.n++;
    p.atMs = nowMs;
    return;
  }
  const fresh: Pending = { n: 0, atMs: nowMs, timer: null };
  pendingInputs.set(sessionId, fresh);
  write(sessionId, 1, nowMs);
  arm(sessionId, fresh);
}

/**
 * Is this Desk-pane frame his typing? xterm also sends frames nobody typed — cursor-position and
 * device-attribute replies, focus in/out, mouse reports while he scrolls a fullscreen TUI — and every
 * one of them starts with ESC. So do arrow keys; the Enter that follows them is what counts.
 */
export function handTyped(d: unknown): boolean {
  return typeof d === "string" && d.length > 0 && d[0] !== "\x1b";
}

/** Write every pending count now and drop the windows (shutdown, tests). */
export function flushOperatorInputs(): void {
  for (const [id, p] of pendingInputs) {
    if (p.timer) clearTimeout(p.timer);
    if (p.n > 0) write(id, p.n, p.atMs);
  }
  pendingInputs.clear();
}
