/**
 * The host's own state is sealed from every agent it runs (config.ts → sandbox.sealed).
 *
 * `~/.chronos-host` holds the host token (`.secrets` — whoever reads it IS this host to the brain),
 * queued `mc` writes carrying each workspace's token (`outbox/`), and terminal output (`spill/`). A
 * host serving two clients runs both clients' agents as the same user, so file modes do not separate
 * them; the Seatbelt profile has to. The deny comes after every re-grant — the agent's own cwd (a
 * terminal with no repo starts in $HOME, the parent of the host home) and a workspace's sandbox_allow
 * — and these tests prove it on real `sandbox-exec`, through the two ways a host spawns an agent:
 * a Desk terminal (terminals.ts) and a headless run (procs.ts).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { HostToBrain } from "../hostlink/wire.js";
import type { TerminalsLink } from "./terminals.js";

// realpath: macOS tmp is /var → /private/var, and Seatbelt matches resolved paths.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hostd-sealed-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const home = path.join(tmp, "home");
const hostHome = path.join(home, ".chronos-host");
const hostlink = path.join(tmp, "brain", "hostlink");
const repo = path.join(tmp, "code", "app");
for (const d of [path.join(hostHome, "outbox"), path.join(hostHome, "spill"), hostlink, repo]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(hostHome, ".secrets"), "CHRONOS_HOST_TOKEN=host-secret-7f3\n", { mode: 0o600 });
fs.writeFileSync(path.join(hostHome, "outbox", "0000000000000001.json"), '{"headers":{"x-mc-workspace-token":"ws-secret-9c1"}}', { mode: 0o600 });
fs.writeFileSync(path.join(hostlink, "brain-key.pem"), "brain-key-secret-2d8");
fs.writeFileSync(path.join(home, "notes.txt"), "plain-file-ok\n");

// Before config.ts is evaluated: it reads both when it builds the deny list.
process.env.CHRONOS_HOST_HOME = hostHome;
process.env.CHRONOS_HOSTLINK_DIR = hostlink;
const { buildProfile, sandboxAvailable, SANDBOX_EXEC } = await import("../sandbox.js");
const { CONFIG } = await import("../config.js");
const { HostTerminals } = await import("./terminals.js");
const { HostProcs } = await import("./procs.js");

const noSandbox = sandboxAvailable() ? false : "sandbox-exec is macOS-only — no profile to read";

// Reads the secrets, tries to plant a queued write, then proves ordinary files still work.
const PROBE = [
  `cat ${JSON.stringify(path.join(hostHome, ".secrets"))}`,
  `cat ${JSON.stringify(path.join(hostHome, "outbox", "0000000000000001.json"))}`,
  `echo forged > ${JSON.stringify(path.join(hostHome, "outbox", "0000000000000002.json"))}`,
  `cat ${JSON.stringify(path.join(hostlink, "brain-key.pem"))}`,
  `cat ${JSON.stringify(path.join(home, "notes.txt"))}`,
  "echo probe-done",
].map((c) => `${c} 2>&1`).join("; ");

function assertSealed(out: string) {
  assert.match(out, /plain-file-ok/, "the agent still reads ordinary files");
  assert.match(out, /probe-done/);
  for (const s of ["host-secret-7f3", "ws-secret-9c1", "brain-key-secret-2d8"]) assert.ok(!out.includes(s), `${s} leaked:\n${out}`);
  assert.match(out, /Operation not permitted/);
  assert.equal(fs.existsSync(path.join(hostHome, "outbox", "0000000000000002.json")), false, "no forged outbox entry");
}

test("the host home and the hostlink dir are on the sealed list, resolved", () => {
  for (const p of [hostHome, hostlink]) assert.ok(CONFIG.sandbox.sealed.includes(p), p);
});

test("the seal is the last word: after the agent's own cwd and a workspace's sandbox_allow", { skip: noSandbox }, () => {
  for (const mode of ["guard", "strict"] as const) {
    // The worst case on purpose: cwd is $HOME (a terminal with no repo) and the workspace was
    // "trusted" with the host home itself.
    const lines = buildProfile(mode, home, [], path.join(home, ".claude"), [], false, [], [hostHome])!.split("\n");
    const last = (head: string) => lines.map((l, i) => (l.startsWith(head) && l.includes(`(subpath ${JSON.stringify(hostHome)})`) ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
    const regrant = last("(allow file-read*"), sealR = last("(deny file-read*"), sealW = last("(deny file-write*");
    assert.ok(regrant >= 0 && sealR > regrant && sealW > regrant, `${mode}: the deny must follow every allow of ${hostHome}`);
  }
});

test("on real sandbox-exec, guard and strict both keep an agent in $HOME out of the host home", { skip: noSandbox }, () => {
  for (const mode of ["guard", "strict"] as const) {
    const profile = buildProfile(mode, home, [], path.join(home, ".claude"), [], false, [], [hostHome])!;
    const r = spawnSync(SANDBOX_EXEC, ["-p", profile, "/bin/sh", "-c", PROBE], { cwd: home, encoding: "utf8" });
    assertSealed(r.stdout + r.stderr);
  }
});

class FakeLink implements TerminalsLink {
  frames: HostToBrain[] = [];
  text = "";
  online() { return true; }
  send(f: HostToBrain) { this.frames.push(f); return true; }
  sendData(_ch: number, _seq: number, bytes: Buffer) { this.text += bytes.toString("utf8"); return true; }
}

const until = async (cond: () => boolean, what: string, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("a remote Desk terminal (terminals.ts) spawned under guard cannot read or write the host home", { skip: noSandbox }, async () => {
  const t = new HostTerminals({
    home, root: process.cwd(), prepare: false, mcPort: 7777,
    profiles: () => ({ claude: path.join(home, ".claude") }),
    checkouts: async () => [],
    deny: () => [],
    backends: { sh: { name: "sh", bin: () => "/bin/sh", interactiveArgs: () => ["-c", PROBE], env: () => ({}) } },
  });
  const link = new FakeLink();
  t.attachLink(link);
  try {
    const r = await t.spawn({
      kind: "intent", session_id: "sess-sealed", workspace: { id: "ws-a", slug: "acme" }, backend: "sh", model: null, role: "human",
      cli_session: null, resume: false, repo: null, repos: [], worktree: null, resume_cwd: null, cwd_hint: "landing",
      profile: "claude", sandbox: { mode: "guard", allow: [], egress_locked: false }, system: null, env: {}, env_home_relative: [],
      nice: 0, cols: 200, rows: 24, seed: null,
    });
    assert.equal(r.cwd, home, "no repo → the host's home, the parent of the sealed dir");
    await until(() => link.text.includes("probe-done"), "the probe to finish");
    assertSealed(link.text);
  } finally {
    t.killAll();
  }
});

test("a headless run (procs.ts) spawned under guard cannot read or write the host home", { skip: noSandbox }, async () => {
  const REMOTE = "git@github.com:acme/app.git";
  const p = new HostProcs({
    home, root: process.cwd(), prepare: false,
    profiles: () => ({ claude: path.join(home, ".claude") }),
    checkouts: async () => [{ path: repo, remote_url: REMOTE }],
    backends: { sh: { name: "sh", bin: () => "/bin/sh", buildArgs: (job) => ["-c", job.goal], env: () => ({}) } },
    mcPort: () => 7788,
    veto: () => null,
    allocCh: () => 1,
    graceMs: 0,
    killGraceMs: 500,
  });
  const link = new FakeLink();
  p.attachLink(link);
  const r = await p.spawn({
    kind: "proc", run_id: "run-sealed", workspace: { id: "ws-a", slug: "acme" }, backend: "sh", profile: "claude",
    job: { name: "t", goal: PROBE, append_system: null, model: null, allowed_tools: null, disallowed_tools: null, max_budget_usd: null },
    context: null, session_id: "sess", resume: null, steer: false,
    repo: { id: "repo-app", git_remote: REMOTE }, repos: [{ id: "repo-app", git_remote: REMOTE }], cwd: null,
    sandbox: { mode: "guard", allow: [], egress_locked: false }, egress: null, env: {}, env_home_relative: [], nice: 0,
    timeout_ms: 30_000, files: [],
  });
  await until(() => link.frames.some((f) => f.t === "exit" && f.ch === r.ch), "the run's exit");
  assertSealed(link.text + link.frames.filter((f) => f.t === "stderr").map((f: any) => f.text).join(""));
});
