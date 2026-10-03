/**
 * The budget ladder (RESOURCES.md → PR 2): what happens to a workspace that takes more than its share
 * of this Mac while the Mac is strained. Warn → slow (renice) → pause (SIGSTOP), and back down again.
 *
 * Why a ladder and not a kill: the 2026-10-02 incident (188 headless Chromes, load 21-30, swap 6.8 of
 * 7.2 GB) was ONE workspace's subagents. The leak reaper (reaper.ts) now kills what nobody owns any
 * more; this is for what a LIVE terminal is still using. Killing a running suite throws its work
 * away, so the ladder only ever slows or freezes it — and only while somebody else is paying for it:
 *
 *  - It acts only while the machine is STRAINED (admission's inputs: memory pressure ≥ warning, or
 *    load per core over `CHRONOS_MAX_LOAD_PER_CORE`). Over budget on a calm Mac costs nobody anything.
 *  - Budgets are shares (budget.ts): weight / Σ weight of the workspaces active on this machine, of
 *    RAM (total − max(3 GB, 20 %)) and CPU (ncpu × 100 %). A lone workspace's share is the whole Mac.
 *
 * The rungs, per workspace, while strained AND over budget:
 *  1. WARN at once: one message to each of its live terminals (typed in, as host failover tells a
 *     terminal — sessions) and to each headless run (the `mc tell` mailbox), naming the heaviest
 *     processes with their RSS and CPU. At most once per `warnEveryMs` (10 min) per workspace.
 *  2. SLOW after `slowAfterMs` (2 min) still over: renice the heaviest owned subtrees to `slowNice`
 *     (20; agents start at CHRONOS_AGENT_NICE 10), up to `maxActions` subtrees per tick. Restored when
 *     the workspace is back under budget or the machine is calm — where the OS allows it: macOS lets
 *     only root LOWER a nice value (measured: `renice 10` on our own nice-20 process → EACCES), so an
 *     unprivileged daemon's restore fails and the process stays at 20 until it exits. That is logged
 *     with the count, never hidden.
 *  3. PAUSE when also memory pressure is CRITICAL: SIGSTOP the workspace's NEWEST heavy process — a
 *     leak-family process, a test runner or a build tool — one per workspace per tick. Never a CLI
 *     root, a shell or a pty, an agent CLI, a keep-listed process or anything below one. SIGCONT,
 *     oldest pause first, when back under budget or calm (up to `maxActions` per tick), and at once
 *     when its owner ends (before the reaper's SIGTERM, which a stopped process would never handle),
 *     when the ladder is switched off, and when the daemon exits. The paused list is mirrored to a
 *     state file so the next daemon can SIGCONT what a crashed one left stopped (brain.ts).
 *
 * Modes (`CHRONOS_LADDER`, or the global setting `resources.ladder`): `warn` (DEFAULT — only rung 1
 * acts; rungs 2-3 log and publish "(would renice / would pause)" once per episode, dry: true, so the
 * first deploy is observable), `slow` (rungs 1-2), `on` (all three), `off` (nothing; anything slowed
 * or paused is released on the next tick).
 *
 * Safety is the reaper's, through the same helpers (guards.ts): ledger-owned only; never pid ≤ 1, the
 * daemon, a live root, another user's process, a protected path, the keep-list or anything below it
 * (with every owned ancestor's argv read first — an unread one is a veto); the start time re-read
 * right before every renice and signal; and only pids, never a process group (so the daemon's group,
 * where headless runs live, is never a target).
 *
 * No store, no bus, no CONFIG: brain.ts injects everything, which is what lets every transition be
 * tested with a fake clock and fake signals.
 */
import os from "node:os";
import { execFile } from "node:child_process";
import { exeName, type Entry, type Owner, type ProcLedger } from "./ledger.js";
import { chainRead, keptBelow, readChains, touchable, type GuardCtx } from "./guards.js";
import { budgetOf, capacityOf, CPU_WINDOW, isOver, median, sharesOf, strainOf, type Budget, type Capacity, type Usage } from "./budget.js";
import type { ReaperConfig } from "./reaper.js";

export type LadderMode = "off" | "warn" | "slow" | "on";
export const LADDER_MODES: LadderMode[] = ["off", "warn", "slow", "on"];
export type Rung = "ok" | "warn" | "slow" | "pause";

export type LadderConfig = {
  mode: LadderMode;
  /** Over budget this long (while strained) before rung 2. */
  slowAfterMs: number;
  /** A workspace is warned at most this often. */
  warnEveryMs: number;
  /** Rung 2's nice value. */
  slowNice: number;
  /** Per tick: subtrees reniced per workspace, and SIGCONTs on the way back down. */
  maxActions: number;
  reserveMinMb: number;
  reservePct: number;
  /** Build tools by executable name — heavy, so pausable. */
  buildTools: RegExp;
  /** …and by argv, for a runtime (node/bun/deno) running one. */
  buildArgs: RegExp;
  /** Executables never paused whatever they run: shells, ptys, agent CLIs. */
  never: RegExp;
};

export const DEFAULT_BUILD_TOOLS =
  /^(tsc|tsgo|esbuild|webpack|rollup|rolldown|swc|turbo|cargo|rustc|go|gradle|gradlew|swift|swiftc|swift-frontend|swift-build|xcodebuild|clang|clang\+\+|cc1|cc1plus|ld|ld64|javac|kotlinc|bazel|ninja)$/i;
export const DEFAULT_BUILD_ARGS = /\b(tsc|esbuild|webpack|rollup|rolldown|vite\s+build|next\s+build|turbo\s+run|gradle)\b/i;
export const DEFAULT_NEVER =
  /^-?(zsh|bash|sh|fish|dash|ksh|tcsh|csh|login|tmux|screen|script|spawn-helper|sudo|claude|codex|grok|gemini|opencode|cursor-agent|agent|ssh|sshd|mc)$/i;

const num = (v: string | undefined, dflt: number, min: number, max = Infinity): number => {
  const n = Number(v);
  return v != null && v.trim() !== "" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

export function parseLadderMode(v: string | undefined | null, dflt: LadderMode = "warn"): LadderMode {
  const m = (v ?? "").trim().toLowerCase();
  if (m === "off" || m === "0" || m === "false") return "off";
  return (LADDER_MODES as string[]).includes(m) ? (m as LadderMode) : dflt;
}

export function ladderConfigFromEnv(env: Record<string, string | undefined>): LadderConfig {
  let buildTools = DEFAULT_BUILD_TOOLS;
  const extra = env.CHRONOS_LADDER_HEAVY?.trim();
  if (extra) {
    try { buildTools = new RegExp(`${DEFAULT_BUILD_TOOLS.source}|${extra}`, "i"); }
    catch { console.warn(`[ladder] CHRONOS_LADDER_HEAVY is not a valid regex — ignored: ${extra}`); }
  }
  return {
    mode: parseLadderMode(env.CHRONOS_LADDER),
    slowAfterMs: num(env.CHRONOS_LADDER_SLOW_AFTER_MS, 120_000, 0),
    warnEveryMs: num(env.CHRONOS_LADDER_WARN_EVERY_MS, 600_000, 60_000),
    slowNice: Math.round(num(env.CHRONOS_LADDER_NICE, 20, 1, 20)),
    maxActions: Math.round(num(env.CHRONOS_LADDER_MAX_ACTIONS, 3, 1, 50)),
    reserveMinMb: num(env.CHRONOS_LADDER_RESERVE_MB, 3072, 0),
    reservePct: num(env.CHRONOS_LADDER_RESERVE_PCT, 20, 0, 90),
    buildTools,
    buildArgs: DEFAULT_BUILD_ARGS,
    never: DEFAULT_NEVER,
  };
}

/** A process the ladder stopped. Persisted (brain.ts) so a restart can SIGCONT what a crash left stopped. */
export type PausedRec = { pid: number; startMs: number; ws: string; owner: string; comm: string; rssMb: number; at: number };
type SlowedRec = { pid: number; startMs: number; prev: number; ws: string };

type WsState = {
  overSince: number | null;
  warnedAt: number | null;
  rung: Rung;
  /** Σ %CPU of the last CPU_WINDOW ticks. */
  cpu: number[];
  /** "(would renice)" already said this episode (dry rungs speak once, not every tick). */
  slowNoted: boolean;
  pauseNoted: Set<number>;
};

export type LadderEvent =
  | {
      topic: "budget.warn";
      workspace_id: string | null;
      rss_mb: number;
      budget_rss_mb: number;
      cpu: number;
      budget_cpu: number;
      share: number;
      weight: number;
      pressure: string;
      load_per_core: number;
      heaviest: Array<{ cmd: string; count: number; rss_mb: number; cpu: number; pid: number }>;
      told: number;
      failed: number;
    }
  | { topic: "budget.slow"; workspace_id: string | null; dry: boolean; nice: number; pids: number[]; count: number; rss_mb: number; cpu: number; over_ms: number }
  | {
      topic: "budget.pause";
      workspace_id: string | null;
      dry: boolean;
      pid: number;
      cmd: string;
      rss_mb: number;
      cpu: number;
      owner_kind: "session" | "run" | null;
      session_id?: string | null;
      run_id?: string;
    }
  | {
      topic: "budget.resume";
      workspace_id: string | null;
      /** cont = SIGCONT of a paused process; nice = a slowed subtree's nice put back. */
      action: "cont" | "nice";
      reason: "under_budget" | "calm" | "owner_ended" | "reaped" | "disabled" | "shutdown" | "boot";
      pids: number[];
      count: number;
      /** nice: how many the OS refused to lower again (EACCES — macOS lets only root lower nice). */
      denied?: number;
      paused_ms?: number;
    };

export type MachineReading = { loadPerCore: number; ncpu: number; pressureLevel: 1 | 2 | 4 | null };

export type LadderDeps = {
  /** The reaper's ledger: the ladder reads the same snapshot, after the reaper's pass. */
  ledger: ProcLedger;
  /** The reaper's knobs: protect, keep-list, leak family, runtimes, test-runner argv. */
  reaper: Pick<ReaperConfig, "protect" | "keep" | "leakFamily" | "runtimes" | "testRunnerArgs">;
  /** The mode right now (the global setting over the env); default: cfg.mode. */
  mode?(): LadderMode;
  load(): MachineReading;
  maxLoadPerCore(): number;
  totalMb(): number;
  /** The machine's heavy-slot pool: its size and how many each workspace holds. */
  slots(): { size: number; held: Map<string, number> };
  weightOf(ws: string | null): number;
  args(pids: number[]): Promise<Map<number, string> | null>;
  starts(pids: number[]): Promise<Map<number, number> | null>;
  /** kill(2) to ONE pid (never a group). false = it was gone. */
  signal(pid: number, sig: NodeJS.Signals): boolean;
  getNice(pid: number): number | null;
  /** Set these pids to nice `n`; resolves to the pids that now are at `n`. */
  setNice(pids: number[], n: number): Promise<Set<number>>;
  /** Deliver one line to a live owner (terminal: typed in; run: mailbox). null = delivered, else why not. */
  tell(owner: Owner, text: string): string | null;
  publish?(e: LadderEvent): void;
  /** Mirror of the paused list (brain.ts writes the state file). */
  save?(paused: PausedRec[]): void;
  wsName?(ws: string | null): string;
  log?(line: string): void;
  now?(): number;
  selfPid?: number;
  uid?: number | null;
};

export type WsView = {
  workspace_id: string | null;
  weight: number;
  share: number;
  active: boolean;
  budget: { rss_mb: number; cpu: number; slots: number };
  usage: { rss_mb: number; cpu: number; slots: number };
  over: boolean;
  rung: Rung;
  paused: number[];
  slowed: number;
};
export type LadderView = {
  mode: LadderMode;
  strained: boolean;
  critical: boolean;
  capacity: { rss_mb: number; cpu: number; slots: number } | null;
  measured_at: number | null;
};

const key = (ws: string | null | undefined): string => ws ?? "";
const unkey = (k: string): string | null => k || null;
const mb = (kb: number) => Math.round(kb / 1024);
const r1 = (n: number) => Math.round(n * 10) / 10;
const gb = (m: number) => (m >= 1024 ? `${(m / 1024).toFixed(1)} GB` : `${Math.round(m)} MB`);

type Measured = {
  usage: Map<string, Usage>;
  active: Set<string>;
  cap: Capacity;
  shares: Map<string, { weight: number; share: number }>;
  budgets: Map<string, Budget>;
  over: Set<string>;
  strained: boolean;
  critical: boolean;
  reading: MachineReading;
};

export class Ladder {
  readonly paused: PausedRec[] = [];
  readonly slowed = new Map<number, SlowedRec>();
  private readonly ws = new Map<string, WsState>();
  private last: Measured | null = null;
  private lastAt: number | null = null;
  private lastMode: LadderMode;
  private deniedNoted = false;

  constructor(readonly cfg: LadderConfig, private readonly deps: LadderDeps) {
    this.lastMode = cfg.mode;
  }

  private log(line: string): void { (this.deps.log ?? ((l: string) => console.log(`[ladder] ${l}`)))(line); }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  mode(): LadderMode { return this.deps.mode?.() ?? this.cfg.mode; }
  private get ledger(): ProcLedger { return this.deps.ledger; }
  private publish(e: LadderEvent): void { try { this.deps.publish?.(e); } catch { /* a listener never stops the ladder */ } }
  private save(): void { try { this.deps.save?.(this.paused.slice()); } catch (e: any) { this.log(`could not save the paused list: ${e?.message ?? e}`); } }
  private name(ws: string | null): string { return this.deps.wsName?.(ws) ?? (ws ? ws.slice(0, 8) : "(no workspace)"); }
  private state(k: string): WsState {
    let s = this.ws.get(k);
    if (!s) { s = { overSince: null, warnedAt: null, rung: "ok", cpu: [], slowNoted: false, pauseNoted: new Set() }; this.ws.set(k, s); }
    return s;
  }

  private ctx(): GuardCtx {
    const live = new Set<number>();
    for (const o of this.ledger.owners.values()) if (!o.ended) live.add(o.rootPid);
    return { selfPid: this.deps.selfPid ?? process.pid, uid: this.deps.uid === undefined ? (process.getuid?.() ?? null) : this.deps.uid, liveRootPids: live };
  }

  /** Still the same process the ledger knows (pid AND start time)? */
  private alive(pid: number, startMs: number): boolean {
    return this.ledger.procs.get(pid)?.startMs === startMs;
  }

  // ───────────────────────── measuring ─────────────────────────

  private measure(): Measured {
    const reading = this.deps.load();
    const { strained, critical } = strainOf(reading, this.deps.maxLoadPerCore());
    const usage = new Map<string, Usage>();
    const active = new Set<string>();
    for (const o of this.ledger.owners.values()) if (!o.ended) active.add(key(o.workspaceId));
    const rawCpu = new Map<string, number>();
    for (const e of this.ledger.entries.values()) {
      const o = this.ledger.owners.get(e.owner);
      if (!o || o.ended) continue;
      const k = key(o.workspaceId);
      const u = usage.get(k) ?? { rssMb: 0, cpu: 0, slots: 0 };
      u.rssMb += e.proc.rssKb / 1024;
      usage.set(k, u);
      rawCpu.set(k, (rawCpu.get(k) ?? 0) + e.proc.cpu);
    }
    // CPU = median of the last CPU_WINDOW ticks: one tsc spike is not a verdict.
    for (const k of [...this.ws.keys()]) if (!active.has(k)) this.ws.get(k)!.cpu = [];
    for (const k of active) {
      const st = this.state(k);
      st.cpu.push(rawCpu.get(k) ?? 0);
      if (st.cpu.length > CPU_WINDOW) st.cpu.splice(0, st.cpu.length - CPU_WINDOW);
      const u = usage.get(k) ?? { rssMb: 0, cpu: 0, slots: 0 };
      u.cpu = median(st.cpu);
      usage.set(k, u);
    }
    const slots = this.deps.slots();
    for (const [ws, n] of slots.held) {
      const k = key(ws);
      const u = usage.get(k) ?? { rssMb: 0, cpu: 0, slots: 0 };
      u.slots = n;
      usage.set(k, u);
    }
    const cap = capacityOf(this.deps.totalMb(), reading.ncpu, slots.size, { minMb: this.cfg.reserveMinMb, pct: this.cfg.reservePct });
    const shares = sharesOf(active, (k) => this.deps.weightOf(unkey(k)), usage.keys());
    const budgets = new Map<string, Budget>();
    const over = new Set<string>();
    for (const [k, s] of shares) {
      const b = budgetOf(s.share, cap);
      budgets.set(k, b);
      if (active.has(k) && isOver(usage.get(k) ?? { rssMb: 0, cpu: 0, slots: 0 }, b)) over.add(k);
    }
    return { usage, active, cap, shares, budgets, over, strained, critical, reading };
  }

  // ───────────────────────── the tick ─────────────────────────

  /** One pass, on the snapshot the reaper just took. */
  async tick(): Promise<void> {
    const now = this.now();
    const mode = this.mode();
    if (mode !== this.lastMode) { this.log(`mode ${this.lastMode} → ${mode}`); this.lastMode = mode; }
    this.forgetGone();
    this.releaseEnded();
    const m = this.measure();
    this.last = m;
    this.lastAt = now;
    if (mode === "off") {
      await this.releaseAllNow("disabled");
      for (const st of this.ws.values()) { st.overSince = null; st.rung = "ok"; st.slowNoted = false; st.pauseNoted.clear(); }
      return;
    }

    // Who is on the ladder this tick, and who is coming down.
    const climbing = new Set<string>();
    for (const k of m.active) {
      const st = this.state(k);
      if (m.strained && m.over.has(k)) {
        st.overSince ??= now;
        climbing.add(k);
      } else {
        st.overSince = null;
        st.rung = "ok";
        st.slowNoted = false;
        st.pauseNoted.clear();
      }
    }
    for (const [k, st] of this.ws) if (!m.active.has(k)) { st.overSince = null; st.rung = "ok"; }

    await this.comeDown(climbing, m);

    for (const k of climbing) {
      const st = this.state(k);
      const overMs = now - st.overSince!;
      st.rung = "warn";
      if (st.warnedAt == null || now - st.warnedAt >= this.cfg.warnEveryMs) {
        st.warnedAt = now;
        await this.warn(k, m);
      }
      if (overMs < this.cfg.slowAfterMs) continue;
      st.rung = "slow";
      await this.slow(k, m, overMs, mode === "slow" || mode === "on");
      if (!m.critical) continue;
      st.rung = "pause";
      await this.pause(k, m, mode === "on");
    }
  }

  /** Paused / slowed records whose process is gone, or whose pid now names a different process. */
  private forgetGone(): void {
    let changed = false;
    for (let i = this.paused.length - 1; i >= 0; i--) {
      const p = this.paused[i];
      if (!this.alive(p.pid, p.startMs)) { this.paused.splice(i, 1); changed = true; }
    }
    if (changed) this.save();
    for (const [pid, s] of this.slowed) if (!this.alive(pid, s.startMs)) this.slowed.delete(pid);
  }

  /** A paused process whose owner ended goes on at once — whatever the reaper then decides about it. */
  private releaseEnded(): void {
    const ended = this.paused.filter((p) => {
      const e = this.ledger.entries.get(p.pid);
      return !e || this.ledger.owners.get(e.owner)?.ended !== false;
    });
    if (ended.length) this.resumeNow(ended, "owner_ended");
  }

  /**
   * SIGCONT right now, no re-check: used when the caller just re-checked these pids (the reaper,
   * `beforeReap`) or when they come straight off the ledger's latest snapshot. SIGCONT to a running
   * process is a no-op, so the only cost of a stale pid is waking a stranger that somebody else stopped.
   */
  private resumeNow(recs: PausedRec[], reason: Extract<LadderEvent, { topic: "budget.resume" }>["reason"]): void {
    if (!recs.length) return;
    const now = this.now();
    for (const p of recs) {
      this.deps.signal(p.pid, "SIGCONT");
      const i = this.paused.indexOf(p);
      if (i >= 0) this.paused.splice(i, 1);
      this.log(`SIGCONT pid ${p.pid} — ${exeName(p.comm)}, ${p.rssMb} MB, paused ${Math.round((now - p.at) / 1000)}s — ws ${this.name(unkey(p.ws))}: ${reason.replace("_", " ")}`);
      this.publish({ topic: "budget.resume", workspace_id: unkey(p.ws), action: "cont", reason, pids: [p.pid], count: 1, paused_ms: now - p.at });
    }
    this.save();
  }

  private async releaseAllNow(reason: "disabled" | "shutdown"): Promise<void> {
    this.resumeNow(this.paused.slice().sort((a, b) => a.at - b.at), reason);
    const byWs = new Map<string, SlowedRec[]>();
    for (const s of this.slowed.values()) (byWs.get(s.ws) ?? byWs.set(s.ws, []).get(s.ws)!).push(s);
    for (const recs of byWs.values()) await this.restore(recs, reason);
  }

  /**
   * The reaper is about to signal these pids (reaper.ts `beforeSignal`): SIGCONT any the ladder
   * paused FIRST. A stopped process never handles SIGTERM — it would sit out the grace and be SIGKILLed.
   */
  beforeReap(pids: number[]): void {
    const set = new Set(pids);
    const hit = this.paused.filter((p) => set.has(p.pid));
    if (hit.length) this.resumeNow(hit, "reaped");
  }

  /**
   * Daemon exit (process.on("exit") — SIGTERM/SIGINT already exit through it): everything paused
   * goes on. Synchronous on purpose; `startsSync` (optional) re-checks start times with one blocking
   * `ps`, and when it cannot answer the SIGCONT is sent anyway — a process left stopped forever is
   * worse than a no-op SIGCONT to a stranger.
   */
  resumeAllSync(reason: "shutdown" | "disabled", startsSync?: (pids: number[]) => Map<number, number> | null): number {
    if (!this.paused.length) return 0;
    const starts = startsSync?.(this.paused.map((p) => p.pid)) ?? null;
    const recs = this.paused.slice().sort((a, b) => a.at - b.at).filter((p) => !starts || starts.get(p.pid) === p.startMs);
    this.resumeNow(recs, reason);
    const n = recs.length;
    this.paused.splice(0);
    this.save();
    return n;
  }

  // ───────────────────────── coming down ─────────────────────────

  /** Workspaces no longer climbing: SIGCONT oldest pause first (capped), put slowed nice values back. */
  private async comeDown(climbing: Set<string>, m: Measured): Promise<void> {
    const why = (_k: string): "calm" | "under_budget" => (m.strained ? "under_budget" : "calm");
    const cont = this.paused.filter((p) => !climbing.has(p.ws)).sort((a, b) => a.at - b.at).slice(0, this.cfg.maxActions);
    const nice = [...this.slowed.values()].filter((s) => !climbing.has(s.ws));
    if (!cont.length && !nice.length) return;
    const starts = await this.deps.starts([...cont.map((p) => p.pid), ...nice.map((s) => s.pid)]).catch(() => null);
    if (!starts) { this.log(`could not re-check ${cont.length + nice.length} process(es) before releasing them — next tick`); return; }
    const same = (pid: number, startMs: number) => starts.get(pid) === startMs;
    const now = this.now();
    for (const p of cont) {
      if (!same(p.pid, p.startMs)) { this.paused.splice(this.paused.indexOf(p), 1); continue; }
      this.deps.signal(p.pid, "SIGCONT");
      this.paused.splice(this.paused.indexOf(p), 1);
      const reason = why(p.ws);
      this.log(`SIGCONT pid ${p.pid} — ${exeName(p.comm)}, ${p.rssMb} MB, paused ${Math.round((now - p.at) / 1000)}s — ws ${this.name(unkey(p.ws))}: ${reason === "calm" ? `machine calm (load ${r1(m.reading.loadPerCore)}/core, pressure ${pressureName(m.reading.pressureLevel)})` : `back under budget (${usageLine(m, p.ws)})`}`);
      this.publish({ topic: "budget.resume", workspace_id: unkey(p.ws), action: "cont", reason, pids: [p.pid], count: 1, paused_ms: now - p.at });
    }
    if (cont.length) this.save();
    const byWs = new Map<string, SlowedRec[]>();
    for (const s of nice) {
      if (!same(s.pid, s.startMs)) { this.slowed.delete(s.pid); continue; }
      (byWs.get(s.ws) ?? byWs.set(s.ws, []).get(s.ws)!).push(s);
    }
    for (const [k, recs] of byWs) await this.restore(recs, why(k), m);
  }

  /** Put slowed nice values back. The OS may refuse (macOS: only root lowers nice) — counted, said once. */
  private async restore(recs: SlowedRec[], reason: Extract<LadderEvent, { topic: "budget.resume" }>["reason"], m?: Measured): Promise<void> {
    if (!recs.length) return;
    const byPrev = new Map<number, SlowedRec[]>();
    for (const s of recs) (byPrev.get(s.prev) ?? byPrev.set(s.prev, []).get(s.prev)!).push(s);
    let ok = 0;
    let denied = 0;
    for (const [prev, group] of byPrev) {
      const done = await this.deps.setNice(group.map((s) => s.pid), prev).catch(() => new Set<number>());
      for (const s of group) {
        this.slowed.delete(s.pid);
        if (done.has(s.pid)) ok++;
        else denied++;
      }
    }
    const k = recs[0].ws;
    const ws = unkey(k);
    this.log(
      `nice restored on ${ok} of ${recs.length} process(es) — ws ${this.name(ws)}: ${reason.replace("_", " ")}${m && reason === "under_budget" ? ` (${usageLine(m, k)})` : ""}` +
        (denied ? ` — ${denied} stay at ${this.cfg.slowNice} until they exit${this.deniedNoted ? "" : " (macOS lets only root lower a nice value)"}` : ""),
    );
    if (denied) this.deniedNoted = true;
    this.publish({ topic: "budget.resume", workspace_id: ws, action: "nice", reason, pids: recs.map((s) => s.pid), count: recs.length, denied });
  }

  // ───────────────────────── rung 1: warn ─────────────────────────

  private async warn(k: string, m: Measured): Promise<void> {
    const ws = unkey(k);
    // A runtime's argv turns `node` into `node (vitest)` — read once per process, cached on the entry.
    const runtimes = [...this.ledger.entries.values()]
      .filter((e) => e.argv === undefined && this.deps.reaper.runtimes.test(exeName(e.proc.comm)) && key(this.ledger.owners.get(e.owner)?.workspaceId) === k)
      .map((e) => e.pid);
    if (runtimes.length) await readChains(this.ledger, runtimes, this.deps.args, this.deps.reaper).catch(() => null);
    const u = m.usage.get(k)!;
    const b = m.budgets.get(k)!;
    const s = m.shares.get(k)!;
    const heavy = heaviest(this.ledger, k, this.deps.reaper, 3);
    const owners = [...this.ledger.owners.values()].filter((o) => !o.ended && key(o.workspaceId) === k);
    const mode = this.mode();
    const next =
      mode === "warn" ? "This Mac only warns for now." :
      mode === "slow" ? `Still over in ${Math.round(this.cfg.slowAfterMs / 60_000)} min: the heaviest of them are reniced to ${this.cfg.slowNice}.` :
      `Still over in ${Math.round(this.cfg.slowAfterMs / 60_000)} min: the heaviest are reniced to ${this.cfg.slowNice}; if memory pressure turns critical, the newest heavy process is paused (SIGSTOP) until there is room.`;
    let told = 0;
    let failed = 0;
    for (const o of owners) {
      const list = heavy.map((h) => `${h.cmd}${h.count > 1 ? ` ×${h.count}` : ""} ${gb(h.rssMb)} ${Math.round(h.cpu)}% CPU (${h.owner === o.key ? "this terminal" : `${h.ownerKind} ${h.ownerId.slice(0, 8)}`})`).join(", ");
      const text =
        `[chronos budget] Workspace ${this.name(ws)} is over its share of this Mac while the Mac is strained ` +
        `(memory pressure ${pressureName(m.reading.pressureLevel)}, load ${r1(m.reading.loadPerCore)}/core): ` +
        `RAM ${gb(u.rssMb)} of a ${gb(b.rssMb)} budget, CPU ${Math.round(u.cpu)}% of ${Math.round(b.cpu)}% ` +
        `(share ${Math.round(s.share * 100)}%, weight ${s.weight}, ${m.active.size} workspace${m.active.size === 1 ? "" : "s"} active). ` +
        `Heaviest: ${list || "nothing identifiable"}. Stop what you no longer need, and run suites and builds through \`mc heavy\`. ${next}`;
      const err = this.deps.tell(o, text);
      if (err) { failed++; this.log(`warn → ${o.kind} ${o.id.slice(0, 8)} not delivered: ${err}`); }
      else told++;
    }
    this.log(
      `WARN ws ${this.name(ws)} — RAM ${gb(u.rssMb)} / ${gb(b.rssMb)}, CPU ${Math.round(u.cpu)}% / ${Math.round(b.cpu)}% (share ${Math.round(s.share * 100)}%) — ` +
        `pressure ${pressureName(m.reading.pressureLevel)}, load ${r1(m.reading.loadPerCore)}/core — told ${told} of ${owners.length} — heaviest ${heavy.map((h) => `${h.cmd} ${gb(h.rssMb)}`).join(", ") || "-"}`,
    );
    this.publish({
      topic: "budget.warn",
      workspace_id: ws,
      rss_mb: Math.round(u.rssMb),
      budget_rss_mb: Math.round(b.rssMb),
      cpu: Math.round(u.cpu),
      budget_cpu: Math.round(b.cpu),
      share: Math.round(s.share * 1000) / 1000,
      weight: s.weight,
      pressure: pressureName(m.reading.pressureLevel),
      load_per_core: r1(m.reading.loadPerCore),
      heaviest: heavy.map((h) => ({ cmd: h.cmd, count: h.count, rss_mb: Math.round(h.rssMb), cpu: Math.round(h.cpu), pid: h.pid })),
      told,
      failed,
    });
  }

  // ───────────────────────── rung 2: slow ─────────────────────────

  private async slow(k: string, m: Measured, overMs: number, act: boolean): Promise<void> {
    const st = this.state(k);
    if (!act && st.slowNoted) return;
    const byCpu = (m.usage.get(k)?.cpu ?? 0) > (m.budgets.get(k)?.cpu ?? Infinity) && (m.usage.get(k)?.rssMb ?? 0) <= (m.budgets.get(k)?.rssMb ?? 0);
    const candidates = slowTops(this.ledger, k, byCpu).filter((t) => t.pids.some((p) => !this.slowed.has(p)));
    if (!candidates.length) return;
    const read = await readChains(this.ledger, candidates.flatMap((t) => t.pids), this.deps.args, this.deps.reaper);
    if (!read.ok) { this.log(`could not read argv of ${read.unread} process(es) to check the keep-list — nothing reniced this tick`); return; }
    const ctx = this.ctx();
    const kept = keptBelow(this.ledger);
    // Already at (or past) the slow value — reniced earlier, or forked by a slowed parent and so born
    // there — is done: it must not take one of this tick's few subtree turns from a heavier one.
    const ok = (pid: number) => {
      const e = this.ledger.entries.get(pid);
      return !!e && !this.slowed.has(pid) && !kept.has(pid) && touchable(e, ctx, this.deps.reaper) && chainRead(this.ledger, pid) &&
        (this.deps.getNice(pid) ?? this.cfg.slowNice) < this.cfg.slowNice;
    };
    const picked = candidates.map((t) => ({ ...t, pids: t.pids.filter(ok) })).filter((t) => t.pids.length).slice(0, this.cfg.maxActions);
    if (!picked.length) return;
    const pids = picked.flatMap((t) => t.pids);
    const rssMb = picked.reduce((s, t) => s + t.rssMb, 0);
    const cpu = picked.reduce((s, t) => s + t.cpu, 0);
    const ws = unkey(k);
    const what = picked.map((t) => `${t.cmd} (pid ${t.top}, ${t.pids.length} proc${t.pids.length === 1 ? "" : "s"}, ${gb(t.rssMb)}, ${Math.round(t.cpu)}%)`).join(", ");
    if (!act) {
      st.slowNoted = true;
      this.log(`(would renice to ${this.cfg.slowNice}) ws ${this.name(ws)} — over ${Math.round(overMs / 1000)}s (${usageLine(m, k)}) — ${what}`);
      this.publish({ topic: "budget.slow", workspace_id: ws, dry: true, nice: this.cfg.slowNice, pids, count: pids.length, rss_mb: Math.round(rssMb), cpu: Math.round(cpu), over_ms: overMs });
      return;
    }
    const starts = await this.deps.starts(pids).catch(() => null);
    if (!starts) { this.log(`could not re-check ${pids.length} target(s) before renicing — skipped this tick`); return; }
    const targets: SlowedRec[] = [];
    for (const pid of pids) {
      const e = this.ledger.entries.get(pid)!;
      if (starts.get(pid) !== e.startMs) continue;
      const prev = this.deps.getNice(pid);
      if (prev == null || prev >= this.cfg.slowNice) continue;
      targets.push({ pid, startMs: e.startMs, prev, ws: k });
    }
    if (!targets.length) return;
    const done = await this.deps.setNice(targets.map((t) => t.pid), this.cfg.slowNice).catch(() => new Set<number>());
    for (const t of targets) if (done.has(t.pid)) this.slowed.set(t.pid, t);
    this.log(`renice ${done.size} of ${targets.length} process(es) to ${this.cfg.slowNice} — ws ${this.name(ws)}: over ${Math.round(overMs / 1000)}s (${usageLine(m, k)}) — ${what}`);
    this.publish({ topic: "budget.slow", workspace_id: ws, dry: false, nice: this.cfg.slowNice, pids: [...done], count: done.size, rss_mb: Math.round(rssMb), cpu: Math.round(cpu), over_ms: overMs });
  }

  // ───────────────────────── rung 3: pause ─────────────────────────

  private async pause(k: string, m: Measured, act: boolean): Promise<void> {
    const st = this.state(k);
    const isPaused = new Set(this.paused.map((p) => p.pid));
    // Runtimes need their argv to be judged (a node is a dev server as often as a vitest) — and every
    // candidate's owned ancestors need theirs for the keep-list: read both, once per process.
    const owned = [...this.ledger.entries.values()].filter((e) => {
      const o = this.ledger.owners.get(e.owner);
      return o && !o.ended && key(o.workspaceId) === k && !isPaused.has(e.pid) && maybeHeavy(e, this.cfg, this.deps.reaper);
    });
    if (!owned.length) return;
    const read = await readChains(this.ledger, owned.map((e) => e.pid), this.deps.args, this.deps.reaper);
    if (!read.ok) { this.log(`could not read argv of ${read.unread} process(es) to check the keep-list — nothing paused this tick`); return; }
    const ctx = this.ctx();
    const kept = keptBelow(this.ledger);
    const target = owned
      .filter((e) => pausable(e, this.ledger, this.cfg, this.deps.reaper, ctx, kept) && (act || !st.pauseNoted.has(e.pid)))
      .sort((a, b) => b.startMs - a.startMs || b.pid - a.pid)[0];
    if (!target) return;
    const o = this.ledger.owners.get(target.owner)!;
    const ws = unkey(k);
    const rssMb = mb(target.proc.rssKb);
    const who = { owner_kind: o.kind, ...(o.kind === "run" ? { run_id: o.id } : { session_id: o.id }) };
    const desc = `pid ${target.pid} — ${labelOf(target, this.deps.reaper)}, ${rssMb} MB, ${Math.round(target.proc.cpu)}% CPU — ${o.kind} ${o.id.slice(0, 8)} (ws ${this.name(ws)})`;
    const why = `memory pressure critical, ${usageLine(m, k)}`;
    if (!act) {
      st.pauseNoted.add(target.pid);
      this.log(`(would pause) ${desc}: ${why}`);
      this.publish({ topic: "budget.pause", workspace_id: ws, dry: true, pid: target.pid, cmd: target.proc.comm, rss_mb: rssMb, cpu: Math.round(target.proc.cpu), ...who });
      return;
    }
    const starts = await this.deps.starts([target.pid]).catch(() => null);
    if (!starts || starts.get(target.pid) !== target.startMs) { this.log(`pid ${target.pid} could not be re-checked before SIGSTOP — skipped this tick`); return; }
    if (!this.deps.signal(target.pid, "SIGSTOP")) return;
    this.paused.push({ pid: target.pid, startMs: target.startMs, ws: k, owner: target.owner, comm: target.proc.comm, rssMb, at: this.now() });
    this.save();
    this.log(`SIGSTOP ${desc}: ${why}`);
    this.publish({ topic: "budget.pause", workspace_id: ws, dry: false, pid: target.pid, cmd: target.proc.comm, rss_mb: rssMb, cpu: Math.round(target.proc.cpu), ...who });
  }

  // ───────────────────────── the view ─────────────────────────

  view(): LadderView {
    const m = this.last;
    return {
      mode: this.mode(),
      strained: m?.strained ?? false,
      critical: m?.critical ?? false,
      capacity: m ? { rss_mb: Math.round(m.cap.rssMb), cpu: Math.round(m.cap.cpu), slots: m.cap.slots } : null,
      measured_at: this.lastAt,
    };
  }

  /** One workspace's line for `GET /machine`. A workspace with nothing live gets the share it WOULD have. */
  wsView(ws: string | null): WsView | null {
    const m = this.last;
    if (!m) return null;
    const k = key(ws);
    const s = m.shares.get(k) ?? sharesOf(m.active, (x) => this.deps.weightOf(unkey(x)), [k]).get(k)!;
    const b = m.budgets.get(k) ?? budgetOf(s.share, m.cap);
    const u = m.usage.get(k) ?? { rssMb: 0, cpu: 0, slots: 0 };
    let slowed = 0;
    for (const x of this.slowed.values()) if (x.ws === k) slowed++;
    return {
      workspace_id: ws,
      weight: s.weight,
      share: Math.round(s.share * 1000) / 1000,
      active: m.active.has(k),
      budget: { rss_mb: Math.round(b.rssMb), cpu: Math.round(b.cpu), slots: b.slots },
      usage: { rss_mb: Math.round(u.rssMb), cpu: Math.round(u.cpu), slots: u.slots },
      over: m.over.has(k),
      rung: this.ws.get(k)?.rung ?? "ok",
      paused: this.paused.filter((p) => p.ws === k).map((p) => p.pid),
      slowed,
    };
  }

  /** Every workspace the last measurement knows about. */
  workspaces(): Array<string | null> {
    return this.last ? [...this.last.shares.keys()].map(unkey) : [];
  }
}

// ───────────────────────── pure helpers ─────────────────────────

export const pressureName = (p: 1 | 2 | 4 | null): string => (p === 4 ? "critical" : p === 2 ? "warning" : p === 1 ? "normal" : "unknown");

function usageLine(m: Measured, k: string): string {
  const u = m.usage.get(k) ?? { rssMb: 0, cpu: 0, slots: 0 };
  const b = m.budgets.get(k)!;
  return `RAM ${gb(u.rssMb)} / ${gb(b.rssMb)}, CPU ${Math.round(u.cpu)}% / ${Math.round(b.cpu)}%`;
}

/** A name a person recognises: `node (vitest)` rather than `node`. */
export function labelOf(e: Entry, rc: Pick<ReaperConfig, "runtimes" | "testRunnerArgs">): string {
  const name = exeName(e.proc.comm);
  if (e.argv && rc.runtimes.test(name)) {
    const hit = rc.testRunnerArgs.exec(e.argv) ?? DEFAULT_BUILD_ARGS.exec(e.argv);
    if (hit) return `${name} (${hit[1]})`;
  }
  return name;
}

/** By executable alone: could this be heavy? (Runtimes are decided on their argv, once it is read.) */
export function maybeHeavy(e: Entry, cfg: Pick<LadderConfig, "buildTools" | "never">, rc: Pick<ReaperConfig, "leakFamily" | "runtimes">): boolean {
  const name = exeName(e.proc.comm);
  if (cfg.never.test(name)) return false;
  return rc.leakFamily.test(name) || cfg.buildTools.test(name) || rc.runtimes.test(name);
}

/** Heavy = leak family, a test runner, or a build tool. A runtime with unread argv is not (yet). */
export function isHeavy(e: Entry, cfg: Pick<LadderConfig, "buildTools" | "buildArgs" | "never">, rc: Pick<ReaperConfig, "leakFamily" | "runtimes" | "testRunnerArgs">): boolean {
  const name = exeName(e.proc.comm);
  if (cfg.never.test(name)) return false;
  if (rc.leakFamily.test(name) || cfg.buildTools.test(name)) return true;
  if (!rc.runtimes.test(name) || !e.argv) return false;
  return rc.testRunnerArgs.test(e.argv) || cfg.buildArgs.test(e.argv);
}

/**
 * The never-pause list, in one place: owned by a LIVE owner; heavy; not a CLI root, shell, pty or
 * agent CLI (`never`); touchable (pid ≤ 1, the daemon, another user, a protected path); not kept nor
 * below a kept process, with the whole owned ancestor chain's argv read.
 */
export function pausable(
  e: Entry,
  ledger: ProcLedger,
  cfg: Pick<LadderConfig, "buildTools" | "buildArgs" | "never">,
  rc: Pick<ReaperConfig, "leakFamily" | "runtimes" | "testRunnerArgs" | "protect">,
  ctx: GuardCtx,
  kept: Set<number>,
): boolean {
  const o = ledger.owners.get(e.owner);
  if (!o || o.ended || e.pid === o.rootPid) return false;
  if (!touchable(e, ctx, rc) || kept.has(e.pid) || !chainRead(ledger, e.pid)) return false;
  return isHeavy(e, cfg, rc);
}

export type SlowTop = { top: number; cmd: string; pids: number[]; rssMb: number; cpu: number };

/**
 * The tops of a workspace's owned subtrees — the processes directly under a live CLI root, and any
 * detached owned process — heaviest first (by RSS, or by CPU when only CPU is over).
 */
export function slowTops(ledger: ProcLedger, k: string, byCpu: boolean): SlowTop[] {
  const out: SlowTop[] = [];
  for (const e of ledger.entries.values()) {
    const o = ledger.owners.get(e.owner);
    if (!o || o.ended || key(o.workspaceId) !== k || e.pid === o.rootPid) continue;
    const parent = ledger.entries.get(e.proc.ppid);
    if (parent && parent.pid !== o.rootPid) continue;
    const pids = ledger.subtree(e.pid);
    let rssKb = 0;
    let cpu = 0;
    for (const p of pids) { const x = ledger.entries.get(p)!; rssKb += x.proc.rssKb; cpu += x.proc.cpu; }
    out.push({ top: e.pid, cmd: exeName(e.proc.comm), pids, rssMb: rssKb / 1024, cpu });
  }
  return out.sort((a, b) => (byCpu ? b.cpu - a.cpu : b.rssMb - a.rssMb) || b.rssMb - a.rssMb || a.top - b.top);
}

export type Heavy = { cmd: string; count: number; rssMb: number; cpu: number; pid: number; owner: string; ownerKind: Owner["kind"]; ownerId: string };

/** A workspace's heaviest processes, grouped by (owner, name): 31 Chrome renderers are one line. */
export function heaviest(ledger: ProcLedger, k: string, rc: Pick<ReaperConfig, "runtimes" | "testRunnerArgs">, n: number): Heavy[] {
  const groups = new Map<string, Heavy & { top: number }>();
  for (const e of ledger.entries.values()) {
    const o = ledger.owners.get(e.owner);
    if (!o || o.ended || key(o.workspaceId) !== k) continue;
    const cmd = labelOf(e, rc);
    const g = `${e.owner}|${cmd}`;
    const h = groups.get(g) ?? { cmd, count: 0, rssMb: 0, cpu: 0, pid: e.pid, top: 0, owner: o.key, ownerKind: o.kind, ownerId: o.id };
    h.count++;
    h.rssMb += e.proc.rssKb / 1024;
    h.cpu += e.proc.cpu;
    if (e.proc.rssKb > h.top) { h.top = e.proc.rssKb; h.pid = e.pid; }
    groups.set(g, h);
  }
  return [...groups.values()].sort((a, b) => b.rssMb - a.rssMb || b.cpu - a.cpu).slice(0, n).map(({ top: _t, ...h }) => h);
}

/**
 * Boot recovery: which pids a previous daemon recorded as paused are STILL stopped and still the same
 * process — those, and only those, get a SIGCONT. `ps` answers pid → { stat, startMs }.
 */
export function stillStopped(recs: Array<Pick<PausedRec, "pid" | "startMs">>, ps: Map<number, { stat: string; startMs: number }>): number[] {
  return recs.filter((r) => { const p = ps.get(r.pid); return !!p && p.startMs === r.startMs && p.stat.startsWith("T"); }).map((r) => r.pid);
}

/** `ps -o pid=,stat=,lstart= -p …` → pid → { stat, startMs }. */
export function parseStatStarts(out: string): Map<number, { stat: string; startMs: number }> {
  const m = new Map<number, { stat: string; startMs: number }>();
  for (const line of out.split("\n")) {
    const r = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!r) continue;
    const ms = Date.parse(r[3].replace(/\s+/g, " "));
    if (Number.isFinite(ms)) m.set(Number(r[1]), { stat: r[2], startMs: ms });
  }
  return m;
}

// ───────────────────────── the real Mac ─────────────────────────

/** renice(8) to an absolute value — node's os.setPriority stops at 19 — then read each pid back. */
export function systemSetNice(pids: number[], n: number): Promise<Set<number>> {
  return new Promise((resolve) => {
    if (!pids.length) return resolve(new Set());
    // exit 1 when ANY pid was refused (EACCES lowering nice) — the others were still set: read back.
    execFile("/usr/bin/renice", [String(n), "-p", ...pids.map(String)], { timeout: 5000 }, () => {
      // linux caps nice at 19 (darwin's PRIO_MAX is 20): read back what the kernel can actually hold.
      const want = process.platform === "darwin" ? n : Math.min(19, n);
      const ok = new Set<number>();
      for (const p of pids) { try { if (os.getPriority(p) === want) ok.add(p); } catch { /* gone */ } }
      resolve(ok);
    });
  });
}

export function systemGetNice(pid: number): number | null {
  try { return os.getPriority(pid); } catch { return null; }
}
