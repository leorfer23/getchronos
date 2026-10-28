/**
 * Focus: the stage as three cards — goal, decisions, hand-off — and nothing else.
 *
 * Leo, 2026-10-28: "I only want to see 1) the initial goal, 2) the questions and guidance I can provide
 * to steer when the agent needs, 3) the end goal to make the decision." Plus a progress bar and a timer,
 * the finish line ("how we will measure if it's ok"), and a per-terminal permission to merge and/or
 * deploy for easy tasks. No timeline, no raw terminal.
 *
 * Pinned here because desk.html has no build step: the page is read as text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
const css = html.slice(0, html.indexOf("</style>"));

test("Focus is three cards, top down, and nothing else", () => {
  assert.match(html, /body\.innerHTML = focusGoal\(s\) \+ focusDecisions\(s\) \+ focusOutcome\(s\);/);
  // What was there before and is not any more.
  for (const gone of ["boardTimeline", "boardNow", "boardTouched", "boardHead", 'class="btl"', "bcols"])
    assert.doesNotMatch(html, new RegExp(gone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${gone} is gone from Focus`);
  assert.doesNotMatch(html, /out \+= watchBlock\(s\);/, "Robert's watch report is not a Focus card");
});

test("the goal card: the outcome, the finish line, a progress bar, the clock and time left", () => {
  assert.match(html, /<div class="fx-sub">Done when<\/div><ul class="fx-checks">/);
  assert.match(html, /No finish line yet — the agent sets it with you before it starts\./, "an undefined finish line says so, loudly");
  assert.match(html, /<div class="fx-bar\$\{p \|\| reached \? "" : " unknown"\}"/, "the bar is the agent's own mc progress");
  assert.match(html, /<b data-clock="run">/, "how long it has been running");
  assert.match(html, /data-clock="eta" data-at="\$\{p\.eta_at\}"/, "and how long it thinks is left");
  assert.match(html, /const etaWord = \(at\) =>/);
  assert.match(css, /\.fx-bar \{ height:10px;/);
  assert.match(css, /\.fx-title \{ margin:0; font-size:23px;/, "the goal is the biggest words on the stage");
});

test("the permission to ship lives on the goal card, and deploy has to be clicked twice", () => {
  assert.match(html, /\["ask", "merge", "deploy"\]\.map\(\(k\) => `<button type="button" data-ship="\$\{k\}"/);
  assert.match(html, /if \(k === "deploy" && Date\.now\(\) - D\.armShip > 2500\)/);
  assert.match(html, /api\("\/sessions\/" \+ s\.id, \{ method: "PATCH", body: JSON\.stringify\(\{ ship: k \}\) \}\)/);
  // …and when you open it: the New dialog and the quick line both carry it, never remembered.
  assert.match(html, /<select name="ship" id="f-ship">/);
  assert.match(html, /qs\("#f-ship"\)\.value = "ask";/);
  assert.match(html, /quickShip\("ask"\);/);
  assert.match(html, /if \(ship && ship !== "ask"\) body\.ship = ship;/);
});

test("decisions: every open ask with a button per option, answerable before Robert gets to it", () => {
  assert.match(html, /api\("\/sessions\/" \+ s\.id \+ "\/decisions"\)/);
  assert.match(html, /data-aans="\$\{esc\(a\.id\)\}" data-v="\$\{esc\(o\)\}"/);
  assert.match(html, /<b>Robert is deciding<\/b> — answer now to decide it yourself/);
  assert.match(html, /api\("\/asks\/" \+ id \+ "\/answer", \{ method: "POST", body: JSON\.stringify\(\{ answer: text, by: "operator" \}\) \}\)/);
  // The question on its screen (a CLI menu) and a wall are decisions too, with the old answer doors.
  assert.match(html, /data-fopt="\$\{i\}"/);
  assert.match(html, /<button type="button" data-fterm>Open the terminal \(⌘E\)<\/button>/);
  // What was decided — answered asks and your own steering — stays on the card underneath.
  assert.match(html, /hist\.push\(\{ at: e\.ts \|\| 0, html: `<span class="you">you · /);
});

test("the hand-off: summary, changes, proof, screenshots, PRs — and the buttons to approve", () => {
  assert.match(html, /<div class="fx-sub">What changed<\/div>/);
  assert.match(html, /<div class="fx-sub">Proof<\/div>/);
  assert.match(html, /<img data-shot="\$\{esc\(x\.name\)\}"/);
  assert.match(html, /fetch\("\/api\/sessions\/" \+ s\.id \+ "\/outcome\/shot\/" \+ encodeURIComponent\(img\.dataset\.shot\), \{ headers: TOKEN \? \{ "x-mc-admin": TOKEN \} : \{\} \}\)/);
  assert.match(html, /data-ok="merge">✓ Approve merge<\/button>/);
  assert.match(html, /data-ok="deploy">✓ Approve deploy<\/button>/);
  // An approval is typed into the terminal — the agent knows its repo's way to merge and deploy.
  assert.match(html, /answer\(s\.id, \{ text: line, enter: true \}\);/);
  assert.match(html, /merge: "Approved: merge the PR once its checks are green\. Don't deploy\./);
  // A terminal that never filed one still shows its last Summary and PRs.
  assert.match(html, /<span class="fx-chip">no hand-off filed<\/span>/);
});

test("the clocks tick off the page's one clock, not off a repaint", () => {
  assert.match(html, /setInterval\(\(\) => \{ document\.body\.classList\.toggle\("blink"\); if \(compLive\(\)\) compSoon\(\); boardTick\(\); \}, 1000\);/);
  assert.match(html, /function boardTick\(\) \{\s*if \(S\.mode !== "focus"\) return;/);
  assert.match(html, /for \(const el of qsa\("#story \[data-clock\]"\)\)/);
  assert.doesNotMatch(css.slice(css.indexOf("/* ── Focus: goal → decisions → hand-off"), css.indexOf("/* The bar under the stage")), /animation|transition/);
});

test("Focus is home: no Terminal button, a reload never lands in the raw terminal, ⌘E still opens it", () => {
  assert.doesNotMatch(html, /<button data-m="term"/);
  assert.match(html, /mode: localStorage\.getItem\("desk-mode"\) === "fleet" \? "fleet" : "focus",/);
  assert.match(html, /if \(modeKey\(e\)\) \{ e\.preventDefault\(\); return setMode\(S\.mode === "focus" \? "term" : "focus"\); \}/);
  // In Focus the bar does not repeat the question or print the raw last command.
  assert.match(html, /const ask = compAskOwns\(s\) \|\| inFocus \? null : askOf\(s\);/);
  assert.match(html, /const last = inFocus \? null : qaLastLine\(s\);/);
});

test("a reached goal keeps its ✓ and the time, while the phase says whether it is still done", () => {
  assert.match(html, /const done = s\.goal_done_at \? Date\.parse\(s\.goal_done_at\) \|\| 0 : 0;/);
  assert.match(html, /✓ reached \$\{esc\(TermCompanion\.hhmm\(done\)\)\}/);
  assert.match(css, /\.fx-goal\.reached \.fx-checks li::before \{ content:"✓"; color:var\(--accent\); \}/);
});

test("the phone shows the two things worth knowing without opening a terminal", () => {
  const phone = fs.readFileSync(path.join(process.cwd(), "static/phone.html"), "utf8");
  assert.match(phone, /if \(e\.kind === "error"\) \{ flush\(\); items\.push\(\{ kind: "err"/, "a failed call is its own line");
  assert.match(phone, /const link = \/\^printed\\s\+\(\\S\+\)\$\/\.exec/, "a printed link is a link, not a folded tool call");
  assert.match(phone, /\.fl\.err \{ color:var\(--danger\); font-size:13\.5px; \}/);
});
