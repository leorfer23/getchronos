/**
 * What a tool RESULT is worth to the Focus feed.
 *
 * The feed used to drop every result record, which cost the operator the two things a control board
 * needs most: that something FAILED, and the PR link `gh pr create` printed to stdout and the agent
 * never repeated. Both are parsed here — nothing else about a result enters the feed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { claudeLine, failureText, printedLinks } from "./focus.js";

const call = (id: string, command: string) =>
  ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const result = (id: string, content: string, is_error = false) =>
  ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } });

test("a failed call is an error event that names the call and keeps the exit code", () => {
  claudeLine(call("tu_a", "npm test -- focus"), 1);
  const evs = claudeLine(result("tu_a", "Exit code 1\n\n3 tests failed\nsecond line\nthird line", true), 2);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, "error");
  assert.equal(evs[0].text, "run npm test -- focus failed (exit 1): 3 tests failed — second line");
  assert.equal(evs[0].seq, 2000, "seq stays lineNo*1000 + block index, so live and REST dedupe");
});

test("a result whose call was never seen still reports, without inventing a name", () => {
  const evs = claudeLine(result("unknown-id", "<tool_use_error>InputValidationError: bad input</tool_use_error>", true), 7);
  assert.equal(evs[0].text, "a tool call failed: InputValidationError: bad input");
});

test("the operator interrupting is not a failure", () => {
  assert.deepEqual(claudeLine(result("tu_a", "Request interrupted by user", true), 3), []);
});

test("a clean result is silent unless it printed a link", () => {
  assert.deepEqual(claudeLine(result("tu_a", "ok\n42 files changed"), 4), []);
  const evs = claudeLine(result("tu_a", "https://github.com/leorfer23/getchronos/pull/12\n"), 5);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, "act");
  assert.equal(evs[0].text, "printed https://github.com/leorfer23/getchronos/pull/12");
});

test("links are capped, deduped and survive a huge log", () => {
  const noise = "x".repeat(300_000);
  const out = printedLinks(noise + "\nhttps://github.com/o/r/pull/1 https://github.com/o/r/pull/1 https://github.com/o/r/pull/2");
  assert.deepEqual(out, ["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"]);
});

test("a failure with no body still says what failed", () => {
  assert.equal(failureText("run gh pr merge", ""), "run gh pr merge failed");
  assert.equal(failureText(null, "Error: Exit code 2"), "a tool call failed (exit 2)");
});

test("a subagent's own transcript stays out of the parent feed", () => {
  const sidechain = { ...result("tu_a", "Exit code 1\nboom", true), isSidechain: true };
  assert.deepEqual(claudeLine(sidechain, 9), []);
});
