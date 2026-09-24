import type { Readable, Writable } from "node:stream";
import type { SpawnSpec } from "./spawn-spec.js";
import type { ProcSpec } from "./proc-spec.js";
import type { Admission, MachineLoad, SlotGrant, SlotHolder, vitalsSnapshot } from "../machine.js";

// The seam between the brain and the computers its agents run on (HOSTS.md, "The seam: Host").
//
// Phase 1 puts every process spawn, signal and machine reading behind this interface with exactly
// one implementation, LocalHost, which is today's code moved behind a name. Nothing about what runs
// where changes. What it buys is that phase 3's RemoteHost has one place to plug in, instead of the
// ~20 modules that reach into a live terminal today each learning about a network link.

/** Something a spawn wants to know when it ended. Returned by the `on*` subscribers. */
export interface Disposable {
  dispose(): void;
}

/**
 * A live pseudo-terminal, wherever it runs. Deliberately the subset of node-pty's `IPty` the daemon
 * actually uses, with the same names and semantics, so LocalHost can hand the `IPty` over as-is and
 * a remote handle only has to be a proxy that speaks frames.
 */
export interface PtyHandle {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  /**
   * Where the process runs, as a path on ITS host. Only a remote handle sets it: the host resolved
   * the checkout / worktree itself (SpawnSpec carries intent, not paths), and the brain records what
   * the host chose on the session row. Undefined on `local`, where the caller chose the cwd.
   */
  readonly cwd?: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): Disposable;
}

/**
 * A headless run's process: stdout lines in, stdin steers out, one exit. Streams rather than a line
 * callback because runner.ts reads stdout through readline and stderr as a rolling tail, and those
 * two consumers should not change to move behind a seam.
 */
export interface ProcHandle {
  readonly pid: number | undefined;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Null unless the spawn asked for a stdin pipe (steer mode). */
  readonly stdin: Writable | null;
  kill(signal?: NodeJS.Signals): void;
  /** The process is gone AND its stdio has drained (Node's `close`, not `exit`). */
  onClose(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  /** The process could not be spawned, or could not be signalled. */
  onError(listener: (err: Error) => void): void;
  // Phase 5 — set only by a remote handle (hosts/remote.ts RemoteProc):
  /** Where the run runs, as a path on ITS host (the host resolved it from the ProcSpec). */
  readonly cwd?: string;
  /** The HOST's watchdog ended it: past its timeout with no word from the brain. */
  readonly timedOut?: boolean;
  /** Set when the process vanished with its host (a host restart) — why, naming the host. */
  readonly lost?: string | null;
}

/**
 * What a spawn is on `local`: a fully built command line. The brain resolves cwd, env, sandbox and
 * `nice` itself, exactly as before hosts existed. A remote host takes a `SpawnSpec` instead
 * (src/hosts/spawn-spec.ts): intent, never an absolute path the brain made up.
 */
export interface PtySpawn {
  kind?: "argv";
  /** The session id this pty belongs to — what `listLive()` reports it under. */
  id: string;
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface ProcSpawn {
  /** The run id this process belongs to. */
  id: string;
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Pipe stdin (steer mode) instead of closing it. */
  stdin: boolean;
}

/** One process a host is running for the brain — what a restarted brain re-attaches to. */
export interface LiveInfo {
  id: string;
  kind: "pty" | "proc";
  pid: number | undefined;
  started_at: number;
}

/** What `GET /machine` and admission read about one host. */
export interface HostVitals {
  load: MachineLoad;
  /** Would an AGENT be allowed to open one more process here right now? */
  admission: Admission;
  samples: ReturnType<typeof vitalsSnapshot>;
}

/** The per-host `mc heavy` permits (HOSTS.md: two suites on two machines don't wait for each other). */
export interface HeavySlotPool {
  size(): number;
  acquire(opts: { session_id?: string | null; label: string; ticket?: string | null }, waitMs: number): Promise<SlotGrant>;
  abandon(ticket: string): void;
  beat(slotId: string): boolean;
  release(slotId: string): boolean;
  holders(): SlotHolder[];
  waiting(): number;
}

export interface Host {
  /** "local" | the stable id minted at join. */
  readonly id: string;

  // ── processes ──
  /** `local` takes a built command line (PtySpawn); a remote host takes intent (SpawnSpec). */
  spawnPty(spec: PtySpawn | SpawnSpec): Promise<PtyHandle>;
  /** `local` takes a built command line (ProcSpawn); a remote host takes intent (ProcSpec, phase 5). */
  spawnProcess(spec: ProcSpawn | ProcSpec): Promise<ProcHandle>;
  /**
   * Signal a process this host is running, by pid, synchronously. Throws when there is no such
   * process, like `process.kill` — callers (stopRun, continueFromRun) decide what that means.
   * Not in HOSTS.md's sketch: a run's pid is persisted, and a stop that arrives from the API holds
   * a row, not a handle.
   */
  signal(pid: number, sig: NodeJS.Signals): void;
  listLive(): Promise<LiveInfo[]>;

  // ── observation ──
  vitals(): HostVitals;
  readonly slots: HeavySlotPool;

  // Phase 3 does checkout/worktree/prepare/transcript INSIDE a remote spawn (the host resolves them
  // from the SpawnSpec) rather than as separate verbs. Phase 5 adds the ship pipeline's verbs —
  // exec / oneshot / worktreeEnsure — on RemoteHost only: on the brain they are the execFile calls
  // gates/reviews/verifier always made, and hosts/workdir.ts picks one or the other by host id.
}
