import { test } from "node:test";
import assert from "node:assert/strict";
import { ScreenMirror } from "./term-screen.js";
import { detectPrompt, renderScreen } from "./desk-prompt.js";

test("mirror shows the current frame as text, and seq moves only once parsed", async () => {
  const m = new ScreenMirror(40, 6);
  assert.equal(m.seq, 0);
  m.write("hello\r\nworld\r\n");
  await m.settle();
  assert.equal(m.seq, 1);
  assert.deepEqual(m.snapshot().lines, ["hello", "world"]);
  m.write("\x1b[2J\x1b[H> what next?");
  await m.settle();
  assert.equal(m.seq, 2);
  assert.deepEqual(m.snapshot().lines, ["> what next?"]);
  m.dispose();
});

test("only the viewport is kept — no scrollback to pay for", async () => {
  const m = new ScreenMirror(20, 4);
  m.write(["a", "b", "c", "d", "e", "f"].join("\r\n"));
  await m.settle();
  const s = m.snapshot();
  assert.equal(s.rows, 4);
  assert.deepEqual(s.lines, ["c", "d", "e", "f"]);
  m.dispose();
});

test("resize reflows and bumps seq; same size is a no-op", async () => {
  const m = new ScreenMirror(40, 6);
  m.write("x");
  await m.settle();
  const before = m.seq;
  m.resize(40, 6);
  assert.equal(m.seq, before);
  m.resize(60, 10);
  assert.equal(m.seq, before + 1);
  assert.equal(m.snapshot().cols, 60);
  m.dispose();
});

test("writes after dispose are ignored", async () => {
  const m = new ScreenMirror(40, 6);
  m.dispose();
  m.write("late");
  await m.settle();
  assert.equal(m.seq, 0);
});

/**
 * The substitution this module exists for: readPrompt() used to re-render the pty tail into a
 * throwaway headless terminal on every quiet flip (renderScreen). It now reads the always-on mirror.
 * Same bytes must give the same answer, or the wall's answer buttons change behaviour.
 */
test("mirror and a one-off re-render read the same prompt off the same bytes", async () => {
  const cases = [
    ["a select menu", "\x1b[2J\x1b[H" + ["Do you want to proceed?", "", "  1. Yes, go ahead", "  2. No, change something", "  3. Cancel", ""].join("\r\n")],
    ["a yes/no", "\x1b[2J\x1b[HOverwrite the file? (y/n) "],
    ["a bare question", "\x1b[2J\x1b[HWhich database should I point this at?"],
    ["a repaint that supersedes an earlier menu", "\x1b[2J\x1b[H  1. stale\r\n  2. old\r\n\x1b[2J\x1b[HReady for the next thing?"],
  ] as const;
  for (const [what, bytes] of cases) {
    const m = new ScreenMirror(80, 24);
    m.write(bytes);
    await m.settle();
    const viaMirror = detectPrompt(m.snapshot().lines);
    const viaRender = detectPrompt(await renderScreen(bytes, 80, 24));
    assert.deepEqual(viaMirror, viaRender, what);
    m.dispose();
  }
});

test("the mirror shows the CURRENT frame, not bytes an alt-screen TUI has already replaced", async () => {
  const m = new ScreenMirror(40, 8);
  m.write("\x1b[2J\x1b[HThinking…");
  m.write("\x1b[2J\x1b[HDone. Anything else?");
  await m.settle();
  assert.deepEqual(m.snapshot().lines, ["Done. Anything else?"]);
  m.dispose();
});
