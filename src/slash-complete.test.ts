/**
 * `/` in a terminal's composer (static/slash-complete.js), run as shipped: the file is loaded into a vm
 * with a few stubs for the DOM it touches, the way desk-companion.test.ts runs its script — so these
 * assertions and the page read the same source. Covers the pure pieces (where `/` counts, ranking, keys,
 * what a pick leaves in the composer, the chip's panel) and the list on a live input, sharing it with
 * `#` (static/tag-complete.js) without the two ever opening or taking a key at the same time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const src = (f: string) => fs.readFileSync(path.join(process.cwd(), "static", f), "utf8");
const plain = (v: any) => JSON.parse(JSON.stringify(v));

// ── the DOM, as much of it as the two scripts use ──
type Listener = { type: string; fn: (e: any) => void; capture: boolean };
class El {
  listeners: Listener[] = [];
  parentElement: El | null = null;
  children: El[] = [];
  hidden = false;
  className = "";
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  value = "";
  selectionStart = 0;
  selectionEnd = 0;
  innerHTML = "";
  constructor(public doc: any) {}
  appendChild(c: El) { c.parentElement = this; this.children.push(c); return c; }
  addEventListener(type: string, fn: (e: any) => void, capture?: any) { this.listeners.push({ type, fn, capture: capture === true || capture?.capture === true }); }
  dispatchEvent(e: any) {
    e.target ??= this;
    for (const phase of [true, false]) for (const l of [...this.listeners]) {
      if (l.type !== e.type || l.capture !== phase) continue;
      l.fn(e);
      if (e.stopped) return true;
    }
    return true;
  }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  querySelector(sel: string) { return sel === ".on" && this.innerHTML.includes('class="on"') ? { scrollIntoView() {} } : null; }
  setSelectionRange(a: number, b: number) { this.selectionStart = a; this.selectionEnd = b; }
  focus() { this.doc.activeElement = this; }
}
const mkEvent = (type: string, o: Record<string, unknown> = {}) => ({
  type, defaultPrevented: false, stopped: false, ...o,
  preventDefault() { this.defaultPrevented = true; },
  stopImmediatePropagation() { this.stopped = true; },
  stopPropagation() {},
});

function page() {
  const doc: any = { activeElement: null, head: { insertAdjacentHTML() {} } };
  doc.createElement = () => new El(doc);
  const window: any = {};
  const ctx: any = {
    window, document: doc, setTimeout, clearTimeout, Promise,
    getComputedStyle: () => ({ position: "static" }),
    Event: class { constructor(type: string) { Object.assign(this, mkEvent(type)); } },
  };
  vm.runInNewContext(src("slash-complete.js"), ctx);
  vm.runInNewContext(src("tag-complete.js"), ctx);
  const host = new El(doc);
  const input = host.appendChild(new El(doc));
  return { doc, window, input, host, SC: window.SlashComplete, TC: window.TagComplete };
}

const { SC } = page();
const L = SC.logic;

const ITEMS = [
  { group: "builtin", name: "compact", insert: "/compact ", desc: "Free up context", hint: "[instructions]" },
  { group: "builtin", name: "context", insert: "/context ", desc: "Context grid", opens: "terminal" },
  { group: "builtin", name: "code-review", insert: "/code-review ", desc: "Review a diff" },
  { group: "skill", name: "commit-helper", insert: "/commit-helper ", desc: "Commits", from: "user" },
  { group: "skill", name: "pdf", insert: "/pdf ", desc: "PDFs", from: "project" },
  { group: "command", name: "frontend:component", insert: "/frontend:component ", desc: "A component" },
  { group: "plugin", name: "superpowers:brainstorm", insert: "/superpowers:brainstorm ", desc: "Ideas", from: "superpowers" },
];

test("where `/` counts: the very first character, nothing but the word before the caret", () => {
  assert.deepEqual(plain(L.slashQuery("/", 1)), { q: "", end: 1 });
  assert.deepEqual(plain(L.slashQuery("/Com", 4)), { q: "com", end: 4 });
  assert.deepEqual(plain(L.slashQuery("/co rest", 3)), { q: "co", end: 3 });
  assert.deepEqual(plain(L.slashQuery("/compact", 3)), { q: "co", end: 8 }, "a caret mid-word replaces the whole word");
  for (const [v, c] of [["", 0], [" /x", 3], ["a /x", 4], ["/x y", 4], ["fix #/x", 7]] as const) assert.equal(L.slashQuery(v, c), null, `${v}|${c}`);
});

test("ranking: groups by their best match, best rows first; a word of a name counts; no match, nothing", () => {
  const names = (q: string) => plain(L.rank(ITEMS, q).map((i: any) => i.name));
  assert.deepEqual(names(""), ["code-review", "compact", "context", "commit-helper", "pdf", "frontend:component", "superpowers:brainstorm"]);
  assert.deepEqual(names("pdf"), ["pdf"]);
  assert.deepEqual(names("brain"), ["superpowers:brainstorm"], "a word of a namespaced name");
  assert.deepEqual(names("rev"), ["code-review"]);
  assert.deepEqual(names("com").slice(0, 3), ["compact", "commit-helper", "frontend:component"], "prefix matches lead their groups; the skill group follows the built-ins it ties");
  assert.deepEqual(names("zzz"), []);
});

test("keys: ↑ ↓ move, ⏎ ⇥ pick, ⎋ closes; a chord, ⇧⏎ or an IME composing is never the list's", () => {
  const k = (key: string, o: Record<string, unknown> = {}) => L.keyAction({ key, ...o });
  assert.equal(k("ArrowDown"), "down");
  assert.equal(k("ArrowUp"), "up");
  assert.equal(k("Enter"), "pick");
  assert.equal(k("Tab"), "pick");
  assert.equal(k("Escape"), "close");
  for (const [key, o] of [["Enter", { shiftKey: true }], ["Enter", { metaKey: true }], ["Enter", { ctrlKey: true }], ["Tab", { shiftKey: true }], ["Enter", { isComposing: true }], ["a", {}]] as const)
    assert.equal(k(key, o), null, `${key} ${JSON.stringify(o)}`);
});

test("a pick replaces the word and keeps what followed; the panel puts its pick first and keeps a draft as its words", () => {
  assert.deepEqual(plain(L.applyPick("/com", 4, "/compact ")), { value: "/compact ", caret: 9 });
  assert.deepEqual(plain(L.applyPick("/com   the auth bug", 4, "/compact ")), { value: "/compact the auth bug", caret: 9 });
  assert.deepEqual(plain(L.placeAtStart("", "/review ")), { value: "/review ", caret: 8 });
  assert.deepEqual(plain(L.placeAtStart("fix the bug", "/review ")), { value: "/review fix the bug", caret: 19 });
  assert.equal(L.placeAtStart("/old with args", "/review ").value, "/review with args", "a command already there is replaced");
  assert.equal(L.placeAtStart("$pdf x", "/review ").value, "/review x");
  assert.equal(L.placeAtStart("/Users/x/Screen.png look", "/review ").value, "/review /Users/x/Screen.png look", "a dropped path is not a command");
});

test("a model switch is its own line: into an empty composer or over a command, never over a draft", () => {
  assert.deepEqual(plain(L.placeModel("", "/model sonnet")), { value: "/model sonnet", caret: 13 });
  assert.equal(L.placeModel("/compact", "/model sonnet").value, "/model sonnet");
  assert.equal(L.placeModel("fix the login", "/model sonnet"), null);
  assert.equal(L.modelLine("/model {model}", "haiku"), "/model haiku");
  assert.equal(L.modelLine("/models", "haiku"), "/models", "a CLI whose switch is its own picker");
});

test("rows: the active one says what it does; terminal-only and project ones are tagged; names and words are escaped", () => {
  const html = L.rowsHtml([...ITEMS.slice(0, 2), { group: "skill", name: "x", insert: "/x ", desc: '<img src=x onerror="alert(1)">', from: "project" }], 1);
  assert.match(html, /<div class="h">Built-in<\/div>/);
  assert.match(html, /data-i="1" class="on" aria-selected="true"><span class="w">in terminal<\/span><span class="n">\/context<\/span>/);
  assert.match(html, /<span class="w">project<\/span><span class="n">\/x<\/span>/);
  assert.ok(!html.includes("<img"), "a description is text, never markup");
});

test("the chip's panel: model chips with the CLI's own switch, the account, sections, MCP — a draft holds the switch back", () => {
  const d = { backend: "claude-code", cli: { label: "Claude Code" }, model: "opus", models: ["sonnet", "opus"], switch_model: "/model {model}", profile: "claude-acme", items: ITEMS, plugins: ["superpowers"], mcp: ["fff", "slack"], notes: [] };
  const html = L.panelHtml(d, {});
  assert.match(html, /<b>opus<\/b><span>Claude Code<\/span><span>account claude-acme<\/span>/);
  assert.match(html, /data-model="\/model sonnet" title="Puts \/model sonnet in the composer — send it to switch">sonnet</);
  assert.match(html, /data-model="\/model opus" class="cur" disabled>opus</, "the current model is not a choice");
  assert.match(html, /<summary>Skills <span class="c">2<\/span><\/summary>/);
  assert.match(html, /data-ins="\/frontend:component "/);
  assert.match(html, /<b>MCP<\/b> fff · slack/);
  assert.ok(!html.includes("Built-in"), "the panel is for what the profile adds; `/` has the built-ins");
  assert.match(L.panelHtml(d, { draft: true }), /data-model="\/model sonnet" disabled title="Send or clear/);
  assert.match(L.panelHtml({ ...d, switch_model: "/model", models: ["auto"] }, {}), /data-model="\/model"[^>]*>Pick a model in the terminal</);
  assert.match(L.panelHtml(null, { error: "Couldn't <load>" }), /Couldn&#39;t &lt;load&gt;/);
});

// ── on a live input ──
const flush = () => new Promise((r) => setTimeout(r, 5));
function live(items = ITEMS) {
  const p = page();
  let fetched = 0;
  const sent: string[] = [];
  const ctl = p.SC.attach(p.input, { session: () => "s1", fetch: async () => { fetched++; return { items }; } });
  p.TC(p.input, () => [{ slug: "acme", name: "Acme" }, { slug: "initech", name: "Initech" }]);
  // The composer's own handler, registered after both (bubble): ⏎ sends.
  p.input.addEventListener("keydown", (e: any) => { if (e.key === "Enter" && !e.shiftKey) sent.push(p.input.value); });
  p.input.focus();
  // A keystroke's input event is trusted; one the page dispatches itself is not.
  const type = (v: string, caret = v.length) => { p.input.value = v; p.input.selectionStart = p.input.selectionEnd = caret; p.input.dispatchEvent(mkEvent("input", { isTrusted: true })); };
  const key = (k: string, o: Record<string, unknown> = {}) => { const e = mkEvent("keydown", { key: k, ...o }); p.input.dispatchEvent(e); return e; };
  const [slash, tag] = p.host.children.slice(1);
  const active = () => /data-i="(\d+)" class="on"/.exec(slash.innerHTML)?.[1] ?? null;
  return { ...p, ctl, type, key, slash, tag, active, sent, fetched: () => fetched };
}

test("the list loads once per terminal on the first `/`, filters as you type, and ⏎ inserts instead of sending", async () => {
  const t = live();
  t.type("/");
  await flush();
  assert.equal(t.fetched(), 1);
  assert.equal(t.slash.hidden, false);
  assert.ok(t.slash.innerHTML.includes("/compact") && t.slash.innerHTML.includes("/superpowers:brainstorm"));
  t.type("/con");
  assert.equal(t.fetched(), 1, "typing filters what is loaded");
  assert.ok(t.slash.innerHTML.includes("/context") && !t.slash.innerHTML.includes("/pdf"));
  t.type("/co");
  assert.equal(t.active(), "0");
  t.key("ArrowDown");
  assert.equal(t.active(), "1");
  t.key("ArrowUp"); t.key("ArrowUp");
  assert.equal(t.active(), String(L.rank(ITEMS, "co").length - 1), "↑ from the top wraps to the bottom");
  t.key("ArrowDown");
  const e = t.key("Enter");
  assert.ok(e.defaultPrevented && e.stopped);
  assert.equal(t.input.value, "/code-review ");
  assert.deepEqual(t.sent, [], "⏎ on the list picks; it does not send");
  assert.equal(t.slash.hidden, true);
  t.key("Enter");
  assert.deepEqual(t.sent, ["/code-review "], "the next ⏎ is the composer's again");
});

test("⎋ closes it until the text changes; a tap picks; no match closes it and ⏎ sends what was typed", async () => {
  const t = live();
  t.type("/pd");
  await flush();
  assert.equal(t.slash.hidden, false);
  t.key("Escape");
  assert.equal(t.slash.hidden, true);
  t.input.dispatchEvent(mkEvent("click"));
  assert.equal(t.slash.hidden, true, "a click on the same text does not reopen what ⎋ closed");
  t.type("/p");
  assert.equal(t.slash.hidden, false);
  t.slash.dispatchEvent(mkEvent("pointerdown", { target: { closest: () => ({ dataset: { i: "0" } }) } }));
  assert.equal(t.input.value, "/pdf ");
  t.type("/nothing-like-it");
  assert.equal(t.slash.hidden, true);
  t.key("Enter");
  assert.deepEqual(t.sent, ["/nothing-like-it"]);
});

test("a draft the page puts back (walking to another terminal) never opens the list; a click into it does", async () => {
  const t = live();
  t.type("/co");
  await flush();
  t.key("Escape");
  t.input.value = "/compact"; t.input.selectionStart = 8;
  t.input.dispatchEvent(mkEvent("input"));
  assert.equal(t.slash.hidden, true, "restored, not typed");
  t.input.dispatchEvent(mkEvent("click"));
  assert.equal(t.slash.hidden, false, "the operator clicking into it is asking");
});

test("`/` and `#` share a composer: one list at a time, and each takes keys only while its own list is open", async () => {
  const t = live();
  t.type("/rev");
  await flush();
  assert.equal(t.slash.hidden, false);
  assert.equal(t.tag.hidden, true, "`#` stays shut on a command");
  t.type("/review #ac");
  assert.equal(t.slash.hidden, true, "past the command word, `/` is done");
  assert.equal(t.tag.hidden, false, "and `#` names a project");
  t.key("Enter");
  assert.equal(t.input.value, "/review #acme ", "⏎ went to `#`, which owns it now");
  assert.deepEqual(t.sent, []);
  t.type("#ac");
  assert.equal(t.slash.hidden, true);
  assert.equal(t.tag.hidden, false);
});

test("a terminal with nothing to list never opens a list, and a failed load says so instead of hanging", async () => {
  const empty = live([]);
  empty.type("/");
  await flush();
  assert.equal(empty.slash.hidden, true);
  const p = page();
  p.SC.attach(p.input, { session: () => "s2", fetch: async () => { throw new Error("401 token"); } });
  p.input.focus();
  p.input.value = "/"; p.input.selectionStart = 1;
  p.input.dispatchEvent(mkEvent("input", { isTrusted: true }));
  await flush();
  const menu = p.host.children[1];
  assert.equal(menu.hidden, false);
  assert.match(menu.innerHTML, /Couldn&#39;t load this terminal&#39;s commands — 401 token/);
});

// The one rule kept as text, because the text is the rule (CLAUDE.md "Desk CSS"): theme tokens, no motion.
test("its CSS and the Desk's chip: theme tokens only, no literal colour, no animation or transition", () => {
  const js = src("slash-complete.js");
  const at = js.indexOf("const css = `");
  const css = js.slice(at, js.indexOf("`;", at));
  const html = src("desk.html");
  const chip = html.slice(html.indexOf("── the composer's chip"), html.indexOf("── the companion"));
  for (const [name, block] of [["slash-complete.js", css], ["desk.html chip", chip]] as const) {
    assert.ok(block.length > 300, `${name}: the block is where this test looks for it`);
    assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, `${name}: no literal colours`);
    assert.doesNotMatch(block, /animation|transition|@keyframes/, `${name}: no motion`);
  }
});

// ── a slash command's answer: the terminal's own frame (the Desk's Talk peek, the phone's sheet) ──
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a line its CLI runs itself is a command; a path, prose or a bare slash is not", () => {
  for (const t of ["/status", "/doctor", " /compact keep the plan ", "/model sonnet", "/frontend:component x"]) assert.equal(SC.isCommandLine(t), true, t);
  for (const t of ["", "status", "/Users/leo/a.png is the screenshot", "fix /status", "/ alone", "//x"]) assert.equal(SC.isCommandLine(t), false, t);
});

test("the peek shows the bottom of the frame: trailing blanks off, at most 60 lines", () => {
  assert.equal(L.peekText(["Status  ", "", "Esc to cancel", "", ""]), "Status\n\nEsc to cancel");
  assert.equal(L.peekText(null), "");
  const many = Array.from({ length: 80 }, (_, i) => "l" + i);
  assert.equal(L.peekText(many).split("\n").length, 60);
  assert.equal(L.peekText(many, 3), "l77\nl78\nl79");
});

test("watchScreen: a frame only when it moved; a key looks again at once; a terminal that ended stops it", async () => {
  const calls: string[] = [];
  const frames: string[][] = [];
  let seq = 4, gone = false, ended = 0;
  const fetcher = async (url: string) => {
    calls.push(url);
    if (gone) return { screens: [], gone: ["t1"] };
    const since = Number(/since=t1:(-?\d+)$/.exec(url)![1]);
    return since === seq ? { screens: [], gone: [] } : { screens: [{ id: "t1", seq, cols: 80, rows: 3, lines: ["Status", "Esc to cancel"] }], gone: [] };
  };
  const w = SC.watchScreen("t1", fetcher, { onFrame: (l: string[]) => frames.push(plain(l)), onGone: () => ended++ }, () => false);
  await wait(40);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], ["Status", "Esc to cancel"]);
  assert.match(calls[0], /^\/desk\/screens\?ids=t1&since=t1:-1$/, "the first ask always gets the frame");
  w.soon(); await wait(220);
  assert.equal(frames.length, 1, "an unchanged frame is not handed over again");
  assert.match(calls.at(-1)!, /since=t1:4$/);
  seq = 5; w.soon(); await wait(220);
  assert.equal(frames.length, 2, "a moved frame is");
  gone = true; w.soon(); await wait(220);
  assert.equal(ended, 1);
  const n = calls.length;
  await wait(700);
  assert.equal(calls.length, n, "nothing more is asked once the terminal ended");
  w.stop();
});

test("watchScreen: a hidden page does not ask, and stop() ends it", async () => {
  let calls = 0;
  const hidden = SC.watchScreen("t2", async () => { calls++; return { screens: [], gone: [] }; }, {}, () => true);
  await wait(60);
  assert.equal(calls, 0, "hidden: no request");
  hidden.stop();
  const w = SC.watchScreen("t3", async () => { calls++; return { screens: [], gone: [] }; }, {}, () => false);
  await wait(40);
  w.stop();
  const n = calls;
  await wait(700);
  assert.equal(calls, n, "stopped: no request");
  assert.ok(n >= 1);
});
