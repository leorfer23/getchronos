// Shared speech-to-text. Defaults to the local whisper.cpp server (sh.chronos.whisper on :7778,
// OpenAI-free, no per-use cost). Set CHRONOS_TRANSCRIBE_URL to an OpenAI-style /audio/transcriptions
// endpoint (+ OPENAI_API_KEY) to use a cloud model instead. Both Telegram voice notes and the web
// dashboard mic funnel through here.
import { ffmpegProblem } from "../bin/ffmpeg-check.mjs";

const LOCAL_URL = "http://127.0.0.1:7778/inference";

export function transcribeUrl(): string {
  return process.env.CHRONOS_TRANSCRIBE_URL || LOCAL_URL;
}
export function transcribeIsLocal(): boolean {
  return transcribeUrl() === LOCAL_URL;
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
  opts: { filename?: string; contentType?: string; language?: string } = {}
): Promise<string> {
  return (await transcribeDetailed(buf, opts)).text;
}

export type Heard = { text: string; probs: Record<string, number> | null };

/**
 * The same call, with whisper.cpp's language probabilities when the engine gives them
 * (verbose_json: `language_probabilities`, reported even when the language was forced).
 */
export async function transcribeDetailed(
  buf: Buffer,
  opts: { filename?: string; contentType?: string; language?: string } = {}
): Promise<Heard> {
  const url = transcribeUrl();
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
    fail(`transcription engine not reachable at ${url}${url === LOCAL_URL ? " — is sh.chronos.whisper running? (see whisper.err.log)" : ""}`, undefined, undefined, e)
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
  ask: (b: Buffer, o: { filename?: string; contentType?: string; language?: string }) => Promise<Heard> = transcribeDetailed,
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
