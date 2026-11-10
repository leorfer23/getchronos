// Shared speech-to-text. Defaults to the local whisper.cpp server (sh.chronos.whisper on :7778,
// OpenAI-free, no per-use cost). Set CHRONOS_TRANSCRIBE_URL to an OpenAI-style /audio/transcriptions
// endpoint (+ OPENAI_API_KEY) to use a cloud model instead. Both Telegram voice notes and the web
// dashboard mic funnel through here.
import { ffmpegProblem } from "../bin/ffmpeg-check.mjs";

const LOCAL_URL = "http://127.0.0.1:7778/inference";
// The second local engine (sh.chronos.whisper-final): a larger model for finished sentences, on its
// own port so a sentence never waits behind a live-words preview on the fast one.
const LOCAL_FINAL_URL = "http://127.0.0.1:7781/inference";

export function transcribeUrl(): string {
  return process.env.CHRONOS_TRANSCRIBE_URL || LOCAL_URL;
}
export function transcribeIsLocal(): boolean {
  return transcribeUrl() === LOCAL_URL;
}
/**
 * Where finished sentences go, or null when there is no second engine: CHRONOS_TRANSCRIBE_FINAL_URL
 * ("off" = none), else the local one — but only beside the local fast engine. A machine pointed at a
 * cloud model for everything keeps using that for everything.
 */
export function finalUrl(): string | null {
  const v = process.env.CHRONOS_TRANSCRIBE_FINAL_URL;
  if (v) return /^(off|none|0)$/i.test(v) ? null : v;
  return transcribeIsLocal() ? LOCAL_FINAL_URL : null;
}

export type EngineName = "fast" | "final";
/** How long a second engine that refused the connection is left alone before it is tried again. */
export const FINAL_DOWN_MS = 30_000;
let finalDownUntil = 0;
/** Tests. */
export function resetFinalEngine(): void { finalDownUntil = 0; }

/**
 * A clip shorter than this is a one-word answer ("sí", "dale", "colgá" — the phone adds ~1.1 s of
 * pre-roll and closing silence around the word) and stays on the fast engine: measured on 27 such
 * clips the large model was no better (20 right vs 22) and took 1.2 s instead of 0.3 s, and with a
 * reduced audio context it got worse (see VOICE.md → Hearing). A clip of unknown length (not WAV)
 * counts as a sentence.
 */
export const SHORT_CLIP_MS = 2000;

/**
 * Which engine a clip goes to. Live words (partial) always the fast one. A finished sentence the
 * accurate one when the operator wants it ("accurate"), it exists, the clip is long enough to be a
 * sentence, and that engine has not just been found down — else the fast one, which is what every
 * clip used before.
 */
export function pickEngine(o: { partial: boolean; mode: string; finalUrl: string | null; audioMs?: number | null; downUntil?: number; now?: number }): EngineName {
  if (o.partial || o.mode !== "accurate" || !o.finalUrl) return "fast";
  if (o.audioMs != null && o.audioMs < SHORT_CLIP_MS) return "fast";
  return (o.now ?? Date.now()) < (o.downUntil ?? finalDownUntil) ? "fast" : "final";
}

// The engines pick a decoder by file extension, so the name must match the bytes: iOS Safari records
// audio/mp4 (AAC), Chrome/Android audio/webm. A mismatched name fails the whole upload.
export function audioFilename(contentType = ""): string {
  const t = contentType.toLowerCase().split(";")[0].trim();
  if (/mp4|m4a|aac/.test(t)) return "audio.m4a";
  if (/ogg|opus/.test(t)) return "audio.ogg";
  if (/wav/.test(t)) return "audio.wav";
  if (/mpeg|mp3/.test(t)) return "audio.mp3";
  return "audio.webm";
}

// Post audio bytes to the configured engine, return the transcript text (trimmed).
export async function transcribe(
  buf: Buffer,
  opts: AskOpts = {}
): Promise<string> {
  return (await transcribeDetailed(buf, opts)).text;
}

export type AskOpts = {
  filename?: string;
  contentType?: string;
  language?: string;
  /** Another engine than the default fast one (the second local server). */
  url?: string;
  /** whisper's `prompt`: text the decoder treats as what was said just before — vocabulary bias. */
  prompt?: string;
  /** Extra whisper-server form fields for this one request (beam_size, audio_ctx, …). */
  fields?: Record<string, string>;
};

export type Heard = { text: string; probs: Record<string, number> | null };

/**
 * The same call, with whisper.cpp's language probabilities when the engine gives them
 * (verbose_json: `language_probabilities`, reported even when the language was forced).
 */
export async function transcribeDetailed(
  buf: Buffer,
  opts: AskOpts = {}
): Promise<Heard> {
  const url = opts.url || transcribeUrl();
  const openai = /\/audio\/transcriptions/.test(url); // OpenAI-style endpoint
  const key = process.env.OPENAI_API_KEY;
  if (openai && !key) throw new Error("cloud transcription needs OPENAI_API_KEY in .secrets");

  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(buf)], { type: opts.contentType || "audio/webm" }),
    opts.filename || audioFilename(opts.contentType)
  );
  // The local engine answers verbose_json with the language probabilities transcribeBilingual weighs.
  form.append("response_format", openai ? "json" : "verbose_json");
  // Explicit language (e.g. "en"/"es") is far more reliable than auto-detect on short clips.
  if (opts.language) form.append("language", opts.language);
  if (openai) form.append("model", process.env.CHRONOS_TRANSCRIBE_MODEL || "whisper-1");
  // Both the OpenAI endpoint and whisper.cpp's server take `prompt` per request (server.cpp reads
  // every form field into a fresh copy of its defaults, so nothing sticks to the next request).
  if (opts.prompt) form.append("prompt", opts.prompt);
  if (!openai) for (const [k, v] of Object.entries(opts.fields ?? {})) form.append(k, v);

  const fail = (msg: string, status?: number, body?: string, cause?: unknown): never => {
    // whisper only says "FFmpeg conversion failed." — the reason (a dyld-broken ffmpeg, say) is
    // on this machine, so ask ffmpeg itself whenever an engine on this machine fails.
    const ff = /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url) ? ffmpegProblem() : null;
    throw new TranscribeError(ff ? `${ff} — ${msg}` : msg, { engine: url, status, body, ffmpeg: ff, cause });
  };
  const res = await fetch(url, {
    method: "POST",
    headers: openai && key ? { authorization: `Bearer ${key}` } : {},
    body: form,
  }).catch((e) =>
    // A bare "fetch failed" hides the usual cause: sh.chronos.whisper is down (it exits at start
    // when --convert can't run ffmpeg).
    fail(`transcription engine not reachable at ${url}${url === LOCAL_URL ? " — is sh.chronos.whisper running? (see whisper.err.log)" : url === LOCAL_FINAL_URL ? " — is sh.chronos.whisper-final running? (see whisper-final.err.log)" : ""}`, undefined, undefined, e)
  );
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 500);
    fail(`transcription HTTP ${res.status}: ${body.slice(0, 300)}`, res.status, body);
  }
  const data: any = await res.json();
  const probs = data.language_probabilities && typeof data.language_probabilities === "object" ? data.language_probabilities : null;
  return { text: String(data.text ?? "").trim(), probs };
}

export type Lang2 = "es" | "en";

/**
 * Spanish or English, never a third language. Whisper's own auto-detect on a one-word answer picks
 * anything ("Sí" came back as Arabic, "Dale" as Hindi — measured on the local small model), and a
 * fixed language garbles the other one (English forced to Spanish: 64–73% word errors). So: transcribe
 * in the call's language, read whisper's probabilities for the two, and only when the other language
 * clearly wins (≥ 0.3 and 1.5× the hint) transcribe again in that one. One pass when he speaks the
 * call's language; two when he switched.
 */
export async function transcribeBilingual(
  buf: Buffer,
  opts: { filename?: string; contentType?: string; hint: Lang2 },
  ask: (b: Buffer, o: AskOpts) => Promise<Heard> = transcribeDetailed,
): Promise<{ text: string; lang: Lang2; passes: number }> {
  const first = await ask(buf, { filename: opts.filename, contentType: opts.contentType, language: opts.hint });
  const p = first.probs;
  if (!p) return { text: first.text, lang: opts.hint, passes: 1 };
  const other: Lang2 = opts.hint === "es" ? "en" : "es";
  const ph = Number(p[opts.hint] ?? 0), po = Number(p[other] ?? 0);
  if (po >= 0.3 && po >= 1.5 * ph) {
    const second = await ask(buf, { filename: opts.filename, contentType: opts.contentType, language: other });
    return { text: second.text, lang: other, passes: 2 };
  }
  return { text: first.text, lang: opts.hint, passes: 1 };
}

/** Length of a 16-bit PCM WAV (what the call pages send), in ms. Any other container: null. */
export function wavMs(buf: Buffer): number | null {
  if (buf.length < 44 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE" || buf.toString("latin1", 36, 40) !== "data") return null;
  const rate = buf.readUInt32LE(24), block = buf.readUInt16LE(32);
  if (!rate || !block) return null;
  return Math.round(((buf.length - 44) / block / rate) * 1000);
}

/** Vocabulary hints are capped: whisper keeps only the last ~224 tokens of a prompt, and a long one costs decode time. */
export const VOCAB_MAX_CHARS = 400;
/**
 * The operator's vocabulary (setting voice.vocab, free text) as a whisper prompt for one clip, or
 * undefined for "no prompt".
 *
 * whisper reads the prompt as what was said just before, so it is written as a sentence in the
 * language being transcribed: a bare list of English-looking terms pulls a short Spanish clip into
 * English. And a clip too short to hold one of those terms gets no prompt at all (PROMPT_MIN_MS):
 * a one-word answer has nothing to gain from it and is the clip a prompt can derail. A clip whose
 * length is unknown (not WAV) is treated as long.
 */
export const PROMPT_MIN_MS = 2000;
export function vocabPrompt(vocab: unknown, lang: string | undefined, audioMs: number | null): string | undefined {
  const terms = [...new Set(String(vocab ?? "").split(/[,;\n]+/).map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean))];
  if (!terms.length) return undefined;
  if (audioMs != null && audioMs < PROMPT_MIN_MS) return undefined;
  let list = "";
  for (const t of terms) {
    if (list.length + t.length + 2 > VOCAB_MAX_CHARS) break;
    list += (list ? ", " : "") + t;
  }
  if (!list) return undefined;
  return lang === "es" ? `Conversación en español. Términos: ${list}.` : lang === "en" ? `Conversation in English. Terms: ${list}.` : `${list}.`;
}

/**
 * Decoder settings for a finished sentence on the second engine, per request (whisper-server takes
 * them as form fields). See VOICE.md → "Hearing" for the measurements behind each.
 *
 * audio_ctx: whisper encodes 30 s (1500 frames) whatever the clip's length, and on the large model
 * that encoder pass IS the latency (beam size 1 instead of 5 saved nothing). A sentence of a few
 * seconds does not need 30 s of context: with 768 frames (15 s) 3–6 s sentences came back no worse
 * than with the full window. Only for clips that fit that window twice over (≤ AUDIO_CTX_MAX_MS):
 * on 13–21 s clips a cut window cost accuracy (3.9% → 6.2% word errors at 1250 frames), so longer
 * and unknown-length clips keep the full context. 0 in CHRONOS_TRANSCRIBE_FINAL_AUDIO_CTX turns it off.
 */
export const AUDIO_CTX_MAX_MS = 8000;
export function finalFields(audioMs: number | null, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const raw = env.CHRONOS_TRANSCRIBE_FINAL_AUDIO_CTX;
  const ctx = raw == null || raw === "" ? 768 : Number(raw);
  if (!Number.isInteger(ctx) || ctx < 256 || ctx >= 1500) return {};
  // The window (50 frames per second) must hold the clip twice over, whatever the number is set to.
  if (audioMs == null || audioMs > AUDIO_CTX_MAX_MS || audioMs * 2 > ctx * 20) return {};
  return { audio_ctx: String(ctx) };
}

export type FinalHeard = { text: string; lang?: Lang2; passes: number; engine: EngineName };

/**
 * A finished sentence → text. The accurate engine when there is one (pickEngine), with the
 * operator's vocabulary as a prompt; any failure there — not installed, still loading its model,
 * crashed — and the same clip goes to the fast engine, so a call never loses a sentence to the
 * second server. An engine that refused the connection is left alone for FINAL_DOWN_MS.
 */
export async function hearFinal(
  buf: Buffer,
  o: { filename?: string; contentType?: string; language?: Lang2; bilingual?: boolean; mode: string; vocab?: unknown; now?: number },
  ask: (b: Buffer, a: AskOpts) => Promise<Heard> = transcribeDetailed,
): Promise<FinalHeard> {
  const ms = wavMs(buf);
  const run = async (engine: EngineName): Promise<FinalHeard> => {
    const extra: AskOpts = engine === "final" ? { url: finalUrl()!, fields: finalFields(ms) } : {};
    const one = (b: Buffer, a: AskOpts) => ask(b, { ...a, ...extra, prompt: vocabPrompt(o.vocab, a.language, ms) });
    if (o.language && o.bilingual !== false) {
      const out = await transcribeBilingual(buf, { filename: o.filename, contentType: o.contentType, hint: o.language }, one);
      return { ...out, engine };
    }
    const h = await one(buf, { filename: o.filename, contentType: o.contentType, language: o.language });
    return { text: h.text, lang: o.language, passes: 1, engine };
  };
  const now = o.now ?? Date.now();
  if (pickEngine({ partial: false, mode: o.mode, finalUrl: finalUrl(), audioMs: ms, now }) === "final") {
    try {
      return await run("final");
    } catch (e) {
      // No HTTP status = nobody answered on that port: stop knocking for a while.
      if (e instanceof TranscribeError && e.status == null) {
        if (now >= finalDownUntil) console.warn(`[transcribe] second engine not reachable (${e.engine}) — finished sentences use the fast engine; retry in ${FINAL_DOWN_MS / 1000}s`);
        finalDownUntil = now + FINAL_DOWN_MS;
      } else console.warn(`[transcribe] second engine failed (${String((e as any)?.message ?? e).slice(0, 160)}) — this sentence goes to the fast engine`);
    }
  }
  return run("fast");
}

/**
 * A call opening sends a blank clip so its first sentence does not pay for a cold model. That clip is
 * short, so it lands on the fast engine — this loads the second one too. Never awaited, never an error.
 */
export function warmFinal(
  buf: Buffer,
  o: { mode: string; filename?: string; contentType?: string; language?: string; now?: number },
  ask: (b: Buffer, a: AskOpts) => Promise<Heard> = transcribeDetailed,
): boolean {
  const url = finalUrl();
  if (pickEngine({ partial: false, mode: o.mode, finalUrl: url, now: o.now }) !== "final") return false;
  ask(buf, { url: url!, filename: o.filename, contentType: o.contentType, language: o.language }).catch(() => {});
  return true;
}

export class TranscribeError extends Error {
  engine: string;
  status?: number;
  body?: string;
  ffmpeg?: string | null;
  constructor(msg: string, o: { engine: string; status?: number; body?: string; ffmpeg?: string | null; cause?: unknown }) {
    super(msg, { cause: o.cause });
    this.name = "TranscribeError";
    this.engine = o.engine;
    this.status = o.status;
    this.body = o.body;
    this.ffmpeg = o.ffmpeg;
  }
}

// One loud daemon log line per failed transcription, plus the reason the PWA toasts.
export function transcribeFailure(e: unknown, req: { mime: string; bytes: number }): { log: string; error: string } {
  const t = e instanceof TranscribeError ? e : undefined;
  const error = String((e as any)?.message ?? e);
  const cause = (e as any)?.cause?.cause?.code ?? (e as any)?.cause?.code;
  const log =
    `[transcribe] FAILED engine=${t?.engine ?? transcribeUrl()} mime=${req.mime} bytes=${req.bytes}` +
    ` status=${t?.status ?? "-"}${cause ? ` cause=${cause}` : ""} body=${JSON.stringify(t?.body ?? "")}` +
    ` ffmpeg=${JSON.stringify(t?.ffmpeg ?? "ok/unchecked")} :: ${error}`;
  return { log, error };
}
