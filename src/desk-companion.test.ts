/**
 * The companion: a column beside the raw terminal that says what this terminal is, when it started,
 * and everything that has happened since — so the operator can stay in Terminal mode without losing
 * the thread.
 *
 * Two halves are pinned here. The derivation (static/desk-companion.js) is run in a vm, the way
 * term-links.js is, because it is a plain script the page loads rather than a module it imports —
 * the page and these assertions therefore read the SAME source, with nothing to keep in sync. The
 * wiring (static/desk.html) is read as text, because desk.html has no build step and nothing else
 * would notice a regression.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ctx: any = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), "static/desk-companion.js"), "utf8"), ctx);
const M = ctx.window.TermCompanion;
// Values cross a vm realm boundary, so their prototypes are not this realm's: round-trip through
// JSON before comparing, the way src/term-links.test.ts does.
const plain = (v: any) => JSON.parse(JSON.stringify(v));
const TC = {
  ...M,
  companionRows: (e: any, c: any) => plain(M.companionRows(e, c)),
  touchedFiles: (e: any) => plain(M.touchedFiles(e)),
  currentAct: (e: any) => plain(M.currentAct(e)),
  trimMarks: (l: any, n: any) => plain(M.trimMarks(l, n)),
};
const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
const css = html.slice(0, html.indexOf("</style>"));

// The feed as focus.ts writes it: seq = lineNo*1000 + blockIdx, `act` text straight out of describeTool.
let seq = 0;
const ev = (kind: string, text: string, ts?: number) => ({ seq: (seq += 1000), kind, text, ts });
const T0 = Date.UTC(2026, 8, 16, 12, 0, 0);

test("the timeline is the narration, oldest first — tool calls are not rows", () => {
  const rows = TC.companionRows([
    ev("user", "fix the login bug", T0),
    ev("understanding", "Understanding: the session cookie is dropped", T0 + 1000),
    ev("act", "Read /a/b/src/auth.ts", T0 + 2000),
    ev("say", "Now checking the cookie path.", T0 + 2500),
    ev("act", "run npm test", T0 + 3000),
    ev("act", "Edit /a/b/src/auth.ts", T0 + 3500),
    ev("result", "**Summary:** shipped it", T0 + 4000),
  ], []);
  assert.deepEqual(rows.map((r: any) => r.kind), ["user", "understanding", "say", "result"]);
  assert.equal(rows[0].at, T0, "a row carries the moment it happened");
  assert.equal(rows[2].at, T0 + 2500);
  assert.ok(rows.every((r: any) => typeof r.k === "string" && r.k), "every row has a key to diff on");
  assert.equal(new Set(rows.map((r: any) => r.k)).size, rows.length, "keys are unique");
});

test("a feed of nothing but tool calls renders no rows", () => {
  const rows = TC.companionRows([
    ev("act", "Read /r/one.ts"), ev("act", "Read /r/two.ts"), ev("act", "Edit /r/four.ts"), ev("act", "run cd /r && ls"),
  ], []);
  assert.deepEqual(rows, []);
});

test("a phase change is a chapter, placed by when it happened", () => {
  const rows = TC.companionRows(
    [ev("act", "run ls", T0), ev("say", "looks fine", T0 + 5000), ev("act", "Edit /x.ts", T0 + 9000)],
    [{ at: T0 + 4000, phase: "review", line: "goal reached" }, { at: T0 + 20000, phase: "decide", line: "drop the view?" }],
  );
  assert.deepEqual(rows.map((r: any) => r.kind), ["chapter", "say", "chapter"]);
  assert.equal(rows[0].phase, "review");
  assert.equal(rows[0].text, "goal reached");
  assert.equal(rows[2].phase, "decide", "a chapter after the last event still lands, at the end");
});

test("the agent's markdown reads as a line, not as a transcript", () => {
  const rows = TC.companionRows([
    ev("result", "**Summary:** renumbered and green"),
    ev("understanding", "Understanding: the rollback script is stale"),
    ev("say", "- opened [PR #214](https://x/pull/214)\n- tests green"),
  ], []);
  assert.equal(rows[0].text, "renumbered and green", "the glyph already says it is the Summary");
  assert.equal(rows[1].text, "the rollback script is stale");
  assert.equal(rows[2].text, "opened PR #214 tests green");
});

test("noise the operator never typed and never read stays out", () => {
  const rows = TC.companionRows([
    ev("think", "let me consider the options"),
    ev("user", "<system-reminder>injected</system-reminder>"),
    ev("user", "   "),
    ev("say", "on it"),
  ], []);
  assert.deepEqual(rows.map((r: any) => r.kind), ["say"]);
});

test("a feed with no timestamps (grok, cursor) still renders — chapters fall at the end", () => {
  const rows = TC.companionRows([{ seq: 1000, kind: "say", text: "hello" }], [{ at: T0, phase: "working", line: "" }]);
  assert.deepEqual(rows.map((r: any) => r.kind), ["say", "chapter"]);
  assert.equal(rows[0].at, 0);
});

test("the ticker: what THIS turn wrote, newest first, deduped — reads are not touches", () => {
  const evs = [
    ev("act", "Edit /repo/old.ts"),
    ev("user", "now do the api"),
    ev("act", "Read /repo/api.ts"),
    ev("act", "Edit /repo/api.ts"),
    ev("act", "run npm test -- api"),
    ev("act", "Write /repo/api.test.ts"),
    ev("act", "Edit /repo/api.ts"),
  ];
  assert.deepEqual(TC.touchedFiles(evs), ["/repo/api.ts", "/repo/api.test.ts"], "since the last user line, newest first");
  assert.equal(TC.lastCommand(evs), "npm test -- api");
  assert.equal(TC.editedFile("Read /repo/api.ts"), null);
  assert.equal(TC.editedFile("NotebookEdit /repo/nb.ipynb"), "/repo/nb.ipynb");
});

test("the now-card's current tool: the newest act, and only while it is the newest thing", () => {
  assert.equal(TC.currentAct([ev("act", "Edit /a/b/src/api.ts")]).text, "Edit /a/b/src/api.ts");
  assert.equal(TC.currentAct([ev("act", "Edit /x.ts"), ev("say", "done")]), null);
  assert.equal(TC.currentAct([]), null);
  assert.equal(TC.actPhrase("Edit /a/b/src/api.ts"), "Editing src/api.ts");
  assert.equal(TC.actPhrase("run npm ci"), "Running npm ci");
  assert.equal(TC.actPhrase("delegate: audit the schema"), "delegate: audit the schema", "unknown shapes are left alone");
});

test("clocks: tabular HH:MM and a coarse elapsed", () => {
  assert.match(TC.hhmm(T0), /^\d{2}:\d{2}$/);
  assert.equal(TC.hhmm(0), "--:--");
  assert.equal(TC.elapsed(12_000), "12s");
  assert.equal(TC.elapsed(4 * 60_000), "4m");
  assert.equal(TC.elapsed(72 * 60_000), "1h 12m");
});

test("marks are bounded: the oldest are handed back to be disposed", () => {
  assert.equal(TC.MAX_MARKS, 500);
  const list = Array.from({ length: 503 }, (_, i) => ({ id: i }));
  const dropped = TC.trimMarks(list, TC.MAX_MARKS);
  assert.equal(list.length, 500);
  assert.deepEqual(dropped.map((d: any) => d.id), [0, 1, 2]);
  assert.deepEqual(TC.trimMarks([{ id: 0 }], 500), [], "under the cap nothing is dropped");
  assert.match(html, /TermCompanion\.trimMarks\(p\.marks, TermCompanion\.MAX_MARKS\)/);
  assert.match(html, /for \(const d of TermCompanion\.trimMarks[\s\S]{0,80}d\.mk\.dispose\(\)/);
});

// ── the page ────────────────────────────────────────────────────────────────────────────────────

test("the rail is a layer of Terminal mode, and the pane shrinks for it", () => {
  assert.match(html, /<script src="\/desk-companion\.js"><\/script>/, "the page and this test read one file");
  assert.match(html, /<aside class="comp" id="comp">/);
  assert.match(css, /body\.mode-term\.comp-on \.comp \{ display:flex; \}/);
  // Shrink, never overlay: only #term's right edge moves, and its own ResizeObserver refits the pty
  // 60ms later — nothing here resizes a pty directly, so nothing can do it under a drag.
  assert.match(css, /body\.mode-term\.comp-on \.term \{ right:var\(--comp-w\); \}/);
  assert.match(css, /body\.mode-term\.comp-on\.comp-min \.term \{ right:8px; \}/);
  assert.doesNotMatch(html, /compSync|sendSize\(\)[^;]*comp/, "the companion never resizes a pty itself");
  for (const id of ["comp-strip", "comp-ws", "comp-goal", "comp-when", "comp-prompt", "comp-now", "comp-tl", "comp-new", "gut", "ticker", "askbar", "h-comp"])
    assert.match(html, new RegExp(`id="${id}"`), id);
});

test("collapsed is an 8px strip of phase colour, and it remembers", () => {
  assert.match(css, /body\.comp-min \.comp \{ width:8px; \}/);
  assert.match(css, /body\.comp-min \.comp-strip \{ display:flex; \}/);
  assert.match(html, /qs\("#comp-strip"\)\.onclick = \(\) => compMin\(false\);/);
  // Nothing keeps a hidden timeline up to date, so opening it back up clears the render signature.
  assert.match(html, /C\.min = min === undefined \? !C\.min : !!min;[\s\S]{0,120}C\.sig = "";\s*compRender\(\);/);
  assert.match(html, /if \(!C\.min\) compRows\(s\);/);
  assert.match(html, /localStorage\.setItem\("desk-companion-min", C\.min \? "1" : "0"\)/);
  assert.match(html, /min: localStorage\.getItem\("desk-companion-min"\) === "1"/);
});

test("on by default, off by ⌘⇧T or the header icon, and the pty never sees the chord", () => {
  assert.match(html, /on: localStorage\.getItem\("desk-companion"\) !== "0"/, "default ON");
  assert.match(html, /localStorage\.setItem\("desk-companion", C\.on \? "1" : "0"\)/);
  assert.match(html, /const compKey = \(e\) => \(e\.metaKey \|\| e\.ctrlKey\) && e\.shiftKey && !e\.altKey && e\.key\.toLowerCase\(\) === "t";/);
  assert.match(html, /if \(compKey\(e\)\) \{ e\.preventDefault\(\); return compToggle\(\); \}/);
  assert.match(html, /fontKey\(e\) !== null \|\| jumpKey\(e\) \|\| modeKey\(e\) \|\| compKey\(e\)/, "the chord is swallowed before the pty");
  assert.match(html, /qs\("#h-comp"\)\.onclick/);
});

test("the xterm keeps the keyboard: every companion click hands it straight back", () => {
  assert.match(html, /function compFocusBack\(\) \{ if \(S\.mode === "term"\) S\.panes\.get\(S\.active\)\?\.term\.focus\(\); \}/);
  // mousedown is where focus moves, so that is where it is refused.
  assert.match(html, /for \(const sel of \["#askbar", "#comp", "#ticker", "#gut"\]\) qs\(sel\)\.addEventListener\("mousedown"[\s\S]{0,120}e\.preventDefault\(\)/);
  for (const re of [/compScrollTo\(Number\(row\.dataset\.at\) \|\| 0\);\s*compFocusBack\(\);/, /compCopy\(f\.dataset\.file\);\s*compFocusBack\(\);/])
    assert.match(html, re);
});

test("the ask bar answers through the one door, and does not move the stage", () => {
  // Same body as every other option chip on the Desk: keys relative to the cursor, via /input.
  assert.match(html, /if \(o && p\?\.options\) \{ const opt = p\.options\[Number\(o\.dataset\.aopt\)\]; if \(opt\) answer\(s\.id, optionBody\(opt\)\); return compFocusBack\(\); \}/);
  assert.match(html, /if \(y\) \{ answer\(s\.id, \{ text: y\.dataset\.ayn, enter: true \}\); return compFocusBack\(\); \}/);
  assert.match(html, /const optionBody = \(o\) => \(\{ keys: \[\.\.\.Array\(Math\.abs\(o\.offset\)\)\.fill\(o\.offset > 0 \? "down" : "up"\), "enter"\] \}\);/);
  assert.match(html, /api\("\/sessions\/" \+ id \+ "\/input", \{ method: "POST", body: JSON\.stringify\(\{ \.\.\.body, by: "operator" \}\)/);
  // Only on the three phases that are actually waiting on a person, and only with a parsed prompt.
  assert.match(html, /const COMP_ASK_PHASES = new Set\(\["decide", "your_turn", "blocked"\]\);/);
  assert.match(html, /return !!p && p\.kind !== "turn" && COMP_ASK_PHASES\.has\(phaseOf\(s\)\);/);
  // One question on screen: while this bar owns the ask, #sbar draws the three moves and nothing else.
  assert.match(html, /const ask = compAskOwns\(s\) \? null : askOf\(s\);/);
  assert.doesNotMatch(html, /data-aopt[\s\S]{0,200}advance\(/, "answering here does not walk to the next terminal");
});

test("chapter marks are xterm markers, drawn only where the viewport is", () => {
  assert.match(html, /mk = p\.term\.registerMarker\(0\)/);
  assert.match(html, /if \(line < top \|\| line >= top \+ rows\) continue;/);
  // xterm fires onRender constantly; the gutter only moves when the viewport does.
  assert.match(html, /const sig = b\.viewportY \+ ":" \+ b\.baseY \+ ":" \+ p\.marks\.length;\s*if \(sig === C\.gutSig\) return;/);
  assert.match(html, /term\.onScroll\(\(\) => compGutSoon\(\)\);/);
  assert.match(html, /for \(const m of p\.marks \|\| \[\]\) \{ try \{ m\.mk\.dispose\(\); \} catch \{\} \}/, "unmounting a pane drops its markers");
});

test("one render per frame, appended not rebuilt", () => {
  assert.match(html, /function compSoon\(\) \{ if \(C\.raf\) return; C\.raf = requestAnimationFrame\(\(\) => \{ C\.raf = 0; compRender\(\); \}\); \}/);
  assert.match(html, /while \(i < rows\.length && i < kids\.length && kids\[i\]\.dataset\.k === compKeyOf\(rows\[i\]\)\) i\+\+;/);
  // Unfolding a Read run changes nothing about the row's identity, so the key carries the fold too.
  assert.match(html, /const compKeyOf = \(r\) => r\.k \+ \(r\.kind === "reads" && C\.open\.has\(r\.k\) \? "\+open" : ""\);/);
  assert.match(html, /const sig = F\.events\.length \+ ":" \+ C\.chapters\.length \+ ":" \+ C\.open\.size[\s\S]{0,60}if \(sig === C\.sig\) return;/);
  assert.match(html, /const setTxt = \(el, t\) => \{ if \(el && el\.textContent !== t\) el\.textContent = t; \};/);
  // The story feed is loaded in Terminal mode too — openStory runs on every select, whatever the mode.
  assert.match(html, /compOpen\(id\);\s*const req = \+\+F\.req;/);
  assert.match(html, /if \(e\.session_id === C\.id\) compChapter\(e\.status\.phase, e\.status\.line, e\.status\.since\);/);
});

test("tokens only, and no clock of its own", () => {
  const block = css.slice(css.indexOf("── the companion"), css.indexOf("/* A small menu")).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, "no literal colours in the companion's CSS");
  assert.doesNotMatch(block, /animation|transition|@keyframes/);
  assert.match(html, /const COMP_PH_COLOR = \{[\s\S]*?blocked: "var\(--danger\)"[\s\S]*?working: "var\(--p-work\)"/);
  // The elapsed clock rides the page's 1Hz blink, like every other indicator.
  assert.match(html, /document\.body\.classList\.toggle\("blink"\); if \(compLive\(\)\) compSoon\(\);/);
});

test("a write to workspace memory is the one tool call that becomes a timeline row", () => {
  const rows = TC.companionRows([
    ev("act", 'run mc remember "PRs target develop" --topic git', T0),
    ev("act", 'run cd /r && mc learn "flyway lives in db/migration', T0 + 1000),
    ev("act", 'run mc memo append memory-index "- one more"', T0 + 2000),
    ev("act", "run mc recall flyway", T0 + 3000),
  ], []);
  assert.deepEqual(rows.map((r: any) => [r.kind, r.text, r.slug]), [
    ["memory", "Remembered (git): PRs target develop", "memory-index"],
    ["memory", "Noted: flyway lives in db/migration", "session-learnings"],
    ["memory", "Added to memory-index: - one more", "memory-index"],
  ]);
  assert.match(html, /memory: "🧠"/);
  assert.match(html, /row\.classList\.contains\("memory"\)[\s\S]{0,160}openMemory\(/);
});

test("the PR and the doc are pinned above the timeline, not inside it", () => {
  // The rail asks the daemon, because only the daemon can ask GitHub whether a PR landed.
  assert.match(html, /await api\("\/sessions\/" \+ id \+ "\/artifacts"/);
  assert.match(html, /if \(C\.id !== id\) return;/, "a slow answer must not land on another terminal's rail");
  // Rate: the 1s tick drives it, the staleness check paces it — no timer of its own.
  assert.match(html, /const PIN_EVERY_MS = 30000;/);
  assert.match(html, /if \(!force && Date\.now\(\) - C\.pinAt < PIN_EVERY_MS\) return;/);
  assert.match(html, /compTop\(s\); compNow\(s\); compAsk\(s\); compTicker\(s\); compStrip\(\); compPins\(s\);/);
  // ✓ merged / ⧗ still yours to merge — and an unknown state is never drawn as merged.
  assert.match(html, /const PIN_MARK = \{ merged: "✓", open: "⧗", closed: "✕" \};/);
  assert.match(html, /const st = p\.state \|\| "open";/);
  // A doc is a link when it is hosted and a path to copy when it is on this machine.
  assert.match(html, /data-pin-path="\$\{esc\(d\.path\)\}"/);
  assert.match(html, /const d = e\.target\.closest\("\[data-pin-path\]"\);\s*if \(d\) compCopy\(d\.dataset\.pinPath\);/);
  // Selecting another terminal clears the pins with everything else the rail holds.
  assert.match(html, /C\.pins = \{ prs: \[\], docs: \[\] \}; C\.pinAt = 0; C\.pinSig = "";/);
});

test("a PR the terminal only printed is read off the pane, bounded so a frame never pays for the whole day", () => {
  assert.deepEqual(plain(TC.prUrls([
    "https://github.com/o/r/pull/7).",
    "https://github.com/o/r/pull/7",
    "https://example.com/not-a-pr",
    "https://github.com/o/r/tree/main",
  ])), ["https://github.com/o/r/pull/7"]);
  assert.match(html, /const PIN_SCAN_ROWS = 400, PIN_SCAN_DEEP = 3000;/);
  assert.match(html, /TermLinks\.scan\(b, p\.term\.cols, Math\.max\(0, to - \(deep \? PIN_SCAN_DEEP : PIN_SCAN_ROWS\)\), to\)/);
  // Deep sweep once, when the terminal comes on stage (pinAt still 0); the newest rows after that.
  assert.match(html, /const seen = compScreenPrs\(!C\.pinAt\);/);
  assert.match(html, /"\/artifacts" \+ \(seen\.length \? "\?urls=" \+ encodeURIComponent\(seen\.join\(","\)\) : ""\)/);
});
