import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";
import type { Review, ReviewState } from "../types.js";

export const reviews = {
  list(state?: string): Review[] {
    if (state)
      return db
        .prepare("SELECT * FROM reviews WHERE state = ? ORDER BY created_at DESC")
        .all(state) as Review[];
    return db.prepare("SELECT * FROM reviews ORDER BY created_at DESC").all() as Review[];
  },
  get(id: string): Review | undefined {
    return db.prepare("SELECT * FROM reviews WHERE id = ?").get(id) as Review | undefined;
  },
  byTicket(ticketId: string): Review[] {
    return db.prepare("SELECT * FROM reviews WHERE ticket_id = ? ORDER BY created_at DESC").all(ticketId) as Review[];
  },
  countByTicket(ticketId: string): number {
    return (db.prepare("SELECT COUNT(*) c FROM reviews WHERE ticket_id = ?").get(ticketId) as { c: number }).c;
  },
  create(r: { run_id: string; ticket_id: string | null; diff_ref: string | null; gate_json?: string | null; risk?: string | null }): Review {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO reviews (id,run_id,ticket_id,state,diff_ref,gate_json,risk,created_at) VALUES (?,?,?,?,?,?,?,?)"
    ).run(id, r.run_id, r.ticket_id, "pending", r.diff_ref, r.gate_json ?? null, r.risk ?? null, now());
    return this.get(id)!;
  },
  setDiff(id: string, diff: string | null): Review | undefined {
    db.prepare("UPDATE reviews SET diff_ref=? WHERE id=?").run(diff, id);
    return this.get(id);
  },
  setEvidence(id: string, gate_json: string | null, risk: string | null): Review | undefined {
    db.prepare("UPDATE reviews SET gate_json=COALESCE(?,gate_json), risk=COALESCE(?,risk) WHERE id=?").run(gate_json, risk, id);
    return this.get(id);
  },
  setPanel(id: string, panel_json: string | null): Review | undefined {
    db.prepare("UPDATE reviews SET panel_json=? WHERE id=?").run(panel_json, id);
    return this.get(id);
  },
  setState(id: string, state: ReviewState, notes?: string | null, actor?: string | null): Review | undefined {
    // Deciding IS the unhold — but only a state that LEAVES pending is a decision. `approve` writes
    // pending→pending when an AI recommend-approve still wants a human (src/reviews.ts), and that
    // must not silently yank a deferred review back onto today's list.
    const keepHold = state === "pending";
    db.prepare(
      `UPDATE reviews SET state=?, notes=COALESCE(?,notes), actor=COALESCE(?,actor), reviewed_at=?` +
      (keepHold ? "" : ", hold_until=NULL, hold_reason=NULL") +
      ` WHERE id=?`
    ).run(state, notes ?? null, actor ?? null, now(), id);
    return this.get(id);
  },

  /** "Later" on a pending review — same contract as asks.hold (null lifts it, never closes the row). */
  hold(id: string, until: string | null, reason: string | null): Review | undefined {
    const cur = this.get(id);
    if (!cur || cur.state !== "pending") return undefined;
    db.prepare("UPDATE reviews SET hold_until=?, hold_reason=? WHERE id=?").run(until, until ? reason : null, id);
    return this.get(id);
  },

  /** Guarded on hold_until IS NOT NULL so only one caller ever sends the return card. */
  resurface(id: string, at: string): Review | undefined {
    const r = db
      .prepare("UPDATE reviews SET hold_until=NULL, resurfaced_at=? WHERE id=? AND state='pending' AND hold_until IS NOT NULL")
      .run(at, id);
    return r.changes ? this.get(id) : undefined;
  },

  holdsDue(nowIso: string): Review[] {
    return db
      .prepare("SELECT * FROM reviews WHERE state='pending' AND hold_until IS NOT NULL AND hold_until <= ? ORDER BY hold_until ASC")
      .all(nowIso) as Review[];
  },
};
