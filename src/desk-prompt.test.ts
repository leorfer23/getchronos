import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPrompt, renderScreen, screenLines } from "./desk-prompt.js";

const CLAUDE_PERMISSION = [
  "\x1b[2J\x1b[H⏺ I'll run the test suite now.",
  "",
  "╭──────────────────────────────────────────────────────────╮",
  "│ Bash command                                             │",
  "│                                                          │",
  "│   npm test                                               │",
  "│   Run the unit tests                                     │",
  "│                                                          │",
  "│ Do you want to proceed?                                  │",
  "│ \x1b[36m❯\x1b[0m 1. Yes                                                 │",
  "│   2. Yes, and don't ask again for npm test commands      │",
  "│   3. No, and tell Claude what to do differently (esc)    │",
  "╰──────────────────────────────────────────────────────────╯",
].join("\r\n");

test("a Claude Code permission prompt is a select with the cursor on Yes", () => {
  const p = detectPrompt(CLAUDE_PERMISSION)!;
  assert.equal(p.kind, "select");
  assert.match(p.question, /Do you want to proceed\?/);
  assert.deepEqual(p.options!.map((o) => o.label.slice(0, 12)), ["Yes", "Yes, and don", "No, and tell"]);
  assert.deepEqual(p.options!.map((o) => o.offset), [0, 1, 2]);
});

test("offsets are relative to the highlighted row, so Enter always takes what is highlighted", () => {
  const screen = [
    "Which branch should this land on?",
    "  1. main",
    "❯ 2. release/2026-09",
    "  3. Other",
    "Enter to select · Esc to cancel",
  ].join("\n");
  const p = detectPrompt(screen)!;
  assert.equal(p.kind, "select");
  assert.equal(p.question, "Which branch should this land on?");
  assert.deepEqual(p.options!.map((o) => o.offset), [-1, 0, 1]);
});

test("a y/n prompt is its own kind with the question kept", () => {
  const p = detectPrompt("Allow `git push --force`? (y/N) ")!;
  assert.equal(p.kind, "yn");
  assert.match(p.question, /git push --force/);
});

test("a bare question with no menu asks for free text", () => {
  const p = detectPrompt("⏺ Two candidates for the bug. Should I fix both, or just the Flyway one?\n")!;
  assert.equal(p.kind, "question");
  assert.match(p.question, /Flyway one\?$/);
});

test("a finished turn at the composer is 'turn', quoting the last thing said — not the composer", () => {
  const screen = [
    "⏺ Opened PR #312 with the fix. Tests are green.",
    "",
    "╭────────────────────────────────╮",
    "│ >                              │",
    "╰────────────────────────────────╯",
    "  ? for shortcuts",
  ].join("\n");
  const p = detectPrompt(screen)!;
  assert.equal(p.kind, "turn");
  assert.match(p.question, /Opened PR #312/);
});

test("a numbered list in prose is not a menu", () => {
  const screen = ["Plan:", "1. read the schema", "2. write the migration", "3. run tests", "", "Working…"].join("\n");
  assert.equal(detectPrompt(screen)!.kind, "turn");
});

test("only the tail of a big buffer is read, and empty screens yield nothing", () => {
  assert.equal(detectPrompt(""), null);
  const big = "x".repeat(20000) + "\nDo it? (y/n)";
  assert.equal(detectPrompt(big)!.kind, "yn");
  assert.ok(screenLines(big).length <= 40);
});

test("renderScreen reads the frame that is showing, not every repaint the buffer holds", async () => {
  // An Ink-style TUI: paints a frame, then moves the cursor up and repaints over it. The raw bytes
  // carry both frames; the screen carries one.
  const frame1 = "Which one?\r\n❯ 1. alpha\r\n  2. beta\r\n";
  const repaint = "\x1b[3A\x1b[2KWhich one?\r\n\x1b[2K  1. alpha\r\n\x1b[2K❯ 2. beta\r\n";
  const lines = await renderScreen("stale line from an earlier turn\r\n" + frame1 + repaint, 80, 24);
  assert.deepEqual(lines, ["stale line from an earlier turn", "Which one?", "  1. alpha", "❯ 2. beta"]);
  const p = detectPrompt(lines)!;
  assert.equal(p.kind, "select");
  assert.deepEqual(p.options!.map((o) => o.offset), [-1, 0]);
  // A clear-screen wipes what came before, so the question is not polluted by the old turn.
  const cleared = await renderScreen("old junk\r\n\x1b[2J\x1b[HDo it? (y/n) ", 80, 24);
  assert.deepEqual(cleared, ["Do it? (y/n)"]);
});

// Rendered from a live cursor-agent 2026.09.10 run on the Desk (no --force), 2026-09-14.
const CURSOR_APPROVAL = [
  "  Cursor Agent",
  "  v2026.09.10-fd3934a",
  "  [Pasted text #1 +1 lines]",
  "  I'll run uname -a and report the output.",
  "  $ uname -a Waiting for approval...",
  "────────────────────────────────────────────────────────────────────────",
  " $  uname -a in .",
  " Run this command?",
  " Not in allowlist: uname",
  "  → Run (once) (y)",
  "    Add Shell(uname) to allowlist? (tab)",
  "    Run Everything (shift+tab)",
  "    Skip & tell the agent what to do instead (esc or n)",
];

test("a cursor-agent approval is a select: arrow row highlighted, key hints dropped from labels", () => {
  const p = detectPrompt(CURSOR_APPROVAL)!;
  assert.equal(p.kind, "select");
  assert.match(p.question, /Run this command\? Not in allowlist: uname/);
  assert.deepEqual(p.options!.map((o) => o.label), [
    "Run (once)",
    "Add Shell(uname) to allowlist?",
    "Run Everything",
    "Skip & tell the agent what to do instead",
  ]);
  assert.deepEqual(p.options!.map((o) => o.offset), [0, 1, 2, 3]);
});

test("a finished cursor turn quotes the agent, not the follow-up composer, status line or cwd", () => {
  const p = detectPrompt([
    "  Cursor Agent",
    "  What codeword did I give you? Reply with just the word",
    "  PAPAYA",
    "  → Add a follow-up",
    "  Auto · 7.5%                                                          Run Everything",
    "  /private/tmp/scratchpad/cprobe",
  ])!;
  assert.equal(p.kind, "turn");
  assert.equal(p.question, "PAPAYA");
});
