/**
 * Quick actions: the chips in the stage footer that type what the operator would have typed.
 *
 * Three halves, for the three places the feature lives:
 *   · the rule (src/quick-actions.ts) — which chips a phase gets, in what order, with which ⌥ number;
 *   · the mirror (static/desk-quick-actions.js) — run in a vm, the way src/desk-companion.test.ts
 *     runs the companion's, and asserted EQUAL to the TS one. desk.html has no build step and the
 *     daemon needs the same defaults, so the list exists twice; this is what notices when the two
 *     drift apart;
 *   · the wiring (static/desk.html, src/api.ts) — read as text, because nothing else would notice a
 *     regression in a page with no build step.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {
  DEFAULT_QUICK_ACTIONS, MAX_LABEL, MAX_QUICK_ACTIONS, MAX_TEXT, MAX_VISIBLE, QA_KINDS, QA_PHASES,
  QUICK_ACTIONS_KV, defaultQuickActions, visibleActions, type QuickAction,
} from "./quick-actions.js";
import { QuickActionsSchema } from "./validation.js";

const ctx: any = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), "static/desk-quick-actions.js"), "utf8"), ctx);
const MIRROR = ctx.window.QuickActions;
// Values cross a vm realm boundary, so their prototypes are not this realm's: round-trip through
// JSON before comparing, the way src/desk-companion.test.ts does.
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
const css = html.slice(0, html.indexOf("</style>"));
const phone = fs.readFileSync(path.join(process.cwd(), "static/phone.html"), "utf8");
const api = fs.readFileSync(path.join(process.cwd(), "src/api.ts"), "utf8");

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

// ── the route ────────────────────────────────────────────────────────────────────────────────
test("the route is admin-only, schema-checked, and stored whole under one kv key", () => {
  assert.match(api, /api\.get\("\/desk\/quick-actions", requireAdmin,/);
  assert.match(api, /api\.put\("\/desk\/quick-actions", requireAdmin, validate\(QuickActionsSchema\)/);
  assert.match(api, /kv\.set\(QUICK_ACTIONS_KV, JSON\.stringify\(req\.body\.actions\)\)/);
  assert.equal(QUICK_ACTIONS_KV, "desk.quick_actions");
  // An unreadable or outdated value must give the operator the defaults, not an empty footer.
  assert.match(api, /function readQuickActions\(\): QuickAction\[\] \{/);
  assert.match(api, /if \(!raw\) return defaultQuickActions\(\);/);
  assert.match(api, /parsed\.success \? parsed\.data\.actions : defaultQuickActions\(\)/);
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

// ── the footer ───────────────────────────────────────────────────────────────────────────────
test("the chips sit on the left of #sbar and go through the composer's own door", () => {
  assert.match(html, /<script src="\/desk-quick-actions\.js"><\/script>/);
  // Left of the bar, before the spacer that pushes Close/Next right.
  assert.match(html, /if \(!ask\) bar\.push\(\.\.\.qaChips\(\)\);/);
  assert.match(html, /const ask = compAskOwns\(s\) \? null : askOf\(s\);\n\s+const last = qaLastLine\(s\);/);
  assert.match(html, /if \(!ask\) bar\.push\(\.\.\.qaChips\(\)\);\n\s+if \(ask\) \{/);
  assert.match(html, /bar\.push\(`<span class="sp"><\/span>`\);/);
  // The same route and body as the composer — nothing here is a second way to talk to an agent.
  assert.match(html, /answer\(s\.id, \{ text: a\.text, enter: true \}\);/);
  assert.match(html, /answer\(s\.id, optionBody\(p\.options\[0\]\)\); return back\(\);/);
  assert.match(html, /if \(p\.kind === "yn"\) \{ answer\(s\.id, \{ text: "y", enter: true \}\); return back\(\); \}/);
  // Hover/title is the exact text.
  assert.match(html, /: QA_TIP\[a\.kind\] \|\| a\.text \|\| a\.label;/);
  assert.match(html, /title="\$\{esc\(tip\(a\)\)\}/);
  // A chip never takes the keyboard off the pane.
  assert.match(html, /qs\("#sbar"\)\.addEventListener\("mousedown", \(e\) => \{ if \(e\.target\.closest\("button\.qa"\)\) e\.preventDefault\(\); \}\);/);
  assert.match(html, /const back = \(\) => compFocusBack\(\);/);
});

test("the chips follow the phase, and step aside for a question the bar is already showing", () => {
  assert.match(html, /return QuickActions\.visible\(QA\.list, phaseOf\(s\), !!\(p && p\.kind !== "turn"\)\);/);
  assert.match(html, /if \(!compAskOwns\(s\) && askOf\(s\)\) return null;/);
  assert.match(html, /if \(!s \|\| !s\.live \|\| S\.mode === "fleet"\) return null;/);
  // An empty list still gets the ⚙ — deleting every action must not be a one-way door.
  assert.match(html, /const acts = qaVisible\(\);\n\s+if \(!acts\) return \[\];/);
  // Recomputed per render and per chord, never cached — a phase change must not leave ⌥2 stale.
  assert.match(html, /function qaFire\(i\) \{\n\s+const s = S\.active && byId\(S\.active\); if \(!s \|\| !s\.live\) return;\n\s+const a = \(qaVisible\(\) \|\| \[\]\)\[i\];/);
});

test("⌥1…⌥9 fire the chips, read from e.code, and the pty never sees the chord", () => {
  assert.match(html, /const qaKey = \(e\) => \{ const m = \/\^Digit\(\[1-9\]\)\$\/\.exec\(e\.code \|\| ""\); return m && e\.altKey && !e\.metaKey && !e\.ctrlKey && !e\.shiftKey \? Number\(m\[1\]\) : null; \};/);
  assert.match(html, /compKey\(e\) \|\| railKey\(e\) \|\| qaKey\(e\) !== null \|\|/);
  assert.match(html, /if \(qk !== null\) \{ if \(qs\("dialog\[open\]"\)\) return; e\.preventDefault\(\); return qaFire\(\(qaVisible\(\) \|\| \[\]\)\.findIndex\(\(a\) => a\.n === qk\)\); \}/);
  // Read before the blanket "any modifier is not ours" bail, or it would never run.
  const chord = html.indexOf("const qk = qaKey(e);");
  const bail = html.indexOf("if (e.metaKey || e.ctrlKey || e.altKey) return;");
  assert.ok(chord > 0 && bail > chord, "the ⌥ chord must be read before the modifier bail");
  // The number hint on the chip.
  assert.match(html, /\$\{a\.n \? `<kbd>\$\{a\.n\}<\/kbd>` : ""\}/);
  assert.match(css, /\.sbar button\.qa kbd \{[^}]*font-variant-numeric:tabular-nums;/);
});

test("the last command is said once: the muted line yields to the companion's ticker", () => {
  assert.match(html, /function qaLastLine\(s\) \{\n\s+if \(C\.on && S\.mode === "term"\) return null;/);
  assert.match(html, /TermCompanion\.lastCommand\(F\.events\)/);
  // …and the ticker is exactly what shows in that mode.
  assert.match(css, /body\.mode-term\.comp-on \.ticker:not\(\[hidden\]\) \{ display:flex; \}/);
  // Its own row, above the chips.
  assert.match(css, /\.sbar \.qa-last \{ flex:0 0 100%;/);
  assert.match(html, /if \(last\) bar\.push\(`<span class="qa-last" title="\$\{esc\(last\.title\)\}">\$\{last\.html\}<\/span>`\);/);
});

test("the dialog is a plain <dialog> of rows, and Close is a real cancel", () => {
  assert.match(html, /<dialog id="dlg-quick">/);
  assert.match(html, /<div class="qa-rows" id="qa-rows"><\/div>/);
  for (const id of ["qa-add", "qa-reset", "qa-cancel", "qa-save"]) assert.match(html, new RegExp(`id="${id}"`), id);
  // Edits are held in QD.list and only QA.list is replaced on a successful save.
  assert.match(html, /QD\.list = QA\.list\.map\(\(a\) => \(\{ \.\.\.a, phases: \[\.\.\.\(a\.phases \|\| \[\]\)\] \}\)\);/);
  assert.match(html, /qs\("#qa-reset"\)\.onclick = \(\) => \{ QD\.list = QuickActions\.defaults\(\); qaRender\(\); \};/);
  assert.match(html, /api\("\/desk\/quick-actions", \{ method: "PUT", body: JSON\.stringify\(\{ actions \}\) \}\)/);
  // A row: label · text · phases · key · reorder · delete.
  assert.match(html, /<input class="label" maxlength="\$\{QuickActions\.MAX_LABEL\}"/);
  assert.match(html, /<input class="text" maxlength="\$\{QuickActions\.MAX_TEXT\}"/);
  assert.match(html, /QuickActions\.PHASES\.map\(\(ph\) =>/);
  assert.match(html, /data-m="up"[\s\S]{0,200}data-m="down"[\s\S]{0,200}data-m="del"/);
  assert.match(html, /<button type="button" class="qa gear" data-qa-cfg/);
  assert.match(html, /if \(e\.target\.closest\("\[data-qa-cfg\]"\)\) return qaOpen\(\);/);
  // Tokens only, no animation of its own.
  assert.match(css, /#dlg-quick \{ width:min\(620px,94vw\); \}/);
  assert.doesNotMatch(css.slice(css.indexOf("#dlg-quick {"), css.indexOf(".qa-row .phs input")), /animation|transition/);
  assert.doesNotMatch(css.slice(css.indexOf(".sbar .qa-last"), css.indexOf(".sbar button.qa.gear")), /animation|transition/);
});

test("the phone shows the same chips through the same endpoint, keys only", () => {
  assert.match(phone, /<script src="\/desk-quick-actions\.js"><\/script>/);
  assert.match(phone, /api\("\/desk\/quick-actions"\)/);
  assert.match(phone, /QuickActions\.visible\(PQA\.list, phaseOf\(s\), false\)\.filter\(\(a\) => a\.kind === "text" \|\| a\.kind === "approve"\)/);
  // It rides the key strip's own data-text road, which is the same POST the composer makes.
  assert.match(phone, /class="qk qa" data-text="\$\{esc\(a\.text\)\}"/);
  assert.match(phone, /if \(b\.dataset\.text\) return input\(S\.current, \{ text: b\.dataset\.text, enter: true \}\);/);
});
