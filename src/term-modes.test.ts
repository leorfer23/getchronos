import { test } from "node:test";
import assert from "node:assert/strict";
import { ModeTracker } from "./term-modes.js";

test("mouse tracking set at boot survives any amount of later output", () => {
  const t = new ModeTracker();
  t.feed("\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h");
  t.feed("x".repeat(600_000));
  assert.equal(t.preamble(), "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h");
});

test("last write wins and moves the mode to the end", () => {
  const t = new ModeTracker();
  t.feed("\x1b[?1003h\x1b[?1000h\x1b[?1003l\x1b[?1003h");
  assert.equal(t.preamble(), "\x1b[?1000h\x1b[?1003h");
});

test("combined params and untracked modes", () => {
  const t = new ModeTracker();
  t.feed("\x1b[?2026h\x1b[?1049;1006h\x1b[?12h");
  assert.equal(t.preamble(), "\x1b[?1049h\x1b[?1006h");
});

test("a sequence split across chunks is still seen", () => {
  const t = new ModeTracker();
  t.feed("hello \x1b[?10");
  t.feed("06h world");
  t.feed("\x1b");
  t.feed("[?1000h");
  assert.equal(t.preamble(), "\x1b[?1006h\x1b[?1000h");
});

test("a finished sequence at the chunk end is not double counted", () => {
  const t = new ModeTracker();
  t.feed("\x1b[?1000h");
  t.feed("\x1b[?1000l");
  assert.equal(t.preamble(), "\x1b[?1000l");
});

test("nothing seen, nothing sent", () => {
  const t = new ModeTracker();
  t.feed("plain \x1b[31mred\x1b[0m");
  assert.equal(t.preamble(), "");
});
