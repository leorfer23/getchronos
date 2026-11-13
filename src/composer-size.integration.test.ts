/**
 * The composers' size in a REAL browser, with each page's own CSS and markup and static/fit-box.js as
 * shipped (darwin with chrome-headless-shell / Chrome for Testing — skipped cleanly otherwise;
 * src/fit-box.test.ts holds the same rules everywhere).
 *
 * 2026-11-13: a draft put back on page load sized the Desk's composer while it was hidden — "0px" — and
 * it sat as a 20px sliver with its placeholder cut in half until the next keystroke. What a person sees
 * is the rule here: the box is never shorter than its text (clientHeight >= scrollHeight), at rest it is
 * one line the height of the model chip beside it, it grows with the text up to its cap and shrinks back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { findEngine } from "./resources/browser-engine.js";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), "static", f), "utf8");
const css = (page: string) => [...page.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
const one = (page: string, re: RegExp, what: string) => {
  const m = re.exec(page);
  if (!m) throw new Error(`${what} not found in the page — update this test with the markup`);
  return m[0];
};

const engine = process.platform === "darwin" ? findEngine({ home: os.homedir(), platform: process.platform }).found : null;
let chromium: any = null;
try { chromium = createRequire(import.meta.url)("playwright").chromium; } catch {}
const skip = !engine ? "no chrome-headless-shell / Chrome for Testing installed" : !chromium ? "playwright not installed" : false;

function deskPage(): string {
  const desk = read("desk.html");
  const form = one(desk, /<form class="composer" id="composer">[\s\S]*?<\/form>/, "the Desk composer");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css(desk)}</style></head><body>${form}<script>${read("fit-box.js")}</script></body></html>`;
}
function phonePage(): string {
  const phone = read("phone.html");
  const row = one(phone, /<div class="fcomposer">[\s\S]*?<\/textarea>[\s\S]*?<\/button>\s*<\/div>/, "the phone composer");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css(phone)}</style></head><body>${row}<script>${read("fit-box.js")}</script></body></html>`;
}

const measure = (page: any, sel: string) =>
  page.evaluate((s: string) => {
    const t = document.querySelector(s) as HTMLTextAreaElement;
    return { inline: t.style.height, client: t.clientHeight, scroll: t.scrollHeight, offset: t.offsetHeight };
  }, sel);

test("real browser: the Desk's composer — sized while hidden it still shows one whole line, as tall as the chip", { skip, timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ executablePath: engine!.path, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(deskPage());
    const fit = (text: string) => page.evaluate((v: string) => { const t = document.getElementById("say") as HTMLTextAreaElement; t.value = v; (window as any).fitBox(t, Math.round(innerHeight * 0.4)); }, text);
    const show = () => page.evaluate(() => { document.body.classList.add("mode-focus"); document.getElementById("composer")!.classList.add("live"); });
    await page.evaluate(() => { (document.getElementById("say-cmds") as HTMLElement).textContent = "fable"; });

    // The 2026-11-13 path: a draft put back while the composer is hidden (no live terminal yet), then shown.
    await fit("");
    await show();
    const rest = await measure(page, "#say");
    assert.notEqual(rest.inline, "0px", "sized while hidden: never pinned to 0px");
    assert.ok(rest.client >= rest.scroll, `one whole line shows: client ${rest.client} >= scroll ${rest.scroll}`);
    const chip = await page.evaluate(() => (document.getElementById("say-cmds") as HTMLElement).offsetHeight);
    assert.equal(rest.offset, chip, "at rest the box is the chip's height — they line up");

    // Shown and typed into: still one whole line, still the chip's height.
    await fit("hello");
    const typed = await measure(page, "#say");
    assert.ok(typed.client >= typed.scroll, `typed: nothing clipped (${typed.client} >= ${typed.scroll})`);
    assert.equal(typed.offset, chip);

    // Four lines: taller, nothing clipped. Cleared: back to one line.
    await fit("a\nb\nc\nd");
    const four = await measure(page, "#say");
    assert.ok(four.offset > chip, "grows with the text");
    assert.ok(four.client >= four.scroll, `four lines: nothing clipped (${four.client} >= ${four.scroll})`);
    await fit("");
    assert.equal((await measure(page, "#say")).offset, chip, "cleared: one line again");

    // A wall of text stops at 40% of the window and scrolls.
    await fit(Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"));
    const wall = await measure(page, "#say");
    assert.ok(wall.offset <= Math.round(900 * 0.4) + 1, `capped: ${wall.offset}px`);
    assert.ok(wall.scroll > wall.client, "the rest scrolls");
  } finally {
    await browser.close();
  }
});

test("real browser: the phone's composer — one whole line at rest, grows to its cap, never clipped", { skip, timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ executablePath: engine!.path, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await page.setContent(phonePage());
    const fit = (text: string) => page.evaluate((v: string) => { const t = document.getElementById("f-composer") as HTMLTextAreaElement; t.value = v; (window as any).fitBox(t, 140); }, text);

    await page.evaluate(() => { (document.querySelector(".fcomposer") as HTMLElement).hidden = true; });
    await fit("a draft");
    await page.evaluate(() => { (document.querySelector(".fcomposer") as HTMLElement).hidden = false; });
    const rest = await measure(page, "#f-composer");
    assert.notEqual(rest.inline, "0px");
    assert.ok(rest.client >= rest.scroll, `sized while hidden, then shown: one whole line (${rest.client} >= ${rest.scroll})`);
    assert.ok(rest.offset >= 48, `at least its 48px rest height: ${rest.offset}`);

    await fit("hello");
    const typed = await measure(page, "#f-composer");
    assert.equal(typed.offset, 48, "one line typed: the 48px rest height");
    assert.ok(typed.client >= typed.scroll);

    await fit("a\nb\nc");
    const three = await measure(page, "#f-composer");
    assert.ok(three.offset > 48 && three.client >= three.scroll, `three lines: taller, nothing clipped (${three.offset}px)`);

    await fit(Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"));
    const wall = await measure(page, "#f-composer");
    assert.ok(wall.offset <= 140, `capped at 140px: ${wall.offset}`);
  } finally {
    await browser.close();
  }
});
