import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { answerDialog, setDialogDeps } from "./dialog-answer.js";

/**
 * A stand-in for Claude Code's AskUserQuestion dialog, keyed the way 2.1.329 behaved in a live TUI
 * (2026-11-20; src/dialog-answer.ts has the list): Enter toggles a box and the cursor stays; ↓ from the
 * last box lands on Submit/Next; typing on the free-text row ticks it and the words become its label;
 * text anywhere else is dropped; Submit opens "Review your answers"; Next shows the next question.
 */
type Q = { question: string; multi: boolean; options: string[]; checked?: boolean[]; own?: string; ownOn?: boolean };
function dialog(qs: Q[], opts: { deaf?: boolean } = {}) {
  const st = { q: 0, cursor: 0, review: false, done: false as false | true, answers: [] as string[][], keys: [] as string[], typed: [] as string[] };
  for (const q of qs) { q.checked ??= q.options.map(() => false); q.own ??= ""; q.ownOn ??= false; }
  const cur = () => qs[st.q];
  // Rows a multi-select's cursor walks: its boxes, its free-text box, Submit/Next, Chat about this.
  const rows = (q: Q) => (q.multi ? q.options.length + 3 : q.options.length + 2);
  const answer = (q: Q) => (q.multi ? [...q.options.filter((_, i) => q.checked![i]), ...(q.ownOn && q.own ? [q.own] : [])] : []);
  const advance = (ans: string[]) => {
    st.answers[st.q] = ans;
    if (st.q < qs.length - 1) { st.q++; st.cursor = 0; }
    else if (qs.length > 1 || cur().multi) { st.review = true; st.cursor = 0; }
    else st.done = true;
  };
  const press = (k: string) => {
    st.keys.push(k);
    if (st.done) return;
    if (st.review) {
      if (k === "down") st.cursor = 1; else if (k === "up") st.cursor = 0;
      else if (k === "enter" && st.cursor === 0) st.done = true;
      return;
    }
    const q = cur(), n = rows(q);
    if (k === "down") st.cursor = Math.min(n - 1, st.cursor + 1);
    else if (k === "up") st.cursor = Math.max(0, st.cursor - 1);
    else if (k === "backspace") { if (st.cursor === q.options.length) q.own = q.own!.slice(0, -1); }
    else if (k === "enter") {
      if (opts.deaf) return;
      if (q.multi) {
        if (st.cursor < q.options.length) q.checked![st.cursor] = !q.checked![st.cursor];
        else if (st.cursor === q.options.length) q.ownOn = !q.ownOn;
        else if (st.cursor === q.options.length + 1) advance(answer(q));
      } else if (st.cursor < q.options.length) advance([q.options[st.cursor]]);
      else if (st.cursor === q.options.length && q.own) advance([q.own]);
    }
  };
  const frame = (): string[] => {
    if (st.done) return ["⏺ Thanks.", "", "❯ ", "  ? for shortcuts"];
    const mark = (i: number) => (st.cursor === i ? "❯" : " ");
    if (st.review) return ["Review your answers", "", ...qs.map((q, i) => ` ● ${q.question}\n   → ${(st.answers[i] ?? []).join(", ")}`).join("\n").split("\n"), "", `${mark(0)} 1. Submit answers`, `${mark(1)} 2. Cancel`];
    const q = cur(), out = ["────", "←  ☐ A  ✔ Submit  →", "", q.question, ""];
    q.options.forEach((o, i) => { out.push(`${mark(i)} ${i + 1}. ${q.multi ? `[${q.checked![i] ? "✔" : " "}] ` : ""}${o}`, `         about ${o}.`); });
    const k = q.options.length;
    if (q.multi) {
      out.push(`${mark(k)} ${k + 1}. [${q.ownOn ? "✔" : " "}] ${q.own || "Type something"}`);
      out.push(`${mark(k + 1)}    ${st.q < qs.length - 1 ? "Next" : "Submit"}`, "────", `${mark(k + 2)} ${k + 2}. Chat about this`);
    } else out.push(`${mark(k)} ${k + 1}. ${q.own || "Type something."}`, "────", `${mark(k + 1)} ${k + 2}. Chat about this`);
    out.push("", "Enter to select · ↑/↓ to navigate · Esc to cancel");
    return out;
  };
  const type = (text: string) => {
    st.typed.push(text);
    const q = cur();
    if (st.cursor === q.options.length && !st.review) { q.own += text; if (q.multi) q.ownOn = true; }
  };
  setDialogDeps({
    frame: async () => frame(),
    keys: async (_id, ks) => { for (const k of ks) press(k); },
    type: (_id, text) => type(text),
    sleep: async () => {},
  });
  return st;
}
afterEach(() => setDialogDeps(null));

test("a multi-select: ticks exactly what was picked (unticking what was not), then Submit and its review", async () => {
  const st = dialog([{ question: "Which should I build?", multi: true, options: ["Alpha", "Bravo", "Charlie", "Delta"], checked: [true, false, false, false] }]);
  const r = await answerDialog("t", { picks: ["Bravo", "Delta"] });
  assert.deepEqual(r, { ok: true, submitted: true, next: false, picked: ["Bravo", "Delta"], text: null });
  assert.equal(st.done, true);
  assert.deepEqual(st.answers[0], ["Bravo", "Delta"]);
});

test("its own words go on the free-text row (which ticks it) and go with the ticks", async () => {
  const st = dialog([{ question: "Which colors?", multi: true, options: ["Red", "Green", "Blue"] }]);
  const r = await answerDialog("t", { picks: ["Red"], text: "only the warm one" });
  assert.equal(r.ok, true);
  assert.deepEqual(st.answers[0], ["Red", "only the warm one"]);
  // Words alone are an answer too.
  const st2 = dialog([{ question: "Which colors?", multi: true, options: ["Red", "Green"] }]);
  assert.equal((await answerDialog("t", { text: "neither" })).ok, true);
  assert.deepEqual(st2.answers[0], ["neither"]);
});

test("a stray tick on the empty free-text row (an Enter typed from the composer) is cleared, not sent as 'Type something'", async () => {
  const st = dialog([{ question: "Which?", multi: true, options: ["Large txns", "Drill-down"], checked: [true, false], ownOn: true }]);
  const r = await answerDialog("t", { picks: ["Large txns"] });
  assert.equal(r.ok, true);
  assert.deepEqual(st.answers[0], ["Large txns"]);
});

test("old words on the free-text row are replaced, not appended to", async () => {
  const st = dialog([{ question: "Which?", multi: true, options: ["A", "B"], own: "first try", ownOn: true }]);
  assert.equal((await answerDialog("t", { text: "second thought" })).ok, true);
  assert.deepEqual(st.answers[0], ["second thought"]);
});

test("not the last question: Next, and the next question is left for the card", async () => {
  const st = dialog([
    { question: "Toppings?", multi: true, options: ["Cheese", "Ham", "Olives"] },
    { question: "Size?", multi: false, options: ["Small", "Large"] },
  ]);
  const r = await answerDialog("t", { picks: ["Ham"] });
  assert.deepEqual(r, { ok: true, submitted: false, next: true, picked: ["Ham"], text: null });
  assert.equal(st.q, 1);
  assert.equal(st.done, false);
  // The last one, a single-select: one pick, then its review screen is confirmed.
  const r2 = await answerDialog("t", { picks: ["Large"] });
  assert.equal(r2.ok && r2.submitted, true);
  assert.equal(st.done, true);
  assert.deepEqual(st.answers, [["Ham"], ["Large"]]);
});

test("a single-select answered in words: onto 'Type something', the words, Enter", async () => {
  const st = dialog([{ question: "Which approach?", multi: false, options: ["Fast", "Safe"] }]);
  const r = await answerDialog("t", { text: "do it safely but today" });
  assert.equal(r.ok, true);
  assert.equal(st.done, true);
  assert.deepEqual(st.answers[0], ["do it safely but today"]);
  assert.equal((await answerDialog("t", { picks: ["Fast"] })).ok, false, "nothing on its screen any more");
});

test("refusals: a pick it does not offer, two picks for one answer, nothing at all — and no key is sent", async () => {
  const st = dialog([{ question: "Which?", multi: true, options: ["A", "B"] }]);
  assert.deepEqual(await answerDialog("t", { picks: ["Z"] }), { ok: false, error: "“Z” is not one of its answers" });
  assert.deepEqual(await answerDialog("t", {}), { ok: false, error: "pick an answer, or write your own" });
  assert.deepEqual(st.keys, []);
  const st2 = dialog([{ question: "One?", multi: false, options: ["A", "B"] }]);
  assert.equal((await answerDialog("t", { picks: ["A", "B"] })).ok, false);
  assert.deepEqual(st2.keys, []);
});

test("a tick that never shows on its screen stops the walk there and says so — it never submits blind", async () => {
  const st = dialog([{ question: "Which?", multi: true, options: ["A", "B"] }], { deaf: true });
  const r = await answerDialog("t", { picks: ["B"] });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /could not tick “B” — open the terminal/);
  assert.equal(st.done, false);
  assert.equal(st.review, false);
});
