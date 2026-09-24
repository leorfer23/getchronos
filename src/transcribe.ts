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
  form.append("response_format", "json");
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
  return String(data.text ?? "").trim();
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
