/**
 * MC_HOST_* on a host (HOSTS.md → "Agents know where they are"): the host stamps its own identity on
 * every terminal and headless run it spawns, AFTER the env the brain sent — so an agent on m2 is told
 * it is on m2 even if the brain guessed wrong, or sent nothing at all.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostTerminals, type HostBackend, type TerminalsLink } from "./terminals.js";
import { HostProcs, type ProcBackend } from "./procs.js";
import { hostSelfEnv } from "./resolve.js";
import type { HostToBrain } from "../hostlink/wire.js";
import type { SpawnSpec } from "../hosts/spawn-spec.js";
import type { ProcSpec } from "../hosts/proc-spec.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hostd-self-"));
after(() => fs.rmSync(home, { recursive: true, force: true }));

const PRINT = `echo "id=$MC_HOST_ID name=$MC_HOST_NAME brain=$MC_HOST_BRAIN"`;
// What the brain's mcEnv would send for a remote spawn — here deliberately stale, to prove the host wins.
const BRAIN_ENV = { MC_HOST_ID: "h_stale", MC_HOST_NAME: "old-name", MC_HOST_BRAIN: "1" };
const self = () => ({ id: "h_m2", name: "m2" });

class FakeLink implements TerminalsLink {
  frames: HostToBrain[] = [];
  out = "";
  online() { return true; }
  send(f: HostToBrain) { this.frames.push(f); return true; }
  sendData(_ch: number, _seq: number, bytes: Buffer) { this.out += bytes.toString("utf8"); return true; }
}

const until = async (cond: () => boolean, what: string, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("hostSelfEnv: id, the operator's name (else the id), and never the brain", () => {
  assert.deepEqual(hostSelfEnv({ id: "h_m2", name: "m2" }), { MC_HOST_ID: "h_m2", MC_HOST_NAME: "m2", MC_HOST_BRAIN: "0" });
  assert.equal(hostSelfEnv({ id: "h_m2", name: "" }).MC_HOST_NAME, "h_m2");
  assert.deepEqual(hostSelfEnv(null), {}, "no identity: leave whatever the brain sent");
});

test("a host terminal sees the host's own MC_HOST_*, over the brain's", async () => {
  const sh: HostBackend = { name: "sh", bin: () => "/bin/sh", interactiveArgs: () => ["-c", PRINT], env: () => ({}) };
  const t = new HostTerminals({
    home, root: process.cwd(), prepare: false, mcPort: 7777,
    profiles: () => ({ claude: home }), checkouts: async () => [], deny: () => [], backends: { sh }, self,
  });
  const link = new FakeLink();
  t.attachLink(link);
  const spec: SpawnSpec = {
    kind: "intent", session_id: "sess-self", workspace: { id: "ws-a", slug: "acme" }, backend: "sh", model: null, role: "human",
    cli_session: null, resume: false, repo: null, repos: [], worktree: null, resume_cwd: null, cwd_hint: "landing",
    profile: "claude", sandbox: { mode: "off", allow: [], egress_locked: false }, system: null, env: BRAIN_ENV, env_home_relative: [],
    nice: 0, cols: 120, rows: 24, seed: null,
  };
  await t.spawn(spec);
  await until(() => /brain=\d/.test(link.out), "the terminal's output");
  assert.match(link.out, /id=h_m2 name=m2 brain=0/);
  t.killAll();
});

test("a host's headless run sees the host's own MC_HOST_*, over the brain's", async () => {
  const sh: ProcBackend = { name: "sh", bin: () => "/bin/sh", buildArgs: (job) => ["-c", job.goal], env: () => ({}) };
  let n = 0;
  const p = new HostProcs({
    home, root: process.cwd(), prepare: false,
    profiles: () => ({ claude: home }), checkouts: async () => [], backends: { sh },
    mcPort: () => 7777, veto: () => null, allocCh: () => ++n, self,
  });
  const link = new FakeLink();
  p.attachLink(link);
  const spec: ProcSpec = {
    kind: "proc", run_id: "run-self", workspace: { id: "ws-a", slug: "acme" }, backend: "sh", profile: "claude",
    job: { name: "t", goal: PRINT, append_system: null, model: null, allowed_tools: null, disallowed_tools: null, max_budget_usd: null },
    context: null, session_id: "sess", resume: null, steer: false, repo: null, repos: [], cwd: null,
    sandbox: { mode: "off", allow: [], egress_locked: false }, egress: null, env: BRAIN_ENV, env_home_relative: [], nice: 0,
    timeout_ms: 30_000, files: [],
  };
  const r = await p.spawn(spec);
  await until(() => link.frames.some((f) => f.t === "exit" && f.ch === r.ch), "the run's exit");
  assert.equal(link.out.trim(), "id=h_m2 name=m2 brain=0");
});
