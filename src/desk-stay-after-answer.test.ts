/**
 * Answering a terminal keeps you on it. Leo, 2026-11-02: "when I answer a question in an agent chat,
 * it reroutes me to another chat… no rerouting me". Every answer path on the Desk — an option or y/n
 * on the stage, the dialog's choices and free text, the answer keys, Continue — used to call
 * advance(), which put the next terminal that needed him on the stage. Only Close may still move the
 * stage, because the terminal he was on is gone. desk.html has no build step, so it is read as text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
const calls = (re: RegExp) => [...html.matchAll(re)].map((m) => m[0]);

test("no answer path walks the stage to another terminal", () => {
  assert.deepEqual(calls(/advance\([^)]*"(answered|continued)"\)/g), [], "an answer or Continue never calls advance()");
  // Every answer site lands on stayAfter instead: stage option, stage y/n, dialog, two answer keys, Continue.
  assert.equal(calls(/stayAfter\((s|f), "answered"\)/g).length, 5);
  assert.match(html, /if \(a === "continue"\) \{ input\(s\.id, \{ text: "continue", enter: true \}\); return stayAfter\(s, "continued"\); \}/);
});

test("staying clears the answered question so it cannot be pressed twice", () => {
  assert.match(html, /function stayAfter\(s, why\) \{ s\.prompt = null; renderStage\(\); toast\(why\); \}/);
});

test("Close still moves on — that terminal is gone", () => {
  assert.match(html, /advance\(s\.id, "closed"\);/);
  assert.equal(calls(/advance\(id, "closed"\)/g).length, 2);
});
