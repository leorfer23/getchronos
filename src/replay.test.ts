import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, events, jobs, runs } from "./store.js";
import { capTail, renderReplay, transcriptLines } from "./replay.js";

beforeEach(() => {
  db.exec("DELETE FROM run_events; DELETE FROM runs; DELETE FROM jobs;");
});

const row = (type: string, payload: unknown) => ({ type, payload: JSON.stringify(payload) });

test("transcriptLines: claude stream-json — text, tool calls, tool results, final result", () => {
  const lines = transcriptLines([
    row("system", { type: "system", subtype: "init" }),
    row("assistant", {
      message: {
        content: [
          { type: "text", text: "Looking at the repo now." },
          { type: "tool_use", name: "Bash", input: { command: "git status" } },
        ],
      },
    }),
    row("user", {
      message: {
        content: [
          { type: "tool_result", content: [{ type: "text", text: "clean tree" }] },
          { type: "text", text: "also, prefer bun" },
        ],
      },
    }),
    row("result", { type: "result", result: "All done." }),
  ]);
  assert.deepEqual(lines, [
    "assistant: Looking at the repo now.",
    'tool Bash: {"command":"git status"}',
    "tool_result: clean tree",
    "user: also, prefer bun",
    "result: All done.",
  ]);
});

test("transcriptLines: text deltas coalesce into one assistant line; junk is skipped", () => {
  const lines = transcriptLines([
    row("text", { data: "Half a " }),
    row("text", { data: "thought." }),
    { type: "assistant", payload: "not json{{" },
    row("result", { result: "ok" }),
  ]);
  assert.deepEqual(lines, ["assistant: Half a thought.", "result: ok"]);
});

test("transcriptLines: long entries are clipped", () => {
  const lines = transcriptLines([row("result", { result: "x".repeat(2000) })]);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].length < 700);
  assert.ok(lines[0].endsWith("…"));
});

test("capTail keeps the newest lines within budget and counts the dropped head", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line-${i}-${"y".repeat(50)}`);
  const { lines: kept, dropped } = capTail(lines, 600);
  assert.ok(kept.length < 100);
  assert.equal(dropped, 100 - kept.length);
  assert.equal(kept[kept.length - 1], lines[99]);
  assert.equal(kept[0], lines[100 - kept.length]);
});

test("renderReplay: null without events, fenced JSON-escaped replay with them", () => {
  const job = jobs.create({ name: "replay-test", goal: "g", cwd: "/tmp", sandbox: "off" });
  const run = runs.create(job.id, "test");
  assert.equal(renderReplay(run.id, "hit a rate limit"), null);

  events.add(run.id, "assistant", { message: { content: [{ type: "text", text: 'said "quoted" things' }] } });
  events.add(run.id, "result", { result: "partial work committed" });
  const block = renderReplay(run.id, "hit a rate limit")!;
  assert.match(block, /hit a rate limit/);
  assert.match(block, /<<<BEGIN REPLAYED TRANSCRIPT\n/);
  assert.match(block, /\nEND REPLAYED TRANSCRIPT>>>/);
  assert.match(block, /unknown outcome/);
  assert.ok(block.includes(JSON.stringify('assistant: said "quoted" things')));
  assert.ok(block.includes(JSON.stringify("result: partial work committed")));
  assert.equal(renderReplay("no-such-run", "x"), null);
});

test("runs.bySession finds the latest run that owned a session", () => {
  const job = jobs.create({ name: "bysess", goal: "g", cwd: "/tmp", sandbox: "off" });
  const a = runs.create(job.id, "test");
  const b = runs.create(job.id, "test");
  runs.patch(a.id, { session_id: "sess-1" });
  runs.patch(b.id, { session_id: "sess-1" });
  assert.equal(runs.bySession("sess-1")?.id, b.id);
  assert.equal(runs.bySession("nope"), undefined);
});
