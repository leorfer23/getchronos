import { CONFIG } from "./config.js";
import { runs, sessions, tickets, workspaces } from "./store.js";
import { status as dispatchStatus } from "./dispatcher.js";
import { lifecycleRollup, type AgentOccupant } from "./agent-lifecycle.js";
import { isStatusDivergent } from "./connectors/types.js";
import { spendToday, combinedByWorkspace } from "./spend.js";
import type { Ticket } from "./types.js";
import { esc } from "./telegram/api.js";
import { kb } from "./telegram/keyboards.js";

// One-glance fleet board: per-workspace live work, today's outcomes, PR state, spend and the ~5h
// subscription-limit token proxy. Data assembly (fleetData) reads only; composition (composeFleet)
// is pure so it unit-tests against seeded fixtures. Mirrors monitor.ts composeBrief.

export type FleetLiveRun = {
  runId8: string;
  jobName: string;
  elapsedSec: number;
  costSoFar: number;
  model: string;
  state?: string;
  name?: string | null;
  progress?: string | null;
};
export type FleetTicket = {
  key: string;
  title: string;
  status: string;
  /** 'external' = mirrors the upstream tracker (ClickUp/Jira) — no agent is actually on it. */
  statusSource: string;
  /** The tracker's own label as of the last sync (null = native ticket / never pulled). */
  externalStatus: string | null;
  /** `status` contradicts `externalStatus` — see isStatusDivergent(). */
  divergent: boolean;
  priority: string;
  assignee: string;
  prState: string | null;
  ciState: string | null;
};

/**
 * Attention order for the ticket list: what's stuck first, what's moving next, what's waiting on a
 * human after that, and only then what's merely queued. Same order the board renders in.
 */
export const TICKET_ORDER = ["blocked", "in_progress", "planning", "review", "planned", "ready"];

export type FleetWs = {
  name: string;
  slug: string;
  live: FleetLiveRun[];
  queued: number;
  sessionsLive: number;
  /** Herdr-style attention: blocked first. */
  agents: {
    blocked: number;
    working: number;
    done: number;
    blockedAgents: Array<{ name: string | null; label: string; id8: string; reason: string | null }>;
  };
  today: { done: number; failed: number; blocked: number; inReview: number };
  /** Open tickets in TICKET_ORDER, P0 first within a status — the "what is actually on the board" list. */
  tickets: FleetTicket[];
  /**
   * Tickets whose local status contradicts the tracker's last-known one, P0 first (capped — the
   * total is `divergentCount`). Deliberately NOT filtered by TICKET_ORDER: the worst case is a
   * ticket Chronos closed while ClickUp still shows it open (ACM-3), and closed tickets never
   * appear in `tickets` at all, which is exactly why nobody saw it.
   */
  divergent: FleetTicket[];
  divergentCount: number;
  /** Everything else still open (backlog, spec) — a count, not a list; it isn't attention-worthy. */
  backlog: number;
  prs: { open: number; mergedToday: number };
  spendToday: number;
  /** Headless-run slice of spendToday (for the strip's breakdown). */
  spendRunsToday: number;
  /** Desk-terminal slice of spendToday. */
  spendSessionsToday: number;
  budget: number | null;
  windowTokens: number;
  rateLimitResetsAt: string | null;
};
export type FleetData = {
  workspaces: FleetWs[];
  global: {
    live: number;
    queued: number;
    spendToday: number;
    spendRunsToday: number;
    spendSessionsToday: number;
    /** spendToday covers every workspace — runs + Desk. */
    spendScope: "global";
    /** Finished runs today whose backend never priced them (PER-24). */
    unpricedRunsToday: number;
    /** Desk dollars today that are token-table estimates, not CLI cost-state. */
    estimatedSessionsToday: number;
    budget: number;
    windowTokens: number;
    blocked: number;
    working: number;
  };
};

// Job-name prefix → pipeline stage word (same convention as store.costReport).
const STAGE: Record<string, string> = { plan: "plan", ticket: "build", review: "review", distill: "distill" };
// "ticket:ACM-14" → "ACM-14 build"; unrecognised prefixes pass through untouched.
function stripJobName(name: string): string {
  const m = name.match(/^(\w+):(.+)$/);
  return m && STAGE[m[1]] ? `${m[2]} ${STAGE[m[1]]}` : name;
}

const hoursAgo = (now: Date, h: number) => new Date(now.getTime() - h * 3600_000).toISOString();

// How many divergent tickets ride along per workspace — the count is always exact, the list is a
// sample (same shape as agents.blockedAgents) so a board with a 40-ticket mirror doesn't ship 40 rows.
const DIVERGENT_SHOWN = 10;

function toFleetTicket(t: Ticket): FleetTicket {
  return {
    key: t.key,
    title: t.title,
    status: t.status,
    statusSource: t.status_source,
    externalStatus: t.external_status,
    divergent: isStatusDivergent(t),
    priority: t.priority,
    assignee: t.assignee,
    prState: t.pr_state,
    ciState: t.ci_state,
  };
}

export function fleetData(now = new Date()): FleetData {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const midIso = midnight.toISOString();
  const win5h = hoursAgo(now, 5);
  const win24h = hoursAgo(now, 24);
  const todayStr = now.toISOString().slice(0, 10);

  const active = runs.activeByWorkspace();
  const win = new Map(runs.windowByWorkspace(win5h, win24h).map((r) => [r.workspace_id, r]));
  const spendMap = new Map(combinedByWorkspace(todayStr).map((r) => [r.workspace_id, r]));
  const builds = new Map<string, { done: number; failed: number; blocked: number }>();
  for (const b of runs.buildOutcomesSince(midIso)) {
    const cur = builds.get(b.workspace_id) ?? { done: 0, failed: 0, blocked: 0 };
    if (b.status === "success") cur.done += b.count;
    else if (b.status === "failed") cur.failed += b.count;
    else if (b.status === "blocked") cur.blocked += b.count;
    builds.set(b.workspace_id, cur);
  }

  const wsList: FleetWs[] = workspaces.list().map((w) => {
    const mine = active.filter((r) => r.workspace_id === w.id);
    const roll = lifecycleRollup(w.id);
    const live: FleetLiveRun[] = mine
      .filter((r) => r.status === "running")
      .map((r) => {
        const occ =
          roll.working.find((a) => a.kind === "run" && a.id === r.id) ??
          roll.blocked.find((a) => a.kind === "run" && a.id === r.id);
        return {
          runId8: r.id.slice(0, 8),
          jobName: stripJobName(r.job_name),
          elapsedSec: r.started_at ? (now.getTime() - Date.parse(r.started_at)) / 1000 : 0,
          costSoFar: r.cost_usd ?? 0,
          model: r.model ?? w.default_model ?? "default",
          state: occ?.state ?? "working",
          name: occ?.name ?? null,
          progress: occ?.progress ?? null,
        };
      });
    const wsTickets = tickets.list({ workspace_id: w.id });
    const diverged = wsTickets
      .filter(isStatusDivergent)
      .sort((a, z) => a.priority.localeCompare(z.priority) || a.key.localeCompare(z.key));
    const b = builds.get(w.id) ?? { done: 0, failed: 0, blocked: 0 };
    return {
      name: w.name,
      slug: w.slug,
      live,
      queued: mine.filter((r) => r.status === "queued").length,
      sessionsLive: sessions.list({ workspace_id: w.id, status: "live" }).length,
      agents: {
        blocked: roll.counts.blocked,
        working: roll.counts.working,
        done: roll.counts.done,
        blockedAgents: roll.blocked.slice(0, 8).map((a: AgentOccupant) => ({
          name: a.name,
          label: a.label,
          id8: a.id8,
          reason: a.blocked_reason,
          demand_inspection: a.demand_inspection,
        })),
      },
      today: {
        done: b.done,
        failed: b.failed,
        blocked: b.blocked,
        // Mirror tickets (status_source 'external') never mean a human/AI is actually reviewing —
        // just a tracker column Chronos hasn't touched.
        inReview: wsTickets.filter((t) => t.status === "review" && t.status_source !== "external").length,
      },
      tickets: wsTickets
        .filter((t) => TICKET_ORDER.includes(t.status))
        .sort(
          (a, z) =>
            TICKET_ORDER.indexOf(a.status) - TICKET_ORDER.indexOf(z.status) ||
            a.priority.localeCompare(z.priority) ||
            a.key.localeCompare(z.key)
        )
        .map(toFleetTicket),
      divergent: diverged.slice(0, DIVERGENT_SHOWN).map(toFleetTicket),
      divergentCount: diverged.length,
      backlog: wsTickets.filter((t) => t.status === "backlog" || t.status === "spec").length,
      prs: {
        open: wsTickets.filter((t) => t.pr_state === "open").length,
        mergedToday: wsTickets.filter((t) => t.pr_state === "merged" && t.updated_at >= midIso).length,
      },
      spendToday: spendMap.get(w.id)?.total_usd || 0,
      spendRunsToday: spendMap.get(w.id)?.runs_usd || 0,
      spendSessionsToday: spendMap.get(w.id)?.sessions_usd || 0,
      budget: w.daily_budget_usd ?? null,
      windowTokens: win.get(w.id)?.tokens ?? 0,
      rateLimitResetsAt: win.get(w.id)?.resets_at ?? null,
    };
  });

  let globalTokens = 0;
  for (const r of win.values()) globalTokens += r.tokens;
  const ds = dispatchStatus();
  const globalRoll = lifecycleRollup();
  const todaySpend = spendToday();
  return {
    workspaces: wsList,
    global: {
      live: ds.active,
      queued: ds.queued,
      spendToday: todaySpend.total_usd,
      spendRunsToday: todaySpend.runs.usd,
      spendSessionsToday: todaySpend.sessions.usd,
      // Combined runs + Desk; budget gate in the dispatcher still keys off runs alone.
      spendScope: "global" as const,
      unpricedRunsToday: ds.unpriced_runs_today,
      estimatedSessionsToday: todaySpend.coverage.estimated_usd,
      budget: CONFIG.dailyBudgetUsd,
      windowTokens: globalTokens,
      blocked: globalRoll.counts.blocked,
      working: globalRoll.counts.working,
    },
  };
}

// ── formatting (shared with the CLI's plain renderer conceptually; kept here for the HTML board) ──
export function fmtTokens(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(Math.round(n));
}
export function fmtDur(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`;
}
function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function isActive(w: FleetWs): boolean {
  // divergentCount counts: a workspace whose only news is "the tracker contradicts us" is precisely
  // the one that must stop being invisible, even with zero runs today.
  return !!(w.live.length || w.queued || w.sessionsLive || w.agents?.blocked || w.today.done || w.today.failed || w.today.blocked ||
    w.today.inReview || w.prs.open || w.prs.mergedToday || w.spendToday || w.rateLimitResetsAt || w.divergentCount);
}

// Pure: FleetData → compact Telegram HTML board + refresh keyboard. Skips idle-and-zero workspaces.
export function composeFleet(data: FleetData): { text: string; keyboard: object } {
  const lines: string[] = [];
  for (const w of data.workspaces) {
    if (!isActive(w)) continue;
    const act: string[] = [];
    if (w.agents?.blocked) act.push(`🚫${w.agents.blocked}`);
    if (w.live.length) act.push(`▶${w.live.length}`);
    if (w.queued) act.push(`⏳${w.queued}`);
    if (w.sessionsLive) act.push(`💻${w.sessionsLive}`);
    const today: string[] = [];
    if (w.today.done) today.push(`✅${w.today.done}`);
    if (w.today.failed) today.push(`✗${w.today.failed}`);
    if (w.today.blocked) today.push(`🚫${w.today.blocked}`);
    if (w.today.inReview) today.push(`⟳${w.today.inReview}`);
    const pr: string[] = [];
    if (w.prs.open) pr.push(`🔀${w.prs.open}`);
    if (w.prs.mergedToday) pr.push(`✅🔀${w.prs.mergedToday}`);

    const head = `<b>${esc(w.name)}</b>${act.length ? " " + act.join(" ") : ""}`;
    const rest: string[] = [];
    if (today.length) rest.push(`today ${today.join(" ")}`);
    if (pr.length) rest.push(`PR ${pr.join(" ")}`);
    rest.push(`$${w.spendToday.toFixed(2)}`);
    if (w.windowTokens) rest.push(`🪙${fmtTokens(w.windowTokens)}/5h`);
    lines.push([head, ...rest].join(" · "));
    for (const a of w.agents?.blockedAgents?.slice(0, 3) ?? []) {
      const handle = a.name ? `@${a.name}` : `\`${a.id8}\``;
      lines.push(`  🚫 ${esc(handle)} ${esc(a.label)}${a.reason ? ` · ${esc(a.reason)}` : ""}`);
    }

    for (const r of w.live) lines.push(`  ▶ ${esc(r.jobName)} · ${fmtDur(r.elapsedSec)} · $${r.costSoFar.toFixed(2)} (${esc(r.model)})`);
    // "Chronos says X, the tracker says Y" — named per ticket, because a bare count is what let ACM-3
    // read as an open P1 for days. Two shown, the rest as +N.
    if (w.divergentCount) {
      const shown = w.divergent.slice(0, 2).map((t) => `${esc(t.key)} ${esc(t.status)}↔${esc(t.externalStatus ?? "?")}`);
      const more = w.divergentCount - shown.length;
      lines.push(`  ⚠ tracker disagrees: ${shown.join(", ")}${more > 0 ? ` +${more}` : ""}`);
    }
    if (w.rateLimitResetsAt) lines.push(`  ⏸ limited, resets ${hhmm(w.rateLimitResetsAt)}`);
  }
  if (!lines.length) lines.push("<i>Fleet idle — no active work.</i>");
  const g = data.global;
  const blocked = g.blocked ? ` · 🚫${g.blocked} blocked` : "";
  // "all" is the qualifier that was missing when this line was read as one workspace's spend, and
  // "+N unpriced" is the one that was missing when 63 of 69 runs cost an unknown amount (PER-24).
  const unpriced = g.unpricedRunsToday ? ` +${g.unpricedRunsToday} unpriced` : "";
  lines.push(`\n▶${g.live} live · ${g.queued} queued${blocked} · $${g.spendToday.toFixed(2)}/$${g.budget} today (all ws${unpriced}) · 🪙${fmtTokens(g.windowTokens)}/5h`);
  return { text: lines.join("\n"), keyboard: kb([[{ text: "🔄 refresh", data: "fl.r" }]]) };
}
