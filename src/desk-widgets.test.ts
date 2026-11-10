/**
 * The widget contract — the one thing four agents are each writing against at the same time.
 *
 * The registry, exercised through the same functions api.ts calls, with the fixture widget (src/widgets/example.ts) registered and removed around the test —
 * nothing a test needs belongs on the operator's board.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import example from "./widgets/example.js";
import { WIDGETS, listWidgets, readWidget, widgetPromptBlock } from "./widgets/index.js";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

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
});

// ── the routes ──────────────────────────────────────────────────────────────────────────────────

// ── the page ────────────────────────────────────────────────────────────────────────────────────

