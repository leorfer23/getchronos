import { test } from "node:test";
import assert from "node:assert/strict";
import { ONCE_CATCHUP_MS, onceDecision } from "./once.js";
import { storyFromEvents } from "./run-story.js";
import { isInternalJob } from "./job-name.js";

const now = Date.parse("2026-09-12T12:00:00Z");
const iso = (ms: number) => new Date(now + ms).toISOString();

test("a one-time job schedules in the future, fires if recently missed and never ran, retires otherwise", () => {
  assert.equal(onceDecision(iso(60_000), false, now), "schedule");
  assert.equal(onceDecision(iso(-60_000), false, now), "fire", "the daemon slept through it a minute ago");
  assert.equal(onceDecision(iso(-60_000), true, now), "retire", "it already ran");
  assert.equal(onceDecision(iso(-ONCE_CATCHUP_MS - 1), false, now), "retire", "too old to fire at a random hour");
  assert.equal(onceDecision(null, false, now), "retire");
  assert.equal(onceDecision("not a date", false, now), "retire");
});

test("a run's story comes from its own assistant/user events, same adapter as a terminal transcript", () => {
  const events = [
    { type: "system", payload: { type: "system", subtype: "init" } },
    { type: "assistant", payload: { type: "assistant", timestamp: "2026-09-12T12:00:01Z", message: { content: [
      { type: "text", text: "Understanding: check the nightly export and report." },
      { type: "tool_use", name: "Bash", input: { command: "ls exports/" } },
    ] } } },
    { type: "assistant", payload: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Result: 3 files, all fresh." }] } }) },
    { type: "result", payload: { type: "result", total_cost_usd: 0.1 } },
  ];
  const story = storyFromEvents(events);
  assert.deepEqual(story.map((e) => e.kind), ["understanding", "act", "result"]);
  assert.equal(story[1].text, "run ls exports/");
  assert.ok(story[0].seq < story[2].seq, "seq follows event order so the Desk can sort and dedupe");
});

test("the machinery's own jobs are internal; anything the operator names is not", () => {
  for (const n of ["ticket:PER-9", "review:ATL-1", "plan:X", "grade:X", "ci-fix:PER-80", "fallback:review:PER-80", "ideas:followups:PER-72"]) assert.equal(isInternalJob(n), true, n);
  for (const n of ["airflow-morning-check", "slack-triage:atlas", "buzz-agent:grok", "", null]) assert.equal(isInternalJob(n), false, String(n));
});
