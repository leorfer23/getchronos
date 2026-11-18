/**
 * A line typed to a working Claude that Claude Code folded into the running turn.
 *
 * Claude Code 2.1.x drops such a line from its queue (`queue-operation remove`, reason
 * `absorbed_mid_turn`) and records it only as a `queued_command` attachment — never a `type:"user"`
 * line. The feed read only user lines, so Talk lost the operator's message while the agent had read it.
 * Shapes below are copied from real transcripts (2026-11-16/17).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { claudeLine } from "./focus.js";

const queued = (attachment: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "attachment",
  isSidechain: false,
  timestamp: "2026-11-17T16:53:36.446Z",
  attachment: { type: "queued_command", commandMode: "prompt", origin: { kind: "human" }, humanTurn: true, timestamp: "2026-11-17T16:53:36.446Z", ...attachment },
  ...extra,
});

test("a line absorbed mid-turn is the operator talking", () => {
  const evs = claudeLine(queued({ prompt: "When we do it we also need to update this one" }), 231);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, "user");
  assert.equal(evs[0].text, "When we do it we also need to update this one");
  assert.equal(evs[0].seq, 231000);
  assert.equal(evs[0].ts, Date.parse("2026-11-17T16:53:36.446Z"));
});

test("a pasted prompt made of content blocks keeps its text, reminders stripped", () => {
  const evs = claudeLine(queued({ prompt: [{ type: "text", text: "look at this <system-reminder>noise</system-reminder>" }] }), 3);
  assert.deepEqual(evs.map((e) => [e.kind, e.text]), [["user", "look at this"]]);
});

test("task notifications, peer messages, slash plumbing and subagent lines are not you", () => {
  assert.deepEqual(claudeLine(queued({ commandMode: "task-notification", origin: { kind: "task-notification" }, prompt: "<task-notification>x</task-notification>" }), 1), []);
  assert.deepEqual(claudeLine(queued({ origin: { kind: "peer" }, prompt: "from another session" }), 1), []);
  assert.deepEqual(claudeLine(queued({ prompt: "<command-name>/compact</command-name>" }), 1), []);
  assert.deepEqual(claudeLine(queued({ prompt: "hi" }, { isSidechain: true }), 1), []);
  assert.deepEqual(claudeLine(queued({ prompt: "   " }), 1), []);
});

test("other attachments add nothing", () => {
  assert.deepEqual(claudeLine({ type: "attachment", attachment: { type: "output_style", style: "Receipts" } }, 1), []);
});
