import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DATA_HEADER_BYTES, MAX_CONTROL_BYTES, MAX_DATA_PAYLOAD, PROTOCOL_VERSION, RING_BYTES, Ring, SeqTracker, WireError,
  checkCompat, chunk, decodeControl, decodeData, encodeControl, encodeData,
} from "./wire.js";

// ───────────────────────────── control ─────────────────────────────

test("control frames round-trip as JSON", () => {
  const f = { t: "rpc" as const, id: "r1", op: "vitals", args: { x: 1 } };
  assert.deepEqual(decodeControl(encodeControl(f)), f);
  assert.deepEqual(decodeControl(Buffer.from(encodeControl(f))), f);
});

test("a control frame that is not an object with a type is malformed", () => {
  for (const bad of ["nope", "[]", "null", "42", '{"x":1}', '{"t":7}']) {
    assert.throws(() => decodeControl(bad), (e: any) => e instanceof WireError && e.code === "malformed", bad);
  }
});

test("an unknown frame type decodes — a newer minor may add kinds", () => {
  assert.equal((decodeControl('{"t":"future_thing","a":1}') as any).t, "future_thing");
});

test("oversized control frames are refused both ways", () => {
  const huge = "x".repeat(MAX_CONTROL_BYTES + 1);
  assert.throws(() => encodeControl({ t: "transcript", ch: 1, delta: huge }), (e: any) => e.code === "oversized");
  assert.throws(() => decodeControl(huge), (e: any) => e.code === "oversized");
});

// ───────────────────────────── data ─────────────────────────────

test("data frames round-trip channel, seq and bytes", () => {
  const bytes = Buffer.from("\x1b[31mhello\x1b[0m", "binary");
  const enc = encodeData(7, 123456789012, bytes);
  assert.equal(enc.length, DATA_HEADER_BYTES + bytes.length);
  const dec = decodeData(enc);
  assert.equal(dec.ch, 7);
  assert.equal(dec.seq, 123456789012);
  assert.deepEqual(Buffer.from(dec.bytes), bytes);
});

test("an empty payload is a valid frame", () => {
  const dec = decodeData(encodeData(0, 1, Buffer.alloc(0)));
  assert.equal(dec.bytes.length, 0);
});

test("data encode refuses oversized payloads and bad channel/seq", () => {
  assert.throws(() => encodeData(1, 1, Buffer.alloc(MAX_DATA_PAYLOAD + 1)), (e: any) => e.code === "oversized");
  assert.doesNotThrow(() => encodeData(1, 1, Buffer.alloc(MAX_DATA_PAYLOAD)));
  assert.throws(() => encodeData(-1, 1, Buffer.alloc(1)));
  assert.throws(() => encodeData(2 ** 32, 1, Buffer.alloc(1)));
  assert.throws(() => encodeData(1, -1, Buffer.alloc(1)));
  assert.throws(() => encodeData(1, 1.5, Buffer.alloc(1)));
});

test("data decode refuses short, foreign, unknown-kind and oversized buffers", () => {
  assert.throws(() => decodeData(Buffer.alloc(3)), (e: any) => e.code === "malformed");
  const ok = encodeData(1, 1, Buffer.from("a"));
  const foreign = Buffer.from(ok); foreign[0] = 0x00;
  assert.throws(() => decodeData(foreign), (e: any) => e.code === "malformed");
  const kind = Buffer.from(ok); kind[1] = 0x09;
  assert.throws(() => decodeData(kind), (e: any) => e.code === "unknown");
  const big = Buffer.alloc(DATA_HEADER_BYTES + MAX_DATA_PAYLOAD + 1);
  big.set(ok.subarray(0, DATA_HEADER_BYTES));
  assert.throws(() => decodeData(big), (e: any) => e.code === "oversized");
  const farSeq = Buffer.from(ok); farSeq.writeBigUInt64BE(2n ** 60n, 6);
  assert.throws(() => decodeData(farSeq), (e: any) => e.code === "malformed");
});

test("chunk splits in order and reassembles to the original", () => {
  const src = Buffer.from(Array.from({ length: 10_000 }, (_, i) => i % 251));
  const parts = chunk(src, 4096);
  assert.deepEqual(parts.map((p) => p.length), [4096, 4096, 1808]);
  assert.deepEqual(Buffer.concat(parts), src);
  assert.deepEqual(chunk(Buffer.alloc(0)), []);
});

// ───────────────────────────── versions ─────────────────────────────

test("same major is compatible whatever the minor; another major or garbage is not", () => {
  assert.deepEqual(checkCompat(PROTOCOL_VERSION), { ok: true });
  assert.deepEqual(checkCompat("1.9", "1.0"), { ok: true });
  const v = checkCompat("2.0", "1.0");
  assert.equal(v.ok, false);
  assert.match((v as any).reason, /update this host/);
  assert.equal(checkCompat(undefined).ok, false);
  assert.equal(checkCompat("1").ok, false);
  assert.equal(checkCompat("v1.0").ok, false);
});

// ───────────────────────────── ring ─────────────────────────────

const b = (s: string) => Buffer.from(s);

test("ring numbers frames from 1 and replays everything unacked in order", () => {
  const r = new Ring(1024, 5);
  const seqs = ["a", "b", "c"].map((s) => r.append(b(s)).seq);
  assert.deepEqual(seqs, [1, 2, 3]);
  const rep = r.since(0);
  assert.equal(rep.gap, false);
  assert.deepEqual(rep.frames.map((f) => [f.ch, f.seq, f.bytes.toString()]), [[5, 1, "a"], [5, 2, "b"], [5, 3, "c"]]);
});

test("ack drops what the peer has; replay after the ack resends only the rest", () => {
  const r = new Ring(1024);
  for (const s of ["one", "two", "three", "four"]) r.append(b(s));
  r.ack(2);
  assert.equal(r.bytes, "three".length + "four".length);
  assert.deepEqual(r.since(2).frames.map((f) => f.bytes.toString()), ["three", "four"]);
  // A reconnecting peer that says it saw 3 gets exactly 4.
  assert.deepEqual(r.since(3).frames.map((f) => f.seq), [4]);
});

test("stale, duplicate and future acks are harmless", () => {
  const r = new Ring(1024);
  for (const s of ["a", "b", "c"]) r.append(b(s));
  r.ack(2);
  r.ack(1); // stale
  r.ack(2); // duplicate
  assert.equal(r.acked, 2);
  r.ack(99); // from the future: clamped to what exists
  assert.equal(r.acked, 3);
  assert.equal(r.bytes, 0);
  r.append(b("d"));
  assert.deepEqual(r.since(r.acked).frames.map((f) => f.seq), [4]);
});

test("the ring is bounded by bytes: oldest unacked output is evicted and the replay reports a gap", () => {
  const r = new Ring(10);
  r.append(b("aaaa")); // 1
  r.append(b("bbbb")); // 2
  r.append(b("cccc")); // 3 → 12 bytes > 10, evict 1
  assert.equal(r.bytes, 8);
  const rep = r.since(0);
  assert.equal(rep.gap, true);
  assert.deepEqual(rep.frames.map((f) => f.seq), [2, 3]);
  // A peer that had already seen past the hole sees no gap.
  assert.equal(r.since(1).gap, false);
});

test("eviction of already-acked frames is not a gap", () => {
  const r = new Ring(8);
  r.append(b("aaaa"));
  r.ack(1);
  r.append(b("bbbb"));
  r.append(b("cccc"));
  assert.equal(r.since(1).gap, false);
});

test("a frame larger than the ring is kept alone (never split), older output goes", () => {
  const r = new Ring(8);
  r.append(b("ab"));
  r.append(b("0123456789ABCDEF"));
  const rep = r.since(0);
  assert.deepEqual(rep.frames.map((f) => f.seq), [2]);
  assert.equal(rep.gap, true);
  assert.equal(r.bytes, 16);
});

test("wraparound: many cycles through a small ring keep order, size and seq continuity", () => {
  const r = new Ring(100);
  let acked = 0;
  for (let i = 1; i <= 5000; i++) {
    r.append(Buffer.alloc(7, i % 256));
    assert.ok(r.bytes <= 100);
    if (i % 3 === 0) { r.ack(i - 1); acked = i - 1; }
  }
  const rep = r.since(acked);
  const seqs = rep.frames.map((f) => f.seq);
  assert.equal(seqs[seqs.length - 1], 5000);
  for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1] + 1);
  assert.equal(r.lastSeq, 5000);
});

test("default ring size matches the replayTail budget (256 KB)", () => {
  assert.equal(new Ring().cap, RING_BYTES);
  assert.equal(RING_BYTES, 256 * 1024);
});

test("the ring copies input: a caller reusing its buffer does not rewrite history", () => {
  const r = new Ring(64);
  const buf = Buffer.from("orig");
  r.append(buf);
  buf.write("XXXX");
  assert.equal(r.since(0).frames[0].bytes.toString(), "orig");
});

// ───────────────────────────── receiver ─────────────────────────────

test("seq tracker: in order is ok, overlap after a resend is dup, a jump is a gap", () => {
  const t = new SeqTracker();
  assert.equal(t.accept(1), "ok");
  assert.equal(t.accept(2), "ok");
  assert.equal(t.accept(2), "dup");
  assert.equal(t.accept(1), "dup");
  assert.equal(t.accept(5), "gap");
  assert.equal(t.lastSeq, 5);
  assert.equal(t.accept(6), "ok");
});

test("ring + tracker: a reconnect resend from the last ack delivers each seq exactly once", () => {
  const ring = new Ring(4096, 3);
  const rx = new SeqTracker();
  const seen: number[] = [];
  const deliver = (seq: number) => { if (rx.accept(seq) !== "dup") seen.push(seq); };
  for (let i = 0; i < 5; i++) deliver(ring.append(b(`p${i}`)).seq);
  ring.ack(3); // the brain acked 3 before the link dropped; 4 and 5 were in flight
  for (let i = 5; i < 8; i++) ring.append(b(`p${i}`)); // produced while offline
  for (const f of ring.since(ring.acked).frames) deliver(f.seq); // resend on reconnect
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8]);
});
