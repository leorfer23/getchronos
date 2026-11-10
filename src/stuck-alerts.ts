/**
 * Stuck work → the operator hears about it AT ONCE, and ONCE.
 *
 * He runs the fleet by voice through Robert, with no keyboard and no screen. A terminal that waits on
 * him and that nobody tells him about is the failure this exists to prevent; an alert storm he learns
 * to ignore is the other one (one month of unprompted chat was 1,723 messages nobody read, and a
 * clock-driven heartbeat that spoke ~30 times a day was switched off for good). So:
 *
 *  - **Event-driven, built on the ONE status** (term-status.ts `session.status`), plus the events that
 *    already say something is over: terminal failover giving up, host failover unable to move work,
 *    a job's last attempt failing, the stall supervisor finding no sign of life. Nothing here speaks on
 *    a clock: the 5s tick only acts on episodes already due, and is silent when nothing is stuck.
 *  - **Robert first, briefly**, on what agents/_blocks/terminal-drive.md lets him handle (a question in
 *    scope, a declared block). His own wake (robert-drive.ts) is reused, never duplicated: the alert
 *    waits for it, fires the moment it is clear he was not woken or already looked and it is still
 *    stuck, and never later than his chance window.
 *  - **One alert per episode, durably** (src/store/alerts.ts): the row is written before anything is
 *    sent; a restart resumes its ladder instead of repeating it. A flicker of the same question is the
 *    same episode. Past `alerts.per_hour` everything else that hour is ONE summary, never dropped.
 *  - **The ladder**: a live voice call speaks it (a page that confirms within seconds) → else a push
 *    to his phone, whose tap lands on the terminal → if no phone is subscribed, or nothing was
 *    acknowledged in time, Telegram. Acknowledged = he opened it, answered the terminal, replied on the
 *    call, or tapped "got it". Every rung and window is a ⚙ Settings → Alerts knob.
 *  - **It cannot fail silently**: checkAlertCoverage (run from the supervision guard, on its own
 *    clock) looks for anything stuck past its window with no row, raises it, and counts the miss.
 *
 * The words are built here, without a model (src/alert-text.ts). Only the operator's own devices get
 * them: his call, his phone, his Telegram. Nothing leaves for anybody else, and a Desk locked to one
 * client for a screen share is never handed another client's alert (voice-presence.ts, desk-scope.js).
 */
import { bus, type BusEvent } from "./bus.js";
import { CONFIG } from "./config.js";
import { asks, db, jobs, kv, runs, sessions, workspaces, LOCAL_HOST_ID } from "./store.js";
import { alerts, type AlertChannel, type AlertKind, type AlertRow, type AlertRung } from "./store/alerts.js";
import type { Job, Run, Session } from "./types.js";
import { signalsOf, statusOf, type Phase, type TermStatus } from "./term-status.js";
import { driveEnabled, graceMs, leadGraceMs, operatorOwns, resolveLead, watched } from "./robert-drive.js";
import { detectWall, failoverOwns, terminalFailoverEnabled, type Wall } from "./terminal-failover.js";
import { sessionPrompt, sessionScreen } from "./terminal.js";
import type { DeskPrompt } from "./desk-prompt.js";
import { isShipTerminal } from "./ship-guard.js";
import { getAgent } from "./agent-lifecycle.js";
import { holderAsks, isOperatorsAsk } from "./robert-asks.js";
import { setting, settingOn } from "./settings.js";
import { actionsFor, broadcast, pushSubs, type PushAction, type PushPayload } from "./push.js";
import { esc, getAllowedChat, send as telegramSend, TOKEN as TELEGRAM_TOKEN } from "./telegram/api.js";
import { kb, type Btn } from "./telegram/keyboards.js";
import { alertText, alertTitle, resetsOf, type AlertLang, type TextInput } from "./alert-text.js";
import { lastVoiceLang, voiceCalls, voiceFor } from "./voice-presence.js";
import { baseJobName, isInternalJob } from "./job-name.js";
import { AUTH_ERR_RE } from "./runner.js";
import { hostLabel, hostOfflineSince } from "./host-failover.js";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

// ─────────────────────────────── the numbers (each one argued) ───────────────────────────────

/**
 * A question or block that is his from the start (an escalated question, a Ship terminal, a daemon
 * block, Robert switched off): told this soon. Long enough to absorb a status flicker — grok's
 * permission gate clears on its very next hook, a TUI repaint flips quiet → working → quiet inside a
 * second or two — and short enough to be "at once" to a person.
 */
export const OPERATOR_GRACE_MS = 10 * SEC;
/**
 * After Robert's own grace (robert-drive graceMs) the wake row is written synchronously by his timer.
 * 15s past that covers timer jitter and the 250ms status debounce; no row by then means he was not
 * woken (switched off, over his cap, a terminal the operator owns, a stop he was already told about)
 * — so the operator is told now rather than after a chance Robert will never take.
 */
export const WAKE_SETTLE_MS = 15 * SEC;
/**
 * Robert's turn on it is over (his wake row acked) and it is still stuck: he looked and handed it up,
 * or could not. 15s lets his keystrokes land (sendInput writes Enter 200ms after the text) and the
 * next status say so, so an answer he did give is never raced.
 */
export const HANDOFF_SETTLE_MS = 15 * SEC;
/**
 * terminal-failover acts at the quiet flip; the only waits it has are the operator-typing window
 * (20s) and the next frame after a model swap. A wall it still owns five minutes later means it
 * stopped acting (busy, stale, a bug) — tell him. A failover that GIVES UP is told at once instead.
 */
export const FAILOVER_SAFETY_MS = 5 * MIN;
/**
 * Host failover moves a gone computer's terminals after CONFIG.hostFailoverGraceMin — the host fences
 * (freezes) its own work just before that, so that is when the work actually stops. A move that fails
 * is told at once (its "stuck" event); this is the net for one that neither moved nor failed.
 */
export const HOST_FAILOVER_SAFETY_MS = 5 * MIN;
/** The same words again within this long after the episode closed: a flicker, not news. */
export const REOPEN_MS = 2 * MIN;
/** The first capped alert waits this long for the rest of its burst, so a summary lists them all. */
export const SUMMARY_DEBOUNCE_MS = 60 * SEC;
/** The self-check flags a stuck terminal this long past the latest moment its alert was due. */
export const COVERAGE_SLACK_MS = 60 * SEC;
/** How often due episodes and ladder steps are looked at. Only ever acts on what is already due. */
export const TICK_MS = 5 * SEC;
/** One failover pass reports a host's stuck terminals one event each: one alert for the pass. */
export const HOST_BATCH_MS = 5 * SEC;
/** A failing job he already heard about may be heard about again after this, if it still fails. */
export const JOB_EPISODE_MAX_MS = 24 * HOUR;

const iso = (ms: number) => new Date(ms).toISOString();
const id8 = (id: string | null | undefined) => String(id ?? "").slice(0, 8);
const goalOf = (s: Pick<Session, "goal" | "spawn_goal" | "title">) => (s.goal ?? s.spawn_goal ?? "").trim();
const wsName = (id: string | null | undefined) => (id ? workspaces.get(id)?.name ?? null : null);

/** ⚙ Settings → Alerts, read at the moment of deciding. */
export const alertsOn = (wsId?: string | null): boolean => settingOn("alerts.enabled", wsId ?? null);
const ackWindowMs = () => Math.max(15, setting<number>("alerts.ack_window_sec")) * SEC;
const voiceConfirmMs = () => Math.max(5, setting<number>("alerts.voice_confirm_sec")) * SEC;
const chanceMs = (wsId: string | null) => Math.max(0, setting<number>("alerts.robert_chance_sec", wsId)) * SEC;
export function alertLang(): AlertLang {
  const v = setting<string>("alerts.lang");
  if (v === "en" || v === "es") return v;
  return lastVoiceLang() ?? "en";
}

// ─────────────────────────────── seams (tests drive these) ───────────────────────────────

type Probes = {
  status: (id: string) => TermStatus | null;
  wall: (id: string) => Wall | null;
  prompt: (id: string) => DeskPrompt | null;
  /** When the OPERATOR last typed into it (Desk pane keystrokes, his /input, a tap) — never Robert's or the daemon's hand. */
  operatorLastIn: (id: string) => number | null;
  hostOfflineSince: (hostId: string) => number | null;
};
const defaultProbes: Probes = {
  status: (id) => statusOf(id),
  wall: (id) => { try { return detectWall(sessionScreen(id)?.lines ?? null); } catch { return null; } },
  prompt: (id) => { try { return sessionPrompt(id); } catch { return null; } },
  // proactive-score.ts persists exactly his input (the first keystroke at once, the rest within 30s);
  // the pty's own last_in would count Robert answering it as the operator acknowledging the alert.
  operatorLastIn: (id) => Date.parse(sessions.get(id)?.operator_last_in ?? "") || null,
  hostOfflineSince: (hostId) => hostOfflineSince(hostId),
};
let probes: Probes = defaultProbes;
export function setAlertProbes(p: Partial<Probes> | null): void { probes = p ? { ...defaultProbes, ...p } : defaultProbes; }

type Senders = {
  pushEnabled: () => boolean;
  subscriptions: () => number;
  push: (p: PushPayload) => Promise<{ sent: number; dropped: number }>;
  telegramReady: () => boolean;
  telegram: (html: string, markup: object) => Promise<{ ok: boolean; detail?: string }>;
};
const defaultSenders: Senders = {
  pushEnabled: () => CONFIG.push,
  subscriptions: () => pushSubs.list().length,
  push: (p) => broadcast(p),
  telegramReady: () => !!TELEGRAM_TOKEN && !!getAllowedChat(),
  telegram: async (html, markup) => {
    const r = await telegramSend(getAllowedChat(), html, markup);
    return { ok: !!r?.ok, detail: r?.ok ? `message ${r.result?.message_id ?? "?"}` : String(r?.description ?? "no answer from Telegram").slice(0, 120) };
  },
};
let senders: Senders = defaultSenders;
export function setAlertSenders(s: Partial<Senders> | null): void { senders = s ? { ...defaultSenders, ...s } : defaultSenders; }

// ─────────────────────────────── what counts as stuck ───────────────────────────────

/** Who gets the first go at a stuck terminal before the operator is told. */
export type Owner = "operator" | "robert" | "lead" | "failover";
export type TermKind = "decide" | "blocked" | "stalled" | "wall";

export interface TermFacts {
  phase: Phase;
  hasWorkspace: boolean;
  hasGoal: boolean;
  /** An open question on it that is already the operator's (escalated, routed to him, or Robert's own question to him). */
  operatorAsk: boolean;
  /** The agent itself declared `mc state blocked` — Robert looks at those first. A daemon block is the operator's. */
  declaredBlocked: boolean;
  /** A Ship terminal: its question is his merge/deploy call, never Robert's (ship-guard.ts). */
  ship: boolean;
  /** A live Lead owns it: the Lead hears its stops first (LEADS.md). */
  leadOwned: boolean;
  /** Robert would be woken for this terminal (robert-drive: robert.enabled + robert.drive + watched). */
  robertMayAct: boolean;
  /** A credit / usage wall is sitting at the bottom of its screen (terminal-failover detectWall). */
  wall: boolean;
  /** terminal-failover is still on that wall (enabled, not finished) — its move to make first. */
  failoverActing: boolean;
  /** terminal-failover already moved the work to a stand-in; the walled one is left for him to close. */
  movedOn: boolean;
}

/**
 * The whole "does this need the operator" table for a terminal, pure. Only phases term-status already
 * resolved count — `decide` (a question is open), `blocked`, `stalled` — plus a wall at a stopped
 * phase, which term-status cannot see. A finished turn, a goal reached, a wait on CI or on Robert are
 * Robert's to drive (robert-drive.ts), never an alert. A terminal with no client or no goal is the
 * operator's own scratch window.
 */
export function classifyTerminal(f: TermFacts): { kind: TermKind; owner: Owner } | null {
  if (!f.hasWorkspace || !f.hasGoal) return null;
  if (f.wall && (f.phase === "your_turn" || f.phase === "decide")) {
    if (f.movedOn) return null;
    return { kind: "wall", owner: f.failoverActing ? "failover" : "operator" };
  }
  switch (f.phase) {
    case "decide":
      return { kind: "decide", owner: f.ship || f.operatorAsk ? "operator" : agentOwner(f) };
    case "blocked":
      return { kind: "blocked", owner: f.declaredBlocked && !f.ship ? agentOwner(f) : "operator" };
    case "stalled":
      return { kind: "stalled", owner: "operator" };
    default:
      return null;
  }
}
const agentOwner = (f: TermFacts): Owner => (f.leadOwned ? "lead" : f.robertMayAct ? "robert" : "operator");

/** When the alert for a stuck terminal may fire, relative to when it got stuck: earliest and latest. */
export function alertWindow(
  st: { kind: TermKind; owner: Owner },
  w: { robertGraceMs: number; leadGraceMs: number; chanceMs: number },
): { first: number; last: number } {
  switch (st.owner) {
    case "operator": return { first: OPERATOR_GRACE_MS, last: OPERATOR_GRACE_MS };
    case "failover": return { first: FAILOVER_SAFETY_MS, last: FAILOVER_SAFETY_MS };
    case "lead": return { first: w.leadGraceMs + w.chanceMs, last: w.leadGraceMs + w.chanceMs };
    case "robert": return { first: w.robertGraceMs + WAKE_SETTLE_MS, last: w.robertGraceMs + Math.max(w.chanceMs, WAKE_SETTLE_MS) };
  }
}
function windowFor(stuck: { kind: TermKind; owner: Owner }, s: Session) {
  const drive = stuck.kind === "blocked" ? "blocked" : "decide";
  return alertWindow(stuck, { robertGraceMs: graceMs(drive), leadGraceMs: leadGraceMs(drive, s), chanceMs: chanceMs(s.workspace_id) });
}

const movedKey = (id: string) => `alerts.moved:${id}`;

function factsOf(s: Session, st: TermStatus): TermFacts & { wallInfo: Wall | null; daemonReason: string | null } {
  const sig = signalsOf(s.id);
  const declaredBlocked = st.phase === "blocked" && sig.declared?.state === "blocked";
  let daemonReason: string | null = null;
  if (st.phase === "blocked" && !declaredBlocked) { try { daemonReason = getAgent(s.id)?.blocked_reason ?? null; } catch {} }
  const wallInfo = st.phase === "your_turn" || st.phase === "decide" ? probes.wall(s.id) : null;
  let failoverActing = false;
  if (wallInfo && terminalFailoverEnabled(s.workspace_id)) { try { failoverActing = failoverOwns(s.id); } catch {} }
  return {
    phase: st.phase,
    hasWorkspace: !!s.workspace_id,
    hasGoal: !!goalOf(s),
    operatorAsk: (st.asks ?? 0) > 0,
    declaredBlocked,
    ship: isShipTerminal(s),
    leadOwned: !!resolveLead(s.lead_id),
    robertMayAct: driveEnabled(s.workspace_id) && watched(s),
    wall: !!wallInfo,
    failoverActing,
    movedOn: !!kv.get(movedKey(s.id)),
    wallInfo,
    daemonReason,
  };
}

// ─────────────────────────────── episodes ───────────────────────────────

type Episode = {
  subject: string;
  kind: AlertKind;
  workspace_id: string | null;
  session_id?: string | null;
  run_id?: string | null;
  job_id?: string | null;
  host_id?: string | null;
  since: number;
  reason: string;
  input: TextInput;
  /** Where a tap on the phone lands. */
  url?: string;
  tag?: string;
  /** Buttons on the phone notification (each types into the terminal from the tray, static/sw.js). */
  actions?: PushAction[];
  /** Answer buttons on the Telegram message (terminal-prompts' `tp.` taps — they re-read the screen first). */
  buttons?: Btn[][];
  /** An older notice already put this on his Telegram (failover's, the job push, the stall notice): don't say it twice there. */
  telegramCovered?: boolean;
};

/** The open question on a terminal, from the same sources term-status resolved its card from. */
function openQuestion(s: Session, st: TermStatus): { question: string; options: string[]; prompt: DeskPrompt | null; permission: { tool: string; input: string | null } | null } {
  if (st.permission) return { question: st.permission.question ?? st.line, options: [], prompt: null, permission: { tool: st.permission.tool, input: st.permission.input } };
  if ((st.asks ?? 0) > 0) {
    const a = [...holderAsks(s.id), ...asks.openForSession(s.id)].find((x) => isOperatorsAsk(x));
    if (a) return { question: a.question, options: parseOptions(a.options), prompt: null, permission: null };
  }
  const sig = signalsOf(s.id);
  if (sig.asking) return { question: sig.asking.question, options: sig.asking.options ?? [], prompt: probes.prompt(s.id), permission: null };
  if (sig.declared?.state === "decide") return { question: sig.declared.label || st.line, options: [], prompt: null, permission: null };
  const p = probes.prompt(s.id);
  if (p && p.kind !== "turn") return { question: p.question || st.line, options: (p.options ?? []).map((o) => o.label), prompt: p, permission: null };
  return { question: st.line, options: [], prompt: null, permission: null };
}
function parseOptions(o: unknown): string[] {
  if (Array.isArray(o)) return o.map(String);
  if (typeof o === "string" && o) { try { const v = JSON.parse(o); if (Array.isArray(v)) return v.map(String); } catch {} }
  return [];
}

function termEpisode(s: Session, st: TermStatus, kind: TermKind, reason: string, facts: ReturnType<typeof factsOf>, now: number): Episode {
  const ws = wsName(s.workspace_id);
  const work = goalOf(s) || s.title || "";
  let input: TextInput;
  let actions: PushAction[] = [{ action: "open", title: "Open", input: {} }];
  let buttons: Btn[][] = [];
  switch (kind) {
    case "decide": {
      const q = openQuestion(s, st);
      input = { kind: "decide", ws, work, question: q.question, options: q.options, permission: q.permission };
      if (q.prompt && (q.prompt.kind === "select" || q.prompt.kind === "yn")) {
        actions = actionsFor(q.prompt);
        const sh = id8(s.id);
        if (q.prompt.kind === "yn") buttons = [[{ text: "Yes", data: `tp.${sh}.y` }, { text: "No", data: `tp.${sh}.n` }]];
        else {
          const opts = (q.prompt.options ?? []).slice(0, 4);
          for (let i = 0; i < opts.length; i += 2)
            buttons.push(opts.slice(i, i + 2).map((o, j) => ({ text: `${i + j + 1}. ${o.label}`.slice(0, 32), data: `tp.${sh}.${i + j}` })));
        }
      } else if (st.permission?.options?.length) {
        actions = actionsFor({ kind: "select", question: st.permission.question ?? "", options: st.permission.options } as DeskPrompt);
      }
      break;
    }
    case "blocked":
      input = { kind: "blocked", ws, work, why: st.line || null, reason: facts.daemonReason };
      break;
    case "stalled":
      input = { kind: "stalled", ws, work, minutes: Math.round((now - st.since) / MIN) || null };
      break;
    case "wall":
      input = { kind: "wall", ws, work, wall: facts.wallInfo?.kind ?? "limit", resets: resetsOf(facts.wallInfo?.line) };
      break;
  }
  // The phone does not list a live Lead's workers (push.ts underLiveLead): a tap lands on their Lead.
  const lead = resolveLead(s.lead_id);
  return {
    subject: `session:${s.id}`, kind, workspace_id: s.workspace_id, session_id: s.id, since: st.since, reason,
    input, url: `/phone#s=${lead?.id ?? s.id}`, tag: `session:${s.id}`, actions, buttons,
  };
}

/** Who was in charge of the first go, in the words GET /api/alerts reports. */
const OWNER_REASON: Record<Owner, string> = {
  operator: "his_from_the_start",
  robert: "robert_chance_over",
  lead: "lead_chance_over",
  failover: "failover_not_acting",
};

// ─────────────────────────────── terminals: candidates in their grace ───────────────────────────────

type Candidate = { sessionId: string; kind: TermKind; owner: Owner; since: number; checkAt: number };
const candidates = new Map<string, Candidate>();

/** A status landed: arm, move or drop this terminal's pending alert, and close episodes that ended. */
export function onTermStatus(sessionId: string, st: TermStatus | null | undefined, now = Date.now()): void {
  if (!st) return;
  const s = sessions.get(sessionId);
  if (!s || s.status !== "live" || st.phase === "ended") return endTerm(sessionId, now);
  const facts = factsOf(s, st);
  const stuck = classifyTerminal(facts);
  closeTerm(sessionId, stuck?.kind ?? null, now);
  if (!stuck || !alertsOn(s.workspace_id) || alerts.openFor(`session:${sessionId}`, stuck.kind)) {
    candidates.delete(sessionId);
    return;
  }
  const cur = candidates.get(sessionId);
  if (cur && cur.kind === stuck.kind && cur.since === st.since && cur.owner === stuck.owner) return;
  candidates.set(sessionId, { sessionId, kind: stuck.kind, owner: stuck.owner, since: st.since, checkAt: st.since + windowFor(stuck, s).first });
}

function closeTerm(sessionId: string, keep: TermKind | null, now: number): void {
  for (const r of alerts.resolve(`session:${sessionId}`, null, now, keep))
    console.log(`[alerts] ${id8(sessionId)} ${r.kind} over — it moved on${r.acked_at ? "" : " before he acknowledged it"}`);
}
function endTerm(sessionId: string, now: number): void {
  candidates.delete(sessionId);
  alerts.resolve(`session:${sessionId}`, null, now);
  try { kv.del(movedKey(sessionId)); } catch {}
}

/** Did Robert get this one, and is his turn on it over? Read off his own wake queue, never a second wake. */
function robertTook(sessionId: string, sinceMs: number): { woken: boolean; ackedAt: number | null } {
  const row = db.prepare(
    "SELECT created_at, acked_at FROM robert_wakes WHERE subject = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1",
  ).get(`session:${sessionId}`, iso(sinceMs - SEC)) as { created_at: string; acked_at: string | null } | undefined;
  return { woken: !!row, ackedAt: row?.acked_at ? Date.parse(row.acked_at) : null };
}

async function checkCandidate(c: Candidate, now: number): Promise<void> {
  const s = sessions.get(c.sessionId);
  const st = s && s.status === "live" ? probes.status(c.sessionId) : null;
  if (!s || !st || st.phase === "ended") { endTerm(c.sessionId, now); return; }
  const facts = factsOf(s, st);
  const stuck = classifyTerminal(facts);
  if (!stuck || stuck.kind !== c.kind || !alertsOn(s.workspace_id)) {
    candidates.delete(c.sessionId);
    if (stuck) onTermStatus(c.sessionId, st, now);
    return;
  }
  // A restart re-derives `since`; the owner can change mid-grace (Robert switched off). Follow both.
  c.since = st.since;
  c.owner = stuck.owner;
  // He is typing into it right now (robert-drive's three minutes): it is his and he is looking at it.
  if (operatorOwns(c.sessionId, now)) { c.checkAt = now + 15 * SEC; return; }
  const w = windowFor(stuck, s);
  if (now < c.since + w.first) { c.checkAt = c.since + w.first; return; }
  let reason = OWNER_REASON[stuck.owner];
  if (stuck.owner === "robert") {
    const took = robertTook(c.sessionId, c.since);
    if (!took.woken) reason = "robert_not_woken";
    else if (took.ackedAt && now >= took.ackedAt + HANDOFF_SETTLE_MS) reason = "robert_looked_still_stuck";
    else if (now < c.since + w.last) {
      c.checkAt = Math.min(c.since + w.last, took.ackedAt ? took.ackedAt + HANDOFF_SETTLE_MS : now + TICK_MS);
      return;
    }
  }
  candidates.delete(c.sessionId);
  await raise(termEpisode(s, st, stuck.kind, reason, facts, now), now);
}

// ─────────────────────────────── raising, and the ladder ───────────────────────────────

const RUNGS: AlertRung[] = ["voice", "push", "telegram"];

/**
 * Tell him about this episode — or don't, when it is already open (the same stop), a flicker of one
 * that just closed, or alerts are off for its workspace. Over the hourly cap it is written but folded
 * into the one summary. Returns the new row, or null when nothing new was raised.
 */
export async function raise(ep: Episode, now = Date.now(), opts: { selfcheck?: boolean } = {}): Promise<AlertRow | null> {
  if (ep.kind !== "summary" && !alertsOn(ep.workspace_id)) return null;
  if (alerts.openFor(ep.subject, ep.kind)) return null;
  const lang = alertLang();
  const text = alertText(ep.input, lang);
  const recent = alerts.recentlyResolved(ep.subject, ep.kind, now - REOPEN_MS);
  if (recent && recent.text === text) {
    try { alerts.reopen(recent.id, now); } catch {}
    return null;
  }
  const capped = ep.kind !== "summary" && alerts.toldSince(now - HOUR) >= Math.max(1, setting<number>("alerts.per_hour"));
  const row = alerts.insert({
    subject: ep.subject, kind: ep.kind, workspace_id: ep.workspace_id, session_id: ep.session_id ?? null,
    run_id: ep.run_id ?? null, job_id: ep.job_id ?? null, host_id: ep.host_id ?? null,
    reason: opts.selfcheck ? `selfcheck:${ep.reason}` : ep.reason,
    title: alertTitle(ep.input, lang), text, lang, state: capped ? "capped" : "active",
    stuck_since: ep.since, next_at: capped ? null : now, selfcheck: !!opts.selfcheck,
    meta: { input: ep.input, url: ep.url ?? "/phone", tag: ep.tag ?? null, actions: ep.actions ?? null, buttons: ep.buttons ?? [], telegramCovered: !!ep.telegramCovered },
  }, now);
  if (!row) return null;
  console.log(`[alerts] ${ep.kind} ${ep.subject.replace(/:(.{8}).*/, ":$1")} — ${capped ? "over the hourly cap, folded into the summary" : "telling him"} (${row.reason}; stuck ${Math.round((now - ep.since) / SEC)}s)`);
  if (capped) { foldIntoSummary(row, now); return alerts.get(row.id) ?? row; }
  await step(row, now);
  return alerts.get(row.id) ?? row;
}

const stepping = new Set<string>();

/** One step of the ladder for this row: the next rung that can take it, or the end. */
async function step(row0: AlertRow, now: number): Promise<void> {
  if (stepping.has(row0.id)) return;
  stepping.add(row0.id);
  try {
    let row: AlertRow | null = alerts.get(row0.id) ?? null;
    if (!row || row.acked_at || row.resolved_at || row.state !== "active") return;
    // Switched off while it was climbing: stop where it is.
    if (row.kind !== "summary" && !alertsOn(row.workspace_id)) { alerts.update(row.id, { next_at: null, state: "done" }, now); return; }
    if (row.kind === "summary" && !row.channels.length) {
      row = composeSummary(row, now);
      if (!row) return;
    }
    // A call picked to say it that never confirmed: that rung failed — on to the phone.
    const pending = row.channels.find((c) => c.rung === "voice" && c.ok === null);
    if (pending) alerts.setChannel(row.id, { ...pending, ok: false, detail: `${pending.detail ?? "call"} · never confirmed it spoke` }, now);
    const tried = new Set((alerts.get(row.id)?.channels ?? []).map((c) => c.rung));
    for (const rung of RUNGS) {
      if (tried.has(rung)) continue;
      const out = await tryRung(rung, alerts.get(row.id)!, now);
      if (out === "pending") { alerts.update(row.id, { next_at: now + voiceConfirmMs() }, now); return; }
      if (out === "sent") {
        markDelivered(row.id, rung, now);
        alerts.update(row.id, rung === "telegram" ? { next_at: null, state: "done" } : { next_at: now + ackWindowMs() }, now);
        return;
      }
    }
    alerts.update(row.id, { next_at: null, state: "done" }, now);
    const end = alerts.get(row.id);
    if (end && !end.delivered_at) console.warn(`[alerts] ${end.kind} ${end.subject} — NO channel could take it: ${end.channels.map((c) => `${c.rung}: ${c.detail ?? c.ok}`).join("; ")}`);
  } finally {
    stepping.delete(row0.id);
  }
}

function markDelivered(id: string, via: AlertRung, now: number): void {
  const r = alerts.get(id);
  if (r && !r.delivered_at) alerts.update(id, { delivered_at: iso(now), delivered_via: via }, now);
}

type RungOut = "pending" | "sent" | "failed" | "skipped";

async function tryRung(rung: AlertRung, row: AlertRow, now: number): Promise<RungOut> {
  const skip = (detail: string): RungOut => { alerts.setChannel(row.id, { rung, at: iso(now), ok: false, detail: `skipped: ${detail}` }, now); return "skipped"; };
  const meta = row.meta ?? {};
  switch (rung) {
    case "voice": {
      if (!settingOn("alerts.voice")) return skip("off in settings");
      const call = voiceFor(row.workspace_id, now);
      if (!call) return skip("no live voice call");
      const input = meta.input as TextInput | undefined;
      const say = input ? alertText(input, call.lang) : row.text;
      alerts.setChannel(row.id, { rung, at: iso(now), ok: null, detail: `${call.surface}:${call.client}` }, now);
      bus.publish({ topic: "alert.raised", alert_id: row.id, workspace_id: row.workspace_id, session_id: row.session_id, kind: row.kind, say, lang: call.lang, client: call.client });
      return "pending";
    }
    case "push": {
      if (!settingOn("alerts.push")) return skip("off in settings");
      if (!senders.pushEnabled()) return skip("push is off on this daemon");
      if (senders.subscriptions() === 0) return skip("no phone subscribed");
      const payload: PushPayload = {
        kind: "alert", title: row.title, body: row.text, tag: meta.tag || `alert:${row.id}`, url: meta.url || "/phone",
        ...(row.session_id ? { session_id: row.session_id } : {}),
        actions: Array.isArray(meta.actions) && meta.actions.length ? meta.actions : [{ action: "open", title: "Open", input: {} }],
        alert_id: row.id, at: iso(now),
      };
      try {
        const r = await senders.push(payload);
        alerts.setChannel(row.id, { rung, at: iso(now), ok: r.sent > 0, detail: `sent to ${r.sent} phone${r.sent === 1 ? "" : "s"}${r.dropped ? `, ${r.dropped} expired` : ""}` }, now);
        return r.sent > 0 ? "sent" : "failed";
      } catch (e: any) {
        alerts.setChannel(row.id, { rung, at: iso(now), ok: false, detail: String(e?.message ?? e).slice(0, 120) }, now);
        return "failed";
      }
    }
    case "telegram": {
      if (meta.telegramCovered) {
        alerts.setChannel(row.id, { rung, at: iso(now), ok: true, detail: "covered by the Telegram notice already sent for it" }, now);
        return "sent";
      }
      if (!settingOn("alerts.telegram")) return skip("off in settings");
      if (!senders.telegramReady()) return skip("Telegram is not set up");
      const html = `🔔 <b>${esc(row.title)}</b>\n${esc(row.text)}`;
      const rows: Btn[][] = [...(Array.isArray(meta.buttons) ? meta.buttons : []), [{ text: row.lang === "es" ? "✓ Lo vi" : "✓ Got it", data: `al.ack.${id8(row.id)}` }]];
      try {
        const r = await senders.telegram(html, kb(rows));
        alerts.setChannel(row.id, { rung, at: iso(now), ok: r.ok, detail: r.detail ?? null }, now);
        return r.ok ? "sent" : "failed";
      } catch (e: any) {
        alerts.setChannel(row.id, { rung, at: iso(now), ok: false, detail: String(e?.message ?? e).slice(0, 120) }, now);
        return "failed";
      }
    }
  }
}

// ─────────────────────────────── acknowledgement ───────────────────────────────

/** He has it: the ladder stops. Returns the row, or null when no such alert. */
export function ackAlert(ref: string, via: string, at = Date.now()): AlertRow | null {
  const row = alerts.find(ref);
  if (!row) return null;
  if (!row.acked_at) {
    const state = row.state === "active" || row.state === "done" ? "acked" : row.state;
    alerts.update(row.id, { acked_at: iso(at), acked_via: String(via || "api").slice(0, 40), state }, at);
    // A summary he acknowledged covers every alert it carried.
    if (row.kind === "summary") for (const c of alerts.carriedBy(row.id)) if (!c.acked_at) alerts.update(c.id, { acked_at: iso(at), acked_via: "summary" }, at);
    console.log(`[alerts] ${row.kind} ${row.subject.replace(/:(.{8}).*/, ":$1")} acknowledged (${via}) ${Math.round((at - Date.parse(row.raised_at)) / SEC)}s after it was raised`);
  }
  return alerts.get(row.id) ?? row;
}

/** The Telegram "got it" button. */
export function ackAlertTap(ref: string, via = "telegram"): boolean {
  return !!ackAlert(ref, via);
}

/** A voice call confirms it said the alert (POST /api/alerts/:id/spoken). */
export function confirmSpoken(ref: string, client: string | null, at = Date.now()): AlertRow | null {
  const row = alerts.find(ref);
  if (!row) return null;
  // Only a call this alert was actually handed to (never a rung that was skipped for want of one).
  const voice = [...row.channels].reverse().find((c) =>
    c.rung === "voice" && c.ok !== true && !String(c.detail ?? "").startsWith("skipped:") && (!client || callOf(c) === client));
  if (!voice) return row;
  // Late = the ladder already gave up on the call and moved on; it still spoke, so it still counts.
  const late = voice.ok === false;
  alerts.setChannel(row.id, { ...voice, ok: true, detail: `${voiceTarget(voice)}${late ? " · confirmed late" : ""}` }, at, (c) => c === voice || (c.rung === "voice" && c.at === voice.at));
  markDelivered(row.id, "voice", at);
  if (!late && row.state === "active") alerts.update(row.id, { next_at: at + ackWindowMs() }, at);
  return alerts.get(row.id) ?? row;
}

/** "desk:<client>" — which call a voice channel was handed to (the part before any " · note"). */
const voiceTarget = (c: AlertChannel) => String(c.detail ?? "").split(" · ")[0];
const callOf = (c: AlertChannel) => voiceTarget(c).split(":").slice(1).join(":");

/** The same call that spoke the alert sent Robert a turn afterwards: he heard it and is on it. */
function ackVoiceReply(client: string | null | undefined, at: number): void {
  if (!client) return;
  for (const r of alerts.list({ sinceMs: at - 6 * HOUR, limit: 50 })) {
    if (r.acked_at || r.resolved_at) continue;
    const spoke = r.channels.find((c) => c.rung === "voice" && c.ok === true && callOf(c) === client);
    if (!spoke || at < Date.parse(spoke.at) || at - Date.parse(spoke.at) > 2 * ackWindowMs()) continue;
    ackAlert(r.id, "voice_reply", at);
  }
}
/**
 * He typed into the terminal an alert was about — Desk pane, composer, phone, a notification button,
 * a Telegram tap. Read from the durable record of HIS input (proactive-score.ts), not the bus: a
 * `session.input` says by "operator" whenever a caller left `by` off, Robert and Leads included.
 */
function ackByTyping(now: number): void {
  for (const r of alerts.awaitingAck()) {
    const li = r.session_id ? probes.operatorLastIn(r.session_id) : null;
    if (li && li > Date.parse(r.raised_at) && li <= now) ackAlert(r.id, "answered", li);
  }
}

// ─────────────────────────────── the hourly cap → one summary ───────────────────────────────

function foldIntoSummary(row: AlertRow, now: number): void {
  let sum = alerts.pendingSummary();
  if (!sum) {
    const last = alerts.lastSummary();
    const at = Math.max(now + SUMMARY_DEBOUNCE_MS, last ? Date.parse(last.created_at) + HOUR : 0);
    sum = alerts.insert({
      subject: `summary:${now}`, kind: "summary", workspace_id: null, reason: "over_hourly_cap",
      title: "…", text: "…", lang: alertLang(), state: "active", stuck_since: now, next_at: at, meta: {},
    }, now) ?? undefined;
  }
  if (sum) alerts.update(row.id, { summary_id: sum.id }, now);
}

/** Right before the summary goes out: what it carries now. Nothing left stuck = nothing to say. */
function composeSummary(sum: AlertRow, now: number): AlertRow | null {
  const open = alerts.carriedBy(sum.id).filter((c) => !c.resolved_at);
  if (!open.length) {
    alerts.update(sum.id, { state: "resolved", next_at: null, resolved_at: iso(now), reason: "nothing_left_stuck" }, now);
    return null;
  }
  const lang = alertLang();
  const items = open.map((c) => {
    const inp = c.meta?.input as TextInput | undefined;
    const ws = inp && "ws" in inp ? inp.ws : wsName(c.workspace_id);
    const what = inp && "work" in inp ? inp.work : inp && "job" in inp ? inp.job : inp && "host" in inp ? inp.host : c.title;
    return ws ? `${ws}: ${what}` : String(what);
  });
  const input: TextInput = { kind: "summary", items };
  alerts.update(sum.id, { title: alertTitle(input, lang), text: alertText(input, lang), lang, meta: { input, url: "/phone", tag: "alert:summary" } }, now);
  return alerts.get(sum.id) ?? null;
}

// ─────────────────────────────── walls, computers, jobs, headless runs ───────────────────────────────

/** terminal-failover's verdicts: gave up → told at once; moved to a stand-in → that wall is nobody's problem. */
async function onFailover(e: Extract<BusEvent, { topic: "session.failover" }>, now = Date.now()): Promise<void> {
  if (e.step === "backend") {
    try { kv.set(movedKey(e.session_id), e.to_session_id || "moved"); } catch {}
    candidates.delete(e.session_id);
    alerts.resolve(`session:${e.session_id}`, "wall", now);
    return;
  }
  if (e.step !== "give_up") return;
  const s = sessions.get(e.session_id);
  if (!s || s.status !== "live") return;
  candidates.delete(s.id);
  await raise({
    subject: `session:${s.id}`, kind: "wall", workspace_id: s.workspace_id, session_id: s.id, since: now,
    reason: "failover_gave_up", url: `/phone#s=${s.id}`, tag: `session:${s.id}`,
    input: { kind: "wall", ws: wsName(s.workspace_id), work: goalOf(s) || s.title || "", wall: e.wall, resets: resetsOf(e.detail) },
    // giveUp() already sent "Terminal stuck on a wall" to Telegram.
    telegramCovered: true,
  }, now);
}

const hostBatches = new Map<string, { ids: Set<string>; at: number; t: NodeJS.Timeout | null }>();

/** host-failover could not move a terminal off a gone computer: one alert per host per pass. */
function onHostStuck(hostId: string, sessionId: string, now = Date.now()): void {
  const b = hostBatches.get(hostId) ?? { ids: new Set<string>(), at: now, t: null };
  b.ids.add(sessionId);
  if (!b.t) {
    b.t = setTimeout(() => void flushHostBatch(hostId).catch((e) => console.error("[alerts] host", e)), HOST_BATCH_MS);
    b.t.unref?.();
  }
  hostBatches.set(hostId, b);
}
export async function flushHostBatch(hostId: string, now = Date.now()): Promise<AlertRow | null> {
  const b = hostBatches.get(hostId);
  hostBatches.delete(hostId);
  if (b?.t) clearTimeout(b.t);
  const rows = [...(b?.ids ?? [])].map((id) => sessions.get(id)).filter((s): s is Session => !!s && s.status === "live" && alertsOn(s.workspace_id));
  if (!rows.length) return null;
  return raise(hostEpisode(hostId, rows, b?.at ?? now, true, "failover_could_not_move"), now);
}
function hostEpisode(hostId: string, rows: Session[], since: number, moved: boolean, reason: string): Episode {
  const works = rows.map((s) => { const ws = wsName(s.workspace_id); const w = goalOf(s) || s.title || "a terminal"; return ws ? `${ws}: ${w}` : w; });
  const single = rows.length === 1 ? rows[0] : null;
  return {
    subject: `host:${hostId}`, kind: "host", workspace_id: single ? single.workspace_id : null, host_id: hostId, since, reason,
    session_id: single?.id ?? null, url: single ? `/phone#s=${single.id}` : "/phone", tag: `host:${hostId}`,
    input: { kind: "host", host: hostLabel(hostId), works, minutes: null, moved },
  };
}
/** The net under host failover: a computer gone past its grace with live work still on it and no alert. */
async function sweepHosts(now: number): Promise<void> {
  const byHost = new Map<string, Session[]>();
  for (const s of sessions.list({ status: "live" })) {
    if (!s.host_id || s.host_id === LOCAL_HOST_ID) continue;
    byHost.set(s.host_id, [...(byHost.get(s.host_id) ?? []), s]);
  }
  for (const r of db.prepare("SELECT DISTINCT host_id FROM alerts WHERE kind = 'host' AND resolved_at IS NULL").all() as { host_id: string }[]) {
    if (!byHost.has(r.host_id) || probes.hostOfflineSince(r.host_id) == null) closeHost(r.host_id, now);
  }
  for (const [hostId, rows] of byHost) {
    const since = probes.hostOfflineSince(hostId);
    if (since == null || hostBatches.has(hostId)) continue;
    const threshold = CONFIG.hostFailoverGraceMin * MIN + (CONFIG.hostFailover ? HOST_FAILOVER_SAFETY_MS : 0);
    if (now - since < threshold || alerts.openFor(`host:${hostId}`, "host")) continue;
    const mine = rows.filter((s) => alertsOn(s.workspace_id));
    if (!mine.length) continue;
    const ep = hostEpisode(hostId, mine, since, false, CONFIG.hostFailover ? "failover_did_not_move_it" : "host_failover_off");
    (ep.input as Extract<TextInput, { kind: "host" }>).minutes = Math.round((now - since) / MIN);
    await raise(ep, now);
  }
}
export function closeHost(hostId: string, now = Date.now()): void {
  for (const r of alerts.resolve(`host:${hostId}`, "host", now)) console.log(`[alerts] host ${hostId} back or emptied — ${r.id.slice(0, 8)} over`);
}

/** A retry is still coming (dispatcher maybeRetry, mirrored): this failure is not the last word. */
export function willRetry(run: Pick<Run, "status" | "attempt" | "error">, job: Pick<Job, "retry_max">): boolean {
  if (run.status !== "failed" && run.status !== "timeout") return false;
  if (run.error && AUTH_ERR_RE.test(run.error)) return false;
  return run.attempt <= job.retry_max;
}
/** A job the operator set up (not the machinery's own runs), not muted, and the alert switch on. */
function jobAlertable(job: Job): boolean {
  if (isInternalJob(job.name) || baseJobName(job.name).startsWith("slack-triage:")) return false;
  if (job.notify === "off") return false;
  return alertsOn(job.workspace_id);
}
/** The first line that says something, without the "Error:" every error starts with. */
const firstLine = (s: string | null | undefined) =>
  (String(s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "").replace(/^(?:error|fatal|exception)\s*:\s*/i, "");
const jobWords = (job: Job) => baseJobName(job.name).replace(/^[a-z-]+:(?=\S)/, "") || job.name;

async function onRunEnded(runId: string, now = Date.now()): Promise<void> {
  const run = runs.get(runId);
  const job = run ? jobs.get(run.job_id) : undefined;
  if (!run || !job) return;
  alerts.resolve(`run:${run.id}`, "stalled", now);
  if (run.status === "success") { alerts.resolve(`job:${job.id}`, "job_failed", now); return; }
  if (run.status !== "failed" && run.status !== "timeout") return;
  if (!jobAlertable(job) || willRetry(run, job)) return;
  await raise(jobEpisode(job, run, now), now);
}
function jobEpisode(job: Job, run: Run, now: number): Episode {
  const auth = !!run.error && AUTH_ERR_RE.test(run.error);
  return {
    subject: `job:${job.id}`, kind: "job_failed", workspace_id: job.workspace_id ?? null, run_id: run.id, job_id: job.id,
    since: Date.parse(run.ended_at ?? "") || now, reason: auth ? "logged_out" : run.status === "timeout" ? "timed_out" : "last_attempt_failed",
    url: "/phone", tag: `job:${job.id}`,
    input: { kind: "job_failed", ws: wsName(job.workspace_id), job: jobWords(job), why: auth || run.status === "timeout" ? null : firstLine(run.error ?? run.summary).slice(0, 160), auth, timeout: run.status === "timeout", backend: job.backend ?? null },
    // telegram/push.ts already posts every final run outcome the job does not mute.
    telegramCovered: true,
  };
}

/** The stall supervisor (monitor.ts): a headless run quiet with no sign of life at all. */
async function onRunState(e: Extract<BusEvent, { topic: "agent.state" }>, now = Date.now()): Promise<void> {
  if (e.blocked_reason !== "stall") { if (e.kind === "run") alerts.resolve(`run:${e.id}`, "stalled", now); return; }
  const run = runs.get(e.id);
  const job = run ? jobs.get(run.job_id) : undefined;
  if (!run || !job || run.status !== "running" || !jobAlertable(job)) return;
  const quiet = /quiet (\d+)m/.exec(e.state_label ?? "");
  await raise({
    subject: `run:${run.id}`, kind: "stalled", workspace_id: job.workspace_id ?? null, run_id: run.id, job_id: job.id,
    since: now - (quiet ? Number(quiet[1]) * MIN : 0), reason: "no_sign_of_life", url: "/phone", tag: `run:${run.id}`,
    input: { kind: "stalled", ws: wsName(job.workspace_id), work: jobWords(job), minutes: quiet ? Number(quiet[1]) : null, job: true },
    // monitor.ts already sent "⚠️ … no liveness evidence" to Telegram on this very verdict.
    telegramCovered: true,
  }, now);
}

// ─────────────────────────────── the self-check ───────────────────────────────

export type Miss = { what: string; subject: string; kind: string; stuck_for_s: number };
export type Coverage = { checked_at: string; ok: boolean; misses: Miss[]; misses_total: number };
const COVERAGE_KEY = "alerts.coverage";
let lastCoverage: Coverage | null = null;

/**
 * Would anything stuck have slipped through? For every live terminal the same table decides; one
 * stuck past the latest moment its alert was due, with no row for it, is a MISS: raised now (marked
 * selfcheck so it is counted, not hidden) and recorded. Ladder steps overdue by minutes mean the tick
 * is not running: they are stepped here. A job's last attempt that failed in the last two hours with
 * no row is a miss too. Runs on the supervision guard's clock, so it does not share this module's.
 */
export async function checkAlertCoverage(now = Date.now(), opts: { force?: boolean } = {}): Promise<Coverage> {
  if (!opts.force && lastCoverage && now - Date.parse(lastCoverage.checked_at) < MIN) return lastCoverage;
  const misses: Miss[] = [];
  for (const s of sessions.list({ status: "live" })) {
    try {
      if (!alertsOn(s.workspace_id)) continue;
      const st = probes.status(s.id);
      if (!st || st.phase === "ended") continue;
      const facts = factsOf(s, st);
      const stuck = classifyTerminal(facts);
      if (!stuck || alerts.openFor(`session:${s.id}`, stuck.kind) || operatorOwns(s.id, now)) continue;
      if (now <= st.since + windowFor(stuck, s).last + COVERAGE_SLACK_MS) continue;
      misses.push({ what: "terminal stuck with no alert", subject: `session:${s.id}`, kind: stuck.kind, stuck_for_s: Math.round((now - st.since) / SEC) });
      candidates.delete(s.id);
      await raise(termEpisode(s, st, stuck.kind, "missed", facts, now), now, { selfcheck: true });
    } catch (e: any) {
      console.warn("[alerts] coverage", id8(s.id), e?.message ?? e);
    }
  }
  const overdue = alerts.due(now - 2 * MIN);
  for (const r of overdue) {
    misses.push({ what: "ladder step overdue", subject: r.subject, kind: r.kind, stuck_for_s: Math.round((now - (r.next_at ?? now)) / SEC) });
    await step(r, now).catch(() => {});
  }
  const failed = db.prepare(
    "SELECT id FROM runs WHERE status IN ('failed','timeout') AND ended_at >= ? AND ended_at <= ? ORDER BY ended_at",
  ).all(iso(now - 2 * HOUR), iso(now - MIN)) as { id: string }[];
  for (const { id } of failed) {
    const run = runs.get(id);
    const job = run ? jobs.get(run.job_id) : undefined;
    if (!run || !job || !jobAlertable(job) || willRetry(run, job)) continue;
    const told = db.prepare("SELECT 1 FROM alerts WHERE job_id = ? AND (resolved_at IS NULL OR created_at >= ?) LIMIT 1").get(job.id, run.ended_at ?? iso(now));
    // A later success already closed the episode it would have opened: nothing to say.
    const after = db.prepare("SELECT 1 FROM runs WHERE job_id = ? AND status = 'success' AND started_at > ? LIMIT 1").get(job.id, run.ended_at ?? iso(now));
    if (told || after) continue;
    misses.push({ what: "failed job with no alert", subject: `job:${job.id}`, kind: "job_failed", stuck_for_s: Math.round((now - Date.parse(run.ended_at ?? iso(now))) / SEC) });
    await raise(jobEpisode(job, run, now), now, { selfcheck: true });
  }
  let total = 0;
  try { total = Number(JSON.parse(kv.get(COVERAGE_KEY) ?? "{}").misses_total ?? 0); } catch {}
  total += misses.length;
  lastCoverage = { checked_at: iso(now), ok: misses.length === 0, misses, misses_total: total };
  try {
    if (misses.length) kv.set(COVERAGE_KEY, JSON.stringify({ ...lastCoverage, last_miss_at: iso(now) }));
    else if (!kv.get(COVERAGE_KEY)) kv.set(COVERAGE_KEY, JSON.stringify(lastCoverage));
  } catch {}
  if (misses.length) console.warn(`[alerts] self-check: ${misses.length} miss(es) — ${misses.map((m) => `${m.what} (${m.subject.replace(/:(.{8}).*/, ":$1")} ${m.kind}, ${m.stuck_for_s}s)`).join("; ")}`);
  return lastCoverage;
}

// ─────────────────────────────── the tick ───────────────────────────────

let ticking = false;
let lastHostSweep = 0;
let lastPrune = 0;

/** Everything due by `now`: pending terminal alerts, ladder steps, acks by typing, the computer net. */
export async function tickAlerts(now = Date.now()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const c of [...candidates.values()]) {
      if (c.checkAt > now) continue;
      try { await checkCandidate(c, now); } catch (e: any) { console.warn("[alerts] candidate", id8(c.sessionId), e?.message ?? e); }
    }
    for (const r of alerts.due(now)) {
      try { await step(r, now); } catch (e: any) { console.warn("[alerts] ladder", id8(r.id), e?.message ?? e); }
    }
    try { ackByTyping(now); } catch {}
    if (now - lastHostSweep >= MIN) {
      lastHostSweep = now;
      try { await sweepHosts(now); } catch (e: any) { console.warn("[alerts] hosts", e?.message ?? e); }
    }
    if (now - lastPrune >= HOUR) {
      lastPrune = now;
      try {
        // A failing job he was told about a day ago may be news again if it is still failing.
        for (const r of db.prepare("SELECT subject FROM alerts WHERE kind = 'job_failed' AND resolved_at IS NULL AND created_at < ?").all(iso(now - JOB_EPISODE_MAX_MS)) as { subject: string }[])
          alerts.resolve(r.subject, "job_failed", now);
        alerts.prune(30, now);
      } catch {}
    }
  } finally {
    ticking = false;
  }
}

// ─────────────────────────────── surfaces ───────────────────────────────

/**
 * The phone push for this terminal is ours (push.ts `owned`): a question or a block on fleet work,
 * with the alerts running. Everything else — finished turns, the operator's scratch windows — keeps
 * push.ts's own notification.
 */
export function alertsOwnPush(sessionId: string, phase: string | null): boolean {
  if (!started || (phase !== "decide" && phase !== "blocked" && phase !== "stalled")) return false;
  const s = sessions.get(sessionId);
  if (!s || !s.workspace_id || !goalOf(s)) return false;
  return alertsOn(s.workspace_id) && settingOn("alerts.push");
}

export function alertView(r: AlertRow) {
  const told = r.delivered_at ? Date.parse(r.delivered_at) - Date.parse(r.stuck_since) : null;
  return {
    id: r.id, kind: r.kind, subject: r.subject, state: r.state, reason: r.reason,
    workspace_id: r.workspace_id, workspace: wsName(r.workspace_id),
    session_id: r.session_id, run_id: r.run_id, job_id: r.job_id, host_id: r.host_id,
    title: r.title, text: r.text, lang: r.lang,
    stuck_since: r.stuck_since, raised_at: r.raised_at, delivered_at: r.delivered_at, delivered_via: r.delivered_via,
    acked_at: r.acked_at, acked_via: r.acked_via, resolved_at: r.resolved_at, summary_id: r.summary_id,
    selfcheck: r.selfcheck, channels: r.channels,
    /** Stuck → raised: the grace and Robert's chance. Stuck → told: what the operator actually waited. */
    raise_ms: Date.parse(r.raised_at) - Date.parse(r.stuck_since),
    told_ms: told,
  };
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

/** GET /api/alerts: the record, the numbers that say whether it works, and what is armed right now. */
export function alertsReport(opts: { sinceMs?: number; limit?: number; kind?: string } = {}, now = Date.now()) {
  const rows = alerts.list({ sinceMs: opts.sinceMs ?? now - 24 * HOUR, limit: opts.limit ?? 200, kind: opts.kind });
  const told = rows.filter((r) => r.delivered_at && r.kind !== "summary").map((r) => Date.parse(r.delivered_at!) - Date.parse(r.stuck_since));
  let coverage: unknown = lastCoverage;
  try { coverage = coverage ?? JSON.parse(kv.get(COVERAGE_KEY) ?? "null"); } catch {}
  return {
    alerts: rows.map(alertView),
    stats: {
      total: rows.length,
      delivered: rows.filter((r) => r.delivered_at).length,
      acked: rows.filter((r) => r.acked_at).length,
      resolved_before_ack: rows.filter((r) => r.resolved_at && !r.acked_at).length,
      undelivered: rows.filter((r) => r.state === "done" && !r.delivered_at).length,
      capped: rows.filter((r) => r.state === "capped").length,
      summaries: rows.filter((r) => r.kind === "summary").length,
      selfcheck: rows.filter((r) => r.selfcheck).length,
      told_ms_p50: pct(told, 50),
      told_ms_p90: pct(told, 90),
    },
    coverage,
    voice: voiceCalls(now).map((c) => ({ surface: c.surface, client: c.client, lang: c.lang, lock: c.lock, age_ms: now - c.at })),
    pending: [...candidates.values()].map((c) => ({ session_id: c.sessionId, kind: c.kind, owner: c.owner, since: iso(c.since), check_at: iso(c.checkAt) })),
  };
}

// ─────────────────────────────── wiring ───────────────────────────────

let started = false;

/** Tests: forget the in-memory half (what a daemon restart forgets). The rows stay. */
export function resetStuckAlerts(): void {
  candidates.clear();
  for (const b of hostBatches.values()) if (b.t) clearTimeout(b.t);
  hostBatches.clear();
  stepping.clear();
  lastCoverage = null;
  lastHostSweep = 0;
  lastPrune = 0;
  ticking = false;
}

export function startStuckAlerts(): void {
  if (started) return;
  started = true;
  bus.on("event", (e: BusEvent) => {
    try {
      switch (e.topic) {
        case "session.status": return onTermStatus(e.session_id, e.status as TermStatus);
        case "session.ended": return endTerm(e.session_id, Date.now());
        case "session.failover": void onFailover(e).catch((err) => console.error("[alerts] failover", err)); return;
        case "session.host_failover": if (e.mode === "stuck") onHostStuck(e.from_host, e.session_id); return;
        case "host.online": return closeHost(e.host_id);
        case "run.ended": void onRunEnded(e.run_id).catch((err) => console.error("[alerts] run", err)); return;
        case "agent.state": if (e.kind === "run") void onRunState(e).catch((err) => console.error("[alerts] run state", err)); return;
        case "agent.asked": return ackVoiceReply(e.client, Date.now());
      }
    } catch (err) {
      console.error("[alerts]", err);
    }
  });
  const t = setInterval(() => void tickAlerts().catch((e) => console.error("[alerts] tick", e)), TICK_MS);
  t.unref?.();
  console.log(
    alertsOn()
      ? `[alerts] stuck work is told once: voice call → phone → Telegram (ack window ${Math.round(ackWindowMs() / SEC)}s, Robert's chance ${Math.round(chanceMs(null) / SEC)}s, ${setting<number>("alerts.per_hour")}/hour then one summary)`
      : "[alerts] off (⚙ Settings → Alerts) — stuck work waits to be noticed",
  );
}

/** Test seam: drive the bus handlers directly with a fake clock (startStuckAlerts would add a real-time tick). */
export const _test = {
  onFailover, onHostStuck, onRunEnded, onRunState, ackVoiceReply, candidates, step, sweepHosts,
  setStarted: (v: boolean) => { started = v; },
};
