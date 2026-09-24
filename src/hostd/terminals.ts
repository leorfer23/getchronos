/**
 * The host's terminals (HOSTS.md phase 3): the other half of `RemoteHost`.
 *
 * A `spawn_pty` frame carries a SpawnSpec — intent, not paths. Everything path-shaped is worked out
 * HERE, on this Mac, with the same modules the brain uses for a local terminal: the checkout is found
 * by git remote among this host's own scanned clones, a ticket worktree is created under this host's
 * `.chronos-worktrees` (worktree-core.ts), the profile NAME is mapped to this host's directory, the
 * Seatbelt profile is built from this host's home (sandbox.ts), and the profile is prepared (trust,
 * card hooks, skill, `mc`, AGENTS.md) on this disk (agent-prep.ts, claude-trust.ts, term-hooks.ts).
 *
 * The local veto (CHRONOS_HOST_DENY) is checked FIRST, before anything is resolved or forked. It is
 * the host's own lock on workspace isolation: a bug in the brain's placement cannot get past it.
 *
 * PTYs outlive the link. Output goes into a 256 KB `Ring` per channel with a seq; while the link is
 * down nothing is sent and nothing is blocked. When the brain re-attaches it names the last seq it
 * has, and only what follows is resent — then live streaming resumes. An exit that happens while the
 * brain is away is held until the brain `release`s the channel.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import pty, { type IPty } from "node-pty";
import { Ring, chunk, type CheckoutInfo, type HostToBrain, type LiveInfo } from "../hostlink/wire.js";
import { expandHomeRelative, isSpawnSpec, type SpawnSpec } from "../hosts/spawn-spec.js";
import type { SpawnReply } from "../hosts/remote.js";
import { ensureBranchWorktree } from "../worktree-core.js";
import { installMcCli, installMcSkill, syncAgentsMd } from "../agent-prep.js";
import { ensureBypassAccepted, ensureTrustedCwd } from "../claude-trust.js";
import { ensureGrokTrustedCwd } from "../grok-trust.js";
import { installClaudeHooks, installCursorHooks, installGrokHooks } from "../term-hooks.js";
import { sandboxAvailable, sandboxWrap, workspaceSandboxAllow } from "../sandbox.js";
import { niceWrap } from "../machine.js";
import { ensureDropDir, saveDrop } from "../drops.js";
import { locateTranscript, transcriptIsJsonl, type FocusCtx } from "../focus.js";
import type { AgentBackend } from "../backends/types.js";
import { ensureRoot, hostBaseEnv, isDir, mainCheckouts, remoteKey, resolveRepos, safeRef, signalName, vetoReason } from "./resolve.js";
import { egressForSpawn, type HostEgress } from "./egress.js";

export { remoteKey };

/** Same negotiation terminal.ts does for a local seed — see its typeSeed for the two failure modes. */
const SEED_MIN_MS = 2500;
const SEED_QUIET_MS = 1200;
const SEED_MAX_MS = 20000;
/** Transcript poll cadence (focus.ts polls its own tails at 700ms). */
const TRANSCRIPT_MS = 700;
const TRANSCRIPT_MAX_READ = 1 << 20;
/** An exited channel the brain never releases (it is gone for good) is forgotten after this. */
const EXITED_KEEP_MS = 30 * 60_000;

export class VetoError extends Error {
  readonly code = "veto";
}

/** How a host talks back to its brain. HostLink implements it; tests can stub it. */
export interface TerminalsLink {
  online(): boolean;
  send(f: HostToBrain): boolean;
  sendData(ch: number, seq: number, bytes: Buffer): boolean;
}

/** A CLI the host may run, resolved by the canonical backend name the spec carries. */
export type HostBackend = Pick<AgentBackend, "name" | "bin" | "interactiveArgs" | "env">;

export type HostTerminalsOptions = {
  /** This host's home. Tests point it at a temp dir so nothing touches the operator's real profiles. */
  home?: string;
  /** Where `skills/` and `scripts/mc` live — this checkout. */
  root: string;
  /** Profile name → dir (the host's CONFIG.profiles). */
  profiles: () => Record<string, string>;
  /** This host's scanned checkouts (inventory.scanCheckouts). */
  checkouts: () => Promise<CheckoutInfo[]>;
  /** The local veto (CHRONOS_HOST_DENY). */
  deny: () => string[];
  /** Where cloned repos go when auto-clone is on: the first host root. */
  cloneRoot?: () => string | null;
  autoClone?: boolean;
  backends: Record<string, HostBackend>;
  /** The loopback `mc` forwarder's port — what MC_API points at. */
  mcPort: number;
  /** Prepare the profile (trust, hooks, skill, mc, AGENTS.md). Off in tests that must not write. */
  prepare?: boolean;
  /** The workspace egress proxies this host runs (phase 5); absent = an egress-policed spawn is refused. */
  egress?: HostEgress;
};

type Chan = {
  ch: number;
  sessionId: string;
  pty: IPty;
  ring: Ring;
  /** Live data frames go out only while true: after a reconnect, not until the brain re-attaches. */
  streaming: boolean;
  exit: { code: number | null; signal: string | null } | null;
  exitSent: boolean;
  lastOut: number;
  forgetT?: NodeJS.Timeout;
  tail: TranscriptTail | null;
  workspace: { id: string; slug: string } | null;
};


/** Incremental tail of one CLI transcript: whole lines only, by byte offset. */
class TranscriptTail {
  file: string | null = null;
  offset = 0;
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly ctx: FocusCtx, private readonly emit: (delta: string, offset: number, reset: boolean) => boolean) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), TRANSCRIPT_MS);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  /** Read what was appended and send it. Returns false when the send failed (offset not advanced). */
  poll(): void {
    let file: string | null = null;
    try { file = locateTranscript(this.ctx); } catch {}
    if (!file) return;
    let reset = false;
    if (file !== this.file) {
      reset = this.file !== null; // a different file than the one we were streaming
      this.file = file;
      if (reset) this.offset = 0;
    }
    let size: number;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size < this.offset) { this.offset = 0; reset = true; }
    if (size <= this.offset && !reset) return;
    const want = Math.min(size - this.offset, TRANSCRIPT_MAX_READ);
    let buf = Buffer.alloc(0);
    if (want > 0) {
      try {
        const fd = fs.openSync(file, "r");
        try {
          buf = Buffer.allocUnsafe(want);
          const n = fs.readSync(fd, buf, 0, want, this.offset);
          buf = buf.subarray(0, n);
        } finally { fs.closeSync(fd); }
      } catch { return; }
    }
    // Whole lines only: a JSONL record cut mid-write would be unparseable on the brain, and a cut
    // mid-character would corrupt the UTF-8 in transit.
    const nl = buf.lastIndexOf(0x0a);
    const whole = nl >= 0 ? buf.subarray(0, nl + 1) : Buffer.alloc(0);
    if (!whole.length && !reset) return;
    if (this.emit(whole.toString("utf8"), this.offset, reset)) this.offset += whole.length;
  }
}

export class HostTerminals {
  private chans = new Map<number, Chan>();
  // Random base: a restarted host must not hand out a channel number the brain still holds for a
  // terminal that died with the previous process.
  private nextCh = (crypto.randomBytes(4).readUInt32BE(0) % 0x3fffffff) + 1;
  private link: TerminalsLink | null = null;
  readonly home: string;

  constructor(private readonly o: HostTerminalsOptions) {
    this.home = o.home ?? os.homedir();
    ensurePtyHelper();
  }

  /** The port the `mc` forwarder actually bound (see mcPortCandidates in index.ts). */
  setMcPort(port: number): void { this.o.mcPort = port; }

  attachLink(link: TerminalsLink): void { this.link = link; }

  /**
   * The brain's own deny list for this host (its `policy` frame). Applied as an EXTRA veto next to
   * CHRONOS_HOST_DENY: the brain already refuses these, and this is belt-and-braces against a bug in
   * its placement. It can only add refusals — the local veto is never loosened by anything the brain says.
   */
  private brainDeny: string[] = [];
  setPolicy(deny: unknown): void {
    this.brainDeny = Array.isArray(deny) ? deny.filter((d): d is string => typeof d === "string" && !!d) : [];
  }

  /** Lock #2 for anything this host does for a workspace — terminals here, runs and exec in procs.ts. */
  vetoFor(ws: { id: string; slug: string } | null): string | null {
    return vetoReason(this.o.deny(), this.brainDeny, ws);
  }

  private denied(ws: { id: string; slug: string } | null): string | null {
    return this.vetoFor(ws);
  }

  /**
   * Another owner of channel numbers on this host (the headless runs, procs.ts): terminals and runs
   * share the one number space the link multiplexes, so neither may hand out one the other holds.
   */
  private otherChannels: (ch: number) => boolean = () => false;
  shareChannels(taken: (ch: number) => boolean): void { this.otherChannels = taken; }

  /** hello.live[]: every channel the brain should know about, exited-but-unreleased ones included. */
  live(): LiveInfo[] {
    return [...this.chans.values()].map((c) => ({
      ch: c.ch, session_id: c.sessionId, kind: "pty" as const, pid: c.pty.pid ?? null, last_seq: c.ring.lastSeq,
      exit: c.exit, transcript_offset: c.tail?.offset ?? 0,
    }));
  }

  /** The link dropped: stop streaming. PTYs keep running and their output keeps landing in the ring. */
  linkDown(): void {
    for (const c of this.chans.values()) { c.streaming = false; if (c.exit) c.exitSent = false; }
  }

  // ───────────── spawn ─────────────

  async spawn(raw: unknown): Promise<SpawnReply> {
    if (!isSpawnSpec(raw)) throw new Error("spawn_pty needs a SpawnSpec");
    const spec = raw;
    // Lock #2 (HOSTS.md → Security): the local veto, before anything is resolved, prepared or forked.
    const veto = this.denied(spec.workspace);
    if (veto) throw new VetoError(veto);
    for (const c of this.chans.values()) {
      if (c.sessionId === spec.session_id && !c.exit) throw new Error(`session ${spec.session_id.slice(0, 8)} is already running here`);
    }
    const backend = this.o.backends[spec.backend];
    if (!backend) throw new Error(`backend ${spec.backend} is not available on this host`);
    const profileDir = this.o.profiles()[spec.profile];
    if (!profileDir) throw new Error(`profile ${spec.profile} is not on this host — log it in here first (CLAUDE_CONFIG_DIR=~/.${spec.profile} claude)`);
    if (spec.sandbox.mode !== "off" && !sandboxAvailable()) throw new Error(`sandbox ${spec.sandbox.mode} requested but this host has no sandbox-exec`);
    // The workspace's egress proxy runs HERE, next to the agent (HOSTS.md phase 5). A locked workspace
    // is network-locked to it by the Seatbelt profile, so no proxy = no spawn: never strand an agent.
    const egress = await egressForSpawn(this.o.egress, spec.workspace, spec.egress ?? null, spec.sandbox.egress_locked);

    const { checkouts, repoPath, wsRepoPaths, denyDirs } = await resolveRepos(this.o, spec.repo, spec.repos);

    let cwd = this.home;
    if (spec.resume_cwd && isDir(spec.resume_cwd)) cwd = spec.resume_cwd;
    else if (repoPath && spec.worktree && safeRef(spec.worktree.branch) && safeRef(spec.worktree.base)) cwd = (await ensureBranchWorktree(repoPath, spec.worktree.base, spec.worktree.branch)) ?? repoPath;
    else if (repoPath) cwd = repoPath;
    else if (wsRepoPaths[0]) cwd = wsRepoPaths[0];

    // Every workspace repo + its worktree root (a strict profile must allow a later `mc worktree`),
    // and this terminal's drop dir — the same set terminal.ts grants a local terminal.
    const addDirs = [
      ...wsRepoPaths.flatMap((p) => [p, ensureRoot(p)].filter((x): x is string => !!x)).filter((p) => p !== cwd),
      ensureDropDir(spec.session_id, path.join(this.home, ".mc", "drops")),
    ];
    // Isolation on a host: every checkout here that is NOT this workspace's is denied (resolveRepos).
    // Stricter than the brain's list (other workspaces' registered repos) because the host cannot know
    // which workspace an unregistered clone belongs to — and it never has to be told another client's repos.
    void checkouts;
    const shared = mainCheckouts(wsRepoPaths);
    const allowSecrets = workspaceSandboxAllow(JSON.stringify(spec.sandbox.allow));

    if (this.o.prepare !== false) await this.prepare(spec, backend.name, profileDir, cwd);

    const iArgs = backend.interactiveArgs ? backend.interactiveArgs(spec.model, spec.system, addDirs, spec.cli_session, spec.resume) : [];
    const wrapped = sandboxWrap(spec.sandbox.mode, cwd, addDirs, profileDir, denyDirs, backend.bin(), iArgs, egress.locked, shared, allowSecrets);
    const { cmd, cmdArgs } = niceWrap(wrapped.cmd, wrapped.cmdArgs, spec.nice);

    const base = hostBaseEnv(this.home);
    const env: Record<string, string> = {
      ...base,
      ...expandHomeRelative(spec.env, spec.env_home_relative, this.home),
      ...backend.env({} as any, profileDir),
      ...egress.env,
      MC_API: `http://localhost:${this.o.mcPort}/api`,
      PATH: `${this.home}/.mc/bin:${base.PATH ?? ""}`,
      MC_SESSION: spec.session_id,
    };

    const term = pty.spawn(cmd, cmdArgs, { name: "xterm-color", cols: spec.cols, rows: spec.rows, cwd, env });
    const ch = this.allocCh();
    const c: Chan = { ch, sessionId: spec.session_id, pty: term, ring: new Ring(undefined, ch), streaming: !!this.link?.online(), exit: null, exitSent: false, lastOut: Date.now(), tail: null, workspace: spec.workspace };
    this.chans.set(ch, c);
    term.onData((d) => {
      c.lastOut = Date.now();
      for (const part of chunk(Buffer.from(d, "utf8"))) {
        const f = c.ring.append(part);
        if (c.streaming) this.link?.sendData(ch, f.seq, f.bytes);
      }
    });
    term.onExit(({ exitCode, signal }) => {
      c.tail?.poll(); // the agent's closing lines, before the brain snapshots its ledger on exit
      c.tail?.stop();
      c.exit = { code: exitCode ?? null, signal: signal ? signalName(signal) : null };
      this.sendExit(c);
      c.forgetT = setTimeout(() => this.chans.delete(ch), EXITED_KEEP_MS);
      c.forgetT.unref?.();
    });

    if (transcriptIsJsonl(backend.name)) {
      c.tail = new TranscriptTail(
        { sessionId: spec.cli_session || spec.session_id, backend: backend.name, cwd, configDir: profileDir, sinceMs: Date.now(), cursorConfigDir: env.CURSOR_CONFIG_DIR },
        (delta, offset, reset) => (c.streaming ? !!this.link?.send({ t: "transcript", ch, delta, offset, ...(reset ? { reset } : {}) }) : false),
      );
      c.tail.start();
    }
    if (spec.seed) this.typeSeed(c, spec.seed.text, spec.seed.enter_after_ms);
    return { ch, pid: term.pid, cols: spec.cols, rows: spec.rows, cwd };
  }

  /** A channel number no terminal or run on this host holds. */
  allocCh(): number {
    let ch = this.nextCh;
    while (this.chans.has(ch) || this.otherChannels(ch)) ch = (ch % 0xfffffffe) + 1;
    this.nextCh = (ch % 0xfffffffe) + 1;
    return ch;
  }

  /** Does a terminal hold this channel? (The link routes channel frames to its owner.) */
  owns(ch: number): boolean { return this.chans.has(ch); }


  /** HOSTS.md `prepare()`: what terminal.ts does to the brain's own profile before a local spawn. */
  private async prepare(spec: SpawnSpec, backend: string, profileDir: string, cwd: string): Promise<void> {
    installMcSkill(profileDir, this.o.root);
    installMcCli(this.o.root, this.home);
    // Hooks rewrite the CLI's USER config; tests spawn with real-looking profiles and must never.
    if (!process.env.CHRONOS_TEST) {
      try {
        if (backend === "claude-code") installClaudeHooks(profileDir);
        else if (backend === "cursor-agent") installCursorHooks(path.join(this.home, ".cursor"));
        else if (backend === "grok") installGrokHooks(path.join(this.home, ".grok"));
      } catch (e: any) {
        console.warn(`[host] ${backend} card hooks install failed: ${e?.message ?? e}`);
      }
    }
    if (backend === "claude-code" && ensureTrustedCwd(profileDir, cwd) === "added") console.log(`[host] pre-trusted ${cwd} in ${path.basename(profileDir)}`);
    if (backend === "claude-code" && ensureBypassAccepted(profileDir) === "added") console.log(`[host] pre-accepted bypass-permissions mode in ${path.basename(profileDir)}`);
    if (backend === "grok" && ensureGrokTrustedCwd(cwd, path.join(this.home, ".grok")) === "added") console.log(`[host] pre-trusted ${cwd} for grok`);
    await syncAgentsMd(cwd, this.o.root, this.home);
    void spec;
  }

  // Type-then-Enter next to the pty (HOSTS.md: "no jitter"): the same wait-for-quiet as terminal.ts.
  private typeSeed(c: Chan, seed: string, enterMs: number): void {
    const started = Date.now();
    const line = seed.replace(/\r?\n/g, " ");
    const tick = setInterval(() => {
      const waited = Date.now() - started;
      if (c.exit) return void clearInterval(tick);
      if (waited < SEED_MIN_MS) return;
      if (Date.now() - c.lastOut < SEED_QUIET_MS && waited < SEED_MAX_MS) return;
      clearInterval(tick);
      try {
        c.pty.write(line);
        setTimeout(() => { try { if (!c.exit) c.pty.write("\r"); } catch {} }, enterMs).unref?.();
      } catch {}
    }, 250);
    tick.unref?.();
  }

  // ───────────── frames from the brain ─────────────

  write(ch: number, data: string): void {
    const c = this.chans.get(ch);
    if (!c || c.exit) return;
    try { c.pty.write(String(data ?? "")); } catch {}
  }

  resize(ch: number, cols: number, rows: number): void {
    const c = this.chans.get(ch);
    if (!c || c.exit) return;
    const w = Math.max(2, cols | 0), h = Math.max(2, rows | 0);
    try { c.pty.resize(w, h); } catch {}
  }

  kill(ch: number, signal?: string): void {
    const c = this.chans.get(ch);
    if (!c || c.exit) return;
    try { c.pty.kill(signal); } catch {}
  }

  ack(ch: number, seq: number): void {
    this.chans.get(ch)?.ring.ack(seq);
  }

  /**
   * The brain (re)adopts a channel: resend what it lacks, in order — output after `seq`, then the
   * transcript after `transcript_offset`, then the exit if it already happened — and stream from here.
   */
  attach(ch: number, seq: number, transcriptOffset: number, sessionId?: string): void {
    const c = this.chans.get(ch);
    if (!c || (sessionId && c.sessionId !== sessionId)) {
      // Not ours (any more): tell the brain it is gone rather than leave a card waiting on it.
      this.link?.send({ t: "exit", ch, code: null, signal: "SIGLOST" });
      return;
    }
    c.ring.ack(seq);
    const { frames } = c.ring.since(seq);
    for (const f of frames) this.link?.sendData(ch, f.seq, f.bytes);
    c.streaming = true;
    if (c.tail) {
      if (transcriptOffset <= (c.tail.offset ?? 0)) c.tail.offset = Math.max(0, transcriptOffset);
      c.tail.poll();
    }
    if (c.exit) this.sendExit(c);
  }

  release(ch: number): void {
    const c = this.chans.get(ch);
    if (!c || !c.exit) return;
    if (c.forgetT) clearTimeout(c.forgetT);
    this.chans.delete(ch);
  }

  private sendExit(c: Chan): void {
    if (!c.exit || !c.streaming || c.exitSent) return;
    if (this.link?.send({ t: "exit", ch: c.ch, code: c.exit.code, signal: c.exit.signal })) c.exitSent = true;
  }

  /** A file dropped on this terminal on the Desk: written into THIS host's drop dir; the path is typed. */
  drop(args: { session_id: string; filename: string; mime?: string; b64: string }): { path: string; name: string; size: number; mime: string } {
    const known = [...this.chans.values()].some((c) => c.sessionId === args.session_id && !c.exit);
    if (!known) throw new Error("no live terminal for that session on this host");
    return saveDrop({
      sessionId: args.session_id,
      buffer: Buffer.from(String(args.b64 ?? ""), "base64"),
      filename: String(args.filename || "drop"),
      mime: args.mime,
      root: path.join(this.home, ".mc", "drops"),
    });
  }

  /**
   * `mc worktree` from one of this host's terminals: the brain chose the branch; the worktree is made
   * here, under this host's checkout of the repo, with the same code the brain uses for its own.
   */
  async claimWorktree(a: { session_id: string; git_remote: string; branch: string; base: string }): Promise<{ path: string }> {
    const c = [...this.chans.values()].find((x) => x.sessionId === a.session_id && !x.exit);
    if (!c) throw new Error("no live terminal for that session on this host");
    // It becomes a git argument: a name only, never something git could read as an option.
    if (!/^[\w][\w./-]{0,200}$/.test(String(a.branch)) || String(a.branch).includes("..")) throw new Error("bad branch name");
    if (!/^[\w][\w./-]{0,200}$/.test(String(a.base || "main"))) throw new Error("bad base branch name");
    const veto = this.denied(c.workspace);
    if (veto) throw new VetoError(veto);
    const want = remoteKey(a.git_remote);
    const repoPath = want ? (await this.o.checkouts()).find((x) => remoteKey(x.remote_url) === want)?.path : undefined;
    if (!repoPath) throw new Error(`repo ${a.git_remote} is not checked out on this host`);
    const p = await ensureBranchWorktree(repoPath, String(a.base || "main"), String(a.branch));
    if (!p) throw new Error(`could not create a worktree for ${a.branch} (not a git repo, or the branch is checked out elsewhere)`);
    return { path: p };
  }

  /** Stop every terminal (host shutdown). */
  killAll(): void {
    for (const c of this.chans.values()) if (!c.exit) { try { c.pty.kill(); } catch {} }
  }
}


/**
 * node-pty's prebuilt `spawn-helper` comes out of `npm ci` without its exec bit on some installs, and
 * then every spawn fails with a bare "posix_spawnp failed" (first contact, 2026-09-24). The brain
 * re-grants it at boot (terminal.ts ensurePtyHelper); a host needs the same, resolved from node-pty's
 * own location rather than the process cwd, since a LaunchAgent's cwd is not the checkout.
 */
export function ensurePtyHelper(): void {
  try {
    const dir = path.dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
    const p = path.join(dir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    if (fs.existsSync(p) && !(fs.statSync(p).mode & 0o111)) fs.chmodSync(p, 0o755);
  } catch {}
}
