/**
 * Robert's chat panel: a turn of his must never lock the composer.
 *
 * The regression this guards is behavioural and lives entirely in static/desk.html, which has no
 * build step: the submit handler used to bail on `OV.busy` and disable the send button, so anything
 * The operator thought of while Robert was mid-turn had to be held in their head until he finished.
 * Now it queues, and ⌘⏎ (or ⏹) stops his turn so the new message goes in first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
const api = fs.readFileSync(path.join(process.cwd(), "src/api.ts"), "utf8");
const cmds = fs.readFileSync(path.join(process.cwd(), "src/commands.ts"), "utf8");

test("the composer accepts a message while he is working", () => {
  // No bail-on-busy, and nothing disables the send button any more.
  assert.doesNotMatch(html, /if \(!text \|\| OV\.busy\) return/);
  assert.doesNotMatch(html, /#chat-send"\)\.disabled/);
  assert.match(html, /OV\.queue\.push\(\{ text, bub, atts \}\)/); // atts: whatever was pasted/dropped for this line
  // Queued messages are visibly queued, and go in one at a time, in order.
  assert.match(html, /ovLine\("you" \+ \(OV\.busy \? " queued" : ""\), text, OV\.sticky \?\? undefined\)/);
  assert.match(html, /const item = OV\.queue\.shift\(\)/);
});

test("⌘⏎ and ⏹ stop the in-flight turn so the queued message goes in now", () => {
  assert.match(html, /e\.key === "Enter" && \(e\.metaKey \|\| e\.ctrlKey\)[^\n]*ask\(true\)/);
  assert.match(html, /qs\("#chat-stop"\)\.onclick = \(\) => stopTurn\(\)/);
  assert.match(html, /api\("\/command", \{ method: "POST", body: JSON\.stringify\(\{ line: "stop robert" \}\)/);
});

test("the stop the panel calls is the one the daemon already runs", () => {
  // No new route: POST /api/command runs the shared command table, whose `stop robert` aborts the
  // in-flight web turn. That also means this ships without a rebuild — desk.html is served from disk.
  assert.match(api, /api\.post\("\/command"/);
  assert.match(cmds, /name: "stop"/);
  assert.match(cmds, /abortWebTurn\(workspaceId \?\? null\)/);
});

test("a working strip says what he is doing, not just that he is busy", () => {
  assert.match(html, /id="chat-work"/);
  assert.match(html, /body\.blink \.chat-work \.dots i/); // blinks off the 1Hz body clock, never an infinite animation
  // Tool and thinking deltas drive the strip; only reply text goes into the bubble.
  assert.match(html, /if \(e\.kind && e\.kind !== "text"\)/);
  assert.match(html, /"agent\.turn\.done"/);
});

test("the working strip actually hides, and the header says idle or what he is on", () => {
  // `.chat-work { display:flex }` used to beat the UA's [hidden] rule: the strip read "working…" forever.
  assert.match(html, /\.chat-work\[hidden\] \{ display:none; \}/);
  assert.match(html, /id="rob-status"/);
  assert.match(html, /dot\.className = "dot ended"; st\.textContent = "idle"; return;/);
  // A turn that is not this page's cannot be ended by this page's POST — it times out to idle.
  assert.match(html, /if \(!OV\.busy\) idleT = setTimeout\(\(\) => \{ if \(!OV\.busy\) ovWork\(false\); \}, 120000\);/);
  // One thread, N conversations: a Robert row from ANY project belongs in this log (it is chipped
  // with its project) — only an executive's own pane, ws "agent:<id>", is a different thread.
  assert.match(html, /\(e\.topic === "agent\.delta" \|\| e\.topic === "agent\.asked" \|\| e\.topic === "agent\.push" \|\| e\.topic === "agent\.step" \|\| e\.topic === "agent\.turn\.done"\) && String\(e\.ws \|\| ""\)\.startsWith\("agent:"\)\) return;/);
});

test("Robert's steps: live under a turn, settled above his reply, and redrawn from history", () => {
  const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
  assert.match(html, /"agent\.step"/);
  assert.match(html, /if \(e\.topic === "agent\.step" && e\.step\) \{\s*liveSteps\(e\);/);
  assert.match(html, /settleSteps\(e\.turn, e\.steps, e\.ws \?\? null\);/);
  assert.match(html, /steps = m\.steps \? JSON\.parse\(m\.steps\) : null/);
  assert.match(html, /hour12: false/);
});
