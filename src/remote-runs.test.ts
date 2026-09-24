/**
 * Headless runs on a host after something restarted (src/remote-runs.ts, HOSTS.md phase 5), against
 * the in-memory store and a RemoteHost on a stub link that records what the brain sends:
 *
 *  - a run the host still reports and this brain holds → re-attached from our last seq;
 *  - reported but not held (the BRAIN restarted) → adopted, then attached;
 *  - not reported (the HOST restarted) → interrupted, the reason naming the computer;
 *  - reported but ended here → stopped there and released;
 *  - a removed host's runs → interrupted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CHRONOS_CLAUDE_BIN = "/usr/bin/true";
const { hosts, jobs, runs, workspaces } = await import("./store.js");
const { registerHost } = await import("./hosts/index.js");
const { RemoteHost } = await import("./hosts/remote.js");
const { reconcileRuns, interruptRunsOn } = await import("./remote-runs.js");
const { PROTOCOL_VERSION } = await import("./hostlink/wire.js");
type BrainToHost = import("./hostlink/wire.js").BrainToHost;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "remote-runs-"));
const ws = workspaces.create({ slug: "rr", name: "RR", config_dir: path.join(tmp, ".claude-rr"), sandbox_mode: "off" } as any);
const sent: BrainToHost[] = [];
const port = { isOnline: () => true, sendControl: (_host: string, f: BrainToHost) => { sent.push(f); return true; }, request: async () => ({}) };
hosts.create({ id: "h_m2", name: "m2", token_hash: "x".repeat(64), status: "online" });
const m2 = new RemoteHost("h_m2", port);
registerHost(m2);

const job = jobs.create({ name: "rr-job", goal: "g", workspace_id: ws.id, backend: "mock", cwd: tmp, sandbox: "off", retry_max: 0 } as any);
const running = (over: Record<string, unknown> = {}) => {
  const r = runs.create(job.id, "test");
  runs.patch(r.id, { status: "running", host_id: "h_m2", started_at: new Date().toISOString(), cwd: "/Users/other/code/app", ...over } as any);
  return runs.get(r.id)!;
};
const hello = (live: any[]) => m2.setOnline({
  proto: PROTOCOL_VERSION, version: "0.1.0", host_id: "h_m2", name: "m2", platform: "darwin", arch: "arm64",
  capabilities: { clis: [], node: process.version, sandbox: true, procs: true }, profiles: [], checkouts: [], deny: [], live,
} as any);

test("reconcile: re-attach what we hold, adopt what a restarted brain lost, interrupt what the host lost", async () => {
  sent.length = 0;
  const held = running();
  const lostWhileHeld = running();
  const adopted = running();
  const gone = running();
  const endedHere = runs.create(job.id, "test");
  runs.patch(endedHere.id, { status: "killed", host_id: "h_m2" } as any);

  // What this brain holds from before the blip: two runs whose readers are wired.
  const heldProc = m2.adoptProc({ ch: 11, session_id: held.id, kind: "proc", pid: 1, last_seq: 0 });
  const lostProc = m2.adoptProc({ ch: 12, session_id: lostWhileHeld.id, kind: "proc", pid: 2, last_seq: 0 });
  let closedWith: [number | null, string | null] | null = null;
  lostProc.onClose((c, s) => { closedWith = [c, s]; });
  lostProc.stdout.resume();

  hello([
    { ch: 11, session_id: held.id, kind: "proc", pid: 1, last_seq: 4 },
    { ch: 13, session_id: adopted.id, kind: "proc", pid: 3, last_seq: 9 },
    { ch: 14, session_id: endedHere.id, kind: "proc", pid: 4, last_seq: 1 },
    { ch: 99, session_id: "not-a-run-of-ours", kind: "proc", pid: 5, last_seq: 0 },
    // A terminal on the same host is remote-terminals.ts's business, not this walk's.
    { ch: 21, session_id: "some-terminal", kind: "pty", pid: 6, last_seq: 0 },
  ]);
  const adoptedWith: string[] = [];
  const r = await reconcileRuns(m2, { adopt: async (_j, runId, p) => { adoptedWith.push(`${runId}:${p.ch}`); return "running"; } });

  assert.deepEqual(r.reattached, [held.id]);
  assert.deepEqual(r.adopted, [adopted.id]);
  assert.deepEqual(adoptedWith, [`${adopted.id}:13`]);
  assert.deepEqual(r.lost.sort(), [lostWhileHeld.id, gone.id].sort());
  assert.deepEqual(r.orphans, [14]);

  // Held + reported → one attach from our last seq (0 here); adopted → attach AFTER its readers.
  assert.ok(sent.some((f) => f.t === "attach" && f.ch === 11 && f.session_id === held.id));
  assert.ok(sent.some((f) => f.t === "attach" && f.ch === 13 && f.session_id === adopted.id));
  // Ended here while the host was away → stopped there, and released.
  assert.ok(sent.some((f) => f.t === "kill" && f.ch === 14));
  assert.ok(sent.some((f) => f.t === "release" && f.ch === 14));
  assert.ok(!sent.some((f) => (f as any).ch === 99), "an unknown run is left alone — it may be another brain's");
  assert.ok(!sent.some((f) => (f as any).ch === 21), "terminals are not this walk's to touch");

  // Not held, not reported: nobody's runner will end it — reconcile does, naming the computer.
  const g = runs.get(gone.id)!;
  assert.equal(g.status, "interrupted");
  assert.match(g.error ?? "", /its host m2 restarted while the run was active/);
  // Held but not reported: the held handle is LOST, which is the runner's close path to interrupted.
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(closedWith, [null, "SIGLOST"]);
  assert.match(lostProc.lost ?? "", /its host m2 restarted/);
  void heldProc;
});

test("a removed host takes its runs with it", () => {
  const a = running();
  const b = running({ host_id: "h_m5" });
  assert.equal(interruptRunsOn("h_m2") >= 1, true);
  assert.equal(runs.get(a.id)!.status, "interrupted");
  assert.match(runs.get(a.id)!.error ?? "", /its host m2 was removed/);
  assert.equal(runs.get(b.id)!.status, "running", "only that host's runs");
});
