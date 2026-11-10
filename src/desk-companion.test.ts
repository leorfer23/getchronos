/**
 * The companion: a column beside the raw terminal that says what this terminal is, when it started,
 * and everything that has happened since — so the operator can stay in Terminal mode without losing
 * the thread.
 *
 * The derivation (static/desk-companion.js) is run in a vm, the way term-links.js is, because it is
 * a plain script the page loads rather than a module it imports — the page and these assertions
 * therefore read the SAME source, with nothing to keep in sync.
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
});

test("a PR the terminal only printed is read off the pane, bounded so a frame never pays for the whole day", () => {
  assert.deepEqual(plain(TC.prUrls([
    "https://github.com/o/r/pull/7).",
    "https://github.com/o/r/pull/7",
    "https://example.com/not-a-pr",
    "https://github.com/o/r/tree/main",
  ])), ["https://github.com/o/r/pull/7"]);
});

// The one rule kept as text, because the text is the rule (CLAUDE.md "Desk CSS"): the companion's
// CSS uses theme tokens and runs no animation of its own.
test("the companion's CSS: theme tokens only, no animation or transition", () => {
  const block = css.slice(css.indexOf("── the companion"), css.indexOf("/* A small menu")).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(block.length > 200, "the companion's CSS block is where this test looks for it");
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, "no literal colours in the companion's CSS");
  assert.doesNotMatch(block, /animation|transition|@keyframes/);
});
