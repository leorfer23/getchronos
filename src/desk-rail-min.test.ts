import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");

test("the rail folds away with ◧ or ⌘B, persists, and the pty never sees the chord", () => {
  assert.match(html, /<button class="icon" id="btn-rail" title="Hide the rail \(⌘B\)">◧<\/button>/);
  assert.match(html, /body\.rail-min \.rail \{ display:none; \}/);
  assert.match(html, /const railKey = \(e\) => \(e\.metaKey \|\| e\.ctrlKey\) && !e\.shiftKey && !e\.altKey && e\.key\.toLowerCase\(\) === "b";/);
  assert.match(html, /localStorage\.setItem\("desk-rail", min \? "0" : "1"\);/);
  assert.match(html, /railToggle\(localStorage\.getItem\("desk-rail"\) === "0"\);/);
  assert.match(html, /if \(railKey\(e\)\) \{ e\.preventDefault\(\); return railToggle\(\); \}/);
  assert.match(html, /compKey\(e\) \|\| railKey\(e\) \|\|/);
});
