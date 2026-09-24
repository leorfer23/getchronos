/**
 * The brain ⇄ host wire protocol (HOSTS.md → Transport). Pure: no sockets, no timers, no I/O.
 *
 * One WebSocket carries everything between a brain and one host, so the frames have to be two kinds:
 *
 *  - **Control frames** are JSON text: hello, vitals, rpc, api, ping. Small, rare, and readable in a
 *    packet dump when something goes wrong at 3am.
 *  - **Data frames** are binary: PTY and stdout bytes, the hot path. A terminal repainting at 60 fps
 *    would pay a base64 + JSON tax on every frame for nothing, so bytes stay bytes behind a fixed
 *    14-byte header that names the channel and the sequence number.
 *
 * Every data frame has a per-channel `seq`. The host keeps what the brain has not acked in a `Ring`
 * (256 KB per channel, the same size as `replayTail` today), so a Wi-Fi drop costs a resend from the
 * last ack rather than a hole in the operator's screen. The brain de-duplicates with `SeqTracker`.
 */

/**
 * `major.minor`. The brain refuses a host whose MAJOR differs — a frame shape changed incompatibly —
 * and accepts any minor (a newer minor only adds optional fields or frame kinds the other side
 * ignores). Bump major only when an existing frame changes meaning.
 */
export const PROTOCOL_VERSION = "1.2";
// 1.1 (phase 3): hello.live[] carries `exit`/`transcript_offset`; `transcript` carries `offset`/`reset`;
// brain → host `attach` and `release`. All additive: a 1.0 peer ignores what it does not know.
// 1.2 (phase 4): vitals carry `ncpu`/`load1`/`swapUsedMb`/`swapTotalMb` (the brain runs the governor's
// own admission() on a host's numbers and sizes its heavy-slot pool); capabilities carry `auto_clone`.

/** Binary data frame header: magic(1) kind(1) ch(u32) seq(u64). */
export const DATA_HEADER_BYTES = 14;
const MAGIC = 0xc1;
const KIND_DATA = 0x01;

/**
 * Largest payload one data frame may carry. `chunk()` splits bigger writes. A PTY read is at most a
 * few KB, so this only bites on a pathological burst — and a single giant frame would hold the one
 * socket every other channel of that host shares (head-of-line blocking) for the whole transfer.
 */
export const MAX_DATA_PAYLOAD = 64 * 1024;

/**
 * Largest control frame. `api` frames carry forwarded `mc` requests, and the daemon accepts JSON
 * bodies up to 16 MB (ticket attachment uploads, `express.json({limit:"16mb"})`), which travel
 * base64 inside the frame (×4/3). Above this the link is being abused, not used.
 */
export const MAX_CONTROL_BYTES = 24 * 1024 * 1024;

/** Per-channel unacked output kept by the sender (HOSTS.md: "a 256 KB ring per PTY"). */
export const RING_BYTES = 256 * 1024;

// ───────────────────────────── control frames ─────────────────────────────

export type CliInfo = { name: string; path: string | null; version: string | null };
export type ProfileInfo = { name: string; dir: string; exists: boolean };
export type CheckoutInfo = { path: string; remote_url: string | null };
export type LiveInfo = {
  ch: number;
  session_id: string;
  kind: "pty" | "proc";
  pid: number | null;
  last_seq: number;
  /**
   * Set when the process already ended while the brain was not listening. The host keeps an exited
   * channel (and its unacked output) until the brain `release`s it, so an exit that happened during a
   * Wi-Fi drop is still delivered — as output, then the exit — instead of the row being guessed dead.
   */
  exit?: { code: number | null; signal: string | null } | null;
  /** Bytes of this session's CLI transcript the host has read so far (see `transcript`). */
  transcript_offset?: number;
};
export type HostVitals = {
  at: number;
  cpu: number | null;
  ram: number | null;
  gpu: number | null;
  loadPerCore: number;
  pressure: 1 | 2 | 4 | null;
  swapPct: number | null;
  /**
   * Protocol 1.2. The raw numbers behind `loadPerCore` and `swapPct`, so the brain can run the
   * governor's own `admission()` on them (its reasons name "load 14.2 on 12 cores") and size the
   * host's heavy-slot pool (`ncpu / 6`). Optional: a 1.1 host still reports the ratios alone.
   */
  ncpu?: number;
  load1?: number;
  swapUsedMb?: number | null;
  swapTotalMb?: number | null;
};
export type Capabilities = {
  clis: CliInfo[];
  node: string;
  sandbox: boolean;
  /** Protocol 1.2: CHRONOS_HOST_AUTO_CLONE=1 — placement may send a repo this host has not cloned yet. */
  auto_clone?: boolean;
};

export type Hello = {
  t: "hello";
  proto: string;
  /** chronos package version on the host — what the Desk shows next to "update this host". */
  version: string;
  host_id: string;
  name: string;
  platform: string;
  arch: string;
  capabilities: Capabilities;
  profiles: ProfileInfo[];
  checkouts: CheckoutInfo[];
  /** The host's local veto (CHRONOS_HOST_DENY). Reported so the brain can show it; the host enforces it. */
  deny: string[];
  live: LiveInfo[];
};

export type HostToBrain =
  | Hello
  | ({ t: "vitals" } & HostVitals)
  | { t: "exit"; ch: number; code: number | null; signal: string | null }
  /**
   * Raw CLI transcript bytes (JSONL, whole lines only) for one channel. `offset` is where `delta`
   * starts in the host's file, so the brain can write it into its mirror idempotently (a resend after
   * reconnect overlaps). `reset` = the host is now reading a different or truncated file: start over.
   */
  | { t: "transcript"; ch: number; delta: string; offset?: number; reset?: boolean }
  | { t: "api"; req_id: string; session_id: string | null; method: string; path: string; headers: Record<string, string>; body: string | null }
  | { t: "rpc_result"; id: string; ok: true; value: unknown }
  | { t: "rpc_result"; id: string; ok: false; error: string }
  | { t: "ping"; n: number }
  | { t: "pong"; n: number }
  | { t: "error"; code: string; message: string; id?: string };

export type BrainToHost =
  | { t: "welcome"; proto: string; host_id: string; ping_ms: number }
  | { t: "joined"; host_id: string; token: string }
  | { t: "spawn_pty"; id: string; spec: unknown }
  | { t: "spawn_proc"; id: string; spec: unknown }
  | { t: "write"; ch: number; bytes: string }
  | { t: "resize"; ch: number; cols: number; rows: number }
  | { t: "kill"; ch: number; signal?: string }
  | { t: "rpc"; id: string; op: string; args?: unknown }
  | { t: "api_result"; req_id: string; status: number; headers: Record<string, string>; body: string | null }
  | { t: "policy"; deny: string[]; reserve?: unknown }
  | { t: "ack"; ch: number; seq: number }
  /**
   * The brain (re)adopts a channel after hello: resend output after `seq` (what the brain already
   * has) and the transcript from `transcript_offset`, then any exit that is still pending.
   */
  | { t: "attach"; ch: number; seq: number; transcript_offset: number; session_id?: string }
  /** The brain has processed this channel's exit: the host may forget it. */
  | { t: "release"; ch: number }
  | { t: "ping"; n: number }
  | { t: "pong"; n: number }
  | { t: "error"; code: string; message: string; id?: string };

export type ControlFrame = HostToBrain | BrainToHost;

export function encodeControl(f: ControlFrame): string {
  const s = JSON.stringify(f);
  if (Buffer.byteLength(s) > MAX_CONTROL_BYTES) throw new WireError("oversized", `control frame ${f.t} exceeds ${MAX_CONTROL_BYTES} bytes`);
  return s;
}

export class WireError extends Error {
  constructor(readonly code: "oversized" | "malformed" | "unknown", message: string) {
    super(message);
  }
}

/**
 * Parse one text frame. Throws `WireError` on anything that is not an object with a string `t` — the
 * caller closes the link on a malformed frame rather than guessing, because a desynced peer that is
 * guessed at keeps producing garbage. Unknown `t` values are NOT an error here: a newer minor may add
 * frame kinds, and the dispatcher ignores what it does not know.
 */
export function decodeControl(text: string | Buffer): ControlFrame {
  const len = typeof text === "string" ? Buffer.byteLength(text) : text.length;
  if (len > MAX_CONTROL_BYTES) throw new WireError("oversized", `control frame of ${len} bytes`);
  let v: unknown;
  try {
    v = JSON.parse(typeof text === "string" ? text : text.toString("utf8"));
  } catch {
    throw new WireError("malformed", "control frame is not JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v) || typeof (v as any).t !== "string") {
    throw new WireError("malformed", "control frame has no type");
  }
  return v as ControlFrame;
}

// ───────────────────────────── data frames ─────────────────────────────

export type DataFrame = { ch: number; seq: number; bytes: Buffer };

/**
 * seq travels as a u64 so it never wraps in practice (2^53 frames at 60 fps is millions of years);
 * JS numbers are exact to 2^53, which is the real ceiling and is checked.
 */
export function encodeData(ch: number, seq: number, bytes: Buffer | Uint8Array): Buffer {
  if (!Number.isInteger(ch) || ch < 0 || ch > 0xffffffff) throw new WireError("malformed", `bad channel ${ch}`);
  if (!Number.isSafeInteger(seq) || seq < 0) throw new WireError("malformed", `bad seq ${seq}`);
  if (bytes.length > MAX_DATA_PAYLOAD) throw new WireError("oversized", `data payload ${bytes.length} > ${MAX_DATA_PAYLOAD} (use chunk())`);
  const out = Buffer.allocUnsafe(DATA_HEADER_BYTES + bytes.length);
  out[0] = MAGIC;
  out[1] = KIND_DATA;
  out.writeUInt32BE(ch, 2);
  out.writeBigUInt64BE(BigInt(seq), 6);
  out.set(bytes, DATA_HEADER_BYTES);
  return out;
}

export function decodeData(buf: Buffer): DataFrame {
  if (buf.length < DATA_HEADER_BYTES) throw new WireError("malformed", `data frame of ${buf.length} bytes is shorter than its header`);
  if (buf[0] !== MAGIC) throw new WireError("malformed", "bad magic");
  if (buf[1] !== KIND_DATA) throw new WireError("unknown", `unknown binary kind ${buf[1]}`);
  if (buf.length - DATA_HEADER_BYTES > MAX_DATA_PAYLOAD) throw new WireError("oversized", `data payload ${buf.length - DATA_HEADER_BYTES}`);
  const seq = buf.readBigUInt64BE(6);
  if (seq > BigInt(Number.MAX_SAFE_INTEGER)) throw new WireError("malformed", "seq beyond 2^53");
  // subarray, not copy: the caller decides whether to keep it past the socket's buffer lifetime.
  return { ch: buf.readUInt32BE(2), seq: Number(seq), bytes: buf.subarray(DATA_HEADER_BYTES) };
}

/** Split a write into payloads no larger than MAX_DATA_PAYLOAD, in order. Empty in → nothing out. */
export function chunk(bytes: Buffer, max = MAX_DATA_PAYLOAD): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += max) out.push(bytes.subarray(i, Math.min(bytes.length, i + max)));
  return out;
}

// ───────────────────────────── versions ─────────────────────────────

export type Compat = { ok: true } | { ok: false; reason: string };

export function checkCompat(theirs: unknown, ours = PROTOCOL_VERSION): Compat {
  const parse = (v: unknown) => {
    const m = /^(\d+)\.(\d+)$/.exec(String(v ?? ""));
    return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
  };
  const a = parse(theirs), b = parse(ours);
  if (!a) return { ok: false, reason: `host speaks an unreadable protocol version ${JSON.stringify(theirs)} — update this host` };
  if (!b || a.major !== b.major) return { ok: false, reason: `host protocol ${theirs} is incompatible with brain ${ours} — update this host` };
  return { ok: true };
}

// ───────────────────────────── the ring: unacked output ─────────────────────────────

export type Replay = {
  frames: DataFrame[];
  /**
   * true when output the peer has not seen was already evicted: the resend starts after a hole. The
   * brain then says so on the screen instead of pretending the stream is whole.
   */
  gap: boolean;
};

/**
 * One channel's outbound history, bounded by BYTES (not frames: a burst of tiny frames and one fat
 * repaint should cost the same memory they occupy).
 *
 * Sender side: `append()` numbers each payload (seq starts at 1, so an ack of 0 means "nothing yet").
 * `ack(seq)` drops everything up to and including seq — the peer has it. `since(seq)` is what to
 * resend after a reconnect in which the peer reported `seq` as the last it saw.
 *
 * When unacked output passes `cap`, the oldest frames are evicted anyway. The alternative — blocking
 * the PTY until the brain acks — would stall an agent because a laptop lid closed, which is exactly
 * what HOSTS.md says must not happen ("PTYs keep running; output buffered in the ring").
 */
export class Ring {
  private frames: DataFrame[] = [];
  private head = 0; // index of the oldest live frame in `frames` (amortised shift)
  private size = 0;
  private nextSeq = 1;
  /** Highest seq ever evicted before it was acked; 0 when nothing unseen was lost. */
  private lostThrough = 0;
  private ackedThrough = 0;

  constructor(readonly cap = RING_BYTES, readonly ch = 0) {}

  /** Bytes currently held. */
  get bytes(): number { return this.size; }
  /** The seq the next append will get, minus one: the newest seq produced so far. */
  get lastSeq(): number { return this.nextSeq - 1; }
  get acked(): number { return this.ackedThrough; }

  append(bytes: Buffer): DataFrame {
    const f: DataFrame = { ch: this.ch, seq: this.nextSeq++, bytes: Buffer.from(bytes) };
    this.frames.push(f);
    this.size += f.bytes.length;
    while (this.size > this.cap && this.head < this.frames.length - 1) this.evictOne();
    // A single frame larger than the ring: kept on its own (it is the newest output), never split —
    // splitting would invent frame boundaries the reader did not produce.
    this.compact();
    return f;
  }

  ack(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq <= this.ackedThrough) return; // stale or duplicate ack
    const upTo = Math.min(seq, this.lastSeq); // an ack from the future is clamped, not trusted
    this.ackedThrough = upTo;
    while (this.head < this.frames.length && this.frames[this.head].seq <= upTo) {
      this.size -= this.frames[this.head].bytes.length;
      this.head++;
    }
    this.compact();
  }

  /** Everything after `seq`, oldest first, and whether a hole precedes it. */
  since(seq: number): Replay {
    const from = Math.max(0, seq);
    const frames = this.frames.slice(this.head).filter((f) => f.seq > from);
    return { frames, gap: this.lostThrough > from };
  }

  private evictOne(): void {
    const f = this.frames[this.head++];
    this.size -= f.bytes.length;
    if (f.seq > this.ackedThrough) this.lostThrough = Math.max(this.lostThrough, f.seq);
  }

  private compact(): void {
    if (this.head > 1024 && this.head * 2 > this.frames.length) {
      this.frames = this.frames.slice(this.head);
      this.head = 0;
    }
  }
}

/**
 * Receiver side of one channel. A resend after reconnect overlaps what already arrived, so frames
 * at or below the last accepted seq are duplicates and dropped. A jump forward is a gap (evicted on
 * the sender) — accepted, because the bytes after a hole are still the newest truth, but reported.
 */
export class SeqTracker {
  private last = 0;
  get lastSeq(): number { return this.last; }
  accept(seq: number): "ok" | "dup" | "gap" {
    if (seq <= this.last) return "dup";
    const verdict = seq === this.last + 1 ? "ok" : "gap";
    this.last = seq;
    return verdict;
  }
}
