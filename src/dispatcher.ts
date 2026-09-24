import fs from "node:fs";
import { CONFIG } from "./config.js";
import { bus } from "./bus.js";
import { backendAllowed, getBackend, validateSpawnTarget, workspaceBackends } from "./backends/index.js";
import { isCloudBackend } from "./backends/types.js";
import type { CloudRef } from "./backends/types.js";
import { jobs, repos, runs, tickets, workspaces } from "./store.js";
import { AUTH_ERR_RE, execute, isReadOnlyRun } from "./runner.js";
import { openSession } from "./terminal.js";
import { notify, esc } from "./telegram/api.js";
import { burnHalted } from "./burn-guard.js";
import { gateDispatch } from "./quota-gate.js";
import { renderReplay } from "./replay.js";
import { hostFor } from "./hosts/index.js";
import type { Job, Run, RunStatus } from "./types.js";

// Single choke point for every trigger source. Enforces guardrails, then runs.
const queue: Array<{ runId: string; jobId: string; depth: number }> = [];
let active = 0;

// The function that actually runs a job. Swappable so tests can drive the dispatcher's
// retry/chain/budget logic without spawning real Claude processes. Defaults to the real runner.
let executor: typeof execute = execute;
export function setExecutor(fn: typeof execute | null) {
  executor = fn ?? execute;
}

// Same pattern for stopCloudRun's backend lookup: swappable so tests can register a hand-written
// fake CloudBackend without needing it in the real registry (src/backends/index.ts, not owned by
// this file's tests — see runner.ts's cloud-reconcile.ts for the identical seam).
let resolveStopBackend: typeof getBackend = getBackend;
export function setStopBackendResolver(fn: typeof getBackend | null) {
  resolveStopBackend = fn ?? getBackend;
}

// Cap on chained on_success/on_failure hops to stop a misconfigured A→B→A loop from running forever.
const MAX_CHAIN_DEPTH = 8;

/**
 * Loop guard — the backstop for every re-trigger cycle, not just the ones we've already seen.
 *
 * Chain depth only bounds on_success/on_failure hops. It does nothing for a cycle that goes out
 * through the bus and comes back: a rate-limited reviewer's fallback clone ended as a "build",
 * which queued a review, which auto-dispatched a reviewer, which rate-limited… PER-80 ran 200 times
 * in four hours and Telegram got every hop of it.
 *
 * Job ROWS are recreated per dispatch, so the identity that survives a cycle is the job NAME. A name
 * that starts more than `runsPerJobHourCap` runs in an hour is a loop — real work never does that —
 * so every trigger source is refused until the window goes quiet. Self-healing: nothing to reset.
 */
const LOOP_WINDOW_MS = 3600_000;
const loopTripped = new Set<string>();
function loopGuardTripped(job: Job): boolean {
  const cap = CONFIG.runsPerJobHourCap;
  if (cap <= 0) return false;
  const since = new Date(Date.now() - LOOP_WINDOW_MS).toISOString();
  if (runs.countRecentByJobName(job.name, since) < cap) {
    loopTripped.delete(job.name);
    return false;
  }
  if (!loopTripped.has(job.name)) {
    loopTripped.add(job.name);
    console.error(`[loop-guard] ${job.name}: ${cap}+ runs in the last hour — refusing to dispatch`);
    void notify(
      `🔁 <b>Loop guard</b> — <code>${esc(job.name)}</code> started ${cap}+ runs in an hour. ` +
        `Dispatch is blocked until it goes quiet; something is re-triggering it.`
    ).catch(() => {});
  }
  return true;
}

export function dispatch(
  jobId: string,
  triggerSrc: string,
  depth = 0,
  context?: string | null,
  // Prior conversation to reopen (answered `mc ask`). MUST be threaded here, not patched onto the
  // run after dispatch() returns: pump() invokes the executor synchronously, and execute() reads
  // resume_session in its synchronous prologue — a post-dispatch patch lands too late and the resume
  // silently degrades to a fresh session.
  resumeSession?: string | null
): { run_id: string; status: string } | { error: string } {
  const job = jobs.get(jobId);
  if (!job) return { error: "job not found" };
  if (!job.enabled) return { error: "job disabled" };
  // Fail closed with an explicit message before we create a run — an unknown/retired (backend,model)
  // used to spawn, die in ~1s with zero events, and surface as "Unexpected server error" (PER-22).
  // Jobs carry no repo_id directly — derive it via the ticket (same two-step as runner.ts) so the
  // cursor-cloud GitHub/delivery=pr gate actually sees the repo instead of silently no-op'ing.
  // A ticketless job (a Desk cloud terminal opened straight from the repo picker, src/desk-cloud.ts —
  // no ticket at all) has no ticket to derive from, so fall back to matching job.cwd against a
  // registered repo's root: exact, or a worktree living under it. Still fails closed when neither
  // resolves anything — this only stops a repo that plainly IS there from reading as "none".
  //
  // job.cwd was realpath'd by sanitizeCwd() at job creation (spawn-guard.ts checkCwd); a repo's own
  // `path` column usually was NOT (it is whatever the operator typed when the repo was registered).
  // A comparison without realpath'ing both sides misses every repo living behind a symlinked parent
  // (macOS's /tmp -> /private/tmp, /var -> /private/var) — resolve each candidate the same way
  // allowedRoots() does, and skip one that no longer exists on disk rather than throw.
  const realpath = (p: string): string | null => { try { return fs.realpathSync(p); } catch { return null; } };
  const dispatchTicket = job.ticket_id ? tickets.get(job.ticket_id) : undefined;
  const dispatchRepo =
    (dispatchTicket?.repo_id ? repos.get(dispatchTicket.repo_id) : undefined) ??
    (job.cwd
      ? repos
          .list(job.workspace_id ?? undefined)
          .map((r) => ({ r, real: r.path ? realpath(r.path) : null }))
          .filter((x): x is { r: typeof x.r; real: string } => x.real !== null && (job.cwd === x.real || job.cwd.startsWith(x.real + "/")))
          .sort((a, b) => b.real.length - a.real.length)[0]?.r
      : undefined);
  const spawnErr = validateSpawnTarget(job.backend, job.model, dispatchRepo);
  if (spawnErr) return { error: spawnErr };
  // Same client boundary the Desk enforces, on the headless path: cursor/grok/opencode share one
  // login across every workspace, so a client's job must not be able to reach for them.
  if (job.workspace_id && job.backend) {
    const jws = workspaces.get(job.workspace_id);
    if (jws && !backendAllowed(jws.backends, job.backend))
      return { error: `${jws.name} may not run \`${job.backend}\` — allowed here: ${workspaceBackends(jws.backends).join(", ")}` };
  }
  if (loopGuardTripped(job)) return { error: `loop guard: ${job.name} ran ${CONFIG.runsPerJobHourCap}+ times in the last hour` };
  // Fleet-wide velocity brake: the loop guard is per job NAME, so a cycle that spreads across names
  // (review:X + its fallback clones + ideas:followups:X) slips under every individual cap.
  const burn = burnHalted();
  if (burn) return { error: burn };

  // One agent per worktree. Two build runs in the same cwd share a branch and a working tree: they
  // overwrite each other's edits and `git add -A` each other's half-finished work (ACM-63 ran two
  // agents on mc/acm-63 and paid twice for one ticket). dispatchTicket has its own per-ticket guard,
  // but everything else — the UI/API "run job" button, triggers, chains, telegram — lands here, so
  // the lock belongs at the choke point. Read-only runs (plan/review/grade/distill) are exempt on
  // both sides: they don't write, and panels deliberately run several at once in the shared checkout.
  if (job.ticket_id && job.cwd && !isReadOnlyRun(job.name)) {
    const busy = runs.activeTicketRunsInCwd(job.cwd).filter((r) => !isReadOnlyRun(r.job_name));
    if (busy.length)
      return { error: `another agent is already working in ${job.cwd} (run ${busy[0].run_id.slice(0, 8)})` };
  }

  const run = runs.create(jobId, triggerSrc);
  if (context) runs.patch(run.id, { context });
  if (resumeSession) runs.patch(run.id, { resume_session: resumeSession });

  // Guardrail: daily budget cap.
  if (CONFIG.dailyBudgetUsd > 0 && runs.spentTodayUsd() >= CONFIG.dailyBudgetUsd) {
    runs.patch(run.id, {
      status: "blocked",
      error: `daily budget $${CONFIG.dailyBudgetUsd} reached`,
      ended_at: new Date().toISOString(),
    });
    return { run_id: run.id, status: "blocked" };
  }

  // Guardrail: per-workspace daily budget cap (only narrows the global cap; null = global-only).
  if (job.workspace_id) {
    const ws = workspaces.get(job.workspace_id);
    if (ws?.daily_budget_usd != null && ws.daily_budget_usd > 0 &&
        runs.spentTodayUsdForWorkspace(job.workspace_id) >= ws.daily_budget_usd) {
      runs.patch(run.id, {
        status: "blocked",
        error: `workspace ${ws.slug} daily budget $${ws.daily_budget_usd} reached`,
        ended_at: new Date().toISOString(),
      });
      return { run_id: run.id, status: "blocked" };
    }
  }

  // Guardrail: can the backend this run resolved to actually FINISH it? The budget caps above ask
  // whether we may spend; this asks whether there is anything left to spend. `warn` (the default)
  // records the verdict on the run and proceeds; `enforce` parks. See src/quota-gate.ts.
  const noRunway = gateDispatch(job, run.id);
  if (noRunway) {
    runs.patch(run.id, { status: "blocked", error: noRunway, ended_at: new Date().toISOString() });
    return { run_id: run.id, status: "blocked" };
  }

  queue.push({ runId: run.id, jobId, depth });
  pump();
  return { run_id: run.id, status: "queued" };
}

// A queued run can start unless its workspace is at its own max_concurrent cap (null = global-only).
function wsHasConcurrencySlot(jobId: string): boolean {
  const wsId = jobs.get(jobId)?.workspace_id;
  if (!wsId) return true;
  const ws = workspaces.get(wsId);
  if (!ws?.max_concurrent) return true;
  return runs.runningCountForWorkspace(wsId) < ws.max_concurrent;
}

function pump() {
  while (CONFIG.maxConcurrent <= 0 || active < CONFIG.maxConcurrent) {
    // Promote the first queued run whose workspace still has a slot; leave the others queued (don't
    // drop them) so they start when a slot frees. findIndex→-1 breaks the loop, so no livelock.
    const idx = queue.findIndex((it) => wsHasConcurrencySlot(it.jobId));
    if (idx === -1) break;
    const item = queue.splice(idx, 1)[0];
    const job = jobs.get(item.jobId);
    if (!job) continue;
    active++;
    executor(job, item.runId)
      .catch((e): RunStatus => {
        runs.patch(item.runId, { status: "failed", error: String(e) });
        bus.publish({ topic: "run.ended", run_id: item.runId, status: "failed" });
        return "failed";
      })
      .then(async (status) => {
        // Rate-limit: prefer a workspace-configured fallback backend immediately; otherwise wait to resume.
        if (status === "rate_limited") {
          if (await maybeFallback(job, item.runId, item.depth)) return;
          return maybeResume(job, item.runId, item.depth);
        }
        // A retry supersedes failure chaining: only fire on_failure once attempts are exhausted.
        if (maybeRetry(job, item.runId)) return;
        maybeChain(job, status, item.depth);
      })
      .finally(() => {
        active--;
        pump();
      });
  }
}

// Auto-retry failed/timed-out runs per the job's policy, with linear backoff.
// Returns true if a retry was scheduled (so chaining is deferred).
function maybeRetry(job: Job, runId: string): boolean {
  const run = runs.get(runId);
  if (!run) return false;
  if (run.status !== "failed" && run.status !== "timeout") return false;
  // A logged-out profile is terminal until a human logs in: retrying re-spawns the same CLI against
  // the same missing credential, so every attempt fails identically and the backoff just burns the
  // queue (196 of 287 historical failures were "Not logged in · Please run /login"). The runner has
  // already opened a login terminal and alerted; resume is the operator's move, not the retry loop's.
  if (run.error && AUTH_ERR_RE.test(run.error)) {
    console.log(`[retry] ${job.name} → skipped: profile ${job.profile} is logged out`);
    return false;
  }
  if (run.attempt > job.retry_max) return false;
  const nextAttempt = run.attempt + 1;
  const delay = job.retry_backoff_sec * 1000 * run.attempt;
  console.log(`[retry] ${job.name} → attempt ${nextAttempt}/${job.retry_max + 1} in ${delay / 1000}s`);
  setTimeout(() => {
    const r = runs.create(job.id, `retry:${runId.slice(0, 8)}`, nextAttempt);
    queue.push({ runId: r.id, jobId: job.id, depth: 0 });
    pump();
  }, delay);
  return true;
}

// Resume a run that hit a rate-limit/credit wall, once access resets. Re-dispatches the same job
// (preserving chain depth) at the reset time, if that's within the configured max wait.
function maybeResume(job: Job, runId: string, depth: number) {
  const maxH = CONFIG.resumeAfterRateLimitMaxHours;
  if (maxH <= 0) return;
  const run = runs.get(runId);
  const resetMs = run?.resets_at ? Date.parse(run.resets_at) : NaN;
  if (!Number.isFinite(resetMs)) {
    console.warn(`[resume] ${job.name}: rate limited, no reset time known — not resuming`);
    return;
  }
  const delay = Math.max(0, resetMs - Date.now()) + 30_000; // small buffer past reset
  if (delay > maxH * 3600_000) {
    console.warn(`[resume] ${job.name}: reset in ${Math.round(delay / 3600_000)}h exceeds ${maxH}h cap — not resuming`);
    return;
  }
  console.log(`[resume] ${job.name}: rate limited, resuming in ${Math.round(delay / 60_000)}m`);
  // Don't restart from zero: a backend whose headless args consume --resume reopens the
  // rate-limited session itself; anything else gets the prior run's event log replayed into the
  // dispatch context (replay.ts). Rendered lazily at fire time; if the event sweep pruned the rows
  // during the wait, the replay degrades to null and the dispatch is goal-only.
  setTimeout(() => {
    const prior = runs.get(runId);
    const native = getBackend(job.backend).headlessResume && prior?.session_id;
    const r = dispatch(
      job.id,
      `resume:rate_limit`,
      depth,
      native ? null : renderReplay(runId, "hit a rate limit"),
      native ? prior!.session_id : null,
    );
    // Hours have passed — the job can be gone (ephemeral reap), disabled, loop-guarded or budget-
    // blocked by now. Every other dispatch site warns on refusal; a resume vanishing silently is
    // the worst one to leave quiet.
    if ("error" in r) console.warn(`[resume] ${job.name}: fire-time dispatch refused — ${r.error}`);
  }, delay);
}

// Workspace-configured backup when the primary backend hits a rate/credit wall.
// Headless-capable backends get a cloned one-shot job; interactive-only (e.g. grok) open a terminal.
// Returns true when a fallback was started (caller should skip wait-for-resume).
async function maybeFallback(job: Job, runId: string, depth: number): Promise<boolean> {
  if (!job.workspace_id) return false;
  // Already the fallback hop — don't cascade.
  if (job.name.startsWith("fallback:")) return false;
  const run = runs.get(runId);
  if (run?.trigger_src?.startsWith("fallback:")) return false;

  const ws = workspaces.get(job.workspace_id);
  if (!ws?.fallback_backend) return false;
  if (ws.fallback_backend === job.backend) return false;

  const fb = getBackend(ws.fallback_backend);
  const model = ws.fallback_model ?? null;
  const note =
    `\n\n## Fallback\nPrimary backend \`${job.backend}\` hit a rate/credit limit` +
    (run?.resets_at ? ` (resets ${run.resets_at})` : "") +
    `. You are the workspace fallback (\`${ws.fallback_backend}\`). Continue the same work.`;

  // Interactive-only: open a PTY so the operator/agent can keep going without waiting for reset.
  if (fb.supportsHeadless === false) {
    try {
      const replay = renderReplay(runId, "hit a rate limit");
      const t = job.ticket_id ? tickets.get(job.ticket_id) : undefined;
      const sess = await openSession({
        workspace_id: job.workspace_id,
        repo_id: t?.repo_id ?? null,
        ticket_id: job.ticket_id,
        backend: ws.fallback_backend,
        model,
        cwd: job.cwd,
        role: "worker",
        title: t ? `${t.key} · fallback ${ws.fallback_backend}` : `fallback: ${job.name}`,
        seed: job.goal + note + (replay ? `\n\n${replay}` : ""),
      });
      console.log(
        `[fallback] ${job.name}: ${job.backend} rate-limited → interactive ${ws.fallback_backend} session ${sess.id.slice(0, 8)}`,
      );
      return true;
    } catch (e: any) {
      console.warn(`[fallback] ${job.name}: interactive ${ws.fallback_backend} failed: ${e?.message ?? e}`);
      return false;
    }
  }

  // Headless-capable: clone the job onto the fallback backend and re-dispatch immediately.
  let addDirs: string[] | null = null;
  try {
    if (job.add_dirs) addDirs = JSON.parse(job.add_dirs);
  } catch {}
  const clone = jobs.create({
    name: `fallback:${job.name}`.slice(0, 120),
    description: `Fallback after rate limit of ${job.name}`,
    goal: job.goal + note,
    append_system: job.append_system,
    profile: job.profile,
    workspace_id: job.workspace_id,
    ticket_id: job.ticket_id,
    backend: ws.fallback_backend,
    model,
    cwd: job.cwd,
    add_dirs: addDirs,
    allowed_tools: job.allowed_tools,
    disallowed_tools: job.disallowed_tools,
    sandbox: job.sandbox,
    verify: !!job.verify,
    retry_max: 0,
    on_success: job.on_success,
    on_failure: job.on_failure,
    notify: job.notify as "all" | "failures" | "off" | null,
    trigger_type: "manual",
  });
  // The stand-in is a different vendor — it can never reopen the primary's session. Replay the
  // primary's event log into its context so it continues the work instead of starting over.
  const r = dispatch(clone.id, `fallback:rate_limit:${job.name}`, depth, renderReplay(runId, "hit a rate limit"));
  if ("error" in r) {
    console.warn(`[fallback] ${job.name} → ${ws.fallback_backend}: ${r.error}`);
    return false;
  }
  console.log(`[fallback] ${job.name}: ${job.backend} rate-limited → ${ws.fallback_backend} run ${r.run_id.slice(0, 8)}`);
  return true;
}

// Chain to a follow-up job on terminal success/failure. Target is an id or exact name.
function maybeChain(job: Job, status: RunStatus, depth: number) {
  const target =
    status === "success" ? job.on_success : status === "failed" || status === "timeout" ? job.on_failure : null;
  if (!target) return;
  if (depth >= MAX_CHAIN_DEPTH) {
    console.warn(`[chain] ${job.name}: max depth ${MAX_CHAIN_DEPTH} reached, not triggering "${target}"`);
    return;
  }
  const next = jobs.get(target) ?? jobs.list().find((j) => j.name === target);
  if (!next) {
    console.warn(`[chain] ${job.name}: on_${status === "success" ? "success" : "failure"} target "${target}" not found`);
    return;
  }
  const r = dispatch(next.id, `chain:${status}:${job.name}`, depth + 1);
  if ("error" in r) console.warn(`[chain] ${job.name} → ${next.name}: ${r.error}`);
  else console.log(`[chain] ${job.name} (${status}) → ${next.name}`);
}

export function stopRun(runId: string): boolean {
  const run = runs.get(runId);
  if (!run) return false;
  // Still waiting for a slot: there is no process to signal, only a queue entry to drop.
  if (run.status === "queued") {
    const i = queue.findIndex((it) => it.runId === runId);
    if (i >= 0) queue.splice(i, 1);
    runs.patch(runId, { status: "killed", ended_at: new Date().toISOString() });
    bus.publish({ topic: "run.ended", run_id: runId, status: "killed" });
    return true;
  }
  // A cloud run has no pid — its process lives on the provider's VM, still billing until the
  // provider itself is told to stop. See stopCloudRun: the row is marked `killed` only once
  // `cancel()` actually confirms, not optimistically. Only while still running — a finished cloud
  // run keeps its cloud_agent_id/cloud_run_id forever, and there is nothing left to cancel.
  if (run.status === "running" && run.cloud_agent_id && run.cloud_run_id) return stopCloudRun(run);
  if (!run.pid) return false;
  // Signalled on the run's own host (HOSTS.md): `pid` is a process id on that machine and nowhere
  // else. Inside the try on purpose — a run on a host this brain does not know is a stop that did
  // not happen, which is exactly what `false` already means here.
  try {
    const host = hostFor(run);
    host.signal(run.pid, "SIGTERM");
    runs.setStatus(runId, "killed");
    setTimeout(() => {
      try {
        host.signal(run.pid!, "SIGKILL");
      } catch {}
    }, 5000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop a cloud run. A stop that visibly succeeds while the Cursor VM keeps working (and billing)
 * is worse than one that errors — so, unlike the local SIGTERM path, this does NOT mark the row
 * `killed` until `backend.cancel(ref)` actually confirms. On failure it says so loudly (a run event
 * + a console error) and leaves the row's status untouched, so a still-live run keeps reading as
 * still-live instead of lying `killed`.
 *
 * The HTTP layer (`POST /runs/:id/kill`, api.ts) reads this return value synchronously — cancel() is
 * a network call, so `true` here means "the stop was accepted and is in flight", the same contract
 * the local SIGTERM path already has (that also marks `killed` before the process has actually
 * exited). The row's status is the trustworthy signal either way.
 */
function stopCloudRun(run: Run): boolean {
  const job = jobs.get(run.job_id);
  if (!job) return false;
  const backend = resolveStopBackend(job.backend);
  if (!isCloudBackend(backend)) return false;
  const ref: CloudRef = { agentId: run.cloud_agent_id!, runId: run.cloud_run_id!, workspaceId: job.workspace_id ?? null };
  void (async () => {
    try {
      await backend.cancel(ref);
      runs.patch(run.id, { status: "killed", ended_at: new Date().toISOString() });
      bus.publish({ topic: "run.ended", run_id: run.id, status: "killed", job_name: job.name ?? undefined, ticket_id: job.ticket_id ?? null, workspace_id: job.workspace_id ?? null });
    } catch (e: any) {
      const msg = `cloud cancel failed — the provider VM may still be running (and billing): ${e?.message ?? e}`;
      console.error(`[stop] ${run.id.slice(0, 8)}: ${msg}`);
      runs.patch(run.id, { error: msg });
      bus.publish({ topic: "run.event", run_id: run.id, event: { type: "stop_failed", error: msg } });
    }
  })();
  return true;
}

export function status() {
  // spent_today_usd is GLOBAL (every workspace) and METERED-ONLY. Both qualifiers ship with the
  // number now: it was read as a per-workspace total on 2026-08-05 and triggered a throttle against
  // a workspace that was well inside its budget, while 91% of the day's runs were unpriced (PER-24).
  const cov = runs.spendCoverageSince(new Date().toISOString().slice(0, 10));
  return {
    active,
    queued: queue.length,
    max_concurrent: CONFIG.maxConcurrent,
    spent_today_usd: cov.usd,
    daily_budget_usd: CONFIG.dailyBudgetUsd,
    spend_scope: "global" as const,
    unpriced_runs_today: cov.unpriced,
    unpriced_backends: cov.unpriced_backends,
  };
}
