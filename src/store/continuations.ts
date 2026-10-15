import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";

/**
 * A continuation is "pick this work back up when <condition>" — see migration 145 and
 * src/continuations.ts. The store is dumb on purpose: conditions, policy, caps and delivery live in
 * the engine so the tests can drive it without a daemon.
 */
export type ContinuationKind = "pr" | "terminal" | "ask" | "at" | "script" | "check" | "manual";
export type ContinuationStatus = "armed" | "met" | "fired" | "cancelled";
export type ContinuationOutcome = "met" | "timeout" | "manual" | "broken";
export type ContinuationThen = "auto" | "resume" | "new";

export type Continuation = {
  id: string;
  workspace_id: string;
  /** The terminal to continue. Null = open a fresh terminal on `goal`. */
  session_id: string | null;
  kind: ContinuationKind;
  /** pr: the PR URL · terminal: a session id · ask: an ask id · script: the command · check: the question in words. */
  target: string | null;
  /** pr: review|approved|changes|merged|closed|checks|green|change · terminal: done|ended. */
  until: string | null;
  /** One line for the card and the lists ("PR #12 approved"). */
  label: string;
  /** What to do once it is met — handed back to the agent with the evidence. */
  note: string | null;
  /** Goal of the fresh terminal when there is no session to continue (or `on_met` is new). */
  goal: string | null;
  /** auto (resume if it can, else fresh) | resume (only on its own transcript) | new (always fresh). */
  on_met: ContinuationThen;
  every_sec: number | null;
  status: ContinuationStatus;
  outcome: ContinuationOutcome | null;
  evidence: string | null;
  baseline: string | null;
  round: number;
  created_by: string | null;
  created_at: string;
  next_check_at: string | null;
  timeout_at: string | null;
  last_check_at: string | null;
  last_check: string | null;
  checks: number;
  errors: number;
  check_run_id: string | null;
  met_at: string | null;
  fired_at: string | null;
  fired_session_id: string | null;
  /** typed (into the live terminal) | resumed (same transcript) | opened (a fresh terminal). */
  fired_how: string | null;
};

export type NewContinuation = Pick<Continuation, "workspace_id" | "kind" | "label"> &
  Partial<Pick<Continuation,
    "session_id" | "target" | "until" | "note" | "goal" | "on_met" | "every_sec" | "baseline" | "round" |
    "created_by" | "next_check_at" | "timeout_at">>;

export const continuations = {
  create(p: NewContinuation): Continuation {
    const row = {
      id: randomUUID(),
      workspace_id: p.workspace_id,
      session_id: p.session_id ?? null,
      kind: p.kind,
      target: p.target ?? null,
      until: p.until ?? null,
      label: p.label,
      note: p.note ?? null,
      goal: p.goal ?? null,
      on_met: p.on_met ?? "auto",
      every_sec: p.every_sec ?? null,
      baseline: p.baseline ?? null,
      round: p.round ?? 0,
      created_by: p.created_by ?? null,
      created_at: now(),
      next_check_at: p.next_check_at ?? null,
      timeout_at: p.timeout_at ?? null,
    };
    db.prepare(
      `INSERT INTO continuations (id,workspace_id,session_id,kind,target,until,label,note,goal,on_met,every_sec,
        baseline,round,created_by,created_at,next_check_at,timeout_at)
       VALUES (@id,@workspace_id,@session_id,@kind,@target,@until,@label,@note,@goal,@on_met,@every_sec,
        @baseline,@round,@created_by,@created_at,@next_check_at,@timeout_at)`,
    ).run(row);
    return this.get(row.id)!;
  },

  get(id: string): Continuation | undefined {
    return db.prepare("SELECT * FROM continuations WHERE id = ?").get(id) as Continuation | undefined;
  },

  /** By full id or a unique prefix (the 8 chars every surface prints). */
  resolve(ref: string): Continuation | undefined {
    const r = String(ref ?? "").trim();
    if (!/^[0-9a-f-]{4,36}$/i.test(r)) return undefined;
    const hits = db.prepare("SELECT * FROM continuations WHERE id LIKE ? LIMIT 2").all(r + "%") as Continuation[];
    return hits.length === 1 ? hits[0] : undefined;
  },

  list(f: { workspace_id?: string; session_id?: string; status?: ContinuationStatus | ContinuationStatus[]; limit?: number } = {}): Continuation[] {
    const where: string[] = [];
    const args: Record<string, unknown> = {};
    if (f.workspace_id) { where.push("workspace_id = @workspace_id"); args.workspace_id = f.workspace_id; }
    if (f.session_id) { where.push("session_id = @session_id"); args.session_id = f.session_id; }
    if (f.status) {
      const st = Array.isArray(f.status) ? f.status : [f.status];
      where.push(`status IN (${st.map((_, i) => `@st${i}`).join(",")})`);
      st.forEach((s, i) => { args[`st${i}`] = s; });
    }
    args.limit = f.limit ?? 200;
    return db.prepare(
      `SELECT * FROM continuations${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT @limit`,
    ).all(args) as Continuation[];
  },

  /** Rows the scheduler owes a look: armed and due, or met and waiting for a seat. */
  due(nowIso: string): Continuation[] {
    return db.prepare(
      `SELECT * FROM continuations WHERE status IN ('armed','met') AND next_check_at IS NOT NULL AND next_check_at <= ?
       ORDER BY next_check_at`,
    ).all(nowIso) as Continuation[];
  },

  nextDueAt(): string | null {
    const r = db.prepare(
      "SELECT MIN(next_check_at) AS at FROM continuations WHERE status IN ('armed','met') AND next_check_at IS NOT NULL",
    ).get() as { at: string | null };
    return r.at;
  },

  /** Armed rows of one kind whose target is this id — the bus handlers' lookup. */
  armedFor(kind: ContinuationKind, target: string): Continuation[] {
    return db.prepare("SELECT * FROM continuations WHERE status='armed' AND kind=? AND target=?").all(kind, target) as Continuation[];
  },

  countArmed(f: { session_id?: string; workspace_id?: string }): number {
    if (f.session_id) return (db.prepare("SELECT COUNT(*) n FROM continuations WHERE status IN ('armed','met') AND session_id=?").get(f.session_id) as { n: number }).n;
    return (db.prepare("SELECT COUNT(*) n FROM continuations WHERE status IN ('armed','met') AND workspace_id=?").get(f.workspace_id ?? "") as { n: number }).n;
  },

  /** Record one look that did not fire: when, what it saw, and when to look next. */
  checked(id: string, p: { at: string; saw: string | null; next: string | null; error?: boolean }): void {
    db.prepare(
      `UPDATE continuations SET last_check_at=@at, last_check=@saw, next_check_at=@next, checks=checks+1,
        errors=CASE WHEN @error THEN errors+1 ELSE 0 END WHERE id=@id AND status='armed'`,
    ).run({ id, at: p.at, saw: p.saw, next: p.next, error: p.error ? 1 : 0 });
  },

  setNext(id: string, next: string | null): void {
    db.prepare("UPDATE continuations SET next_check_at=? WHERE id=?").run(next, id);
  },

  setCheckRun(id: string, runId: string | null): void {
    db.prepare("UPDATE continuations SET check_run_id=? WHERE id=?").run(runId, id);
  },

  /**
   * armed → met, exactly once. Guarded on status so a bus event and a poll racing on the same row
   * cannot both claim it. next_check_at = now so the scheduler delivers it on its next pass.
   */
  markMet(id: string, p: { outcome: ContinuationOutcome; evidence: string | null; at: string }): boolean {
    return db.prepare(
      `UPDATE continuations SET status='met', outcome=@outcome, evidence=@evidence, met_at=@at, next_check_at=@at, check_run_id=NULL
       WHERE id=@id AND status='armed'`,
    ).run({ id, ...p }).changes > 0;
  },

  /** met → fired. Guarded the same way: one delivery per continuation, ever. */
  markFired(id: string, p: { session_id: string; how: string; at: string }): boolean {
    return db.prepare(
      `UPDATE continuations SET status='fired', fired_at=@at, fired_session_id=@session_id, fired_how=@how, next_check_at=NULL
       WHERE id=@id AND status='met'`,
    ).run({ id, ...p }).changes > 0;
  },

  cancel(id: string, why: string | null): boolean {
    return db.prepare(
      "UPDATE continuations SET status='cancelled', evidence=COALESCE(@why, evidence), next_check_at=NULL, check_run_id=NULL WHERE id=@id AND status IN ('armed','met')",
    ).run({ id, why }).changes > 0;
  },

  /** How many continuations already fired for this terminal — the chain's round counter. */
  firedFor(session_id: string): number {
    return (db.prepare("SELECT COALESCE(MAX(round),0) r FROM continuations WHERE status='fired' AND (session_id=@s OR fired_session_id=@s)").get({ s: session_id }) as { r: number }).r;
  },
};
