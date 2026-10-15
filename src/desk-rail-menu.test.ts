/** Right-click on a rail row opens that row's actions at the pointer (static/desk.html). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
const fn = (name: string) => {
  const at = html.indexOf(`function ${name}(`);
  assert.ok(at >= 0, name);
  return html.slice(at, html.indexOf("\n}\n", at) + 2);
};

test("a right-click on a rail row opens its menu at the pointer, not the browser's", () => {
  assert.match(html, /qs\("#rail"\)\.addEventListener\("contextmenu"/);
  assert.match(html, /e\.preventDefault\(\);\s+const m = qs\("#menu-row"\)/);
  assert.match(html, /openMenu\(m, row, \{ x: e\.clientX, y: e\.clientY \}\)/);
  assert.match(fn("openMenu"), /if \(at\) \{/);
});

test("live terminals, ended ones and parked notes each get their own actions; destructive ones arm", () => {
  const live = fn("sessionActions");
  for (const l of ["✓ Goal reached", "✏️ Rename…", "👁 Have Robert watch it", "🔗 Copy reopen link", "✕ Close terminal", "↻ Reopen", "✕ Remove from the list"]) assert.ok(live.includes(l), l);
  assert.match(live, /armed: "✕ Close\? click again"/);
  const jot = fn("jotActions");
  for (const l of ["▶ Run in a terminal", "✓ Mark done", "✏️ Edit…", "⏰ Follow up…", "📋 Copy text", "✕ Delete"]) assert.ok(jot.includes(l), l);
  assert.match(jot, /armed: "✕ Delete\? click again"/);
});

test("a watched terminal says what Robert watches for, when he looks next and what he said last", () => {
  const block = fn("watchBlock");
  for (const l of ["Robert is watching", "Anything that needs you", "first look ", "next look ", "Robert's closing report", "earlier checks"]) assert.ok(block.includes(l), l);
  assert.match(fn("paintRow"), /eye\.classList\.toggle\("looking"/);
  assert.match(html, /<dialog id="dlg-watch">/);
  assert.doesNotMatch(html, /prompt\("Robert checks this terminal every/);
});

test("a plain live terminal can be promoted to Lead from its menu; the restart arms first", () => {
  const live = fn("sessionActions");
  assert.match(live, /s\.role !== "lead" && !s\.lead_id && s\.workspace_id/);
  assert.match(live, /label: "◆ Promote to Lead", armed: "◆ Restart as Lead\? click again"/);
  assert.match(fn("promoteLead"), /"\/sessions\/" \+ id \+ "\/promote-lead"/);
});
