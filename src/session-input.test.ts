/**
 * Typing into someone else's terminal: the rate cap, and the Telegram tier that guards it.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "./store.js";
import { INPUT_MAX, INPUT_WINDOW_MS, inputAllowed, noteInput, sendInput } from "./terminal.js";
import { isSafeProposal } from "./telegram/agent.js";

beforeEach(() => {
  db.exec("DELETE FROM sessions; DELETE FROM workspaces;");
});

test("a terminal takes a bounded number of injected inputs per minute, per terminal", () => {
  const a = "card-a", b = "card-b";
  const t0 = Date.now();
  for (let i = 0; i < INPUT_MAX; i++) {
    assert.equal(inputAllowed(a, t0), true, `input ${i + 1} of ${INPUT_MAX} should be allowed`);
    noteInput(a, t0);
  }
  // Cap reached: this is what stops an overseer that answers a card, sees it go quiet, and answers
  // again from looping with it — it gets an error it can report instead of a bill you find later.
  assert.equal(inputAllowed(a, t0), false);
  // The cap is per terminal, and the window rolls.
  assert.equal(inputAllowed(b, t0), true);
  assert.equal(inputAllowed(a, t0 + INPUT_WINDOW_MS + 1), true);
});

test("sendInput refuses a terminal that isn't live, and an empty request", () => {
  assert.equal(sendInput("no-such-session", { text: "hello" }), "terminal is not live");
  assert.equal(sendInput("no-such-session", {}), "terminal is not live");
});

test("typing into a terminal is never a safe-tier Telegram proposal", () => {
  // Robert on Telegram proposes; the daemon tiers. Spawning a terminal is safe (reversible, it's his
  // daily drive) — typing into one that is already running someone else's work is not.
  assert.equal(isSafeProposal({ label: "spawn", method: "POST", path: "/api/sessions", body: {} } as any), true);
  assert.equal(
    isSafeProposal({ label: "type", method: "POST", path: "/api/sessions/abc/input", body: { text: "yes" } } as any),
    false,
  );
  assert.equal(
    isSafeProposal({ label: "type", method: "POST", path: "/api/sessions/abc/input?x=1", body: {} } as any),
    false,
  );
});
