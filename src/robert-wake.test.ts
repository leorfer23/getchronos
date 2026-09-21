import { test } from "node:test";
import assert from "node:assert/strict";
import { wakesRobert, buildWakePrompt, robertModelFor } from "./robert-wake.js";
import { getWebModel, setWebModel } from "./telegram/agent.js";
import { tgHtmlToMarkdown } from "./telegram/api.js";
import { kv } from "./store.js";

test("only review.created, blocked tickets, and ask.created wake Robert", () => {
  assert.equal(wakesRobert({ topic: "review.created", review_id: "r1", run_id: "x", ticket_id: "t1" } as any), true);
  // A review with no ticket has nothing for him to read — the wake would be a dead end.
  assert.equal(wakesRobert({ topic: "review.created", review_id: "r1", run_id: "x", ticket_id: null } as any), false);
  assert.equal(wakesRobert({ topic: "ticket.updated", ticket_id: "t1", status: "blocked" } as any), true);
  assert.equal(wakesRobert({ topic: "ticket.updated", ticket_id: "t1", status: "review" } as any), false);
  assert.equal(wakesRobert({ topic: "run.ended", run_id: "x", status: "success" } as any), false);
  assert.equal(
    wakesRobert({ topic: "ask.created", ask_id: "a1", run_id: "x", ticket_id: "t1", question: "q?" } as any),
    true
  );
  // Same rule as review.created: no ticket, nothing to triage against.
  assert.equal(
    wakesRobert({ topic: "ask.created", ask_id: "a1", run_id: "x", ticket_id: null, question: "q?" } as any),
    false
  );
});

test("telegram HTML survives the trip to the board as markdown", () => {
  assert.equal(
    tgHtmlToMarkdown("🙋 <b>Acme</b> · <code>ACM-71</code> needs a human"),
    "🙋 **Acme** · `ACM-71` needs a human"
  );
  // esc() writes these on the way in; a raw &lt; in the room would be the bug.
  assert.equal(tgHtmlToMarkdown("&lt;script&gt; &amp; more"), "<script> & more");
  assert.equal(tgHtmlToMarkdown('<a href="http://x/y">link</a>'), "[link](http://x/y)");
});

test("the ask wake defers to the ask-authority block instead of restating the rules", () => {
  const e = {
    topic: "ask.created",
    ask_id: "abcdef1234",
    run_id: "r1",
    ticket_id: "t1",
    ticket_key: "API-9",
    question: "which branch?",
  } as any;

  const open = buildWakePrompt(e, { key: "API-9" }, null);
  assert.match(open, /WHEN YOU DECIDE AND WHEN YOU ASK/);
  assert.match(open, /POST \/api\/asks\/abcdef12\/answer/);
  // The four escalate triggers live in agents/_blocks/ask-authority.md. A copy here is the copy
  // that goes stale, so the prompt must not grow one back.
  assert.doesNotMatch(open, /touches scope, money/);

  // ask_policy IS the prompt's job: the block cannot know this workspace shut the decide side.
  const escalate = buildWakePrompt(e, { key: "API-9" }, "escalate");
  assert.match(escalate, /ask_policy IS "escalate"/);
  assert.match(escalate, /Recommend; do not decide/);
  assert.doesNotMatch(escalate, /The decide side is genuinely open/);
});

test("review and blocked wakes still say what happened and forbid acting", () => {
  const review = buildWakePrompt(
    { topic: "review.created", review_id: "rev1", run_id: "run12345678", ticket_id: "t1" } as any,
    { key: "API-9" },
    null
  );
  assert.match(review, /API-9 just moved to REVIEW/);
  assert.match(review, /Do NOT approve, merge, or dispatch anything/);

  const blocked = buildWakePrompt(
    { topic: "ticket.updated", ticket_id: "t1", status: "blocked" } as any,
    { key: "API-9" },
    null
  );
  assert.match(blocked, /API-9 just went BLOCKED/);
});

test("robertModelFor follows the Desk pick and escalates on heavy keywords", () => {
  const prev = kv.get("web.model");
  try {
    kv.del("web.model");
    assert.equal(getWebModel(), "opus", "unset preference → voiceModel default (opus)");
    assert.equal(robertModelFor("what's blocked?"), "opus");

    setWebModel("haiku");
    assert.equal(robertModelFor("what's blocked?"), "haiku");
    assert.equal(robertModelFor("think hard about the architecture"), "opus");

    setWebModel("fable");
    assert.equal(robertModelFor("standup"), "fable");
  } finally {
    if (prev == null) kv.del("web.model");
    else kv.set("web.model", prev);
  }
});
