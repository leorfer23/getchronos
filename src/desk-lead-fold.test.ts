import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");

test("a Lead's workers fold under it: folded by default, ▸ N unfolds, remembered per Desk", () => {
  assert.match(html, /leadOpen: new Set\(readJson\("desk-lead-open", \[\]\)\)/);
  assert.match(html, /for \(const s of top\) \{ rows\.push\(s\); if \(S\.leadOpen\.has\(s\.id\)\) rows\.push\(\.\.\.\(kids\.get\(s\.id\) \|\| \[\]\)\); \}/);
  assert.match(html, /localStorage\.setItem\("desk-lead-open", JSON\.stringify\(\[\.\.\.S\.leadOpen\]\)\);/);
  assert.match(html, /fold\.textContent = \(open \? "▾ " : "▸ "\) \+ kids\.length;/);
  assert.match(html, /if \(e\.target\.closest\("\.x, \.fold"\)\) return; select\(s\.id\);/);
});

test("a wall behind a fold still surfaces: the fold turns red, ⌘J unfolds it", () => {
  assert.match(html, /const URGENT = \["blocked", "decide"\];/);
  assert.match(html, /fold\.classList\.toggle\("hot", hot > 0\);/);
  assert.match(html, /&& !\(folded\(s\) && !URGENT\.includes\(phaseOf\(s\)\)\)\);/);
  assert.match(html, /if \(s\.live && folded\(s\)\) toggleLead\(s\.lead_id, true\);/);
});

test("J/K and the first pick walk what the rail shows, not the folded workers", () => {
  assert.match(html, /const r = needs\.length \? needs : railView\(\)\.rows\.map\(\(s\) => s\.id\);/);
  assert.match(html, /const first = railView\(\)\.rows\[0\];/);
});

test("the rail groups by workspace, oldest first inside a group", () => {
  assert.match(html, /\.sort\(\(a, b\) => \(!a\.workspace_id - !b\.workspace_id\) \|\| railWs\(a\)\.localeCompare\(railWs\(b\)\) \|\| \(a\.workspace_id \|\| ""\)\.localeCompare\(b\.workspace_id \|\| ""\) \|\| a\.created_at\.localeCompare\(b\.created_at\)\);/);
  assert.match(html, /const b = isKid\(s\) \? null : bandOf\(s\);/);
});
