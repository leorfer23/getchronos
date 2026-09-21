/**
 * `mc ask-robert`: how Robert's verdict is read, and what he is asked in the first place.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict, triagePrompt } from "./ask-robert.js";
import { describeClip } from "./clipboard.js";

const ask = (over: Record<string, unknown> = {}): any => ({
  id: "a".repeat(32),
  run_id: null,
  job_id: null,
  session_id: null,
  asked_by: "acme terminal",
  route: "robert",
  triage: null,
  escalated_at: null,
  ticket_id: null,
  workspace_id: null,
  question: "staging or prod schema?",
  options: null,
  answer: null,
  answered_by: null,
  status: "open",
  created_at: new Date().toISOString(),
  answered_at: null,
  ...over,
});

describe("parseVerdict", () => {
  test("reads an answer he is taking himself", () => {
    assert.deepEqual(parseVerdict("ANSWER: use the staging schema"), {
      kind: "answer",
      text: "use the staging schema",
    });
  });

  test("reads both escalation spellings", () => {
    assert.deepEqual(parseVerdict("ASK LEO: this touches prod"), { kind: "escalate", text: "this touches prod" });
    assert.deepEqual(parseVerdict("ESCALATE: needs his call"), { kind: "escalate", text: "needs his call" });
  });

  test("is case- and whitespace-tolerant, and keeps the lines after the verdict", () => {
    const v = parseVerdict("  answer:  use staging\nit is what the memo says  ");
    assert.equal(v?.kind, "answer");
    assert.equal(v?.text, "use staging\nit is what the memo says");
  });

  test("returns null for prose with no verdict — which the caller escalates", () => {
    // The important half: an unparseable reply must NOT read as an answer. A terminal is blocked on
    // this, and inventing an answer out of Robert's musing is the one unrecoverable outcome.
    assert.equal(parseVerdict("I think they probably want staging, but it depends"), null);
    assert.equal(parseVerdict(""), null);
    assert.equal(parseVerdict("ANSWER:"), null);
    assert.equal(parseVerdict("ANSWER"), null);
  });

  test("does not match a verdict buried mid-reply", () => {
    // Only the FIRST line is the decision. Otherwise a reply that merely discusses the word ANSWER
    // could be executed as one.
    assert.equal(parseVerdict("Here's my thinking.\nANSWER: use staging"), null);
  });
});

describe("triagePrompt", () => {
  test("offers both paths, and tells him unsure means escalate", () => {
    const p = triagePrompt(ask(), false);
    assert.ok(p.includes("ANSWER:"));
    assert.ok(p.includes("ASK LEO:"));
    assert.ok(p.includes("staging or prod schema?"));
    assert.ok(/not sure/i.test(p));
    assert.ok(/BLOCKED/.test(p));
  });

  test("takes the answer path away entirely when the workspace requires a human", () => {
    // Mirrors the hard gate in answerAsk: in an ask_policy:'escalate' workspace, offering him the
    // option at all would earn a rejected API call and a terminal waiting out the deadline instead.
    const p = triagePrompt(ask(), true);
    assert.ok(p.includes("ASK LEO:"));
    assert.ok(!/^\s*ANSWER:/m.test(p));
    assert.ok(/REQUIRES a human answer/.test(p));
  });

  test("names the asker so the decision is about a specific terminal", () => {
    const p = triagePrompt(ask({ asked_by: "globex · fix the dbt model" }), false);
    assert.ok(p.includes("globex · fix the dbt model"));
  });
});

describe("describeClip", () => {
  test("describes shape without ever echoing the content", () => {
    const token = "sk_live_9aXbY7zQ1mNpR4tU6vW8";
    const d = describeClip(token);
    assert.ok(/token-ish/.test(d));
    assert.ok(!d.includes(token));
    assert.ok(!d.includes("sk_live"));
  });

  test("names the common shapes", () => {
    assert.equal(describeClip(""), "empty");
    assert.ok(/^url/.test(describeClip("https://github.com/x/y/pull/3")));
    assert.ok(/^one line/.test(describeClip("just a sentence")));
    assert.ok(/^3 lines/.test(describeClip("a\nb\nc")));
  });

  test("never leaks a multi-line secret through the line count", () => {
    const d = describeClip("-----BEGIN KEY-----\nabc123\n-----END KEY-----");
    assert.ok(/^3 lines/.test(d));
    assert.ok(!d.includes("abc123"));
  });
});
