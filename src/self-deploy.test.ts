import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { kv, repos, workspaces } from "./store.js";
import { createTicket } from "./tickets.js";
import { CONFIG } from "./config.js";
import {
  deployGate,
  resolveRestart,
  driftSummary,
  isSelfRepoPath,
  isSafeBranchName,
  queueSelfDeploy,
  queueSelfDeployManual,
  deployEnv,
  alreadyLive,
  isTransientFailure,
  readPending,
  selfRoot,
  maybeSelfDeploy,
  setDeployRunner,
  type GateInput,
} from "./self-deploy.js";

const PENDING_KEY = "deploy.pending";
const clearMarker = () => kv.del(PENDING_KEY);

const gateInput = (o: Partial<GateInput> = {}): GateInput => ({
  active: 0,
  queued: 0,
  running: 0,
  attempts: 0,
  lastAttemptMs: null,
  requestedMs: 1_000,
  nowMs: 1_000,
  maxAttempts: 3,
  retryMin: 30,
  idleWaitMin: 90,
  ...o,
});

// ---------------------------------------------------------------------------
// The gate. This is the whole safety argument of the ticket: a restart on a busy
// fleet throws away live runs (store/db.ts marks them `interrupted` on the next
// boot), so "idle" has to mean genuinely nothing in flight.
// ---------------------------------------------------------------------------

test("deployGate goes only when nothing is running or queued anywhere", () => {
  assert.equal(deployGate(gateInput()).go, true);
  assert.equal(deployGate(gateInput()).reason, "idle");

  for (const busy of [{ active: 1 }, { queued: 1 }, { running: 1 }]) {
    const d = deployGate(gateInput(busy));
    assert.equal(d.go, false, `must not deploy with ${JSON.stringify(busy)}`);
    assert.equal(d.reason, "fleet-busy");
  }
});

test("deployGate backs off after a failed round, then retries", () => {
  const base = { attempts: 1, lastAttemptMs: 0, retryMin: 30 };
  // 29 minutes after the failure: still cooling off.
  assert.equal(deployGate(gateInput({ ...base, nowMs: 29 * 60_000 })).reason, "backoff");
  // 31 minutes: allowed to try again.
  assert.equal(deployGate(gateInput({ ...base, nowMs: 31 * 60_000 })).go, true);
});

test("deployGate stops trying after maxAttempts", () => {
  const d = deployGate(gateInput({ attempts: 3, maxAttempts: 3, lastAttemptMs: 0, nowMs: 99 * 60_000 }));
  assert.equal(d.go, false);
  assert.equal(d.reason, "blocked");
});

// A busy fleet must never be forced — but it must not be silent either. `overdue` is the flag that
// turns a long wait into an operator notice while still refusing to restart.
test("deployGate reports overdue without ever forcing a restart on a busy fleet", () => {
  const d = deployGate(gateInput({ active: 2, requestedMs: 0, nowMs: 120 * 60_000, idleWaitMin: 90 }));
  assert.equal(d.overdue, true);
  assert.equal(d.go, false, "overdue must not override a busy fleet");
  assert.equal(d.reason, "fleet-busy");
});

// ---------------------------------------------------------------------------
// Did the restart actually happen? The marker is written before the process is
// killed, so boot-vs-build is the only evidence that survives the restart.
// ---------------------------------------------------------------------------

test("resolveRestart distinguishes came-back-up from never-went-down", () => {
  const built = new Date(10_000).toISOString();
  // Booted after the build → this process IS the new build.
  assert.equal(resolveRestart({ built_at: built }, 20_000, 30_000), "deployed");
  // Booted before the build, still inside the grace window → give launchd a moment.
  assert.equal(resolveRestart({ built_at: built }, 5_000, 20_000, 120_000), "waiting");
  // Booted before the build and the grace window has passed → the restart never took.
  assert.equal(resolveRestart({ built_at: built }, 5_000, 200_000, 120_000), "restart-failed");
  // No build recorded at all → nothing to have come back to.
  assert.equal(resolveRestart({ built_at: null }, 5_000, 200_000), "restart-failed");
});

// ---------------------------------------------------------------------------
// Drift reporting — the part that would have made PER-23's nine-commit gap visible.
// ---------------------------------------------------------------------------

test("driftSummary says nothing when current, and names the gap when behind", () => {
  const base = {
    commit: "abc",
    branch: "main",
    behind: 0,
    built_at: new Date().toISOString(),
    build_age_hours: 1,
    stale_build: false,
    checked_at: new Date().toISOString(),
  };
  assert.equal(driftSummary(base, null), null, "a current daemon has nothing to report");
  assert.equal(driftSummary(null, null), null, "no drift computed yet → no claim either way");

  const behind = driftSummary({ ...base, behind: 9, build_age_hours: 26 }, null)!;
  assert.match(behind, /9 commits behind origin\/main/);
  assert.match(behind, /build 26h old/);

  assert.match(driftSummary({ ...base, behind: 1 }, null)!, /1 commit behind/, "singular");
  assert.match(driftSummary({ ...base, stale_build: true }, null)!, /checkout newer than the deployed build/);
});

test("driftSummary surfaces a pending deploy even when the checkout is current", () => {
  const current = {
    commit: "abc", branch: "main", behind: 0, built_at: null,
    build_age_hours: null, stale_build: false, checked_at: new Date().toISOString(),
  };
  const s = driftSummary(current, {
    ticket_key: "PER-23", branch: "main", requested_at: new Date().toISOString(),
    state: "blocked", attempts: 3, last_attempt_at: null, last_error: "npm test failed",
    built_at: null, commit: null, waited_notified: false,
  })!;
  assert.match(s, /deploy pending \(PER-23, blocked\)/);
});

// ---------------------------------------------------------------------------
// Identifying "this repo is me".
// ---------------------------------------------------------------------------

test("isSelfRepoPath matches through symlinks and rejects other checkouts", () => {
  assert.equal(isSelfRepoPath(selfRoot()), true);
  assert.equal(isSelfRepoPath(selfRoot() + "/"), true, "trailing slash is the same directory");
  assert.equal(isSelfRepoPath("/some/other/repo"), false);
  assert.equal(isSelfRepoPath(null), false);
  assert.equal(isSelfRepoPath(""), false);

  // A symlinked parent is the case a plain string compare gets wrong — and getting it wrong means
  // silently never deploying, which is the bug this ticket exists to kill.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selfdeploy-"));
  const link = path.join(dir, "link");
  try {
    fs.symlinkSync(selfRoot(), link);
    assert.equal(isSelfRepoPath(link), true, "symlink to the self checkout is the self checkout");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isSafeBranchName rejects anything that is not a plain ref", () => {
  for (const ok of ["main", "master", "release/2.0", "feat_x-1.2"]) assert.equal(isSafeBranchName(ok), true, ok);
  for (const bad of ["main; rm -rf /", "main && curl evil", "$(whoami)", "`id`", "a b", "--upload-pack=x", "a..b", ""])
    assert.equal(isSafeBranchName(bad), false, bad);
});

// ---------------------------------------------------------------------------
// Queueing: only Chronos' own repo, and only when self-deploy is on.
// ---------------------------------------------------------------------------

function seedTicket(repoPath: string) {
  const ws = workspaces.create({
    slug: "sd-" + randomUUID().slice(0, 8),
    name: "SD",
    config_dir: "/tmp/sd",
  } as any);
  const repo = repos.create({
    workspace_id: ws.id,
    name: "r-" + randomUUID().slice(0, 6),
    path: repoPath,
    default_branch: "main",
  } as any);
  return createTicket({ workspace_id: ws.id, repo_id: repo.id, title: "self-deploy fixture" });
}

test("queueSelfDeploy fires for Chronos' own checkout and ignores every other repo", (t) => {
  const wasEnabled = CONFIG.selfDeploy.enabled;
  CONFIG.selfDeploy.enabled = true; // the suite sets CHRONOS_TEST=1, which switches it off
  t.after(() => {
    CONFIG.selfDeploy.enabled = wasEnabled;
    clearMarker();
  });

  clearMarker();
  // A real directory that simply is not us — createTicket writes the ticket file under repo.path.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "otherrepo-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  assert.equal(queueSelfDeploy(seedTicket(other)), false, "another repo must not queue a deploy");
  assert.equal(readPending(), null);

  const self = seedTicket(selfRoot());
  assert.equal(queueSelfDeploy(self), true);
  const m = readPending()!;
  assert.equal(m.ticket_key, self.key);
  assert.equal(m.state, "queued");
  assert.equal(m.attempts, 0, "a fresh merge starts with a clean attempt count");
});

test("queueSelfDeploy is a no-op while self-deploy is disabled", (t) => {
  const wasEnabled = CONFIG.selfDeploy.enabled;
  CONFIG.selfDeploy.enabled = false;
  t.after(() => {
    CONFIG.selfDeploy.enabled = wasEnabled;
    clearMarker();
  });
  clearMarker();
  assert.equal(queueSelfDeploy(seedTicket(selfRoot())), false);
  assert.equal(readPending(), null);
});

// ---------------------------------------------------------------------------
// The chain end-to-end, with the shell and the restart stubbed. This is the
// acceptance criterion that matters most: a red suite must not reach dist/.
// ---------------------------------------------------------------------------

function withStubbedRunner(t: any, sh: (cmd: string) => Promise<{ stdout: string; stderr: string }>) {
  const cmds: string[] = [];
  let restarts = 0;
  const wasEnabled = CONFIG.selfDeploy.enabled;
  CONFIG.selfDeploy.enabled = true;
  setDeployRunner({
    sh: (cmd) => {
      cmds.push(cmd);
      return sh(cmd);
    },
    restart: () => {
      restarts++;
    },
  });
  t.after(() => {
    setDeployRunner({ sh: null, restart: null });
    CONFIG.selfDeploy.enabled = wasEnabled;
    clearMarker();
  });
  return { cmds, restarts: () => restarts };
}

const ok = async () => ({ stdout: "", stderr: "" });

test("a failed npm test blocks the restart and leaves the daemon on the old build", async (t) => {
  const { cmds, restarts } = withStubbedRunner(t, async (cmd) => {
    if (cmd.includes("npm test")) throw Object.assign(new Error("suite failed"), { stdout: "1 failing" });
    return { stdout: "", stderr: "" };
  });

  clearMarker();
  queueSelfDeploy(seedTicket(selfRoot()));
  await maybeSelfDeploy();

  assert.equal(restarts(), 0, "a red suite must never restart the daemon");
  assert.ok(!cmds.some((c) => c.includes("npm run build")), "and must never reach the build");
  const m = readPending()!;
  assert.equal(m.attempts, 1, "the failure is counted so the backoff applies");
  assert.equal(m.state, "queued", "still queued — the next idle window retries");
  assert.match(m.last_error ?? "", /npm test/);
});

test("a green chain builds, marks restarting, and only then restarts", async (t) => {
  const { cmds, restarts } = withStubbedRunner(t, ok);

  clearMarker();
  const self = seedTicket(selfRoot());
  queueSelfDeploy(self);
  await maybeSelfDeploy();

  const order = cmds.join(" | ");
  assert.match(order, /git pull --ff-only.*npm test.*npm run build/s, "pull → test → build, in that order");
  assert.equal(restarts(), 1);

  // The marker must be on disk BEFORE the process dies, or the new boot cannot tell that it is the
  // result of a deploy rather than an ordinary restart.
  const m = readPending()!;
  assert.equal(m.state, "restarting");
  assert.ok(m.built_at, "built_at is what resolveRestart compares the next boot against");
});

test("a busy fleet defers the chain entirely", async (t) => {
  const { cmds, restarts } = withStubbedRunner(t, ok);
  clearMarker();
  queueSelfDeploy(seedTicket(selfRoot()));

  // Occupy the fleet the same way the gate sees it: a run row in 'running'.
  const { jobs, runs, workspaces: ws } = await import("./store.js");
  const w = ws.create({ slug: "busy-" + randomUUID().slice(0, 8), name: "B", config_dir: "/tmp/b" } as any);
  const job = jobs.create({ name: "busy", goal: "g", workspace_id: w.id, cwd: "/tmp" } as any);
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, { status: "running" });
  t.after(() => runs.patch(run.id, { status: "success", ended_at: new Date().toISOString() }));

  await maybeSelfDeploy();

  assert.equal(cmds.length, 0, "nothing shells out while work is in flight");
  assert.equal(restarts(), 0);
  assert.equal(readPending()!.state, "queued", "the deploy is deferred, not dropped");
});

test("an unsafe branch name refuses to reach the shell", async (t) => {
  const { cmds, restarts } = withStubbedRunner(t, ok);
  clearMarker();
  const self = seedTicket(selfRoot());
  queueSelfDeploy(self);
  const m = readPending()!;
  kv.set(PENDING_KEY, JSON.stringify({ ...m, branch: "main; touch /tmp/pwned" }));

  await maybeSelfDeploy();

  assert.equal(cmds.length, 0, "the branch never reaches bash");
  assert.equal(restarts(), 0);
  assert.match(readPending()!.last_error ?? "", /unsafe branch name/);
});

test("a hotfix merged without a ticket is queued by hand and rides the same gate; a bad branch or a disabled loop is refused", () => {
  kv.del("deploy.pending");
  assert.equal(queueSelfDeployManual("PR #333 phone queue", "main", new Date("2026-09-13T23:00:00Z"), false), null, "disabled");
  assert.equal(queueSelfDeployManual("x", "main;echo", new Date(), true), null, "unsafe branch");
  const p = queueSelfDeployManual("PR #333 phone queue", "main", new Date("2026-09-13T23:00:00Z"), true)!;
  assert.equal(p.state, "queued"); assert.equal(p.attempts, 0); assert.equal(p.ticket_key, "PR #333 phone queue"); assert.equal(p.branch, "main");
  assert.deepEqual(readPending(), p);
  kv.del("deploy.pending");
});

test("the deploy chain drops the daemon's own CHRONOS_* knobs so the suite runs against its defaults", () => {
  const out = deployEnv({ PATH: "/bin", HOME: "/h", CHRONOS_DIGEST_HOUR: "-1", CHRONOS_PORT: "7777", CHRONOS_SELF_DEPLOY: "1", NODE_ENV: "production" });
  assert.deepEqual(out, { PATH: "/bin", HOME: "/h", NODE_ENV: "production" });
});

test("a marker the daemon already outran is recognised; an unpulled, unbuilt or unrestarted checkout is not", () => {
  const m = { requested_at: "2026-09-14T00:08:24.000Z" };
  const d = { commit: "c866c3e", branch: "main", behind: 0, built_at: "2026-09-14T12:17:16.000Z", build_age_hours: 0, stale_build: false, checked_at: "2026-09-14T12:17:49.000Z" };
  const boot = Date.parse("2026-09-14T12:17:30.000Z");
  assert.equal(alreadyLive(m, d, boot), true, "restarted on a build made after the request, level with origin");
  assert.equal(alreadyLive(m, null, boot), false, "no drift yet");
  assert.equal(alreadyLive(m, { ...d, behind: 2 }, boot), false, "origin has commits the build lacks");
  assert.equal(alreadyLive(m, { ...d, behind: null }, boot), false, "offline: unknown is not live");
  assert.equal(alreadyLive(m, { ...d, stale_build: true }, boot), false, "pulled but never built");
  assert.equal(alreadyLive(m, { ...d, built_at: "2026-09-13T23:00:00.000Z" }, boot), false, "build predates the merge");
  assert.equal(alreadyLive(m, d, Date.parse("2026-09-14T12:00:00.000Z")), false, "built but never restarted");
});

test("a network failure on git pull retries without spending an attempt; a real pull failure still counts", async (t) => {
  assert.equal(isTransientFailure("fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com"), true);
  assert.equal(isTransientFailure("fatal: Not possible to fast-forward, aborting."), false);

  let pullErr = "fatal: unable to access 'https://github.com/leorfer23/getchronos.git/': Could not resolve host: github.com";
  const { cmds, restarts } = withStubbedRunner(t, async (cmd) => {
    if (cmd.includes("git pull")) throw Object.assign(new Error("pull"), { stderr: pullErr });
    return { stdout: "", stderr: "" };
  });
  clearMarker();
  queueSelfDeployManual("PR #335 revive-continue", "main", new Date(), true);
  const before = readPending()!;
  kv.set(PENDING_KEY, JSON.stringify({ ...before, attempts: CONFIG.selfDeploy.maxAttempts - 1 }));

  await maybeSelfDeploy();
  let m = readPending()!;
  assert.equal(m.attempts, CONFIG.selfDeploy.maxAttempts - 1, "the DNS blip is not the attempt that gives up");
  assert.equal(m.state, "queued");
  assert.ok(m.last_attempt_at, "but it still backs off");
  assert.ok(!cmds.some((c) => c.includes("npm test")));
  assert.equal(restarts(), 0);

  pullErr = "fatal: Not possible to fast-forward, aborting.";
  kv.set(PENDING_KEY, JSON.stringify({ ...m, last_attempt_at: null }));
  await maybeSelfDeploy();
  m = readPending()!;
  assert.equal(m.attempts, CONFIG.selfDeploy.maxAttempts);
  assert.equal(m.state, "blocked", "a diverged checkout is a real failure");
});
