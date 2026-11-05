/**
 * Services — always-on, non-agent processes the daemon keeps running (SERVICES.md).
 *
 * A Desk terminal is an agent working toward a goal; a job is one run. A service is neither: a plain
 * command (a Slack bot on Socket Mode, a local API, a watcher) that should simply be up. This module
 * is its supervisor:
 *
 *  - The switch is `enabled`. On = start it now and at every boot; off = stop it and leave it off.
 *  - It runs in a pty on this Mac (`localHost.spawnPty`), so its output is a terminal's — colours,
 *    progress bars — and it is a root of the process ledger as owner kind `service`: the leak reaper
 *    and the budget ladder see it, count it against its workspace, and never renice or pause it.
 *  - It exits on its own → the restart policy decides: `always` starts it again, `on-failure` only
 *    after a non-zero exit, `never` leaves it. Restarts back off 1s, 2s, 4s… (max 60s). After
 *    MAX_RESTARTS crashes in a row without staying up STABLE_MS, it is `crashed` and the operator is
 *    told — once: a crash loop is a bug to look at, not something to hammer. It is still tried again
 *    every COOLDOWN_MS while switched on, because on a laptop the cause is often outside it (woke up
 *    with no network, a VPN not up yet) and an always-on bot that stays down until someone notices
 *    is the failure this exists to prevent. A run that stays up STABLE_MS clears the alarm.
 *  - Output goes to a ring the Desk tails (`output()`) and to `service-logs/<id>.log`, rotated.
 *  - `deploy` checks the service's `ref` out (detached) in its cwd and restarts it — refused on a
 *    dirty tree, so a deploy never discards someone's work.
 *
 * Its lifetime is the daemon's: a daemon restart ends the pty, and boot (`startServices`) starts every
 * enabled service again. A previous incarnation still alive at boot (same pid AND start time) is
 * stopped first, so a restart never leaves two copies.
 *
 * Trust: the command runs as the daemon's user, with the workspace's env (child-env.ts) plus its own,
 * outside the agent sandbox — what a launchd agent would get. Only the operator defines, changes or
 * switches one (admin-gated routes, service-routes.ts); a workspace token may only read.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { bus } from "./bus.js";
import { childEnv } from "./child-env.js";
import { localHost } from "./hosts/local.js";
import type { PtyHandle, PtySpawn } from "./hosts/types.js";
import { resolveStateDir } from "./repo-root.js";
import { parseStarts } from "./resources/reaper.js";
import { envOf, services, workspaces, type Service } from "./store.js";

export const RING_CHARS = 256_000;
export const LOG_MAX_BYTES = 5_000_000;
export const LOG_KEEP = 3;
export const STOP_GRACE_MS = 10_000;
export const MAX_RESTARTS = 5;
export const STABLE_MS = 60_000;
export const COOLDOWN_MS = 10 * 60_000;
export const BACKOFF_MAX_MS = 60_000;
const FLUSH_MS = 500;

/** A git ref `deploy` may check out: a branch, tag or sha — never an option, never a range. */
export const REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

export const backoffMs = (restarts: number): number => Math.min(1000 * 2 ** Math.max(0, restarts - 1), BACKOFF_MAX_MS);

export type SupervisorDeps = {
  spawn: (spec: PtySpawn) => Promise<PtyHandle>;
  /** Where log files go. */
  logDir: () => string;
  now: () => number;
  /** Signal a process group (negative pid) or a pid. False when it is gone. */
  signal: (pid: number, sig: NodeJS.Signals) => boolean;
  /** pid → start time (ms) for the pids still alive. */
  starts: (pids: number[]) => Promise<Map<number, number>>;
  git: (cwd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
  publish: (s: Service) => void;
  /** A service gave up (crash loop) — tell the operator. */
  alarm: (s: Service, why: string) => void;
  stopGraceMs: number;
  /** Wait before restart number `n` of a streak. */
  backoff: (n: number) => number;
  maxRestarts: number;
  /** After a crash loop, how long until it is tried again (a fresh streak). */
  cooldownMs: number;
  /** Up at least this long = healthy: the next exit starts a new streak. */
  stableMs: number;
};

type Live = {
  term: PtyHandle;
  pid: number;
  startedAt: number;
  /** Why we are ending it, if we are: an operator stop, a restart, or a deploy's restart. */
  ending: null | "stop" | "restart";
  killTimer: NodeJS.Timeout | null;
  exited: Promise<void>;
};

/** The last RING_CHARS of a service's output, addressed by a running character offset. */
class Ring {
  text = "";
  /** Offset of text[0] since this ring started. */
  base = 0;
  push(s: string): void {
    this.text += s;
    if (this.text.length > RING_CHARS) {
      const cut = this.text.length - RING_CHARS;
      this.text = this.text.slice(cut);
      this.base += cut;
    }
  }
  get end(): number { return this.base + this.text.length; }
  since(from: number): { from: number; to: number; data: string; truncated: boolean } {
    const start = Math.max(from, this.base);
    return { from: start, to: this.end, data: this.text.slice(start - this.base), truncated: from < this.base };
  }
}

/** Buffered, rotated append-only log per service. */
class LogFile {
  private pending = "";
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  constructor(readonly file: string) {}
  write(s: string): void {
    this.pending += s;
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, FLUSH_MS);
  }
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const chunk = this.pending;
    this.pending = "";
    if (!chunk) return this.writing;
    this.writing = this.writing.then(async () => {
      try {
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const size = await fs.promises.stat(this.file).then((s) => s.size, () => 0);
        if (size + chunk.length > LOG_MAX_BYTES && size > 0) await rotate(this.file);
        await fs.promises.appendFile(this.file, chunk, { mode: 0o600 });
      } catch (e) {
        console.warn(`[services] log write failed (${this.file}): ${(e as Error).message}`);
      }
    });
    return this.writing;
  }
  /** Daemon exit: `exit` handlers cannot wait, so what is still buffered goes out synchronously. */
  flushSync(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const chunk = this.pending;
    this.pending = "";
    if (!chunk) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.file, chunk, { mode: 0o600 });
    } catch { /* exiting: nowhere left to report it */ }
  }
  /** The last `chars` of what is on disk — what a restarted daemon shows before new output arrives. */
  tail(chars: number): string {
    try {
      const fd = fs.openSync(this.file, "r");
      try {
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, chars);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        return buf.toString("utf8");
      } finally { fs.closeSync(fd); }
    } catch { return ""; }
  }
}

async function rotate(file: string): Promise<void> {
  for (let i = LOG_KEEP - 1; i >= 1; i--) {
    await fs.promises.rename(`${file}.${i}`, `${file}.${i + 1}`).catch(() => {});
  }
  await fs.promises.rename(file, `${file}.1`).catch(() => {});
  await fs.promises.rm(`${file}.${LOG_KEEP + 1}`, { force: true }).catch(() => {});
}

// Local time, like the timestamps the service itself prints next to it.
const stamp = (ms: number) => {
  const d = new Date(ms), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
/** A line the supervisor itself writes into the service's output, set apart (dim) from the process's own. */
const note = (ms: number, text: string) => `\x1b[2m── ${stamp(ms)} chronos: ${text}\x1b[0m\r\n`;

export class ServiceError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export class Supervisor {
  private live = new Map<string, Live>();
  private backoff = new Map<string, NodeJS.Timeout>();
  /** Services whose crash loop was already raised: a cool-down retry that fails again stays quiet. */
  private alarmed = new Set<string>();
  private rings = new Map<string, Ring>();
  private logs = new Map<string, LogFile>();
  /** Serializes start/stop/restart/deploy per service, so two clicks never spawn two copies. */
  private locks = new Map<string, Promise<unknown>>();

  constructor(readonly deps: SupervisorDeps) {}

  isLive(id: string): boolean { return this.live.has(id); }
  liveIds(): string[] { return [...this.live.keys()]; }
  livePid(id: string): number | null { return this.live.get(id)?.pid ?? null; }

  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(id, next);
    void next.finally(() => { if (this.locks.get(id) === next) this.locks.delete(id); }).catch(() => {});
    return next;
  }

  private ring(id: string): Ring {
    let r = this.rings.get(id);
    if (!r) {
      r = new Ring();
      // A restarted daemon has an empty ring: seed it from the log so the Desk shows what came before.
      const seed = this.log(id).tail(64_000);
      if (seed) r.push(seed);
      this.rings.set(id, r);
    }
    return r;
  }
  private log(id: string): LogFile {
    let l = this.logs.get(id);
    if (!l) { l = new LogFile(path.join(this.deps.logDir(), `${id}.log`)); this.logs.set(id, l); }
    return l;
  }
  private emit(id: string, s: string): void {
    this.ring(id).push(s);
    this.log(id).write(s);
  }
  /** Its own line: after a newline if the process left the cursor mid-line. */
  private say(id: string, text: string): void {
    const t = this.ring(id).text;
    this.emit(id, (t && !t.endsWith("\n") ? "\r\n" : "") + note(this.deps.now(), text));
  }

  private set(id: string, r: Parameters<typeof services.setRuntime>[1]): Service | undefined {
    services.setRuntime(id, r);
    const s = services.get(id);
    if (s) this.deps.publish(s);
    return s;
  }

  /** Output since `from` (a character offset); `from` omitted = the last `tail` characters. */
  output(id: string, from?: number, tail = 64_000): { from: number; to: number; data: string; truncated: boolean } {
    const r = this.ring(id);
    return r.since(from ?? Math.max(r.base, r.end - tail));
  }
  logFile(id: string): string { return this.log(id).file; }

  // ───────────────────────── the switch ─────────────────────────

  /** Switch on and start (no-op if it is already running). */
  start(id: string): Promise<Service> {
    return this.serial(id, async () => {
      need(id);
      this.clearBackoff(id);
      this.alarmed.delete(id);
      services.setRuntime(id, { enabled: 1, restarts: 0, last_error: null, next_start_at: null });
      if (!this.live.has(id)) await this.spawn(need(id), "started");
      return need(id);
    });
  }

  /** Switch off and stop: SIGTERM to its process group, SIGKILL after the grace. */
  stop(id: string): Promise<Service> {
    return this.serial(id, async () => {
      need(id);
      this.clearBackoff(id);
      this.alarmed.delete(id);
      services.setRuntime(id, { enabled: 0, next_start_at: null });
      await this.end(id, "stop");
      return this.set(id, { status: "stopped", pid: null, next_start_at: null })!;
    });
  }

  /** Stop if running, then start (switching it on). */
  restart(id: string, why = "restarted"): Promise<Service> {
    return this.serial(id, async () => {
      need(id);
      this.clearBackoff(id);
      this.alarmed.delete(id);
      services.setRuntime(id, { enabled: 1, restarts: 0, last_error: null, next_start_at: null });
      await this.end(id, "restart");
      await this.spawn(need(id), why);
      return need(id);
    });
  }

  /**
   * Check `ref` out in the service's cwd (fetched from origin, detached) and restart it if it is on.
   * Refused when the tree has uncommitted changes to tracked files: a deploy never discards work.
   */
  deploy(id: string): Promise<{ service: Service; from: string; to: string; restarted: boolean }> {
    return this.serial(id, async () => {
      const s = need(id);
      if (!s.ref) throw new ServiceError(`service '${s.name}' has no ref to deploy — set one (mc service edit ${s.name} --ref <branch>)`);
      if (!REF_RE.test(s.ref)) throw new ServiceError(`ref '${s.ref}' is not a branch, tag or sha`);
      const env = gitEnv(s);
      const git = (args: string[]) => this.deps.git(s.cwd, args, env);
      try { await git(["rev-parse", "--show-toplevel"]); } catch { throw new ServiceError(`${s.cwd} is not a git checkout`); }
      const dirty = (await git(["status", "--porcelain", "--untracked-files=no"])).trim();
      if (dirty) throw new ServiceError(`${s.cwd} has uncommitted changes — commit or discard them first:\n${dirty.split("\n").slice(0, 10).join("\n")}`, 409);
      const from = (await git(["rev-parse", "HEAD"])).trim();
      try {
        await git(["fetch", "--quiet", "origin", s.ref]);
      } catch (e) {
        throw new ServiceError(`git fetch origin ${s.ref} failed: ${(e as Error).message}`, 502);
      }
      await git(["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
      const to = (await git(["rev-parse", "HEAD"])).trim();
      this.say(id, `deployed ${s.ref} ${from.slice(0, 7)} → ${to.slice(0, 7)}`);
      const on = !!need(id).enabled;
      if (on) {
        this.clearBackoff(id);
        this.alarmed.delete(id);
        services.setRuntime(id, { restarts: 0, last_error: null, next_start_at: null });
        await this.end(id, "restart");
        await this.spawn(need(id), `restarted on ${to.slice(0, 7)}`);
      }
      return { service: need(id), from, to, restarted: on };
    });
  }

  /** The row is going away: stop it for good and forget its buffers (the log file stays on disk). */
  async remove(id: string): Promise<void> {
    await this.serial(id, async () => {
      this.clearBackoff(id);
      await this.end(id, "stop");
      await this.log(id).flush();
      this.rings.delete(id);
      this.logs.delete(id);
    });
  }

  // ───────────────────────── boot / shutdown ─────────────────────────

  /**
   * Boot: every row's runtime columns describe a pty that died with the previous daemon. A process
   * that outlived it (same pid, same start time — never a recycled pid) is stopped first; then every
   * enabled service starts, each with a fresh crash streak.
   */
  async boot(): Promise<void> {
    // Only rows this supervisor is not already running: boot describes the previous daemon's leftovers.
    const all = services.list().filter((s) => !this.live.has(s.id));
    const stale = all.filter((s) => s.pid && s.started_at);
    const alive = stale.length ? await this.deps.starts(stale.map((s) => s.pid!)).catch(() => new Map<number, number>()) : new Map<number, number>();
    for (const s of stale) {
      const st = alive.get(s.pid!);
      const was = Date.parse(s.started_at!);
      // ps reports start times to the second; the row's is to the millisecond.
      if (st == null || !Number.isFinite(was) || Math.abs(st - was) > 2000) continue;
      console.log(`[services] ${s.name}: stopping the copy the previous daemon left running (pid ${s.pid})`);
      this.say(s.id, `stopping the copy left from the previous daemon (pid ${s.pid})`);
      this.deps.signal(-s.pid!, "SIGTERM");
      const deadline = this.deps.now() + this.deps.stopGraceMs;
      while (this.deps.now() < deadline) {
        const left = await this.deps.starts([s.pid!]).catch(() => new Map<number, number>());
        if (left.get(s.pid!) !== st) break;
        await sleep(200);
      }
      const left = await this.deps.starts([s.pid!]).catch(() => new Map<number, number>());
      if (left.get(s.pid!) === st) this.deps.signal(-s.pid!, "SIGKILL");
    }
    for (const s of all) {
      if (s.enabled) continue;
      if (s.status === "running" || s.status === "backoff" || s.pid) this.set(s.id, { status: "stopped", pid: null, next_start_at: null });
    }
    for (const s of services.enabled()) {
      services.setRuntime(s.id, { restarts: 0, next_start_at: null, pid: null });
      await this.serial(s.id, () => this.spawn(need(s.id), "started at boot")).catch((e) => {
        console.warn(`[services] ${s.name}: could not start at boot: ${(e as Error).message}`);
      });
    }
  }

  /**
   * A row that vanished under a live process (its workspace was deleted: ON DELETE CASCADE) — stop
   * the process too, or it would run on with nothing left that can switch it off.
   */
  async reconcile(): Promise<number> {
    let n = 0;
    for (const id of [...this.live.keys()]) {
      if (services.get(id)) continue;
      n++;
      await this.remove(id).catch(() => {});
    }
    return n;
  }

  /** Daemon exit: end every service's process group now (synchronously — `exit` handlers cannot wait). */
  shutdownSync(): number {
    let n = 0;
    for (const [id, l] of this.live) {
      l.ending = "stop";
      this.say(id, "daemon stopping — started again at its next boot");
      if (this.deps.signal(-l.pid, "SIGTERM")) n++;
    }
    for (const t of this.backoff.values()) clearTimeout(t);
    this.backoff.clear();
    for (const l of this.logs.values()) l.flushSync();
    return n;
  }

  /** Flush every log (tests, and a clean shutdown when there is time for it). */
  async flushLogs(): Promise<void> {
    await Promise.all([...this.logs.values()].map((l) => l.flush()));
  }

  // ───────────────────────── internals ─────────────────────────

  private clearBackoff(id: string): void {
    const t = this.backoff.get(id);
    if (t) { clearTimeout(t); this.backoff.delete(id); }
  }

  /** End the live process (if any) for `why`, and wait for it to exit. */
  private async end(id: string, why: "stop" | "restart"): Promise<void> {
    const l = this.live.get(id);
    if (!l) return;
    l.ending = why;
    this.say(id, why === "stop" ? "stopping" : "restarting");
    if (!this.deps.signal(-l.pid, "SIGTERM")) this.deps.signal(l.pid, "SIGTERM");
    l.killTimer = setTimeout(() => {
      if (this.live.get(id) !== l) return;
      this.say(id, `still running ${Math.round(this.deps.stopGraceMs / 1000)}s after SIGTERM — SIGKILL`);
      if (!this.deps.signal(-l.pid, "SIGKILL")) this.deps.signal(l.pid, "SIGKILL");
    }, this.deps.stopGraceMs);
    // A process stuck in the kernel can outlive even SIGKILL for a while: never let that hold the
    // service's lock (and with it every later start/stop) forever.
    let cap: NodeJS.Timeout | null = null;
    const gaveUp = await Promise.race([
      l.exited.then(() => false),
      new Promise<boolean>((r) => { cap = setTimeout(() => r(true), this.deps.stopGraceMs + 5000); }),
    ]);
    if (cap) clearTimeout(cap);
    if (gaveUp && this.live.get(id) === l) {
      clearTimeout(l.killTimer);
      this.live.delete(id);
      this.say(id, `pid ${l.pid} did not exit after SIGKILL — no longer tracked`);
    }
  }

  private async spawn(s: Service, why: string): Promise<void> {
    if (this.live.has(s.id)) return;
    if (!isDir(s.cwd)) {
      this.say(s.id, `cannot start: ${s.cwd} is not a directory`);
      this.set(s.id, { status: "crashed", pid: null, last_error: `cwd not found: ${s.cwd}`, next_start_at: null });
      return;
    }
    const ws = workspaces.get(s.workspace_id);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({
      ...childEnv(ws),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      ...envOf(s),
      MC_SERVICE: s.name,
    })) if (typeof v === "string") env[k] = v;
    let term: PtyHandle;
    try {
      term = await this.deps.spawn({ id: s.id, cmd: "/bin/bash", args: ["-c", s.command], cwd: s.cwd, env, cols: 160, rows: 48 });
    } catch (e) {
      const msg = (e as Error).message;
      this.say(s.id, `cannot start: ${msg}`);
      this.set(s.id, { status: "crashed", pid: null, last_error: `spawn failed: ${msg}`, next_start_at: null });
      return;
    }
    const startedAt = this.deps.now();
    let resolveExit!: () => void;
    const l: Live = { term, pid: term.pid, startedAt, ending: null, killTimer: null, exited: new Promise((r) => { resolveExit = r; }) };
    this.live.set(s.id, l);
    this.say(s.id, `${why} — pid ${term.pid}`);
    term.onData((d) => this.emit(s.id, d));
    term.onExit(({ exitCode, signal }) => {
      if (l.killTimer) clearTimeout(l.killTimer);
      if (this.live.get(s.id) === l) this.live.delete(s.id);
      try { this.exited(s.id, l, exitCode, signal ?? null); } finally { resolveExit(); }
    });
    this.set(s.id, { status: "running", pid: term.pid, started_at: new Date(startedAt).toISOString(), next_start_at: null });
  }

  private exited(id: string, l: Live, code: number, signal: number | null): void {
    const t = this.deps.now();
    const upMs = t - l.startedAt;
    const sig = signal ? signalName(signal) : null;
    const how = sig ? `killed by ${sig}` : `exit ${code}`;
    this.say(id, `${how} after ${dur(upMs)}`);
    const exit = { pid: null, last_exit_code: sig ? null : code, last_exit_signal: sig, last_exit_at: new Date(t).toISOString() };
    const s = services.get(id);
    if (!s) return; // deleted while it ran
    if (l.ending) {
      // Ours: a stop or a restart is already handling what comes next.
      services.setRuntime(id, exit);
      return;
    }
    const failed = !!sig || code !== 0;
    const again = s.enabled && (s.restart === "always" || (s.restart === "on-failure" && failed));
    if (!again) {
      this.set(id, { ...exit, status: failed ? "crashed" : "exited", next_start_at: null, last_error: failed ? `${how} after ${dur(upMs)}` : null });
      if (failed && s.enabled) this.deps.alarm(services.get(id)!, `${how} — restart policy '${s.restart}' leaves it down`);
      return;
    }
    // It stayed up long enough to count as healthy: this exit starts a new streak.
    const { maxRestarts, stableMs, cooldownMs } = this.deps;
    if (upMs >= stableMs) this.alarmed.delete(id);
    const streak = (upMs >= stableMs ? 0 : s.restarts) + 1;
    if (streak > maxRestarts) {
      const why = `crash loop: ${maxRestarts} restarts in a row, each up less than ${dur(stableMs)} (last: ${how})`;
      this.say(id, `${why} — trying again in ${dur(cooldownMs)}; restart it any time once it is fixed`);
      this.set(id, { ...exit, status: "crashed", restarts: streak - 1, next_start_at: new Date(t + cooldownMs).toISOString(), last_error: why });
      if (!this.alarmed.has(id)) { this.alarmed.add(id); this.deps.alarm(services.get(id)!, why); }
      this.later(id, cooldownMs, async (cur) => {
        services.setRuntime(id, { restarts: 0 });
        await this.spawn(need(cur.id), "trying again after a crash loop");
      });
      return;
    }
    const wait = this.deps.backoff(streak);
    this.say(id, `starting again in ${dur(wait)} (restart ${streak} of ${maxRestarts})`);
    this.set(id, { ...exit, status: "backoff", restarts: streak, next_start_at: new Date(t + wait).toISOString(), last_error: failed ? `${how} after ${dur(upMs)}` : null });
    this.later(id, wait, (cur) => this.spawn(cur, `restart ${streak}`));
  }

  /** Start it again after `ms`, unless it was switched off, started by hand or deleted meanwhile. */
  private later(id: string, ms: number, go: (cur: Service) => Promise<void>): void {
    this.clearBackoff(id);
    const timer = setTimeout(() => {
      this.backoff.delete(id);
      void this.serial(id, async () => {
        const cur = services.get(id);
        if (!cur?.enabled || this.live.has(id)) return;
        await go(cur);
      });
    }, ms);
    timer.unref?.();
    this.backoff.set(id, timer);
  }
}

function need(id: string): Service {
  const s = services.get(id);
  if (!s) throw new ServiceError("service not found", 404);
  return s;
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** git for `deploy` runs with the workspace's env (its GH_CONFIG_DIR / credentials), not the daemon's. */
function gitEnv(s: Service): NodeJS.ProcessEnv {
  return { ...childEnv(workspaces.get(s.workspace_id)), GIT_TERMINAL_PROMPT: "0" };
}

const SIGNALS: Record<number, string> = { 1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 6: "SIGABRT", 9: "SIGKILL", 11: "SIGSEGV", 13: "SIGPIPE", 15: "SIGTERM" };
const signalName = (n: number) => SIGNALS[n] ?? `signal ${n}`;

export function dur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── the daemon's supervisor ─────────────────────────

export const serviceLogDir = (): string => resolveStateDir("service-logs", "CHRONOS_SERVICE_LOGS");

export function systemSupervisorDeps(): SupervisorDeps {
  return {
    spawn: (spec) => localHost.spawnPty(spec),
    logDir: serviceLogDir,
    now: Date.now,
    signal: (pid, sig) => {
      if (Math.abs(pid) <= 1 || Math.abs(pid) === process.pid) return false;
      try { process.kill(pid, sig); return true; } catch { return false; }
    },
    // One `ps` per pid: a single pid ps rejects ("process id too large") makes it print nothing for
    // the others, and one bad row must not hide a real leftover. Boot-time only, a handful of rows.
    starts: async (pids) => {
      const list = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 1))];
      const one = (pid: number) => new Promise<Map<number, number>>((resolve) =>
        execFile("ps", ["-o", "pid=,lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C" } }, (_e, out) => resolve(parseStarts(String(out ?? "")))));
      const out = new Map<number, number>();
      for (const m of await Promise.all(list.map(one))) for (const [k, v] of m) out.set(k, v);
      return out;
    },
    git: (cwd, args, env) => new Promise((resolve, reject) => {
      execFile("git", args, { cwd, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (e, out, err) => {
        if (e) reject(new Error(String(err || e.message).trim().slice(0, 2000)));
        else resolve(String(out));
      });
    }),
    publish: (s) => bus.publish({ topic: "service.changed", service_id: s.id, workspace_id: s.workspace_id, name: s.name, status: s.status }),
    alarm: (s, why) => {
      console.warn(`[services] ${s.name}: ${why}`);
      bus.publish({ topic: "service.alarm", service_id: s.id, workspace_id: s.workspace_id, name: s.name, status: s.status, reason: why });
    },
    stopGraceMs: STOP_GRACE_MS,
    backoff: backoffMs,
    maxRestarts: MAX_RESTARTS,
    stableMs: STABLE_MS,
    cooldownMs: COOLDOWN_MS,
  };
}

let supervisor: Supervisor | null = null;

/** The daemon's one supervisor (created on first use, so routes work before boot finishes). */
export function serviceSupervisor(): Supervisor {
  if (!supervisor) supervisor = new Supervisor(systemSupervisorDeps());
  return supervisor;
}

/** Tests: swap the supervisor (null = back to the system one on next use). */
export function setServiceSupervisorForTest(s: Supervisor | null): void { supervisor = s; }

/** Boot hook (index.ts): reconcile rows left by the previous daemon and start every enabled service. */
export function startServices(): void {
  const sup = serviceSupervisor();
  bus.on("event", (e: { topic?: string }) => {
    if (e.topic !== "workspace.changed") return;
    void sup.reconcile().then((n) => { if (n) console.log(`[services] stopped ${n} service(s) whose workspace was deleted`); });
  });
  process.on("exit", () => {
    const n = sup.shutdownSync();
    if (n) console.log(`[services] exit: SIGTERM ${n} service(s)`);
  });
  void sup.boot().then(
    () => {
      const on = services.enabled().length;
      console.log(`[services] ${on ? `${on} enabled service(s) started` : "no enabled services"}`);
    },
    (e) => console.warn(`[services] boot failed: ${(e as Error).message}`),
  );
}

