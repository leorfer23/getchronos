import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";
import type { GoalKind, GoalSource, SessionGoal } from "../types.js";

/**
 * More than one finish line for one terminal.
 *
 * A Desk card shows ONE goal — that is the whole point of the wall, and nothing here changes it.
 * What changes is how many the operator may queue behind it: "open the rollback PR", then "update
 * the runbook", then "tell #eng". The terminal works them in order and ticks them off one at a
 * time (`mc goal done`), and only when the last one is ticked is the TERMINAL done.
 *
 * The mirror is the trick that keeps every existing surface honest. `sessions.goal`, `goal_kind`
 * and `goal_done_at` are still the columns the Desk, Robert, the fleet line, the digest and the
 * phase machine read — they now hold the CURRENT goal (the first one not ticked), rewritten by
 * `sync()` after every change. A terminal with one goal has no rows here at all and behaves
 * exactly as it did before this table existed.
 */

const rowToGoal = (r: any): SessionGoal => ({
  id: r.id,
  session_id: r.session_id,
  seq: r.seq,
  text: r.text,
  kind: r.kind ?? null,
  source: r.source ?? null,
  done_at: r.done_at ?? null,
  created_at: r.created_at,
});

/** The session columns this list mirrors into. Written by `sync`, read by everything else. */
type Mirror = { goal: string | null; goal_kind: GoalKind | null; goal_done_at: string | null };

export const sessionGoals = {
  /** The whole list, in the order the operator queued it. Empty = this terminal never had a list. */
  list(sessionId: string): SessionGoal[] {
    return (db
      .prepare("SELECT * FROM session_goals WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as any[]).map(rowToGoal);
  },
  get(id: string): SessionGoal | undefined {
    const r = db.prepare("SELECT * FROM session_goals WHERE id = ?").get(id) as any;
    return r ? rowToGoal(r) : undefined;
  },
  /** The one the card shows: the first goal not ticked off, or undefined once they all are. */
  current(sessionId: string): SessionGoal | undefined {
    const r = db
      .prepare("SELECT * FROM session_goals WHERE session_id = ? AND done_at IS NULL ORDER BY seq LIMIT 1")
      .get(sessionId) as any;
    return r ? rowToGoal(r) : undefined;
  },
  counts(sessionId: string): { total: number; done: number } {
    const r = db
      .prepare("SELECT COUNT(*) total, SUM(CASE WHEN done_at IS NOT NULL THEN 1 ELSE 0 END) done FROM session_goals WHERE session_id = ?")
      .get(sessionId) as { total: number; done: number | null };
    return { total: r?.total ?? 0, done: r?.done ?? 0 };
  },

  /**
   * Turn a single-goal terminal into a list, once, without a backfill migration: the goal already on
   * the row becomes item #1, carrying its kind, its source and its tick. Called before every append,
   * so the first `mc goal add` on a terminal opened the old way does the right thing by itself.
   */
  adopt(session: { id: string; goal: string | null; goal_kind: GoalKind | null; goal_source: GoalSource | null; goal_done_at: string | null }): void {
    if (!session.goal?.trim()) return;
    const existing = db
      .prepare("SELECT COUNT(*) c FROM session_goals WHERE session_id = ?")
      .get(session.id) as { c: number };
    if (existing.c > 0) return;
    db.prepare(
      "INSERT INTO session_goals (id,session_id,seq,text,kind,source,done_at,created_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(randomUUID(), session.id, 1, session.goal.trim(), session.goal_kind ?? null, session.goal_source ?? null, session.goal_done_at ?? null, now());
  },

  /** Append one. Returns the row; the caller mirrors with `sync`. */
  add(
    sessionId: string,
    g: { text: string; kind?: GoalKind | null; source?: GoalSource | null; done?: boolean },
  ): SessionGoal {
    const text = g.text.trim();
    if (!text) throw new Error("a goal needs words");
    const max = (db.prepare("SELECT COALESCE(MAX(seq),0) m FROM session_goals WHERE session_id = ?").get(sessionId) as { m: number }).m;
    const id = randomUUID();
    db.prepare(
      "INSERT INTO session_goals (id,session_id,seq,text,kind,source,done_at,created_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(id, sessionId, max + 1, text, g.kind ?? null, g.source ?? "human", g.done ? now() : null, now());
    return this.get(id)!;
  },

  /** Edit one in place — retitle it, reshape it, tick it or untick it. */
  patch(
    id: string,
    p: { text?: string; kind?: GoalKind | null; source?: GoalSource | null; done?: boolean },
  ): SessionGoal | undefined {
    const sets: string[] = [];
    const params: any[] = [];
    if (p.text !== undefined) {
      const t = p.text.trim();
      if (!t) throw new Error("a goal needs words");
      sets.push("text=?");
      params.push(t);
    }
    if (p.kind !== undefined) { sets.push("kind=?"); params.push(p.kind); }
    if (p.source !== undefined) { sets.push("source=?"); params.push(p.source); }
    if (p.done !== undefined) { sets.push("done_at=?"); params.push(p.done ? now() : null); }
    if (!sets.length) return this.get(id);
    params.push(id);
    db.prepare(`UPDATE session_goals SET ${sets.join(", ")} WHERE id=?`).run(...params);
    return this.get(id);
  },

  /** Drop one and close the gap, so `seq` stays 1..n and `mc goal done 2` keeps meaning item two. */
  remove(id: string): boolean {
    const g = this.get(id);
    if (!g) return false;
    db.prepare("DELETE FROM session_goals WHERE id=?").run(id);
    db.prepare("UPDATE session_goals SET seq = seq - 1 WHERE session_id = ? AND seq > ?").run(g.session_id, g.seq);
    return true;
  },

  /** Replace the whole list (`mc goal set` with several, the spawn dialog's multi-goal field). */
  replace(
    sessionId: string,
    goals: Array<{ text: string; kind?: GoalKind | null }>,
    source: GoalSource = "human",
  ): SessionGoal[] {
    db.prepare("DELETE FROM session_goals WHERE session_id = ?").run(sessionId);
    for (const g of goals) this.add(sessionId, { ...g, source });
    return this.list(sessionId);
  },

  clear(sessionId: string): void {
    db.prepare("DELETE FROM session_goals WHERE session_id = ?").run(sessionId);
  },

  /**
   * Tick the current goal off and hand back the one that follows. This is `mc goal done` for a
   * terminal with a list: the card moves to the next line instead of going dark, and the terminal
   * only reads as finished when nothing follows.
   */
  tickCurrent(sessionId: string): { ticked: SessionGoal | undefined; next: SessionGoal | undefined } {
    const cur = this.current(sessionId);
    if (!cur) return { ticked: undefined, next: undefined };
    this.patch(cur.id, { done: true });
    return { ticked: this.get(cur.id), next: this.current(sessionId) };
  },

  /** Every goal ticked, in one move — the operator closing a card that is good enough. */
  tickAll(sessionId: string): void {
    db.prepare("UPDATE session_goals SET done_at = ? WHERE session_id = ? AND done_at IS NULL").run(now(), sessionId);
  },

  /** Nothing left open, and there was something to be open. */
  allDone(sessionId: string): boolean {
    const c = this.counts(sessionId);
    return c.total > 0 && c.done === c.total;
  },

  /**
   * What `sessions.goal` / `goal_kind` / `goal_done_at` should say now: the current goal, or — once
   * they are all ticked — the last one, with the moment the list was finished. Returns null when the
   * terminal has no list, which means "leave the columns alone, they are the goal".
   */
  mirror(sessionId: string): Mirror | null {
    const all = this.list(sessionId);
    if (!all.length) return null;
    const open = all.find((g) => !g.done_at);
    if (open) return { goal: open.text, goal_kind: open.kind, goal_done_at: null };
    const last = all[all.length - 1];
    // The list is finished when its LAST tick landed, not its first — a terminal that ticked #1 at
    // 10:00 and #3 at 14:00 finished at 14:00.
    const finishedAt = all.reduce((acc, g) => (g.done_at && g.done_at > acc ? g.done_at : acc), "");
    return { goal: last.text, goal_kind: last.kind, goal_done_at: finishedAt || now() };
  },
};
