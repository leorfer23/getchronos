import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";

/**
 * Workspace triggers — "when X happens in this workspace, open the right work" (migration 161,
 * src/ws-triggers.ts, `mc trigger`). Not the `triggers` table: those are HTTP webhooks bound to one
 * job (src/triggers.ts). The store is dumb on purpose, like continuations': conditions, gates, dedupe
 * and actions live in the engine so the tests can drive it without a daemon.
 *
 * Two tables:
 *  - ws_triggers: one standing rule per row — its workspace, condition (kind/target/config), action,
 *    dedupe template and rate limit, its own cadence, and `state` (what the condition is compared
 *    against: PR snapshots, the inbox cursor, the lines last seen, the metric's readings).
 *  - ws_trigger_fires: one row per event the rule acted on (or chose not to). It is the "seen" set
 *    (new events only), the rate-limit counter, the map from a dedupe key to the live terminal or inbox
 *    item a new event is appended to, and the Desk's "last fire".
 */
export type WsTriggerKind = "pr" | "slack" | "email" | "check" | "command" | "metric";
export type WsTriggerAction = "terminal" | "playbook" | "inbox";
/**
 * opened: a fresh terminal · appended: typed into the live terminal / added to the open inbox item of
 * the same key · filed: an inbox item · playbook: handed to a playbook · pending: waiting for its busy
 * terminal to be free · skipped: not acted on (rate limit, muted, cap) · failed: nothing could take it.
 */
export type WsFireOutcome = "opened" | "appended" | "filed" | "playbook" | "pending" | "skipped" | "failed";

export type WsTrigger = {
  id: string;
  workspace_id: string;
  name: string;
  kind: WsTriggerKind;
  /** pr: the repo id · slack: the person (null = anyone) · email: the sender · check: the condition in words · command/metric: the command. */
  target: string | null;
  /** Kind options as JSON — pr {on} · slack {match} · email {match} · command {lines} · metric {rule}. */
  config: string | null;
  /** One line for the lists ("a PR fails CI on acme/app"). */
  label: string;
  action: WsTriggerAction;
  goal: string | null;
  skill: string | null;
  playbook: string | null;
  /** The repo a terminal opens in (always one of this workspace's own). */
  repo_id: string | null;
  /** Which events share one piece of live work: a template over {trigger} {subject} {day}. */
  dedupe: string;
  rate_max: number;
  rate_window_sec: number;
  every_sec: number | null;
  cron: string | null;
  enabled: number;
  paused_reason: string | null;
  state: string | null;
  next_check_at: string | null;
  last_check_at: string | null;
  last_check: string | null;
  checks: number;
  errors: number;
  check_run_id: string | null;
  last_fired_at: string | null;
  fire_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type NewWsTrigger = Pick<WsTrigger, "workspace_id" | "name" | "kind" | "label" | "action"> &
  Partial<Pick<WsTrigger,
    "target" | "config" | "goal" | "skill" | "playbook" | "repo_id" | "dedupe" | "rate_max" | "rate_window_sec" |
    "every_sec" | "cron" | "enabled" | "paused_reason" | "state" | "next_check_at" | "created_by">>;

export type WsTriggerFire = {
  id: string;
  trigger_id: string;
  workspace_id: string;
  at: string;
  event_key: string;
  dedupe_key: string;
  outcome: WsFireOutcome;
  session_id: string | null;
  inbox_id: string | null;
  run_id: string | null;
  subject: string | null;
  evidence: string | null;
  reason: string | null;
  /** pending only: when to try its terminal again. */
  retry_at: string | null;
};

export type NewWsTriggerFire = Pick<WsTriggerFire, "trigger_id" | "workspace_id" | "event_key" | "dedupe_key" | "outcome"> &
  Partial<Pick<WsTriggerFire, "at" | "session_id" | "inbox_id" | "run_id" | "subject" | "evidence" | "reason" | "retry_at">>;

/** Outcomes that started new work — what the rate limit counts. Appends go to work already running. */
export const STARTED: WsFireOutcome[] = ["opened", "filed", "playbook"];

export const wsTriggers = {
  create(p: NewWsTrigger): WsTrigger {
    const at = now();
    const row = {
      id: randomUUID(),
      workspace_id: p.workspace_id,
      name: p.name,
      kind: p.kind,
      target: p.target ?? null,
      config: p.config ?? null,
      label: p.label,
      action: p.action,
      goal: p.goal ?? null,
      skill: p.skill ?? null,
      playbook: p.playbook ?? null,
      repo_id: p.repo_id ?? null,
      dedupe: p.dedupe ?? "{trigger}",
      rate_max: p.rate_max ?? 3,
      rate_window_sec: p.rate_window_sec ?? 86_400,
      every_sec: p.every_sec ?? null,
      cron: p.cron ?? null,
      enabled: p.enabled ?? 1,
      paused_reason: p.paused_reason ?? null,
      state: p.state ?? null,
      // Explicit null = not scheduled (a trigger saved off); left out = look right away.
      next_check_at: p.next_check_at !== undefined ? p.next_check_at : at,
      created_by: p.created_by ?? null,
      created_at: at,
      updated_at: at,
    };
    db.prepare(
      `INSERT INTO ws_triggers (id,workspace_id,name,kind,target,config,label,action,goal,skill,playbook,repo_id,dedupe,
        rate_max,rate_window_sec,every_sec,cron,enabled,paused_reason,state,next_check_at,created_by,created_at,updated_at)
       VALUES (@id,@workspace_id,@name,@kind,@target,@config,@label,@action,@goal,@skill,@playbook,@repo_id,@dedupe,
        @rate_max,@rate_window_sec,@every_sec,@cron,@enabled,@paused_reason,@state,@next_check_at,@created_by,@created_at,@updated_at)`,
    ).run(row);
    return this.get(row.id)!;
  },

  get(id: string): WsTrigger | undefined {
    return db.prepare("SELECT * FROM ws_triggers WHERE id = ?").get(id) as WsTrigger | undefined;
  },

  /**
   * By full id or a unique prefix (the 8 chars every surface prints). With a workspace, only among
   * its own rows — so another client's ids never make a prefix ambiguous, and are never found.
   */
  resolve(ref: string, workspace_id?: string | null): WsTrigger | undefined {
    const r = String(ref ?? "").trim();
    if (!/^[0-9a-f-]{4,36}$/i.test(r)) return undefined;
    const hits = (workspace_id
      ? db.prepare("SELECT * FROM ws_triggers WHERE id LIKE ? AND workspace_id = ? LIMIT 2").all(r + "%", workspace_id)
      : db.prepare("SELECT * FROM ws_triggers WHERE id LIKE ? LIMIT 2").all(r + "%")) as WsTrigger[];
    return hits.length === 1 ? hits[0] : undefined;
  },

  list(f: { workspace_id?: string | null; kind?: WsTriggerKind; enabled?: boolean } = {}): WsTrigger[] {
    const where: string[] = [];
    const args: Record<string, unknown> = {};
    if (f.workspace_id) { where.push("workspace_id = @workspace_id"); args.workspace_id = f.workspace_id; }
    if (f.kind) { where.push("kind = @kind"); args.kind = f.kind; }
    if (f.enabled !== undefined) { where.push("enabled = @enabled"); args.enabled = f.enabled ? 1 : 0; }
    return db.prepare(
      `SELECT * FROM ws_triggers${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY workspace_id, created_at`,
    ).all(args) as WsTrigger[];
  },

  count(workspace_id: string): number {
    return (db.prepare("SELECT COUNT(*) n FROM ws_triggers WHERE workspace_id = ?").get(workspace_id) as { n: number }).n;
  },

  /** On and due for a look. */
  due(nowIso: string): WsTrigger[] {
    return db.prepare(
      "SELECT * FROM ws_triggers WHERE enabled = 1 AND next_check_at IS NOT NULL AND next_check_at <= ? ORDER BY next_check_at",
    ).all(nowIso) as WsTrigger[];
  },

  nextDueAt(): string | null {
    return (db.prepare("SELECT MIN(next_check_at) AS at FROM ws_triggers WHERE enabled = 1 AND next_check_at IS NOT NULL").get() as { at: string | null }).at;
  },

  /**
   * Record one look: what it saw, the condition's new state, when to look next. An error counts up
   * (and keeps the old state); a clean look resets the count — unless `keepErrors` (a probe that only
   * STARTED says nothing yet about whether the last ones failed). `state: undefined` leaves it as it is.
   */
  looked(id: string, p: { at: string; saw: string | null; next: string | null; error?: boolean; keepErrors?: boolean; state?: string | null }): void {
    db.prepare(
      `UPDATE ws_triggers SET last_check_at=@at, last_check=@saw, next_check_at=@next, checks=checks+1,
        errors=CASE WHEN @error THEN errors+1 WHEN @keep_errors THEN errors ELSE 0 END,
        state=CASE WHEN @keep THEN state ELSE @state END WHERE id=@id`,
    ).run({
      id, at: p.at, saw: p.saw, next: p.next, error: p.error ? 1 : 0, keep_errors: p.keepErrors ? 1 : 0,
      keep: p.state === undefined ? 1 : 0, state: p.state ?? null,
    });
  },

  /** Look at this workspace's triggers of one kind now (an inbox row was filed: Slack triggers). How many moved. */
  nudge(workspace_id: string, kind: WsTriggerKind, nowIso: string): number {
    return db.prepare(
      "UPDATE ws_triggers SET next_check_at = @now WHERE workspace_id = @ws AND kind = @kind AND enabled = 1 AND (next_check_at IS NULL OR next_check_at > @now)",
    ).run({ ws: workspace_id, kind, now: nowIso }).changes;
  },

  setNext(id: string, next: string | null): void {
    db.prepare("UPDATE ws_triggers SET next_check_at = ? WHERE id = ?").run(next, id);
  },

  setState(id: string, state: string | null): void {
    db.prepare("UPDATE ws_triggers SET state = ? WHERE id = ?").run(state, id);
  },

  setCheckRun(id: string, runId: string | null): void {
    db.prepare("UPDATE ws_triggers SET check_run_id = ? WHERE id = ?").run(runId, id);
  },

  /** On (looked at again from now) or off, with the reason shown on every surface. */
  setEnabled(id: string, enabled: boolean, reason: string | null, nextIso: string | null = null): WsTrigger | undefined {
    db.prepare(
      "UPDATE ws_triggers SET enabled=@enabled, paused_reason=@reason, errors=CASE WHEN @enabled THEN 0 ELSE errors END, next_check_at=@next, updated_at=@at WHERE id=@id",
    ).run({ id, enabled: enabled ? 1 : 0, reason: enabled ? null : reason, next: enabled ? nextIso ?? now() : null, at: now() });
    return this.get(id);
  },

  recordFired(id: string, at: string): void {
    db.prepare("UPDATE ws_triggers SET fire_count = fire_count + 1, last_fired_at = ? WHERE id = ?").run(at, id);
  },

  remove(id: string): void {
    db.prepare("DELETE FROM ws_triggers WHERE id = ?").run(id);
  },

  // ── fires ──

  addFire(p: NewWsTriggerFire): WsTriggerFire {
    const row = {
      id: randomUUID(),
      trigger_id: p.trigger_id,
      workspace_id: p.workspace_id,
      at: p.at ?? now(),
      event_key: p.event_key,
      dedupe_key: p.dedupe_key,
      outcome: p.outcome,
      session_id: p.session_id ?? null,
      inbox_id: p.inbox_id ?? null,
      run_id: p.run_id ?? null,
      subject: p.subject ?? null,
      evidence: p.evidence ?? null,
      reason: p.reason ?? null,
      retry_at: p.retry_at ?? null,
    };
    db.prepare(
      `INSERT INTO ws_trigger_fires (id,trigger_id,workspace_id,at,event_key,dedupe_key,outcome,session_id,inbox_id,run_id,subject,evidence,reason,retry_at)
       VALUES (@id,@trigger_id,@workspace_id,@at,@event_key,@dedupe_key,@outcome,@session_id,@inbox_id,@run_id,@subject,@evidence,@reason,@retry_at)`,
    ).run(row);
    return this.getFire(row.id)!;
  },

  getFire(id: string): WsTriggerFire | undefined {
    return db.prepare("SELECT * FROM ws_trigger_fires WHERE id = ?").get(id) as WsTriggerFire | undefined;
  },

  /** A pending fire's delivery settled: what happened to it in the end. */
  settleFire(id: string, p: Partial<Pick<WsTriggerFire, "outcome" | "session_id" | "inbox_id" | "run_id" | "reason" | "retry_at">>): void {
    const cur = this.getFire(id);
    if (!cur) return;
    const n = { ...cur, ...p };
    db.prepare(
      "UPDATE ws_trigger_fires SET outcome=@outcome, session_id=@session_id, inbox_id=@inbox_id, run_id=@run_id, reason=@reason, retry_at=@retry_at WHERE id=@id",
    ).run({ id, outcome: n.outcome, session_id: n.session_id, inbox_id: n.inbox_id, run_id: n.run_id, reason: n.reason, retry_at: n.outcome === "pending" ? n.retry_at : null });
  },

  /** Has this trigger already acted on (or decided about) this event? New events only. */
  seen(trigger_id: string, event_key: string): boolean {
    return !!db.prepare("SELECT 1 FROM ws_trigger_fires WHERE trigger_id = ? AND event_key = ? LIMIT 1").get(trigger_id, event_key);
  },

  /** New work this trigger started since then — the rate limit's count. */
  startedSince(trigger_id: string, sinceIso: string): number {
    return (db.prepare(
      `SELECT COUNT(*) n FROM ws_trigger_fires WHERE trigger_id = ? AND at >= ? AND outcome IN (${STARTED.map(() => "?").join(",")})`,
    ).get(trigger_id, sinceIso, ...STARTED) as { n: number }).n;
  },

  /** The newest fire of this key that put the event somewhere (a terminal or an inbox item). */
  workFor(trigger_id: string, dedupe_key: string): WsTriggerFire | undefined {
    return db.prepare(
      `SELECT * FROM ws_trigger_fires WHERE trigger_id = ? AND dedupe_key = ? AND (session_id IS NOT NULL OR inbox_id IS NOT NULL)
       AND outcome IN ('opened','appended','filed','playbook','pending') ORDER BY at DESC, rowid DESC LIMIT 1`,
    ).get(trigger_id, dedupe_key) as WsTriggerFire | undefined;
  },

  /** How many events this trigger has typed (or is waiting to type) into one terminal. */
  appendsTo(trigger_id: string, session_id: string): number {
    return (db.prepare(
      "SELECT COUNT(*) n FROM ws_trigger_fires WHERE trigger_id = ? AND session_id = ? AND outcome IN ('appended','pending')",
    ).get(trigger_id, session_id) as { n: number }).n;
  },

  /** Pending fires whose retry time has come. */
  pendingDue(nowIso: string): WsTriggerFire[] {
    return db.prepare(
      "SELECT * FROM ws_trigger_fires WHERE outcome = 'pending' AND retry_at IS NOT NULL AND retry_at <= ? ORDER BY retry_at",
    ).all(nowIso) as WsTriggerFire[];
  },

  nextPendingAt(): string | null {
    return (db.prepare("SELECT MIN(retry_at) AS at FROM ws_trigger_fires WHERE outcome = 'pending' AND retry_at IS NOT NULL").get() as { at: string | null }).at;
  },

  fires(trigger_id: string, limit = 20): WsTriggerFire[] {
    return db.prepare("SELECT * FROM ws_trigger_fires WHERE trigger_id = ? ORDER BY at DESC, rowid DESC LIMIT ?").all(trigger_id, limit) as WsTriggerFire[];
  },

  lastFire(trigger_id: string): WsTriggerFire | undefined {
    return db.prepare("SELECT * FROM ws_trigger_fires WHERE trigger_id = ? ORDER BY at DESC, rowid DESC LIMIT 1").get(trigger_id) as WsTriggerFire | undefined;
  },

  /** Forget fires older than this — except a pending one, which still owes its event a home. */
  pruneFires(beforeIso: string): number {
    return db.prepare("DELETE FROM ws_trigger_fires WHERE at < ? AND outcome <> 'pending'").run(beforeIso).changes;
  },
};
