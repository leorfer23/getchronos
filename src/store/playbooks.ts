import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";

/**
 * Playbooks: a workspace's recurring multi-step chain (merge → release → refresh a service → republish
 * → draft "it is live"), run on ONE operator OK. Migration 161; the logic that acts on these rows —
 * parsing, the workspace walls, drafting from a transcript, the run's gates — is src/playbooks.ts.
 *
 * A run copies the playbook's steps when it is created and never changes them: editing a playbook
 * while a run is in flight changes the NEXT run, never what the operator already OK'd.
 */

/** shell: a command · mc: an `mc …` command · agent: an instruction · message: the final note — always a draft. */
export type PlaybookStepKind = "shell" | "mc" | "agent" | "message";
export const STEP_KINDS: readonly PlaybookStepKind[] = ["shell", "mc", "agent", "message"];
/** The steps one OK has to name: they change something other people see or use. */
export type GateKind = "merge" | "deploy" | "publish" | "release";
export const GATE_KINDS: readonly GateKind[] = ["merge", "deploy", "publish", "release"];

export type PlaybookStep = {
  kind: PlaybookStepKind;
  /** shell/mc: the command (an mc step starts with `mc `) · agent: the instruction · message: the text. */
  run: string;
  gate: GateKind | null;
  /** message only: who the draft is for, and where. */
  to?: string | null;
  channel?: "slack" | "email" | null;
};

export type RunStepStatus = "todo" | "active" | "done" | "failed" | "skipped";
export type PlaybookRunStep = PlaybookStep & {
  idx: number;
  status: RunStepStatus;
  note: string | null;
  started_at: string | null;
  ended_at: string | null;
  /** The command as it was handed out when the step started (its target filled in). */
  ran?: string | null;
};

/**
 * awaiting_ok — created; nothing runs until the operator's OK
 * running     — OK'd; its terminal is working through the steps
 * needs_ok    — stopped before a gate because the PR head moved after the OK; a new OK resumes it
 * done        — every step done
 * failed      — a step failed; the run stopped there and asked. Never re-run — a new run is.
 * stopped     — stopped by someone (or its terminal could not open)
 * expired     — no OK, or not finished, within the run's lifetime
 */
export type RunState = "awaiting_ok" | "running" | "needs_ok" | "done" | "failed" | "stopped" | "expired";
export const LIVE_RUN_STATES: readonly RunState[] = ["awaiting_ok", "running", "needs_ok"];

export type Playbook = {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  /** The repo its terminal opens in; null = the workspace's landing dir. */
  repo_id: string | null;
  steps: PlaybookStep[];
  source: "hand" | "session";
  /** The terminal it was drafted from (`mc playbook save --from-session`). */
  drafted_from: string | null;
  /** Set when the operator saved it himself; cleared when anyone else changes it. */
  reviewed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/** One gate the OK covered: which step, what kind, and a hash of exactly what that step runs. */
export type OkGate = { idx: number; gate: GateKind; hash: string };

export type PlaybookRun = {
  id: string;
  playbook_id: string;
  workspace_id: string;
  name: string;
  steps: PlaybookRunStep[];
  pr_url: string | null;
  pr_number: number | null;
  /** The PR head the run targets: read when it was created, updated when it moved (before an OK). */
  head_sha: string | null;
  state: RunState;
  reason: string | null;
  from_step: number;
  /** The terminal it runs in (set when the OK opens or picks it). */
  session_id: string | null;
  /** Run in the terminal that asked for it rather than a new one. */
  here: number;
  requested_by: string | null;
  requested_session: string | null;
  ok_sha: string | null;
  ok_gates: OkGate[] | null;
  ok_by: string | null;
  ok_at: string | null;
  ok_surface: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
};

/** A name is what `mc playbook <name>` takes: short, no spaces. */
export const PLAYBOOK_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

function parse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

type Row = Record<string, unknown>;
const toPlaybook = (r: Row | undefined): Playbook | undefined =>
  r ? ({ ...(r as unknown as Playbook), steps: parse<PlaybookStep[]>(r.steps, []) }) : undefined;
const toRun = (r: Row | undefined): PlaybookRun | undefined =>
  r ? ({ ...(r as unknown as PlaybookRun), steps: parse<PlaybookRunStep[]>(r.steps, []), ok_gates: parse<OkGate[] | null>(r.ok_gates, null) }) : undefined;

export type NewPlaybook = {
  workspace_id: string;
  name: string;
  steps: PlaybookStep[];
  description?: string | null;
  repo_id?: string | null;
  source?: "hand" | "session";
  drafted_from?: string | null;
  reviewed?: boolean;
  created_by?: string | null;
};

export type PlaybookPatch = Partial<{ name: string; description: string | null; repo_id: string | null; steps: PlaybookStep[] }>;

export type NewRun = {
  playbook: Playbook;
  steps: PlaybookRunStep[];
  pr_url: string | null;
  pr_number: number | null;
  head_sha: string | null;
  from_step: number;
  here: boolean;
  requested_by: string | null;
  requested_session: string | null;
};

/** What the run module writes on a run. Steps are written whole (one transaction per transition). */
export type RunPatch = Partial<Pick<PlaybookRun,
  "steps" | "head_sha" | "state" | "reason" | "session_id" | "ok_sha" | "ok_gates" | "ok_by" | "ok_at" | "ok_surface" | "ended_at">>;
const RUN_COLS = new Set(["steps", "head_sha", "state", "reason", "session_id", "ok_sha", "ok_gates", "ok_by", "ok_at", "ok_surface", "ended_at"]);

export const playbooks = {
  list(workspaceId?: string | null): Playbook[] {
    const rows = (workspaceId
      ? db.prepare("SELECT * FROM playbooks WHERE workspace_id=? ORDER BY name").all(workspaceId)
      : db.prepare("SELECT * FROM playbooks ORDER BY workspace_id, name").all()) as Row[];
    return rows.map((r) => toPlaybook(r)!);
  },
  get(id: string): Playbook | undefined {
    return toPlaybook(db.prepare("SELECT * FROM playbooks WHERE id=?").get(id) as Row | undefined);
  },
  byName(workspaceId: string, name: string): Playbook | undefined {
    return toPlaybook(db.prepare("SELECT * FROM playbooks WHERE workspace_id=? AND name=?").get(workspaceId, name) as Row | undefined);
  },
  create(n: NewPlaybook): Playbook {
    const id = randomUUID();
    const t = now();
    db.prepare(
      `INSERT INTO playbooks (id,workspace_id,name,description,repo_id,steps,source,drafted_from,reviewed_at,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, n.workspace_id, n.name, n.description ?? null, n.repo_id ?? null, JSON.stringify(n.steps),
      n.source ?? "hand", n.drafted_from ?? null, n.reviewed ? t : null, n.created_by ?? null, t, t,
    );
    return playbooks.get(id)!;
  },
  /** `reviewed`: the operator saved it himself (true) or anyone else changed it (false). */
  update(id: string, p: PlaybookPatch, reviewed: boolean): Playbook | undefined {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const k of ["name", "description", "repo_id", "steps"] as const) {
      if (p[k] === undefined) continue;
      sets.push(`${k}=?`);
      vals.push(k === "steps" ? JSON.stringify(p.steps) : p[k]);
    }
    if (!sets.length) return playbooks.get(id);
    const t = now();
    sets.push("reviewed_at=?", "updated_at=?");
    vals.push(reviewed ? t : null, t, id);
    db.prepare(`UPDATE playbooks SET ${sets.join(",")} WHERE id=?`).run(...vals);
    return playbooks.get(id);
  },
  delete(id: string): boolean {
    return db.prepare("DELETE FROM playbooks WHERE id=?").run(id).changes > 0;
  },
};

export const playbookRuns = {
  get(id: string): PlaybookRun | undefined {
    return toRun(db.prepare("SELECT * FROM playbook_runs WHERE id=?").get(id) as Row | undefined);
  },
  /** A full id, or an id8 prefix when exactly one run starts with it. */
  find(idOrPrefix: string): PlaybookRun | undefined {
    const key = String(idOrPrefix ?? "").trim();
    if (!key) return undefined;
    const exact = playbookRuns.get(key);
    if (exact || key.length < 6 || !/^[0-9a-f-]+$/i.test(key)) return exact;
    const rows = db.prepare("SELECT * FROM playbook_runs WHERE id LIKE ? ORDER BY created_at DESC LIMIT 2").all(`${key}%`) as Row[];
    return rows.length === 1 ? toRun(rows[0]) : undefined;
  },
  list(f: { workspace_id?: string | null; playbook_id?: string; session_id?: string; states?: readonly RunState[]; limit?: number } = {}): PlaybookRun[] {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (f.workspace_id) { where.push("workspace_id=?"); vals.push(f.workspace_id); }
    if (f.playbook_id) { where.push("playbook_id=?"); vals.push(f.playbook_id); }
    // A terminal's runs: the ones it works, and the ones it asked to run in itself (--here) before the OK.
    if (f.session_id) { where.push("(session_id=? OR (session_id IS NULL AND requested_session=?))"); vals.push(f.session_id, f.session_id); }
    if (f.states?.length) { where.push(`state IN (${f.states.map(() => "?").join(",")})`); vals.push(...f.states); }
    const lim = Math.min(Math.max(f.limit ?? 50, 1), 500);
    const rows = db.prepare(
      `SELECT * FROM playbook_runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, rowid DESC LIMIT ${lim}`,
    ).all(...vals) as Row[];
    return rows.map((r) => toRun(r)!);
  },
  create(n: NewRun): PlaybookRun {
    const id = randomUUID();
    const t = now();
    db.prepare(
      `INSERT INTO playbook_runs (id,playbook_id,workspace_id,name,steps,pr_url,pr_number,head_sha,state,from_step,here,requested_by,requested_session,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,'awaiting_ok',?,?,?,?,?,?)`,
    ).run(
      id, n.playbook.id, n.playbook.workspace_id, n.playbook.name, JSON.stringify(n.steps), n.pr_url, n.pr_number, n.head_sha,
      n.from_step, n.here ? 1 : 0, n.requested_by, n.requested_session, t, t,
    );
    return playbookRuns.get(id)!;
  },
  /**
   * Write a transition — only if the run is still in `from` (when given), so two callers racing on one
   * run cannot both move it. Returns the row after, or undefined when the guard did not hold.
   */
  patch(id: string, p: RunPatch, from?: readonly RunState[]): PlaybookRun | undefined {
    const keys = Object.keys(p).filter((k) => RUN_COLS.has(k) && (p as Record<string, unknown>)[k] !== undefined);
    if (!keys.length) return playbookRuns.get(id);
    const vals = keys.map((k) => {
      const v = (p as Record<string, unknown>)[k];
      return k === "steps" || k === "ok_gates" ? (v == null ? null : JSON.stringify(v)) : v;
    });
    const guard = from?.length ? ` AND state IN (${from.map(() => "?").join(",")})` : "";
    const r = db.prepare(`UPDATE playbook_runs SET ${keys.map((k) => `${k}=?`).join(",")},updated_at=? WHERE id=?${guard}`)
      .run(...vals, now(), id, ...(from ?? []));
    return r.changes ? playbookRuns.get(id) : undefined;
  },
};
