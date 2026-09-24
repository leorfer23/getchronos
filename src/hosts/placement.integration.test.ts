/**
 * Placement through the daemon's real API (HOSTS.md phase 4), one process: the brain's own
 * `startServer()` on a spare loopback port, its BrainLink singleton taking a real host link through
 * the tunnel door, and a real HostLink + HostTerminals on the other side spawning a REAL pty (`/bin/sh`
 * behind the host's `mock` backend — no agent, no token, CLAUDE.md gotcha 2).
 *
 * Proves: "Auto" (POST /sessions with no host_id) lands on the connected host when the brain is the
 * busier machine, says why on the row and on the bus; an agent is refused with every computer's
 * reason when nobody has room; `mc heavy` forwarded from that host is granted from THAT host's pool
 * (sized ncpu/6 of that host), separate from the brain's, and the slots come back when the terminal
 * ends; `mc machine` from the host reads the host.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
const PORT = await freePort();
process.env.CHRONOS_PORT = String(PORT);
process.env.CHRONOS_CLAUDE_BIN = "/usr/bin/true";

const { startServer } = await import("../api.js");
const { brainLink } = await import("../hostlink/brain-link.js");
const { hashToken, mintHostCredential } = await import("../hostlink/join.js");
const { PROTOCOL_VERSION } = await import("../hostlink/wire.js");
const { HostLink } = await import("../hostd/link.js");
const { HostTerminals } = await import("../hostd/terminals.js");
const { startRemoteTerminals } = await import("../remote-terminals.js");
const { isLive } = await import("../terminal.js");
const { sessions, workspaces } = await import("../store.js");
const { setLoadProbe, startMachineGovernor } = await import("../machine.js");
const { bus } = await import("../bus.js");
const { CONFIG } = await import("../config.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "placement-it-"));
const hostHome = path.join(tmp, "home");
const profileDir = path.join(hostHome, ".claude-pit");
fs.mkdirSync(profileDir, { recursive: true });

// The brain: busy but not refusing (load 1.5/core of 12 → headroom well under the host's).
const BRAIN_BUSY = { load1: 18, ncpu: 12, loadPerCore: 1.5, swapUsedMb: 1000, swapTotalMb: 4000, pressureLevel: 1 as const };
const BRAIN_FULL = { load1: 234, ncpu: 12, loadPerCore: 19.5, swapUsedMb: 12400, swapTotalMb: 13312, pressureLevel: 2 as const };
// What the host reports. Mutable: a test turns it into a thrashing machine.
let hostVitals = { at: 0, cpu: 5, ram: 30, gpu: 0, loadPerCore: 0.1, pressure: 1 as 1 | 2 | 4, swapPct: 10, ncpu: 12, load1: 1.2, swapUsedMb: 400, swapTotalMb: 4000 };

let server: import("node:http").Server;
let hostLink: InstanceType<typeof HostLink>;
let terminals: InstanceType<typeof HostTerminals>;
let stopRemote: () => void;
const cred = mintHostCredential();
const ws = workspaces.create({ slug: "pit", name: "PIT", config_dir: path.join(tmp, "brain", ".claude-pit"), sandbox_mode: "off" });
const reserveWas = CONFIG.placement.brainReserve;
const modeWas = CONFIG.placement.mode;

const base = `http://127.0.0.1:${PORT}/api`;
const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function waitFor(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > ms) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

/** An `mc` call made by an agent on the host, through its forwarder. */
async function fromHost(sessionId: string, method: string, p: string, body?: unknown) {
  const r = await hostLink.api({
    session_id: sessionId, method, path: "/api" + p,
    headers: { "content-type": "application/json", "x-mc-workspace-token": ws.token!, "x-mc-session": sessionId },
    body: body === undefined ? null : Buffer.from(JSON.stringify(body)).toString("base64"),
  });
  return { status: r.status, json: r.body ? JSON.parse(Buffer.from(r.body).toString("utf8")) : null };
}

before(async () => {
  CONFIG.placement.mode = "auto";
  CONFIG.placement.brainReserve = 25;
  setLoadProbe(() => BRAIN_BUSY);
  // Boot wiring index.ts does: the governor's session.ended hook is what frees a terminal's slots.
  startMachineGovernor();
  server = startServer();
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  brainLink().creds.add({ host_id: cred.host_id, name: "m2", token_hash: hashToken(cred.token) });
  stopRemote = startRemoteTerminals(brainLink());

  terminals = new HostTerminals({
    home: hostHome,
    root: process.cwd(),
    prepare: false,
    mcPort: 7777,
    profiles: () => ({ "claude-pit": profileDir }),
    checkouts: async () => [],
    deny: () => [],
    backends: { mock: { name: "mock", bin: () => "/bin/sh", interactiveArgs: () => ["-c", "echo ready; sleep 30"], env: () => ({}) } },
  });
  hostLink = new HostLink({
    brains: [`ws://127.0.0.1:${PORT}/host`],
    hostId: cred.host_id,
    token: cred.token,
    fp: null,
    hello: async () => ({
      t: "hello", proto: PROTOCOL_VERSION, version: "0.1.0", host_id: cred.host_id, name: "m2", platform: "darwin", arch: "arm64",
      capabilities: { clis: [{ name: "git", path: "/usr/bin/git", version: null }], node: process.version, sandbox: true },
      profiles: [{ name: "claude-pit", dir: profileDir, exists: true }], checkouts: [], deny: [],
      live: terminals.live(),
    }),
    vitals: async () => ({ ...hostVitals, at: Date.now() }),
    vitalsMs: 100,
    terminals,
  });
  const online = new Promise<void>((r) => { const off = brainLink().onHostOnline(() => { off(); r(); }); });
  hostLink.start();
  await online;
  // A first vitals frame must have arrived: no reading, no admission.
  const { findHost } = await import("./index.js");
  await waitFor(() => !!(findHost(cred.host_id) as any)?.latestVitals(), "the host's first vitals frame");
});

after(async () => {
  setLoadProbe(null);
  CONFIG.placement.brainReserve = reserveWas;
  CONFIG.placement.mode = modeWas;
  terminals?.killAll();
  stopRemote?.();
  await hostLink?.stop();
  await brainLink().close();
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("Auto: POST /sessions with no host_id lands on the host with the most headroom, and says why", async () => {
  const placed: any[] = [];
  const onEv = (e: any) => { if (e?.topic === "session.placed") placed.push(e); };
  bus.on("event", onEv);
  try {
    const r = await post("/sessions", { workspace_id: ws.id, backend: "mock", cols: 80, rows: 24 });
    const s = await r.json();
    assert.equal(r.status, 201, JSON.stringify(s));
    assert.equal(s.host_id, cred.host_id, "the idle host, not the busy brain");
    assert.match(s.placement, /^most headroom \(m2 \d+ · local \d+−25\)$/);
    assert.equal(sessions.get(s.id)!.placement, s.placement, "kept on the row");
    assert.ok(isLive(s.id));
    assert.deepEqual(placed.map((e) => [e.session_id, e.host_id]), [[s.id, cred.host_id]]);
    await fetch(`${base}/sessions/${s.id}/kill`, { method: "POST" });
    await waitFor(() => sessions.get(s.id)!.status === "ended", "the host terminal to end");
  } finally {
    bus.off("event", onEv);
  }
});

test("a pin to the brain — or a brain directory — keeps a terminal local even when a host has more room", async () => {
  for (const body of [{ host_id: "local" }, { cwd: tmp }]) {
    const r = await post("/sessions", { workspace_id: ws.id, backend: "mock", ...body });
    const s = await r.json();
    assert.equal(r.status, 201, JSON.stringify(s));
    assert.equal(s.host_id, "local");
    await fetch(`${base}/sessions/${s.id}/kill`, { method: "POST" });
  }
});

test("nobody has room: an agent is refused with every computer's reason; the operator still gets one", async () => {
  setLoadProbe(() => BRAIN_FULL);
  hostVitals = { ...hostVitals, loadPerCore: 3.1, load1: 37.2, pressure: 1 };
  const { findHost } = await import("./index.js");
  await waitFor(() => (findHost(cred.host_id) as any)?.latestVitals()?.loadPerCore === 3.1, "the busy vitals frame");
  try {
    const r = await post("/sessions", { workspace_id: ws.id, backend: "mock", created_by: "robert" });
    const body = await r.json();
    assert.equal(r.status, 400);
    assert.match(body.error, /^no computer has room — m2: load 37\.2 on 12 cores, memory pressure normal \(swap 10% used\); retry when workers finish; local: load 234\.0 on 12 cores/);

    const op = await post("/sessions", { workspace_id: ws.id, backend: "mock" });
    const s = await op.json();
    assert.equal(op.status, 201, JSON.stringify(s));
    assert.equal(s.host_id, cred.host_id, "least loaded: the host at 3.1/core beats the brain at 19.5");
    assert.match(s.placement, /^every computer is busy — least loaded/);
    await fetch(`${base}/sessions/${s.id}/kill`, { method: "POST" });
    await waitFor(() => sessions.get(s.id)!.status === "ended", "the host terminal to end");
  } finally {
    setLoadProbe(() => BRAIN_BUSY);
    hostVitals = { ...hostVitals, loadPerCore: 0.1, load1: 1.2 };
    await waitFor(() => (findHost(cred.host_id) as any)?.latestVitals()?.loadPerCore === 0.1, "calm vitals again");
  }
});

test("mc heavy from a host is granted from THAT host's pool (ncpu/6), and freed when its terminal ends", async () => {
  const r = await post("/sessions", { workspace_id: ws.id, backend: "mock" });
  const s = await r.json();
  assert.equal(s.host_id, cred.host_id);

  // 12 cores on the host → 2 slots there, whatever the brain's own CHRONOS_HEAVY_SLOTS is.
  const m = await fromHost(s.id, "GET", "/machine");
  assert.equal(m.status, 200, JSON.stringify(m.json));
  assert.equal(m.json.host_id, cred.host_id);
  assert.equal(m.json.ncpu, 12);
  assert.equal(m.json.heavy.slots, 2);
  assert.equal(m.json.admission.ok, true);

  const a = await fromHost(s.id, "POST", "/machine/slots", { session_id: s.id, label: "npm test" });
  const b = await fromHost(s.id, "POST", "/machine/slots", { session_id: s.id, label: "tsc -b" });
  assert.equal(a.json.granted, true);
  assert.equal(b.json.granted, true);
  assert.equal(a.json.slots, 2);

  // The brain's own pool never saw them: two suites on two Macs do not wait for each other.
  const local = await (await fetch(base + "/machine")).json();
  assert.equal(local.host_id, undefined);
  assert.deepEqual(local.heavy.holders, []);
  const there = await fromHost(s.id, "GET", "/machine");
  assert.deepEqual(there.json.heavy.holders.map((h: any) => h.label), ["npm test", "tsc -b"]);

  // Heartbeat and release go to the same pool.
  assert.equal((await fromHost(s.id, "PUT", `/machine/slots/${a.json.slot_id}`)).status, 200);
  assert.equal((await fetch(`${base}/machine/slots/${a.json.slot_id}`, { method: "PUT" })).status, 404, "unknown to the brain's pool");
  assert.equal((await fromHost(s.id, "DELETE", `/machine/slots/${a.json.slot_id}`)).json.released, true);

  // The terminal ends → whatever it still held on its host is released.
  await fetch(`${base}/sessions/${s.id}/kill`, { method: "POST" });
  await waitFor(() => sessions.get(s.id)!.status === "ended", "the host terminal to end");
  const { findHost } = await import("./index.js");
  await waitFor(() => findHost(cred.host_id)!.slots.holders().length === 0, "the host's slots to be released");
});
