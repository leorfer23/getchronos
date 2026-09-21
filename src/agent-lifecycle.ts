/**
 * Herdr-inspired agent lifecycle for Chronos.
 *
 * Semantic states (idle / working / blocked / done / unknown) are the authority for waits,
 * fleet rollups, and Robert's "what's urgent?" brief. Display labels are separate.
 *
 * Chronos doesn't screen-scrape CLIs the way Herdr does — state is derived from runs/sessions
 * plus explicit reports (HITL, stalls, auth) and optional overlays Robert/workers set.
 */
import { bus, type BusEvent } from "./bus.js";
import { listStalls } from "./recovery.js";
import { isLive, sessionActivity } from "./terminal.js";
import { asks, events, jobs, reviews, runs, sessions, steps, tickets, workspaces } from "./store.js";
import { isClosedTicketStatus, type Run, type Session } from "./types.js";

export type AgentLifecycleState = "idle" | "working" | "blocked" | "done" | "unknown";
export type AgentKind = "session" | "run";
export type BlockedReason =
  | "hitl"
  | "approval"
  | "question"
  | "budget"
  | "gate"
  | "stall"
  | "recovery"
  | "review"
  | "auth"
  | null;

/** Unique live name: herdr-compatible `[a-z][a-z0-9_-]{0,31}`. */
export const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export type AgentOccupant = {
  kind: AgentKind;
  id: string;
  id8: string;
  name: string | null;
  label: string;
  workspace_id: string | null;
  workspace_slug: string | null;
  state: AgentLifecycleState;
  /** Display-only; waits/rollups use `state`. */
  state_label: string | null;
  blocked_reason: BlockedReason;
  ticket_key: string | null;
  backend: string | null;
  /** "2/4 · fix root cause" from declared run_steps; null for sessions or a run with no steps declared. */
  progress: string | null;
  /** done → idle once seen (focused / attached / explicitly marked). */
  seen: boolean;
  /** Quiet with no liveness evidence for CONFIG.stallInspectCount checks — a human has to look. */
  demand_inspection: boolean;
  updated_at: string;
};

type Overlay = {
  state?: AgentLifecycleState;
  state_label?: string | null;
  blocked_reason?: BlockedReason;
  seen?: boolean;
  demand_inspection?: boolean;
  /** Soft TTL so a stuck report doesn't lie forever (ms since epoch). */
  expires_at?: number | null;
};

const overlays = new Map<string, Overlay>(); // key = `${kind}:${id}`
const waiters = new Set<{
  kind: AgentKind;
  id: string;
  until: Set<AgentLifecycleState>;
  resolve: (o: AgentOccupant) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

function key(kind: AgentKind, id: string): string {
  return `${kind}:${id}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function cleanOverlay(k: string): Overlay | undefined {
  const o = overlays.get(k);
  if (!o) return undefined;
  if (o.expires_at != null && Date.now() > o.expires_at) {
    overlays.delete(k);
    return undefined;
  }
  return o;
}

export function validateAgentName(name: string): string | null {
  const n = name.trim().toLowerCase();
  if (!AGENT_NAME_RE.test(n)) {
    return "name must match [a-z][a-z0-9_-]{0,31}";
  }
  return null;
}

/** Map run status → semantic lifecycle (before overlays / recovery). */
export function deriveRunState(run: Pick<Run, "status">): {
  state: AgentLifecycleState;
  blocked_reason: BlockedReason;
} {
  switch (run.status) {
    case "running":
      return { state: "working", blocked_reason: null };
    case "queued":
      return { state: "idle", blocked_reason: null };
    case "blocked":
      return { state: "blocked", blocked_reason: "gate" };
    case "rate_limited":
      return { state: "blocked", blocked_reason: "budget" };
    case "paused":
      return { state: "blocked", blocked_reason: "question" };
    case "success":
      return { state: "done", blocked_reason: null };
    case "failed":
    case "timeout":
    case "killed":
    case "interrupted":
      return { state: "done", blocked_reason: null };
    default:
      return { state: "unknown", blocked_reason: null };
  }
}

/** Live session defaults to working; ended → done (until seen). */
export function deriveSessionState(
  session: Pick<Session, "status">,
  live: boolean,
  /** Pty has produced nothing for a while → the turn is over, it is not working (terminal.ts). */
  quiet = false,
): {
  state: AgentLifecycleState;
  blocked_reason: BlockedReason;
} {
  // A silent terminal is idle, not blocked: an agent that genuinely needs a decision says so with
  // `mc state blocked` (an overlay, which wins over this) or files an ask. Calling every finished
  // turn "blocked" would flood Robert's needs-you brief with terminals that are merely at rest.
  if (session.status === "live" && live) return { state: quiet ? "idle" : "working", blocked_reason: null };
  if (session.status === "live" && !live) return { state: "unknown", blocked_reason: null };
  return { state: "done", blocked_reason: null };
}

function applyOverlay(
  base: { state: AgentLifecycleState; blocked_reason: BlockedReason },
  overlay: Overlay | undefined,
  seenDefault: boolean
): {
  state: AgentLifecycleState;
  blocked_reason: BlockedReason;
  state_label: string | null;
  seen: boolean;
  demand_inspection: boolean;
} {
  let state = overlay?.state ?? base.state;
  let blocked_reason: BlockedReason =
    overlay?.blocked_reason !== undefined ? overlay.blocked_reason : base.blocked_reason;
  const seen = overlay?.seen ?? seenDefault;
  // Herdr: done is idle-after-unseen-work; focusing marks seen → idle.
  if (state === "done" && seen) state = "idle";
  if (state !== "blocked") blocked_reason = null;
  else if (!blocked_reason) blocked_reason = "hitl";
  return {
    state,
    blocked_reason,
    state_label: overlay?.state_label ?? null,
    seen,
    demand_inspection: overlay?.demand_inspection ?? false,
  };
}

function wsSlug(id: string | null | undefined): string | null {
  if (!id) return null;
  return workspaces.get(id)?.slug ?? null;
}

function occupantFromSession(s: Session): AgentOccupant {
  const live = s.status === "live" && isLive(s.id);
  const base = deriveSessionState(s, live, live && sessionActivity(s.id).quiet);
  const o = applyOverlay(base, cleanOverlay(key("session", s.id)), false);
  const t = s.ticket_id ? tickets.get(s.ticket_id) : undefined;
  const label =
    s.agent_name ||
    s.title ||
    (t ? `${t.key} — ${t.title}` : null) ||
    `${s.role} · ${s.backend}`;
  return {
    kind: "session",
    id: s.id,
    id8: s.id.slice(0, 8),
    name: s.agent_name ?? null,
    label,
    workspace_id: s.workspace_id,
    workspace_slug: wsSlug(s.workspace_id),
    state: o.state,
    state_label: o.state_label,
    blocked_reason: o.blocked_reason,
    ticket_key: t?.key ?? s.ticket_key ?? null,
    backend: s.backend,
    progress: null, // sessions have no run_steps checklist
    seen: o.seen,
    demand_inspection: o.demand_inspection,
    updated_at: s.ended_at ?? s.created_at,
  };
}

// Cooperative first: a declared checklist wins. Non-cooperative backstop only for a run that's
// actually running and never declared steps — a finished run's occupant doesn't need a live activity
// guess, and querying run_events for every settled run in the fleet list would be needless I/O.
function progressLabel(run: Run): string | null {
  const p = steps.progress(run.id);
  if (p) return `${p.done}/${p.total}${p.current ? ` · ${p.current}` : ""}`;
  if (run.status === "running") return events.lastActivity(run.id);
  return null;
}

function occupantFromRun(run: Run & { job_name?: string; workspace_id?: string | null }): AgentOccupant {
  const job = jobs.get(run.job_id);
  const base = deriveRunState(run);
  // Recovery stalls on interrupted runs → blocked needs-you.
  const stallId = `r:${run.id.slice(0, 8)}`;
  const stalled = run.status === "interrupted" && listStalls().some((x) => x.id === stallId);
  if (stalled) {
    base.state = "blocked";
    base.blocked_reason = "recovery";
  }
  const o = applyOverlay(base, cleanOverlay(key("run", run.id)), run.status === "success");
  const t = job?.ticket_id ? tickets.get(job.ticket_id) : undefined;
  const jobName = run.job_name ?? job?.name ?? "run";
  const label = t?.key ? `${t.key} — ${jobName}` : jobName;
  return {
    kind: "run",
    id: run.id,
    id8: run.id.slice(0, 8),
    name: getRunName(run.id),
    label,
    workspace_id: run.workspace_id ?? job?.workspace_id ?? null,
    workspace_slug: wsSlug(run.workspace_id ?? job?.workspace_id),
    state: o.state,
    state_label: o.state_label,
    blocked_reason: o.blocked_reason,
    ticket_key: t?.key ?? null,
    backend: job?.backend ?? null,
    progress: progressLabel(run),
    seen: o.seen,
    demand_inspection: o.demand_inspection,
    updated_at: run.ended_at ?? run.started_at ?? nowIso(),
  };
}

/** Run names live only in memory (runs are ephemeral jobs). */
const runNames = new Map<string, string>(); // name → runId
const runNamesById = new Map<string, string>(); // runId → name

function getRunName(runId: string): string | null {
  return runNamesById.get(runId) ?? null;
}

function clearRunName(runId: string): void {
  const n = runNamesById.get(runId);
  if (n) runNames.delete(n);
  runNamesById.delete(runId);
}

export function listAgents(filter: {
  workspace_id?: string;
  state?: AgentLifecycleState;
  kind?: AgentKind;
  /** Include recently ended sessions/runs (default: live + active runs only). */
  include_settled?: boolean;
} = {}): AgentOccupant[] {
  const out: AgentOccupant[] = [];

  if (!filter.kind || filter.kind === "session") {
    const rows = sessions.list({
      status: filter.include_settled ? undefined : "live",
      workspace_id: filter.workspace_id,
      limit: filter.include_settled ? 40 : undefined,
    });
    for (const s of rows) {
      if (!filter.include_settled && s.status !== "live") continue;
      if (!filter.include_settled && s.status === "live" && !isLive(s.id)) continue;
      out.push(occupantFromSession(s));
    }
  }

  if (!filter.kind || filter.kind === "run") {
    for (const r of runs.activeByWorkspace()) {
      if (filter.workspace_id && r.workspace_id !== filter.workspace_id) continue;
      const full = runs.get(r.id);
      if (!full) continue;
      // Parked on ask, but the ticket is gone or already closed — nobody will answer to resume
      // meaningful work. activeByWorkspace already drops paused-without-open-ask; this covers the
      // done/dismissed/deleted-ticket ghosts that still have an unanswered ask (PER-17).
      if (full.status === "paused") {
        const job = jobs.get(full.job_id);
        if (job?.ticket_id) {
          const t = tickets.get(job.ticket_id);
          if (!t || isClosedTicketStatus(t.status)) continue;
        } else if (asks.openForRun(full.id).some((a) => a.ticket_id && !tickets.get(a.ticket_id))) {
          // Job lost its ticket_id (SET NULL on delete) while an ask still points at the missing row.
          continue;
        }
      }
      out.push(
        occupantFromRun({
          ...full,
          job_name: r.job_name,
          workspace_id: r.workspace_id,
        })
      );
    }
    // Also surface interrupted-needing-recovery that aren't in the active set.
    for (const stall of listStalls()) {
      if (!stall.id.startsWith("r:")) continue;
      const id8 = stall.id.slice(2);
      if (out.some((a) => a.kind === "run" && a.id8 === id8)) continue;
      const found = runs.findByIdPrefix(id8);
      if (found) {
        const occ = occupantFromRun(found);
        if (filter.workspace_id && occ.workspace_id !== filter.workspace_id) continue;
        out.push(occ);
      }
    }
  }

  // Pending reviews as blocked attention (only when include_settled — keeps default list about live agents).
  if (filter.include_settled) {
    for (const rev of reviews.list("pending")) {
      const t = rev.ticket_id ? tickets.get(rev.ticket_id) : undefined;
      if (filter.workspace_id && t && t.workspace_id !== filter.workspace_id) continue;
      out.push({
        kind: "run",
        id: rev.id,
        id8: rev.id.slice(0, 8),
        name: null,
        label: t ? `review ${t.key}` : `review ${rev.id.slice(0, 8)}`,
        workspace_id: t?.workspace_id ?? null,
        workspace_slug: wsSlug(t?.workspace_id),
        state: "blocked",
        state_label: "awaiting review",
        blocked_reason: "review",
        ticket_key: t?.key ?? null,
        backend: null,
        progress: null,
        seen: false,
        demand_inspection: false,
        updated_at: rev.created_at,
      });
    }
  }

  let filtered = out;
  if (filter.state) filtered = filtered.filter((a) => a.state === filter.state);

  const rank: Record<AgentLifecycleState, number> = {
    blocked: 0,
    working: 1,
    done: 2,
    unknown: 3,
    idle: 4,
  };
  filtered.sort((a, b) => rank[a.state] - rank[b.state] || b.updated_at.localeCompare(a.updated_at));
  return filtered;
}

/** Resolve by full id, id8, or unique live name. */
export function resolveAgent(idOrName: string): { kind: AgentKind; id: string } | null {
  const raw = idOrName.trim();
  if (!raw) return null;

  // Exact session id
  const s = sessions.get(raw);
  if (s) return { kind: "session", id: s.id };

  // Exact run id
  const r = runs.get(raw);
  if (r) return { kind: "run", id: r.id };

  // Live name (sessions DB + run memory)
  const byName = sessions.findByAgentName(raw);
  if (byName) return { kind: "session", id: byName.id };
  const runId = runNames.get(raw.toLowerCase());
  if (runId && runs.get(runId)) return { kind: "run", id: runId };

  // id8 prefix — prefer live session, then active run
  if (/^[0-9a-f-]{6,}$/i.test(raw)) {
    const live = sessions.list({ status: "live" }).find((x) => x.id.startsWith(raw));
    if (live) return { kind: "session", id: live.id };
    const active = runs.activeByWorkspace().find((x) => x.id.startsWith(raw));
    if (active) return { kind: "run", id: active.id };
    const anyRun = runs.findByIdPrefix(raw);
    if (anyRun) return { kind: "run", id: anyRun.id };
  }

  return null;
}

export function getAgent(idOrName: string): AgentOccupant | null {
  const ref = resolveAgent(idOrName);
  if (!ref) return null;
  if (ref.kind === "session") {
    const s = sessions.get(ref.id);
    return s ? occupantFromSession(s) : null;
  }
  const run = runs.get(ref.id);
  if (!run) return null;
  const active = runs.activeByWorkspace().find((x) => x.id === ref.id);
  return occupantFromRun({
    ...run,
    job_name: active?.job_name,
    workspace_id: active?.workspace_id ?? jobs.get(run.job_id)?.workspace_id ?? null,
  });
}

export function setAgentName(
  idOrName: string,
  name: string | null
): { ok: true; agent: AgentOccupant } | { ok: false; error: string } {
  const ref = resolveAgent(idOrName);
  if (!ref) return { ok: false, error: `agent \`${idOrName}\` not found` };

  if (name == null || name === "") {
    if (ref.kind === "session") {
      sessions.setAgentName(ref.id, null);
    } else {
      clearRunName(ref.id);
    }
    const agent = getAgent(ref.id)!;
    publishState(agent);
    return { ok: true, agent };
  }

  const err = validateAgentName(name);
  if (err) return { ok: false, error: err };
  const n = name.trim().toLowerCase();

  // Uniqueness among live agents
  const taken = resolveAgent(n);
  if (taken && !(taken.kind === ref.kind && taken.id === ref.id)) {
    return { ok: false, error: `name \`${n}\` already in use` };
  }

  if (ref.kind === "session") {
    sessions.setAgentName(ref.id, n);
  } else {
    clearRunName(ref.id);
    runNames.set(n, ref.id);
    runNamesById.set(ref.id, n);
  }
  const agent = getAgent(ref.id)!;
  publishState(agent);
  return { ok: true, agent };
}

export function reportAgentState(
  idOrName: string,
  patch: {
    state?: AgentLifecycleState;
    state_label?: string | null;
    blocked_reason?: BlockedReason;
    demand_inspection?: boolean;
    /** Soft TTL ms (default 1h for blocked/working reports). */
    ttl_ms?: number | null;
  }
): { ok: true; agent: AgentOccupant } | { ok: false; error: string } {
  const ref = resolveAgent(idOrName);
  if (!ref) return { ok: false, error: `agent \`${idOrName}\` not found` };
  const k = key(ref.kind, ref.id);
  const prev = cleanOverlay(k) ?? {};
  const ttl = patch.ttl_ms === null ? null : (patch.ttl_ms ?? 60 * 60 * 1000);
  // Count each time a terminal STOPS to ask for you (the transition, not every repeat of the same
  // block). In the day's log this is the column that separates work that ran clean from work that
  // needed you five times.
  if (ref.kind === "session" && patch.state === "blocked" && prev.state !== "blocked") {
    try { sessions.countBlocked(ref.id); } catch {}
  }
  overlays.set(k, {
    ...prev,
    state: patch.state ?? prev.state,
    state_label: patch.state_label !== undefined ? patch.state_label : prev.state_label,
    blocked_reason:
      patch.blocked_reason !== undefined ? patch.blocked_reason : prev.blocked_reason,
    demand_inspection:
      patch.demand_inspection !== undefined ? patch.demand_inspection : prev.demand_inspection,
    expires_at: ttl == null ? null : Date.now() + ttl,
  });
  const agent = getAgent(ref.id)!;
  publishState(agent);
  notifyWaiters(agent);
  return { ok: true, agent };
}

/** Drop whatever was reported about this agent: its derived state speaks again (term-status.ts). */
export function clearAgentOverlay(idOrName: string): void {
  const ref = resolveAgent(idOrName);
  if (!ref) return;
  const k = key(ref.kind, ref.id);
  const prev = cleanOverlay(k);
  if (!prev || (prev.state === undefined && prev.state_label == null && prev.blocked_reason == null)) return;
  overlays.set(k, { seen: prev.seen, demand_inspection: prev.demand_inspection });
  const agent = getAgent(ref.id);
  if (agent) { publishState(agent); notifyWaiters(agent); }
}

export function markAgentSeen(idOrName: string): { ok: true; agent: AgentOccupant } | { ok: false; error: string } {
  const ref = resolveAgent(idOrName);
  if (!ref) return { ok: false, error: `agent \`${idOrName}\` not found` };
  const k = key(ref.kind, ref.id);
  const prev = cleanOverlay(k) ?? {};
  overlays.set(k, { ...prev, seen: true });
  const agent = getAgent(ref.id)!;
  publishState(agent);
  notifyWaiters(agent);
  return { ok: true, agent };
}

function publishState(agent: AgentOccupant): void {
  bus.publish({
    topic: "agent.state",
    kind: agent.kind,
    id: agent.id,
    name: agent.name,
    state: agent.state,
    state_label: agent.state_label,
    blocked_reason: agent.blocked_reason,
    demand_inspection: agent.demand_inspection,
    workspace_id: agent.workspace_id,
  });
}

function notifyWaiters(agent: AgentOccupant): void {
  for (const w of [...waiters]) {
    if (w.kind !== agent.kind || w.id !== agent.id) continue;
    if (!w.until.has(agent.state)) continue;
    clearTimeout(w.timer);
    waiters.delete(w);
    w.resolve(agent);
  }
}

export type WaitUntil = AgentLifecycleState | "settled";

const SETTLED: AgentLifecycleState[] = ["idle", "done", "blocked"];

/**
 * Event-driven wait pinned to a specific occupant id (replacements cannot satisfy it).
 * Herdr: `agent wait reviewer --until blocked`.
 */
export function waitForAgent(opts: {
  idOrName: string;
  until?: WaitUntil | WaitUntil[];
  timeout_ms?: number;
}): Promise<
  | { ok: true; agent: AgentOccupant; waited_ms: number }
  | { ok: false; error: string; agent?: AgentOccupant; waited_ms: number }
> {
  const started = Date.now();
  const ref = resolveAgent(opts.idOrName);
  if (!ref) {
    return Promise.resolve({
      ok: false,
      error: `agent \`${opts.idOrName}\` not found`,
      waited_ms: 0,
    });
  }

  const untilRaw = opts.until ?? "settled";
  const list = (Array.isArray(untilRaw) ? untilRaw : [untilRaw]).flatMap((u) =>
    u === "settled" ? SETTLED : [u]
  );
  const until = new Set<AgentLifecycleState>(list);
  const timeout = Math.max(1_000, Math.min(opts.timeout_ms ?? 120_000, 15 * 60_000));

  // Immediate match
  const current = getAgent(ref.id);
  if (current && until.has(current.state)) {
    return Promise.resolve({ ok: true, agent: current, waited_ms: 0 });
  }

  return new Promise((resolve) => {
    const entry = {
      kind: ref.kind,
      id: ref.id,
      until,
      resolve: (agent: AgentOccupant) =>
        resolve({ ok: true, agent, waited_ms: Date.now() - started }),
      reject: (_e: Error) => {
        /* unused — we resolve with ok:false on timeout */
      },
      timer: setTimeout(() => {
        waiters.delete(entry);
        const agent = getAgent(ref.id) ?? undefined;
        resolve({
          ok: false,
          error: `timeout after ${timeout}ms waiting for ${[...until].join("|")}`,
          agent,
          waited_ms: Date.now() - started,
        });
      }, timeout),
    };
    waiters.add(entry);
    entry.timer.unref?.();
  });
}

/** Rollup counts for fleet / Robert brief. */
export function lifecycleRollup(workspace_id?: string): {
  blocked: AgentOccupant[];
  working: AgentOccupant[];
  done: AgentOccupant[];
  counts: Record<AgentLifecycleState, number>;
} {
  const agents = listAgents({ workspace_id });
  const counts: Record<AgentLifecycleState, number> = {
    idle: 0,
    working: 0,
    blocked: 0,
    done: 0,
    unknown: 0,
  };
  for (const a of agents) counts[a.state]++;
  return {
    blocked: agents.filter((a) => a.state === "blocked"),
    working: agents.filter((a) => a.state === "working"),
    done: agents.filter((a) => a.state === "done"),
    counts,
  };
}

/**
 * Structured handoff body addressed to Robert. This is an executive's seam — a persona posts one to
 * hand work-ops over. `from` deliberately does not default to a person: most callers are workers,
 * and an unnamed handoff is from "agent" rather than from an executive who may not exist.
 */
export function formatHandoff(opts: {
  goal: string;
  context?: string;
  deadline?: string;
  constraints?: string;
  from?: string;
}): string {
  const lines = [
    `@Robert handoff`,
    ``,
    `**Goal:** ${opts.goal.trim()}`,
  ];
  if (opts.context?.trim()) lines.push(`**Context:** ${opts.context.trim()}`);
  if (opts.deadline?.trim()) lines.push(`**Deadline:** ${opts.deadline.trim()}`);
  if (opts.constraints?.trim()) lines.push(`**Constraints:** ${opts.constraints.trim()}`);
  lines.push(`**From:** ${opts.from ?? "agent"}`);
  lines.push(``);
  lines.push(`_Please ack with a short receipt, then own the work-ops._`);
  return lines.join("\n");
}

/** Keep waiters honest when underlying run/session events fire. */
export function startAgentLifecycleBridge(): void {
  bus.on("event", (e: BusEvent) => {
    if (e.topic === "run.ended" || e.topic === "run.started") {
      const agent = getAgent(e.run_id);
      if (agent) {
        if (e.topic === "run.ended") clearRunName(e.run_id);
        notifyWaiters(agent);
        publishState(agent);
      }
    }
    if (e.topic === "session.ended" || e.topic === "session.started" || e.topic === "session.updated") {
      const agent = getAgent(e.session_id);
      if (agent) {
        notifyWaiters(agent);
        publishState(agent);
      }
    }
    if (e.topic === "auth.needed" && e.run_id) {
      reportAgentState(e.run_id, {
        state: "blocked",
        blocked_reason: "auth",
        state_label: `auth needed (${e.backend})`,
      });
    }
  });
  console.log("[agent-lifecycle] bridge listening");
}
