import { randomUUID } from "node:crypto";
import { db } from "./db.js";

/**
 * Robert's outbox (migration 170; the door is src/robert-outbox.ts) — one row per thing he said or did
 * that nobody typed to him: a wake's reply, an ask he triaged, a watch report, a card he put up.
 *
 * The row is written BEFORE anything is delivered and settled after, so the record survives a post that
 * throws, and it is what the next wake turn reads back as "what you already told the operator". Plain
 * reads and writes: what counts as the same words lives in the door, not here.
 *
 * `status`: pending (written, not decided yet) · delivered (in the Desk chat) · held (robert.desk_posts
 * off — the quiet log line) · suppressed (the same words about the same thing were already delivered or
 * held inside the repeat window) · failed (the post threw). Only delivered and held count as told.
 */
export type OutboxStatus = "pending" | "delivered" | "held" | "suppressed" | "failed";
export const OUTBOX_STATUSES: readonly OutboxStatus[] = ["pending", "delivered", "held", "suppressed", "failed"];
const TOLD = "status IN ('delivered','held')";

/** A wake that caused the row — enough to find it in robert_wakes, never its payload. */
export interface OutboxWake {
  key: string;
  topic: string;
  subject: string | null;
}

export interface OutboxRow {
  id: string;
  /** Null = the default (unscoped) thread. A workspace's rows are only ever read back in that workspace. */
  workspace_id: string | null;
  created_at: string;
  /** Which path said it: wake · ask · triage · watch · board · failover · artifact. */
  source: string;
  body: string;
  /** Hash of the normalised words — what the repeat rule compares. */
  body_key: string;
  /** How many tool steps the turn took (the Desk bubble shows them). */
  steps: number;
  wakes: OutboxWake[];
  /** What it is about (`session:<id>`, `ask:<id>`, a ticket id …): two lines about one thing share it. */
  episode: string | null;
  turn: string | null;
  status: OutboxStatus;
  reason: string | null;
  delivered_at: string | null;
  /** Where it went when delivered: `desk`. */
  channel: string | null;
}

export interface NewOutboxRow {
  workspace_id: string | null;
  source: string;
  body: string;
  body_key: string;
  steps?: number;
  wakes?: OutboxWake[];
  episode?: string | null;
  turn?: string | null;
}

/** Retention: a record to read back and debug, not an archive. Both caps apply. */
export const OUTBOX_KEEP_DAYS = 30;
export const OUTBOX_KEEP_ROWS = 10_000;

const iso = (ms: number) => new Date(ms).toISOString();

function hydrate(r: any): OutboxRow | undefined {
  if (!r) return undefined;
  let wakes: OutboxWake[] = [];
  try { wakes = r.wakes ? JSON.parse(r.wakes) : []; } catch {}
  return { ...r, wakes } as OutboxRow;
}
const all = (rows: unknown[]) => rows.map((r) => hydrate(r)!);

export const robertOutbox = {
  /** Write the row first, as `pending`. The door settles it once it knows what became of the post. */
  add(r: NewOutboxRow, nowMs = Date.now()): OutboxRow {
    const row = {
      id: randomUUID(),
      workspace_id: r.workspace_id ?? null,
      created_at: iso(nowMs),
      source: r.source,
      body: r.body,
      body_key: r.body_key,
      steps: r.steps ?? 0,
      wakes: r.wakes?.length ? JSON.stringify(r.wakes) : null,
      episode: r.episode ?? null,
      turn: r.turn ?? null,
      status: "pending",
    };
    db.prepare(
      `INSERT INTO robert_outbox (id,workspace_id,created_at,source,body,body_key,steps,wakes,episode,turn,status)
       VALUES (@id,@workspace_id,@created_at,@source,@body,@body_key,@steps,@wakes,@episode,@turn,@status)`,
    ).run(row);
    return robertOutbox.get(row.id)!;
  },

  get(id: string): OutboxRow | undefined {
    return hydrate(db.prepare("SELECT * FROM robert_outbox WHERE id = ?").get(id));
  },

  settle(id: string, s: { status: OutboxStatus; reason?: string | null; channel?: string | null; delivered_at?: string | null }): void {
    db.prepare("UPDATE robert_outbox SET status = ?, reason = ?, channel = ?, delivered_at = ? WHERE id = ?").run(
      s.status, s.reason ?? null, s.channel ?? null, s.delivered_at ?? null, id,
    );
  },

  /** The told row this one would repeat: same scope, same episode, same words, since `sinceMs`. */
  repeatOf(p: { workspace_id: string | null; episode: string | null; body_key: string; sinceMs: number; except: string }): OutboxRow | undefined {
    return hydrate(db.prepare(
      `SELECT * FROM robert_outbox WHERE workspace_id IS ? AND episode IS ? AND body_key = ? AND created_at >= ? AND id != ? AND ${TOLD}
       ORDER BY created_at DESC LIMIT 1`,
    ).get(p.workspace_id, p.episode, p.body_key, iso(p.sinceMs), p.except));
  },

  /** What was told in exactly this scope since then, newest first. Null reads the default thread only. */
  told(workspaceId: string | null, sinceMs: number, limit = 20): OutboxRow[] {
    return all(db.prepare(
      `SELECT * FROM robert_outbox WHERE workspace_id IS ? AND created_at >= ? AND ${TOLD} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(workspaceId, iso(sinceMs), limit));
  },

  /** The record, newest first. `workspace` undefined = every scope (the operator's view); null = the default thread. */
  list(o: { workspace?: string | null; sinceMs?: number; status?: OutboxStatus; limit?: number } = {}): OutboxRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (o.workspace !== undefined) { where.push("workspace_id IS ?"); params.push(o.workspace); }
    if (o.sinceMs != null) { where.push("created_at >= ?"); params.push(iso(o.sinceMs)); }
    if (o.status) { where.push("status = ?"); params.push(o.status); }
    params.push(Math.max(1, Math.min(1000, o.limit ?? 200)));
    return all(db.prepare(
      `SELECT * FROM robert_outbox${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(...params));
  },

  prune(nowMs = Date.now(), days = OUTBOX_KEEP_DAYS, keep = OUTBOX_KEEP_ROWS): number {
    const old = db.prepare("DELETE FROM robert_outbox WHERE created_at < ?").run(iso(nowMs - days * 86_400_000)).changes;
    const over = db.prepare(
      "DELETE FROM robert_outbox WHERE id IN (SELECT id FROM robert_outbox ORDER BY created_at DESC LIMIT -1 OFFSET ?)",
    ).run(keep).changes;
    return old + over;
  },
};
