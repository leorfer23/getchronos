import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerKey, parseLstart, parsePs, ProcLedger, type Proc, type Root } from "./ledger.js";
import { fixtureProc as P } from "./reaper.js";

const SELF = 100; // the daemon
const T0 = 1_000_000;

const root = (over: Partial<Root> = {}): Root => ({ kind: "session", id: "s1", pid: 200, startedAt: T0, workspaceId: "ws-a", ...over });
const DAEMON = P({ pid: SELF, ppid: 1, comm: "/usr/local/bin/node" });

// ───────────────────────────── parsing ─────────────────────────────

test("parsePs: real darwin rows, comm with spaces kept whole, junk skipped", () => {
  const out = [
    "    1     0     1     0  10640   0.7 Thu Oct  1 21:59:06 2026     /sbin/launchd",
    "52749     1 52749   501   6304   0.0 Fri Oct  2 16:52:02 2026     /Users/leo/Library/Caches/.wrangler/chrome/mac_arm-126.0.6478.182/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "52994 52749 52749   501    608  12.5 Fri Oct  2 16:52:05 2026     /Users/leo/x/Google Chrome for Testing Helper (Renderer).app/Contents/MacOS/Google Chrome for Testing Helper (Renderer)",
    "garbage line",
    "",
  ].join("\n");
  const rows = parsePs(out);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    { pid: rows[1].pid, ppid: rows[1].ppid, pgid: rows[1].pgid, uid: rows[1].uid, rssKb: rows[1].rssKb },
    { pid: 52749, ppid: 1, pgid: 52749, uid: 501, rssKb: 6304 },
  );
  assert.match(rows[1].comm, /Google Chrome for Testing\.app\/Contents\/MacOS\/Google Chrome for Testing$/);
  assert.equal(rows[2].cpu, 12.5);
  assert.match(rows[2].comm, /\(Renderer\)$/);
  // Same lstart string → same ms: the identity comparison relies on it being stable across ticks.
  assert.equal(rows[1].startMs, parseLstart("Fri Oct  2 16:52:02 2026"));
  assert.equal(rows[2].startMs - rows[1].startMs, 3000);
});

test("parseLstart: double-spaced day parses; nonsense is null", () => {
  assert.equal(parseLstart("Thu Oct  2 10:11:12 2026"), parseLstart("Thu Oct 2 10:11:12 2026"));
  assert.equal(parseLstart("not a date"), null);
});

// ───────────────────────────── attribution ─────────────────────────────

test("a root's whole tree is owned; a stranger is not", () => {
  const l = new ProcLedger();
  const snap: Proc[] = [
    DAEMON,
    P({ pid: 200, ppid: SELF, startMs: T0 }), // the terminal's CLI
    P({ pid: 201, ppid: 200 }), // its shell tool
    P({ pid: 202, ppid: 201 }), // vitest
    P({ pid: 203, ppid: 202, comm: "/x/Google Chrome for Testing" }),
    P({ pid: 300, ppid: 1 }), // somebody else entirely
    P({ pid: 301, ppid: SELF }), // another daemon child that is not a root (Robert, say)
  ];
  l.update(snap, [root()], { selfPid: SELF, now: T0 });
  assert.deepEqual([...l.entries.keys()].sort(), [200, 201, 202, 203]);
  const k = ownerKey(root());
  for (const e of l.entries.values()) assert.equal(e.owner, k);
  assert.equal(l.entries.has(SELF), false);
});

test("a root is only believed as the spawner's direct child, started when the spawner says", () => {
  const notChild = new ProcLedger();
  notChild.update([DAEMON, P({ pid: 200, ppid: 999, startMs: T0 })], [root()], { selfPid: SELF, now: T0 });
  assert.equal(notChild.entries.size, 0, "pid 200 is not the daemon's child: a stale/recycled pid");

  const tooOld = new ProcLedger();
  tooOld.update([DAEMON, P({ pid: 200, ppid: SELF, startMs: T0 - 3_600_000 })], [root()], { selfPid: SELF, now: T0 });
  assert.equal(tooOld.entries.size, 0, "started an hour before the spawn: not the process we spawned");

  const unknownStart = new ProcLedger();
  unknownStart.update([DAEMON, P({ pid: 200, ppid: SELF, startMs: T0 - 3_600_000 })], [root({ startedAt: null })], { selfPid: SELF, now: T0 });
  assert.equal(unknownStart.entries.size, 1, "hostd gives no start: the direct-child rule alone decides");
});

test("ownership is sticky: reparented to launchd it keeps its owner, and its new children inherit", () => {
  const l = new ProcLedger();
  const chrome = P({ pid: 203, ppid: 202, comm: "/x/Google Chrome for Testing" });
  l.update([DAEMON, P({ pid: 200, ppid: SELF, startMs: T0 }), P({ pid: 202, ppid: 200 }), chrome], [root()], { selfPid: SELF, now: T0 });
  const k = ownerKey(root());
  // vitest (202) exits; Chrome is adopted by launchd and forks a renderer.
  l.update(
    [DAEMON, P({ pid: 200, ppid: SELF, startMs: T0 }), { ...chrome, ppid: 1 }, P({ pid: 204, ppid: 203, pgid: 203, startMs: T0 + 5000 })],
    [root()],
    { selfPid: SELF, now: T0 + 10_000 },
  );
  assert.equal(l.entries.get(203)?.owner, k);
  assert.equal(l.entries.get(203)?.orphanSince, T0 + 10_000);
  assert.equal(l.entries.get(204)?.owner, k, "born to an owned orphan → owned");
  assert.equal(l.entries.get(204)?.orphanSince, null);
  assert.equal(l.entries.has(202), false, "gone from the snapshot → gone from the ledger");
  // The orphan clock does not restart on the next tick.
  l.update([DAEMON, P({ pid: 200, ppid: SELF, startMs: T0 }), { ...chrome, ppid: 1 }], [root()], { selfPid: SELF, now: T0 + 20_000 });
  assert.equal(l.entries.get(203)?.orphanSince, T0 + 10_000);
});

test("pid reuse: the same pid with a new start time is a stranger, and is dropped", () => {
  const l = new ProcLedger();
  l.update([DAEMON, P({ pid: 200, ppid: SELF, startMs: T0 }), P({ pid: 250, ppid: 200, startMs: T0 })], [root()], { selfPid: SELF, now: T0 });
  assert.ok(l.entries.has(250));
  // 250 died; the kernel handed the pid to an unrelated process under launchd.
  l.update([DAEMON, P({ pid: 200, ppid: SELF, startMs: T0 }), P({ pid: 250, ppid: 1, startMs: T0 + 60_000 })], [root()], { selfPid: SELF, now: T0 + 60_000 });
  assert.equal(l.entries.has(250), false);
});

test("an owner is one incarnation: same session id under a new pid ends the old one", () => {
  const l = new ProcLedger();
  const r1 = root();
  l.update([DAEMON, P({ pid: 200, ppid: SELF, startMs: T0 }), P({ pid: 201, ppid: 200 })], [r1], { selfPid: SELF, now: T0 });
  // promoteToLead: the pty is replaced; 201 was left behind and reparented.
  const r2 = root({ pid: 400, startedAt: T0 + 30_000 });
  l.update([DAEMON, P({ pid: 201, ppid: 1 }), P({ pid: 400, ppid: SELF, startMs: T0 + 30_000 })], [r2], { selfPid: SELF, now: T0 + 30_000 });
  assert.equal(l.owners.get(ownerKey(r1))?.ended, true);
  assert.equal(l.owners.get(ownerKey(r1))?.endedAt, T0 + 30_000);
  assert.equal(l.owners.get(ownerKey(r2))?.ended, false);
  assert.equal(l.entries.get(201)?.owner, ownerKey(r1));
  assert.equal(l.entries.get(400)?.owner, ownerKey(r2));
  // Once the leftover is gone, the ended incarnation is forgotten.
  l.update([DAEMON, P({ pid: 400, ppid: SELF, startMs: T0 + 30_000 })], [r2], { selfPid: SELF, now: T0 + 40_000 });
  assert.equal(l.owners.has(ownerKey(r1)), false);
  assert.equal(l.owners.size, 1);
});

test("rollup: count, RSS, CPU and orphans per incarnation", () => {
  const l = new ProcLedger();
  l.update(
    [DAEMON, P({ pid: 200, ppid: SELF, startMs: T0, rssKb: 1024, cpu: 10 }), P({ pid: 201, ppid: 200, rssKb: 2048, cpu: 5 })],
    [root()],
    { selfPid: SELF, now: T0 },
  );
  l.update(
    [DAEMON, P({ pid: 200, ppid: SELF, startMs: T0, rssKb: 1024, cpu: 10 }), P({ pid: 201, ppid: 1, rssKb: 2048, cpu: 5 })],
    [root()],
    { selfPid: SELF, now: T0 + 1 },
  );
  assert.deepEqual(l.rollup().get(ownerKey(root())), { pids: 2, rssKb: 3072, cpu: 15, orphans: 1, left: 0 });
});
