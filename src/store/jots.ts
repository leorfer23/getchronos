import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";

/**
 * A jot is a half-formed thought parked against a client: "the flyway rollback — but check prod
 * first". See migration 104 for why it is not a ticket and not an idea.
 *
 * The lifecycle is deliberately two states wide. `open` is everything not yet started; `done` is
 * everything that is. There is no spec/ready/planning ladder, because the whole point of the row is
 * that it is NOT specified yet — a status ladder would just be somewhere else to be wrong.
 *
 * `session_id` is the terminal a jot opened, kept after the run so the row stays a door back into
 * the work rather than a record that something once happened. Running a jot CLOSES it: the terminal
 * now owns the work, and a card that stays on the pad next to the terminal doing it reads as two
 * things to do. If the attempt goes nowhere, reopen the card (↩ in the pad / PATCH status open).
 */
export type Jot = {
  id: string;
  workspace_id: string;
  title: string;
  /** The brain dump proper — everything you knew when you wrote it, appended to over time. */
  body: string | null;
  status: "open" | "done";
  /** Manual order within a client, so a list you have arranged stays arranged. */
  pos: number;
  /** The last terminal this jot opened, if any. */
  session_id: string | null;
  created_at: string;
  updated_at: string;
  /** When it was last run — distinct from updated_at, which any edit moves. */
  ran_at: string | null;
  done_at: string | null;
  /** The day this card was planned for (YYYY-MM-DD), or null for a parked thought with no date. */
  for_date: string | null;
  /** Who wrote it: the operator at the wall, a "plan tomorrow" terminal (`nextday`), or a working
   *  terminal that parked a follow-up it found (`agent`). */
  source: JotSource;
  /** The terminal that filed it — the door back to its reasoning. null for operator rows. */
  planned_by: string | null;
  /** When an agent should come back to this note (ISO), or null. Cleared the moment one does. */
  follow_up_at: string | null;
  /** What that agent should look at — the question the note is waiting on. */
  follow_up_check: string | null;
  /** The last terminal a follow-up opened on this note: the door to what it found. */
  follow_up_session: string | null;
  /** When the last follow-up fired. */
  followed_up_at: string | null;
  /** How many follow-ups have fired. Bounds how long agents can keep rescheduling on their own. */
  follow_up_count: number;
};

export type JotSource = "operator" | "nextday" | "agent";

export type NewJot = {
  workspace_id: string;
  title: string;
  body?: string | null;
  for_date?: string | null;
  source?: JotSource;
  planned_by?: string | null;
  follow_up_at?: string | null;
  follow_up_check?: string | null;
};

const COLS = `id,workspace_id,title,body,status,pos,session_id,created_at,updated_at,ran_at,done_at,for_date,source,planned_by,follow_up_at,follow_up_check,follow_up_session,followed_up_at,follow_up_count`;

export const jots = {
  list(filter: { workspace_id?: string; status?: string; for_date?: string; source?: JotSource } = {}): Jot[] {
    const where: string[] = [];
    const p: any = {};
    if (filter.workspace_id) { where.push("workspace_id=@workspace_id"); p.workspace_id = filter.workspace_id; }
    if (filter.status) { where.push("status=@status"); p.status = filter.status; }
    if (filter.for_date) { where.push("for_date=@for_date"); p.for_date = filter.for_date; }
    if (filter.source) { where.push("source=@source"); p.source = filter.source; }
    // Open rows first and in your arrangement; done rows sink, newest first, as a receipt. Undated
    // rows (your own parked thoughts) stay ahead of dated ones so a day plan reads as a block below.
    return db.prepare(
      `SELECT * FROM jots ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY status='done', for_date IS NOT NULL, for_date, pos, created_at`,
    ).all(p) as Jot[];
  },

  get(id: string): Jot | undefined {
    return db.prepare("SELECT * FROM jots WHERE id = ?").get(id) as Jot | undefined;
  },

  create(input: NewJot): Jot {
    const t = now();
    // Append to the end of this client's list. MAX over a 20-row table needs no index.
    const pos =
      (db.prepare("SELECT COALESCE(MAX(pos), -1) AS m FROM jots WHERE workspace_id=?")
        .get(input.workspace_id) as { m: number }).m + 1;
    const row: Jot = {
      id: randomUUID(),
      workspace_id: input.workspace_id,
      title: input.title,
      body: input.body ?? null,
      status: "open",
      pos,
      session_id: null,
      created_at: t,
      updated_at: t,
      ran_at: null,
      done_at: null,
      for_date: input.for_date ?? null,
      source: input.source ?? "operator",
      planned_by: input.planned_by ?? null,
      follow_up_at: input.follow_up_at ?? null,
      follow_up_check: input.follow_up_check ?? null,
      follow_up_session: null,
      followed_up_at: null,
      follow_up_count: 0,
    };
    db.prepare(
      `INSERT INTO jots (${COLS}) VALUES (@id,@workspace_id,@title,@body,@status,@pos,@session_id,@created_at,@updated_at,@ran_at,@done_at,@for_date,@source,@planned_by,@follow_up_at,@follow_up_check,@follow_up_session,@followed_up_at,@follow_up_count)`,
    ).run(row);
    return this.get(row.id)!;
  },

  /**
   * Drop the planner-written cards for one day that nobody has touched: not run, not done. A re-plan
   * replaces its own earlier draft rather than stacking a second set under the same date. Operator
   * rows and anything already opened stay — a card you ran is a door back into work.
   */
  clearPlanned(workspace_id: string, for_date: string): number {
    return db.prepare(
      `DELETE FROM jots WHERE workspace_id=? AND for_date=? AND source='nextday' AND status='open' AND session_id IS NULL`,
    ).run(workspace_id, for_date).changes;
  },

  /**
   * Patch whichever fields the caller named. Everything is optional because the row is edited from a
   * live-typing UI: a body autosave must not have to restate the title, and COALESCE on the params
   * would make "clear the body" unexpressible.
   */
  update(
    id: string,
    p: Partial<Pick<Jot, "title" | "body" | "status" | "pos" | "session_id" | "for_date">>,
  ): Jot | undefined {
    const sets: string[] = [];
    const params: any = { id, updated_at: now() };
    for (const k of ["title", "body", "pos", "session_id", "for_date"] as const) {
      if (p[k] !== undefined) { sets.push(`${k}=@${k}`); params[k] = p[k]; }
    }
    if (p.status !== undefined) {
      sets.push("status=@status");
      params.status = p.status;
      // done_at tracks the transition, not the write: re-saving a done row must not move it, and
      // reopening one has to clear it or the row keeps a completion date it no longer has.
      sets.push("done_at=@done_at");
      params.done_at = p.status === "done" ? (this.get(id)?.done_at ?? now()) : null;
      // A closed note has nothing left to follow up on; a follow-up that fired on it anyway would
      // open a terminal to chase work that is already finished.
      if (p.status === "done") sets.push("follow_up_at=NULL");
    }
    if (!sets.length) return this.get(id);
    sets.push("updated_at=@updated_at");
    db.prepare(`UPDATE jots SET ${sets.join(", ")} WHERE id=@id`).run(params);
    return this.get(id);
  },

  /**
   * Add to the detail without replacing it, in one statement: two terminals appending to the same row
   * must both land, which a read-then-PATCH from the CLI cannot promise.
   */
  append(id: string, text: string): Jot | undefined {
    db.prepare(
      `UPDATE jots SET body = CASE WHEN body IS NULL OR trim(body) = '' THEN @text ELSE rtrim(body, ' ' || char(9, 10, 13)) || char(10) || @text END,
       updated_at=@t WHERE id=@id`,
    ).run({ id, text, t: now() });
    return this.get(id);
  },

  /**
   * Record that this jot opened a terminal, and close it: the work moved into the terminal. done_at
   * keeps its first value on a re-run so the receipt says when the card was first taken up.
   */
  ran(id: string, session_id: string): Jot | undefined {
    db.prepare(
      "UPDATE jots SET session_id=@session_id, ran_at=@t, updated_at=@t, status='done', done_at=COALESCE(done_at, @t), follow_up_at=NULL WHERE id=@id",
    ).run({ id, session_id, t: now() });
    return this.get(id);
  },

  /**
   * Schedule (or, with `at: null`, cancel) the next follow-up. `check` is only touched when given, so
   * moving the time does not wipe the question; pass null to clear it. Scheduling reopens nothing: a
   * done note refuses, because following up on finished work is the bug this guards.
   */
  setFollowUp(id: string, at: string | null, check?: string | null): Jot | undefined {
    const j = this.get(id);
    if (!j) return undefined;
    if (at && j.status === "done") throw new Error("note is done — reopen it before scheduling a follow-up");
    const sets = ["follow_up_at=@at", "updated_at=@t"];
    const params: any = { id, at, t: now() };
    if (check !== undefined) { sets.push("follow_up_check=@check"); params.check = check; }
    db.prepare(`UPDATE jots SET ${sets.join(", ")} WHERE id=@id`).run(params);
    return this.get(id);
  },

  /** Open notes whose follow-up time has come, oldest first. */
  dueFollowUps(nowIso: string): Jot[] {
    return db.prepare(
      "SELECT * FROM jots WHERE status='open' AND follow_up_at IS NOT NULL AND follow_up_at <= ? ORDER BY follow_up_at",
    ).all(nowIso) as Jot[];
  },

  /** The soonest pending follow-up, so the timer can sleep exactly until then. */
  nextFollowUpAt(): string | null {
    const r = db.prepare(
      "SELECT MIN(follow_up_at) AS at FROM jots WHERE status='open' AND follow_up_at IS NOT NULL",
    ).get() as { at: string | null };
    return r.at;
  },

  /**
   * Take a due follow-up exactly once. Guarded on the time still being set and due, so two sweeps
   * racing (boot catch-up + timer) cannot both open a terminal. Returns false if someone else won.
   */
  claimFollowUp(id: string, nowIso: string): boolean {
    return db.prepare(
      `UPDATE jots SET follow_up_at=NULL, followed_up_at=@t, follow_up_count=follow_up_count+1, updated_at=@t
       WHERE id=@id AND status='open' AND follow_up_at IS NOT NULL AND follow_up_at <= @t`,
    ).run({ id, t: nowIso }).changes > 0;
  },

  /** Give a claimed follow-up back (its terminal could not open): a later time, and the claim uncounted. */
  unclaimFollowUp(id: string, retryIso: string): Jot | undefined {
    db.prepare(
      "UPDATE jots SET follow_up_at=@at, follow_up_count=MAX(follow_up_count-1, 0), updated_at=@t WHERE id=@id AND status='open'",
    ).run({ id, at: retryIso, t: now() });
    return this.get(id);
  },

  /** Link the terminal a follow-up opened. */
  followedUpBy(id: string, session_id: string): Jot | undefined {
    db.prepare("UPDATE jots SET follow_up_session=@s, updated_at=@t WHERE id=@id").run({ id, s: session_id, t: now() });
    return this.get(id);
  },

  remove(id: string): boolean {
    return db.prepare("DELETE FROM jots WHERE id = ?").run(id).changes > 0;
  },

  /** Reorder within a client: the ids in the order given, everything else left where it is. */
  reorder(workspace_id: string, ids: string[]): void {
    const stmt = db.prepare("UPDATE jots SET pos=@pos, updated_at=@t WHERE id=@id AND workspace_id=@workspace_id");
    const t = now();
    db.transaction(() => {
      ids.forEach((id, i) => stmt.run({ id, pos: i, workspace_id, t }));
    })();
  },

  /** Open-row counts per workspace, for the Desk's per-client badge. */
  openCounts(): Record<string, number> {
    const rows = db.prepare(
      "SELECT workspace_id, COUNT(*) AS n FROM jots WHERE status='open' GROUP BY workspace_id",
    ).all() as Array<{ workspace_id: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.workspace_id, r.n]));
  },
};
