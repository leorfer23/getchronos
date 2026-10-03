/**
 * The process ownership ledger: which Chronos terminal or run every process on this Mac belongs to.
 * RESOURCES.md has the design; this file is the "who owns it" half, the reaper (reaper.ts) the "so
 * kill it" half.
 *
 * Measured 2026-10-02 on the 12-core / 18 GB brain: load 21-30, swap 6.8 of 7.2 GB, 188 headless
 * Chrome for Testing processes (wrangler's local Browser Rendering under vitest-pool-workers) holding
 * 2-4 GB, 32 of them browser roots whose vitest parent had already exited (PPID 1), 96 older than an
 * hour. All of them came from ONE Desk terminal's subagents. And none of them could be traced back to
 * it after the fact: puppeteer launches its browser detached — own process group, own session — with
 * a stripped environment (`ps eww` showed six variables, no MC_SESSION, no MC_WORKSPACE). Env tagging
 * cannot attribute an orphan, and neither can its process group.
 *
 * So attribution is LINEAGE, observed while the parent is still alive:
 *
 *  - Every tick takes one cheap `ps` snapshot (pid, ppid, pgid, uid, rss, %cpu, start time, exe —
 *    ~50 ms on the brain; deliberately not `ps eww`, which costs ~90 ms and reads every environment).
 *  - A ROOT is a process the daemon spawned itself — a Desk terminal's CLI or a headless run — taken
 *    from the daemon's in-memory list of what it is running, never from the DB (a stale `pid` column
 *    after a restart can name anyone). A root is only believed when it is still this daemon's direct
 *    child and started when the daemon says it spawned it.
 *  - Every descendant of an owned process is owned by the same owner, and ownership is STICKY: an
 *    entry is keyed by (pid, start time), so a recycled pid is a stranger, and a process keeps its
 *    owner after its parent dies and launchd (PPID 1) adopts it. A grandchild spawned by an owned
 *    orphan inherits too — the tree walk starts from everything owned, not only from the roots.
 *
 * An owner is one INCARNATION of a terminal or run: (kind, id, root pid). promoteToLead and a model
 * failover reopen the SAME session id under a new pid; the old incarnation's leftovers are then an
 * ended owner's, and the new pty starts clean.
 *
 * In memory only, and bounded: an entry is dropped the tick its process is gone, an owner once it is
 * ended and owns nothing. A daemon restart forgets everything — the safe direction: an unknown
 * process is never touched (RESOURCES.md → What it does not do).
 *
 * Pure: no `ps`, no signals, no store. The brain (brain.ts) and every host (hostd/index.ts) drive the
 * same class with their own roots.
 */
import path from "node:path";

/** One row of the snapshot. `startMs` is the kernel's start time (1 s resolution) — half of a process's identity. */
export type Proc = {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  rssKb: number;
  cpu: number;
  startMs: number;
  /** The executable as `ps -o comm` prints it: a full path on darwin, a 15-char name on linux. */
  comm: string;
};

/**
 * The one `ps` the ledger needs. `lstart` is five whitespace tokens ("Thu Oct  2 10:11:12 2026") and
 * `comm` goes LAST because it may contain spaces ("Google Chrome for Testing.app/…"). Run it with
 * LC_ALL=C so %cpu prints a dot and lstart prints English.
 */
export const PS_ARGS = ["-Ao", "pid=,ppid=,pgid=,uid=,rss=,pcpu=,lstart=,comm="];

const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/;

/** `Thu Oct  2 10:11:12 2026` → epoch ms, local time (ps prints in the zone this process runs in). */
export function parseLstart(s: string): number | null {
  const ms = Date.parse(s.replace(/\s+/g, " "));
  return Number.isFinite(ms) ? ms : null;
}

/** `ps -Ao <PS_ARGS>` output → rows. A line that does not parse is skipped, never guessed at. */
export function parsePs(out: string): Proc[] {
  const rows: Proc[] = [];
  for (const line of out.split("\n")) {
    const m = ROW.exec(line);
    if (!m) continue;
    const startMs = parseLstart(m[7]);
    if (startMs == null) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      uid: Number(m[4]),
      rssKb: Number(m[5]),
      cpu: Number(m[6]),
      startMs,
      comm: m[8],
    });
  }
  return rows;
}

export const exeName = (comm: string): string => path.basename(comm);

export type OwnerKind = "session" | "run";

/** A process the daemon (or hostd) spawned and is still running, as its own in-memory list says. */
export type Root = {
  kind: OwnerKind;
  /** Session id for a terminal, run id for a headless run. */
  id: string;
  pid: number;
  /** When the spawner says it spawned it (ms). Null = unknown (hostd): the direct-child rule alone then decides. */
  startedAt?: number | null;
  workspaceId: string | null;
};

export type Owner = {
  /** `kind:id:pid` — one incarnation. */
  key: string;
  kind: OwnerKind;
  id: string;
  workspaceId: string | null;
  rootPid: number;
  /** Its root left the spawner's live list: everything it still owns is a leftover. */
  ended: boolean;
  endedAt: number | null;
  /** Processes the reaper has signalled on this owner's behalf (dry-run: would have). */
  reaped: number;
};

export type Entry = {
  pid: number;
  startMs: number;
  owner: string;
  firstSeen: number;
  /** The latest snapshot row for this process. */
  proc: Proc;
  /** First tick it was seen DETACHED (see `isDetached`) while owned; null while it has a living owned parent. */
  orphanSince: number | null;
  /** The orphan rule's verdict on it (reaper.ts classify): unset until it is first detached. */
  cls?: "leak" | "keep";
  /** Its argv, read once (`ps -o command`) when it first became a candidate. undefined = not read yet; null = gone before it could be. */
  argv?: string | null;
  /** argv matches the keep-list (reaper.ts): never signalled, nor anything below it. */
  kept?: boolean;
  /** Its owner ended and the reaper deliberately spared it (a daemon it detached, or the keep-list). */
  left?: boolean;
  /** `left_running` already announced for the subtree this entry tops. */
  leftNoted?: boolean;
  /** SIGTERM sent at; the reaper escalates to SIGKILL after its grace. */
  termAt?: number;
  /** The group the SIGTERM went to (null = the pid alone), so SIGKILL follows the same way. */
  termGroup?: number | null;
  killAt?: number;
  /** Dry-run: already announced once — a dry reaper logs a target once, not every tick. */
  noted?: boolean;
};

export const ownerKey = (r: Pick<Root, "kind" | "id" | "pid">): string => `${r.kind}:${r.id}:${r.pid}`;

/** A root's own start time may trail the spawner's clock by the spawn itself; it may never precede it by more than ps's 1 s rounding plus slack. */
const ROOT_EARLY_MS = 5_000;
const ROOT_LATE_MS = 60_000;
/** Far beyond any real fleet; past it the ledger stops adopting rather than grow without bound. */
export const MAX_ENTRIES = 50_000;

export type Rollup = {
  pids: number;
  rssKb: number;
  cpu: number;
  orphans: number;
  /** Spared leftovers of an ended owner (reaper.ts `left_running`). */
  left: number;
};

export class ProcLedger {
  readonly entries = new Map<number, Entry>();
  readonly owners = new Map<string, Owner>();
  /** pgid → member pids, from the last snapshot (every process, owned or not): what a group kill would reach. */
  groups = new Map<number, number[]>();
  /** ppid → child pids, from the last snapshot. */
  children = new Map<number, number[]>();
  /** The last snapshot, by pid. */
  procs = new Map<number, Proc>();
  sampledAt: number | null = null;
  private capWarned = false;

  constructor(private readonly log: (line: string) => void = () => {}) {}

  /**
   * Fold one snapshot in. `selfPid` is the spawner (the daemon, or hostd): a root must be its direct
   * child, or it is not believed — a pid the spawner holds as a live child cannot have been recycled,
   * so this is the root's half of the pid-reuse guard.
   */
  update(snapshot: Proc[], roots: Root[], opts: { selfPid: number; now: number }): void {
    const { selfPid, now } = opts;
    const byPid = new Map<number, Proc>();
    const children = new Map<number, number[]>();
    const groups = new Map<number, number[]>();
    for (const p of snapshot) {
      byPid.set(p.pid, p);
      (children.get(p.ppid) ?? children.set(p.ppid, []).get(p.ppid)!).push(p.pid);
      (groups.get(p.pgid) ?? groups.set(p.pgid, []).get(p.pgid)!).push(p.pid);
    }
    this.procs = byPid;
    this.children = children;
    this.groups = groups;
    this.sampledAt = now;

    // 1. Forget what is gone — and a pid now held by a different process (same pid, new start time).
    for (const [pid, e] of this.entries) {
      const p = byPid.get(pid);
      if (!p || p.startMs !== e.startMs) this.entries.delete(pid);
      else e.proc = p;
    }

    // 2. Owners: every live root is a live incarnation; an incarnation whose root left the list ended.
    const liveKeys = new Set<string>();
    for (const r of roots) {
      const key = ownerKey(r);
      liveKeys.add(key);
      const o = this.owners.get(key);
      if (o) {
        if (r.workspaceId) o.workspaceId = r.workspaceId;
      } else {
        this.owners.set(key, { key, kind: r.kind, id: r.id, workspaceId: r.workspaceId, rootPid: r.pid, ended: false, endedAt: null, reaped: 0 });
      }
    }
    for (const o of this.owners.values()) {
      if (!o.ended && !liveKeys.has(o.key)) { o.ended = true; o.endedAt = now; }
    }

    // 3. Adopt the roots themselves.
    for (const r of roots) {
      const p = byPid.get(r.pid);
      if (!p || p.ppid !== selfPid || this.entries.has(p.pid)) continue;
      if (r.startedAt != null && (p.startMs < r.startedAt - ROOT_EARLY_MS || p.startMs > r.startedAt + ROOT_LATE_MS)) continue;
      this.adopt(p, ownerKey(r), now);
    }

    // 4. Everything below something owned is owned by the same owner — sticky, so this walks down from
    //    every owned process, orphans included: an adopted Chrome that forks a renderer keeps its owner.
    const queue = [...this.entries.keys()];
    while (queue.length) {
      const pid = queue.pop()!;
      const owner = this.entries.get(pid)?.owner;
      if (!owner) continue;
      for (const c of children.get(pid) ?? []) {
        if (this.entries.has(c) || c === selfPid || c <= 1) continue;
        if (!this.adopt(byPid.get(c)!, owner, now)) break;
        queue.push(c);
      }
    }

    // 5. Orphan clocks.
    for (const e of this.entries.values()) {
      if (this.isDetached(e)) e.orphanSince ??= now;
      else e.orphanSince = null;
    }

    // 6. An ended owner that owns nothing any more is history.
    const owning = new Set<string>();
    for (const e of this.entries.values()) owning.add(e.owner);
    for (const [k, o] of this.owners) if (o.ended && !owning.has(k)) this.owners.delete(k);
  }

  /**
   * No longer under a living OWNED parent: adopted by launchd (PPID 1) or, on linux, by a subreaper.
   * A root is never detached — its parent is the spawner, which nobody owns.
   */
  isDetached(e: Entry): boolean {
    if (e.proc.ppid === 1) return true;
    if (this.entries.has(e.proc.ppid)) return false;
    return e.pid !== this.owners.get(e.owner)?.rootPid;
  }

  private adopt(p: Proc, owner: string, now: number): boolean {
    if (this.entries.size >= MAX_ENTRIES) {
      if (!this.capWarned) { this.capWarned = true; this.log(`ledger full (${MAX_ENTRIES} processes) — not adopting more`); }
      return false;
    }
    this.entries.set(p.pid, { pid: p.pid, startMs: p.startMs, owner, firstSeen: now, proc: p, orphanSince: null });
    return true;
  }

  /** Per incarnation: how much it holds right now. */
  rollup(): Map<string, Rollup> {
    const out = new Map<string, Rollup>();
    for (const e of this.entries.values()) {
      const r = out.get(e.owner) ?? { pids: 0, rssKb: 0, cpu: 0, orphans: 0, left: 0 };
      r.pids++;
      r.rssKb += e.proc.rssKb;
      r.cpu += e.proc.cpu;
      if (this.isDetached(e)) r.orphans++;
      if (e.left) r.left++;
      out.set(e.owner, r);
    }
    return out;
  }

  /** `pid`'s owned ancestors, nearest first, up to the first parent the ledger does not own (the owner's root at most). */
  ancestors(pid: number): number[] {
    const out: number[] = [];
    const seen = new Set<number>([pid]);
    let p = this.entries.get(pid)?.proc.ppid;
    while (p != null && p > 1 && !seen.has(p) && this.entries.has(p)) {
      out.push(p);
      seen.add(p);
      p = this.entries.get(p)!.proc.ppid;
    }
    return out;
  }

  /** The owned subtree under `pid` (itself first), from the last snapshot. */
  subtree(pid: number): number[] {
    const out: number[] = [];
    const stack = [pid];
    const seen = new Set<number>();
    while (stack.length) {
      const p = stack.pop()!;
      if (seen.has(p) || !this.entries.has(p)) continue;
      seen.add(p);
      out.push(p);
      for (const c of this.children.get(p) ?? []) stack.push(c);
    }
    return out;
  }
}
