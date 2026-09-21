// Shared speech-to-text. Defaults to the local whisper.cpp server (sh.chronos.whisper on :7778,
// OpenAI-free, no per-use cost). Set CHRONOS_TRANSCRIBE_URL to an OpenAI-style /audio/transcriptions
// endpoint (+ OPENAI_API_KEY) to use a cloud model instead. Both Telegram voice notes and the web
// dashboard mic funnel through here.
const LOCAL_URL = "http://127.0.0.1:7778/inference";

export function transcribeUrl(): string {
  return process.env.CHRONOS_TRANSCRIBE_URL || LOCAL_URL;
}
export function transcribeIsLocal(): boolean {
  return transcribeUrl() === LOCAL_URL;
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
    opts.filename || "audio.webm"
  );
  form.append("response_format", "json");
  // Explicit language (e.g. "en"/"es") is far more reliable than auto-detect on short clips.
  if (opts.language) form.append("language", opts.language);
  if (openai) form.append("model", process.env.CHRONOS_TRANSCRIBE_MODEL || "whisper-1");

  const res = await fetch(url, {
    method: "POST",
    headers: openai && key ? { authorization: `Bearer ${key}` } : {},
    body: form,
  });
  if (!res.ok) throw new Error(`transcription HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  return String(data.text ?? "").trim();
}
