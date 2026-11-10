import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// The pages in static/ ship as written: no build step, so nothing else would notice these.
const dir = path.join(process.cwd(), "static");
const pages = fs.readdirSync(dir).filter((f) => f.endsWith(".html"));
const scripts = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");

// A duplicate top-level `const` (two branches each adding the same helper merges cleanly in git) is
// a SyntaxError that kills the WHOLE page script at load. Parse every inline script and every file.
test("every page's inline scripts and every static script parse", () => {
  for (const page of pages) {
    const inline = [...read(page).matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="module")[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    for (const src of inline) assert.doesNotThrow(() => new Function(src), `${page}: an inline script does not parse`);
  }
  for (const f of scripts) assert.doesNotThrow(() => new Function(read(f)), `${f} does not parse`);
  assert.ok(pages.includes("desk.html") && pages.includes("phone.html"));
});

// A token templated into a static file is one `curl` away from a sandboxed agent: pages read it
// from localStorage / window.__MC_TOKEN__ at runtime, never from their own source.
test("no static file carries a token", () => {
  for (const f of [...pages, ...scripts]) {
    const src = read(f);
    assert.doesNotMatch(src, /__MC_TOKEN__\s*=\s*["'`]/, `${f} assigns a literal token`);
    assert.doesNotMatch(src, /["'`][0-9a-f]{64}["'`]/, `${f} holds a 64-hex secret`);
  }
});

// The Desk's frame budget (one live pane, WKWebView): indicators blink off a 1 Hz class flip, never
// an infinite CSS animation that repaints every frame.
test("the Desk runs no infinite CSS animation", () => {
  const css = read("desk.html").split("</style>")[0];
  assert.doesNotMatch(css, /animation:[^;]*infinite/);
  assert.doesNotMatch(css, /@keyframes/);
});
