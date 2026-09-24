/**
 * The machine governor: the daemon's three defences against its own fleet eating the Mac.
 *
 * Measured 2026-09-18 on the operator's 12-core / 18 GB Mac with ~20 live Desk terminals: load
 * average 32-38, swap 12.9 GB of 13.3 GB, 21 claude CLIs at 250% CPU, 90 vitest/workerd processes at
 * 168%, 13 tsc/esbuild at 34%. The Desk itself was NOT the cost (webview 9%, WindowServer 7.6%,
 * daemon 3.5%) — the UI was simply losing a fair fight, because every agent CLI ran at nice 0.
 *
 *  1. `niceWrap` — every agent process starts below the UI, so the webview and the daemon win the
 *     CPU under oversubscription. Children (vitest, tsc, workerd) inherit the value.
 *  2. `admission` — an AGENT may not open a terminal onto a saturated machine. The operator always may.
 *  3. Heavy slots — full test suites are serialized machine-wide (`mc heavy -- <cmd>`), so five
 *     agents cannot each run a full vitest pool at the same moment.
 */
import os from "node:os";
import fs from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CONFIG } from "./config.js";
import { bus } from "./bus.js";

// ───────────────────────────── 1. nice: agents below the UI ─────────────────────────────

const NICE = "/usr/bin/nice";
let niceWarned = false;

/**
 * Wrap a spawn so the child (and everything it forks) runs at `CONFIG.agentNice`.
 *
 * `nice` is applied by WRAPPING the command rather than by `os.setPriority` after the spawn: it
 * lands before `exec`, so there is no window in which a CLI is already competing at nice 0, and it
 * survives node-pty's spawn-helper the same way it survives `sandbox-exec` — `nice` execs
 * `sandbox-exec`, which execs the real binary, and the priority is inherited the whole way down
 * (verified with `ps -o nice`). Deliberately NOT `taskpolicy -b`: background QoS clamps to the
 * E-cores and throttles I/O, which would cripple the agents rather than deprioritize them.
 *
 * A no-op when the knob is 0 or `nice` is not on this machine — this must never be the reason a
 * terminal fails to open.
 */
export function niceWrap(cmd: string, args: string[], n = CONFIG.agentNice): { cmd: string; cmdArgs: string[] } {
  if (!Number.isFinite(n) || n === 0) return { cmd, cmdArgs: args };
  if (process.platform !== "darwin" && process.platform !== "linux") return { cmd, cmdArgs: args };
  try {
    if (!niceAvailable()) {
      if (!niceWarned) { niceWarned = true; console.warn(`[machine] ${NICE} unavailable — agents run at the daemon's priority`); }
      return { cmd, cmdArgs: args };
    }
  } catch {
    return { cmd, cmdArgs: args };
  }
  return niceCommand(cmd, args, n);
}

/** The wrapping itself, with no probing — what the tests assert on. */
export function niceCommand(cmd: string, args: string[], n: number): { cmd: string; cmdArgs: string[] } {
  if (!Number.isFinite(n) || n === 0) return { cmd, cmdArgs: args };
  // Clamped to the range nice(1) accepts; a negative value would need root and is never what we want.
  const level = Math.max(0, Math.min(20, Math.round(n)));
  return { cmd: NICE, cmdArgs: ["-n", String(level), cmd, ...args] };
}

let niceOk: boolean | null = null;
function niceAvailable(): boolean {
  if (niceOk === null) niceOk = fs.existsSync(NICE);
  return niceOk;
}

// ───────────────────────────── 2. admission: how loaded is this Mac ─────────────────────────────

/** macOS `kern.memorystatus_vm_pressure_level`. 1 normal · 2 warning · 4 critical. */
export type PressureLevel = 1 | 2 | 4;

export type MachineLoad = {
  load1: number;
  ncpu: number;
  loadPerCore: number;
  /** null off darwin (no cheap probe elsewhere) — the memory rule is then simply not applied. */
  swapUsedMb: number | null;
  swapTotalMb: number | null;
  pressureLevel: PressureLevel | null;
};

type Memory = { swap: { usedMb: number; totalMb: number } | null; pressureLevel: PressureLevel | null };
let memCache: { at: number; value: Memory } = { at: 0, value: { swap: null, pressureLevel: null } };
const MEM_TTL_MS = 5000;

export const pressureWord = (p: PressureLevel | null): string =>
  p === 4 ? "critical" : p === 2 ? "warning" : p === 1 ? "normal" : "unknown";

/**
 * Parse the two sysctls we ask for in one call:
 *   `total = 4096.00M  used = 2949.69M  free = 1146.31M  (encrypted)`
 *   `1`
 *
 * Swap USED% on its own is not a health signal on macOS. The swapfile is dynamically sized, and the
 * kernel does not eagerly swap pages back in, so a small mostly-full swapfile is the normal resting
 * state of a calm Mac: measured here at 73% used with pressure 1 and plenty of memory free. Only
 * `memorystatus_vm_pressure_level` says whether the machine is actually short of memory.
 */
export function parseMemorySysctl(out: string): Memory {
  const mb = (label: string) => {
    const m = new RegExp(`${label}\\s*=\\s*([0-9.]+)([KMG])`, "i").exec(out);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    return m[2].toUpperCase() === "G" ? n * 1024 : m[2].toUpperCase() === "K" ? n / 1024 : n;
  };
  const totalMb = mb("total");
  const usedMb = mb("used");
  const lvl = Number(out.trim().split("\n").pop()?.trim());
  return {
    swap: totalMb == null || usedMb == null ? null : { totalMb, usedMb },
    pressureLevel: lvl === 1 || lvl === 2 || lvl === 4 ? (lvl as PressureLevel) : null,
  };
}

/** Never throws: a probe that cannot answer reads as "no memory information", not as a refusal. */
function memory(): Memory {
  if (process.platform !== "darwin") return { swap: null, pressureLevel: null };
  const now = Date.now();
  if (now - memCache.at < MEM_TTL_MS) return memCache.value;
  let value: Memory = { swap: null, pressureLevel: null };
  try {
    // ONE fork for both: this runs on the daemon's event loop on every admission check.
    value = parseMemorySysctl(
      execFileSync("/usr/sbin/sysctl", ["-n", "vm.swapusage", "kern.memorystatus_vm_pressure_level"], { encoding: "utf8", timeout: 2000 }),
    );
  } catch {
    value = { swap: null, pressureLevel: null };
  }
  memCache = { at: now, value };
  return value;
}

export function machineLoad(): MachineLoad {
  const ncpu = Math.max(1, os.cpus().length || 1);
  const load1 = os.loadavg()[0] ?? 0;
  const m = memory();
  return {
    load1,
    ncpu,
    loadPerCore: load1 / ncpu,
    swapUsedMb: m.swap ? m.swap.usedMb : null,
    swapTotalMb: m.swap ? m.swap.totalMb : null,
    pressureLevel: m.pressureLevel,
  };
}

export type Admission = { ok: true } | { ok: false; reason: string };

export const swapPctOf = (load: MachineLoad): number | null =>
  load.swapTotalMb && load.swapUsedMb != null ? (load.swapUsedMb / load.swapTotalMb) * 100 : null;

/**
 * Pure: is there room for one more agent process?
 *
 * Memory is judged by PRESSURE first, swap second. Swap% alone never refuses — see
 * `parseMemorySysctl` for why a full small swapfile is normal. So: critical pressure refuses on its
 * own, and warning pressure refuses only once swap is also over the line. With no pressure reading
 * (off darwin, or the sysctl failed) the memory rule does not apply at all and load decides.
 *
 * Every number goes into the reason whichever one tripped — "load 34.1 on 12 cores" alone tells an
 * agent nothing about whether to wait or give up.
 */
export function admission(load: MachineLoad, cfg = CONFIG.machine): Admission {
  if (!cfg.enabled) return { ok: true };
  const swapPct = swapPctOf(load);
  const overLoad = load.loadPerCore > cfg.maxLoadPerCore;
  const critical = load.pressureLevel === 4;
  const strained = load.pressureLevel != null && load.pressureLevel >= 2 && swapPct != null && swapPct > cfg.maxSwapUsedPct;
  if (!overLoad && !critical && !strained) return { ok: true };
  const swapPart = swapPct == null ? "swap unknown" : `swap ${Math.round(swapPct)}% used`;
  return {
    ok: false,
    reason: `load ${load.load1.toFixed(1)} on ${load.ncpu} cores, memory pressure ${pressureWord(load.pressureLevel)} (${swapPart}); retry when workers finish`,
  };
}

/** Test seam (same shape as robert-drive's setDriveProbe): what `admissionNow` reads. */
type LoadProbe = () => MachineLoad;
let loadProbe: LoadProbe = machineLoad;
export function setLoadProbe(fn: LoadProbe | null): void { loadProbe = fn ?? machineLoad; }

export function currentLoad(): MachineLoad { return loadProbe(); }
export function admissionNow(): Admission { return admission(loadProbe()); }

// ───────────────────────────── 3. heavy slots: one test suite at a time ─────────────────────────────

export type SlotHolder = { slot_id: string; session_id: string | null; label: string; since: number; held_ms: number };
type Slot = { id: string; session_id: string | null; label: string; since: number; beat: number };
/** The in-flight long poll attached to a queue entry. Absent between one poll and the next. */
type Poll = { settle: (r: SlotGrant) => void; timer?: NodeJS.Timeout; tick?: NodeJS.Timeout };
type Waiter = {
  /** The caller's place in line. Survives poll round-trips — that is the whole point. */
  ticket: string;
  session_id: string | null;
  label: string;
  /** When this entry first joined the queue: what FIFO actually orders by. */
  since: number;
  /** When a poll last attached. An entry nobody comes back for expires (SLOT_STALE_MS). */
  lastPoll: number;
  poll: Poll | null;
};
export type SlotGrant =
  | { granted: true; slot_id: string }
  | { granted: false; holders: SlotHolder[]; ticket: string };

/** A holder that has not heartbeated in this long is gone (crashed CLI, SIGKILL'd shell). The same
 *  window covers a queue entry nobody has re-polled for: an abandoned place in line. */
export const SLOT_STALE_MS = 90_000;

const slots = new Map<string, Slot>();
let queue: Waiter[] = [];

/** Test seam: the clock the stale sweep reads, so reclaim is testable without waiting 90 seconds. */
let nowMs: () => number = () => Date.now();
export function setSlotClock(fn: (() => number) | null): void { nowMs = fn ?? (() => Date.now()); }

export function heavySlotCount(): number {
  return Math.max(1, Math.round(CONFIG.machine.heavySlots));
}

export function slotHolders(): SlotHolder[] {
  const now = nowMs();
  return [...slots.values()]
    .sort((a, b) => a.since - b.since)
    .map((s) => ({ slot_id: s.id, session_id: s.session_id, label: s.label, since: s.since, held_ms: now - s.since }));
}

function detach(w: Waiter): Poll | null {
  const p = w.poll;
  if (p) {
    if (p.timer) clearTimeout(p.timer);
    if (p.tick) clearInterval(p.tick);
    w.poll = null;
  }
  return p;
}

function sweep(): void {
  const now = nowMs();
  for (const [id, s] of slots) {
    if (now - s.beat > SLOT_STALE_MS) {
      slots.delete(id);
      console.warn(`[machine] heavy slot ${id.slice(0, 8)} (${s.label}) reclaimed — no heartbeat for ${Math.round((now - s.beat) / 1000)}s`);
    }
  }
  // A place in line nobody has come back for: the `mc heavy` was killed, or its client hung up and
  // never re-polled. Dropped, or it would hold up everyone behind it forever.
  for (let i = queue.length - 1; i >= 0; i--) {
    const w = queue[i];
    if (!w.poll && now - w.lastPoll > SLOT_STALE_MS) queue.splice(i, 1);
  }
}

/**
 * Grant down the queue, in arrival order, while there is capacity.
 *
 * An entry with no live poll is SKIPPED, not granted: handing a slot to a caller that is not
 * listening would burn a permit for the full heartbeat window. It keeps its place — a `mc heavy`
 * between two 55s polls is back within milliseconds — and `sweep` removes it if it never returns.
 */
function pump(): void {
  sweep();
  const n = heavySlotCount();
  for (let i = 0; i < queue.length && slots.size < n; ) {
    const w = queue[i];
    if (!w.poll) { i++; continue; }
    queue.splice(i, 1);
    const settle = detach(w)!.settle;
    const now = nowMs();
    const slot: Slot = { id: randomUUID(), session_id: w.session_id, label: w.label, since: now, beat: now };
    slots.set(slot.id, slot);
    settle({ granted: true, slot_id: slot.id });
  }
}

/**
 * Long-poll for one of the N machine-wide heavy slots.
 *
 * `ticket` is how a caller keeps its place across poll rounds. Without it, every 55s timeout would
 * send `mc heavy` to the BACK of the queue behind callers that arrived later, and with ten agents
 * behind a five-minute suite the oldest waiter would starve. Pass back the ticket a refusal returned
 * and the SAME queue entry resumes, with its original arrival time.
 *
 * `waitMs <= 0` is a single attempt (what the tests use); the API parks a caller for up to 55s.
 */
export function acquireSlot(
  opts: { session_id?: string | null; label: string; ticket?: string | null },
  waitMs: number,
): Promise<SlotGrant> {
  return new Promise<SlotGrant>((resolve) => {
    const now = nowMs();
    // Resume the existing entry when the ticket is still in line; a ticket we have forgotten (expired,
    // or from before a restart) simply re-joins at the back, which is the only honest thing to do.
    // A new entry KEEPS the caller's ticket rather than minting its own, so whoever called us can
    // name this entry before the promise settles — that is how the API drops an abandoned poll.
    let w = opts.ticket ? queue.find((x) => x.ticket === opts.ticket) : undefined;
    if (w) {
      detach(w);
      w.lastPoll = now;
      w.label = opts.label;
    } else {
      w = { ticket: opts.ticket || randomUUID(), session_id: opts.session_id ?? null, label: opts.label, since: now, lastPoll: now, poll: null };
      queue.push(w);
    }
    const entry = w;
    let done = false;
    const settle = (r: SlotGrant) => { if (!done) { done = true; resolve(r); } };
    const refuse = () => { detach(entry); settle({ granted: false, holders: slotHolders(), ticket: entry.ticket }); };

    entry.poll = { settle };
    pump();
    if (done) return;
    if (waitMs <= 0) return refuse();
    // Re-pump on a tick as well as on release: a holder can also go away by going STALE, and nothing
    // publishes an event for that.
    const tick = setInterval(pump, 2000);
    tick.unref?.();
    const timer = setTimeout(refuse, waitMs);
    timer.unref?.();
    entry.poll.tick = tick;
    entry.poll.timer = timer;
  });
}

/**
 * The client hung up (ctrl-C, closed socket) while its poll was parked. Detach the poll so `pump`
 * cannot hand it a slot nobody is listening for; the queue entry keeps its place until either the
 * caller re-polls with its ticket or `sweep` expires it.
 */
export function abandonPoll(ticket: string): void {
  const w = queue.find((x) => x.ticket === ticket);
  if (!w) return;
  const p = detach(w);
  p?.settle({ granted: false, holders: slotHolders(), ticket });
}

/** Heartbeat. false = the slot is gone (already reclaimed) and the caller should re-acquire. */
export function beatSlot(id: string): boolean {
  const s = slots.get(id);
  if (!s) return false;
  s.beat = nowMs();
  return true;
}

export function releaseSlot(id: string): boolean {
  const had = slots.delete(id);
  if (had) pump();
  return had;
}

/** A terminal that ended cannot still be running a test suite — free whatever it held. */
export function releaseForSession(sessionId: string): number {
  let freed = 0;
  for (const [id, s] of slots) if (s.session_id === sessionId) { slots.delete(id); freed++; }
  if (freed) pump();
  return freed;
}

/** Test-only: forget every slot and waiter. */
export function resetSlots(): void {
  for (const w of queue.splice(0)) detach(w)?.settle({ granted: false, holders: [], ticket: w.ticket });
  slots.clear();
}

/** Who is in line, oldest first — for tests and for `GET /machine`'s waiting count. */
export function slotQueue(): Array<{ ticket: string; label: string; polling: boolean; since: number }> {
  return queue.map((w) => ({ ticket: w.ticket, label: w.label, polling: !!w.poll, since: w.since }));
}

// ───────────────────────────── 4. vitals: what the Desk header draws ─────────────────────────────

/**
 * CPU / RAM / GPU as the operator reads them in Activity Monitor, sampled every VITALS_EVERY_MS into
 * a ring the Desk header draws as sparklines. Display only — admission never reads these; it keeps
 * judging by load and memory PRESSURE (a Mac at 90% RAM with pressure "normal" is fine).
 */
export type Vitals = { at: number; cpu: number | null; ram: number | null; gpu: number | null };
export type RamReading = { usedMb: number; totalMb: number };

export const VITALS_EVERY_MS = 5000;
export const VITALS_KEEP = 120; // 10 minutes
let vitals: Vitals[] = [];
let lastRam: RamReading | null = null;

/**
 * `vm_stat` → "Memory Used" the way Activity Monitor counts it: app memory (anonymous minus
 * purgeable) + wired + compressor. `os.freemem()` is useless on macOS — the kernel keeps free pages
 * near zero by filling them with file cache, so it always reads ~98% used.
 */
export function parseVmStat(out: string, totalBytes: number): RamReading | null {
  const page = Number(/page size of (\d+) bytes/.exec(out)?.[1]);
  const n = (label: string) => {
    const m = new RegExp(`${label}:\\s+(\\d+)`).exec(out);
    return m ? Number(m[1]) : null;
  };
  const anon = n("Anonymous pages"), purge = n("Pages purgeable"), wired = n("Pages wired down"), comp = n("Pages occupied by compressor");
  if (!page || anon == null || wired == null || comp == null || !totalBytes) return null;
  const used = (Math.max(0, anon - (purge ?? 0)) + wired + comp) * page;
  return { usedMb: Math.min(used, totalBytes) / 1048576, totalMb: totalBytes / 1048576 };
}

/** `ioreg -c IOAccelerator` → Apple GPU "Device Utilization %"; the busiest accelerator wins. */
export function parseGpuUtil(out: string): number | null {
  const all = [...out.matchAll(/"Device Utilization %"\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
  return all.length ? Math.min(100, Math.max(...all)) : null;
}

/** CPU busy % between two `os.cpus()` snapshots, all cores together. */
export function cpuBusyPct(prev: os.CpuInfo[], next: os.CpuInfo[]): number | null {
  let busy = 0, total = 0;
  for (let i = 0; i < Math.min(prev.length, next.length); i++) {
    const a = prev[i].times, b = next[i].times;
    const idle = b.idle - a.idle;
    const all = b.user - a.user + (b.nice - a.nice) + (b.sys - a.sys) + (b.irq - a.irq) + idle;
    busy += all - idle;
    total += all;
  }
  return total > 0 ? Math.min(100, Math.max(0, (busy / total) * 100)) : null;
}

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout: 2000 }, (err, out) => resolve(err ? null : out));
  });
}

let cpuPrev = os.cpus();
async function sampleVitals(): Promise<void> {
  const cpuNow = os.cpus();
  const cpu = cpuBusyPct(cpuPrev, cpuNow);
  cpuPrev = cpuNow;
  let ram: RamReading | null = null, gpu: number | null = null;
  if (process.platform === "darwin") {
    // Async on purpose: the daemon's event loop also carries every live pty.
    const [vm, io] = await Promise.all([run("/usr/bin/vm_stat", []), run("/usr/sbin/ioreg", ["-r", "-d", "1", "-c", "IOAccelerator"])]);
    ram = vm ? parseVmStat(vm, os.totalmem()) : null;
    gpu = io ? parseGpuUtil(io) : null;
  } else {
    const total = os.totalmem();
    ram = { usedMb: (total - os.freemem()) / 1048576, totalMb: total / 1048576 };
  }
  lastRam = ram;
  vitals.push({ at: Date.now(), cpu, ram: ram ? (ram.usedMb / ram.totalMb) * 100 : null, gpu });
  if (vitals.length > VITALS_KEEP) vitals = vitals.slice(-VITALS_KEEP);
}

export function vitalsSnapshot(): { every_ms: number; ram: RamReading | null; history: Vitals[] } {
  return { every_ms: VITALS_EVERY_MS, ram: lastRam, history: vitals };
}

let wired = false;
export function startMachineGovernor(): void {
  if (wired) return;
  wired = true;
  void sampleVitals();
  setInterval(() => void sampleVitals(), VITALS_EVERY_MS).unref?.();
  bus.on("event", (e: any) => {
    if (e?.topic === "session.ended") releaseForSession(e.session_id);
  });
}
