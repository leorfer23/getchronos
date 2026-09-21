/**
 * The Desk is one terminal at a time: a rail of every terminal (ordered by who needs you) and one
 * stage. Exactly one pty is ever attached — the one on the stage, and only in Terminal mode. These
 * assertions read the shipped file: there is no build step to catch a regression here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
const css = html.slice(0, html.indexOf("</style>"));

test("no infinite CSS animation anywhere on the page", () => {
  assert.doesNotMatch(css, /animation:[^;]*infinite/);
  assert.doesNotMatch(css, /@keyframes/);
  assert.match(html, /classList\.toggle\("blink"\)/, "indicators blink off the 1Hz body clock instead");
  assert.match(css, /body\.blink \.dot\.working/);
});

test("one pane: the stage's terminal, in Terminal mode, and nothing else holds a socket", () => {
  assert.match(html, /const s = S\.mode === "term" && S\.active && byId\(S\.active\);/);
  assert.match(html, /const id = s\?\.live && !s\.focus_only \? S\.active : null;/);
  assert.match(html, /for \(const k of \[\.\.\.S\.panes\.keys\(\)\]\) if \(k !== id\) unmountPane\(k\);/);
  assert.doesNotMatch(html, /\/desk\/screens/, "no text cards to poll — the rail shows one line per terminal, not a screen");
  assert.doesNotMatch(html, /liveMode/);
});

test("the pane tells the daemon its frame pace and drops it while the window is behind", () => {
  assert.match(html, /t: "rate", ms/);
  assert.match(html, /const RATE = \{ focused: 0, wall: 250, background: 500 \}/);
  assert.match(html, /window\.addEventListener\("blur", \(\) => syncRates\(\)\)/);
});

test("the rail is the triage queue: blocked, decide, review, your turn, stalled, waiting, working", () => {
  // The daemon resolves the phase (term-status.ts); the rail orders by it and labels each band.
  assert.match(html, /blocked: +\{ rank: 0,[\s\S]*decide: +\{ rank: 1,[\s\S]*review: +\{ rank: 2,[\s\S]*your_turn: \{ rank: 3,[\s\S]*stalled: +\{ rank: 4,[\s\S]*waiting: +\{ rank: 5,[\s\S]*working: +\{ rank: 6,/);
  assert.match(html, /if \(s\.status && PH\[s\.status\.phase\]\) return s\.status\.phase;/);
  assert.match(html, /if \(e\.topic === "session\.status"\)/);
  // A daemon without term-status still gets the old four-way reading.
  assert.match(html, /return askOf\(s\) \? "decide" : "your_turn";/);
  assert.match(html, /if \(el\) el\.dataset\.band = several && b !== null && b !== last \? b : "";/);
  // Swiping the stage and J/K walk the same order; ⌘J walks only what needs you.
  assert.match(html, /addEventListener\("wheel"/);
  assert.match(html, /if \(jumpKey\(e\)\) \{ e\.preventDefault\(\); return step\(e\.shiftKey \? -1 : 1, true\); \}/);
});

test("focus is a mode of the stage, remembered, and the story comes from /sessions/:id/focus", () => {
  assert.match(html, /localStorage\.setItem\("desk-mode", S\.mode\)/);
  assert.match(html, /api\("\/sessions\/" \+ id \+ "\/focus"\)/);
  assert.match(html, /DOMPurify\.sanitize\(marked\.parse/, "agent markdown is sanitized before it touches the DOM");
  // Every terminal says whose it is, in words and in colour, on the rail and on the stage. A Lead's
  // row prepends a chip to the same element instead (LEADS.md Desk spec) — see desk-leads.test.ts.
  assert.match(html, /wsEl\.textContent = wsName\(s\.workspace_id\)/);
  assert.match(html, /stage\.style\.setProperty\("--ws", wsColor\(s\.workspace_id\)\)/);
});

test("opening is one line and closing is one key", () => {
  // N drops the quick line: client + a sentence + ⏎; empty ⏎ is blank; ⇧N is the full dialog.
  assert.match(html, /<form class="quick" id="quick">/);
  assert.match(html, /return ask \? pick\("last"\) : e\.shiftKey \? openNew\(\) : quickOpen\(\);/);
  assert.match(html, /if \(!goal\) return spawn\(body\);/);
  // The rail shows the terminal before the pty exists, and the stage lands on it when it does.
  assert.match(html, /const ph = pendingRow\(body\);/);
  assert.match(html, /if \(s\?\.id && byId\(s\.id\)\) select\(s\.id\);/);
  // X closes the one you are in; the "N done" count closes all of them on a second click.
  assert.match(html, /if \(k === "x"\) \{ e\.preventDefault\(\); return stageAction\("close"\); \}/);
  assert.match(html, /async function closeDone\(\)/);
});

test("Focus-only is optional at spawn and never mounts that session's live terminal", () => {
  assert.match(html, /id="q-focus"/);
  assert.match(html, /id="f-focus"/);
  assert.match(html, /\.\.\.\(focus \? \{ focus_only: true \} : \{\}\)/);
  assert.match(html, /if \(m === "term" && byId\(S\.active\)\?\.focus_only\) m = "focus";/);
  assert.match(html, /if \(s\.focus_only && S\.mode === "term"\) setMode\("focus"\);/);
  assert.match(css, /body\.focus-only #mode \[data-m="term"\]/);
});

test("nothing open = Robert on the stage; ended terminals stay behind the on-demand log", () => {
  assert.match(html, /document\.body\.classList\.add\("no-terms"\)/);
  // …everywhere but the Fleet board: an empty Desk with widgets registered has something to look at,
  // so the stage keeps the window and Robert stays the column you open with ⌘K (src/desk-widgets.test.ts).
  assert.match(css, /body\.no-terms:not\(\.mode-fleet\) \.stage \{ display:none; \}/);
  assert.doesNotMatch(html, /sec-recent|renderRecent/, "completed sessions are not resident on the rail");
  assert.match(html, /api\("\/desk\/log\?since=" \+ since\)/, "history is fetched only when the log opens");
  assert.match(html, /if \(!t\.live\) await restart\(t\.id\)/, "a historical row is revived on demand");
  assert.match(html, /if \(s\) select\(id\); else await restart\(id\);/, "a dormant direct link revives without preloading history");
  // Closing the last one lands on Robert, not on the corpse of the terminal you just closed.
  assert.match(html, /if \(cur && !S\.dismissed\.has\(cur\.id\) && \(cur\.live \|\| S\.stickEnded\)\) return;/);
});

test("Robert on the Desk: markdown bubbles, terminal chips, select directives, the briefs he reads every turn", () => {
  assert.match(html, /marked\.parse\(withChips, \{ breaks: true \}\)/);
  assert.match(html, /\\b\(\[0-9a-f\]\{8\}\)\\b/, "an 8-char id in his reply becomes a chip");
  assert.match(html, /if \(a\.op !== "select" && a\.op !== "focus_terminal"\) continue;/);
  assert.match(html, /runActions\(r\?\.actions\)/);
  assert.match(html, /<dialog id="dlg-briefs">/);
  assert.match(html, /api\("\/workspaces\/" \+ B\.tab \+ "\/brief", \{ method: "PUT"/);
  assert.match(html, /api\("\/agents\/robert\/memory", \{ method: "PUT"/);
});

test("jobs: the dialog is the surface — list of operator jobs, one job's tabs, runs with story, live updates", () => {
  assert.match(html, /<dialog id="dlg-jobs">/);
  assert.match(html, /api\("\/jobs\?kind=operator"\)/, "the fleet's own ticket/review runs are not jobs");
  for (const t of ["overview", "instructions", "agent", "triggers", "runs"]) assert.match(html, new RegExp(`data-pane="${t}"`));
  assert.match(html, /api\("\/runs\/" \+ id \+ "\/story"\)/);
  assert.match(html, /"run\.started", "run\.ended", "job\.updated",/);
  assert.match(html, /run_at: t === "once" && v\("run_at"\) \? new Date\(v\("run_at"\)\)\.toISOString\(\) : null,/, "one-timers send an ISO time, in the operator's zone");
  assert.match(html, /if \(a\.op === "jobs"\) \{ openJobs\(a\.id \? String\(a\.id\) : null\); continue; \}/, "Robert can put a job on the screen");
  assert.match(html, /api\("\/runs\/" \+ r\.id \+ "\/continue"/, "a run reopens as a live terminal");
});
