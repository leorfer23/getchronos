import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, events, jobs, runs } from "../store.js";

// run_events.run_id is a real FK — seed a job + two runs and use their real ids.
let r1: string, r2: string;
beforeEach(() => {
  db.exec("DELETE FROM run_events; DELETE FROM runs; DELETE FROM jobs;");
  const j = jobs.create({ name: "ticket:T-1", goal: "g" });
  r1 = runs.create(j.id, "ticket:T-1").id;
  r2 = runs.create(j.id, "ticket:T-1").id;
});

const toolEvent = (name: string, input: any) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", name, input }] },
});
const textEvent = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

test("tailLines: readable tool + text lines, oldest→newest, junk skipped", () => {
  events.add(r1, "message", textEvent("Reading the failing test first."));
  events.add(r1, "message", { type: "system", noise: true }); // no renderable content
  events.add(r1, "message", toolEvent("Bash", { command: "npm test" }));
  events.add(r2, "message", textEvent("other run — must not leak"));
  const lines = events.tailLines(r1);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Reading the failing test first\./);
  assert.match(lines[1], /npm test/);
});

test("tailLines caps at the limit, keeping the newest lines", () => {
  for (let i = 0; i < 20; i++) events.add(r1, "message", textEvent(`line ${i}`));
  const lines = events.tailLines(r1, 3);
  assert.equal(lines.length, 3);
  assert.match(lines[2], /line 19/);
  assert.match(lines[0], /line 17/);
});

test("tailLines flattens multi-line prose to one snippet", () => {
  events.add(r1, "message", textEvent("first\nsecond   third\n" + "x".repeat(400)));
  const [line] = events.tailLines(r1);
  assert.ok(!line.includes("\n"));
  assert.ok(line.length <= 160);
});
