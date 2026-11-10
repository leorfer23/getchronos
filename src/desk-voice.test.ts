/**
 * The Desk voice call lives in static/desk.html (no build step). Its two pure pieces — the WAV the
 * mic hands whisper, and what of a chat reply is read out — are lifted out of the page and run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");

const fn = (name: string) => {
  const at = html.indexOf(`function ${name}(`);
  assert.ok(at >= 0, name);
  return html.slice(at, html.indexOf("\n}\n", at) + 2);
};

test("vcWav writes 16kHz mono PCM whisper can read", async () => {
  const VC = { rate: 48000 };
  const vcWav = new Function("VC", fn("vcWav") + "; return vcWav;")(VC);
  const blob: Blob = vcWav([new Float32Array(48000).fill(0.5), new Float32Array(24000).fill(-0.5)]);
  const dict: Blob = vcWav([new Float32Array(44100).fill(0.5)], 44100);
  assert.equal(Buffer.from(await dict.arrayBuffer()).readUInt32LE(40), 16000 * 2);
  const b = Buffer.from(await blob.arrayBuffer());
  assert.equal(b.subarray(0, 4).toString(), "RIFF");
  assert.equal(b.readUInt32LE(24), 16000);
  assert.equal(b.readUInt16LE(22), 1);
  assert.equal(b.readUInt32LE(40), 24000 * 2);
  assert.ok(b.readInt16LE(44 + 100) > 16000 && b.readInt16LE(44 + 40000) < -16000);
});

test("speakable turns chat markdown into words", () => {
  const S = { sessions: [{ id: "abcd1234-0000-0000-0000-000000000000" }] };
  const VC = { lang: "en" };
  const speakable = new Function("S", "VC", "chipLabel", fn("speakable") + "; return speakable;")(S, VC, () => "the loader fix");
  assert.equal(speakable('**Done** — opened abcd1234.\nUI {"op":"select","id":"abcd1234"}'), "Done — opened the loader fix.");
  assert.equal(speakable("- atlas · 2 waiting\n- see https://x.y/z 🚀"), "atlas, 2 waiting see a link");
  assert.equal(speakable("```\ncode\n```ok"), "ok");
  assert.equal(speakable("Need your call.\n\n::ask 0123abcd-4567-89ab-cdef-0123456789ab::"), "Need your call.", "an Ask card is on screen, not read out");
});
