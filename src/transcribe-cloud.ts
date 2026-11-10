/**
 * The optional cloud engine for a finished sentence of a call: ElevenLabs Scribe (batch
 * speech-to-text). OFF unless the operator sets voice.final_engine = cloud — then the audio of what
 * he says on a call is sent to api.elevenlabs.io, and nowhere else. Live words, one-word answers and
 * every fallback stay on the local engines (src/transcribe.ts → hearFinal owns the chain).
 *
 * Written against the API reference (POST /v1/speech-to-text, multipart): `model_id`, `file`,
 * `language_code`, `tag_audio_events`, `keyterms`, `file_format`, query `enable_logging`; response
 * `text`, `language_code` (ISO 639-3 in practice: "spa", "eng"), `language_probability`.
 * See VOICE.md → "Hearing in the cloud" for what was measured and what the docs say about cost and
 * retention.
 */

/** The only host this module talks to. Not configurable: a setting must not be able to point call audio elsewhere. */
export const CLOUD_URL = "https://api.elevenlabs.io/v1/speech-to-text";
export const CLOUD_KEY_VAR = "ELEVENLABS_API_KEY";
/**
 * How long a sentence may wait on the cloud before the local engine takes it. Measured from one Mac
 * on 60 requests of 2–6 s clips: median 0.6 s, slowest 1.7 s. A timeout costs this much once — the
 * engine is then left alone for CLOUD_DOWN_MS.
 */
export const CLOUD_TIMEOUT_MS = 2500;
/** After a timeout, a network error, a 429 or a 5xx. Same length as the local second engine's (FINAL_DOWN_MS). */
export const CLOUD_DOWN_MS = 30_000;
/** After a 401/403 (wrong key, plan, quota): no sentence will fix that, so it is not tried on every one. */
export const CLOUD_AUTH_DOWN_MS = 10 * 60_000;
/** Above 100 keyterms a request is billed as at least 20 s of audio (API reference) — never go there. */
export const KEYTERMS_MAX = 100;
/** The other language than the call's is believed only when the model is this sure of it. */
export const CLOUD_OTHER_LANG_MIN = 0.7;

export type CloudLang = "es" | "en";

let key: string | undefined;
let downUntil = 0;
let downWhy: string | null = null;
let saidNoKey = false;

/**
 * Take the key out of the environment and keep it here. .secrets is loaded into the daemon's
 * process.env, and a few daemon-spawned CLIs inherit that env whole — a key that only this module
 * needs does not stay there. Called at import (the daemon imports this at boot, before any spawn).
 */
export function claimCloudKey(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[CLOUD_KEY_VAR]?.trim();
  if (v) key = v;
  delete env[CLOUD_KEY_VAR];
  return !!key;
}
claimCloudKey();

export const cloudHasKey = (): boolean => !!key;
/** Tests. */
export function resetCloud(o: { key?: string | null } = {}): void {
  downUntil = 0; downWhy = null; saidNoKey = false;
  if (o.key !== undefined) key = o.key ?? undefined;
}

/** The key never appears in a log line or an error, whatever a response body echoes back. */
export function redact(s: string, k: string | undefined = key): string {
  return k ? s.split(k).join("[key]") : s;
}

/** Scribe answers ISO 639-3 ("spa", "eng"); the request takes either. Anything but Spanish/English: null. */
export function cloudLang(code: unknown): CloudLang | null {
  const c = String(code ?? "").toLowerCase();
  return c === "es" || c === "spa" ? "es" : c === "en" || c === "eng" ? "en" : null;
}

/**
 * voice.vocab → `keyterms`. The API's limits per term: 50 characters, 5 words, none of < > { } [ ] \ ;
 * a term outside them is dropped rather than letting it fail the whole request (422).
 */
export function cloudKeyterms(vocab: unknown): string[] {
  const out: string[] = [];
  for (const raw of String(vocab ?? "").split(/[,;\n]+/)) {
    const t = raw.replace(/\s+/g, " ").trim();
    if (!t || t.length > 50 || t.split(" ").length > 5 || /[<>{}[\]\\]/.test(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length >= KEYTERMS_MAX) break;
  }
  return out;
}

/**
 * The samples of the WAV the call pages send (44-byte header, 16 kHz, mono, 16-bit PCM), or null for
 * anything else. Sent headerless with `file_format=pcm_s16le_16`, which the API reference describes
 * as the lower-latency input.
 */
export function plainPcm(buf: Buffer): Buffer | null {
  if (buf.length <= 44 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE" || buf.toString("latin1", 36, 40) !== "data") return null;
  const pcm = buf.readUInt16LE(20) === 1, mono = buf.readUInt16LE(22) === 1, rate = buf.readUInt32LE(24), bits = buf.readUInt16LE(34);
  return pcm && mono && rate === 16000 && bits === 16 ? buf.subarray(44) : null;
}

export type CloudAsk = {
  filename?: string;
  contentType?: string;
  /** Sent as `language_code`. Absent: the model detects the language and says which. */
  language?: CloudLang;
  keyterms?: string[];
};

/** One request, as data: where, with which headers, which form. The key rides the header — never the URL. */
export function cloudRequest(
  buf: Buffer,
  o: CloudAsk,
  k: string,
  env: Record<string, string | undefined> = process.env,
): { url: string; headers: Record<string, string>; form: FormData } {
  const form = new FormData();
  form.append("model_id", env.CHRONOS_TRANSCRIBE_CLOUD_MODEL || "scribe_v2");
  const pcm = plainPcm(buf);
  if (pcm) {
    form.append("file_format", "pcm_s16le_16");
    form.append("file", new Blob([new Uint8Array(pcm)], { type: "application/octet-stream" }), "audio.pcm");
  } else {
    form.append("file", new Blob([new Uint8Array(buf)], { type: o.contentType || "audio/webm" }), o.filename || "audio.webm");
  }
  if (o.language) form.append("language_code", o.language);
  form.append("tag_audio_events", "false");
  for (const t of o.keyterms ?? []) form.append("keyterms", t);
  // Zero retention is for enterprise accounts only (any other plan answers 403) — an explicit opt-in.
  const zrm = /^(1|true|on)$/i.test(env.CHRONOS_TRANSCRIBE_CLOUD_ZERO_RETENTION ?? "");
  return { url: zrm ? `${CLOUD_URL}?enable_logging=false` : CLOUD_URL, headers: { "xi-api-key": k }, form };
}

export type CloudFailure = "no-key" | "timeout" | "network" | "auth" | "busy" | "http" | "empty" | "language";
export class CloudError extends Error {
  kind: CloudFailure;
  status?: number;
  constructor(kind: CloudFailure, msg: string, status?: number) {
    super(msg);
    this.name = "CloudError";
    this.kind = kind;
    this.status = status;
  }
}

export type CloudHeard = { text: string; lang: CloudLang | null; prob: number | null };
export type CloudDeps = { fetch?: typeof fetch; timeoutMs?: number; env?: Record<string, string | undefined> };

export function cloudTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.CHRONOS_TRANSCRIBE_CLOUD_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 500 && n <= 15_000 ? n : CLOUD_TIMEOUT_MS;
}

/**
 * One clip → text, or a CloudError saying why not. The timeout covers the whole exchange (upload,
 * model, reading the answer). An empty transcript is a failure here: the caller has a local engine
 * to ask, and a turn must not be dropped because the cloud heard nothing.
 */
export async function askCloud(buf: Buffer, o: CloudAsk, deps: CloudDeps = {}): Promise<CloudHeard> {
  if (!key) throw new CloudError("no-key", `${CLOUD_KEY_VAR} is not set`);
  const env = deps.env ?? process.env;
  const ms = deps.timeoutMs ?? cloudTimeoutMs(env);
  const req = cloudRequest(buf, o, key, env);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    let res: Response;
    try {
      res = await (deps.fetch ?? fetch)(req.url, { method: "POST", headers: req.headers, body: req.form, signal: ctl.signal });
    } catch (e: any) {
      if (ctl.signal.aborted) throw new CloudError("timeout", `no answer in ${ms} ms`);
      throw new CloudError("network", redact(String(e?.cause?.code ?? e?.message ?? e)).slice(0, 120));
    }
    if (!res.ok) {
      const body = redact((await res.text().catch(() => "")).replace(/\s+/g, " ")).slice(0, 200);
      const kind: CloudFailure = res.status === 401 || res.status === 403 ? "auth" : res.status === 429 || res.status >= 500 ? "busy" : "http";
      throw new CloudError(kind, `HTTP ${res.status}: ${body}`, res.status);
    }
    let data: any;
    try {
      data = await res.json();
    } catch (e: any) {
      if (ctl.signal.aborted) throw new CloudError("timeout", `no answer in ${ms} ms`);
      throw new CloudError("http", "answer was not JSON", res.status);
    }
    const text = String(data?.text ?? "").trim();
    if (!text) throw new CloudError("empty", "empty transcript");
    const prob = typeof data?.language_probability === "number" ? data.language_probability : null;
    return { text, lang: cloudLang(data?.language_code), prob };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a sentence may go to the cloud right now: the key is there and the engine has not just
 * failed. Says once (per daemon run) when the setting asks for the cloud and there is no key.
 */
export function cloudReady(now: number = Date.now()): boolean {
  if (!key) {
    if (!saidNoKey) {
      saidNoKey = true;
      console.warn(`[transcribe] voice.final_engine = cloud but ${CLOUD_KEY_VAR} is not in .secrets — finished sentences stay on the local engines`);
    }
    return false;
  }
  return now >= downUntil;
}

/** A failed cloud request: log it (no key, no audio) and decide how long the engine is left alone. */
export function cloudFailed(e: unknown, now: number = Date.now()): void {
  const err = e instanceof CloudError ? e : new CloudError("network", redact(String((e as any)?.message ?? e)).slice(0, 120));
  // This clip only: the cloud answered, just not with something usable.
  if (err.kind === "empty" || err.kind === "language" || err.kind === "http") {
    console.warn(`[transcribe] cloud engine: ${err.kind} (${err.message}) — this sentence goes to the local engine`);
    return;
  }
  if (err.kind === "no-key") return;
  const wait = err.kind === "auth" ? CLOUD_AUTH_DOWN_MS : CLOUD_DOWN_MS;
  if (now >= downUntil) console.warn(`[transcribe] cloud engine ${err.kind} (${err.message}) — finished sentences use the local engines; retry in ${wait / 1000}s`);
  downUntil = now + wait;
  downWhy = `${err.kind}: ${err.message}`;
}

/** For GET /api/voices: is the cloud engine asked for, can it be used, and if not why. Never the key. */
export function cloudHealth(mode: string, now: number = Date.now(), env: Record<string, string | undefined> = process.env): Record<string, unknown> {
  const on = mode === "cloud";
  const down = now < downUntil;
  return {
    on,
    provider: "elevenlabs",
    model: env.CHRONOS_TRANSCRIBE_CLOUD_MODEL || "scribe_v2",
    key: !!key,
    ready: on && !!key && !down,
    ...(on && !key ? { why: `${CLOUD_KEY_VAR} is not in .secrets — finished sentences stay local` } : {}),
    ...(down ? { why: downWhy, retry_in_s: Math.ceil((downUntil - now) / 1000) } : {}),
  };
}
