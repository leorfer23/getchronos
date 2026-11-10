/**
 * The phone surface (static/phone.html + static/sw.js) has no build step. The call engine and the
 * approval deck are run for real in src/phone-voice.test.ts and src/phone-deck.test.ts; here, the
 * PWA manifest a phone installs from, and the few lines of page wiring where a slip would act for him
 * twice, say a stuck-work alert was heard when it was not, or put an API answer in the offline cache.
 * Minimum tokens: the wiring is the contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const html = read("static/phone.html");
const sw = read("static/sw.js");

test("installs as a PWA: manifest with an id and 192/512 icons (one maskable), standalone, keyboard-aware viewport", () => {
  assert.match(html, /<link rel="manifest" href="\/phone\.webmanifest">/);
  const manifest = JSON.parse(read("static/phone.webmanifest"));
  assert.equal(manifest.start_url, "/phone");
  assert.equal(manifest.id, "/phone");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.icons.some((i: any) => i.sizes === "192x192"));
  assert.ok(manifest.icons.some((i: any) => i.sizes === "512x512" && i.purpose === "maskable"));
  for (const i of manifest.icons) assert.ok(fs.existsSync(path.join(process.cwd(), "static", i.src)), i.src);
});

test("never twice, never falsely heard, never cached: a write is not retried, 'spoken' only after it played, /api stays off the shell", () => {
  assert.match(html, /method === "GET" && err instanceof TypeError/, "only a GET is retried after a blip");
  assert.match(html, /if \(played\) a\.done\(\)/, "the alert ladder hears 'done' only after the words played");
  assert.match(sw, /url\.pathname\.startsWith\("\/api"\)/, "the worker never serves an API answer from its cache");
});

test("lines he says while Robert works go as ONE follow-up when the turn ends; a quoted reply stays its own", () => {
  const src = html.slice(html.indexOf("function takeNext() {"));
  const body = src.slice(0, src.indexOf("\n}\n") + 3);
  const takeNext = new Function("R", body + "; return takeNext;");
  const el = () => ({ classList: { remove() {} }, _voice: true });
  const R: any = { outbox: [{ text: "y además", el: el(), quote: null }, { text: "lo del export", el: el(), quote: null }, { text: "otra cosa", el: el(), quote: { id: 1 } }] };
  const next = takeNext(R)();
  assert.equal(next.text, "y además\nlo del export", "consecutive lines join into one turn");
  assert.equal(R.outbox.length, 1, "a quoted reply stays its own turn");
});
