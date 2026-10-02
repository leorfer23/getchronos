import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { ownerKey, ProcLedger, type Proc, type Root } from "./ledger.js";
import {
  classify, decide, DEFAULT_LEAK_FAMILY, fixtureProc as P, parseArgs, parseStarts, Reaper, reaperConfigFromEnv, systemReaperDeps,
  type Ctx, type ReapEvent, type ReaperConfig, type ReaperDeps,
} from "./reaper.js";
import { procsView } from "./brain.js";

const SELF = 100;
const T0 = Date.parse("Fri Oct 2 10:00:00 2026");
const CFG: ReaperConfig = { ...reaperConfigFromEnv({}), mode: "on" };
const DAEMON = P({ pid: SELF, ppid: 1, pgid: SELF, startMs: T0 - 86_400_000, comm: "/usr/local/bin/node" });
const root = (over: Partial<Root> = {}): Root => ({ kind: "session", id: "sess-1", pid: 200, startedAt: T0, workspaceId: "ws-a", ...over });
const CLI = P({ pid: 200, ppid: SELF, pgid: 200, startMs: T0, comm: "/opt/homebrew/bin/claude" });

const ctx = (over: Partial<Ctx> = {}): Ctx => ({ now: T0, selfPid: SELF, selfPgid: SELF, uid: 501, liveRootPids: new Set([200]), ...over });

/** A detached headless Chrome (own group) with two renderers, under vitest, under the CLI. */
const tree = (): Proc[] => [
  DAEMON,
  CLI,
  P({ pid: 210, ppid: 200, pgid: 210, startMs: T0 + 1000, comm: "node" }),
  P({ pid: 220, ppid: 210, pgid: 220, startMs: T0 + 2000, comm: "/c/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", rssKb: 200 * 1024 }),
  P({ pid: 221, ppid: 220, pgid: 220, startMs: T0 + 3000, comm: "/c/Google Chrome for Testing Helper (Renderer)", rssKb: 100 * 1024 }),
  P({ pid: 222, ppid: 220, pgid: 220, startMs: T0 + 3000, comm: "/c/Google Chrome for Testing Helper (Renderer)", rssKb: 100 * 1024 }),
];

function ledgerWith(snaps: Array<{ procs: Proc[]; roots: Root[]; now: number }>): ProcLedger {
  const l = new ProcLedger();
  for (const s of snaps) l.update(s.procs, s.roots, { selfPid: SELF, now: s.now });
  return l;
}

// ───────────────────────────── knobs ─────────────────────────────

test("config: defaults, and every knob parses (a bad regex keeps the default)", () => {
  const d = reaperConfigFromEnv({});
  assert.equal(d.mode, "on");
  assert.equal(d.tickMs, 10_000);
  assert.equal(d.killGraceMs, 10_000);
  assert.equal(d.orphanGraceMs, 120_000);
  assert.equal(d.maxSignals, 20);
  assert.deepEqual(d.protect, ["/Applications/Google Chrome.app/"]);
  const c = reaperConfigFromEnv({
    CHRONOS_REAPER: "DRY", CHRONOS_REAPER_TICK_MS: "5000", CHRONOS_REAPER_KILL_GRACE_MS: "0", CHRONOS_REAPER_ORPHAN_GRACE_MS: "60000",
    CHRONOS_REAPER_MAX_SIGNALS: "3", CHRONOS_REAPER_ORPHAN_FAMILY: "^sleep$", CHRONOS_REAPER_PROTECT: "/opt/keep/, /x/",
  });
  assert.deepEqual([c.mode, c.tickMs, c.killGraceMs, c.orphanGraceMs, c.maxSignals], ["dry", 5000, 0, 60000, 3]);
  assert.ok(c.leakFamily.test("sleep"));
  assert.deepEqual(c.protect, ["/Applications/Google Chrome.app/", "/opt/keep/", "/x/"]);
  assert.equal(reaperConfigFromEnv({ CHRONOS_REAPER: "off" }).mode, "off");
  assert.equal(reaperConfigFromEnv({ CHRONOS_REAPER: "0" }).mode, "off");
  assert.equal(reaperConfigFromEnv({ CHRONOS_REAPER_ORPHAN_FAMILY: "(" }).leakFamily, DEFAULT_LEAK_FAMILY);
  assert.equal(reaperConfigFromEnv({ CHRONOS_REAPER_TICK_MS: "5" }).tickMs, 1000, "clamped: a 5 ms tick would melt the Mac it guards");
});

test("classify: browsers and workerd by name, runtimes by argv, everything else kept", () => {
  assert.equal(classify("/c/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", CFG), "leak");
  assert.equal(classify("/x/chrome-headless-shell", CFG), "leak");
  assert.equal(classify("/x/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd", CFG), "leak");
  assert.equal(classify("/opt/homebrew/bin/node", CFG), "args");
  assert.equal(classify("/opt/homebrew/bin/node", CFG, "node /r/node_modules/vitest/dist/workers/forks.js"), "leak");
  assert.equal(classify("/opt/homebrew/bin/node", CFG, "node /r/node_modules/.bin/vite --port 5173"), "keep", "a dev server an agent backgrounded");
  assert.equal(classify("/usr/bin/python3", CFG), "keep");
  assert.equal(classify("/bin/sleep", CFG), "keep");
});

test("parseStarts / parseArgs: the re-check and argv reads", () => {
  const s = parseStarts("  220 Fri Oct  2 10:00:02 2026\n  221 Fri Oct  2 10:00:03 2026\n");
  assert.equal(s.get(220), T0 + 2000);
  assert.equal(s.get(221), T0 + 3000);
  const a = parseArgs("  300 node /r/node_modules/vitest/vitest.mjs run\n  301 /bin/sleep 5\n");
  assert.equal(a.get(300), "node /r/node_modules/vitest/vitest.mjs run");
  assert.equal(a.get(301), "/bin/sleep 5");
});

// ───────────────────────────── rule 1: ended owners ─────────────────────────────

test("ended terminal: its Chrome group goes in ONE group signal, the rest pid by pid", () => {
  const l = ledgerWith([
    { procs: tree(), roots: [root()], now: T0 },
    // The terminal closed: the CLI and vitest are gone, Chrome is reparented to launchd.
    { procs: [DAEMON, ...tree().slice(3).map((p) => (p.pid === 220 ? { ...p, ppid: 1 } : p))], roots: [], now: T0 + 10_000 },
  ]);
  const acts = decide(l, CFG, ctx({ now: T0 + 10_000, liveRootPids: new Set() }));
  assert.deepEqual(acts, [{ signal: "SIGTERM", reason: "session_ended", owner: ownerKey(root()), group: 220, pids: [220, 221, 222] }]);
});

test("ended terminal: a group with a member the owner does not own is signalled pid by pid", () => {
  const procs = tree();
  const l = ledgerWith([
    { procs, roots: [root()], now: T0 },
    { procs: [DAEMON, ...procs.slice(3), P({ pid: 230, ppid: 1, pgid: 220, comm: "/x/stranger" })], roots: [], now: T0 + 1000 },
  ]);
  const acts = decide(l, CFG, ctx({ now: T0 + 1000, liveRootPids: new Set() }));
  assert.deepEqual(acts.map((a) => [a.group, a.pids]), [[null, [220]], [null, [221]], [null, [222]]]);
  assert.ok(!acts.some((a) => a.pids.includes(230)), "never a process the ledger does not own");
});

test("a headless run shares the daemon's process group: that group is never signalled", () => {
  const run = root({ kind: "run", id: "run-1", pid: 500 });
  const procs = [DAEMON, P({ pid: 500, ppid: SELF, pgid: SELF, startMs: T0 }), P({ pid: 501, ppid: 500, pgid: SELF })];
  const l = ledgerWith([
    { procs, roots: [run], now: T0 },
    { procs: [DAEMON, P({ pid: 501, ppid: 1, pgid: SELF })], roots: [], now: T0 + 1000 },
  ]);
  const acts = decide(l, CFG, ctx({ now: T0 + 1000, liveRootPids: new Set() }));
  assert.deepEqual(acts.map((a) => [a.group, a.pids, a.reason]), [[null, [501], "session_ended"]]);
});

test("never touched: another user's process, a protected path, a live root", () => {
  const procs = [
    DAEMON,
    CLI,
    P({ pid: 201, ppid: 200, uid: 0 }),
    P({ pid: 202, ppid: 200, comm: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }),
    P({ pid: 203, ppid: 200 }),
  ];
  const other = root({ id: "sess-2", pid: 600 });
  const l = ledgerWith([
    { procs, roots: [root()], now: T0 },
    // sess-1 ended; meanwhile its old CLI pid shows up as a LIVE root of another terminal (contrived, but the rail must hold).
    { procs, roots: [other], now: T0 + 1000 },
  ]);
  const acts = decide(l, CFG, ctx({ now: T0 + 1000, liveRootPids: new Set([200]) }));
  assert.deepEqual(acts.map((a) => a.pids), [[203]]);
});

test("SIGTERM ignored past the grace → SIGKILL, aimed the same way", () => {
  const l = ledgerWith([
    { procs: tree(), roots: [root()], now: T0 },
    { procs: [DAEMON, ...tree().slice(3)], roots: [], now: T0 + 1000 },
  ]);
  for (const p of [220, 221, 222]) Object.assign(l.entries.get(p)!, { termAt: T0 + 1000, termGroup: 220 });
  assert.deepEqual(decide(l, CFG, ctx({ now: T0 + 5000, liveRootPids: new Set() })), [], "inside the grace: wait");
  const acts = decide(l, CFG, ctx({ now: T0 + 1000 + CFG.killGraceMs, liveRootPids: new Set() }));
  assert.deepEqual(acts.map((a) => [a.signal, a.reason, a.group, a.pids]), [["SIGKILL", "escalate", 220, [220, 221, 222]]]);
});

test("per-tick cap: at most maxSignals kill(2) calls, the rest wait for the next tick", () => {
  const procs: Proc[] = [DAEMON, CLI];
  for (let i = 0; i < 30; i++) procs.push(P({ pid: 1000 + i, ppid: 200, pgid: 200 }));
  const l = ledgerWith([
    { procs, roots: [root()], now: T0 },
    { procs: [DAEMON, ...procs.slice(2).map((p) => ({ ...p, ppid: 1 }))], roots: [], now: T0 + 1000 },
  ]);
  const acts = decide(l, { ...CFG, maxSignals: 7 }, ctx({ now: T0 + 1000, liveRootPids: new Set() }));
  assert.equal(acts.length, 7);
});

// ───────────────────────────── rule 2: orphans of a live owner ─────────────────────────────

function orphanedChrome(): ProcLedger {
  // vitest (210) died while the terminal lives on; its detached Chrome is now PPID 1.
  return ledgerWith([
    { procs: tree(), roots: [root()], now: T0 },
    { procs: [DAEMON, CLI, ...tree().slice(3).map((p) => (p.pid === 220 ? { ...p, ppid: 1 } : p))], roots: [root()], now: T0 + 1000 },
  ]);
}

test("orphan: a leak-family orphan dies as a group once orphaned past the grace — not before", () => {
  const l = orphanedChrome();
  l.entries.get(220)!.cls = "leak";
  assert.deepEqual(decide(l, CFG, ctx({ now: T0 + 1000 + CFG.orphanGraceMs - 1 })), []);
  const acts = decide(l, CFG, ctx({ now: T0 + 1000 + CFG.orphanGraceMs }));
  assert.deepEqual(acts.map((a) => [a.reason, a.group, a.pids]), [["orphan", 220, [220, 221, 222]]]);
});

test("orphan: one that is not leak-family (a backgrounded dev server) waits for its owner to end", () => {
  const l = orphanedChrome();
  l.entries.get(220)!.cls = "keep";
  assert.deepEqual(decide(l, CFG, ctx({ now: T0 + 10 * 3_600_000 })), []);
});

test("orphan: not its group's leader → the orphan and what it owns below it, pid by pid", () => {
  const procs = [DAEMON, CLI, P({ pid: 210, ppid: 200, pgid: 200 }), P({ pid: 211, ppid: 210, pgid: 200, comm: "workerd" }), P({ pid: 212, ppid: 211, pgid: 200 })];
  const l = ledgerWith([
    { procs, roots: [root()], now: T0 },
    { procs: [DAEMON, CLI, { ...procs[3], ppid: 1 }, procs[4]], roots: [root()], now: T0 + 1000 },
  ]);
  l.entries.get(211)!.cls = "leak";
  const acts = decide(l, { ...CFG, orphanGraceMs: 0 }, ctx({ now: T0 + 1000 }));
  // Group 200 also holds the live CLI (a live root): no group signal.
  assert.deepEqual(acts.map((a) => [a.group, a.pids]).sort(), [[null, [211]], [null, [212]]]);
});

// ───────────────────────────── the driver ─────────────────────────────

const two = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const lstart = (ms: number) => {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`;
};
const psText = (procs: Proc[]) =>
  procs.map((p) => `${p.pid} ${p.ppid} ${p.pgid} ${p.uid} ${p.rssKb} ${p.cpu.toFixed(1)} ${lstart(p.startMs)}     ${p.comm}`).join("\n");

function harness(cfg: Partial<ReaperConfig> = {}) {
  const w = {
    now: T0,
    procs: tree(),
    roots: [root()] as Root[],
    signals: [] as Array<[number, string]>,
    events: [] as ReapEvent[],
    logs: [] as string[],
    psCalls: 0,
    /** Start times the last-moment re-check sees; default = the snapshot's. */
    startsOverride: null as Map<number, number> | null,
  };
  const deps: ReaperDeps = {
    roots: () => w.roots,
    ps: async () => { w.psCalls++; return psText(w.procs); },
    starts: async (pids) => w.startsOverride ?? new Map(w.procs.filter((p) => pids.includes(p.pid)).map((p) => [p.pid, p.startMs])),
    args: async (pids) => new Map(pids.map((p) => [p, "node /r/node_modules/vitest/dist/workers/forks.js"])),
    signal: (t, s) => { w.signals.push([t, s]); return true; },
    onReap: (e) => w.events.push(e),
    log: (l) => w.logs.push(l),
    now: () => w.now,
    selfPid: SELF,
    uid: 501,
  };
  return { w, r: new Reaper({ ...CFG, ...cfg }, deps) };
}

test("driver: terminal ends → group SIGTERM, event + log line, then SIGKILL after the grace if still there", async () => {
  const { w, r } = harness();
  await r.tick();
  assert.deepEqual(w.signals, []);
  w.now += 10_000;
  w.roots = [];
  w.procs = [DAEMON, ...tree().slice(3).map((p) => (p.pid === 220 ? { ...p, ppid: 1 } : p))];
  await r.tick();
  assert.deepEqual(w.signals, [[-220, "SIGTERM"]]);
  assert.equal(w.events.length, 1);
  assert.deepEqual(
    { ...w.events[0], owner: w.events[0].owner },
    { signal: "SIGTERM", reason: "session_ended", dry: false, pid: 220, group: 220, count: 3, rssMb: 400, cmd: tree()[3].comm, owner: { kind: "session", id: "sess-1", workspaceId: "ws-a" } },
  );
  assert.match(w.logs.at(-1)!, /SIGTERM group 220 — 3 procs, 400 MB — session sess-1 \(ws ws-a\): session ended — Google Chrome for Testing$/);
  assert.equal(r.reapedByWs.get("ws-a"), 3);
  // Next tick inside the grace: nothing new.
  w.now += 5_000;
  await r.tick();
  assert.equal(w.signals.length, 1);
  // Past the grace and Chrome ignored it.
  w.now += 5_000;
  await r.tick();
  assert.deepEqual(w.signals.at(-1), [-220, "SIGKILL"]);
  assert.equal(w.events.at(-1)?.reason, "escalate");
  assert.equal(r.reapedByWs.get("ws-a"), 3, "an escalation is not a second reap");
});

test("driver: a target whose start time moved since the snapshot is not signalled (pid reuse)", async () => {
  const { w, r } = harness();
  await r.tick();
  w.roots = [];
  w.procs = [DAEMON, ...tree().slice(3)];
  w.startsOverride = new Map([[220, T0 + 999_000], [221, T0 + 3000], [222, T0 + 3000]]);
  await r.tick();
  assert.deepEqual(w.signals, []);
});

test("driver: the re-check failing means nothing is signalled this tick", async () => {
  const { w, r } = harness();
  (r as any).deps.starts = async () => null;
  await r.tick();
  w.roots = [];
  w.procs = [DAEMON, ...tree().slice(3)];
  await r.tick();
  assert.deepEqual(w.signals, []);
  assert.match(w.logs.at(-1)!, /could not re-check/);
});

test("driver: dry mode decides, logs and publishes each target ONCE, and never signals", async () => {
  const { w, r } = harness({ mode: "dry" });
  await r.tick();
  w.roots = [];
  w.procs = [DAEMON, ...tree().slice(3)];
  await r.tick();
  await r.tick();
  w.now += 60_000;
  await r.tick();
  assert.deepEqual(w.signals, []);
  assert.equal(w.events.length, 1);
  assert.equal(w.events[0].dry, true);
  assert.match(w.logs[0], /^\(dry\) would send SIGTERM group 220/);
});

test("driver: orphan rule end to end — a vitest worker orphan is classified by argv and reaped after the grace", async () => {
  const { w, r } = harness({ orphanGraceMs: 30_000 });
  const worker = P({ pid: 230, ppid: 210, pgid: 230, startMs: T0 + 1000, comm: "/opt/homebrew/bin/node" });
  w.procs = [...tree(), worker];
  await r.tick();
  w.procs = [DAEMON, CLI, { ...worker, ppid: 1 }];
  w.now += 1000;
  await r.tick();
  assert.equal(r.ledger.entries.get(230)?.cls, "leak");
  assert.deepEqual(w.signals, []);
  w.now += 30_000;
  await r.tick();
  assert.deepEqual(w.signals, [[-230, "SIGTERM"]]);
  assert.equal(w.events[0].reason, "orphan");
});

test("driver: idle (no roots, nothing owned) costs no ps at all; off mode never samples", async () => {
  const idle = harness();
  idle.w.roots = [];
  await idle.r.tick();
  assert.equal(idle.w.psCalls, 0);
  const off = harness({ mode: "off" });
  await off.r.tick();
  assert.equal(off.w.psCalls, 0);
});

// ───────────────────────────── GET /machine's view ─────────────────────────────

test("procsView: admin sees every workspace; a workspace token sees only its own rows", async () => {
  const { w, r } = harness();
  w.roots = [root(), root({ id: "sess-2", pid: 700, workspaceId: "ws-b" })];
  w.procs = [...tree(), P({ pid: 700, ppid: SELF, pgid: 700, startMs: T0, rssKb: 50 * 1024 })];
  await r.tick();
  const all = procsView(null, r);
  assert.equal(all.mode, "on");
  assert.deepEqual(all.workspaces.map((x) => [x.workspace_id, x.pids, x.rss_mb]), [["ws-a", 5, 402], ["ws-b", 1, 50]]);
  const mine = procsView("ws-b", r);
  assert.deepEqual(mine.owners.map((o) => o.id), ["sess-2"]);
  assert.deepEqual(mine.workspaces.map((x) => x.workspace_id), ["ws-b"]);
  assert.equal(procsView("ws-c", r).owners.length, 0);
  assert.equal(procsView(null, null).mode, "off");
});

// ───────────────────────────── one real process tree ─────────────────────────────

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(fn: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return fn();
}

test("real processes: an orphaned `sleep` under a live root is reaped; the root and strangers are not", { skip: process.platform !== "darwin" }, async () => {
  // root sh → middle sh → sleep. Killing the middle orphans the sleep (PPID 1) while the root lives.
  // The root's own foreground sleep keeps it alive after the middle dies (a bare `wait` would return).
  const rootProc = spawn("/bin/sh", ["-c", '/bin/sh -c "/bin/sleep 300 & wait" & /bin/sleep 300; :'], { detached: true, stdio: "ignore" });
  const stranger = spawn("/bin/sleep", ["300"], { detached: true, stdio: "ignore" });
  const rootPid = rootProc.pid!;
  try {
    const cfg: ReaperConfig = { ...CFG, orphanGraceMs: 0, killGraceMs: 2000, leakFamily: /^sleep$/ };
    const roots: Root[] = [{ kind: "session", id: "it", pid: rootPid, startedAt: Date.now(), workspaceId: null }];
    const r = new Reaper(cfg, { ...systemReaperDeps(), roots: () => roots, log: () => {} });
    // Wait until the whole chain exists and the ledger owns it.
    let sleepPid = 0, middlePid = 0;
    assert.ok(await (async () => {
      for (let i = 0; i < 80; i++) {
        await r.tick();
        middlePid = r.ledger.children.get(rootPid)?.find((p) => r.ledger.entries.has(p)) ?? 0;
        sleepPid = (middlePid && r.ledger.children.get(middlePid)?.find((p) => r.ledger.entries.has(p))) || 0;
        if (sleepPid) return true;
        await new Promise((res) => setTimeout(res, 25));
      }
      return false;
    })(), "ledger adopted root → middle → sleep");
    assert.equal(r.ledger.entries.has(stranger.pid!), false);
    process.kill(middlePid, "SIGKILL");
    assert.ok(await until(() => { try { return !alive(middlePid); } catch { return true; } }));
    // Tick until the reaper has seen the orphan and signalled it.
    assert.ok(await (async () => {
      for (let i = 0; i < 80; i++) {
        await r.tick();
        if (!alive(sleepPid)) return true;
        await new Promise((res) => setTimeout(res, 25));
      }
      return false;
    })(), "orphaned sleep was reaped");
    assert.ok(alive(rootPid), "the live root is never touched");
    assert.ok(alive(stranger.pid!), "a process the ledger does not own is never touched");
  } finally {
    try { process.kill(-rootPid, "SIGKILL"); } catch {}
    try { process.kill(stranger.pid!, "SIGKILL"); } catch {}
  }
});
