/** The pure parts of scripts/stt-bench.mjs and scripts/whisper-models.mjs. */
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore — plain .mjs scripts, no types
import { wordErrors, normWords, parseEngine, padWav } from "../scripts/stt-bench.mjs";
// @ts-ignore
import { pickWhisperModel, pickFinalModel } from "../scripts/whisper-models.mjs";

test("word errors ignore case, accents and punctuation; count substitutions, insertions and deletions", () => {
  assert.deepEqual(normWords("¡Colgá, YA!"), ["colga", "ya"]);
  assert.deepEqual(wordErrors("Sí.", "si"), [0, 1]);
  assert.deepEqual(wordErrors("Dale, mergealo ya", "dale merge alo ya"), [2, 3]);
  assert.deepEqual(wordErrors("uno dos tres", ""), [3, 3]);
  assert.deepEqual(wordErrors("uno dos", "uno tres dos"), [1, 2]);
});

test("an engine spec carries its URL and per-request whisper fields", () => {
  assert.deepEqual(parseEngine("final=http://127.0.0.1:7781/inference;audio_ctx=768;prompt=@"), {
    name: "final", url: "http://127.0.0.1:7781/inference", fields: { audio_ctx: "768", prompt: "@" },
  });
  assert.deepEqual(parseEngine("fast=http://h/inference").fields, {});
  assert.throws(() => parseEngine("nourl"));
  assert.throws(() => parseEngine("a=http://h;bad"));
});

test("padding appends silence and keeps the WAV header honest; anything else is left alone", () => {
  const b = Buffer.alloc(44 + 3200);
  b.write("RIFF", 0, "latin1"); b.write("WAVEfmt ", 8, "latin1"); b.writeUInt32LE(16000, 24); b.writeUInt16LE(2, 32); b.write("data", 36, "latin1"); b.writeUInt32LE(3200, 40);
  const p = padWav(b, 500);
  assert.equal(p.length, 44 + 3200 + 16000);
  assert.equal(p.readUInt32LE(40), 3200 + 16000);
  assert.equal(p.readUInt32LE(4), p.length - 8);
  assert.equal(padWav(b, 0), b);
  const other = Buffer.from("OggS....");
  assert.equal(padWav(other, 500), other);
});

test("the fast engine takes small; the second engine the largest OTHER multilingual model, or none", () => {
  const all = ["ggml-base.en.bin", "ggml-large-v3-turbo.bin", "ggml-small.bin"];
  assert.equal(pickWhisperModel(all), "ggml-small.bin");
  assert.equal(pickFinalModel(all, "ggml-small.bin"), "ggml-large-v3-turbo.bin");
  assert.equal(pickFinalModel(["ggml-small.bin", "ggml-base.en.bin"], "ggml-small.bin"), null, "nothing larger: no second engine");
  assert.equal(pickFinalModel(["ggml-large-v3-turbo.bin"], "ggml-large-v3-turbo.bin"), null, "never the fast engine's own model twice");
  assert.equal(pickFinalModel(["ggml-small.bin", "ggml-medium.bin", "ggml-large-v3.bin"], "ggml-small.bin"), "ggml-large-v3.bin");
  assert.equal(pickFinalModel(all, "ggml-small.bin", "ggml-medium.bin"), null, "a pinned file that is not there");
  assert.equal(pickFinalModel([...all, "ggml-medium.bin"], "ggml-small.bin", "ggml-medium.bin"), "ggml-medium.bin");
  assert.equal(pickFinalModel(["ggml-small.bin", "ggml-medium.en.bin"], "ggml-small.bin"), null, "English-only is never the second engine");
});
