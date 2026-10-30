/**
 * Focus: the stage as four cards — goal, decisions, talk, hand-off — and nothing else.
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

test("Focus is one board that fits the stage: status on top, three columns, the dock at the bottom", () => {
  // Leo, 2026-10-28: full width, no scrolling to reach a button, what it is doing always on top.
  assert.match(html, /body\.innerHTML = focusStatus\(s\) \+ grid \+ focusDock\(s\);/);
  assert.match(html, /<div class="fx-col c1">\$\{focusGoal\(s\)\}\$\{focusDecided\(s\)\}\$\{ready \? "" : out\}<\/div>/, "no hand-off yet: its line sits under the goal");
  assert.match(html, /const c2 = `<div class="fx-col c2\$\{FX\.exp === "talk" \? " holds-exp" : ""\}">\$\{focusTalk\(s\)\}<\/div>`;/);
  assert.match(css, /\.fx-grid:not\(\.has-out\) > \.c2 \{ grid-column:2 \/ -1; \}/, "…and Talk takes the hand-off's column until there is one");
  assert.match(css, /body\.mode-focus \.story \{ display:flex; flex-direction:column; gap:10px; \}/);
  assert.doesNotMatch(css, /\.story > \* \{ max-width/, "no centred column: the board uses the whole width");
  assert.match(css, /\.fx-grid \{ flex:1 1 0; min-height:0; display:grid;/, "the board takes what the strip and the dock leave, and no more");
  assert.match(css, /\.fx-body \{ flex:1 1 auto; min-height:0; overflow-y:auto;/, "a long card scrolls inside itself, never the page");
  assert.match(css, /@container \(max-width:1280px\)/);
  // What was there before and is not any more.
  for (const gone of ["boardTimeline", "boardNow", "boardTouched", "boardHead", 'class="btl"', "bcols"])
    assert.doesNotMatch(html, new RegExp(gone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${gone} is gone from Focus`);
  assert.doesNotMatch(html, /out \+= watchBlock\(s\);/, "Robert's watch report is not a Focus card");
});

test("the goal card: the outcome, the finish line, a progress bar, the clock and time left", () => {
  assert.match(html, /<div class="fx-sub">Done when · \$\{reached \? checks\.length : nMet\}\/\$\{checks\.length\}<\/div><ul class="fx-checks">/);
  assert.match(html, /data-check="\$\{i \+ 1\}"/, "each check ticks on its own, and can be ticked from here");
  assert.match(html, /api\("\/sessions\/" \+ s\.id, \{ method: "PATCH", body: JSON\.stringify\(was \? \{ uncheck: \[n\] \} : \{ check: \[n\] \}\) \}\)/);
  assert.match(html, /No finish line yet — the agent sets it with you before it starts\./, "an undefined finish line says so, loudly");
  assert.match(html, /<div class="fx-bar\$\{p \|\| reached \|\| nMet \? "" : " unknown"\}"/, "the bar is the agent's own mc progress, else its checks met");
  assert.match(html, /<b data-clock="run">/, "how long it has been running");
  assert.match(html, /data-clock="eta" data-at="\$\{p\.eta_at\}"/, "and how long it thinks is left");
  // No steps reported: the bar is the share of the finish line met. And how long since it last moved.
  assert.match(html, /: checks\.length \? Math\.round\(\(nMet \/ checks\.length\) \* 100\) : 0;/);
  assert.match(html, /updated <time data-clock="ago" data-at="\$\{moved\}" data-suffix=" ago">/);
  assert.match(html, /const etaWord = \(at\) =>/);
  assert.match(css, /\.fx-bar \{ height:10px;/);
  assert.match(css, /\.fx-title \{ margin:0; font-size:21px;/, "the goal is the biggest words on the board");
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
  // What was decided stays on the card underneath; your own lines moved to Talk, beside the answers.
  assert.match(html, /for \(const a of asks\) if \(a\.status === "answered"\)/);
  assert.doesNotMatch(html, /<span class="you">you · /);
  // Never "decide" with nothing to decide on: the line and a way in, whatever it stopped on.
  assert.match(html, /if \(!open\.length && ph === "decide"\)/);
  // Talk leaves out the daemon's own typing: the cache keeper's /compact, a budget notice.
  const re = new Function("return " + html.match(/const DAEMON_LINE = (\/.+\/i);/)![1])() as RegExp;
  assert.ok(re.test("/compact Chronos cache keeper: idle 46 min") && re.test("[chronos budget] this workspace is over its share"));
  assert.ok(!re.test("keep it friendly, Thomas is new") && !re.test("Permission update: you may merge"));
});

test("a CLI question dialog (AskUserQuestion): its whole question, a button per answer, free text through its menu", () => {
  // The words come from the hook (D.dialog), the keys from the menu read off its screen.
  assert.match(html, /D\.dialog = r\.dialog \|\| null;/);
  assert.match(html, /const TYPE_RE = \/\^type something\\\.\?\$\/i, CHAT_RE = \/\^chat about this\\\.\?\$\/i/);
  assert.match(html, /data-dopt="\$\{c\.i\}"/);
  assert.match(html, /<input data-dtext="\$\{d\.type\}"/);
  // Free text: arrows to "Type something.", then the line and Enter — never Enter on the row first.
  assert.match(html, /if \(keys\.length\) await answer\(s\.id, \{ keys \}\);/);
  assert.match(html, /await answer\(s\.id, \{ text, enter: true \}\);/);
});

test("talk: the whole conversation — every line you sent and everything it said, in order", () => {
  assert.match(html, /function talkThread\(s\)/);
  // Every message it writes is a row, not only the answer after its last tool call (Leo, 2026-10-30).
  assert.match(html, /items\.push\(\{ k: "say", text: sayText\(e\), at: e\.ts \|\| 0, seq: e\.seq \}\);/);
  // What it ran between two messages folds to one line; a click lists it.
  assert.match(html, /const actsWord = \(g\) => \(g\.acts\.length \? foldActs\(g\.acts\.map\(\(a\) => a\.text\)\)/);
  assert.match(html, /data-tacts="\$\{esc\(x\.key\)\}"/);
  // A terminal opened with a goal starts with the goal you gave it, never the daemon's seed.
  assert.match(html, /const t = seed \? String\(s\.spawn_goal\)\.trim\(\) : cleanUser\(e\.text\);/);
  // While it works, what it is on right now is the last line — Talk never sits silent over a busy agent.
  assert.match(html, /function talkNow\(s, items\) \{/);
  assert.match(html, /<div class="tk live"><i><\/i>/);
  assert.match(css, /body\.blink \.tk\.live i \{ opacity:\.3; \}/);
  assert.match(html, /if \(SYS_LINE\.test\(e\.text\) \|\| DAEMON_LINE\.test\(e\.text\)\) continue;/);
  assert.match(html, /<span class="fx-lbl">\$\{chat \? "Chat" : "Talk"\}<\/span>/);
  // It scrolls inside its card, newest at the bottom, and expands over the board.
  assert.match(html, /<div class="fx-body" data-keep="talk" data-stick>/);
  assert.match(html, /\+ \(chat \? "" : expBtn\("talk"\)\)/, "a chat's Talk is already the board");
  // A line sent from the Focus composer shows at once and the page follows it to the answer.
  assert.match(html, /Object\.assign\(T, \{ pending: \{ text, at: Date\.now\(\), now \}, follow: true, sig: "" \}\);/);
  // The last answer is not printed twice: a Result card without a hand-off points up at it.
  assert.match(html, /No hand-off filed — its last answer is open in Talk\./);
});

test("is it working: the evidence under the phase — printing now or quiet since, and the last thing it did", () => {
  assert.match(html, /<div class="st-line" title="\$\{esc\(line\)\}">\$\{esc\(line\)\}<\/div>\$\{pulseHtml\(s\)\}/, "the evidence sits under the status line");
  assert.match(html, /const printing = s\.quiet === false;/);
  assert.match(html, /else if \(el\.dataset\.clock === "ago" && at\)/, "the quiet clock ticks off the page clock");
  assert.match(css, /body\.blink \.fx-pulse\.on i \{ opacity:\.3; \}/, "the dot blinks off the 1Hz class, no animation");
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
  assert.match(css, /\.fx-checks li\.ok::before, \.fx-goal\.reached \.fx-checks li::before \{ content:"✓"; color:var\(--accent\);/);
});

test("the phone shows the two things worth knowing without opening a terminal", () => {
  const phone = fs.readFileSync(path.join(process.cwd(), "static/phone.html"), "utf8");
  assert.match(phone, /if \(e\.kind === "error"\) \{ flush\(\); items\.push\(\{ kind: "err"/, "a failed call is its own line");
  assert.match(phone, /const link = \/\^printed\\s\+\(\\S\+\)\$\/\.exec/, "a printed link is a link, not a folded tool call");
  assert.match(phone, /\.fl\.err \{ color:var\(--danger\); font-size:13\.5px; \}/);
});

test("the status strip: what it is doing now, in the need's colour when it needs you, and who else does", () => {
  assert.match(html, /function focusStatus\(s\)/);
  assert.match(html, /else if \(need\?\.k === "decide"\) line = "Waiting for you — "/);
  assert.match(html, /else if \(need\?\.k === "approve"\) line = "Hand-off ready — approve it below  ↓";/);
  assert.match(html, /const others = needsNow\(\)\.filter\(\(x\) => x\.id !== s\.id\)\.length;/);
  assert.match(html, /data-fnext title="the next terminal that needs you \(⌘J\)"/);
  assert.match(css, /\.fx-status \{ flex:none;/, "never scrolls away");
});

test("needs you: one reading for the rail's pill, ⌘J, the counts and Focus — a wall, a question, a hand-off to approve", () => {
  assert.match(html, /function needOf\(s\) \{/);
  assert.match(html, /if \(s\.handoff && !SHIPPING\.has\(s\.id\)\) return \{ k: "approve", word: "approve" \};/);
  assert.match(html, /q\.className = "asks " \+ need\.k;/);
  assert.match(html, /\(need \? " needs n-" \+ need\.k : ""\)/);
  assert.match(css, /body\.blink \.row \.side \.asks i \{ opacity:\.25; \}/, "the pill's dot blinks off the page clock");
  assert.match(css, /\.row \.side \.asks\[hidden\] \{ display:none; \}/, "a pill styled display:inline-flex must still hide");
  assert.match(html, /const need = live\.filter\(\(s\) => needOf\(s\)\)\.length/);
  assert.match(html, /\|\| needOf\(s\)\) && !\(S\.answered\.get/);
});

test("the dock: every answer and approval in one place at the bottom, and a ship you approved keeps showing", () => {
  assert.match(html, /function focusDock\(s\)/);
  assert.match(html, /const rows = openDecisions\(s\);/);
  assert.match(html, /Nothing needs you right now/);
  // Approve buttons live in the dock, not inside the hand-off card.
  assert.match(html, /function handoffDock\(s\)/);
  assert.match(html, /<button type="button" class="go" data-ok="merge\+deploy">✓ Merge \+ deploy<\/button>/);
  // The click is tracked until the hand-off says it shipped, and turns on the 1Hz clock meanwhile.
  assert.match(html, /shipStart\(s, ok\.dataset\.ok\);/);
  assert.match(html, /if \(\(o && \(Date\.parse\(o\.at\) \|\| 0\) > x\.at && o\.shipped\?\.length\) \|\| \(x\.kind === "merge" && merged\)\)/);
  assert.match(html, /<i class="spin" data-spin>◐<\/i>/);
  assert.match(html, /for \(const el of qsa\("#story \[data-spin\]"\)\) el\.textContent = SPIN/);
  assert.match(html, /localStorage\.setItem\("desk-shipping"/);
});

test("hand-offs: the newest in full, every earlier one kept and folded; Talk and the hand-off expand over the board", () => {
  assert.match(html, /D\.earlier = r\.earlier \|\| \[\];/);
  assert.match(html, /<div class="ho-h" data-hopen="\$\{i\}"/);
  assert.match(html, /#\$\{n\} of \$\{n\}/);
  assert.match(html, /\+ expBtn\("out"\)/);
  assert.match(css, /\.fx-grid\.exp > \.fx-col:not\(\.holds-exp\), \.fx-grid\.exp \.fx-col > \.fx:not\(\.exp\) \{ display:none; \}/);
  assert.match(html, /if \(e\.key === "Escape" && S\.mode === "focus" && FX\.exp/, "Esc gives the board back");
  // A repaint keeps every card where it was scrolled (Talk follows the newest when it was at the end).
  assert.match(html, /el\.scrollTop = was\.end && el\.hasAttribute\("data-stick"\) \? el\.scrollHeight : was\.top;/);
});

test("activity: the status strip expands into every step, stamped to the second, live", () => {
  // Leo, 2026-10-30: "see live what it is doing, and by timestamp what it was doing before".
  assert.match(html, /<div class="st-m" data-fexp="act"/, "the strip itself opens it");
  assert.match(html, /\? "⤡ Back to board" : "⤢ Activity"/);
  assert.match(html, /const grid = FX\.exp === "act"\s+\? `<div class="fx-grid exp"><div class="fx-col c1 holds-exp">\$\{focusActivity\(s\)\}<\/div><\/div>`/);
  assert.match(html, /function focusActivity\(s\) \{/);
  // How long each step took, and a running clock on the one it is on now (the page's 1Hz clock).
  assert.match(html, /<em class="now" data-clock="ago" data-at="\$\{at\}">/);
  assert.match(html, /next && at && next - at >= 3000 \? `<em>\$\{esc\(TermCompanion\.elapsed\(next - at\)\)\}<\/em>`/);
  // It stays open while you walk the rail, so J/K shows each terminal's activity.
  assert.match(html, /exp: FX\.exp === "act" \? "act" : null/);
});

test("a chat: no goal card, the talk is the board, and a way to make it a task", () => {
  assert.match(html, /const chat = s\.goal_kind === "chat";/);
  assert.match(html, /\+ \(chat \? "" : `<div class="fx-col c1">/, "no goal card in a chat");
  assert.match(css, /\.fx-grid\.fx-chat \{ grid-template-columns:minmax\(0,1fr\); grid-template-rows:minmax\(0,1fr\); \}/);
  assert.match(html, /<option value="chat">Chat — just talk<\/option>/, "the New dialog can open one");
  assert.match(html, /if \(e\.target\.closest\("\[data-ftask\]"\)\) return talkSend\(s, TASK_LINE\);/);
});

test("a line sent while a Claude terminal works goes as send-now, so it answers without waiting the step out", () => {
  assert.match(html, /const sendsNow = \(s\) => s\.backend === "claude-code" && phaseOf\(s\) === "working";/);
  assert.match(html, /answer\(s\.id, \{ text, enter: true, \.\.\.\(now \? \{ now: true \} : \{\}\) \}\);/);
  // The composer goes through it in both modes.
  assert.match(html, /if \(!s\?\.live\) return answer\(S\.active, \{ text, enter: true \}\);\n  talkSend\(s, text\);/);
  assert.match(html, /queued — it reads this when “/, "a line still waiting on a step says so");
});
