/**
 * The "Robert's attention" card (src/widgets/robert.ts + static/desk-widgets/robert.js).
 *
 * The card's whole claim is that it draws what is ACTUALLY armed, so the things worth testing are
 * the derivations that decide what gets an edge and in what order — over fake drive/watch/queue
 * state, with no daemon and no clock. The client half has no build step and no types, so the last
 * block reads the shipped module the way src/desk-widgets.test.ts reads desk.html: a dropped token
 * or a renamed contract key is a card that breaks in the browser and nowhere else.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import robert, {
  NODE_CAP,
  PHASE_RANK,
  nodeTier,
  orderQueue,
  rankNodes,
  robertState,
  wakeKindOf,
  wakeSession,
  whyOf,
  type QueueEntry,
  type RobertNode,
} from "./widgets/robert.js";

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-09-16T12:00:00.000Z");

const node = (id: string, extra: Partial<RobertNode> = {}): RobertNode => ({
  id,
  workspace_id: "ws1",
  title: id,
  phase: "working",
  ...extra,
});

// ── what a wake is about ────────────────────────────────────────────────────────────────────────

describe("reading a wake row", () => {
  test("the terminal comes from the subject, or from the payload when there is no subject", () => {
    assert.equal(wakeSession({ subject: "session:abc-123", payload: null }), "abc-123");
    assert.equal(wakeSession({ subject: null, payload: JSON.stringify({ session_id: "def-456" }) }), "def-456");
    // A ticket/review/ask wake names no terminal — it is a real wake with no node to hang an edge on.
    assert.equal(wakeSession({ subject: "ticket:T-9", payload: null }), null);
    assert.equal(wakeSession({ subject: null, payload: "{not json" }), null, "a corrupt payload is not a crash");
    assert.equal(wakeSession({ subject: null, payload: null }), null);
  });

  test("the kind is the drive suffix, and the reason is said in the operator's words", () => {
    assert.equal(wakeKindOf("session.turn"), "turn");
    assert.equal(wakeKindOf("session.blocked"), "blocked");
    assert.equal(wakeKindOf("review.created"), "review.created");
    assert.equal(whyOf("turn"), "turn finished");
    assert.equal(whyOf("robert"), "waiting on Robert");
    // An unmapped topic still reads as English rather than as a topic string.
    assert.equal(whyOf("some.new_thing"), "some new thing");
  });
});

// ── which edge each terminal gets, and which twelve get drawn ───────────────────────────────────

describe("nodes", () => {
  test("armed outranks watched outranks recently-woken outranks quiet", () => {
    assert.equal(nodeTier(node("a", { armed: { kind: "turn", fire_at: T0, why: "turn finished" } })), 0);
    assert.equal(nodeTier(node("b", { watching: { every_min: 10, next_at: iso(T0), looking: false } })), 1);
    assert.equal(nodeTier(node("c", { woke: { at: iso(T0), why: "turn finished" } })), 2);
    assert.equal(nodeTier(node("d")), 3);
    // A terminal can be all three at once; the edge it draws is the most urgent one.
    assert.equal(
      nodeTier(node("e", {
        armed: { kind: "decide", fire_at: T0, why: "waiting on a decision" },
        watching: { every_min: 5, next_at: iso(T0), looking: false },
      })),
      0,
    );
  });

  test("inside a tier, the soonest thing comes first", () => {
    const { nodes } = rankNodes([
      node("late", { armed: { kind: "turn", fire_at: T0 + 40_000, why: "turn finished" } }),
      node("soon", { armed: { kind: "decide", fire_at: T0 + 5_000, why: "waiting on a decision" } }),
      node("watch-late", { watching: { every_min: 30, next_at: iso(T0 + 600_000), looking: false } }),
      node("watch-soon", { watching: { every_min: 5, next_at: iso(T0 + 60_000), looking: false } }),
      node("woke-old", { woke: { at: iso(T0 - 600_000), why: "turn finished" } }),
      node("woke-new", { woke: { at: iso(T0 - 60_000), why: "declared blocked" } }),
    ]);
    assert.deepEqual(nodes.map((n) => n.id), ["soon", "late", "watch-soon", "watch-late", "woke-new", "woke-old"]);
  });

  test("the quiet ones fall back to the rail's own triage order", () => {
    const { nodes } = rankNodes([node("w", { phase: "working" }), node("b", { phase: "blocked" }), node("r", { phase: "review" })]);
    assert.deepEqual(nodes.map((n) => n.id), ["b", "r", "w"]);
    assert.ok(PHASE_RANK.blocked < PHASE_RANK.review && PHASE_RANK.review < PHASE_RANK.working);
  });

  test("past twelve the graph keeps what Robert is pointed at and counts the rest", () => {
    const quiet = Array.from({ length: 20 }, (_, i) => node(`q${String(i).padStart(2, "0")}`));
    const armed = node("armed-one", { armed: { kind: "blocked", fire_at: T0 + 1_000, why: "declared blocked" } });
    const watched = node("watched-one", { watching: { every_min: 10, next_at: iso(T0 + 120_000), looking: true } });
    // Deliberately last in the input: rank, not arrival, is what earns a place.
    const { nodes, more } = rankNodes([...quiet, armed, watched]);
    assert.equal(nodes.length, NODE_CAP);
    assert.equal(NODE_CAP, 12);
    assert.equal(more, 22 - NODE_CAP);
    assert.deepEqual(nodes.slice(0, 2).map((n) => n.id), ["armed-one", "watched-one"]);
  });

  test("a fleet with nothing armed still draws every terminal — the graph is never empty for want of a wake", () => {
    const { nodes, more } = rankNodes([node("a"), node("b"), node("c")]);
    assert.equal(nodes.length, 3);
    assert.equal(more, 0);
    assert.ok(nodes.every((n) => !n.armed && !n.watching && !n.woke));
  });

  test("ranking never mutates what it was handed", () => {
    const input = [node("b"), node("a")];
    rankNodes(input);
    assert.deepEqual(input.map((n) => n.id), ["b", "a"]);
  });
});

// ── he'll open next ─────────────────────────────────────────────────────────────────────────────

describe("the queue", () => {
  const q = (id: string, fire_at: number, queued = false): QueueEntry =>
    ({ id, fire_at, kind: "turn", why: "turn finished", queued, label: null });

  test("fire order, with the already-queued ahead of anything still inside its grace", () => {
    const out = orderQueue([
      q("armed-late", T0 + 45_000),
      q("queued-old", T0 - 600_000, true),
      q("armed-soon", T0 + 5_000),
      q("queued-new", T0 - 60_000, true),
    ]);
    assert.deepEqual(out.map((x) => x.id), ["queued-old", "queued-new", "armed-soon", "armed-late"]);
  });

  test("a tie breaks on id, so the rail's numbering does not reshuffle between two refreshes", () => {
    assert.deepEqual(orderQueue([q("b", T0), q("a", T0)]).map((x) => x.id), ["a", "b"]);
    assert.deepEqual(orderQueue([q("a", T0), q("b", T0)]).map((x) => x.id), ["a", "b"]);
  });

  test("ordering never mutates what it was handed", () => {
    const input = [q("b", T0 + 1), q("a", T0)];
    orderQueue(input);
    assert.deepEqual(input.map((x) => x.id), ["b", "a"]);
  });
});

// ── his own state ───────────────────────────────────────────────────────────────────────────────

describe("what Robert himself is doing", () => {
  test("nothing in flight = idle, and the card falls back to when he last spoke", () => {
    const r = robertState({ looking: [], claimed: [], lastTurnAt: iso(T0 - 300_000) });
    assert.equal(r.state, "idle");
    assert.equal(r.ws, null);
    assert.equal(r.since, null);
    assert.equal(r.last_turn_at, iso(T0 - 300_000));
  });

  test("a watch mid-look is busy, on that watch's client", () => {
    const r = robertState({ looking: [{ workspace_id: "ws-atlas", since: T0 - 30_000 }], claimed: [], lastTurnAt: null });
    assert.equal(r.state, "busy");
    assert.equal(r.ws, "ws-atlas");
    assert.equal(r.since, T0 - 30_000);
  });

  test("a claimed-but-unhandled wake is busy too, and the longest-running turn is the one named", () => {
    const r = robertState({
      looking: [{ workspace_id: "ws-new", since: T0 - 10_000 }],
      claimed: [{ workspace_id: "ws-old", claimed_at: iso(T0 - 900_000) }],
      lastTurnAt: iso(T0 - 900_000),
    });
    assert.equal(r.state, "busy");
    assert.equal(r.ws, "ws-old", "the turn that has been running longest is the one worth naming");
    assert.equal(r.since, T0 - 900_000);
  });

  test("a corrupt claim stamp does not turn into NaN on the card", () => {
    const r = robertState({ looking: [], claimed: [{ workspace_id: "ws1", claimed_at: "not a date" }], lastTurnAt: null });
    assert.equal(r.state, "busy");
    assert.equal(r.since, null);
  });
});

// ── the widget's own contract ───────────────────────────────────────────────────────────────────

describe("the registered widget", () => {
  test("name, title and refresh match the client module, and the topics are real bus topics", () => {
    assert.equal(robert.name, "robert");
    assert.equal(robert.title, "Robert's attention");
    const bus = fs.readFileSync(path.join(process.cwd(), "src/bus.ts"), "utf8");
    for (const t of robert.topics ?? []) assert.match(bus, new RegExp(`topic: "${t}"`), `${t} is not a bus topic`);
    assert.ok((robert.topics ?? []).includes("session.status"), "a status change is what arms a wake");
  });

  test("data() answers on a bare daemon: the graph draws, and nothing is NaN", () => {
    const d = robert.data({}) as any;
    assert.ok(Number.isFinite(d.now));
    assert.deepEqual(d.nodes, []);
    assert.deepEqual(d.queue, []);
    assert.equal(d.more, 0);
    assert.equal(d.robert.state, "idle");
    assert.equal(typeof d.supervision.ok, "boolean");
    assert.equal(d.supervision.in_flight, 0);
    assert.equal(typeof d.supervision.armed, "number");
  });
});

describe("the client module", () => {
  const js = fs.readFileSync(path.join(process.cwd(), "static/desk-widgets/robert.js"), "utf8");

  test("it is in both registries, exactly once", () => {
    assert.match(fs.readFileSync(path.join(process.cwd(), "src/widgets/index.ts"), "utf8"), /import robert from "\.\/robert\.js";/);
    assert.match(fs.readFileSync(path.join(process.cwd(), "static/desk-widgets/index.js"), "utf8"), /"robert"/);
  });

  test("it declares the same name, title, topics and a 10s refresh", () => {
    assert.match(js, /name: "robert",/);
    assert.match(js, /title: "Robert's attention",/);
    assert.match(js, /refreshMs: 10000,/);
    assert.match(js, /topics: \["session\.status", "session\.updated", "session\.ended", "agent\.push"\],/);
  });

  test("it renders idempotently, from lib.js, and stages the terminal you click", () => {
    assert.match(js, /import \{ el, fmtAgo, PHASE_COLOR \} from "\.\/lib\.js";/);
    assert.match(js, /host\.replaceChildren\(/, "render replaces its output rather than appending to it");
    assert.match(js, /ctx\.stage\(n\.id\)/);
    assert.match(js, /ctx\.wsColor\(n\.workspace_id\)/);
    assert.match(js, /ctx\.chipLabel\(/);
  });

  test("the three edges are typed the way the legend says they are", () => {
    assert.match(js, /dash: "5 4"/, "an armed wake is the dashed one");
    assert.match(js, /last \? "var\(--ink\)" : e\.color/, "what woke him last is the bold one");
    assert.match(js, /solid = watching · dashed = armed wake · bold = what woke him last/);
    assert.match(js, /nothing armed — he's waiting on the fleet/);
  });

  test("every emptiness has its own calm line, and an unread supervision never cries gap", () => {
    assert.match(js, /no terminals on the desk/);
    assert.match(js, /nothing queued/);
    // `ok` absent is a failed or not-yet-landed read, not a supervision gap.
    assert.match(js, /const known = typeof sup\.ok === "boolean";/);
    assert.match(js, /"supervision unread"/);
    assert.match(js, /known && !sup\.ok && sup\.reason/);
  });

  test("the labels are laid out clear of the nodes — the ring is small inside a wide box", () => {
    assert.match(js, /const W = 640, H = 300, CX = 320, CY = 148, RX = 140, RY = 100;/);
    // A top node's sub-label under its own circle is how the first draft read; it goes above instead.
    assert.match(js, /const ty = right \|\| left \? p\.y \+ 3 : p\.sin > 0 \? p\.y \+ 25 : p\.y - 27;/);
  });

  test("tokens only, and the page's own 1Hz clock is the only thing that moves", () => {
    assert.doesNotMatch(js, /#[0-9a-fA-F]{3,8}\b/, "no literal colours — dark mode is the tokens");
    assert.doesNotMatch(js, /@keyframes|animation:|animation-name:|transition:/);
    assert.match(js, /body\.blink \.rbt-look \{ opacity:\.3; \}/);
  });
});
