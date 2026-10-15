import { test } from "node:test";
import assert from "node:assert/strict";
import { OP_LABEL, OP_MARK, OP_PREFIX, isOperational, stripOperational } from "./operational-prefix.js";
import { buildWakePrompt } from "./robert-wake.js";

test("the mark is U+2063 and the prefix is mark + label", () => {
  assert.equal(OP_MARK.codePointAt(0), 0x2063);
  assert.equal(OP_MARK.length, 1);
  assert.equal(OP_PREFIX, OP_MARK + OP_LABEL);
  // The label ends in a space so the injected text reads as a sentence, not a jammed token.
  assert.equal(OP_LABEL, "CHRONOS_OP: ");
});

test("isOperational matches the whole-message opening only", () => {
  assert.equal(isOperational(`${OP_PREFIX}9am brief`), true);
  assert.equal(isOperational("status?"), false);
  // The operator quoting a notification back at him is still the operator speaking.
  assert.equal(isOperational(`what did you mean by ${OP_PREFIX}9am brief`), false);
  // The label without the mark is typeable, so it must not count on its own.
  assert.equal(isOperational("CHRONOS_OP: fake"), false);
  assert.equal(isOperational(OP_MARK + "just a separator"), false);
  assert.equal(isOperational(""), false);
  assert.equal(isOperational(undefined as unknown as string), false);
});

test("stripOperational removes the prefix and leaves a real message untouched", () => {
  assert.equal(stripOperational(`${OP_PREFIX}9am brief`), "9am brief");
  assert.equal(stripOperational("status?"), "status?");
  assert.equal(stripOperational(`${OP_PREFIX}`), "");
  // Only the opening copy goes; a quoted one inside the text is content.
  assert.equal(
    stripOperational(`${OP_PREFIX}he asked about ${OP_PREFIX}x`),
    `he asked about ${OP_PREFIX}x`
  );
});

test("every robert-wake prompt opens with the marker", () => {
  const cases = [
    { topic: "ask.created", ask_id: "abcdef1234", run_id: "r", ticket_id: "t1", question: "q?" },
    { topic: "review.created", review_id: "rev", run_id: "run12345678", ticket_id: "t1" },
    { topic: "ticket.updated", ticket_id: "t1", status: "blocked" },
  ];
  for (const e of cases)
    for (const policy of [null, "escalate"]) {
      const p = buildWakePrompt(e as any, { key: "API-9" }, policy);
      assert.ok(isOperational(p), `${e.topic}/${policy} must be marked operational`);
      // The old hand-written lead-in is gone, not merely prefixed: two markers is one too many.
      assert.doesNotMatch(p, /SYSTEM — /);
    }
});
