import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

test("the brain's policy frame adds a veto; it can never lift the local one", async () => {
  const calls: string[] = [];
  const t = terminals([], calls);
  t.setPolicy(["ws-g"]);
  await assert.rejects(t.spawn(spec()), /^Error: veto: workspace galley is denied on this host by the brain's policy/);
  const t2 = terminals(["galley"], calls);
  t2.setPolicy([]);
  await assert.rejects(t2.spawn(spec()), /CHRONOS_HOST_DENY/);
  assert.deepEqual(calls, []);
});

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
  // What the menu bar lists (status.ts): a live terminal, and nothing about its workspace.
  const w = t.work();
  assert.equal(w.length, 1);
  assert.deepEqual(Object.keys(w[0]).sort(), ["backend", "cwd", "frozen", "id", "kind", "lastOut", "startedAt"]);
  assert.equal(w[0].kind, "terminal");
  assert.equal(w[0].backend, "sh");
  assert.equal(w[0].cwd, home);
  await assert.rejects(t.spawn(spec()), /already running here/);
  t.killAll();
});

test("remoteKey: the same repo matches whatever form its remote was written in", () => {
  const want = "github.com/medialab-ai/airflow";
  for (const u of ["git@github.com:medialab-ai/airflow.git", "https://github.com/medialab-ai/airflow", "https://x-token@github.com/medialab-ai/airflow.git/", "ssh://git@github.com/medialab-ai/airflow.git", "https://GitHub.com/medialab-ai/airflow"]) {
    assert.equal(remoteKey(u), want, u);
  }
  assert.notEqual(remoteKey("git@github.com:medialab-ai/airflow-2.git"), want);
  assert.equal(remoteKey("not a remote"), "", "garbage never matches garbage");
  assert.equal(remoteKey(null), "");
});

// ───────────── the fence (fence.ts) and salvage (salvage.ts) on a real pty ─────────────

const stat = (pid: number) => { try { return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { return ""; } };
// A signal is delivered asynchronously: on a loaded runner `ps` can still show the old state for a
// moment after kill(2) returns. Poll until it matches (or 2s pass) instead of reading once.
const statUntil = async (pid: number, ok: (st: string) => boolean, timeoutMs = 2000) => {
  const t0 = Date.now();
  let st = stat(pid);
  while (!ok(st) && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 20));
    st = stat(pid);
  }
  return st;
};
// Until the pty child has exec'd its program it is still node-pty's spawn-helper (macOS) or a forked
// node (Linux); a SIGSTOP sent in that window can be lost on a loaded runner (seen on macOS CI:
// still `S<s+` 2s later). Freeze only once the child is the program the terminal runs.
const comm = (pid: number) => { try { return execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { return ""; } };
const execd = async (pid: number, timeoutMs = 3000) => {
  const t0 = Date.now();
  while (!/(^|\/)(sh|sleep)$/.test(comm(pid)) && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 20));
};
const exited = (t: HostTerminals, timeoutMs = 5000) => new Promise<void>((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => (t.live()[0]?.exit ? resolve() : Date.now() - t0 > timeoutMs ? reject(new Error("never exited")) : setTimeout(tick, 50));
  tick();
});

function sleeper(cwd: string | null = null) {
  const sh: HostBackend = { name: "sh", bin: () => "/bin/sh", interactiveArgs: () => ["-c", "sleep 30"], env: () => ({}) };
  return new HostTerminals({
    home, root: process.cwd(), prepare: false, mcPort: 7777,
    profiles: () => ({ claude: home }),
    checkouts: async () => (cwd ? [{ path: cwd, remote_url: "git@github.com:acme/app.git" }] : []),
    deny: () => [],
    backends: { sh },
  });
}

test("fence: freezeAll stops the pty's process group; an attach (still ours) thaws it; a kill while frozen still lands", async () => {
  const t = sleeper();
  const r = await t.spawn(spec({ session_id: "sess-fence", workspace: null }));
  await execd(r.pid);
  assert.equal(t.freezeAll(), 1);
  assert.equal(t.freezeAll(), 0, "already frozen");
  assert.match(await statUntil(r.pid, (st) => /T/.test(st)), /T/, "stopped");
  assert.equal(t.live()[0].frozen, true, "hello.live[] says so");
  assert.equal(t.work()[0].frozen, true);
  assert.equal(t.frozenCount(), 1);
  t.attach(r.ch, 0, 0, "sess-fence");
  assert.doesNotMatch(await statUntil(r.pid, (st) => !/T/.test(st)), /T/, "running again");
  assert.equal(t.live()[0].frozen, undefined);
  t.freezeAll();
  t.kill(r.ch);
  await exited(t);
  assert.equal(t.frozenCount(), 0);
});

test("salvage: a moved terminal's dirty worktree goes to origin as wip/<id8> by sha; HEAD and files untouched; then it is stopped", async () => {
  const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe" }).toString().trim();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hostd-salvage-")));
  const origin = path.join(base, "origin.git");
  const repo = path.join(base, "app");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
  execFileSync("git", ["clone", origin, repo], { stdio: "pipe" });
  g(repo, "commit", "--allow-empty", "-m", "base");
  g(repo, "push", "origin", "HEAD:main");
  const wt = path.join(base, ".chronos-worktrees", "app", "feat-x");
  g(repo, "worktree", "add", "-b", "feat/x", wt);
  fs.writeFileSync(path.join(wt, "a.txt"), "committed, never pushed\n");
  g(wt, "add", "a.txt");
  g(wt, "commit", "-m", "local only");
  fs.writeFileSync(path.join(wt, "b.txt"), "not even committed\n");
  const head = g(wt, "rev-parse", "HEAD");

  const t = sleeper(repo);
  const r = await t.spawn(spec({ session_id: "abcdef12-salvage", workspace: null, resume_cwd: wt }));
  assert.equal(r.cwd, wt);
  const res = await t.salvage({ ch: r.ch, session_id: "abcdef12-salvage", dir: null });
  assert.equal(res.status, "saved", JSON.stringify(res));
  assert.equal(res.branch, "wip/abcdef12");
  assert.equal(res.dirty, true);
  assert.equal(res.ahead, 1);
  assert.equal(res.from, "feat/x");
  const pushed = execFileSync("git", ["--git-dir", origin, "ls-tree", "-r", "--name-only", "wip/abcdef12"], { encoding: "utf8" });
  assert.match(pushed, /a\.txt/);
  assert.match(pushed, /b\.txt/);
  assert.equal(g(wt, "rev-parse", "HEAD"), head, "HEAD did not move");
  assert.match(g(wt, "status", "--porcelain"), /\?\? b\.txt/, "the file is still uncommitted in the worktree");
  await exited(t);
  // A later salvage that would rewrite wip/<id8> is refused by origin (never a force push).
  g(wt, "commit", "-m", "another local commit", "--allow-empty");
  const again = await (await import("./salvage.js")).salvageWorktree(wt, "abcdef12-salvage");
  assert.equal(again.status, "failed");
  // The shared checkout is never salvaged.
  fs.writeFileSync(path.join(repo, "c.txt"), "x\n");
  assert.equal((await (await import("./salvage.js")).salvageWorktree(repo, "deadbeef-shared")).status, "skipped");
});
