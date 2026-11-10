/**
 * The call clips kept for diagnosis (src/voice-clips.ts): off by default, capped, sealed from every
 * agent, gone when the setting goes off.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keepClip, listClips, wipeClips, overCap, wavStats, clipsDir, KEEP, MAX_CLIP_BYTES } from "./voice-clips.js";
import { CONFIG } from "./config.js";
import { setting } from "./settings.js";
import { derivedWriteRefusal, FLEET_PRIVATE_READS } from "./robert-scope.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-clips-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A 16 kHz mono 16-bit WAV: `lead` ms of silence, `tone` ms at `amp`, `tail` ms of silence. */
function wav(lead: number, tone: number, tail: number, amp = 0.3): Buffer {
  const n = (ms: number) => Math.round(16 * ms);
  const total = n(lead) + n(tone) + n(tail);
  const b = Buffer.alloc(44 + total * 2);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(36 + total * 2, 4); b.write("WAVEfmt ", 8, "latin1");
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36, "latin1"); b.writeUInt32LE(total * 2, 40);
  for (let i = 0; i < n(tone); i++) b.writeInt16LE(Math.round(amp * 32767 * Math.sin((2 * Math.PI * 200 * i) / 16000)), 44 + (n(lead) + i) * 2);
  return b;
}

test("off by default, one setting for the Mac, and its directory is sealed from every agent sandbox", () => {
  assert.equal(setting("voice.keep_clips"), false);
  assert.ok(CONFIG.sandbox.sealed.includes(clipsDir()), "config.ts → sandbox.sealed names the clips directory");
  assert.ok(!path.resolve(clipsDir()).startsWith(path.resolve(process.cwd()) + path.sep), "outside the checkout the daemon stages");
});

test("no Robert credential turns the recording on or lists the clips", () => {
  const req = (key: string) => ({ method: "PUT", route: { path: "/settings" }, body: { key, value: true } }) as any;
  assert.match(String(derivedWriteRefusal(req("voice.keep_clips"))), /operator-only/);
  assert.equal(derivedWriteRefusal(req("voice.vocab")), null, "an ordinary voice setting is not walled");
  assert.ok(FLEET_PRIVATE_READS.has("GET /voice/clips"));
});

test("levels of a clip: length, loudness, a start that is already loud (onset cut), the quiet tail", () => {
  const s = wavStats(wav(350, 400, 750))!;
  assert.equal(s.audio_ms, 1500);
  assert.ok(s.peak > 0.15 && s.rms > 0.05 && s.rms < s.peak);
  assert.equal(s.head_rms, 0, "350 ms of pre-roll: the clip starts in silence");
  assert.ok(Math.abs(s.tail_quiet_ms - 750) <= 40, `quiet tail ${s.tail_quiet_ms}`);
  const cut = wavStats(wav(0, 400, 750))!;
  assert.ok(cut.head_rms > 0.1, "no pre-roll: the first 60 ms are already speech");
  assert.equal(wavStats(Buffer.from("not audio")), null);
});

test("which clips go when over the cap: oldest first, by count and by bytes", () => {
  const clips = [1, 2, 3, 4, 5].map((i) => ({ id: i, bytes: 100 }));
  assert.deepEqual(overCap(clips, 3, 10_000).map((c) => c.id), [1, 2]);
  assert.deepEqual(overCap(clips, 40, 250).map((c) => c.id), [1, 2, 3]);
  assert.deepEqual(overCap(clips, 40, 10_000), []);
  assert.deepEqual(overCap([{ id: 9, bytes: 500 }], 40, 100).map((c) => c.id), [9], "one clip larger than the whole budget is not kept either");
});

test("a kept clip lands with its transcript, private to the user; the cap drops the oldest file too", () => {
  let now = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 5; i++) {
    const c = keepClip(wav(350, 300, 750), { text: `uno ${i}`, lang: "es", engine: "final", ms: 400 + i }, { dir, now: (now += 1000), keep: 3 });
    assert.ok(c && c.stats?.audio_ms === 1400);
  }
  const list = listClips(dir);
  assert.deepEqual(list.map((c) => c.text), ["uno 4", "uno 3", "uno 2"], "newest first, the last three");
  assert.equal(list[0].engine, "final");
  const onDisk = fs.readdirSync(dir).filter((f) => f.endsWith(".wav")).sort();
  assert.deepEqual(onDisk, list.map((c) => c.file).sort(), "no file outlives its index entry");
  assert.equal(fs.statSync(dir).mode & 0o077, 0, "the directory is the user's alone");
  assert.equal(fs.statSync(path.join(dir, list[0].file)).mode & 0o077, 0);
  assert.equal(fs.statSync(path.join(dir, "index.json")).mode & 0o077, 0);
  assert.equal(KEEP, 40);
});

test("the blank clip that warms the engine, an empty body and an oversized one are not kept", () => {
  const before = listClips(dir).length;
  assert.equal(keepClip(wav(0, 0, 400), { text: "" }, { dir }), null, "digital silence");
  assert.equal(keepClip(Buffer.alloc(0), { text: "" }, { dir }), null);
  assert.equal(keepClip(Buffer.alloc(MAX_CLIP_BYTES + 1, 1), { text: "x" }, { dir }), null);
  assert.equal(listClips(dir).length, before);
});

test("a stray file in the directory does not survive the next clip, and a hostile index entry is ignored", () => {
  fs.writeFileSync(path.join(dir, "left-behind.wav"), "x");
  const idx = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
  idx.clips.push({ file: "../../etc/passwd", text: "x", bytes: 1, at: "" });
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(idx));
  keepClip(wav(350, 300, 750), { text: "otra" }, { dir, keep: 3 });
  assert.ok(!fs.existsSync(path.join(dir, "left-behind.wav")));
  assert.ok(listClips(dir).every((c) => /^[\w.-]+$/.test(c.file)));
});

test("turning it off leaves nothing behind", () => {
  assert.ok(listClips(dir).length > 0);
  wipeClips(dir);
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(listClips(dir), []);
  wipeClips(dir); // twice is fine
});
