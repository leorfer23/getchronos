/**
 * The phone's approval deck (static/phone-deck.js), run in a vm: what an utterance means for the card
 * on screen (only an explicit, short affirmative is a yes), how the agent's proof becomes checks, how
 * before/after screenshots pair, what the card says out loud, and — the part that must never drift —
 * exactly which door each decision goes through today (and that a draft is never sent).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const src = fs.readFileSync(path.join(process.cwd(), "static/phone-deck.js"), "utf8");
const mem = new Map<string, string>();
const localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) };
const ctx: any = { window: { crypto: globalThis.crypto, TextEncoder }, TextEncoder, Blob, URL, setTimeout, clearTimeout, console, localStorage };
vm.runInNewContext(src, ctx);
const D = ctx.window.PhoneDeck;
const T = D._t;
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

type Call = { kind: "api" | "input"; path?: string; id?: string; body?: any; headers?: any };
let calls: Call[] = [];
let apiImpl: (p: string, o: any) => any = () => ({});
function setCtx(lang = "es") {
  T.setCtx({
    lang: () => lang,
    api: async (p: string, o: any = {}) => { calls.push({ kind: "api", path: p, body: o.body ? JSON.parse(o.body) : undefined, headers: o.headers }); return apiImpl(p, o); },
    input: async (id: string, body: any) => { calls.push({ kind: "input", id, body }); },
    sessions: () => [],
    wsName: () => "atlas",
    wsColor: () => "#56B693",
  });
}
beforeEach(() => { calls = []; mem.clear(); apiImpl = () => ({}); setCtx(); });

const question = (options: string[], yn = false) => ({ kind: "question", question: { text: "q?", options, yn, free: true } });
const merge = { kind: "merge" };

test("only a short utterance made of yes-words is a yes", () => {
  for (const t of ["Sí.", "sí", "Dale.", "sí, dale", "bueno, dale", "ok", "Okay.", "listo", "perfecto", "de una", "sí, por favor", "mergealo", "yes", "go ahead", "approve it", "está bien"])
    assert.equal(T.intentOf(t, merge).type, "yes", t);
  for (const t of ["sí pero cambiá el color", "sí, aunque no sé", "no", "sip sip sip sip sip sip sip", "si si si si si si si", "¿sí?", "bueno", "mmm", "hacé lo que quieras", "sí claro pero primero quiero ver los tests"])
    assert.notEqual(T.intentOf(t, merge).type, "yes", t);
});

test("later, change, no, unsure, close, repeat, more and next are told apart", () => {
  assert.equal(T.intentOf("después", merge).type, "later");
  assert.equal(T.intentOf("Más tarde.", merge).type, "later");
  assert.equal(T.intentOf("ahora no", merge).type, "later");
  assert.equal(T.intentOf("no", merge).type, "no");
  assert.equal(T.intentOf("No sé.", merge).type, "unclear", "unsure is not a no");
  assert.equal(T.intentOf("ni idea", merge).type, "unclear");
  const ch = T.intentOf("No, que cambie el título del botón", merge);
  assert.equal(ch.type, "change");
  assert.equal(ch.words, "que cambie el título del botón");
  const but = T.intentOf("Sí, pero cambiá el color a verde", merge);
  assert.equal(but.type, "change");
  assert.equal(but.words, "cambiá el color a verde");
  assert.equal(T.intentOf("cerrar", merge).type, "close");
  assert.equal(T.intentOf("repetí", merge).type, "repeat");
  assert.equal(T.intentOf("detalles", merge).type, "more");
  assert.equal(T.intentOf("siguiente", merge).type, "next");
  assert.equal(T.intentOf("esperá", merge).type, "wait");
});

test("a question's answer by its order or its own words — ambiguity is never guessed", () => {
  const q = question(["Keep both for a week", "Switch today"]);
  assert.deepEqual(plain(T.intentOf("la primera", q)), { type: "option", option: 0 });
  assert.deepEqual(plain(T.intentOf("la segunda", q)), { type: "option", option: 1 });
  assert.deepEqual(plain(T.intentOf("la última", q)), { type: "option", option: 1 });
  assert.deepEqual(plain(T.intentOf("switch today", q)), { type: "option", option: 1 });
  assert.deepEqual(plain(T.intentOf("keep both for a week please", q)), { type: "option", option: 0 });
  assert.equal(T.intentOf("today", question(["Ship today", "Switch today"])).type, "unclear", "both options match equally");
  const free = T.intentOf("decile que esperamos al lunes", q);
  assert.equal(free.type, "free");
  assert.equal(free.words, "esperamos al lunes");
});

test("the agent's proof becomes checks with a plain pass/fail; '0 failed' and 'nothing broke' pass", () => {
  const g = plain(T.groupProof([
    "npm test — 412 passed, 0 failed",
    "Full suite re-run after the change: nothing else moved",
    "Checked at 360, 390 and 430px widths",
    "Second model review: no issues",
  ]));
  assert.deepEqual(g.map((x: any) => [x.id, x.state]), [["intact", "pass"], ["tests", "pass"], ["review", "pass"], ["checked", "pass"]]);
  for (const l of ["3 tests failed", "typecheck failed", "build broken on main", "2 errors in lint", "FAIL src/a.test.ts", "✕ login flow"]) assert.equal(T.lineFails(l), true, l);
  for (const l of ["0 failed", "no failures", "nothing broke", "without errors", "never crashed", "passed all 12"]) assert.equal(T.lineFails(l), false, l);
  assert.deepEqual(plain(T.groupProof(["the numbers look right"])).map((x: any) => x.id), ["other"]);
});

test("before/after screenshots pair by label; the rest stand alone", () => {
  const r = plain(T.pairShots([
    { name: "a", label: "before" }, { name: "b", label: "after" },
    { name: "c", label: "desktop-before" }, { name: "d", label: "desktop-after" },
    { name: "e", label: "after 390" }, { name: "f", label: "menu open" },
  ]));
  assert.deepEqual(r.pairs.map((p: any) => [p.label, p.before.name, p.after.name]), [["", "a", "b"], ["desktop", "c", "d"]]);
  assert.deepEqual(r.singles.map((s: any) => s.name).sort(), ["e", "f"]);
});

const sess = { id: "s1", live: true, workspace_id: "w1", goal: "Fix the sign-in button", spawn_goal: "the sign-in button sits on the footer, fix it", done_when: ["no overlap at 360px"], done_checked: ["2026-11-09T10:00:00Z"], lines_added: 48, lines_removed: 12 };
const outcome = { summary: "The button no longer covers the footer. It sits under the field.", changes: ["moved it"], proof: ["npm test — 12 passed, 0 failed"], prs: ["https://github.com/example/web/pull/128"], shots: [{ name: "b.png", label: "before" }, { name: "a.png", label: "after" }], ask: "merge", shipped: [], at: "2026-11-09T10:05:00Z" };

test("a hand-off becomes a card: his words, the verdict, checks, screenshots, the PR and its size", () => {
  const it = plain(T.handoffItem(sess, outcome));
  assert.equal(it.kind, "merge");
  assert.equal(it.key, "handoff:s1:2026-11-09T10:05:00Z", "a newer hand-off is a new card");
  assert.equal(it.asked, "the sign-in button sits on the footer, fix it", "what he asked, in his words");
  assert.equal(it.verdict, "The button no longer covers the footer.");
  assert.equal(it.pairs.length, 1);
  assert.deepEqual(it.prs.map((p: any) => p.num), [128]);
  assert.deepEqual(it.size, { added: 48, removed: 12 });
  assert.deepEqual(it.finish, { total: 1, met: 1, items: [{ text: "no overlap at 360px", met: true }] });
  assert.equal(T.handoffItem(sess, { ...outcome, shipped: ["merged #128"] }), null, "shipped asks nothing");
  assert.equal(T.handoffItem(sess, { ...outcome, ask: "none" }), null);
  assert.equal(T.handoffItem(sess, { ...outcome, ask: "review" }).kind, "review");
});

test("read out verdict first; a draft is read whole; no text, no yes", () => {
  const it = T.handoffItem(sess, outcome);
  const r = plain(T.readout(it));
  assert.match(r.head, /^atlas\. The button no longer covers the footer\./);
  assert.match(r.body.join(" "), /Según el agente: los tests pasan/);
  assert.equal(r.ask, "¿Lo mergeo?");
  const d = T.draftItem({ id: "d1", kind: "slack", channel: "#partners", text: "Hi team — prices hold until March.\nThen they move.", workspace_id: "w1", at: "2026-11-09T10:00:00Z" });
  const dr = plain(T.readout(d));
  assert.match(dr.body.join(" "), /Dice así: Hi team — prices hold until March\.\nThen they move\./, "every word");
  assert.match(dr.ask, /¿La apruebo\?/);
  const blind = plain(T.readout(T.draftItem({ id: "d2", kind: "slack", channel: "#x", text: null, label: "Slack draft → #x: Hi…" })));
  assert.match(blind.ask, /no puedo darte el sí/);
});

test("what Yes does today: merge → the Desk's line into its terminal; never more", async () => {
  const it = T.handoffItem(sess, outcome);
  await T.decide(it, "yes");
  assert.deepEqual(plain(calls), [{ kind: "input", id: "s1", body: { text: T.OK_LINE.merge, enter: true } }]);
  assert.equal(T.hidden(it.key), true, "the card leaves the deck");
});

test("what Yes does today: a question is answered on its ask; Later dates it off the live list", async () => {
  const q = T.questionItem({ kind: "ask", id: "a1", question: "Keep both?", options: ["Keep both", "Switch"], text: true, at: 1 });
  await T.decide(q, "yes", null, 1);
  assert.deepEqual(plain(calls), [{ kind: "api", path: "/asks/a1/answer", body: { answer: "Switch", by: "operator" } }]);
  calls = [];
  const q2 = T.questionItem({ kind: "ask", id: "a2", question: "Now?", options: [], text: true, at: 1 });
  await T.decide(q2, "later");
  assert.equal(calls[0].path, "/asks/a2/hold");
  assert.equal(calls[0].body.until, "+2h");
});

test("what Yes does today: a draft is NEVER sent — the yes is a line in the terminal that wrote it", async () => {
  T.setCtx({ ...{ lang: () => "en", wsName: () => "cedar", wsColor: () => "#000" }, api: async (p: string, o: any = {}) => { calls.push({ kind: "api", path: p, body: o.body && JSON.parse(o.body) }); return {}; }, input: async (id: string, body: any) => { calls.push({ kind: "input", id, body }); }, sessions: () => [{ id: "s9", live: true }] });
  const d = T.draftItem({ id: "d1", session_id: "s9", kind: "slack", channel: "#partners", text: "Hi team.", at: "2026-11-09T10:00:00Z" });
  const msg = await T.decide(d, "yes");
  assert.deepEqual(plain(calls), [{ kind: "input", id: "s9", body: { text: "Approved: the draft to #partners is good as written. Leave it as a draft — I'll send it myself.", enter: true } }]);
  assert.match(msg, /stays a draft/);
  assert.doesNotMatch(src, /\/send|chat\.postMessage|drafts\/send|send_message\b/, "no send door anywhere in the deck");
});

test("the ledger, when the daemon has it: a bound yes is recorded with its target; an unbound merge goes to the terminal; 409 is never resent", async () => {
  const led = (over: any = {}) => ({ ...T.handoffItem(sess, outcome), key: "ledger:i1", src: "ledger", ledger: { item: "i1", request: "r1", target_hash: null, bound: false, action: "merge", ...over } });
  await T.decide(led(), "yes");
  assert.deepEqual(plain(calls), [{ kind: "input", id: "s1", body: { text: T.OK_LINE.merge, enter: true } }], "unbound: today's way");
  calls = [];
  await T.decide(led({ bound: true, target_hash: "sha:abc" }), "yes", null, null, { voice: true, words: "sí, dale" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/ledger/r1/decision");
  assert.deepEqual(plain(calls[0].headers), { "x-mc-operator": "1" });
  assert.deepEqual(calls[0].body, { item: "i1", decision: "yes", by: "phone-voice", target_hash: "sha:abc", words: "sí, dale" });
  calls = [];
  apiImpl = () => { throw Object.assign(new Error("target moved"), { status: 409 }); };
  await assert.rejects(T.decide(led({ bound: true, target_hash: "sha:old" }), "yes"), (e: any) => e.moved === true);
  assert.equal(calls.length, 1, "one attempt, no resend");
  calls = []; apiImpl = () => ({});
  await T.decide(led(), "change", "keep the old colour");
  assert.deepEqual(plain(calls).map((c: Call) => c.kind + ":" + (c.path || c.id)), ["api:/ledger/r1/decision", "input:s1"], "recorded, and the words reach the terminal");
});

test("a draft yes on the ledger needs the exact words: the phone's hash must equal the item's target", async () => {
  const d = { kind: "slack", channel: "#Partners ", text: "Hi team — prices hold.\n", subject: null, to: null };
  const ours = await T.draftHash(d);
  const ledgerFormula = "sha256:" + crypto.createHash("sha256").update(JSON.stringify(["slack", "#partners", "", "Hi team — prices hold.\n"])).digest("hex");
  assert.equal(ours, ledgerFormula, "same formula as src/ledger-model.ts draftHash (channel trimmed + lower-cased, text verbatim)");
  const it = { ...T.draftItem({ id: "x", kind: "slack", channel: "#partners", text: "Hi team.", at: "2026-11-09T10:00:00Z" }), src: "ledger", ledger: { item: "i2", request: "r2", target_hash: "sha256:other", bound: true, action: "send" }, hashOk: false };
  await assert.rejects(T.decide(it, "yes"), /exact text|texto exacto/);
  assert.equal(calls.length, 0, "nothing recorded for words he did not hear");
});

test("the adapter prefers the ledger and falls back to today's endpoints", () => {
  assert.match(src, /var led = await C\.api\("\/ledger\/queue"\)\.catch\(function \(\) \{ return null; \}\);/);
  assert.match(src, /if \(led && Array\.isArray\(led\.items\)\)/);
  assert.match(src, /C\.api\("\/asks\?status=open"\)/);
  assert.match(src, /C\.api\("\/drafts"\)/);
  assert.match(src, /decisionsFor\(s\)/);
});
