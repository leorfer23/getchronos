/**
 * Clicking a URL that Claude Code broke across rows opens the whole URL, not its first row.
 * The rows below are copied from a live 123-column Desk terminal: the TUI hard-breaks the URL one column
 * short of the edge and indents the rest, which xterm's web-links addon (soft wraps only) cannot follow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as { Terminal: typeof HeadlessTerminal };
const ctx: any = { URL };
vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), "static/term-links.js"), "utf8"), ctx);
const linksAt = (buf: unknown, cols: number, y: number) => JSON.parse(JSON.stringify(ctx.TermLinks.linksAt(buf, cols, y)));

async function screen(cols: number, rows: string[]) {
  const term = new Terminal({ cols, rows: rows.length + 2, allowProposedApi: true });
  await new Promise<void>((r) => term.write(rows.join("\r\n"), r));
  return { at: (y: number) => linksAt(term.buffer.active, cols, y), term };
}

const CLAUDE = [
  "  2. Paste the contents of Code.gs (https://github.com/acmecorp/settlement-close/blob/feat/netsuite-daily-fx-rates-sheet/i",
  "  ntegrations/netsuite_daily_fx/Code.gs) into the default Code.gs file (replace what's there).",
  "  3. Project Settings (gear icon) → check \"Show appsscript.json\", open it, replace with appsscript.json (https://github.co",
  "  m/acmecorp/settlement-close/blob/feat/netsuite-daily-fx-rates-sheet/integrations/netsuite_daily_fx/appsscript.json).",
  "  - 26 documentos instalados en 21 placements (PR https://github.com/contoso-products/inventory-docs/pull/246)",
  "  - Reports page con el catálogo rediseñado",
];

test("a hard-broken URL is one link from either row", async () => {
  const { at, term } = await screen(123, CLAUDE);
  const full = "https://github.com/acmecorp/settlement-close/blob/feat/netsuite-daily-fx-rates-sheet/integrations/netsuite_daily_fx/Code.gs";
  for (const y of [0, 1]) {
    const links = at(y);
    assert.equal(links.length, 1, `row ${y}`);
    assert.equal(links[0].text, full);
    assert.deepEqual(links[0].range, { start: { x: 37, y: 1 }, end: { x: 39, y: 2 } });
  }
  assert.equal(at(3)[0].text, "https://github.com/acmecorp/settlement-close/blob/feat/netsuite-daily-fx-rates-sheet/integrations/netsuite_daily_fx/appsscript.json");
  assert.equal(at(2)[0].text, at(3)[0].text);
  term.dispose();
});

test("a URL that ends before the edge is not glued to the next line", async () => {
  const { at, term } = await screen(123, CLAUDE);
  assert.deepEqual(at(4).map((l: any) => l.text), ["https://github.com/contoso-products/inventory-docs/pull/246"]);
  assert.deepEqual(at(5), []);
  term.dispose();
});

test("a URL spanning three rows, and one soft-wrapped by xterm itself", async () => {
  const { at, term } = await screen(20, ["see https://example.", "  com/aaaaaaaaaaaaaa", "  bbb done"]);
  for (const y of [0, 1, 2]) assert.equal(at(y)[0]?.text, "https://example.com/aaaaaaaaaaaaaabbb", `row ${y}`);
  term.dispose();
  const soft = await screen(20, ["go https://example.com/some/long/path ok"]);
  assert.equal(soft.at(1)[0]?.text, "https://example.com/some/long/path");
  soft.term.dispose();
});

test("a sentence that merely reaches the edge links nothing", async () => {
  const { at, term } = await screen(20, ["the quick brown fox", "  jumps over"]);
  assert.deepEqual(at(0), []);
  assert.deepEqual(at(1), []);
  term.dispose();
});

test("scan() reads every URL in a range once, stitching the ones a TUI broke across rows", async () => {
  const { term } = await screen(123, CLAUDE);
  const urls = JSON.parse(JSON.stringify(ctx.TermLinks.scan(term.buffer.active, 123, 0, 5)));
  assert.deepEqual(urls, [
    "https://github.com/acmecorp/settlement-close/blob/feat/netsuite-daily-fx-rates-sheet/integrations/netsuite_daily_fx/Code.gs",
    "https://github.com/acmecorp/settlement-close/blob/feat/netsuite-daily-fx-rates-sheet/integrations/netsuite_daily_fx/appsscript.json",
    "https://github.com/contoso-products/inventory-docs/pull/246",
  ]);
  term.dispose();
});

test("scan() is bounded by the rows it is given — what `gh pr create` just printed, not the whole day", async () => {
  const { term } = await screen(60, ["old https://github.com/o/r/pull/1", "", "new https://github.com/o/r/pull/2"]);
  const tail = JSON.parse(JSON.stringify(ctx.TermLinks.scan(term.buffer.active, 60, 2, 3)));
  assert.deepEqual(tail, ["https://github.com/o/r/pull/2"]);
  term.dispose();
});
