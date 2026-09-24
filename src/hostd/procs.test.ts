/**
 * The host's headless runs and exec (HOSTS.md phase 5), against REAL child processes (`node -e` /
 * `sh -c` behind a stand-in backend — no agent CLI, no token) and a recording stand-in for the link.
 *
 * Proves: stdout reaches the brain as whole lines in seq order; stdin frames steer the process;
 * a kill frame and the host's own timeout both end it (the latter flagged `timed_out`); output
 * produced while the link is down is resent exactly once after re-attach; the veto and the path rules
 * hold before anything is forked; exec is bounded by the host's timeout and caps, and only runs in a
 * checkout (or worktree) this host reported.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostProcs, type ProcBackend } from "./procs.js";
import { VetoError, type TerminalsLink } from "./terminals.js";
import { SeqTracker, type HostToBrain } from "../hostlink/wire.js";
import type { ProcSpec } from "../hosts/proc-spec.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hostd-procs-"));
const home = path.join(tmp, "home");
const repo = path.join(tmp, "code", "app");
const other = path.join(tmp, "code", "other-client");
for (const d of [home, repo, other, path.join(home, ".claude-x")]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const REMOTE = "git@github.com:acme/app.git";

/** A backend whose "CLI" is whatever script the goal carries: `sh -c <goal>`. */
const sh: ProcBackend = {
  name: "sh",
  bin: () => "/bin/sh",
  buildArgs: (job) => ["-c", job.goal],
  steerArgs: (job) => ["-c", job.goal],
  env: () => ({}),
};

class FakeLink implements TerminalsLink {
  up = true;
  frames: HostToBrain[] = [];
  data: Array<{ ch: number; seq: number; text: string }> = [];
  online() { return this.up; }
  send(f: HostToBrain) { if (!this.up) return false; this.frames.push(f); return true; }
  sendData(ch: number, seq: number, bytes: Buffer) { if (!this.up) return false; this.data.push({ ch, seq, text: bytes.toString("utf8") }); return true; }
  exitOf(ch: number) { return this.frames.find((f) => f.t === "exit" && f.ch === ch) as Extract<HostToBrain, { t: "exit" }> | undefined; }
}

function procs(o: { deny?: string[]; link?: FakeLink } = {}) {
  let n = 0;
  const p = new HostProcs({
    home, root: process.cwd(), prepare: false,
    profiles: () => ({ "claude-x": path.join(home, ".claude-x") }),
    checkouts: async () => [{ path: repo, remote_url: REMOTE }, { path: other, remote_url: "git@github.com:globex/other.git" }],
    backends: { sh },
    mcPort: () => 7788,
    veto: (ws) => (ws && (o.deny ?? []).includes(ws.slug) ? `veto: workspace ${ws.slug} is denied on this host (CHRONOS_HOST_DENY)` : null),
    allocCh: () => ++n,
    graceMs: 0,
    killGraceMs: 500,
  });
  const link = o.link ?? new FakeLink();
  p.attachLink(link);
  return { p, link };
}

const spec = (goal: string, over: Partial<ProcSpec> = {}): ProcSpec => ({
  kind: "proc", run_id: `run-${Math.random().toString(36).slice(2, 8)}`, workspace: { id: "ws-acme", slug: "acme" },
  backend: "sh", profile: "claude-x",
  job: { name: "t", goal, append_system: null, model: null, allowed_tools: null, disallowed_tools: null, max_budget_usd: null },
  context: null, session_id: "sess", resume: null, steer: false,
  repo: { id: "repo-app", git_remote: REMOTE }, repos: [{ id: "repo-app", git_remote: REMOTE }], cwd: null,
  sandbox: { mode: "off", allow: [], egress_locked: false }, egress: null, env: {}, env_home_relative: [], nice: 0,
  timeout_ms: 30_000, files: [], ...over,
});

const until = async (cond: () => boolean, what: string, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("stdout reaches the brain as whole lines, in seq order, from the host's checkout of the repo", async () => {
  const { p, link } = procs();
  // Two writes that split a line in the middle, then a last line with no newline at all.
  const r = await p.spawn(spec(`printf 'one\\ntw'; sleep 0.1; printf 'o\\nthree'; echo "cwd:$PWD" >&2`));
  assert.equal(r.cwd, repo, "no explicit cwd: the host's own checkout of the repo, found by remote");
  await until(() => !!link.exitOf(r.ch), "the exit");
  const frames = link.data.filter((d) => d.ch === r.ch);
  assert.deepEqual(frames.map((f) => f.seq), frames.map((_, i) => i + 1), "seq 1, 2, 3 … with no hole");
  for (const f of frames.slice(0, -1)) assert.ok(f.text.endsWith("\n"), `a frame is whole lines: ${JSON.stringify(f.text)}`);
  assert.equal(frames.map((f) => f.text).join(""), "one\ntwo\nthree");
  const stderr = link.frames.filter((f) => f.t === "stderr").map((f: any) => f.text).join("");
  assert.match(stderr, /cwd:/);
  assert.deepEqual(link.exitOf(r.ch), { t: "exit", ch: r.ch, code: 0, signal: null });
});

test("stdin frames steer the run; `end` closes it — how a steer-mode run finishes", async () => {
  const { p, link } = procs();
  const r = await p.spawn(spec(`while read l; do echo "got:$l"; done; echo bye`, { steer: true }));
  p.stdin(r.ch, `{"type":"user","text":"a"}\n`, false);
  p.stdin(r.ch, `second\n`, true);
  await until(() => !!link.exitOf(r.ch), "the exit after stdin closed");
  assert.equal(link.data.filter((d) => d.ch === r.ch).map((d) => d.text).join(""), `got:{"type":"user","text":"a"}\ngot:second\nbye\n`);
});

test("a kill frame ends it with the signal; the host's own watchdog ends a run past its timeout", async () => {
  const { p, link } = procs();
  const a = await p.spawn(spec("sleep 30"));
  p.kill(a.ch, "SIGTERM");
  await until(() => !!link.exitOf(a.ch), "the killed run's exit");
  assert.equal(link.exitOf(a.ch)!.signal, "SIGTERM");
  assert.equal(link.exitOf(a.ch)!.timed_out, undefined);

  // No brain in sight: the host stops it itself (timeout + grace; the grace is 0 here) and says so.
  const b = await p.spawn(spec("sleep 30", { timeout_ms: 300 }));
  await until(() => !!link.exitOf(b.ch), "the host watchdog", 5000);
  assert.equal(link.exitOf(b.ch)!.timed_out, true);
  assert.equal(link.exitOf(b.ch)!.signal, "SIGTERM");
});

test("output made while the link is down is resent exactly once on re-attach, then the held exit", async () => {
  const link = new FakeLink();
  const { p } = procs({ link });
  const r = await p.spawn(spec(`echo before; sleep 0.4; echo during-1; echo during-2; sleep 0.4; echo after`));
  const brainSeq = new SeqTracker();
  const seen: string[] = [];
  const take = () => {
    for (const d of link.data.splice(0)) if (d.ch === r.ch && brainSeq.accept(d.seq) !== "dup") seen.push(d.text);
  };
  await until(() => link.data.some((d) => d.text.includes("before")), "the first line");
  take();
  link.up = false;
  p.linkDown();
  await until(() => p.live().find((l) => l.ch === r.ch)!.last_seq >= 3, "the lines produced with no link");
  link.up = true;
  // The brain re-attaches naming the last seq it has — and, to prove the dedupe, asks twice.
  p.attach(r.ch, brainSeq.lastSeq);
  p.attach(r.ch, 0);
  await until(() => !!link.exitOf(r.ch), "the exit after re-attach");
  take();
  assert.deepEqual(seen.join("").split("\n").filter(Boolean), ["before", "during-1", "during-2", "after"]);
  // Released → forgotten; an exited run nobody released is still reported in hello.live[].
  assert.ok(p.live().some((l) => l.ch === r.ch && l.exit), "held for the brain until it releases it");
  p.release(r.ch);
  assert.ok(!p.live().some((l) => l.ch === r.ch));
});

test("lock #2: the veto refuses before anything is resolved or forked; a cwd must be the host's own", async () => {
  let resolved = 0;
  const p = new HostProcs({
    home, root: process.cwd(), prepare: false, profiles: () => ({ "claude-x": home }),
    checkouts: async () => { resolved++; return [{ path: repo, remote_url: REMOTE }]; },
    backends: { sh }, mcPort: () => 7788, veto: () => "veto: workspace acme is denied on this host (CHRONOS_HOST_DENY)", allocCh: () => 1,
  });
  await assert.rejects(p.spawn(spec("echo no")), (e: any) => e instanceof VetoError && /^veto:/.test(e.message));
  assert.equal(resolved, 0);
  assert.deepEqual(p.live(), []);

  const { p: q } = procs();
  await assert.rejects(q.spawn(spec("echo x", { cwd: path.join(tmp, "nowhere") })), /working directory gone/);
  await assert.rejects(q.spawn(spec("echo x", { cwd: tmp })), /not a checkout or a worktree on this host/);
  await assert.rejects(q.spawn(spec("echo x", { repo: { id: "r", git_remote: "git@github.com:acme/missing.git" } })), /not checked out on this host/);
});

test("a delivered ticket file lands in the checkout's .mc/ — and nowhere else", async () => {
  const { p, link } = procs();
  const r = await p.spawn(spec(`cat .mc/tickets/ACM-1.md`, {
    files: [
      { repo_id: "repo-app", rel: ".mc/tickets/ACM-1.md", content: "# ACM-1\nbody\n" },
      { repo_id: "repo-app", rel: "../escape.md", content: "x" },
      { repo_id: "repo-app", rel: "src/index.ts", content: "x" },
    ],
  }));
  await until(() => !!link.exitOf(r.ch), "the exit");
  assert.equal(link.data.filter((d) => d.ch === r.ch).map((d) => d.text).join(""), "# ACM-1\nbody\n");
  assert.ok(!fs.existsSync(path.join(repo, "..", "escape.md")));
  assert.ok(!fs.existsSync(path.join(repo, "src", "index.ts")));
});

test("prose tokens expand to THIS host's paths; env `~/…` expands to its home", async () => {
  const { p, link } = procs();
  const r = await p.spawn(spec(`echo "{{chronos:repo:repo-app}} | {{chronos:wtroot:repo-app}} | {{chronos:repo:gone}} | $SECRET_DIR"`, {
    env: { SECRET_DIR: "~/secrets" }, env_home_relative: ["SECRET_DIR"],
  }));
  await until(() => !!link.exitOf(r.ch), "the exit");
  const out = link.data.filter((d) => d.ch === r.ch).map((d) => d.text).join("").trim();
  assert.equal(out, `${repo} | ${path.join(tmp, "code", ".chronos-worktrees", "app")} | (a repo that is not checked out on this computer) | ${path.join(home, "secrets")}`);
});

// ───────────────────────────── exec ─────────────────────────────

test("exec: runs in a reported checkout, with its exit code and output", async () => {
  const { p } = procs();
  const ok = await p.exec({ workspace: { id: "ws-acme", slug: "acme" }, cwd: repo, cmd: "sh", args: ["-c", "pwd; echo err >&2; exit 3"], env: {}, env_home_relative: [], timeout_ms: 5000 });
  assert.equal(ok.code, 3);
  assert.equal(fs.realpathSync(ok.stdout.trim()), fs.realpathSync(repo));
  assert.equal(ok.stderr.trim(), "err");
  assert.equal(ok.timed_out, false);
});

test("exec: the host enforces the timeout itself", async () => {
  const { p } = procs();
  const t0 = Date.now();
  const r = await p.exec({ workspace: null, cwd: repo, cmd: "sleep", args: ["30"], env: {}, env_home_relative: [], timeout_ms: 1000 });
  assert.equal(r.timed_out, true);
  assert.ok(Date.now() - t0 < 5000);
});

test("exec: output is capped, keeping the head of a diff or the tail of a gate", async () => {
  const { p } = procs();
  const line = "node -e 'for (let i = 0; i < 5000; i++) console.log(\"line-\" + i)'";
  const head = await p.exec({ workspace: null, cwd: repo, cmd: "sh", args: ["-c", line], env: {}, env_home_relative: [], timeout_ms: 10_000, max_bytes: 2048, keep: "head" });
  assert.equal(head.truncated, true);
  assert.ok(head.stdout.startsWith("line-0\n") && head.stdout.length <= 2048);
  const tail = await p.exec({ workspace: null, cwd: repo, shell: line, env: {}, env_home_relative: [], timeout_ms: 10_000, max_bytes: 2048, keep: "tail" });
  assert.equal(tail.code, 0);
  assert.equal(tail.truncated, true);
  assert.ok(tail.stdout.trimEnd().endsWith("line-4999") && tail.stdout.length <= 2048);
});

test("exec: only in this host's own path space — a missing dir, a foreign dir, a vetoed workspace", async () => {
  const { p } = procs({ deny: ["acme"] });
  const base = { cmd: "true", env: {}, env_home_relative: [], timeout_ms: 5000 };
  assert.match((await p.exec({ ...base, workspace: null, cwd: path.join(repo, "gone") })).error ?? "", /^cwd_missing:/);
  assert.match((await p.exec({ ...base, workspace: null, cwd: tmp })).error ?? "", /^outside:/);
  assert.match((await p.exec({ ...base, workspace: null, cwd: "relative/path" })).error ?? "", /absolute cwd/);
  assert.match((await p.exec({ ...base, workspace: { id: "ws-acme", slug: "acme" }, cwd: repo })).error ?? "", /^veto:/);
  // A worktree under the checkout's root counts as the host's own.
  const wt = path.join(tmp, "code", ".chronos-worktrees", "app", "mc-acm-1");
  fs.mkdirSync(wt, { recursive: true });
  assert.equal((await p.exec({ ...base, workspace: null, cwd: wt })).code, 0);
});

test("exec {shell}: a gate line runs through a login shell with the HOST's runtime PATH in front", async () => {
  const { p } = procs();
  const r = await p.exec({ workspace: null, cwd: repo, shell: "echo \"$PATH\"", env: {}, env_home_relative: [], timeout_ms: 10_000 });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.startsWith(process.env.PATH ?? "\0"), "the host's own PATH wins the ties, not the brain's");
});
