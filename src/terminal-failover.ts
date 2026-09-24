/**
 * A Desk terminal that runs out of credits moves on by itself.
 *
 * Headless jobs already fail over (dispatcher `maybeFallback`) and so do the warm managers
 * (manager-fallback.ts). A live Desk terminal had nothing: Claude painted "You're out of usage
 * credits" or "You've hit your limit · resets 3pm", the card turned orange like any finished turn,
 * and the work sat there until the operator noticed. In his words: "cuando una terminal se queda sin
 * crédito, que automáticamente cambie a una nueva terminal en grok o cursor".
 *
 * Same ladder as manager-fallback, applied to a pty:
 *   1. Model wall (Fable's usage credits, a per-model weekly limit) on claude → the SAME terminal types
 *      `/model <agent.modelFallback>` and a short "continue". The conversation and its context stay.
 *   2. Claude itself walled (session/usage limit, the fallback model walled too, or step 1 already
 *      tried) → a NEW terminal on the next backend (workspace.fallback_backend, then
 *      CHRONOS_TERMINAL_FALLBACK_BACKENDS), same workspace/cwd/ticket/goal, seeded with the goal and a
 *      replay of the old terminal's Focus feed. The old one is closed with an end_reason that points at
 *      the stand-in. A stand-in that walls too walks to the next backend; nothing is ever retried.
 *
 * Detection is read off the settled frame at the quiet flip (the same moment desk-prompt reads a
 * question), and only counts a line in the CLI's own voice sitting at the bottom of the frame with
 * nothing but composer chrome under it — an agent explaining rate limits in prose never matches.
 */
import fs from "node:fs";
import { CONFIG } from "./config.js";
import { bus, type BusEvent } from "./bus.js";
import { sessions, workspaces } from "./store.js";
import { backendAllowed, backendInstalled, getBackend, hasBackend } from "./backends/index.js";
import { isCreditWallError, isProviderLimitError } from "./manager-fallback.js";
import { renderLinesReplay } from "./replay.js";
import {
  focusEvents, killSession, openSession, sendInput, sessionActivity, sessionPrompt, sessionScreen,
  type NamedKey,
} from "./terminal.js";
import type { DeskPrompt, PromptOption } from "./desk-prompt.js";
import type { Session } from "./types.js";

// ──────────────────────────── the wall, off the frame ────────────────────────────

export type WallKind = "credit" | "limit";
export type Wall = { kind: WallKind; line: string };

/** How far up from the bottom of the frame a wall may sit, and how much may sit under it. */
const TAIL_ROWS = 14;
const MAX_ROWS_UNDER = 8;

// Claude Code 2.1.x wording (read out of its bundle): "You've hit your session limit · resets 3pm",
// "You've hit your limit · resets 3pm", "You've reached your Fable limit.", "You're out of usage
// credits. Switch to another model to continue.", "Your org is out of usage · add funds to continue",
// "Fable 5 requires usage credits.", plus the older "Claude AI usage limit reached|<epoch>".
// Case-SENSITIVE on the leading word on purpose: the CLI capitalises it, and the stand-in's seed
// quotes the wall in lower case so its own echo can never read as a second wall.
const VOICE_RES = [
  /^You(?:'ve|’ve| have) (?:hit|reached) your\b/,
  /^You(?:'re|’re| are) out of (?:usage credits|extra usage|credits)\b/,
  /^Your org is out of usage\b/,
  /^(?:Claude (?:AI )?)?[Uu]sage limit reached\b/,
  /^[A-Z][\w.-]*(?: [\w.-]+){0,3} requires usage credits\b/,
];
// Error rows other CLIs (and Claude's API errors) print: "API Error: 429 … rate_limit_error",
// "Error: quota exceeded". Only counted with the prefix, so prose that mentions quotas never is.
const ERROR_PREFIX_RE = /^(?:API Error|Error)\b\s*(?:\(\s*\d{3}[^)]*\)|:\s*\d{3}\b|:)?\s*/i;
// A 429 the CLI is still retrying (or an overload) is weather, not a wall.
const TRANSIENT_RE = /overloaded|retrying|retry in|\b529\b/i;
// Where a CLI puts its own system rows: hung off a result glyph (Claude's `⎿`), in a dialog box
// (`│`), flagged (`✗ ⚠`), or flush at column 0. NOT behind `●`/`⏺` (the agent's own sentence), not
// on an indented row (a wrapped paragraph of it), not behind `>`/`❯` (the operator's prompt) — an
// agent quoting "You've hit your limit" in its final message must never read as a wall.
const LEAD_RE = /^(\s*)([⎿✗✘⚠!│┃]\s*)?/;
// Claude's footer while a turn is running. A frame that still says it is not a finished turn.
const WORKING_RE = /\besc to interrupt\b/i;
// A row that is work, not chrome: an assistant/tool bullet, or a prompt with text in it.
const CONTENT_RE = /^\s*(?:[⎿●⏺✻✳✢*]\s*\S|[>❯]\s*\S)/;
const OPTION_RE = /^\s*(?:[❯>▶›]\s*)?\d{1,2}[.)]\s+\S/;
// Model-scoped: another model on the same login usually still answers.
const MODEL_SCOPED_RE = /\b(?:Fable|Opus|Sonnet|Haiku) limit\b|requires usage credits/i;

/** The wall a single row states, as it would be quoted — or null. */
export function wallLine(row: string): string | null {
  const lead = LEAD_RE.exec(row)!;
  if (!lead[2] && lead[1].length > 0) return null;
  const s = row.slice(lead[0].length).replace(/\s*[│┃]\s*$/, "").trim();
  if (!s) return null;
  if (VOICE_RES.some((re) => re.test(s))) return s;
  const pre = ERROR_PREFIX_RE.exec(s);
  if (pre && pre[0].trim()) {
    const rest = s.slice(pre[0].length);
    if (!TRANSIENT_RE.test(s) && (isProviderLimitError(rest) || isCreditWallError(rest))) return s;
  }
  return null;
}

/** Credit wall (try another model) or limit (Claude itself is capped → another backend). */
export function classifyWall(text: string): WallKind {
  return isCreditWallError(text) || MODEL_SCOPED_RE.test(text) ? "credit" : "limit";
}

/**
 * The wall a settled frame is sitting on, or null. Pure over the frame's rows (ScreenMirror keeps no
 * scrollback, so these ARE the visible rows): the bottom-most wall row wins, and it only counts when
 * everything under it is chrome — a composer, a footer, a dialog's options — never more work.
 */
export function detectWall(frame: string[] | null | undefined): Wall | null {
  const rows = (frame ?? []).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
  if (!rows.length) return null;
  const tail = rows.slice(-TAIL_ROWS);
  if (tail.some((l) => WORKING_RE.test(l))) return null;
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = wallLine(tail[i]);
    if (!line) continue;
    const under = tail.slice(i + 1);
    if (under.length > MAX_ROWS_UNDER) return null;
    // The row right under a wall is often its own second sentence ("/upgrade to increase your usage
    // limit."), so only bullets and prompts disqualify — and a numbered option is a dialog, not work.
    if (under.some((l) => CONTENT_RE.test(l) && !OPTION_RE.test(l))) return null;
    const ctx = [line, under[0] ? under[0].replace(/^[\s⎿│┃]+/, "").trim() : ""].join(" ");
    return { kind: classifyWall(ctx), line: line.slice(0, 300) };
  }
  return null;
}

// ──────────────────────────── what to do about it ────────────────────────────

export type FailoverStep =
  | { step: "model"; to: string }
  | { step: "backend"; to: string; model: string | null }
  | { step: "give_up"; why: string };

export interface DecideInput {
  wall: WallKind;
  backend: string;
  /** The model the terminal is on now (after a swap, the swapped-to one). */
  model: string | null;
  modelTried: boolean;
  attempts: number;
  max: number;
  modelFallback: string | null | undefined;
  /** Candidate backends in order (names as configured). */
  chain: string[];
  /** Canonical backend names this lineage already ran on — the original included. */
  tried: string[];
  usable: (backend: string) => boolean;
  modelFor: (backend: string) => string | null;
}

/** Canonical name: `cursor` and `cursor-agent` are one CLI, so one entry in `tried`. */
export const canonBackend = (b: string | null | undefined): string => getBackend(b).name;

const sameModel = (model: string | null, to: string) => !!model && model.toLowerCase().includes(to.toLowerCase());

/** Pure ladder: model swap → next backend → give up. Never a backend the lineage already ran on. */
export function decideFailover(i: DecideInput): FailoverStep {
  if (i.attempts >= i.max) return { step: "give_up", why: `failover cap reached (${i.attempts}/${i.max})` };
  const to = (i.modelFallback ?? "").trim();
  if (canonBackend(i.backend) === "claude-code" && i.wall === "credit" && !i.modelTried && to && !sameModel(i.model, to))
    return { step: "model", to };
  const seen = new Set([...i.tried, canonBackend(i.backend)]);
  for (const b of i.chain) {
    if (!hasBackend(b)) continue;
    const c = canonBackend(b);
    if (seen.has(c)) continue;
    seen.add(c);
    if (!i.usable(b)) continue;
    return { step: "backend", to: b, model: i.modelFor(b) };
  }
  return { step: "give_up", why: `no fallback backend left (ran on ${[...new Set([...i.tried, canonBackend(i.backend)])].join(", ")})` };
}

/** workspace.fallback_backend first, then the configured chain — deduped, order kept. */
export function fallbackChain(ws: { fallback_backend?: string | null } | undefined, configured = CONFIG.terminalFallbackBackends): string[] {
  const out: string[] = [];
  for (const b of [ws?.fallback_backend?.trim(), ...configured]) if (b && !out.includes(b)) out.push(b);
  return out;
}

// ──────────────────────────── the stand-in's first prompt ────────────────────────────

// The quoted wall and replay go into a seed that the stand-in's CLI echoes onto its own frame; lower
// case keeps VOICE_RES (case-sensitive) from reading that echo as a wall of its own.
const defang = (t: string) => t.replace(/\bYou(?=(?:'ve|’ve|'re|’re| have| are)\b)/g, "you").replace(/\bYour org\b/g, "your org");

/** What the old terminal was asked, minus the Focus contract a no-system-prompt backend had folded in. */
export function originalBrief(firstPrompt: string | null | undefined, cap = 3000): string | null {
  let t = (firstPrompt ?? "").trim();
  const k = t.indexOf("--- Your task ---");
  if (k >= 0) t = t.slice(k + "--- Your task ---".length).trim();
  if (!t) return null;
  return t.length > cap ? t.slice(0, cap) + "…" : t;
}

export function standInSeed(i: {
  from: string;
  fromModel: string | null;
  to: string;
  wall: Wall;
  goal: string | null;
  brief: string | null;
  cwd: string;
  replay: string | null;
}): string {
  const what = i.wall.kind === "credit" ? "ran out of credits" : "hit its usage limit";
  return [
    `You are taking over a Desk terminal that stopped mid-work: the previous agent (${i.from}${i.fromModel ? "/" + i.fromModel : ""}) ` +
      `${what} (the CLI said: "${defang(i.wall.line)}") and cannot continue, so the work moves to you on ${i.to}. ` +
      `Same workspace, same working directory (${i.cwd}), same card — do not open another terminal.`,
    i.goal ? `Goal: ${i.goal}` : null,
    i.brief ? `What the previous terminal was asked:\n${defang(i.brief)}` : null,
    i.replay
      ? defang(i.replay)
      : "No transcript of its work could be recovered — read the working tree (git status, git diff, recently changed files) to see how far it got.",
    "Continue the work from where it stopped. Do not start over: check the actual state first (git status/diff, " +
      "files, anything with side effects), then finish the goal and run `mc goal done` when it is met.",
  ].filter(Boolean).join("\n\n");
}

export const CONTINUE_TEXT = "Continue where you left off. The previous model ran out of credits, so this terminal switched models; nothing else changed.";

// ──────────────────────────── the loop ────────────────────────────

type SendReq = { text?: string; key?: NamedKey; keys?: NamedKey[]; enter?: boolean };

export interface FailoverOps {
  activity(id: string): { live: boolean; quiet: boolean; last_out: number | null; last_in: number | null; started_at: number | null };
  frame(id: string): string[] | null;
  prompt(id: string): DeskPrompt | null;
  send(id: string, req: SendReq): string | null;
  open(opts: Parameters<typeof openSession>[0]): Promise<Session>;
  kill(id: string, reason: string): void;
  feed(id: string): string[];
  installed(backend: string): boolean;
  wake(w: { topic: string; key: string; subject?: string | null; workspace_id?: string | null; payload?: unknown }): void;
  notify(text: string, level: "info" | "alert"): void;
  later(ms: number, fn: () => void): NodeJS.Timeout;
}

const defaultOps: FailoverOps = {
  activity: sessionActivity,
  frame: (id) => sessionScreen(id)?.lines ?? null,
  prompt: sessionPrompt,
  send: (id, req) => sendInput(id, req, "failover"),
  open: openSession,
  kill: killSession,
  feed: (id) => focusEvents(id).map((e) => `${e.kind}: ${e.text}`),
  installed: backendInstalled,
  // Lazy: wake-queue pulls in Robert's whole agent, and this module is imported by terminal-prompts.
  wake: (w) => void import("./wake-queue.js").then((m) => m.enqueueWake(w)).catch(() => {}),
  notify: (text, level) =>
    void import("./telegram/api.js")
      .then((m) => (level === "info" ? m.notifyInfo(text) : m.notify(text)))
      .catch(() => {}),
  later: (ms, fn) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
};

let ops: FailoverOps = defaultOps;
/** Test seam: replace any of the daemon's hands. */
export function setFailoverOps(o: Partial<FailoverOps>): void { ops = { ...defaultOps, ...o }; }

/** One per chain of terminals: the original and every stand-in opened for it share it. */
type Lineage = { tried: string[]; attempts: number };
type TermState = {
  lineage: Lineage;
  modelTried: boolean;
  /** Model after our swap; the row keeps the one it was opened with. */
  model?: string | null;
  /** When we last acted — the frame must move after this before the same terminal is judged again. */
  actedAt: number | null;
  /** Last keystroke WE sent, so our own typing never reads as the operator's. */
  wroteAt: number;
  busy: boolean;
  done: boolean;
  recheck?: NodeJS.Timeout;
};
const states = new Map<string, TermState>();

export function resetFailoverState(): void {
  for (const s of states.values()) if (s.recheck) clearTimeout(s.recheck);
  states.clear();
}

function stateFor(id: string, backend: string): TermState {
  let st = states.get(id);
  if (!st) {
    st = { lineage: { tried: [canonBackend(backend)], attempts: 0 }, modelTried: false, actedAt: null, wroteAt: 0, busy: false, done: false };
    states.set(id, st);
  }
  return st;
}

export const terminalFailoverEnabled = (): boolean => CONFIG.terminalFailover;

/** Is this terminal sitting on a wall failover will handle? terminal-prompts leaves those alone. */
export function failoverOwns(sessionId: string): boolean {
  if (!terminalFailoverEnabled()) return false;
  const st = states.get(sessionId);
  if (st?.done) return false;
  try { return !!detectWall(ops.frame(sessionId)); } catch { return false; }
}

export type QuietOutcome =
  | "off" | "not-live" | "busy" | "done" | "stale" | "no-wall" | "not-agent" | "typing"
  | "model" | "backend" | "give_up";

const id8 = (id: string) => id.slice(0, 8);
const wallWords = (w: Wall) => (w.kind === "credit" ? "out of credits" : "usage limit");

/**
 * A terminal went quiet. Returns what happened, for tests and the log; the backend step resolves
 * after the stand-in is open and the old terminal closed.
 */
export async function onTerminalQuiet(id: string, now = Date.now()): Promise<QuietOutcome> {
  if (!terminalFailoverEnabled()) return "off";
  const act = ops.activity(id);
  if (!act.live || !act.quiet) return "not-live";
  const s = sessions.get(id);
  if (!s || s.status !== "live") return "not-live";
  const st = stateFor(id, s.backend);
  if (st.done) return "done";
  if (st.busy) return "busy";
  // Same frame we already acted on: /model and a continue must produce output before the terminal
  // can be judged again, which is also what keeps one wall from firing twice.
  if (st.actedAt !== null && !((act.last_out ?? 0) > st.actedAt)) return "stale";
  const wall = detectWall(ops.frame(id));
  if (!wall) return "no-wall";
  // Agent work only: a goal, a brief it was seeded with, or a ticket. A bare scratch terminal is the
  // operator's own window and he is the one to decide where it goes.
  if (!s.goal && !s.first_prompt && !s.ticket_id) return "not-agent";
  const windowMs = CONFIG.terminalFailoverTypingSec * 1000;
  const typedAt = act.last_in ?? 0;
  const someoneTyped = typedAt > (act.started_at ?? 0) + 500 && typedAt > st.wroteAt + 1500;
  if (someoneTyped && now - typedAt < windowMs) {
    if (st.recheck) clearTimeout(st.recheck);
    st.recheck = ops.later(typedAt + windowMs - now + 250, () => { st.recheck = undefined; void onTerminalQuiet(id); });
    return "typing";
  }

  const ws = s.workspace_id ? workspaces.get(s.workspace_id) : undefined;
  const model = st.model !== undefined ? st.model : s.model;
  const step = decideFailover({
    wall: wall.kind,
    backend: s.backend,
    model,
    modelTried: st.modelTried,
    attempts: st.lineage.attempts,
    max: CONFIG.terminalFailoverMax,
    modelFallback: CONFIG.agent.modelFallback,
    chain: fallbackChain(ws),
    tried: st.lineage.tried,
    usable: (b) => ops.installed(b) && backendAllowed(ws?.backends, b),
    modelFor: (b) =>
      (ws?.fallback_backend && canonBackend(ws.fallback_backend) === canonBackend(b) ? ws.fallback_model ?? null : null) ??
      (CONFIG.agent.fallbackBackend && canonBackend(CONFIG.agent.fallbackBackend) === canonBackend(b) ? CONFIG.agent.fallbackModel ?? null : null),
  });

  if (step.step === "model") return swapModel(s, st, wall, model, step.to, now);
  if (step.step === "give_up") return giveUp(s, st, wall, model, step.why);
  return handOff(s, st, wall, model, step, ws);
}

function swapModel(s: Session, st: TermState, wall: Wall, from: string | null, to: string, now: number): QuietOutcome {
  st.modelTried = true;
  st.model = to;
  st.lineage.attempts++;
  st.actedAt = now;
  st.wroteAt = now;
  const p = ops.prompt(s.id);
  // Claude's mid-session Fable dialog offers the swap itself ("Switch to Opus and continue") — take
  // it rather than typing a slash command into a menu.
  const offer = p?.kind === "select" ? p.options?.find((o) => /^switch to .+ and continue/i.test(o.label)) : undefined;
  if (offer) {
    ops.send(s.id, { keys: keysFor(offer) });
  } else {
    // Some other dialog is up: close it first, or `/model` lands in the menu.
    const lead = p?.kind === "select" ? 300 : 0;
    if (lead) ops.send(s.id, { key: "esc" });
    // Separate writes, spaced like sendInput's own Enter: the slash command must run before the
    // nudge is typed, or the TUI takes both as one line.
    ops.later(lead, () => { st.wroteAt = Date.now(); ops.send(s.id, { text: `/model ${to}` }); });
    ops.later(lead + 1500, () => { st.wroteAt = Date.now(); ops.send(s.id, { text: CONTINUE_TEXT }); });
  }
  const reason = `${wallWords(wall)} on ${from ?? "its model"} → switched to ${to} in the same terminal`;
  publish(s, { step: "model", wall, from_model: from, to_backend: s.backend, to_model: to, reason });
  console.warn(`[terminal-failover] ${id8(s.id)} ${s.backend}/${from ?? "default"}: ${wall.line} → /model ${to}`);
  return "model";
}

async function handOff(
  s: Session,
  st: TermState,
  wall: Wall,
  from: string | null,
  first: { to: string; model: string | null },
  ws: ReturnType<typeof workspaces.get>,
): Promise<QuietOutcome> {
  st.busy = true;
  try {
    let step: FailoverStep = { step: "backend", ...first };
    while (step.step === "backend") {
      const to = step.to;
      st.lineage.attempts++;
      st.lineage.tried.push(canonBackend(to));
      try {
        const sess = await openStandIn(s, wall, from, to, step.model);
        // The stand-in inherits the lineage: what was tried, and how many steps are left.
        states.set(sess.id, { lineage: st.lineage, modelTried: true, actedAt: null, wroteAt: 0, busy: false, done: false });
        const reason = `${wallWords(wall)} on ${s.backend}${from ? "/" + from : ""} → continued in ${to} terminal ${id8(sess.id)}`;
        st.done = true;
        ops.kill(s.id, reason);
        publish(s, { step: "backend", wall, from_model: from, to_backend: to, to_model: step.model, to_session_id: sess.id, reason });
        console.warn(`[terminal-failover] ${id8(s.id)} ${s.backend}/${from ?? "default"}: ${wall.line} → ${to} terminal ${id8(sess.id)}`);
        const label = s.goal || s.title || id8(s.id);
        ops.wake({
          topic: "session.failover",
          key: `terminal-failover:${s.id}`,
          subject: `session:${s.id}`,
          workspace_id: s.workspace_id,
          payload: {
            session_id: s.id,
            to_session_id: sess.id,
            say:
              `terminal \`${id8(s.id)}\` ("${label}") ${wall.kind === "credit" ? "ran out of credits" : "hit its usage limit"} on ` +
              `${s.backend}${from ? "/" + from : ""} ("${wall.line}"). The daemon already moved the work to a new ${to} terminal ` +
              `\`${id8(sess.id)}\`, seeded with the goal and a replay of what the old one did, and closed the old one. ` +
              `Check the new terminal picked it up (\`mc session focus ${id8(sess.id)}\`) and tell the operator in one line.`,
          },
        });
        ops.notify(`↪ <b>Terminal out of ${wall.kind === "credit" ? "credits" : "quota"}</b> — ${esc(label)}: ${esc(s.backend)} → new ${esc(to)} terminal <code>${id8(sess.id)}</code>`, "info");
        return "backend";
      } catch (e: any) {
        console.warn(`[terminal-failover] ${id8(s.id)}: opening a ${to} stand-in failed: ${e?.message ?? e}`);
        step = decideFailover({
          wall: wall.kind, backend: s.backend, model: from, modelTried: true,
          attempts: st.lineage.attempts, max: CONFIG.terminalFailoverMax, modelFallback: null,
          chain: fallbackChain(ws), tried: st.lineage.tried,
          usable: (b) => ops.installed(b) && backendAllowed(ws?.backends, b),
          modelFor: () => null,
        });
      }
    }
    return giveUp(s, st, wall, from, step.step === "give_up" ? step.why : "no fallback backend left");
  } finally {
    st.busy = false;
  }
}

async function openStandIn(s: Session, wall: Wall, from: string | null, to: string, model: string | null): Promise<Session> {
  // A claimed worktree is where the work actually is; the row's cwd is only where it started.
  // On another host the worktree is on THAT disk: whether it still exists is the host's to check.
  const remote = !!s.host_id && s.host_id !== "local";
  const cwd = s.worktree_path && (remote || fs.existsSync(s.worktree_path)) ? s.worktree_path : s.cwd;
  let feed: string[] = [];
  try { feed = ops.feed(s.id); } catch {}
  if (feed.length < 2) {
    // No transcript we can parse: the frame it died on is still better than nothing.
    feed = (ops.frame(s.id) ?? []).filter((l) => l.trim() && !wallLine(l)).map((l) => `screen: ${l.trim()}`);
  }
  const replay = renderLinesReplay(
    feed,
    `A Desk terminal on ${s.backend}${from ? "/" + from : ""} ${wall.kind === "credit" ? "ran out of credits" : "hit its usage limit"}`,
    "its Focus feed",
    6000,
  );
  const seed = standInSeed({
    from: s.backend, fromModel: from, to, wall, goal: s.goal ?? s.spawn_goal ?? null,
    brief: originalBrief(s.first_prompt), cwd, replay,
  });
  return ops.open({
    workspace_id: s.workspace_id,
    repo_id: s.repo_id,
    ticket_id: s.ticket_id,
    backend: to,
    model,
    cwd,
    role: s.role,
    title: `↪ ${to} · ${s.title || s.goal || "terminal " + id8(s.id)}`.slice(0, 200),
    goal: s.goal,
    goal_kind: s.goal_kind,
    created_by: "failover",
    seed,
    replaces: s.id,
    // Sticky (HOSTS.md → Placement): a stand-in runs where the walled terminal ran — its worktree
    // and files are on that machine.
    host_id: s.host_id,
  });
}

function giveUp(s: Session, st: TermState, wall: Wall, from: string | null, why: string): QuietOutcome {
  st.done = true;
  const reason = `${wallWords(wall)} on ${s.backend}${from ? "/" + from : ""} — ${why}; waiting for you`;
  publish(s, { step: "give_up", wall, from_model: from, reason });
  console.warn(`[terminal-failover] ${id8(s.id)}: ${wall.line} → gave up (${why})`);
  const label = s.goal || s.title || id8(s.id);
  ops.wake({
    topic: "session.failover",
    key: `terminal-failover:${s.id}:give_up`,
    subject: `session:${s.id}`,
    workspace_id: s.workspace_id,
    payload: {
      session_id: s.id,
      say:
        `terminal \`${id8(s.id)}\` ("${label}") is stopped on a wall ("${wall.line}") and the daemon could not move it: ${why}. ` +
        `It is waiting. Tell the operator in one line what it needs (top up, wait for the reset, or which backend to use).`,
    },
  });
  ops.notify(`⛔ <b>Terminal stuck on a wall</b> — ${esc(label)} (${esc(s.backend)}): ${esc(wall.line)}. ${esc(why)}.`, "alert");
  return "give_up";
}

function publish(
  s: Session,
  e: { step: "model" | "backend" | "give_up"; wall: Wall; from_model: string | null; to_backend?: string | null; to_model?: string | null; to_session_id?: string | null; reason: string },
): void {
  bus.publish({
    topic: "session.failover",
    session_id: s.id,
    workspace_id: s.workspace_id,
    step: e.step,
    wall: e.wall.kind,
    detail: e.wall.line,
    from_backend: s.backend,
    from_model: e.from_model,
    to_backend: e.to_backend ?? null,
    to_model: e.to_model ?? null,
    to_session_id: e.to_session_id ?? null,
    reason: e.reason,
  });
}

function keysFor(o: PromptOption): NamedKey[] {
  const n = Math.abs(o.offset | 0);
  return [...Array(n).fill(o.offset > 0 ? "down" : "up"), "enter"];
}

const esc = (t: string) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function startTerminalFailover(): void {
  bus.on("event", (e: BusEvent) => {
    try {
      if (e.topic === "session.activity" && e.state === "waiting")
        void onTerminalQuiet(e.session_id).catch((err) => console.error("[terminal-failover]", err));
      else if (e.topic === "session.ended") {
        const st = states.get(e.session_id);
        if (st?.recheck) clearTimeout(st.recheck);
        states.delete(e.session_id);
      }
    } catch (err) {
      console.error("[terminal-failover]", err);
    }
  });
  console.log(
    terminalFailoverEnabled()
      ? `[terminal-failover] walled terminals move on: /model ${CONFIG.agent.modelFallback || "(off)"} → ${fallbackChain(undefined).join(" → ") || "(no backends)"} (cap ${CONFIG.terminalFailoverMax})`
      : "[terminal-failover] off (CHRONOS_TERMINAL_FAILOVER=off) — a walled terminal waits for the operator",
  );
}
