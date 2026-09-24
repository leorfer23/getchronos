/**
 * Memory usage telemetry — evidence of which workspace memory agents actually use.
 *
 * The nightly dream pass ranks, compacts and prunes memory (★ memory-index, memory-<topic> branches,
 * session-learnings, lessons, skills). Before this, the only usage signal was `lessons.hits`: nobody
 * could tell a memo read every day from one nobody has opened since it was written. So every door
 * memory leaves through writes a row here (store/memory-usage.ts):
 *
 *  - `mc recall`              → the query (+ how many hits) and one row per hit
 *  - `mc memo get` / `skill view` → the memo/skill an agent opened in full
 *  - relevanceBlock           → the memos/skills put in front of a fresh agent at dispatch/spawn
 *
 * Desk renders do not count: the Desk reads /notes and /notes/:id without `?use=1`, the CLI passes it.
 *
 * Recording is best-effort. It sits on the request path of recall and memo reads, so a failure is
 * logged and swallowed — telemetry must never be the reason an agent could not read its memory.
 */
import type express from "express";
import { CONFIG } from "./config.js";
import { checkScope } from "./authz.js";
import { memoryUsage, notes, skills, sessions, lessons, workspaces } from "./store.js";
import type { MemoryUsageAggregate, MemoryUsageKind, MemoryUsageMiss, NewMemoryUsage } from "./store.js";
import type { RecallHit } from "./recall.js";

export type UsageSource = "api" | "command" | "dispatch" | "spawn";
export interface UsageVia {
  source: UsageSource;
  session_id?: string | null;
}

function safely(what: string, fn: () => void): void {
  try { fn(); } catch (e: any) { console.warn(`[memory-usage] ${what}: ${e?.message ?? e}`); }
}

/**
 * A caller-supplied session id is only kept when that session lives in the same workspace — a
 * terminal must not be able to stamp its reads onto another workspace's session.
 */
export function sessionFor(workspace_id: string, sid: unknown): string | null {
  if (typeof sid !== "string" || !sid) return null;
  try {
    const s = sessions.get(sid);
    return s && s.workspace_id === workspace_id ? s.id : null;
  } catch { return null; }
}

/** One recall: the query itself, then one row per hit it returned. */
export function recordRecall(workspace_id: string, q: string, hits: RecallHit[], via: UsageVia): void {
  const query = q.trim();
  if (!workspace_id || !query) return;
  safely("recall", () => {
    const base = { workspace_id, query, source: via.source, session_id: via.session_id ?? null };
    const rows: NewMemoryUsage[] = [{ ...base, kind: "recall", hits: hits.length }];
    for (const h of hits) {
      if (!h.source_ref) continue;
      rows.push({ ...base, kind: "recall_hit", ref_kind: h.kind, ref: h.source_ref });
    }
    memoryUsage.addMany(rows);
  });
}

/** An agent opened one memo or skill in full. */
export function recordRead(
  workspace_id: string,
  what: { kind: Extract<MemoryUsageKind, "memo_get" | "skill_view">; ref: string },
  via: UsageVia,
): void {
  if (!workspace_id) return;
  safely(what.kind, () => memoryUsage.add({
    workspace_id, kind: what.kind, ref_kind: what.kind === "memo_get" ? "note" : "skill", ref: what.ref,
    source: via.source, session_id: via.session_id ?? null,
  }));
}

/** The memos/skills relevanceBlock surfaced into a fresh agent's prompt. */
export function recordRelevance(workspace_id: string, refs: { kind: "note" | "skill"; ref: string }[], via: UsageVia): void {
  if (!workspace_id || !refs.length) return;
  safely("relevance", () => memoryUsage.addMany(refs.map((r) => ({
    workspace_id, kind: "relevance_inject" as const, ref_kind: r.kind, ref: r.ref,
    source: via.source, session_id: via.session_id ?? null,
  }))));
}

// ───────────────────────────── reading it back ─────────────────────────────

/** `7d` / `24h` / `30m` / an ISO timestamp → ISO. Anything else → null (the caller's default applies). */
export function parseSince(raw: unknown, nowMs = Date.now()): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();
  const rel = /^(\d+)\s*([mhdw])$/i.exec(s);
  if (rel) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2].toLowerCase() as "m" | "h" | "d" | "w"];
    return new Date(nowMs - Number(rel[1]) * unit).toISOString();
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export type UsageRef = MemoryUsageAggregate & {
  /** A human handle for the ref (memo/skill slug, lesson topic, session title) — null once the source is gone. */
  label: string | null;
};

export interface UsageReport {
  workspace_id: string;
  since: string;
  recalls: number;
  refs: UsageRef[];
  misses: MemoryUsageMiss[];
}

function labelOf(workspace_id: string, a: MemoryUsageAggregate): string | null {
  // Labels are resolved inside the same wall: a ref whose row moved to another workspace (or is
  // gone) keeps its id but loses its label, rather than leaking the other side's name.
  const own = <T extends { workspace_id: string | null }>(r: T | undefined) => (r && r.workspace_id === workspace_id ? r : undefined);
  switch (a.ref_kind) {
    case "note": return own(notes.get(a.ref))?.slug ?? null;
    case "skill": return own(skills.get(a.ref))?.slug ?? null;
    case "lesson": { const l = own(lessons.get(a.ref)); return l ? `[${l.topic}] ${l.rule.slice(0, 60)}` : null; }
    case "session": return own(sessions.get(a.ref))?.title ?? null;
    default: return null;
  }
}

export const DEFAULT_SINCE_DAYS = 30;

/** Per-ref usage for ONE workspace since `since` (default 30 days). What the dream pass reads. */
export function usageReport(workspace_id: string, since?: string | null, nowMs = Date.now()): UsageReport {
  const from = since ?? new Date(nowMs - DEFAULT_SINCE_DAYS * 86_400_000).toISOString();
  return {
    workspace_id,
    since: from,
    recalls: memoryUsage.recallCount(workspace_id, from),
    refs: memoryUsage.aggregate(workspace_id, from).map((a) => ({ ...a, label: labelOf(workspace_id, a) })),
    misses: memoryUsage.misses(workspace_id, from),
  };
}

/**
 * GET /workspaces/:id/memory/usage. Admin or that workspace's own token — the checkScope wall.
 * A handler (not an inline route) so the wall is tested against the real code path.
 */
export function usageRoute(req: express.Request, res: express.Response): void {
  if (!checkScope(req, res, req.params.id)) return;
  if (!workspaces.get(req.params.id)) { res.status(404).json({ error: "workspace not found" }); return; }
  const raw = req.query?.since;
  const since = parseSince(raw);
  if (raw != null && raw !== "" && since == null) { res.status(400).json({ error: "since must be an ISO timestamp or like 7d / 24h" }); return; }
  res.json(usageReport(req.params.id, since));
}

// ───────────────────────────── retention ─────────────────────────────

/** Drop usage rows older than the retention window. Called from the monitor's retention sweep. */
export function pruneMemoryUsage(nowMs = Date.now(), days = CONFIG.memoryUsageRetainDays): number {
  if (!(days > 0)) return 0;
  return memoryUsage.pruneBefore(new Date(nowMs - days * 86_400_000).toISOString());
}
