/**
 * The executor's rows (migration 159, src/executor.ts): the operator's single-use approvals and the
 * log of every attempt to carry one out. Plain reads and writes — every rule about WHEN an approval
 * may be written or used lives in src/executor.ts. Two of those rules are in the SQL itself, so no
 * caller can get them wrong: one approval per decision item (a unique index), and a claim that
 * succeeds once (`used_at` set in a single conditional UPDATE, before anything runs).
 */
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";

/** How the yes was given: a tap on a card, a strong spoken yes, or a weak one he confirmed when asked again. */
export const APPROVAL_HOWS = ["tap", "voice_strong", "voice_confirmed"] as const;
export type ApprovalHow = (typeof APPROVAL_HOWS)[number];
/** What the executor carries out. `deploy` is a seam, disabled: it will need its own yes each time. */
export const EXEC_ACTIONS = ["merge_pr", "send_draft", "deploy"] as const;
export type ExecAction = (typeof EXEC_ACTIONS)[number];

export interface Approval {
  id: string;
  request_id: string;
  decision_id: string;
  /** The request's workspace when he said yes — the wall the execution must still be inside. */
  workspace_id: string | null;
  action: ExecAction;
  /** What it acts on: the PR URL, the draft's channel:recipient. */
  target_ref: string;
  /** What he was shown and said yes to: a PR head SHA, a draft's content hash. */
  target_hash: string;
  approved_at: string;
  /** `decided_by` on the decision: the surface's own label (phone, phone-voice:strong, desk…). */
  approved_by: string | null;
  surface: string | null;
  /** His exact words. */
  transcript: string | null;
  how: ApprovalHow;
  audio_ref: string | null;
  /** An operator-only override he gave with the yes (`no_checks`), recorded as given. */
  override: string | null;
  expires_at: string;
  /** Set once, when the executor claims it — before anything runs. */
  used_at: string | null;
  /** done | refused | failed | queued | void */
  result: string | null;
  created_at: string;
}

export interface ExecLogRow {
  id: string;
  approval_id: string | null;
  request_id: string | null;
  decision_id: string | null;
  workspace_id: string | null;
  action: string;
  approved_by: string | null;
  surface: string | null;
  how: string | null;
  words: string | null;
  target_ref: string | null;
  /** The hash his yes was bound to. */
  approved_hash: string | null;
  /** What the live re-read said the target is now (null when it was never read). */
  live_hash: string | null;
  /** What ran, as a command line with no secrets in it — or null when nothing ran. */
  ran: string | null;
  /** done | refused | failed | queued | void */
  status: string;
  /** A short reason code (moved, expired, replay, no_checks, …) the voice layer can say. */
  code: string | null;
  error: string | null;
  override: string | null;
  at: string;
}

const clip = (s: string | null | undefined, n: number) => (s == null ? null : String(s).slice(0, n));

export const executorStore = {
  /** Throws on a second approval for the same decision item (the unique index). */
  createApproval(a: Omit<Approval, "id" | "used_at" | "result" | "created_at">): Approval {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO executor_approvals (id,request_id,decision_id,workspace_id,action,target_ref,target_hash,approved_at,approved_by,surface,transcript,how,audio_ref,override,expires_at,used_at,result,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)`,
    ).run(
      id, a.request_id, a.decision_id, a.workspace_id, a.action, clip(a.target_ref, 600), a.target_hash, a.approved_at, clip(a.approved_by, 60),
      clip(a.surface, 24), clip(a.transcript, 4000), a.how, clip(a.audio_ref, 400), clip(a.override, 40), a.expires_at, now(),
    );
    return executorStore.approval(id)!;
  },
  approval(id: string): Approval | undefined {
    return db.prepare("SELECT * FROM executor_approvals WHERE id = ?").get(id) as Approval | undefined;
  },
  approvalForDecision(decisionId: string): Approval | undefined {
    return db.prepare("SELECT * FROM executor_approvals WHERE decision_id = ?").get(decisionId) as Approval | undefined;
  },
  /**
   * Take it for this one execution: true exactly once, and only before it expires. The claim is the
   * single-use rule — a second caller (a replay, a race) finds `used_at` already set and gets false.
   */
  claim(id: string, atIso: string): boolean {
    return db.prepare("UPDATE executor_approvals SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?").run(atIso, id, atIso).changes === 1;
  },
  /** Past its time and never used: used up now, so it can never run late. */
  expire(id: string, atIso: string): boolean {
    return db.prepare("UPDATE executor_approvals SET used_at = ?, result = 'expired' WHERE id = ? AND used_at IS NULL").run(atIso, id).changes === 1;
  },
  finish(id: string, result: string): void {
    db.prepare("UPDATE executor_approvals SET result = ? WHERE id = ?").run(result, id);
  },
  /** Approvals nobody used (the daemon stopped between the yes and the run): used up, never run. */
  voidUnused(atIso: string): Approval[] {
    const rows = db.prepare("SELECT * FROM executor_approvals WHERE used_at IS NULL").all() as Approval[];
    db.prepare("UPDATE executor_approvals SET used_at = ?, result = 'void' WHERE used_at IS NULL").run(atIso);
    return rows;
  },

  log(e: Omit<ExecLogRow, "id" | "at"> & { at?: string }): ExecLogRow {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO executor_log (id,approval_id,request_id,decision_id,workspace_id,action,approved_by,surface,how,words,target_ref,approved_hash,live_hash,ran,status,code,error,override,at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, e.approval_id, e.request_id, e.decision_id, e.workspace_id, e.action, clip(e.approved_by, 60), clip(e.surface, 24), clip(e.how, 24),
      clip(e.words, 4000), clip(e.target_ref, 600), clip(e.approved_hash, 200), clip(e.live_hash, 200), clip(e.ran, 1000), e.status,
      clip(e.code, 40), clip(e.error, 2000), clip(e.override, 40), e.at ?? now(),
    );
    return db.prepare("SELECT * FROM executor_log WHERE id = ?").get(id) as ExecLogRow;
  },
  /** Newest first. Every filter optional; the operator's view spans every workspace. */
  logRows(f: { request_id?: string; workspace_id?: string; approval_id?: string; status?: string; limit?: number } = {}): ExecLogRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.request_id) { where.push("request_id = ?"); params.push(f.request_id); }
    if (f.workspace_id) { where.push("workspace_id = ?"); params.push(f.workspace_id); }
    if (f.approval_id) { where.push("approval_id = ?"); params.push(f.approval_id); }
    if (f.status) { where.push("status = ?"); params.push(f.status); }
    params.push(Math.max(1, Math.min(f.limit ?? 50, 500)));
    return db.prepare(
      "SELECT * FROM executor_log" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY at DESC, rowid DESC LIMIT ?",
    ).all(...params) as ExecLogRow[];
  },
};
