/**
 * The Focus board: the stage as the control panel of ONE terminal.
 *
 * Focus used to be a reading surface — a headline, the goal, and the last three things said, with
 * tool calls folded into "12 commands · 3 edits". What the operator actually triages by was missing
 * or buried: is it working or stuck, how long has it been running, what is it doing right now, what
 * did it produce, and how did it get here (Leo, 2026-09-22).
 *
 * Pinned here because desk.html has no build step: the page is read as text, and the row derivation
 * it shares with the companion rail (static/desk-companion.js) is run in a vm, exactly as
 * desk-companion.test.ts does — so the rail and the board can never drift into two stories.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ctx: any = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), "static/desk-companion.js"), "utf8"), ctx);
const TC = ctx.window.TermCompanion;
const plain = (v: any) => JSON.parse(JSON.stringify(v));
const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
const css = html.slice(0, html.indexOf("</style>"));

let seq = 0;
const ev = (kind: string, text: string, ts?: number) => ({ seq: (seq += 1000), kind, text, ts });

test("the board is built in triage order, and the ask is the only full-width block", () => {
  // What it needs from you → what it is doing → what it said → how it got here; the reference
  // (goal, links, files) rides alongside, so a narrow stage stacks them under the story.
  assert.match(html, /let main = boardNow\(s\);/);
  assert.match(html, /main \+= boardTimeline\(s\);/);
  assert.match(html, /const side = boardGoal\(s\) \+ boardShips\(s\) \+ boardTouched\(s\);/);
  assert.match(html, /out \+= `<div class="bcols"><div class="bmain">\$\{main\}<\/div><aside class="bside">\$\{side\}<\/aside><\/div>`;/);
  // The strip comes before everything, including the ask: status is never something you scroll to.
  assert.match(html, /let out = boardHead\(s\);/);
  assert.match(css, /@media \(max-width:860px\) \{ \.bcols \{ flex-direction:column; \}/);
});

test("the strip carries the four numbers you triage by", () => {
  assert.match(html, /<span>running <b data-clock="run">/, "how long it has been running");
  assert.match(html, /\$\{esc\(PH_WORD\[ph\] \|\| ph\)\} for \$\{esc\(elapsedOf\(phaseSince\(s\)\)\)\}/, "how long in this phase");
  assert.match(html, /class="bprog"/, "the agent's own mc progress, as a bar");
  assert.match(html, /\$\{st\.subagents\} subagent/);
  assert.match(html, /<span>on \$\{esc\(st\.on\)\}/, "what it is waiting on, and its eta");
});

test("the clocks tick off the page's one clock, not off a repaint", () => {
  assert.match(html, /setInterval\(\(\) => \{ document\.body\.classList\.toggle\("blink"\); if \(compLive\(\)\) compSoon\(\); boardTick\(\); \}, 1000\);/);
  assert.match(html, /function boardTick\(\) \{\s*if \(S\.mode !== "focus"\) return;/);
  assert.match(html, /for \(const el of qsa\("#story \[data-clock\]"\)\)/);
});

test("deliverables are the daemon's pins, drawn by the same function as the rail", () => {
  assert.match(html, /function pinPrHtml\(p\)/);
  assert.match(html, /function pinDocHtml\(d\)/);
  assert.match(html, /const out = prs\.map\(pinPrHtml\)\.concat\(docs\.map\(pinDocHtml\)\);/, "the rail uses the shared pin");
  assert.match(html, /const rows = prs\.map\(pinPrHtml\)\.concat\(docs\.map\(pinDocHtml\)\);/, "and so does the board");
  // The pins refresh on the same throttle wherever they are shown.
  assert.match(html, /if \(S\.mode === "focus"\) renderStorySoon\(\); else compSoon\(\);/);
  assert.match(html, /if \(s\.id === C\.id\) compPinsLoad\(s\.id\);/);
});

test("the timeline is moments, never commands", () => {
  const rows = plain(TC.companionRows([
    ev("user", "rehacé el Focus"),
    ev("understanding", "Understanding: rebuild Focus as a board"),
    ev("act", "run npm test -- focus"),
    ev("act", "Edit /repo/src/focus.ts"),
    ev("error", "run npm test -- focus failed (exit 1): 3 tests failed"),
    ev("act", "printed https://github.com/o/r/pull/12"),
    ev("result", "Summary: board shipped"),
  ], []));
  assert.deepEqual(rows.map((r: any) => r.kind), ["user", "understanding", "error", "link", "result"]);
  assert.equal(rows[3].url, "https://github.com/o/r/pull/12", "a printed link is a row you can click");
  // The count of what was folded away is still offered — "34 steps" is signal, the 34 commands are not.
  assert.match(html, /const steps = F\.events\.filter\(\(e\) => e\.kind === "act"\)\.length;/);
  assert.match(html, /\$\{steps \? " · " \+ steps \+ " steps" : ""\}/);
});

test("a failure is red on both surfaces, and only the board's links are clickable", () => {
  assert.match(css, /\.btl \.r\.error \.tx, \.btl \.r\.error \.g \{ color:var\(--danger\); \}/);
  assert.match(css, /\.ctl\.error \.tx, \.ctl\.error \.g \{ color:var\(--danger\); \}/);
  assert.match(html, /r\.kind === "link"\s*\?\s*`<a class="tx" href="\$\{esc\(r\.url\)\}" target="_blank" rel="noopener">/);
});

test("Now says what it is doing, and an ended terminal says what became of it", () => {
  assert.match(html, /const line = oneLiner\(s\)\.text \|\| "";/);
  assert.match(html, /const act = ph === "working" && F\.id === s\.id \? TermCompanion\.currentAct\(F\.events\) : null;/);
  assert.match(html, /class="bcard bnow idle"/);
  assert.match(html, /s\.end_reason \? "↪ " \+ s\.end_reason/);
});
