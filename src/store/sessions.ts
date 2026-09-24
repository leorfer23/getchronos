import { randomUUID, randomBytes } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";
import type { GoalKind, GoalSource, NewSession, Session, WatchReport } from "../types.js";

// The Lead's credential never rides a row out of the store: every session-returning endpoint (GET
// /sessions, /desk, …) is readable with a plain workspace token, and a worker that could read its
// Lead's token could type into every peer. openSession reads it through `leadToken(id)` alone.
const pub = <T>(r: T): T => {
  if (r) {
    delete (r as any).lead_token;
    (r as any).focus_only = !!(r as any).focus_only;
  }
  return r;
};
const pubAll = <T>(rows: T[]): T[] => rows.map(pub);

// Every session read carries the size of its goal list beside the row. Two counting subqueries on an
// indexed column, so the Desk can render "2/3" without a second round trip — and so a terminal with
// no list (the common one) is plainly `goals_total: 0` rather than an absence to guess at.
const SESSION_COLS =
  "s.*, t.key AS ticket_key, t.title AS ticket_title, " +
  "(SELECT COUNT(*) FROM session_goals g WHERE g.session_id = s.id) AS goals_total, " +
  "(SELECT COUNT(*) FROM session_goals g WHERE g.session_id = s.id AND g.done_at IS NOT NULL) AS goals_done";

export const sessions = {
  list(filter: { ticket_id?: string; status?: string; workspace_id?: string; limit?: number } = {}): Session[] {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.ticket_id) { where.push("ticket_id = ?"); params.push(filter.ticket_id); }
    if (filter.status) { where.push("status = ?"); params.push(filter.status); }
    if (filter.workspace_id) { where.push("workspace_id = ?"); params.push(filter.workspace_id); }
    const w = where.map((c) => "s." + c);
    let sql =
      "SELECT " + SESSION_COLS + " FROM sessions s LEFT JOIN tickets t ON t.id = s.ticket_id" +
      (w.length ? " WHERE " + w.join(" AND ") : "") + " ORDER BY s.created_at DESC";
    if (filter.limit) { sql += " LIMIT ?"; params.push(filter.limit); }
    return pubAll(db.prepare(sql).all(...params) as Session[]);
  },
  get(id: string): Session | undefined {
    return pub(db.prepare(
      "SELECT " + SESSION_COLS + " FROM sessions s LEFT JOIN tickets t ON t.id = s.ticket_id WHERE s.id = ?"
    ).get(id) as Session | undefined);
  },
  // Latest session's AI metadata for a ticket (Flow shipped enrichment). Cols null if unset.
  latestMeta(ticketId: string): { summary: string | null; tags: string | null } | undefined {
    return db
      .prepare("SELECT summary, tags FROM sessions WHERE ticket_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(ticketId) as { summary: string | null; tags: string | null } | undefined;
  },
  create(s: NewSession & { id?: string }): Session {
    const id = s.id || randomUUID();
    db.prepare(
      `INSERT INTO sessions (id,ticket_id,workspace_id,repo_id,title,goal,goal_kind,goal_source,spawn_goal,created_by,lead_id,agent_name,lead_token,backend,model,role,focus_only,cwd,host_id,status,created_at)
       VALUES (@id,@ticket_id,@workspace_id,@repo_id,@title,@goal,@goal_kind,@goal_source,@spawn_goal,@created_by,@lead_id,@agent_name,@lead_token,@backend,@model,@role,@focus_only,@cwd,@host_id,'live',@created_at)`
    ).run({
      id,
      ticket_id: s.ticket_id ?? null,
      workspace_id: s.workspace_id ?? null,
      repo_id: s.repo_id ?? null,
      title: s.title ?? null,
      goal: s.goal ?? null,
      goal_kind: s.goal_kind ?? null,
      // A goal typed into the spawn dialog is a starting intent, not a verdict — mark it 'seed' so
      // the agent's own Understanding may sharpen it later (see desk-title.ts).
      goal_source: s.goal_source ?? (s.goal ? "seed" : null),
      // Keep the words the operator actually typed: the deriver will overwrite `goal`, and "what did
      // I ask for" vs "what did it turn out to be" is the most useful pair in the day's log.
      spawn_goal: s.goal ?? null,
      created_by: s.created_by ?? "operator",
      // Ownership, as opposed to `created_by`'s day-log label: api.ts fills it from the `x-mc-lead`
      // credential the caller actually presented, so a worker cannot talk its way into a Lead.
      lead_id: s.lead_id ?? null,
      agent_name: s.agent_name ?? null,
      // Only a Lead gets one: its credential to type into its own workspace's other terminals (see
      // authz.ts leadScope) — the one thing a plain worker may never do.
      lead_token: s.role === "lead" ? randomBytes(16).toString("hex") : null,
      backend: s.backend ?? "claude-code",
      model: s.model ?? null,
      role: s.role ?? "human",
      focus_only: s.focus_only ? 1 : 0,
      cwd: s.cwd,
      // The computer the pty runs on (HOSTS.md). Placement decides it once, here; it never moves.
      host_id: s.host_id || "local",
      created_at: now(),
    });
    return this.get(id)!;
  },
  /**
   * The terminals a Lead owns (`lead_id`), newest first. The one query behind "does this Lead still
   * have work in flight" (robert-drive.ts) and the Desk's worker counts — an indexed column lookup,
   * not a scan of every live session looking for a matching `created_by` string.
   */
  workersOf(leadId: string, filter: { status?: string } = {}): Session[] {
    const where = ["s.lead_id = ?"];
    const params: any[] = [leadId];
    if (filter.status) { where.push("s.status = ?"); params.push(filter.status); }
    return pubAll(db.prepare(
      "SELECT " + SESSION_COLS + " FROM sessions s LEFT JOIN tickets t ON t.id = s.ticket_id " +
        `WHERE ${where.join(" AND ")} ORDER BY s.created_at DESC`,
    ).all(...params) as Session[]);
  },
  /**
   * Stamp live workers of one Lead onto another (`mc lead adopt`). Ended workers keep their history
   * under the old Lead — only the ones still running need a new owner.
   */
  reassignLiveWorkers(fromLeadId: string, toLeadId: string): number {
    if (fromLeadId === toLeadId) return 0;
    return db
      .prepare("UPDATE sessions SET lead_id = ? WHERE lead_id = ? AND status = 'live'")
      .run(toLeadId, fromLeadId).changes;
  },
  getByLeadToken(tok: string): Session | undefined {
    if (!tok) return undefined;
    return pub(db.prepare(
      "SELECT " + SESSION_COLS + " FROM sessions s LEFT JOIN tickets t ON t.id = s.ticket_id WHERE s.lead_token = ? LIMIT 1"
    ).get(tok) as Session | undefined);
  },
  /** The only way the credential leaves the store — for the Lead's own env at spawn (openSession). */
  leadToken(id: string): string | null {
    return (db.prepare("SELECT lead_token FROM sessions WHERE id = ?").get(id) as { lead_token: string | null } | undefined)?.lead_token ?? null;
  },
  /** Promotion (terminal.ts promoteToLead): the row keeps its id and transcript, only its role moves. */
  setRole(id: string, role: Session["role"]) {
    db.prepare("UPDATE sessions SET role=? WHERE id=?").run(role, id);
  },
  /**
   * Where a REMOTE terminal actually runs, as its host resolved it (a path on that machine). A local
   * row's cwd is chosen before the spawn and never set here; a remote one only exists after the host
   * answers, since the brain sends intent, not paths (HOSTS.md → SpawnSpec).
   */
  setCwd(id: string, cwd: string) {
    db.prepare("UPDATE sessions SET cwd=? WHERE id=?").run(cwd, id);
  },
  setPid(id: string, pid: number | null) {
    db.prepare("UPDATE sessions SET pid=? WHERE id=?").run(pid, id);
  },
  /** Why placement put this terminal where it is (HOSTS.md phase 4). */
  setPlacement(id: string, reason: string | null) {
    db.prepare("UPDATE sessions SET placement=? WHERE id=?").run(reason, id);
  },
  /** Unique live agent handle. Cleared automatically on end(). */
  setAgentName(id: string, name: string | null) {
    db.prepare("UPDATE sessions SET agent_name=? WHERE id=?").run(name, id);
  },
  findByAgentName(name: string): Session | undefined {
    const n = name.trim().toLowerCase();
    if (!n) return undefined;
    return pub(db.prepare(
      "SELECT " + SESSION_COLS + " FROM sessions s LEFT JOIN tickets t ON t.id = s.ticket_id WHERE s.agent_name = ? AND s.status = 'live' LIMIT 1"
    ).get(n) as Session | undefined);
  },
  // Patch the AI-generated metadata (title / summary / tags / first_prompt) used for search + display.
  /** The terminal's objective + its done marker. Separate from setMeta: a goal is operator/agent
   *  intent, not AI-derived display metadata, and `goal_done` must be settable back to null. */
  setGoal(
    id: string,
    g: {
      goal?: string | null;
      goal_done?: boolean;
      goal_kind?: GoalKind | null;
      goal_source?: GoalSource | null;
      /** The exact tick to record, when it is not "now" — the goal-list mirror replays the moment the
       *  LAST item was ticked, and a re-stamped `now()` would move the day's log every refresh. */
      goal_done_at?: string | null;
    },
  ) {
    const sets: string[] = [];
    const params: any[] = [];
    if (g.goal !== undefined) { sets.push("goal=?"); params.push(g.goal); }
    if (g.goal_done_at !== undefined) { sets.push("goal_done_at=?"); params.push(g.goal_done_at); }
    else if (g.goal_done !== undefined) { sets.push("goal_done_at=?"); params.push(g.goal_done ? now() : null); }
    if (g.goal_kind !== undefined) { sets.push("goal_kind=?"); params.push(g.goal_kind); }
    // Who named it decides whether the deriver may rename it later. A goal write with no stated
    // source is the operator's (the card's own inline edit is the only unlabelled writer).
    if (g.goal !== undefined || g.goal_source !== undefined) {
      sets.push("goal_source=?");
      params.push(g.goal_source ?? "human");
    }
    if (!sets.length) return;
    params.push(id);
    db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id=?`).run(...params);
  },
  /** Ledger columns: refreshed while a terminal runs, frozen when it dies. */
  setLedger(
    id: string,
    l: Partial<{
      turns: number; tokens_in: number; tokens_out: number; cache_read: number; cache_write: number;
      cost_usd: number; cost_estimated: boolean | number;
      context_peak: number; lines_added: number; lines_removed: number; model_ms: number; branch: string | null;
    }>,
  ) {
    const cols = Object.keys(l).filter((k) => (l as any)[k] !== undefined);
    if (!cols.length) return;
    const vals = cols.map((c) => {
      const v = (l as any)[c];
      if (c === "cost_estimated") return v === true || v === 1 ? 1 : 0;
      return v;
    });
    db.prepare(`UPDATE sessions SET ${cols.map((c) => `${c}=?`).join(", ")} WHERE id=?`)
      .run(...vals, id);
  },

  /**
   * Desk (interactive terminal) spend in a window. Filtered on `created_at` — same clock the day's
   * log uses — so seven-day Desk totals reconcile with `/desk/log`. Cost may be exact (CLI
   * cost-state) or estimated (token table); both contribute to `usd`, and coverage separates them.
   */
  spendSince(
    sinceIso: string,
    opts: { workspace_id?: string; until?: string } = {},
  ): {
    usd: number;
    estimated_usd: number;
    priced_usd: number;
    tokens_in: number;
    tokens_out: number;
    cache_read: number;
    cache_write: number;
    sessions: number;
    priced: number;
    estimated: number;
    unpriced: number;
  } {
    const where = ["s.created_at >= ?"];
    const params: any[] = [sinceIso];
    if (opts.until) { where.push("s.created_at < ?"); params.push(opts.until); }
    if (opts.workspace_id) { where.push("s.workspace_id = ?"); params.push(opts.workspace_id); }
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(s.cost_usd),0) usd,
                COALESCE(SUM(CASE WHEN s.cost_estimated = 1 THEN s.cost_usd ELSE 0 END),0) estimated_usd,
                COALESCE(SUM(CASE WHEN s.cost_estimated = 0 AND s.cost_usd IS NOT NULL THEN s.cost_usd ELSE 0 END),0) priced_usd,
                COALESCE(SUM(s.tokens_in),0) tokens_in,
                COALESCE(SUM(s.tokens_out),0) tokens_out,
                COALESCE(SUM(s.cache_read),0) cache_read,
                COALESCE(SUM(s.cache_write),0) cache_write,
                COUNT(*) sessions,
                SUM(CASE WHEN s.cost_usd IS NOT NULL AND COALESCE(s.cost_estimated,0) = 0 THEN 1 ELSE 0 END) priced,
                SUM(CASE WHEN s.cost_usd IS NOT NULL AND s.cost_estimated = 1 THEN 1 ELSE 0 END) estimated,
                SUM(CASE WHEN s.cost_usd IS NULL AND s.ended_at IS NOT NULL THEN 1 ELSE 0 END) unpriced
         FROM sessions s WHERE ${where.join(" AND ")}`,
      )
      .get(...params) as any;
    return {
      usd: row?.usd ?? 0,
      estimated_usd: row?.estimated_usd ?? 0,
      priced_usd: row?.priced_usd ?? 0,
      tokens_in: row?.tokens_in ?? 0,
      tokens_out: row?.tokens_out ?? 0,
      cache_read: row?.cache_read ?? 0,
      cache_write: row?.cache_write ?? 0,
      sessions: row?.sessions ?? 0,
      priced: row?.priced ?? 0,
      estimated: row?.estimated ?? 0,
      unpriced: row?.unpriced ?? 0,
    };
  },

  spentByWorkspace(sinceIso: string): Array<{
    workspace_id: string;
    cost: number;
    estimated_usd: number;
    sessions: number;
  }> {
    return db
      .prepare(
        `SELECT COALESCE(s.workspace_id,'') workspace_id,
                COALESCE(SUM(s.cost_usd),0) cost,
                COALESCE(SUM(CASE WHEN s.cost_estimated = 1 THEN s.cost_usd ELSE 0 END),0) estimated_usd,
                COUNT(*) sessions
         FROM sessions s WHERE s.created_at >= ? AND s.cost_usd IS NOT NULL
         GROUP BY COALESCE(s.workspace_id,'')`,
      )
      .all(sinceIso) as Array<{ workspace_id: string; cost: number; estimated_usd: number; sessions: number }>;
  },
  /**
   * Put a standing watch on this terminal, or lift it (`every_min: null`).
   *
   * `watch_last_at` starts at NOW rather than null on purpose: a fresh watch reports one interval
   * from now, not on the sweeper's very next pass — "check it every 10 minutes" means the first
   * report is in ten minutes, and an immediate one reads as a bug.
   */
  setWatch(
    id: string,
    w: { every_min: number | null; note?: string | null; by?: string | null },
  ) {
    if (w.every_min == null) {
      db.prepare(
        "UPDATE sessions SET watch_every_min=NULL, watch_note=NULL, watch_by=NULL, watch_started_at=NULL, watch_last_at=NULL WHERE id=?",
      ).run(id);
      return this.get(id);
    }
    const t = now();
    db.prepare(
      `UPDATE sessions SET watch_every_min=?, watch_note=?, watch_by=?,
         watch_started_at=COALESCE(watch_started_at, ?), watch_last_at=? WHERE id=?`,
    ).run(w.every_min, w.note ?? null, w.by ?? "operator", t, t, id);
    return this.get(id);
  },
  /** Stamp a watch as reported — the sweeper's clock hand. */
  markWatched(id: string, at = now()) {
    db.prepare("UPDATE sessions SET watch_last_at=? WHERE id=?").run(at, id);
  },
  /** Every terminal under a standing watch, live or not (an ended one gets one last report). */
  watched(): Session[] {
    return pubAll(db.prepare(
      "SELECT " + SESSION_COLS + " FROM sessions s LEFT JOIN tickets t ON t.id = s.ticket_id " +
        "WHERE s.watch_every_min IS NOT NULL ORDER BY s.created_at DESC",
    ).all() as Session[]);
  },
  /** Keep what Robert said on a check, so the Desk can show it next to the terminal. */
  addWatchReport(id: string, r: { state: string; body: string; final: boolean; failed: boolean }, at = now()): WatchReport {
    const info = db.prepare(
      "INSERT INTO watch_reports (session_id, at, state, body, final, failed) VALUES (?,?,?,?,?,?)",
    ).run(id, at, r.state, r.body, r.final ? 1 : 0, r.failed ? 1 : 0);
    return { id: Number(info.lastInsertRowid), session_id: id, at, state: r.state, body: r.body, final: r.final, failed: r.failed };
  },
  /** Newest first. */
  watchReports(id: string, limit = 20): WatchReport[] {
    return (db.prepare("SELECT * FROM watch_reports WHERE session_id=? ORDER BY id DESC LIMIT ?").all(id, limit) as any[])
      .map((r) => ({ ...r, final: !!r.final, failed: !!r.failed }));
  },
  /** Record the worktree a terminal claimed, and the repo it turned out to need. */
  setWorktree(id: string, w: { path: string; branch: string | null; repo_id?: string | null }) {
    db.prepare(
      "UPDATE sessions SET worktree_path=?, worktree_branch=?, repo_id=COALESCE(?, repo_id) WHERE id=?",
    ).run(w.path, w.branch, w.repo_id ?? null, id);
    return this.get(id);
  },
  /** Forget the worktree a terminal claimed, once that tree is gone. The repo it needed stays. */
  clearWorktree(id: string) {
    db.prepare("UPDATE sessions SET worktree_path=NULL, worktree_branch=NULL WHERE id=?").run(id);
    return this.get(id);
  },
  /** Count one "this terminal had to stop and ask you" — the number that says which work was smooth. */
  countBlocked(id: string) {
    db.prepare("UPDATE sessions SET blocked_count = COALESCE(blocked_count,0) + 1 WHERE id=?").run(id);
  },
  /** Cloud terminals only (backend kind "cloud"): mirror the provider ids onto the session row so
   *  the Desk card renders without joining `runs`. Undefined fields are skipped — a partial update
   *  (e.g. just cloud_last_event_id on reconcile) must not null out the rest. */
  setCloud(id: string, c: { cloud_agent_id?: string | null; cloud_run_id?: string | null; cloud_url?: string | null; cloud_last_event_id?: string | null }) {
    const sets: string[] = [];
    const params: any[] = [];
    if (c.cloud_agent_id !== undefined) { sets.push("cloud_agent_id=?"); params.push(c.cloud_agent_id); }
    if (c.cloud_run_id !== undefined) { sets.push("cloud_run_id=?"); params.push(c.cloud_run_id); }
    if (c.cloud_url !== undefined) { sets.push("cloud_url=?"); params.push(c.cloud_url); }
    if (c.cloud_last_event_id !== undefined) { sets.push("cloud_last_event_id=?"); params.push(c.cloud_last_event_id); }
    if (!sets.length) return;
    params.push(id);
    db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id=?`).run(...params);
  },
  setMeta(id: string, m: { title?: string; summary?: string; tags?: string[]; first_prompt?: string }) {
    const sets: string[] = [];
    const params: any[] = [];
    if (m.title != null) { sets.push("title=?"); params.push(m.title); }
    if (m.summary != null) { sets.push("summary=?"); params.push(m.summary); }
    if (m.tags != null) { sets.push("tags=?"); params.push(JSON.stringify(m.tags)); }
    if (m.first_prompt != null) { sets.push("first_prompt=?"); params.push(m.first_prompt); }
    if (!sets.length) return;
    params.push(id);
    db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id=?`).run(...params);
  },
  // `reason` only when the daemon ended it on purpose (failover). COALESCE: the pty's own onExit
  // ends the row again a moment later with no reason, and must not wipe the one just written.
  end(id: string, reason?: string | null) {
    db.prepare("UPDATE sessions SET status='ended', ended_at=?, agent_name=NULL, lead_token=NULL, end_reason=COALESCE(?, end_reason) WHERE id=?")
      .run(now(), reason ?? null, id);
  },
  // Flip an ended session back to live (used when resuming its transcript in a fresh pty).
  revive(id: string): Session | undefined {
    db.prepare("UPDATE sessions SET status='live', ended_at=NULL, end_reason=NULL WHERE id=?").run(id);
    // end() burned the old credential; a reopened Lead gets a fresh one for its new pty.
    db.prepare("UPDATE sessions SET lead_token=? WHERE id=? AND role='lead'").run(randomBytes(16).toString("hex"), id);
    return this.get(id);
  },
  // Mark any still-'live' session ended (called on boot — ptys die with the daemon). Only THIS
  // machine's: a terminal on another host (HOSTS.md) is that host's child and outlives a brain restart — it is re-attached,
  // not reaped. Every row is host 'local' until hosts ship, so today this is every live row.
  reapAll() {
    db.prepare("UPDATE sessions SET status='ended', ended_at=?, agent_name=NULL, lead_token=NULL WHERE status='live' AND host_id='local'").run(now());
  },
};
