/**
 * The Desk's artifacts list (static/desk-artifacts.js), run in a vm the way the page runs it: each sort
 * puts pages where it says, the operator's own order survives new pages, a filter and the client lock,
 * and nothing an agent wrote into a page's title reaches the Desk as markup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ctx: any = {};
vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), "static/desk-artifacts.js"), "utf8"), ctx);
const A = ctx.DeskArtifacts;

const page = (id: string, o: Record<string, unknown> = {}) => ({
  id, title: id, workspace_id: "ws-a", created_by: "terminal " + id, ask_id: null, status: "open", version: 1,
  created_at: "2026-11-10T10:00:00Z", updated_at: "2026-11-10T10:00:00Z", ...o,
});
const rows = [
  page("b", { title: "Plan b", workspace_id: "ws-b", created_at: "2026-11-12T10:00:00Z", updated_at: "2026-11-12T10:00:00Z" }),
  page("a", { title: "plan A", created_at: "2026-11-11T10:00:00Z", updated_at: "2026-11-15T10:00:00Z" }),
  page("c", { title: "Plan 10", workspace_id: null, created_at: "2026-11-13T10:00:00Z", updated_at: "2026-11-13T10:00:00Z" }),
  page("d", { title: "Plan 9", created_at: "2026-11-09T10:00:00Z", updated_at: "2026-11-09T10:00:00Z" }),
];
const names: Record<string, string> = { "ws-a": "Zeta", "ws-b": "Acme" };
const wsName = (id: string | null) => (id ? names[id] || "" : "");
const ids = (list: any[]) => Array.from(list, (r: any) => r.id).join("");

test("each sort puts pages where it says", () => {
  assert.equal(ids(A.order(rows, "recent")), "acbd", "latest activity first: a was answered/updated last");
  assert.equal(ids(A.order(rows, "new")), "cbad", "by when it was published");
  assert.equal(ids(A.order(rows, "az")), "dcab", "A–Z ignores case and reads numbers as numbers (9 before 10, digits before letters)");
  assert.equal(ids(A.order(rows, "project", [], wsName)), "badc", "by project name, then recent; no project last");
  assert.equal(ids(A.order(rows, "nonsense")), "acbd", "an unknown sort is Recent");
  assert.equal(A.mode("az"), "az");
  assert.equal(A.mode("<x>"), "recent");
  assert.equal(ids(rows), "bacd", "sorting never touches the list it was given");
});

test("Mine: the saved order, with a page published since on top", () => {
  assert.equal(ids(A.order(rows, "mine", ["d", "a", "b", "c"])), "dabc");
  assert.equal(ids(A.order(rows, "mine", ["a", "b"])), "cdab", "c and d are not placed yet: on top, newest first");
  assert.equal(ids(A.order(rows, "mine", [])), "cbad", "nothing placed yet reads like New");
  assert.equal(ids(A.order(rows, "mine", ["gone", "b", "b", "a"])), "cdba", "an id for a page that is gone, or twice, changes nothing");
  assert.deepEqual(Array.from(A.saved(["a", 3, null, "", "b"])), ["a", "b"], "only ids survive what storage handed back");
  assert.deepEqual(Array.from(A.saved("x")), []);
});

test("a drop moves one page and leaves the rest where they were", () => {
  const shown = ["a", "b", "c", "d"];
  assert.deepEqual(Array.from(A.drop([], shown, "d", "a", false)), ["d", "a", "b", "c"], "before the first");
  assert.deepEqual(Array.from(A.drop([], shown, "a", "c", true)), ["b", "c", "a", "d"], "after a row");
  assert.deepEqual(Array.from(A.drop([], shown, "a", "d", true)), ["b", "c", "d", "a"], "after the last");
  assert.deepEqual(Array.from(A.drop([], shown, "b", "b", true)), shown, "onto itself: nothing moves, the order on screen is kept");
  assert.deepEqual(Array.from(A.drop(["x"], shown, "zz", "a", false)), ["x"], "a page that is not on screen is not dropped");
});

test("pages not on screen keep their places — a filter or the client lock never reshuffles them", () => {
  // Saved: a h1 b h2 c — h1/h2 are filtered out (or another client's under the lock).
  const mine = ["a", "h1", "b", "h2", "c"];
  assert.deepEqual(Array.from(A.drop(mine, ["a", "b", "c"], "c", "a", false)), ["c", "h1", "a", "h2", "b"]);
  // A page published since (n) shows on top in Mine; moving it keeps every hidden one in place.
  assert.deepEqual(Array.from(A.drop(mine, ["n", "a", "b", "c"], "n", "b", true)), ["a", "b", "h1", "n", "h2", "c"]);
});

test("dragging in another sort makes what is on screen the order", () => {
  const shown = ids(A.order(rows, "az")).split("");
  const mine = A.drop([], shown, "b", "a", false);
  assert.equal(ids(A.order(rows, "mine", mine)), "dcba", "A–Z was d c a b; b dropped before a");
});

test("find: every word, in the title, who made it or the project — case and accents ignored", () => {
  const r = page("x", { title: "Migración del catálogo", created_by: "Rediseño checkout", workspace_id: "ws-b" });
  assert.ok(A.matches(r, "", wsName));
  assert.ok(A.matches(r, "  migracion  CATALOGO ", wsName));
  assert.ok(A.matches(r, "rediseno", wsName));
  assert.ok(A.matches(r, "acme catalogo", wsName), "the project's name counts");
  assert.ok(!A.matches(r, "catalogo zeta", wsName), "every word must match");
});

test("a row: what it is, where it is from, whether it waits on you", () => {
  const h = { wsBit: (id: string) => `<span class="ws">${id}</span>`, who: (n: string) => n.toUpperCase(), now: Date.parse("2026-11-16T12:00:00Z") };
  const ask = A.row(page("q1", { title: "Pick one", ask_id: "k1", version: 3, updated_at: "2026-11-16T09:00:00Z" }), h, "recent");
  assert.match(ask, /data-agid="q1"/);
  assert.match(ask, /draggable="true"/);
  assert.match(ask, /class="lp-ico ask"[^>]*>\?</);
  assert.match(ask, /<span class="ws">ws-a<\/span>/);
  assert.match(ask, /TERMINAL Q1/, "the publisher goes through the assistant-name hook");
  assert.match(ask, /waiting on you/);
  assert.match(ask, /v3/);
  assert.match(ask, /3h ago/);

  const answered = A.row(page("q2", { ask_id: "k2", status: "answered" }), h, "new");
  assert.match(answered, /class="lp-ico done"[^>]*>✓</);
  assert.match(answered, /<span>answered<\/span>/);
  assert.match(answered, /published 6d ago/, "New shows when it was published");
  assert.doesNotMatch(answered, /waiting on you/);

  const plain = A.row(page("p1"), h, "project");
  assert.match(plain, /class="lp-ico"[^>]*>▤</);
  assert.doesNotMatch(plain, /class="ws"/, "under a project header the row does not repeat the project");
  assert.doesNotMatch(plain, />v1</, "a first version is not worth a word");
});

test("Project puts a header with its count above each project", () => {
  const html = A.render(A.order(rows, "project", [], wsName), "project", { wsName });
  const heads = [...html.matchAll(/<div class="lp-sec">([^<]*)<span class="n">(\d+)<\/span>/g)].map((m) => m[1] + ":" + m[2]);
  assert.deepEqual(heads, ["Acme:1", "Zeta:2", "No project:1"]);
  assert.doesNotMatch(A.render(rows, "recent", {}), /lp-sec/, "only Project has headers");
});

test("nothing a page carries reaches the Desk as markup", () => {
  const html = A.render(
    [page('"><img src=x onerror=alert(1)>', { title: "<script>bad()</script>", created_by: "a & <b>b</b>", workspace_id: "<i>w</i>" })],
    "project",
    { wsName: (id: string) => id },
  );
  assert.doesNotMatch(html, /<img|<script|<b>b|<i>w/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /a &amp; &lt;b&gt;b&lt;\/b&gt;/);
  assert.match(html, /data-agid="&quot;&gt;&lt;img/);
});
