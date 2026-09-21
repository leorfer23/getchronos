import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, jots, workspaces } from "./store.js";
import { jotWritePolicy } from "./jots.js";
import { deskSeed } from "./terminal.js";

beforeEach(() => {
  db.exec("DELETE FROM jots; DELETE FROM workspaces;");
});

const mkWs = (slug = `jot-${randomUUID().slice(0, 6)}`) =>
  workspaces.create({ slug, name: slug, config_dir: `/tmp/mc-test/${slug}` });

test("a new jot is open, unrun, and appended to the end of its client's list", () => {
  const ws = mkWs();
  const a = jots.create({ workspace_id: ws.id, title: "flyway rollback" });
  const b = jots.create({ workspace_id: ws.id, title: "dbt coverage", body: "orders_fct first" });
  assert.equal(a.status, "open");
  assert.equal(a.body, null);
  assert.equal(a.session_id, null);
  assert.equal(a.ran_at, null);
  assert.equal(b.body, "orders_fct first");
  assert.equal(a.pos, 0);
  assert.equal(b.pos, 1);
});

test("pos is per client, so two clients both start at 0", () => {
  const one = mkWs(), two = mkWs();
  assert.equal(jots.create({ workspace_id: one.id, title: "a" }).pos, 0);
  assert.equal(jots.create({ workspace_id: two.id, title: "b" }).pos, 0);
});

test("list returns one client's rows in arranged order, done rows sunk to the bottom", () => {
  const ws = mkWs(), other = mkWs();
  const a = jots.create({ workspace_id: ws.id, title: "a" });
  const b = jots.create({ workspace_id: ws.id, title: "b" });
  const c = jots.create({ workspace_id: ws.id, title: "c" });
  jots.create({ workspace_id: other.id, title: "not mine" });
  jots.update(a.id, { status: "done" });
  assert.deepEqual(jots.list({ workspace_id: ws.id }).map((j) => j.title), ["b", "c", "a"]);
  assert.deepEqual(jots.list({ workspace_id: ws.id, status: "open" }).map((j) => j.title), ["b", "c"]);
  assert.deepEqual(jots.list({ workspace_id: other.id }).map((j) => j.title), ["not mine"]);
  assert.equal(b.id && c.id ? true : false, true);
});

// The row exists to be revised: this is the edit path the Desk drives on every keystroke pause.
test("update patches only the named fields and leaves the rest alone", () => {
  const ws = mkWs();
  const j = jots.create({ workspace_id: ws.id, title: "ask about WLM", body: "first thing I knew" });
  const withMore = jots.update(j.id, { body: "first thing I knew\nand the second" })!;
  assert.equal(withMore.title, "ask about WLM", "a body autosave must not disturb the title");
  assert.equal(withMore.body, "first thing I knew\nand the second");
  const retitled = jots.update(j.id, { title: "ask about the Redshift WLM change" })!;
  assert.equal(retitled.body, "first thing I knew\nand the second", "a title edit must not drop the body");
});

test("a body can be cleared back to empty", () => {
  const ws = mkWs();
  const j = jots.create({ workspace_id: ws.id, title: "t", body: "written in haste" });
  assert.equal(jots.update(j.id, { body: null })!.body, null);
});

test("update with no fields is a no-op rather than a broken UPDATE", () => {
  const ws = mkWs();
  const j = jots.create({ workspace_id: ws.id, title: "t" });
  assert.equal(jots.update(j.id, {})!.title, "t");
});

test("done_at marks the transition, not the write", async () => {
  const ws = mkWs();
  const j = jots.create({ workspace_id: ws.id, title: "t" });
  const done = jots.update(j.id, { status: "done" })!;
  assert.ok(done.done_at);
  await new Promise((r) => setTimeout(r, 5));
  const edited = jots.update(j.id, { body: "one more thing" })!;
  assert.equal(edited.done_at, done.done_at, "editing a done row must not move its completion time");
  assert.equal(jots.update(j.id, { status: "open" })!.done_at, null, "reopening clears it");
});

// Running IS taking it up: the terminal owns the work now, so the card leaves the pad.
test("ran() links the session and closes the row; reopening is still possible", () => {
  const ws = mkWs();
  const j = jots.create({ workspace_id: ws.id, title: "t" });
  const ran = jots.ran(j.id, "session-abc")!;
  assert.equal(ran.session_id, "session-abc");
  assert.ok(ran.ran_at);
  assert.equal(ran.status, "done");
  assert.ok(ran.done_at);
  assert.equal(jots.list({ workspace_id: ws.id, status: "open" }).length, 0);
  assert.equal(jots.update(j.id, { status: "open" })!.status, "open", "a run that went nowhere can be put back");
});

test("a re-run repoints the row at the newer terminal", () => {
  const ws = mkWs();
  const j = jots.create({ workspace_id: ws.id, title: "t" });
  const first = jots.ran(j.id, "session-first")!;
  const second = jots.ran(j.id, "session-second")!;
  assert.equal(second.session_id, "session-second");
  assert.equal(second.done_at, first.done_at, "the receipt keeps when it was first taken up");
});

test("reorder rewrites pos for the ids given, scoped to the client", () => {
  const ws = mkWs(), other = mkWs();
  const a = jots.create({ workspace_id: ws.id, title: "a" });
  const b = jots.create({ workspace_id: ws.id, title: "b" });
  const c = jots.create({ workspace_id: ws.id, title: "c" });
  const foreign = jots.create({ workspace_id: other.id, title: "foreign" });
  jots.reorder(ws.id, [c.id, a.id, b.id]);
  assert.deepEqual(jots.list({ workspace_id: ws.id }).map((j) => j.title), ["c", "a", "b"]);
  // An id from another client named in the list is ignored rather than stolen.
  jots.reorder(ws.id, [foreign.id]);
  assert.equal(jots.get(foreign.id)!.workspace_id, other.id);
  assert.equal(jots.get(foreign.id)!.pos, 0);
});

test("remove deletes the row and reports whether it existed", () => {
  const ws = mkWs();
  const j = jots.create({ workspace_id: ws.id, title: "t" });
  assert.equal(jots.remove(j.id), true);
  assert.equal(jots.get(j.id), undefined);
  assert.equal(jots.remove(j.id), false);
});

test("openCounts counts only open rows, per client", () => {
  const one = mkWs(), two = mkWs();
  const a = jots.create({ workspace_id: one.id, title: "a" });
  jots.create({ workspace_id: one.id, title: "b" });
  jots.create({ workspace_id: two.id, title: "c" });
  jots.update(a.id, { status: "done" });
  const counts = jots.openCounts();
  assert.equal(counts[one.id], 1);
  assert.equal(counts[two.id], 1);
});

// The jot outlives the terminal it opened: session rows are reaped on retention, and a cascade
// would take the parked thought with it.
test("a jot survives a session id that no longer resolves", () => {
  const ws = mkWs();
  const j = jots.create({ workspace_id: ws.id, title: "t" });
  jots.ran(j.id, randomUUID());
  assert.ok(jots.get(j.id));
});

test("deleting a client takes its jots with it", () => {
  const ws = mkWs();
  const j = jots.create({ workspace_id: ws.id, title: "t" });
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare("DELETE FROM workspaces WHERE id=?").run(ws.id);
  assert.equal(jots.get(j.id), undefined);
});

// ── planned cards (migration 107) ──
test("a card defaults to the operator's, undated; a planner's card carries its day, source and author", () => {
  const ws = mkWs();
  const mine = jots.create({ workspace_id: ws.id, title: "mine" });
  assert.equal(mine.for_date, null);
  assert.equal(mine.source, "operator");
  assert.equal(mine.planned_by, null);
  const planned = jots.create({ workspace_id: ws.id, title: "planned", for_date: "2026-09-04", source: "nextday", planned_by: "sess-1" });
  assert.equal(planned.for_date, "2026-09-04");
  assert.equal(planned.source, "nextday");
  assert.equal(planned.planned_by, "sess-1");
});

test("list filters by day and source, and keeps undated rows ahead of a day's block", () => {
  const ws = mkWs();
  const d1 = jots.create({ workspace_id: ws.id, title: "day one", for_date: "2026-09-04", source: "nextday" });
  const mine = jots.create({ workspace_id: ws.id, title: "mine" });
  const d2 = jots.create({ workspace_id: ws.id, title: "day two", for_date: "2026-09-05", source: "nextday" });
  assert.deepEqual(jots.list({ workspace_id: ws.id }).map((j) => j.title), ["mine", "day one", "day two"]);
  assert.deepEqual(jots.list({ workspace_id: ws.id, for_date: "2026-09-04" }).map((j) => j.id), [d1.id]);
  assert.deepEqual(jots.list({ workspace_id: ws.id, source: "nextday" }).map((j) => j.id), [d1.id, d2.id]);
  assert.equal(jots.list({ workspace_id: ws.id, source: "operator" })[0].id, mine.id);
});

test("clearPlanned drops only that day's untouched planner cards", () => {
  const ws = mkWs(), other = mkWs();
  const fresh = jots.create({ workspace_id: ws.id, title: "fresh", for_date: "2026-09-04", source: "nextday" });
  const ran = jots.create({ workspace_id: ws.id, title: "ran", for_date: "2026-09-04", source: "nextday" });
  jots.ran(ran.id, "s");
  const done = jots.create({ workspace_id: ws.id, title: "done", for_date: "2026-09-04", source: "nextday" });
  jots.update(done.id, { status: "done" });
  const mine = jots.create({ workspace_id: ws.id, title: "mine dated", for_date: "2026-09-04" });
  const elsewhere = jots.create({ workspace_id: other.id, title: "other client", for_date: "2026-09-04", source: "nextday" });
  assert.equal(jots.clearPlanned(ws.id, "2026-09-04"), 1);
  assert.equal(jots.get(fresh.id), undefined);
  for (const j of [ran, done, mine, elsewhere]) assert.ok(jots.get(j.id), `${j.title} must survive`);
});

test("a card can be moved to another day, or made undated again", () => {
  const ws = mkWs();
  const j = jots.create({ workspace_id: ws.id, title: "t", for_date: "2026-09-04" });
  assert.equal(jots.update(j.id, { for_date: "2026-09-05" })!.for_date, "2026-09-05");
  assert.equal(jots.update(j.id, { for_date: null })!.for_date, null);
});

// Who may write: the operator anything; a terminal only a dated card, stamped as the planner's.
test("jotWritePolicy: operator writes freely, a scoped terminal files rows stamped as its own, no token is nobody", () => {
  assert.deepEqual(jotWritePolicy({ admin: true, scopedWs: null }, { for_date: null, planned_by: "s" }), { ok: true, source: "operator", planned_by: null });
  assert.deepEqual(jotWritePolicy({ admin: false, scopedWs: "ws1" }, { for_date: "2026-09-04", planned_by: "s1" }), { ok: true, source: "nextday", planned_by: "s1" });
  // An undated row from a terminal is a follow-up it parked — allowed, and never passes as the operator's.
  assert.deepEqual(jotWritePolicy({ admin: false, scopedWs: "ws1" }, { planned_by: "s2" }), { ok: true, source: "agent", planned_by: "s2" });
  assert.deepEqual(jotWritePolicy({ admin: false, scopedWs: "ws1" }, {}), { ok: true, source: "agent", planned_by: null });
  const nobody = jotWritePolicy({ admin: false, scopedWs: null }, { for_date: "2026-09-04" });
  assert.equal(nobody.ok, false);
  assert.match(!nobody.ok ? nobody.error : "", /admin token required/);
});

test("append adds a line under what is written and never replaces it", () => {
  const ws = mkWs();
  const empty = jots.create({ workspace_id: ws.id, title: "t" });
  assert.equal(jots.append(empty.id, "first")!.body, "first", "an empty row takes the text as its body");
  assert.equal(jots.append(empty.id, "second")!.body, "first\nsecond");
  const trailing = jots.create({ workspace_id: ws.id, title: "u", body: "written\n\n  " });
  assert.equal(jots.append(trailing.id, "more")!.body, "written\nmore", "trailing blank lines do not pile up");
  const blank = jots.create({ workspace_id: ws.id, title: "v", body: "   " });
  assert.equal(jots.append(blank.id, "x")!.body, "x");
});

test("two appends to the same row both land", () => {
  const ws = mkWs();
  const j = jots.create({ workspace_id: ws.id, title: "t", body: "base" });
  jots.append(j.id, "from terminal A");
  jots.append(j.id, "from terminal B");
  assert.equal(jots.get(j.id)!.body, "base\nfrom terminal A\nfrom terminal B");
});

// The point of writing the body down over days: by the time you press Run, the brief is already
// written. This asserts the accumulated detail is what the agent is actually handed.
test("deskSeed carries the row's body through as the agent's brief", () => {
  const j = { title: "flyway rollback", body: "prod is 3 behind\nsafe window Sunday 02:00" };
  const seed = deskSeed(j.title, null, j.body);
  assert.match(seed, /Goal: flyway rollback/);
  assert.match(seed, /Brief from your operator:\nprod is 3 behind\nsafe window Sunday 02:00/);
});

test("a row with no detail yet seeds a goal and no empty brief", () => {
  const seed = deskSeed("ask about the WLM change", null, null);
  assert.match(seed, /Goal: ask about the WLM change/);
  assert.doesNotMatch(seed, /Brief from your operator/);
});
