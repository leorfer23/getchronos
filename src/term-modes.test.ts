import { test } from "node:test";
import assert from "node:assert/strict";
import { ModeTracker, isTerminalReply } from "./term-modes.js";

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

test("the terminal answering for itself is not input; anything typed is", () => {
  for (const d of ["\x1b[I", "\x1b[O", "\x1b[I\x1b[O", "\x1b[24;80R", "\x1b[0n", "\x1b[?1;2c", "\x1b[>0;276;0c",
    "\x1b[?2004;1$y", "\x1b]11;rgb:0000/0000/0000\x07", "\x1b]10;rgb:ffff/ffff/ffff\x1b\\", "\x1b[<64;10;5M", "\x1b[<0;3;4m"])
    assert.equal(isTerminalReply(d), true, JSON.stringify(d));
  for (const d of ["", "a", "\r", "\x1b", "\x1b[A", "\x03", "\x1b[200~hi\x1b[201~", "\x1b[Ix", "y\x1b[O"])
    assert.equal(isTerminalReply(d), false, JSON.stringify(d));
});
