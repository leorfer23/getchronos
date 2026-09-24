import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "./config.js";
import {
  abandonPoll, acquireSlot, admission, beatSlot, cpuBusyPct, heavyPoolFor, heavySlotsForCpus, loadFromVitals, machineLoad, niceCommand,
  parseGpuUtil, parseMemorySysctl, parseVmStat,
  releaseForSession, releaseSlot, resetSlots, setSlotClock, slotHolders, slotQueue,
  type MachineLoad,
} from "./machine.js";

const CFG = { enabled: true, maxLoadPerCore: 2.5, maxSwapUsedPct: 90, heavySlots: 2 };
// A calm 12-core Mac: load 0.5/core, and a small swapfile 8% used with pressure "normal".
const load = (over: Partial<MachineLoad> = {}): MachineLoad => ({
  load1: 6, ncpu: 12, loadPerCore: 0.5, swapUsedMb: 1000, swapTotalMb: 13312, pressureLevel: 1, ...over,
});
const FULL_SWAP = { swapUsedMb: 12902, swapTotalMb: 13312 }; // 97%

// ───────────────────────────── admission ─────────────────────────────

test("a quiet machine admits an agent", () => {
  assert.deepEqual(admission(load(), CFG), { ok: true });
});

test("load alone refuses, and the reason names load, pressure and swap", () => {
  const v = admission(load({ load1: 34.1, loadPerCore: 34.1 / 12 }), CFG);
  assert.equal(v.ok, false);
  assert.match((v as any).reason, /load 34\.1 on 12 cores/);
  assert.match((v as any).reason, /memory pressure normal/);
  assert.match((v as any).reason, /swap 8% used/);
  assert.match((v as any).reason, /retry when workers finish/);
});

test("load exactly at the threshold is still admitted — the rule is 'over'", () => {
  assert.deepEqual(admission(load({ loadPerCore: 2.5 }), CFG), { ok: true });
  assert.equal(admission(load({ loadPerCore: 2.6 }), CFG).ok, false);
});

// The bug this encodes: `vm.swapusage` TOTAL is dynamic on macOS, and the kernel does not page back
// in eagerly — a small mostly-full swapfile is what a HEALTHY idle Mac looks like, for hours. Judged
// on swap% alone, the governor refused spawns on a machine with pressure 1 and memory to spare.
test("swap 97% with pressure normal is a healthy Mac — never refused", () => {
  assert.deepEqual(admission(load({ ...FULL_SWAP, pressureLevel: 1 }), CFG), { ok: true });
});

test("swap 97% with pressure WARNING refuses — the second opinion agrees", () => {
  const v = admission(load({ ...FULL_SWAP, pressureLevel: 2 }), CFG);
  assert.equal(v.ok, false);
  assert.match((v as any).reason, /memory pressure warning \(swap 97% used\)/);
});

test("warning pressure with swap under the line is still fine", () => {
  assert.deepEqual(admission(load({ swapUsedMb: 1000, swapTotalMb: 13312, pressureLevel: 2 }), CFG), { ok: true });
});

test("CRITICAL pressure refuses on its own, whatever swap says", () => {
  const v = admission(load({ swapUsedMb: 400, swapTotalMb: 4096, pressureLevel: 4 }), CFG);
  assert.equal(v.ok, false);
  assert.match((v as any).reason, /memory pressure critical \(swap 10% used\)/);
});

test("no pressure reading (non-darwin) = load decides alone", () => {
  assert.deepEqual(admission(load({ ...FULL_SWAP, pressureLevel: null }), CFG), { ok: true });
  assert.deepEqual(admission(load({ swapUsedMb: null, swapTotalMb: null, pressureLevel: null }), CFG), { ok: true });
  // …and a refusal for load says so rather than inventing numbers.
  const v = admission(load({ load1: 40, loadPerCore: 40 / 12, swapUsedMb: null, swapTotalMb: null, pressureLevel: null }), CFG);
  assert.match((v as any).reason, /memory pressure unknown \(swap unknown\)/);
});

test("disabled governor admits anything", () => {
  const off = { ...CFG, enabled: false };
  assert.deepEqual(admission(load({ loadPerCore: 99, ...FULL_SWAP, pressureLevel: 4 }), off), { ok: true });
});

test("machineLoad reads the real machine without throwing and stays self-consistent", () => {
  const m = machineLoad();
  assert.ok(m.ncpu >= 1);
  assert.ok(Number.isFinite(m.load1) && m.load1 >= 0);
  assert.equal(m.loadPerCore, m.load1 / m.ncpu);
  // Swap is darwin-only; either both halves are numbers or both are null.
  assert.equal(m.swapUsedMb === null, m.swapTotalMb === null);
  assert.ok(m.pressureLevel === null || [1, 2, 4].includes(m.pressureLevel));
});

test("parseMemorySysctl reads both sysctls out of one call", () => {
  // Exactly what `sysctl -n vm.swapusage kern.memorystatus_vm_pressure_level` prints.
  assert.deepEqual(parseMemorySysctl("total = 4096.00M  used = 2949.69M  free = 1146.31M  (encrypted)\n1\n"), {
    swap: { totalMb: 4096, usedMb: 2949.69 }, pressureLevel: 1,
  });
  assert.deepEqual(parseMemorySysctl("total = 2.00G  used = 1.00G  free = 1.00G\n4"), {
    swap: { totalMb: 2048, usedMb: 1024 }, pressureLevel: 4,
  });
  // Junk, a missing level, or an unknown level must read as "no information", never as a refusal.
  assert.deepEqual(parseMemorySysctl("sysctl: unknown oid"), { swap: null, pressureLevel: null });
  assert.deepEqual(parseMemorySysctl("total = 1.00G  used = 0.50G  free = 0.50G\n7").pressureLevel, null);
});

// ───────────────────────────── nice ─────────────────────────────

test("CHRONOS_AGENT_NICE=0 leaves the command untouched", () => {
  assert.deepEqual(niceCommand("/usr/bin/sandbox-exec", ["-p", "(version 1)", "claude"], 0), {
    cmd: "/usr/bin/sandbox-exec", cmdArgs: ["-p", "(version 1)", "claude"],
  });
});

test("the default wraps the whole sandboxed command, so the nice value is inherited through it", () => {
  const w = niceCommand("/usr/bin/sandbox-exec", ["-p", "(version 1)", "claude", "--resume"], 10);
  assert.equal(w.cmd, "/usr/bin/nice");
  assert.deepEqual(w.cmdArgs, ["-n", "10", "/usr/bin/sandbox-exec", "-p", "(version 1)", "claude", "--resume"]);
});

test("a nonsense priority is clamped, never passed through to nice(1)", () => {
  assert.deepEqual(niceCommand("claude", [], 99).cmdArgs.slice(0, 2), ["-n", "20"]);
  assert.deepEqual(niceCommand("claude", [], -5).cmdArgs.slice(0, 2), ["-n", "0"]);
  assert.deepEqual(niceCommand("claude", [], Number.NaN), { cmd: "claude", cmdArgs: [] });
});

// ───────────────────────────── heavy slots ─────────────────────────────

let clock = 1_000_000;
beforeEach(() => {
  resetSlots();
  clock = 1_000_000;
  setSlotClock(() => clock);
  CONFIG.machine.heavySlots = 2;
});

test("grants up to N slots, then refuses and names who is holding them", async () => {
  const a = await acquireSlot({ label: "npm test", session_id: "s1" }, 0);
  const b = await acquireSlot({ label: "tsc -b" }, 0);
  assert.equal(a.granted, true);
  assert.equal(b.granted, true);

  clock += 60_000; // still inside the heartbeat window — nobody is reclaimed
  const c = await acquireSlot({ label: "vitest run" }, 0);
  assert.equal(c.granted, false);
  assert.deepEqual((c as any).holders.map((h: any) => h.label), ["npm test", "tsc -b"]);
  assert.equal((c as any).holders[0].held_ms, 60_000);
});

test("a released slot goes to the FIRST waiter, not the loudest", async () => {
  CONFIG.machine.heavySlots = 1;
  const held = await acquireSlot({ label: "first" }, 0);
  assert.equal(held.granted, true);

  const second = acquireSlot({ label: "second" }, 5000);
  const third = acquireSlot({ label: "third" }, 5000);
  // Let both parks register before the release pumps the queue.
  await new Promise((r) => setImmediate(r));

  releaseSlot((held as any).slot_id);
  assert.equal((await second).granted, true);
  assert.deepEqual(slotHolders().map((h) => h.label), ["second"]);

  releaseSlot(slotHolders()[0].slot_id);
  assert.equal((await third).granted, true);
});

test("releasing a slot that is already gone is a quiet no-op", async () => {
  const a = await acquireSlot({ label: "npm test" }, 0);
  assert.equal(releaseSlot((a as any).slot_id), true);
  assert.equal(releaseSlot((a as any).slot_id), false);
  assert.deepEqual(slotHolders(), []);
});

test("a holder that stops heartbeating is reclaimed; one that keeps beating is not", async () => {
  CONFIG.machine.heavySlots = 1;
  const a = await acquireSlot({ label: "crashed suite" }, 0);
  const id = (a as any).slot_id;

  clock += 60_000;
  assert.equal(beatSlot(id), true);
  clock += 60_000; // 120s since acquire, but only 60s since the beat
  assert.equal((await acquireSlot({ label: "waiting" }, 0)).granted, false, "still held — it is beating");

  clock += 91_000;
  const next = await acquireSlot({ label: "waiting" }, 0);
  assert.equal(next.granted, true, "reclaimed after the heartbeat timeout");
  assert.equal(beatSlot(id), false, "the dead holder learns its slot is gone");
});

test("a terminal's slots are released when the terminal ends", async () => {
  await acquireSlot({ label: "npm test", session_id: "sess-a" }, 0);
  await acquireSlot({ label: "tsc", session_id: "sess-b" }, 0);
  assert.equal(releaseForSession("sess-a"), 1);
  assert.deepEqual(slotHolders().map((h) => h.session_id), ["sess-b"]);
  assert.equal(releaseForSession("sess-a"), 0);
});

// ───────────────────────────── the queue survives poll round-trips ─────────────────────────────

// The bug this encodes: a 55s long poll that times out used to DROP the waiter, and `mc heavy`'s
// next POST joined at the back — behind everyone who arrived during those 55 seconds. With two slots
// and ten agents behind five-minute suites, the oldest waiter starved.
test("a re-poll with its ticket keeps its place, and is granted before later arrivals", async () => {
  CONFIG.machine.heavySlots = 1;
  const held = await acquireSlot({ label: "holder" }, 0);

  const a1 = await acquireSlot({ label: "A" }, 0);   // A arrives first, poll times out
  const b1 = await acquireSlot({ label: "B" }, 0);   // B arrives second
  const c1 = await acquireSlot({ label: "C" }, 0);   // C arrives third
  assert.equal(a1.granted, false);
  const ticketA = (a1 as any).ticket;
  assert.ok(ticketA && (b1 as any).ticket !== ticketA);

  // A comes straight back with its ticket; B and C are between polls.
  const a2 = acquireSlot({ label: "A", ticket: ticketA }, 5000);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(slotQueue().map((w) => w.label), ["A", "B", "C"], "A kept its place at the head");

  releaseSlot((held as any).slot_id);
  assert.equal((await a2).granted, true, "the oldest waiter got it");
  assert.deepEqual(slotHolders().map((h) => h.label), ["A"]);
  assert.deepEqual(slotQueue().map((w) => w.label), ["B", "C"]);
});

test("an unknown or expired ticket simply re-joins at the back, keeping its name", async () => {
  CONFIG.machine.heavySlots = 1;
  await acquireSlot({ label: "holder" }, 0);
  await acquireSlot({ label: "A" }, 0);
  const stale = await acquireSlot({ label: "B", ticket: "a-ticket-we-have-forgotten" }, 0);
  assert.equal(stale.granted, false);
  assert.deepEqual(slotQueue().map((w) => w.label), ["A", "B"], "behind A, not ahead of it");
  // The caller's own id is kept, so whoever called us can still name this entry (req.on("close")).
  assert.equal((stale as any).ticket, "a-ticket-we-have-forgotten");
});

test("a place in line nobody re-polls for expires and stops blocking the queue", async () => {
  CONFIG.machine.heavySlots = 1;
  const held = await acquireSlot({ label: "holder" }, 0);
  await acquireSlot({ label: "abandoned" }, 0); // never comes back
  assert.deepEqual(slotQueue().map((w) => w.label), ["abandoned"]);

  clock += 91_000;
  const later = acquireSlot({ label: "later" }, 5000);
  await new Promise((r) => setImmediate(r));
  // The holder went stale at the same moment, so `later` is granted outright.
  assert.equal((await later).granted, true);
  assert.deepEqual(slotQueue(), [], "the abandoned entry was swept, not granted");
  assert.equal(beatSlot((held as any).slot_id), false);
});

// ───────────────────────────── a client that hung up gets nothing ─────────────────────────────

test("a slot is never granted to a waiter whose client went away", async () => {
  CONFIG.machine.heavySlots = 1;
  const held = await acquireSlot({ label: "holder" }, 0);

  const gone = acquireSlot({ label: "hung-up", ticket: "t-gone" }, 5000);
  const alive = acquireSlot({ label: "still-here" }, 5000);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(slotQueue().map((w) => w.label), ["hung-up", "still-here"]);

  abandonPoll("t-gone"); // express `req.on("close")`
  assert.equal((await gone).granted, false, "its own poll is settled, not left hanging");
  assert.deepEqual(slotQueue().map((w) => [w.label, w.polling]), [["hung-up", false], ["still-here", true]]);

  releaseSlot((held as any).slot_id);
  assert.equal((await alive).granted, true, "the live waiter behind it is served, not the ghost");
  assert.deepEqual(slotHolders().map((h) => h.label), ["still-here"]);

  // The ghost keeps its place only until the expiry window passes — then it is gone for good.
  clock += 91_000;
  await acquireSlot({ label: "sweeper" }, 0);
  assert.equal(slotQueue().some((w) => w.label === "hung-up"), false);
});

test("abandoning a ticket nobody is waiting on is a no-op", () => {
  abandonPoll("nothing-here");
  assert.deepEqual(slotQueue(), []);
});

// ───────────────────────────── vitals parsers ─────────────────────────────

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     4505.
Pages active:                                 218101.
Pages wired down:                             268110.
Pages purgeable:                                  26.
File-backed pages:                            146512.
Anonymous pages:                              288938.
Pages occupied by compressor:                 417788.
`;

test("vm_stat: RAM used counts app + wired + compressor, not file cache (Activity Monitor's number)", () => {
  const r = parseVmStat(VM_STAT, 19327352832)!;
  assert.equal(Math.round(r.totalMb), 18432);
  // (288938 - 26 + 268110 + 417788) pages × 16 KB
  assert.equal(Math.round(r.usedMb), Math.round((974810 * 16384) / 1048576));
});

test("vm_stat: missing fields read as no reading, never a made-up number", () => {
  assert.equal(parseVmStat("Mach Virtual Memory Statistics: (page size of 16384 bytes)\n", 1e9), null);
  assert.equal(parseVmStat("", 1e9), null);
});

test("ioreg: GPU is the busiest accelerator's Device Utilization %", () => {
  const out = `"PerformanceStatistics" = {"Renderer Utilization %"=38,"Device Utilization %"=39}\n"PerformanceStatistics" = {"Device Utilization %"=12}`;
  assert.equal(parseGpuUtil(out), 39);
  assert.equal(parseGpuUtil("nothing here"), null);
});

test("cpu busy % is the non-idle share of the tick delta across all cores", () => {
  const t = (user: number, idle: number) => ({ model: "", speed: 0, times: { user, nice: 0, sys: 0, irq: 0, idle } });
  assert.equal(cpuBusyPct([t(0, 0), t(0, 0)], [t(30, 70), t(10, 90)]), 20);
  assert.equal(cpuBusyPct([t(5, 5)], [t(5, 5)]), null);
});

// ───────────────────────────── per-host pools (HOSTS.md phase 4) ─────────────────────────────

test("each host has its own pool, sized by its own cores: two suites on two Macs never wait for each other", async () => {
  CONFIG.machine.heavySlots = 1;
  let cores = 12;
  const m2 = heavyPoolFor("m2-test", () => heavySlotsForCpus(cores));
  assert.equal(heavyPoolFor("m2-test", () => 99), m2, "one pool per host, created once");
  assert.equal((await acquireSlot({ label: "brain suite" }, 0)).granted, true);
  assert.equal((await acquireSlot({ label: "brain suite 2" }, 0)).granted, false, "the brain's one slot is taken");
  // …and the host's two are untouched by that.
  assert.equal(m2.size(), 2);
  assert.equal((await m2.acquire({ label: "m2 suite", session_id: "on-m2" }, 0)).granted, true);
  assert.equal((await m2.acquire({ label: "m2 tsc", session_id: "on-m2" }, 0)).granted, true);
  assert.equal((await m2.acquire({ label: "m2 third" }, 0)).granted, false);
  assert.deepEqual(slotHolders().map((h) => h.label), ["brain suite"]);
  // A size read on every grant: a host whose core count arrives later is sized from then on.
  cores = 24;
  assert.equal(m2.size(), 4);
  // A terminal that ends frees its slots on whichever machine it held them.
  assert.equal(releaseForSession("on-m2"), 2);
  assert.deepEqual(m2.holders(), []);
});

test("heavy slots per core count: ncpu/6, never zero, one when unknown", () => {
  assert.equal(heavySlotsForCpus(12), 2);
  assert.equal(heavySlotsForCpus(10), 1);
  assert.equal(heavySlotsForCpus(4), 1);
  assert.equal(heavySlotsForCpus(null), 1);
  assert.equal(heavySlotsForCpus(undefined), 1);
});

test("a host's reported vitals go through the very admission() the brain judges itself by", () => {
  const v = { loadPerCore: 34.1 / 12, pressure: 2 as const, swapPct: 97, ncpu: 12, load1: 34.1, swapUsedMb: 12902, swapTotalMb: 13312 };
  const l = loadFromVitals(v);
  assert.deepEqual(l, { load1: 34.1, ncpu: 12, loadPerCore: 34.1 / 12, swapUsedMb: 12902, swapTotalMb: 13312, pressureLevel: 2 });
  assert.match((admission(l, CFG) as any).reason, /^load 34\.1 on 12 cores, memory pressure warning \(swap 97% used\)/);
  // A protocol-1.1 host (ratios only) gets the same verdict, in poorer words.
  const old = loadFromVitals({ loadPerCore: 34.1 / 12, pressure: 2, swapPct: 97 });
  assert.equal(old.ncpu, 1);
  assert.equal(old.swapUsedMb, 97);
  assert.equal(old.swapTotalMb, 100);
  assert.equal(admission(old, CFG).ok, false);
  assert.equal(admission(loadFromVitals({ loadPerCore: 0.2, pressure: 1, swapPct: 97 }), CFG).ok, true, "swap alone never refuses");
});
