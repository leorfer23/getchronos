/**
 * Output a channel's ring had to evict before the brain acked it, kept on disk (HOSTS.md → Reconnect
 * and restarts). The ring holds 256 KB (4 MB for a run); a brain whose lid is closed for an hour
 * misses far more than that from a busy agent, and without this the reconnect replays a hole.
 *
 * One append-only file per channel under `~/.chronos-host/spill/`: `[seq u64][len u32][bytes]` per
 * frame, oldest first. Read back only on attach, deleted as soon as the brain acks past its newest
 * frame. Bounded per channel; a full spill says no and the ring reports the gap as it always did.
 *
 * The directory is wiped when the host starts: a host restart kills its PTYs (they are its
 * children), so a spill from the previous process belongs to a channel that no longer exists.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { DataFrame, RingSpill } from "../hostlink/wire.js";

/** Per-channel disk budget. A few of these at once is still a small fraction of any Mac's disk. */
export const SPILL_BYTES = 64 * 1024 * 1024;
const REC_HEADER = 12;

export class SpillDir {
  constructor(readonly dir: string, readonly capBytes = SPILL_BYTES) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** A fresh spill for one channel. The random suffix keeps a reused channel number off an old file. */
  forChannel(ch: number): FileSpill {
    return new FileSpill(path.join(this.dir, `${ch}-${crypto.randomBytes(4).toString("hex")}.bin`), ch, this.capBytes);
  }
}

export class FileSpill implements RingSpill {
  private fd: number | null = null;
  private size = 0;
  private maxSeq = 0;

  constructor(readonly file: string, readonly ch: number, readonly cap = SPILL_BYTES) {}

  get bytes(): number { return this.size; }

  put(f: DataFrame): boolean {
    const need = REC_HEADER + f.bytes.length;
    if (this.size + need > this.cap) return false;
    try {
      // Sync on purpose: it only runs when the ring overflows, and the PTY's data callback must see the
      // frame kept before the next one is numbered.
      this.fd ??= fs.openSync(this.file, "a", 0o600);
      const head = Buffer.allocUnsafe(REC_HEADER);
      head.writeBigUInt64BE(BigInt(f.seq), 0);
      head.writeUInt32BE(f.bytes.length, 8);
      fs.writeSync(this.fd, head);
      fs.writeSync(this.fd, f.bytes);
    } catch (e: any) {
      console.warn(`[host] output spill for channel ${this.ch} failed (${e?.message ?? e}) — the brain will see a gap`);
      return false;
    }
    this.size += need;
    this.maxSeq = f.seq;
    return true;
  }

  since(seq: number): DataFrame[] {
    if (!this.size) return [];
    let buf: Buffer;
    try { buf = fs.readFileSync(this.file); } catch { return []; }
    const out: DataFrame[] = [];
    for (let i = 0; i + REC_HEADER <= buf.length; ) {
      const s = Number(buf.readBigUInt64BE(i));
      const len = buf.readUInt32BE(i + 8);
      if (i + REC_HEADER + len > buf.length) break; // a torn tail: what came before is still whole
      if (s > seq) out.push({ ch: this.ch, seq: s, bytes: buf.subarray(i + REC_HEADER, i + REC_HEADER + len) });
      i += REC_HEADER + len;
    }
    return out;
  }

  /**
   * Only an ack past the newest spilled frame frees anything: the file is append-only, and a partial
   * ack just means `since()` skips the acked head. Every ring ack after reconnect covers it quickly.
   */
  ack(seq: number): void {
    if (this.size && seq >= this.maxSeq) this.drop();
  }

  drop(): void {
    if (this.fd == null) return;
    try { fs.closeSync(this.fd); } catch {}
    try { fs.unlinkSync(this.file); } catch {}
    this.fd = null;
    this.size = 0;
    this.maxSeq = 0;
  }
}
