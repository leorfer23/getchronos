/**
 * The Desk's question-dialog card (static/desk.html dialogOf / dialogHtml), lifted out and run in a vm
 * over a menu read by the real parser from a frame captured on Claude Code 2.1.329. 2026-11-20: a
 * multi-select's card had no way to send — its buttons were disabled ("pick them in the terminal"), or,
 * as a Permission card, only ticked boxes. Now each answer ticks on the card and one Submit sends them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { detectPrompt } from "./desk-prompt.js";

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
const lift = (re: RegExp, what: string) => {
  const m = re.exec(html);
  assert.ok(m, `${what} is where this test looks for it`);
  return m[0];
};
const src = [
  lift(/const esc = \(s\) => [^\n]*\n/, "esc"),
  lift(/const norm = \(t\) => [^\n]*\n/, "norm"),
  lift(/const TYPE_RE = [^\n]*\nconst ASK_TOOL_RE = [^\n]*\n/, "the dialog regexes"),
  lift(/function dialogOf\(s, p, ph\) \{[\s\S]*?\nfunction picksOf[\s\S]*?\n\}\n/, "dialogOf + picksOf"),
  lift(/function dialogHtml\(d, s\) \{[\s\S]*?\n\}\n/, "dialogHtml"),
].join("");

function page(dialog: unknown) {
  const ctx: any = { D: { id: "t", dialog, drafts: new Map() } };
  vm.runInNewContext(`${src}; Object.assign(globalThis, { dialogOf, dialogHtml, picksOf, DPICK });`, ctx);
  return ctx;
}

const FRAME = [
  "←  ☒ Build  ✔ Submit  →",
  "",
  "Which should I build now while Tyler is out?",
  "",
  "  1. [✔] Large txns: better columns",
  "         Category, counterparty and wire memo on the large transactions table.",
  "  2. [ ] Cash bridge drill-down",
  "         Clicking a bridge bar lists its transactions.",
  "❯ 3. [✔] Type something",
  "     Submit",
  "────",
  "  4. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
];
const QUESTIONS = [{
  question: "Which should I build now while Tyler is out?", header: "Build", multi: true,
  options: [{ label: "Large txns: better columns", description: "Category, counterparty and wire memo." }, { label: "Cash bridge drill-down", description: "Clicking a bridge bar lists its transactions." }],
}];

test("a multi-select card: every answer ticks (starting from what its screen shows), with one Submit and a box for words", () => {
  const ctx = page(QUESTIONS);
  const s = { id: "t" };
  const d = ctx.dialogOf(s, detectPrompt(FRAME), "decide");
  assert.equal(d.multi, true);
  assert.equal(d.next, false);
  assert.deepEqual(d.choices.map((c: any) => [c.label, c.on]), [["Large txns: better columns", true], ["Cash bridge drill-down", false]]);
  const out: string = ctx.dialogHtml(d, s);
  assert.equal((out.match(/data-dtick=/g) ?? []).length, 2, "a tick per answer — never disabled");
  assert.doesNotMatch(out, /disabled/);
  assert.match(out, /data-dsubmit[^>]*>Submit \(1\)</, "Submit, with how many are ticked");
  assert.match(out, /<input data-dtext=/, "words of your own go with the ticks");
  assert.match(out, /class="fx-choice tick on"/);
  // Ticking on the card changes the card only; nothing is sent until Submit.
  ctx.picksOf(s, d).add("Cash bridge drill-down");
  assert.match(ctx.dialogHtml(d, s), /Submit \(2\)/);
});

test("before its screen is read (no menu yet), a multi-select still ticks and submits — the daemon reads the screen itself", () => {
  const ctx = page(QUESTIONS);
  const d = ctx.dialogOf({ id: "t" }, null, "decide");
  assert.equal(d.multi, true);
  const out: string = ctx.dialogHtml(d, { id: "t" });
  assert.equal((out.match(/data-dtick=/g) ?? []).length, 2);
  assert.match(out, /data-dsubmit/);
});

test("more questions behind this one: the button says Next", () => {
  const ctx = page(QUESTIONS);
  const d = ctx.dialogOf({ id: "t" }, detectPrompt(FRAME.map((l) => (l === "     Submit" ? "     Next" : l))), "decide");
  assert.equal(d.next, true);
  assert.match(ctx.dialogHtml(d, { id: "t" }), /Next question →/);
});

test("a single-select card is unchanged: one click answers, through the menu's own keys", () => {
  const ctx = page([{ question: "Which approach?", options: [{ label: "Fast" }, { label: "Safe" }] }]);
  const p = detectPrompt(["Which approach?", "", "❯ 1. Fast", "     quick", "  2. Safe", "     careful", "  3. Type something.", "────", "  4. Chat about this", "", "Enter to select · ↑/↓ to navigate · Esc to cancel"]);
  const d = ctx.dialogOf({ id: "t" }, p, "decide");
  assert.equal(d.multi, false);
  const out: string = ctx.dialogHtml(d, { id: "t" });
  assert.match(out, /data-dopt="0"/);
  assert.match(out, /data-dopt="1"/);
  assert.doesNotMatch(out, /data-dtick|data-dsubmit/);
});
