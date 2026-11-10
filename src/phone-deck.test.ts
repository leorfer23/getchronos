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
const ctx: any = { window: { crypto: globalThis.crypto, TextEncoder, performance }, TextEncoder, Blob, URL, setTimeout, clearTimeout, console, localStorage, performance };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(process.cwd(), "static/ask-card.js"), "utf8"), ctx); // the shared answer bodies
vm.runInContext(src, ctx);
const D = ctx.window.PhoneDeck;
const T = D._t;
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

type Call = { kind: "api" | "input"; path?: string; id?: string; body?: any; headers?: any };
let calls: Call[] = [];
let apiImpl: (p: string, o: any) => any = () => ({});
// A call that "plays" every line at once: say() resolves true (played to the end) right away.
let said: string[] = [];
let toasts: Array<{ msg: string; act?: any }> = [];
let voiceState = "listening";
const voice = { on: true, state: () => voiceState, say: (text: string) => { said.push(text); return Promise.resolve(true); }, skip: () => {}, stop: () => {} };
function setCtx(lang = "es") {
  T.setCtx({
    lang: () => lang,
    api: async (p: string, o: any = {}) => { calls.push({ kind: "api", path: p, body: o.body ? JSON.parse(o.body) : undefined, headers: o.headers }); return apiImpl(p, o); },
    input: async (id: string, body: any) => { calls.push({ kind: "input", id, body }); },
    sessions: () => [],
    wsName: () => "atlas",
    wsColor: () => "#56B693",
    voice, toast: (msg: string, act?: any) => { toasts.push({ msg, act }); }, onChange: () => {}, onOpen: () => {},
  });
}
beforeEach(() => { calls = []; said = []; toasts = []; voiceState = "listening"; mem.clear(); apiImpl = () => ({}); setCtx(); T.setHold(40, 200); });

const question = (options: string[], yn = false) => ({ kind: "question", question: { text: "q?", options, yn, free: true } });
const merge = { kind: "merge" };

test("on something irreversible only a strong yes is a yes; a weak one is asked again, never acted on", () => {
  for (const t of ["Sí.", "sí", "Dale.", "sí, dale", "dale sí", "bueno, dale", "si si", "de una", "sí, por favor", "mergealo", "hacelo", "adelante", "aprobado", "yes", "yes please", "go ahead", "do it", "ship it", "merge it"])
    assert.deepEqual(plain(T.intentOf(t, merge)), { type: "yes", strength: "strong" }, t);
  for (const t of ["ok", "Okay.", "listo", "perfecto", "bien", "está bien", "claro", "obvio", "va", "vale", "bueno", "correcto", "ok perfecto", "sip", "yep", "yeah"])
    assert.equal(T.intentOf(t, merge).type, "weak", t);
  for (const t of ["sí pero cambiá el color", "sí, aunque no sé", "no", "sip sip sip sip sip sip sip", "si si si si si si si", "¿sí?", "mmm", "hacé lo que quieras",
    "sí claro pero primero quiero ver los tests", "lo mergeo", "¿Lo mergeo?", "la apruebo", "apruebo", "mergear", "aprobar", "approve it", "merge"])
    assert.ok(!["yes", "weak"].includes(T.intentOf(t, merge).type), t);
  // A question or a read: the wider list stands.
  for (const t of ["ok", "listo", "perfecto", "bien", "claro"]) {
    assert.equal(T.intentOf(t, { kind: "review" }).type, "yes", t);
    assert.equal(T.intentOf(t, question(["Yes", "No"], true)).type, "yes", t);
  }
});

test("later, change, no, unsure, close, repeat, more and next are told apart", () => {
  assert.equal(T.intentOf("después", merge).type, "later");
  assert.equal(T.intentOf("Más tarde.", merge).type, "later");
  assert.equal(T.intentOf("ahora no", merge).type, "later");
  assert.equal(T.intentOf("no", merge).type, "no");
  assert.equal(T.intentOf("No sé.", merge).type, "unclear", "unsure is not a no");
  assert.equal(T.intentOf("ni idea", merge).type, "unclear");
  // "No, <words>" is read back and asked about first: the page's own "No te entendí" must never be
  // typed into a terminal as a change.
  const ch = T.intentOf("No, que cambie el título del botón", merge);
  assert.equal(ch.type, "nochange");
  assert.equal(ch.words, "que cambie el título del botón");
  assert.equal(T.intentOf("No te entendí.", merge).type, "nochange");
  const verb = T.intentOf("cambiá el título del botón", merge);
  assert.equal(verb.type, "change", "a change led by its verb goes straight to the terminal");
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
  assert.deepEqual(plain(T.intentOf("the second one", q)), { type: "option", option: 1 }, "'one' names the option here, it is not its order");
  assert.deepEqual(plain(T.intentOf("option one", q)), { type: "option", option: 0 });
  assert.deepEqual(plain(T.intentOf("la de arriba", q)), { type: "option", option: 0 });
  assert.equal(T.intentOf("Which one", q).type, "unclear", "the page's own question is not an answer");
  assert.equal(T.intentOf("la tercera", q).type, "unclear", "there is no third");
  assert.equal(T.intentOf("la primera o la segunda", q).type, "unclear", "two orders is no answer");
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
  setCtx("en");
  assert.equal(plain(T.readout(it)).ask, "Shall I merge?", "never 'Merge it?' — that is a yes phrase");
  setCtx("es");
  const d = T.draftItem({ id: "d1", kind: "slack", channel: "#partners", text: "Hi team — prices hold until March.\nThen they move.", workspace_id: "w1", at: "2026-11-09T10:00:00Z" });
  const dr = plain(T.readout(d));
  assert.match(dr.body.join(" "), /Dice así: Hi team — prices hold until March\.\nThen they move\./, "every word");
  assert.match(dr.ask, /¿La apruebo\?/);
  const blind = plain(T.readout(T.draftItem({ id: "d2", kind: "slack", channel: "#x", text: null, label: "Slack draft → #x: Hi…" })));
  assert.match(blind.ask, /no puedo aprobarlo/);
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
  assert.deepEqual(calls[0].body, { item: "i1", decision: "yes", by: "phone-voice:strong", target_hash: "sha:abc", words: "sí, dale" });
  calls = [];
  // A weak yes confirmed after the re-ask: both utterances, and how, reach the record.
  await T.decide(led({ bound: true, target_hash: "sha:abc" }), "yes", null, null, { voice: true, words: "bien → sí", how: "confirmed" });
  assert.equal(calls[0].body.by, "phone-voice:confirmed");
  assert.equal(calls[0].body.words, "bien → sí");
  calls = [];
  apiImpl = () => { throw Object.assign(new Error("target moved"), { status: 409 }); };
  await assert.rejects(T.decide(led({ bound: true, target_hash: "sha:old" }), "yes"), (e: any) => e.moved === true);
  assert.equal(calls.length, 1, "one attempt, no resend");
  calls = []; apiImpl = () => ({});
  await T.decide(led(), "change", "keep the old colour");
  assert.deepEqual(plain(calls).map((c: Call) => c.kind + ":" + (c.path || c.id)), ["api:/ledger/r1/decision", "input:s1"], "recorded, and the words reach the terminal");
});

test("executed on the decision's answer: true → nothing typed into the terminal; false → today's line; absent → as today", async () => {
  const led = (over: any = {}) => ({ ...T.handoffItem(sess, outcome), key: "ledger:i1", src: "ledger", ledger: { item: "i1", request: "r1", target_hash: "sha:abc", bound: true, action: "merge", ...over } });
  // The executor merged it: say so, and never also type the approval line (that would be a second merge).
  calls = []; apiImpl = () => ({ ok: true, executed: true });
  const done = await T.decide(led(), "yes");
  assert.deepEqual(plain(calls).map((c: Call) => c.kind + ":" + (c.path || c.id)), ["api:/ledger/r1/decision"], "recorded — and no input to the terminal");
  assert.match(done, /Done|Listo/);
  // The executor did not run it: the terminal is told the Desk's way, so the agent still carries it out.
  calls = []; apiImpl = () => ({ ok: true, executed: false });
  await T.decide(led(), "yes");
  assert.deepEqual(plain(calls).map((c: Call) => c.kind + ":" + (c.path || c.id)), ["api:/ledger/r1/decision", "input:s1"]);
  assert.equal(calls[1].body.text, T.OK_LINE.merge);
  // No field (the daemon before the executor): recorded, nothing typed — exactly today's behaviour.
  calls = []; apiImpl = () => ({ ok: true });
  const rec = await T.decide(led(), "yes");
  assert.deepEqual(plain(calls).map((c: Call) => c.kind + ":" + (c.path || c.id)), ["api:/ledger/r1/decision"]);
  assert.match(rec, /Recorded|registrado/);
  // A draft is never typed as an approval anywhere — executed or not.
  const d = { ...T.draftItem({ id: "x", session_id: "s1", kind: "slack", channel: "#partners", text: "Hi team.", at: "2026-11-09T10:00:00Z" }), src: "ledger", ledger: { item: "i2", request: "r2", target_hash: "sha256:t", bound: true, action: "send" }, hashOk: true };
  for (const executed of [true, false, undefined]) {
    calls = []; apiImpl = () => ({ ok: true, executed });
    await T.decide(d, "yes");
    assert.deepEqual(plain(calls).map((c: Call) => c.kind), ["api"], `draft, executed=${executed}`);
  }
  calls = []; apiImpl = () => ({});
});

test("a draft yes on the ledger needs the exact words: the phone's hash must equal the item's target", async () => {
  const d = { kind: "slack", channel: "#Partners ", text: "Hi team — prices hold.\n", subject: null, to: null };
  const ours = await T.draftHash(d);
  const ledgerFormula = "sha256:" + crypto.createHash("sha256").update(JSON.stringify(["slack", "#partners", "", "Hi team — prices hold.\n"])).digest("hex");
  assert.equal(ours, ledgerFormula, "same formula as src/ledger-model.ts draftHash (channel trimmed + lower-cased, text verbatim)");
  const it = { ...T.draftItem({ id: "x", kind: "slack", channel: "#partners", text: "Hi team.", at: "2026-11-09T10:00:00Z" }), src: "ledger", ledger: { item: "i2", request: "r2", target_hash: "sha256:other", bound: true, action: "send" }, hashOk: false };
  await assert.rejects(T.decide(it, "yes"), /full text|texto completo/);
  assert.equal(calls.length, 0, "nothing recorded for words he did not hear");
});

// ── a spoken yes on something irreversible must not be easy to trigger ─────────────────────────────

// One card of every kind, written with neutral agent text (no yes-word in it): any yes-word found in
// what the page says must then come from the page's own lines.
function everyKind(): any[] {
  const base = { live: true, sid: "s1", ws: "w1", at: 1, title: "Fix the sign-in button" };
  const ho = T.handoffItem({ ...sess, id: "s1" }, outcome);
  return [
    { ...ho, key: "k-merge", kind: "merge" },
    { ...ho, key: "k-deploy", kind: "deploy" },
    { ...ho, key: "k-md", kind: "merge+deploy" },
    { ...ho, key: "k-review", kind: "review" },
    { ...T.draftItem({ id: "d1", session_id: "s1", kind: "slack", channel: "#partners", text: "Prices hold until March. Then they move.", at: "2026-11-09T10:00:00Z" }), key: "k-draft", live: true },
    { ...T.draftItem({ id: "d2", session_id: "s1", kind: "email", to: "ana@example.com", subject: "Numbers", text: "The numbers are attached.", at: "2026-11-09T10:00:00Z" }), key: "k-email", live: true },
    { ...T.questionItem({ kind: "ask", id: "a1", question: "Keep the old endpoint for a week, or switch everyone over today?", options: ["Keep both for a week", "Switch today"], text: true, at: 1, note: "keeping both is safer" }), ...base, key: "k-q", kind: "question" },
    { ...T.questionItem({ kind: "term", id: "s1", question: "Run the migration now", options: ["Yes", "No"], yn: true, at: 1 }), ...base, key: "k-yn", kind: "question" },
    { ...T.questionItem({ kind: "ask", id: "a2", question: "Which branch name should it use", options: [], text: true, at: 1 }), ...base, key: "k-free", kind: "question" },
    { ...T.blockedItem({ id: "s1", live: true, workspace_id: "w1", goal: "Refresh the numbers", status: { line: "needs the VPN to reach the reporting database", since: 1 } }), key: "k-blocked" },
  ];
}
const variants = (line: string) => {
  const out = new Set<string>([line, line.replace(/[¿?¡!.,:;«»“”—…]/g, " ").replace(/\s+/g, " ").trim()]);
  for (const part of line.split(/(?<=[.!?…:;])\s+/)) { out.add(part); out.add(part.replace(/[¿?¡!.,:;«»“”—…]/g, " ").replace(/\s+/g, " ").trim()); }
  return [...out].filter(Boolean);
};

test("the page's own lines are never a yes, and never act — every card kind, Spanish and English", () => {
  // Moving around (repeat, more, next, wait, close) decides nothing; "No, …" and a change on a question
  // or a blocked card are read back and asked about first. Anything else would be a decision.
  const moves = new Set(["unclear", "repeat", "more", "next", "wait", "close"]);
  const asksFirst = (it: any, i: any) => i.type === "nochange" || ((i.type === "change" || i.type === "free") && (it.kind === "question" || it.kind === "blocked"));
  for (const lang of ["es", "en"]) {
    setCtx(lang);
    for (const it of everyKind()) {
      const pw = T.pageWords(it);
      for (const line of T.deckLines(it)) for (const v of variants(line)) {
        const i = T.intentOf(v, it, pw);
        assert.ok(!["yes", "weak"].includes(i.type), `${lang} ${it.kind}: "${v}" was read as ${i.type}`);
        // An option's own label is one of the page's words by necessity (it reads the options): only
        // the call's clock tells his answer from its echo — tested below. A whole line never matches.
        if (i.type === "option") assert.ok(it.question.options.some((o: string) => v.toLowerCase().replace(/[.,]/g, "").trim() === o.toLowerCase()), `${lang}: "${v}" matched an option`);
        else assert.ok(moves.has(i.type) || asksFirst(it, i), `${lang} ${it.kind}: "${v}" would act (${i.type})`);
      }
    }
  }
});

test("the page reading the options aloud is never taken as his answer: it overlaps its audio, or starts before the question ended", async () => {
  const q = { ...T.questionItem({ kind: "ask", id: "a8", question: "Keep both or switch?", options: ["Keep both for a week", "Switch today"], text: true, at: 1 }), key: "k-q8", live: true };
  T.mount([q]);
  T.voiceAnswer("hola", later());
  await tick(5);
  const ended = T.va().askEndedAt;
  T.voiceAnswer("Switch today", { t0: ended + 5, overlap: true });
  T.voiceAnswer("Switch today", { t0: ended - 400, overlap: false });
  T.voiceAnswer("Switch today", { t0: ended + 5, overlap: false, echo: true });
  await tick(20);
  assert.equal(calls.filter((c) => c.kind === "api").length, 0);
});

test("no line the page authors carries a yes-word (fails the day a new prompt adds one)", () => {
  const yesWords = new Set([...T.STRONG_YES, ...T.WEAK_YES]);
  const phrases: string[] = T.STRONG_PHRASE;
  const norm = (x: string) => " " + x.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim() + " ";
  for (const lang of ["es", "en"]) {
    setCtx(lang);
    for (const it of everyKind()) for (const line of T.deckLines(it)) {
      const n = norm(line);
      const hit = n.trim().split(" ").filter((w) => yesWords.has(w));
      assert.deepEqual(hit, [], `${lang} ${it.kind}: "${line}" says ${hit.join(", ")}`);
      for (const ph of phrases) assert.ok(!n.includes(ph), `${lang} ${it.kind}: "${line}" says "${ph.trim()}"`);
    }
  }
});

test("a yes-word the agent's own text puts in the read-out does not count for that card", () => {
  const d = { ...T.draftItem({ id: "d9", session_id: "s1", kind: "slack", channel: "#team", text: "Sí, dale, nos vemos el lunes.", at: "2026-11-09T10:00:00Z" }), key: "k-d9", live: true };
  const pw = T.pageWords(d);
  assert.deepEqual(plain(T.intentOf("dale", d, pw)), { type: "unclear", why: "page-word" }, "the draft itself says 'dale'");
  assert.equal(T.intentOf("sí", d, pw).type, "unclear");
  assert.deepEqual(plain(T.intentOf("aprobalo", d, pw)), { type: "yes", strength: "strong" }, "a yes-word the page never said still counts");
});

// The deck by voice, with the call's clock: the card is read, its question ends, then he speaks.
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const later = (ms = 5) => ({ t0: performance.now() + ms, t1: performance.now() + ms + 300, overlap: false, echo: false });
async function readMerge() {
  const it = { ...T.handoffItem({ ...sess, id: "s1" }, outcome), key: "k-m", live: true, sid: "s1" };
  T.mount([it]);
  T.voiceAnswer("hola", later());   // the card on screen was not read yet: reading it is all that happens
  await tick(5);
  assert.ok(T.va().askEndedAt != null, "its question was played to the end");
  return it;
}
const inputs = () => calls.filter((c) => c.kind === "input");

test("a strong yes is said back and held; it goes only when the window closes", async () => {
  await readMerge();
  said = [];
  T.voiceAnswer("Sí, dale.", later());
  await tick(5);
  assert.match(said.join(" "), /Mergeo .*Decí cancelar para frenar\./, "one line before");
  assert.equal(inputs().length, 0, "nothing typed yet");
  const hold = toasts.at(-1)!;
  assert.match(hold.msg, /Decí cancelar para frenar/);
  assert.equal(typeof hold.act?.fn, "function", "a Cancel on screen too");
  assert.ok(hold.act.ms >= 10_000, "it stays for the whole window, not a 5 s toast");
  await tick(80);
  assert.deepEqual(plain(inputs()), [{ kind: "input", id: "s1", body: { text: T.OK_LINE.merge, enter: true } }], "only the approval is typed — no transcript");
  await tick(5);
  assert.match(said.join(" "), /Hecho\. Le dije que mergee\./, "one line after");
  assert.equal(toasts.at(-1)!.msg, "Hecho. Le dije que mergee.", "the Cancel is gone once it went");
  const rec = JSON.parse(mem.get("phone-decided")!)["k-m"];
  assert.equal(rec.words, "Sí, dale.");
  assert.equal(rec.how, "strong");
});

test("cancelar, no, any other words, or a barge-in inside the window stop it", async () => {
  for (const [lang, stopper] of [["es", "cancelar"], ["es", "no"], ["es", "esperá"], ["es", "eh, pará un poco que lo miro"], ["es", "ok"], ["en", "cancel"], ["en", "wait"], ["en", "no, not yet"]]) {
    calls = []; said = []; setCtx(lang);
    await readMerge();
    T.voiceAnswer(lang === "es" ? "dale" : "go ahead", later());
    await tick(5);
    T.voiceAnswer(stopper, later(1));
    await tick(80);
    assert.equal(inputs().length, 0, `"${stopper}" stopped it`);
    assert.match(said.join(" "), lang === "es" ? /Cancelado\. No hice nada\./ : /Cancelled\. Nothing was done\./, stopper);
    assert.match(toasts.at(-1)!.msg, /^(Cancelado|Cancelled)/, "the screen says so too");
  }
  setCtx("es");
  calls = [];
  await readMerge();
  T.voiceAnswer("dale", later());
  await tick(5);
  D.onBarge();
  await tick(80);
  assert.equal(inputs().length, 0, "a barge-in stopped it");
  calls = [];
  await readMerge();
  T.voiceAnswer("dale", later());
  await tick(5);
  D.cancelHold(true); // hanging up / leaving the deck
  await tick(80);
  assert.equal(inputs().length, 0, "hanging up stopped it");
});

test("every irreversible kind is held — a deploy, a merge and deploy, a draft — in Spanish and English", async () => {
  const ho = T.handoffItem({ ...sess, id: "s1" }, outcome);
  const kinds = () => [
    { ...ho, key: "k-dep", kind: "deploy", live: true, sid: "s1" },
    { ...ho, key: "k-md2", kind: "merge+deploy", live: true, sid: "s1" },
    { ...T.draftItem({ id: "d5", session_id: "s1", kind: "slack", channel: "#partners", text: "Prices hold until March.", at: "2026-11-09T10:00:00Z" }), key: "k-d5", live: true, sid: "s1" },
  ];
  for (const lang of ["es", "en"]) for (const it of kinds()) {
    calls = []; said = []; mem.clear(); setCtx(lang);
    T.mount([it]);
    T.voiceAnswer("hola", later());
    await tick(5);
    said = [];
    T.voiceAnswer(lang === "es" ? "okey" : "okay", later());
    await tick(5);
    assert.match(said.join(" "), lang === "es" ? /^¿Confirmás / : /^Confirm /, `${lang} ${it.kind}: a weak yes is asked again`);
    assert.equal(T.va().hold, null);
    said = [];
    T.voiceAnswer(lang === "es" ? "dale" : "go ahead", later(1));
    await tick(5);
    assert.match(said.join(" "), lang === "es" ? /Decí cancelar para frenar\.$/ : /Say cancel to stop\.$/, `${lang} ${it.kind}: one line before`);
    assert.equal(inputs().length, 0, `${lang} ${it.kind}: nothing typed inside the window`);
    await tick(80);
    assert.equal(inputs().length, 1, `${lang} ${it.kind}: typed once the window closed`);
    assert.doesNotMatch(JSON.stringify(inputs()), /okey|okay|dale|go ahead/, "what he said never reaches the terminal");
    assert.equal(JSON.parse(mem.get("phone-decided")!)[it.key].how, "confirmed");
  }
});

test("the held yes runs only on the card he heard: changed or gone meanwhile, nothing happens; a tap drops it", async () => {
  // Changed while the window was open (a new PR head, a rewritten hand-off).
  let it = await readMerge();
  T.voiceAnswer("dale", later());
  await tick(5);
  T.mount([{ ...it, rev: "another-rev" }]);
  await tick(80);
  assert.equal(inputs().length, 0, "a yes to what he heard never covers something else");
  assert.match(said.join(" "), /Cambió desde que lo viste/);
  // Gone (decided on the Desk, its terminal closed) — another card is on the deck now.
  calls = []; said = [];
  it = await readMerge();
  T.voiceAnswer("dale", later());
  await tick(5);
  T.mount([{ ...it, key: "k-other" }]);
  await tick(80);
  assert.equal(inputs().length, 0);
  assert.match(said.join(" "), /Esa tarjeta ya no está; no hice nada\./);
  // He taps while it is held: the tap decides, the held yes is dropped — never both.
  calls = []; said = [];
  it = await readMerge();
  T.voiceAnswer("dale", later());
  await tick(5);
  await T.act(it, "later");
  await tick(80);
  assert.equal(inputs().length, 0, "no merge line typed after he tapped Later");
  assert.equal(T.va().hold, null);
});

test("words still on their way when the window closes are waited for; if they never land, nothing happens", async () => {
  await readMerge();
  T.voiceAnswer("dale", later());
  await tick(5);
  voiceState = "transcribing"; // he said something in the last second
  await tick(120);
  assert.equal(inputs().length, 0, "it waits for his words");
  T.voiceAnswer("cancelar", later());
  voiceState = "listening";
  await tick(60);
  assert.equal(inputs().length, 0, "they were a cancel");

  calls = [];
  await readMerge();
  T.voiceAnswer("dale", later());
  await tick(5);
  voiceState = "transcribing";
  await tick(400);
  assert.equal(inputs().length, 0, "they never landed");
  assert.match(said.join(" "), /Cancelado\. No hice nada\./);

  calls = []; voiceState = "listening";
  await readMerge();
  T.voiceAnswer("dale", later());
  await tick(5);
  voiceState = "hearing";
  await tick(80);
  voiceState = "listening"; // the call dropped them (a cough, whisper's silence phantom): the yes stands
  await tick(400);
  assert.equal(inputs().length, 1);
});

test("a yes that overlaps the page's audio, starts before its question ended, or is an echo is ignored", async () => {
  await readMerge();
  const ended = T.va().askEndedAt;
  said = [];
  T.voiceAnswer("sí", { t0: ended + 5, overlap: true });
  T.voiceAnswer("sí", { t0: ended - 200, overlap: false });
  T.voiceAnswer("sí", { t0: ended + 5, overlap: false, echo: true });
  T.voiceAnswer("sí", {}); // no clock at all: never a yes
  await tick(80);
  assert.equal(inputs().length, 0);
  assert.equal(T.va().hold, null, "nothing held");
  assert.match(said.join(" "), /Dejame terminar\./, "it asks again instead");
});

test("a yes while the card is still being read is let go: no restart, no extra line, nothing decided", async () => {
  const it = { ...T.handoffItem({ ...sess, id: "s1" }, outcome), key: "k-m3", live: true, sid: "s1" };
  const pending: Array<() => void> = [];
  const slow = { ...voice, state: () => (pending.length ? "speaking" : "listening"), say: (text: string) => { said.push(text); return new Promise<boolean>((r) => pending.push(() => r(true))); } };
  T.setCtx({ lang: () => "es", api: async () => ({}), input: async (id: string, body: any) => { calls.push({ kind: "input", id, body }); }, sessions: () => [], wsName: () => "atlas", wsColor: () => "#000", voice: slow, toast: () => {}, onChange: () => {}, onOpen: () => {} });
  T.mount([it]);
  T.voiceAnswer("hola", later());          // reading starts; nothing has played yet
  const lines = said.length;
  T.voiceAnswer("sí", { t0: performance.now(), overlap: true });
  await tick(5);
  assert.equal(said.length, lines, "nothing added, nothing restarted");
  for (let i = 0; i < 6; i++) { pending.splice(0).forEach((f) => f()); await tick(1); }
  assert.equal(inputs().length, 0);
  assert.equal(T.va().hold, null);
});

test("a weak yes on a merge is asked once more; a strong one after it is held and recorded as confirmed", async () => {
  await readMerge();
  said = [];
  T.voiceAnswer("bien", later());
  await tick(5);
  assert.match(said.join(" "), /¿Confirmás el merge\?/);
  assert.equal(T.va().hold, null, "a weak yes holds nothing");
  T.voiceAnswer("sí", later(1));
  await tick(80);
  assert.equal(inputs().length, 1);
  const rec = JSON.parse(mem.get("phone-decided")!)["k-m"];
  assert.equal(rec.words, "bien → sí");
  assert.equal(rec.how, "confirmed");
});

test("the next card is read once, even when he speaks over the line that closes the last one", async () => {
  const pending: Array<() => void> = [];
  const slow = { ...voice, say: (text: string) => { said.push(text); return new Promise<boolean>((r) => pending.push(() => r(true))); } };
  const flush = async () => { for (let i = 0; i < 6; i++) { pending.splice(0).forEach((f) => f()); await tick(1); } };
  T.setCtx({ lang: () => "es", api: async () => ({}), input: async () => {}, sessions: () => [], wsName: () => "atlas", wsColor: () => "#000", voice: slow, toast: () => {}, onChange: () => {}, onOpen: () => {} });
  const a = { ...T.handoffItem({ ...sess, id: "s1" }, outcome), key: "k-a", live: true, sid: "s1" };
  const b = { ...T.handoffItem({ ...sess, id: "s2" }, { ...outcome, summary: "The weekly report reads right now.", ask: "review" }), key: "k-b", live: true, sid: "s2" };
  T.mount([a, b]);
  T.voiceAnswer("hola", later());
  await flush();
  T.voiceAnswer("después", later());
  await tick(5);                          // "Te lo dejo para después." is playing…
  T.voiceAnswer("hola", later());         // …he speaks over it: the next card is read now
  await flush();                          // the line ends
  assert.equal(said.filter((x) => /weekly report/.test(x)).length, 1, said.join(" | "));
});

test("question cards are unchanged: a yes/no answered at once, an option by its order", async () => {
  const yn = { ...T.questionItem({ kind: "term", id: "s1", question: "Run the migration now", options: ["Yes", "No"], yn: true, at: 1 }), key: "k-yn2", live: true, sid: "s1" };
  T.setCtx({ ...{ lang: () => "es", wsName: () => "atlas", wsColor: () => "#000", voice, toast: () => {}, onChange: () => {} }, api: async (p: string, o: any = {}) => { calls.push({ kind: "api", path: p, body: o.body && JSON.parse(o.body) }); return {}; }, input: async (id: string, body: any) => { calls.push({ kind: "input", id, body }); }, sessions: () => [{ id: "s1", live: true }] });
  T.mount([yn]);
  T.voiceAnswer("hola", later());
  await tick(5);
  T.voiceAnswer("ok", later());
  await tick(10);
  assert.deepEqual(plain(inputs()), [{ kind: "input", id: "s1", body: { text: "y", enter: true } }], "answered at once, no hold");
  assert.match(said.join(" "), /Le contesté afirmativamente\./, "said back which way, without saying a yes-word");
  calls = [];
  const q = { ...T.questionItem({ kind: "ask", id: "a7", question: "Keep both or switch?", options: ["Keep both for a week", "Switch today"], text: true, at: 1 }), key: "k-q7", live: true };
  T.mount([q]);
  T.voiceAnswer("hola", later());
  await tick(5);
  T.voiceAnswer("la segunda", later());
  await tick(10);
  assert.deepEqual(plain(calls.filter((c) => c.kind === "api")), [{ kind: "api", path: "/asks/a7/answer", body: { answer: "Switch today", by: "operator" } }]);
});

// ── the same deck on a Mac, and the swipe between cards ─────────────────────────────────────────
test("a decision is recorded under the surface it was taken on: desk for a click, desk-voice for a spoken yes", async () => {
  const led = () => ({ ...T.handoffItem(sess, outcome), key: "ledger:i1", src: "ledger", ledger: { item: "i1", request: "r1", target_hash: "sha:abc", bound: true, action: "merge" } });
  const withSurface = (surface?: string) => T.setCtx({ lang: () => "en", surface, api: async (p: string, o: any = {}) => { calls.push({ kind: "api", path: p, body: o.body && JSON.parse(o.body) }); return {}; }, input: async () => {}, sessions: () => [], wsName: () => "atlas", wsColor: () => "#000", voice, toast: () => {}, onChange: () => {}, onOpen: () => {} });
  withSurface("desk");
  await T.decide(led(), "yes");
  await T.decide(led(), "yes", null, null, { voice: true, words: "yes", how: "confirmed" });
  withSurface(undefined);
  await T.decide(led(), "yes");
  assert.deepEqual(calls.map((c) => c.body.by), ["desk", "desk-voice:confirmed", "phone"]);
});

test("a swipe is a swipe only after a clear horizontal intent; a scroll or a diagonal is left to the page", () => {
  assert.equal(T.swipeIntent(6, 2), "wait", "not far enough to say");
  assert.equal(T.swipeIntent(-30, 4), "navigate");
  assert.equal(T.swipeIntent(30, -10), "navigate");
  assert.equal(T.swipeIntent(13, 9), "ignore", "under 1.5× the vertical travel: a diagonal");
  assert.equal(T.swipeIntent(3, 40), "ignore", "a vertical scroll");
  assert.equal(T.swipeIntent(-20, 20), "ignore");
});

test("a released swipe moves one card at most, never past either end, and a small drag snaps back", () => {
  assert.equal(T.swipeTarget(1, 5, -120, 390, 400), 2, "left = next");
  assert.equal(T.swipeTarget(1, 5, 120, 390, 400), 0, "right = previous");
  assert.equal(T.swipeTarget(1, 5, -380, 390, 900), 2, "one step however far");
  assert.equal(T.swipeTarget(1, 5, -50, 390, 600), 1, "a slow short drag snaps back");
  assert.equal(T.swipeTarget(1, 5, -50, 390, 120), 2, "a quick flick goes");
  assert.equal(T.swipeTarget(4, 5, -200, 390, 200), 4, "the last card stays");
  assert.equal(T.swipeTarget(0, 5, 200, 390, 200), 0, "the first card stays");
});

// The smallest DOM a gesture needs: closest() over a class/tag chain, a parent, and scroll sizes.
function node(sel: string, parent: any = null, size: any = {}) {
  const n: any = { sel: sel.split(","), parentElement: parent, scrollWidth: 300, clientWidth: 300, ...size };
  n.classList = { contains: (c: string) => n.sel.includes("." + c) };
  n.closest = (q: string) => { const want = q.split(",").map((x) => x.trim()); for (let x = n; x; x = x.parentElement) if (x.sel.some((s: string) => want.includes(s))) return x; return null; };
  return n;
}
test("a swipe does not start on a button, a field, the before/after compare, a sideways-scrolling block, or outside a card", () => {
  const card = node(".qcard"), scroll = node(".qc-scroll", card);
  assert.equal(T.swipeStartOk(node("p", scroll)), true, "plain card text");
  assert.equal(T.swipeStartOk(node("span", node("button", scroll))), true, "a row that is a button (a check, an option): the swipe may start there, its click is swallowed");
  assert.equal(T.swipeStartOk(node("a", scroll)), false);
  assert.equal(T.swipeStartOk(node("textarea", scroll)), false);
  assert.equal(T.swipeStartOk(node("img", node(".ba", scroll))), false, "the compare slider keeps its own drag");
  assert.equal(T.swipeStartOk(node("code", node("pre", scroll, { scrollWidth: 900, clientWidth: 300 }))), false, "wide code scrolls itself");
  assert.equal(T.swipeStartOk(node("td", node("table", scroll, { scrollWidth: 640, clientWidth: 300 }))), false);
  assert.equal(T.swipeStartOk(node(".dk-head")), false, "not on a card");
  assert.equal(T.swipeStartOk(null), false);
});

test("a full swipe across the deck navigates and calls nothing: no decision, no answer, no terminal input", async () => {
  T.mount([{ ...T.handoffItem(sess, outcome), key: "k1" }, T.questionItem({ kind: "ask", id: "a1", question: "Ship?", options: [], yn: true, at: 1 }), T.draftItem({ id: "d1", session_id: "s9", kind: "slack", channel: "#partners", text: "Hi.", at: "2026-11-09T10:00:00Z" })]);
  const on: Record<string, (e: any) => void> = {};
  const scrolled: any[] = [];
  const track: any = { clientWidth: 390, scrollLeft: 0, style: {}, addEventListener: (t: string, f: any) => { on[t] = f; }, setPointerCapture() {}, scrollTo: (o: any) => { scrolled.push(o); track.scrollLeft = o.left; } };
  T.wireSwipe(track);
  const card = node(".qcard"), text = node("p", node(".qc-scroll", card));
  const ev = (type: string, x: number, y: number, target: any = text) => ({ type, pointerId: 1, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, target });
  // Left: the card follows the finger, then the deck lands on the next one.
  on.pointerdown(ev("pointerdown", 300, 400));
  on.pointermove(ev("pointermove", 292, 401));
  assert.equal(track.scrollLeft, 0, "nothing moves before the intent is clear");
  on.pointermove(ev("pointermove", 180, 404));
  assert.equal(track.scrollLeft, 120, "the card follows the finger");
  assert.equal(track.style.scrollSnapType, "none");
  on.pointerup(ev("pointerup", 150, 404));
  assert.equal(scrolled.at(-1).left, 390, "next card");
  // A vertical drag is the card scrolling: the deck does not move.
  const before = scrolled.length;
  on.pointerdown(ev("pointerdown", 200, 300)); on.pointermove(ev("pointermove", 204, 360)); on.pointermove(ev("pointermove", 60, 420)); on.pointerup(ev("pointerup", 60, 420));
  // Starting on a link, at the screen's edge, or with a mouse: not a swipe. (Yes · Later · Change sit
  // in the bar, outside the track: no swipe can start on them at all.)
  on.pointerdown(ev("pointerdown", 300, 700, node("a", card))); on.pointermove(ev("pointermove", 100, 700)); on.pointerup(ev("pointerup", 100, 700));
  on.pointerdown(ev("pointerdown", 8, 400)); on.pointermove(ev("pointermove", 200, 400)); on.pointerup(ev("pointerup", 200, 400));
  on.pointerdown({ ...ev("pointerdown", 300, 400), pointerType: "mouse" }); on.pointermove(ev("pointermove", 100, 400)); on.pointerup(ev("pointerup", 100, 400));
  assert.equal(scrolled.length, before, "none of those navigated");
  // The browser took the gesture back mid-swipe: the deck returns to the card it was on.
  on.pointerdown(ev("pointerdown", 300, 400)); on.pointermove(ev("pointermove", 150, 400)); on.pointercancel(ev("pointercancel", 150, 400));
  assert.equal(scrolled.at(-1).left, 0, "back to where it started (the mounted deck is on card 0)");
  await tick(5);
  assert.deepEqual(calls, [], "a swipe reaches no endpoint and types into no terminal");
  assert.deepEqual(toasts, [], "and starts no Undo window");
});

test("a double tap on Yes is one decision: the card that slides in under the finger does not answer for a moment", async () => {
  const a = { ...T.handoffItem(sess, outcome), key: "k1" };
  const b = T.draftItem({ id: "d1", session_id: "s9", kind: "slack", channel: "#partners", text: "Hi.", at: "2026-11-09T10:00:00Z" });
  T.mount([a, b]);
  assert.equal(T.settled(), true, "a deck at rest answers");
  void T.act(a, "yes"); // the first tap: the card leaves, its Undo window opens
  assert.equal(T.settled(), false, "the second tap of a double tap lands on a bar that is not armed yet");
  await tick(750);
  assert.equal(T.settled(), true, "and then it answers again");
});

test("a swipe that began on a row button swallows the click that follows it", () => {
  const js = fs.readFileSync(new URL("../static/phone-deck.js", import.meta.url), "utf8");
  assert.match(js, /track\.addEventListener\("click", function \(e\) \{\s*if \(Date\.now\(\) - swiped < 500\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); \}\s*\}, true\);/);
  assert.match(js, /g\.lock = true; clearTimeout\(snapT\); swiped = Date\.now\(\);/);
});
