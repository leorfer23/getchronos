/**
 * The widget contract — the one thing four agents are each writing against at the same time.
 *
 * Half of it lives in static/desk.html, which has no build step and no types, so the assertions read
 * the shipped file: a renamed helper or a dropped ctx key is a widget that fails in the browser and
 * nowhere else. The other half is the registry, which is exercised through the same functions api.ts
 * calls, with the fixture widget (src/widgets/example.ts) registered and removed around the test —
 * nothing a test needs belongs on the operator's board.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import example from "./widgets/example.js";
import { WIDGETS, listWidgets, readWidget, widgetPromptBlock } from "./widgets/index.js";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const html = read("static/desk.html");
const api = read("src/api.ts");

async function withExample<T>(fn: () => Promise<T> | T): Promise<T> {
  WIDGETS.push(example);
  try { return await fn(); } finally { WIDGETS.splice(WIDGETS.indexOf(example), 1); }
}

// ── the registry ────────────────────────────────────────────────────────────────────────────────

test("the two registries agree — every reader has a module on disk, and every module a reader", () => {
  // Was "both registries are empty": true only on the scaffold branch. The invariant that outlives
  // it is that they MATCH — the board mounts a name that is in both, so a name in one alone is a
  // card that 404s or a reader nothing ever reads.
  const board = [...read("static/desk-widgets/index.js").matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...board].sort(), WIDGETS.map((w) => w.name).sort());
  for (const n of board) {
    assert.match(n, /^[a-z0-9-]+$/, `${n} must be a legal name, file and url segment`);
    assert.ok(fs.existsSync(path.join(process.cwd(), `static/desk-widgets/${n}.js`)), `${n}.js is on disk`);
  }
});

test("listWidgets is name/title/topics only — never the reader itself", async () => {
  await withExample(() => {
    const rows = listWidgets();
    assert.deepEqual(rows.at(-1), { name: "example", title: "Example", topics: ["session.started"] });
    for (const r of rows) assert.deepEqual(Object.keys(r), ["name", "title", "topics"]);
  });
});

test("readWidget stamps the read and forwards the query string; unknown is null, not a throw", async () => {
  await withExample(async () => {
    const out = await readWidget("example", { who: "leo" });
    assert.equal(out?.name, "example");
    assert.deepEqual((out?.data as any).hello, "leo");
    assert.ok(!isNaN(Date.parse(out!.at)), "at is an ISO stamp");
    assert.equal(await readWidget("nope"), null);
  });
});

test("a widget that throws throws out of readWidget — api.ts turns that into the card's 500", async () => {
  WIDGETS.push({ name: "boom", title: "Boom", data: () => { throw new Error("no"); } });
  try { await assert.rejects(() => readWidget("boom"), /no/); }
  finally { WIDGETS.pop(); }
});

test("Robert is told about live cards only when there are some, and by name", async () => {
  const shipped = WIDGETS.splice(0, WIDGETS.length);
  try { assert.equal(widgetPromptBlock(), "", "an empty registry offers him nothing"); }
  finally { WIDGETS.push(...shipped); }
  await withExample(() => {
    const block = widgetPromptBlock();
    assert.match(block, /::widget <name>::/);
    assert.match(block, /`::widget example::` — Example/);
  });
  // …and the Desk surface actually carries it into his system prompt.
  assert.match(read("src/telegram/agent.ts"), /personaSystem\("robert", robertPrompt\("web"\).*widgetPromptBlock\(\)\)/);
});

// ── the routes ──────────────────────────────────────────────────────────────────────────────────

test("api.ts serves the two widget routes, admin-only, through the registry", () => {
  assert.match(api, /api\.get\("\/widgets", requireAdmin, \(_req, res\) => res\.json\(listWidgets\(\)\)\)/);
  assert.match(api, /api\.get\("\/widgets\/:name", requireAdmin, async \(req, res\) => \{/);
  assert.match(api, /if \(!out\) return res\.status\(404\)\.json\(\{ error: "unknown widget" \}\)/);
  assert.match(api, /res\.status\(500\)\.json\(\{ error: String\(e\?\.message \?\? e\) \}\)/);
  // Strings only: a widget reads `q.foo`, it never has to defend against express's array shape.
  assert.match(api, /for \(const \[k, v\] of Object\.entries\(req\.query\)\) if \(typeof v === "string"\) q\[k\] = v;/);
});

test("widget modules are served by bare name, no-store, and nothing else can be reached", () => {
  assert.match(api, /app\.get\("\/desk-widgets\/:file", \(req, res\) => \{/);
  assert.match(api, /if \(!\/\^\[a-z0-9-\]\+\\\.js\$\/\.test\(file\)\) return res\.status\(404\)\.end\(\)/);
  assert.match(api, /res\.setHeader\("Cache-Control", "no-store, must-revalidate"\)/);
  // The fixture is on disk under that directory, so the route has something real to serve.
  assert.ok(fs.existsSync(path.join(process.cwd(), "static/desk-widgets/example.js")));
  assert.ok(fs.existsSync(path.join(process.cwd(), "static/desk-widgets/lib.js")));
});

test("the fixture widget is in NEITHER shipped registry", () => {
  assert.doesNotMatch(read("src/widgets/index.ts"), /from "\.\/example\.js"/);
  assert.doesNotMatch(read("static/desk-widgets/index.js"), /example/);
});

// ── the page ────────────────────────────────────────────────────────────────────────────────────

test("ctx is exactly the ten keys the README documents", () => {
  assert.match(
    html,
    /window\.DeskWidgets = \{ S, api, esc, chipLabel, toast, stage: \(id\) => select\(id\), pickWs, wsName, wsColor, byId \};/,
  );
});

test("mountWidget builds the card the CSS styles, and never throws on a bad widget", () => {
  assert.match(html, /async function mountWidget\(name, host, opts = \{\}\) \{/);
  assert.match(html, /card\.className = "widget";\s*card\.dataset\.w = name;/);
  assert.match(html, /<header><h3><\/h3><time><\/time><button class="icon" title="Refresh">↻<\/button><\/header><div class="wbody"><\/div>/);
  assert.match(html, /if \(!mod\) \{ w\.body\.innerHTML = `<div class="werr">no widget called/);
  assert.match(html, /w\.body\.innerHTML = `<div class="werr">\$\{esc\(errMsg\(e\)\)\}<\/div>`/);
  assert.match(html, /w\.mod\.render\(w\.body, r\.data, window\.DeskWidgets\)/);
});

test("a card off screen does not poll", () => {
  assert.match(html, /new IntersectionObserver\(\(es\) => \{/);
  assert.match(html, /if \(!w\.seen \|\| document\.visibilityState === "hidden"\) return;/);
  assert.match(html, /w\.timer = setTimeout\(\(\) => dwTick\(w\), Math\.max\(2000, Number\(w\.mod\.refreshMs\) \|\| 30000\)\)/);
  assert.match(html, /document\.addEventListener\("visibilitychange", \(\) => \{ for \(const w of DW\.cards\) dwTick\(w\); \}\)/);
});

test("the bus refreshes cards by topic — one dispatch line, and a socket that resubscribes", () => {
  assert.match(html, /if \(DW\.topics\.has\(e\.topic\)\) dwBus\(e\.topic\);/);
  assert.match(html, /encodeURIComponent\(\[BUS_TOPICS, \.\.\.DW\.extra\]\.join\(","\)\)/);
  assert.match(html, /if \(grew\) \{ try \{ DW\.sock\?\.close\(\); \} catch \{\} \}/);
  assert.match(html, /for \(const w of DW\.cards\) if \(w\.seen && w\.mod\?\.topics\?\.some\(\(t\) => hit\.includes\(t\)\)\) dwRefresh\(w\);/);
});

test("Fleet is the third view of the stage: a segment button, ⌘⇧F, and the same localStorage key", () => {
  assert.match(html, /<button data-m="fleet" title="The board: live widgets for the whole desk \(⌘⇧F\)">Fleet<\/button>/);
  assert.match(html, /<div class="fleet" id="fleet"><\/div>/);
  assert.match(html, /e\.key\.toLowerCase\(\) === "f"\) \{ e\.preventDefault\(\); return setMode\(S\.mode === "fleet" \? S\.preFleet : "fleet"\); \}/);
  assert.match(html, /localStorage\.setItem\("desk-mode", S\.mode\)/);
  assert.match(html, /mode: \["term", "fleet"\]\.includes\(localStorage\.getItem\("desk-mode"\)\)/);
  assert.match(html, /document\.body\.classList\.toggle\("mode-fleet", S\.mode === "fleet"\)/);
  assert.match(html, /body\.mode-fleet \.fleet \{ display:block; \}/);
});

test("picking a terminal leaves the board; an empty Desk opens on it once, only if there are widgets", () => {
  assert.match(html, /if \(S\.mode === "fleet"\) setMode\("focus"\);/);
  assert.match(html, /if \(!DW\.auto && DW\.names\.length\) \{ DW\.auto = true; if \(S\.mode !== "fleet"\) setMode\("fleet"\); \}/);
  // No widgets at all: the empty Desk is still Robert, full width, exactly as before.
  assert.match(html, /body\.no-terms:not\(\.mode-fleet\) \.stage \{ display:none; \}/);
  assert.match(html, /host\.innerHTML = '<div class="empty">no widgets yet<\/div>'/);
});

test("a `::widget name::` line in one of his replies becomes a card, once per bubble", () => {
  assert.match(html, /const WIDGET_LINE = \/\^::widget \(\[a-z0-9-\]\+\)::\$\//);
  assert.match(html, /if \(!m \|\| qs\('\.widget\[data-w="' \+ m\[1\] \+ '"\]', bub\)\) continue;/);
  // Drawn where the bubble is drawn, and nowhere near the composer.
  assert.match(html, /d\.innerHTML = mdChat\(text\);\s*d\._raw = text;\s*dwEmbed\(d\);/);
});

test("the card uses the page's own tokens and never animates", () => {
  const css = html.match(/\.widget \{[^}]+\}/)?.[0] ?? "";
  assert.match(css, /background:var\(--surface\)/);
  assert.match(css, /border:1px solid var\(--line\)/);
  assert.match(css, /box-shadow:var\(--shadow\)/);
  assert.match(css, /border-radius:1[012]px/);
  assert.match(html, /\.wbody \{[^}]*font-variant-numeric:tabular-nums/);
  // The page's only clock is the 1Hz body.blink class (see .ph.working). Nothing here spins.
  const block = html.slice(html.indexOf("── the Fleet board"), html.indexOf(".bub .widget"));
  assert.doesNotMatch(block, /@keyframes|animation:|animation-name:|transition:/);
});
