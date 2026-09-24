import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostTerminals, VetoError, remoteKey, type HostBackend } from "./terminals.js";
import type { SpawnSpec } from "../hosts/spawn-spec.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hostd-terms-"));
const spec = (over: Partial<SpawnSpec> = {}): SpawnSpec => ({
  kind: "intent", session_id: "sess-veto", workspace: { id: "ws-g", slug: "galley" }, backend: "sh", model: null, role: "human",
  cli_session: null, resume: false, repo: null, repos: [], worktree: null, resume_cwd: null, cwd_hint: "landing",
  profile: "claude", sandbox: { mode: "off", allow: [], egress_locked: false }, system: null, env: {}, env_home_relative: [],
  nice: 0, cols: 80, rows: 24, seed: null, ...over,
});

function terminals(deny: string[], calls: string[]) {
  const sh: HostBackend = { name: "sh", bin: () => "/bin/sh", interactiveArgs: () => { calls.push("args"); return ["-c", "echo hi"]; }, env: () => ({}) };
  return new HostTerminals({
    home, root: process.cwd(), prepare: false, mcPort: 7777,
    profiles: () => { calls.push("profiles"); return { claude: home }; },
    checkouts: async () => { calls.push("checkouts"); return []; },
    deny: () => deny,
    backends: { sh },
  });
}

test("local veto: a denied workspace is refused BEFORE anything is resolved or forked", async () => {
  for (const deny of [["galley"], ["ws-g"]]) {
    const calls: string[] = [];
    const t = terminals(deny, calls);
    await assert.rejects(t.spawn(spec()), (e: any) => e instanceof VetoError && /^veto: workspace galley is denied/.test(e.message));
    assert.deepEqual(calls, [], "no profile lookup, no checkout scan, no argv — nothing ran");
    assert.deepEqual(t.live(), [], "no pty");
  }
});

test("an allowed workspace spawns, and the refusal messages for what a host cannot do are explicit", async () => {
  const calls: string[] = [];
  const t = terminals(["gfm"], calls);
  await assert.rejects(t.spawn(spec({ repo: { id: "r", git_remote: "git@github.com:o/missing.git" } })), /not checked out on this host.*CHRONOS_HOST_AUTO_CLONE/);
  await assert.rejects(t.spawn(spec({ profile: "claude-acme" })), /profile claude-acme is not on this host/);
  await assert.rejects(t.spawn(spec({ backend: "nope" })), /backend nope is not available/);
  await assert.rejects(t.spawn(spec({ sandbox: { mode: "off", allow: [], egress_locked: true } })), /egress is locked/);
  await assert.rejects(t.spawn({ kind: "argv" }), /needs a SpawnSpec/);
  const r = await t.spawn(spec());
  assert.equal(r.cwd, home, "no repo, no workspace checkout → the host's home");
  assert.ok(r.pid > 0);
  assert.equal(t.live()[0].session_id, "sess-veto");
  await assert.rejects(t.spawn(spec()), /already running here/);
  t.killAll();
});

test("remoteKey: the same repo matches whatever form its remote was written in", () => {
  const want = "github.com/medialab-ai/airflow";
  for (const u of ["git@github.com:medialab-ai/airflow.git", "https://github.com/medialab-ai/airflow", "https://x-token@github.com/medialab-ai/airflow.git/", "ssh://git@github.com/medialab-ai/airflow.git", "https://GitHub.com/medialab-ai/airflow"]) {
    assert.equal(remoteKey(u), want, u);
  }
  assert.notEqual(remoteKey("git@github.com:medialab-ai/airflow-2.git"), want);
  assert.equal(remoteKey(null), "");
});
