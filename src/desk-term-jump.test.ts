/**
 * The Desk's top / bottom buttons over the terminal. Plain HTML in static/desk.html with no build
 * step, so these read the shipped file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");

test("the terminal has a go-to-beginning and a go-to-bottom button", () => {
  assert.match(html, /<div class="term" id="term">[\s\S]*?<button id="tj-top"[^>]*>[\s\S]*?<button id="tj-bot"[^>]*>/);
  assert.match(html, /qs\("#tj-top"\)\.onclick = \(\) => termJump\(true\);/);
  assert.match(html, /qs\("#tj-bot"\)\.onclick = \(\) => termJump\(false\);/);
});

test("normal screen scrolls xterm; the alternate screen sends Claude's scroll:top / scroll:bottom keys", () => {
  const fn = html.match(/function termJump\(top\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(fn, "termJump exists");
  assert.match(fn!, /buffer\.active\.type === "normal"/);
  assert.match(fn!, /scrollToTop\(\)/);
  assert.match(fn!, /scrollToBottom\(\)/);
  assert.match(fn!, /\\x1b\[1;5H/);
  assert.match(fn!, /\\x1b\[1;5F/);
});
