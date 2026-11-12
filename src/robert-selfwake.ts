/**
 * Robert's self-wake — a look at a QUIET workspace, only when something there changed.
 *
 * robert-drive.ts wakes him when a terminal stops; robert-sweep.ts looks over a workspace while its
 * terminals work. With nothing running he did nothing at all, so every morning the operator typed
 * the next thing himself: "merge #N", "confirm X runs", "what's waiting on me". The proactive agents
 * he pointed at (OpenClaw, Dots, Muse, Hermes) share one shape, and it is the one copied here:
 *
 *  - **Self-wake with a quiet path.** A periodic look whose default answer is silence (QUIET, acked
 *    by wake-queue.ts and never posted). The fleet heartbeat that was switched off posted proposals
 *    every 30 minutes; this one either starts work or says nothing.
 *  - **No model unless something changed** (Hermes' monitor mode). A fingerprint of cheap store facts
 *    — PRs and their CI, terminals left waiting on the operator, red jobs, unanswered asks, inbox rows
 *    nobody opened, the brief's Next — is compared with the last look. Same facts → no turn at all.
 *  - **Output is a terminal, never a message.** He reads terminals only. Robert's one move is to
 *    open ONE terminal through POST /robert/proactive, which the daemon caps (1 per workspace per
 *    hour, CHRONOS_PROACTIVE_PER_DAY in all) and labels `created_by: proactive` so it can be scored.
 *  - **Active hours, live workspaces only.** Outside `robert.proactive_hours` or in a workspace
 *    nobody has touched for a week, nothing is computed.
 *
 * What he may start is bounded by the workspace's Standing orders (briefs.ts): the terminal does the
 * work up to the first thing they say to ask about, and asks there.
 */
import { randomUUID } from "node:crypto";
import { CONFIG } from "./config.js";
import { briefNote, nextItemText, normalizeBrief } from "./briefs.js";
import { jobHealth } from "./job-check.js";
import { isStopped } from "./robert-drive.js";
import { PROACTIVE_AUTO_BY } from "./inbox-guard.js";
import { proactiveAllowed } from "./proactive-score.js";
import { assistantName, setting, settingOn } from "./settings.js";
import { asks, db, inbox, kv, sessionPrs, sessions, workspaces } from "./store.js";
import { statusOf, type TermStatus } from "./term-status.js";
import { enqueueWake, QUIET_REPLY, SWEEP_KEY } from "./wake-queue.js";
import type { Workspace } from "./types.js";

const HOUR = 60 * 60_000;
export const PROACTIVE_BY = PROACTIVE_AUTO_BY;
/** The wake key. Under SWEEP_KEY so a QUIET reply is acked silently like a presence sweep's. */
export const SELFWAKE_KEY = `${SWEEP_KEY}idle:`;
/** A terminal has waited on the operator this long before it counts as "left waiting". */
export const WAITING_MS = 2 * HOUR;
/** An ask to the operator unanswered this long is news. */
export const ASK_STALE_MS = 4 * HOUR;
/** A workspace with no terminal opened in this long is dormant: not looked at. */
export const DORMANT_MS = 7 * 24 * HOUR;
export const PER_WS_PER_HOUR = 1;
export const perDay = () => Math.max(0, Number(process.env.CHRONOS_PROACTIVE_PER_DAY ?? 6));

const sigKey = (wsId: string) => `selfwake.sig.${wsId}`;
const lastKey = (wsId: string) => `selfwake.at.${wsId}`;

/** "09-21" → is `hour` inside it? Overnight ("22-06") wraps. Bad input = always. */
export function inHours(spec: string, hour: number): boolean {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(spec || "");
  if (!m) return true;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === b) return true;
  return a < b ? hour >= a && hour < b : hour >= a || hour < b;
}

/** The hour in the operator's zone (the same zone the Slack triage hours use). */
export function localHour(nowMs: number, tz = CONFIG.slackTriageTz): number {
  const h = new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(new Date(nowMs));
  return Number(h) % 24;
}

export type Probe = (id: string) => TermStatus | null;
let probe: Probe = (id) => statusOf(id);
/** Tests only. */
export function setSelfwakeProbe(fn: Probe | null): void {
  probe = fn ?? ((id) => statusOf(id));
}

/**
 * The facts a look is about, one line each, stable across calls so a set difference is "what
 * changed". Store reads only — no gh, no model.
 */
export function signals(ws: Pick<Workspace, "id">, nowMs = Date.now()): string[] {
  const out: string[] = [];
  // A green PR is the ship loop's (ship-loop.ts) and a pending one is nobody's yet: only a PR that
  // went red or got changes requested is news a fresh terminal could act on.
  for (const r of sessionPrs.openIn(ws.id, 30)) {
    const changes = String(r.review_decision ?? "").toUpperCase() === "CHANGES_REQUESTED";
    if (r.ci_state !== "failing" && !changes) continue;
    out.push(`pr ${r.url}${r.ci_state === "failing" ? " CI failing" : ""}${changes ? " changes requested" : ""}`);
  }
  for (const s of sessions.list({ workspace_id: ws.id, status: "live", limit: 200 })) {
    const st = probe(s.id);
    if (!st || !isStopped(st) || nowMs - st.since < WAITING_MS) continue;
    out.push(`waiting ${s.id.slice(0, 8)} ${st.phase}: ${(s.goal ?? s.spawn_goal ?? s.title ?? "").replace(/\s+/g, " ").slice(0, 100)}`);
  }
  try {
    for (const r of jobHealth(ws.id, { now: new Date(nowMs) }).red) out.push(`red job ${r.job_name}: ${r.kind}`);
  } catch { /* a health read that throws is not a signal */ }
  for (const a of asks.list({ status: "open", workspace_id: ws.id })) {
    if (a.route === "robert" || a.route === "lead") continue;
    if (nowMs - Date.parse(a.created_at) < ASK_STALE_MS) continue;
    out.push(`ask ${a.id.slice(0, 8)} unanswered: ${String(a.question ?? "").replace(/\s+/g, " ").slice(0, 100)}`);
  }
  for (const i of inbox.list({ workspace_id: ws.id, open: true, limit: 50 })) {
    if (i.dispatched_session) continue;
    out.push(`inbox ${i.id.slice(0, 8)}: ${i.title.replace(/\s+/g, " ").slice(0, 100)}`);
  }
  const brief = briefNote(ws.id, false);
  if (brief) {
    const body = normalizeBrief(brief.body);
    const at = body.search(/^## Next\s*$/m);
    if (at >= 0) {
      const section = body.slice(at).split("\n").slice(1);
      for (const l of section) {
        if (/^##\s/.test(l)) break;
        if (!/^\s*[-*]\s*\[\s\]/.test(l) && !/^\s*[-*]\s+(?!\[)/.test(l)) continue;
        const t = nextItemText(l).slice(0, 140);
        if (t) out.push(`next: ${t}`);
      }
    }
  }
  return [...new Set(out)].sort();
}

/** Lines in `now` that were not in `before` — resolutions are not a reason to wake. */
export function changed(before: string[], now: string[]): string[] {
  const was = new Set(before);
  return now.filter((l) => !was.has(l));
}

/**
 * A self-wake's one-time ticket. The terminal it may open is bound to the workspace the wake was
 * for: Robert holds the admin token, and without this a look at one client could open a terminal —
 * carrying that client's context — in another (the wall). Single use, expires with the look.
 */
const TICKET_TTL_MS = 2 * HOUR;
const ticketKey = (t: string) => `selfwake.ticket.${t}`;
export function issueTicket(wsId: string, nowMs = Date.now()): string {
  const t = randomUUID().replace(/-/g, "").slice(0, 16);
  kv.set(ticketKey(t), JSON.stringify({ ws: wsId, at: nowMs }));
  return t;
}
/** The workspace a ticket was issued for, consuming it; null when unknown, used or expired. */
export function redeemTicket(t: string | null | undefined, nowMs = Date.now()): string | null {
  if (!t || !/^[a-f0-9]{16}$/.test(t)) return null;
  const raw = kv.get(ticketKey(t));
  if (!raw) return null;
  kv.del(ticketKey(t));
  try {
    const v = JSON.parse(raw) as { ws: string; at: number };
    return nowMs - v.at <= TICKET_TTL_MS ? v.ws : null;
  } catch {
    return null;
  }
}

export function selfwakeSay(ws: Pick<Workspace, "id" | "name">, fresh: string[], total: number, ticket = "<ticket>"): string {
  const shown = fresh.slice(0, 15);
  return (
    `SELF-WAKE · ${ws.name} — nothing is working here, and since your last look this is new ` +
    `(${fresh.length} of ${total} open facts):\n${shown.map((l) => `- ${l}`).join("\n")}` +
    (fresh.length > shown.length ? `\n- …and ${fresh.length - shown.length} more` : "") +
    `\n\nNobody asked you. Decide ONE move, or none — this workspace's brief (goals, Standing orders, Next) is above:\n` +
    `- START: one change above (or one Next item) has a concrete next step the operator would want started without ` +
    `being asked → open ONE terminal: \`curl -s -X POST http://localhost:${CONFIG.port}/api/robert/proactive ` +
    `-H "x-mc-admin: $CHRONOS_ADMIN" -H "content-type: application/json" -d '{"workspace_id":"${ws.id}","ticket":"${ticket}",` +
    `"goal":"<one finish line>","description":"<why now, where to look, which Standing orders apply>"}'\`. ` +
    `Its goal does the work up to the first thing the Standing orders say to ask about, and asks him in that ` +
    `terminal. Drafts, never sends. The daemon refuses past its caps; a refusal is final for this look.\n` +
    `- NUDGE: a terminal left waiting is waiting on something you may answer under the drive rules → ` +
    `\`mc session send <id> "<next step>"\`.\n` +
    `- QUIET: nothing above clearly moves a goal forward, it is the operator's call with nothing to prepare, a ` +
    `terminal already holds it, or a Standing order says not to → reply exactly ${QUIET_REPLY}.\n` +
    `Never message the operator, never merge, deploy, send or post. After acting, reply ${QUIET_REPLY} too: ` +
    `the terminal is the report.`
  );
}

/** Proactive terminals opened (created_by proactive) in a workspace — or everywhere — since `sinceMs`. */
export function proactiveOpened(sinceMs: number, wsId?: string): number {
  const since = new Date(sinceMs).toISOString();
  const row = (wsId
    ? db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE created_by = ? AND workspace_id = ? AND created_at >= ?").get(PROACTIVE_BY, wsId, since)
    : db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE created_by = ? AND created_at >= ?").get(PROACTIVE_BY, since)) as { n: number };
  return row.n;
}

/** Why the daemon would refuse a proactive terminal right now (null = it may open one). */
export function capRefusal(wsId: string, nowMs = Date.now()): string | null {
  if (proactiveOpened(nowMs - HOUR, wsId) >= PER_WS_PER_HOUR) return "this workspace already got a proactive terminal in the last hour";
  if (proactiveOpened(nowMs - 24 * HOUR) >= perDay()) return `${perDay()} proactive terminals in the last 24h — the daily cap`;
  return null;
}

function dormant(wsId: string, nowMs: number): boolean {
  const row = db.prepare("SELECT MAX(created_at) AS at FROM sessions WHERE workspace_id = ?").get(wsId) as { at: string | null };
  return !row.at || nowMs - Date.parse(row.at) > DORMANT_MS;
}

/**
 * One look at a workspace with nothing working. Queues a wake only when a fact is new since the last
 * look, the hour is right, the look is due and the caps leave room for a terminal. Returns why not,
 * or null when a wake was queued.
 */
export function selfwakeOnce(ws: Workspace, nowMs = Date.now()): string | null {
  if (ws.archived) return "archived";
  if (!settingOn("robert.enabled", ws.id) || !settingOn("robert.proactive", ws.id)) return "off";
  if (!inHours(String(setting("robert.proactive_hours", ws.id) ?? ""), localHour(nowMs))) return "outside hours";
  const every = Math.max(5, Number(setting("robert.proactive_every_min", ws.id) ?? 30)) * 60_000;
  const last = Number(kv.get(lastKey(ws.id)) ?? 0);
  if (nowMs - last < every) return "not due";
  if (dormant(ws.id, nowMs)) return "dormant";
  if (capRefusal(ws.id, nowMs)) return "capped";
  // He has been ignoring the terminals this opens here (proactive-score.ts): no turn spent on a look
  // whose one move would be refused anyway.
  if (!proactiveAllowed(PROACTIVE_BY, ws.id, nowMs)) return "backed off";

  const now = signals(ws, nowMs);
  let before: string[] = [];
  try { before = JSON.parse(kv.get(sigKey(ws.id)) ?? "[]"); } catch { before = []; }
  kv.set(lastKey(ws.id), String(nowMs));
  kv.set(sigKey(ws.id), JSON.stringify(now));
  const fresh = changed(before, now);
  if (!fresh.length) return "nothing new";
  enqueueWake({
    topic: "robert.selfwake",
    key: `${SELFWAKE_KEY}${ws.id}`,
    subject: null,
    workspace_id: ws.id,
    payload: { say: selfwakeSay(ws, fresh, now.length, issueTicket(ws.id, nowMs)), fresh: fresh.length },
  });
  return null;
}

// ──────────────────────────── the one move: open a terminal ────────────────────────────

export type ProactiveOpen = { workspace_id: string; ticket?: string | null; goal: string; description?: string | null };
export type Opener = (opts: Parameters<typeof import("./terminal.js").openSession>[0]) => Promise<{ id: string }>;
/** A gate from outside (the engagement score) — true = this kind may open here now. */
export type Allowed = (kind: string, wsId: string, nowMs: number) => boolean;

/**
 * POST /robert/proactive. The caps live here, not in Robert's prompt: a model that ignores "one
 * terminal" still gets one. Returns the new terminal, or why not (status for the route).
 */
export async function openProactive(
  req: ProactiveOpen,
  opener: Opener,
  opts: { nowMs?: number; allowed?: Allowed } = {},
): Promise<{ ok: true; id: string } | { ok: false; status: number; error: string }> {
  const nowMs = opts.nowMs ?? Date.now();
  const ws = workspaces.get(req.workspace_id) ?? workspaces.list().find((w) => w.slug === req.workspace_id);
  if (!ws || ws.archived) return { ok: false, status: 404, error: "workspace not found" };
  // Only the look that was FOR this workspace may open here (issueTicket): never across the wall.
  const ticketWs = redeemTicket(req.ticket, nowMs);
  if (ticketWs !== ws.id) return { ok: false, status: 403, error: "no valid self-wake ticket for this workspace" };
  if (!settingOn("robert.proactive", ws.id)) return { ok: false, status: 409, error: "proactive work is off for this workspace" };
  const cap = capRefusal(ws.id, nowMs);
  if (cap) return { ok: false, status: 429, error: cap };
  if (opts.allowed && !opts.allowed(PROACTIVE_BY, ws.id, nowMs)) {
    return { ok: false, status: 429, error: "the operator has been ignoring proactive terminals here — backed off" };
  }
  const goal = req.goal.replace(/\s+/g, " ").trim();
  const s = await opener({
    workspace_id: ws.id,
    goal,
    goal_source: "human",
    description:
      `${assistantName()} opened this on his own (self-wake): nobody asked for it yet.\n\n${(req.description ?? "").trim()}\n\n` +
      `Work toward the goal up to the first thing this workspace's Standing orders say to ask about, then ask the ` +
      `operator HERE (\`mc ask "…" --options "sí,no"\`) and stop. If the goal turns out to be already done, or not ` +
      `worth doing, say so in one line and run \`mc goal done\`.`,
    backend: ws.default_backend ?? undefined,
    created_by: PROACTIVE_BY,
    role: "human",
    // No cwd: openSession lands it in the workspace's own directory, like every other daemon opener.
  } as any);
  return { ok: true, id: s.id };
}
