/**
 * What a quiet terminal is actually asking.
 *
 * The wall knows a pty has gone silent (terminal.ts QUIET_MS) and paints the card orange. It does
 * not know WHY: a permission prompt, a question, or a turn that simply finished. Answering used to
 * mean zooming the card and reading a 11px screen. This reads the screen for you — the pty's
 * bytes replayed into a headless terminal (renderScreen), so what is read is the frame that is
 * actually showing — and names the prompt shape so the Desk can put the question and its answers
 * in a strip at the top, one tap each.
 *
 * Shapes, in the order tried:
 *   · select   — a numbered option list, one line carrying the cursor (❯ / >). Claude Code's
 *                permission prompt and its AskUserQuestion, codex's approvals. Answers are relative
 *                to the cursor (down × n, Enter), so the wall never has to know which CLI it is.
 *   · yn       — "(y/n)", "[Y/n]", "yes/no". Answer is a letter and Enter.
 *   · question — the last thing printed ends in "?" with no options: free text.
 *   · turn     — none of the above: the agent finished and is at its composer.
 *
 * Pure function over text so it is testable against screens captured from real CLIs.
 */
import { createRequire } from "node:module";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import { stripAnsi } from "./summarize.js";

// @xterm/headless ships a CommonJS bundle whose exports Node's ESM lexer cannot see, so the
// named import resolves at type level and throws at runtime. require() it instead.
const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as { Terminal: typeof HeadlessTerminal };

export type PromptKind = "select" | "yn" | "question" | "turn";

export type PromptOption = {
  /** The option text as the CLI printed it, without its number or cursor. */
  label: string;
  /** Position relative to the highlighted option: 0 = Enter takes it, 1 = down once then Enter. */
  offset: number;
};

export type DeskPrompt = {
  kind: PromptKind;
  /** The question, as one line. For a turn: the last non-empty line the agent printed. */
  question: string;
  /** Select prompts only. Absent on a y/n, a free question, a finished turn. */
  options?: PromptOption[];
};

/** How much of the scrollback to read: a prompt is at the bottom, and a TUI repaints whole frames. */
export const SCREEN_TAIL_BYTES = 6000;
/** How much of the scrollback to REPLAY into a screen: enough to hold the last full repaint. */
export const REPLAY_TAIL_BYTES = 64 * 1024;
const MAX_LINES = 40;

/**
 * The screen as the operator would see it, not the bytes as they arrived. A TUI (Claude Code's Ink,
 * codex) redraws its frame with cursor-up + erase-line dozens of times a second, so the raw buffer
 * holds every stale repaint and a prompt's "question" read straight from it picks up lines that
 * are no longer on screen. Replaying the tail into a headless terminal of the pty's own size and
 * reading its rows back gives the frame that is actually there. One replay per quiet flip, a few
 * ms; the terminal is thrown away afterwards.
 */
export async function renderScreen(buffer: string, cols: number, rows: number): Promise<string[]> {
  const term = new Terminal({ cols: Math.max(20, cols | 0), rows: Math.max(4, rows | 0), scrollback: 200, allowProposedApi: true });
  const data = buffer.length > REPLAY_TAIL_BYTES ? buffer.slice(-REPLAY_TAIL_BYTES) : buffer;
  await new Promise<void>((resolve) => term.write(data, resolve));
  const b = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? "");
  try { term.dispose(); } catch {}
  return tidy(out);
}

function tidy(raw: string[]): string[] {
  return raw
    .map((l) => l.replace(/^[│┃]\s?/, "").replace(/\s?[│┃]\s*$/, "").replace(/\s+$/, ""))
    .filter((l) => l.trim().length > 0)
    .slice(-MAX_LINES);
}

// Claude Code and codex both mark the highlighted option with a pointer glyph. Bullet / plain-number
// rows are options without the cursor. Ordinal first, then label; the cursor may precede either.
const OPTION_RE = /^\s*(?:[❯>▶›]\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/;
const CURSOR_RE = /^\s*[❯>▶›]\s/;
const YN_RE = /\((?:y\/n|Y\/n|y\/N|yes\/no)\)|\[(?:y\/n|Y\/n|y\/N|yes\/no)\]|\b(?:yes|y)\s*\/\s*(?:no|n)\b\s*[:?]?\s*$/i;
// TUI chrome that sits under a prompt and must not be mistaken for its question.
const CHROME_RE = /^(?:[─━═┄╌\-_=]{3,}|[│┃╭╮╰╯└┘┌┐├┤]+.*|\s*(?:esc|enter|↑|↓|tab|shift\+tab|ctrl\+c)\b.*(?:cancel|select|confirm|toggle|interrupt|to\s).*|\?\s*for shortcuts.*|.*\bctrl\+[a-z]\b.*)$/i;

const ARROW_RE = /^(\s*)→\s/;
const KEY_HINT_RE = /\s+\((?:[a-z]|esc|tab|enter|shift\+tab|ctrl\+[a-z])(?:\s+or\s+[a-z]+)?\)\s*$/i;
// Status lines under a composer: cursor's "→ Add a follow-up", its "Auto · 7.5%" model/context line,
// and the cwd it prints last. None of them is what the agent said.
const FOOTER_RE = /^\s*(?:→\s*Add a follow-up.*|\S.*\s·\s\d+(?:\.\d+)?%.*|[~/]\S*)\s*$/;

/** The readable tail of a pty buffer: escapes stripped, box-drawing borders trimmed, blank lines dropped. */
export function screenLines(buffer: string): string[] {
  return tidy(stripAnsi(buffer.slice(-SCREEN_TAIL_BYTES)).split("\n"));
}

/** Rendered screen rows (renderScreen) or raw pty text (tests, and a fallback when a render fails). */
export function detectPrompt(screen: string | string[]): DeskPrompt | null {
  const lines = Array.isArray(screen) ? tidy(screen) : screenLines(screen);
  if (!lines.length) return null;

  // Select: read the option rows up from the bottom, skipping chrome under them.
  const opts: Array<{ n: number; label: string; cursor: boolean }> = [];
  let i = lines.length - 1;
  while (i >= 0 && CHROME_RE.test(lines[i].trim())) i--;
  while (i >= 0) {
    const m = OPTION_RE.exec(lines[i]);
    if (!m) break;
    opts.unshift({ n: Number(m[1]), label: m[2], cursor: CURSOR_RE.test(lines[i]) });
    i--;
  }
  // Two or more consecutive ordinals starting at 1 is a menu; a lone "1." is a list item in prose.
  if (opts.length >= 2 && opts[0].n === 1 && opts.every((o, k) => o.n === k + 1)) {
    const cur = Math.max(0, opts.findIndex((o) => o.cursor));
    return {
      kind: "select",
      question: questionAbove(lines, i),
      options: opts.map((o, k) => ({ label: o.label, offset: k - cur })),
    };
  }

  const arrow = arrowMenu(lines);
  if (arrow) return arrow;

  const last = lines[lines.length - 1].trim();
  const tail = lines.slice(-3).map((l) => l.trim()).filter((l) => !CHROME_RE.test(l));
  const lastReal = tail[tail.length - 1] ?? last;
  if (YN_RE.test(lastReal)) return { kind: "yn", question: lastReal.replace(/\s+/g, " ").slice(0, 300) };
  if (/\?\s*$/.test(lastReal) && !/^\?/.test(lastReal))
    return { kind: "question", question: lastReal.replace(/\s+/g, " ").slice(0, 300) };
  // A composer at rest: the CLI's own input box ("> " / "❯ ") is not the agent's last sentence.
  const said = [...lines].reverse().find((l) => !CHROME_RE.test(l.trim()) && !/^\s*[>❯]\s*$/.test(l) && !FOOTER_RE.test(l));
  return { kind: "turn", question: (said ?? "").replace(/\s+/g, " ").trim().slice(0, 300) };
}

/**
 * Cursor's menu: no ordinals, the highlighted row carries "→", the rest sit on the same text column,
 * each ending in its key hint — "→ Run (once) (y)" / "Skip & tell the agent … (esc or n)". Its idle
 * composer is a lone "→ Add a follow-up" with the status line under it, which is not a menu.
 */
function arrowMenu(lines: string[]): DeskPrompt | null {
  let end = lines.length - 1;
  while (end >= 0 && CHROME_RE.test(lines[end].trim())) end--;
  let ptr = -1;
  for (let k = end; k >= Math.max(0, end - 8); k--) if (ARROW_RE.test(lines[k])) { ptr = k; break; }
  if (ptr < 0) return null;
  const col = (ARROW_RE.exec(lines[ptr])![1].length) + 2;
  const onCol = (l: string) => l.length > col && l.slice(0, col).trim() === "" && l[col] !== " ";
  let top = ptr;
  while (top - 1 >= 0 && onCol(lines[top - 1]) && KEY_HINT_RE.test(lines[top - 1])) top--;
  for (let k = ptr + 1; k <= end; k++) if (!onCol(lines[k])) return null;
  const rows = lines.slice(top, end + 1);
  if (rows.length < 2) return null;
  const cur = ptr - top;
  return {
    kind: "select",
    question: questionAbove(lines, top - 1),
    options: rows.map((l, k) => ({ label: l.replace(ARROW_RE, "").trim().replace(KEY_HINT_RE, ""), offset: k - cur })),
  };
}

/** The sentence(s) directly above an option list — up to three lines, skipping borders. */
function questionAbove(lines: string[], from: number): string {
  const out: string[] = [];
  for (let k = from; k >= 0 && out.length < 3; k--) {
    const t = lines[k].trim();
    if (!t || CHROME_RE.test(t)) { if (out.length) break; else continue; }
    out.unshift(t);
  }
  return out.join(" ").replace(/\s+/g, " ").slice(0, 300);
}
