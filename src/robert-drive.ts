/**
 * Robert drives the Desk — he is woken when a terminal STOPS, not only when it asks.
 *
 * Before this, the only things that woke him without the operator were ticket events (nobody uses
 * tickets any more), an `mc ask-robert`, and a 🟠 menu read off a screen. A terminal that finished its
 * turn, ticked its goal, declared `mc state waiting --on robert`, `decide` or `blocked` just sat on
 * the wall until the operator happened to look. In his words: "a veces se quedan ahí esperando y no
 * veo a Robert que se despierte y ejecute".
 *
 * The signal is the ONE resolved status (term-status.ts), not raw pty events: it already knows a
 * finished turn from subagents running, a declared wait from silence, a question from a result.
 *
 *  - **One wake per stop.** The key is session + phase + when that phase began, so a card that stays
 *    amber for an hour is one wake, and the next turn that finishes is a new one.
 *  - **Grace, then look again.** A phase must still hold after its grace (the operator answering in
 *    ten seconds never reaches Robert), re-read from term-status at fire time.
 *  - **Not over his shoulder.** A terminal the operator typed into recently is his.
 *  - **Nobody twice.** An open ask is ask-robert's, a screen prompt Robert is already on is
 *    terminal-prompts', a credit wall is terminal-failover's.
 *  - **Capped.** Per terminal and daemon-wide per hour, so Robert answering a terminal that finishes
 *    again cannot become a loop that burns the day.
 *
 * What he may do once woken is policy and lives in agents/_blocks/terminal-drive.md, beside
 * terminal-prompts.md — not here.
 *
 * A LEAD (LEADS.md) is woken differently, and the difference is the second half of this file. Its
 * workers' stops are ROWS in `lead_events`, not keystrokes: the Lead long-polls for them
 * (`mc lead wait` → waitForLeadEvents), which costs nothing while it waits and hands it five stops in
 * one turn instead of five. Only a Lead that is NOT pulling is typed at, once, with a debounced
 * digest naming every worker in the burst (scheduleDigest/sendDigest). If even that cannot land, the
 * stops become Robert's exactly as they would have if the worker had no Lead at all (escalateBatch) —
 * a stop is never silently lost.
 */
import { CONFIG } from "./config.js";
import { bus, type BusEvent } from "./bus.js";
import { asks, db, leadEvents, leadSlices, sessions, workspaces, type LeadEvent } from "./store.js";
import type { Session } from "./types.js";
import { enqueueWake, TERMINAL_DRIVE_KEY } from "./wake-queue.js";
import { failoverOwns } from "./terminal-failover.js";
import { promptTracked } from "./terminal-prompts.js";
import { focusEvents, sessionActivity, sendInput } from "./terminal.js";
import { signalsOf, statusOf, type TermStatus } from "./term-status.js";

export type DriveKind = "review" | "turn" | "decide" | "blocked" | "robert";
/** The same five as a set — the inbox stores kinds as free text, and only these have a Robert wake. */
const DRIVE_KINDS: ReadonlySet<string> = new Set<DriveKind>(["review", "turn", "decide", "blocked", "robert"]);

export const driveEnabled = (): boolean => CONFIG.robertDrive.enabled;

/** Seconds a phase must hold before Robert hears about it. */
export function graceMs(kind: DriveKind): number {
  const turn = Math.max(0, CONFIG.robertDrive.graceSec) * 1000;
  if (kind === "turn") return turn;
  if (kind === "robert") return Math.min(turn, 20_000);
  return Math.min(turn, 45_000);
}

/**
 * The grace a terminal actually gets. Robert's (graceMs) is tuned for "the operator answers in ten
 * seconds and Robert never needs to know" — for a worker whose Lead is sitting in `mc lead wait`
 * that is ninety seconds of dead air per turn, times every worker it has open.
 *
 * Only ever LOWERS it (`min`), so a kind Robert already hears about quickly keeps its own number,
 * and the operator-owns rule in fireIfStill still applies on top: a terminal the operator typed into
 * three minutes ago is his whoever opened it.
 */
export function leadGraceMs(kind: DriveKind, s: Pick<Session, "lead_id"> | undefined): number {
  const base = graceMs(kind);
  return resolveLead(s?.lead_id) ? Math.min(base, Math.max(0, CONFIG.leadDrive.graceSec) * 1000) : base;
}

/** The operator typed into it this recently → it is his, Robert stays out. */
export const OPERATOR_OWNS_MS = 3 * 60_000;
const HOUR = 60 * 60_000;
/** A stop older than this when first seen is a parked terminal, not news. */
export const maxAgeMs = () => Math.max(1, CONFIG.robertDrive.maxAgeHours) * HOUR;

const id8 = (id: string) => id.slice(0, 8);
const goalOf = (s: Pick<Session, "goal" | "spawn_goal">) => (s.goal ?? s.spawn_goal ?? "").trim();

/**
 * Which stop this status is, if any. Pure: the whole "does this wake Robert" table, testable
 * without a daemon.
 */
export function driveKind(
  st: Pick<TermStatus, "phase" | "on">,
  ctx: {
    hasWorkspace: boolean;
    hasGoal: boolean;
    openAsk: boolean;
    declared: string | null;
    promptTracked: boolean;
    /** This stopped terminal is itself a Lead (LEADS.md), not a plain worker. */
    isLead?: boolean;
    /**
     * Only meaningful when isLead: at least one of its live workers is actually WORKING — see
     * `isStopped` for where that line falls (a worker waiting on CI or its own subagents is working).
     * Deliberately not "has live workers": a Lead whose six workers are all sitting on finished turns
     * is the single most stuck thing on the wall, and `has live workers` suppressed exactly that case
     * forever (nothing else ever wakes a Lead — its workers wake IT).
     */
    leadHasWorkingWorkers?: boolean;
  },
): DriveKind | null {
  // No client or no goal = the operator's own scratch window: nothing for Robert to judge against.
  if (!ctx.hasWorkspace || !ctx.hasGoal) return null;
  switch (st.phase) {
    case "review":
      return "review";
    case "your_turn":
      // A Lead sitting idle while its workers are still WORKING is doing its job, not stuck — it is
      // waiting on them (LEADS.md wake routing). Once every live worker is itself stopped, the whole
      // group is waiting on the Lead and the Lead is waiting on nobody: a normal turn stop.
      if (ctx.isLead && ctx.leadHasWorkingWorkers) return null;
      return "turn";
    case "decide":
      // An open ask is ask-robert's (escalated → already the operator's); a menu on screen is
      // terminal-prompts' once it has picked it up.
      return ctx.openAsk || ctx.promptTracked ? null : "decide";
    case "blocked":
      // Only what the AGENT declared. A daemon block (stall supervisor, auth wall) has its own owner.
      return ctx.declared === "blocked" ? "blocked" : null;
    case "waiting":
      return st.on === "robert" && !ctx.openAsk ? "robert" : null;
    default:
      return null;
  }
}

const robertWakeExists = (key: string): boolean =>
  !!db.prepare("SELECT 1 FROM robert_wakes WHERE key = ? LIMIT 1").get(key);

export const driveKey = (sessionId: string, phase: string, since: number) =>
  `${TERMINAL_DRIVE_KEY}${sessionId}:${phase}:${since}`;

/** Rolling-hour caps. Pure over the timestamps so the window is testable. */
export function underCaps(
  perSession: number[],
  global: number[],
  nowMs: number,
  caps = { perSession: CONFIG.robertDrive.perSessionHour, global: CONFIG.robertDrive.globalHour },
): boolean {
  const n = (xs: number[]) => xs.filter((t) => nowMs - t < HOUR).length;
  return n(perSession) < caps.perSession && n(global) < caps.global;
}

/**
 * What the terminal last said. `keepNewlines` is the difference between the two audiences: a wake
 * typed into a pty is flattened by sendInput anyway, so Robert's copy collapses all whitespace; an
 * inbox row is READ (`mc lead inbox`), and a worker's result loses its shape without its line breaks.
 */
function lastWords(id: string, keepNewlines = false): { result: string | null; said: string | null } {
  let result: string | null = null;
  let said: string | null = null;
  try {
    const evs = focusEvents(id);
    for (let i = evs.length - 1; i >= 0 && (!result || !said); i--) {
      const e = evs[i];
      if (e.kind === "user") break;
      if (!result && e.kind === "result") result = e.text;
      if (!said && (e.kind === "say" || e.kind === "understanding")) said = e.text;
    }
  } catch {}
  const flat = (t: string) =>
    keepNewlines ? t.replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n") : t.replace(/\s+/g, " ");
  const cut = (t: string | null) => (t ? flat(t).trim().slice(0, 1200) : null);
  return { result: cut(result), said: cut(said) };
}

/**
 * What Robert is told. The queue adds OP_PREFIX and the "you are being woken" tail.
 *
 * A Lead is no longer told anything HERE: its workers' stops are inbox rows it pulls (`mc lead wait`),
 * and the one thing ever typed at it is the digest (digestText). This text is reached for a Lead's
 * workers only on the escalation path — when the Lead could not take them and they became Robert's.
 */
/**
 * When a worker's Lead has ended, Robert gets the dead Lead's goal + board so the stop is not an
 * orphan card with no context. Null when the terminal has no lead_id, or its Lead is still live.
 */
export function orphanLeadLine(s: { lead_id?: string | null }): string | null {
  if (!s.lead_id) return null;
  if (resolveLead(s.lead_id)) return null;
  const dead = sessions.get(s.lead_id);
  if (!dead || dead.role !== "lead") return null;
  const tally = leadSlices.tally(dead.id);
  const goal = goalOf(dead) || "(no goal)";
  return (
    `ORPHAN — its Lead \`${id8(dead.id)}\` ended (goal: ${goal}; board ${tally.done}/${tally.total}). ` +
    `Adopt with \`mc lead adopt ${id8(dead.id)}\` from a new Lead in the same workspace, or drive this worker yourself.\n`
  );
}

export function driveSay(
  s: Pick<Session, "id" | "goal" | "spawn_goal" | "workspace_id"> & { lead_id?: string | null },
  kind: DriveKind,
  st: Pick<TermStatus, "line">,
  words: { result: string | null; said: string | null },
  wsName: string,
  /** Set only when the STOPPED terminal is itself a Lead: how many live workers it has, all of them
   *  stopped (that is the only shape in which a Lead's idle turn reaches here — see driveKind). */
  leadWorkers: number | null = null,
): string {
  const head: Record<DriveKind, string> = {
    review: "a terminal says its GOAL IS DONE and is waiting for someone to check it.",
    turn: "a terminal FINISHED ITS TURN and has been sitting idle — nobody has told it what's next.",
    decide: "a terminal is waiting on a DECISION and nobody has taken it.",
    blocked: "a terminal declared itself BLOCKED.",
    robert: "a terminal says it is WAITING ON YOU (Robert) — it declared `mc state waiting --on robert`.",
  };
  const goal = goalOf(s) || "(no goal)";
  const orphan = orphanLeadLine(s);
  const follow =
    `Follow DRIVING THE WALL in your instructions. Look first: \`mc session focus ${id8(s.id)}\`. Then make the ` +
    `call — tell it the next step (\`mc session send ${id8(s.id)} "..."\`), close it when the goal is truly met, ` +
    `or hand it to the operator in one line with your recommendation.`;
  return (
    `${head[kind]}\n` +
    `TERMINAL — \`${id8(s.id)}\` · ${wsName} · ${goal}\n` +
    `FULL ID (for endpoints): ${s.id}\n` +
    (leadWorkers
      ? `THIS IS A LEAD; its ${leadWorkers} workers are all stopped and waiting on it.\n`
      : "") +
    (orphan ?? "") +
    `ITS CARD SAYS: ${st.line || "(nothing)"}\n` +
    (words.result ? `ITS LAST RESULT: ${words.result}\n` : words.said ? `IT LAST SAID: ${words.said}\n` : "") +
    follow + ` Say in one line what you did.`
  );
}

// ──────────────────────────── state ────────────────────────────

const timers = new Map<string, { key: string; kind: DriveKind; at: number; t: NodeJS.Timeout }>();
const operatorTyped = new Map<string, number>();
const perSession = new Map<string, number[]>();
let global: number[] = [];
/** Failed digests per Lead. At LEAD_RETRY_MAX its pending stops stop being its and go to Robert. */
const digestRetries = new Map<string, number>();
/** Lead wake budget, tracked apart from Robert's perSession/global on purpose (CONFIG.leadDrive). */
const leadPerWorker = new Map<string, number[]>();
const leadPerLead = new Map<string, number[]>();
/** Per-Lead pacing: when the next keystroke to this Lead may be written, and the timers waiting to. */
const leadNextSlot = new Map<string, number>();
const leadSendTimers = new Set<NodeJS.Timeout>();
/** The Lead currently blocked in `mc lead wait`, one per Lead — see waitForLeadEvents. */
const leadWaiters = new Map<string, { resolve: (evs: LeadEvent[]) => void; timer: NodeJS.Timeout }>();
/** The armed digest per Lead, with the moment it will fire (so a debounce can move it). */
const digestTimers = new Map<string, { at: number; t: NodeJS.Timeout }>();

export function resetRobertDriveState(): void {
  for (const { t } of timers.values()) clearTimeout(t);
  timers.clear();
  for (const t of leadSendTimers) clearTimeout(t);
  leadSendTimers.clear();
  for (const { t } of digestTimers.values()) clearTimeout(t);
  digestTimers.clear();
  for (const leadId of [...leadWaiters.keys()]) closeLeadWaiter(leadId, []);
  operatorTyped.clear();
  perSession.clear();
  global = [];
  digestRetries.clear();
  leadPerWorker.clear();
  leadPerLead.clear();
  leadNextSlot.clear();
  leadGapMs = LEAD_GAP_MS;
  digestMs = null;
}

/** Test seam: what the daemon sees of a terminal at fire time. */
type Probe = (id: string) => TermStatus | null;
let probe: Probe = (id) => statusOf(id);
export function setDriveProbe(fn: Probe): void { probe = fn; }
/** When anyone last typed into it (operator, Robert, a tap). Null after a daemon restart. */
type InputProbe = (id: string) => { lastIn: number | null; lastOut: number | null };
let lastInput: InputProbe = (id) => {
  const a = sessionActivity(id);
  return { lastIn: a.last_in, lastOut: a.last_out };
};
export function setDriveInputProbe(fn: InputProbe): void { lastInput = fn; }
/**
 * Test seam: typing a wake into a Lead's pty, in place of `sendInput` — tests drive it without a pty.
 * Returns exactly what `sendInput` returns: null on success, or the reason it did not happen ("terminal
 * is not live", "rate limit — …"). Ignoring that string is how a Lead wake used to be marked delivered
 * and dropped in the same breath.
 */
type SendProbe = (id: string, text: string, opts: { by: string }) => string | null;
let sendProbe: SendProbe = (id, text, opts) => sendInput(id, { text }, opts.by);
export function setDriveSendProbe(fn: SendProbe): void { sendProbe = fn; }

/**
 * The same stop already woke him. A restart re-derives `since`, so the key alone would wake him again
 * about every idle terminal on every deploy: a previous wake for this terminal and phase with nobody
 * typing into it since is the same stop.
 */
export function alreadyWoken(sessionId: string, phase: string, act: { lastIn: number | null; lastOut: number | null }): boolean {
  const latest = (pattern: string) =>
    (db.prepare("SELECT created_at FROM robert_wakes WHERE key LIKE ? ORDER BY generation DESC LIMIT 1").get(pattern) as
      | { created_at: string }
      | undefined)?.created_at;
  const before = (t: number | null, iso: string) => t == null || t < Date.parse(iso);
  const same = latest(`${TERMINAL_DRIVE_KEY}${sessionId}:${phase}:%`);
  if (same && before(act.lastIn, same)) return true;
  // Any earlier wake, and the terminal neither printed nor was typed into since: nothing happened IN
  // it — the change is Robert's own doing (he ticked it done, declared for it). Not a new stop.
  const any = latest(`${TERMINAL_DRIVE_KEY}${sessionId}:%`);
  return !!any && before(act.lastIn, any) && before(act.lastOut, any);
}

// ──────────────────────────── leads (LEADS.md) ────────────────────────────

/** The live Lead that owns this terminal, if any — null when it has no `lead_id`, or that Lead has
 *  since ended or is no longer a Lead. `lead_id` is stamped by the daemon from the `x-mc-lead`
 *  credential at POST /sessions (api.ts) and can never be asserted by the worker itself. */
export function resolveLead(leadId: string | null | undefined): Session | null {
  if (!leadId) return null;
  const lead = sessions.get(leadId);
  return lead && lead.status === "live" && lead.role === "lead" ? lead : null;
}

/** Phases in which a terminal is waiting on a PERSON rather than doing the work. */
const STOP_PHASES: ReadonlySet<string> = new Set(["your_turn", "review", "decide", "blocked", "ended"]);
/** `waiting --on X` where X resumes the terminal by itself (term-status.ts WAIT_ON): work is still in
 *  flight and nobody has to do anything. The rest — robert, person, terminal, other — need a hand. */
const SELF_RESUMING: ReadonlySet<string> = new Set(["subagents", "ci", "command", "deploy"]);

/**
 * Is this terminal waiting on somebody, as opposed to working? Pure, so the whole table is testable.
 *
 * `waiting` is the subtle one: a worker waiting on its own subagents, on CI, on a command it ran or
 * on a deploy comes back BY ITSELF, so its Lead sitting idle meanwhile is doing its job — counting
 * those as stops would wake Robert about a Lead with nothing wrong with it. No status at all is NOT
 * a stop either: unknown is not evidence that everything has frozen.
 */
export function isStopped(st: Pick<TermStatus, "phase" | "on"> | null | undefined): boolean {
  if (!st) return false;
  if (st.phase === "waiting") return !st.on || !SELF_RESUMING.has(st.on);
  return STOP_PHASES.has(st.phase);
}

/**
 * How long a report stands in for the stop that follows it. Short on purpose: it covers the seconds
 * between `mc report` and the turn ending, not a worker that reported an hour ago and has since
 * stopped again with something new to say.
 */
export const REPORT_SUPPRESS_MS = 2 * 60_000;

/** Is this worker's stop already covered by a report its Lead has not acted on yet? Pure over the row. */
export function reportSupersedes(leadId: string, sessionId: string, nowMs = Date.now()): boolean {
  const last = leadEvents.lastUnacked(leadId, sessionId, "report");
  if (!last) return false;
  // A WINDOW, not a ceiling: a row timestamped ahead of `nowMs` (a clock that stepped back, a caller
  // working from a fixed instant) would otherwise read as forever-fresh and mute that worker's stops.
  const age = nowMs - Date.parse(last.created_at);
  return age >= 0 && age < REPORT_SUPPRESS_MS;
}

/** This Lead's live workers, and how many of them are still working (see driveKind's leadHasWorkingWorkers). */
function leadWorkers(leadId: string): { live: Session[]; working: number } {
  const live = sessions.workersOf(leadId, { status: "live" });
  return { live, working: live.filter((w) => !isStopped(probe(w.id))).length };
}

function context(s: Session) {
  const isLead = s.role === "lead";
  return {
    hasWorkspace: !!s.workspace_id,
    hasGoal: !!goalOf(s),
    openAsk: asks.openForSession(s.id).length > 0,
    declared: signalsOf(s.id).declared?.state ?? null,
    promptTracked: promptTracked(s.id),
    isLead,
    leadHasWorkingWorkers: isLead && leadWorkers(s.id).working > 0,
  };
}

/** Delivery is not this Lead's to take right now (or ever): hand the stop back to Robert. */
const ESCALATE = Symbol("escalate-to-robert");
/** Milliseconds between two keystrokes typed into the SAME Lead — see paceToLead. */
export const LEAD_GAP_MS = 600;
let leadGapMs = LEAD_GAP_MS;
/** Test seam: drive many wakes at one Lead without waiting real seconds per keystroke. Restored to
 *  LEAD_GAP_MS by resetRobertDriveState, so nothing can leave the daemon typing at full speed. */
export function setLeadGapMs(ms: number): void { leadGapMs = Math.max(0, ms); }
const LEAD_RETRY_MS = 30_000;
export const LEAD_RETRY_MAX = 5;
/** Test seam: the digest windows, in ms, without waiting the configured seconds. Null = CONFIG, which
 *  resetRobertDriveState restores — nothing can leave the daemon digesting on a zero debounce. */
let digestMs: { debounce: number; maxWait: number } | null = null;
export function setLeadDigestMs(debounce: number, maxWait: number): void {
  digestMs = { debounce: Math.max(0, debounce), maxWait: Math.max(0, maxWait) };
}
const digestDebounceMs = () => digestMs?.debounce ?? CONFIG.leadDrive.digestDebounceSec * 1000;
const digestMaxWaitMs = () => digestMs?.maxWait ?? CONFIG.leadDrive.digestMaxWaitSec * 1000;

/**
 * Two wakes typed into one Lead less than 200ms apart merged into a single line: `sendInput` writes
 * the text immediately and Enter 200ms later, so the second wake's text lands INSIDE the first one's
 * pending line. A tiny per-Lead FIFO — every keystroke to a Lead is spaced at least LEAD_GAP_MS from
 * the last — is the whole fix. Immediate when the Lead has been quiet, which keeps the common path
 * (and most tests) synchronous.
 */
function paceToLead(leadId: string, run: () => void): void {
  const now = Date.now();
  const at = Math.max(now, leadNextSlot.get(leadId) ?? 0);
  leadNextSlot.set(leadId, at + leadGapMs);
  if (at <= now) return run();
  const t = setTimeout(() => { leadSendTimers.delete(t); run(); }, at - now);
  t.unref?.();
  leadSendTimers.add(t);
}

/** A previous lead wake for this session+phase that nothing has answered since — mirrors alreadyWoken()
 *  over `lead_wakes`, because a restart re-derives `since` and would otherwise re-wake every Lead about
 *  every worker still sitting on the stop it was already told about. */
export function leadAlreadyWoken(
  sessionId: string,
  phase: string,
  act: { lastIn: number | null; lastOut: number | null },
): boolean {
  const latest = (pattern: string) =>
    (db.prepare("SELECT created_at FROM lead_wakes WHERE key LIKE ? ORDER BY created_at DESC LIMIT 1").get(pattern) as
      | { created_at: string }
      | undefined)?.created_at;
  const before = (t: number | null, iso: string) => t == null || t < Date.parse(iso);
  const same = latest(`${TERMINAL_DRIVE_KEY}${sessionId}:${phase}:%`);
  if (same && before(act.lastIn, same)) return true;
  const any = latest(`${TERMINAL_DRIVE_KEY}${sessionId}:%`);
  return !!any && before(act.lastIn, any) && before(act.lastOut, any);
}

/** The Lead itself is on a question right now — typing a wake at it would answer that question with a
 *  paragraph about a worker. `working`/`your_turn` are fine: Claude Code queues input mid-turn. */
function leadBusy(leadId: string): string | null {
  if (promptTracked(leadId)) return "the lead is on a prompt terminal-prompts owns";
  const st = probe(leadId);
  if (st && (st.phase === "decide" || st.phase === "blocked")) return `the lead is itself ${st.phase}`;
  return null;
}

// ──────────────────────── the Lead's inbox: pull first, push a digest ────────────────────────

/** What an inbox row carries, so `mc lead inbox` reads without going back to the daemon per event. */
export type LeadEventPayload = {
  id8: string;
  goal: string | null;
  card_line: string | null;
  last_result: string | null;
  last_said: string | null;
  phase: string;
  progress: { n: number; of: number } | null;
};

export function leadEventPayload(ev: Pick<LeadEvent, "payload">): Partial<LeadEventPayload> {
  try {
    return ev.payload ? (JSON.parse(ev.payload) as LeadEventPayload) : {};
  } catch {
    return {};
  }
}

function eventPayload(s: Session, st: Pick<TermStatus, "line" | "phase" | "progress">): LeadEventPayload {
  // Newlines preserved: this is READ on a screen (`mc lead inbox`), not typed into a pty.
  const words = lastWords(s.id, true);
  return {
    id8: id8(s.id),
    goal: goalOf(s) || null,
    card_line: st.line || null,
    last_result: words.result,
    last_said: words.said,
    phase: st.phase,
    progress: st.progress ?? null,
  };
}

/** The one word the digest uses per kind. `turn` reads FINISHED because that is what the Lead sees. */
const DIGEST_LABEL: Record<string, string> = {
  review: "REVIEW", turn: "FINISHED", decide: "DECIDE", blocked: "BLOCKED", robert: "WAITING", ended: "ENDED",
  report: "REPORT", ask: "ASK",
};
const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

/**
 * The ONE line typed into a Lead that was not pulling. Deliberately one line: sendInput flattens
 * newlines anyway, and the point is to spend one Lead turn on N stops instead of N turns — what each
 * worker actually said stays in the inbox, which costs nothing to read.
 *
 * A `report` and an `ask` name what they are ABOUT rather than the worker's goal: a Lead that opened
 * seven workers off one board already knows each one's goal, and what it does not know is which one
 * just said it was blocked on a migration.
 */
export function digestText(evs: LeadEvent[]): string {
  const list = evs
    .map((e) => {
      const p = leadEventPayload(e) as Partial<LeadEventPayload> & {
        state?: string; summary?: string; question?: string;
      };
      const label = DIGEST_LABEL[e.kind] ?? e.kind.toUpperCase();
      const who = p.id8 ?? id8(e.session_id);
      if (e.kind === "report") return `${who} ${label} ${p.state ?? "?"} — ${clip(p.summary ?? "(no summary)", 80)}`;
      if (e.kind === "ask") return `${who} ${label} — ${clip(p.question ?? "(no question)", 80)}`;
      return `${who} ${label} — ${clip(p.goal ?? "(no goal)", 60)}`;
    })
    .join(" · ");
  // "stopped" is only true of a stop: a worker that filed an `ask` is sitting blocked on an answer
  // from THIS Lead, and telling it that worker stopped would send it to read a screen instead.
  const verb = evs.every((e) => e.kind !== "report" && e.kind !== "ask") ? "stopped" : "need you";
  return (
    `${evs.length} of your workers ${verb}: ${list} ` +
    "Run `mc lead inbox` for what each one said, then `mc lead wait` instead of sleeping."
  );
}

/** `lead_wakes` is still "the Lead was TOLD about this stop" — now written the moment it is handed
 *  over (pulled or digested) rather than when a keystroke lands, so leadAlreadyWoken keeps meaning
 *  exactly what it meant in #394 across a restart. */
function noteLeadWakes(leadId: string, evs: LeadEvent[]): void {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO lead_wakes (key,lead_id,session_id,kind,created_at) VALUES (?,?,?,?,?)",
  );
  const ts = new Date().toISOString();
  for (const e of evs) if (e.key) stmt.run(e.key, leadId, e.session_id, e.kind, ts);
}

function clearDigest(leadId: string): void {
  const prev = digestTimers.get(leadId);
  if (prev) { clearTimeout(prev.t); digestTimers.delete(leadId); }
}

/** Hand these to the Lead: seen, remembered in `lead_wakes`, and nothing left for a digest to type. */
function takeSeen(leadId: string, evs: LeadEvent[]): LeadEvent[] {
  leadEvents.markSeen(evs.map((e) => e.id));
  noteLeadWakes(leadId, evs);
  clearDigest(leadId);
  // Re-read, so what the caller hands the Lead carries the `seen_at` it was just given rather than
  // the null it was read with.
  return evs.map((e) => leadEvents.get(e.id) ?? e);
}

function closeLeadWaiter(leadId: string, evs: LeadEvent[]): boolean {
  const w = leadWaiters.get(leadId);
  if (!w) return false;
  clearTimeout(w.timer);
  leadWaiters.delete(leadId);
  w.resolve(evs);
  return true;
}

/**
 * The long-poll behind `GET /api/leads/me/events/wait` (`mc lead wait`) — the whole reason the inbox
 * exists. A Lead blocked here costs nothing while it waits and is handed its workers' stops the
 * instant they land; before this, a real Lead polled with `sleep 40; mc session focus <id>` in a loop.
 *
 * One waiter per Lead: a second request replaces the first, which resolves empty rather than hanging
 * on a socket nobody is reading. `cancel` belongs to THIS waiter only, so a disconnect cannot close
 * the waiter a newer request registered.
 */
export function waitForLeadEvents(
  leadId: string,
  timeoutMs: number,
): { events: Promise<LeadEvent[]>; cancel: () => void } {
  const pending = leadEvents.unseen(leadId);
  if (pending.length) return { events: Promise.resolve(takeSeen(leadId, pending)), cancel: () => {} };
  closeLeadWaiter(leadId, []);
  let mine: { resolve: (evs: LeadEvent[]) => void; timer: NodeJS.Timeout };
  const events = new Promise<LeadEvent[]>((resolve) => {
    const timer = setTimeout(() => { leadWaiters.delete(leadId); resolve([]); }, timeoutMs);
    timer.unref?.();
    mine = { resolve, timer };
    leadWaiters.set(leadId, mine);
  });
  return { events, cancel: () => { if (leadWaiters.get(leadId) === mine) closeLeadWaiter(leadId, []); } };
}

/**
 * An event landed. A Lead that is pulling gets it now and NOTHING is typed; a Lead that is not gets
 * one debounced digest. This is the whole push/pull decision, in one place.
 */
export function notifyLead(leadId: string): void {
  const evs = leadEvents.unseen(leadId);
  if (!evs.length) return;
  if (leadWaiters.has(leadId)) { closeLeadWaiter(leadId, takeSeen(leadId, evs)); return; }
  scheduleDigest(leadId, evs);
}

/**
 * Wait `digestDebounceSec` from the newest unseen event for its siblings to land, but never hold the
 * oldest longer than `digestMaxWaitSec`: five workers finishing together are one message, and a slow
 * trickle still reaches the Lead inside twenty seconds.
 *
 * An `ended` worker never arms this on its own — it is news a waiting Lead should have immediately
 * and nothing to interrupt a working Lead for. It rides along in the next digest that IS sent.
 */
function scheduleDigest(leadId: string, evs: LeadEvent[]): void {
  if (!evs.some((e) => e.kind !== "ended")) return;
  const nowMs = Date.now();
  const oldest = Math.min(...evs.map((e) => Date.parse(e.created_at)));
  const at = Math.min(nowMs + digestDebounceMs(), oldest + digestMaxWaitMs());
  clearDigest(leadId);
  const t = setTimeout(() => {
    digestTimers.delete(leadId);
    try { sendDigest(leadId); } catch (e) { console.error("[lead-drive]", e); }
  }, Math.max(0, at - nowMs));
  t.unref?.();
  digestTimers.set(leadId, { at, t });
}

function sendDigest(leadId: string): void {
  const lead = sessions.get(leadId);
  if (!lead || lead.status !== "live" || lead.role !== "lead") return;
  if (!leadEvents.unseen(leadId).some((e) => e.kind !== "ended")) return;
  paceToLead(leadId, () => {
    // Re-read: the Lead may have pulled its inbox, or steered those workers itself, while this
    // keystroke sat behind the pacing gap. Either way there is nothing left to tell it.
    const batch = leadEvents.unseen(leadId);
    if (!batch.some((e) => e.kind !== "ended")) return;
    const err = leadBusy(leadId) ?? sendProbe(leadId, digestText(batch), { by: "daemon" });
    if (err) return digestFailed(leadId, err);
    const at = Date.now();
    leadEvents.markDelivered(batch.map((e) => e.id));
    noteLeadWakes(leadId, batch);
    digestRetries.delete(leadId);
    // Both windows re-READ here, at write time — #394's fix, and the reason a burst cannot walk past
    // the Lead's hour. A digest is ONE keystroke burst, so it costs the Lead one; each stop in it
    // still costs its own worker one, which is what caps a single worker that keeps bouncing.
    const keep = (xs: number[]) => xs.filter((t) => at - t < HOUR);
    leadPerLead.set(leadId, keep([...(leadPerLead.get(leadId) ?? []), at]));
    for (const e of batch) {
      if (e.kind === "ended") continue;
      leadPerWorker.set(e.session_id, keep([...(leadPerWorker.get(e.session_id) ?? []), at]));
    }
    console.log(`[lead-drive] digested ${batch.length} event(s) into lead ${id8(leadId)}`);
  });
}

/** The digest did not land. Retry in 30s; at LEAD_RETRY_MAX every pending stop becomes Robert's. */
function digestFailed(leadId: string, why: string): void {
  const tries = (digestRetries.get(leadId) ?? 0) + 1;
  digestRetries.set(leadId, tries);
  if (tries >= LEAD_RETRY_MAX) return escalateBatch(leadId, `${LEAD_RETRY_MAX} failed digests (${why})`);
  console.warn(`[lead-drive] digest failed (${why}) — retry ${tries}/${LEAD_RETRY_MAX} in 30s for lead ${id8(leadId)}`);
  clearDigest(leadId);
  const t = setTimeout(() => {
    digestTimers.delete(leadId);
    try { sendDigest(leadId); } catch (e) { console.error("[lead-drive]", e); }
  }, LEAD_RETRY_MS);
  t.unref?.();
  digestTimers.set(leadId, { at: Date.now() + LEAD_RETRY_MS, t });
}

/**
 * A Lead that cannot be typed into is a Lead that is not driving, which is precisely when Robert
 * should hear about its workers. Every pending STOP goes to him with the wording he expects; the
 * whole batch is marked delivered (typed or not) so the same stop is never escalated twice, and
 * `ended` is never escalated at all — a closed terminal is nobody's turn.
 */
function escalateBatch(leadId: string, why: string): void {
  const batch = leadEvents.unseen(leadId);
  // Only a real STOP has somewhere to go: `ended` is nobody's turn, and a kind Robert has no wake
  // shape for (PR 3's `report`/`ask`) must not reach him as an undefined headline.
  const stops = batch.filter((e) => DRIVE_KINDS.has(e.kind) && !e.delivered_at);
  for (const ev of stops) escalateEvent(ev);
  leadEvents.markDelivered(batch.map((e) => e.id));
  digestRetries.delete(leadId);
  clearDigest(leadId);
  if (stops.length)
    console.warn(`[lead-drive] ${why} — ${stops.length} stop(s) escalated to Robert (lead ${id8(leadId)})`);
}

/** One inbox row, queued for Robert exactly as fireIfStill would have if the worker had no Lead. */
function escalateEvent(ev: LeadEvent): void {
  const s = sessions.get(ev.session_id);
  if (!s || !ev.key) return;
  const p = leadEventPayload(ev);
  const wsName = s.workspace_id ? workspaces.get(s.workspace_id)?.name ?? "?" : "unscoped";
  enqueueWake({
    topic: `session.${ev.kind}`,
    key: ev.key,
    subject: `session:${ev.session_id}`,
    workspace_id: s.workspace_id,
    payload: {
      say: driveSay(
        s,
        ev.kind as DriveKind,
        { line: p.card_line ?? "" },
        { result: p.last_result ?? null, said: p.last_said ?? null },
        wsName,
      ),
      session_id: ev.session_id,
      kind: ev.kind,
    },
  });
}

/**
 * A worker of this Lead stopped. It becomes a ROW, not a keystroke: the Lead pulls it (`mc lead
 * wait`) or gets it in the next digest (notifyLead).
 *
 * Returns the synthetic wake id when the stop is the Lead's, null when it is not news, and ESCALATE
 * when it must go to Robert after all (the Lead is over its hour). Every guard #394 put here is
 * unchanged — only the delivery is.
 */
function fireToLead(
  s: Session,
  lead: Session,
  kind: DriveKind,
  st: TermStatus,
  key: string,
  nowMs: number,
): string | null | typeof ESCALATE {
  if (leadAlreadyWoken(s.id, st.phase, lastInput(s.id))) return null;
  // `mc report` and the turn ending seconds later are ONE moment. The report is the better half of
  // it — structured, written on purpose — so the scraped stop behind it is dropped rather than
  // queued, or the Lead would read the same worker twice in one digest and answer it twice.
  if (reportSupersedes(lead.id, s.id, nowMs)) return null;
  // Read for the cap decision only — the digest re-reads both windows before writing.
  const caps = { perSession: CONFIG.leadDrive.perWorkerHour, global: CONFIG.leadDrive.perLeadHour };
  if (!underCaps(leadPerWorker.get(s.id) ?? [], leadPerLead.get(lead.id) ?? [], nowMs, caps)) {
    console.warn(`[lead-drive] cap reached — escalated to Robert (${id8(s.id)} ${kind} → lead ${id8(lead.id)})`);
    return ESCALATE;
  }
  // A restart re-derives `since`, so the SAME stop can arrive under a new key. An unseen row already
  // queued for this worker and kind is that stop: reuse its key so `add` dedupes onto it (and takes
  // the fresher payload) instead of naming the worker twice in one digest.
  const queued = leadEvents.unseen(lead.id).find((e) => e.session_id === s.id && e.kind === kind);
  leadEvents.add({
    lead_id: lead.id,
    session_id: s.id,
    kind,
    key: queued?.key ?? key,
    payload: eventPayload(s, st),
  });
  notifyLead(lead.id);
  return `lead:${key}`;
}

/** A worker of a live Lead closed. Its Lead should know without being interrupted for it. */
export function noteWorkerEnded(sessionId: string): void {
  const s = sessions.get(sessionId);
  const lead = resolveLead(s?.lead_id);
  if (!s || !lead) return;
  const words = lastWords(s.id, true);
  leadEvents.add({
    lead_id: lead.id,
    session_id: s.id,
    kind: "ended",
    key: null,
    payload: {
      id8: id8(s.id), goal: goalOf(s) || null, card_line: s.end_reason ?? null,
      last_result: words.result, last_said: words.said, phase: "ended", progress: null,
    },
  });
  notifyLead(lead.id);
}

/**
 * The Lead typed into one of its own workers → that worker's events are answered, whether or not the
 * Lead had read them. It plainly knows that worker stopped: it just steered it. Without this, a Lead
 * working its way down the wall would be digested about the very stops it was in the middle of
 * clearing. `operator`/`daemon` are excluded: the operator at the wall and the daemon's own digest are
 * not an answer to the stop. Robert's hand counts — if he answered an escalated worker, that stop is
 * settled and the Lead's inbox should say so.
 */
export function noteLeadTyped(sessionId: string, by: string): void {
  if (!by || by === "operator" || by === "daemon") return;
  const s = sessions.get(sessionId);
  const lead = resolveLead(s?.lead_id);
  if (!lead) return;
  if (!leadEvents.ackForWorker(lead.id, sessionId)) return;
  if (!leadEvents.unseen(lead.id).some((e) => e.kind !== "ended")) clearDigest(lead.id);
}

/**
 * Enqueue now if this status still warrants a wake. Returns the wake id, or null with the guard that
 * said no left to the caller's imagination — every guard here is a reason Robert should stay quiet.
 */
export function fireIfStill(sessionId: string, key: string, nowMs = Date.now()): string | null {
  const s = sessions.get(sessionId);
  const st = probe(sessionId);
  if (!s || !st || s.status !== "live") return null;
  if (driveKey(sessionId, st.phase, st.since) !== key) return null; // moved on during the grace
  if (nowMs - st.since > maxAgeMs()) return null;
  const kind = driveKind(st, context(s));
  if (!kind) return null;
  if (nowMs - (operatorTyped.get(sessionId) ?? 0) < OPERATOR_OWNS_MS) return null;
  if (failoverOwns(sessionId)) return null;
  // A Lead's worker stopping is the Lead's news, not Robert's (LEADS.md: "A Lead's workers stop → the
  // Lead is woken, not Robert"). Same grace and operator-owns checks above; its own dedupe/caps below.
  // ESCALATE = the Lead could not take it (over its hour) → Robert, as if it had no Lead at all. A
  // digest that never lands escalates later, from the digest itself (escalateBatch).
  const lead = resolveLead(s.lead_id);
  if (lead) {
    const out = fireToLead(s, lead, kind, st, key, nowMs);
    if (out !== ESCALATE) return out;
  }
  // Same stop re-armed (a second status event): the queue absorbs it as a repeat, and it is not a new
  // wake for the caps.
  const repeat = robertWakeExists(key);
  if (!repeat && alreadyWoken(sessionId, st.phase, lastInput(sessionId))) return null;
  const mine = perSession.get(sessionId) ?? [];
  if (!repeat && !underCaps(mine, global, nowMs)) {
    console.warn(`[robert-drive] cap reached — ${id8(sessionId)} ${kind} not sent`);
    return null;
  }
  const wsName = s.workspace_id ? workspaces.get(s.workspace_id)?.name ?? "?" : "unscoped";
  // A stopped LEAD tells Robert what its own workers are doing: an idle Lead only reaches him once
  // every one of them is stopped too, and that number is the whole reason the group is frozen.
  const stalled = s.role === "lead" ? leadWorkers(s.id).live.length : null;
  const id = enqueueWake({
    topic: `session.${kind}`,
    key,
    subject: `session:${sessionId}`,
    workspace_id: s.workspace_id,
    payload: {
      say: driveSay(s, kind, st, lastWords(sessionId), wsName, stalled),
      session_id: sessionId,
      kind,
    },
  });
  if (repeat) return id;
  mine.push(nowMs);
  perSession.set(sessionId, mine.filter((t) => nowMs - t < HOUR));
  global = [...global, nowMs].filter((t) => nowMs - t < HOUR);
  console.log(`[robert-drive] woke Robert: ${id8(sessionId)} ${kind}`);
  return id;
}

/** A status landed: arm (or disarm) this terminal's timer. */
export function onStatus(sessionId: string, st: TermStatus | null | undefined): void {
  if (!driveEnabled() || !st) return;
  const s = sessions.get(sessionId);
  armTimer(sessionId, st, s);
  // A Lead's own stop depends on what its WORKERS are doing (leadHasWorkingWorkers), and a Lead that
  // is idle emits no status of its own — so the last worker going quiet would arm nothing and the
  // whole group would sit there forever. Re-resolve the Lead's timer whenever one of its workers
  // moves. One level only: a Lead may not open a Lead, so `lead_id` on a Lead is always null.
  if (s?.lead_id) {
    const lead = resolveLead(s.lead_id);
    if (lead) onStatus(lead.id, probe(lead.id));
  }
}

function armTimer(sessionId: string, st: TermStatus, s: Session | undefined): void {
  const prev = timers.get(sessionId);
  const kind = s && s.status === "live" ? driveKind(st, context(s)) : null;
  if (!kind) {
    if (prev) { clearTimeout(prev.t); timers.delete(sessionId); }
    return;
  }
  const key = driveKey(sessionId, st.phase, st.since);
  if (prev?.key === key) return;
  if (prev) clearTimeout(prev.t);
  const wait = Math.max(0, st.since + leadGraceMs(kind, s) - Date.now());
  const t = setTimeout(() => {
    timers.delete(sessionId);
    try { fireIfStill(sessionId, key); } catch (e) { console.error("[robert-drive]", e); }
  }, wait);
  t.unref?.();
  timers.set(sessionId, { key, kind, at: Date.now() + wait, t });
}

/**
 * The wakes armed RIGHT NOW — one per terminal whose stop is inside its grace, soonest first.
 *
 * A read-only view of `timers`, added for the Desk's "Robert's attention" card: the armed wake is the
 * one part of driving the fleet that exists only in memory, so a surface that wants to show what he
 * is about to open has nowhere else to read it. Never mutates, never fires anything.
 */
export function armedWakes(): { session_id: string; kind: DriveKind; key: string; fire_at: number }[] {
  return [...timers.entries()]
    .map(([session_id, v]) => ({ session_id, kind: v.kind, key: v.key, fire_at: v.at }))
    .sort((a, b) => a.fire_at - b.fire_at);
}

export function noteDriveInput(sessionId: string, by: string, atMs = Date.now()): void {
  if (by === "operator") operatorTyped.set(sessionId, atMs);
}

export function startRobertDrive(): void {
  if (!driveEnabled()) {
    console.log("[robert-drive] off (CHRONOS_ROBERT_DRIVE=0) — finished terminals wait for the operator");
    return;
  }
  bus.on("event", (e: BusEvent) => {
    try {
      if (e.topic === "session.input") { noteDriveInput(e.session_id, e.by); noteLeadTyped(e.session_id, e.by); }
      else if (e.topic === "session.status") onStatus(e.session_id, e.status as TermStatus);
      else if (e.topic === "session.ended") {
        const p = timers.get(e.session_id);
        if (p) { clearTimeout(p.t); timers.delete(e.session_id); }
        // The ended terminal may be a Lead (drop its waiter and its pending digest — there is nobody
        // left to type at) or one of a Lead's workers (news for that Lead's inbox). Never both: a
        // Lead's own `lead_id` is null, because a Lead may not open a Lead.
        closeLeadWaiter(e.session_id, []);
        clearDigest(e.session_id);
        noteWorkerEnded(e.session_id);
        // A Lead that ends leaves its workers blocked on questions only it could answer. They become
        // Robert's now rather than at the next sweep — the worker is stopped the whole time. Late
        // import: lead-asks.ts reads notifyLead/resolveLead from this module.
        void import("./lead-asks.js")
          .then((m) => m.sweepLeadAsks())
          .catch((err) => console.error("[lead-ask]", err));
      }
    } catch (err) {
      console.error("[robert-drive]", err);
    }
  });
  // Lead wakes and inbox rows are a keystroke log, not an audit trail: 7 days is far longer than any
  // stop survives, and the only thing older rows could still do is suppress a wake about a terminal
  // nobody remembers.
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    const gone = db.prepare("DELETE FROM lead_wakes WHERE created_at < ?").run(cutoff).changes;
    if (gone) console.log(`[lead-drive] pruned ${gone} lead wake(s) older than 7 days`);
    const events = leadEvents.prune(7);
    if (events) console.log(`[lead-drive] pruned ${events} lead event(s) older than 7 days`);
  } catch (err) {
    console.error("[lead-drive] prune", err);
  }
  const c = CONFIG.robertDrive;
  const l = CONFIG.leadDrive;
  console.log(`[robert-drive] Robert woken on finished/review/decide/blocked/waiting-on-robert terminals (grace ${c.graceSec}s, ${c.perSessionHour}/terminal·h, ${c.globalHour}/h)`);
  console.log(`[lead-drive] a Lead's own workers file into its inbox (\`mc lead wait\`); a Lead that is not pulling gets one digest after ${l.digestDebounceSec}s (max ${l.digestMaxWaitSec}s), then Robert`);
}
