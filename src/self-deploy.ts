import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { CONFIG } from "./config.js";
import { execFileTimed } from "./exec.js";
import { kv, repos, runs } from "./store.js";
import { status as dispatchStatus } from "./dispatcher.js";
import { notify } from "./telegram.js";
import { notifyInfo } from "./telegram/api.js";
import type { Ticket } from "./types.js";

/**
 * Chronos deploying itself — the one repo whose merges nothing else picks up.
 *
 * Every other repo ships by merging a PR. For THIS one a merge changes nothing: launchd runs
 * `dist/index.js`, and nothing pulls, rebuilds or restarts. On 2026-08-05 nine merged commits sat
 * undeployed for a whole day while the bugs they fixed kept firing in front of the operator, and
 * every surface still said "done" (PER-23).
 *
 * The obvious fix — `repo.post_merge_cmd = "npm run deploy"` — is unsafe: that script ends in
 * `launchctl kickstart -k`, index.ts's SIGTERM handler exits immediately with no draining, and
 * store/db.ts force-marks every live run `interrupted` on the next boot. A merge landing while three
 * tickets build would throw all three away. So the loop is closed the slow way instead: persist a
 * pending marker, wait for a genuinely idle fleet, then pull → test → build → restart, and only
 * clear the marker once we come back up on the new build.
 *
 * Nothing here ever forces a restart on a busy fleet. If idle never comes, the wait escalates to the
 * operator (once) and keeps waiting — a missed deploy is recoverable, a killed build is not.
 */

// The daemon's own checkout, derived from this module's location (dist/self-deploy.js → repo root,
// src/self-deploy.ts → the same root under tsx). Not process.cwd(): launchd sets that to the live
// checkout, but a dev/worktree run would then claim to be the deployed daemon.
const SELF_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PENDING_KEY = "deploy.pending";

// When this process started. The marker is written BEFORE the restart it causes, so comparing our
// boot against the build time is the only way to tell "we came back up on the new build" from "the
// restart never happened" (see resolveRestart).
const BOOT_MS = Date.now() - process.uptime() * 1000;

export type DeployState = "queued" | "restarting" | "blocked";

export type PendingDeploy = {
  ticket_key: string;
  branch: string;
  requested_at: string; // when the merge landed
  state: DeployState;
  attempts: number; // failed test/build/restart rounds since the last merge
  last_attempt_at: string | null;
  last_error: string | null;
  built_at: string | null; // when the build we are about to restart into finished
  commit: string | null; // sha that build came from
  waited_notified: boolean; // idle ceiling already escalated (never nag twice per merge)
};

export type DeployDrift = {
  commit: string | null; // HEAD of the self checkout
  branch: string | null;
  behind: number | null; // commits HEAD..origin/<branch>; null = couldn't ask (offline/no remote)
  built_at: string | null; // mtime of dist/index.js = what the daemon is actually running
  build_age_hours: number | null;
  stale_build: boolean; // dist older than HEAD's commit date → checkout pulled but never built
  checked_at: string;
};

export function selfRoot(): string {
  return SELF_ROOT;
}

// When this process came up — the reference resolveRestart compares a pending build against.
export function bootAtMs(): number {
  return BOOT_MS;
}

// realpath both sides: the same checkout is reachable by several equivalent paths (a symlinked
// parent, macOS's /private prefix on /tmp), and a plain string compare would miss the match and
// silently never deploy — the exact failure mode this ticket exists to kill.
export function isSelfRepoPath(repoPath: string | null | undefined, root = SELF_ROOT): boolean {
  if (!repoPath) return false;
  const norm = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return norm(repoPath) === norm(root);
}

export function readPending(): PendingDeploy | null {
  const raw = kv.get(PENDING_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as PendingDeploy;
    return p && typeof p.state === "string" ? p : null;
  } catch {
    return null;
  }
}

function writePending(p: PendingDeploy): void {
  kv.set(PENDING_KEY, JSON.stringify(p));
}

function clearPending(): void {
  kv.del(PENDING_KEY);
}

/**
 * Called from markDelivered on every merge. Returns true when this merge queued a self-deploy, so
 * the caller can say "merged — not yet deployed" instead of a bare 🎉 (`done` meant two different
 * things all through PER-23's bad day).
 */
export function queueSelfDeploy(t: Ticket, now = new Date()): boolean {
  if (!CONFIG.selfDeploy.enabled) return false;
  const repo = t.repo_id ? repos.get(t.repo_id) : undefined;
  if (!repo?.path || !isSelfRepoPath(repo.path)) return false;
  writePending({
    ticket_key: t.key,
    branch: repo.default_branch || "main",
    requested_at: now.toISOString(),
    state: "queued",
    // A new merge is new code, so the attempt counter resets: whatever just landed may be the fix
    // for the red tests that blocked the previous round.
    attempts: 0,
    last_attempt_at: null,
    last_error: null,
    built_at: null,
    commit: null,
    waited_notified: false,
  });
  return true;
}

/**
 * The same marker, queued by hand — Robert or the operator after merging a PR that is not a ticket
 * (a hotfix, a UI fix). `label` stands where a ticket key would (notifications, the drift line).
 * Goes through the identical idle gate and pull → test → build → restart chain: this is the ONLY
 * sanctioned way to restart the daemon on new code; `launchctl kickstart` by hand kills live runs.
 */
export function queueSelfDeployManual(label: string, branch = "main", now = new Date(), enabled = CONFIG.selfDeploy.enabled): PendingDeploy | null {
  if (!enabled || !isSafeBranchName(branch)) return null;
  const p: PendingDeploy = {
    ticket_key: label.trim().slice(0, 80) || "manual",
    branch,
    requested_at: now.toISOString(),
    state: "queued",
    attempts: 0,
    last_attempt_at: null,
    last_error: null,
    built_at: null,
    commit: null,
    waited_notified: false,
  };
  writePending(p);
  return p;
}

export type GateInput = {
  active: number; // dispatcher's in-process running count
  queued: number; // dispatcher's in-process queue depth
  running: number; // DB-backed 'running' runs (catches anything the dispatcher isn't tracking)
  attempts: number;
  lastAttemptMs: number | null;
  requestedMs: number;
  nowMs: number;
  maxAttempts: number;
  retryMin: number;
  idleWaitMin: number;
};

export type GateDecision = {
  go: boolean;
  reason: "idle" | "fleet-busy" | "backoff" | "blocked";
  overdue: boolean; // waited past the ceiling → tell the operator (we still don't force it)
};

// Pure decision so the gating edges are testable without a fleet: thresholds and clock are injected,
// same shape as monitor.ts's isStalled.
export function deployGate(i: GateInput): GateDecision {
  const overdue = i.nowMs - i.requestedMs > i.idleWaitMin * 60_000;
  if (i.attempts >= i.maxAttempts) return { go: false, reason: "blocked", overdue };
  if (i.lastAttemptMs !== null && i.nowMs - i.lastAttemptMs < i.retryMin * 60_000)
    return { go: false, reason: "backoff", overdue };
  // Idle means idle: no run executing, nothing waiting to execute. Anything less and the restart
  // takes live work with it.
  if (i.active > 0 || i.queued > 0 || i.running > 0) return { go: false, reason: "fleet-busy", overdue };
  return { go: true, reason: "idle", overdue };
}

/**
 * Resolve a marker left in `restarting` — i.e. we built, asked launchd to re-exec us, and then
 * either came back up (marker's job done) or never went down at all (kickstart failed / no launchd).
 * Boot-after-build is the signal that survives the restart itself.
 */
export function resolveRestart(
  m: Pick<PendingDeploy, "built_at">,
  bootMs: number,
  nowMs: number,
  graceMs = 120_000,
): "deployed" | "restart-failed" | "waiting" {
  const built = m.built_at ? Date.parse(m.built_at) : NaN;
  if (!Number.isFinite(built)) return "restart-failed"; // no build recorded → nothing to come back to
  if (bootMs > built) return "deployed";
  return nowMs - built > graceMs ? "restart-failed" : "waiting";
}

/**
 * A marker the running daemon already outran: someone restarted it on a build made after the marker
 * was queued, from a checkout level with origin. On 2026-09-14 PR #335's marker hit maxAttempts
 * (two env-poisoned test runs, then a DNS blip), #336 was deployed by hand hours later, and /health
 * kept saying "deploy pending, blocked" for code that was already live — nothing ever cleared it.
 */
export function alreadyLive(m: Pick<PendingDeploy, "requested_at">, d: DeployDrift | null, bootMs: number): boolean {
  if (!d || d.behind !== 0 || d.stale_build || !d.built_at) return false;
  const built = Date.parse(d.built_at);
  return built > Date.parse(m.requested_at) && bootMs > built;
}

// The network, not the code: nothing ran, so the round must not spend one of the attempts that end
// in "deploy by hand" (the DNS blip at 01:14Z on 2026-09-14 was the attempt that gave up).
export function isTransientFailure(detail: string): boolean {
  return /Could not resolve host|Temporary failure in name resolution|Failed to connect to|Connection timed out|Connection reset|Network is unreachable|Operation timed out/i.test(detail);
}

// One line the operator can read without asking anything: "3 commits behind origin/main · build 26h
// old". null when everything is current — the daily nag only fires when there is something to say.
export function driftSummary(drift: DeployDrift | null, pending: PendingDeploy | null): string | null {
  if (!drift) return null;
  const bits: string[] = [];
  if (drift.behind && drift.behind > 0) bits.push(`${drift.behind} commit${drift.behind === 1 ? "" : "s"} behind origin/${drift.branch ?? "main"}`);
  if (drift.stale_build) bits.push("checkout newer than the deployed build");
  if (bits.length && drift.build_age_hours != null) bits.push(`build ${Math.round(drift.build_age_hours)}h old`);
  if (pending) bits.push(`deploy pending (${pending.ticket_key}${pending.state === "blocked" ? ", blocked" : ""})`);
  return bits.length ? bits.join(" · ") : null;
}

let drift: DeployDrift | null = null;
let lastDriftMs = 0;
let lastDriftNagDay = "";

// Whether the running daemon is behind what's on main. Cached: computing it shells out to git fetch,
// far too hot for a /health request. Refreshed on the self-deploy tick.
export function deployStatus(): { pending: PendingDeploy | null; drift: DeployDrift | null; summary: string | null } {
  const pending = readPending();
  return { pending, drift, summary: driftSummary(drift, pending) };
}

function git(args: string[], timeout = 15_000): Promise<string> {
  return execFileTimed("git", args, { cwd: SELF_ROOT, encoding: "utf8", timeout }).then((r) => r.stdout.trim());
}

async function computeDrift(now = new Date()): Promise<DeployDrift> {
  const commit = await git(["rev-parse", "HEAD"]).catch(() => null);
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => null);
  let behind: number | null = null;
  if (branch) {
    // Fails open (offline, no remote, detached HEAD) exactly like gates.ts's merge-conflict
    // pre-check: unknown drift is reported as null, never as an error the operator has to clear.
    try {
      await git(["fetch", "--quiet", "origin", branch], 60_000);
      const n = Number(await git(["rev-list", "--count", `HEAD..origin/${branch}`]));
      behind = Number.isFinite(n) ? n : null;
    } catch {
      behind = null;
    }
  }
  let builtMs: number | null = null;
  try {
    builtMs = fs.statSync(path.join(SELF_ROOT, "dist", "index.js")).mtimeMs;
  } catch {
    builtMs = null; // running from src (tsx) or never built
  }
  const headMs = Date.parse(await git(["log", "-1", "--format=%cI", "HEAD"]).catch(() => ""));
  return {
    commit,
    branch,
    behind,
    built_at: builtMs ? new Date(builtMs).toISOString() : null,
    build_age_hours: builtMs ? (now.getTime() - builtMs) / 3600_000 : null,
    stale_build: !!builtMs && Number.isFinite(headMs) && builtMs < headMs,
    checked_at: now.toISOString(),
  };
}

async function maybeRefreshDrift(now = new Date()): Promise<void> {
  if (now.getTime() - lastDriftMs < CONFIG.selfDeploy.driftCheckMin * 60_000) return;
  lastDriftMs = now.getTime();
  try {
    drift = await computeDrift(now);
  } catch (e: any) {
    console.warn("[self-deploy] drift check failed", e?.message ?? e);
    return;
  }
  // Continuous visibility, once a day at most: a silent multi-commit gap is what made PER-23 cost a
  // whole day. Only nags when there is drift AND no deploy is already in flight (that path notifies).
  const summary = driftSummary(drift, null);
  const day = now.toISOString().slice(0, 10);
  if (summary && !readPending() && lastDriftNagDay !== day) {
    lastDriftNagDay = day;
    await notify(`🕰️ <b>Chronos is stale</b> — ${summary}. Deploy with <code>POST /api/self-deploy</code> — never <code>npm run deploy</code>, it kills live runs.`).catch(() => {});
  }
}

let busy = false;

/**
 * One self-deploy step. Never throws — it runs on a timer and every failure path has to leave the
 * marker in a state the next tick can act on.
 */
export async function maybeSelfDeploy(now = new Date()): Promise<void> {
  if (!CONFIG.selfDeploy.enabled || busy) return;
  const m = readPending();
  if (!m) return;
  busy = true;
  try {
    if (m.state === "restarting") {
      const verdict = resolveRestart(m, BOOT_MS, now.getTime());
      if (verdict === "waiting") return;
      if (verdict === "deployed") {
        clearPending();
        await notifyInfo(`🚀 <b>Chronos deployed</b> ${m.commit?.slice(0, 7) ?? "new build"} (${m.ticket_key}) — daemon restarted on the merged code.`).catch(() => {});
        return;
      }
      // Built fine but never went down: launchd didn't re-exec us. Back to queued so the next idle
      // window retries, and count it as an attempt so a broken kickstart can't spin forever.
      writePending({ ...m, state: "queued", attempts: m.attempts + 1, last_attempt_at: now.toISOString(), last_error: "restart did not take effect" });
      await notify(`⚠️ <b>Self-deploy</b> built ${m.commit?.slice(0, 7) ?? ""} but the daemon never restarted — still running the old build.`).catch(() => {});
      return;
    }

    if (alreadyLive(m, drift, BOOT_MS)) {
      clearPending();
      console.log(`[self-deploy] ${m.ticket_key} already live on ${drift?.commit?.slice(0, 7)} — cleared the ${m.state} marker`);
      await notifyInfo(`🚀 <b>Chronos deployed</b> ${drift?.commit?.slice(0, 7) ?? ""} (${m.ticket_key}) — the daemon is already on a newer build; cleared the ${m.state} deploy.`).catch(() => {});
      return;
    }

    const d = dispatchStatus();
    const gate = deployGate({
      active: d.active,
      queued: d.queued,
      running: runs.runningCount(),
      attempts: m.attempts,
      lastAttemptMs: m.last_attempt_at ? Date.parse(m.last_attempt_at) : null,
      requestedMs: Date.parse(m.requested_at),
      nowMs: now.getTime(),
      maxAttempts: CONFIG.selfDeploy.maxAttempts,
      retryMin: CONFIG.selfDeploy.retryMin,
      idleWaitMin: CONFIG.selfDeploy.idleWaitMin,
    });
    if (!gate.go) {
      // Waited past the ceiling: tell the operator once, then keep waiting. Forcing the restart here
      // would kill the very runs we are waiting on.
      if (gate.overdue && !m.waited_notified && gate.reason === "fleet-busy") {
        writePending({ ...m, waited_notified: true });
        await notify(`⏳ <b>Self-deploy waiting</b> ${m.ticket_key} merged ${CONFIG.selfDeploy.idleWaitMin}m ago and the fleet is still busy — not restarting on live runs.`).catch(() => {});
      }
      return;
    }
    await runDeployChain(m, now);
  } catch (e: any) {
    console.warn("[self-deploy]", e?.message ?? e);
  } finally {
    busy = false;
  }
}

export type ShellFn = (cmd: string, timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;

/**
 * The chain's environment: the daemon's, minus its own CHRONOS_* knobs. The daemon boots with its
 * secrets file in process.env (CHRONOS_DIGEST_HOUR=-1, budgets, gates…) and `npm test` inherited
 * all of it: a suite written against the defaults failed on the production values — three
 * self-deploys in a row on 2026-09-14 died at `npm test` with a hygiene assertion that passed
 * everywhere else. The test script sets the CHRONOS_* it needs itself; pull and build need none.
 */
export function deployEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("CHRONOS_")));
}

const realSh: ShellFn = (cmd, timeout) =>
  execFileTimed("bash", ["-lc", cmd], { cwd: SELF_ROOT, encoding: "utf8", timeout, env: deployEnv() });

let sh: ShellFn = realSh;
let restart: () => void = restartDaemon;

// The chain shells out and then kills this process — both halves swappable so tests can drive the
// real gating/marker logic without running a 20-minute suite or restarting the daemon under them
// (same seam as dispatcher.setExecutor). Pass nulls to restore the real ones.
export function setDeployRunner(o: { sh?: ShellFn | null; restart?: (() => void) | null }): void {
  sh = o.sh ?? realSh;
  restart = o.restart ?? restartDaemon;
}

// The deploy chain needs a shell (`&&`, npm on PATH), so the branch is interpolated into a command
// string. `repo.default_branch` is admin-writable, not agent-writable, but "admin-only" is not a
// reason to hand a DB column to bash — a branch is a ref name and nothing else.
export function isSafeBranchName(b: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(b) && !b.startsWith("-") && !b.includes("..");
}

// pull → test → build → restart. A red test suite stops at step 2 with the marker intact: the daemon
// keeps running the old (working) build rather than restarting into code that fails its own tests.
async function runDeployChain(m: PendingDeploy, now: Date): Promise<void> {
  const fail = async (stage: string, e: any) => {
    const detail = String(e?.stderr || e?.stdout || e?.message || e).trim().slice(-1200);
    if (stage === "git pull" && isTransientFailure(detail)) {
      writePending({ ...m, state: "queued", last_attempt_at: now.toISOString(), last_error: `${stage} (network, retrying): ${detail}` });
      console.warn(`[self-deploy] ${m.ticket_key}: git pull hit the network, retrying after backoff — ${detail.slice(-200)}`);
      return;
    }
    const attempts = m.attempts + 1;
    writePending({ ...m, state: attempts >= CONFIG.selfDeploy.maxAttempts ? "blocked" : "queued", attempts, last_attempt_at: now.toISOString(), last_error: `${stage}: ${detail}` });
    const stop = attempts >= CONFIG.selfDeploy.maxAttempts ? " — giving up until the next merge, deploy by hand" : "";
    await notify(`🚨 <b>Self-deploy blocked</b> (${m.ticket_key}) — <code>${stage}</code> failed, daemon still on the old build${stop}:\n<code>${detail.slice(-600)}</code>`).catch(() => {});
  };

  if (!isSafeBranchName(m.branch)) {
    return fail("git pull", new Error(`refusing to deploy: unsafe branch name ${JSON.stringify(m.branch)}`));
  }
  try {
    await sh(`git checkout ${m.branch} && git pull --ff-only`, 120_000);
  } catch (e: any) {
    return fail("git pull", e);
  }
  const commit = await sh("git rev-parse HEAD", 15_000).then((r) => r.stdout.trim() || null).catch(() => null);
  try {
    await sh("npm test", CONFIG.selfDeploy.testTimeoutMin * 60_000);
  } catch (e: any) {
    return fail("npm test", e);
  }
  try {
    await sh("npm run build", 300_000);
  } catch (e: any) {
    return fail("npm run build", e);
  }

  // Marker first, restart second — it has to already be on disk when the process we are about to
  // kill is us. built_at is what the next boot compares against.
  writePending({ ...m, state: "restarting", commit, built_at: new Date().toISOString(), last_attempt_at: now.toISOString(), last_error: null });
  await notify(`🏗️ <b>Self-deploy</b> ${m.ticket_key} — tests green, built ${commit?.slice(0, 7) ?? ""}, restarting the daemon.`).catch(() => {});
  restart();
}

function restartDaemon(): void {
  // launchd owns this process (KeepAlive=true): kickstart -k SIGTERMs us and re-execs dist/index.js.
  // detached + unref'd so the launchctl child is not in our process group — it has to outlive the
  // signal it is about to have delivered to us.
  try {
    const child = spawn("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 0}/${CONFIG.selfDeploy.launchdLabel}`], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (e) => console.error("[self-deploy] kickstart failed", e?.message ?? e));
    child.unref();
  } catch (e: any) {
    console.error("[self-deploy] kickstart failed", e?.message ?? e);
  }
}

export function startSelfDeploy(): void {
  // Drift reporting runs even with the auto-deploy switched off: someone who deploys by hand needs
  // the "N commits behind" signal MORE, not less. maybeSelfDeploy is the part `enabled` gates.
  if (process.env.CHRONOS_TEST === "1") return;
  const tick = async () => {
    await maybeSelfDeploy().catch(() => {});
    await maybeRefreshDrift().catch(() => {});
  };
  // 20s after boot: resolves a marker left by the restart we just came back from, and reports drift
  // for a daemon nobody deployed at all.
  setTimeout(tick, 20_000).unref?.();
  setInterval(tick, Math.max(30, CONFIG.selfDeploy.pollSec) * 1000).unref?.();
  console.log(
    CONFIG.selfDeploy.enabled
      ? `[self-deploy] watching ${SELF_ROOT} · idle ceiling ${CONFIG.selfDeploy.idleWaitMin}m`
      : `[self-deploy] auto-deploy off — drift reporting only (${SELF_ROOT})`,
  );
}
