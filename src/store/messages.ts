import { db } from "./db.js";
import { now } from "./util.js";

export interface RunMessage {
  id: number;
  ticket_id: string | null;
  run_id: string | null;
  workspace_id: string | null;
  text: string;
  from_who: string;
  created_at: string;
  delivered_at: string | null;
  delivered_to_run: string | null;
}

export interface NewRunMessage {
  ticket_id?: string | null;
  run_id?: string | null;
  workspace_id?: string | null;
  text: string;
  from_who: string;
}

export const messages = {
  // At least one of ticket_id/run_id must be set — a message addressed nowhere would sit undeliverable
  // forever. Enforced here, not via a SQL CHECK, so the error message is a `mc tell` caller can act on.
  create(m: NewRunMessage): RunMessage {
    if (!m.ticket_id && !m.run_id) throw new Error("message needs a ticket_id or run_id target");
    const info = db
      .prepare(
        `INSERT INTO run_messages (ticket_id,run_id,workspace_id,text,from_who,created_at)
         VALUES (?,?,?,?,?,?)`
      )
      .run(m.ticket_id ?? null, m.run_id ?? null, m.workspace_id ?? null, m.text, m.from_who, now());
    return this.get(info.lastInsertRowid as number)!;
  },

  get(id: number): RunMessage | undefined {
    return db.prepare("SELECT * FROM run_messages WHERE id = ?").get(id) as RunMessage | undefined;
  },

  // Piggyback pickup set for a run: its own run-scoped messages, plus every undelivered message
  // addressed to its ticket (survives park & resume — a message sent while parked is still here when
  // the next run starts). ticketId null just narrows to run-scoped.
  undeliveredFor(run_id: string | null, ticket_id: string | null): RunMessage[] {
    const clauses: string[] = [];
    const params: any[] = [];
    if (run_id) { clauses.push("run_id = ?"); params.push(run_id); }
    if (ticket_id) { clauses.push("ticket_id = ?"); params.push(ticket_id); }
    if (!clauses.length) return [];
    return db
      .prepare(`SELECT * FROM run_messages WHERE delivered_at IS NULL AND (${clauses.join(" OR ")}) ORDER BY id ASC`)
      .all(...params) as RunMessage[];
  },

  markDelivered(ids: number[], run_id: string): void {
    if (!ids.length) return;
    const ts = now();
    const upd = db.prepare("UPDATE run_messages SET delivered_at = COALESCE(delivered_at, ?), delivered_to_run = COALESCE(delivered_to_run, ?) WHERE id = ?");
    const tx = db.transaction(() => ids.forEach((id) => upd.run(ts, run_id, id)));
    tx();
  },

  // Undo delivery for messages a run never actually consumed. A live steer marks the row delivered
  // the moment it's written to the child's stdin, but a run that dies before processing it (timeout,
  // kill, crash) leaves the operator's directive both unseen AND unre-deliverable. Reverting these
  // rows puts them back in the mailbox for the next dispatch — the durable path that steering is
  // supposed to accelerate, never replace.
  undeliver(ids: number[]): void {
    if (!ids.length) return;
    const upd = db.prepare("UPDATE run_messages SET delivered_at = NULL, delivered_to_run = NULL WHERE id = ?");
    const tx = db.transaction(() => ids.forEach((id) => upd.run(id)));
    tx();
  },

  list(opts: { ticket_id?: string; run_id?: string; undelivered_only?: boolean } = {}): RunMessage[] {
    const clauses: string[] = [];
    const params: any[] = [];
    if (opts.ticket_id) { clauses.push("ticket_id = ?"); params.push(opts.ticket_id); }
    if (opts.run_id) { clauses.push("run_id = ?"); params.push(opts.run_id); }
    if (opts.undelivered_only) clauses.push("delivered_at IS NULL");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`SELECT * FROM run_messages ${where} ORDER BY id DESC`).all(...params) as RunMessage[];
  },

  // Same pattern as steps.prune / events.prune — a DELETE...NOT IN(...LIMIT) sweep run from the
  // monitor's retention cadence, not per-write.
  prune(cap: number): void {
    try {
      db.prepare(`DELETE FROM run_messages WHERE id NOT IN (SELECT id FROM run_messages ORDER BY id DESC LIMIT ?)`).run(cap);
    } catch {}
  },
};
