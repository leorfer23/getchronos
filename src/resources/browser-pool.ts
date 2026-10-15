/**
 * `mc browser` leases (RESOURCES.md → Shared headless browser pool): who holds a context on which
 * machine's shared browser, the caps, the fairness rule, heartbeats and the end of a lease.
 *
 * Modelled on the heavy slots (machine.ts `HeavyPool`): a long poll with a ticket that keeps the
 * caller's place in line, a 90 s heartbeat window, and pools that all live on the brain — one per
 * machine, the brain's own and one per host an `mc browser` was forwarded from. A lease is a CONTEXT
 * on that machine's browser, so unlike a slot it has a process behind it: the engine
 * (browser-engine.ts) runs where the agent runs — in the daemon for the brain, in hostd for a host,
 * driven over the link.
 *
 * A lease ends, and its context (every page in it) is disposed, on:
 *  - explicit release (`mc browser release`, or `mc browser run` exiting);
 *  - a lapsed heartbeat (LEASE_STALE_MS);
 *  - the end of the session or run that holds it (`session.ended` / `run.ended`);
 *  - the engine losing it (browser crashed or was stopped).
 *
 * Caps, per machine: at most `cap` leases at once; a workspace past its fair share (`perWs`) is
 * granted only while no OTHER workspace is waiting. In memory on purpose, like the slots: a lease
 * that outlived a daemon restart would be a context nobody can release.
 */
import { randomUUID } from "node:crypto";
import { bus } from "../bus.js";
import { resolveStateDir } from "../repo-root.js";
import { ChromeEngine, RemoteBrowserEngine, browserConfigFromEnv, type BrowserConfig, type BrowserEngine, type BrowserRpc, type EngineStatus, type OpenOpts } from "./browser-engine.js";

/** Same window as a heavy slot (machine.ts SLOT_STALE_MS): `mc browser run` beats every 30 s. */
export const LEASE_STALE_MS = 90_000;

export type LeaseOwner = { workspace_id: string | null; session_id: string | null; run_id: string | null; label: string };

type Lease = LeaseOwner & {
  id: string;
  host_id: string;
  /** The engine's handle — null while the context is still being opened. */
  handle: string | null;
  context_id: string | null;
  ws_endpoint: string | null;
  since: number;
  beat: number;
};

type Poll = { settle: (g: LeaseGrant) => void; timer?: NodeJS.Timeout; tick?: NodeJS.Timeout };
type Waiter = LeaseOwner & { ticket: string; since: number; lastPoll: number; poll: Poll | null };

export type LeaseGrant =
  | { granted: true; lease_id: string; ws_endpoint: string; context_id: string; expires_at: number }
  | { granted: false; ticket: string; in_use: number; cap: number; waiting: number }
  /** The engine could not open a context (none installed, crashed on start) — waiting will not help. */
  | { granted: false; error: string };

export type LeaseView = LeaseOwner & { lease_id: string; host_id: string; context_id: string | null; since: number; held_ms: number; expires_at: number };

export type Limits = { cap: number; perWs: number };

/** Test seam: the clock every pool reads. */
let nowMs: () => number = () => Date.now();
export function setLeaseClock(fn: (() => number) | null): void { nowMs = fn ?? (() => Date.now()); }

const wsKey = (ws: string | null): string => ws ?? "";

function detach(w: Waiter): Poll | null {
  const p = w.poll;
  if (p) {
    if (p.timer) clearTimeout(p.timer);
    if (p.tick) clearInterval(p.tick);
    w.poll = null;
  }
  return p;
}

export class BrowserPool {
  private readonly leases = new Map<string, Lease>();
  private readonly byHandle = new Map<string, string>();
  private queue: Waiter[] = [];
  /** Lease-milliseconds of ENDED leases, per workspace — `usage()` adds the live ones. */
  private readonly spentMs = new Map<string, number>();

  constructor(
    readonly hostId: string,
    readonly engine: BrowserEngine,
    private readonly limitsOf: () => Limits,
    private readonly log: (line: string) => void = (l) => console.warn(`[browser] ${l}`),
  ) {
    engine.onLost((handles) => {
      for (const h of handles) {
        const id = this.byHandle.get(h);
        const l = id ? this.leases.get(id) : undefined;
        if (!l) continue;
        this.forget(l);
        this.log(`lease ${l.id.slice(0, 8)} (${l.label}) on ${this.hostId} lost — its browser context is gone`);
      }
      this.pump();
    });
  }

  limits(): Limits {
    const l = this.limitsOf();
    const cap = Math.max(1, Math.round(l.cap));
    return { cap, perWs: Math.max(1, Math.min(cap, Math.round(l.perWs))) };
  }

  inUse(): number { return this.leases.size; }
  waiting(): number { return this.queue.length; }

  private heldBy(key: string): number {
    let n = 0;
    for (const l of this.leases.values()) if (wsKey(l.workspace_id) === key) n++;
    return n;
  }

  /**
   * The fairness rule. Under the machine cap, a workspace below its fair share is granted; one at or
   * past it only while no OTHER workspace is in line (an idle machine lends its whole browser).
   * Nothing is ever taken back from a holder — a newcomer gets the next free context.
   */
  private canGrant(w: Waiter): boolean {
    const { cap, perWs } = this.limits();
    if (this.leases.size >= cap) return false;
    const k = wsKey(w.workspace_id);
    if (this.heldBy(k) < perWs) return true;
    return !this.queue.some((x) => wsKey(x.workspace_id) !== k);
  }

  sweep(): void {
    const now = nowMs();
    for (const l of [...this.leases.values()]) {
      if (now - l.beat > LEASE_STALE_MS) {
        this.log(`lease ${l.id.slice(0, 8)} (${l.label}) on ${this.hostId} reclaimed — no heartbeat for ${Math.round((now - l.beat) / 1000)}s`);
        void this.release(l.id);
      }
    }
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const w = this.queue[i];
      if (!w.poll && now - w.lastPoll > LEASE_STALE_MS) this.queue.splice(i, 1);
    }
  }

  /** Grant down the queue, oldest first, skipping entries with no live poll and entries over their share. */
  private pump(): void {
    this.sweep();
    for (let i = 0; i < this.queue.length; ) {
      const w = this.queue[i];
      if (!w.poll || !this.canGrant(w)) { i++; continue; }
      this.queue.splice(i, 1);
      this.grant(w, detach(w)!.settle);
    }
  }

  private grant(w: Waiter, settle: (g: LeaseGrant) => void): void {
    const now = nowMs();
    const lease: Lease = {
      id: randomUUID(), host_id: this.hostId, workspace_id: w.workspace_id, session_id: w.session_id, run_id: w.run_id, label: w.label,
      handle: null, context_id: null, ws_endpoint: null, since: now, beat: now,
    };
    // Reserved now, so the cap counts it while the context is being opened.
    this.leases.set(lease.id, lease);
    this.engine.open({ workspace_id: w.workspace_id }).then(
      (o) => {
        if (this.leases.get(lease.id) !== lease) {
          // Released while opening (its session ended): nobody will ever use this context.
          void this.engine.close(o.handle).catch(() => {});
          return settle({ granted: false, error: "the lease ended before the browser context was ready" });
        }
        Object.assign(lease, { handle: o.handle, context_id: o.context_id, ws_endpoint: o.ws_endpoint, beat: nowMs() });
        this.byHandle.set(o.handle, lease.id);
        settle({ granted: true, lease_id: lease.id, ws_endpoint: o.ws_endpoint, context_id: o.context_id, expires_at: lease.beat + LEASE_STALE_MS });
      },
      (e) => {
        if (this.leases.get(lease.id) === lease) this.leases.delete(lease.id);
        settle({ granted: false, error: String(e?.message ?? e) });
        this.pump();
      },
    );
  }

  /**
   * Long-poll for a context on this machine's browser. `ticket` keeps the caller's place across
   * poll rounds exactly as for `mc heavy`. `waitMs <= 0` is a single attempt.
   */
  acquire(owner: LeaseOwner & { ticket?: string | null }, waitMs: number): Promise<LeaseGrant> {
    return new Promise<LeaseGrant>((resolve) => {
      const now = nowMs();
      let w = owner.ticket ? this.queue.find((x) => x.ticket === owner.ticket) : undefined;
      // A ticket only resumes the place of the SAME workspace: never someone else's spot in line.
      if (w && wsKey(w.workspace_id) !== wsKey(owner.workspace_id)) w = undefined;
      if (w) {
        detach(w);
        w.lastPoll = now;
        w.label = owner.label;
      } else {
        w = {
          ticket: owner.ticket && !this.queue.some((x) => x.ticket === owner.ticket) ? owner.ticket : randomUUID(),
          workspace_id: owner.workspace_id, session_id: owner.session_id, run_id: owner.run_id, label: owner.label,
          since: now, lastPoll: now, poll: null,
        };
        this.queue.push(w);
      }
      const entry = w;
      let done = false;
      const settle = (g: LeaseGrant) => { if (!done) { done = true; resolve(g); } };
      const refuse = () => {
        detach(entry);
        const { cap } = this.limits();
        settle({ granted: false, ticket: entry.ticket, in_use: this.leases.size, cap, waiting: this.queue.length });
      };
      entry.poll = { settle };
      this.pump();
      if (done || !entry.poll) return; // granted (or being opened — the grant settles it)
      if (waitMs <= 0) return refuse();
      const tick = setInterval(() => this.pump(), 2000);
      tick.unref?.();
      const timer = setTimeout(refuse, waitMs);
      timer.unref?.();
      entry.poll.tick = tick;
      entry.poll.timer = timer;
    });
  }

  /** The caller hung up while parked: keep its place (until it re-polls or goes stale), stop granting to it. */
  abandon(ticket: string): void {
    const w = this.queue.find((x) => x.ticket === ticket);
    if (!w) return;
    const p = detach(w);
    const { cap } = this.limits();
    p?.settle({ granted: false, ticket, in_use: this.leases.size, cap, waiting: this.queue.length });
  }

  get(id: string): LeaseView | null {
    const l = this.leases.get(id);
    return l ? this.view(l) : null;
  }

  /** Heartbeat: the new expiry, or null when the lease is gone (reclaimed, lost). */
  beat(id: string): number | null {
    const l = this.leases.get(id);
    if (!l) return null;
    l.beat = nowMs();
    if (l.handle) void this.engine.touch(l.handle).catch(() => true);
    return l.beat + LEASE_STALE_MS;
  }

  private forget(l: Lease): void {
    this.leases.delete(l.id);
    if (l.handle) this.byHandle.delete(l.handle);
    const k = wsKey(l.workspace_id);
    this.spentMs.set(k, (this.spentMs.get(k) ?? 0) + (nowMs() - l.since));
  }

  /** End a lease and dispose its context. false = no such lease. */
  async release(id: string): Promise<boolean> {
    const l = this.leases.get(id);
    if (!l) return false;
    this.forget(l);
    if (l.handle) {
      try { await this.engine.close(l.handle); } catch (e: any) { this.log(`closing lease ${id.slice(0, 8)} on ${this.hostId}: ${e?.message ?? e}`); }
    }
    this.pump();
    return true;
  }

  /** A terminal / run that ended cannot still be driving a page. */
  releaseWhere(pred: (l: LeaseOwner) => boolean): number {
    let n = 0;
    for (const l of [...this.leases.values()]) if (pred(l)) { void this.release(l.id); n++; }
    return n;
  }

  private view(l: Lease): LeaseView {
    const now = nowMs();
    return {
      lease_id: l.id, host_id: l.host_id, workspace_id: l.workspace_id, session_id: l.session_id, run_id: l.run_id, label: l.label,
      context_id: l.context_id, since: l.since, held_ms: now - l.since, expires_at: l.beat + LEASE_STALE_MS,
    };
  }

  /** `ws` null = every lease (admin); otherwise that workspace's only. */
  list(ws: string | null): LeaseView[] {
    return [...this.leases.values()].filter((l) => ws == null || l.workspace_id === ws).sort((a, b) => a.since - b.since).map((l) => this.view(l));
  }

  /**
   * Browser use per workspace on this machine — the hook PR 2's budgets read to count browser
   * contexts against a workspace's share. Live leases now, plus lease-milliseconds since boot.
   */
  usage(): Array<{ workspace_id: string | null; leases: number; lease_ms: number }> {
    const now = nowMs();
    const out = new Map<string, { workspace_id: string | null; leases: number; lease_ms: number }>();
    const row = (ws: string | null) => {
      const k = wsKey(ws);
      let r = out.get(k);
      if (!r) { r = { workspace_id: ws, leases: 0, lease_ms: this.spentMs.get(k) ?? 0 }; out.set(k, r); }
      return r;
    };
    for (const [k, ms] of this.spentMs) if (!out.has(k)) out.set(k, { workspace_id: k || null, leases: 0, lease_ms: ms });
    for (const l of this.leases.values()) { const r = row(l.workspace_id); r.leases++; r.lease_ms += now - l.since; }
    return [...out.values()];
  }

  /** What `GET /machine` and `mc browser status` show for this machine. */
  status(): EngineStatus & { in_use: number; cap: number; per_ws: number; waiting: number } {
    const { cap, perWs } = this.limits();
    const s = this.engine.status();
    return { ...s, in_use: this.leases.size, cap, per_ws: perWs, waiting: this.queue.length };
  }

  reset(): void {
    for (const w of this.queue.splice(0)) detach(w)?.settle({ granted: false, error: "reset" });
    this.leases.clear();
    this.byHandle.clear();
    this.spentMs.clear();
  }
}

// ───────────────────────────── the brain's pools ─────────────────────────────

const pools = new Map<string, BrowserPool>();
let localCfg: BrowserConfig | null = null;

export function browserConfig(): BrowserConfig {
  return (localCfg ??= browserConfigFromEnv(process.env));
}

/** Where the brain's browser keeps its throwaway profile (`<state>/.browser-pool/profile-*`). */
export const browserDataDir = (): string => resolveStateDir(".browser-pool", "CHRONOS_BROWSER_DATA_DIR");

/**
 * The brain's own pool: a ChromeEngine in this daemon. Created on first use — nothing launches until
 * a lease. `proxyFor` (browser-routes.ts) names a workspace's egress proxy, read at every lease.
 */
export function localBrowserPool(proxyFor?: (o: OpenOpts) => string | null): BrowserPool {
  let p = pools.get("local");
  if (!p) {
    const cfg = browserConfig();
    p = new BrowserPool("local", new ChromeEngine({ cfg, dataDir: browserDataDir(), ttlMs: 2 * LEASE_STALE_MS, proxyFor }), () => ({ cap: cfg.maxContexts, perWs: cfg.maxPerWorkspace }));
    pools.set("local", p);
  }
  return p;
}

/**
 * A host's pool, driven over its link (`rpc` = the host's `browser` op). Sized by what the host
 * reports for ITSELF (its RAM, its knobs); until it has answered once, a cautious 2 / 1.
 */
export function remoteBrowserPool(hostId: string, rpc: (args: BrowserRpc) => Promise<unknown>): BrowserPool {
  let p = pools.get(hostId);
  if (!p) {
    const engine = new RemoteBrowserEngine(rpc);
    p = new BrowserPool(hostId, engine, () => {
      const s = engine.status();
      return { cap: s.cap ?? 2, perWs: s.per_ws ?? 1 };
    });
    pools.set(hostId, p);
    void engine.refresh();
  }
  return p;
}

export function allBrowserPools(): BrowserPool[] {
  return [...pools.values()];
}

/** A lease by id, on whichever machine holds it. */
export function findLease(id: string): { pool: BrowserPool; lease: LeaseView } | null {
  for (const pool of pools.values()) {
    const lease = pool.get(id);
    if (lease) return { pool, lease };
  }
  return null;
}

export function releaseBrowserForSession(sessionId: string): number {
  let n = 0;
  for (const p of pools.values()) n += p.releaseWhere((l) => l.session_id === sessionId);
  return n;
}

export function releaseBrowserForRun(runId: string): number {
  let n = 0;
  for (const p of pools.values()) n += p.releaseWhere((l) => l.run_id === runId);
  return n;
}

/** PR 2's hook: browser use per machine and workspace. No pool yet = no use. */
export function browserUsage(): Array<{ host_id: string; workspace_id: string | null; leases: number; lease_ms: number }> {
  return allBrowserPools().flatMap((p) => p.usage().map((u) => ({ host_id: p.hostId, ...u })));
}

/** Test-only: put a pool (over a fake engine) in place of a machine's own. */
export function setBrowserPoolForTest(hostId: string, pool: BrowserPool): void {
  pools.set(hostId, pool);
}

/** Test-only: forget every pool (their engines are fakes or already stopped). */
export function resetBrowserPools(): void {
  for (const p of pools.values()) p.reset();
  pools.clear();
  localCfg = null;
}

let wired = false;
/** Boot hook (index.ts): end leases with their session/run, and sweep stale ones even when nobody calls. */
export function startBrowserPool(): void {
  if (wired) return;
  wired = true;
  bus.on("event", (e: any) => {
    if (e?.topic === "session.ended" && e.session_id) releaseBrowserForSession(e.session_id);
    if (e?.topic === "run.ended" && e.run_id) releaseBrowserForRun(e.run_id);
  });
  setInterval(() => { for (const p of pools.values()) p.sweep(); }, 10_000).unref?.();
  // No SIGTERM handler here (one would replace node's default exit): the launcher SIGKILLs the browser
  // on the daemon's `exit`, and launchd takes the daemon's process group down with it.
  const cfg = browserConfig();
  console.log(`[browser] ${cfg.enabled ? `shared headless browser on demand — ${cfg.maxContexts} contexts (${cfg.maxPerWorkspace}/workspace fair share), idle stop ${Math.round(cfg.idleMs / 60000)} min` : "off (CHRONOS_BROWSER=off)"}`);
}
