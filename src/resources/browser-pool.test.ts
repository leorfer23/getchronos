/**
 * Lease bookkeeping for `mc browser` (browser-pool.ts) over a fake engine: grant, cap, fairness,
 * heartbeat expiry, session/run-ended disposal, engine loss. No browser is ever launched here — the
 * engine's own seams are covered in browser-engine.test.ts.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { BrowserPool, LEASE_STALE_MS, setLeaseClock, type LeaseGrant } from "./browser-pool.js";
import type { BrowserEngine, EngineStatus, Opened } from "./browser-engine.js";

/** An engine that opens contexts instantly (or fails, or waits) and records every close. */
class FakeEngine implements BrowserEngine {
  open_n = 0;
  closed: string[] = [];
  touched: string[] = [];
  live = new Set<string>();
  fail: string | null = null;
  gate: Promise<void> | null = null;
  private lost: Array<(h: string[]) => void> = [];
  async open(): Promise<Opened> {
    if (this.gate) await this.gate;
    if (this.fail) throw new Error(this.fail);
    const n = ++this.open_n;
    this.live.add(`h${n}`);
    return { handle: `h${n}`, context_id: `ctx${n}`, ws_endpoint: `ws://127.0.0.1:1/devtools/browser/h${n}` };
  }
  async close(h: string): Promise<void> { this.closed.push(h); this.live.delete(h); }
  async touch(h: string): Promise<boolean> { this.touched.push(h); return this.live.has(h); }
  status(): EngineStatus { return { engine: "chrome-headless-shell", version: "1", path: "/x", pid: 1, running: true, handles: this.live.size, idle_stops_at: null, error: null }; }
  onLost(cb: (h: string[]) => void): void { this.lost.push(cb); }
  lose(h: string): void { this.live.delete(h); for (const cb of this.lost) cb([h]); }
  async stop(): Promise<void> {}
}

const flush = () => new Promise((r) => setImmediate(r));
const make = (cap = 2, perWs = 1) => {
  const engine = new FakeEngine();
  const pool = new BrowserPool("local", engine, () => ({ cap, perWs }), () => {});
  return { engine, pool };
};
const who = (workspace_id: string | null, label = "t", extra: { session_id?: string; run_id?: string } = {}) => ({
  workspace_id, session_id: extra.session_id ?? null, run_id: extra.run_id ?? null, label,
});
const granted = (g: LeaseGrant) => {
  assert.equal(g.granted, true, JSON.stringify(g));
  return g as Extract<LeaseGrant, { granted: true }>;
};

afterEach(() => setLeaseClock(null));

test("a lease is a fresh context with an endpoint, an id and an expiry", async () => {
  const { pool, engine } = make();
  const g = granted(await pool.acquire(who("ws-a"), 0));
  assert.equal(g.context_id, "ctx1");
  assert.match(g.ws_endpoint, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
  assert.ok(g.expires_at > Date.now());
  assert.equal(pool.inUse(), 1);
  assert.equal(engine.open_n, 1);
  assert.deepEqual(pool.list(null).map((l) => [l.workspace_id, l.context_id]), [["ws-a", "ctx1"]]);
});

test("the machine cap refuses past N and says how busy it is", async () => {
  const { pool } = make(2, 2);
  granted(await pool.acquire(who("ws-a"), 0));
  granted(await pool.acquire(who("ws-a"), 0));
  const r = await pool.acquire(who("ws-b"), 0);
  assert.equal(r.granted, false);
  assert.deepEqual({ in_use: (r as any).in_use, cap: (r as any).cap }, { in_use: 2, cap: 2 });
  assert.ok((r as any).ticket, "a refusal hands back a place in line");
});

test("release disposes the context and frees the place for the next waiter", async () => {
  const { pool, engine } = make(1, 1);
  const a = granted(await pool.acquire(who("ws-a"), 0));
  const waiting = pool.acquire(who("ws-b", "second"), 5000);
  await flush();
  assert.equal(pool.waiting(), 1);
  assert.equal(await pool.release(a.lease_id), true);
  assert.deepEqual(engine.closed, ["h1"]);
  const b = granted(await waiting);
  assert.equal(pool.list(null)[0].label, "second");
  assert.equal(await pool.release(a.lease_id), false, "releasing twice is a quiet no-op");
  await pool.release(b.lease_id);
});

test("fair share: a workspace past its share is granted while nobody else waits", async () => {
  const { pool } = make(3, 1);
  granted(await pool.acquire(who("ws-a"), 0));
  granted(await pool.acquire(who("ws-a"), 0)); // over its share of 1, but alone: the idle machine lends
  assert.equal(pool.inUse(), 2);
});

test("fair share: once another workspace waits, the one over its share yields the next free context", async () => {
  const { pool } = make(2, 1);
  const a1 = granted(await pool.acquire(who("ws-a"), 0));
  granted(await pool.acquire(who("ws-a"), 0)); // alone → lent the second one
  // Both busy. A asks for a third (first in line), then B arrives.
  const a3 = pool.acquire(who("ws-a", "a3"), 5000);
  const b1 = pool.acquire(who("ws-b", "b1"), 5000);
  await flush();
  assert.equal(pool.waiting(), 2);
  await pool.release(a1.lease_id);
  const gb = granted(await b1);
  assert.equal(pool.list("ws-b").length, 1, "B (under its share) got the free context although A asked first");
  assert.equal(pool.waiting(), 1, "A is still in line");
  await pool.release(gb.lease_id);
  // B gone from the queue: A may take it again.
  granted(await a3);
});

test("fair share: a workspace under its share is granted even with others waiting", async () => {
  const { pool } = make(3, 2);
  granted(await pool.acquire(who("ws-a"), 0));
  const parked = pool.acquire(who("ws-b"), 5000);
  // ws-a holds 1 < 2: granted right away, a waiter of another workspace does not block it.
  granted(await pool.acquire(who("ws-a"), 0));
  granted(await parked);
});

test("a heartbeat keeps a lease; a lapsed one is reclaimed and its context disposed", async () => {
  let now = 1_000_000;
  setLeaseClock(() => now);
  const { pool, engine } = make();
  const a = granted(await pool.acquire(who("ws-a"), 0));
  now += LEASE_STALE_MS - 1000;
  const exp = pool.beat(a.lease_id);
  assert.equal(exp, now + LEASE_STALE_MS);
  assert.deepEqual(engine.touched, ["h1"], "the beat reaches the engine (the host's TTL)");
  now += LEASE_STALE_MS - 1000;
  pool.sweep();
  assert.equal(pool.inUse(), 1, "beaten in time: still held");
  now += 2000;
  pool.sweep();
  await flush();
  assert.equal(pool.inUse(), 0);
  assert.deepEqual(engine.closed, ["h1"]);
  assert.equal(pool.beat(a.lease_id), null, "the dead holder learns its lease is gone");
});

test("the end of a session or run disposes its leases, and only its", async () => {
  const { pool, engine } = make(4, 4);
  granted(await pool.acquire(who("ws-a", "s1", { session_id: "sess-1" }), 0));
  granted(await pool.acquire(who("ws-a", "s2", { session_id: "sess-2" }), 0));
  granted(await pool.acquire(who("ws-a", "r1", { run_id: "run-1" }), 0));
  assert.equal(pool.releaseWhere((l) => l.session_id === "sess-1"), 1);
  assert.equal(pool.releaseWhere((l) => l.run_id === "run-1"), 1);
  await flush();
  assert.deepEqual(pool.list(null).map((l) => l.label), ["s2"]);
  assert.deepEqual(engine.closed.sort(), ["h1", "h3"]);
});

test("the bus: session.ended and run.ended release on every machine's pool", async () => {
  const mod = await import("./browser-pool.js");
  const { bus } = await import("../bus.js");
  mod.resetBrowserPools();
  mod.startBrowserPool();
  // A host pool driven by a fake rpc: what the brain keeps for a host.
  const calls: any[] = [];
  const remote = mod.remoteBrowserPool("h_m2", async (args: any) => {
    calls.push(args);
    if (args.op === "open") return { handle: "rh1", context_id: "rctx1", ws_endpoint: "ws://127.0.0.1:2/devtools/browser/rh1", status: { cap: 3, per_ws: 2 } };
    return { ok: true, alive: true, status: { cap: 3, per_ws: 2 } };
  });
  await flush();
  assert.deepEqual(remote.limits(), { cap: 3, perWs: 2 }, "the host's own caps, from its status");
  granted(await remote.acquire(who("ws-a", "remote", { session_id: "sess-r" }), 0));
  bus.publish({ topic: "session.ended", session_id: "sess-r" });
  await flush();
  assert.equal(remote.inUse(), 0);
  assert.deepEqual(calls.map((c) => c.op), ["status", "open", "close"]);
  assert.equal(calls[2].handle, "rh1");
  granted(await remote.acquire(who("ws-a", "run", { run_id: "run-9" }), 0));
  bus.publish({ topic: "run.ended", run_id: "run-9", status: "success" });
  await flush();
  assert.equal(remote.inUse(), 0);
  mod.resetBrowserPools();
});

test("a lease released while its context is still opening never leaks the context", async () => {
  const { pool, engine } = make();
  let open!: () => void;
  engine.gate = new Promise((r) => (open = r));
  const p = pool.acquire(who("ws-a", "slow", { session_id: "sess-x" }), 0);
  await flush();
  assert.equal(pool.inUse(), 1, "reserved while opening: the cap counts it");
  pool.releaseWhere((l) => l.session_id === "sess-x");
  open();
  const g = await p;
  assert.equal(g.granted, false);
  await flush();
  assert.deepEqual(engine.closed, ["h1"], "the context that arrived late was closed at once");
});

test("an engine failure is an error grant, not a place in line", async () => {
  const { pool, engine } = make();
  engine.fail = "no headless browser installed on this machine — install one: npx …";
  const g = await pool.acquire(who("ws-a"), 0);
  assert.equal(g.granted, false);
  assert.match((g as any).error, /no headless browser installed/);
  assert.equal(pool.inUse(), 0);
  assert.equal(pool.waiting(), 0);
});

test("a context the engine lost (browser crashed) drops its lease", async () => {
  const { pool, engine } = make();
  const a = granted(await pool.acquire(who("ws-a"), 0));
  engine.lose("h1");
  assert.equal(pool.inUse(), 0);
  assert.equal(pool.beat(a.lease_id), null);
});

test("a ticket keeps its place across polls, and never jumps workspaces", async () => {
  const { pool } = make(1, 1);
  granted(await pool.acquire(who("ws-a"), 0));
  const r1 = await pool.acquire(who("ws-b", "B"), 0);
  const ticket = (r1 as any).ticket as string;
  const r2 = await pool.acquire(who("ws-c", "C"), 0);
  // ws-c presenting ws-b's ticket gets its own entry, not B's place.
  const r3 = await pool.acquire({ ...who("ws-c", "C2"), ticket }, 0);
  assert.notEqual((r3 as any).ticket, ticket);
  // B re-polling with its ticket resumes the SAME entry.
  const r4 = await pool.acquire({ ...who("ws-b", "B again"), ticket }, 0);
  assert.equal((r4 as any).ticket, ticket);
  assert.equal(pool.waiting(), 3);
  void r2;
});

test("usage per workspace: live leases plus lease-time since boot (PR 2's hook)", async () => {
  let now = 5_000_000;
  setLeaseClock(() => now);
  const { pool } = make(4, 4);
  const a = granted(await pool.acquire(who("ws-a"), 0));
  granted(await pool.acquire(who("ws-b"), 0));
  now += 60_000;
  await pool.release(a.lease_id);
  now += 30_000;
  const u = Object.fromEntries(pool.usage().map((r) => [r.workspace_id, r]));
  assert.deepEqual(u["ws-a"], { workspace_id: "ws-a", leases: 0, lease_ms: 60_000 });
  assert.deepEqual(u["ws-b"], { workspace_id: "ws-b", leases: 1, lease_ms: 90_000 });
});

test("list is scoped: a workspace sees its own leases, admin sees all", async () => {
  const { pool } = make(4, 4);
  granted(await pool.acquire(who("ws-a", "mine"), 0));
  granted(await pool.acquire(who("ws-b", "theirs"), 0));
  assert.deepEqual(pool.list("ws-a").map((l) => l.label), ["mine"]);
  assert.deepEqual(pool.list(null).map((l) => l.label).sort(), ["mine", "theirs"]);
  assert.equal(JSON.stringify(pool.list(null)).includes("ws://"), false, "views never carry the endpoint");
});
