/**
 * The host's headless runs and ship-pipeline commands (HOSTS.md phase 5): the other half of
 * `RemoteHost.spawnProcess` / `exec` / `oneshot` / `worktree_ensure`.
 *
 * A `spawn_proc` frame carries a ProcSpec — intent, not paths — resolved HERE exactly the way a
 * terminal is (resolve.ts): the veto first, then the checkout by git remote, the worktree the brain
 * named by a path THIS host reported, the profile by name, a Seatbelt profile from this host's home,
 * the workspace's egress proxy on this host. The CLI's argv is built here too, by this host's own
 * backend registry, from a pseudo-job whose prose had its brain paths swapped for tokens.
 *
 * A run outlives the link. Its stdout is kept as WHOLE LINES (the brain parses it line by line into
 * run events) in a ring with a seq; while the link is down nothing is sent and nothing blocks, and on
 * re-attach the brain names the last seq it has and only what follows is resent. The run's timeout is
 * enforced HERE as well, so a brain that went away cannot leave a runaway agent behind — the brain's
 * own watchdog normally fires first, this one (the timeout plus a grace) is the backstop.
 *
 * `exec` runs one command in a directory this host reported (a checkout or a worktree under one), with
 * this host's timeout and output caps: the gates, git and gh of the ship pipeline.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  EXEC_MAX_BYTES, PROC_RING_BYTES, Ring, chunk,
  type CheckoutInfo, type ExecResult, type ExecSpec, type LiveInfo,
} from "../hostlink/wire.js";
import { expandHomeRelative } from "../hosts/spawn-spec.js";
import {
  expandPathTokens, isProcSpec,
  type OneshotResult, type OneshotSpec, type ProcSpec, type WorktreeEnsureArgs,
} from "../hosts/proc-spec.js";
import { ensureBranchWorktree, worktreeRootFor, worktreeSandboxDirs } from "../worktree-core.js";
import { installMcCli, installMcSkill, syncAgentsMd } from "../agent-prep.js";
import { ensureTrustedCwd } from "../claude-trust.js";
import { sandboxAvailable, sandboxWrap, workspaceSandboxAllow } from "../sandbox.js";
import { niceWrap } from "../machine.js";
import { withRuntimePath } from "../gates.js";
import type { AgentBackend } from "../backends/types.js";
import type { Job } from "../types.js";
import { hostBaseEnv, insideCheckouts, isDir, resolveRepos, safeRef, type CloneOpts } from "./resolve.js";
import { egressForSpawn, type HostEgress } from "./egress.js";
import { VetoError, type TerminalsLink } from "./terminals.js";
import type { WorkSource } from "./status.js";

/** A CLI a host runs headless, by the canonical backend name the spec carries. */
export type ProcBackend = Pick<AgentBackend, "name" | "bin" | "buildArgs" | "env"> & Partial<Pick<AgentBackend, "steerArgs" | "oneShot">>;

export type HostProcsOptions = CloneOpts & {
  /** This host's home. Tests point it at a temp dir. */
  home?: string;
  /** Where `skills/` and `scripts/mc` live — this checkout. */
  root: string;
  profiles: () => Record<string, string>;
  checkouts: () => Promise<CheckoutInfo[]>;
  backends: Record<string, ProcBackend>;
  /** The loopback `mc` forwarder's port — read per spawn: it may have fallen back off 7777. */
  mcPort: () => number;
  /** Lock #2, shared with the terminals (it carries the brain's policy frame too). */
  veto: (ws: { id: string; slug: string } | null) => string | null;
  /** One channel-number space with the terminals: the link multiplexes both. */
  allocCh: () => number;
  egress?: HostEgress;
  /** Prepare the profile (skill, mc, trust, AGENTS.md). Off in tests that must not write. */
  prepare?: boolean;
  /** Past the run's own timeout, how long the host waits before it kills the run itself. */
  graceMs?: number;
  /** SIGTERM → SIGKILL. */
  killGraceMs?: number;
  ringBytes?: number;
};

type ProcChan = {
  ch: number;
  runId: string;
  child: ChildProcess;
  ring: Ring;
  /** Live frames go out only while true: after a reconnect, not until the brain re-attaches. */
  streaming: boolean;
  exit: { code: number | null; signal: string | null; timed_out: boolean } | null;
  exitSent: boolean;
  /** Stdout after the last newline — held until the line is whole. */
  partial: Buffer;
  stderrTail: string;
  timedOut: boolean;
  watchdog: NodeJS.Timeout | null;
  forgetT?: NodeJS.Timeout;
  backend: string;
  cwd: string;
  startedAt: number;
  /** Last stdout or stderr byte: the menu bar's "working" (status.ts ACTIVE_MS). */
  lastOut: number;
};

/** An exited run the brain never releases (it is gone for good) is forgotten after this. */
const EXITED_KEEP_MS = 30 * 60_000;
const STDERR_KEEP = 8000;
/** A single "line" this long with no newline is flushed anyway: memory over purity. */
const MAX_PARTIAL = 8 * 1024 * 1024;
const ONESHOT_CAP = 2 * 1024 * 1024;
const EXEC_DEFAULT_BYTES = 1024 * 1024;
const EXEC_MAX_TIMEOUT_MS = 2 * 3600_000;

/** A relative path under `.mc/` — the only place a delivered brain file may land in a checkout. */
function safeRel(rel: unknown): rel is string {
  if (typeof rel !== "string" || !rel || path.isAbsolute(rel)) return false;
  const norm = path.normalize(rel);
  return norm.startsWith(`.mc${path.sep}`) && !norm.split(path.sep).includes("..");
}

export class HostProcs {
  private chans = new Map<number, ProcChan>();
  private link: TerminalsLink | null = null;
  readonly home: string;

  constructor(private readonly o: HostProcsOptions) {
    this.home = o.home ?? os.homedir();
  }

  /**
   * The checkouts `exec` is held to. A scan runs `git remote get-url` per clone, and the ship pipeline
   * makes a dozen exec calls per review — so it is kept for a minute, and rescanned once on a miss (a
   * repo cloned since) before a directory is called foreign.
   */
  private scanned: { at: number; list: CheckoutInfo[] } | null = null;
  private async isOwnDir(dir: string): Promise<boolean> {
    if (this.scanned && Date.now() - this.scanned.at < 60_000 && insideCheckouts(dir, this.scanned.list)) return true;
    this.scanned = { at: Date.now(), list: await this.o.checkouts() };
    return insideCheckouts(dir, this.scanned.list);
  }

  attachLink(link: TerminalsLink): void { this.link = link; }

  owns(ch: number): boolean { return this.chans.has(ch); }

  /** hello.live[]: every run the brain should know about (kind "proc", session_id = the run id). */
  live(): LiveInfo[] {
    return [...this.chans.values()].map((c) => ({
      ch: c.ch, session_id: c.runId, kind: "proc" as const, pid: c.child.pid ?? null, last_seq: c.ring.lastSeq, exit: c.exit,
    }));
  }

  /** What the menu bar lists (status.ts): every run still running. Internal shape; never the workspace. */
  work(): WorkSource[] {
    return [...this.chans.values()].filter((c) => !c.exit).map((c) => ({
      kind: "run" as const, id: c.runId, cwd: c.cwd, backend: c.backend, startedAt: c.startedAt, lastOut: c.lastOut,
    }));
  }

  /** The link dropped: stop streaming. Runs keep running; their stdout keeps landing in the ring. */
  linkDown(): void {
    for (const c of this.chans.values()) { c.streaming = false; if (c.exit) c.exitSent = false; }
  }

  // ───────────── spawn_proc ─────────────

  async spawn(raw: unknown): Promise<{ ch: number; pid: number; cwd: string }> {
    if (!isProcSpec(raw)) throw new Error("spawn_proc needs a ProcSpec");
    const spec = raw;
    // Lock #2 (HOSTS.md → Security): the local veto, before anything is resolved, prepared or forked.
    const veto = this.o.veto(spec.workspace);
    if (veto) throw new VetoError(veto);
    for (const c of this.chans.values()) {
      if (c.runId === spec.run_id && !c.exit) throw new Error(`run ${spec.run_id.slice(0, 8)} is already running here`);
    }
    const backend = this.o.backends[spec.backend];
    if (!backend) throw new Error(`backend ${spec.backend} is not available on this host`);
    if (spec.steer && !backend.steerArgs) throw new Error(`backend ${spec.backend} has no steer mode`);
    const profileDir = this.o.profiles()[spec.profile];
    if (!profileDir) throw new Error(`profile ${spec.profile} is not on this host — log it in here first (CLAUDE_CONFIG_DIR=~/.${spec.profile} claude)`);
    if (spec.sandbox.mode !== "off" && !sandboxAvailable()) throw new Error(`sandbox ${spec.sandbox.mode} requested but this host has no sandbox-exec`);
    const egress = await egressForSpawn(this.o.egress, spec.workspace, spec.egress ?? null, spec.sandbox.egress_locked);

    const r = await resolveRepos(this.o, spec.repo, spec.repos);
    let cwd: string;
    if (spec.cwd) {
      // A directory this host reported (worktree_ensure). Same wording as the brain's own check
      // (runner.ts): a pruned worktree is the usual cause, and ENOENT naming the binary misleads.
      if (!isDir(spec.cwd)) throw new Error(`working directory gone: ${spec.cwd} (worktree pruned?) — re-dispatch the ticket to rebuild it`);
      if (!insideCheckouts(spec.cwd, r.checkouts)) throw new Error(`${spec.cwd} is not a checkout or a worktree on this host`);
      cwd = spec.cwd;
    } else cwd = r.repoPath ?? r.wsRepoPaths[0] ?? this.home;

    // Brain-only files the run reads (the ticket markdown): into this checkout's gitignored `.mc/`.
    for (const f of spec.files ?? []) {
      const base = r.byId.get(f.repo_id);
      if (!base || !safeRel(f.rel)) continue;
      const dest = path.join(base, f.rel);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        fs.writeFileSync(dest, String(f.content ?? ""), { mode: 0o600 });
      } catch (e: any) {
        console.warn(`[host] run ${spec.run_id.slice(0, 8)}: could not deliver ${f.rel}: ${e?.message ?? e}`);
      }
    }

    // The sandbox a local build gets (runner.ts): in a worktree, the main checkout is read-only and its
    // .git/.mc are re-granted; every other workspace repo is an add-dir; other checkouts are denied.
    const wt = worktreeSandboxDirs(r.repoPath, cwd);
    const addDirs = [...new Set([...r.wsRepoPaths.filter((p) => p !== cwd && !wt.readonly.includes(p)), ...wt.grant])].filter((d) => isDir(d));
    const expand = (t: string | null) => expandPathTokens(t, r.byId, worktreeRootFor);
    const job = {
      ...spec.job,
      goal: expand(spec.job.goal) ?? "",
      append_system: expand(spec.job.append_system),
      add_dirs: addDirs.length ? JSON.stringify(addDirs) : null,
      cwd,
      workspace_id: spec.workspace?.id ?? null,
    } as unknown as Job;
    const context = expand(spec.context);
    const args = spec.steer ? backend.steerArgs!(job, spec.session_id, spec.resume) : backend.buildArgs(job, spec.session_id, context, spec.resume);

    if (this.o.prepare !== false) {
      installMcSkill(profileDir, this.o.root);
      installMcCli(this.o.root, this.home);
      if (backend.name === "claude-code" && ensureTrustedCwd(profileDir, cwd) === "added") console.log(`[host] pre-trusted ${cwd} in ${path.basename(profileDir)}`);
      try { await syncAgentsMd(cwd, this.o.root, this.home); } catch {}
    }

    const allowSecrets = workspaceSandboxAllow(JSON.stringify(spec.sandbox.allow ?? []));
    const wrapped = sandboxWrap(spec.sandbox.mode, cwd, addDirs, profileDir, r.denyDirs, backend.bin(), args, egress.locked, wt.readonly, allowSecrets);
    const { cmd, cmdArgs } = niceWrap(wrapped.cmd, wrapped.cmdArgs, spec.nice);
    const base = hostBaseEnv(this.home);
    const env: Record<string, string> = {
      ...base,
      ...expandHomeRelative(spec.env, spec.env_home_relative, this.home),
      ...backend.env(job, profileDir),
      ...egress.env,
      MC_API: `http://localhost:${this.o.mcPort()}/api`,
      PATH: `${this.home}/.mc/bin:${base.PATH ?? ""}`,
      MC_RUN: spec.run_id,
    };

    const child = spawn(cmd, cmdArgs, { cwd, env, stdio: [spec.steer ? "pipe" : "ignore", "pipe", "pipe"] });
    // Node reports a spawn failure (ENOENT, EACCES) on the next tick as 'error': wait for one or the
    // other, so the brain gets the reason as the spawn's answer instead of a run that never speaks.
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    child.on("error", (e) => console.warn(`[host] run ${spec.run_id.slice(0, 8)}: ${e?.message ?? e}`));
    // An EPIPE on a steer write (the child died mid-message) must not take the host process down.
    child.stdin?.on("error", (e: any) => console.warn(`[host] run ${spec.run_id.slice(0, 8)}: stdin ${e?.code ?? e?.message ?? e}`));

    const ch = this.o.allocCh();
    const c: ProcChan = {
      ch, runId: spec.run_id, child, ring: new Ring(this.o.ringBytes ?? PROC_RING_BYTES, ch),
      streaming: !!this.link?.online(), exit: null, exitSent: false, partial: Buffer.alloc(0),
      stderrTail: "", timedOut: false, watchdog: null,
      backend: backend.name, cwd, startedAt: Date.now(), lastOut: Date.now(),
    };
    this.chans.set(ch, c);
    child.stdout!.on("data", (b: Buffer) => this.onStdout(c, b));
    child.stderr!.on("data", (b: Buffer) => this.onStderr(c, b.toString("utf8")));
    child.on("close", (code, signal) => this.onClose(c, code, signal));
    const limit = Math.max(1000, Number(spec.timeout_ms) || 0) + (this.o.graceMs ?? 15_000);
    c.watchdog = setTimeout(() => this.timeout(c), limit);
    c.watchdog.unref?.();
    return { ch, pid: child.pid ?? 0, cwd };
  }

  private emit(c: ProcChan, buf: Buffer): void {
    for (const part of chunk(buf)) {
      const f = c.ring.append(part);
      if (c.streaming) this.link?.sendData(c.ch, f.seq, f.bytes);
    }
  }

  private onStdout(c: ProcChan, b: Buffer): void {
    c.lastOut = Date.now();
    const all = c.partial.length ? Buffer.concat([c.partial, b]) : b;
    const nl = all.lastIndexOf(0x0a);
    if (nl < 0) {
      c.partial = all.length > MAX_PARTIAL ? (this.emit(c, all), Buffer.alloc(0)) : Buffer.from(all);
      return;
    }
    c.partial = Buffer.from(all.subarray(nl + 1));
    this.emit(c, all.subarray(0, nl + 1));
  }

  private onStderr(c: ProcChan, text: string): void {
    c.lastOut = Date.now();
    c.stderrTail = (c.stderrTail + text).slice(-STDERR_KEEP);
    if (c.streaming) this.link?.send({ t: "stderr", ch: c.ch, text });
  }

  private timeout(c: ProcChan): void {
    if (c.exit) return;
    c.timedOut = true;
    console.warn(`[host] run ${c.runId.slice(0, 8)} passed its timeout with no word from the brain — stopping it here`);
    // Same order as the brain's watchdog: EOF first (a steer-mode CLI ends on it), then the signal.
    try { c.child.stdin?.end(); } catch {}
    try { c.child.kill("SIGTERM"); } catch {}
    setTimeout(() => { if (!c.exit) { try { c.child.kill("SIGKILL"); } catch {} } }, this.o.killGraceMs ?? 10_000).unref?.();
  }

  private onClose(c: ProcChan, code: number | null, signal: NodeJS.Signals | null): void {
    if (c.watchdog) clearTimeout(c.watchdog);
    if (c.partial.length) { this.emit(c, c.partial); c.partial = Buffer.alloc(0); }
    c.exit = { code, signal: signal ?? null, timed_out: c.timedOut };
    this.sendExit(c);
    c.forgetT = setTimeout(() => this.chans.delete(c.ch), EXITED_KEEP_MS);
    c.forgetT.unref?.();
  }

  private sendExit(c: ProcChan): void {
    if (!c.exit || !c.streaming || c.exitSent) return;
    if (this.link?.send({ t: "exit", ch: c.ch, code: c.exit.code, signal: c.exit.signal, ...(c.exit.timed_out ? { timed_out: true } : {}) })) c.exitSent = true;
  }

  // ───────────── frames from the brain ─────────────

  stdin(ch: number, bytes: string | undefined, end: boolean | undefined): void {
    const c = this.chans.get(ch);
    if (!c || c.exit || !c.child.stdin) return;
    try {
      if (bytes) c.child.stdin.write(String(bytes));
      if (end) c.child.stdin.end();
    } catch {}
  }

  kill(ch: number, signal?: string): void {
    const c = this.chans.get(ch);
    if (!c || c.exit) return;
    try { c.child.kill((signal || "SIGTERM") as NodeJS.Signals); } catch {}
  }

  ack(ch: number, seq: number): void {
    this.chans.get(ch)?.ring.ack(seq);
  }

  /**
   * The brain (re)adopts a run: resend the stdout it lacks (after `seq`), then the stderr tail once, then
   * the exit if it already happened — and stream from here.
   */
  attach(ch: number, seq: number, runId?: string): void {
    const c = this.chans.get(ch);
    if (!c || (runId && c.runId !== runId)) {
      this.link?.send({ t: "exit", ch, code: null, signal: "SIGLOST" });
      return;
    }
    c.ring.ack(seq);
    for (const f of c.ring.since(seq).frames) this.link?.sendData(ch, f.seq, f.bytes);
    c.streaming = true;
    if (c.stderrTail) this.link?.send({ t: "stderr", ch, text: c.stderrTail, replay: true });
    if (c.exit) this.sendExit(c);
  }

  release(ch: number): void {
    const c = this.chans.get(ch);
    if (!c || !c.exit) return;
    if (c.forgetT) clearTimeout(c.forgetT);
    this.chans.delete(ch);
  }

  killAll(): void {
    for (const c of this.chans.values()) if (!c.exit) { try { c.child.kill("SIGTERM"); } catch {} }
  }

  // ───────────── exec: the ship pipeline's commands ─────────────

  async exec(raw: unknown): Promise<ExecResult> {
    const spec = raw as ExecSpec;
    const none = (error: string): ExecResult => ({ code: null, signal: null, stdout: "", stderr: "", timed_out: false, truncated: false, error });
    if (!spec || typeof spec.cwd !== "string" || !path.isAbsolute(spec.cwd)) return none("spawn: exec needs an absolute cwd on this host");
    const veto = this.o.veto(spec.workspace ?? null);
    if (veto) return none(veto);
    if (!isDir(spec.cwd)) return none(`cwd_missing: ${spec.cwd}`);
    // Held to what this host reported: its checkouts and their worktrees, never an arbitrary folder.
    if (!(await this.isOwnDir(spec.cwd))) return none(`outside: ${spec.cwd} is not a checkout or a worktree on this host`);
    const env: Record<string, string> = { ...hostBaseEnv(this.home), ...expandHomeRelative(spec.env ?? {}, spec.env_home_relative ?? [], this.home) };
    let cmd: string, args: string[];
    if (typeof spec.shell === "string") {
      // Through a login shell (so profile-only toolchains resolve) with THIS host's runtime PATH put
      // back in front — the reason gates.ts withRuntimePath exists, applied on the machine that runs it.
      cmd = "bash";
      args = ["-lc", withRuntimePath(spec.shell, env)];
    } else {
      if (typeof spec.cmd !== "string" || !spec.cmd) return none("spawn: exec needs cmd or shell");
      cmd = spec.cmd;
      args = Array.isArray(spec.args) ? spec.args.map(String) : [];
    }
    const cap = Math.min(EXEC_MAX_BYTES, Math.max(1024, Number(spec.max_bytes) || EXEC_DEFAULT_BYTES));
    const timeout = Math.min(EXEC_MAX_TIMEOUT_MS, Math.max(1000, Number(spec.timeout_ms) || 15_000));
    return runCapped(cmd, args, { cwd: spec.cwd, env, timeoutMs: timeout, cap, keep: spec.keep === "tail" ? "tail" : "head", killGraceMs: this.o.killGraceMs ?? 5000 });
  }

  // ───────────── oneshot: the verifier, where the run's files are ─────────────

  async oneshot(raw: unknown): Promise<OneshotResult> {
    const spec = raw as OneshotSpec;
    if (!spec || typeof spec.cwd !== "string") throw new Error("oneshot needs a cwd");
    const veto = this.o.veto(spec.workspace ?? null);
    if (veto) throw new VetoError(veto);
    const backend = this.o.backends[spec.backend];
    if (!backend?.oneShot) throw new Error(`backend ${spec.backend} has no one-shot mode on this host`);
    const profileDir = this.o.profiles()[spec.profile];
    if (!profileDir) throw new Error(`profile ${spec.profile} is not on this host`);
    const r = await resolveRepos(this.o, null, spec.repos ?? []);
    if (!isDir(spec.cwd) || !insideCheckouts(spec.cwd, r.checkouts)) throw new Error(`${spec.cwd} is not a checkout or a worktree on this host`);
    const prompt = expandPathTokens(String(spec.prompt ?? ""), r.byId, worktreeRootFor) ?? "";
    const one = backend.oneShot({
      prompt, model: spec.model, configDir: profileDir, cwd: spec.cwd,
      ...(spec.allowed_tools != null ? { allowedTools: spec.allowed_tools } : {}),
      ...(spec.max_budget_usd != null ? { maxBudgetUsd: spec.max_budget_usd } : {}),
    });
    const allowSecrets = workspaceSandboxAllow(JSON.stringify(spec.sandbox?.allow ?? []));
    const { cmd, cmdArgs } = sandboxWrap(spec.sandbox?.mode ?? "off", spec.cwd, [], profileDir, r.denyDirs, one.cmd, one.args, false, [], allowSecrets);
    const env = { ...hostBaseEnv(this.home), ...expandHomeRelative(spec.env ?? {}, spec.env_home_relative ?? [], this.home), ...one.env };
    const res = await runCapped(cmd, cmdArgs, { cwd: spec.cwd, env, timeoutMs: Math.max(1000, Number(spec.timeout_ms) || 120_000), cap: ONESHOT_CAP, keep: "tail", killGraceMs: 2000 });
    return { stdout: res.stdout, code: res.code, timed_out: res.timed_out };
  }

  // ───────────── worktree_ensure: a ticket worktree for a run placed here ─────────────

  async worktreeEnsure(raw: unknown): Promise<{ path: string }> {
    const a = raw as WorktreeEnsureArgs;
    const veto = this.o.veto(a?.workspace ?? null);
    if (veto) throw new VetoError(veto);
    if (!safeRef(a?.branch) || !safeRef(a?.base || "main")) throw new Error("bad branch name");
    const r = await resolveRepos(this.o, { id: "_", git_remote: String(a.git_remote ?? "") }, []);
    const p = await ensureBranchWorktree(r.repoPath!, String(a.base || "main"), a.branch);
    if (!p) throw new Error(`could not create a worktree for ${a.branch} on this host (not a git repo, or the branch is checked out elsewhere)`);
    return { path: p };
  }
}

/**
 * Run one command with a hard timeout (SIGTERM, then SIGKILL) and bounded output. Unlike execFile's
 * maxBuffer — which KILLS the process when output passes the cap — this keeps running and keeps the
 * end that matters: a diff's head, a gate's tail.
 */
export function runCapped(
  cmd: string,
  args: string[],
  o: { cwd: string; env: Record<string, string>; timeoutMs: number; cap: number; keep: "head" | "tail"; killGraceMs: number },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e: any) {
      return resolve({ code: null, signal: null, stdout: "", stderr: "", timed_out: false, truncated: false, error: `spawn: ${e?.message ?? e}` });
    }
    const out = { stdout: [] as Buffer[], stderr: [] as Buffer[], n: { stdout: 0, stderr: 0 } };
    let truncated = false;
    let timedOut = false;
    const take = (k: "stdout" | "stderr", b: Buffer) => {
      if (o.keep === "head") {
        const room = o.cap - out.n[k];
        if (room <= 0) { truncated = true; return; }
        if (b.length > room) { truncated = true; b = b.subarray(0, room); }
        out[k].push(Buffer.from(b));
        out.n[k] += b.length;
      } else {
        out[k].push(Buffer.from(b));
        out.n[k] += b.length;
        while (out.n[k] > o.cap && out[k].length > 1) { out.n[k] -= out[k][0].length; out[k].shift(); truncated = true; }
        if (out.n[k] > o.cap) { const only = out[k][0]; out[k][0] = only.subarray(only.length - o.cap); out.n[k] = o.cap; truncated = true; }
      }
    };
    child.stdout!.on("data", (b: Buffer) => take("stdout", b));
    child.stderr!.on("data", (b: Buffer) => take("stderr", b));
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, o.killGraceMs).unref?.();
    }, o.timeoutMs);
    timer.unref?.();
    let spawnError: string | null = null;
    child.on("error", (e) => { spawnError = `spawn: ${e?.message ?? e}`; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal: signal ?? null,
        stdout: Buffer.concat(out.stdout).toString("utf8"),
        stderr: Buffer.concat(out.stderr).toString("utf8"),
        timed_out: timedOut,
        truncated,
        ...(spawnError ? { error: spawnError } : {}),
      });
    });
  });
}
