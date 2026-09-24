/**
 * Computers on the Desk (HOSTS.md). One Mac must look exactly as it did before hosts existed: the
 * chip, the rail and "+ Terminal" only change once a second computer has joined. These read the
 * shipped file — desk.html has no build step to catch a regression.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");

test("one Mac: the header chip is today's chip until a remote computer exists", () => {
  assert.match(html, /function renderMac\(\) \{\n  const s = M\.snap, el = qs\("#mac"\);\n  if \(hRemote\(\)\.length\) return renderFleetChip\(el, s\);/);
  assert.match(html, /function openMac\(anchor\) \{\n  if \(hRemote\(\)\.length\) return openFleet\(anchor\);/);
  assert.match(html, /const hRemote = \(\) => \(H\.list \|\| \[\]\)\.filter\(\(h\) => !h\.is_brain\);/);
  // Polled only while there is something remote to show, or the dialog is open.
  assert.match(html, /if \(!document\.hidden && \(hRemote\(\)\.length \|\| qs\("#dlg-hosts"\)\.open\)\) loadHosts\(\);/);
});

test("Computers lives behind ⋯ and follows the host.* bus events", () => {
  assert.match(html, /<button id="btn-hosts">🖥 Computers<\/button>/);
  assert.match(html, /<dialog id="dlg-hosts">/);
  assert.match(html, /"host\.online", "host\.offline", "host\.updated",/);
  assert.match(html, /api\("\/hosts\/join-codes", \{ method: "POST"/);
  assert.match(html, /api\("\/hosts\/" \+ encodeURIComponent\(id\), \{ method: "PATCH"/);
  // Policy is written in the contract shape the remote-terminals side reads: {deny: [...]}.
  assert.match(html, /hPatch\(h\.id, \{ policy: \{ deny: \[\.\.\.deny\] \} \}\)/);
  // Removing a computer is armed, never confirm() (WKWebView answers false).
  assert.match(html, /arm\(rv, "Remove — its token stops working now"/);
});

test("rail and stage: a tag only for terminals on another computer; its computer offline dims the row", () => {
  assert.match(html, /if \(id === "local"\) return null;/);
  assert.match(html, /\(ho\?\.off && s\.live \? " hoff" : ""\)/);
  assert.match(html, /<span class="side"><span class="htag" hidden><\/span>/);
});

test("+ Terminal: the computer picker shows only with a remote computer online, and sends host_id", () => {
  assert.match(html, /<select id="q-host" title="Which computer it runs on" hidden><\/select>/);
  assert.match(html, /const show = up\.some\(\(h\) => !h\.is_brain\);\n  sel\.hidden = !show;/);
  assert.match(html, /\.\.\.\(host_id \? \{ host_id \} : \{\}\)/);
  // A computer whose policy or veto denies the chosen client is offered, but disabled.
  assert.match(html, /<option value="\$\{esc\(h\.id\)\}"\$\{why \? " disabled" : ""\}>/);
});

test("the dialog never repaints under a field being typed in", () => {
  assert.match(html, /if \(d\.open && !\(a && a\.tagName === "INPUT" && d\.contains\(a\)\)\) renderHosts\(\);/);
});
