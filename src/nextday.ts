import fs from "node:fs";
import path from "node:path";
import { jots, notes as notesStore, repos, sessions, tickets, workspaces } from "./store.js";
import { isClosedTicketStatus } from "./types.js";
import { openSession } from "./terminal.js";
import { wsTicketsDir } from "./sandbox.js";
import type { Repo, Session, Ticket, Workspace } from "./types.js";
import type { Jot } from "./store/jots.js";

/**
 * Plan tomorrow.
 *
 * One button on the Desk (or one call from Robert) opens one terminal per client. Each terminal is a
 * planner: it reads that client's tracker, the last terminals worked there, the PRs shipped and in
 * flight, and the memos, then files the next day's cards with `mc jot new --date`. A card is a jot
 * with a date — the row that already has the one action wanted here, ▶ Run, which opens a fresh
 * terminal seeded with the card's body.
 *
 * The daemon does the gathering it can do from its own tables (sessions, mirrored tickets, PR state,
 * parked cards, learnings) and writes it into a brief on disk; the terminal reads the brief and does
 * the part that needs tools — the live tracker, `gh`, `git log`, the memos in full. The brief lives
 * in the workspace's tickets dir because that path is already granted to the sandbox; nothing new
 * is opened up for it.
 */

export type PlanOpts = {
  /** Workspace ids. Default: every unarchived client with a `default_dir` (the ones you actually work in). */
  workspaces?: string[];
  /** Per-workspace free text from the operator, keyed by workspace id. Outranks every other source. */
  steering?: Record<string, string>;
  /** YYYY-MM-DD. Default: the next workday. */
  date?: string;
  /** operator | robert | cron — for the day's ledger. */
  created_by?: string;
};

export type PlanResult = {
  date: string;
  planned: Array<{ workspace_id: string; slug: string; session_id: string; brief_path: string; replaced: number }>;
  errors: Array<{ workspace_id: string; slug: string; error: string }>;
};

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const mmdd = (date: string) => date.slice(5);

/**
 * The day the cards are for. "Tomorrow" from a button pressed in the evening; but a plan made after
 * midnight is for the day that just started, and a plan made on Friday is for Monday — client work
 * does not happen on the weekend, and a Saturday plan would sit unread until it was stale.
 */
export function nextWorkday(now = new Date()): string {
  const d = new Date(now);
  if (d.getHours() >= 4) d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return ymd(d);
}

export function defaultPlanWorkspaces(): Workspace[] {
  return workspaces.list().filter((w) => !w.archived && w.kind === "client" && !!w.default_dir);
}

// ───────────────────────────── the brief ─────────────────────────────

export type BriefContext = {
  steering?: string | null;
  sessions: Session[];
  tickets: Ticket[];
  repos: Repo[];
  parked: Jot[];
  learnings?: string | null;
  replaced: number;
};

const cap = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max) + `\n(…truncated at ${max} chars)`);
const oneLine = (s: string | null | undefined, max = 160) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const day = (iso: string | null | undefined) => (iso ?? "").slice(0, 10);

/** Non-secret pointers from the connector config: where the tracker is, never how to log in. */
function trackerLine(ws: Workspace): string {
  let cfg: any = {};
  try { cfg = ws.connector_config ? JSON.parse(ws.connector_config) : {}; } catch { cfg = {}; }
  if (ws.ticket_connector === "jira") {
    const where = [cfg.base_url, cfg.project_key ? `project ${cfg.project_key}` : null].filter(Boolean).join(", ");
    return (
      `**Jira** (${where || "see memos"}), mirrored into Mission Control — \`mc ticket list\` is the mirror, ` +
      `and the Jira/Atlassian tools your profile exposes reach what the mirror does not (comments, sprint, due ` +
      `dates, what a teammate just reassigned). Look for: assigned to me and unresolved, due or overdue, blocked ` +
      `on me, and anything that moved since yesterday.`
    );
  }
  if (ws.ticket_connector === "clickup") {
    return (
      `**ClickUp** (list ${cfg.list_id ?? "see memos"}), mirrored into Mission Control — \`mc ticket list\` is the ` +
      `mirror, and the ClickUp tools your profile exposes reach status, comments, due dates and what was just ` +
      `assigned. Look for: assigned to me and open, due or overdue, blocked on me, and anything that moved since yesterday.`
    );
  }
  return (
    `No tracker is mirrored into Mission Control for this workspace. Use the tracker tools your profile exposes ` +
    `(a Jira or ClickUp MCP/connector — this workspace's memos say which one and which project). Look for: ` +
    `assigned to me and unresolved, due or overdue, blocked on me, and anything that moved since yesterday. ` +
    `If no tracker tool is reachable, say so in your summary line and plan from the other sources — never invent tickets.`
  );
}

function ticketLines(rows: Ticket[]): string {
  const open = rows
    .filter((t) => !isClosedTicketStatus(t.status))
    .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))
    .slice(0, 40)
    .map((t) => `   - ${t.key} · ${oneLine(t.title, 90)} [${t.external_status || t.status}]${t.external_url ? ` ${t.external_url}` : ""}`);
  return open.length ? open.join("\n") : "   (nothing open in the mirror)";
}

function sessionLines(rows: Session[]): string {
  const lines = rows.map((s) => {
    const label = oneLine(s.title || s.goal || s.first_prompt, 90) || "(untitled)";
    const what = oneLine(s.summary || (s.goal && s.title ? s.goal : ""), 200);
    return `   - ${day(s.created_at)} · ${label}${s.goal_kind ? ` (${s.goal_kind})` : ""}${s.goal_done_at ? " ✓" : s.status === "live" ? " · still open" : ""}${what ? ` — ${what}` : ""}`;
  });
  return lines.length ? lines.join("\n") : "   (no recent terminals here)";
}

function prLines(rows: Ticket[]): string {
  const cut = Date.now() - 14 * 86_400_000;
  const withPr = rows
    .filter((t) => t.pr_url && Date.parse(t.updated_at || t.created_at) >= cut)
    .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))
    .slice(0, 20)
    .map((t) => `   - ${t.key} · ${oneLine(t.title, 80)} — ${t.pr_state || "pr"} ${t.pr_url}`);
  return withPr.length ? withPr.join("\n") : "   (no PR-bearing tickets in the last two weeks)";
}

function repoLines(rows: Repo[]): string {
  const withPath = rows.filter((r) => r.path);
  return withPath.length
    ? withPath.map((r) => `   - ${r.name}: ${r.path}${r.git_remote ? ` (${r.git_remote})` : ""}`).join("\n")
    : "   (no repos registered — plan from the tracker and the terminals)";
}

function parkedLines(rows: Jot[]): string {
  const open = rows.filter((j) => j.status === "open" && !j.for_date);
  return open.length
    ? open.map((j) => `   - ${oneLine(j.title, 100)}${j.body ? ` — ${oneLine(j.body, 140)}` : ""}`).join("\n")
    : "   (nothing parked)";
}

/**
 * The planner's whole instruction set. Pure: everything it needs is in `ctx`, so a test can render
 * it from seeded rows and read what the agent would be told.
 */
export function nextDayBrief(ws: Workspace, date: string, ctx: BriefContext): string {
  const steer = (ctx.steering ?? "").trim();
  const weekday = new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { weekday: "long" });
  const sections: string[] = [];

  sections.push(
    `# Plan ${date} (${weekday}) — ${ws.name}\n\n` +
      `You are the planner for ${ws.name}'s next working day. Your ONLY output is a set of cards on the operator's ` +
      `Desk, filed with \`mc jot new --date ${date}\`. You do not edit code, you do not create tickets, you do not ` +
      `post anywhere, you do not move anything in the tracker. Read-only, except for \`mc jot\`.\n\n` +
      `Tomorrow morning the operator presses ▶ on each card and a FRESH terminal starts from the card's body. ` +
      `That agent has this workspace's ★ memos and \`mc recall\`, but not your transcript — everything it needs ` +
      `to start has to be in the card.`,
  );

  if (steer) {
    sections.push(
      `## What the operator wants weighed in\n${cap(steer, 4000)}\n\n` +
        `This outranks every source below. If it names work, that work is card #1. If it changes priorities, ` +
        `reorder everything else around it.`,
    );
  }

  sections.push(
    `## How to size the day\n` +
      `- This is ONE client's day. The operator runs several agents in parallel and QAs every result himself, so ` +
      `plan for more than a human day — but not more than he can review by evening. Target 4–7 cards, each ` +
      `1–4 hours of agent work, each reviewable on its own. Aggressive in ambition, honest in scope: a card he ` +
      `could not QA in one sitting is two cards.\n` +
      `- Prefer work that moves a real ticket, PR or commitment. Unfinished threads from the last terminals ` +
      `come first; then what is due; then what the tracker says nobody has picked up; then the improvement ` +
      `nobody asked for but the codebase clearly needs.\n` +
      `- Order by priority — the first card you file is the day's headline.\n` +
      `- No filler. A quiet day gets fewer cards and one honest sentence about why.\n` +
      `- Tomorrow always gets its own cards. Never skip one because something similar already exists somewhere — ` +
      `a parked card, yesterday's plan, a ticket — the card for ${date} is what gets run.`,
  );

  sections.push(
    `## Where to look (in this order — a source that returns nothing is skipped, never invented)\n` +
      `1. Tracker — ${trackerLine(ws)}\n   Mirror right now (open):\n${ticketLines(ctx.tickets)}\n` +
      `2. The last terminals in this workspace — what was in flight when the day ended. An unfinished thread is ` +
      `tomorrow's first card; a ✓ one may have follow-ups.\n${sessionLines(ctx.sessions)}\n` +
      `   More: \`mc desk log --since 7d\`, and \`mc recall "<topic>"\` for what an earlier session learned.\n` +
      `3. Shipped and in flight — PRs. A merged PR often implies its follow-up; an open one may need a nudge ` +
      `or a rebase.\n${prLines(ctx.tickets)}\n` +
      `   Per repo, from its path: \`gh pr list --author @me --state all --limit 20 --json number,title,url,state,updatedAt,mergedAt\` ` +
      `and \`git log --since=7.days --oneline\`. Repos:\n${repoLines(ctx.repos)}\n` +
      `4. Memos — \`mc memo list\`, then \`mc memo get <slug>\` for anything that looks like a commitment, a plan ` +
      `or a "we should". The ★ ones are already in your context.` +
      (ctx.learnings ? `\n   Latest operator learnings:\n${cap(ctx.learnings.trim(), 2500).replace(/^/gm, "   ")}` : "") +
      `\n5. Cards already parked here by the operator — context, not a constraint. A similar parked card, or a ` +
      `similar card from an earlier day, is NOT a reason to leave tomorrow's card out: file tomorrow's full set ` +
      `regardless, and where one of these is the natural next step, fold it in and say so in the card:\n${parkedLines(ctx.parked)}` +
      (ctx.replaced ? `\n   (${ctx.replaced} earlier planner card${ctx.replaced === 1 ? " was" : "s were"} cleared for ${date} by this run — plan fresh.)` : ""),
  );

  sections.push(
    `## How to file each card\n` +
      "```\n" +
      `mc jot new --date ${date} --title "<the outcome, ≤70 chars — what will be TRUE, not 'investigate X'>" --body "<markdown, template below>"\n` +
      "```\n" +
      `Body template — every section, in this order:\n` +
      "```\n" +
      `## Description\n<what and why, naming the ticket key / PR / memo it comes from — enough that an agent with no memory can start>\n` +
      `## Goal\n<the one outcome; what done looks like>\n` +
      `## Where to look\n<repos, files, tickets, PRs, memos, dashboards — concrete paths and keys>\n` +
      `## Done when\n<checkable criteria>\n` +
      `## QA for the operator\n<how the operator verifies it in five minutes>\n` +
      "```\n" +
      `Write the body for the agent that will run it, not for the operator. Quote keys, paths and URLs verbatim.\n\n` +
      `File in priority order — first filed is first on the Desk. When done: \`mc jot list --date ${date}\` to check the ` +
      `set reads as one coherent day, print ONE summary line (how many cards, what each source contributed, any ` +
      `source you could not reach), then \`mc goal done\`.`,
  );

  return cap(sections.join("\n\n"), 40_000);
}

// ───────────────────────────── gathering + fan-out ─────────────────────────────

const PLANNER_TITLE = (date: string) => `Next Day ${mmdd(date)} plan`;
const PLANNER_GOAL = (date: string) => `Plan ${mmdd(date)}: file tomorrow's cards`;

export function collectContext(ws: Workspace, date: string, steering?: string | null, replaced = 0): BriefContext {
  const plannerTitle = PLANNER_TITLE(date);
  const recent = sessions
    .list({ workspace_id: ws.id, limit: 60 })
    // Skip the noise: terminals with nothing to say (no goal, no summary — a bare "cwd check"), and
    // earlier planners (their output is the cards, not a thread to pick up).
    .filter((s) => (s.goal || s.summary) && !(s.title || "").startsWith("Next Day "))
    .filter((s) => s.title !== plannerTitle)
    .slice(0, 8);
  return {
    steering,
    sessions: recent,
    tickets: tickets.list({ workspace_id: ws.id }),
    repos: repos.list(ws.id),
    parked: jots.list({ workspace_id: ws.id, status: "open" }),
    learnings: notesStore.bySlug(ws.id, "session-learnings")?.body ?? null,
    replaced,
  };
}

export function briefPath(ws: Workspace, date: string): string {
  return path.join(wsTicketsDir(ws.slug), "nextday", `${date}.md`);
}

export type PlanDeps = {
  open: (opts: Parameters<typeof openSession>[0]) => Promise<Session>;
  writeBrief: (ws: Workspace, date: string, text: string) => string;
};

const defaultDeps: PlanDeps = {
  open: openSession,
  writeBrief: (ws, date, text) => {
    const fp = briefPath(ws, date);
    fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o700 });
    fs.writeFileSync(fp, text, { mode: 0o600 });
    return fp;
  },
};

/**
 * Open one planner terminal per client. Each client is independent: a workspace at its session cap
 * reports an error and the others still open. A re-plan for the same day first clears that day's
 * unrun planner cards so the new set replaces the old one instead of stacking under it.
 */
export async function planNextDay(opts: PlanOpts = {}, deps: PlanDeps = defaultDeps): Promise<PlanResult> {
  const date = opts.date ?? nextWorkday();
  const targets: Workspace[] = opts.workspaces?.length
    ? opts.workspaces.map((id) => {
        const w = workspaces.get(id);
        if (!w) throw new Error(`workspace not found: ${id}`);
        return w;
      })
    : defaultPlanWorkspaces();
  if (!targets.length) throw new Error("no workspaces to plan — pick some, or give a client a default_dir");

  const out: PlanResult = { date, planned: [], errors: [] };
  for (const ws of targets) {
    try {
      const replaced = jots.clearPlanned(ws.id, date);
      const steer = opts.steering?.[ws.id] ?? null;
      const brief = nextDayBrief(ws, date, collectContext(ws, date, steer, replaced));
      const fp = deps.writeBrief(ws, date, brief);
      const s = await deps.open({
        workspace_id: ws.id,
        title: PLANNER_TITLE(date),
        goal: PLANNER_GOAL(date),
        goal_kind: "investigation",
        goal_source: "human",
        description:
          (steer?.trim()
            ? `What your operator wants weighed in for ${ws.name} (his words, verbatim — this outranks every other source):\n` +
              `${steer.trim()}\n\n`
            : "") +
          `Read the full brief at ${fp} and follow it to the letter — it lists the sources to check and how to file ` +
          `each card (mc jot new --date ${date}). Your output is the cards, nothing else.`,
        backend: ws.default_backend ?? undefined,
        created_by: opts.created_by ?? "operator",
        role: "human",
        // The brief it must read is a file on the brain's disk (briefPath): placement may not send it
        // to another computer, where that path does not exist.
        host_id: "local",
      } as any);
      out.planned.push({ workspace_id: ws.id, slug: ws.slug, session_id: s.id, brief_path: fp, replaced });
    } catch (e: any) {
      out.errors.push({ workspace_id: ws.id, slug: ws.slug, error: String(e?.message ?? e) });
    }
  }
  return out;
}
