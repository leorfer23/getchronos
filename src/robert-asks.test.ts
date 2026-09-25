/**
 * The Ask widget: Robert's own questions (src/robert-asks.ts), the chat card marker every operator
 * question now carries, the one answer path, and the shared page script (static/ask-card.js) run in
 * a vm — desk.html and phone.html have no build step, so the text of the wiring is asserted too.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { db, asks, chat, robertWakes, sessions, workspaces } from "./store.js";
import { answerAsk, notifyAskCreated } from "./asks.js";
import { escalateAsk } from "./ask-robert.js";
import { ASK_MARKER_RE, ROBERT_ASKER, askMarker, isOperatorsAsk, isRobertAsk, liftRobertAsks, raiseRobertAsk } from "./robert-asks.js";
import { setWakeAsker, setWakePoster } from "./wake-queue.js";

let turns: string[] = [];
beforeEach(() => {
  db.exec("DELETE FROM asks; DELETE FROM chat_messages; DELETE FROM robert_wakes; DELETE FROM sessions; DELETE FROM workspaces;");
  // A queued wake must never become a real manager turn in a test.
  turns = [];
  setWakeAsker(async (p) => { turns.push(p); return ""; });
  setWakePoster(() => {});
});

let n = 0;
const mkWs = () => workspaces.create({ slug: "akw-" + n++ + "-" + Math.random().toString(36).slice(2, 7), name: "AskWidget", config_dir: "/tmp/akw-" + n });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const deskRows = () => db.prepare("SELECT reply, source, workspace_id FROM chat_messages ORDER BY id").all() as { reply: string; source: string; workspace_id: string | null }[];

// ── Robert's `UI {"op":"ask"}` ────────────────────────────────────────────────────────────────────

test("an ask directive files an operator ask and becomes a card marker in his reply", () => {
  const ws = mkWs();
  const out = liftRobertAsks(
    {
      reply: "The deploy needs your go.",
      actions: [
        { op: "select", id: "abcd1234" },
        { op: "ask", question: "  Deploy acme to prod now?  ", options: ["Yes, deploy", " ", "Not today", 42 as any], ws: ws.slug },
      ],
    },
    null,
  );
  assert.equal(out.asks.length, 1);
  const a = asks.get(out.asks[0].id)!;
  assert.equal(a.question, "Deploy acme to prod now?");
  assert.deepEqual(JSON.parse(a.options!), ["Yes, deploy", "Not today"], "blank and non-string choices are dropped");
  assert.equal(a.asked_by, ROBERT_ASKER);
  assert.equal(a.route, "operator");
  assert.equal(a.workspace_id, ws.id, "a project slug on the directive files it there");
  assert.equal(a.run_id, null);
  assert.equal(a.session_id, null);
  assert.ok(isRobertAsk(a));
  assert.deepEqual(out.actions, [{ op: "select", id: "abcd1234" }], "other directives pass through; the ask one is consumed");
  assert.equal(out.reply, `The deploy needs your go.\n\n${askMarker(a.id)}`);
  assert.match(askMarker(a.id), ASK_MARKER_RE);
});

test("the turn's workspace is the default, a blank question files nothing, no ask leaves the reply alone", () => {
  const ws = mkWs();
  const filed: any[] = [];
  const raise = (f: any) => { filed.push(f); return { id: "f".repeat(8) + "-0000-0000-0000-000000000000" } as any; };
  const out = liftRobertAsks({ reply: "hi", actions: [{ op: "ask", question: "   " }, { op: "ask", q: "Which branch?" }] }, ws.id, raise);
  assert.deepEqual(filed, [{ question: "Which branch?", options: null, workspace_id: ws.id }]);
  assert.equal(out.asks.length, 1);
  const none = liftRobertAsks({ reply: "just talk", actions: [] }, null, raise);
  assert.equal(none.reply, "just talk");
  assert.deepEqual(none.asks, []);
});

test("options are capped at six, 80 chars each; the question at 500", () => {
  const filed: any[] = [];
  liftRobertAsks({ reply: "", actions: [{ op: "ask", question: "x".repeat(900), options: Array.from({ length: 9 }, (_, i) => String(i).repeat(100)) }] }, null, (f) => { filed.push(f); return { id: "a".repeat(36) } as any; });
  assert.equal(filed[0].question.length, 500);
  assert.equal(filed[0].options.length, 6);
  assert.ok(filed[0].options.every((o: string) => o.length === 80));
});

// ── whose question it is ──────────────────────────────────────────────────────────────────────────

test("the ? count is the operator's questions: his route, or escalated to him — not Robert's or a Lead's in-flight triage", () => {
  const base = { status: "open" as const, escalated_at: null };
  assert.equal(isOperatorsAsk({ ...base, route: "operator" }), true);
  assert.equal(isOperatorsAsk({ ...base, route: "robert" }), false);
  assert.equal(isOperatorsAsk({ ...base, route: "lead" }), false);
  assert.equal(isOperatorsAsk({ ...base, route: "robert", escalated_at: new Date().toISOString() }), true);
  assert.equal(isOperatorsAsk({ status: "answered", route: "operator", escalated_at: null }), false);
});

// ── the card in the chat ──────────────────────────────────────────────────────────────────────────

test("an operator-routed ask lands in the Desk chat as its card; Robert's own does not post a second one", async () => {
  const ws = mkWs();
  const a = asks.create({ asked_by: "acme terminal", route: "operator", workspace_id: ws.id, question: "staging or prod?" });
  await notifyAskCreated(a, undefined);
  assert.deepEqual(deskRows(), [{ reply: askMarker(a.id), source: "robert", workspace_id: ws.id }]);

  raiseRobertAsk({ question: "ship it?", options: null, workspace_id: ws.id });
  await settle();
  assert.equal(deskRows().length, 1, "his reply already carries the card");
});

test("a Robert-triaged ask posts its card only when he hands it up, with his line above it", async () => {
  const ws = mkWs();
  const a = asks.create({ asked_by: "acme terminal", route: "robert", workspace_id: ws.id, question: "drop the table?" });
  await notifyAskCreated(a, undefined).catch(() => {}); // triage is fire-and-forget; its turn is not what this tests
  const before = deskRows().filter((r) => r.reply.includes("::ask")).length;
  assert.equal(before, 0, "still with Robert: nothing in the operator's chat yet");
  await escalateAsk(a, "destructive — yours", { line: "**Passed a question to you** — destructive" });
  const rows = deskRows().filter((r) => r.reply.includes(askMarker(a.id)));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reply, `**Passed a question to you** — destructive\n\n${askMarker(a.id)}`);
  assert.ok(isOperatorsAsk(asks.get(a.id)!));
  await escalateAsk(a, "again", {});
  assert.equal(deskRows().filter((r) => r.reply.includes(askMarker(a.id))).length, 1, "a second escalation is a no-op");
});

// ── answering ─────────────────────────────────────────────────────────────────────────────────────

test("Robert's own question is the operator's: an agent answer is refused, the operator's reaches Robert as a wake", async () => {
  const ws = mkWs();
  const a = asks.create({ asked_by: ROBERT_ASKER, route: "operator", workspace_id: ws.id, question: "Deploy acme to prod?", options: ["Yes", "No"] });
  const refused = await answerAsk(a.id, "Yes", "robert");
  assert.deepEqual(refused, { ok: false, error: "Robert asked this one — only the operator answers it", status: 403 });
  const lead = await answerAsk(a.id, "Yes", "lead:12345678");
  assert.equal(lead.ok, false);
  assert.equal(asks.get(a.id)!.status, "open");

  const out = await answerAsk(a.id.slice(0, 8), "Yes", "operator");
  assert.equal(out.ok, true);
  assert.equal(asks.get(a.id)!.answer, "Yes");
  // The wake is filed behind a late import (asks.ts → wake-queue.ts): wait for it in real time, not ticks.
  const wakeRow = () => db.prepare("SELECT * FROM robert_wakes WHERE key = ?").get(`robert-ask:${a.id}`) as any;
  for (let i = 0; i < 200 && !wakeRow(); i++) await new Promise((r) => setTimeout(r, 10));
  const wake = wakeRow();
  assert.ok(wake, "a durable wake was queued");
  assert.equal(wake.workspace_id, ws.id);
  assert.match(JSON.parse(wake.payload).say, /Q: Deploy acme to prod\?\nA: Yes/);
  for (let i = 0; i < 100 && !turns.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(turns.some((t) => t.includes("A: Yes")), "the drain handed it to Robert");
});

test("an ordinary terminal ask answered from the card does not wake Robert", async () => {
  const ws = mkWs();
  const s = sessions.create({ backend: "claude-code", cwd: "/tmp", workspace_id: ws.id } as any);
  const a = asks.create({ session_id: s.id, asked_by: "acme terminal", route: "operator", workspace_id: ws.id, question: "q?" });
  assert.equal(isRobertAsk(a), false);
  const out = await answerAsk(a.id, "go", "operator");
  assert.equal(out.ok, true);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(robertWakes.unacked().length, 0);
});

// ── static/ask-card.js (the page half) ────────────────────────────────────────────────────────────

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const ctx: any = { window: {} };
vm.runInNewContext(read("static/ask-card.js"), ctx);
const AC = ctx.window.AskCard;
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

test("the page reads exactly the marker the daemon writes", () => {
  const id = "0123abcd-4567-89ab-cdef-0123456789ab";
  assert.equal(AC.MARK.exec(askMarker(id))?.[1], id);
  assert.equal(AC.MARK.source, ASK_MARKER_RE.source, "one marker grammar on both sides");
  assert.equal(AC.MARK.test(`see ${askMarker(id)}`), false, "only a line of its own is a card");
});

test("collect: the operator's asks, then terminals asking with no ask behind them — workers of a live Lead excluded", () => {
  const t0 = "2026-09-25T10:00:00.000Z";
  const rows = [
    { id: "a1", status: "open", for_operator: true, question: "prod?", options: '["yes","no"]', created_at: t0, asked_by: "Robert", session_id: null },
    { id: "a2", status: "open", for_operator: false, question: "with robert", options: null, created_at: t0, session_id: "s-triaging" },
  ];
  const askOf = (s: any) => (s.prompt && s.prompt.kind !== "turn" ? s.prompt : null);
  const sessions = [
    { id: "s-menu", live: true, created_at: t0, last_out: 1, prompt: { kind: "select", question: "Which plan?", options: [{ label: "A", offset: 0 }, { label: "B", offset: 1 }] } },
    { id: "s-triaging", live: true, created_at: t0, state: "blocked", blocked_reason: "question", state_label: "asked robert" },
    { id: "s-blocked", live: true, created_at: t0, last_out: 2, state: "blocked", blocked_reason: "question", state_label: "need the API key name" },
    { id: "s-worker", live: true, created_at: t0, lead_id: "s-lead", prompt: { kind: "yn", question: "ok?" } },
    { id: "s-lead", live: true, created_at: t0 },
    { id: "s-dead", live: false, created_at: t0, prompt: { kind: "yn", question: "gone?" } },
    { id: "s-turn", live: true, created_at: t0, prompt: { kind: "turn", question: "done." } },
  ];
  const items = plain(AC.collect(rows, sessions, askOf, (s: any) => "T " + s.id));
  assert.deepEqual(items.map((i: any) => i.key), ["term:s-menu", "term:s-blocked", "ask:a1"]);
  const menu = items[0];
  assert.deepEqual(menu.options, ["A", "B"]);
  assert.equal(menu.text, false, "a TUI menu is answered by picking, never by typing into it");
  assert.equal(items[1].question, "need the API key name");
  assert.equal(items[1].text, true);
  assert.deepEqual(items[2].options, ["yes", "no"]);
});

test("termBody: the ask bar's own bodies — cursor keys for a menu, y/n, typed text", () => {
  assert.deepEqual(plain(AC.termBody({ offsets: [0, 2] }, 1, null)), { keys: ["down", "down", "enter"] });
  assert.deepEqual(plain(AC.termBody({ offsets: [-1, 0] }, 0, null)), { keys: ["up", "enter"] });
  assert.deepEqual(plain(AC.termBody({ yn: true }, 1, null)), { text: "n", enter: true });
  assert.deepEqual(plain(AC.termBody({}, null, "use staging")), { text: "use staging", enter: true });
});

test("the card escapes model and agent text, and collapses once answered", () => {
  const open = AC.html({ key: "ask:x", kind: "ask", who: "<b>evil</b>", question: '"><img src=x onerror=alert(1)>', options: ["<i>"], text: true, at: Date.now(), status: "open" });
  assert.doesNotMatch(open, /<img|<b>evil|<i>/);
  assert.match(open, /data-akopt="0"/);
  assert.match(open, /class="ak-f"/);
  const done = AC.html({ key: "ask:x", kind: "ask", who: "w", question: "prod?", options: [], at: 0, status: "answered", answer: "yes", by: "operator" });
  assert.match(done, /askc done/);
  assert.doesNotMatch(done, /ak-f|data-akopt/, "an answered card has nothing left to press");
});

test("both chat surfaces load the widget, embed cards, relay its topics and carry one ? button", () => {
  for (const [file, btn] of [["static/desk.html", "chat-asks"], ["static/phone.html", "r-asks"]] as const) {
    const html = read(file);
    assert.match(html, /<script src="\/ask-card\.js"><\/script>/, file);
    assert.match(html, /AskCard\.embed\(d\)/, `${file}: every Robert row goes through embed`);
    assert.match(html, /const BUS_TOPICS = \[[^\]]*"ask\.created", "ask\.answered"/, `${file}: the socket asks for ask.* events`);
    assert.match(html, /AskCard\.onEvent\(e\)/, file);
    assert.match(html, new RegExp(`id="${btn}"`), file);
    assert.match(html, /AskCard\.init\(/, file);
  }
  assert.deepEqual(plain(AC.TOPICS), ["ask.created", "ask.answered"]);
  const api = read("src/api.ts");
  assert.match(api, /api\.get\("\/asks\/:id", /, "the card reads one row");
  assert.match(api, /for_operator: isOperatorsAsk\(a\)/, "the list marks whose turn each ask is");
});
