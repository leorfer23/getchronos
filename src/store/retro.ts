import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";

/**
 * The weekly self-retro's rows (migration 161, src/retro-pass.ts).
 *
 *   retro_runs       one per workspace per week:  gathering → gathered → dispatched → applied
 *                                                       └──────────┴──────────┴──→ failed | abandoned
 *   retro_proposals  one rule (or, in the product workspace, one improvement) waiting on the operator:
 *                    pending → approved | dismissed. (workspace, key) is unique, so a dismissed one is
 *                    never proposed again — the same once-only debounce the kv sweeps use, walled per
 *                    workspace and gone with it.
 *
 * Every read takes a workspace id: the wall holds in the query.
 */
export type RetroStatus = "gathering" | "gathered" | "dispatched" | "applied" | "failed" | "abandoned";
export type RetroSource = "slot" | "manual";

export interface RetroRun {
  id: string;
  workspace_id: string;
  slot: string | null;
  source: RetroSource;
  status: RetroStatus;
  /** The week read: [since, until). */
  since: string;
  until: string;
  /** JSON RetroStats — this workspace's own numbers and examples. Never leaves the workspace. */
  stats: string | null;
  /** JSON Record<finding key, count> — enums and counts only, built by code: the one thing that may leave. */
  findings: string | null;
  /** JSON Candidate[] — the operator's corrections and repeated asks the job turns into rules. */
  candidates: string | null;
  /** Markdown the operator reads. */
  report: string | null;
  /** Product workspace only: JSON { workspaces, counts } summed from every workspace's findings. */
  aggregate: string | null;
  job_id: string | null;
  run_id: string | null;
  error: string | null;
  created_at: string;
  gathered_at: string | null;
  finished_at: string | null;
}

export type ProposalKind = "rule" | "product";
export type ProposalSource = "correction" | "repeat" | "verifier" | "product";
export type ProposalStatus = "pending" | "approved" | "dismissed";

export interface RetroProposal {
  id: string;
  workspace_id: string;
  run_id: string | null;
  kind: ProposalKind;
  source: ProposalSource;
  /** Stable identity within the workspace (verifier:<check>, or a hash of the wording). */
  key: string;
  /** The one-line rule, or the improvement's title. */
  text: string;
  /** Rule: what it answers. Product: why + the change. */
  detail: string | null;
  /** Rule: the operator phrase it answers — seen again after approval, the rule failed. */
  match: string | null;
  /** How many times the pattern was seen when it was proposed. */
  evidence: number;
  status: ProposalStatus;
  decided_at: string | null;
  decided_by: string | null;
  /** What an approval wrote: the memory line's hash, or the ticket key. */
  ref: string | null;
  created_at: string;
}

const OPEN: RetroStatus[] = ["gathering", "gathered", "dispatched"];

export const retroRuns = {
  create(r: { workspace_id: string; source: RetroSource; slot?: string | null; since: string; until: string }): RetroRun {
    const id = randomUUID();
    db.prepare("INSERT INTO retro_runs (id,workspace_id,slot,source,status,since,until,created_at) VALUES (?,?,?,?,'gathering',?,?,?)")
      .run(id, r.workspace_id, r.slot ?? null, r.source, r.since, r.until, now());
    return this.get(id)!;
  },
  get(id: string): RetroRun | undefined {
    return db.prepare("SELECT * FROM retro_runs WHERE id = ?").get(id) as RetroRun | undefined;
  },
  patch(id: string, p: Partial<Omit<RetroRun, "id" | "workspace_id" | "created_at">>): RetroRun | undefined {
    const keys = Object.keys(p).filter((k) => (p as any)[k] !== undefined);
    if (keys.length) db.prepare(`UPDATE retro_runs SET ${keys.map((k) => `${k}=@${k}`).join(", ")} WHERE id=@id`).run({ ...p, id });
    return this.get(id);
  },
  /** Newest first, ONE workspace. */
  list(workspace_id: string, limit = 10): RetroRun[] {
    return db.prepare("SELECT * FROM retro_runs WHERE workspace_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(workspace_id, limit) as RetroRun[];
  },
  open(workspace_id: string): RetroRun[] {
    return db.prepare(`SELECT * FROM retro_runs WHERE workspace_id=? AND status IN (${OPEN.map(() => "?").join(",")}) ORDER BY created_at DESC, rowid DESC`)
      .all(workspace_id, ...OPEN) as RetroRun[];
  },
  /**
   * The newest run that got as far as numbers — what the Desk shows. An abandoned run (its job never
   * applied) still has a true week of numbers; only a failed one has none.
   */
  latest(workspace_id: string, before?: string): RetroRun | undefined {
    return db.prepare(
      `SELECT * FROM retro_runs WHERE workspace_id=? AND stats IS NOT NULL AND status IN ('gathered','dispatched','applied','abandoned')
       ${before ? "AND until < ?" : ""} ORDER BY until DESC, created_at DESC, rowid DESC LIMIT 1`,
    ).get(...(before ? [workspace_id, before] : [workspace_id])) as RetroRun | undefined;
  },
};

export const retroProposals = {
  /** Insert unless (workspace, key) already exists in ANY status. Null = it existed (pending, approved or dismissed). */
  add(p: { workspace_id: string; run_id: string | null; kind: ProposalKind; source: ProposalSource; key: string; text: string; detail?: string | null; match?: string | null; evidence?: number }): RetroProposal | null {
    const id = randomUUID();
    const r = db.prepare(
      `INSERT OR IGNORE INTO retro_proposals (id,workspace_id,run_id,kind,source,key,text,detail,match,evidence,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?)`,
    ).run(id, p.workspace_id, p.run_id, p.kind, p.source, p.key, p.text, p.detail ?? null, p.match ?? null, p.evidence ?? 0, now());
    return r.changes ? this.get(id)! : null;
  },
  get(id: string): RetroProposal | undefined {
    return db.prepare("SELECT * FROM retro_proposals WHERE id = ?").get(id) as RetroProposal | undefined;
  },
  /** ONE workspace, newest first; optionally one status / kind. */
  list(workspace_id: string, f: { status?: ProposalStatus; kind?: ProposalKind } = {}): RetroProposal[] {
    const where = ["workspace_id = ?"];
    const args: unknown[] = [workspace_id];
    if (f.status) { where.push("status = ?"); args.push(f.status); }
    if (f.kind) { where.push("kind = ?"); args.push(f.kind); }
    return db.prepare(`SELECT * FROM retro_proposals WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT 500`).all(...args) as RetroProposal[];
  },
  /** pending → approved | dismissed, once. Null when it was not pending any more. */
  decide(id: string, d: { status: "approved" | "dismissed"; by: string; ref?: string | null; text?: string }): RetroProposal | null {
    const r = db.prepare("UPDATE retro_proposals SET status=?, decided_at=?, decided_by=?, ref=?, text=COALESCE(?, text) WHERE id=? AND status='pending'")
      .run(d.status, now(), d.by.slice(0, 40), d.ref ?? null, d.text ?? null, id);
    return r.changes ? this.get(id)! : null;
  },
};
