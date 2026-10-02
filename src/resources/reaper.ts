/**
 * The leak reaper: kills what an agent left running, by the ownership ledger (ledger.ts). RESOURCES.md
 * has the design and the incident; this is the rule set, in the order the reaper applies it.
 *
 *  1. ENDED owner → what it still holds ATTACHED (under a living owned parent) and its leak-family
 *     DETACHED processes get SIGTERM, then SIGKILL after `killGraceMs`. No warning: the terminal or
 *     run that could have used them is gone. This is what would have caught 2026-10-02 — 188
 *     headless Chromes outliving the terminal whose subagents started them. Any OTHER detached
 *     process is something that daemonized on purpose and may serve more than this owner — Claude
 *     Code's own `claude daemon run` (with every background session its `bg-pty-host`s carry),
 *     colima, `pg_ctl start`, an MCP server: it is LEFT RUNNING, with everything below it, and
 *     reported once as `left_running`.
 *  2. ORPHAN of a LIVE owner (detached: its launcher died) → SIGTERM after `orphanGraceMs`, ONLY for
 *     the leak family: headless browsers / workerd by executable, and node/bun/deno whose argv names
 *     a test runner (vitest, jest, playwright, puppeteer…). An agent's `npm run dev &` is also PPID 1
 *     once its shell exits, and the agent may still be using it.
 *  3. A SIGTERM that has not worked after `killGraceMs` → SIGKILL, the same way (group or pid).
 *
 * The KEEP-LIST (`keep`, regex over argv; `CHRONOS_REAPER_KEEP` adds one) is never signalled under
 * any rule, attached or not, and neither is anything below it: shared per-user daemons an agent CLI
 * may have started on demand (Claude Code's daemon / bg-pty-host / bg-spare, limactl, colima,
 * gpg-agent, ssh-agent, watchman, git fsmonitor, ollama). argv is read once per candidate target,
 * batched; a tick that cannot read it signals nothing.
 *
 * How a signal is aimed: at the process GROUP when the group's leader is owned by the same owner and
 * every member of the group is too (so Chrome's renderers go with their browser), otherwise at each
 * owned pid alone. Never: pid ≤ 1, the spawner itself or its group (a headless run shares the
 * daemon's group), a live root, another user's process, anything under a protected path (Leo's own
 * `/Applications/Google Chrome.app`, which the claude-in-chrome extension drives), or ANY process
 * the ledger does not own. Right before signalling, every target's start time is read again — a pid
 * recycled since the snapshot is skipped. At most `maxSignals` kill(2) calls per tick; the rest wait.
 *
 * Modes (`CHRONOS_REAPER`): `on` signals; `dry` decides and logs each target once without
 * signalling; `off` does not even sample.
 *
 * No store, no bus, no CONFIG: the brain (brain.ts) and every host (hostd/index.ts) inject roots,
 * `ps` and `kill`, which is also what makes every decision testable without spawning anything.
 */
import fs from "node:fs";
import { execFile } from "node:child_process";
import { exeName, parsePs, PS_ARGS, ProcLedger, type Entry, type Owner, type Proc, type Root } from "./ledger.js";

export type ReaperMode = "off" | "dry" | "on";

export type ReaperConfig = {
  mode: ReaperMode;
  /** Ledger sample + reaper pass interval. */
  tickMs: number;
  /** SIGTERM → SIGKILL. */
  killGraceMs: number;
  /** How long a leak-family process must have been orphaned (PPID 1) before rule 2 takes it. */
  orphanGraceMs: number;
  /** kill(2) calls per tick, all rules together. */
  maxSignals: number;
  /** Rule 2 by executable name (basename of `comm`). */
  leakFamily: RegExp;
  /** Runtimes whose argv decides rule 2 (`node` is a dev server as often as a test runner). */
  runtimes: RegExp;
  /** …and what in that argv makes one a leak. */
  testRunnerArgs: RegExp;
  /** Executable path prefixes never signalled, owned or not. */
  protect: string[];
  /** argv patterns never signalled, nor anything below them (the keep-list). */
  keep: RegExp[];
};

export const DEFAULT_LEAK_FAMILY = /chrom(e|ium)|headless[_-]?shell|firefox|webkit|msedge|workerd/i;
export const DEFAULT_RUNTIMES = /^(node|bun|deno)$/i;
export const DEFAULT_TEST_RUNNER_ARGS = /\b(vitest|jest|mocha|playwright|puppeteer|tinypool|karma|wdio|cypress)\b/i;
export const DEFAULT_PROTECT = ["/Applications/Google Chrome.app/"];
/**
 * Shared per-user daemons an agent CLI may start on demand and that serve far more than the terminal
 * that happened to start them. Measured here: `claude daemon run --json-path ~/.claude/daemon.json`
 * (PPID 1) hosting `claude bg-pty-host` / `bg-spare` children — one of them a 5-hour-old background
 * Claude session (`--bg-pty-host … --resume`) the operator was still using.
 */
export const DEFAULT_KEEP = [
  /(^|\/)claude\s+(daemon|bg-pty-host|bg-spare)\b|--bg-pty-host\b|--bg-spare\b/,
  /(^|[\/\s])(limactl|colima|gpg-agent|ssh-agent|watchman|ollama)(\s|$)/,
  /fsmonitor--daemon/,
];

const num = (v: string | undefined, dflt: number, min: number): number => {
  const n = Number(v);
  return v != null && v.trim() !== "" && Number.isFinite(n) ? Math.max(min, n) : dflt;
};

/** The knobs, from an environment. CONFIG.reaper on the brain; hostd reads its own env through the same function. */
export function reaperConfigFromEnv(env: Record<string, string | undefined>): ReaperConfig {
  const m = (env.CHRONOS_REAPER ?? "on").trim().toLowerCase();
  const mode: ReaperMode = m === "off" || m === "0" ? "off" : m === "dry" ? "dry" : "on";
  let leakFamily = DEFAULT_LEAK_FAMILY;
  const fam = env.CHRONOS_REAPER_ORPHAN_FAMILY?.trim();
  if (fam) {
    try { leakFamily = new RegExp(fam, "i"); } catch { /* a bad regex keeps the default rather than reaping by accident */ }
  }
  const extra = (env.CHRONOS_REAPER_PROTECT ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const keep = [...DEFAULT_KEEP];
  const k = env.CHRONOS_REAPER_KEEP?.trim();
  if (k) {
    // An invalid regex is a loud log line, never "keep nothing extra" silently turning into a kill.
    try { keep.push(new RegExp(k)); } catch { console.warn(`[reaper] CHRONOS_REAPER_KEEP is not a valid regex — ignored: ${k}`); }
  }
  return {
    mode,
    tickMs: num(env.CHRONOS_REAPER_TICK_MS, 10_000, 1000),
    killGraceMs: num(env.CHRONOS_REAPER_KILL_GRACE_MS, 10_000, 0),
    orphanGraceMs: num(env.CHRONOS_REAPER_ORPHAN_GRACE_MS, 120_000, 0),
    maxSignals: Math.round(num(env.CHRONOS_REAPER_MAX_SIGNALS, 20, 1)),
    leakFamily,
    runtimes: DEFAULT_RUNTIMES,
    testRunnerArgs: DEFAULT_TEST_RUNNER_ARGS,
    protect: [...DEFAULT_PROTECT, ...extra],
    keep,
  };
}

/**
 * Rule 2's verdict on one orphan: "leak", "keep", or "args" (a runtime — ask again with its argv).
 * With argv in hand a runtime is never "args" again.
 */
export function classify(comm: string, cfg: Pick<ReaperConfig, "leakFamily" | "runtimes" | "testRunnerArgs">, args?: string | null): "leak" | "keep" | "args" {
  const name = exeName(comm);
  if (cfg.leakFamily.test(name)) return "leak";
  if (!cfg.runtimes.test(name)) return "keep";
  if (args == null) return "args";
  return cfg.testRunnerArgs.test(args) ? "leak" : "keep";
}

export type Reason = "session_ended" | "orphan" | "escalate";

/** argv on the keep-list? */
export const isKept = (argv: string | null | undefined, cfg: Pick<ReaperConfig, "keep">): boolean =>
  !!argv && cfg.keep.some((r) => r.test(argv));

/** One kill(2): a whole group (`group` = pgid) or one pid. `pids` are the ledger entries it reaches. */
export type Action = {
  signal: "SIGTERM" | "SIGKILL";
  reason: Reason;
  owner: string;
  group: number | null;
  pids: number[];
};

export type Ctx = {
  now: number;
  selfPid: number;
  /** The spawner's own process group: never signalled (a headless run lives in it). */
  selfPgid: number | null;
  uid: number | null;
  liveRootPids: Set<number>;
  /**
   * Refuse any target whose argv — or any OWNED ANCESTOR's argv — has not been read: "nothing below a
   * kept process" can only be checked once the whole chain above a target has been. The driver's final pass sets it.
   */
  requireArgv?: boolean;
};

/**
 * Pure: what the reaper deliberately spares.
 *  - A KEPT process (keep-list) and everything below it — a background Claude session's own tools are
 *    live work.
 *  - A DETACHED process of an ENDED owner that is not leak-family (it daemonized on purpose: a dev
 *    server, `pg_ctl start`, an MCP server) and what runs below it — EXCEPT leak-family descendants
 *    (a vitest, a headless Chrome), which are not spared and die with their own subtrees. That is
 *    how a Bash tool's orphaned `zsh -c "npx vitest"` loses its vitest but `vite` keeps its esbuild.
 * Not yet classified counts as not leak: spared until the verdict is in.
 */
export function spared(ledger: ProcLedger): Set<number> {
  const out = new Set<number>();
  const walk = (top: number, all: boolean) => {
    const stack = [top];
    while (stack.length) {
      const p = stack.pop()!;
      const e = ledger.entries.get(p);
      if (!e || out.has(p)) continue;
      if (!all && p !== top && e.cls === "leak" && !e.kept) continue;
      out.add(p);
      for (const c of ledger.children.get(p) ?? []) stack.push(c);
    }
  };
  for (const e of ledger.entries.values()) if (e.kept) walk(e.pid, true);
  for (const e of ledger.entries.values()) {
    if (out.has(e.pid) || !ledger.owners.get(e.owner)?.ended) continue;
    if (ledger.isDetached(e) && e.cls !== "leak") walk(e.pid, false);
  }
  return out;
}

export function touchable(e: Entry, ctx: Ctx, cfg: Pick<ReaperConfig, "protect">): boolean {
  const p = e.proc;
  if (p.pid <= 1 || p.pid === ctx.selfPid || ctx.liveRootPids.has(p.pid)) return false;
  if (ctx.uid != null && p.uid !== ctx.uid) return false;
  if (cfg.protect.some((pre) => p.comm.startsWith(pre))) return false;
  return true;
}

/**
 * Pure: what to signal this tick, escalations first (finish what was started), then ended owners,
 * then orphans — capped at `cfg.maxSignals` actions. Dry mode asks the same question; the caller
 * decides whether to act on the answer.
 */
export function decide(ledger: ProcLedger, cfg: ReaperConfig, ctx: Ctx): Action[] {
  const out: Action[] = [];
  const claimed = new Set<number>();
  const keep = spared(ledger);
  const full = () => out.length >= cfg.maxSignals;
  const owner = (e: Entry): Owner | undefined => ledger.owners.get(e.owner);
  const ok = (pid: number) => {
    const e = ledger.entries.get(pid);
    if (!e || claimed.has(pid) || keep.has(pid) || !touchable(e, ctx, cfg)) return false;
    if (!ctx.requireArgv) return true;
    return e.argv !== undefined && ledger.ancestors(pid).every((a) => ledger.entries.get(a)!.argv !== undefined);
  };

  /** The group `pgid`, if one signal to it reaches only processes this owner owns and we may touch. */
  const wholeGroup = (pgid: number, ownerKey: string): number[] | null => {
    if (pgid <= 1 || pgid === ctx.selfPgid || pgid === ctx.selfPid) return null;
    const leader = ledger.entries.get(pgid);
    if (!leader || leader.owner !== ownerKey) return null;
    const members = ledger.groups.get(pgid) ?? [];
    for (const m of members) {
      const e = ledger.entries.get(m);
      if (!e || e.owner !== ownerKey || !ok(m)) return null;
    }
    return members;
  };

  const push = (a: Action) => {
    for (const p of a.pids) claimed.add(p);
    out.push(a);
  };

  /** Aim at `targets` (one owner's pids): by whole groups where possible, the rest one by one. */
  const aim = (targets: number[], ownerKey: string, signal: Action["signal"], reason: Reason) => {
    for (const pid of targets) {
      if (full()) return;
      if (!ok(pid)) continue;
      const g = wholeGroup(ledger.entries.get(pid)!.proc.pgid, ownerKey);
      if (g) push({ signal, reason, owner: ownerKey, group: ledger.entries.get(pid)!.proc.pgid, pids: g });
      else push({ signal, reason, owner: ownerKey, group: null, pids: [pid] });
    }
  };

  // 3 (first): a SIGTERM that did not work.
  for (const e of ledger.entries.values()) {
    if (full()) return out;
    if (e.termAt == null || e.killAt != null || ctx.now - e.termAt < cfg.killGraceMs || !ok(e.pid)) continue;
    if (e.termGroup != null) {
      const g = wholeGroup(e.termGroup, e.owner);
      if (g) { push({ signal: "SIGKILL", reason: "escalate", owner: e.owner, group: e.termGroup, pids: g }); continue; }
    }
    push({ signal: "SIGKILL", reason: "escalate", owner: e.owner, group: null, pids: [e.pid] });
  }

  // 1: what an ended owner still holds, minus what `spared` keeps. Oldest first, so a browser goes
  // before the renderers its group kill already covers.
  const ended = [...ledger.entries.values()]
    .filter((e) => e.termAt == null && owner(e)?.ended)
    .sort((a, b) => a.startMs - b.startMs || a.pid - b.pid);
  for (const e of ended) {
    if (full()) return out;
    aim([e.pid], e.owner, "SIGTERM", "session_ended");
  }

  // 2: leak-family orphans of a live owner, past the grace — with what they own below them.
  const orphans = [...ledger.entries.values()]
    .filter((e) => e.termAt == null && e.cls === "leak" && e.orphanSince != null && ctx.now - e.orphanSince >= cfg.orphanGraceMs && owner(e) && !owner(e)!.ended)
    .sort((a, b) => a.startMs - b.startMs || a.pid - b.pid);
  for (const e of orphans) {
    if (full()) return out;
    if (!ok(e.pid)) continue;
    const g = wholeGroup(e.proc.pgid, e.owner);
    if (g && e.proc.pgid === e.pid) push({ signal: "SIGTERM", reason: "orphan", owner: e.owner, group: e.pid, pids: g });
    else aim(ledger.subtree(e.pid), e.owner, "SIGTERM", "orphan");
  }
  return out;
}

export type ReapEvent = {
  /** null = nothing was sent (`left_running`). */
  signal: Action["signal"] | null;
  reason: Reason | "left_running";
  dry: boolean;
  pid: number;
  group: number | null;
  /** Processes the signal reached. */
  count: number;
  rssMb: number;
  cmd: string;
  owner: { kind: Owner["kind"]; id: string; workspaceId: string | null } | null;
};

export type ReaperDeps = {
  /** What the spawner is running right now — its in-memory truth, never the DB. */
  roots(): Promise<Root[]> | Root[];
  /** `ps` with PS_ARGS; null = could not sample (the tick is skipped, nothing is decided). */
  ps(): Promise<string | null>;
  /** Start times of these pids right now (pid → startMs); null = could not check (nothing is signalled). */
  starts(pids: number[]): Promise<Map<number, number> | null>;
  /** argv of these pids (pid → command line): runtime orphans' verdict, and the keep-list. */
  args(pids: number[]): Promise<Map<number, string> | null>;
  /** kill(2). `target` < 0 is a process group. false = it was already gone. */
  signal(target: number, sig: NodeJS.Signals): boolean;
  onReap?(e: ReapEvent): void;
  log?(line: string): void;
  now?(): number;
  selfPid?: number;
  uid?: number | null;
};

export type TickResult = { sampled: boolean; actions: Action[]; signalled: number };

export class Reaper {
  readonly ledger: ProcLedger;
  private running = false;
  private kickT: NodeJS.Timeout | null = null;
  /** Per workspace, since this process started: processes reaped (or, dry, that would have been). */
  readonly reapedByWs = new Map<string, number>();

  constructor(readonly cfg: ReaperConfig, private readonly deps: ReaperDeps) {
    this.ledger = new ProcLedger((l) => this.log(l));
  }

  private log(line: string): void { (this.deps.log ?? ((l: string) => console.log(`[reaper] ${l}`)))(line); }
  private now(): number { return this.deps.now?.() ?? Date.now(); }

  /** Something just ended (session.ended / run.ended): look now rather than at the next tick. */
  kick(delayMs = 250): void {
    if (this.kickT || this.cfg.mode === "off") return;
    this.kickT = setTimeout(() => { this.kickT = null; void this.tick(); }, delayMs);
    this.kickT.unref?.();
  }

  async tick(): Promise<TickResult> {
    const none: TickResult = { sampled: false, actions: [], signalled: 0 };
    if (this.cfg.mode === "off" || this.running) return none;
    this.running = true;
    try {
      return await this.pass();
    } catch (e: any) {
      this.log(`tick failed: ${e?.message ?? e}`);
      return none;
    } finally {
      this.running = false;
    }
  }

  private async pass(): Promise<TickResult> {
    const roots = await this.deps.roots();
    // Idle: nothing running and nothing owned — not even a `ps`.
    if (!roots.length && !this.ledger.entries.size && !this.ledger.owners.size) return { sampled: false, actions: [], signalled: 0 };
    const out = await this.deps.ps();
    const snap = out ? parsePs(out) : [];
    if (!snap.length) return { sampled: false, actions: [], signalled: 0 };
    const selfPid = this.deps.selfPid ?? process.pid;
    const now = this.now();
    this.ledger.update(snap, roots, { selfPid, now });
    await this.classifyOrphans();

    const self = this.ledger.procs.get(selfPid);
    const ctx: Ctx = {
      now,
      selfPid,
      selfPgid: self?.pgid ?? null,
      uid: this.deps.uid === undefined ? (process.getuid?.() ?? null) : this.deps.uid,
      liveRootPids: new Set(roots.map((r) => r.pid)),
    };
    // The keep-list needs argv: read it for every candidate this tick would otherwise signal AND every
    // owned ancestor of one (a vitest is spared because the `claude --bg-pty-host` session ABOVE it is
    // kept — `classify` alone never reads a `claude`'s argv). Once per process, cached on the entry;
    // then decide again with any unread argv in a target's chain as a veto.
    const pre = decide(this.ledger, this.cfg, ctx);
    const chain = new Set<number>();
    for (const p of pre.flatMap((a) => a.pids)) {
      chain.add(p);
      for (const a of this.ledger.ancestors(p)) chain.add(a);
    }
    const unread = [...chain].filter((p) => this.ledger.entries.get(p)?.argv === undefined);
    if (unread.length) {
      const argv = await this.deps.args(unread).catch(() => null);
      if (!argv) {
        this.log(`could not read argv of ${unread.length} candidate(s)/ancestor(s) to check the keep-list — nothing signalled this tick`);
        return { sampled: true, actions: [], signalled: 0 };
      }
      for (const p of unread) this.setArgv(this.ledger.entries.get(p)!, argv.get(p) ?? null);
    }
    // Without our own row the group guard is blind — fall back to pid-by-pid aiming only.
    const actions = decide(this.ledger, this.cfg, { ...ctx, requireArgv: true }).filter((a) => a.group == null || ctx.selfPgid != null);
    this.reportLeftRunning();
    if (!actions.length) return { sampled: true, actions, signalled: 0 };
    if (this.cfg.mode === "dry") {
      for (const a of actions) {
        const fresh = a.pids.filter((p) => !this.ledger.entries.get(p)?.noted);
        if (!fresh.length) continue;
        for (const p of a.pids) { const e = this.ledger.entries.get(p); if (e) e.noted = true; }
        this.report(a, true);
      }
      return { sampled: true, actions, signalled: 0 };
    }
    return { sampled: true, actions, signalled: await this.execute(actions, now) };
  }

  private setArgv(e: Entry, argv: string | null): void {
    e.argv = argv;
    e.kept = isKept(argv, this.cfg);
  }

  /**
   * An ended owner's spared subtrees, announced once each (top process, how many below it, RSS):
   * the daemon it detached is not ours to kill, but the operator should see it outlived its terminal.
   */
  private reportLeftRunning(): void {
    const keep = spared(this.ledger);
    for (const pid of keep) {
      const e = this.ledger.entries.get(pid)!;
      const o = this.ledger.owners.get(e.owner);
      if (!o?.ended) continue;
      e.left = true;
      // Only the top of each spared subtree speaks, and only once it is classified (or kept).
      if (keep.has(e.proc.ppid) || e.leftNoted || (!e.kept && !e.cls)) continue;
      e.leftNoted = true;
      const pids = this.ledger.subtree(pid).filter((p) => keep.has(p));
      this.report({ signal: null, reason: "left_running", owner: e.owner, group: null, pids }, true);
    }
  }

  /**
   * The leak-family verdict, for every detached process (rules 1 and 2) and everything an ended owner
   * still holds (rule 1 kills leak-family descendants of what it spares). Runtimes need their argv,
   * fetched once for the batch and cached on the entry.
   */
  private async classifyOrphans(): Promise<void> {
    const ask: Entry[] = [];
    for (const e of this.ledger.entries.values()) {
      if (e.cls || (e.orphanSince == null && !this.ledger.owners.get(e.owner)?.ended)) continue;
      if (e.argv !== undefined) { e.cls = classify(e.proc.comm, this.cfg, e.argv) === "leak" ? "leak" : "keep"; continue; }
      const c = classify(e.proc.comm, this.cfg);
      if (c === "args") ask.push(e);
      else e.cls = c;
    }
    if (!ask.length) return;
    const argv = await this.deps.args(ask.map((e) => e.pid)).catch(() => null);
    if (!argv) return; // ask again next tick
    for (const e of ask) {
      const a = argv.get(e.pid);
      this.setArgv(e, a ?? null);
      e.cls = a == null ? "keep" : (classify(e.proc.comm, this.cfg, a) as "leak" | "keep");
    }
  }

  private async execute(actions: Action[], now: number): Promise<number> {
    const all = [...new Set(actions.flatMap((a) => a.pids))];
    const starts = await this.deps.starts(all).catch(() => null);
    if (!starts) { this.log(`could not re-check ${all.length} target(s) before signalling — skipped this tick`); return 0; }
    let n = 0;
    for (const a of actions) {
      // The pid-reuse guard, at the last moment: a target whose start time moved is someone else now.
      const same = (p: number) => starts.get(p) === this.ledger.entries.get(p)?.startMs;
      if (a.group != null ? !same(a.group) : !same(a.pids[0])) continue;
      const pids = a.pids.filter(same);
      const sent = this.deps.signal(a.group != null ? -a.group : a.pids[0], a.signal);
      n++;
      if (!sent) continue;
      for (const p of pids) {
        const e = this.ledger.entries.get(p);
        if (!e) continue;
        if (a.signal === "SIGTERM") { e.termAt = now; e.termGroup = a.group; } else e.killAt = now;
      }
      this.report({ ...a, pids }, false);
    }
    return n;
  }

  private report(a: Omit<Action, "signal" | "reason"> & { signal: Action["signal"] | null; reason: Reason | "left_running" }, dry: boolean): void {
    const lead = this.ledger.entries.get(a.group ?? a.pids[0]);
    const o = this.ledger.owners.get(a.owner);
    const rssKb = a.pids.reduce((s, p) => s + (this.ledger.entries.get(p)?.proc.rssKb ?? 0), 0);
    const ev: ReapEvent = {
      signal: a.signal,
      reason: a.reason,
      dry,
      pid: a.group ?? a.pids[0],
      group: a.group,
      count: a.pids.length,
      rssMb: Math.round(rssKb / 1024),
      cmd: lead?.proc.comm ?? "?",
      owner: o ? { kind: o.kind, id: o.id, workspaceId: o.workspaceId } : null,
    };
    if (a.signal === "SIGTERM" && o) {
      o.reaped += a.pids.length;
      const ws = o.workspaceId ?? "";
      this.reapedByWs.set(ws, (this.reapedByWs.get(ws) ?? 0) + a.pids.length);
    }
    const who = o ? `${o.kind} ${o.id.slice(0, 8)}${o.workspaceId ? ` (ws ${o.workspaceId.slice(0, 8)})` : ""}` : "?";
    const size = `${ev.count} proc${ev.count === 1 ? "" : "s"}, ${ev.rssMb} MB`;
    if (a.reason === "left_running") {
      this.log(`left running pid ${ev.pid} — ${size} — ${who} ended, but it detached on purpose${lead?.kept ? " (keep-list)" : ""} — ${exeName(ev.cmd)}`);
    } else {
      const why = a.reason === "session_ended" ? `${o?.kind ?? "owner"} ended` : a.reason === "orphan" ? "orphaned leak-family process" : "SIGTERM ignored";
      this.log(`${dry ? "(dry) would send " : ""}${a.signal} ${a.group != null ? `group ${a.group}` : `pid ${a.pids[0]}`} — ${size} — ${who}: ${why} — ${exeName(ev.cmd)}`);
    }
    try { this.deps.onReap?.(ev); } catch { /* a listener never stops the reaper */ }
  }
}

// ───────────────────────────── the real Mac: ps and kill ─────────────────────────────

const PS = fs.existsSync("/bin/ps") ? "/bin/ps" : "ps";

/**
 * null = no answer. A timed-out or failed snapshot must never be read as "these processes are gone":
 * only `ps -p`'s exit 1 (some of the listed pids no longer exist) still counts as an answer.
 */
function runPs(args: string[], missingOk = false): Promise<string | null> {
  return new Promise((resolve) => {
    // Async on purpose: the daemon's event loop also carries every live pty.
    execFile(PS, args, { encoding: "utf8", timeout: 5000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (err, out) => {
      if (!err) return resolve(out);
      const e = err as { code?: unknown; killed?: boolean };
      resolve(missingOk && e.code === 1 && !e.killed ? out : null);
    });
  });
}

/** `ps -o pid=,lstart= -p …` → pid → startMs. */
export function parseStarts(out: string): Map<number, number> {
  const m = new Map<number, number>();
  for (const line of out.split("\n")) {
    const r = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!r) continue;
    const ms = Date.parse(r[2].replace(/\s+/g, " "));
    if (Number.isFinite(ms)) m.set(Number(r[1]), ms);
  }
  return m;
}

/** `ps -o pid=,command= -p …` → pid → argv as one line. */
export function parseArgs(out: string): Map<number, string> {
  const m = new Map<number, string>();
  for (const line of out.split("\n")) {
    const r = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (r) m.set(Number(r[1]), r[2]);
  }
  return m;
}

/** ps + kill(2) on this machine — every dep but `roots`, which only the spawner knows. */
export function systemReaperDeps(): Omit<ReaperDeps, "roots"> {
  return {
    ps: () => runPs(PS_ARGS),
    starts: async (pids) => {
      if (!pids.length) return new Map();
      const out = await runPs(["-o", "pid=,lstart=", "-p", pids.join(",")], true);
      return out == null ? null : parseStarts(out);
    },
    args: async (pids) => {
      if (!pids.length) return new Map();
      const out = await runPs(["-o", "pid=,command=", "-p", pids.join(",")], true);
      return out == null ? null : parseArgs(out);
    },
    signal: (target, sig) => {
      try {
        process.kill(target, sig);
        return true;
      } catch {
        return false; // ESRCH: already gone. EPERM cannot happen — touchable() keeps us to our own uid.
      }
    },
  };
}

/** Test-only: a ledger row, so tests can build fixtures without a `ps`. */
export const fixtureProc = (p: Partial<Proc> & Pick<Proc, "pid" | "ppid">): Proc => ({
  pgid: p.pid, uid: 501, rssKb: 1024, cpu: 0, startMs: 1_000_000, comm: "/bin/sleep", ...p,
});
