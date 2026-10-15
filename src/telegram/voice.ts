import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tg, send, esc, TOKEN } from "./api.js";
import { deliverToActiveExec } from "./agent.js";
import { transcribe as transcribeAudio, transcribeIsLocal } from "../transcribe.js";

// Telegram voice notes (OGG/Opus) → transcription (local whisper.cpp by default) → same NL agent path.
const MAX_VOICE_BYTES = 20 * 1024 * 1024;
const MAX_VOICE_SEC = 300;

export type VoiceMeta = { duration?: number; file_size?: number };

// Pure gate — no I/O — so it's unit-testable without hitting Telegram/whisper.
export function voiceGate(v: VoiceMeta): string | null {
  // Local whisper needs no key; only a cloud endpoint does.
  if (!transcribeIsLocal() && !process.env.OPENAI_API_KEY) return "cloud voice needs OPENAI_API_KEY in .secrets";
  if ((v.duration ?? 0) > MAX_VOICE_SEC) return "voice note too long (max 5 min)";
  if ((v.file_size ?? 0) > MAX_VOICE_BYTES) return "voice note too large (max 20MB)";
  return null;
}

async function transcribe(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return transcribeAudio(buf, { filename: "voice.oga", contentType: "audio/ogg" });
}

// Download the voice note via Bot API, transcribe it, echo "🎤 <transcript>", then feed the
// transcript into the same door typed text uses — whichever executive the chat is pointed at,
// with Robert's PROPOSE handling, parallel-ask cap and reply attribution unchanged.
export async function handleVoice(chatId: number, voice: VoiceMeta & { file_id: string }, msgId: number) {
  const gateErr = voiceGate(voice);
  if (gateErr) { await send(chatId, gateErr, undefined, msgId); return; }

  let tmpFile: string | undefined;
  try {
    const fileRes: any = await tg("getFile", { file_id: voice.file_id });
    const filePath = fileRes?.result?.file_path;
    if (!filePath) { await send(chatId, "⚠️ couldn't fetch voice file", undefined, msgId); return; }

    const audioRes = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${filePath}`);
    if (!audioRes.ok) { await send(chatId, "⚠️ couldn't download voice note", undefined, msgId); return; }

    tmpFile = path.join(os.tmpdir(), `chronos-voice-${randomUUID()}.oga`);
    await fs.writeFile(tmpFile, Buffer.from(await audioRes.arrayBuffer()));

    const transcript = await transcribe(tmpFile);
    if (!transcript) { await send(chatId, "⚠️ transcription came back empty", undefined, msgId); return; }

    await send(chatId, `🎤 ${esc(transcript)}`, undefined, msgId);
    void deliverToActiveExec(chatId, transcript, msgId);
  } catch (e: any) {
    await send(chatId, "⚠️ " + esc(String(e.message ?? e)), undefined, msgId);
  } finally {
    if (tmpFile) await fs.unlink(tmpFile).catch(() => {});
  }
}
