/**
 * Standing watches: the cadence, and what Robert is shown each time he looks.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  dueWatches,
  feedSince,
  parseEvery,
  watchDue,
  WATCH_MAX_MINUTES,
  WATCH_MIN_MINUTES,
  watchView,
} from "./desk-watch.js";
import { sessions } from "./store.js";

const iso = (ms: number) => new Date(ms).toISOString();

describe("parseEvery", () => {
  test("takes the shapes an operator actually types", () => {
    assert.equal(parseEvery("5"), 5);
    assert.equal(parseEvery("10m"), 10);
    assert.equal(parseEvery("10 min"), 10);
    assert.equal(parseEvery("15 minutes"), 15);
    assert.equal(parseEvery("1h"), 60);
    assert.equal(parseEvery("2 hours"), 120);
    assert.equal(parseEvery(7), 7);
  });

  test("refuses what is not an interval, instead of defaulting to one", () => {
    // The failure that matters: "ten" silently becoming 10 would put a report on his phone every ten
    // minutes that he never actually asked for.
    for (const bad of ["ten", "", "soon", "-5", "0", "5x", null, undefined, "m"]) {
      assert.equal(parseEvery(bad as any), null, `expected ${JSON.stringify(bad)} to be refused`);
    }
  });

  test("clamps to a sane band and rounds to whole minutes", () => {
    assert.equal(parseEvery("0.5m"), WATCH_MIN_MINUTES);
    assert.equal(parseEvery("99999m"), WATCH_MAX_MINUTES);
    assert.equal(parseEvery("7.4m"), 7);
  });
});

describe("watchDue", () => {
  const now = Date.UTC(2026, 7, 30, 12, 0, 0);

  test("is not due before its interval is up", () => {
    assert.equal(watchDue({ watch_every_min: 10, watch_last_at: iso(now - 9 * 60_000) }, now), false);
  });

  test("is due at the interval and after", () => {
    assert.equal(watchDue({ watch_every_min: 10, watch_last_at: iso(now - 10 * 60_000) }, now), true);
    assert.equal(watchDue({ watch_every_min: 10, watch_last_at: iso(now - 55 * 60_000) }, now), true);
  });

  test("never fires for an unwatched terminal", () => {
    assert.equal(watchDue({ watch_every_min: null, watch_last_at: iso(now - 99 * 60_000) }, now), false);
    assert.equal(watchDue({ watch_every_min: 0, watch_last_at: null }, now), false);
  });

  test("reports once for a missed window, not once per window missed", () => {
    // The daemon was down an hour on a 10m watch. dueWatches is a filter over rows, so it yields ONE
    // entry — the sweeper sends one report and re-stamps, rather than firing six on boot.
    const rows: any[] = [{ watch_every_min: 10, watch_last_at: iso(now - 60 * 60_000) }];
    assert.equal(dueWatches(rows, now).length, 1);
  });

  test("treats a missing or corrupt stamp as due now", () => {
    assert.equal(watchDue({ watch_every_min: 10, watch_last_at: null }, now), true);
    assert.equal(watchDue({ watch_every_min: 10, watch_last_at: "not a date" }, now), true);
  });
});

describe("feedSince", () => {
  const t0 = Date.UTC(2026, 7, 30, 12, 0, 0);
  const feed = [
    { kind: "understanding", text: "old", ts: t0 - 60_000 },
    { kind: "narration", text: "also old", ts: t0 - 30_000 },
    { kind: "narration", text: "new", ts: t0 + 10_000 },
  ];

  test("keeps only what was said since the last look", () => {
    assert.deepEqual(
      feedSince(feed, t0).map((e) => e.text),
      ["new"],
    );
  });

  test("falls back to the tail when nothing was said in the window", () => {
    // A terminal that went silent IS the report — with an empty list Robert would have nothing to
    // describe and would answer about a blank screen.
    assert.deepEqual(
      feedSince(feed, t0 + 60_000).map((e) => e.text),
      ["old", "also old", "new"],
    );
  });

  test("takes the whole feed when there is no previous look", () => {
    assert.equal(feedSince(feed, null).length, 3);
  });

  test("keeps entries with no timestamp rather than dropping them", () => {
    const noTs = [{ kind: "narration", text: "untimed" }];
    assert.deepEqual(
      feedSince(noTs, t0).map((e) => e.text),
      ["untimed"],
    );
  });

  test("caps the tail so one chatty terminal can't blow up the prompt", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ kind: "narration", text: `line ${i}`, ts: t0 + i }));
    const out = feedSince(many, t0 - 1, 40);
    assert.equal(out.length, 40);
    assert.equal(out.at(-1)!.text, "line 99"); // the NEWEST 40, not the oldest
  });
});

describe("watchView — what the Desk draws", () => {
  test("an unwatched terminal with no history shows nothing", () => {
    const s = sessions.create({ workspace_id: null, cwd: "/tmp" } as any);
    assert.equal(watchView(s), null);
  });

  test("an armed watch carries the order, the next look, and Robert's last words", () => {
    const s0 = sessions.create({ workspace_id: null, cwd: "/tmp" } as any);
    const armed = sessions.setWatch(s0.id, { every_min: 10, note: "tell me if it touches prod" })!;
    const at = Date.parse(armed.watch_last_at!);
    assert.equal(watchView(armed, at)!.next_due, iso(at + 10 * 60_000));
    sessions.addWatchReport(s0.id, { state: "working", body: "first", final: false, failed: false });
    sessions.addWatchReport(s0.id, { state: "blocked", body: "stuck on a y/n", final: false, failed: false });
    const v = watchView(sessions.get(s0.id)!, at)!;
    assert.equal(v.active, true);
    assert.equal(v.note, "tell me if it touches prod");
    assert.equal(v.looking, false);
    assert.equal(v.last?.body, "stuck on a y/n");
    assert.deepEqual(sessions.watchReports(s0.id).map((r) => r.body), ["stuck on a y/n", "first"]);
  });

  test("a next look already overdue reads as now, never in the past", () => {
    const s0 = sessions.create({ workspace_id: null, cwd: "/tmp" } as any);
    const armed = sessions.setWatch(s0.id, { every_min: 5 })!;
    const later = Date.parse(armed.watch_last_at!) + 60 * 60_000;
    assert.equal(watchView(armed, later)!.next_due, iso(later));
  });

  test("the closing verdict outlives the watch that produced it", () => {
    const s0 = sessions.create({ workspace_id: null, cwd: "/tmp" } as any);
    sessions.setWatch(s0.id, { every_min: 10 });
    sessions.addWatchReport(s0.id, { state: "done", body: "shipped the PR", final: true, failed: false });
    const off = sessions.setWatch(s0.id, { every_min: null })!;
    const v = watchView(off)!;
    assert.equal(v.active, false);
    assert.equal(v.last?.final, true);
  });
});
