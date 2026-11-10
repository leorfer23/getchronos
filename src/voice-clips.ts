/**
 * The last few clips a call sent for transcription, kept on this Mac with what was heard — so the
 * speech engines can be compared on the operator's real voice instead of a synthetic one
 * (`mc voice clips`, `scripts/stt-bench.mjs --dir <that folder>`).
 *
 * OFF unless Settings → Voice → "Keep the last call clips" is on. A clip is his voice and his words:
 *  - it lives outside the checkout (the daemon stages everything under it), in a directory every
 *    agent sandbox is denied (config.ts → sandbox.sealed), mode 0700, files 0600;
 *  - only the admin token lists it (GET /api/voice/clips); nothing serves the audio over HTTP;
 *  - the last KEEP clips and at most MAX_BYTES, oldest dropped first;
 *  - turning the setting off deletes the directory, and so does a daemon start that finds it off.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const KEEP = 40;
export const MAX_BYTES = 48 * 1024 * 1024;
/** One clip never takes the whole budget: a 45 s turn as 16 kHz mono PCM is ~1.4 MB. */
export const MAX_CLIP_BYTES = 4 * 1024 * 1024;

export const clipsDir = (): string =>
  process.env.CHRONOS_VOICE_CLIPS ||
  // Tests run on an in-memory DB and must never write into a real home.
  (process.env.CHRONOS_TEST ? path.join(os.tmpdir(), `chronos-test-voice-clips-${process.pid}`) : path.join(os.homedir(), ".mc", "voice-clips"));

export type ClipStats = {
  /** Length of the audio. */
  audio_ms: number;
  /** Level of the whole clip and its loudest 20 ms, 0..1. */
  rms: number;
  peak: number;
  /** Level of the first 60 ms: far above a room's floor means the clip starts mid-word (onset cut). */
  head_rms: number;
  /** Quiet at the end, ms — how long the call waited before it cut. */
  tail_quiet_ms: number;
};

export type Clip = {
  file: string;
  at: string;
  bytes: number;
  lang: string | null;
  /** Which engine answered (fast / final) and how long it took. */
  engine: string | null;
  ms: number | null;
  /** What was heard then. */
  text: string;
  /** What he really said — filled in by hand (index.json) to score engines on these clips. */
  ref?: string;
  stats: ClipStats | null;
};

const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** Levels of a 16-bit PCM WAV as the phone writes it (44-byte header). Anything else: null. */
export function wavStats(buf: Buffer): ClipStats | null {
  if (buf.length < 46 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE") return null;
  if (buf.readUInt16LE(20) !== 1 || buf.readUInt16LE(34) !== 16 || buf.toString("latin1", 36, 40) !== "data") return null;
  const rate = buf.readUInt32LE(24), ch = buf.readUInt16LE(22) || 1;
  if (!rate) return null;
  const n = Math.floor((buf.length - 44) / (2 * ch));
  const win = Math.max(1, Math.round(rate * 0.02));
  let sum = 0, peak = 0, head = 0, headN = 0, wsum = 0, wn = 0, lastLoud = -1;
  const headEnd = Math.round(rate * 0.06);
  const levels: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(44 + i * 2 * ch) / 32768;
    sum += v * v;
    if (i < headEnd) { head += v * v; headN++; }
    wsum += v * v; wn++;
    if (wn === win || i === n - 1) { levels.push(Math.sqrt(wsum / wn)); wsum = 0; wn = 0; }
  }
  for (const l of levels) peak = Math.max(peak, l);
  // "Quiet" is relative to the clip's own loudest moment, so it reads the same at any mic gain.
  const quiet = Math.max(0.004, peak * 0.15);
  for (let i = levels.length - 1; i >= 0; i--) if (levels[i] > quiet) { lastLoud = i; break; }
  return {
    audio_ms: Math.round((n / rate) * 1000),
    rms: r4(Math.sqrt(sum / Math.max(1, n))),
    peak: r4(peak),
    head_rms: r4(Math.sqrt(head / Math.max(1, headN))),
    tail_quiet_ms: Math.round(((levels.length - 1 - lastLoud) * win * 1000) / rate),
  };
}

/** Which clips go, oldest first, so that at most `keep` remain and they fit in `maxBytes`. */
export function overCap<T extends { bytes: number }>(clips: T[], keep = KEEP, maxBytes = MAX_BYTES): T[] {
  const drop: T[] = [];
  const rest = [...clips];
  let total = rest.reduce((a, c) => a + c.bytes, 0);
  while (rest.length && (rest.length > keep || total > maxBytes)) {
    const c = rest.shift()!;
    total -= c.bytes;
    drop.push(c);
  }
  return drop;
}

const indexFile = (dir: string) => path.join(dir, "index.json");

function readIndex(dir: string): Clip[] {
  try {
    const j = JSON.parse(fs.readFileSync(indexFile(dir), "utf8"));
    return Array.isArray(j?.clips) ? j.clips.filter((c: any) => c && typeof c.file === "string" && /^[\w.-]+$/.test(c.file)) : [];
  } catch {
    return [];
  }
}
function writeIndex(dir: string, clips: Clip[]): void {
  const tmp = indexFile(dir) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ clips }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, indexFile(dir));
}

/**
 * Keep one final clip with its transcript. Returns the clip, or null when it was not kept (empty,
 * too big, or pure digital silence — the blank clip a call sends to warm the engine).
 */
export function keepClip(
  buf: Buffer,
  meta: { text: string; lang?: string | null; engine?: string | null; ms?: number | null; ext?: string },
  opts: { dir?: string; now?: number; keep?: number; maxBytes?: number } = {},
): Clip | null {
  if (!buf?.length || buf.length > MAX_CLIP_BYTES) return null;
  const stats = wavStats(buf);
  if (stats && stats.peak === 0) return null;
  const dir = opts.dir ?? clipsDir();
  const now = opts.now ?? Date.now();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ext = /^[a-z0-9]{2,5}$/.test(meta.ext ?? "") ? meta.ext : "wav";
  const file = `${new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(dir, file), buf, { mode: 0o600 });
  const clip: Clip = {
    file,
    at: new Date(now).toISOString(),
    bytes: buf.length,
    lang: meta.lang ?? null,
    engine: meta.engine ?? null,
    ms: meta.ms ?? null,
    text: String(meta.text ?? "").slice(0, 2000),
    stats,
  };
  // A file the index lost track of (a crash between the two writes) must not outlive the cap.
  const clips = [...readIndex(dir).filter((c) => fs.existsSync(path.join(dir, c.file))), clip];
  const drop = overCap(clips, opts.keep ?? KEEP, opts.maxBytes ?? MAX_BYTES);
  for (const c of drop) fs.rmSync(path.join(dir, c.file), { force: true });
  const kept = clips.filter((c) => !drop.includes(c));
  writeIndex(dir, kept);
  const known = new Set(kept.map((c) => c.file));
  for (const f of fs.readdirSync(dir)) if (f !== "index.json" && !known.has(f)) fs.rmSync(path.join(dir, f), { force: true, recursive: true });
  return drop.includes(clip) ? null : clip;
}

/** Newest first. */
export function listClips(dir = clipsDir()): Clip[] {
  return readIndex(dir).filter((c) => fs.existsSync(path.join(dir, c.file))).reverse();
}

/** The setting went off: nothing of it stays on disk. */
export function wipeClips(dir = clipsDir()): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
