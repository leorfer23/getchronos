/**
 * The composers' height (static/fit-box.js), run as shipped in a vm with a box that reports what a
 * browser would. The rule that broke on 2026-11-13: a box measured while hidden reads scrollHeight 0,
 * and "0px" left the Desk's composer a 20px sliver with its placeholder cut in half until the next
 * keystroke. A hidden box gets no inline height at all; a shown one counts its borders.
 * src/composer-size.integration.test.ts measures the same thing in a real browser with the pages' CSS.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const src = (f: string) => fs.readFileSync(path.join(process.cwd(), "static", f), "utf8");

/** A textarea as the browser lays it out: `content` = its text's height; hidden = nothing laid out. */
function box(o: { content: number; hidden?: boolean; sizing?: "border-box" | "content-box"; pad?: number; border?: number; minHeight?: number }) {
  const pad = o.pad ?? 10, border = o.border ?? 1, sizing = o.sizing ?? "border-box";
  const el: any = { style: { height: "" } };
  // At height:auto (fitBox sets it before measuring) the box is as tall as its text, at least min-height.
  const inner = () => Math.max(o.content + 2 * pad, (o.minHeight ?? 0) - 2 * border);
  Object.defineProperty(el, "scrollHeight", { get: () => (o.hidden ? 0 : inner()) });
  Object.defineProperty(el, "clientHeight", { get: () => (o.hidden ? 0 : inner()) });
  Object.defineProperty(el, "offsetHeight", { get: () => (o.hidden ? 0 : inner() + 2 * border) });
  const cs = { boxSizing: sizing, paddingTop: `${pad}px`, paddingBottom: `${pad}px` };
  return { el, cs };
}

function fitBoxFor(cs: Record<string, string>) {
  const ctx: any = { getComputedStyle: () => cs };
  ctx.window = ctx;
  vm.runInNewContext(src("fit-box.js"), ctx);
  return ctx.fitBox as (el: any, max?: number) => void;
}

test("hidden: no inline height at all — never 0px, so the CSS one-line height holds", () => {
  const { el, cs } = box({ content: 25, hidden: true });
  el.style.height = "47px";
  fitBoxFor(cs)(el, 360);
  assert.equal(el.style.height, "", "a box measured while hidden must not be pinned to what it measured");
});

test("shown, border-box: text + padding + borders, so nothing is clipped (the chip beside it is 47px)", () => {
  const { el, cs } = box({ content: 25 });
  fitBoxFor(cs)(el, 360);
  assert.equal(el.style.height, "47px", "25 text + 2×10 padding + 2×1 border");
});

test("shown, content-box: the text alone (scrollHeight counts the padding)", () => {
  const { el, cs } = box({ content: 25, sizing: "content-box" });
  fitBoxFor(cs)(el, 360);
  assert.equal(el.style.height, "25px");
});

test("it grows with the text up to max, then stops (the box scrolls)", () => {
  const { el, cs } = box({ content: 25 * 4 });
  const fit = fitBoxFor(cs);
  fit(el, 360);
  assert.equal(el.style.height, "122px");
  const big = box({ content: 25 * 40 });
  fit(big.el, 360);
  assert.equal(big.el.style.height, "360px");
});

test("a CSS min-height still counts (the phone's composer is 48px at rest)", () => {
  const { el, cs } = box({ content: 22, pad: 12, minHeight: 48 });
  fitBoxFor(cs)(el, 140);
  assert.equal(el.style.height, "48px");
});

test("no box, no throw", () => {
  assert.doesNotThrow(() => fitBoxFor({ boxSizing: "border-box" })(null, 100));
});

test("both composers size through fitBox — not a raw scrollHeight write that can pin 0px again", () => {
  // The contract is the text here: the one place a composer's height is computed is fit-box.js.
  const desk = src("desk.html"), phone = src("phone.html");
  assert.ok(desk.includes('<script src="/fit-box.js"></script>') && phone.includes('<script src="/fit-box.js"></script>'));
  assert.ok(/fitBox\?\.\(document\.getElementById\("say"\)/.test(desk), "the Desk's #say goes through fitBox");
  assert.ok(/fitBox\?\.\(fcomposer,/.test(phone), "the phone's #f-composer goes through fitBox");
  assert.ok(!/say\.style\.height\s*=\s*[^;"]*scrollHeight/.test(desk), "no raw scrollHeight write on the Desk's composer");
  assert.ok(!/fcomposer\.style\.height\s*=\s*[^;"]*scrollHeight/.test(phone), "no raw scrollHeight write on the phone's composer");
  assert.ok(src("sw.js").includes('"/fit-box.js"'), "the phone's offline shell carries it");
});
