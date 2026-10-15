/**
 * The output spill (spill.ts): what a channel's ring evicts before the brain acked it, on disk, read
 * back in seq order on attach, gone once acked — and a clean slate when the host starts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SpillDir } from "./spill.js";
import { Ring } from "../hostlink/wire.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "chronos-spill-"));
const b = (s: string) => Buffer.from(s);

test("frames round-trip through the file, oldest first, filtered by seq", () => {
  const dir = path.join(tmp(), "spill");
  const s = new SpillDir(dir).forChannel(7);
  for (let i = 1; i <= 4; i++) assert.equal(s.put({ ch: 7, seq: i, bytes: b(`frame ${i}`) }), true);
  assert.deepEqual(s.since(0).map((f) => [f.ch, f.seq, f.bytes.toString()]), [[7, 1, "frame 1"], [7, 2, "frame 2"], [7, 3, "frame 3"], [7, 4, "frame 4"]]);
  assert.deepEqual(s.since(2).map((f) => f.seq), [3, 4]);
  assert.equal((fs.statSync(s.file).mode & 0o777).toString(8), "600");
});

test("an ack short of the newest spilled frame keeps the file; one past it deletes it", () => {
  const s = new SpillDir(path.join(tmp(), "spill")).forChannel(1);
  s.put({ ch: 1, seq: 1, bytes: b("a") });
  s.put({ ch: 1, seq: 2, bytes: b("b") });
  s.ack(1);
  assert.ok(fs.existsSync(s.file));
  assert.deepEqual(s.since(1).map((f) => f.seq), [2]);
  s.ack(5);
  assert.equal(fs.existsSync(s.file), false);
  assert.equal(s.bytes, 0);
  assert.deepEqual(s.since(0), []);
  // Still usable after: the next overflow starts a fresh file.
  assert.equal(s.put({ ch: 1, seq: 9, bytes: b("z") }), true);
  assert.deepEqual(s.since(0).map((f) => f.seq), [9]);
});

test("the cap is a hard no, never a partial write", () => {
  const s = new SpillDir(path.join(tmp(), "spill"), 40).forChannel(1);
  assert.equal(s.put({ ch: 1, seq: 1, bytes: Buffer.alloc(20) }), true); // 12 + 20 = 32
  assert.equal(s.put({ ch: 1, seq: 2, bytes: Buffer.alloc(20) }), false);
  assert.equal(s.bytes, 32);
  assert.deepEqual(s.since(0).map((f) => f.seq), [1]);
});

test("a host start wipes spills from the previous process (its PTYs died with it)", () => {
  const dir = path.join(tmp(), "spill");
  const old = new SpillDir(dir).forChannel(3);
  old.put({ ch: 3, seq: 1, bytes: b("stale") });
  assert.equal(fs.readdirSync(dir).length, 1);
  new SpillDir(dir);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("a ring backed by a file spill loses nothing across a long outage, then cleans up on ack and dispose", () => {
  const sd = new SpillDir(path.join(tmp(), "spill"));
  const sp = sd.forChannel(4);
  const r = new Ring(1024, 4, sp);
  const want: string[] = [];
  for (let i = 1; i <= 300; i++) { const s = `line ${i} `.padEnd(40, "."); want.push(s); r.append(b(s)); }
  assert.ok(r.bytes <= 1024);
  assert.ok(sp.bytes > 0, "the overflow went to disk");
  const rep = r.since(0);
  assert.equal(rep.gap, false);
  assert.deepEqual(rep.frames.map((f) => f.bytes.toString()), want);
  r.ack(300);
  assert.equal(fs.existsSync(sp.file), false);
  for (let i = 0; i < 100; i++) r.append(b("x".repeat(40)));
  assert.ok(fs.existsSync(sp.file));
  r.dispose();
  assert.equal(fs.existsSync(sp.file), false);
});
