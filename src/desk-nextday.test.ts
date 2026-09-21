/**
 * The Desk's "Plan tomorrow" button and the day-grouped pad. The page is plain HTML with no build
 * step, so — as with desk-blank.test.ts — these read the shipped file for the hooks the daemon
 * side relies on, and check the schemas the button posts through.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { NewJotSchema, PlanNextDaySchema } from "./validation.js";

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");

test("the bar has the button, the dialog posts to /nextday with a date and per-client steering", () => {
  assert.match(html, /id="btn-tomorrow"/);
  assert.match(html, /<dialog id="dlg-tomorrow">/);
  assert.match(html, /id="plan-date" type="date"/);
  assert.match(html, /api\("\/nextday", \{ method: "POST", body: JSON\.stringify\(\{ workspaces, steering, date/);
  assert.match(html, /function nextWorkday\(/);
});

test("the pad groups a day's cards under a Next Day rule and repaints when a planner files one", () => {
  assert.match(html, /"🌙 Next Day " \+ esc\(j\.for_date\.slice\(5\)\)/);
  assert.match(html, /"jot\.updated", "jot\.ran",/);
  assert.match(html, /e\.topic === "jot\.updated" \|\| e\.topic === "jot\.ran"\) loadSoon\(\)/);
  assert.match(html, /el\.classList\.toggle\("planned", j\.source === "nextday"\)/);
  // A run or ticked card leaves the pad: the terminal owns the work, the row stays for mc jot list.
  assert.match(html, /S\.jots\.filter\(\(j\) => j\.status === "open"\)/);
  // Rows and day rules are placed with `order`, which only a flex container honours.
  assert.match(html, /id="sec-parked"/);
  // A card's body is shown rendered, not hidden behind a toggle; agent text is escaped first.
  assert.match(html, /function mdLite\(/);
  assert.match(html, /<div class="jot-view"><\/div>/);
  assert.doesNotMatch(html, /to-planner/);
});

test("the plan request: ids, optional steering keyed by id, a calendar day", () => {
  assert.equal(PlanNextDaySchema.safeParse({}).success, true);
  assert.equal(PlanNextDaySchema.safeParse({ workspaces: ["a"], steering: { a: "x" }, date: "2026-09-04" }).success, true);
  assert.equal(PlanNextDaySchema.safeParse({ date: "tomorrow" }).success, false);
  assert.equal(PlanNextDaySchema.safeParse({ workspaces: [] }).success, false);
});

test("a filed card's day is a calendar date or nothing", () => {
  assert.equal(NewJotSchema.safeParse({ title: "t", for_date: "2026-09-04", planned_by: "s1" }).success, true);
  assert.equal(NewJotSchema.safeParse({ title: "t" }).success, true);
  assert.equal(NewJotSchema.safeParse({ title: "t", for_date: "09-04" }).success, false);
  assert.equal(NewJotSchema.safeParse({ title: "t", source: "operator" }).success, true, "source is ignored on input, never trusted");
});
