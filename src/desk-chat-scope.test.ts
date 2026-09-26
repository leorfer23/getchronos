import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// The Desk chat with Robert: ONE chat, routed by the daemon. No view-filter picker — routing is
// #tags + the smart router (+ a reply rides the parent's project). The chips on bubbles are labels.
const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");

test("no workspace view filter: the line goes out with no ws, the router decides", () => {
  assert.doesNotMatch(html, /id="chat-ws"/);
  assert.doesNotMatch(html, /desk-chat-filter/);
  assert.doesNotMatch(html, /function pickWs\(/);
  assert.doesNotMatch(html, /OV\.filter/);
  assert.doesNotMatch(html, /api\("\/thread\/sticky"/);
  // The line goes out with no ws: the router reads the project from the text / sticky / reply.
  assert.match(html, /const body = \{ text: item\.text, session: S\.active \|\| null, client: CLIENT \};/);
});

test("history is one timeline across every project", () => {
  assert.match(html, /async function ovHistory\(reload = false\)/);
  assert.match(html, /\/agent\/history\?ws=all&limit=40/);
  assert.match(html, /if \(reload\) OV\.log\.innerHTML = "";/);
  assert.match(html, /const gen = \+\+OV\.histGen;/);
  assert.match(html, /if \(gen !== OV\.histGen\) return;/);
});

test("chips are labels; a tap on one does not filter the log", () => {
  assert.doesNotMatch(html, /noteLanding/);
  assert.match(html, /setChip\(item\.bub, r\?\.ws \?\? null\); OV\.sticky = r\?\.ws \?\? null;/);
  assert.match(html, /if \(r\?\.accepted && r\?\.turn\) \{ OV\.drawn\.set\(r\.turn, item\.bub\); ovAwait\(r\.turn\); hold = true; \}/);
  // Chip click no longer filters; hover still dims siblings. (steps .sh still has its own click.)
  assert.doesNotMatch(html, /closest\("\.wsc"\).*pickWs|pickWs\(ws && ws/);
  assert.match(html, /OV\.log\.addEventListener\("mouseover"/);
});

test("a streamed reply is promoted in place — never remove+redraw", () => {
  assert.match(html, /const streamed = OV\.pending;/);
  assert.match(html, /streamed\.className = "bub rob";/);
  assert.doesNotMatch(html, /if \(OV\.pending\) \{ OV\.pending\.remove\(\); OV\.pending = null; \}/);
});

test("a dropped request is a note, not a failure — the turn's answer still lands from the bus", () => {
  assert.match(html, /const dropped = err instanceof TypeError \|\| \[502, 503, 504, 520, 521, 522, 523, 524\]\.includes\(err\.status\);/);
  assert.match(html, /Object\.assign\(new Error\(\(await r\.text\(\)\)\.slice\(0, 200\)\), \{ status: r\.status \}\)/);
});

test("# in the composer autocompletes the projects", () => {
  assert.match(html, /<script src="\/tag-complete\.js"><\/script>/);
  assert.match(html, /TagComplete\(input0, \(\) => S\.workspaces\);/);
});

test("+ Terminal sits at the top of the rail, above the terminals", () => {
  assert.match(html, /<aside class="rail" id="rail">\s*<button class="btn primary rail-new" id="btn-new"/);
});
