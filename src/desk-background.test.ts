import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// The Desk's rail split (src/background.ts): a terminal whose status says `background` sits under the
// Background fold, never on the rail, never in the counts, never in an OS notification. The functions
// are lifted out of desk.html and run against a stub S, the way the page runs them.
const desk = fs.readFileSync(path.join(process.cwd(), "static", "desk.html"), "utf8");
const from = desk.indexOf("const railWs = ");
const to = desk.indexOf("\n", desk.indexOf("const bgOrder = "));
assert.ok(from > 0 && to > from, "the rail order block is where this test looks for it");

function lift(sessions: any[]) {
  const S = { sessions, dismissed: new Set<string>() };
  const wsName = (id: string) => ({ a: "Alpha", b: "Beta" } as Record<string, string>)[id] ?? "";
  return new Function("S", "wsName", desk.slice(from, to) + "\nreturn { railOrder, bgOrder, bgOf };")(S, wsName) as {
    railOrder: () => any[]; bgOrder: () => any[]; bgOf: (s: any) => boolean;
  };
}
let n = 0;
const row = (id: string, o: Record<string, unknown> = {}) =>
  ({ id, live: true, workspace_id: "a", created_at: new Date(Date.UTC(2026, 10, 16, 0, n++)).toISOString(), status: { phase: "working" }, ...o });

test("a background terminal is under the fold, not on the rail; one that needs you is on the rail", () => {
  const { railOrder, bgOrder } = lift([
    row("mine"),
    row("jobcheck", { status: { phase: "working", background: true } }),
    row("inbox-asks", { status: { phase: "decide" } }),
    row("ended-bg", { live: false, status: { phase: "ended", background: true } }),
  ]);
  assert.deepEqual(railOrder().map((s) => s.id), ["mine", "inbox-asks"]);
  assert.deepEqual(bgOrder().map((s) => s.id), ["jobcheck"]);
});

test("the moment the daemon drops `background`, the row moves back up", () => {
  const s = row("jobcheck", { status: { phase: "working", background: true } });
  const { railOrder, bgOrder, bgOf } = lift([s]);
  assert.equal(bgOf(s), true);
  s.status = { phase: "decide" } as any;
  assert.deepEqual(railOrder().map((x) => x.id), ["jobcheck"]);
  assert.deepEqual(bgOrder(), []);
});

test("counts, the OS notification and the 30s repaint read the same split", () => {
  assert.match(desk, /function renderCounts\(\) \{\n  const live = S\.sessions\.filter\(\(s\) => s\.live && !S\.dismissed\.has\(s\.id\) && !bgOf\(s\)\);/);
  assert.match(desk, /function attention\(s\) \{\n  if \(!s\.live \|\| S\.dismissed\.has\(s\.id\) \|\| bgOf\(s\)\) return;/);
  assert.match(desk, /for \(const s of \[\.\.\.railOrder\(\), \.\.\.bgOrder\(\)\]\) repaintRow\(s\.id\)/);
});
