/**
 * The Altitude surface (static/altitude.html) is plain HTML with no build step, so the regressions
 * this guards are strings in the shipped file: the token rule the whole product shares, the single
 * endpoint it is allowed to read, and the honesty markers that keep an estimate from reading as a
 * metered fact. Same approach as phone.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(path.join(process.cwd(), "static/altitude.html"), "utf8");
const desk = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");

test("the admin token is never baked into the page, and rides the Desk's localStorage key", () => {
  assert.match(html, /localStorage\.getItem\("mc-token"\)/);
  assert.match(html, /window\.__MC_TOKEN__/);
  assert.match(html, /"x-mc-admin": TOKEN/);
  // A token templated into static HTML is one `curl` away from a sandboxed agent (see api.ts).
  assert.doesNotMatch(html, /__MC_TOKEN__\s*=\s*["']/);
});

test("it reads the one analytics endpoint and nothing that mutates", () => {
  assert.match(html, /api\("\/analytics\?"/);
  assert.match(html, /\/api\/analytics\/export\.csv/);
  for (const verb of ["POST", "PUT", "DELETE", "PATCH"]) {
    assert.doesNotMatch(html, new RegExp(`method:\\s*["']${verb}`, "i"), `${verb} has no business here`);
  }
});

test("the window, the client filter and the metric all live in the URL, so a view is a link", () => {
  assert.match(html, /history\.replaceState/);
  assert.match(html, /h\.set\("preset", S\.preset\)/);
  assert.match(html, /q\.set\("workspace", S\.ws\)/);
});

test("estimated dollars stay labelled, and unpriced work stays visible", () => {
  assert.match(html, /tag est/);
  assert.match(html, /estimated from the token table/);
  assert.match(html, /carry no cost/);
  assert.match(html, /never cross-attributed/);
});

test("a terminal row is a door back to the wall", () => {
  assert.match(html, /\/desk#reopen=/);
});

test("it carries both themes and the Desk's token set", () => {
  assert.match(html, /prefers-color-scheme: dark/);
  for (const token of ["--surface-2", "--accent-soft", "--warn-soft", "--danger-soft"]) {
    assert.ok(html.includes(token), `${token} is part of the shared palette`);
  }
});

test("the Desk links to it, so the wall and the ledger are one product", () => {
  assert.match(desk, /href="\/altitude"/);
});
