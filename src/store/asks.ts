import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";

export type AskStatus = "open" | "answered" | "cancelled";

/**
 * Who gets the question FIRST. 'robert' means the overseer triages before the operator's phone rings;
 * 'lead' means the asking terminal's own Lead does, and the row is re-routed to 'robert' if it does
 * not (src/lead-asks.ts) — so 'lead' is always a stage, never a terminus.
 */
export type AskRoute = "operator" | "robert" | "lead";

export interface Ask {
  id: string;
  /** Set for a dispatched run's ask. Null for a terminal's — exactly one of run_id/session_id is set. */
  run_id: string | null;
  job_id: string | null;
  /** Set for an ask filed from a Desk terminal (`mc ask-robert`). */
  session_id: string | null;
  /** The asker in words: agent handle, or the terminal's goal. What the card leads with. */
  asked_by: string | null;
  route: AskRoute;
  /** Robert's call and why, kept even after the ask is answered. */
  triage: string | null;
  escalated_at: string | null;
  ticket_id: string | null;
  workspace_id: string | null;
  question: string;
  options: string | null; // JSON array or null (free-form)
  answer: string | null;
  answered_by: string | null;
  status: AskStatus;
  created_at: string;
  answered_at: string | null;
  /** ISO. Set = the operator said "later": off the live list until this moment (see src/holds.ts). */
  hold_until: string | null;
  hold_reason: string | null;
  /** ISO of the last time a due hold brought it back — the reason the return card fires only once. */
  resurfaced_at: string | null;
}

export interface NewAsk {
  run_id?: string | null;
  job_id?: string | null;
  session_id?: string | null;
  asked_by?: string | null;
  route?: AskRoute;
  ticket_id?: string | null;
  workspace_id?: string | null;
  question: string;
  options?: string[] | null;
}

export const asks = {
  create(f: NewAsk): Ask {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO asks (id,run_id,job_id,session_id,asked_by,route,ticket_id,workspace_id,question,options,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'open',?)`
    ).run(
      id,
      f.run_id ?? null,
      f.job_id ?? null,
      f.session_id ?? null,
      f.asked_by ?? null,
      f.route ?? "operator",
      f.ticket_id ?? null,
      f.workspace_id ?? null,
      f.question,
      f.options && f.options.length ? JSON.stringify(f.options) : null,
      now()
    );
    return this.get(id)!;
  },

  get(id: string): Ask | undefined {
    return db.prepare("SELECT * FROM asks WHERE id = ?").get(id) as Ask | undefined;
  },

  /** Resolve a short id prefix (id8) to at most one ask — Telegram callback_data / `mc answer <id8>`. */
  findByIdPrefix(prefix: string): Ask | undefined {
    const p = prefix.trim();
    if (p.length < 4) return undefined;
    const rows = db
      .prepare("SELECT * FROM asks WHERE id LIKE ? ORDER BY rowid DESC LIMIT 2")
      .all(`${p}%`) as Ask[];
    return rows.length === 1 ? rows[0] : rows.find((r) => r.id.startsWith(p));
  },

  openForRun(run_id: string): Ask[] {
    return db.prepare("SELECT * FROM asks WHERE run_id = ? AND status = 'open' ORDER BY rowid ASC").all(run_id) as Ask[];
  },

  list(opts: { status?: string; workspace_id?: string } = {}): Ask[] {
    const clauses: string[] = [];
    const p: Record<string, string> = {};
    if (opts.status) { clauses.push("status = @status"); p.status = opts.status; }
    if (opts.workspace_id) { clauses.push("workspace_id = @workspace_id"); p.workspace_id = opts.workspace_id; }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`SELECT * FROM asks ${where} ORDER BY created_at DESC`).all(p) as Ask[];
  },

  // Only transitions an OPEN ask — a double-answer (Telegram tap racing `mc answer`, or a retry) must
  // not overwrite the first responder's text or fire a second resume dispatch. Returns undefined for
  // "not found" or "already answered/cancelled" alike; the caller distinguishes via a fresh get() if needed.
  answer(id: string, answer: string, by: string): Ask | undefined {
    const cur = this.get(id);
    if (!cur || cur.status !== "open") return undefined;
    // Clears any hold in the same statement: an answer IS the unhold — the operator's words are on
    // the row now, so a pending "later" date is spent and must not read as still-deferred.
    db.prepare(
      "UPDATE asks SET answer = ?, answered_by = ?, status = 'answered', answered_at = ?, hold_until = NULL, hold_reason = NULL WHERE id = ?"
    ).run(
      answer,
      by,
      now(),
      id
    );
    return this.get(id);
  },

  /** Open asks filed from one terminal — cancelled together when its pty dies. */
  openForSession(session_id: string): Ask[] {
    return db.prepare("SELECT * FROM asks WHERE session_id = ? AND status = 'open' ORDER BY rowid ASC").all(session_id) as Ask[];
  },

  /** Open asks still sitting with Robert — the sweeper escalates the ones he never resolved. */
  openRoutedToRobert(): Ask[] {
    return db.prepare(
      "SELECT * FROM asks WHERE status = 'open' AND route = 'robert' AND escalated_at IS NULL ORDER BY rowid ASC",
    ).all() as Ask[];
  },

  /** Open asks still sitting with a Lead — the fallback sweep's work list (src/lead-asks.ts). */
  openRoutedToLead(): Ask[] {
    return db.prepare(
      "SELECT * FROM asks WHERE status = 'open' AND route = 'lead' ORDER BY rowid ASC",
    ).all() as Ask[];
  },

  /**
   * Hand an OPEN ask to a different first responder — only ever lead → robert, when the Lead ran out
   * of time or ended. Guarded on `status` AND on the route it is leaving, so two overlapping sweeps
   * cannot both re-route (and therefore both triage) the same question.
   */
  setRoute(id: string, route: AskRoute, from: AskRoute = "lead"): boolean {
    return db
      .prepare("UPDATE asks SET route = ? WHERE id = ? AND status = 'open' AND route = ?")
      .run(route, id, from).changes > 0;
  },

  /** Robert's verdict on an ask he could not or would not answer: it becomes the operator's, with his note. */
  escalate(id: string, triage: string | null): Ask | undefined {
    db.prepare("UPDATE asks SET escalated_at = ?, triage = COALESCE(?, triage) WHERE id = ? AND status = 'open'").run(
      now(), triage, id,
    );
    return this.get(id);
  },

  /** Record what Robert decided without changing whose turn it is. */
  setTriage(id: string, triage: string): void {
    db.prepare("UPDATE asks SET triage = ? WHERE id = ?").run(triage, id);
  },

  cancel(id: string): void {
    db.prepare("UPDATE asks SET status = 'cancelled' WHERE id = ? AND status = 'open'").run(id);
  },

  /**
   * "Later" — park an OPEN ask until `until` (null lifts the hold). Never closes it: a held ask is
   * still the operator's question, it just isn't on today's list. The reason is cleared with the date.
   */
  hold(id: string, until: string | null, reason: string | null): Ask | undefined {
    const cur = this.get(id);
    if (!cur || cur.status !== "open") return undefined;
    db.prepare("UPDATE asks SET hold_until = ?, hold_reason = ? WHERE id = ?").run(until, until ? reason : null, id);
    return this.get(id);
  },

  /**
   * Clear a due hold and stamp `resurfaced_at` in ONE guarded statement: two overlapping sweeps (or a
   * sweep racing a manual unhold) must not both send the "back from later" card.
   * Returns the row only when THIS call is the one that cleared it.
   */
  resurface(id: string, at: string): Ask | undefined {
    const r = db
      .prepare("UPDATE asks SET hold_until = NULL, resurfaced_at = ? WHERE id = ? AND status = 'open' AND hold_until IS NOT NULL")
      .run(at, id);
    return r.changes ? this.get(id) : undefined;
  },

  /** Open asks whose hold has come due — the resurface sweep's work list. */
  holdsDue(nowIso: string): Ask[] {
    return db
      .prepare("SELECT * FROM asks WHERE status = 'open' AND hold_until IS NOT NULL AND hold_until <= ? ORDER BY hold_until ASC")
      .all(nowIso) as Ask[];
  },
};
