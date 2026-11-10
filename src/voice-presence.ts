/**
 * Which surfaces have a LIVE voice call right now — the first rung of a stuck-work alert
 * (src/stuck-alerts.ts): when the operator is on a call, the alert is spoken into it instead of
 * buzzing his phone.
 *
 * A call lives in the browser (the Desk's 🎙, static/desk.html), so the daemon only knows about it
 * because the page says so: POST /api/voice/presence every ~20s while the call is up, and once more
 * with live:false when it hangs up. A page that vanishes without saying goodbye (tab closed, Mac
 * asleep) simply stops pinging and falls out after VOICE_TTL_MS — the alert then goes to the phone,
 * which is the safe direction to be wrong in.
 *
 * `lock` is the Desk's client lock (static/desk-scope.js): a page locked to one workspace for a
 * screen share must never be handed another workspace's alert to read out loud.
 */
import { kv } from "./store.js";

export type VoiceLang = "en" | "es";
export type VoicePresence = { client: string; surface: string; lang: VoiceLang; lock: string | null; at: number };

/** Background tabs throttle timers to about once a minute; 90s keeps a 20s ping alive through that. */
export const VOICE_TTL_MS = 90_000;
const LANG_KEY = "alerts.voice_lang";

const calls = new Map<string, VoicePresence>();

export function notePresence(
  p: { client: string; surface?: string | null; live: boolean; lang?: string | null; lock?: string | null },
  nowMs = Date.now(),
): void {
  const client = String(p.client || "").slice(0, 80);
  if (!client) return;
  if (!p.live) { calls.delete(client); return; }
  const lang: VoiceLang = p.lang === "es" ? "es" : "en";
  calls.set(client, { client, surface: String(p.surface || "desk").slice(0, 40), lang, lock: p.lock || null, at: nowMs });
  // The language he last spoke in is the language his phone and Telegram alerts use (alerts.lang auto).
  try { if (kv.get(LANG_KEY) !== lang) kv.set(LANG_KEY, lang); } catch {}
}

/** Live calls, freshest first. */
export function voiceCalls(nowMs = Date.now()): VoicePresence[] {
  for (const [k, v] of calls) if (nowMs - v.at > VOICE_TTL_MS) calls.delete(k);
  return [...calls.values()].sort((a, b) => b.at - a.at);
}

/**
 * The call that may speak an alert about this workspace: the freshest one that is not locked to a
 * different client. An alert that belongs to no single workspace (a computer, a summary) only goes to
 * an unlocked page — the lock fails closed, exactly as static/desk-scope.js does for the bus.
 */
export function voiceFor(workspaceId: string | null, nowMs = Date.now()): VoicePresence | null {
  return voiceCalls(nowMs).find((c) => c.lock === null || (workspaceId !== null && c.lock === workspaceId)) ?? null;
}

export function lastVoiceLang(): VoiceLang | null {
  try {
    const v = kv.get(LANG_KEY);
    return v === "es" || v === "en" ? v : null;
  } catch {
    return null;
  }
}

/** Tests. */
export function resetVoicePresence(): void {
  calls.clear();
}
