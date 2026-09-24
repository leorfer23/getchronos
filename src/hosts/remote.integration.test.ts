/**
 * A remote terminal end to end, in one process: the brain's real BrainLink and openSession on one
 * side, a real HostLink + HostTerminals spawning a REAL pty on the other, over a real WebSocket (the
 * loopback tunnel door, so no TLS setup). The "CLI" is `/bin/sh` behind the host's `mock` backend —
 * no agent, no token (CLAUDE.md gotcha 2) — and every module is imported after CHRONOS_CLAUDE_BIN
 * points at `true`, so a closing terminal's exit digest boots nothing.
 *
 * Proves: output reaches the Desk's Live entry, input reaches the pty, a link drop mid-session loses
 * nothing and duplicates nothing (output produced while the link was down is replayed exactly once),
 * the exit closes the row, a forwarded `mc` call is held to its own session/host/workspace, and the
 * host's veto refuses before forking.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

process.env.CHRONOS_CLAUDE_BIN = "/usr/bin/true";
const express = (await import("express")).default;
const { BrainLink } = await import("../hostlink/brain-link.js");
const { HostRegistry } = await import("../hostlink/registry.js");
const { JoinCodes, hashToken, mintHostCredential } = await import("../hostlink/join.js");
const { PROTOCOL_VERSION } = await import("../hostlink/wire.js");
const { HostLink } = await import("../hostd/link.js");
const { HostTerminals } = await import("../hostd/terminals.js");
const { startRemoteTerminals, sessionHostOffline } = await import("../remote-terminals.js");
const { openSession, attach, writeTo, isLive } = await import("../terminal.js");
const { sessions, workspaces } = await import("../store.js");
const { forwardedGate } = await import("../authz.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "remote-term-it-"));
const hostHome = path.join(tmp, "home");
const profileDir = path.join(hostHome, ".claude-itest");
fs.mkdirSync(profileDir, { recursive: true });

// What the "CLI" does: greet, echo one line back, keep talking a moment later (that line is what a
// link drop must not lose or double), then echo a second line and exit.
const SCRIPT = 'echo hi; read x; echo "got:$x"; sleep 0.6; echo "during-drop"; read y; echo "bye:$y"';

let brain: InstanceType<typeof BrainLink>;
let server: http.Server;
let port = 0;
let hostLink: InstanceType<typeof HostLink>;
let terminals: InstanceType<typeof HostTerminals>;
let stopRemote: () => void;
const cred = mintHostCredential();
const ws = workspaces.create({ slug: "itest", name: "ITest", config_dir: "/Users/brain-only/.claude-itest" });
const other = workspaces.create({ slug: "other", name: "Other", config_dir: "/tmp/other" });

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

before(async () => {
  const registry = new HostRegistry();
  registry.add({ host_id: cred.host_id, name: "m2", token_hash: hashToken(cred.token) });
  // The brain's API, as far as this test needs it: the forwarded-request gate in front of one route.
  const app = express();
  const api = express.Router();
  api.use(forwardedGate);
  api.get("/probe", (_req, res) => res.json({ ok: true }));
  app.use("/api", api);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as any).port;
  brain = new BrainLink({ creds: registry, codes: new JoinCodes(), pingMs: 200, apiTarget: () => ({ host: "127.0.0.1", port }) });
  server.on("upgrade", (req, sock, head) => brain.handleUpgrade(req, sock, head as Buffer, "tunnel"));
  stopRemote = startRemoteTerminals(brain);

  terminals = new HostTerminals({
    home: hostHome,
    root: process.cwd(),
    prepare: false,
    mcPort: 7777,
    profiles: () => ({ "claude-itest": profileDir }),
    checkouts: async () => [],
    deny: () => ["denied-here"],
    backends: { mock: { name: "mock", bin: () => "/bin/sh", interactiveArgs: () => ["-c", SCRIPT], env: () => ({}) } },
  });
  hostLink = new HostLink({
    brains: [`ws://127.0.0.1:${port}/host`],
    hostId: cred.host_id,
    token: cred.token,
    fp: null,
    hello: async () => ({
      t: "hello", proto: PROTOCOL_VERSION, version: "0.1.0", host_id: cred.host_id, name: "m2", platform: "darwin", arch: "arm64",
      capabilities: { clis: [], node: process.version, sandbox: true }, profiles: [], checkouts: [], deny: ["denied-here"],
      live: terminals.live(),
    }),
    vitals: async () => ({ at: Date.now(), cpu: 1, ram: 1, gpu: 0, loadPerCore: 0.1, pressure: 1, swapPct: 0 }),
    vitalsMs: 1000,
    // A drop must outlast the CLI's next line, so the reconnect is held back ≥ 1s.
    backoffMinMs: 2400,
    backoffMaxMs: 2400,
    terminals,
  });
  const online = new Promise<void>((r) => { const off = brain.onHostOnline(() => { off(); r(); }); });
  hostLink.start();
  await online;
});

after(async () => {
  terminals?.killAll();
  stopRemote?.();
  await hostLink?.stop();
  await brain?.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("a Desk terminal pinned to a host runs there end to end, and survives a link drop", async () => {
  const s = await openSession({ workspace_id: ws.id, backend: "mock", host_id: cred.host_id, cols: 80, rows: 24 } as any);
  assert.equal(s.host_id, cred.host_id);
  assert.ok(isLive(s.id), "on the wall like any local terminal");
  const row = sessions.get(s.id)!;
  assert.equal(row.cwd, hostHome, "the host chose the cwd (no repo → its home) and the row records it");
  assert.ok((row.pid ?? 0) > 0, "a real pid — on that host");

  // A Desk client on the terminal, exactly as /term attaches one.
  let screen = "";
  const client: any = { readyState: 1, bufferedAmount: 0, send: (d: string) => { screen += d; }, on: () => {} };
  assert.ok(attach(s.id, client));
  await waitFor(() => screen.includes("hi"), "the CLI's first output");

  writeTo(s.id, "abc\r");
  await waitFor(() => screen.includes("got:abc"), "input to reach the pty and its answer to come back");

  // Drop the link mid-session. The pty keeps running over there and prints "during-drop" while no
  // link exists; the brain marks the host offline and does not end anything.
  const offline = new Promise<void>((r) => { const off = brain.onHostOffline(() => { off(); r(); }); });
  (brain as any).links.get(cred.host_id).ws.terminate();
  await offline;
  assert.equal(sessionHostOffline(sessions.get(s.id)!), true);
  assert.equal(sessions.get(s.id)!.status, "live", "offline is a flag, not an ending");
  assert.ok(isLive(s.id));
  assert.ok(!screen.includes("during-drop"), "that line was produced while the link was down");

  // Reconnect → hello.live[] → re-attach → the host resends only what the brain lacks.
  await waitFor(() => screen.includes("during-drop"), "the line produced during the drop, after reconnect", 10000);
  assert.equal(sessionHostOffline(sessions.get(s.id)!), false);
  await new Promise((r) => setTimeout(r, 300)); // any duplicate resend would have landed by now
  assert.equal(screen.split("during-drop").length - 1, 1, `replayed exactly once:\n${screen}`);
  assert.equal(screen.split("got:abc").length - 1, 1, "and nothing from before the drop came twice");

  // A forwarded `mc` call from that host is held to its own session, host and workspace.
  const call = (headers: Record<string, string>) => hostLink.api({ session_id: s.id, method: "GET", path: "/api/probe", headers, body: null });
  assert.equal((await call({ "x-mc-workspace-token": ws.token!, "x-mc-session": s.id })).status, 200);
  assert.equal((await call({ "x-mc-session": s.id })).status, 401, "no token is never loopback trust");
  const wrongWs = await call({ "x-mc-workspace-token": other.token!, "x-mc-session": s.id });
  assert.equal(wrongWs.status, 403, "another workspace's token cannot speak for this session");

  writeTo(s.id, "z\r");
  await waitFor(() => screen.includes("bye:z"), "the second answer");
  await waitFor(() => sessions.get(s.id)!.status === "ended", "the exit to close the row");
  assert.equal(isLive(s.id), false);
  await waitFor(() => terminals.live().length === 0, "the host to forget the channel once the brain released it");
});

test("the host's own veto refuses before forking, and the brain logs it", async () => {
  const denied = workspaces.create({ slug: "denied-here", name: "Denied", config_dir: "/tmp/denied" });
  // The brain's lock #1 sees the veto the host reported in hello and refuses first.
  await assert.rejects(openSession({ workspace_id: denied.id, backend: "mock", host_id: cred.host_id } as any), /not allowed on host m2/);
  // Past a brain that did not know (a spec sent straight to the host), lock #2 still holds.
  await assert.rejects(terminals.spawn({
    kind: "intent", session_id: "x", workspace: { id: denied.id, slug: "denied-here" }, backend: "mock", model: null, role: "human",
    cli_session: null, resume: false, repo: null, repos: [], worktree: null, resume_cwd: null, cwd_hint: "landing", profile: "claude-itest",
    sandbox: { mode: "off", allow: [], egress_locked: false }, system: null, env: {}, env_home_relative: [], nice: 0, cols: 80, rows: 24, seed: null,
  }), /^Error: veto:/);
  assert.equal(terminals.live().length, 0);
});
