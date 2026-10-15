/**
 * What every Desk terminal is told about browsers (agents/_blocks/browser.md, folded in by
 * terminal.ts). The order is the rule: avoid one, else borrow the shared one, never launch your own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { browserBlock } from "./terminal.js";

test("every terminal is told: avoid a browser, else `mc browser run`, never your own Chrome", () => {
  const b = browserBlock();
  const avoid = b.search(/Avoid a browser/), borrow = b.search(/mc browser run -- <cmd>/), never = b.search(/Never launch your own Chrome/);
  assert.ok(avoid >= 0 && borrow > avoid && never > borrow, "in that order");
  assert.match(b, /happy-dom|jsdom|linkedom/);
  assert.match(b, /mock `env\.BROWSER`/);
  assert.match(b, /CHRONOS_BROWSER_WS/);
  assert.match(b, /CHRONOS_BROWSER_CONTEXT/);
  assert.ok(!b.includes("<!--"), "editor notes are stripped");
  assert.ok(b.split("\n").filter((l) => l.trim()).length <= 6, "short: it rides every turn");
});
