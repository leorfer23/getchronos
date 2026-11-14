/**
 * Trial rows (migration 161): one per analysis hand-off chain — a terminal's hand-offs for one request —
 * with the arm it ran in and what came of it, so an experiment can be read a week later. Plain reads and
 * keyed writes; when to write lives in src/red-team-trial.ts, what the numbers mean in src/red-team.ts.
 * Every row carries its workspace: the report reads one workspace's rows, never another's.
 */
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";

export interface TrialRow {
  id: string;
  trial: string;
  workspace_id: string;
  session_id: string;
  /** The ledger request it answers; null while the ledger has not linked the terminal yet. */
  request_id: string | null;
  /** The workspace's trial setting at its first hand-off. */
  arm: "on" | "off";
  /** Its first prompt carried the protocol. */
  protocol: boolean;
  /** When it was asked (the request), else when the terminal opened. */
  started_at: string;
  first_handoff_at: string;
  last_handoff_at: string;
  handoffs: number;
  /** Hypotheses on its fullest hand-off: did it work hypotheses-first at all. */
  hypotheses: number;
  /** The first verifier pass that found it ready. */
  ready_at: string | null;
  /** Rework rounds the verifier told it, all reasons. */
  rounds: number;
  /** Rounds that sent it back for the verifier's own checks (not only the red team's findings). */
  rejections: number;
  /** Check → rounds it was among the reasons. */
  aspects: Record<string, number>;
  /** null = no red team on it · ran · skipped (no verdict, or no engine other than the worker's). */
  red_team: "ran" | "skipped" | null;
  findings: number;
  /** Findings its hand-offs answered, and how many of those were fixed (a change). */
  answered: number;
  changed: number;
  /** The operator's own typed turns into the terminal after its first hand-off. */
  operator_turns: number;
  updated_at: string;
}

const row = (r: any): TrialRow | undefined => {
  if (!r) return undefined;
  let aspects: Record<string, number> = {};
  try { const j = r.aspects ? JSON.parse(r.aspects) : {}; if (j && typeof j === "object" && !Array.isArray(j)) aspects = j; } catch {}
  return { ...r, protocol: !!r.protocol, aspects };
};

export const trials = {
  /**
   * The chain a hand-off of this terminal belongs to: the row for this request, else (the ledger may link
   * the terminal later) the newest one not yet tied to a request.
   */
  find(trial: string, sessionId: string, requestId: string | null): TrialRow | undefined {
    if (requestId) {
      const hit = db.prepare("SELECT * FROM trial_handoffs WHERE trial = ? AND session_id = ? AND request_id = ?").get(trial, sessionId, requestId);
      if (hit) return row(hit);
    }
    return row(db.prepare("SELECT * FROM trial_handoffs WHERE trial = ? AND session_id = ? AND request_id IS NULL ORDER BY first_handoff_at DESC, rowid DESC LIMIT 1").get(trial, sessionId));
  },
  /** The first hand-off of a chain. Keyed by (trial, terminal, request): a replay writes nothing new. */
  open(r: { trial: string; workspace_id: string; session_id: string; request_id: string | null; arm: "on" | "off"; protocol: boolean; started_at: string; handoff_at: string; hypotheses: number }): TrialRow {
    const t = now();
    db.prepare(
      `INSERT OR IGNORE INTO trial_handoffs (id,trial,workspace_id,session_id,request_id,arm,protocol,started_at,first_handoff_at,last_handoff_at,handoffs,hypotheses,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    ).run(randomUUID(), r.trial, r.workspace_id, r.session_id, r.request_id, r.arm, r.protocol ? 1 : 0, r.started_at, r.handoff_at, r.handoff_at, r.hypotheses, t);
    return trials.find(r.trial, r.session_id, r.request_id)!;
  },
  get(id: string): TrialRow | undefined {
    return row(db.prepare("SELECT * FROM trial_handoffs WHERE id = ?").get(id));
  },
  /** Another hand-off in the chain: counted once per hand-off (its `at`), whatever replays it. */
  handoff(id: string, at: string, hypotheses: number): void {
    db.prepare("UPDATE trial_handoffs SET handoffs = handoffs + (CASE WHEN last_handoff_at = ? THEN 0 ELSE 1 END), last_handoff_at = ?, hypotheses = MAX(hypotheses, ?), updated_at = ? WHERE id = ?")
      .run(at, at, hypotheses, now(), id);
  },
  /** The ledger linked the terminal after its first hand-off. */
  setRequest(id: string, requestId: string): void {
    db.prepare("UPDATE trial_handoffs SET request_id = ?, updated_at = ? WHERE id = ? AND request_id IS NULL").run(requestId, now(), id);
  },
  /** One verifier pass over it: a round told (and what for), and the first time it was found ready. */
  pass(id: string, p: { told: boolean; names: string[]; ready: boolean; at: string }): void {
    const cur = trials.get(id);
    if (!cur) return;
    const aspects = { ...cur.aspects };
    if (p.told) for (const n of new Set(p.names)) aspects[n] = (aspects[n] ?? 0) + 1;
    const own = p.told && p.names.some((n) => n !== "red_team");
    db.prepare("UPDATE trial_handoffs SET rounds = rounds + ?, rejections = rejections + ?, aspects = ?, ready_at = COALESCE(ready_at, ?), updated_at = ? WHERE id = ?")
      .run(p.told ? 1 : 0, own ? 1 : 0, JSON.stringify(aspects), p.ready ? p.at : null, now(), id);
  },
  /** The red team ran on it (with this many findings) or was skipped — the first word stands. */
  redTeam(id: string, status: "ran" | "skipped", findings: number): void {
    db.prepare("UPDATE trial_handoffs SET red_team = ?, findings = ?, updated_at = ? WHERE id = ? AND (red_team IS NULL OR red_team = 'skipped')")
      .run(status, findings, now(), id);
  },
  /** How its newest hand-off answered the findings. */
  answers(id: string, answered: number, changed: number): void {
    db.prepare("UPDATE trial_handoffs SET answered = ?, changed = ?, updated_at = ? WHERE id = ?").run(answered, changed, now(), id);
  },
  /** Does this terminal have a chain of any trial? (The cheap test before counting a turn.) */
  hasSession(sessionId: string): boolean {
    return !!db.prepare("SELECT 1 FROM trial_handoffs WHERE session_id = ? LIMIT 1").get(sessionId);
  },
  /**
   * One typed turn of the operator's into a terminal: counted on its newest chain that was already handed
   * off — unless the terminal has since moved on to another request (that turn is new work, not a follow-up).
   */
  turn(sessionId: string, currentRequestId: string | null, at: string): boolean {
    return db.prepare(
      `UPDATE trial_handoffs SET operator_turns = operator_turns + 1, updated_at = ?
       WHERE id = (SELECT id FROM trial_handoffs WHERE session_id = ? AND first_handoff_at <= ? ORDER BY first_handoff_at DESC, rowid DESC LIMIT 1)
         AND (request_id IS NULL OR ? IS NULL OR request_id = ?)`,
    ).run(now(), sessionId, at, currentRequestId, currentRequestId).changes > 0;
  },
  /** One workspace's chains of a trial, first hand-off at/after `since`, oldest first. */
  list(trial: string, workspaceId: string, since: string): TrialRow[] {
    return (db.prepare("SELECT * FROM trial_handoffs WHERE trial = ? AND workspace_id = ? AND first_handoff_at >= ? ORDER BY first_handoff_at ASC, rowid ASC").all(trial, workspaceId, since) as any[]).map((r) => row(r)!);
  },
  /** Workspaces with chains of a trial since `since` — the operator's report without --ws. */
  workspacesWith(trial: string, since: string): string[] {
    return (db.prepare("SELECT DISTINCT workspace_id FROM trial_handoffs WHERE trial = ? AND first_handoff_at >= ?").all(trial, since) as Array<{ workspace_id: string }>).map((r) => r.workspace_id);
  },
};
