import test from "node:test";
import assert from "node:assert/strict";
import {
  WATCH_LIMITS,
  busMatches,
  evalPredicate,
  onBusEvent,
  parseEvery,
  parseUntil,
  prepareWatch,
  resolvePath,
  setWatchFetcher,
  setWatchPoster,
  tickPolls,
  tickDue,
  invalidateWatchCache,
} from "./watches.js";
import { watches } from "./store.js";
import type { BusEvent } from "./bus.js";

const NOW = Date.parse("2026-08-10T12:00:00.000Z");

// Every test drives the engine through its two seams — no board writes, no loopback HTTP.
const posted: any[] = [];
setWatchPoster(((p: any) => { posted.push(p); return { id: "b1", ...p } as any; }) as any);

function reset() {
  for (const w of watches.list({})) watches.remove(w.id);
  invalidateWatchCache();
  posted.length = 0;
}

const mk = (over: Record<string, unknown> = {}) => {
  const p = prepareWatch({ owner: "robert", what: "algo pasa", on: "run.ended", ...over }, NOW);
  if ("error" in p) throw new Error(p.error);
  const w = watches.create(p.row);
  invalidateWatchCache(); // the API does this; tests write to the store directly
  return w;
};

// ── the predicate grammar ────────────────────────────────────────────────────
test("resolvePath: dotted paths, indexes, length and $", () => {
  const doc = { a: { b: [{ c: 7 }] }, list: [1, 2, 3], s: "hola" };
  assert.equal(resolvePath(doc, "a.b[0].c"), 7);
  assert.equal(resolvePath(doc, "$.a.b[0].c"), 7);
  assert.equal(resolvePath(doc, "list.length"), 3);
  assert.equal(resolvePath(doc, "s.length"), 4);
  assert.deepEqual(resolvePath(doc, "$"), doc);
  assert.equal(resolvePath(doc, "a.nope.deeper"), undefined);
});

test("evalPredicate: comparisons, contains, exists, && and ||", () => {
  const t = { status: "pending", spend: 7, title: "Fix the CI", pr: null };
  assert.equal(evalPredicate(t, "status != 'pending'"), false);
  assert.equal(evalPredicate(t, "status == 'pending'"), true);
  assert.equal(evalPredicate(t, "spend > 5"), true);
  assert.equal(evalPredicate(t, "spend >= 7 && status == 'pending'"), true);
  assert.equal(evalPredicate(t, "spend > 100 || status == 'pending'"), true);
  assert.equal(evalPredicate(t, "title contains 'ci'"), true);
  assert.equal(evalPredicate(t, "exists title"), true);
  assert.equal(evalPredicate(t, "missing pr"), true);   // null counts as missing
  assert.equal(evalPredicate([], "$.length > 0"), false);
  assert.equal(evalPredicate([{ id: 1 }], "$.length > 0"), true);
});

test("evalPredicate: an agent-authored string is data, never code", () => {
  const doc = { status: "ok" };
  // No eval anywhere, so the classic injections are simply predicates that don't parse → false.
  for (const evil of [
    "process.exit(1)",
    "constructor.constructor('return 1')()",
    "status == 'ok'); require('fs').rmSync('/', {recursive:true}); (''",
    "__proto__.polluted == 1",
  ]) {
    assert.equal(evalPredicate(doc, evil), false, evil);
  }
  assert.equal((({} as any).polluted), undefined, "nothing was polluted");
  // Garbage is false, not a throw.
  assert.equal(evalPredicate(doc, "&&&"), false);
  assert.equal(evalPredicate(doc, ""), false);
});

// ── inputs ───────────────────────────────────────────────────────────────────
test("parseEvery / parseUntil accept the shorthands an agent will actually write", () => {
  assert.equal(parseEvery("5m"), 300);
  assert.equal(parseEvery("90s"), 90);
  assert.equal(parseEvery("2h"), 7200);
  assert.equal(parseEvery(120), 120);
  assert.equal(parseEvery("soon"), null);
  assert.equal(parseUntil("+48h", NOW), "2026-08-12T12:00:00.000Z");
  assert.equal(parseUntil("+7d", NOW), "2026-08-17T12:00:00.000Z");
  assert.equal(parseUntil("2026-09-01T00:00:00Z", NOW), "2026-09-01T00:00:00.000Z");
  assert.equal(parseUntil("mañana", NOW), null);
});

test("prepareWatch: guards", () => {
  reset();
  assert.match((prepareWatch({ owner: "nadie", what: "x", on: "run.ended" }, NOW) as any).error, /executive/);
  assert.match((prepareWatch({ owner: "robert", what: "", on: "run.ended" }, NOW) as any).error, /what is required/);
  assert.match((prepareWatch({ owner: "robert", what: "x" }, NOW) as any).error, /needs `on`.*`at`/);
  assert.match((prepareWatch({ owner: "robert", what: "x", check: "/api/tickets" }, NOW) as any).error, /needs `when`/);
  // The check path is an allowlist, not a suggestion.
  for (const bad of ["https://evil.test/x", "/etc/passwd", "/board", "/api/../secret"]) {
    const r = prepareWatch({ owner: "robert", what: "x", check: bad, when: "a == 1" }, NOW);
    assert.ok("error" in r, bad);
  }
  assert.match((prepareWatch({ owner: "robert", what: "x", check: "/api/tickets", when: "$.length > 0", every: "10s" }, NOW) as any).error, /at least/);
  assert.match((prepareWatch({ owner: "robert", what: "x", on: "run.ended", until: "+90d" }, NOW) as any).error, /capped/);
  assert.match((prepareWatch({ owner: "robert", what: "x", on: "run.ended", until: "2020-01-01T00:00:00Z" }, NOW) as any).error, /past/);
  // A handle with no agent behind it is not an owner: a watch owned by an executive that does not
  // exist would fire into a thread nobody wakes on.
  assert.match((prepareWatch({ owner: "nils", what: "x", on: "run.ended" }, NOW) as any).error, /must be an executive/);
  // The live handle resolves to its id, and the default expiry applies.
  const ok = prepareWatch({ owner: "robert", what: "x", on: "run.ended" }, NOW);
  assert.equal((ok as any).row.owner, "robert");
  assert.equal((ok as any).row.until, "2026-08-17T12:00:00.000Z");
});

test("prepareWatch: an owner can't hoard watches", () => {
  reset();
  for (let i = 0; i < WATCH_LIMITS.perOwner; i++) mk({ what: `w${i}` });
  assert.match((prepareWatch({ owner: "robert", what: "one more", on: "run.ended" }, NOW) as any).error, /already has/);
  // Closing one frees the slot.
  watches.patch(watches.list({ owner: "robert" })[0].id, { enabled: 0 });
  assert.ok("row" in prepareWatch({ owner: "robert", what: "one more", on: "run.ended" }, NOW));
});

// ── bus mode ─────────────────────────────────────────────────────────────────
const ended = (over: Record<string, unknown> = {}): BusEvent =>
  ({ topic: "run.ended", run_id: "r1", status: "success", ticket_key: "PER-35", ...over }) as BusEvent;

test("busMatches: topic plus field equality, and comparison operators in `where`", () => {
  const w = mk({ where: { ticket_key: "PER-35", status: "failed" } });
  assert.equal(busMatches(w, ended({ status: "failed" })), true);
  assert.equal(busMatches(w, ended({ status: "success" })), false);
  assert.equal(busMatches(w, ended({ ticket_key: "PER-99", status: "failed" })), false);
  assert.equal(busMatches(w, { topic: "run.started", run_id: "r1", job_id: "j" } as BusEvent), false);
  reset();
  const cmp = mk({ on: "run.step", where: { idx: ">= 3" } });
  assert.equal(busMatches(cmp, { topic: "run.step", run_id: "r", idx: 4, label: "l", status: "done", progress: "4/5" } as BusEvent), true);
  assert.equal(busMatches(cmp, { topic: "run.step", run_id: "r", idx: 1, label: "l", status: "done", progress: "1/5" } as BusEvent), false);
});

test("a one-shot bus watch fires once, mentions its owner, and closes itself", () => {
  reset();
  const w = mk({ where: { status: "failed" }, say: "arreglalo" });
  onBusEvent(ended({ status: "success" }), NOW);
  assert.equal(posted.length, 0, "no match, no cost");

  onBusEvent(ended({ status: "failed" }), NOW);
  assert.equal(posted.length, 1);
  assert.match(posted[0].body, /@robert/);
  assert.match(posted[0].body, /algo pasa/);
  assert.match(posted[0].body, /arreglalo/);
  assert.equal(posted[0].kind, "watch");

  // Closed — a second identical event costs nothing.
  onBusEvent(ended({ status: "failed" }), NOW);
  assert.equal(posted.length, 1);
  const after = watches.get(w.id)!;
  assert.equal(after.enabled, 0);
  assert.equal(after.fire_count, 1);
  assert.match(after.disabled_reason!, /one-shot/);
});

test("a repeating watch dedupes identical state and auto-disables if it runs away", () => {
  reset();
  const w = mk({ one_shot: false, where: { status: "failed" } });
  onBusEvent(ended({ status: "failed" }), NOW);
  onBusEvent(ended({ status: "failed" }), NOW);
  assert.equal(posted.length, 1, "same event shape twice is one notification");

  for (let i = 0; i < WATCH_LIMITS.maxFires + 5; i++) onBusEvent(ended({ status: "failed", run_id: "r" + i }), NOW);
  const after = watches.get(w.id)!;
  assert.equal(after.enabled, 0);
  assert.equal(after.fire_count, WATCH_LIMITS.maxFires);
  assert.match(after.disabled_reason!, /auto-disabled/);
  assert.equal(posted.length, WATCH_LIMITS.maxFires);
});

test("an expired watch is switched off instead of evaluated", () => {
  reset();
  const w = mk({ until: "+1h" });
  onBusEvent(ended(), NOW + 2 * 3600_000);
  assert.equal(posted.length, 0);
  assert.equal(watches.get(w.id)!.enabled, 0);
  assert.equal(watches.get(w.id)!.disabled_reason, "expired");
});

// ── poll mode ────────────────────────────────────────────────────────────────
test("poll: honours the interval, fires on the predicate, survives a failing check", async () => {
  reset();
  let doc: unknown = { status: "pending" };
  let calls = 0;
  setWatchFetcher(async (path) => { calls++; if (path === "/api/boom") throw new Error("502"); return doc; });

  const p = prepareWatch({ owner: "robert", what: "el pedido sale de pendiente", check: "/api/tickets/PER-40", when: "status != 'pending'", every: "5m" }, NOW);
  const w = watches.create((p as any).row);

  await tickPolls(NOW);
  assert.equal(calls, 1);
  assert.equal(posted.length, 0, "predicate false → nothing");

  doc = { status: "done" };
  await tickPolls(NOW + 60_000);
  assert.equal(calls, 1, "not due yet — the interval is the budget");

  await tickPolls(NOW + 301_000);
  assert.equal(calls, 2);
  assert.equal(posted.length, 1);
  assert.match(posted[0].body, /@robert/);
  assert.match(posted[0].body, /PER-40/);
  assert.equal(watches.get(w.id)!.enabled, 0);

  // A check that 502s marks the attempt and moves on rather than hot-looping.
  const bad = watches.create((prepareWatch({ owner: "robert", what: "roto", check: "/api/boom", when: "$.length > 0" }, NOW) as any).row);
  await tickPolls(NOW);
  assert.equal(posted.length, 1, "a failed check is not a fire");
  assert.ok(watches.get(bad.id)!.last_checked_at, "the attempt is recorded so the interval still applies");
  setWatchFetcher(null);
});

test("the bus hot path costs nothing when nobody is watching that topic", () => {
  reset();
  mk({ on: "review.created" });
  // agent.delta fires once per streamed token: it must not reach the store at all, so count the
  // scans the hot path makes rather than trusting that it looks cheap.
  onBusEvent({ topic: "agent.delta", text: "warm" } as BusEvent, NOW); // build the topic index once
  const real = watches.live.bind(watches);
  let scans = 0;
  (watches as any).live = (...a: any[]) => { scans++; return (real as any)(...a); };
  try {
    onBusEvent({ topic: "agent.delta", text: "x" } as BusEvent, NOW);
    assert.equal(scans, 0, "with the index built, an unwatched topic never queries the store");
    assert.equal(posted.length, 0);
    // The topic someone IS watching still matches.
    onBusEvent({ topic: "review.created", review_id: "rv", run_id: "r", ticket_id: null } as BusEvent, NOW);
    assert.equal(posted.length, 1);
  } finally {
    (watches as any).live = real;
  }
});

test("the firehose and self-referential topics are refused at creation", () => {
  reset();
  for (const topic of ["board.posted", "agent.delta", "run.event", "agent.push"]) {
    const r = prepareWatch({ owner: "robert", what: "x", on: topic }, NOW);
    assert.ok("error" in r, topic);
    assert.match((r as any).error, /can't be watched/);
  }
  assert.ok("row" in prepareWatch({ owner: "robert", what: "x", on: "run.ended" }, NOW));
});

// ── at mode: scheduled self-wakes ────────────────────────────────────────────
test("prepareWatch: `at` guards — future, capped, and always one delivery", () => {
  reset();
  assert.match((prepareWatch({ owner: "robert", what: "x", at: "ayer" }, NOW) as any).error, /ISO date or a relative/);
  assert.match((prepareWatch({ owner: "robert", what: "x", at: "2020-01-01T00:00:00Z" }, NOW) as any).error, /past/);
  assert.match((prepareWatch({ owner: "robert", what: "x", at: "+90d" }, NOW) as any).error, /capped/);
  const r = prepareWatch({ owner: "robert", what: "checkout check", at: "+20m", say: "mirá si pasó", one_shot: false }, NOW);
  assert.ok("row" in r);
  const row = (r as any).row;
  assert.equal(row.mode, "at");
  assert.equal(row.at, "2026-08-10T12:20:00.000Z");
  assert.equal(row.one_shot, 1, "a self-wake is one delivery even if the caller says otherwise");
  assert.equal(row.until, "2026-08-10T13:20:00.000Z", "expiry trails the due time; caller until is ignored");
});

test("a due self-wake delivers exactly once, with the message, without any gate", () => {
  reset();
  const p = prepareWatch({ owner: "robert", what: "revisar checkout", at: "+20m", say: "fijate si el pago entró" }, NOW);
  const w = watches.create((p as any).row);
  invalidateWatchCache();

  tickDue(NOW + 5 * 60_000);
  assert.equal(posted.length, 0, "not due yet");

  tickDue(NOW + 21 * 60_000);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].kind, "wakeup");
  assert.match(posted[0].body, /⏰ scheduled wake — revisar checkout/);
  assert.match(posted[0].body, /@robert fijate si el pago entró/);

  // Delivered = closed. The next sweep finds nothing.
  tickDue(NOW + 22 * 60_000);
  assert.equal(posted.length, 1);
  const after = watches.get(w.id)!;
  assert.equal(after.enabled, 0);
  assert.equal(after.fire_count, 1);
});
