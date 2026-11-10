// Robert's voice: text → speech, rendered here into a file the page plays. Rendering here instead of
// letting anything use the speakers means the Desk, the bar, the phone and the tunnel all hear it,
// and the page owns stop/skip. Local, free, nothing leaves the machine.
//
// Two engines, best first:
//   · Kokoro-82M on MLX (scripts/tts-server.py, launchd sh.chronos.tts on 127.0.0.1:7779) — a neural
//     voice, WAV out. Optional: installed by scripts/install-tts.sh on an Apple Silicon Mac;
//   · macOS `say` with the best installed voice — AAC out. Always there; used whenever Kokoro is not
//     installed, not up yet, or fails a sentence. CHRONOS_TTS_URL=off skips Kokoro altogether.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { islands, pickLang, type Segment } from "./voice-lang.js";

export type VoiceLang = "en" | "es";

const FALLBACK_VOICE: Record<VoiceLang, string> = { en: "Zoe (Premium)", es: "Marisol (Premium)" };
// Robert is a man: the male Mac voices, most natural first. `say` can only use what was downloaded
// (System Settings → Accessibility → Spoken Content → System voice → Manage Voices).
const MALE: Record<VoiceLang, string[]> = {
  en: ["Evan", "Nathan", "Tom", "Aaron", "Oliver", "Arthur", "Alex", "Daniel", "Gordon", "Lee", "Rishi"],
  es: ["Jorge", "Juan", "Diego", "Carlos", "Enrique"],
};
const MAX_CHARS = 1200;

export type InstalledVoice = { name: string; lang: string; premium: boolean };

const tier = (name: string) => (/\(Premium\)/.test(name) ? 0 : /\(Enhanced\)/.test(name) ? 1 : 2);

// The best installed male voice for a language — Premium, then Enhanced, then the compact one — and
// the female Premium voice when no male voice for that language is installed at all.
export function pickVoice(lang: VoiceLang, installed: InstalledVoice[], env: NodeJS.ProcessEnv = process.env): string {
  const pinned = lang === "es" ? env.CHRONOS_VOICE_ES : env.CHRONOS_VOICE_EN;
  if (pinned) return pinned;
  let best: { name: string; rank: number } | null = null;
  for (const v of installed) {
    if (!v.lang.startsWith(lang + "_")) continue;
    const i = MALE[lang].indexOf(v.name.replace(/\s*\(.*\)\s*$/, ""));
    if (i < 0) continue;
    const rank = tier(v.name) * 100 + i;
    if (!best || rank < best.rank) best = { name: v.name, rank };
  }
  return best?.name ?? FALLBACK_VOICE[lang];
}

// `say -v '?'`, cached for a minute: a voice downloaded while the daemon runs is picked up without a
// restart, and a call does not pay for the listing on every sentence.
let installedCache: { at: number; list: Promise<InstalledVoice[]> } | null = null;
function installed(): Promise<InstalledVoice[]> {
  if (!installedCache || Date.now() - installedCache.at > 60_000) installedCache = { at: Date.now(), list: listVoices() };
  return installedCache.list;
}
export async function voiceFor(lang: VoiceLang, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return pickVoice(lang, await installed(), env);
}

// Last line of defence — the page already turns markdown and ids into words. Control characters,
// directive lines and runaway length never reach the synthesizer.
export function sayable(text: string): string {
  return String(text ?? "")
    .split("\n")
    .filter((l) => !/^\s*(UI\b|\{.*\}\s*$)/.test(l))
    .join(" ")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CHARS);
}

export function sayArgs(voice: string, out: string, rate?: number): string[] {
  const args = ["-v", voice, "-o", out, "--file-format=m4af", "--data-format=aac", "-f", "-"];
  if (rate && rate > 80 && rate < 400) args.push("-r", String(Math.round(rate)));
  return args;
}

function render(voice: string, text: string, out: string, rate?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // Text goes in on stdin: never parsed as a flag, never through a shell.
    const p = spawn("say", sayArgs(voice, out, rate), { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    const kill = setTimeout(() => p.kill("SIGKILL"), 20000);
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", (e) => { clearTimeout(kill); reject(e); });
    p.on("close", (code) => { clearTimeout(kill); code === 0 ? resolve() : reject(new Error(err.trim() || `say exited ${code}`)); });
    p.stdin.end(text);
  });
}

export type Spoken = { audio: Buffer; mime: string; engine: "kokoro" | "say"; lang: VoiceLang };

const TTS_DEFAULT = "http://127.0.0.1:7779";
// Not installed (connection refused) is the common case on a Mac without it: say so once and stop
// paying for the attempt on every sentence for a while. Any other failure falls back for that one
// sentence only.
const DOWN_FOR_MS = 30_000;
let ttsDownUntil = 0;
export function resetNeuralState(): void { ttsDownUntil = 0; }

export async function neuralSpeak(
  text: string,
  lang: VoiceLang,
  opts: { url?: string; timeoutMs?: number; now?: number; segments?: Segment[] } = {},
): Promise<Buffer | null> {
  const url = opts.url ?? process.env.CHRONOS_TTS_URL ?? TTS_DEFAULT;
  if (!url || url === "off") return null;
  const now = opts.now ?? Date.now();
  if (now < ttsDownUntil) return null;
  try {
    const r = await fetch(url.replace(/\/+$/, "") + "/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // segments: the sentence's English runs inside Spanish (voice-lang.ts islands) — read with English
      // phonemes in the sentence's own voice. A server that predates them ignores the field.
      body: JSON.stringify({ text, lang, ...(opts.segments && opts.segments.length > 1 ? { segments: opts.segments } : {}) }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    // A WAV header and something after it, or it is not audio we can hand the page.
    return buf.length > 44 && buf.subarray(0, 4).toString() === "RIFF" ? buf : null;
  } catch (e: any) {
    const code = e?.cause?.code ?? e?.code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH") ttsDownUntil = now + DOWN_FOR_MS;
    return null;
  }
}

/**
 * One sentence → audio. `lang` is the page's language; with `pick` (the default, setting
 * voice.lang_pick) the sentence's own language wins when it is clear (voice-lang.ts pickLang) and
 * `lang` is only the tie-breaker — so an English sentence on a Spanish call is read in English.
 */
export async function speak(text: string, lang: VoiceLang = "en", opts: { pick?: boolean; islands?: boolean } = {}): Promise<Spoken> {
  const clean = sayable(text);
  if (!clean) throw new Error("nothing to say");
  const use: VoiceLang = opts.pick === false ? lang : pickLang(clean, lang);
  // English runs inside a Spanish sentence (voice.islands, off by default): measured by reading the
  // audio back through whisper, the English words came out right but the Spanish right after each
  // join suffered (14% → 19% word errors on four mixed sentences) — not a win yet.
  const segments = opts.islands ? islands(clean, use) : undefined;
  const neural = await neuralSpeak(clean, use, { segments });
  if (neural) return { audio: neural, mime: "audio/wav", engine: "kokoro", lang: use };
  const out = path.join(os.tmpdir(), `chronos-say-${randomUUID()}.m4a`);
  const rate = Number(process.env.CHRONOS_VOICE_RATE) || undefined;
  try {
    // A voice that was never downloaded (or renamed by an OS update) is not an error to `say`: it
    // quietly uses the system voice, so the call never goes silent — GET /api/voices shows which.
    await render(await voiceFor(use), clean, out, rate);
    return { audio: await fs.promises.readFile(out), mime: "audio/mp4", engine: "say", lang: use };
  } finally {
    fs.promises.unlink(out).catch(() => {});
  }
}

/** What GET /api/voices reports for the neural engine: its own /health, or why it is not there. */
export async function neuralHealth(url = process.env.CHRONOS_TTS_URL ?? TTS_DEFAULT): Promise<Record<string, unknown>> {
  if (!url || url === "off") return { up: false, why: "CHRONOS_TTS_URL=off" };
  try {
    const r = await fetch(url.replace(/\/+$/, "") + "/health", { signal: AbortSignal.timeout(2000) });
    return r.ok ? { up: true, ...(await r.json()) } : { up: false, why: `health ${r.status}` };
  } catch (e: any) {
    return { up: false, why: e?.cause?.code ?? String(e?.message ?? e) };
  }
}

export function listVoices(): Promise<InstalledVoice[]> {
  return new Promise((resolve) => {
    execFile("say", ["-v", "?"], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(String(stdout).split("\n").map((l) => l.match(/^(.+?)\s{2,}([a-z]{2}_[A-Z0-9]{2,3})\s/)).filter(Boolean)
        .map((m) => ({ name: m![1].trim(), lang: m![2], premium: /\((Premium|Enhanced)\)/.test(m![1]) })));
    });
  });
}
