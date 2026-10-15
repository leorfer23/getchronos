import { db } from "./db.js";
import { now } from "./util.js";

/**
 * A Lead's inbox (LEADS.md) — the durable half of "one of your workers stopped".
 *
 * The row is written first and delivered second, which is what makes it PULLABLE: a Lead blocked in
 * `mc lead wait` is handed the rows the moment they land and nothing is typed at all, and a Lead that
 * is not pulling gets one debounced digest instead of one keystroke per stop (robert-drive.ts).
 *
 * The three timestamps are three different facts and are deliberately not one status column:
 *   - `seen_at`      the Lead was handed this event (long-poll return, or a delivered digest)
 *   - `delivered_at` it was typed into the Lead's pty (a digest) — the escalation path keys off this
 *   - `acked_at`     the Lead acted on that worker, so the event is no longer outstanding
 */
export interface LeadEvent {
  id: number;
  lead_id: string;
  /** The WORKER this is about, never the Lead. */
  session_id: string;
  /** `review|turn|decide|blocked|robert` (a stop, robert-drive's DriveKind) or `ended`. */
  kind: string;
  /** The drive key of the stop behind it — the dedupe. NULL for kinds with no stop (`ended`). */
  key: string | null;
  payload: string | null;
  created_at: string;
  seen_at: string | null;
  delivered_at: string | null;
  acked_at: string | null;
}

export interface NewLeadEvent {
  lead_id: string;
  session_id: string;
  kind: string;
  key?: string | null;
  payload?: unknown;
}

export const leadEvents = {
  /**
   * Write the event. Idempotent on `key`: the same stop re-armed (a second status event, a daemon
   * restart re-deriving `since`) returns the row already queued rather than a second inbox entry.
   */
  add(e: NewLeadEvent): { row: LeadEvent; deduped: boolean } {
    const payload = e.payload === undefined ? null : JSON.stringify(e.payload);
    const tx = db.transaction((): { row: LeadEvent; deduped: boolean } => {
      if (e.key) {
        const open = db.prepare("SELECT * FROM lead_events WHERE key = ?").get(e.key) as LeadEvent | undefined;
        // Keep the newest payload — the card line and last words move on while the stop does not.
        if (open) {
          db.prepare("UPDATE lead_events SET payload = COALESCE(?, payload) WHERE id = ?").run(payload, open.id);
          return { row: leadEvents.get(open.id)!, deduped: true };
        }
      }
      const id = db
        .prepare(
          "INSERT INTO lead_events (lead_id,session_id,kind,key,payload,created_at) VALUES (?,?,?,?,?,?)",
        )
        .run(e.lead_id, e.session_id, e.kind, e.key ?? null, payload, now()).lastInsertRowid as number;
      return { row: leadEvents.get(id)!, deduped: false };
    });
    return tx();
  },

  get(id: number): LeadEvent | undefined {
    return db.prepare("SELECT * FROM lead_events WHERE id = ?").get(id) as LeadEvent | undefined;
  },

  /** What this Lead has not been handed yet, oldest first — the long-poll's and the digest's batch. */
  unseen(leadId: string): LeadEvent[] {
    return db
      .prepare("SELECT * FROM lead_events WHERE lead_id = ? AND seen_at IS NULL ORDER BY id")
      .all(leadId) as LeadEvent[];
  },

  /**
   * The newest event of one kind for one worker that the Lead has not acted on. Behind the stop
   * suppression in robert-drive.ts: a worker that just ran `mc report` is about to stop, and that
   * stop is the same moment — it must not become a second row naming the worker twice in one digest.
   */
  lastUnacked(leadId: string, sessionId: string, kind: string): LeadEvent | undefined {
    return db
      .prepare(
        "SELECT * FROM lead_events WHERE lead_id = ? AND session_id = ? AND kind = ? AND acked_at IS NULL " +
          "ORDER BY id DESC LIMIT 1",
      )
      .get(leadId, sessionId, kind) as LeadEvent | undefined;
  },

  markSeen(ids: number[]): void {
    if (!ids.length) return;
    const ts = now();
    const stmt = db.prepare("UPDATE lead_events SET seen_at = COALESCE(seen_at, ?) WHERE id = ?");
    db.transaction(() => ids.forEach((id) => stmt.run(ts, id)))();
  },

  /** Typed into the Lead. Always also seen — a digest it read is a digest it was handed. */
  markDelivered(ids: number[]): void {
    if (!ids.length) return;
    const ts = now();
    const stmt = db.prepare(
      "UPDATE lead_events SET delivered_at = COALESCE(delivered_at, ?), seen_at = COALESCE(seen_at, ?) WHERE id = ?",
    );
    db.transaction(() => ids.forEach((id) => stmt.run(ts, ts, id)))();
  },

  /**
   * The Lead acted on that worker (it typed into it) → every event of its about that worker stops
   * being outstanding. Also marks them seen: a Lead that just steered a worker plainly knows it
   * stopped, and a digest about it afterwards would be telling it what it already did.
   */
  ackForWorker(leadId: string, sessionId: string): number {
    const ts = now();
    return db
      .prepare(
        "UPDATE lead_events SET acked_at = COALESCE(acked_at, ?), seen_at = COALESCE(seen_at, ?) " +
          "WHERE lead_id = ? AND session_id = ? AND acked_at IS NULL",
      )
      .run(ts, ts, leadId, sessionId).changes;
  },

  /** The inbox: what is still outstanding, or (`all`) the recent history whatever its state. */
  recent(leadId: string, opts: { limit?: number; all?: boolean } = {}): LeadEvent[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 30, 200));
    const where = opts.all ? "lead_id = ?" : "lead_id = ? AND acked_at IS NULL";
    const rows = db
      .prepare(`SELECT * FROM lead_events WHERE ${where} ORDER BY id DESC LIMIT ?`)
      .all(leadId, limit) as LeadEvent[];
    return rows.reverse();
  },

  /** A keystroke log, not an audit trail (activity.ts is the audit trail) — 7 days at startup. */
  prune(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60_000).toISOString();
    return db.prepare("DELETE FROM lead_events WHERE created_at < ?").run(cutoff).changes;
  },

  /** Move every inbox row from one Lead onto another (`mc lead adopt`). */
  reassign(fromLeadId: string, toLeadId: string): number {
    if (fromLeadId === toLeadId) return 0;
    return db.prepare("UPDATE lead_events SET lead_id = ? WHERE lead_id = ?").run(toLeadId, fromLeadId).changes;
  },
};
