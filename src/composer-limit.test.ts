// The composer's size limit (2026-11-13: a long brief over the old 4 000-character cap was refused AND
// cleared from the box, so it was lost). The daemon takes 20 000; both composers check the same number
// before sending, so a refusal for length never happens after the text has left the box.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SessionInputSchema } from "./validation.js";

const root = path.join(import.meta.dirname, "..");

test("one line typed into a terminal may be 20 000 characters, not one more", () => {
  assert.equal(SessionInputSchema.safeParse({ text: "a".repeat(20000), enter: true }).success, true);
  assert.equal(SessionInputSchema.safeParse({ text: "a".repeat(20001), enter: true }).success, false);
});

test("the Desk and phone composers check the same limit the daemon enforces", () => {
  for (const page of ["static/desk.html", "static/phone.html"]) {
    const m = /const SAY_MAX = (\d+);/.exec(fs.readFileSync(path.join(root, page), "utf8"));
    assert.ok(m, `${page} declares SAY_MAX`);
    assert.equal(Number(m![1]), 20000, `${page} SAY_MAX matches SessionInputSchema.text`);
  }
});
