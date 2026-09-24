import pty from "node-pty";
import { spawn, type ChildProcess } from "node:child_process";
import { admission, currentLoad, heavyPoolFor, heavySlotCount, vitalsSnapshot } from "../machine.js";
import type { SpawnSpec } from "./spawn-spec.js";
import type { Host, HeavySlotPool, HostVitals, LiveInfo, ProcHandle, ProcSpawn, PtyHandle, PtySpawn } from "./types.js";

// The brain as a host: today's code, behind the Host seam (HOSTS.md phase 1). Every call here is
// the exact call the daemon made before this file existed — node-pty's spawn with the same options,
// child_process.spawn with the same stdio, process.kill, machine.ts's governor. The command line,
// cwd and env arrive fully built (sandbox, `nice` and env are still assembled by the caller), so
// nothing about what runs, or how, changes on a single-machine install.

/**
 * A ChildProcess as a ProcHandle. `close` and `error` are subscribed HERE, synchronously at spawn,
 * and replayed to whoever subscribes later. The caller now awaits `spawnProcess()` before wiring its
 * handlers, and a spawn failure (ENOENT, EACCES) is emitted on the next tick: with nobody listening
 * yet, Node would throw it as an uncaught 'error' and take the whole daemon down with one bad run.
 */
function procHandle(child: ChildProcess): ProcHandle {
  type Close = [code: number | null, signal: NodeJS.Signals | null];
  let closed: Close | null = null;
  const errors: Error[] = [];
  const closeLs: Array<(...a: Close) => void> = [];
  const errorLs: Array<(e: Error) => void> = [];
  child.on("error", (e) => {
    errors.push(e);
    for (const l of errorLs) l(e);
  });
  child.on("close", (code, signal) => {
    closed = [code, signal];
    for (const l of closeLs) l(code, signal);
  });
  return {
    get pid() { return child.pid; },
    // Non-null: stdout/stderr are always "pipe" (see spawnProcess) — only stdin varies.
    stdout: child.stdout!,
    stderr: child.stderr!,
    stdin: child.stdin ?? null,
    kill: (signal) => { child.kill(signal); },
    onClose(l) {
      closeLs.push(l);
      if (closed) l(...closed);
    },
    onError(l) {
      errorLs.push(l);
      for (const e of errors) l(e);
    },
  };
}

class LocalHost implements Host {
  readonly id = "local";
  /** What this daemon spawned and is still running, by session/run id — see listLive. */
  private live = new Map<string, LiveInfo & { handle: object }>();

  private track(info: LiveInfo, handle: object): () => void {
    const entry = { ...info, handle };
    this.live.set(info.id, entry);
    // Only forget the entry that is still ours: promoteToLead reopens the SAME session id, and the
    // new pty must not be dropped by the old one's exit.
    return () => { if (this.live.get(info.id) === entry) this.live.delete(info.id); };
  }

  async spawnPty(spec: PtySpawn | SpawnSpec): Promise<PtyHandle> {
    // The brain builds its own command lines; an intent spec is for a host that resolves its own paths.
    if (spec.kind === "intent") throw new Error("the local host spawns built command lines, not SpawnSpecs");
    const term = pty.spawn(spec.cmd, spec.args, {
      name: "xterm-color",
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env: spec.env,
    });
    const forget = this.track({ id: spec.id, kind: "pty", pid: term.pid, started_at: Date.now() }, term);
    term.onExit(forget);
    // The IPty IS the handle: PtyHandle is its subset, so every write/resize/kill is node-pty's own.
    return term;
  }

  async spawnProcess(spec: ProcSpawn): Promise<ProcHandle> {
    const child = spawn(spec.cmd, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: [spec.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const handle = procHandle(child);
    const forget = this.track({ id: spec.id, kind: "proc", pid: child.pid, started_at: Date.now() }, handle);
    handle.onClose(forget);
    handle.onError(forget);
    return handle;
  }

  signal(pid: number, sig: NodeJS.Signals): void {
    process.kill(pid, sig);
  }

  async listLive(): Promise<LiveInfo[]> {
    return [...this.live.values()].map(({ handle: _h, ...info }) => info);
  }

  vitals(): HostVitals {
    const load = currentLoad();
    return { load, admission: admission(load), samples: vitalsSnapshot() };
  }

  // The brain's own pool — the one machine.ts's acquireSlot/releaseSlot have always served.
  readonly slots: HeavySlotPool = heavyPoolFor("local", heavySlotCount);
}

export const localHost: Host = new LocalHost();
