/**
 * Answering Claude Code's question dialog (AskUserQuestion) from the Desk, by its screen.
 *
 * A single-select is one run of keys (down × n, Enter). A multi-select is not: Enter only ticks the
 * row under the cursor, typed text is dropped unless the cursor sits on "Type something", and the
 * answer goes only from the unnumbered "Submit" row under the last box ("Next" when more questions
 * follow) and then "Submit answers" on its review screen. So the operator ticks on the card and
 * presses one button, and this walks the dialog: one key run at a time, reading the frame after each
 * and checking the tick landed before the next. A line typed in the Desk's composer while a dialog is
 * open comes here too, as the dialog's own words, instead of keystrokes the dialog drops (2026-11-20:
 * "I just answer below and this msg never disappears").
 *
 * Verified on Claude Code 2.1.329 in a live TUI (2026-11-20):
 *   · Enter (or Space) on a box toggles it; the cursor stays on that row.
 *   · ↓ from the last box ("Type something") lands on Submit/Next; Enter there moves on.
 *   · Typing on "Type something" ticks it and shows the words as its label; Enter there UNticks it.
 *   · After Submit: "Review your answers" with "1. Submit answers / 2. Cancel" (cursor on 1).
 *   · A single-select's last question also ends on that review screen when there were several.
 *   · Text typed while the cursor is on any other row is dropped; the Enter after it toggles that row.
 */
import { detectPrompt, type DeskPrompt, type PromptOption } from "./desk-prompt.js";
import { KEY_GAP_MS, sendInput, settledScreen, writeTo } from "./terminal.js";

export type DialogAnswer = { picks?: string[]; text?: string | null };
export type DialogResult =
  | { ok: true; submitted: boolean; next: boolean; picked: string[]; text: string | null }
  | { ok: false; error: string };

type Key = "up" | "down" | "enter" | "backspace";
export type DialogDeps = {
  /** The frame as it is now, every byte so far parsed. Null = not a live terminal. */
  frame: (id: string) => Promise<string[] | null>;
  /** Keystrokes, one at a time, spaced as a person would type them. */
  keys: (id: string, keys: Key[]) => Promise<void>;
  /** Words into the field under the cursor (no Enter). */
  type: (id: string, text: string) => void;
  sleep: (ms: number) => Promise<void>;
};

const RAW: Record<Key, string> = { up: "\x1b[A", down: "\x1b[B", enter: "\r", backspace: "\x7f" };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const real: DialogDeps = {
  frame: async (id) => (await settledScreen(id))?.lines ?? null,
  keys: async (id, keys) => { for (const k of keys) { writeTo(id, RAW[k]); await sleep(KEY_GAP_MS); } },
  type: (id, text) => { sendInput(id, { text, enter: false }, "operator"); },
  sleep,
};
let deps = real;
/** Tests: a scripted dialog instead of a live pty. Null restores the real one. */
export function setDialogDeps(d: DialogDeps | null) { deps = d ?? real; }

const TYPE_RE = /^type something\.?$/i;
const CHAT_RE = /^chat about this\.?$/i;
const SUBMIT_ANSWERS_RE = /^submit answers$/i;
/** How long one key run may take to show on the frame. */
const LOOKS = 20, LOOK_MS = 75;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
/** Same option: the label as the hook gave it vs as the screen shows it (a long one may be cut). */
const same = (a: string, b: string) => {
  const x = norm(a), y = norm(b);
  return x === y || (Math.min(x.length, y.length) >= 12 && x.slice(0, 28) === y.slice(0, 28));
};
const arrows = (offset: number): Key[] => Array(Math.abs(offset)).fill(offset > 0 ? "down" : "up");
const boxes = (p: DeskPrompt | null) => (p?.options ?? []).filter((o) => o.checked !== undefined);
const fail = (error: string): DialogResult => ({ ok: false, error });

async function look(id: string): Promise<DeskPrompt | null> {
  const f = await deps.frame(id);
  if (!f) return null;
  const p = detectPrompt(f);
  return p?.kind === "select" && p.options?.length ? p : null;
}
/** Read the frame until `ok` holds (or give up): a key run takes a repaint or two to show. */
async function until(id: string, ok: (p: DeskPrompt) => boolean): Promise<DeskPrompt | null> {
  for (let n = 0; n < LOOKS; n++) {
    await deps.sleep(LOOK_MS);
    const p = await look(id);
    if (p && ok(p)) return p;
  }
  return null;
}
/** After the last answer, its review screen: confirm it. Absent (one plain question) = it already went. */
async function confirmReview(id: string): Promise<boolean> {
  const r = await until(id, (p) => p.options!.some((o) => SUBMIT_ANSWERS_RE.test(o.label)));
  if (!r) return false;
  const o = r.options!.find((x) => SUBMIT_ANSWERS_RE.test(x.label))!;
  await deps.keys(id, [...arrows(o.offset), "enter"]);
  return true;
}

export async function answerDialog(id: string, a: DialogAnswer): Promise<DialogResult> {
  const picks = [...new Set((a.picks ?? []).map((x) => String(x).trim()).filter(Boolean))];
  const text = String(a.text ?? "").replace(/\s+/g, " ").trim() || null;
  if (!picks.length && !text) return fail("pick an answer, or write your own");
  const p = await look(id);
  if (!p) return fail("there is no question on its screen right now — open the terminal (⌘E)");
  return boxes(p).length ? multi(id, p, picks, text) : single(id, p, picks, text);
}

/** One pick or its own words, then Enter; a review screen after it (the last of several) is confirmed. */
async function single(id: string, p: DeskPrompt, picks: string[], text: string | null): Promise<DialogResult> {
  if (picks.length > 1) return fail("this question takes one answer");
  if (text) {
    const row = p.options!.find((o) => TYPE_RE.test(o.label));
    if (!row) return fail("this question takes no words of your own — pick one of its answers");
    await deps.keys(id, arrows(row.offset));
    if (!(await until(id, (q) => q.options!.some((o) => o.offset === 0 && TYPE_RE.test(o.label))))) return fail("could not reach “Type something” — open the terminal (⌘E)");
    deps.type(id, text);
    await deps.sleep(300);
    await deps.keys(id, ["enter"]);
  } else {
    const row = p.options!.find((o) => !TYPE_RE.test(o.label) && !CHAT_RE.test(o.label) && same(o.label, picks[0]));
    if (!row) return fail(`“${picks[0]}” is not one of its answers`);
    await deps.keys(id, [...arrows(row.offset), "enter"]);
  }
  const submitted = await confirmReview(id);
  return { ok: true, submitted, next: false, picked: picks, text };
}

/**
 * Ticks to match `picks` (every box but the last, which is its free-text row), its own words on that
 * last row, then Submit — and the review after it — or Next.
 */
async function multi(id: string, first: DeskPrompt, picks: string[], text: string | null): Promise<DialogResult> {
  const named = boxes(first).slice(0, -1);
  const want = new Set<number>();
  for (const pick of picks) {
    const i = named.findIndex((o) => same(o.label, pick));
    if (i < 0) return fail(`“${pick}” is not one of its answers`);
    want.add(i);
  }
  // 1. The ticks — by row index, re-read before each move: offsets count from the cursor, which moves.
  for (let i = 0; i < named.length; i++) {
    const on = want.has(i);
    const p = await look(id);
    const o: PromptOption | undefined = boxes(p)[i];
    if (!o) return fail("its question changed on screen — open the terminal (⌘E)");
    if (o.checked === on) continue;
    await deps.keys(id, [...arrows(o.offset), "enter"]);
    if (!(await until(id, (q) => boxes(q)[i]?.checked === on))) return fail(`could not ${on ? "tick" : "untick"} “${named[i].label}” — open the terminal (⌘E)`);
  }
  // 2. Its own words, on the last box: typing there ticks it. Words already in it go first. No words
  //    and a tick left on it (an Enter that landed there) → untick, or "Type something" goes as an answer.
  let p = await look(id);
  const own = boxes(p).at(-1);
  if (!own) return fail("its question changed on screen — open the terminal (⌘E)");
  if (text) {
    await deps.keys(id, arrows(own.offset));
    if (!(await until(id, (q) => boxes(q).at(-1)?.offset === 0))) return fail("could not reach “Type something” — open the terminal (⌘E)");
    if (!TYPE_RE.test(own.label)) await deps.keys(id, Array(own.label.length + 16).fill("backspace"));
    deps.type(id, text);
    const typed = await until(id, (q) => { const b = boxes(q).at(-1); return !!b?.checked && same(b.label, text); });
    if (!typed) return fail("its question did not take your words — open the terminal (⌘E)");
  } else if (own.checked) {
    await deps.keys(id, [...arrows(own.offset), "enter"]);
    if (!(await until(id, (q) => boxes(q).at(-1)?.checked === false))) return fail("could not clear “Type something” — open the terminal (⌘E)");
  }
  // 3. Submit (the only or last question → its review screen) or Next (the next question).
  p = await look(id);
  if (!p?.submit) return fail("its Submit row is not on screen — open the terminal (⌘E)");
  const last = /^submit$/i.test(p.submit.label);
  await deps.keys(id, [...arrows(p.submit.offset), "enter"]);
  if (!last) return { ok: true, submitted: false, next: true, picked: picks, text };
  const submitted = await confirmReview(id);
  if (!submitted) return fail("it did not show its review screen — open the terminal (⌘E)");
  return { ok: true, submitted, next: false, picked: picks, text };
}
