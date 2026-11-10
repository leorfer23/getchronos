import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { neuralSpeak, pickVoice, resetNeuralState, sayable, sayArgs, speak } from "./speak.js";

const v = (name: string, lang: string) => ({ name, lang, premium: /\((Premium|Enhanced)\)/.test(name) });

test("Robert speaks with the best installed male voice, env pins a name per language", () => {
  const mac = [v("Zoe (Premium)", "en_US"), v("Daniel", "en_GB"), v("Evan (Enhanced)", "en_US"), v("Nathan (Premium)", "en_US"), v("Marisol (Premium)", "es_ES"), v("Jorge", "es_ES")];
  assert.equal(pickVoice("en", mac, {}), "Nathan (Premium)");
  assert.equal(pickVoice("es", mac, {}), "Jorge");
  assert.equal(pickVoice("en", [v("Zoe (Premium)", "en_US"), v("Daniel", "en_GB")], {}), "Daniel");
  assert.equal(pickVoice("es", [v("Marisol (Premium)", "es_ES"), v("Daniel", "en_GB")], {}), "Marisol (Premium)");
  assert.equal(pickVoice("en", [], {}), "Zoe (Premium)");
  assert.equal(pickVoice("en", mac, { CHRONOS_VOICE_EN: "Ava (Premium)" }), "Ava (Premium)");
  assert.equal(pickVoice("es", mac, { CHRONOS_VOICE_EN: "Ava (Premium)" }), "Jorge");
});

test("directive lines, control characters and runaway length never reach the synthesizer", () => {
  assert.equal(sayable('Opened it.\nUI {"op":"select","id":"abcd1234"}\n{"op":"refresh"}'), "Opened it.");
  assert.equal(sayable("a" + String.fromCharCode(7) + "b\r\nc"), "a b c");
  assert.equal(sayable("x".repeat(5000)).length, 1200);
});

test("text goes in on stdin, so it can never be read as a flag", () => {
  const args = sayArgs("Zoe (Premium)", "/tmp/o.m4a");
  assert.deepEqual(args.slice(-2), ["-f", "-"]);
  assert.ok(args.includes("--file-format=m4af"));
  assert.ok(!sayArgs("v", "o", 1000).includes("-r"));
  assert.deepEqual(sayArgs("v", "o", 200).slice(-2), ["-r", "200"]);
});

const hasSay = (() => {
  try { execFileSync("which", ["say"]); return process.platform === "darwin"; } catch { return false; }
})();
test("renders real AAC audio on a Mac", { skip: !hasSay ? "no say(1) on this machine" : process.env.CHRONOS_TEST_SLOW ? false : "slow suite: npm run test:all" }, async () => {
  const prev = process.env.CHRONOS_TTS_URL;
  process.env.CHRONOS_TTS_URL = "off"; // `say` itself — never the Kokoro service a dev Mac may run
  try {
    const out = await speak("-v Nope --help. Done.", "en");
    assert.equal(out.engine, "say");
    assert.equal(out.mime, "audio/mp4");
    assert.ok(out.audio.length > 2000);
    assert.equal(out.audio.subarray(4, 8).toString(), "ftyp");
  } finally {
    if (prev === undefined) delete process.env.CHRONOS_TTS_URL; else process.env.CHRONOS_TTS_URL = prev;
  }
});

// ── the neural engine (scripts/tts-server.py), against a stand-in ─────────────────────────────────
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40), Buffer.from([1, 2, 3, 4])]);
function stub(handler: (body: any, res: http.ServerResponse) => void): Promise<{ url: string; seen: any[]; close: () => void }> {
  const seen: any[] = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => { const body = raw ? JSON.parse(raw) : null; seen.push({ path: req.url, body }); handler(body, res); });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => {
    resolve({ url: `http://127.0.0.1:${(srv.address() as any).port}`, seen, close: () => srv.close() });
  }));
}

test("Kokoro answers first: its WAV is what /api/speak returns, with the language it was asked", async () => {
  resetNeuralState();
  const s = await stub((_b, res) => { res.writeHead(200, { "content-type": "audio/wav" }); res.end(WAV); });
  const prev = process.env.CHRONOS_TTS_URL;
  process.env.CHRONOS_TTS_URL = s.url + "/";
  try {
    const out = await speak("Hola, Leo.\nUI {\"op\":\"refresh\"}", "es");
    assert.equal(out.engine, "kokoro");
    assert.equal(out.mime, "audio/wav");
    assert.deepEqual(out.audio, WAV);
    assert.deepEqual(s.seen[0], { path: "/speak", body: { text: "Hola, Leo.", lang: "es" } }, "sayable() ran first, one slash");
  } finally {
    s.close();
    if (prev === undefined) delete process.env.CHRONOS_TTS_URL; else process.env.CHRONOS_TTS_URL = prev;
  }
});

test("anything but a WAV from Kokoro is not audio: null, so the caller falls back to say", async () => {
  resetNeuralState();
  const html = await stub((_b, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>nope</html>"); });
  const err = await stub((_b, res) => { res.writeHead(500); res.end("{}"); });
  try {
    assert.equal(await neuralSpeak("hi", "en", { url: html.url }), null);
    assert.equal(await neuralSpeak("hi", "en", { url: err.url }), null);
    assert.equal(await neuralSpeak("hi", "en", { url: "off" }), null);
  } finally { html.close(); err.close(); }
});

test("not installed (connection refused): skipped for 30s, then tried again", async () => {
  resetNeuralState();
  const s = await stub((_b, res) => { res.writeHead(200); res.end(WAV); });
  const url = s.url;
  s.close();
  await new Promise((r) => setTimeout(r, 50));
  const t = Date.now();
  assert.equal(await neuralSpeak("hi", "en", { url, now: t }), null);
  const up = await stub((_b, res) => { res.writeHead(200); res.end(WAV); });
  try {
    assert.equal(await neuralSpeak("hi", "en", { url: up.url, now: t + 1000 }), null, "still marked down");
    assert.equal(up.seen.length, 0, "…and not even asked");
    assert.deepEqual(await neuralSpeak("hi", "en", { url: up.url, now: t + 31_000 }), WAV, "asked again after the window");
  } finally { up.close(); resetNeuralState(); }
});
