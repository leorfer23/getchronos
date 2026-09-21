/**
 * Robert answers the questions a TERMINAL asks — the 🟠 half of the HITL layer.
 *
 * `mc ask-robert` covers the questions an agent chooses to file through the API (src/ask-robert.ts).
 * It does not cover the far more common case: a CLI stops mid-turn and paints a menu — a permission
 * prompt, an AskUserQuestion, a y/n — and there is no ask row anywhere. The Desk turns that card
 * orange (`session.activity` waiting + the parsed `DeskPrompt`) and waits for a tap. Nothing woke
 * Robert for it, so in the operator's words: "several of my agents asked me to choose between
 * options and Robert didn't answer them — I had to pick the recommended option for each myself."
 *
 * This closes that gap with the same three properties as ask-robert:
 *  - **Woken, durably.** A waiting prompt is an `enqueueWake` row keyed by session + prompt hash, so
 *    it survives a restart and a repeat of the same question costs one turn, not twenty.
 *  - **His hands are the operator's hands.** He answers through the ONE primitive the Desk's tap
 *    uses — `POST /api/sessions/:id/input` (`mc session key` / `mc session send`) — so there is no
 *    second answer path to keep in sync, and every keystroke is recorded with his name on it.
 *  - **Nothing waits silently.** An answer that doesn't land re-wakes him once; a prompt he neither
 *    answers nor escalates inside the deadline becomes the operator's card, options as buttons.
 *
 * What he may answer and what he must hand up is NOT here: `agents/_blocks/terminal-prompts.md` owns
 * that policy, exactly as ask-authority.md owns it for asks. Two copies is how one goes stale.
 */
import { createHash } from "node:crypto";
import { CONFIG } from "./config.js";
import { bus, type BusEvent } from "./bus.js";
import { sessions, workspaces } from "./store.js";
import type { Session } from "./types.js";
import type { DeskPrompt, PromptOption } from "./desk-prompt.js";
import { enqueueWake, TERMINAL_PROMPT_KEY } from "./wake-queue.js";
import { isLive, sendInput, sessionPrompt, type NamedKey } from "./terminal.js";
import { failoverOwns } from "./terminal-failover.js";
import { esc, notify } from "./telegram/api.js";
import { kb, type Btn } from "./telegram/keyboards.js";

/** A finished turn is not a question — it never wakes anybody. */
const ANSWERABLE = new Set<DeskPrompt["kind"]>(["select", "yn", "question"]);
/** After a prompt is dealt with, the same question on the same terminal is old news for this long. */
export const PROMPT_HANDLED_MS = 10 * 60_000;
/** A terminal the operator is typing into himself is his — he is looking right at it. */
export const OPERATOR_TYPING_MS = 60_000;

const id8 = (id: string) => id.slice(0, 8);

/**
 * The identity of a question: its text plus its option labels, never the cursor position. Moving the
 * highlight is not a new question, and hashing the offsets would re-wake him on every arrow key.
 */
export function promptHash(p: DeskPrompt): string {
  const body = [p.question, ...(p.options ?? []).map((o) => o.label)].join("\n");
  return createHash("sha1").update(body).digest("hex").slice(0, 10);
}

export const promptWakeKey = (sessionId: string, p: DeskPrompt): string =>
  `${TERMINAL_PROMPT_KEY}${sessionId}:${promptHash(p)}`;

/** The keystrokes that take one option, relative to the cursor — the Desk's tap, as a sequence. */
export function keysForOption(o: PromptOption): NamedKey[] {
  const n = Math.abs(o.offset | 0);
  return [...Array(n).fill(o.offset > 0 ? "down" : "up"), "enter"];
}

const keySpec = (o: PromptOption) => keysForOption(o).join(",");

/** What a terminal was opened to do. No goal at all = the operator's own scratch terminal. */
const goalOf = (s: Session): string => (s.goal ?? s.spawn_goal ?? "").trim();

const wsName = (s: Session): string =>
  s.workspace_id ? workspaces.get(s.workspace_id)?.name ?? s.workspace_id.slice(0, 8) : "unscoped";

/** `ab12cd34 · acme · fix the login redirect` — how a terminal is named everywhere below. */
export function terminalLabel(s: Session): string {
  return `${id8(s.id)} · ${wsName(s)} · ${goalOf(s) || "(no goal)"}`;
}

/** The option list as Robert (and the operator) reads it, cursor marked. */
export function optionLines(p: DeskPrompt): string[] {
  return (p.options ?? []).map(
    (o, i) => `  ${i + 1}. ${o.label}${o.offset === 0 ? "   ← the cursor is on this one" : ""}`,
  );
}

/**
 * What Robert is told. No OP_PREFIX here: `wakeSection` in the queue puts it on, and adds the
 * "you are being woken because this needs a call" tail every wake ends with.
 */
export function promptSay(s: Session, p: DeskPrompt, again = false): string {
  const head = again
    ? `your answer to terminal \`${id8(s.id)}\` DID NOT LAND — it is still sitting on the SAME question ` +
      `${Math.round(CONFIG.terminalPromptConfirmSec)}s after you typed. Look at the screen before you type again: ` +
      `the keys may have gone to a different frame, or the CLI may want a letter where you sent a menu move.`
    : `a terminal has STOPPED on a question and is waiting for an answer — nobody has seen it yet.`;
  const how =
    p.kind === "select"
      ? `Answer it the way the Desk's tap does, with keys relative to the cursor: ` +
        `\`mc session key ${id8(s.id)} ${keySpec((p.options ?? [{ label: "", offset: 0 }])[0])}\` takes option 1.`
      : p.kind === "yn"
        ? `Answer it with the letter: \`mc session send ${id8(s.id)} y\` (or \`n\`).`
        : `Answer it with ONE clear sentence: \`mc session send ${id8(s.id)} "..."\`.`;
  return (
    `${head}\nTERMINAL — \`${terminalLabel(s)}\`${s.ticket_key ? ` · ticket ${s.ticket_key}` : ""}\n` +
    `THE QUESTION (${p.kind}): "${p.question}"\n` +
    (p.options?.length ? `OPTIONS:\n${optionLines(p).join("\n")}\n` : "") +
    `${how}\n` +
    `Follow ANSWERING A TERMINAL'S PROMPT in your instructions — it owns what you may answer yourself and ` +
    `what goes to the operator. Look at the terminal first (\`mc session focus ${id8(s.id)}\`); never answer ` +
    `from this text alone.`
  );
}

// ──────────────────────────── the wake ────────────────────────────

/** Prompts already dealt with (answered, escalated, or gone) → when. Keeps a repeat from re-waking. */
const handled = new Map<string, number>();
/** Last time the OPERATOR himself typed into a terminal. His terminal, his question. */
const operatorTyped = new Map<string, number>();

type Tracked = {
  session_id: string;
  key: string;
  hash: string;
  /** When Robert was woken — the deadline counts from here. */
  queued_at: number;
  /** When keystrokes from someone other than the operator landed on this terminal. */
  answered_at: number | null;
  /** The "your answer didn't land" wake is sent at most once; after that it is the operator's. */
  rewoken: boolean;
};

const tracked = new Map<string, Tracked>();

export const terminalPromptsEnabled = (): boolean => CONFIG.terminalPrompts;
/** Robert is already on a screen prompt from this terminal — robert-drive leaves it alone. */
export const promptTracked = (sessionId: string): boolean => tracked.has(sessionId);

/** Test seam: what the daemon can see of a terminal right now. Default is the live pty. */
type PromptProbe = (sessionId: string) => { live: boolean; prompt: DeskPrompt | null };
let probe: PromptProbe = (id) => ({ live: isLive(id), prompt: sessionPrompt(id) });
export function setPromptProbe(fn: PromptProbe): void { probe = fn; }

type PromptNotifier = (text: string, markup?: object) => Promise<unknown>;
let notifier: PromptNotifier = (text, markup) => notify(text, markup);
export function setPromptNotifier(fn: PromptNotifier): void { notifier = fn; }

export function resetTerminalPromptState(): void {
  handled.clear();
  operatorTyped.clear();
  tracked.clear();
}

/** Noting who typed. Robert's hand and the operator's hand mean opposite things here. */
export function noteInput(sessionId: string, by: string, atMs = Date.now()): void {
  if (by === "operator") {
    operatorTyped.set(sessionId, atMs);
    return;
  }
  // Anyone else typing into a terminal we woke him about IS his answer landing (or being attempted).
  const t = tracked.get(sessionId);
  if (t) t.answered_at = atMs;
}

/**
 * A terminal went quiet on a question → wake Robert, once. Returns the wake row's id, or null when
 * one of the guards below said no; those guards, not the enqueue, are the whole safety story.
 */
export function onPromptWaiting(
  sessionId: string,
  p: DeskPrompt | null | undefined,
  nowMs = Date.now(),
): string | null {
  if (!terminalPromptsEnabled()) return null;
  if (!p || !ANSWERABLE.has(p.kind) || !p.question?.trim()) return null;
  const s = sessions.get(sessionId);
  // A terminal with no goal or no client is the operator's own scratch window: not fleet work, and
  // Robert has nothing to judge "is this in scope" against.
  if (!s || !s.workspace_id || !goalOf(s)) return null;
  // He is at the keyboard on this one. Waking him to answer over the operator's shoulder is worse
  // than saying nothing.
  const typed = operatorTyped.get(sessionId) ?? 0;
  if (nowMs - typed < OPERATOR_TYPING_MS) return null;
  // A credit/usage wall is not a question for Robert: terminal-failover.ts is already swapping the
  // model or opening a stand-in, and his keys landing in the same frame would fight it.
  if (failoverOwns(sessionId)) return null;

  const key = promptWakeKey(sessionId, p);
  const lastHandled = handled.get(key);
  if (lastHandled !== undefined && nowMs - lastHandled < PROMPT_HANDLED_MS) return null;
  // Already tracked = already queued and not yet resolved; the queue would absorb it anyway.
  if (tracked.get(sessionId)?.key === key) return null;

  const id = enqueueWake({
    topic: "session.prompt",
    key,
    subject: `session:${sessionId}`,
    workspace_id: s.workspace_id,
    payload: { say: promptSay(s, p), session_id: sessionId, prompt: p },
  });
  tracked.set(sessionId, { session_id: sessionId, key, hash: promptHash(p), queued_at: nowMs, answered_at: null, rewoken: false });
  return id;
}

// ──────────────────────── confirm it landed, then the deadline ────────────────────────

/** The card the operator gets: the question, the options as buttons, and Robert's silence named. */
export async function escalatePrompt(s: Session, p: DeskPrompt, why: string): Promise<void> {
  const short = id8(s.id);
  const lines = [
    `🟠 <b>A terminal is waiting on a question</b> — ${esc(why)}`,
    `<i>${esc(terminalLabel(s))}</i>`,
    esc(p.question),
  ];
  const rows: Btn[][] = [];
  if (p.kind === "select" && p.options?.length) {
    lines.push(...optionLines(p).map((l) => esc(l)));
    const opts = p.options.slice(0, 8);
    for (let i = 0; i < opts.length; i += 2)
      rows.push(opts.slice(i, i + 2).map((o, j) => ({ text: `${i + j + 1}. ${o.label}`.slice(0, 32), data: `tp.${short}.${i + j}` })));
  } else if (p.kind === "yn") {
    rows.push([{ text: "Yes", data: `tp.${short}.y` }, { text: "No", data: `tp.${short}.n` }]);
  }
  // Free text is always available, and it is the ONLY answer for a `question` prompt — a button
  // cannot type a sentence.
  lines.push(`<code>mc session send ${short} "..."</code>`);
  await notifier(lines.join("\n"), rows.length ? kb(rows) : undefined).catch((e) =>
    console.error("[terminal-prompts] escalate notify failed", e),
  );
}

/**
 * One pass over every prompt Robert was woken about (desk-watch's 30s sweep).
 *
 * Three exits, in this order: the prompt is gone (he or the operator answered it — nothing to do),
 * his answer didn't move the screen (one re-wake, then the operator), or he never acted at all
 * (deadline → the operator). A prompt never stays in this map without one of them happening.
 */
export async function sweepTerminalPrompts(nowMs = Date.now()): Promise<void> {
  const confirmMs = Math.max(5, CONFIG.terminalPromptConfirmSec) * 1_000;
  const deadlineMs = Math.max(1, CONFIG.terminalPromptDeadlineMin) * 60_000;
  for (const t of [...tracked.values()]) {
    const s = sessions.get(t.session_id);
    const seen = probe(t.session_id);
    const cur = seen.prompt;
    const stillWaiting = !!s && seen.live && !!cur && ANSWERABLE.has(cur.kind) && promptHash(cur) === t.hash;
    if (!stillWaiting) {
      // Answered, killed, or moved on to a different question. Either way this one is settled.
      done(t, nowMs);
      continue;
    }
    if (t.answered_at !== null) {
      if (nowMs - t.answered_at < confirmMs) continue;
      if (!t.rewoken) {
        t.rewoken = true;
        // Restart the clock: the re-wake gets the same confirmation window his first answer got.
        t.answered_at = nowMs;
        enqueueWake({
          topic: "session.prompt",
          key: `${t.key}:again`,
          subject: `session:${t.session_id}`,
          workspace_id: s!.workspace_id,
          payload: { say: promptSay(s!, cur!, true), session_id: t.session_id, prompt: cur },
        });
        continue;
      }
      done(t, nowMs);
      await escalatePrompt(s!, cur!, "Robert answered and it didn't land");
      continue;
    }
    // The daemon cannot see him escalating in his own words (that is a chat message, not a row), so
    // the deadline fires regardless. Worst case the operator gets the same question twice, once with
    // buttons — which beats the alternative this feature exists to remove: nobody getting it at all.
    if (nowMs - t.queued_at >= deadlineMs) {
      done(t, nowMs);
      await escalatePrompt(s!, cur!, `no call from Robert within ${CONFIG.terminalPromptDeadlineMin}m — over to you`);
    }
  }
  // Both maps are keyed by things that end (a prompt, a terminal), so they are pruned by their own
  // windows rather than living for the life of the daemon.
  for (const [key, at] of handled) if (nowMs - at > PROMPT_HANDLED_MS) handled.delete(key);
  for (const [id, at] of operatorTyped) if (nowMs - at > OPERATOR_TYPING_MS) operatorTyped.delete(id);
}

function done(t: Tracked, nowMs: number): void {
  tracked.delete(t.session_id);
  handled.set(t.key, nowMs);
}

// ──────────────────────────── the operator's tap ────────────────────────────

/**
 * The Telegram button, executed with the same primitive as the Desk's tap. The prompt is re-read
 * first: the card can be minutes old, and typing a menu move at a screen that has moved on is
 * exactly how an agent gets told to do something nobody chose.
 */
export function answerPromptTap(sess8: string, choice: string): { ok: boolean; text: string } {
  const s = sessions.list({ status: "live", limit: 200 }).find((x) => x.id.startsWith(sess8));
  if (!s) return { ok: false, text: "that terminal is gone" };
  const p = probe(s.id).prompt;
  if (!p || !ANSWERABLE.has(p.kind)) return { ok: false, text: "that prompt is gone — the terminal moved on" };
  if (p.kind === "yn") {
    const letter = choice === "y" ? "y" : "n";
    const err = sendInput(s.id, { text: letter, enter: true }, "operator");
    return err ? { ok: false, text: err } : { ok: true, text: letter };
  }
  const o = p.options?.[Number(choice)];
  if (!o) return { ok: false, text: "that option is no longer on the screen" };
  const err = sendInput(s.id, { keys: keysForOption(o) }, "operator");
  return err ? { ok: false, text: err } : { ok: true, text: o.label };
}

export function startTerminalPrompts(): void {
  bus.on("event", (e: BusEvent) => {
    try {
      if (e.topic === "session.input") noteInput(e.session_id, e.by);
      else if (e.topic === "session.activity" && e.state === "waiting") onPromptWaiting(e.session_id, e.prompt);
    } catch (err) {
      console.error("[terminal-prompts]", err);
    }
  });
  console.log(
    terminalPromptsEnabled()
      ? `[terminal-prompts] Robert woken on 🟠 prompts (confirm ${CONFIG.terminalPromptConfirmSec}s, deadline ${CONFIG.terminalPromptDeadlineMin}m)`
      : "[terminal-prompts] off (CHRONOS_TERMINAL_PROMPTS=0) — a waiting terminal waits for the operator",
  );
}
