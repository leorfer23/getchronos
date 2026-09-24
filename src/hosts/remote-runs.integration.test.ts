/**
 * Headless runs on another computer, end to end in one process (HOSTS.md phase 5): the brain's real
 * BrainLink, dispatcher, runner and ship pipeline on one side; a real HostLink + HostProcs spawning
 * REAL child processes on the other, over a real WebSocket (the loopback tunnel door, no TLS). The
 * "CLI" is the scripted `mock` backend (CLAUDE.md gotcha 2: sandbox off, tmp dirs, retry_max 0) — the
 * host resolves it from its OWN registry, so what crosses the link is a ProcSpec, never a command line.
 *
 * The brain and the host have different clones of the same repo (same remote, different folders),
 * so every path the run reports must be the host's.
 *
 * Proves: dispatch places a job on the host with room and it completes there with its events; a
 * steer-mode run takes an operator message over the link; a ticket build gets its worktree created
 * ON the host (none on the brain), runs there, and its gates, review diff/commit and mergeability
 * check all run in that worktree through `exec`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";

process.env.CHRONOS_CLAUDE_BIN = "/usr/bin/true";
// The brain's own load is the test machine's: a full reserve makes the idle host the pick, always.
process.env.CHRONOS_BRAIN_RESERVE = "100";
const express = (await import("express")).default;
const { BrainLink } = await import("../hostlink/brain-link.js");
const { HostRegistry } = await import("../hostlink/registry.js");
const { JoinCodes, hashToken, mintHostCredential } = await import("../hostlink/join.js");
const { PROTOCOL_VERSION } = await import("../hostlink/wire.js");
const { HostLink } = await import("../hostd/link.js");
const { HostTerminals } = await import("../hostd/terminals.js");
const { HostProcs } = await import("../hostd/procs.js");
const { HostEgress } = await import("../hostd/egress.js");
const { mockBackend } = await import("../backends/mock.js");
const { startRemoteTerminals } = await import("../remote-terminals.js");
const { startRemoteRuns } = await import("../remote-runs.js");
const { dispatch } = await import("../dispatcher.js");
const { steerRun } = await import("../runner.js");
const { createTicket, dispatchTicket, ticketBranch } = await import("../tickets.js");
const { events, jobs, repos, reviews, runs, tickets, workspaces } = await import("../store.js");
const { worktreeRootFor } = await import("../worktree-core.js");

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "remote-runs-it-")));
const hostHome = path.join(tmp, "host-home");
const profileDir = path.join(hostHome, ".claude-itest");
fs.mkdirSync(profileDir, { recursive: true });
const REMOTE = "https://github.com/itest/app.git";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// One origin, two clones: the brain's and the host's, in different folders.
const origin = path.join(tmp, "origin.git");
const seed = path.join(tmp, "seed");
const brainRepo = path.join(tmp, "brain", "app");
const hostRepo = path.join(tmp, "hostcode", "app");
execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
execFileSync("git", ["clone", "-q", origin, seed], { stdio: "ignore" });
for (const [k, v] of [["user.name", "itest"], ["user.email", "itest@example.com"]]) git(seed, "config", k, v);
fs.writeFileSync(path.join(seed, "README.md"), "# app\n");
git(seed, "add", "-A");
git(seed, "commit", "-q", "-m", "init");
git(seed, "push", "-q", "origin", "HEAD:main");
for (const d of [brainRepo, hostRepo]) {
  fs.mkdirSync(path.dirname(d), { recursive: true });
  execFileSync("git", ["clone", "-q", origin, d], { stdio: "ignore" });
  for (const [k, v] of [["user.name", "itest"], ["user.email", "itest@example.com"]]) git(d, "config", k, v);
}

let brain: InstanceType<typeof BrainLink>;
let server: http.Server;
let hostLink: InstanceType<typeof HostLink>;
let terminals: InstanceType<typeof HostTerminals>;
let procs: InstanceType<typeof HostProcs>;
let stops: Array<() => void> = [];
const cred = mintHostCredential();
const ws = workspaces.create({
  slug: "itest", name: "ITest", config_dir: "/Users/brain-only/.claude-itest", sandbox_mode: "off", default_backend: "mock",
} as any);
const repo = repos.create({
  workspace_id: ws.id, name: "app", path: brainRepo, default_branch: "main", git_remote: REMOTE,
  gate_cmds: JSON.stringify([{ name: "readme", cmd: "echo gate-ran-in:$PWD && test -f README.md" }]),
} as any);

const until = async (cond: () => boolean, what: string, ms = 15_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const finished = async (runId: string) => {
  await until(() => !["queued", "running"].includes(runs.get(runId)?.status ?? ""), `run ${runId.slice(0, 8)} to finish`);
  return runs.get(runId)!;
};

before(async () => {
  const registry = new HostRegistry();
  registry.add({ host_id: cred.host_id, name: "m2", token_hash: hashToken(cred.token) });
  const app = express();
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  brain = new BrainLink({ creds: registry, codes: new JoinCodes(), pingMs: 500, apiTarget: () => ({ host: "127.0.0.1", port }) });
  server.on("upgrade", (req, sock, head) => brain.handleUpgrade(req, sock, head as Buffer, "tunnel"));
  stops = [startRemoteTerminals(brain), startRemoteRuns()];

  const egress = new HostEgress();
  const checkouts = async () => [{ path: hostRepo, remote_url: REMOTE }];
  terminals = new HostTerminals({
    home: hostHome, root: process.cwd(), prepare: false, mcPort: 7777, egress,
    profiles: () => ({ "claude-itest": profileDir }), checkouts, deny: () => [], backends: {},
  });
  procs = new HostProcs({
    home: hostHome, root: process.cwd(), prepare: false, egress,
    profiles: () => ({ "claude-itest": profileDir }), checkouts,
    backends: { mock: mockBackend }, mcPort: () => 7777,
    veto: (w) => terminals.vetoFor(w), allocCh: () => terminals.allocCh(),
  });
  terminals.shareChannels((ch) => procs.owns(ch));
  hostLink = new HostLink({
    brains: [`ws://127.0.0.1:${port}/host`],
    hostId: cred.host_id,
    token: cred.token,
    fp: null,
    hello: async () => ({
      t: "hello", proto: PROTOCOL_VERSION, version: "0.1.0", host_id: cred.host_id, name: "m2", platform: "darwin", arch: "arm64",
      capabilities: { clis: [], node: process.version, sandbox: true, procs: true, egress: true },
      profiles: [{ name: "claude-itest", dir: profileDir, exists: true }],
      checkouts: await checkouts(), deny: [],
      live: [...terminals.live(), ...procs.live()],
    }),
    vitals: async () => ({ at: Date.now(), cpu: 1, ram: 5, gpu: 0, loadPerCore: 0.05, pressure: 1, swapPct: 0, ncpu: 12, load1: 0.6, swapUsedMb: 0, swapTotalMb: 0 }),
    vitalsMs: 200,
    // A drop must outlast the run's last line, so the reconnect is held back.
    backoffMinMs: 1500,
    backoffMaxMs: 1500,
    terminals, procs, egress,
    rpc: {
      exec: (a) => procs.exec(a),
      oneshot: (a) => procs.oneshot(a),
      worktree_ensure: (a) => procs.worktreeEnsure(a),
    },
  });
  const online = new Promise<void>((r) => { const off = brain.onHostOnline(() => { off(); r(); }); });
  hostLink.start();
  await online;
  // Placement reads the host's vitals: wait for the first frame to land.
  const { findHost } = await import("./index.js");
  const { RemoteHost } = await import("./remote.js");
  await until(() => { const h = findHost(cred.host_id); return h instanceof RemoteHost && !!h.latestVitals(); }, "the host's first vitals");
});

after(async () => {
  procs?.killAll();
  terminals?.killAll();
  for (const s of stops) s();
  await hostLink?.stop();
  await brain?.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("a job in the workspace's repo is placed on the host, runs there, and completes with its events", async () => {
  const job = jobs.create({ name: "itest-remote", goal: "hello from afar\n!cost: 0.02", workspace_id: ws.id, backend: "mock", cwd: brainRepo, sandbox: "off", retry_max: 0 } as any);
  const d = dispatch(job.id, "test");
  assert.ok(!("error" in d), (d as any).error);
  const runId = (d as any).run_id;
  assert.equal(runs.get(runId)!.host_id, cred.host_id, "placed before the executor ran (gotcha #1)");
  const r = await finished(runId);
  assert.equal(r.status, "success", r.error ?? "");
  assert.equal(r.summary, "mock: hello from afar");
  assert.equal(r.cost_usd, 0.02);
  assert.equal(r.exit_code, 0);
  assert.equal(r.cwd, hostRepo, "the host's own clone, found by remote — not the brain's path");
  assert.match(r.placement ?? "", /most headroom|only computer/);
  const evs = events.list(runId);
  const init = evs.find((e) => e.type === "system");
  assert.equal(fs.realpathSync(JSON.parse(init!.payload as any).cwd), hostRepo, "the CLI itself ran in the host's checkout");
  assert.ok(evs.some((e) => e.type === "result"));
});

test("steer mode over the link: an operator message reaches the live run on the host", async () => {
  workspaces.update(ws.id, { live_steer: true } as any);
  try {
    const job = jobs.create({ name: "itest-steer", goal: "steer me\n!sleep: 300", workspace_id: ws.id, backend: "mock", cwd: brainRepo, sandbox: "off", retry_max: 0 } as any);
    const d = dispatch(job.id, "test");
    const runId = (d as any).run_id;
    assert.equal(steerRun(runId, "also do this", "operator"), true, "queued before the spawn, flushed after the goal");
    const r = await finished(runId);
    assert.equal(r.status, "success", r.error ?? "");
    assert.equal(r.host_id, cred.host_id);
    const types = events.list(runId).map((e) => e.type);
    assert.ok(types.includes("steer_echo"), `the host's CLI saw the steer: ${types.join(",")}`);
    assert.equal(types.filter((t) => t === "result").length, 2, "one result per message, then stdin closed and it ended");
  } finally {
    workspaces.update(ws.id, { live_steer: false } as any);
  }
});

test("a ticket build: worktree on the host, run there, gates + review diff + merge check through exec", async () => {
  const t = createTicket({ workspace_id: ws.id, repo_id: repo.id, title: "Remote build" } as any);
  const out = await dispatchTicket(t.id);
  assert.ok(out.run_id, `dispatched: ${out.status}`);
  const job = jobs.get(out.job_id)!;
  const hostWtRoot = worktreeRootFor(hostRepo);
  assert.equal(job.host_id, cred.host_id, "the build job is pinned to the host that holds its worktree");
  assert.ok(job.cwd.startsWith(hostWtRoot + "/"), `worktree created ON the host: ${job.cwd}`);
  assert.equal(git(job.cwd, "rev-parse", "--abbrev-ref", "HEAD"), ticketBranch(t.key));
  const brainWt = path.join(worktreeRootFor(brainRepo), ticketBranch(t.key).replace(/\//g, "-"));
  assert.equal(fs.existsSync(brainWt), false, "and none on the brain");
  const r = await finished(out.run_id!);
  // The ticket file lives in the BRAIN's clone (.mc/tickets, gitignored); the run got a copy.
  assert.equal(fs.readFileSync(path.join(hostRepo, ".mc", "tickets", `${t.key}.md`), "utf8"), fs.readFileSync(t.file_path, "utf8"));
  assert.equal(r.status, "success", r.error ?? "");
  assert.equal(r.host_id, cred.host_id);
  assert.equal(r.cwd, job.cwd);

  // finalizeRun → gates in the host's worktree → createForRun → review with the evidence.
  await until(() => reviews.byTicket(t.id).length > 0, "the review to be filed");
  const rev = reviews.byTicket(t.id)[0];
  const gates = JSON.parse(rev.gate_json ?? "[]");
  const readme = gates.find((g: any) => g.name === "readme");
  assert.equal(readme?.ok, true, JSON.stringify(gates));
  assert.match(readme.output ?? "", new RegExp(`gate-ran-in:${job.cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "the gate ran IN the host's worktree");
  assert.equal(gates.find((g: any) => g.name === "mergeable")?.ok, true, "merge-tree against origin/main, on the host");
  assert.equal(tickets.get(t.id)!.status, "review");

  // A reviewer reads the build's worktree, so it is pinned to that host and that directory.
  const { dispatchReview } = await import("../reviews.js");
  const rv = dispatchReview(rev.id);
  const rj = jobs.get(rv.job_id)!;
  assert.equal(rj.host_id, cred.host_id);
  assert.equal(rj.cwd, job.cwd);
  if (rv.run_id) {
    const rr = await finished(rv.run_id);
    assert.equal(rr.host_id, cred.host_id);
    assert.equal(rr.status, "success", rr.error ?? "");
  }
});

test("a link drop mid-run loses nothing and doubles nothing: the result produced offline arrives once", async () => {
  const job = jobs.create({ name: "itest-drop", goal: "survive the drop\n!sleep: 700", workspace_id: ws.id, backend: "mock", cwd: brainRepo, sandbox: "off", retry_max: 0 } as any);
  const d = dispatch(job.id, "test");
  const runId = (d as any).run_id;
  await until(() => events.list(runId).some((e) => e.type === "system"), "the run's first line");
  const offline = new Promise<void>((r) => { const off = brain.onHostOffline(() => { off(); r(); }); });
  (brain as any).links.get(cred.host_id).ws.terminate();
  await offline;
  assert.equal(runs.get(runId)!.status, "running", "a dropped link is not a dead run");
  const r = await finished(runId);
  assert.equal(r.status, "success", r.error ?? "");
  assert.equal(r.summary, "mock: survive the drop");
  const types = events.list(runId).map((e) => e.type);
  assert.equal(types.filter((t) => t === "system").length, 1, `no line twice: ${types.join(",")}`);
  assert.equal(types.filter((t) => t === "result").length, 1);
});
