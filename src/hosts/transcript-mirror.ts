import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostlinkDir } from "../hostlink/join.js";

// The brain's copy of a remote terminal's CLI transcript (HOSTS.md → phase 3, "transcript streaming").
//
// A claude on another Mac writes `<its profile>/projects/…/<id>.jsonl` on THAT disk. Focus (the Desk
// story), the usage ledger and term-status all read a transcript file, incrementally, by byte offset.
// Rather than teach each of them about a network stream, the host sends the raw lines and the brain
// appends them here; the readers are then pointed at this file (FocusCtx.transcriptFile, and
// session-usage's lookup) and work exactly as they do for a local terminal.
//
// Writes are by OFFSET, not blind appends: after a reconnect the host resends from what the brain last
// said it had, and a resend that overlaps is trimmed instead of doubling lines (which would double the
// ledger's turns and tokens). Kept under the hostlink dir, which the sandbox denies to every agent — a
// transcript is one workspace's conversation and must not be readable from another's terminal.

export function mirrorRoot(): string {
  if (process.env.CHRONOS_HOST_TRANSCRIPTS) return process.env.CHRONOS_HOST_TRANSCRIPTS;
  // Tests run on an in-memory DB and must never write into the checkout.
  if (process.env.CHRONOS_TEST) return path.join(os.tmpdir(), `chronos-test-transcripts-${process.pid}`);
  return path.join(hostlinkDir(), "transcripts");
}

export function mirrorFile(sessionId: string): string {
  return path.join(mirrorRoot(), `${String(sessionId).replace(/[^\w-]+/g, "_").slice(0, 80) || "session"}.jsonl`);
}

/** Bytes the brain already holds for this session — what it tells the host to resend after. */
export function mirrorSize(sessionId: string): number {
  try { return fs.statSync(mirrorFile(sessionId)).size; } catch { return 0; }
}

export function hasMirror(sessionId: string): boolean {
  return fs.existsSync(mirrorFile(sessionId));
}

/**
 * Write one delta that starts at `offset` in the host's file. Returns the bytes actually appended.
 * `reset` (the host switched to a new or truncated file) starts the mirror over, like the readers do
 * when a local transcript shrinks.
 */
export function writeTranscript(sessionId: string, offset: number, delta: string, reset = false): number {
  const file = mirrorFile(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (reset) fs.writeFileSync(file, "", { mode: 0o600 });
  const buf = Buffer.from(delta, "utf8");
  const size = mirrorSize(sessionId);
  const at = Number.isSafeInteger(offset) && offset >= 0 ? offset : size;
  // Already have (part of) this: keep only what is past our end. A delta that starts beyond our end
  // is a hole the host could not fill (its reader restarted) — appended anyway, the newest lines win.
  const skip = Math.max(0, size - at);
  if (skip >= buf.length) return 0;
  fs.appendFileSync(file, buf.subarray(skip), { mode: 0o600 });
  return buf.length - skip;
}

export function dropMirror(sessionId: string): void {
  try { fs.rmSync(mirrorFile(sessionId), { force: true }); } catch {}
}
