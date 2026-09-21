/**
 * "Shipped" — what actually landed, per client, per day, with the burn next to it.
 *
 * The daemon already knows what finished in four different places and has never said it in one: the
 * worklog ledger (src/worklog.ts) carries the entry a finished terminal or build wrote, a ticket that
 * reached review/done is in `tickets.flowShipped`, the terminal that did the work is a session row
 * with a worktree branch and a dollar figure on it, and a deploy is a run of a deploy-named job. This
 * reads all four for the last `days` (7 by default), folds them into ship events, groups them by LOCAL
 * day and by client, and puts the money that produced each one beside it.
 *
 * ROBERT: this is a live card — `::widget shipped::` alone on a line in a Desk reply mounts it, and it
 * is the honest answer to "what shipped today / this week". Use it in the standup instead of typing a
 * list of PR links that is stale by the time it is read: say your one line of judgement (what the week
 * amounted to, what is suspiciously quiet) and let the card carry the rows and the burn. No prompt
 * change is needed — the registry already lists it to you.
 *
 * Two rules this module will not bend:
 *
 * - **Dates are the Mac's local day.** The operator's "today" is the one on his clock, not UTC's. The
 *   worklog's own stamps are already local wall-clock (`### YYYY-MM-DD HH:MM`); everything else is an
 *   ISO instant and is bucketed through `localDay`.
 * - **A dollar figure is never invented.** `usd` is filled only when the item maps to exactly ONE
 *   cost-bearing row — a session's own `cost_usd`, or a run's. A worklog entry keeps no id of the
 *   session that wrote it, and a ticket is many runs and many terminals whose dollars are already
 *   counted under the terminal that did the work, so both are `null` (the card shows "—") unless
 *   exactly one unused cost row links to them. Double-counting the fleet's spend would be worse than
 *   an empty column.
 */
import { jobs, runs, sessions, tickets, workspaces } from "../store.js";
import { readWorklog } from "../worklog.js";
import type { Session, Ticket } from "../types.js";
import type { Widget } from "./index.js";

/** What kind of landing a row is. Anything that is not one of these is not a ship event. */
export type ShipKind = "pr" | "deploy" | "ticket" | "worktree";

export interface ShipItem {
  kind: ShipKind;
  /** One short line, in the operator's words where we have them. */
  label: string;
  /** The PR (or the tracker item) — the card opens it in a new tab. */
  url?: string;
  /** Fallback name for who did it, used when the session is gone from the Desk's state. */
  by?: string;
  /** The terminal that produced it, so the card can title it the way the rail does. */
  session_id?: string;
  at: string; // ISO instant
  usd: number | null;
}

export interface ShipClient {
  workspace_id: string;
  items: ShipItem[];
}

export interface ShipDay {
  date: string; // YYYY-MM-DD, local
  total_usd: number | null;
  count: number;
  clients: ShipClient[];
}

export interface ShippedData {
  now: string;
  days: ShipDay[];
  spark: Array<{ date: string; count: number }>;
}

const MAX_DAYS = 31;
const PER_CLIENT_CAP = 12; // one client's day is a handful of landings, not a changelog

// ───────────────────────────── local days ─────────────────────────────

/** The local calendar day of an instant — the daemon's TZ, which is the operator's clock. */
export function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight `n` days back, as the instant the window starts at. */
export function windowStart(now: Date, days: number): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - (days - 1));
  return d;
}

/** The worklog's `### YYYY-MM-DD HH:MM` stamp is local wall clock — parse it as such, never as UTC. */
export function parseWorklogStamp(at: string): Date | null {
  const m = String(at ?? "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return isNaN(d.getTime()) ? null : d;
}

// ───────────────────────────── dedupe ─────────────────────────────

/**
 * Two sources describing one PR are one landing. Normalised so `.../pull/12`, a trailing slash and a
 * `#issuecomment` anchor all collide; anything that is not a url dedupes on itself.
 */
export function prKey(url: string | null | undefined): string | null {
  const u = String(url ?? "").trim();
  if (!/^https?:\/\/\S+$/.test(u)) return null;
  return u.replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
}

const oneLine = (s: unknown, cap = 120): string =>
  String(s ?? "").replace(/\s+/g, " ").trim().slice(0, cap);

/** A deploy is a run of a job the operator named for deploying — nothing else records one (see below). */
export function isDeployJob(name: string | null | undefined): boolean {
  return /(^|[:\s_\-/])deploy/i.test(String(name ?? ""));
}

const sessionLabel = (s: Session): string =>
  oneLine(s.title || s.goal || s.spawn_goal || s.agent_name || "terminal");

const who = (s: Session): string => oneLine(s.agent_name || s.created_by || s.backend || "", 40);

const ticketLabel = (t: Ticket): string => oneLine(`${t.key} ${t.title}`);

// ───────────────────────────── the read ─────────────────────────────

export function shippedData(q: Record<string, string> = {}, now = new Date()): ShippedData {
  const days = Math.min(Math.max(Number(q.days) || 7, 1), MAX_DAYS);
  const start = windowStart(now, days);
  const startMs = start.getTime();
  const sinceIso = start.toISOString();
  const wsFilter = q.ws || null;

  const items: Array<ShipItem & { workspace_id: string }> = [];
  const seenPr = new Set<string>();
  /** Cost rows already spent on an item, so nothing is counted twice in a day's total. */
  const usedCost = new Set<string>();

  /** Adds the item unless its PR is already on the board. False = it was a duplicate, nothing shown. */
  const push = (workspace_id: string, it: ShipItem & { _pr?: string | null }): boolean => {
    const key = it._pr ?? null;
    if (key) {
      if (seenPr.has(key)) return false;
      seenPr.add(key);
    }
    delete it._pr;
    items.push({ ...it, workspace_id });
    return true;
  };

  /** A cost row is "spent" only once it is actually SHOWN — a duplicate row showed nothing. */
  const spend = (shown: boolean, key: string, usd: number | null): void => {
    if (shown && usd !== null) usedCost.add(key);
  };

  // ── terminals: the only place a landing carries its own price ────────────────────────────────
  // Highest-ranked PR source on purpose — it is the one row that knows both the url (through its
  // ticket) and what the work cost. Ended inside the window; a live terminal has not landed yet.
  const ended = sessions
    .list({ status: "ended", ...(wsFilter ? { workspace_id: wsFilter } : {}), limit: 600 })
    .filter((s) => s.workspace_id && s.ended_at && Date.parse(s.ended_at) >= startMs);
  for (const s of ended) {
    const t = s.ticket_id ? tickets.get(s.ticket_id) : undefined;
    const pr = prKey(t?.pr_url);
    const usd = typeof s.cost_usd === "number" && s.cost_usd > 0 ? s.cost_usd : null;
    if (pr) {
      const shown = push(s.workspace_id!, {
        kind: "pr",
        label: t ? ticketLabel(t) : sessionLabel(s),
        url: t!.pr_url!,
        by: who(s),
        session_id: s.id,
        at: s.ended_at!,
        usd,
        _pr: pr,
      });
      spend(shown, `session:${s.id}`, usd);
      continue;
    }
    // No PR, but it claimed a worktree and gave it back: a checkout closed is work put down.
    const branch = s.worktree_branch || s.branch;
    if (s.worktree_path || branch) {
      const shown = push(s.workspace_id!, {
        kind: "worktree",
        label: oneLine(branch ? `${branch} · ${sessionLabel(s)}` : sessionLabel(s)),
        by: who(s),
        session_id: s.id,
        at: s.ended_at!,
        usd,
      });
      spend(shown, `session:${s.id}`, usd);
    }
  }

  // ── deploys ──────────────────────────────────────────────────────────────────────────────────
  // src/self-deploy.ts keeps ONE marker in kv (`deploy.pending`) and deletes it the moment the daemon
  // comes back up on the new build, so there is no deploy history to read anywhere in the db. What is
  // dateable is a run of a job the operator named for deploying — that, and only that, lands here.
  for (const r of runs.list(undefined, 800)) {
    if (r.status !== "success" || !r.ended_at || Date.parse(r.ended_at) < startMs) continue;
    const job = jobs.get(r.job_id);
    if (!job?.workspace_id || !isDeployJob(job.name)) continue;
    if (wsFilter && job.workspace_id !== wsFilter) continue;
    const usd = typeof r.cost_usd === "number" && r.cost_usd > 0 ? r.cost_usd : null;
    const shown = push(job.workspace_id, {
      kind: "deploy",
      label: oneLine(job.description || job.name),
      at: r.ended_at,
      usd,
    });
    spend(shown, `run:${r.id}`, usd);
  }

  // ── the worklog ledger ───────────────────────────────────────────────────────────────────────
  // Every finished terminal and build wrote one entry here. Entries that carry neither a PR nor a
  // ticket are finished work, not a landing, and are left to the ledger.
  const wss = (wsFilter ? [workspaces.get(wsFilter)].filter(Boolean) : workspaces.list()) as Array<{ id: string }>;
  for (const ws of wss) {
    for (const row of readWorklog(ws.id, 200)) {
      const when = parseWorklogStamp(row.at);
      if (!when || when.getTime() < startMs || when.getTime() > now.getTime() + 60_000) continue;
      if (!row.pr && !row.ticket) continue;
      push(ws.id, {
        kind: row.pr ? "pr" : "ticket",
        label: oneLine(row.ticket ? `${row.ticket} ${row.what}` : row.what),
        url: row.pr ?? undefined,
        at: when.toISOString(),
        // The ledger keeps no id of the run or session that produced it: ambiguous, so no figure.
        usd: null,
        _pr: prKey(row.pr),
      });
    }
  }

  // ── tickets that reached review or done ──────────────────────────────────────────────────────
  for (const t of tickets.flowShipped(sinceIso, 200)) {
    if (wsFilter && t.workspace_id !== wsFilter) continue;
    const at = Date.parse(t.updated_at);
    if (!Number.isFinite(at) || at < startMs) continue;
    push(t.workspace_id, {
      kind: t.pr_url ? "pr" : "ticket",
      label: `${ticketLabel(t)} · ${t.status}`,
      url: t.pr_url ?? t.external_url ?? undefined,
      at: t.updated_at,
      usd: soleCost(t.id, usedCost),
      _pr: prKey(t.pr_url),
    });
  }

  return fold(items, now, days);
}

/**
 * A ticket's burn, but only when it is unambiguous: exactly ONE cost-bearing row (a run, or an ended
 * terminal) links to the ticket and has not already been shown against an item of its own. Two rows,
 * or a row already spent, and the answer is `null` — the card says "—" rather than a number that is
 * either half the truth or the same dollars twice.
 */
function soleCost(ticketId: string, used: Set<string>): number | null {
  const rows: Array<{ key: string; usd: number }> = [];
  for (const r of runs.listForTicket(ticketId, 50)) {
    if (typeof r.cost_usd === "number" && r.cost_usd > 0) rows.push({ key: `run:${r.id}`, usd: r.cost_usd });
  }
  for (const s of sessions.list({ ticket_id: ticketId, limit: 50 })) {
    if (typeof s.cost_usd === "number" && s.cost_usd > 0) rows.push({ key: `session:${s.id}`, usd: s.cost_usd });
  }
  if (rows.length !== 1) return null;
  if (used.has(rows[0].key)) return null;
  used.add(rows[0].key);
  return rows[0].usd;
}

/** Items → days (newest first) → clients, plus the full-window sparkline (oldest first, zeros kept). */
function fold(items: Array<ShipItem & { workspace_id: string }>, now: Date, days: number): ShippedData {
  const byDay = new Map<string, Map<string, ShipItem[]>>();
  for (const it of items) {
    const d = localDay(new Date(it.at));
    const clients = byDay.get(d) ?? new Map<string, ShipItem[]>();
    byDay.set(d, clients);
    const list = clients.get(it.workspace_id) ?? [];
    clients.set(it.workspace_id, list);
    const { workspace_id, ...rest } = it;
    list.push(rest);
  }

  const out: ShipDay[] = [];
  for (const [date, clients] of byDay) {
    let total: number | null = null;
    let count = 0;
    const cs: ShipClient[] = [];
    for (const [workspace_id, list] of clients) {
      list.sort((a, b) => b.at.localeCompare(a.at));
      const kept = list.slice(0, PER_CLIENT_CAP);
      count += kept.length;
      for (const it of kept) if (it.usd !== null) total = (total ?? 0) + it.usd;
      cs.push({ workspace_id, items: kept });
    }
    cs.sort((a, b) => b.items.length - a.items.length || a.workspace_id.localeCompare(b.workspace_id));
    out.push({ date, total_usd: total === null ? null : round2(total), count, clients: cs });
  }
  out.sort((a, b) => b.date.localeCompare(a.date));

  const spark: Array<{ date: string; count: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setDate(d.getDate() - i);
    const key = localDay(d);
    spark.push({ date: key, count: out.find((x) => x.date === key)?.count ?? 0 });
  }

  return { now: now.toISOString(), days: out, spark };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

const shipped: Widget = {
  name: "shipped",
  title: "Shipped",
  // What lands changes when a terminal closes, a build ends, a ticket moves, a PR merges, or the
  // worklog note is appended to (src/notes.ts publishes note.updated on every append).
  topics: ["session.ended", "run.ended", "ticket.updated", "ticket.delivered", "note.updated"],
  data: (q) => shippedData(q),
};

export default shipped;
