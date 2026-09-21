/**
 * Robert on 🟠: which waiting prompts wake him, which never should, and the two deadlines that stop
 * a blocked terminal from waiting on him forever.
 *
 * The wake queue's asker/poster/notifier are stubbed the way src/wake-queue.test.ts stubs them — an
 * unstubbed drain would spawn a real CLI (CLAUDE.md gotcha 2).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { db, robertWakes, sessions, workspaces } from "./store.js";
import { setWakeAsker, setWakeNotifier, setWakePoster, dueRows, WAKE_ATTEMPT_CAP } from "./wake-queue.js";
import type { DeskPrompt } from "./desk-prompt.js";
import {
  keysForOption,
  noteInput,
  onPromptWaiting,
  OPERATOR_TYPING_MS,
  PROMPT_HANDLED_MS,
  promptHash,
  promptSay,
  promptWakeKey,
  resetTerminalPromptState,
  setPromptNotifier,
  setPromptProbe,
  sweepTerminalPrompts,
} from "./terminal-prompts.js";
import { CONFIG } from "./config.js";

setWakeAsker(async () => "noted");
setWakePoster(() => {});
setWakeNotifier(async () => {});

const NOW = Date.parse("2026-09-12T12:00:00.000Z");

let cards: string[] = [];
setPromptNotifier(async (text) => { cards.push(text); });

/** What the daemon "sees" on each terminal this test. Stands in for the live pty. */
let screens = new Map<string, { live: boolean; prompt: DeskPrompt | null }>();
setPromptProbe((id) => screens.get(id) ?? { live: false, prompt: null });

const select = (over: Partial<DeskPrompt> = {}): DeskPrompt => ({
  kind: "select",
  question: "Extract a helper or inline it?",
  options: [
    { label: "Inline it here", offset: -1 },
    { label: "Extract a helper", offset: 0 },
    { label: "Ask me later", offset: 1 },
  ],
  ...over,
});

function reset() {
  db.prepare("DELETE FROM robert_wakes").run();
  db.prepare("DELETE FROM kv").run();
  db.prepare("DELETE FROM sessions").run();
  db.prepare("DELETE FROM workspaces").run();
  resetTerminalPromptState();
  cards = [];
  screens = new Map();
}

const ws = (slug = "acme") => workspaces.create({ slug, name: slug, config_dir: "/tmp/" + slug }).id;

function term(over: Record<string, unknown> = {}) {
  return sessions.create({ workspace_id: ws(), goal: "fix the login redirect", cwd: "/tmp", ...over } as any);
}

const allRows = () => db.prepare("SELECT * FROM robert_wakes ORDER BY generation").all() as any[];

test("a waiting select/yn/question wakes him; a finished turn never does", () => {
  for (const p of [select(), { kind: "yn", question: "Overwrite the file? (y/n)" } as DeskPrompt, { kind: "question", question: "Which branch?" } as DeskPrompt]) {
    reset();
    const s = term();
    assert.ok(onPromptWaiting(s.id, p, NOW), `${p.kind} should wake him`);
    const [row] = allRows();
    assert.equal(row.key, promptWakeKey(s.id, p));
    assert.equal(row.subject, `session:${s.id}`);
    assert.equal(row.workspace_id, s.workspace_id);
    const payload = JSON.parse(row.payload);
    assert.equal(payload.session_id, s.id);
    assert.equal(payload.prompt.kind, p.kind);
    // The `say` has to stand on its own: which terminal, the question, and where to look.
    assert.match(payload.say, /fix the login redirect/);
    assert.match(payload.say, new RegExp(s.id.slice(0, 8)));
    assert.match(payload.say, /ANSWERING A TERMINAL'S PROMPT/);
  }
  reset();
  const s = term();
  assert.equal(onPromptWaiting(s.id, { kind: "turn", question: "done, PR is up" }, NOW), null);
  assert.equal(onPromptWaiting(s.id, null, NOW), null);
  assert.equal(allRows().length, 0);
});

test("the say names every option and marks the one the cursor is on", () => {
  reset();
  const s = term();
  const say = promptSay(s, select());
  assert.match(say, /1\. Inline it here/);
  assert.match(say, /2\. Extract a helper.*cursor/);
  assert.match(say, /3\. Ask me later/);
  // The keys he answers with are the Desk's own tap: relative to the cursor, not absolute.
  assert.deepEqual(keysForOption(select().options![0]), ["up", "enter"]);
  assert.deepEqual(keysForOption(select().options![1]), ["enter"]);
  assert.deepEqual(keysForOption(select().options![2]), ["down", "enter"]);
});

test("the same question on the same terminal queues once, and stays quiet for 10m after it is handled", async () => {
  reset();
  const s = term();
  const p = select();
  onPromptWaiting(s.id, p, NOW);
  assert.equal(onPromptWaiting(s.id, p, NOW + 1_000), null, "already tracked");
  assert.equal(allRows().length, 1);

  // The operator answered it: the screen has moved on, so the sweep settles the tracked prompt.
  screens.set(s.id, { live: true, prompt: { kind: "turn", question: "ok" } });
  await sweepTerminalPrompts(NOW + 2_000);
  assert.equal(onPromptWaiting(s.id, p, NOW + 3_000), null, "same question inside the handled window");
  assert.equal(allRows().length, 1);
  // Past the window it is news again — a CLI that re-asks 20 minutes later is genuinely stuck. The
  // row Robert has not been presented yet absorbs it (the queue's own key dedupe), so it costs one
  // turn either way; what matters is that it is no longer suppressed.
  assert.ok(onPromptWaiting(s.id, p, NOW + 2_000 + PROMPT_HANDLED_MS));
  assert.equal(allRows().length, 1);
  assert.equal(allRows()[0].hits, 2);
});

test("a DIFFERENT question on the same terminal is new news, even inside the handled window", async () => {
  reset();
  const s = term();
  onPromptWaiting(s.id, select(), NOW);
  screens.set(s.id, { live: true, prompt: { kind: "turn", question: "ok" } });
  await sweepTerminalPrompts(NOW + 1_000);
  assert.ok(onPromptWaiting(s.id, select({ question: "Run the migration now?" }), NOW + 2_000));
  assert.equal(allRows().length, 2);
  assert.notEqual(allRows()[0].key, allRows()[1].key);
});

test("a terminal the operator just typed into is his — no wake", () => {
  reset();
  const s = term();
  noteInput(s.id, "operator", NOW);
  assert.equal(onPromptWaiting(s.id, select(), NOW + 30_000), null);
  assert.equal(allRows().length, 0);
  // A minute later it is fair game again: he typed and walked away.
  assert.ok(onPromptWaiting(s.id, select(), NOW + OPERATOR_TYPING_MS + 1));
});

test("a goal-less or client-less terminal is the operator's scratch window, not fleet work", () => {
  reset();
  const noGoal = sessions.create({ workspace_id: ws("beta"), cwd: "/tmp" } as any);
  assert.equal(onPromptWaiting(noGoal.id, select(), NOW), null);
  const noWs = sessions.create({ goal: "poke at something", cwd: "/tmp" } as any);
  assert.equal(onPromptWaiting(noWs.id, select(), NOW), null);
  assert.equal(onPromptWaiting("nope-not-a-session", select(), NOW), null);
  assert.equal(allRows().length, 0);
});

test("the 15-minute per-subject window never swallows a second prompt on the same terminal", () => {
  reset();
  const s = term();
  const a = select();
  const b = select({ question: "Delete the old migration?" });
  onPromptWaiting(s.id, a, NOW);
  const [first] = robertWakes.unacked();
  robertWakes.claim([first.id]);
  robertWakes.ackIds([first.id], WAKE_ATTEMPT_CAP); // he handled the first question just now
  onPromptWaiting(s.id, b, NOW + 1_000);
  const queued = robertWakes.unacked();
  assert.equal(queued.length, 1);
  // A ticket subject would be suppressed here (see wake-queue.test.ts); a blocked terminal must not be.
  assert.equal(dueRows(queued, Date.now()).length, 1);
});

test("an answer that didn't land re-wakes him ONCE, then the prompt becomes the operator's card", async () => {
  reset();
  const s = term();
  const p = select();
  onPromptWaiting(s.id, p, NOW);
  screens.set(s.id, { live: true, prompt: p }); // still sitting on the same question
  const confirmMs = CONFIG.terminalPromptConfirmSec * 1_000;

  noteInput(s.id, "robert", NOW + 5_000);
  await sweepTerminalPrompts(NOW + 5_000 + confirmMs - 1_000);
  assert.equal(allRows().length, 1, "inside the confirm window nothing happens yet");

  await sweepTerminalPrompts(NOW + 5_000 + confirmMs);
  const rows = allRows();
  assert.equal(rows.length, 2, "one re-wake");
  assert.equal(rows[1].key, `${promptWakeKey(s.id, p)}:again`);
  assert.match(JSON.parse(rows[1].payload).say, /DID NOT LAND/);
  assert.equal(cards.length, 0, "the operator is not bothered yet");

  // Still stuck one window later: he has had his second look, so it is the operator's now.
  await sweepTerminalPrompts(NOW + 5_000 + confirmMs * 2 + 1_000);
  assert.equal(allRows().length, 2, "never a third wake");
  assert.equal(cards.length, 1);
  assert.match(cards[0], /didn't land/);
  assert.match(cards[0], /Extract a helper/);

  // And the prompt is off the tracked list: no second card on the next sweep.
  await sweepTerminalPrompts(NOW + 60 * 60_000);
  assert.equal(cards.length, 1);
});

test("a prompt Robert never touched becomes the operator's card at the deadline, options and all", async () => {
  reset();
  const s = term();
  const p = select();
  onPromptWaiting(s.id, p, NOW);
  screens.set(s.id, { live: true, prompt: p });
  const deadlineMs = CONFIG.terminalPromptDeadlineMin * 60_000;

  await sweepTerminalPrompts(NOW + deadlineMs - 1_000);
  assert.equal(cards.length, 0);
  await sweepTerminalPrompts(NOW + deadlineMs);
  assert.equal(cards.length, 1);
  assert.match(cards[0], /no call from Robert within/);
  assert.match(cards[0], /Extract a helper or inline it\?/);
  assert.match(cards[0], /mc session send/);
});

test("a prompt that resolved itself never reaches the operator", async () => {
  reset();
  const s = term();
  onPromptWaiting(s.id, select(), NOW);
  screens.set(s.id, { live: false, prompt: null }); // terminal was killed
  await sweepTerminalPrompts(NOW + CONFIG.terminalPromptDeadlineMin * 60_000 + 1_000);
  assert.equal(cards.length, 0);
});

test("the prompt hash ignores the cursor and follows the question and the labels", () => {
  const a = select();
  const moved = select({ options: [{ label: "Inline it here", offset: 0 }, { label: "Extract a helper", offset: 1 }, { label: "Ask me later", offset: 2 }] });
  assert.equal(promptHash(a), promptHash(moved), "an arrow key is not a new question");
  assert.notEqual(promptHash(a), promptHash(select({ question: "something else?" })));
  assert.notEqual(promptHash(a), promptHash(select({ options: [{ label: "Inline it here", offset: 0 }, { label: "Rewrite the module", offset: 1 }] })));
});
