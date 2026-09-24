import { admission, heavyPoolFor, heavySlotsForCpus, loadFromVitals, VITALS_EVERY_MS, type MachineLoad } from "../machine.js";
import { SeqTracker, type BrainToHost, type DataFrame, type Hello, type HostToBrain, type HostVitals as WireVitals, type LiveInfo as WireLive } from "../hostlink/wire.js";
import { isSpawnSpec, type SpawnSpec } from "./spawn-spec.js";
import { mirrorSize, writeTranscript } from "./transcript-mirror.js";
import type { Disposable, HeavySlotPool, Host, HostVitals, LiveInfo, ProcHandle, PtyHandle, PtySpawn } from "./types.js";

// A computer the brain drives over a host link (HOSTS.md phase 3). Everything the daemon does to a
// terminal — write, resize, kill, read its bytes, learn it exited — goes through a PtyHandle; this is
// the PtyHandle that turns those calls into frames, and turns frames back into the same callbacks
// node-pty would fire. terminal.ts cannot tell the difference, which is the point: the Desk's buffer,
// ScreenMirror, turn detection and exit path are the ones a local terminal uses.
//
// The link can drop at any moment (Wi-Fi, a laptop lid). A drop is NOT a death: the host keeps the
// pty running and its output in a 256 KB ring, and when it says hello again the brain re-attaches
// with the last seq it has. SeqTracker drops what a resend overlaps, so a byte reaches the screen once.

/** The slice of BrainLink a RemoteHost needs. An interface so tests can drive a host with no socket. */
export interface HostLinkPort {
  isOnline(hostId: string): boolean;
  sendControl(hostId: string, f: BrainToHost): boolean;
  request(hostId: string, op: string, args?: unknown, timeoutMs?: number): Promise<unknown>;
}

/** What a host answers to `spawn_pty`. */
export type SpawnReply = { ch: number; pid: number; cols: number; rows: number; cwd: string };

/** Unclaimed output kept per host for a channel the brain has not registered yet (spawn reply race). */
const EARLY_CAP = 256 * 1024;
/** Acks are batched: one per channel per this long, not one per frame. */
const ACK_MS = 100;
const SPAWN_TIMEOUT_MS = 90_000; // a ticket worktree off a fresh `git fetch` is the slow case
/**
 * Vitals older than this are not a reading: a host that stopped reporting (a wedged process, a link
 * the pings have not declared dead yet) must not be placed onto on the strength of numbers from
 * before it went quiet. Six missed frames.
 */
export const VITALS_STALE_MS = 6 * VITALS_EVERY_MS;

export class RemoteChannel implements PtyHandle {
  readonly tracker = new SeqTracker();
  private dataLs: Array<(d: string) => void> = [];
  private exitLs: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  /** Output that arrived before anyone subscribed — openSession wires onData a few lines after spawn. */
  private held: string[] = [];
  private exited: { exitCode: number; signal?: number } | null = null;
  private ackT: NodeJS.Timeout | null = null;
  private decoder = new TextDecoder("utf-8", { fatal: false });
  gaps = 0;

  constructor(
    private readonly host: RemoteHost,
    readonly ch: number,
    readonly sessionId: string,
    readonly pid: number,
    public cols: number,
    public rows: number,
    readonly cwd: string,
  ) {}

  write(data: string): void {
    // Input while the link is down is dropped, not queued: a keystroke replayed minutes later into
    // whatever the agent is doing THEN is worse than a keystroke lost. The card says "host offline".
    this.host.send({ t: "write", ch: this.ch, bytes: data });
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.host.send({ t: "resize", ch: this.ch, cols, rows });
  }

  kill(signal?: string): void {
    this.host.send({ t: "kill", ch: this.ch, ...(signal ? { signal } : {}) });
  }

  onData(listener: (data: string) => void): Disposable {
    this.dataLs.push(listener);
    if (this.held.length) {
      const held = this.held;
      this.held = [];
      for (const d of held) for (const l of this.dataLs) l(d);
    }
    return { dispose: () => { this.dataLs = this.dataLs.filter((l) => l !== listener); } };
  }

  onExit(listener: (e: { exitCode: number; signal?: number }) => void): Disposable {
    this.exitLs.push(listener);
    if (this.exited) listener(this.exited);
    return { dispose: () => { this.exitLs = this.exitLs.filter((l) => l !== listener); } };
  }

  /** One data frame off the link. Duplicates (resend overlap) are dropped here, once. */
  feed(f: DataFrame): void {
    const v = this.tracker.accept(f.seq);
    if (v === "dup") return;
    if (v === "gap") this.gaps++;
    const text = this.decoder.decode(f.bytes, { stream: true });
    if (text) {
      if (this.dataLs.length) for (const l of this.dataLs) l(text);
      else this.held.push(text);
    }
    this.scheduleAck();
  }

  /** The process ended on the host. Fires once; later exits (a resent exit frame) are ignored. */
  end(code: number | null, signal: string | null): void {
    if (this.exited) return;
    const tail = this.decoder.decode();
    if (tail) for (const l of this.dataLs) l(tail);
    this.flushAck();
    this.exited = { exitCode: code ?? (signal ? 128 : 1), ...(signal ? { signal: signalNumber(signal) } : {}) };
    for (const l of this.exitLs) l(this.exited);
  }

  get hasExited(): boolean { return !!this.exited; }

  private scheduleAck(): void {
    if (this.ackT) return;
    this.ackT = setTimeout(() => this.flushAck(), ACK_MS);
    this.ackT.unref?.();
  }

  flushAck(): void {
    if (this.ackT) { clearTimeout(this.ackT); this.ackT = null; }
    if (this.tracker.lastSeq > 0) this.host.send({ t: "ack", ch: this.ch, seq: this.tracker.lastSeq });
  }

  /** Ask the host to resend after what we have: output after our last seq, transcript after our mirror. */
  attach(): void {
    this.host.send({ t: "attach", ch: this.ch, session_id: this.sessionId, seq: this.tracker.lastSeq, transcript_offset: mirrorSize(this.sessionId) });
  }

  dispose(): void {
    if (this.ackT) clearTimeout(this.ackT);
  }
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
const signalNumber = (s: string) => SIGNALS[s] ?? 15;

export class RemoteHost implements Host {
  private channels = new Map<number, RemoteChannel>();
  /** Output for channels the brain has not registered yet, by ch. Bounded; claimed at register. */
  private early = new Map<number, { frames: DataFrame[]; bytes: number; exit?: { code: number | null; signal: string | null } }>();
  hello: Hello | null = null;
  private wireVitals: WireVitals | null = null;
  /** When the BRAIN received the last vitals frame. Not `vitals.at`: that is the host's clock. */
  vitalsReceivedAt: number | null = null;
  private samples: WireVitals[] = [];
  onlineSince: number | null = null;
  offlineSince: number | null = Date.now();

  constructor(readonly id: string, private readonly link: HostLinkPort) {}

  get online(): boolean { return this.link.isOnline(this.id) && !!this.hello; }

  send(f: BrainToHost): boolean { return this.link.sendControl(this.id, f); }

  // ───────────── link lifecycle (driven by remote-terminals.ts from BrainLink events) ─────────────

  setOnline(hello: Omit<Hello, "t"> | Hello): void {
    this.hello = { t: "hello", ...(hello as Omit<Hello, "t">) } as Hello;
    this.onlineSince = Date.now();
    this.offlineSince = null;
  }

  setOffline(): void {
    this.onlineSince = null;
    this.offlineSince = Date.now();
    this.early.clear();
  }

  setVitals(v: WireVitals, receivedAt = Date.now()): void {
    this.wireVitals = v;
    this.vitalsReceivedAt = receivedAt;
    this.samples.push(v);
    if (this.samples.length > 120) this.samples.shift();
  }

  /** The live channels this host reported in its last hello — what reconcile walks. */
  reportedLive(): WireLive[] { return this.hello?.live ?? []; }

  /** Profiles/checkouts/veto the host reported. */
  reportedDeny(): string[] { return this.hello?.deny ?? []; }

  channelFor(sessionId: string): RemoteChannel | undefined {
    for (const c of this.channels.values()) if (c.sessionId === sessionId) return c;
    return undefined;
  }

  // ───────────── frames ─────────────

  data(f: DataFrame): void {
    const c = this.channels.get(f.ch);
    if (c) return c.feed(f);
    // A frame for a channel whose spawn reply has not been processed yet (the reply and the first
    // output can cross on the wire). Held, bounded, and claimed when the channel registers.
    const e = this.early.get(f.ch) ?? { frames: [], bytes: 0 };
    if (e.bytes + f.bytes.length > EARLY_CAP) return;
    e.frames.push({ ch: f.ch, seq: f.seq, bytes: Buffer.from(f.bytes) });
    e.bytes += f.bytes.length;
    this.early.set(f.ch, e);
  }

  control(f: HostToBrain): void {
    if (f.t === "exit") {
      const c = this.channels.get(f.ch);
      if (!c) {
        const e = this.early.get(f.ch) ?? { frames: [], bytes: 0 };
        e.exit = { code: f.code, signal: f.signal };
        this.early.set(f.ch, e);
        return;
      }
      this.channels.delete(f.ch);
      c.end(f.code, f.signal);
      c.dispose();
      // Only now may the host forget it: the exit reached terminal.ts's onExit.
      this.send({ t: "release", ch: f.ch });
      return;
    }
    if (f.t === "transcript") {
      const c = this.channels.get(f.ch);
      if (!c) return;
      try {
        writeTranscript(c.sessionId, f.offset ?? mirrorSize(c.sessionId), String(f.delta ?? ""), !!f.reset);
      } catch (e: any) {
        console.warn(`[hosts] ${this.id}: transcript mirror write for ${c.sessionId.slice(0, 8)} failed: ${e?.message ?? e}`);
      }
    }
  }

  /**
   * A channel whose process is gone without an exit frame (its host restarted and does not report
   * it). Ends it through the ordinary exit path so the row closes out like any other terminal.
   */
  lose(c: RemoteChannel): void {
    if (this.channels.get(c.ch) === c) this.channels.delete(c.ch);
    c.end(null, "SIGLOST");
    c.dispose();
  }

  /** Register a channel and hand it whatever arrived for it early. */
  private register(c: RemoteChannel): RemoteChannel {
    this.channels.set(c.ch, c);
    const e = this.early.get(c.ch);
    if (e) {
      this.early.delete(c.ch);
      for (const fr of e.frames) c.feed(fr);
      if (e.exit) queueMicrotask(() => this.control({ t: "exit", ch: c.ch, code: e.exit!.code, signal: e.exit!.signal }));
    }
    return c;
  }

  /**
   * Re-adopt a channel the host reported in `hello.live[]` after the BRAIN restarted (nothing in
   * memory knows it). The caller wires onData/onExit and then calls `attach()` so the resend lands
   * on listeners, not on the floor.
   */
  adopt(l: WireLive, size: { cols?: number; rows?: number; cwd?: string } = {}): RemoteChannel {
    const prev = this.channels.get(l.ch);
    if (prev) return prev;
    return this.register(new RemoteChannel(this, l.ch, l.session_id, l.pid ?? 0, size.cols ?? 100, size.rows ?? 30, size.cwd ?? ""));
  }

  // ───────────── Host ─────────────

  async spawnPty(spec: PtySpawn | SpawnSpec): Promise<PtyHandle> {
    if (!isSpawnSpec(spec)) throw new Error(`host ${this.id} takes a SpawnSpec, not a command line — a remote host resolves its own paths`);
    if (!this.online) throw new Error(`host ${this.hello?.name ?? this.id} is offline`);
    const r = (await this.link.request(this.id, "spawn_pty", spec, SPAWN_TIMEOUT_MS)) as SpawnReply;
    if (!r || typeof r.ch !== "number") throw new Error(`host ${this.id}: malformed spawn reply`);
    return this.register(new RemoteChannel(this, r.ch, spec.session_id, r.pid, r.cols ?? spec.cols, r.rows ?? spec.rows, r.cwd));
  }

  /** A file dropped on one of this host's terminals: the host writes it to its own drop dir. */
  async drop(args: { session_id: string; filename: string; mime?: string; b64: string }): Promise<{ path: string; name: string; size: number; mime: string }> {
    return (await this.link.request(this.id, "drop", args, 60_000)) as { path: string; name: string; size: number; mime: string };
  }

  /** `mc worktree` for a terminal on this host: created under the host's own checkout of the repo. */
  async claimWorktree(args: { session_id: string; git_remote: string; branch: string; base: string }): Promise<{ path: string }> {
    return (await this.link.request(this.id, "worktree", args, 90_000)) as { path: string };
  }

  async spawnProcess(): Promise<ProcHandle> {
    throw new Error("headless runs on hosts land in HOSTS.md phase 5");
  }

  signal(): void {
    // A remote pid means nothing on this Mac; terminals are stopped through their channel (kill).
    throw new Error(`host ${this.id}: signal a remote process through its channel, not by pid`);
  }

  async listLive(): Promise<LiveInfo[]> {
    return this.reportedLive().filter((l) => !l.exit).map((l) => ({ id: l.session_id, kind: l.kind, pid: l.pid ?? undefined, started_at: 0 }));
  }

  /** The last vitals frame, or null when there is none recent enough to judge by (see VITALS_STALE_MS). */
  latestVitals(now = Date.now()): WireVitals | null {
    if (!this.wireVitals || this.vitalsReceivedAt == null) return null;
    return now - this.vitalsReceivedAt > VITALS_STALE_MS ? null : this.wireVitals;
  }

  /** The host's core count from its vitals (protocol 1.2), or null before the first frame / from a 1.1 host. */
  ncpu(): number | null {
    return this.wireVitals?.ncpu ?? null;
  }

  vitals(): HostVitals {
    // A real governor reading (HOSTS.md phase 4): the host's own numbers, through the very admission()
    // the brain applies to itself, with the host's core count. No recent frame = nothing to admit on.
    const v = this.latestVitals();
    const load: MachineLoad = v
      ? loadFromVitals(v)
      : { load1: 0, ncpu: this.ncpu() ?? 1, loadPerCore: 0, swapUsedMb: null, swapTotalMb: null, pressureLevel: null };
    const name = this.hello?.name ?? this.id;
    return {
      load,
      admission: !this.online ? { ok: false, reason: `${name} is offline` } : !v ? { ok: false, reason: `no recent vitals from ${name}` } : admission(load),
      samples: { every_ms: VITALS_EVERY_MS, ram: null, history: this.samples.map((s) => ({ at: s.at, cpu: s.cpu, ram: s.ram, gpu: s.gpu })) },
    };
  }

  /**
   * This host's `mc heavy` permits (HOSTS.md → Heavy slots are per host), kept on the brain and keyed
   * by host id: `ncpu / 6` of THIS machine, read on every grant so the first vitals frame sizes it.
   * Getter, not a field: the pool outlives this object if the host is ever re-registered.
   */
  get slots(): HeavySlotPool {
    return heavyPoolFor(this.id, () => heavySlotsForCpus(this.ncpu()));
  }
}
