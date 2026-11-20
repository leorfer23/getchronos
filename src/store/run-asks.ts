import { randomUUID } from "node:crypto";
import { db } from "./db.js";

/**
 * Run-asks (migration 171; the door is src/run-asks.ts) — a command a Desk terminal asked the operator
 * to run because a guard, hook or permission refused it and only he can allow it (`mc ask-run`).
 *
 * Plain reads and writes. Every status change is one guarded UPDATE (`WHERE status = …`), so two clicks,
 * or a click racing a supersede, change a row once: the loser gets `undefined` and says so.
 *
 *   open        the terminal asked; waiting on his card
 *   running     he tapped Run; the command is running in the terminal's own sandbox
 *   ran         it exited 0 · failed  it exited non-zero, timed out, or could not start
 *   declined    he said no · superseded  the terminal asked something newer before he answered
 */
export type RunAskStatus = "open" | "running" | "ran" | "failed" | "declined" | "superseded";
export const RUN_ASK_STATUSES: readonly RunAskStatus[] = ["open", "running", "ran", "failed", "declined", "superseded"];

export interface RunAsk {
  id: string;
  session_id: string;
  workspace_id: string | null;
  /** The command as the terminal asked for it — {{placeholders}} and all. */
  command: string;
  /** Its one line on why only the operator can run it. */
  why: string;
  /** Where the agent was when it asked (its shell's cwd). The run falls back to the terminal's own. */
  cwd: string | null;
  status: RunAskStatus;
  /** The command as he actually ran it (his edits and filled-in placeholders included). */
  command_run: string | null;
  /** He changed it beyond filling in its placeholders. */
  edited: boolean;
  exit_code: number | null;
  /** The full output (stdout + stderr, interleaved, capped) — in the terminal's drop dir. */
  output_path: string | null;
  duration_ms: number | null;
  /** The end of the output when it finished: what his card shows. */
  tail: string | null;
  /** Why it was declined or failed, in one line. */
  note: string | null;
  decided_by: string | null;
  surface: string | null;
  created_at: string;
  decided_at: string | null;
  finished_at: string | null;
}

export interface NewRunAsk {
  session_id: string;
  workspace_id: string | null;
  command: string;
  why: string;
  cwd: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();
const hydrate = (r: any): RunAsk | undefined => (r ? { ...r, edited: !!r.edited } as RunAsk : undefined);
const all = (rows: unknown[]) => rows.map((r) => hydrate(r)!);

export const runAsks = {
  /**
   * Write a new open ask for its terminal. Whatever that terminal still had open is superseded first,
   * in the same transaction — one open ask per terminal, which the partial unique index also holds.
   */
  create(r: NewRunAsk, nowMs = Date.now()): { ask: RunAsk; superseded: RunAsk[] } {
    const id = randomUUID();
    const at = iso(nowMs);
    const superseded = db.transaction(() => {
      const prev = all(db.prepare("SELECT * FROM run_asks WHERE session_id = ? AND status = 'open'").all(r.session_id));
      if (prev.length) {
        db.prepare("UPDATE run_asks SET status = 'superseded', decided_at = ?, note = ? WHERE session_id = ? AND status = 'open'").run(
          at, "the terminal asked for something newer before it was answered", r.session_id,
        );
      }
      db.prepare(
        `INSERT INTO run_asks (id,session_id,workspace_id,command,why,cwd,status,created_at)
         VALUES (?,?,?,?,?,?,'open',?)`,
      ).run(id, r.session_id, r.workspace_id ?? null, r.command, r.why, r.cwd ?? null, at);
      return prev.map((p) => runAsks.get(p.id)!);
    })();
    return { ask: runAsks.get(id)!, superseded };
  },

  get(id: string): RunAsk | undefined {
    return hydrate(db.prepare("SELECT * FROM run_asks WHERE id = ?").get(id));
  },

  /** By id, or by a unique prefix of at least 8 characters (what `mc` prints). */
  find(ref: string): RunAsk | undefined {
    const v = String(ref ?? "").trim();
    if (!/^[0-9a-f-]{8,36}$/i.test(v)) return undefined;
    const hits = db.prepare("SELECT * FROM run_asks WHERE id LIKE ? LIMIT 2").all(v + "%");
    return hits.length === 1 ? hydrate(hits[0]) : undefined;
  },

  /** The terminal's one open ask, if any. */
  openFor(sessionId: string): RunAsk | undefined {
    return hydrate(db.prepare("SELECT * FROM run_asks WHERE session_id = ? AND status = 'open' LIMIT 1").get(sessionId));
  },

  /** A terminal's asks, newest first. */
  forSession(sessionId: string, limit = 20): RunAsk[] {
    return all(db.prepare("SELECT * FROM run_asks WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(sessionId, limit));
  },

  /** Newest first. `workspace_id` undefined = every workspace; null = only rows with none. */
  list(q: { statuses?: readonly RunAskStatus[]; workspace_id?: string | null; limit?: number } = {}): RunAsk[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.statuses?.length) { where.push(`status IN (${q.statuses.map(() => "?").join(",")})`); args.push(...q.statuses); }
    if (q.workspace_id !== undefined) { where.push("workspace_id IS ?"); args.push(q.workspace_id); }
    args.push(Math.max(1, Math.min(q.limit ?? 100, 500)));
    return all(db.prepare(`SELECT * FROM run_asks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args));
  },

  /** open → running, once. Undefined when it was not open any more (run, declined, superseded). */
  start(id: string, p: { command_run: string; edited: boolean; decided_by: string; surface: string | null; output_path: string }, nowMs = Date.now()): RunAsk | undefined {
    const r = db.prepare(
      `UPDATE run_asks SET status = 'running', command_run = ?, edited = ?, decided_by = ?, surface = ?, output_path = ?, decided_at = ?
       WHERE id = ? AND status = 'open'`,
    ).run(p.command_run, p.edited ? 1 : 0, p.decided_by, p.surface ?? null, p.output_path, iso(nowMs), id);
    return r.changes ? runAsks.get(id) : undefined;
  },

  /** running → ran | failed, once. */
  finish(id: string, p: { status: "ran" | "failed"; exit_code: number | null; duration_ms: number; tail: string | null; note: string | null }, nowMs = Date.now()): RunAsk | undefined {
    const r = db.prepare(
      `UPDATE run_asks SET status = ?, exit_code = ?, duration_ms = ?, tail = ?, note = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
    ).run(p.status, p.exit_code, Math.max(0, Math.round(p.duration_ms)), p.tail, p.note, iso(nowMs), id);
    return r.changes ? runAsks.get(id) : undefined;
  },

  /** open → declined, once. */
  decline(id: string, p: { decided_by: string; surface: string | null; note: string | null }, nowMs = Date.now()): RunAsk | undefined {
    const r = db.prepare(
      `UPDATE run_asks SET status = 'declined', decided_by = ?, surface = ?, note = ?, decided_at = ? WHERE id = ? AND status = 'open'`,
    ).run(p.decided_by, p.surface ?? null, p.note, iso(nowMs), id);
    return r.changes ? runAsks.get(id) : undefined;
  },

  /**
   * At boot: a row still `running` belongs to a daemon that is gone, and so does the process's result.
   * Marked failed with the reason, so no card spins forever. Returns the rows it settled.
   */
  failStale(note: string, nowMs = Date.now()): RunAsk[] {
    const stale = all(db.prepare("SELECT * FROM run_asks WHERE status = 'running'").all());
    if (!stale.length) return [];
    db.prepare("UPDATE run_asks SET status = 'failed', note = ?, finished_at = ? WHERE status = 'running'").run(note, iso(nowMs));
    return stale.map((s) => runAsks.get(s.id)!);
  },
};
