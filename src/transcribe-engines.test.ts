/**
 * Two engines (src/transcribe.ts): live words on the fast one, finished sentences on the accurate one
 * when it is there, the vocabulary prompt, and the fallback that keeps a call from losing a sentence.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  pickEngine, hearFinal, warmFinal, vocabPrompt, finalFields, finalUrl, wavMs, resetFinalEngine, transcribeDetailed,
  TranscribeError, SHORT_CLIP_MS, PROMPT_MIN_MS, VOCAB_MAX_CHARS, FINAL_DOWN_MS, AUDIO_CTX_MAX_MS, collapseRepeat, type AskOpts, type Heard,
} from "./transcribe.js";
import { setting } from "./settings.js";

const FINAL = "http://127.0.0.1:7781/inference";
const URL_VARS = ["CHRONOS_TRANSCRIBE_URL", "CHRONOS_TRANSCRIBE_FINAL_URL", "CHRONOS_TRANSCRIBE_FINAL_AUDIO_CTX"] as const;
const saved = URL_VARS.map((k) => process.env[k]);
for (const k of URL_VARS) delete process.env[k];
after(() => URL_VARS.forEach((k, i) => { if (saved[i] == null) delete process.env[k]; else process.env[k] = saved[i]; }));

/** A 16 kHz mono 16-bit WAV of `ms` (its content does not matter here). */
function wav(ms: number): Buffer {
  const n = Math.round(16 * ms);
  const b = Buffer.alloc(44 + n * 2, 1);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8, "latin1");
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36, "latin1"); b.writeUInt32LE(n * 2, 40);
  return b;
}

test("defaults: sentences want the accurate engine, no vocabulary; the second engine is the local one, beside the local fast one only", () => {
  assert.equal(setting("voice.final_engine"), "accurate");
  assert.equal(setting("voice.vocab"), "");
  assert.equal(finalUrl(), FINAL);
  process.env.CHRONOS_TRANSCRIBE_FINAL_URL = "off";
  assert.equal(finalUrl(), null);
  process.env.CHRONOS_TRANSCRIBE_FINAL_URL = "http://10.0.0.2:9000/inference";
  assert.equal(finalUrl(), "http://10.0.0.2:9000/inference");
  delete process.env.CHRONOS_TRANSCRIBE_FINAL_URL;
  process.env.CHRONOS_TRANSCRIBE_URL = "https://api.example.com/v1/audio/transcriptions";
  assert.equal(finalUrl(), null, "a machine on a cloud model for everything gets no local second engine by surprise");
  delete process.env.CHRONOS_TRANSCRIBE_URL;
});

test("engine choice: partials and one-word clips stay fast; a sentence goes to the accurate engine unless it is off, absent or just found down", () => {
  const base = { partial: false, mode: "accurate", finalUrl: FINAL, audioMs: 4000, downUntil: 0, now: 1000 };
  assert.equal(pickEngine(base), "final");
  assert.equal(pickEngine({ ...base, partial: true }), "fast");
  assert.equal(pickEngine({ ...base, mode: "fast" }), "fast");
  assert.equal(pickEngine({ ...base, finalUrl: null }), "fast");
  assert.equal(pickEngine({ ...base, audioMs: SHORT_CLIP_MS - 1 }), "fast", "«sí», «dale»: no better on the large model, four times slower");
  assert.equal(pickEngine({ ...base, audioMs: SHORT_CLIP_MS }), "final");
  assert.equal(pickEngine({ ...base, audioMs: null }), "final", "unknown length (not WAV) counts as a sentence");
  assert.equal(pickEngine({ ...base, downUntil: 5000 }), "fast");
  assert.equal(pickEngine({ ...base, downUntil: 5000, now: 5000 }), "final", "…and is tried again afterwards");
});

test("the vocabulary prompt is a sentence in the language being transcribed, skipped on short clips and when empty", () => {
  assert.equal(vocabPrompt("", "es", 5000), undefined);
  assert.equal(vocabPrompt("  , ;\n", "es", 5000), undefined);
  assert.equal(vocabPrompt("Acme, pull request,  deploy ,Acme", "es", 5000), "Conversación en español. Términos: Acme, pull request, deploy.");
  assert.equal(vocabPrompt("Acme\npull request", "en", 5000), "Conversation in English. Terms: Acme, pull request.");
  assert.equal(vocabPrompt("Acme", undefined, 5000), "Acme.");
  assert.equal(vocabPrompt("Acme", "es", PROMPT_MIN_MS - 1), undefined, "a one-word answer gets no prompt: it only pulls it off course");
  assert.equal(vocabPrompt("Acme", "es", null), "Conversación en español. Términos: Acme.", "unknown length counts as long");
  const long = vocabPrompt(Array.from({ length: 200 }, (_, i) => `term${i}`).join(","), "es", 5000)!;
  assert.ok(long.length <= VOCAB_MAX_CHARS + 60 && /term0, term1/.test(long) && !/term199/.test(long), "capped, first terms win");
});

test("the second engine's audio window is cut only for clips that fit it twice over", () => {
  assert.deepEqual(finalFields(4000, {}), { audio_ctx: "768" });
  assert.deepEqual(finalFields(AUDIO_CTX_MAX_MS + 1, {}), {}, "a long turn keeps the full 30 s window");
  assert.deepEqual(finalFields(null, {}), {}, "unknown length: full window");
  assert.deepEqual(finalFields(4000, { CHRONOS_TRANSCRIBE_FINAL_AUDIO_CTX: "0" }), {}, "0 turns it off");
  assert.deepEqual(finalFields(4000, { CHRONOS_TRANSCRIBE_FINAL_AUDIO_CTX: "nonsense" }), {});
  assert.deepEqual(finalFields(4000, { CHRONOS_TRANSCRIBE_FINAL_AUDIO_CTX: "512" }), { audio_ctx: "512" });
  assert.deepEqual(finalFields(6000, { CHRONOS_TRANSCRIBE_FINAL_AUDIO_CTX: "512" }), {}, "6 s does not fit twice in 10 s");
  assert.equal(wavMs(wav(1500)), 1500);
  assert.equal(wavMs(Buffer.from("OggS not a wav, just bytes that are long enough to look at....")), null);
});

test("a sentence goes to the second engine with the vocabulary and the cut window; a one-word clip to the fast one with neither", async () => {
  resetFinalEngine();
  const calls: AskOpts[] = [];
  const ask = async (_b: Buffer, a: AskOpts): Promise<Heard> => { calls.push(a); return { text: "hola", probs: null }; };
  let r = await hearFinal(wav(4000), { language: "es", mode: "accurate", vocab: "Acme, deploy", contentType: "audio/wav", filename: "audio.wav" }, ask);
  assert.deepEqual({ text: r.text, engine: r.engine, lang: r.lang, passes: r.passes }, { text: "hola", engine: "final", lang: "es", passes: 1 });
  assert.equal(calls[0].url, FINAL);
  assert.equal(calls[0].language, "es");
  assert.equal(calls[0].prompt, "Conversación en español. Términos: Acme, deploy.");
  assert.deepEqual(calls[0].fields, { audio_ctx: "768" });
  assert.equal(calls[0].filename, "audio.wav");
  calls.length = 0;
  r = await hearFinal(wav(1400), { language: "es", mode: "accurate", vocab: "Acme, deploy" }, ask);
  assert.equal(r.engine, "fast");
  assert.deepEqual([calls[0].url, calls[0].prompt, calls[0].fields], [undefined, undefined, undefined]);
  calls.length = 0;
  r = await hearFinal(wav(4000), { language: "es", mode: "fast", vocab: "Acme" }, ask);
  assert.equal(r.engine, "fast");
  assert.equal(calls[0].url, undefined);
  assert.ok(calls[0].prompt, "the vocabulary rides on the fast engine too");
});

test("bilingual: the second pass carries the prompt of the language it transcribes", async () => {
  resetFinalEngine();
  const calls: AskOpts[] = [];
  const ask = async (_b: Buffer, a: AskOpts): Promise<Heard> => { calls.push(a); return { text: a.language === "en" ? "ship it" : "chip it", probs: { en: 0.9, es: 0.05 } }; };
  const r = await hearFinal(wav(4000), { language: "es", mode: "accurate", vocab: "Acme" }, ask);
  assert.deepEqual({ text: r.text, lang: r.lang, passes: r.passes, engine: r.engine }, { text: "ship it", lang: "en", passes: 2, engine: "final" });
  assert.deepEqual(calls.map((c) => c.prompt), ["Conversación en español. Términos: Acme.", "Conversation in English. Terms: Acme."]);
  assert.ok(calls.every((c) => c.url === FINAL));
  // voice.listen = page: one pass, the page's language.
  calls.length = 0;
  const one = await hearFinal(wav(4000), { language: "es", bilingual: false, mode: "accurate" }, ask);
  assert.equal(one.passes, 1);
  assert.equal(calls.length, 1);
});

test("the second engine not running: the same clip goes to the fast one, and it is left alone for a while", async () => {
  resetFinalEngine();
  const urls: Array<string | undefined> = [];
  const ask = async (_b: Buffer, a: AskOpts): Promise<Heard> => {
    urls.push(a.url);
    if (a.url) throw new TranscribeError("not reachable", { engine: a.url });
    return { text: "igual te escucho", probs: null };
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const t0 = 1_000_000;
    const r = await hearFinal(wav(4000), { language: "es", mode: "accurate", now: t0 }, ask);
    assert.deepEqual({ text: r.text, engine: r.engine }, { text: "igual te escucho", engine: "fast" });
    assert.deepEqual(urls, [FINAL, undefined]);
    urls.length = 0;
    await hearFinal(wav(4000), { language: "es", mode: "accurate", now: t0 + FINAL_DOWN_MS - 1 }, ask);
    assert.deepEqual(urls, [undefined], "no second knock while it is marked down");
    urls.length = 0;
    await hearFinal(wav(4000), { language: "es", mode: "accurate", now: t0 + 2 * FINAL_DOWN_MS }, ask);
    assert.deepEqual(urls, [FINAL, undefined], "tried again later");
    // An HTTP error (the model choking on one clip) falls back for that clip only.
    resetFinalEngine();
    urls.length = 0;
    const flaky = async (_b: Buffer, a: AskOpts): Promise<Heard> => {
      urls.push(a.url);
      if (a.url && urls.length === 1) throw new TranscribeError("HTTP 500", { engine: a.url, status: 500 });
      return { text: "ok", probs: null };
    };
    await hearFinal(wav(4000), { language: "es", mode: "accurate", now: t0 }, flaky);
    await hearFinal(wav(4000), { language: "es", mode: "accurate", now: t0 + 1 }, flaky);
    assert.deepEqual(urls, [FINAL, undefined, FINAL]);
  } finally {
    console.warn = warn;
    resetFinalEngine();
  }
});

test("a call's blank opening clip loads the second engine too — only when it is in use", () => {
  resetFinalEngine();
  const urls: Array<string | undefined> = [];
  const ask = async (_b: Buffer, a: AskOpts): Promise<Heard> => { urls.push(a.url); throw new Error("down"); };
  assert.equal(warmFinal(wav(400), { mode: "accurate", language: "es" }, ask), true, "a failure there is nobody's problem");
  assert.equal(warmFinal(wav(400), { mode: "fast" }, ask), false);
  assert.deepEqual(urls, [FINAL]);
});

test("prompt and decoder fields reach whisper as form fields of that one request", async () => {
  let body = "";
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      body = Buffer.concat(chunks).toString("latin1");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ text: " hola ", language_probabilities: { es: 0.9 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/inference`;
    const h = await transcribeDetailed(wav(300), { url, contentType: "audio/wav", language: "es", prompt: "Terms: Acme.", fields: { audio_ctx: "768" } });
    assert.equal(h.text, "hola");
    assert.match(body, /name="prompt"\r\n\r\nTerms: Acme\./);
    assert.match(body, /name="audio_ctx"\r\n\r\n768/);
    assert.match(body, /name="language"\r\n\r\nes/);
    await transcribeDetailed(wav(300), { url, contentType: "audio/wav" });
    assert.doesNotMatch(body, /name="prompt"|name="audio_ctx"/, "nothing sticks to the next request");
  } finally {
    server.close();
  }
});

test("a transcript that is one sentence written two or three times over is that sentence once", () => {
  const one = "¿Cuánto gastamos esta semana comparado con la semana pasada?";
  assert.equal(collapseRepeat(`${one} ${one}`), one);
  assert.equal(collapseRepeat(`${one} ${one} ${one}`), one);
  assert.equal(collapseRepeat("no, no"), "no, no");
  assert.equal(collapseRepeat("dale dale dale dale"), "dale dale dale dale");
  assert.equal(collapseRepeat("primero esto y después esto otro"), "primero esto y después esto otro");
});
