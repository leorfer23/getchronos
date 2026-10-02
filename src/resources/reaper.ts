/**
 * The leak reaper: kills what an agent left running, by the ownership ledger (ledger.ts). RESOURCES.md
 * has the design and the incident; this is the rule set, in the order the reaper applies it.
 *
 *  1. ENDED owner → every process it still owns gets SIGTERM, then SIGKILL after `killGraceMs`. No
 *     warning: the terminal or run that could have used them is gone. This is what would have caught
 *     2026-10-02 — 188 headless Chromes outliving the terminal whose subagents started them.
 *  2. ORPHAN of a LIVE owner (PPID 1: its launcher died) → the same, after `orphanGraceMs` orphaned,
 *     but ONLY for the leak family: headless browsers / workerd by executable, and node/bun/deno whose
 *     argv names a test runner (vitest, jest, playwright, puppeteer…). An agent's `npm run dev &` is
 *     also PPID 1 once its shell exits, and the agent may still be using it — so every other orphan
 *     is left alone and dies with its owner under rule 1.
 *  3. A SIGTERM that has not worked after `killGraceMs` → SIGKILL, the same way (group or pid).
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
};

export const DEFAULT_LEAK_FAMILY = /chrom(e|ium)|headless[_-]?shell|firefox|webkit|msedge|workerd/i;
export const DEFAULT_RUNTIMES = /^(node|bun|deno)$/i;
export const DEFAULT_TEST_RUNNER_ARGS = /\b(vitest|jest|mocha|playwright|puppeteer|tinypool|karma|wdio|cypress)\b/i;
export const DEFAULT_PROTECT = ["/Applications/Google Chrome.app/"];

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
};

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
  const full = () => out.length >= cfg.maxSignals;
  const owner = (e: Entry): Owner | undefined => ledger.owners.get(e.owner);
  const ok = (pid: number) => {
    const e = ledger.entries.get(pid);
    return !!e && !claimed.has(pid) && touchable(e, ctx, cfg);
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

  // 1: everything an ended owner still holds. Oldest first, so a browser goes before the renderers its group kill already covers.
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
  signal: Action["signal"];
  reason: Reason;
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
  /** argv of these pids (pid → command line), for runtime orphans. */
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
    // Without our own row the group guard is blind — fall back to pid-by-pid aiming only.
    const actions = decide(this.ledger, this.cfg, ctx).filter((a) => a.group == null || ctx.selfPgid != null);
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

  /** Rule 2 needs each new orphan's verdict; runtimes need their argv, fetched once for the batch. */
  private async classifyOrphans(): Promise<void> {
    const ask: Entry[] = [];
    for (const e of this.ledger.entries.values()) {
      if (e.orphanSince == null || e.cls) continue;
      const c = classify(e.proc.comm, this.cfg);
      if (c === "args") ask.push(e);
      else e.cls = c;
    }
    if (!ask.length) return;
    const argv = await this.deps.args(ask.map((e) => e.pid)).catch(() => null);
    if (!argv) return; // ask again next tick
    for (const e of ask) {
      const a = argv.get(e.pid);
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

  private report(a: Action, dry: boolean): void {
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
    const why = a.reason === "session_ended" ? `${o?.kind ?? "owner"} ended` : a.reason === "orphan" ? "orphaned leak-family process" : "SIGTERM ignored";
    this.log(
      `${dry ? "(dry) would send " : ""}${a.signal} ${a.group != null ? `group ${a.group}` : `pid ${a.pids[0]}`} — ${ev.count} proc${ev.count === 1 ? "" : "s"}, ${ev.rssMb} MB — ${who}: ${why} — ${exeName(ev.cmd)}`,
    );
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
