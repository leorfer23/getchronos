import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { kv } from "./kv.js";
import { now } from "./util.js";

/**
 * The durable half of Robert's wake path (engine in src/wake-queue.ts).
 *
 * A wake is a row before it is a turn: the event is written here first, handled second, and acked
 * only once the handling side effect landed. That is what makes a daemon restart or a thrown turn
 * recoverable instead of silent.
 *
 * `generation` is a monotonic sequence, so a drain can present wakes in the order they happened and
 * ack THROUGH the highest one it handled. `key` is the dedupe key: an unacked row with the same key
 * absorbs a repeat rather than queueing a second turn about the same news.
 */
export interface RobertWake {
  id: string;
  generation: number;
  topic: string;
  key: string;
  /** What the wake is ABOUT (a ticket id) — the debounce window is per subject, not per key. */
  subject: string | null;
  payload: string | null;
  workspace_id: string | null;
  /** Repeats absorbed by this row. Separate from `attempts` on purpose — see enqueue(). */
  hits: number;
  attempts: number;
  created_at: string;
  claimed_at: string | null;
  handled_at: string | null;
  acked_at: string | null;
  last_error: string | null;
}

export interface NewRobertWake {
  topic: string;
  key: string;
  subject?: string | null;
  payload?: unknown;
  workspace_id?: string | null;
}

const GEN_KEY = "robert.wake.generation";

// Highest generation ever issued, kept in kv as well as read off the table: retention (or a manual
// repair) can delete the newest rows, and a sequence that walks backwards would let an old row
// outrank a new one in the drain order.
function nextGeneration(): number {
  const fromTable = (db.prepare("SELECT COALESCE(MAX(generation),0) g FROM robert_wakes").get() as { g: number }).g;
  const fromKv = Number(kv.get(GEN_KEY) ?? 0);
  const next = Math.max(fromTable, Number.isFinite(fromKv) ? fromKv : 0) + 1;
  kv.set(GEN_KEY, String(next));
  return next;
}

const scopeClause = (scope: string) => (scope === "default" ? "workspace_id IS NULL" : "workspace_id = @scope");

export const robertWakes = {
  /** Write the wake. Returns the row plus whether it was absorbed by one already queued. */
  enqueue(w: NewRobertWake): { row: RobertWake; deduped: boolean } {
    const payload = w.payload === undefined ? null : JSON.stringify(w.payload);
    const tx = db.transaction((): { row: RobertWake; deduped: boolean } => {
      const open = db
        .prepare("SELECT * FROM robert_wakes WHERE key = ? AND acked_at IS NULL ORDER BY generation DESC LIMIT 1")
        .get(w.key) as RobertWake | undefined;
      if (open) {
        // A repeat is the same news: keep one row and the newest payload. Deliberately NOT a bump of
        // `attempts` — that counter is what parks a row after N failed turns, and a chatty event
        // source must never park its own wake.
        db.prepare("UPDATE robert_wakes SET payload = COALESCE(?, payload), hits = hits + 1 WHERE id = ?").run(
          payload,
          open.id,
        );
        return { row: this.get(open.id)!, deduped: true };
      }
      const row: RobertWake = {
        id: randomUUID(),
        generation: nextGeneration(),
        topic: w.topic,
        key: w.key,
        subject: w.subject ?? null,
        payload,
        workspace_id: w.workspace_id ?? null,
        hits: 1,
        attempts: 0,
        created_at: now(),
        claimed_at: null,
        handled_at: null,
        acked_at: null,
        last_error: null,
      };
      db.prepare(
        `INSERT INTO robert_wakes (id,generation,topic,key,subject,payload,workspace_id,hits,attempts,
          created_at,claimed_at,handled_at,acked_at,last_error)
         VALUES (@id,@generation,@topic,@key,@subject,@payload,@workspace_id,@hits,@attempts,
          @created_at,@claimed_at,@handled_at,@acked_at,@last_error)`,
      ).run(row);
      return { row, deduped: false };
    });
    return tx();
  },

  get(id: string): RobertWake | undefined {
    return db.prepare("SELECT * FROM robert_wakes WHERE id = ?").get(id) as RobertWake | undefined;
  },

  /** Resolve a short id prefix — `mc robert wakes` and the ack route both take one. */
  findByIdPrefix(prefix: string): RobertWake | undefined {
    const p = prefix.trim();
    if (p.length < 4) return undefined;
    const rows = db
      .prepare("SELECT * FROM robert_wakes WHERE id LIKE ? ORDER BY generation DESC LIMIT 2")
      .all(`${p}%`) as RobertWake[];
    return rows.length === 1 ? rows[0] : rows.find((r) => r.id.startsWith(p));
  },

  unacked(): RobertWake[] {
    return db.prepare("SELECT * FROM robert_wakes WHERE acked_at IS NULL ORDER BY generation ASC").all() as RobertWake[];
  },

  /** One workspace's queue in happened-order. Scope "default" is the unscoped/global thread. */
  unackedForScope(scope: string): RobertWake[] {
    return db
      .prepare(`SELECT * FROM robert_wakes WHERE acked_at IS NULL AND ${scopeClause(scope)} ORDER BY generation ASC`)
      .all({ scope }) as RobertWake[];
  },

  /** Every scope with something queued — the startup replay walks these. */
  unackedScopes(): string[] {
    const rows = db
      .prepare("SELECT DISTINCT COALESCE(workspace_id,'default') s FROM robert_wakes WHERE acked_at IS NULL")
      .all() as Array<{ s: string }>;
    return rows.map((r) => r.s);
  },

  claim(ids: string[]): void {
    if (!ids.length) return;
    const stamp = now();
    const st = db.prepare("UPDATE robert_wakes SET claimed_at = ? WHERE id = ?");
    db.transaction(() => { for (const id of ids) st.run(stamp, id); })();
  },

  /**
   * Ack exactly the rows a turn presented. Acking by generation instead would also sweep up a row
   * that was claimed by a crashed drain and then held back by its subject's debounce window — acked
   * without ever reaching a prompt, which is the silent drop this table exists to stop. Rows over the
   * attempt cap are left alone for the same reason.
   */
  ackIds(ids: string[], attemptCap: number): number {
    if (!ids.length) return 0;
    const stamp = now();
    const st = db.prepare(
      `UPDATE robert_wakes SET handled_at = COALESCE(handled_at,?), acked_at = ?, last_error = NULL
       WHERE id = ? AND acked_at IS NULL AND attempts < ?`,
    );
    let n = 0;
    db.transaction(() => { for (const id of ids) n += st.run(stamp, stamp, id, attemptCap).changes; })();
    return n;
  },

  /** Manual repair (API/CLI): one row off the queue without pretending a turn happened. */
  ack(id: string): RobertWake | undefined {
    db.prepare("UPDATE robert_wakes SET acked_at = ? WHERE id = ? AND acked_at IS NULL").run(now(), id);
    return this.get(id);
  },

  /** The turn threw: keep the rows queued, count the attempt, remember why. */
  fail(ids: string[], error: string): void {
    if (!ids.length) return;
    const st = db.prepare(
      "UPDATE robert_wakes SET attempts = attempts + 1, last_error = ?, claimed_at = NULL WHERE id = ?",
    );
    db.transaction(() => { for (const id of ids) st.run(error.slice(0, 500), id); })();
  },

  /** When this subject last reached Robert — the debounce window reads from here, not from memory. */
  lastHandledAt(subject: string): string | null {
    const row = db
      .prepare("SELECT MAX(COALESCE(handled_at, acked_at)) t FROM robert_wakes WHERE subject = ? AND acked_at IS NOT NULL")
      .get(subject) as { t: string | null };
    return row.t ?? null;
  },

  /** Recently handled wakes — the operator-facing half of GET /api/robert/wakes. */
  recentAcked(limit = 20): RobertWake[] {
    return db
      .prepare("SELECT * FROM robert_wakes WHERE acked_at IS NOT NULL ORDER BY generation DESC LIMIT ?")
      .all(limit) as RobertWake[];
  },
};
