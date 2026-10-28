/**
 * `mc vpn` holds (vpn.ts) over a fake driver, and the two real drivers over a fake exec. What is
 * under test: the daemon turns a VPN off only when it turned it on and the last hold is gone; a
 * restart neither forgets that nor keeps a dead terminal's hold; and a Tunnelblick name can never
 * become part of the AppleScript it is passed to.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tailscaleDriver, tunnelblickDriver, VpnError, VpnLeases, type Exec, type VpnConfig, type VpnDriver, type VpnHolder, type VpnState } from "./vpn.js";

class FakeVpn implements VpnDriver {
  ups = 0;
  downs = 0;
  failUp: Error | null = null;
  constructor(public now: VpnState = "down") {}
  async state() { return this.now; }
  async up() {
    this.ups++;
    await new Promise((r) => setTimeout(r, 5));
    if (this.failUp) throw this.failUp;
    this.now = "up";
  }
  async down() { this.downs++; this.now = "down"; }
}

const TS: VpnConfig = { kind: "tailscale" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hold = (id: string, workspace_id = "wsA"): VpnHolder => ({ kind: "session", id, workspace_id, label: id, since: new Date().toISOString() });

function leases(vpn: FakeVpn, opts: { live?: Set<string>; saved?: string; graceMs?: number } = {}) {
  const store = { json: opts.saved };
  const l = new VpnLeases({
    driver: () => vpn,
    isLive: (h) => (opts.live ? opts.live.has(h.id) : true),
    load: () => store.json,
    save: (j) => { store.json = j; },
    graceMs: opts.graceMs ?? 10,
    log: () => {},
  });
  return { l, store };
}

test("off → the first hold turns it on; it goes off only after the LAST hold ends, plus the grace", async () => {
  const vpn = new FakeVpn("down");
  const { l } = leases(vpn);
  const a = await l.acquire(TS, hold("s1"));
  assert.equal(a.turned_on, true);
  assert.equal(a.turned_on_by_chronos, true);
  const b = await l.acquire(TS, hold("s2"));
  assert.equal(b.turned_on, false, "already up: the second hold does not run `up` again");
  assert.equal(vpn.ups, 1);
  assert.equal(l.release("s1"), true);
  await sleep(30);
  assert.equal(vpn.downs, 0, "s2 still holds it");
  l.release("s2");
  assert.equal((await l.status(TS, null)).turns_off_at !== null, true, "off is scheduled, not immediate");
  await sleep(30);
  assert.equal(vpn.downs, 1);
  assert.equal(vpn.now, "down");
  assert.equal((await l.status(TS, null)).turned_on_by_chronos, false);
});

test("a VPN the operator turned on by hand is never turned off by Chronos", async () => {
  const vpn = new FakeVpn("up");
  const { l } = leases(vpn);
  const a = await l.acquire(TS, hold("s1"));
  assert.equal(a.turned_on, false);
  assert.equal(a.turned_on_by_chronos, false);
  l.release("s1");
  await sleep(30);
  assert.equal(vpn.downs, 0);
  assert.equal(vpn.now, "up");
});

test("a hold during the grace cancels the turn-off (back-to-back jobs don't flap it)", async () => {
  const vpn = new FakeVpn("down");
  const { l } = leases(vpn, { graceMs: 25 });
  await l.acquire(TS, hold("s1"));
  l.release("s1");
  await sleep(5);
  await l.acquire(TS, hold("s2"));
  await sleep(40);
  assert.equal(vpn.downs, 0);
  assert.equal(vpn.ups, 1);
  assert.equal((await l.status(TS, null)).turned_on_by_chronos, true, "still Chronos's to turn off later");
});

test("two holds asking at once run `up` once", async () => {
  const vpn = new FakeVpn("down");
  const { l } = leases(vpn);
  await Promise.all([l.acquire(TS, hold("s1")), l.acquire(TS, hold("s2")), l.acquire(TS, hold("s3"))]);
  assert.equal(vpn.ups, 1);
  assert.equal((await l.status(TS, null)).holders.length, 3);
});

test("a failed `up` drops the hold and puts the VPN back off", async () => {
  const vpn = new FakeVpn("down");
  vpn.failUp = new VpnError("did not connect", 504);
  const { l } = leases(vpn);
  await assert.rejects(l.acquire(TS, hold("s1")), /did not connect/);
  assert.equal(vpn.downs, 1);
  const s = await l.status(TS, null);
  assert.equal(s.holders.length, 0);
  assert.equal(s.turned_on_by_chronos, false);
});

test("a failed `up` while it was already connecting leaves that attempt alone (it is someone else's)", async () => {
  const vpn = new FakeVpn("connecting");
  vpn.failUp = new VpnError("did not connect", 504);
  const { l } = leases(vpn);
  await assert.rejects(l.acquire(TS, hold("s1")), /did not connect/);
  assert.equal(vpn.downs, 0);
});

test("needs a login → refused, nothing held, nothing run", async () => {
  const vpn = new FakeVpn("needs-login");
  const { l } = leases(vpn);
  await assert.rejects(l.acquire(TS, hold("s1")), (e: any) => e instanceof VpnError && e.status === 409);
  assert.equal(vpn.ups, 0);
  assert.equal((await l.status(TS, null)).holders.length, 0);
});

test("the sweep drops a dead terminal's hold and turns off what Chronos turned on", async () => {
  const vpn = new FakeVpn("down");
  const live = new Set(["s1"]);
  const { l } = leases(vpn, { live });
  await l.acquire(TS, hold("s1"));
  live.delete("s1");
  l.sweep();
  await sleep(30);
  assert.equal(vpn.downs, 1);
});

test("a restart keeps the holds and the debt: a hold whose terminal did not come back ends, and the VPN goes off", async () => {
  const vpn = new FakeVpn("down");
  const first = leases(vpn);
  await first.l.acquire(TS, hold("s1"));
  first.l.reset();
  // The daemon restarted: same kv, nobody came back.
  const second = leases(vpn, { saved: first.store.json, live: new Set() });
  const s = await second.l.status(TS, null);
  assert.equal(s.turned_on_by_chronos, true);
  assert.equal(s.holders.map((h) => h.id).join(), "s1");
  second.l.sweep();
  await sleep(30);
  assert.equal(vpn.downs, 1);
});

test("a workspace sees its own holds; another workspace sharing the VPN is only a count", async () => {
  const vpn = new FakeVpn("down");
  const { l } = leases(vpn);
  await l.acquire(TS, hold("a1", "wsA"));
  const b = await l.acquire(TS, hold("b1", "wsB"));
  assert.deepEqual(b.holders.map((h) => h.id), ["b1"]);
  assert.equal(b.other_holders, 1);
  const op = await l.status(TS, null);
  assert.equal(op.holders.length, 2);
  assert.equal(op.other_holders, 0);
});

test("the operator's hand: off now drops every hold; on by hand is never Chronos's to turn off", async () => {
  const vpn = new FakeVpn("down");
  const { l } = leases(vpn);
  await l.acquire(TS, hold("s1"));
  const off = await l.forceDown(TS);
  assert.equal(off.holders.length, 0);
  assert.equal(vpn.now, "down");
  const on = await l.operatorUp(TS);
  assert.equal(on.turned_on_by_chronos, false);
  assert.equal(vpn.now, "up");
});

// ───────────────────────────── drivers ─────────────────────────────

function recorder(answer: (bin: string, args: string[]) => { code?: number; stdout?: string; stderr?: string }) {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const exec: Exec = async (bin, args) => {
    calls.push({ bin, args });
    const a = answer(bin, args);
    return { code: a.code ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
  return { calls, exec };
}

test("tunnelblick: the configuration name is only ever an argv item, never script text", async () => {
  const evil = 'x" & (do shell script "touch /tmp/pwned") & "';
  let state = "EXITING";
  const { calls, exec } = recorder((_b, args) => {
    const script = args.filter((_, i) => args[i - 1] === "-e").join("\n");
    if (script.includes("is running")) return { stdout: "true\n" };
    if (script.includes("connect (item 1 of argv)")) { state = "CONNECTED"; return { stdout: "true\n" }; }
    if (script.includes("get state")) return { stdout: state + "\n" };
    return { code: 1, stderr: "unexpected" };
  });
  const d = tunnelblickDriver(evil, exec, 1);
  await d.up();
  assert.equal(await d.state(), "up");
  for (const c of calls) {
    assert.equal(c.bin, "/usr/bin/osascript");
    const scripts = c.args.filter((_, i) => c.args[i - 1] === "-e");
    for (const s of scripts) assert.ok(!s.includes(evil), `name leaked into script: ${s}`);
    if (c.args.includes(evil)) assert.equal(c.args[c.args.length - 1], evil, "name is the trailing argv item");
  }
});

test("tunnelblick: a stopped app is a VPN that is down — and it is never launched to find that out", async () => {
  const { calls, exec } = recorder(() => ({ stdout: "false\n" }));
  const d = tunnelblickDriver("corp", exec, 1);
  assert.equal(await d.state(), "down");
  await d.down();
  assert.equal(calls.length, 2, "two `is running` checks, no `tell`");
  for (const c of calls) assert.ok(c.args.join(" ").includes("is running"));
});

test("tunnelblick: macOS refusing Automation reads as what to fix", async () => {
  const { exec } = recorder(() => ({ code: 1, stderr: "execution error: Not authorized to send Apple events to Tunnelblick. (-1743)" }));
  await assert.rejects(tunnelblickDriver("corp", exec, 1).state(), /Privacy & Security → Automation/);
});

test("tunnelblick: no connection within the wait → a 504 that names the likely password prompt", async () => {
  const { exec } = recorder((_b, args) => (args.join(" ").includes("is running") ? { stdout: "true" } : args.join(" ").includes("get state") ? { stdout: "PASSWORD_WAIT" } : { stdout: "true" }));
  await assert.rejects(tunnelblickDriver("corp", exec, 1, 20).up(), (e: any) => e.status === 504 && /password/.test(e.message));
});

test("tailscale: BackendState maps to a state, and up is a BARE `tailscale up` (flags would re-state settings)", async () => {
  process.env.CHRONOS_TAILSCALE_BIN = "/opt/test/tailscale";
  try {
    let backend = "Stopped";
    const { calls, exec } = recorder((_b, args) => {
      if (args[0] === "status") return { stdout: JSON.stringify({ BackendState: backend }) };
      if (args[0] === "up") { backend = "Running"; return {}; }
      return {};
    });
    const d = tailscaleDriver(exec, 1);
    assert.equal(await d.state(), "down");
    await d.up();
    assert.equal(await d.state(), "up");
    const up = calls.find((c) => c.args[0] === "up")!;
    assert.deepEqual(up.args, ["up"]);
    assert.equal(up.bin, "/opt/test/tailscale");
    backend = "NeedsLogin";
    assert.equal(await d.state(), "needs-login");
    backend = "Starting";
    assert.equal(await d.state(), "connecting");
  } finally {
    delete process.env.CHRONOS_TAILSCALE_BIN;
  }
});

test("tailscale: an unreadable status is an error, not a guess", async () => {
  process.env.CHRONOS_TAILSCALE_BIN = "/opt/test/tailscale";
  try {
    const { exec } = recorder(() => ({ code: 1, stderr: "failed to connect to local Tailscale service" }));
    await assert.rejects(tailscaleDriver(exec, 1).state(), /failed to connect to local Tailscale service/);
  } finally {
    delete process.env.CHRONOS_TAILSCALE_BIN;
  }
});
