/**
 * The Desk's inbox (src/inbox.ts): a badge on the bar and one page grouped by client. The page is plain
 * HTML with no build step, so — as with desk-nextday.test.ts — these read the shipped file for the
 * hooks the daemon side relies on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");

test("the bar carries the inbox with an unread badge fed by /desk and repainted on inbox.updated", () => {
  assert.match(html, /id="btn-inbox"/);
  assert.match(html, /id="inbox-unread"/);
  assert.match(html, /IB\.counts = d\.inbox \|\| \{\}; syncInboxBadge\(\);/);
  assert.match(html, /"inbox\.updated",\n\]\.join\(","\)/);
  assert.match(html, /e\.topic === "inbox\.updated"\) return loadInboxSoon\(\)/);
});

test("the page: grouped by client, newest first, one row per item with Dispatch / Later / dismiss", () => {
  assert.match(html, /<dialog id="dlg-inbox">/);
  assert.match(html, /api\("\/inbox"\)/);
  assert.match(html, /api\("\/inbox\/" \+ id \+ "\/dispatch", \{ method: "POST"/);
  assert.match(html, /api\("\/inbox\/" \+ id \+ "\/dismiss"/);
  assert.match(html, /api\("\/inbox\/" \+ id \+ "\/snooze", \{ method: "POST", body: JSON\.stringify\(\{ until: b\.dataset\.until \}\) \}\)/);
  assert.match(html, /data-until="2h"/);
  assert.match(html, /data-until="tomorrow 9:00"/);
  // External text is escaped before it touches innerHTML; the link opens in a new tab without an opener.
  assert.match(html, /\$\{esc\(i\.title\)\}/);
  assert.match(html, /\$\{esc\(i\.why \|\| ""\)\}/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("nothing on the page dispatches by itself — only the Dispatch button's click does", () => {
  const calls = html.match(/\/dispatch"/g) ?? [];
  assert.equal(calls.length, 1);
  const at = html.indexOf('"/dispatch"');
  assert.ok(html.lastIndexOf('if (a === "go")', at) > html.lastIndexOf("qs(\"#ib-list\").onclick", at) - 1);
});
