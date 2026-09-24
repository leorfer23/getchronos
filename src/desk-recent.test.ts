/**
 * Recent on the Desk rail: the last 20 terminals that ended.
 *
 * The rail itself is the triage queue and stays live-only (one terminal at a time, PR #313), so the
 * ended ones were reachable only through ⋯ → 🗒 Log. That is the right home for the day's numbers and
 * the wrong one for "the thing I closed ten minutes ago and want back". Recent is that second door:
 * the same rail rows, folded, newest first, with ↻ Reopen already on their ⋯ menu.
 *
 * The client is plain HTML with no build step, so this guards the shape of the code that ships.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const desk = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
const phone = fs.readFileSync(path.join(process.cwd(), "static/phone.html"), "utf8");

test("the rail has a Recent section, folded, under Parked", () => {
  assert.match(desk, /<section id="sec-recent" class="fold"><h3><span>Recent<\/span><span class="n" id="recent-n"><\/span>/);
  assert.match(desk, /<div class="rows" id="recent"><\/div><\/section>/);
  // Folded is the default and it is remembered, same key as Parked.
  assert.match(desk, /fold: readJson\("desk-fold", \{ parked: true, recent: true \}\)/);
  assert.match(desk, /S\.fold\.recent = !S\.fold\.recent; localStorage\.setItem\("desk-fold"/);
});

test("Recent holds the 20 newest ended terminals, hiding a live Lead's workers", () => {
  assert.match(desk, /const RECENT_MAX = 20;/);
  assert.match(desk, /rows = await api\("\/sessions\?status=ended&limit=100"\);/);
  // Sorted newest-first here, capped only in renderRecent — after the live-Lead filter (#31).
  assert.match(desk, /\.sort\(\(a, b\) => Date\.parse\(b\.ended_at\) - Date\.parse\(a\.ended_at\)\);/);
  assert.match(desk, /S\.ended\.filter\(\(s\) => !S\.dismissed\.has\(s\.id\) && !leadLive\(s\.lead_id\)\)\.slice\(0, RECENT_MAX\)/);
  // Same row element and painter as the rail: an ended row already knows how to draw itself.
  assert.match(desk, /reconcile\(qs\("#recent"\), rows, rowEl, paintRow\);/);
});

test("folded, Recent asks the daemon for nothing — history is never bootstrapped with the Desk", () => {
  assert.match(desk, /if \(S\.fold\.recent \|\| recentT\) return;/);
  assert.match(desk, /recentT = setTimeout\(\(\) => \(recentT = 0\), 2500\);/, "a burst of bus events is one query");
  assert.match(desk, /clearTimeout\(recentT\); recentT = 0; \/\/ unfolding asks now/);
});

test("an ended row can reach the stage, and ✕ on it stays removed", () => {
  // byId backs the stage, the story, ↻ Reopen and the row's ⋯ menu — it has to see ended rows.
  assert.match(desk, /const byId = \(id\) => S\.sessions\.find\(\(s\) => s\.id === id\) \|\| S\.ended\.find\(\(s\) => s\.id === id\);/);
  assert.match(desk, /const leadLive = \(id\) => !!id && S\.sessions\.some\(\(x\) => x\.id === id && x\.live\);/);
  // Dismissals are pruned against what the Desk still knows. Live rows alone handed every ✕ back.
  assert.match(desk, /const known = new Set\(\[\.\.\.d\.sessions, \.\.\.S\.ended\]\.map\(\(x\) => x\.id\)\);/);
});

test("the phone's Recent shows the same 20, with no time window", () => {
  assert.match(phone, /recent = S\.ended\.filter\(\(s\) => !isWorker\(s\)\)\.slice\(0, 20\);/);
  assert.doesNotMatch(phone, /const cut = Date\.now\(\) - 24 \* 3600 \* 1000;/);
});
