import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// The Desk chat with Robert: the composer's project picker is the ONE scope of the log. auto shows
// every project's conversation in one timeline (chipped); a picked project shows that conversation
// only, so following one client is following one thread.
const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");

test("the picker is the scope: the filter always equals the sticky project", () => {
  assert.match(html, /function applyWsFilter\(\) \{\s*OV\.filter = OV\.sticky \|\| null;/);
  assert.match(html, /qs\("#chat-ws"\)\.onchange = \(e\) => pickWs\(e\.target\.value \|\| null\);/);
  assert.match(html, /async function pickWs\(ws\) \{\s*OV\.sticky = ws \|\| null;\s*renderWsPick\(\);\s*applyWsFilter\(\);/);
  // The daemon's sticky moves with the picker — where the next line goes IS what you are looking at.
  assert.match(html, /api\("\/thread\/sticky", \{ method: "POST", body: JSON\.stringify\(\{ ws: OV\.sticky \}\) \}\)/);
});

test("switching project redraws the log from that thread's own history — not mid-turn", () => {
  assert.match(html, /if \(!OV\.busy && !OV\.queue\.length\) ovHistory\(true\);/);
  assert.match(html, /async function ovHistory\(reload = false\)/);
  assert.match(html, /OV\.sticky \? "\/agent\/history\?ws=" \+ encodeURIComponent\(OV\.sticky\) \+ "&limit=16" : "\/agent\/history\?ws=all&limit=16"/);
  assert.match(html, /if \(reload\) OV\.log\.innerHTML = "";/);
  // Two quick switches: only the last fetch paints.
  assert.match(html, /const gen = \+\+OV\.histGen;/);
  assert.match(html, /if \(gen !== OV\.histGen\) return;/);
});

test("where his answer lands moves the scope too; a chip is a shortcut to the picker", () => {
  assert.match(html, /function noteLanding\(ws\) \{\s*if \(ws === undefined\) return;\s*OV\.sticky = ws \|\| null;\s*renderWsPick\(\);\s*applyWsFilter\(\);/);
  assert.match(html, /pickWs\(ws && ws !== OV\.sticky && wsById\(ws\) \? ws : null\);/);
});

test("rows born on a picked project are chipped with it, so the scope never hides your own turn", () => {
  assert.match(html, /ovLine\("you" \+ \(OV\.busy \? " queued" : ""\), text, OV\.sticky \?\? undefined\)/);
  assert.match(html, /OV\.pending = ovLine\("rob pending", "", e\.ws === undefined \? OV\.sticky \?\? undefined : e\.ws, false\);/);
  assert.match(html, /const d = ovLine\("rob", r\.reply, OV\.sticky \?\? null, false\);/);
  assert.match(html, /"\(failed: " \+ String\(err\.message\)\.slice\(0, 160\) \+ "\)", OV\.sticky \?\? null, false\)/);
});
