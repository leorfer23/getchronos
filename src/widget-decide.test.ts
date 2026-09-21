/**
 * The "Needs you" card: what reaches the list, in what order, and — the part that actually costs
 * something if it is wrong — the exact request each row promises will answer it.
 *
 * `decideItems` is pure over its source on purpose: `statusOf` needs a live pty to resolve anything,
 * so a test that went through `data()` could only ever see an empty desk. The wiring half is pinned
 * with regexes against the two shipped files instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import decide, { decideItems, optionKeys, termTitle, NEEDS_YOU, type DecideSource } from "./widgets/decide.js";
import type { Ask } from "./store/asks.js";
import type { TermStatus } from "./term-status.js";
import type { DeskPrompt } from "./desk-prompt.js";
import type { Session } from "./types.js";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const NOW = 1_800_000_000_000;
const min = (n: number) => NOW - n * 60_000;

const sess = (id: string, over: Partial<Session> = {}): Session =>
  ({ id, workspace_id: "ws1", goal: "ship the widget", title: null, backend: "claude-code", status: "live", ...over } as Session);

const status = (phase: TermStatus["phase"], since: number, line = "line"): TermStatus =>
  ({ phase, line, word: phase, needs_you: false, since, on: null, eta_at: null, subagents: 0, progress: null, hooked: true });

const ask = (id: string, over: Partial<Ask> = {}): Ask =>
  ({
    id, run_id: null, job_id: null, session_id: null, asked_by: "CED-3", route: "operator", triage: null,
    escalated_at: null, ticket_id: null, workspace_id: "ws1", question: "deploy to prod?", options: null,
    answer: null, answered_by: null, status: "open", created_at: new Date(min(5)).toISOString(),
    answered_at: null, hold_until: null, hold_reason: null, resurfaced_at: null, ...over,
  });

const src = (over: Partial<DecideSource> = {}): DecideSource =>
  ({ terminals: [], asks: [], now: NOW, ...over });

const term = (id: string, phase: TermStatus["phase"], since: number, prompt: DeskPrompt | null = null) =>
  ({ session: sess(id), status: status(phase, since), prompt });

// ── what reaches the list ───────────────────────────────────────────────────────────────────────

test("only the four phases that are his turn — working, waiting and stalled are not his problem", () => {
  assert.deepEqual(NEEDS_YOU, ["blocked", "decide", "review", "your_turn"]);
  const items = decideItems(src({
    terminals: [
      term("a", "working", min(50)), term("b", "waiting", min(40)), term("c", "stalled", min(30)),
      term("d", "review", min(20)), term("e", "ended", min(10)),
    ],
  }));
  assert.deepEqual(items.map((i) => i.id), ["d"]);
});

test("an ask Robert still has is his, not the operator's — one he escalated is", () => {
  const items = decideItems(src({
    asks: [
      ask("triaging", { route: "robert" }),
      ask("handed-up", { route: "robert", escalated_at: new Date(min(2)).toISOString(), triage: "I'd say no" }),
      ask("direct"),
    ],
  }));
  assert.deepEqual(items.map((i) => i.id).sort(), ["direct", "handed-up"]);
  assert.equal(items.find((i) => i.id === "handed-up")!.note, "I'd say no");
});

test("a terminal's own escalated ask is that terminal's row, not a second one asking the same thing", () => {
  const items = decideItems(src({
    terminals: [term("sess1", "decide", min(9))],
    asks: [ask("a1", { session_id: "sess1" }), ask("a2", { session_id: "other" })],
  }));
  assert.deepEqual(items.map((i) => i.id), ["sess1", "a2"]);
});

test("zero items is an empty list, never a fabricated row", () => {
  assert.deepEqual(decideItems(src()), []);
});

// ── order ───────────────────────────────────────────────────────────────────────────────────────

test("blocked, then decide, then review, then your turn — longest waiting first inside each", () => {
  const items = decideItems(src({
    terminals: [
      term("turn-old", "your_turn", min(90)), term("review", "review", min(5)),
      term("decide-new", "decide", min(2)), term("decide-old", "decide", min(30)),
      term("blocked", "blocked", min(1)),
    ],
  }));
  assert.deepEqual(items.map((i) => i.id), ["blocked", "decide-old", "decide-new", "review", "turn-old"]);
});

test("asks sit with `decide` and interleave with it by age — they are not a second list underneath", () => {
  const items = decideItems(src({
    terminals: [term("decide-old", "decide", min(40)), term("decide-new", "decide", min(3)), term("review", "review", min(99))],
    asks: [ask("ask-mid", { created_at: new Date(min(20)).toISOString() })],
  }));
  assert.deepEqual(items.map((i) => i.id), ["decide-old", "ask-mid", "decide-new", "review"]);
});

// ── the answer each row promises ────────────────────────────────────────────────────────────────

test("a select terminal answers with keystrokes relative to the cursor — the Focus view's own shape", () => {
  const prompt: DeskPrompt = {
    kind: "select", question: "which branch?",
    options: [{ label: "main", offset: 0 }, { label: "staging", offset: 1 }, { label: "cancel", offset: 2 }],
  };
  const [it] = decideItems(src({ terminals: [term("s", "decide", min(4), prompt)] }));
  assert.equal(it.answer.route, "/sessions/s/input");
  assert.equal(it.answer.field, "text");
  assert.deepEqual(it.answer.body, { enter: true, by: "operator" });
  assert.deepEqual(it.options, [
    { key: "0", label: "main", body: { keys: ["enter"], by: "operator" } },
    { key: "1", label: "staging", body: { keys: ["down", "enter"], by: "operator" } },
    { key: "2", label: "cancel", body: { keys: ["down", "down", "enter"], by: "operator" } },
  ]);
});

test("a y/n prompt is two chips of text + Enter; a free question has no chips at all", () => {
  const [yn] = decideItems(src({ terminals: [term("s", "decide", min(4), { kind: "yn", question: "overwrite? (y/n)" })] }));
  assert.deepEqual(yn.options, [
    { key: "y", label: "Yes", body: { text: "y", enter: true, by: "operator" } },
    { key: "n", label: "No", body: { text: "n", enter: true, by: "operator" } },
  ]);
  const [q] = decideItems(src({ terminals: [term("s", "decide", min(4), { kind: "question", question: "which schema?" })] }));
  assert.equal(q.options, undefined);
  const [t] = decideItems(src({ terminals: [term("s", "your_turn", min(4), { kind: "turn", question: "…" })] }));
  assert.equal(t.options, undefined);
});

test("an option further down the menu than /input takes keystrokes is dropped, not truncated", () => {
  // SessionInputSchema caps `keys` at 8 — nine downs would be a 400 the operator sees as a dead chip.
  const prompt: DeskPrompt = {
    kind: "select", question: "pick",
    options: [{ label: "near", offset: 7 }, { label: "far", offset: 8 }],
  };
  const [it] = decideItems(src({ terminals: [term("s", "decide", min(4), prompt)] }));
  assert.deepEqual(it.options!.map((o) => o.label), ["near"]);
  assert.equal(optionKeys(7).length, 8);
  assert.deepEqual(optionKeys(-1), ["up", "enter"]);
});

test("an ask answers through /asks/:id/answer, with its stored options as the chips", () => {
  const [it] = decideItems(src({ asks: [ask("a1", { options: JSON.stringify(["yes", "no"]) })] }));
  assert.equal(it.kind, "ask");
  assert.equal(it.answer.route, "/asks/a1/answer");
  assert.equal(it.answer.field, "answer");
  assert.deepEqual(it.answer.body, { by: "operator" });
  assert.deepEqual(it.options, [
    { key: "yes", label: "yes", body: { answer: "yes", by: "operator" } },
    { key: "no", label: "no", body: { answer: "no", by: "operator" } },
  ]);
  // Free-form: no chips, and the typed answer goes in `answer.field`.
  const [free] = decideItems(src({ asks: [ask("a2", { options: "not json at all" })] }));
  assert.equal(free.options, undefined);
});

test("every row carries the client colour, the age to sort by and a line that is never empty", () => {
  const [t] = decideItems(src({ terminals: [term("s", "blocked", min(12), null)] }));
  assert.equal(t.workspace_id, "ws1");
  assert.equal(t.since, min(12));
  assert.equal(t.phase, "blocked");
  assert.equal(t.title, "ship the widget");
  const [bare] = decideItems(src({
    terminals: [{ session: sess("s2", {}), status: status("review", min(1), ""), prompt: null }],
  }));
  assert.equal(bare.line, "review", "an empty one-liner falls back to the phase word");
  assert.equal(termTitle({ goal: null, title: null, backend: "claude-code" } as Session), "claude terminal");
});

// ── the contract ────────────────────────────────────────────────────────────────────────────────

test("the reader is registered under the name both files use, and wakes on the right topics", () => {
  assert.equal(decide.name, "decide");
  assert.equal(decide.title, "Needs you");
  assert.deepEqual(decide.topics, ["session.status", "ask.created", "ask.answered", "session.ended"]);
  assert.match(read("src/widgets/index.ts"), /import decide from "\.\/decide\.js";/);
  assert.match(read("static/desk-widgets/index.js"), /"decide"/);
});

test("the module agrees with its reader, renders idempotently, and animates nothing", () => {
  const js = read("static/desk-widgets/decide.js");
  assert.match(js, /name: "decide"/);
  assert.match(js, /title: "Needs you"/);
  assert.match(js, /refreshMs: 10000/);
  assert.match(js, /topics: \["session\.status", "ask\.created", "ask\.answered", "session\.ended"\]/);
  assert.match(js, /body\.replaceChildren\(\.\.\.items\.map\(\(it, i\) => row\(it, ctx, i\)\)\)/);
  assert.match(js, /"nothing needs you"/);
  // It posts the route its own reader named — it never builds one.
  assert.match(js, /ctx\.api\(it\.answer\.route, \{ method: "POST", body: JSON\.stringify\(body\) \}\)/);
  assert.doesNotMatch(js, /\/sessions\/|\/asks\//);
  assert.match(js, /ctx\.stage\(it\.id\)/);
  // Tokens only, and the page's own phase colours.
  assert.doesNotMatch(js, /#[0-9a-fA-F]{3,6}\b|rgb\(/);
  assert.doesNotMatch(js, /@keyframes|animation:|transition:/);
  assert.match(js, /import \{ el, fmtAgo, PHASE_COLOR, PHASE_SOFT \} from "\.\/lib\.js"/);
});

test("the reader reuses the daemon's own resolvers rather than re-deriving a phase or a prompt", () => {
  const ts = read("src/widgets/decide.ts");
  assert.match(ts, /import \{ sessionPrompt \} from "\.\.\/terminal\.js"/);
  assert.match(ts, /import \{ statusOf, type Phase, type TermStatus \} from "\.\.\/term-status\.js"/);
  // Read-only by contract: nothing in here answers anything.
  assert.doesNotMatch(ts, /answerAsk|sendInput|\.patch\(|\.answer\(/);
});
