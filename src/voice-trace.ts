/**
 * Call traces from the real phone: what the call engine did (static/phone-voice.js `trace`) and the
 * mic levels it measured while Robert was speaking — the numbers that say why a barge-in did or did
 * not fire on HIS phone, on HIS route (speaker, earpiece, headset, car). Posted at hang-up and on
 * demand (POST /api/voice/trace), operator-only, kept in memory: the last few, nothing on disk.
 * No audio is ever sent — only levels (0..1 RMS, rounded) and event names.
 * Read them with `mc voice traces` (GET /api/voice/traces).
 */

export type VoiceTrace = {
  id: string;
  at: string;
  client: string;
  surface: string;
  ua: string;
  why: string;
  /** [ms since page start, event] — the engine's own trace. */
  events: Array<[number, string]>;
  /** Mic level samples while the page was playing speech: [ms, rms, floor, threshold]. */
  levels: Array<[number, number, number, number]>;
  summary: Record<string, number | string | null>;
};

const KEEP = 8;
const MAX_EVENTS = 400;
const MAX_LEVELS = 2000;
const traces: VoiceTrace[] = [];

const str = (v: unknown, n: number) => String(v ?? "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, n);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0);

/** Validate and keep one trace. Anything that is not the shape below is dropped, not stored. */
export function noteVoiceTrace(body: any, nowMs = Date.now()): { ok: true; id: string } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "a JSON object" };
  const events = Array.isArray(body.events) ? body.events : Array.isArray(body.trace) ? body.trace : [];
  const levels = Array.isArray(body.levels) ? body.levels : [];
  if (!events.length && !levels.length) return { ok: false, error: "nothing in it: events or levels" };
  const t: VoiceTrace = {
    id: Math.random().toString(36).slice(2, 10),
    at: new Date(nowMs).toISOString(),
    client: str(body.client, 80),
    surface: str(body.surface, 24) || "phone",
    ua: str(body.ua, 200),
    why: str(body.why, 40) || "hang-up",
    events: events.slice(-MAX_EVENTS).filter((e: unknown) => Array.isArray(e)).map((e: any[]) => [num(e[0]), str(e[1], 120)] as [number, string]),
    levels: levels.slice(-MAX_LEVELS).filter((l: unknown) => Array.isArray(l)).map((l: any[]) => [num(l[0]), num(l[1]), num(l[2]), num(l[3])] as [number, number, number, number]),
    summary: {},
  };
  const sum = body.summary && typeof body.summary === "object" ? body.summary : {};
  for (const [k, v] of Object.entries(sum).slice(0, 30)) t.summary[str(k, 40)] = typeof v === "number" ? num(v) : v == null ? null : str(v, 120);
  // What the levels say, worked out here so `mc voice traces` reads at a glance.
  if (t.levels.length) {
    const rms = t.levels.map((l) => l[1]).sort((a, b) => a - b);
    const q = (p: number) => rms[Math.min(rms.length - 1, Math.floor(p * rms.length))];
    t.summary.play_rms_p50 = q(0.5);
    t.summary.play_rms_p90 = q(0.9);
    t.summary.play_rms_max = rms[rms.length - 1];
    t.summary.threshold_last = t.levels[t.levels.length - 1][3];
  }
  t.summary.barges = t.events.filter((e) => /^barge$/.test(e[1])).length;
  t.summary.barge_words = t.events.filter((e) => /^barge:words/.test(e[1])).length;
  t.summary.barge_false = t.events.filter((e) => /^barge:echo-or-noise/.test(e[1])).length;
  t.summary.taps_stop = t.events.filter((e) => /^tap-stop/.test(e[1])).length;
  // Hearing: what the ear did with each sound (seg:<ms>:<loud ms>:<voiced ms>:<peak‰>:<kept|word|barge|drop>),
  // how often he spoke again right after a cut (reopen:<ms>) and how many of those became one turn (join:<ms>).
  const kind = (k: string) => t.events.filter((e) => new RegExp(`^seg:.*:${k}$`).test(e[1])).length;
  t.summary.segs_kept = kind("kept") + kind("barge");
  t.summary.segs_word = kind("word");
  t.summary.segs_dropped = kind("drop");
  t.summary.reopens = t.events.filter((e) => /^reopen:/.test(e[1])).length;
  t.summary.joins = t.events.filter((e) => /^join:\d/.test(e[1])).length;
  traces.push(t);
  while (traces.length > KEEP) traces.shift();
  return { ok: true, id: t.id };
}

export function voiceTraces(limit = 5): VoiceTrace[] {
  return traces.slice(-Math.max(1, Math.min(limit, KEEP))).reverse();
}

/** Tests. */
export function resetVoiceTraces(): void {
  traces.length = 0;
}
