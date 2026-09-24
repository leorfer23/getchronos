import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { transcribe, audioFilename } from "./transcribe.js";

// A stand-in engine: records the multipart body it got and answers like whisper.cpp.
let lastBody = "";
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    lastBody = Buffer.concat(chunks).toString("latin1");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ text: " hello " }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
process.env.CHRONOS_TRANSCRIBE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/inference`;
after(() => server.close());

test("audioFilename matches the extension to the recorded container", () => {
  assert.equal(audioFilename("audio/mp4"), "audio.m4a");
  assert.equal(audioFilename("audio/mp4;codecs=mp4a.40.2"), "audio.m4a");
  assert.equal(audioFilename("audio/webm;codecs=opus"), "audio.webm");
  assert.equal(audioFilename("audio/ogg;codecs=opus"), "audio.ogg");
  assert.equal(audioFilename("audio/wav"), "audio.wav");
  assert.equal(audioFilename(""), "audio.webm");
});

test("an iOS audio/mp4 clip reaches the engine named .m4a, not .webm", async () => {
  const text = await transcribe(Buffer.from("ftypM4A fake"), { contentType: "audio/mp4" });
  assert.equal(text, "hello");
  assert.match(lastBody, /filename="audio\.m4a"/);
  assert.match(lastBody, /Content-Type: audio\/mp4/i);
  assert.doesNotMatch(lastBody, /audio\.webm/);
});

test("an Android audio/webm;codecs=opus clip reaches the engine named .webm with its full type", async () => {
  await transcribe(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), { contentType: "audio/webm;codecs=opus" });
  assert.match(lastBody, /filename="audio\.webm"/);
  assert.match(lastBody, /Content-Type: audio\/webm;codecs=opus/i);
});

test("an explicit filename still wins", async () => {
  await transcribe(Buffer.from("OggS"), { filename: "voice.oga", contentType: "audio/ogg" });
  assert.match(lastBody, /filename="voice\.oga"/);
});

test("an engine that isn't listening fails loudly with its URL, not a bare 'fetch failed'", async () => {
  const prev = process.env.CHRONOS_TRANSCRIBE_URL;
  const dead = http.createServer();
  await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
  const port = (dead.address() as AddressInfo).port;
  await new Promise((r) => dead.close(r));
  process.env.CHRONOS_TRANSCRIBE_URL = `http://127.0.0.1:${port}/inference`;
  try {
    await assert.rejects(
      transcribe(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), { contentType: "audio/webm;codecs=opus" }),
      new RegExp(`transcription engine not reachable at http://127\\.0\\.0\\.1:${port}/inference`)
    );
  } finally {
    process.env.CHRONOS_TRANSCRIBE_URL = prev;
  }
});
