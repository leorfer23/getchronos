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

// Claude Code 2.1.312's permission menu as a 120×40 pty frame shows it (captured live, 2026-10-28): no
// box any more, dashed rules round the command, a fourth row offering auto mode, and option 2's
// path wrapped onto an indented line of its own.
const CLAUDE_PERMISSION_2_1 = [
  "⏺ Creating probe-dir and writing date stamp",
  "  ⎿  $ mkdir -p probe-dir && date > probe-dir/stamp.txt",
  "─".repeat(120),
  " Bash command",
  " Tip: auto mode handles these prompts for you — choose \"switch to auto mode\" below",
  " Create probe-dir and write date stamp",
  "╌".repeat(120),
  " mkdir -p probe-dir && date > probe-dir/stamp.txt",
  "╌".repeat(120),
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again for mkdir -p probe-dir and date commands in",
  "      /private/tmp/probe-work",
  "   3. Yes, and switch to auto mode · auto mode handles these prompts for you",
  "   4. No",
  " Esc to cancel · Tab to amend",
];

test("Claude Code 2.1's permission menu reads as a select: every row, the wrapped path kept with its row", () => {
  const p = detectPrompt(CLAUDE_PERMISSION_2_1)!;
  assert.equal(p.kind, "select");
  assert.equal(p.question, "Do you want to proceed?");
  assert.deepEqual(p.options!.map((o) => o.label), [
    "Yes",
    "Yes, and don't ask again for mkdir -p probe-dir and date commands in",
    "Yes, and switch to auto mode · auto mode handles these prompts for you",
    "No",
  ]);
  assert.equal(p.options![1].detail, "/private/tmp/probe-work");
  assert.deepEqual(p.options!.map((o) => o.offset), [0, 1, 2, 3]);
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

// Claude Code's AskUserQuestion, as the rendered frame reads (shape copied from a live terminal):
// a tab bar, the question in a bordered block, options with their descriptions under them, then a
// rule and "Chat about this" below "Type something.".
const ASK_USER_QUESTION = [
  "⏺ Two of the three reports are already on main. I'll ask before scoping the rest.",
  "────────────────────────────────────────────────────────────────────────────────",
  " ☐ Scope ",
  "",
  "│ The notes doc has 3 reports left to build: Ending AR, Fee Accrual and Payouts ",
  "│ (the other two are already on main). What should this terminal cover?",
  "  ",
  "❯ 1. 3 PRs, one per report (Recommended)",
  "     One PR per report with every agreed change. Open decisions get a safe default",
  "     and are listed back for review. ~3-4h.",
  "  2. Fee Accrual only first",
  "     The only one with a gap in the totals.",
  "  3. Reply first",
  "     No code. Send the list of decisions that need a call before building.",
  "  4. Type something.",
  "────────────────────────────────────────────────────────────────────────────────",
  "  5. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
];

test("an AskUserQuestion dialog is a select: descriptions and the rule above 'Chat about this' stay inside the menu", () => {
  const p = detectPrompt(ASK_USER_QUESTION)!;
  assert.equal(p.kind, "select");
  assert.deepEqual(p.options!.map((o) => o.label), ["3 PRs, one per report (Recommended)", "Fee Accrual only first", "Reply first", "Type something.", "Chat about this"]);
  assert.deepEqual(p.options!.map((o) => o.offset), [0, 1, 2, 3, 4]);
  assert.match(p.options![0].detail!, /^One PR per report .* ~3-4h\.$/);
  assert.equal(p.options![3].detail, undefined);
  // The whole question, not its last three rows — and not the tab bar above it.
  assert.match(p.question, /^The notes doc has 3 reports left .* What should this terminal cover\?$/);
});

test("indented rows above a menu are the question's, not an option's", () => {
  const p = detectPrompt(["Pick a target", "     (staging is down today)", "❯ 1. prod", "  2. staging"])!;
  assert.equal(p.kind, "select");
  assert.equal(p.options![0].detail, undefined);
  assert.match(p.question, /staging is down today/);
});

// Claude Code 2.1.329's AskUserQuestion with multiSelect, captured from a live TUI (2026-11-20). Each
// box is "[✔] label" / "[ ] label"; the last box is its free-text row; an unnumbered "Submit" (or
// "Next" when more questions follow) sits under it, and the cursor walks through that row too.
const MULTI = (cursor: string, row = "Submit") => [
  "────────────────────────────────────────────────────────────────────────────────────────────────────",
  "←  ☒ Build  ✔ Submit  →",
  "",
  "Which options do you want to include in the build?",
  "",
  `${cursor === "1" ? "❯" : " "} 1. [✔] Alpha`,
  "         First option in the build set.",
  `${cursor === "2" ? "❯" : " "} 2. [ ] Bravo`,
  "         Second option in the build set.",
  `${cursor === "3" ? "❯" : " "} 3. [ ] Type something`,
  `${cursor === "submit" ? "❯" : " "}    ${row}`,
  "────────────────────────────────────────────────────────────────────────────────────────────────────",
  `${cursor === "4" ? "❯" : " "} 4. Chat about this`,
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
];

test("a multi-select: each box's tick, its label without the box, and the Submit row counted from the cursor", () => {
  const p = detectPrompt(MULTI("1"))!;
  assert.equal(p.kind, "select");
  assert.equal(p.question, "Which options do you want to include in the build?");
  assert.deepEqual(p.options!.map((o) => [o.label, o.offset, o.checked]), [
    ["Alpha", 0, true], ["Bravo", 1, false], ["Type something", 2, false], ["Chat about this", 4, undefined],
  ]);
  assert.equal(p.options![0].detail, "First option in the build set.");
  assert.deepEqual(p.submit, { label: "Submit", offset: 3 });
});

test("the cursor on the Submit row: still a menu, every offset counted from that row", () => {
  // It used to end the menu there: no option had the cursor and the frame read as no menu at all.
  const p = detectPrompt(MULTI("submit"))!;
  assert.equal(p.kind, "select");
  assert.deepEqual(p.options!.map((o) => o.offset), [-3, -2, -1, 1]);
  assert.deepEqual(p.submit, { label: "Submit", offset: 0 });
  assert.deepEqual(detectPrompt(MULTI("4", "Next"))!.submit, { label: "Next", offset: -1 });
});

test("its review screen is a plain menu: Submit answers / Cancel", () => {
  const p = detectPrompt(["←  ☒ Build  ✔ Submit  →", "", "Review your answers", " ", " ● Which options do you want?", "   → Alpha, Charlie", "", "❯ 1. Submit answers", "  2. Cancel"])!;
  assert.deepEqual(p.options!.map((o) => [o.label, o.offset]), [["Submit answers", 0], ["Cancel", 1]]);
  assert.equal(p.submit, undefined);
});

test("a description that reads 'Next' under a plain option is not a Submit row", () => {
  const p = detectPrompt(["Pick one", "", "❯ 1. Go on", "     Next", "  2. Stop"])!;
  assert.deepEqual(p.options!.map((o) => [o.label, o.offset]), [["Go on", 0], ["Stop", 1]]);
  assert.equal(p.submit, undefined);
  assert.equal(p.options![0].checked, undefined);
});
