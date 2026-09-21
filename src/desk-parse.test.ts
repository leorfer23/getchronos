import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// desk.html has no build step: a duplicate top-level `const` (two branches each adding the same
// helper merges cleanly in git) is a SyntaxError that kills the WHOLE page script at load. Parse it.
for (const page of ["desk.html", "phone.html"]) {
  test(`${page}: every inline script parses`, () => {
    const html = fs.readFileSync(path.join(process.cwd(), "static", page), "utf8");
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="module")[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0, "no inline script found");
    for (const src of scripts) assert.doesNotThrow(() => new Function(src), "inline script does not parse");
  });
}
