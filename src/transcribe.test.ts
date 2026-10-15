import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { transcribe, audioFilename, transcribeFailure, TranscribeError } from "./transcribe.js";
import { ffmpegProblem } from "../bin/ffmpeg-check.mjs";

// Stand-in ffmpegs: one healthy, one that dies in dyld at load like the x265-upgrade breakage.
const bins = fs.mkdtempSync(path.join(os.tmpdir(), "ffmpeg-check-"));
const shim = (name: string, body: string) => {
  const p = path.join(bins, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
};
const GOOD = shim("ffmpeg-ok", 'echo "ffmpeg version 8.0"');
const DYLD = shim(
  "ffmpeg-dyld",
  'echo "dyld[4242]: Library not loaded: /opt/homebrew/opt/x265/lib/libx265.215.dylib" >&2\nkill -ABRT $$'
);
process.env.CHRONOS_FFMPEG = GOOD;
after(() => fs.rmSync(bins, { recursive: true, force: true }));

// A stand-in engine: records the multipart body it got and answers like whisper.cpp (or as told).
let lastBody = "";
let reply: { status: number; body: string } | null = null;
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    lastBody = Buffer.concat(chunks).toString("latin1");
    res.statusCode = reply?.status ?? 200;
    res.setHeader("content-type", "application/json");
    res.end(reply?.body ?? JSON.stringify({ text: " hello " }));
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

test("ffmpegProblem runs the binary: healthy, dyld-broken and missing are told apart", () => {
  assert.equal(ffmpegProblem(GOOD), null);
  const broken = ffmpegProblem(DYLD);
  assert.match(broken ?? "", /^ffmpeg broken: dyld\[4242\]: Library not loaded: .*libx265\.215\.dylib/);
  assert.match(broken ?? "", /-version → SIGABRT/);
  assert.match(ffmpegProblem(path.join(bins, "nope")) ?? "", /ffmpeg not installed/);
});

test("whisper's opaque 'FFmpeg conversion failed' is explained by probing ffmpeg, reason first", async () => {
  process.env.CHRONOS_FFMPEG = DYLD;
  reply = { status: 500, body: JSON.stringify({ error: "FFmpeg conversion failed." }) };
  try {
    const e = await transcribe(Buffer.alloc(10375), { contentType: "audio/webm;codecs=opus" }).then(
      () => assert.fail("should have thrown"),
      (err) => err
    );
    assert.ok(e instanceof TranscribeError);
    assert.equal(e.status, 500);
    assert.match(e.body ?? "", /FFmpeg conversion failed/);
    assert.match(e.message, /^ffmpeg broken: dyld.*libx265\.215\.dylib.* — transcription HTTP 500: .*FFmpeg conversion failed/);

    const f = transcribeFailure(e, { mime: "audio/webm;codecs=opus", bytes: 10375 });
    assert.equal(f.error, e.message);
    for (const bit of [
      `engine=${process.env.CHRONOS_TRANSCRIBE_URL}`,
      "mime=audio/webm;codecs=opus",
      "bytes=10375",
      "status=500",
      "FFmpeg conversion failed",
      "libx265.215.dylib",
    ])
      assert.ok(f.log.includes(bit), `log is missing ${bit}: ${f.log}`);
    assert.match(f.log, /^\[transcribe\] FAILED /);
  } finally {
    process.env.CHRONOS_FFMPEG = GOOD;
    reply = null;
  }
});

test("with a healthy ffmpeg an engine error passes through untouched", async () => {
  reply = { status: 400, body: JSON.stringify({ error: "bad audio" }) };
  try {
    await assert.rejects(transcribe(Buffer.from("x"), { contentType: "audio/mp4" }), (e: any) => {
      assert.equal(e.message, 'transcription HTTP 400: {"error":"bad audio"}');
      assert.equal(e.ffmpeg, null);
      return true;
    });
  } finally {
    reply = null;
  }
});

test("a dead engine logs its connection cause and status '-'", async () => {
  const f = transcribeFailure(
    new TranscribeError("transcription engine not reachable at http://127.0.0.1:1/inference", {
      engine: "http://127.0.0.1:1/inference",
      cause: Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    }),
    { mime: "audio/mp4", bytes: 42 }
  );
  assert.match(f.log, /engine=http:\/\/127\.0\.0\.1:1\/inference mime=audio\/mp4 bytes=42 status=- cause=ECONNREFUSED/);
});
