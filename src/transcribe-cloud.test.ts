/**
 * The cloud engine for finished sentences (src/transcribe-cloud.ts) and its place in the chain
 * (src/transcribe.ts → hearFinal): off by default, cloud → accurate → fast on any failure, the key
 * nowhere but the request header. No network: fetch is injected.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  askCloud, cloudRequest, cloudKeyterms, cloudLang, plainPcm, cloudReady, cloudFailed, cloudHealth, claimCloudKey, resetCloud, redact,
  cloudTimeoutMs, cloudHasKey, CloudError, CLOUD_URL, CLOUD_DOWN_MS, CLOUD_AUTH_DOWN_MS, CLOUD_TIMEOUT_MS, KEYTERMS_MAX, type CloudAsk, type CloudHeard,
} from "./transcribe-cloud.js";
import { hearFinal, hearCloud, pickEngine, warmFinal, resetFinalEngine, TranscribeError, type AskOpts, type Heard } from "./transcribe.js";
import { setting } from "./settings.js";
import { derivedWriteRefusal } from "./robert-scope.js";
// @ts-ignore — plain .mjs script, no types
import { cloudFields, cloudKey, parseEngine } from "../scripts/stt-bench.mjs";

const KEY = "sk_test_0123456789abcdef";
const FINAL = "http://127.0.0.1:7781/inference";
const VARS = ["CHRONOS_TRANSCRIBE_URL", "CHRONOS_TRANSCRIBE_FINAL_URL", "CHRONOS_TRANSCRIBE_FINAL_AUDIO_CTX", "CHRONOS_TRANSCRIBE_CLOUD_MODEL", "CHRONOS_TRANSCRIBE_CLOUD_ZERO_RETENTION", "CHRONOS_TRANSCRIBE_CLOUD_TIMEOUT_MS", "CHRONOS_WHISPER_PORT", "CHRONOS_WHISPER_FINAL_PORT"] as const;
const saved = VARS.map((k) => process.env[k]);
for (const k of VARS) delete process.env[k];
after(() => { VARS.forEach((k, i) => { if (saved[i] == null) delete process.env[k]; else process.env[k] = saved[i]; }); resetCloud({ key: null }); resetFinalEngine(); });

/** A 16 kHz mono 16-bit WAV of `ms`, as the call pages send. */
function wav(ms: number): Buffer {
  const n = Math.round(16 * ms);
  const b = Buffer.alloc(44 + n * 2, 1);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8, "latin1");
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36, "latin1"); b.writeUInt32LE(n * 2, 40);
  return b;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** console.warn captured for the length of `fn`. */
async function quiet<T>(fn: (lines: string[]) => Promise<T> | T): Promise<T> {
  const warn = console.warn, lines: string[] = [];
  console.warn = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try { return await fn(lines); } finally { console.warn = warn; }
}

test("off by default; the setting names what leaves the machine; no Robert credential turns it on", () => {
  assert.equal(setting("voice.final_engine"), "accurate");
  const req = (value: unknown) => ({ method: "PUT", route: { path: "/settings" }, body: { key: "voice.final_engine", value } }) as any;
  assert.match(String(derivedWriteRefusal(req("cloud"))), /operator-only/);
  assert.equal(derivedWriteRefusal(req("fast")), null, "back to a local engine is anyone's to set");
  assert.equal(derivedWriteRefusal(req("accurate")), null);
});

test("the key is taken out of the environment at claim, and is never in a URL, a log line or an error", async () => {
  const env: Record<string, string | undefined> = { ELEVENLABS_API_KEY: ` ${KEY} `, OTHER: "x" };
  resetCloud({ key: null });
  assert.equal(claimCloudKey(env), true);
  assert.deepEqual(env, { OTHER: "x" }, "nothing a spawned process could inherit");
  assert.equal(cloudHasKey(), true);
  assert.equal(claimCloudKey({}), true, "a second claim with nothing to take keeps the one it has");
  const r = cloudRequest(wav(3000), { language: "es" }, KEY, {});
  assert.equal(r.url, CLOUD_URL);
  assert.equal(new URL(r.url).host, "api.elevenlabs.io");
  assert.deepEqual(r.headers, { "xi-api-key": KEY });
  assert.ok(![...r.form.entries()].some(([, v]) => typeof v === "string" && v.includes(KEY)));
  assert.equal(redact(`bad key ${KEY} given`), "bad key [key] given");
  // A provider that echoes the key in its error body: neither the error nor the log carries it.
  const echo = async () => new Response(`{"detail":"invalid key ${KEY}"}`, { status: 401 });
  const e = await askCloud(wav(3000), {}, { fetch: echo as any, env: {} }).catch((x) => x);
  assert.ok(e instanceof CloudError && e.kind === "auth" && e.status === 401);
  assert.ok(!e.message.includes(KEY));
  const lines = await quiet((l) => { cloudFailed(e, 1000); return l; });
  assert.equal(lines.length, 1);
  assert.ok(!lines.join("\n").includes(KEY));
  assert.ok(!JSON.stringify(cloudHealth("cloud", 1000, {})).includes(KEY));
  resetCloud();
});

test("the request: the phone's WAV goes as headerless PCM, anything else as the file; language, keyterms, model and zero retention", async () => {
  const clip = wav(3000);
  const r = cloudRequest(clip, { language: "es", keyterms: ["Acme", "pull request"], contentType: "audio/wav", filename: "audio.wav" }, KEY, {});
  const f = r.form;
  assert.equal(f.get("model_id"), "scribe_v2");
  assert.equal(f.get("language_code"), "es");
  assert.equal(f.get("tag_audio_events"), "false");
  assert.deepEqual(f.getAll("keyterms"), ["Acme", "pull request"]);
  assert.equal(f.get("file_format"), "pcm_s16le_16");
  assert.equal((f.get("file") as File).size, clip.length - 44);
  assert.equal(plainPcm(clip)!.length, clip.length - 44);
  // Not the plain 16 kHz mono WAV (iOS mp4, a 48 kHz WAV): sent whole, no file_format.
  const hi = wav(3000); hi.writeUInt32LE(48000, 24);
  assert.equal(plainPcm(hi), null);
  assert.equal(plainPcm(Buffer.from("OggS not a wav, just bytes that are long enough to look at....")), null);
  const m = cloudRequest(Buffer.from("....ftypM4A ...................................."), { contentType: "audio/mp4", filename: "audio.m4a" }, KEY, { CHRONOS_TRANSCRIBE_CLOUD_MODEL: "scribe_v3" }).form;
  assert.equal(m.get("file_format"), null);
  assert.equal((m.get("file") as File).name, "audio.m4a");
  assert.equal(m.get("language_code"), null, "no hint: the model detects");
  assert.equal(m.get("model_id"), "scribe_v3");
  assert.deepEqual(m.getAll("keyterms"), []);
  assert.equal(cloudRequest(clip, {}, KEY, { CHRONOS_TRANSCRIBE_CLOUD_ZERO_RETENTION: "1" }).url, `${CLOUD_URL}?enable_logging=false`);
  assert.equal(cloudTimeoutMs({}), CLOUD_TIMEOUT_MS);
  assert.equal(cloudTimeoutMs({ CHRONOS_TRANSCRIBE_CLOUD_TIMEOUT_MS: "4000" }), 4000);
  assert.equal(cloudTimeoutMs({ CHRONOS_TRANSCRIBE_CLOUD_TIMEOUT_MS: "5" }), CLOUD_TIMEOUT_MS, "a timeout too small to ever answer is ignored");
});

test("vocabulary → keyterms inside the API's limits; languages come back as ISO 639-3", () => {
  assert.deepEqual(cloudKeyterms(""), []);
  assert.deepEqual(cloudKeyterms("Acme, pull request;  deploy\nAcme"), ["Acme", "pull request", "deploy"]);
  assert.deepEqual(cloudKeyterms(`ok, ${"x".repeat(51)}, one two three four five six, a<b, c[0], d\\e`), ["ok"], "too long, too many words, forbidden characters: dropped, not sent to fail the request");
  assert.equal(cloudKeyterms(Array.from({ length: 300 }, (_, i) => `t${i}`).join(",")).length, KEYTERMS_MAX, "never past the count that changes the billing");
  assert.deepEqual(["spa", "es", "eng", "EN", "por", "", undefined].map(cloudLang), ["es", "es", "en", "en", null, null, null]);
});

test("askCloud: text and language on 200; timeout, network, auth, busy, bad request and an empty transcript are each named", async () => {
  resetCloud({ key: KEY });
  let sent: { url: string; init: any } | null = null;
  const ok = async (url: any, init: any) => { sent = { url: String(url), init }; return json({ text: " Hola Robert ", language_code: "spa", language_probability: 0.98 }); };
  assert.deepEqual(await askCloud(wav(3000), { language: "es" }, { fetch: ok as any, env: {} }), { text: "Hola Robert", lang: "es", prob: 0.98 });
  assert.equal(sent!.url, CLOUD_URL);
  assert.equal(sent!.init.method, "POST");
  assert.equal(sent!.init.headers["xi-api-key"], KEY);
  const kind = async (f: any, ms?: number) => { const e = await askCloud(wav(3000), {}, { fetch: f, timeoutMs: ms, env: {} }).catch((x) => x); assert.ok(e instanceof CloudError, String(e)); return e.kind; };
  assert.equal(await kind(async () => json({ text: "  " })), "empty");
  assert.equal(await kind(async () => json({ detail: "x" }, 401)), "auth");
  assert.equal(await kind(async () => json({ detail: "x" }, 403)), "auth");
  assert.equal(await kind(async () => json({ detail: "x" }, 429)), "busy");
  assert.equal(await kind(async () => json({ detail: "x" }, 503)), "busy");
  assert.equal(await kind(async () => json({ detail: "x" }, 422)), "http");
  assert.equal(await kind(async () => new Response("<html>", { status: 200 })), "http");
  assert.equal(await kind(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); }), "network");
  // A provider that never answers: cut at the timeout, not at its leisure.
  const hang = (_u: any, init: any) => new Promise<Response>((_res, rej) => init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
  const t0 = Date.now();
  assert.equal(await kind(hang, 40), "timeout");
  assert.ok(Date.now() - t0 < 1500);
  resetCloud({ key: null });
  assert.equal(await kind(ok), "no-key");
});

test("engine choice: cloud only for a sentence, only when asked, only when it can be used — else exactly where accurate goes", () => {
  const base = { partial: false, mode: "cloud", finalUrl: FINAL, audioMs: 4000, downUntil: 0, now: 1000, cloud: true };
  assert.equal(pickEngine(base), "cloud");
  assert.equal(pickEngine({ ...base, audioMs: null }), "cloud", "unknown length (not WAV) counts as a sentence");
  assert.equal(pickEngine({ ...base, partial: true }), "fast", "live words never leave the machine");
  assert.equal(pickEngine({ ...base, audioMs: 1900 }), "fast", "«sí», «dale»: the cloud heard them no better");
  assert.equal(pickEngine({ ...base, cloud: false }), "final");
  assert.equal(pickEngine({ ...base, cloud: false, finalUrl: null }), "fast");
  assert.equal(pickEngine({ ...base, cloud: false, downUntil: 5000 }), "fast");
  assert.equal(pickEngine({ ...base, mode: "accurate" }), "final", "a key in .secrets alone sends nothing");
  assert.equal(pickEngine({ ...base, mode: "fast" }), "fast");
});

test("a sentence goes to the cloud with the vocabulary as keyterms; one-word clips and the blank opening clip stay local", async () => {
  resetCloud({ key: KEY }); resetFinalEngine();
  const cloud: CloudAsk[] = [], local: AskOpts[] = [];
  const askC = async (_b: Buffer, a: CloudAsk): Promise<CloudHeard> => { cloud.push(a); return { text: "sale el viernes", lang: "es", prob: 1 }; };
  const askL = async (_b: Buffer, a: AskOpts): Promise<Heard> => { local.push(a); return { text: "local", probs: null }; };
  let r = await hearFinal(wav(4000), { language: "es", bilingual: false, mode: "cloud", vocab: "Acme, deploy", contentType: "audio/wav", filename: "audio.wav" }, askL, askC);
  assert.deepEqual(r, { text: "sale el viernes", lang: "es", passes: 1, engine: "cloud" });
  assert.deepEqual(cloud, [{ filename: "audio.wav", contentType: "audio/wav", language: "es", keyterms: ["Acme", "deploy"] }]);
  assert.equal(local.length, 0, "one request, nothing sent twice");
  r = await hearFinal(wav(1400), { language: "es", mode: "cloud", vocab: "Acme" }, askL, askC);
  assert.equal(r.engine, "fast");
  assert.equal(cloud.length, 1);
  // The same sentence with the setting on a local engine: the cloud is never asked.
  await hearFinal(wav(4000), { language: "es", mode: "accurate" }, askL, askC);
  await hearFinal(wav(4000), { language: "es", mode: "fast" }, askL, askC);
  assert.equal(cloud.length, 1);
  // The warm-up clip loads the LOCAL second engine (the fallback), and is not sent out.
  local.length = 0;
  assert.equal(warmFinal(wav(400), { mode: "cloud", language: "es" }, askL), true);
  assert.deepEqual(local.map((a) => a.url), [FINAL]);
});

test("language: fixed → sent as the hint; otherwise detected, a third language is not believed, the other one needs confidence", async () => {
  const seen: Array<string | undefined> = [];
  const heard = (lang: any, prob: number | null) => async (_b: Buffer, a: CloudAsk): Promise<CloudHeard> => { seen.push(a.language); return { text: "x", lang, prob }; };
  assert.equal((await hearCloud(wav(4000), { language: "es", bilingual: false }, heard("en", 0.99))).lang, "es", "fixed on the call screen: nothing is guessed");
  assert.equal((await hearCloud(wav(4000), { language: "es" }, heard("en", 0.9))).lang, "en");
  assert.equal((await hearCloud(wav(4000), { language: "es" }, heard("en", 0.5))).lang, "es", "not sure enough to switch the call's language");
  assert.equal((await hearCloud(wav(4000), { language: "en" }, heard("en", 0.4))).lang, "en");
  assert.deepEqual(seen, ["es", undefined, undefined, undefined]);
  const e = await hearCloud(wav(4000), { language: "es" }, heard(null, 0.9)).catch((x) => x);
  assert.ok(e instanceof CloudError && e.kind === "language");
  assert.equal((await hearCloud(wav(4000), {}, heard(null, 0.9))).lang, undefined, "no call language (the Desk mic): whatever it heard");
});

test("the chain: timeout, non-200 or an empty transcript on the cloud → local accurate → local fast; the sentence is never lost", async () => {
  await quiet(async () => {
    const t0 = 1_000_000;
    const run = async (cloudErr: CloudError, localFinalUp: boolean, now = t0) => {
      const path: string[] = [];
      const askC = async (): Promise<CloudHeard> => { path.push("cloud"); throw cloudErr; };
      const askL = async (_b: Buffer, a: AskOpts): Promise<Heard> => {
        path.push(a.url ? "final" : "fast");
        if (a.url && !localFinalUp) throw new TranscribeError("not reachable", { engine: a.url });
        return { text: "igual te escucho", probs: null };
      };
      const r = await hearFinal(wav(4000), { language: "es", mode: "cloud", vocab: "Acme", now }, askL, askC);
      assert.equal(r.text, "igual te escucho");
      return { path, engine: r.engine };
    };
    for (const err of [new CloudError("timeout", "no answer"), new CloudError("network", "ENOTFOUND"), new CloudError("busy", "HTTP 503", 503), new CloudError("http", "HTTP 422", 422), new CloudError("empty", "empty transcript"), new CloudError("auth", "HTTP 401", 401)]) {
      resetCloud({ key: KEY }); resetFinalEngine();
      assert.deepEqual(await run(err, true), { path: ["cloud", "final"], engine: "final" }, err.kind);
    }
    resetCloud({ key: KEY }); resetFinalEngine();
    assert.deepEqual(await run(new CloudError("timeout", "no answer"), false), { path: ["cloud", "final", "fast"], engine: "fast" }, "both the network and the second whisper gone");
    // The vocabulary still reaches the local engine as its prompt.
    resetCloud({ key: KEY }); resetFinalEngine();
    const prompts: Array<string | undefined> = [];
    await hearFinal(wav(4000), { language: "es", mode: "cloud", vocab: "Acme", now: t0 }, async (_b, a) => { prompts.push(a.prompt); return { text: "ok", probs: null }; }, async () => { throw new CloudError("empty", "empty transcript"); });
    assert.deepEqual(prompts, ["Conversación en español. Términos: Acme."]);
  });
  resetCloud({ key: null }); resetFinalEngine();
});

test("back-off: a timeout or an outage leaves the cloud alone for a while, a bad key for longer; an empty or refused clip costs only itself", async () => {
  await quiet(async (lines) => {
    const t0 = 2_000_000;
    resetCloud({ key: KEY });
    assert.equal(cloudReady(t0), true);
    cloudFailed(new CloudError("empty", "empty transcript"), t0);
    cloudFailed(new CloudError("http", "HTTP 422", 422), t0);
    cloudFailed(new CloudError("language", "third language"), t0);
    assert.equal(cloudReady(t0), true);
    // One slow answer is a blip; the second in a row is an outage.
    cloudFailed(new CloudError("timeout", "no answer in 2500 ms"), t0);
    assert.equal(cloudReady(t0 + 1), true, "one timeout does not turn the engine off");
    cloudFailed(new CloudError("timeout", "no answer in 2500 ms"), t0);
    assert.equal(cloudReady(t0 + CLOUD_DOWN_MS - 1), false);
    assert.equal(cloudReady(t0 + CLOUD_DOWN_MS), true, "tried again afterwards");
    assert.deepEqual(cloudHealth("cloud", t0 + 1000, {}), { on: true, provider: "elevenlabs", model: "scribe_v2", key: true, ready: false, why: "timeout: no answer in 2500 ms", retry_in_s: 29 });
    resetCloud();
    cloudFailed(new CloudError("auth", "HTTP 401: Invalid API key", 401), t0);
    assert.equal(cloudReady(t0 + CLOUD_DOWN_MS), false);
    assert.equal(cloudReady(t0 + CLOUD_AUTH_DOWN_MS), true);
    // While it is down, sentences go straight to the local engine: no second wait on the network.
    resetCloud(); resetFinalEngine();
    let asked = 0;
    const askC = async (): Promise<CloudHeard> => { asked++; throw new CloudError("timeout", "no answer"); };
    const askL = async (): Promise<Heard> => ({ text: "ok", probs: null });
    await hearFinal(wav(4000), { language: "es", mode: "cloud", now: t0 }, askL, askC);
    await hearFinal(wav(4000), { language: "es", mode: "cloud", now: t0 + 1000 }, askL, askC);
    assert.equal(asked, 2, "the second timeout in a row is what turns it off");
    await hearFinal(wav(4000), { language: "es", mode: "cloud", now: t0 + 5000 }, askL, askC);
    assert.equal(asked, 2);
    await hearFinal(wav(4000), { language: "es", mode: "cloud", now: t0 + 1000 + CLOUD_DOWN_MS }, askL, askC);
    assert.equal(asked, 3);
    lines.length = 0;
  });
  resetCloud({ key: null }); resetFinalEngine();
});

test("the setting on without a key: local engines, said once in the log and in the health report — never an error", async () => {
  resetCloud({ key: null }); resetFinalEngine();
  await quiet(async (lines) => {
    let asked = 0;
    const askC = async (): Promise<CloudHeard> => { asked++; return { text: "no", lang: "es", prob: 1 }; };
    const askL = async (_b: Buffer, a: AskOpts): Promise<Heard> => ({ text: a.url ? "final" : "fast", probs: null });
    for (let i = 0; i < 3; i++) {
      const r = await hearFinal(wav(4000), { language: "es", mode: "cloud" }, askL, askC);
      assert.deepEqual({ text: r.text, engine: r.engine }, { text: "final", engine: "final" });
    }
    assert.equal(asked, 0);
    assert.equal(lines.filter((l) => /ELEVENLABS_API_KEY is not in \.secrets/.test(l)).length, 1);
    const h = cloudHealth("cloud", Date.now(), {});
    assert.deepEqual({ on: h.on, key: h.key, ready: h.ready }, { on: true, key: false, ready: false });
    assert.match(String(h.why), /ELEVENLABS_API_KEY is not in \.secrets/);
    assert.deepEqual(cloudHealth("accurate", Date.now(), {}), { on: false, provider: "elevenlabs", model: "scribe_v2", key: false, ready: false });
  });
});

test("the bench: the cloud engine's fields, and its key from the environment or a secrets file", () => {
  const e = parseEngine("cloud=elevenlabs;keyterms=@;model_id=scribe_v3");
  assert.equal(e.url, "elevenlabs");
  assert.deepEqual(cloudFields(e, "es", "Acme, pull request"), [["model_id", "scribe_v3"], ["tag_audio_events", "false"], ["language_code", "es"], ["keyterms", "Acme"], ["keyterms", "pull request"]]);
  assert.deepEqual(cloudFields(parseEngine("cloud=elevenlabs;language_code=auto"), "es", ""), [["model_id", "scribe_v2"], ["tag_audio_events", "false"]]);
  assert.equal(cloudKey({ ELEVENLABS_API_KEY: ` ${KEY} ` }, "/nonexistent"), KEY);
  assert.equal(cloudKey({}, "/nonexistent/.secrets"), null);
});
