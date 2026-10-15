/**
 * The Fleet pulse card: the reader's arithmetic, and the two places outside it the card depends on —
 * the table it draws (migration 119) and the append that fills it (term-status.ts).
 *
 * The drawing half has no build step and no types, so it is pinned by reading the shipped module, the
 * same way src/desk-widgets.test.ts pins the page: a renamed helper or a hard-coded colour is a card
 * that is wrong in the browser and nowhere else.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db, sessions, workspaces } from "./store.js";
import { MIGRATIONS } from "./store/migrate.js";
import pulse, { byTriage, pulseData, segmentsFrom, ENDED_GRACE_MS, DEFAULT_WINDOW_MIN } from "./widgets/pulse.js";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const NOW = 1_800_000_000_000;
const MIN = 60_000;

// ── segments: everything the band is made of ────────────────────────────────────────────────────

test("no history at all: one band, from the phase's own `since`", () => {
  const segs = segmentsFrom([], { from: NOW - 60 * MIN, to: NOW, phase: "working", since: NOW - 20 * MIN });
  assert.deepEqual(segs, [{ phase: "working", from: NOW - 20 * MIN, to: NOW }]);
});

test("a `since` older than the window is clipped to the window, not dropped", () => {
  const segs = segmentsFrom([], { from: NOW - 15 * MIN, to: NOW, phase: "decide", since: NOW - 9 * 60 * MIN });
  assert.deepEqual(segs, [{ phase: "decide", from: NOW - 15 * MIN, to: NOW }]);
});

test("transitions become adjacent bands, the last one running to now", () => {
  const rows = [
    { phase: "working", at: NOW - 50 * MIN },
    { phase: "your_turn", at: NOW - 30 * MIN },
    { phase: "working", at: NOW - 20 * MIN },
  ];
  const segs = segmentsFrom(rows, { from: NOW - 60 * MIN, to: NOW, phase: "working", since: NOW - 20 * MIN });
  assert.deepEqual(segs, [
    { phase: "working", from: NOW - 50 * MIN, to: NOW - 30 * MIN },
    { phase: "your_turn", from: NOW - 30 * MIN, to: NOW - 20 * MIN },
    { phase: "working", from: NOW - 20 * MIN, to: NOW },
  ]);
  // …and the bands never overlap or leave a hole: each one starts where the last one stopped.
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].from, segs[i - 1].to);
});

test("history older than the window is clipped, and the band that straddles the edge survives", () => {
  const rows = [
    { phase: "working", at: NOW - 6 * 60 * MIN },
    { phase: "blocked", at: NOW - 40 * MIN },   // started before the window, still visible inside it
    { phase: "decide", at: NOW - 5 * MIN },
  ];
  const segs = segmentsFrom(rows, { from: NOW - 15 * MIN, to: NOW, phase: "decide", since: NOW - 5 * MIN });
  assert.deepEqual(segs, [
    { phase: "blocked", from: NOW - 15 * MIN, to: NOW - 5 * MIN },
    { phase: "decide", from: NOW - 5 * MIN, to: NOW },
  ]);
});

test("statusOf wins over the table: the tail is the phase it is in NOW", () => {
  // The in-memory clock moves a phase on a timer and the row is written on the next read, so history
  // can trail the truth by one refresh. Drawing the stale tail would make the card lie about `now`.
  const rows = [{ phase: "working", at: NOW - 30 * MIN }];
  const segs = segmentsFrom(rows, { from: NOW - 60 * MIN, to: NOW, phase: "stalled", since: NOW - 2 * MIN });
  assert.deepEqual(segs, [
    { phase: "working", from: NOW - 30 * MIN, to: NOW - 2 * MIN },
    { phase: "stalled", from: NOW - 2 * MIN, to: NOW },
  ]);
});

test("a zero-width band is not drawn", () => {
  const rows = [{ phase: "working", at: NOW - 10 * MIN }, { phase: "waiting", at: NOW - 10 * MIN }];
  const segs = segmentsFrom(rows, { from: NOW - 60 * MIN, to: NOW, phase: "waiting", since: NOW - 10 * MIN });
  assert.deepEqual(segs, [{ phase: "waiting", from: NOW - 10 * MIN, to: NOW }]);
});

// ── order: the rail's, not the table's ──────────────────────────────────────────────────────────

test("needs-you first, then longest waited — the rail's order", () => {
  const rows = [
    { id: "c", phase: "working", since: NOW - 90 * MIN },
    { id: "d", phase: "ended", since: NOW - 1 * MIN },
    { id: "a", phase: "decide", since: NOW - 3 * MIN },
    { id: "b", phase: "blocked", since: NOW - 1 * MIN },
    { id: "e", phase: "decide", since: NOW - 40 * MIN },
  ];
  assert.deepEqual([...rows].sort(byTriage).map((r) => r.id), ["b", "e", "a", "c", "d"]);
});

test("same phase, same age: the id breaks the tie, so the board does not reshuffle every refresh", () => {
  const a = { id: "aaa", phase: "review", since: NOW };
  const b = { id: "bbb", phase: "review", since: NOW };
  assert.ok(byTriage(a, b) < 0 && byTriage(b, a) > 0);
});

// ── the reader, against the store ───────────────────────────────────────────────────────────────

beforeEach(() => {
  db.exec("DELETE FROM session_phases; DELETE FROM session_status; DELETE FROM sessions; DELETE FROM workspaces;");
});
let n = 0;
const mk = (over: Record<string, unknown> = {}) => {
  const ws = workspaces.create({ slug: `pw${++n}`, name: "PW", config_dir: "/tmp/pw" });
  return sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code", goal: "g", ...over } as any);
};
const endAt = (id: string, ms: number) =>
  db.prepare("UPDATE sessions SET status='ended', ended_at=? WHERE id=?").run(new Date(ms).toISOString(), id);
const mark = (id: string, phase: string, at: number) =>
  db.prepare("INSERT OR IGNORE INTO session_phases (session_id, phase, at) VALUES (?,?,?)").run(id, phase, at);

test("a terminal that ended inside the grace window is on the board; one that ended before it is not", () => {
  const fresh = mk({ goal: "just finished" });
  const old = mk({ goal: "finished ages ago" });
  endAt(fresh.id, NOW - 10 * MIN);
  endAt(old.id, NOW - 90 * MIN);
  const out = pulseData({}, NOW);
  assert.deepEqual(out.rows.map((r) => r.id), [fresh.id]);
  assert.equal(out.rows[0].phase, "ended");
  // `since` is when it ended, not when it was read — "ended · now" on a 10-minute-old row is a lie.
  assert.equal(out.rows[0].since, NOW - 10 * MIN);
  assert.ok(NOW - out.rows[0].since < ENDED_GRACE_MS);
});

test("the window is minutes, defaulted and clamped, and it clips the bands it returns", () => {
  const s = mk();
  endAt(s.id, NOW - 1 * MIN);
  mark(s.id, "working", NOW - 5 * 60 * MIN);
  mark(s.id, "your_turn", NOW - 90 * MIN);
  assert.equal(pulseData({}, NOW).window, DEFAULT_WINDOW_MIN);
  assert.equal(pulseData({ window: "240" }, NOW).window, 240);
  assert.equal(pulseData({ window: "nonsense" }, NOW).window, DEFAULT_WINDOW_MIN);
  assert.equal(pulseData({ window: "99999" }, NOW).window, 24 * 60, "clamped to a day");
  assert.equal(pulseData({ window: "0" }, NOW).window, DEFAULT_WINDOW_MIN);
  const short = pulseData({ window: "15" }, NOW);
  assert.ok(short.rows[0].segments.every((g) => g.from >= NOW - 15 * MIN && g.to <= NOW));
  const long = pulseData({ window: "240" }, NOW);
  assert.ok(long.rows[0].segments[0].from < NOW - 60 * MIN, "a wider window shows more of the past");
  assert.equal(long.now, NOW);
});

test("the title is the fallback the page uses when a row is not on its rail", () => {
  const s = mk({ goal: null, title: null });
  endAt(s.id, NOW - 1 * MIN);
  assert.equal(pulseData({}, NOW).rows[0].title, "claude terminal");
  const g = mk({ goal: "open the rollback PR" });
  endAt(g.id, NOW - 1 * MIN);
  assert.ok(pulseData({}, NOW).rows.some((r) => r.title === "open the rollback PR"));
});

// ── the table, and the append that fills it ─────────────────────────────────────────────────────

test("migration 119 creates session_phases with the key that makes a double write a no-op", () => {
  const m = MIGRATIONS.find((x) => x.version === 119);
  assert.ok(m, "migration 119 exists");
  assert.match(m!.name, /session_phases/);
  const cols = db.prepare("PRAGMA table_info(session_phases)").all() as { name: string; type: string; pk: number }[];
  assert.deepEqual(cols.map((c) => c.name).sort(), ["at", "phase", "session_id"]);
  assert.equal(cols.find((c) => c.name === "at")?.type, "INTEGER");
  assert.deepEqual(cols.filter((c) => c.pk).map((c) => c.name).sort(), ["at", "session_id"]);
  const s = mk();
  mark(s.id, "working", NOW);
  mark(s.id, "decide", NOW);   // same millisecond, other phase: ignored, never a second segment
  assert.equal((db.prepare("SELECT COUNT(*) c FROM session_phases WHERE session_id=?").get(s.id) as any).c, 1);
});

test("term-status appends a row on every transition, and closes the band when a terminal ends", () => {
  const ts = read("src/term-status.ts");
  assert.match(ts, /INSERT OR IGNORE INTO session_phases \(session_id, phase, at\) VALUES \(\?, \?, \?\)/);
  // The live transition: the same branch that moves the in-memory clock writes the row.
  assert.match(ts, /if \(!prev \|\| prev\.phase !== r\.phase\) \{ phaseAt\.set\(id, \{ phase: r\.phase, at: since \}\); recordPhase\(id, r\.phase, since\); \}/);
  // …and the end, from the row's own ended_at so the band closes where it really closed.
  assert.match(ts, /recordPhase\(id, "ended", Date\.parse\(s\.ended_at \?\? ""\) \|\| now\)/);
  // A reopened terminal must not inherit the "ended" the old process wrote.
  assert.match(ts, /wrote\.delete\(id\);/);
  // Pruned, and not on every write.
  assert.match(ts, /DELETE FROM session_phases WHERE at < \?/);
  assert.match(ts, /if \(now - prunedAt < 60 \* 60 \* 1000\) return;/);
});

test("pruning keeps a week and drops what is older", async () => {
  const { prunePhases, PHASE_KEEP_MS } = await import("./term-status.js");
  const s = mk();
  const now = Date.now();
  mark(s.id, "working", now - PHASE_KEEP_MS - MIN);
  mark(s.id, "waiting", now - MIN);
  prunePhases(now + 2 * 60 * 60 * 1000);   // past the hourly throttle, whenever the suite last pruned
  const left = db.prepare("SELECT phase FROM session_phases WHERE session_id=?").all(s.id) as { phase: string }[];
  assert.deepEqual(left.map((r) => r.phase), ["waiting"]);
});

// ── the two halves agree ────────────────────────────────────────────────────────────────────────

test("the reader is registered under the name of its module, with topics the bus really publishes", () => {
  assert.equal(pulse.name, "pulse");
  assert.equal(pulse.title, "Fleet pulse");
  assert.deepEqual(pulse.topics, ["session.status", "session.started", "session.ended"]);
  const bus = read("src/bus.ts");
  for (const t of pulse.topics!) assert.match(bus, new RegExp(`topic: "${t}"`), `${t} is a real bus topic`);
  assert.match(read("src/widgets/index.ts"), /import pulse from "\.\/pulse\.js";/);
  assert.match(read("static/desk-widgets/index.js"), /"pulse"/);
});

test("the module draws with the page's tokens, the shared helpers, and no clock of its own", () => {
  const js = read("static/desk-widgets/pulse.js");
  assert.match(js, /import \{ el, fmtAgo, PHASE_COLOR \} from "\.\/lib\.js";/);
  assert.match(js, /refreshMs: 15000/);
  assert.match(js, /topics: \["session\.status", "session\.started", "session\.ended"\]/);
  // Idempotent render — the one rule the contract has.
  assert.match(js, /body\.replaceChildren\(/);
  // A band is DOM, not a canvas, and its width is its duration.
  assert.doesNotMatch(js, /getContext|createElement\("canvas"\)|<svg/i);
  assert.match(js, /flex: dur \+ " 1 0"/);
  // Nothing animates, and no literal colour is ever written — PHASE_COLOR and var() only.
  assert.doesNotMatch(js, /@keyframes|animation:|transition:|setInterval/);
  assert.doesNotMatch(js, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  // Click a band, get the terminal; the window toggle is remembered under the documented key.
  assert.match(js, /ctx\.stage\(r\.id\)/);
  assert.match(js, /const KEY = "desk-widget-pulse-window"/);
  assert.match(js, /const WINDOWS = \[15, 60, 240\]/);
  // An empty fleet is one calm line, not an empty card.
  assert.match(js, /class: "werr"/);
});
