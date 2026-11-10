import { randomUUID } from "node:crypto";
import { db } from "./db.js";

/**
 * Stuck-work alerts (src/stuck-alerts.ts) — one row per episode the operator was told about.
 *
 * The row is written BEFORE anything is sent, and it is the only memory the ladder has: which rungs
 * ran (`channels`), when the next one is due (`next_at`), whether he acknowledged it. A daemon restart
 * therefore resumes an alert half-way up the ladder instead of forgetting it, and never repeats one
 * he already got — the partial unique index (subject, kind) WHERE resolved_at IS NULL allows exactly
 * one open episode per thing per kind.
 *
 * The timestamps are separate facts on purpose, not one status:
 *   - `stuck_since`  when the thing got stuck (term-status `since`, the run's end, the failover event)
 *   - `raised_at`    when the daemon decided to tell him (after the grace / Robert's chance)
 *   - `delivered_at` the first rung that confirmed delivery (a voice surface spoke it, the push
 *                    service accepted it, Telegram accepted it)
 *   - `acked_at`     he opened it, answered the terminal, tapped "got it" or replied on the call
 *   - `resolved_at`  the episode ended (the terminal moved on, the host came back, the job passed)
 */
export type AlertKind = "decide" | "blocked" | "stalled" | "wall" | "host" | "job_failed" | "summary";
export type AlertRung = "voice" | "push" | "telegram";
/** active = the ladder is running · done = it ran out of rungs · capped = folded into a summary. */
export type AlertState = "active" | "done" | "acked" | "resolved" | "capped";
export type AlertChannel = { rung: AlertRung; at: string; ok: boolean | null; detail?: string | null };

export interface AlertRow {
  id: string;
  subject: string;
  kind: AlertKind;
  workspace_id: string | null;
  session_id: string | null;
  run_id: string | null;
  job_id: string | null;
  host_id: string | null;
  reason: string | null;
  title: string;
  text: string;
  lang: string;
  state: AlertState;
  stuck_since: string;
  raised_at: string;
  next_at: number | null;
  channels: AlertChannel[];
  meta: Record<string, any>;
  delivered_at: string | null;
  delivered_via: string | null;
  acked_at: string | null;
  acked_via: string | null;
  resolved_at: string | null;
  summary_id: string | null;
  selfcheck: boolean;
  created_at: string;
  updated_at: string;
}

export type NewAlert = Pick<AlertRow, "subject" | "kind" | "title" | "text" | "lang" | "state"> & {
  workspace_id?: string | null;
  session_id?: string | null;
  run_id?: string | null;
  job_id?: string | null;
  host_id?: string | null;
  reason?: string | null;
  stuck_since: number;
  next_at?: number | null;
  meta?: Record<string, unknown>;
  summary_id?: string | null;
  selfcheck?: boolean;
};

const iso = (ms: number) => new Date(ms).toISOString();

function hydrate(r: any): AlertRow | undefined {
  if (!r) return undefined;
  let channels: AlertChannel[] = [];
  let meta: Record<string, any> = {};
  try { channels = JSON.parse(r.channels || "[]"); } catch {}
  try { meta = r.meta ? JSON.parse(r.meta) : {}; } catch {}
  return { ...r, channels, meta, selfcheck: !!r.selfcheck } as AlertRow;
}
const all = (rows: any[]) => rows.map((r) => hydrate(r)!);

export const alerts = {
  /**
   * Write a new episode. Null when one is already open for this subject and kind — the unique index
   * decides, so two raises racing for the same stop produce one row, not two alerts.
   */
  insert(a: NewAlert, nowMs = Date.now()): AlertRow | null {
    const id = randomUUID();
    const at = iso(nowMs);
    try {
      db.prepare(
        `INSERT INTO alerts (id,subject,kind,workspace_id,session_id,run_id,job_id,host_id,reason,title,text,lang,state,
           stuck_since,raised_at,next_at,channels,meta,summary_id,selfcheck,created_at,updated_at)
         VALUES (@id,@subject,@kind,@workspace_id,@session_id,@run_id,@job_id,@host_id,@reason,@title,@text,@lang,@state,
           @stuck_since,@raised_at,@next_at,'[]',@meta,@summary_id,@selfcheck,@at,@at)`,
      ).run({
        id, subject: a.subject, kind: a.kind, workspace_id: a.workspace_id ?? null, session_id: a.session_id ?? null,
        run_id: a.run_id ?? null, job_id: a.job_id ?? null, host_id: a.host_id ?? null, reason: a.reason ?? null,
        title: a.title, text: a.text, lang: a.lang, state: a.state, stuck_since: iso(a.stuck_since), raised_at: at,
        next_at: a.next_at ?? null, meta: a.meta ? JSON.stringify(a.meta) : null, summary_id: a.summary_id ?? null,
        selfcheck: a.selfcheck ? 1 : 0, at,
      });
    } catch (e: any) {
      if (/UNIQUE constraint failed/i.test(String(e?.message))) return null;
      throw e;
    }
    return alerts.get(id)!;
  },

  get(id: string): AlertRow | undefined {
    return hydrate(db.prepare("SELECT * FROM alerts WHERE id = ?").get(id));
  },

  /** Full id or its first 8 characters (a Telegram button carries 8). */
  find(idOrPrefix: string): AlertRow | undefined {
    const ref = String(idOrPrefix ?? "").trim();
    if (!ref) return undefined;
    return alerts.get(ref) ?? (ref.length >= 8 ? hydrate(db.prepare("SELECT * FROM alerts WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1").get(ref + "%")) : undefined);
  },

  /** The open episode for this thing and kind, if any. */
  openFor(subject: string, kind: string): AlertRow | undefined {
    return hydrate(db.prepare("SELECT * FROM alerts WHERE subject = ? AND kind = ? AND resolved_at IS NULL").get(subject, kind));
  },

  openForSubject(subject: string): AlertRow[] {
    return all(db.prepare("SELECT * FROM alerts WHERE subject = ? AND resolved_at IS NULL").all(subject));
  },

  /** Rows the ladder owes a step to. A closed episode keeps its `next_at` (a flicker may reopen it) but is never due. */
  due(nowMs: number): AlertRow[] {
    return all(db.prepare(
      "SELECT * FROM alerts WHERE next_at IS NOT NULL AND next_at <= ? AND resolved_at IS NULL AND state = 'active' ORDER BY next_at",
    ).all(nowMs));
  },

  /** Told about a terminal, not acknowledged, episode still open: a keystroke in it would be his answer. */
  awaitingAck(): AlertRow[] {
    return all(db.prepare(
      "SELECT * FROM alerts WHERE session_id IS NOT NULL AND acked_at IS NULL AND resolved_at IS NULL AND state IN ('active','done')",
    ).all());
  },

  /** A row of this subject and kind that closed after `sinceMs` — a flicker is the same episode. */
  recentlyResolved(subject: string, kind: string, sinceMs: number): AlertRow | undefined {
    return hydrate(db.prepare(
      "SELECT * FROM alerts WHERE subject = ? AND kind = ? AND resolved_at IS NOT NULL AND resolved_at >= ? ORDER BY resolved_at DESC LIMIT 1",
    ).get(subject, kind, iso(sinceMs)));
  },

  /** Alerts the operator was told one by one since then — what the hourly cap counts. Summaries and capped rows do not. */
  toldSince(sinceMs: number): number {
    return (db.prepare(
      "SELECT COUNT(*) AS n FROM alerts WHERE created_at >= ? AND kind != 'summary' AND state != 'capped' AND summary_id IS NULL",
    ).get(iso(sinceMs)) as { n: number }).n;
  },

  /** The summary still collecting capped alerts (not sent yet), if any. */
  pendingSummary(): AlertRow | undefined {
    return hydrate(db.prepare(
      "SELECT * FROM alerts WHERE kind = 'summary' AND resolved_at IS NULL AND state = 'active' AND channels = '[]' ORDER BY created_at DESC LIMIT 1",
    ).get());
  },

  lastSummary(): AlertRow | undefined {
    return hydrate(db.prepare("SELECT * FROM alerts WHERE kind = 'summary' ORDER BY created_at DESC LIMIT 1").get());
  },

  carriedBy(summaryId: string): AlertRow[] {
    return all(db.prepare("SELECT * FROM alerts WHERE summary_id = ? ORDER BY created_at").all(summaryId));
  },

  list(opts: { sinceMs?: number; limit?: number; kind?: string } = {}): AlertRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.sinceMs != null) { where.push("created_at >= ?"); params.push(iso(opts.sinceMs)); }
    if (opts.kind) { where.push("kind = ?"); params.push(opts.kind); }
    params.push(Math.max(1, Math.min(1000, opts.limit ?? 200)));
    return all(db.prepare(
      `SELECT * FROM alerts${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`,
    ).all(...params));
  },

  update(id: string, patch: Partial<Pick<AlertRow,
    "state" | "next_at" | "title" | "text" | "lang" | "reason" | "delivered_at" | "delivered_via" | "acked_at" | "acked_via" | "resolved_at" | "summary_id"
  >> & { meta?: Record<string, unknown> }, nowMs = Date.now()): void {
    const cols: string[] = [];
    const params: Record<string, unknown> = { id, updated_at: iso(nowMs) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      cols.push(`${k} = @${k}`);
      params[k] = k === "meta" ? JSON.stringify(v) : v;
    }
    if (!cols.length) return;
    db.prepare(`UPDATE alerts SET ${cols.join(", ")}, updated_at = @updated_at WHERE id = @id`).run(params);
  },

  /**
   * Record one rung's attempt. It replaces the entry `replaces` matches — by default a still-pending
   * one for the same rung (a call that was asked to speak and has now answered, or never did).
   */
  setChannel(id: string, ch: AlertChannel, nowMs = Date.now(), replaces?: (c: AlertChannel) => boolean): void {
    const row = alerts.get(id);
    if (!row) return;
    const match = replaces ?? ((c: AlertChannel) => c.rung === ch.rung && c.ok === null);
    // In place, so the list stays in the order the rungs were tried.
    const i = row.channels.findIndex(match);
    const next = i >= 0 ? row.channels.map((c, j) => (j === i ? ch : c)) : [...row.channels, ch];
    db.prepare("UPDATE alerts SET channels = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), iso(nowMs), id);
  },

  /**
   * Close every open episode of this subject (one kind, or all of them but `except`). The ladder stops
   * because `due()` skips closed rows; `next_at` is kept so a flicker can reopen it on the same clock.
   */
  resolve(subject: string, kind: string | null, nowMs = Date.now(), except: string | null = null): AlertRow[] {
    const open = alerts.openForSubject(subject).filter((r) => (kind == null || r.kind === kind) && r.kind !== except);
    for (const r of open) {
      db.prepare(
        `UPDATE alerts SET resolved_at = ?, state = CASE WHEN state = 'active' THEN 'resolved' ELSE state END, updated_at = ? WHERE id = ?`,
      ).run(iso(nowMs), iso(nowMs), r.id);
    }
    return open;
  },

  /** A flicker: put a just-closed episode back (ladder and all) instead of telling him the same thing twice. */
  reopen(id: string, nowMs = Date.now()): void {
    db.prepare(
      `UPDATE alerts SET resolved_at = NULL, state = CASE WHEN state = 'resolved' AND acked_at IS NULL THEN 'active' ELSE state END, updated_at = ? WHERE id = ?`,
    ).run(iso(nowMs), id);
  },

  /** A record of what he was told, not an audit trail: 30 days is ample to measure and debug. */
  prune(days = 30, nowMs = Date.now()): number {
    return db.prepare("DELETE FROM alerts WHERE created_at < ? AND resolved_at IS NOT NULL").run(iso(nowMs - days * 86_400_000)).changes;
  },
};
