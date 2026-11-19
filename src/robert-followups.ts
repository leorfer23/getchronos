/**
 * Robert's follow-ups — a deadline he sets on himself.
 *
 * His turns are stateless (no --resume), so a Robert who asks the operator about a merge and hears
 * nothing, or wants to look at a PR's CI in 20 minutes, has nothing that brings him back: 2026-11, six
 * finished terminals sat ~8 hours waiting on a word. The always-on-agent answer: a follow-up is a
 * deadline in a durable store; a scheduler pass finds it due, marks it fired and puts an event in his
 * inbox (the wake queue, src/wake-queue.ts). It never starts a turn itself.
 *
 * A follow-up IS a continuation (src/continuations.ts) with on_met='robert': kind `at`, no terminal.
 * Same table, same time parser, same scheduler pass and status guards as `mc when`, and it shows up in
 * the Desk's open loops with Fire/Cancel for free. Only delivery differs: enqueueWake instead of typing
 * into a terminal. Every limit below is the daemon's, not the prompt's.
 *
 *   mc robert followup "+2h" "asked the operator to merge #12 — still no answer? ask again" --subject <pr url>
 */
import { bus } from "./bus.js";
import { continuations, db, workspaces, type Continuation } from "./store.js";
import { arm, cancel, parseWhen, type WhenSpec } from "./continuations.js";
import { enqueueWake, FOLLOWUP_KEY, QUIET_REPLY } from "./wake-queue.js";
import { settingOn } from "./settings.js";
import type { CallerScope } from "./authz.js";

export const FOLLOWUP_LIMITS = {
  /** Sooner than this is not a follow-up: do it now. */
  minLeadMs: 5 * 60_000,
  /** Further than this is a calendar entry or a job. */
  maxLeadMs: 7 * 86_400_000,
  perWorkspace: 20,
  noteMax: 400,
  subjectMax: 500,
};
/** Fired more than this past its time = it came due while the daemon was down (or the Mac asleep). */
export const LATE_MS = 2 * 60_000;

const iso = (ms: number) => new Date(ms).toISOString();
const id8 = (id: string) => id.slice(0, 8);
const when = (ms: number) => new Date(ms).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const span = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 120 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

/**
 * Who may create, see or cancel follow-ups: the operator (admin token) or ONE workspace's own Robert.
 * Never a terminal's workspace token, and never the fleet-wide Robert — he has no workspace to be woken
 * in. `write` refuses the read-only (Telegram) Robert. Null = refused.
 */
export function followUpAccess(scope: CallerScope, write = false): { ws: string | null } | null {
  if (!scope) return null;
  if (scope.fleet) return null;
  if (scope.robert) return write && scope.robert !== "rw" ? null : { ws: scope.ws };
  return scope.ws === null ? { ws: null } : null;
}

export type FollowUpRequest = { when?: string | null; note?: string | null; subject?: string | null; every?: unknown; cron?: unknown };

/** Read a request into a row-shaped spec, or say what is wrong in words he can act on. Pure. */
export function parseFollowUp(r: FollowUpRequest, nowMs = Date.now()): { ok: true; spec: WhenSpec; subject: string | null } | { ok: false; error: string } {
  if (r.every != null || r.cron != null) return { ok: false, error: "a follow-up fires once — something recurring is a job, not a follow-up" };
  const note = String(r.note ?? "").trim();
  if (!note) return { ok: false, error: "say what to check and why — the note is all you will have when it fires" };
  if (note.length > FOLLOWUP_LIMITS.noteMax) return { ok: false, error: `keep the note under ${FOLLOWUP_LIMITS.noteMax} characters (it is ${note.length})` };
  const subject = String(r.subject ?? "").trim() || null;
  if (subject && subject.length > FOLLOWUP_LIMITS.subjectMax) return { ok: false, error: `keep the subject under ${FOLLOWUP_LIMITS.subjectMax} characters — a session id or a PR url` };
  if (!String(r.when ?? "").trim()) return { ok: false, error: "when? try +30m, +2h, tomorrow 9:00" };
  const p = parseWhen({ kind: "at", at: String(r.when), note }, nowMs);
  if (!p.ok) return p;
  const lead = Date.parse(p.spec.next_check_at!) - nowMs;
  if (lead < FOLLOWUP_LIMITS.minLeadMs) return { ok: false, error: "a follow-up is at least 5 minutes out — sooner than that, just do it now" };
  if (lead > FOLLOWUP_LIMITS.maxLeadMs) return { ok: false, error: "a follow-up is at most 7 days out — further than that is a calendar entry or a job" };
  const short = note.replace(/\s+/g, " ");
  return { ok: true, spec: { ...p.spec, then: "robert", label: `follow up: ${short.length > 70 ? short.slice(0, 69) + "…" : short}` }, subject };
}

export type FollowUp = {
  id: string;
  workspace_id: string;
  due_at: string | null;
  note: string | null;
  subject: string | null;
  status: "pending" | "fired" | "cancelled";
  created_by: string | null;
  created_at: string;
  fired_at: string | null;
  /** Why it was cancelled, when it was. */
  evidence: string | null;
};

/** A continuation row as a follow-up: armed and met are both still pending to him. */
export function followUpView(c: Continuation): FollowUp {
  return {
    id: c.id,
    workspace_id: c.workspace_id,
    due_at: c.target,
    note: c.note,
    subject: c.subject ?? null,
    status: c.status === "fired" || c.status === "cancelled" ? c.status : "pending",
    created_by: c.created_by,
    created_at: c.created_at,
    fired_at: c.fired_at,
    evidence: c.status === "cancelled" ? c.evidence : null,
  };
}

export const pendingFollowUps = (wsId: string): Continuation[] =>
  continuations.list({ workspace_id: wsId, on_met: "robert", status: ["armed", "met"] });

/** Write one, inside the per-workspace cap. The caller has already decided the workspace is the caller's. */
export async function createFollowUp(wsId: string, r: FollowUpRequest, by: string, nowMs = Date.now()): Promise<{ ok: true; followup: FollowUp } | { ok: false; status: number; error: string }> {
  if (!workspaces.get(wsId)) return { ok: false, status: 400, error: "which workspace? (workspace_id)" };
  const p = parseFollowUp(r, nowMs);
  if (!p.ok) return { ok: false, status: 400, error: p.error };
  const pending = pendingFollowUps(wsId).length;
  if (pending >= FOLLOWUP_LIMITS.perWorkspace) {
    return { ok: false, status: 409, error: `this workspace already has ${pending} follow-ups pending — cancel one (mc robert followup cancel <id8>) first` };
  }
  const c = await arm({ workspace_id: wsId, session_id: null, spec: p.spec, created_by: by, round: 1, subject: p.subject });
  return { ok: true, followup: followUpView(c) };
}

/** What he reads when it fires. */
export function followUpSay(c: Continuation, nowMs = Date.now()): string {
  const due = Date.parse(c.target ?? c.next_check_at ?? "") || nowMs;
  const late = nowMs - due > LATE_MS;
  return [
    `FOLLOW-UP ${id8(c.id)} — this is the follow-up YOU set on yourself at ${when(Date.parse(c.created_at) || due)}, due ${when(due)}. The operator did not ask for this; you did.`,
    late ? `It is LATE: it came due ${span(nowMs - due)} ago while the daemon was down — weigh what may have happened since.` : null,
    `Your note: ${c.note ?? "(none)"}`,
    c.subject ? `About: ${c.subject}` : null,
    `Check the current state first — it may have moved since you wrote this. Then act within this workspace's Standing orders; anything they do not cover is the operator's call (ask him).`,
    `If it has resolved itself and nothing needs doing, answer exactly ${QUIET_REPLY} and nothing else — no one is shown it.`,
  ].filter(Boolean).join("\n");
}

/**
 * Hand a met follow-up to his wake queue (called by continuations.ts deliver). Mark-then-enqueue in ONE
 * transaction: a crash between them leaves neither (the row stays met and the next pass retries), and
 * markFired's status guard means no second pass can ever queue it again.
 */
export function deliverFollowUp(c: Continuation, nowMs = Date.now()): "woke" | null {
  if (c.status !== "met" || c.on_met !== "robert") return null;
  // Switched off in ⚙ Settings since he set it: nobody to wake. Say so on the row instead of queueing a
  // turn the drain would drop in silence.
  if (!settingOn("robert.enabled", c.workspace_id)) {
    cancel(c, "Robert was switched off for this workspace when it came due");
    return null;
  }
  const say = followUpSay(c, nowMs);
  const fired = db.transaction((): boolean => {
    if (!continuations.markFired(c.id, { session_id: null, how: "woke", at: iso(nowMs) })) return false;
    enqueueWake({ topic: "followup", key: FOLLOWUP_KEY + c.id, subject: null, workspace_id: c.workspace_id, payload: { say, followup_id: c.id, subject: c.subject ?? null } });
    return true;
  })();
  if (!fired) return null;
  bus.publish({ topic: "continuation.updated", continuation_id: c.id, workspace_id: c.workspace_id, session_id: null });
  console.log(`[followup] ${id8(c.id)} → Robert (${c.workspace_id.slice(0, 8)})${nowMs - (Date.parse(c.target ?? "") || nowMs) > LATE_MS ? " late" : ""}`);
  return "woke";
}
