/**
 * The Desk's blank terminal: a card you open before you know what the work is.
 *
 * The dialog is plain HTML in static/desk.html, so the regression this guards is an attribute — the
 * goal field was `required`, which made "just give me a terminal" impossible from the only surface
 * that opens one. These assertions read the shipped file: there is no build step to catch it.
 * (The field is a one-line textarea since goals became a queue — one goal per line, src/goals.ts.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { OpenSessionSchema } from "./validation.js";

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");

test("the spawn dialog's goal field is optional", () => {
  const field = html.match(/<textarea name="goal"[^>]*>/)?.[0];
  assert.ok(field, "goal field still exists");
  assert.doesNotMatch(field!, /\brequired\b/);
});

test("the dialog offers Blank, and N opens one from the wall", () => {
  assert.match(html, /id="f-blank"/);
  assert.match(html, /if \(!goal\) return spawn\(body\);/);
  assert.match(html, /e\.key === "n" \|\| e\.key === "N"/);
  // Blank must not carry a kind: a "pr" badge on a scratch terminal is a claim about work nobody
  // described. The dialog's own submit drops it too when the goal is empty.
  assert.match(html, /goal_kind: \(goal && f\.get\("goal_kind"\)\) \|\| null/);
});

test("the daemon accepts a session with no goal at all", () => {
  const parsed = OpenSessionSchema.safeParse({ workspace_id: "ws1", backend: "claude-code", role: "human" });
  assert.equal(parsed.success, true, parsed.success ? "" : String(parsed.error));
  assert.equal(OpenSessionSchema.safeParse({ goal: null, goal_kind: null }).success, true);
});
