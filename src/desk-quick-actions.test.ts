/**
 * Quick actions: the chips in the stage footer that type what the operator would have typed.
 *
 * Two halves:
 *   · the rule (src/quick-actions.ts) — which chips a phase gets, in what order, with which ⌥ number;
 *   · the mirror (static/desk-quick-actions.js) — run in a vm, the way src/desk-companion.test.ts
 *     runs the companion's, and asserted EQUAL to the TS one. desk.html has no build step and the
 *     daemon needs the same defaults, so the list exists twice; this is what notices when the two
 *     drift apart. The route's admin gate is route-guards.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {
  DEFAULT_QUICK_ACTIONS, MAX_LABEL, MAX_QUICK_ACTIONS, MAX_TEXT, MAX_VISIBLE, QA_KINDS, QA_PHASES,
  defaultQuickActions, visibleActions, type QuickAction,
} from "./quick-actions.js";
import { QuickActionsSchema } from "./validation.js";

const ctx: any = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), "static/desk-quick-actions.js"), "utf8"), ctx);
const MIRROR = ctx.window.QuickActions;
// Values cross a vm realm boundary, so their prototypes are not this realm's: round-trip through
// JSON before comparing, the way src/desk-companion.test.ts does.
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

const labels = (acts: { label: string }[]) => acts.map((a) => a.label);

// ── the defaults ─────────────────────────────────────────────────────────────────────────────
test("the shipped set covers every phase the operator has a move for, and nothing else", () => {
  const d = defaultQuickActions();
  assert.ok(d.length <= MAX_QUICK_ACTIONS);
  for (const a of d) {
    assert.ok(a.label.length > 0 && a.label.length <= MAX_LABEL, `label out of range: ${a.label}`);
    assert.ok(a.text.length <= MAX_TEXT);
    assert.ok(QA_KINDS.includes(a.kind), `unknown kind: ${a.kind}`);
    assert.ok(a.phases.length > 0, `${a.label} shows nowhere`);
    for (const p of a.phases) assert.ok(QA_PHASES.includes(p), `unknown phase: ${p}`);
    assert.ok(a.key === null || (Number.isInteger(a.key) && a.key >= 1 && a.key <= 9));
    // Only the kinds that act rather than type may carry no text.
    if (!a.text) assert.ok(a.kind === "changes" || a.kind === "kill", `${a.label} types nothing`);
  }
  assert.deepEqual(labels(visibleActions(d, "review")), ["✓ Approve", "🔀 Merge", "🔍 QA pass", "✎ Changes", "▶ Continue", "🤖 Ask Robert"]);
  // Every shipped chip is numbered by where it sits, so ⌥N is the Nth chip on the row.
  for (const ph of ["review", "decide", "working", "blocked"])
    assert.deepEqual(visibleActions(d, ph).map((a) => a.n), visibleActions(d, ph).map((_, i) => i + 1), ph);
  assert.deepEqual(labels(visibleActions(d, "working")), ["❓ Status", "⏸ Pause", "📝 Summary", "▶ Continue", "🤖 Ask Robert"]);
  assert.deepEqual(labels(visibleActions(d, "waiting")), labels(visibleActions(d, "working")));
  assert.deepEqual(labels(visibleActions(d, "blocked")), ["↻ Retry", "🤖 Ask Robert", "⏹ Kill", "▶ Continue"]);
  assert.deepEqual(labels(visibleActions(d, "stalled")), labels(visibleActions(d, "blocked")));
  assert.equal(visibleActions(d, "ended").length, 0, "an ended terminal is offered ↻ Reopen, nothing else");
  assert.equal(defaultQuickActions()[0].phases !== DEFAULT_QUICK_ACTIONS[0].phases, true, "a copy, not the shipped array");
});

test("an always chip does not double up with the phase chip that says the same thing", () => {
  const d = defaultQuickActions();
  // decide/your_turn ship their own ▶ Continue; the "always" one must not sit beside it.
  const decide = labels(visibleActions(d, "decide"));
  assert.deepEqual(decide, ["✓ Approve", "▶ Continue", "🎲 Your call", "🤖 Ask Robert"]);
  assert.equal(decide.filter((l) => l === "▶ Continue").length, 1);
  // your_turn is the same minus ✓ Approve — there is no prompt to approve at a finished turn.
  assert.deepEqual(labels(visibleActions(d, "your_turn")), ["▶ Continue", "🎲 Your call", "🤖 Ask Robert"]);
  // blocked ships its own 🤖 Ask Robert, likewise.
  assert.equal(labels(visibleActions(d, "blocked")).filter((l) => l === "🤖 Ask Robert").length, 1);
});

// ── filtering and numbering ──────────────────────────────────────────────────────────────────
const act = (o: Partial<QuickAction>): QuickAction =>
  ({ label: "x", text: "t", kind: "text", phases: ["always"], key: null, ...o }) as QuickAction;

test("a chip shows in its own phases plus always, and the row stops at eight", () => {
  const list = [
    act({ label: "only-review", phases: ["review"] }),
    act({ label: "two", phases: ["working", "waiting"] }),
    act({ label: "every", phases: ["always"] }),
  ];
  assert.deepEqual(labels(visibleActions(list, "review")), ["only-review", "every"]);
  assert.deepEqual(labels(visibleActions(list, "working")), ["two", "every"]);
  assert.deepEqual(labels(visibleActions(list, "waiting")), ["two", "every"]);
  assert.deepEqual(labels(visibleActions(list, "blocked")), ["every"]);

  const many = Array.from({ length: 20 }, (_, i) => act({ label: "a" + i }));
  assert.equal(visibleActions(many, "working").length, MAX_VISIBLE);
});

test("a pinned ⌥ number is kept; the rest take the gaps, and past nine there is no chord", () => {
  const list = [
    act({ label: "pinned3", key: 3 }),
    act({ label: "free-a" }),
    act({ label: "free-b" }),
    act({ label: "also3", key: 3 }),
  ];
  assert.deepEqual(visibleActions(list, "working").map((a) => [a.label, a.n]), [
    ["pinned3", 3], ["free-a", 1], ["free-b", 2], ["also3", 4],
  ]);
  const ten = Array.from({ length: 10 }, (_, i) => act({ label: "a" + i }));
  const shown = visibleActions(ten, "working");
  assert.equal(shown.length, MAX_VISIBLE);
  assert.deepEqual(shown.map((a) => a.n), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("smart approve is the approve chip and only while a prompt is open", () => {
  const d = defaultQuickActions();
  const dry = visibleActions(d, "review", false);
  const live = visibleActions(d, "review", true);
  assert.equal(dry.every((a) => !a.smart), true, "nothing is smart without a parsed prompt");
  assert.deepEqual(live.filter((a) => a.smart).map((a) => a.label), ["✓ Approve"]);
  assert.equal(live.find((a) => a.label === "✓ Approve")?.kind, "approve");
  // It has to be reachable where prompts actually happen: a "decide" terminal is one sitting on a
  // parsed question, and in Terminal mode the companion owns that question so the chips still show.
  assert.deepEqual(visibleActions(d, "decide", true).filter((a) => a.smart).map((a) => a.label), ["✓ Approve"]);
  // hasPrompt changes what the chip DOES, never which chips there are.
  assert.deepEqual(labels(dry), labels(live));
});

test("a broken row is skipped rather than allowed to break the row", () => {
  const list = [
    { label: "", text: "t", kind: "text", phases: ["always"], key: null },
    { label: "no phases", text: "t", kind: "text", phases: undefined },
    { label: "ok", text: "t", kind: "text", phases: ["always"], key: null },
  ] as unknown as QuickAction[];
  assert.deepEqual(labels(visibleActions(list, "working")), ["ok"]);
  assert.deepEqual(visibleActions([], "working"), []);
  assert.deepEqual(visibleActions(defaultQuickActions(), ""), []);
});

// ── the page reads the same rule the daemon does ─────────────────────────────────────────────
test("static/desk-quick-actions.js is the same list and the same rule as src/quick-actions.ts", () => {
  assert.deepEqual(plain(MIRROR.DEFAULTS), plain(DEFAULT_QUICK_ACTIONS));
  assert.deepEqual(plain(MIRROR.defaults()), plain(defaultQuickActions()));
  assert.deepEqual(plain(MIRROR.PHASES), plain(QA_PHASES));
  assert.deepEqual(plain(MIRROR.KINDS), plain(QA_KINDS));
  assert.equal(MIRROR.MAX_VISIBLE, MAX_VISIBLE);
  assert.equal(MIRROR.MAX_ACTIONS, MAX_QUICK_ACTIONS);
  assert.equal(MIRROR.MAX_LABEL, MAX_LABEL);
  assert.equal(MIRROR.MAX_TEXT, MAX_TEXT);

  const lists: QuickAction[][] = [
    defaultQuickActions(),
    [],
    [act({ label: "pinned3", key: 3 }), act({ label: "free" }), act({ label: "Pinned3", key: 9 })],
    Array.from({ length: 12 }, (_, i) => act({ label: "a" + i, key: i === 4 ? 2 : null })),
  ];
  for (const list of lists)
    for (const phase of [...QA_PHASES, "ended", ""])
      for (const hasPrompt of [false, true])
        assert.deepEqual(
          plain(MIRROR.visible(list, phase, hasPrompt)),
          plain(visibleActions(list, phase, hasPrompt)),
          `mirror drifted: ${phase} / prompt=${hasPrompt}`,
        );
});

test("the schema refuses what would break the footer", () => {
  const ok = QuickActionsSchema.safeParse({ actions: defaultQuickActions() });
  assert.equal(ok.success, true, ok.success ? "" : JSON.stringify(ok.error.issues));

  const bad = (a: unknown) => QuickActionsSchema.safeParse({ actions: [a] }).success;
  assert.equal(bad({ label: "x".repeat(MAX_LABEL + 1), text: "t", kind: "text", phases: [], key: null }), false, "label cap");
  assert.equal(bad({ label: "x", text: "t".repeat(MAX_TEXT + 1), kind: "text", phases: [], key: null }), false, "text cap");
  assert.equal(bad({ label: "x", text: "t", kind: "nope", phases: [], key: null }), false, "unknown kind");
  assert.equal(bad({ label: "x", text: "t", kind: "text", phases: ["ended"], key: null }), false, "ended is not a phase a chip can pick");
  assert.equal(bad({ label: "x", text: "t", kind: "text", phases: [], key: 0 }), false, "key below 1");
  assert.equal(bad({ label: "x", text: "t", kind: "text", phases: [], key: 10 }), false, "key above 9");
  assert.equal(bad({ label: "  ", text: "t", kind: "text", phases: [], key: null }), false, "a blank label is not a chip");
  assert.equal(
    QuickActionsSchema.safeParse({ actions: Array.from({ length: MAX_QUICK_ACTIONS + 1 }, () => ({ label: "x" })) }).success,
    false, "at most " + MAX_QUICK_ACTIONS,
  );
  // Defaults fill in, so a minimal row is a valid row.
  const min = QuickActionsSchema.safeParse({ actions: [{ label: "x" }] });
  assert.equal(min.success, true);
  assert.deepEqual(min.success ? min.data.actions[0] : null, { label: "x", text: "", kind: "text", phases: [], key: null });
});
