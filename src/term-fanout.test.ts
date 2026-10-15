import { test } from "node:test";
import assert from "node:assert/strict";
import { ACC_CAP, clampRate, fanOut, type TermClient } from "./term-fanout.js";

function client(over: Partial<TermClient> = {}): TermClient & { sent: string[] } {
  const c: any = { readyState: 1, bufferedAmount: 0, sent: [] as string[], send(d: string) { c.sent.push(d); }, ...over };
  return c;
}

test("an unpaced client gets every flush", () => {
  const c = client();
  fanOut([c], "a", 1000);
  fanOut([c], "b", 1010);
  assert.deepEqual(c.sent, ["a", "b"]);
});

test("a paced client accumulates and gets one frame per slot", () => {
  const c = client({ _rate: 250 });
  let r = fanOut([c], "a", 1000);
  assert.deepEqual(c.sent, ["a"], "first frame goes straight out");
  r = fanOut([c], "b", 1016);
  assert.deepEqual(c.sent, ["a"], "second is held");
  assert.equal(r.again, 234, "asks to be ticked when the slot opens");
  r = fanOut([c], "c", 1100);
  assert.deepEqual(c.sent, ["a"]);
  r = fanOut([c], "", 1250);
  assert.deepEqual(c.sent, ["a", "bc"], "held bytes leave as one frame, in order");
  assert.equal(r.again, 0);
});

test("pacing one client never delays another", () => {
  const fast = client(), slow = client({ _rate: 500 });
  fanOut([fast, slow], "a", 1000);
  fanOut([fast, slow], "b", 1016);
  assert.deepEqual(fast.sent, ["a", "b"]);
  assert.deepEqual(slow.sent, ["a"]);
});

test("a paced client whose backlog outgrows the cap is resynced, not flooded", () => {
  const c = client({ _rate: 5000, _lastSend: 1000 });
  const r = fanOut([c], "x".repeat(ACC_CAP + 1), 1001);
  assert.deepEqual(c.sent, []);
  assert.ok(r.resync.includes(c));
  assert.equal(c._acc, "");
});

test("a lagging client is cut off and resynced once it drains", () => {
  const c = client({ bufferedAmount: 2_000_000 });
  let r = fanOut([c], "a", 1000);
  assert.deepEqual(c.sent, []);
  assert.equal(c._lagging, true);
  assert.equal(r.again, 250, "keeps a slow tick alive while it drains");
  c.bufferedAmount = 0;
  r = fanOut([c], "b", 1250);
  assert.ok(r.resync.includes(c), "recovered laggard is replayed from scrollback");
  assert.deepEqual(c.sent, [], "the frame it missed is not sent piecemeal");
});

test("closed sockets are skipped", () => {
  const c = client({ readyState: 3 });
  fanOut([c], "a", 1000);
  assert.deepEqual(c.sent, []);
});

test("clampRate: at or under one flush means unpaced, and there is a ceiling", () => {
  assert.equal(clampRate(0), 0);
  assert.equal(clampRate(16), 0);
  assert.equal(clampRate("250"), 250);
  assert.equal(clampRate(99999), 5000);
  assert.equal(clampRate("nope"), 0);
});
