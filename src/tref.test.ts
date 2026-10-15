import { test } from "node:test";
import assert from "node:assert/strict";
import { tref } from "./telegram/api.js";

/**
 * PER-25. Operator, verbatim: "PER-88 not relevant to me, need to understand what the ticket is
 * about in a short words." A key is an index into a system he does not hold in his head, so the
 * title leads and the key trails for when he needs it to act.
 */

test("the title leads, the key trails", () => {
  const s = tref({ key: "PER-15", title: "Los answers a asks no aterrizan" });
  // What it IS comes first — that is the whole point.
  assert.ok(s.indexOf("Los answers") < s.indexOf("PER-15"), "title must precede the key");
  assert.match(s, /<b>Los answers a asks no aterrizan<\/b>/);
  assert.match(s, /<code>PER-15<\/code>/);
});

test("a long title is truncated so it stays one phone line", () => {
  const long = "A".repeat(120);
  const s = tref({ key: "PER-99", title: long });
  assert.ok(s.length < 120, "must not put a 120-char title on the phone");
  assert.match(s, /…<\/b>/, "truncation is marked");
  assert.match(s, /<code>PER-99<\/code>/, "the key survives truncation");
});

test("no title falls back to the bare key, not a dangling dash", () => {
  assert.equal(tref({ key: "PER-7", title: "" }), "<b>PER-7</b>");
  assert.equal(tref({ key: "PER-7", title: null }), "<b>PER-7</b>");
  assert.equal(tref({ key: "PER-7" }), "<b>PER-7</b>");
  assert.equal(tref({ key: "PER-7", title: "   " }), "<b>PER-7</b>", "whitespace is not a title");
});

test("a title with HTML is escaped, not rendered", () => {
  // Titles are operator- and agent-authored free text and land in an HTML parse_mode message.
  const s = tref({ key: "PER-1", title: "fix <script>alert(1)</script> & co" });
  assert.ok(!s.includes("<script>"), "no raw tag may reach Telegram");
  assert.match(s, /&lt;script&gt;/);
  assert.match(s, /&amp; co/);
});

test("a missing ticket renders as nothing rather than 'undefined'", () => {
  assert.equal(tref(null), "");
  assert.equal(tref(undefined), "");
  assert.equal(tref({ key: "" } as any), "");
});
