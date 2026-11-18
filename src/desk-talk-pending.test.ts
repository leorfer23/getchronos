import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// Focus Talk shows a line you sent until its own record lands in the transcript. It used to keep ONE
// such line: a second message sent before the first landed replaced it, and the first left Talk
// (2026-11-18: "pisa el anterior… no sé si le llegó al agente"). The Talk block is lifted out of
// desk.html and run against stubs, the way the page runs it.
const desk = fs.readFileSync(path.join(process.cwd(), "static", "desk.html"), "utf8");
const from = desk.indexOf("const T = { id: null");
const to = desk.indexOf("// A slash command sent from Focus.");
assert.ok(from > 0 && to > from, "the Talk block is where this test looks for it");

const STUBS = `
const FX = { zoom: new Set(), exp: null, pin: new Map() };
const esc = (t) => String(t), md = (t) => t, stripLead = (t) => t, youSaid = (t) => t, cleanUser = (t) => t, cleanAct = (t) => t;
const clip = (t, n) => (t.length > n ? t.slice(0, n) + "…" : t);
const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const SYS_LINE = /^\\s*<(task-notification|system-reminder|command-)/, DAEMON_LINE = /^\\s*(?:\\/[a-z]|\\[chronos\\b)/i;
const isNoiseAct = () => false, foldActs = (a) => a.length + " steps";
const D = { id: null, shown: [] }, TermCompanion = { actPhrase: (t) => t, hhmm: () => "00:00" };
const phaseOf = (s) => s.phase, peekClose = () => {}, peekHtml = () => "", elapsedOf = () => "1s", qs = () => null, pinTo = () => {};
const window = {}, S = { mode: "focus" }, renderStory = () => {};
`;
function lift(answer: () => Promise<unknown>) {
  const F = { id: "s1", events: [] as any[] };
  const api = new Function("F", "answer", STUBS + desk.slice(from, to) + "\nreturn { T, focusTalk, talkSend };")(F, answer);
  return { F, ...api } as { F: typeof F; T: { pending: { text: string }[] }; focusTalk: (s: any) => string; talkSend: (s: any, t: string) => Promise<unknown> };
}
const said = (html: string) => [...html.matchAll(/<div class="tk you[^"]*">(?:<div class="cap">[^<]*<\/div>)?<div class="b">([^<]*)<\/div>/g)].map((m) => m[1]);
const term = (id = "s1") => ({ id, live: true, backend: "claude-code", phase: "working", quiet: false, goal_kind: "task" });

test("two lines sent before either lands both stay in Talk, each until its own record arrives", async () => {
  const { F, T, focusTalk, talkSend } = lift(async () => ({ ok: true }));
  const s = term();
  await talkSend(s, "first line");
  await talkSend(s, "second line");
  assert.deepEqual(said(focusTalk(s)), ["first line", "second line"]);
  F.events.push({ kind: "user", text: "first line", seq: 5000, ts: Date.now() });
  assert.deepEqual(said(focusTalk(s)), ["first line", "second line"]);
  assert.deepEqual(T.pending.map((p) => p.text), ["second line"]);
  F.events.push({ kind: "user", text: "second line", seq: 6000, ts: Date.now() });
  assert.deepEqual(said(focusTalk(s)), ["first line", "second line"], "never drawn twice");
  assert.deepEqual(T.pending, []);
});

test("a refused line leaves Talk; the others stay", async () => {
  let refuse = false;
  const { T, talkSend } = lift(async () => (refuse ? null : { ok: true }));
  const s = term();
  await talkSend(s, "kept");
  refuse = true;
  await talkSend(s, "refused");
  assert.deepEqual(T.pending.map((p) => p.text), ["kept"]);
});

test("another terminal does not inherit the lines still pending on the last one", async () => {
  const { F, T, talkSend } = lift(async () => ({ ok: true }));
  await talkSend(term("s1"), "on s1");
  F.id = "s2";
  await talkSend(term("s2"), "on s2");
  assert.deepEqual(T.pending.map((p) => p.text), ["on s2"]);
});
