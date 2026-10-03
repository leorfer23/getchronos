import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { ProcLedger, type Proc, type Root } from "./ledger.js";
import { fixtureProc as P, Reaper, reaperConfigFromEnv, parseStarts, type ReaperDeps } from "./reaper.js";
import {
  Ladder, ladderConfigFromEnv, parseLadderMode, parseStatStarts, stillStopped,
  type LadderConfig, type LadderDeps, type LadderEvent, type LadderMode, type MachineReading,
} from "./ladder.js";

const SELF = 100;
const T0 = Date.parse("Fri Oct 2 10:00:00 2026");
const RCFG = { ...reaperConfigFromEnv({}), mode: "on" as const };
const LCFG: LadderConfig = { ...ladderConfigFromEnv({}), mode: "on" };
const MB = 1024; // rssKb per MB
const CALM: MachineReading = { loadPerCore: 0.5, ncpu: 4, pressureLevel: 1 };
const WARNING: MachineReading = { loadPerCore: 0.5, ncpu: 4, pressureLevel: 2 };
const CRITICAL: MachineReading = { loadPerCore: 3, ncpu: 4, pressureLevel: 4 };

const DAEMON = P({ pid: SELF, ppid: 1, pgid: SELF, startMs: T0 - 86_400_000, comm: "/usr/local/bin/node" });
const CLAUDE = "/opt/homebrew/bin/claude";
const CHROME = "/c/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

/**
 * ws-a, two terminals:  sa1: claude 200 → zsh 210 → node vitest 220 (2 GB, 300%) → Chrome 230 (1 GB)
 *                       sa2: claude 300 → tsc 310 (500 MB, 100%)
 * ws-b, one terminal:   sb1: claude 400 → node dev server 410 (100 MB)
 * On an 8 GB, 4-core Mac: capacity 5 GB / 400%; two active workspaces → 2.5 GB / 200% each.
 * ws-a holds ~3.5 GB and 400% CPU: over on both. ws-b is far under.
 */
const scene = (): Proc[] => [
  DAEMON,
  P({ pid: 200, ppid: SELF, pgid: 200, startMs: T0, comm: CLAUDE }),
  P({ pid: 210, ppid: 200, pgid: 210, startMs: T0 + 1000, comm: "/bin/zsh" }),
  P({ pid: 220, ppid: 210, pgid: 210, startMs: T0 + 2000, comm: "/opt/homebrew/bin/node", rssKb: 2048 * MB, cpu: 300 }),
  P({ pid: 230, ppid: 220, pgid: 230, startMs: T0 + 3000, comm: CHROME, rssKb: 1024 * MB }),
  P({ pid: 300, ppid: SELF, pgid: 300, startMs: T0, comm: CLAUDE }),
  P({ pid: 310, ppid: 300, pgid: 300, startMs: T0 + 4000, comm: "/r/node_modules/.bin/tsc", rssKb: 500 * MB, cpu: 100 }),
  P({ pid: 400, ppid: SELF, pgid: 400, startMs: T0, comm: CLAUDE }),
  P({ pid: 410, ppid: 400, pgid: 400, startMs: T0 + 1000, comm: "/opt/homebrew/bin/node", rssKb: 100 * MB }),
];
const ROOTS: Root[] = [
  { kind: "session", id: "sa1-0000", pid: 200, startedAt: T0, workspaceId: "ws-a" },
  { kind: "session", id: "sa2-0000", pid: 300, startedAt: T0, workspaceId: "ws-a" },
  { kind: "session", id: "sb1-0000", pid: 400, startedAt: T0, workspaceId: "ws-b" },
];
const ARGV: Record<number, string> = {
  200: "claude", 210: "/bin/zsh -c npx vitest run", 220: "node /r/node_modules/vitest/vitest.mjs run",
  230: `${CHROME} --headless`, 300: "claude", 310: "node /r/node_modules/.bin/tsc -b", 400: "claude", 410: "node /r/node_modules/.bin/vite --port 5173",
};

function harness(o: { cfg?: Partial<LadderConfig>; mode?: LadderMode; procs?: Proc[]; roots?: Root[]; argv?: Record<number, string> } = {}) {
  const w = {
    now: T0,
    procs: o.procs ?? scene(),
    roots: o.roots ?? ROOTS.slice(),
    argv: { ...ARGV, ...(o.argv ?? {}) } as Record<number, string>,
    argvFails: false,
    load: CALM,
    mode: o.mode ?? ("on" as LadderMode),
    weights: {} as Record<string, number>,
    nice: new Map<number, number>(),
    /** macOS: an unprivileged process may raise nice but never lower it. */
    denyLower: false,
    signals: [] as Array<[number, string]>,
    told: [] as Array<{ to: string; text: string }>,
    events: [] as LadderEvent[],
    logs: [] as string[],
    saved: null as unknown[] | null,
    setNiceCalls: [] as Array<[number[], number]>,
  };
  const ledger = new ProcLedger();
  const deps: LadderDeps = {
    ledger,
    reaper: RCFG,
    mode: () => w.mode,
    load: () => w.load,
    maxLoadPerCore: () => 2.5,
    totalMb: () => 8192,
    slots: () => ({ size: 2, held: new Map() }),
    weightOf: (ws) => (ws ? w.weights[ws] ?? 1 : 1),
    args: async (pids) => (w.argvFails ? null : new Map(pids.filter((p) => w.argv[p] != null).map((p) => [p, w.argv[p]]))),
    starts: async (pids) => new Map(w.procs.filter((p) => pids.includes(p.pid)).map((p) => [p.pid, p.startMs])),
    signal: (pid, sig) => { w.signals.push([pid, sig]); return true; },
    getNice: (pid) => w.nice.get(pid) ?? 10,
    setNice: async (pids, n) => {
      w.setNiceCalls.push([pids, n]);
      const ok = new Set<number>();
      for (const p of pids) {
        if (w.denyLower && n < (w.nice.get(p) ?? 10)) continue;
        w.nice.set(p, n);
        ok.add(p);
      }
      return ok;
    },
    tell: (owner, text) => { w.told.push({ to: owner.id, text }); return null; },
    publish: (e) => w.events.push(e),
    save: (p) => { w.saved = p; },
    wsName: (ws) => ws ?? "-",
    log: (l) => w.logs.push(l),
    now: () => w.now,
    selfPid: SELF,
    uid: 501,
  };
  const ladder = new Ladder({ ...LCFG, ...(o.cfg ?? {}) }, deps);
  /** One daemon tick: the reaper's snapshot, then the ladder's pass on it. */
  const tick = async (advanceMs = 0) => {
    w.now += advanceMs;
    ledger.update(w.procs, w.roots, { selfPid: SELF, now: w.now });
    await ladder.tick();
  };
  return { w, ladder, ledger, tick };
}

const sigs = (w: { signals: Array<[number, string]> }, sig: string) => w.signals.filter(([, s]) => s === sig).map(([p]) => p);
const topics = (w: { events: LadderEvent[] }, t: LadderEvent["topic"]) => w.events.filter((e) => e.topic === t) as any[];

// ───────────────────────────── knobs ─────────────────────────────

test("config: default mode is warn, and every knob parses", () => {
  const d = ladderConfigFromEnv({});
  assert.deepEqual(
    [d.mode, d.slowAfterMs, d.warnEveryMs, d.slowNice, d.maxActions, d.reserveMinMb, d.reservePct],
    ["warn", 120_000, 600_000, 20, 3, 3072, 20],
  );
  const c = ladderConfigFromEnv({
    CHRONOS_LADDER: "ON", CHRONOS_LADDER_SLOW_AFTER_MS: "30000", CHRONOS_LADDER_WARN_EVERY_MS: "5", CHRONOS_LADDER_NICE: "40",
    CHRONOS_LADDER_MAX_ACTIONS: "5", CHRONOS_LADDER_RESERVE_MB: "4096", CHRONOS_LADDER_RESERVE_PCT: "25", CHRONOS_LADDER_HEAVY: "^mytool$",
  });
  assert.deepEqual([c.mode, c.slowAfterMs, c.warnEveryMs, c.slowNice, c.maxActions, c.reserveMinMb, c.reservePct], ["on", 30_000, 60_000, 20, 5, 4096, 25]);
  assert.ok(c.buildTools.test("mytool") && c.buildTools.test("tsc"));
  assert.equal(parseLadderMode("slow"), "slow");
  assert.equal(parseLadderMode("0"), "off");
  assert.equal(parseLadderMode("nonsense"), "warn", "a typo never turns the pause rung on");
  assert.equal(ladderConfigFromEnv({ CHRONOS_LADDER_HEAVY: "(" }).buildTools.test("tsc"), true, "a bad regex keeps the default");
});

// ───────────────────────────── when it acts ─────────────────────────────

test("a calm Mac: over budget costs nobody anything — no warning, no rung", async () => {
  const { w, ladder, tick } = harness();
  await tick();
  await tick(600_000);
  assert.deepEqual(w.told, []);
  assert.deepEqual(w.events, []);
  const a = ladder.wsView("ws-a")!;
  assert.equal(a.over, true);
  assert.equal(a.rung, "ok");
  assert.equal(a.share, 0.5);
  assert.deepEqual(a.budget, { rss_mb: 2560, cpu: 200, slots: 1 });
  assert.equal(a.usage.rss_mb, 3575);
  assert.equal(ladder.wsView("ws-b")!.over, false);
});

test("warn: strained + over → one message to each of ITS live terminals, naming the heaviest with numbers; then not again for 10 min", async () => {
  const { w, ladder, tick } = harness();
  w.load = WARNING;
  await tick();
  assert.deepEqual(w.told.map((t) => t.to).sort(), ["sa1-0000", "sa2-0000"], "ws-b's terminal is not told");
  const sa1 = w.told.find((t) => t.to === "sa1-0000")!.text;
  assert.match(sa1, /Workspace ws-a is over its share of this Mac/);
  assert.match(sa1, /memory pressure warning, load 0\.5\/core/);
  assert.match(sa1, /RAM 3\.5 GB of a 2\.5 GB budget, CPU 400% of 200%/);
  assert.match(sa1, /share 50%, weight 1, 2 workspaces active/);
  assert.match(sa1, /Heaviest: node \(vitest\) 2\.0 GB 300% CPU \(this terminal\), Google Chrome for Testing 1\.0 GB 0% CPU \(this terminal\), tsc 500 MB 100% CPU \(session sa2-0000\)/);
  assert.ok(!sa1.includes("\n"), "one line: a pty would submit half of it");
  const [ev] = topics(w, "budget.warn");
  assert.deepEqual(
    { ws: ev.workspace_id, rss: ev.rss_mb, b: ev.budget_rss_mb, cpu: ev.cpu, bc: ev.budget_cpu, told: ev.told, top: ev.heaviest[0] },
    { ws: "ws-a", rss: 3575, b: 2560, cpu: 400, bc: 200, told: 2, top: { cmd: "node (vitest)", count: 1, rss_mb: 2048, cpu: 300, pid: 220 } },
  );
  assert.equal(ladder.wsView("ws-a")!.rung, "warn");
  await tick(60_000);
  await tick(500_000);
  assert.equal(w.told.length, 2, "at most once per 10 minutes per workspace");
  await tick(40_001);
  assert.equal(w.told.length, 4, "re-sent after 10 minutes");
});

test("the default `warn` mode: only the warning acts — the other rungs log and publish 'would', once per episode", async () => {
  const { w, tick } = harness({ mode: "warn" });
  w.load = WARNING;
  await tick();
  await tick(120_000);
  assert.equal(w.setNiceCalls.length, 0, "never reniced");
  assert.equal(w.logs.filter((l) => l.startsWith("(would renice to 20) ws ws-a")).length, 1);
  const slow = topics(w, "budget.slow");
  assert.equal(slow.length, 1);
  assert.equal(slow[0].dry, true);
  await tick(10_000);
  assert.equal(topics(w, "budget.slow").length, 1, "said once, not every tick");
  w.load = CRITICAL;
  await tick(10_000);
  await tick(10_000);
  assert.deepEqual(w.signals, [], "never SIGSTOPped");
  const pause = topics(w, "budget.pause");
  assert.deepEqual(pause.map((e) => [e.pid, e.dry]), [[310, true], [230, true]], "would pause the newest heavy, one per tick");
  assert.match(w.logs.find((l) => l.startsWith("(would pause)"))!, /pid 310 — tsc, 500 MB, 100% CPU — session sa2-0000 \(ws ws-a\): memory pressure critical, RAM 3\.5 GB \/ 2\.5 GB/);
  assert.match(w.told[0].text, /This Mac only warns for now\./);
});

// ───────────────────────────── the whole ladder, up and down ─────────────────────────────

test("rungs: warn → 2 min → slow → critical → pause (newest first, one per tick) → calm → resume oldest first", async () => {
  const { w, ladder, tick } = harness({ cfg: { maxActions: 2 } });
  w.load = WARNING;
  await tick();
  assert.equal(topics(w, "budget.warn").length, 1);
  await tick(60_000);
  assert.equal(w.setNiceCalls.length, 0, "still inside the 2 minutes");
  await tick(60_000);
  // Slow: the heaviest subtrees, heaviest first (zsh → vitest → Chrome is 3 GB; tsc 500 MB) — never a CLI root.
  assert.deepEqual(w.setNiceCalls, [[[210, 220, 230, 310], 20]]);
  assert.equal(ladder.wsView("ws-a")!.rung, "slow");
  assert.equal(ladder.wsView("ws-a")!.slowed, 4);
  assert.match(w.logs.find((l) => l.startsWith("renice 4 of 4"))!, /to 20 — ws ws-a: over 120s \(RAM 3\.5 GB \/ 2\.5 GB, CPU 400% \/ 200%\) — zsh \(pid 210, 3 procs, 3\.0 GB, 300%\), tsc \(pid 310, 1 proc, 500 MB, 100%\)/);
  for (const p of [200, 300, 400, 410]) assert.notEqual(w.nice.get(p), 20, `pid ${p} untouched`);
  assert.deepEqual(sigs(w, "SIGSTOP"), [], "no pause while pressure is only warning");

  w.load = CRITICAL;
  await tick(10_000);
  await tick(10_000);
  await tick(10_000);
  await tick(10_000);
  assert.deepEqual(sigs(w, "SIGSTOP"), [310, 230, 220], "newest heavy first, one per tick; zsh and the CLI roots never");
  assert.equal(ladder.wsView("ws-a")!.rung, "pause");
  assert.deepEqual(ladder.wsView("ws-a")!.paused, [310, 230, 220]);
  assert.deepEqual((w.saved as any[]).map((p) => p.pid), [310, 230, 220], "mirrored for the next daemon");
  assert.deepEqual(ladder.wsView("ws-b")!.paused, []);

  w.load = CALM;
  await tick(10_000);
  assert.deepEqual(sigs(w, "SIGCONT"), [310, 230], "oldest pause first, capped per tick");
  await tick(10_000);
  assert.deepEqual(sigs(w, "SIGCONT"), [310, 230, 220]);
  assert.deepEqual(w.saved, []);
  assert.deepEqual(topics(w, "budget.resume").filter((e) => e.action === "cont").map((e) => [e.pids[0], e.reason]), [[310, "calm"], [230, "calm"], [220, "calm"]]);
  // The nice values went back to where they were.
  assert.deepEqual(w.setNiceCalls.at(-1), [[210, 220, 230, 310], 10]);
  assert.equal(ladder.wsView("ws-a")!.slowed, 0);
  assert.equal(ladder.wsView("ws-a")!.rung, "ok");
});

test("back under budget (machine still strained) resumes too — and an idle workspace's share is lent", async () => {
  const { w, ladder, tick } = harness({ cfg: { slowAfterMs: 0 } });
  w.load = CRITICAL;
  await tick();
  assert.deepEqual(sigs(w, "SIGSTOP"), [310]);
  // ws-b's terminal ends: its share is lent to ws-a (now 100% → 5 GB / 400%): under budget.
  w.roots = ROOTS.filter((r) => r.workspaceId !== "ws-b");
  w.procs = scene().filter((p) => p.pid !== 400 && p.pid !== 410);
  await tick(10_000);
  assert.equal(ladder.wsView("ws-a")!.share, 1);
  assert.equal(ladder.wsView("ws-a")!.over, false);
  assert.deepEqual(sigs(w, "SIGCONT"), [310]);
  assert.equal(topics(w, "budget.resume").find((e) => e.action === "cont").reason, "under_budget");
});

test("restore: macOS refuses to LOWER nice for an unprivileged daemon — counted and said, never hidden", async () => {
  const { w, tick } = harness({ cfg: { slowAfterMs: 0 } });
  w.denyLower = true;
  w.load = WARNING;
  await tick();
  assert.equal(w.nice.get(220), 20);
  w.load = CALM;
  await tick(10_000);
  const line = w.logs.find((l) => l.startsWith("nice restored"))!;
  assert.match(line, /nice restored on 0 of 4 process\(es\) — ws ws-a: calm — 4 stay at 20 until they exit \(macOS lets only root lower a nice value\)/);
  assert.equal(topics(w, "budget.resume").find((e) => e.action === "nice").denied, 4);
});

// ───────────────────────────── never pause ─────────────────────────────

test("never paused: a CLI root, a shell, an agent CLI, a kept process and anything below it, a protected path, another user, a non-heavy process", async () => {
  const procs: Proc[] = [
    DAEMON,
    P({ pid: 200, ppid: SELF, pgid: 200, startMs: T0, comm: CLAUDE, rssKb: 900 * MB }),
    P({ pid: 210, ppid: 200, pgid: 210, startMs: T0 + 1000, comm: "/bin/zsh", rssKb: 900 * MB }),
    // A background Claude session (keep-list) with a vitest below it.
    P({ pid: 220, ppid: 200, pgid: 220, startMs: T0 + 2000, comm: "/opt/homebrew/bin/node", rssKb: 900 * MB }),
    P({ pid: 221, ppid: 220, pgid: 220, startMs: T0 + 9000, comm: "/opt/homebrew/bin/node", rssKb: 900 * MB }),
    // Leo's own Chrome (protected), and a Chrome of another user.
    P({ pid: 230, ppid: 200, pgid: 230, startMs: T0 + 9100, comm: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", rssKb: 900 * MB }),
    P({ pid: 240, ppid: 200, pgid: 240, startMs: T0 + 9200, uid: 0, comm: CHROME, rssKb: 900 * MB }),
    // A nested agent CLI and a dev server: not heavy.
    P({ pid: 250, ppid: 210, pgid: 210, startMs: T0 + 9300, comm: "/opt/homebrew/bin/codex", rssKb: 900 * MB }),
    P({ pid: 260, ppid: 210, pgid: 210, startMs: T0 + 9400, comm: "/usr/bin/python3", rssKb: 900 * MB }),
  ];
  const roots: Root[] = [{ kind: "session", id: "sa1-0000", pid: 200, startedAt: T0, workspaceId: "ws-a" }];
  const { w, tick } = harness({
    procs, roots, cfg: { slowAfterMs: 0 },
    argv: { 220: "claude --bg-pty-host --resume abc", 221: "node /r/node_modules/vitest/vitest.mjs", 250: "codex", 260: "python3 -m http.server" },
  });
  w.load = CRITICAL;
  for (let i = 0; i < 4; i++) await tick(10_000);
  assert.deepEqual(sigs(w, "SIGSTOP"), [], "nothing on this list is ever paused");
  for (const p of [200, 220, 221, 230, 240]) assert.ok(!w.setNiceCalls.some(([ps]) => ps.includes(p)), `pid ${p} never reniced`);
  // Add one real build tool: it is the one paused.
  w.procs = [...procs, P({ pid: 270, ppid: 210, pgid: 210, startMs: T0 + 9500, comm: "/r/node_modules/@esbuild/darwin-arm64/bin/esbuild", rssKb: 300 * MB })];
  w.argv[270] = "esbuild --service";
  await tick(10_000);
  assert.deepEqual(sigs(w, "SIGSTOP"), [270]);
});

test("an unreadable argv chain is a veto: nothing paused or reniced that tick", async () => {
  const { w, tick } = harness({ cfg: { slowAfterMs: 0 } });
  w.argvFails = true;
  w.load = CRITICAL;
  await tick();
  assert.deepEqual(w.signals, []);
  assert.deepEqual(w.setNiceCalls, []);
  assert.ok(w.logs.some((l) => /could not read argv .* nothing reniced this tick/.test(l)));
  w.argvFails = false;
  await tick(10_000);
  assert.deepEqual(sigs(w, "SIGSTOP"), [310]);
});

test("a recycled pid is never signalled: the start time is re-read right before SIGSTOP", async () => {
  const { w, ladder, tick } = harness({ cfg: { slowAfterMs: 0 } });
  w.load = CRITICAL;
  const d = (ladder as any).deps as LadderDeps;
  const real = d.starts;
  d.starts = async (pids) => new Map(pids.map((p) => [p, p === 310 ? T0 + 99_000 : (w.procs.find((x) => x.pid === p)?.startMs ?? 0)]));
  await tick();
  assert.deepEqual(sigs(w, "SIGSTOP"), []);
  d.starts = real;
});

// ───────────────────────────── releasing: owner end, reaper, off, exit ─────────────────────────────

test("SIGCONT before the reaper's SIGTERM: a stopped process would never handle it", async () => {
  // The real driver: Reaper ticks, the ladder rides its afterTick, the reaper calls beforeSignal.
  const two = (n: number) => String(n).padStart(2, "0");
  const D = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const lstart = (ms: number) => { const d = new Date(ms); return `${D[d.getDay()]} ${M[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`; };
  const psText = (procs: Proc[]) => procs.map((p) => `${p.pid} ${p.ppid} ${p.pgid} ${p.uid} ${p.rssKb} ${p.cpu.toFixed(1)} ${lstart(p.startMs)}     ${p.comm}`).join("\n");

  const { w, ladder } = harness({ cfg: { slowAfterMs: 0 } });
  w.load = CRITICAL;
  const rdeps: ReaperDeps = {
    roots: () => w.roots,
    ps: async () => psText(w.procs),
    starts: async (pids) => new Map(w.procs.filter((p) => pids.includes(p.pid)).map((p) => [p.pid, p.startMs])),
    args: async (pids) => new Map(pids.filter((p) => ARGV[p]).map((p) => [p, ARGV[p]])),
    signal: (t, s) => { w.signals.push([t, s]); return true; },
    beforeSignal: (pids) => ladder.beforeReap(pids),
    afterTick: () => ladder.tick(),
    log: () => {},
    now: () => w.now,
    selfPid: SELF,
    uid: 501,
  };
  const reaper = new Reaper(RCFG, rdeps);
  // The ladder must read the reaper's own ledger.
  (ladder as any).deps.ledger = reaper.ledger;
  await reaper.tick();
  w.now += 10_000;
  await reaper.tick();
  w.now += 10_000;
  await reaper.tick();
  assert.deepEqual(sigs(w, "SIGSTOP"), [310, 230, 220], "tsc, Chrome, vitest paused");
  // Terminal sa1 closes: its CLI is gone, zsh is adopted by launchd (spared: it is not leak-family),
  // and the paused vitest and Chrome below it are leak-family → the reaper SIGTERMs them.
  w.now += 10_000;
  w.roots = ROOTS.filter((r) => r.id !== "sa1-0000");
  w.procs = scene().filter((p) => p.pid !== 200).map((p) => (p.pid === 210 ? { ...p, ppid: 1 } : p));
  await reaper.tick();
  for (const pid of [220, 230]) {
    const cont = w.signals.findIndex(([p, s]) => p === pid && s === "SIGCONT");
    const term = w.signals.findIndex(([p, s]) => (p === pid || p === -pid) && s === "SIGTERM");
    assert.ok(cont >= 0 && term >= 0, `both sent to ${pid}: ${JSON.stringify(w.signals)}`);
    assert.ok(cont < term, `SIGCONT before SIGTERM for ${pid}`);
  }
  assert.deepEqual(ladder.paused.map((p) => p.pid), [310], "tsc (other terminal, still live) stays paused");
  assert.deepEqual(topics(w, "budget.resume").map((e) => [e.pids[0], e.reason]).sort(), [[220, "reaped"], [230, "reaped"]]);
});

test("owner ended but its paused process was spared by the reaper: SIGCONT anyway", async () => {
  const { w, ladder, tick } = harness({ cfg: { slowAfterMs: 0 } });
  w.load = CRITICAL;
  await tick();
  assert.deepEqual(ladder.paused.map((p) => p.pid), [310]);
  w.roots = ROOTS.filter((r) => r.id !== "sa2-0000");
  w.procs = scene().filter((p) => p.pid !== 300).map((p) => (p.pid === 310 ? { ...p, ppid: 1 } : p));
  await tick(10_000);
  assert.deepEqual(sigs(w, "SIGCONT"), [310]);
  assert.equal(topics(w, "budget.resume")[0].reason, "owner_ended");
});

test("switching the ladder off releases everything on the next tick", async () => {
  const { w, ladder, tick } = harness({ cfg: { slowAfterMs: 0 } });
  w.load = CRITICAL;
  await tick();
  await tick(10_000);
  assert.deepEqual(sigs(w, "SIGSTOP"), [310, 230]);
  w.mode = "off";
  await tick(10_000);
  assert.deepEqual(sigs(w, "SIGCONT"), [310, 230]);
  assert.equal(ladder.paused.length, 0);
  assert.deepEqual(w.setNiceCalls.at(-1)?.[1], 10, "nice restored");
  assert.ok(topics(w, "budget.resume").every((e) => e.reason === "disabled"));
  assert.equal(ladder.view().mode, "off");
  await tick(10_000);
  assert.deepEqual(sigs(w, "SIGSTOP"), [310, 230], "and stays off");
});

test("daemon exit: everything paused gets SIGCONT synchronously; a pid whose start moved is left alone", async () => {
  const { w, ladder, tick } = harness({ cfg: { slowAfterMs: 0 } });
  w.load = CRITICAL;
  await tick();
  await tick(10_000);
  const n = ladder.resumeAllSync("shutdown", (pids) => new Map(pids.map((p) => [p, p === 230 ? 1 : w.procs.find((x) => x.pid === p)!.startMs])));
  assert.equal(n, 1);
  assert.deepEqual(sigs(w, "SIGCONT"), [310]);
  assert.deepEqual(w.saved, []);
  assert.equal(ladder.paused.length, 0);
  // No re-check available at all: SIGCONT anyway (left stopped forever is the worse failure).
  const h = harness({ cfg: { slowAfterMs: 0 } });
  h.w.load = CRITICAL;
  await h.tick();
  assert.equal(h.ladder.resumeAllSync("shutdown", () => null), 1);
  assert.deepEqual(sigs(h.w, "SIGCONT"), [310]);
});

test("weights: a weight-3 workspace next to a weight-1 one gets 75% of the machine", async () => {
  const { w, ladder, tick } = harness();
  w.weights["ws-a"] = 3;
  await tick();
  const a = ladder.wsView("ws-a")!;
  assert.equal(a.weight, 3);
  assert.equal(a.share, 0.75);
  assert.deepEqual(a.budget, { rss_mb: 3840, cpu: 300, slots: 1 });
  assert.equal(ladder.wsView("ws-b")!.share, 0.25);
  // A workspace with nothing live shows what it WOULD get.
  const c = ladder.wsView("ws-c")!;
  assert.equal(c.active, false);
  assert.equal(c.share, 0.2);
});

// ───────────────────────────── boot recovery ─────────────────────────────

test("boot: only a recorded pid that is STILL stopped and still the same process gets SIGCONT", () => {
  const ps = parseStatStarts("  310 T    Fri Oct  2 10:00:04 2026\n  230 S    Fri Oct  2 10:00:03 2026\n  220 T+   Fri Oct  2 11:11:11 2026\n");
  assert.deepEqual(
    stillStopped([{ pid: 310, startMs: T0 + 4000 }, { pid: 230, startMs: T0 + 3000 }, { pid: 220, startMs: T0 + 2000 }, { pid: 999, startMs: T0 }], ps),
    [310],
    "230 is running, 220 is a different process now, 999 is gone",
  );
});

test("real process: a stopped `sleep` reads as state T to the boot check, and not after SIGCONT", { skip: process.platform !== "darwin" }, () => {
  const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  const pid = child.pid!;
  const ps = () => execFileSync("/bin/ps", ["-o", "pid=,stat=,lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  try {
    const startMs = parseStarts(execFileSync("/bin/ps", ["-o", "pid=,lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } })).get(pid)!;
    assert.ok(Number.isFinite(startMs));
    process.kill(pid, "SIGSTOP");
    let stopped: number[] = [];
    for (let i = 0; i < 40 && !stopped.length; i++) stopped = stillStopped([{ pid, startMs }], parseStatStarts(ps()));
    assert.deepEqual(stopped, [pid]);
    process.kill(pid, "SIGCONT");
    let running = [pid];
    for (let i = 0; i < 40 && running.length; i++) running = stillStopped([{ pid, startMs }], parseStatStarts(ps()));
    assert.deepEqual(running, []);
  } finally {
    child.kill("SIGKILL");
  }
});

// ───────────────────────────── the surface ─────────────────────────────

test("GET /machine procs: each workspace's weight, share, budget, usage, rung and paused pids — a workspace token sees only its own line", async () => {
  const { procsView } = await import("./brain.js");
  const two = (n: number) => String(n).padStart(2, "0");
  const D = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const lstart = (ms: number) => { const d = new Date(ms); return `${D[d.getDay()]} ${M[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`; };
  const { w, ladder } = harness({ cfg: { slowAfterMs: 0 } });
  w.load = CRITICAL;
  const reaper = new Reaper(RCFG, {
    roots: () => w.roots,
    ps: async () => w.procs.map((p) => `${p.pid} ${p.ppid} ${p.pgid} ${p.uid} ${p.rssKb} ${p.cpu.toFixed(1)} ${lstart(p.startMs)}     ${p.comm}`).join("\n"),
    starts: async (pids) => new Map(w.procs.filter((p) => pids.includes(p.pid)).map((p) => [p.pid, p.startMs])),
    args: async (pids) => new Map(pids.filter((p) => ARGV[p]).map((p) => [p, ARGV[p]])),
    signal: (t, s) => { w.signals.push([t, s]); return true; },
    beforeSignal: (pids) => ladder.beforeReap(pids),
    afterTick: () => ladder.tick(),
    log: () => {}, now: () => w.now, selfPid: SELF, uid: 501,
  });
  (ladder as any).deps.ledger = reaper.ledger;
  await reaper.tick();
  const all = procsView(null, reaper, ladder);
  assert.equal(all.ladder?.mode, "on");
  assert.equal(all.ladder?.critical, true);
  assert.deepEqual(all.ladder?.capacity, { rss_mb: 5120, cpu: 400, slots: 2 });
  const a = all.workspaces.find((x) => x.workspace_id === "ws-a")!;
  assert.deepEqual(
    { weight: a.weight, share: a.share, budget: a.budget, usage: a.usage, over: a.over, rung: a.rung, paused: a.paused },
    { weight: 1, share: 0.5, budget: { rss_mb: 2560, cpu: 200, slots: 1 }, usage: { rss_mb: 3575, cpu: 400, slots: 0 }, over: true, rung: "pause", paused: [310] },
  );
  const mine = procsView("ws-b", reaper, ladder);
  assert.deepEqual(mine.workspaces.map((x) => x.workspace_id), ["ws-b"], "never another workspace's line");
  assert.ok(mine.owners.every((o) => o.workspace_id === "ws-b"));
  assert.equal(mine.workspaces[0].over, false);
  assert.deepEqual(mine.workspaces[0].paused, []);
  ladder.resumeAllSync("shutdown", () => null);
});

test("slow: a subtree already at the slow value (born under a slowed parent) does not take a turn from a heavier one", async () => {
  const { w, tick } = harness({ cfg: { slowAfterMs: 0, maxActions: 1 } });
  for (const p of [210, 220, 230]) w.nice.set(p, 20);
  w.load = WARNING;
  await tick();
  assert.deepEqual(w.setNiceCalls, [[[310], 20]], "the zsh subtree is heavier but already at 20: tsc gets the one turn");
});
