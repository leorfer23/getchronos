/**
 * The Desk's trigger rows (static/desk-triggers.js), run in a vm the way the page runs them: the switch
 * says on or off, the last fire reads in words, and nothing an agent wrote into a trigger reaches the
 * page as markup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ctx: any = {};
vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), "static/desk-triggers.js"), "utf8"), ctx);
const T = ctx.DeskTriggers;

const base = {
  id: "1a2b3c4d-0000", workspace_id: "ws-a", kind: "metric", name: "cost today", label: "`./cost` moves more than 20% from its 7-day median",
  then: "open a terminal: explain it", enabled: true, paused_reason: null, next_check_at: "2026-11-14T09:00:00Z", last_check: "100 — within ±20%",
  last_fire: { at: "2026-11-13T15:00:00Z", outcome: "opened", session_id: "5e55a0c1-0000", reason: null },
};
const h = { wsBit: (id: string) => `<span class="ws">${id}</span>`, when: (iso: string) => `at ${iso.slice(11, 16)}` };

test("a row: its switch, what it watches and does, and its last fire in words", () => {
  const html = T.row(base, h);
  assert.match(html, /data-tgsw="1a2b3c4d-0000" data-on="1" aria-pressed="true"[^>]*>On</);
  assert.match(html, /<b>when<\/b> `\.\/cost` moves more than 20%.*<b>then<\/b> open a terminal: explain it/);
  assert.match(html, /last: opened a terminal · at 15:00/);
  assert.match(html, /next look at 09:00/);
  assert.match(html, /data-tgsess="5e55a0c1-0000"/, "a click on the row can show its last terminal");
  assert.match(html, /<span class="ws">ws-a<\/span>/);

  const off = T.row({ ...base, enabled: false, paused_reason: "proposed by terminal abcdef12", last_fire: null }, h);
  assert.match(off, /class="lp-row tg-row tg-off"/);
  assert.match(off, /data-on="0" aria-pressed="false"[^>]*>Off</);
  assert.match(off, /off: proposed by terminal abcdef12/);
  assert.match(off, /never fired/);
  assert.doesNotMatch(off, /next look/, "an off trigger is not looked at");

  assert.equal(T.lastLine({ last_fire: { outcome: "skipped", reason: "rate limit — 3 started in the last day", at: "x" } }), "last: skipped (rate limit — 3 started in the last day)");
});

test("nothing a trigger carries reaches the page as markup", () => {
  const html = T.row({ ...base, name: '<img src=x onerror=alert(1)>', label: '"><script>bad()</script>', then: "a & b", paused_reason: null, last_check: "<b>x</b>" }, h);
  assert.doesNotMatch(html, /<img|<script|<b>x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /a &amp; b/);
});

test("rows group by workspace, then by name", () => {
  const rows = T.sort([{ workspace_id: "b", name: "z" }, { workspace_id: "a", name: "y" }, { workspace_id: "a", name: "c" }]);
  assert.deepEqual(Array.from(rows, (r: any) => `${r.workspace_id}/${r.name}`), ["a/c", "a/y", "b/z"]);
});
