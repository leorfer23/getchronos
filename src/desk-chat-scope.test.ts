import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// The Desk chat with Robert: ONE chat, routed by the daemon. The composer's picker is only a view
// filter — the operator's alone: nothing he answers moves it, it never decides where a line goes,
// and the operator's own exchanges stay on screen through it.
const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");

test("the picker is a view filter: it never posts a sticky and nothing routes on it", () => {
  assert.match(html, /qs\("#chat-ws"\)\.onchange = \(e\) => pickWs\(e\.target\.value \|\| null\);/);
  assert.match(html, /function pickWs\(ws\) \{\s*OV\.filter = ws \|\| null;/);
  assert.doesNotMatch(html, /api\("\/thread\/sticky"/);
  // The line goes out with no ws: the router reads the project from the text.
  assert.match(html, /const body = \{ text: item\.text, session: S\.active \|\| null, client: CLIENT \};/);
  // It survives a reload.
  assert.match(html, /localStorage\.getItem\("desk-chat-filter"\)/);
});

test("switching the filter redraws the log from that project's own history — not mid-turn", () => {
  assert.match(html, /if \(!OV\.busy && !OV\.queue\.length\) ovHistory\(true\);/);
  assert.match(html, /async function ovHistory\(reload = false\)/);
  assert.match(html, /OV\.filter \? "\/agent\/history\?ws=" \+ encodeURIComponent\(OV\.filter\) \+ "&limit=16" : "\/agent\/history\?ws=all&limit=16"/);
  assert.match(html, /if \(reload\) OV\.log\.innerHTML = "";/);
  // Two quick switches: only the last fetch paints.
  assert.match(html, /const gen = \+\+OV\.histGen;/);
  assert.match(html, /if \(gen !== OV\.histGen\) return;/);
});

test("where his answer lands never moves the filter; a chip is a shortcut to it", () => {
  assert.doesNotMatch(html, /noteLanding/);
  assert.match(html, /else \{ setChip\(item\.bub, r\?\.ws \?\? null\); OV\.sticky = r\?\.ws \?\? null; RP\.mark\(item\.bub, r\?\.id, "you"\); \}/);
  assert.match(html, /pickWs\(ws && ws !== OV\.filter && wsById\(ws\) \? ws : null\);/);
  // Asking about a terminal routes on its id in the text; the filter stays put.
  assert.doesNotMatch(html, /pickWs\(s\.workspace_id/);
});

test("your own exchanges show through the filter, whatever project they land on", () => {
  assert.match(html, /const offFilter = \(el\) => OV\.filter !== null && !el\._own && \(el\.dataset\.ws \|\| ""\) !== OV\.filter;/);
  assert.match(html, /ovLine\("you" \+ \(OV\.busy \? " queued" : ""\), text, undefined, true, true\)/);
  assert.match(html, /OV\.pending = ovLine\("rob pending", "", e\.ws \?\? null, false, e\.client === CLIENT\);/);
  assert.match(html, /ovLine\("rob", e\.reply, e\.ws \?\? null, !fromHere && !e\.you, fromHere\), e\.id, "reply"\);/);
  assert.match(html, /const d = ovLine\("rob", r\.reply, null, false, true\);/);
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
