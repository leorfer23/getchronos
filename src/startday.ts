import fs from "node:fs";
import path from "node:path";
import { inbox, jots, notes as notesStore, repos, sessions, tickets, workspaces } from "./store.js";
import { openSession } from "./terminal.js";
import { wsTicketsDir } from "./sandbox.js";
import {
  cap, isPlannerSession, mmdd, oneLine, parkedLines, prLines, repoLines, sessionLines, ticketLines, trackerLine, ymd,
} from "./nextday.js";
import type { Repo, Session, Ticket, Workspace } from "./types.js";
import type { Jot } from "./store/jots.js";
import type { InboxItem } from "./store/inbox.js";

/**
 * Start the day.
 *
 * The morning twin of plan-tomorrow (src/nextday.ts): one button on the Desk bar opens one terminal
 * per workspace the operator ticks — all of them by default. Each terminal reads what happened
 * since he last worked there (the needs-you inbox, the tracker, Slack and the client's other tools,
 * the last terminals, the PRs, the cards already filed for today) and PROPOSES today's work in the
 * terminal, then waits for him.
 *
 * Where the evening planner works alone and its output is cards, this one is a conversation: the
 * proposal is the output, and nothing is filed or started until he answers. The daemon gathers what
 * its own tables hold into a brief on disk, exactly as plan-tomorrow does, and the terminal does the
 * part that needs tools.
 */

export type StartOpts = {
  /** Workspace ids. Default: every unarchived workspace. */
  workspaces?: string[];
  /** Per-workspace free text from the operator, keyed by workspace id. Outranks every other source. */
  steering?: Record<string, string>;
  /** operator | robert | cron — for the day's ledger. */
  created_by?: string;
};

export type StartResult = {
  date: string;
  started: Array<{ workspace_id: string; slug: string; session_id: string; brief_path: string }>;
  errors: Array<{ workspace_id: string; slug: string; error: string }>;
};

/** The day being started: the calendar day on the operator's clock, weekend or not. */
export const today = (now = new Date()): string => ymd(now);

export function defaultStartWorkspaces(): Workspace[] {
  return workspaces.list().filter((w) => !w.archived);
}

// ───────────────────────────── the brief ─────────────────────────────

export type StartContext = {
  steering?: string | null;
  sessions: Session[];
  tickets: Ticket[];
  repos: Repo[];
  /** Open rows of this client's needs-you inbox (Slack triage + tracker diff). */
  inbox: InboxItem[];
  /** Cards already filed for today — usually last night's plan. */
  cards: Jot[];
  parked: Jot[];
  learnings?: string | null;
};

function slackOn(ws: Workspace): boolean {
  try { return !!JSON.parse(ws.slack_config || "{}").enabled; } catch { return false; }
}

function inboxLines(rows: InboxItem[]): string {
  const lines = rows.slice(0, 25).map(
    (i) =>
      `   - ${i.urgent ? "‼ " : ""}[${i.source}/${i.kind}] ${oneLine(i.title, 110)}` +
      `${i.actor ? ` — ${oneLine(i.actor, 40)}` : ""}${i.why ? ` — ${oneLine(i.why, 140)}` : ""}${i.url ? ` ${i.url}` : ""}`,
  );
  return lines.length ? lines.join("\n") : "   (nothing waiting in the inbox)";
}

function cardLines(rows: Jot[]): string {
  return rows.length
    ? rows.map((j) => `   - ${oneLine(j.title, 110)}${j.session_id ? " (already running)" : ""}`).join("\n")
    : "   (no cards filed for today)";
}

/**
 * The morning terminal's whole instruction set. Pure: everything it needs is in `ctx`, so a test can
 * render it from seeded rows and read what the agent would be told.
 */
export function startDayBrief(ws: Workspace, date: string, ctx: StartContext): string {
  const steer = (ctx.steering ?? "").trim();
  const weekday = new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { weekday: "long" });
  const sections: string[] = [];

  sections.push(
    `# Start ${date} (${weekday}) — ${ws.name}\n\n` +
      `You open ${ws.name}'s working day with the operator. Find out what happened since he last worked here ` +
      `and what is waiting on him, then PROPOSE what to work on today — in this terminal, as text — and wait ` +
      `for his answer.\n\n` +
      `Until he answers you are read-only: you do not edit code, you do not create or move anything in the ` +
      `tracker, you do not post or reply anywhere (Slack, email, PRs), you do not start any of the work. ` +
      `Reading is the whole job; the proposal is the output.`,
  );

  if (steer) {
    sections.push(
      `## What the operator wants weighed in\n${cap(steer, 4000)}\n\n` +
        `This outranks every source below. If it names work, that work is item #1. If it changes priorities, ` +
        `reorder everything else around it.`,
    );
  }

  sections.push(
    `## Where to look (in this order — a source that returns nothing is skipped, never invented)\n` +
      `1. What already needs him — this client's inbox on the Desk (Slack DMs and @mentions the triage filed, ` +
      `tracker changes aimed at him). Open rows right now:\n${inboxLines(ctx.inbox)}\n` +
      `   More: \`mc inbox list --open\`.\n` +
      `2. Tracker — ${trackerLine(ws)}\n   Mirror right now (open):\n${ticketLines(ctx.tickets)}\n` +
      `3. Slack — ${
        slackOn(ws)
          ? `this workspace has its Slack tools wired in.`
          : `use the Slack tools your profile exposes; if there are none, say so in the proposal and move on.`
      } Read what arrived since his last working day: DMs, @mentions, threads he is in, and the channels this ` +
      `client's memos name. Someone waiting on an answer from him is the first thing he should see.\n` +
      `4. This client's other tools — whatever the profile exposes and the memos name for ${ws.name}: ` +
      `orchestrator and pipeline health (Airflow, Jenkins, CI), dashboards and alerts (Grafana), warehouse ` +
      `freshness, email, and \`mc cal --days 1\` for today's meetings. Check the ones that can have failed or ` +
      `moved overnight. \`mc vars\` holds the tokens and config values a tool may need.\n` +
      `5. The last work in Chronos here — what was in flight when he stopped. An unfinished thread is usually ` +
      `today's first item; a ✓ one may have left a follow-up.\n${sessionLines(ctx.sessions)}\n` +
      `   More: \`mc worklog\` (what was finished and what each piece left pending), \`mc desk log --since 7d\`, ` +
      `\`mc when list\` (work parked until something happens), \`mc pad due\` (follow-ups that are due), and ` +
      `\`mc recall "<topic>"\` for what an earlier session learned.\n` +
      `6. Shipped and in flight — PRs. An open one may need a review answered, a rebase or a nudge; a merged ` +
      `one may imply its follow-up.\n${prLines(ctx.tickets)}\n` +
      `   Per repo, from its path: \`gh pr list --author @me --state all --limit 20 --json number,title,url,state,updatedAt,mergedAt\`, ` +
      `\`gh pr list --search "review-requested:@me" --json number,title,url\` and \`git log --since=3.days --oneline\`. Repos:\n${repoLines(ctx.repos)}\n` +
      `7. Cards already filed for today (\`mc jot list --date ${date}\` shows each in full) — usually last ` +
      `night's plan. They are the starting point, not the answer: confirm, reorder or drop each one against ` +
      `what you found this morning.\n${cardLines(ctx.cards)}\n` +
      `   Parked by the operator, undated — context:\n${parkedLines(ctx.parked)}\n` +
      `8. Memos — \`mc memo list\`, then \`mc memo get <slug>\` for anything that reads like a commitment or a ` +
      `plan. The ★ ones are already in your context.` +
      (ctx.learnings ? `\n   Latest operator learnings:\n${cap(ctx.learnings.trim(), 2500).replace(/^/gm, "   ")}` : ""),
  );

  sections.push(
    `## What to propose\n` +
      `One message, short enough to read in a minute, in this shape:\n` +
      "```\n" +
      `## Waiting on you\n<who is waiting on an answer or a review from him, oldest first — name, what, link. "Nobody" if nobody.>\n` +
      `## Overnight\n<what broke, moved or shipped since he last worked here — failures first. One line each.>\n` +
      `## Today, in order\n<3–6 items. Each: the outcome (what will be TRUE), where it comes from (ticket key / PR / thread / card), rough size, why today.>\n` +
      `## Not today\n<what you deliberately left out, one line on why.>\n` +
      `## Could not reach\n<any source above you had no tool or no access for. Omit if none.>\n` +
      "```\n" +
      `- He runs several agents in parallel and QAs every result himself: propose what he can review by ` +
      `evening, not everything that is open. A quiet day gets fewer items and one honest sentence about why.\n` +
      `- Quote ticket keys, PR numbers and links verbatim. Never invent a ticket, a message or a failure.\n` +
      `- Write to him the way this workspace's memos say he wants to be written to.\n\n` +
      `Then stop and wait for him. Do not run \`mc goal done\` yet.`,
  );

  sections.push(
    `## After he answers\n` +
      `Do what he says. For each item he agrees to and wants run in its own terminal, file a card — he presses ` +
      `▶ on it — unless a card for it is already filed for today:\n` +
      "```\n" +
      `mc jot new --date ${date} --title "<the outcome, ≤70 chars>" --body "<markdown, template below>"\n` +
      "```\n" +
      "```\n" +
      `## Description\n<what and why, naming the ticket key / PR / thread it comes from — enough that an agent with no memory can start>\n` +
      `## Goal\n<the one outcome; what done looks like>\n` +
      `## Where to look\n<repos, files, tickets, PRs, memos, dashboards — concrete paths and keys>\n` +
      `## Done when\n<checkable criteria>\n` +
      `## QA for the operator\n<how the operator verifies it in five minutes>\n` +
      "```\n" +
      `If he tells you to do an item right here instead, do it here. When the day is agreed and its cards are ` +
      `filed, \`mc goal done\`.`,
  );

  return cap(sections.join("\n\n"), 40_000);
}

// ───────────────────────────── gathering + fan-out ─────────────────────────────

const START_TITLE = (date: string) => `Start Day ${mmdd(date)}`;
const START_GOAL = (date: string) => `Start ${mmdd(date)}: propose today's work`;

export function collectStartContext(ws: Workspace, date: string, steering?: string | null): StartContext {
  const recent = sessions
    .list({ workspace_id: ws.id, limit: 60 })
    .filter((s) => (s.goal || s.summary) && !isPlannerSession(s))
    .slice(0, 8);
  const open = jots.list({ workspace_id: ws.id, status: "open" });
  return {
    steering,
    sessions: recent,
    tickets: tickets.list({ workspace_id: ws.id }),
    repos: repos.list(ws.id),
    inbox: inbox.list({ workspace_id: ws.id }),
    cards: open.filter((j) => j.for_date === date),
    parked: open,
    learnings: notesStore.bySlug(ws.id, "session-learnings")?.body ?? null,
  };
}

export function startBriefPath(ws: Workspace, date: string): string {
  return path.join(wsTicketsDir(ws.slug), "startday", `${date}.md`);
}

export type StartDeps = {
  open: (opts: Parameters<typeof openSession>[0]) => Promise<Session>;
  writeBrief: (ws: Workspace, date: string, text: string) => string;
};

const defaultDeps: StartDeps = {
  open: openSession,
  writeBrief: (ws, date, text) => {
    const fp = startBriefPath(ws, date);
    fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o700 });
    fs.writeFileSync(fp, text, { mode: 0o600 });
    return fp;
  },
};

/**
 * Open one morning terminal per workspace. Each is independent: a workspace at its session cap
 * reports an error and the others still open. Nothing is cleared — the cards already filed for
 * today are an input here, not something to replace.
 */
export async function startDay(opts: StartOpts = {}, deps: StartDeps = defaultDeps, now = new Date()): Promise<StartResult> {
  const date = today(now);
  // A workspace named twice still gets one terminal.
  const targets: Workspace[] = opts.workspaces?.length
    ? [...new Set(opts.workspaces)].map((id) => {
        const w = workspaces.get(id);
        if (!w) throw new Error(`workspace not found: ${id}`);
        return w;
      })
    : defaultStartWorkspaces();
  if (!targets.length) throw new Error("no workspaces to start");

  const out: StartResult = { date, started: [], errors: [] };
  for (const ws of targets) {
    try {
      const steer = opts.steering?.[ws.id] ?? null;
      const fp = deps.writeBrief(ws, date, startDayBrief(ws, date, collectStartContext(ws, date, steer)));
      const s = await deps.open({
        workspace_id: ws.id,
        title: START_TITLE(date),
        goal: START_GOAL(date),
        goal_kind: "investigation",
        goal_source: "human",
        description:
          (steer?.trim()
            ? `What your operator wants weighed in for ${ws.name} today (his words, verbatim — this outranks every other source):\n` +
              `${steer.trim()}\n\n`
            : "") +
          `Read the full brief at ${fp} and follow it to the letter — it lists the sources to check (inbox, tracker, ` +
          `Slack, this client's other tools, the last work in Chronos) and the shape of the proposal. Propose ` +
          `today's work here, then wait for the operator.`,
        backend: ws.default_backend ?? undefined,
        created_by: opts.created_by ?? "operator",
        role: "human",
        // The brief it must read is a file on the brain's disk (startBriefPath): placement may not
        // send it to another computer, where that path does not exist.
        host_id: "local",
      } as any);
      out.started.push({ workspace_id: ws.id, slug: ws.slug, session_id: s.id, brief_path: fp });
    } catch (e: any) {
      out.errors.push({ workspace_id: ws.id, slug: ws.slug, error: String(e?.message ?? e) });
    }
  }
  return out;
}
