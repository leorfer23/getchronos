/**
 * Standing watches — "Robert, check that terminal every 10 minutes."
 *
 * The Desk wall answers "which of these needs me right now" only while the operator is LOOKING at it. A
 * watch is the same question asked on a clock, for one terminal, with the answer delivered to his
 * phone: every `watch_every_min` minutes Robert re-reads that terminal's Focus feed since his last
 * look, and sends ONE Telegram line saying what moved and whether it needs him.
 *
 * Deliberately NOT the fleet heartbeat (heartbeat.ts): that one is proactive and generates work
 * across every workspace on a fixed schedule. This is narrow and operator-armed — one terminal, an
 * interval the operator names, and it dies with the terminal. Every report is sent; a watch that goes quiet
 * because "nothing changed" is a watch you stop trusting, and the whole point is that he asked to
 * be told.
 */
import { bus } from "./bus.js";
import { getAgent } from "./agent-lifecycle.js";
import { OP_PREFIX } from "./operational-prefix.js";
import { sessionUsage } from "./session-usage.js";
import { focusEvents, isLive, sessionActivity } from "./terminal.js";
import { sessionGoalReached } from "./term-status.js";
import { sessions, workspaces } from "./store.js";
import type { Session } from "./types.js";
import { sweepTriageDeadline } from "./ask-robert.js";
import { sweepLeadAsks } from "./lead-asks.js";
import { sweepTerminalPrompts } from "./terminal-prompts.js";
import { askManagerWeb } from "./telegram/agent.js";
import { postRobertToDesk } from "./robert-desk.js";
import type { RobertStep } from "./robert-steps.js";
import { esc, notify } from "./telegram/api.js";

/** Floor on the interval: below a minute a "check" is just the same screen twice, at Opus prices. */
export const WATCH_MIN_MINUTES = 1;
export const WATCH_MAX_MINUTES = 24 * 60;
/** How often the sweeper looks for due watches. Sets the granularity of every interval. */
const SWEEP_MS = 30_000;

/**
 * "10" · "10m" · "1h" · "90 min" → minutes. Null when it isn't an interval at all, so a caller can
 * say so rather than silently watching every 10 minutes because someone typed "ten".
 */
export function parseEvery(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === "number") return Number.isFinite(input) ? clampEvery(input) : null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?\s*$/i.exec(input);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "m").toLowerCase();
  return clampEvery(unit.startsWith("h") ? n * 60 : n);
}

function clampEvery(n: number): number {
  return Math.max(WATCH_MIN_MINUTES, Math.min(WATCH_MAX_MINUTES, Math.round(n)));
}

/**
 * Is this watch due? Pure so the cadence is testable without a daemon or a clock.
 *
 * A missed window does not stack: a daemon that was down for an hour sends ONE report when it comes
 * back, not six. `watch_last_at` is set when the watch is armed, so the first report lands a full
 * interval later rather than on the next sweep.
 */
export function watchDue(
  s: Pick<Session, "watch_every_min" | "watch_last_at">,
  nowMs = Date.now(),
): boolean {
  if (!s.watch_every_min) return false;
  const last = s.watch_last_at ? Date.parse(s.watch_last_at) : NaN;
  if (Number.isNaN(last)) return true; // never reported (or a corrupt stamp) — report now
  return nowMs - last >= s.watch_every_min * 60_000;
}

export function dueWatches(rows: Session[], nowMs = Date.now()): Session[] {
  return rows.filter((s) => watchDue(s, nowMs));
}

const shortId = (id: string) => id.slice(0, 8);

/** Focus lines this terminal produced since Robert last looked — the actual subject of a report. */
export function feedSince(
  feed: { kind: string; text: string; ts?: number | string | null }[],
  sinceMs: number | null,
  cap = 40,
): { kind: string; text: string }[] {
  const fresh =
    sinceMs == null
      ? feed
      : feed.filter((e) => {
          const t = typeof e.ts === "string" ? Date.parse(e.ts) : e.ts;
          return typeof t === "number" && !Number.isNaN(t) ? t >= sinceMs : true;
        });
  // A terminal that said nothing since the last look is itself the news — fall back to the tail so
  // the report can say "still on X, silent for 12 minutes" instead of having nothing to show.
  return (fresh.length ? fresh : feed).slice(-cap).map((e) => ({ kind: e.kind, text: e.text.slice(0, 400) }));
}

/** One terminal, in the words Robert needs to judge it. */
export function watchDigest(s: Session): {
  id: string;
  workspace: string | null;
  goal: string | null;
  kind: string | null;
  state: string;
  quiet_for_min: number;
  since: string | null;
  usage: ReturnType<typeof sessionUsage>;
  every_min: number;
  understanding: string | null;
  says: { kind: string; text: string }[];
  note: string | null;
} {
  const act = sessionActivity(s.id);
  const agent = getAgent(s.id);
  const state = sessionGoalReached(s, act)
    ? "done"
    : !act.live
      ? "ended"
      : agent?.state === "blocked"
        ? "blocked"
        : act.quiet
          ? "waiting"
          : "working";
  let feed: any[] = [];
  try {
    feed = focusEvents(s.id) as any[];
  } catch {
    feed = [];
  }
  const sinceMs = s.watch_last_at ? Date.parse(s.watch_last_at) : null;
  return {
    id: s.id,
    workspace: s.workspace_id ? (workspaces.get(s.workspace_id)?.name ?? null) : null,
    goal: s.goal ?? s.spawn_goal ?? null,
    kind: s.goal_kind ?? null,
    state,
    quiet_for_min: act.quiet && act.last_out ? Math.round((Date.now() - act.last_out) / 60_000) : 0,
    since: s.watch_last_at,
    usage: sessionUsage(s.id),
    every_min: s.watch_every_min ?? 0,
    understanding: [...feed].reverse().find((e) => e.kind === "understanding")?.text?.slice(0, 400) ?? null,
    says: feedSince(feed, Number.isNaN(Number(sinceMs)) ? null : sinceMs),
    note: s.watch_note ?? null,
  };
}

/**
 * What Robert is asked, every interval. Pure so the wording is reviewable in a test rather than
 * only observable by waiting ten minutes and reading a phone.
 *
 * Two rules do the heavy lifting: report on the WINDOW (what changed since he last looked, not the
 * terminal's whole life), and keep his hands still unless the standing order said otherwise. A
 * watch is an instruction to WATCH — a scheduled check that quietly starts typing into a terminal
 * every ten minutes is a robot with a keyboard, not an overseer.
 */
export function watchPrompt(d: ReturnType<typeof watchDigest>, final = false): string {
  const said = d.says.length
    ? d.says.map((e) => `[${e.kind}] ${e.text}`).join("\n")
    : "(nothing — it has produced no plain-English output in this window)";
  const window = d.since ? `since your last look at ${d.since}` : "since it started";
  const head = final
    ? `${OP_PREFIX}WATCH ENDING. The terminal you were watching has finished (state: ${d.state}). The operator did NOT message ` +
      `you. Write the CLOSING report: what it ended up doing, whether it reached its goal, and anything left over ` +
      `for him. This is the last thing he hears about this terminal, so it is a verdict, not a status line.`
    : `${OP_PREFIX}SCHEDULED WATCH. The operator asked you to check ONE terminal every ${d.every_min} minutes and report. ` +
      `He did NOT message you; nothing here is a question to answer. Report what changed ${window}.`;
  return (
    `${head}\n\n` +
    `TERMINAL \`${shortId(d.id)}\` · ${d.workspace ?? "unscoped"} · state: ${d.state}` +
    (d.quiet_for_min ? ` · silent ${d.quiet_for_min}m` : "") +
    `\nGoal: ${d.goal ?? "(none set)"}${d.kind ? ` · shape: ${d.kind}` : ""}` +
    (d.understanding ? `\nIts own understanding: ${d.understanding}` : "") +
    (d.usage
      ? `\nSpent so far: ${d.usage.turns ?? 0} turns · ${d.usage.cost_usd != null ? `$${d.usage.cost_usd.toFixed(2)}` : "—"}` +
        `${d.usage.context_tokens ? ` · ${Math.round(d.usage.context_tokens / 1000)}k context` : ""}`
      : "") +
    (d.note ? `\nLEO'S STANDING ORDER — what he asked you to watch for: "${d.note}"` : "") +
    `\n\nWHAT IT SAID ${window.toUpperCase()}:\n${said}\n\n` +
    `Reply with the message that goes to his phone. Rules:\n` +
    `- 1–3 SHORT lines. Lead with the one that matters. No preamble, no "here is your update".\n` +
    `- Report the WINDOW, not the terminal's whole history — he has had every earlier report.\n` +
    `- Say plainly if it is stuck, waiting on him, going somewhere he wouldn't want, or burning turns ` +
    `without progress — and what you recommend. If it is simply working fine, say so in ONE line.\n` +
    `- Do NOT type into the terminal, approve anything, or take any action from this check. You are ` +
    `watching. If it needs a hand, say what you'd do and let him say go` +
    (d.note ? `, unless his standing order above already told you to do it.` : `.`) +
    `\n- Plain text. No markdown headings, no code fences.`
  );
}

/** The Telegram message a report lands in: who this is about, then Robert's words. */
export function watchMessage(d: ReturnType<typeof watchDigest>, body: string, final: boolean): string {
  const dot =
    d.state === "blocked" ? "🔴" : d.state === "waiting" ? "🟠" : d.state === "done" ? "✅" : d.state === "ended" ? "⚫️" : "🟢";
  const title = (d.goal ?? "terminal").slice(0, 60);
  const head = final
    ? `👁 <b>Watch ended</b> ${dot} ${esc(title)}`
    : `👁 <b>${esc(title)}</b> ${dot}${d.quiet_for_min ? ` · silent ${d.quiet_for_min}m` : ""}`;
  const foot = final
    ? `<code>mc session reopen ${shortId(d.id)}</code>`
    : `<code>mc session focus ${shortId(d.id)}</code> · <code>mc desk unwatch ${shortId(d.id)}</code>`;
  return `${head}\n${esc(body)}\n${foot}`;
}

/** Terminals Robert is reading right now — the Desk pulses their 👁 while a check is in flight. */
const looking = new Set<string>();
export const isWatchLooking = (id: string): boolean => looking.has(id);

/**
 * What the Desk shows about a watch: the order, when he looks next, and the last thing he said. The
 * last report outlives the watch so a terminal that finished still shows Robert's closing verdict.
 */
export function watchView(s: Session, nowMs = Date.now()) {
  const last = sessions.watchReports(s.id, 1)[0] ?? null;
  if (!s.watch_every_min && !last) return null;
  const lastMs = s.watch_last_at ? Date.parse(s.watch_last_at) : NaN;
  return {
    active: !!s.watch_every_min,
    every_min: s.watch_every_min,
    note: s.watch_note,
    by: s.watch_by,
    started: s.watch_started_at,
    next_due:
      s.watch_every_min && !Number.isNaN(lastMs) ? new Date(Math.max(nowMs, lastMs + s.watch_every_min * 60_000)).toISOString() : null,
    looking: looking.has(s.id),
    last,
  };
}

/** One check: look, ask Robert, send it. `final` also lifts the watch. */
export async function runWatch(s: Session, final = false): Promise<void> {
  const d = watchDigest(s);
  // Stamp BEFORE the LLM call: a slow or failed turn must not let the next sweep fire a second
  // check on top of it, and a watch that errors should wait its interval like any other.
  sessions.markWatched(s.id);
  looking.add(s.id);
  bus.publish({ topic: "session.updated", session_id: s.id });
  let body = "";
  let failed = false;
  let steps: RobertStep[] = [];
  let turn: string | undefined;
  try {
    // Model is the Desk pick (getWebModel inside askManagerWeb) — same as a typed chat turn.
    const { reply, steps: st, turn: t } = await askManagerWeb(watchPrompt(d, final), undefined, s.workspace_id ?? null, {
      label: "watch",
    });
    body = (reply || "").trim();
    steps = st;
    turn = t;
  } catch (e: any) {
    console.warn("[desk-watch] robert turn failed", e?.message ?? e);
    // Never swallow a watch: he asked to hear every interval, so a failed turn reports the raw state
    // rather than nothing. Silence would read as "all fine".
    body = `(couldn't reach Robert for this check) state ${d.state}${d.quiet_for_min ? `, silent ${d.quiet_for_min}m` : ""}.`;
    failed = true;
  } finally {
    looking.delete(s.id);
  }
  if (!body) {
    body = `(Robert had nothing to say) state ${d.state}.`;
    failed = true;
  }
  sessions.addWatchReport(s.id, { state: d.state, body, final, failed });
  postRobertToDesk({
    body: `👁 **${final ? "Watch ended" : "Watch"} · ${(d.goal ?? "terminal").slice(0, 60)}** (${shortId(s.id)})\n${body}`,
    ws: s.workspace_id ?? null,
    steps,
    turn,
  });
  if (final) sessions.setWatch(s.id, { every_min: null });
  bus.publish({ topic: "session.updated", session_id: s.id });
  await notify(watchMessage(d, body, final)).catch((e) => console.error("[desk-watch] notify failed", e));
}

let sweeping = false;

/** One pass: fire every due watch, and close out watches whose terminal is gone. */
export async function sweepWatches(nowMs = Date.now()): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    // Same clock, different promise: an ask Robert never called is the operator's after the deadline. Runs
    // first, because a blocked terminal waiting on a question outranks a status report about one.
    await sweepTriageDeadline(nowMs).catch((e) => console.warn("[desk-watch] triage sweep", e?.message ?? e));
    // And the same clock again for the questions a worker put to its own Lead: one the Lead never
    // answered becomes Robert's, exactly as one Robert never answered becomes the operator's.
    await sweepLeadAsks(nowMs).catch((e) => console.warn("[desk-watch] lead ask sweep", e?.message ?? e));
    // Same promise for the questions that never became asks: a prompt Robert answered has to be
    // CONFIRMED landed, and one he never touched becomes the operator's card (src/terminal-prompts.ts).
    await sweepTerminalPrompts(nowMs).catch((e) => console.warn("[desk-watch] prompt sweep", e?.message ?? e));
    for (const s of sessions.watched()) {
      // A terminal that died or was ticked off gets ONE closing report, then the watch lifts itself.
      // Leaving it armed would report on a corpse every ten minutes until someone noticed.
      // "Ticked off" only counts while the tick still stands: a terminal the operator gave more
      // work to after its goal is exactly the one the watch should keep watching.
      const over = s.status !== "live" || !isLive(s.id) || sessionGoalReached(s, sessionActivity(s.id));
      if (!over && !watchDue(s, nowMs)) continue;
      try {
        await runWatch(s, over);
      } catch (e: any) {
        console.warn(`[desk-watch] watch ${shortId(s.id)} failed`, e?.message ?? e);
      }
    }
  } finally {
    sweeping = false;
  }
}

export function startDeskWatch(): void {
  const tick = () => void sweepWatches().catch((e) => console.error("[desk-watch]", e));
  setInterval(tick, SWEEP_MS).unref?.();
  setTimeout(tick, 20_000).unref?.();
  console.log(`[desk-watch] standing watches swept every ${SWEEP_MS / 1000}s`);
}
