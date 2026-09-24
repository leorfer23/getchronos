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
export const PROTOCOL_VERSION = "1.4";
// 1.1 (phase 3): hello.live[] carries `exit`/`transcript_offset`; `transcript` carries `offset`/`reset`;
// brain → host `attach` and `release`. All additive: a 1.0 peer ignores what it does not know.
// 1.2 (phase 4): vitals carry `ncpu`/`load1`/`swapUsedMb`/`swapTotalMb` (the brain runs the governor's
// own admission() on a host's numbers and sizes its heavy-slot pool); capabilities carry `auto_clone`.
// 1.3 (phase 6): hello carries `commit` / `install`; brain → host `update`, host → brain `update_status`.
// 1.4 (phase 5): headless runs and the ship pipeline — see the "phase 5" block below. `spawn_proc`
// is answered, proc channels ride the same data/ack/attach/release frames a pty does, and the rpc ops
// `exec` / `oneshot` / `worktree_ensure` exist. A host older than 1.4 is simply never sent a run
// (placement reads `capabilities.procs`).

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

// ── phase 5: headless procs + exec ──
// Everything phase 5 adds to the protocol lives in this block (the unions above only name it), so a
// parallel change to the wire rebases against one hunk. Proc channels reuse the pty frames for what
// they share — `data` (stdout, one whole line or more per frame), `ack`, `attach`, `release`, `kill`,
// `exit` (+ `timed_out`) — and add only what a pty does not have.

/** What a host that runs headless jobs says it can do (hello.capabilities, protocol 1.3). */
export type ProcCapabilities = {
  /** Answers `spawn_proc` and the `exec` / `oneshot` / `worktree_ensure` ops. */
  procs?: boolean;
  /** Runs a workspace's egress proxy itself (spec.egress), so an egress-locked workspace may run here. */
  egress?: boolean;
};

export type ProcHostToBrain =
  /**
   * A headless run's stderr, as it comes (not sequenced: the brain keeps only a rolling tail for the
   * run's error message). `replay` = the host's whole kept tail, resent on attach after a reconnect;
   * a brain that already has stderr for the channel ignores it.
   */
  | { t: "stderr"; ch: number; text: string; replay?: boolean }
  /** One outbound connection the host's egress proxy allowed or denied, for the brain's audit log. */
  | { t: "egress"; workspace_id: string; host: string; port: number; action: "allow" | "deny" };

export type ProcBrainToHost =
  /** Steer-mode stdin for a proc channel: NDJSON `bytes`, or `end` to close it (how a steer run ends). */
  | { t: "stdin"; ch: number; bytes?: string; end?: boolean };

/**
 * Unacked stdout kept per headless run. Bigger than a pty's ring on purpose: a pty that loses output
 * to eviction repaints on the next frame, but a run's stdout is its event log — an evicted line is a
 * lost run event, and the one that matters most (the result, with cost and summary) comes last. Hosts
 * are the machines with RAM to spare; a few MB per live run is the price of never losing that line.
 */
export const PROC_RING_BYTES = 4 * 1024 * 1024;

/**
 * `exec` rpc (HOSTS.md → The ship pipeline on a host): one command in a directory ON THE HOST, with
 * the host's own timeout. What gates, reviews, delivery and the verifier used to run with execFile in
 * a worktree on the brain's disk.
 */
export type ExecSpec = {
  /** Checked against the host's veto before anything runs. */
  workspace: { id: string; slug: string } | null;
  /** A directory on the host (it reported it: a checkout or a worktree). */
  cwd: string;
  cmd?: string;
  args?: string[];
  /**
   * A shell line instead of cmd/args: the host runs it through `bash -lc` with ITS runtime PATH put
   * back in front (gates.ts withRuntimePath) — the brain's PATH means nothing on another Mac.
   */
  shell?: string;
  /** Secrets + workspace vars only (spawn-spec.ts portableEnv); the host supplies the base env. */
  env: Record<string, string>;
  env_home_relative: string[];
  /** Enforced by the host: a dropped link cannot leave a runaway gate. */
  timeout_ms: number;
  /** Cap per stream; `keep` says which end survives the cut (a diff wants its head, a gate its tail). */
  max_bytes?: number;
  keep?: "head" | "tail";
};

export type ExecResult = {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  truncated: boolean;
  /** Set when nothing ran: `cwd_missing: …`, `outside: …`, `veto: …`, `spawn: …`. */
  error?: string;
};

/** Hard ceiling on one exec stream (a control frame is 24 MB; two streams must fit with room). */
export const EXEC_MAX_BYTES = 8 * 1024 * 1024;
// ── end phase 5 ──

// ───────────────────────────── control frames ─────────────────────────────

export type CliInfo = {
  name: string; path: string | null; version: string | null;
  /**
   * Whether the CLI is logged in on this host, where that is readable without running a model call:
   * grok/opencode by their auth file, cursor-agent by `status` or CURSOR_API_KEY. Absent (older
   * hosts, or CLIs with no probe) and "unknown" mean "don't know" — placement only refuses on "no".
   */
  auth?: "yes" | "no" | "unknown";
};
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
} & ProcCapabilities;

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
  /** Phase 6: the commit this host runs (git installs), and how it was installed — see HostInstall. */
  commit?: string | null;
  install?: HostInstall;
};

export type HostToBrain =
  | Hello
  | ({ t: "vitals" } & HostVitals)
  | { t: "exit"; ch: number; code: number | null; signal: string | null; timed_out?: boolean }
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
  | { t: "error"; code: string; message: string; id?: string }
  | UpdateStatus
  | ProcHostToBrain;

export type BrainToHost =
  | { t: "welcome"; proto: string; host_id: string; ping_ms: number; name?: string }
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
  | { t: "error"; code: string; message: string; id?: string }
  | UpdateFrame
  | ProcBrainToHost;

// ── phase 6: version + update ──
/**
 * How a host's code got there (bin/host-core.mjs `installKind`): `git` = the clone at
 * ~/.chronos-host/app, updated by commit; `npm` = `getchronos` installed under ~/.chronos-host/app,
 * updated by version; `dev` = someone's own checkout, which the brain never updates. A host that sends
 * no `install` predates phase 6 and does not understand `update` at all.
 */
export type HostInstall = "git" | "npm" | "dev";
/** What the brain runs, and so what an update brings a host to. */
export type UpdateTarget = { version: string; commit: string | null };
/** brain → host: become `target`, then restart. Answered with `update_status` frames carrying the same id. */
export type UpdateFrame = { t: "update"; id: string; target: UpdateTarget };
/**
 * host → brain, as the update moves: `running` (with the step), then `restarting` (the new code is in
 * place and the LaunchAgent is being kicked — the link drops next), or `failed` (the old version keeps
 * running; `error` says why), or `current` (already there, nothing done).
 */
export type UpdateStatus = {
  t: "update_status";
  id: string;
  state: "running" | "restarting" | "failed" | "current";
  step?: string;
  error?: string;
};
// ── end phase 6 ──

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
