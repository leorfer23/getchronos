/**
 * What a Desk terminal is doing, in the seven words the operator triages by.
 *
 * Before this, a card had two honest signals — pty bytes (working) and pty silence (your turn) —
 * plus whatever the agent remembered to say with `mc state`. Silence could mean three different
 * things: the turn finished, the agent asked something, or it was waiting on subagents it had just
 * launched. All three painted the same amber dot, and the line under the title was whatever tool it
 * last called ("run sed -n '1160,1245p' …").
 *
 * Now three sources feed one resolver, strongest first:
 *   1. What the agent DECLARES (`mc state`, `mc progress`) — only it knows it is waiting on CI.
 *   2. Its CLI's lifecycle HOOKS (term-hooks.ts; claude, cursor and grok all have them) — a
 *      submitted prompt, a finished turn, a subagent starting or stopping, a question tool opening.
 *   3. The pty itself — bytes, silence, and the prompt read off the screen (desk-prompt.ts). The
 *      fallback, and the only source for a CLI whose hooks never fired.
 *
 * The phase and its one-liner are computed HERE, once, so the Desk, the phone and Robert read the
 * same answer instead of each re-deriving it from raw events.
 */
import { bus } from "./bus.js";
import { db, asks, sessions } from "./store.js";
import { clearAgentOverlay, getAgent, reportAgentState } from "./agent-lifecycle.js";
import { focusEvents, isLive, sessionActivity, sessionPrompt } from "./terminal.js";
import type { DeskPrompt } from "./desk-prompt.js";

export const PHASES = ["blocked", "decide", "review", "your_turn", "waiting", "working", "stalled"] as const;
export type Phase = (typeof PHASES)[number] | "ended";
/** What `mc state` may declare. `idle` clears a declaration; `done` is an alias of `review`. */
export type DeclaredState = "working" | "waiting" | "blocked" | "decide" | "review";
export const WAIT_ON = ["subagents", "ci", "terminal", "command", "robert", "person", "deploy", "other"] as const;
export type WaitOn = (typeof WAIT_ON)[number];

export type Signals = {
  declared?: { state: Exclude<DeclaredState, "working">; label: string | null; reason?: string | null; on?: WaitOn | null; eta_at?: number | null; at: number } | null;
  /** `mc state working "label"` — colour for the working line, never a phase of its own. */
  work_label?: { text: string; at: number } | null;
  progress?: { n: number; of: number; label: string | null; at: number } | null;
  /** Turn boundaries from hooks. Absent = this CLI's hooks never fired; trust the pty. */
  turn?: { state: "working" | "stopped"; at: number; error?: string | null } | null;
  subagents?: Record<string, { label: string; at: number }>;
  /**
   * kind "permission": a tool-permission gate (grok's PermissionRequest — fires even when
   * always-approve auto-answers it, per tool, with no matching PostToolUse/answered event behind
   * it). Self-clears on the very next hook call, since that proves the CLI moved on. A real
   * question (AskUserQuestion/ExitPlanMode, or Claude's own permission_prompt Notification) has no
   * kind and only clears on an explicit "answered"/"prompt"/"stop"/"session_end".
   */
  asking?: { question: string; options: string[]; at: number; kind?: "permission" } | null;
};

export type TermStatus = {
  phase: Phase;
  /** The one line under the title. Never a raw tool call. */
  line: string;
  /** Short word for the chip: "blocked", "decide", "review", "your turn", "waiting", "working", "stalled". */
  word: string;
  needs_you: boolean;
  /** When this phase began (ms). */
  since: number;
  on: WaitOn | null;
  eta_at: number | null;
  subagents: number;
  progress: { n: number; of: number } | null;
  /** True once any hook has been seen from this terminal. */
  hooked: boolean;
};

export const WORD: Record<Phase, string> = {
  blocked: "blocked", decide: "decide", review: "review", your_turn: "your turn",
  waiting: "waiting", working: "working", stalled: "stalled", ended: "ended",
};
const NEEDS_YOU = new Set<Phase>(["blocked", "decide"]);
/** Hooks said "working" but the pty has been silent this long: whatever it is doing, it is not working. */
export const HOOK_WORKING_SILENCE_MS = 45_000;
/** A subagent that never reported back stops counting after this. */
export const SUBAGENT_TTL_MS = 3 * 60 * 60 * 1000;
const REASON: Record<string, string> = {
  hitl: "needs you", approval: "approve?", question: "asked you", budget: "out of budget", gate: "gate",
  stall: "stalled", recovery: "recover?", review: "review", auth: "needs a login",
};

export type ResolveInput = {
  live: boolean;
  goalDone: boolean;
  goal: string | null;
  signals: Signals;
  quiet: boolean;
  lastOut: number | null;
  lastIn: number | null;
  prompt: DeskPrompt | null;
  /** An open `mc ask-robert` / `mc ask-lead` from this terminal. */
  ask: { question: string; options: string[]; escalated: boolean; route?: string } | null;
  /** A block the daemon itself set (stall supervisor, auth wall) — not the agent's declaration. */
  daemonBlock: { label: string | null; reason: string | null } | null;
  demandInspection: boolean;
  narration: string | null;
  result: string | null;
  now: number;
};

const clip = (s: string | null | undefined, n = 160) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
/** Markdown the agent wrote for its transcript reads as noise in a one-line card. */
export const plain = (s: string) =>
  s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/(\*\*|__|`)/g, "").replace(/^\s*(#+|[-*>]|\d+\.)\s+/gm, "")
    .replace(/^\s*\*{0,2}(summary|result|understanding|verdict|receipts)\*{0,2}\s*[:\-—]\s*/i, "");
const firstSentence = (s: string | null) => {
  const t = clip(plain(String(s ?? "")), 400);
  const m = /^(.{12,}?[.!?])(\s|$)/.exec(t);
  return clip(m ? m[1] : t);
};
function mins(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

/** Live subagents: the ones hooks saw start and not stop, minus the ones that went silent for hours. */
export function liveSubagents(sig: Signals, now: number): { label: string; at: number }[] {
  return Object.values(sig.subagents ?? {}).filter((s) => now - s.at < SUBAGENT_TTL_MS);
}

/**
 * A declaration holds until the agent says something else, or until the operator answered it: a
 * submitted prompt (hooks), or — for a CLI without hooks — typing followed by the agent working again.
 */
function declarationStands(inp: ResolveInput): boolean {
  const d = inp.signals.declared;
  if (!d) return false;
  const turn = inp.signals.turn;
  if (turn && turn.state === "working" && turn.at > d.at && turn.at - d.at > 1500) return false;
  if (!turn && inp.lastIn && inp.lastIn > d.at + 1500 && !inp.quiet && (inp.lastOut ?? 0) > inp.lastIn + 2000) return false;
  return true;
}

export function resolve(inp: ResolveInput): Omit<TermStatus, "since"> {
  const sig = inp.signals;
  const subs = liveSubagents(sig, inp.now);
  const hooked = !!sig.turn;
  const base = {
    on: null as WaitOn | null, eta_at: null as number | null, subagents: subs.length,
    progress: sig.progress ? { n: sig.progress.n, of: sig.progress.of } : null, hooked,
  };
  const out = (phase: Phase, line: string, extra: Partial<typeof base> = {}) =>
    ({ ...base, ...extra, phase, word: WORD[phase], needs_you: NEEDS_YOU.has(phase), line: clip(line) });
  if (!inp.live) return out("ended", inp.result ? firstSentence(inp.result) : inp.narration ?? "");

  const d = declarationStands(inp) ? sig.declared! : null;
  if (d?.state === "blocked") return out("blocked", d.label || REASON[d.reason ?? ""] || "blocked");
  if (inp.daemonBlock && inp.daemonBlock.reason !== "question")
    return out("blocked", inp.daemonBlock.label || REASON[inp.daemonBlock.reason ?? ""] || "blocked");

  const opts = (o: string[]) => (o.length ? ` (${o.slice(0, 4).join(" / ")})` : "");
  if (inp.ask?.escalated) return out("decide", inp.ask.question + opts(inp.ask.options));
  if (sig.asking) return out("decide", sig.asking.question + opts(sig.asking.options));
  if (d?.state === "decide") return out("decide", d.label || "needs a decision");
  if (inp.quiet && inp.prompt && inp.prompt.kind !== "turn" && !(hooked && sig.turn!.state === "working"))
    return out("decide", inp.prompt.question || "asked you");

  if (inp.goalDone || d?.state === "review")
    return out("review", d?.state === "review" && d.label ? d.label : inp.result ? firstSentence(inp.result) : "goal reached — no Summary written");

  const eta = (at: number | null | undefined) => (at && at > inp.now ? ` · ~${mins(at - inp.now)}` : "");
  // Whose turn it is, said on the card. A `route: "lead"` ask is waiting on ANOTHER TERMINAL — the
  // worker's own Lead — which is a different thing from waiting on Robert: nobody should go looking
  // for it in Robert's queue, and `isStopped` (robert-drive.ts) counts `waiting --on terminal` as
  // stopped, so the group still reads as frozen if the Lead never answers.
  if (inp.ask?.route === "lead")
    return out("waiting", "its Lead is deciding: " + inp.ask.question, { on: "terminal" });
  if (inp.ask) return out("waiting", "Robert is deciding: " + inp.ask.question, { on: "robert" });
  if (d?.state === "waiting") return out("waiting", (d.label || `waiting on ${d.on ?? "something"}`) + eta(d.eta_at), { on: d.on ?? null, eta_at: d.eta_at ?? null });

  // Working: hooks own the turn boundary when they fire; pty bytes decide otherwise. A terminal whose
  // hooks say "working" but whose pty has been dead silent for a while is not working (a missed Stop).
  const silentFor = inp.lastOut ? inp.now - inp.lastOut : Infinity;
  const working = hooked ? sig.turn!.state === "working" && silentFor < HOOK_WORKING_SILENCE_MS : !inp.quiet;
  const stopped = hooked ? !working : inp.quiet;
  if (stopped && subs.length) {
    const tally = new Map<string, number>();
    for (const s of subs) if (s.label) tally.set(s.label, (tally.get(s.label) ?? 0) + 1);
    const names = [...tally].map(([l, c]) => (c > 1 ? `${l} ×${c}` : l));
    return out("waiting", `${subs.length} subagent${subs.length === 1 ? "" : "s"}${names.length ? ": " + names.join(", ") : ""}`, { on: "subagents" });
  }
  if (working) {
    const p = sig.progress;
    const label = p ? `${p.n}/${p.of}${p.label ? " · " + p.label : ""}` : sig.work_label?.text || inp.narration || "working";
    return out("working", label);
  }
  if (inp.demandInspection) return out("stalled", `silent ${inp.lastOut ? mins(silentFor) : ""} with no sign of life`.replace(/\s+/g, " "));
  if (sig.turn?.error) return out("your_turn", "turn failed: " + sig.turn.error);
  // Not the prompt's "question": for a finished turn that is the TUI's last line — its status bar.
  return out("your_turn", inp.narration || "finished its turn");
}

// ── state: signals (persisted), narration (memory), phase clock (memory) ───────────────────────
const cache = new Map<string, Signals>();
const narr = new Map<string, { say: string | null; result: string | null }>();
const phaseAt = new Map<string, { phase: Phase; at: number }>();
const published = new Map<string, string>();

/**
 * The same transitions, written down — session_phases (migration 119), which is what the Fleet pulse
 * card draws. `phaseAt` above is the live clock and dies with the process; before this, a restart
 * erased the fleet's recent past entirely and the only honest answer to "what was it doing an hour
 * ago" was the raw pty log.
 *
 * `wrote` is the write filter, and it is not an optimisation: statusOf runs for every row on every
 * /desk load, ended rows included, so without it each load would cost a SELECT per terminal forever.
 * The SELECT behind it is for the first call after a restart, when `wrote` is empty but the row is
 * already there.
 */
const wrote = new Map<string, Phase>();
/** A drawing of the last few hours, not an audit trail — activity.ts is the audit trail. */
export const PHASE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
let prunedAt = 0;
export function recordPhase(id: string, phase: Phase, at: number): void {
  if (wrote.get(id) === phase) return;
  wrote.set(id, phase);
  try {
    const last = db.prepare("SELECT phase FROM session_phases WHERE session_id = ? ORDER BY at DESC LIMIT 1").get(id) as { phase: string } | undefined;
    if (last?.phase === phase) return;
    db.prepare("INSERT OR IGNORE INTO session_phases (session_id, phase, at) VALUES (?, ?, ?)").run(id, phase, Math.round(at));
    prunePhases();
  } catch {}
}
/** Lazily, on write, at most hourly — a prune that ran per transition would be a DELETE per minute. */
export function prunePhases(now = Date.now()): void {
  if (now - prunedAt < 60 * 60 * 1000) return;
  prunedAt = now;
  try { db.prepare("DELETE FROM session_phases WHERE at < ?").run(now - PHASE_KEEP_MS); } catch {}
}

function load(id: string): Signals {
  const hit = cache.get(id);
  if (hit) return hit;
  let sig: Signals = {};
  try {
    const row = db.prepare("SELECT data FROM session_status WHERE session_id = ?").get(id) as { data: string } | undefined;
    if (row) sig = JSON.parse(row.data);
  } catch {}
  cache.set(id, sig);
  return sig;
}
function save(id: string, sig: Signals) {
  cache.set(id, sig);
  db.prepare(
    `INSERT INTO session_status (session_id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  ).run(id, JSON.stringify(sig), new Date().toISOString());
}
export function signalsOf(id: string): Signals {
  return load(id);
}

function narrationOf(id: string): { say: string | null; result: string | null } {
  let n = narr.get(id);
  if (n) return n;
  n = { say: null, result: null };
  try {
    for (const e of focusEvents(id)) take(n, e);
  } catch {}
  narr.set(id, n);
  return n;
}
function take(n: { say: string | null; result: string | null }, e: { kind?: string; text?: string }) {
  if (!e?.text) return false;
  if (e.kind === "result") { n.result = e.text; n.say = firstSentence(e.text); return true; }
  if (e.kind === "say" || e.kind === "understanding") { n.say = firstSentence(e.text); return true; }
  if (e.kind === "user") { n.result = null; return true; }
  return false;
}

export function statusOf(id: string, now = Date.now()): TermStatus | null {
  const s = sessions.get(id);
  if (!s) return null;
  const act = sessionActivity(id);
  const live = s.status === "live" && isLive(id);
  if (!live) {
    // An ended card needs no narration read: that is a transcript parse per row on every /desk load.
    phaseAt.delete(id);
    // The band has to close somewhere: without this an ended terminal's last live phase would run to
    // "now" forever in anything that reads the history.
    recordPhase(id, "ended", Date.parse(s.ended_at ?? "") || now);
    return { phase: "ended", word: WORD.ended, needs_you: false, line: "", since: now, on: null, eta_at: null, subagents: 0, progress: null, hooked: false };
  }
  const agent = getAgent(id);
  const open = asks.openForSession(id)[0];
  const n = narrationOf(id);
  const r = resolve({
    live,
    goalDone: !!s.goal_done_at,
    goal: s.goal ?? null,
    signals: load(id),
    quiet: act.quiet,
    lastOut: act.last_out,
    lastIn: act.last_in,
    prompt: live ? sessionPrompt(id) : null,
    // `escalated` = it is the OPERATOR's now. A lead-routed ask is nobody's escalation yet — its
    // Lead has it, and the fallback rewrites `route` to "robert" when that runs out (lead-asks.ts).
    ask: open
      ? {
          question: open.question,
          options: parseOptions(open.options),
          escalated: (open.route !== "robert" && open.route !== "lead") || !!open.escalated_at,
          route: open.route,
        }
      : null,
    daemonBlock: agent?.state === "blocked" ? { label: agent.state_label, reason: agent.blocked_reason } : null,
    demandInspection: !!agent?.demand_inspection,
    narration: n.say,
    result: n.result,
    now,
  });
  const prev = phaseAt.get(id);
  const since = prev && prev.phase === r.phase ? prev.at : r.phase === "your_turn" && act.last_out ? act.last_out : now;
  if (!prev || prev.phase !== r.phase) { phaseAt.set(id, { phase: r.phase, at: since }); recordPhase(id, r.phase, since); }
  return { ...r, since };
}
function parseOptions(o: unknown): string[] {
  if (Array.isArray(o)) return o.map(String);
  if (typeof o === "string" && o) { try { const v = JSON.parse(o); if (Array.isArray(v)) return v.map(String); } catch { return o.split(",").map((x) => x.trim()).filter(Boolean); } }
  return [];
}

/** Recompute and publish if anything the operator would see changed. */
export function refresh(id: string): TermStatus | null {
  const st = statusOf(id);
  if (!st) return null;
  const key = JSON.stringify({ ...st, since: undefined });
  if (published.get(id) === key) return st;
  published.set(id, key);
  bus.publish({ topic: "session.status", session_id: id, status: st });
  return st;
}
const soon = new Map<string, NodeJS.Timeout>();
function refreshSoon(id: string, ms = 250) {
  if (soon.has(id)) return;
  soon.set(id, setTimeout(() => { soon.delete(id); try { refresh(id); } catch {} }, ms));
}

// ── writers ─────────────────────────────────────────────────────────────────────────────────────
export type Declare = {
  state: DeclaredState | "idle" | "done";
  label?: string | null;
  reason?: string | null;
  on?: WaitOn | null;
  eta_min?: number | null;
};
export function declare(id: string, d: Declare, now = Date.now()): TermStatus | null {
  const sig = { ...load(id) };
  const label = d.label ? clip(d.label, 200) : null;
  if (d.state === "idle") { sig.declared = null; sig.work_label = null; }
  else if (d.state === "working") { sig.declared = null; sig.work_label = label ? { text: label, at: now } : null; }
  else {
    const state = d.state === "done" ? "review" : d.state;
    sig.declared = {
      state, label, at: now,
      reason: state === "blocked" ? d.reason ?? null : null,
      on: state === "waiting" ? d.on ?? "other" : null,
      eta_at: state === "waiting" && d.eta_min ? now + d.eta_min * 60000 : null,
    };
  }
  save(id, sig);
  mirror(id, sig);
  return refresh(id);
}
/**
 * The older consumers (Robert's `mc agents`, the phone's blocked push, `mc wait`) read the
 * agent-lifecycle overlay. Keep it telling the same story: a declared wall or question is
 * "blocked"; anything else lets the derived state speak.
 */
function mirror(id: string, sig: Signals) {
  const d = sig.declared;
  try {
    if (d?.state === "blocked" || d?.state === "decide")
      reportAgentState(id, { state: "blocked", state_label: d.label, blocked_reason: d.state === "decide" ? "question" : ((d.reason as any) || "hitl"), ttl_ms: null });
    else clearAgentOverlay(id);
  } catch {}
}
export function setProgress(id: string, p: { n: number; of: number; label?: string | null } | null, now = Date.now()): TermStatus | null {
  const sig = { ...load(id), progress: p ? { n: p.n, of: p.of, label: p.label ? clip(p.label, 120) : null, at: now } : null };
  save(id, sig);
  return refresh(id);
}

/** One hook call from a terminal's CLI, already normalized by `mc hook`. */
export type HookEvent =
  | { event: "prompt" }
  | { event: "stop"; error?: string | null; tasks?: { key: string; label: string }[] }
  | { event: "subagent_start"; key: string; label?: string | null }
  | { event: "subagent_stop"; key?: string | null; label?: string | null }
  | { event: "ask"; question: string; options?: string[]; kind?: "permission" }
  | { event: "answered" }
  | { event: "session_end" };

export function applyHook(id: string, h: HookEvent, now = Date.now()): TermStatus | null {
  const sig: Signals = { ...load(id), subagents: { ...(load(id).subagents ?? {}) } };
  let cleared = false;
  // A tool-permission gate (grok's PermissionRequest) is not a real block: it fires per tool even
  // when auto-approved, with no PostToolUse/answered behind it. Any further hook call — the very
  // next thing this switch handles below — proves the CLI moved on, so drop it before reacting to
  // that call. A genuine question (no kind) is untouched and still needs an explicit clear.
  if (sig.asking?.kind === "permission") sig.asking = null;
  switch (h.event) {
    case "prompt":
      // A submitted prompt is the operator (or Robert) answering: whatever the agent declared it
      // was stuck on is over. Progress and subagents are the agent's own and survive.
      sig.turn = { state: "working", at: now };
      sig.asking = null;
      if (sig.declared && sig.declared.state !== "review") { sig.declared = null; cleared = true; }
      break;
    case "stop":
      sig.turn = { state: "stopped", at: now, error: h.error ? clip(h.error, 120) : null };
      sig.asking = null;
      // The CLI told us exactly what is still running: that list wins over our start/stop tally.
      if (h.tasks) sig.subagents = Object.fromEntries(h.tasks.map((t) => [t.key, { label: clip(t.label, 40), at: sig.subagents?.[t.key]?.at ?? now }]));
      break;
    case "subagent_start":
      sig.subagents![h.key || `s${now}`] = { label: clip(h.label ?? "", 40), at: now };
      if (!sig.turn) sig.turn = { state: "working", at: now };
      break;
    case "subagent_stop": {
      const subs = sig.subagents!;
      const k = h.key && subs[h.key] ? h.key
        : Object.keys(subs).find((x) => h.label && subs[x].label === clip(h.label, 40))
        ?? Object.keys(subs).sort((a, b) => subs[a].at - subs[b].at)[0];
      if (k) delete subs[k];
      // A background subagent finishing wakes the main agent to read its result.
      if (sig.turn?.state === "stopped") sig.turn = { state: "working", at: now };
      break;
    }
    case "ask":
      sig.asking = { question: clip(h.question, 300), options: (h.options ?? []).map((o) => clip(o, 60)).slice(0, 6), at: now, ...(h.kind ? { kind: h.kind } : {}) };
      break;
    case "answered":
      sig.asking = null;
      sig.turn = { state: "working", at: now };
      break;
    case "session_end":
      sig.turn = { state: "stopped", at: now };
      sig.subagents = {};
      sig.asking = null;
      break;
  }
  save(id, sig);
  if (cleared) mirror(id, sig);
  return refresh(id);
}

/** Forget everything but the agent's declarations when a terminal is reopened (a new process). */
export function resetForRespawn(id: string) {
  const prev = load(id);
  save(id, { declared: prev.declared ?? null, progress: prev.progress ?? null });
  // A reopened terminal is a new process: its history starts again, and the last thing written for
  // the old one was "ended", which must not swallow the first phase of the new one.
  wrote.delete(id);
  narr.delete(id);
  published.delete(id);
}

// ── wiring ──────────────────────────────────────────────────────────────────────────────────────
let started = false;
export function startTermStatus() {
  if (started) return;
  started = true;
  prunePhases();
  bus.on("event", (e: any) => {
    switch (e.topic) {
      case "session.activity":
      case "session.updated":
      case "session.ended":
      case "session.input":
        return refreshSoon(e.session_id);
      case "session.started":
        resetForRespawn(e.session_id);
        return refreshSoon(e.session_id);
      case "agent.state":
        if (e.kind === "session") refreshSoon(e.id);
        return;
      case "focus.event": {
        const n = narr.get(e.session_id);
        if (n && take(n, e.event)) refreshSoon(e.session_id, 1000);
        else if (!n) refreshSoon(e.session_id, 1000);
        return;
      }
    }
  });
  // Time moves phases on its own: an ETA passing, a hook-working terminal gone silent, a subagent TTL.
  const t = setInterval(() => {
    for (const s of sessions.list({ limit: 200 })) if (s.status === "live") try { refresh(s.id); } catch {}
  }, 20_000);
  t.unref?.();
}
