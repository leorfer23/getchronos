/**
 * The reconciler: the other half of "launch, sleep, reconcile" (see runner.ts's cloud section and
 * docs/plans/2026-09-22-cursor-cloud-backend.md). A cloud run's process does not live on this
 * machine, so nothing here assumes the daemon that launched it is the one that finishes it — every
 * pass re-derives "what's still live" from the DB, not from in-memory state.
 *
 * Runs at daemon boot (index.ts) and every 60s WHILE at least one run has a cloud backend and
 * status='running' — nothing to reconcile → no timer at all. Migration 130's
 * idx_runs_cloud_live(status, cloud_agent_id) is this module's only query.
 */
import { db, jobs, runs } from "./store.js";
import { getBackend } from "./backends/index.js";
import { isCloudBackend } from "./backends/types.js";
import type { AgentBackend, CloudBackend, CloudRef } from "./backends/types.js";
import { finalizeCloudRun, isCloudStreaming, streamCloudRun } from "./runner.js";
import type { Job, Run } from "./types.js";

// How a job's backend name resolves to an AgentBackend. Swappable so tests can register a
// hand-written fake CloudBackend under a test-only name, mirroring dispatcher.ts's setExecutor —
// the real registry (src/backends/index.ts) is owned by another branch in this rollout and this PR
// must not import cursor-cloud.ts, so this is the seam tests drive instead.
let resolveBackend: (name: string) => AgentBackend = getBackend;
export function setBackendResolver(fn: ((name: string) => AgentBackend) | null): void {
  resolveBackend = fn ?? getBackend;
}

// Budget: ≤20 req/min across every run this reconciler touches (the provider's own per-user cap),
// plus a straight backoff window on a 429 from any call. Shared across every run in a tick — one
// slow/noisy workspace must not starve another's reconcile.
const REQS_PER_MIN = 20;
let windowStart = Date.now();
let reqsThisWindow = 0;
let backoffUntil = 0;

function takeSlot(): boolean {
  const now = Date.now();
  if (now - windowStart >= 60_000) {
    windowStart = now;
    reqsThisWindow = 0;
  }
  if (now < backoffUntil) return false;
  if (reqsThisWindow >= REQS_PER_MIN) return false;
  reqsThisWindow++;
  return true;
}

function isRateLimited(e: any): boolean {
  return e?.status === 429 || e?.code === 429 || /\b429\b|resource[_ ]exhausted|rate[- ]?limit/i.test(String(e?.message ?? e ?? ""));
}

function backoffFrom(e: any): void {
  const v = Number(e?.retryAfter ?? e?.retry_after);
  const sec = Number.isFinite(v) && v > 0 ? v : 60;
  backoffUntil = Date.now() + sec * 1000;
}

// Every run this daemon still believes is live on a cloud provider — the exact query the migration
// 130 index exists for. Raw SQL (not a new store/runs.ts method): this module is the only caller,
// and every other file in this PR's list is runner.ts/index.ts, not the store.
function liveCloudRuns(): Run[] {
  return db.prepare("SELECT * FROM runs WHERE status = 'running' AND cloud_agent_id IS NOT NULL").all() as Run[];
}

/** Pure decision, exported for tests: has this run been running longer than its job allows? */
export function isCloudTimedOut(run: Pick<Run, "started_at">, timeoutSec: number): boolean {
  if (!run.started_at || timeoutSec <= 0) return false;
  return (Date.now() - Date.parse(run.started_at)) / 1000 > timeoutSec;
}

/** Exported for tests — the per-run decision, with the backend already resolved. */
export async function reconcileOne(job: Job, run: Run, backend: CloudBackend): Promise<void> {
  if (!run.cloud_agent_id || !run.cloud_run_id) return;
  const ref: CloudRef = { agentId: run.cloud_agent_id, runId: run.cloud_run_id, workspaceId: job.workspace_id ?? null };

  // Timeout needs no API call to detect — only to act on. job.timeout_sec is client-side for cloud
  // (the provider has no idea what Chronos's budget is); this is where it's enforced.
  if (isCloudTimedOut(run, job.timeout_sec)) {
    if (!takeSlot()) return;
    try {
      await backend.cancel(ref);
    } catch (e: any) {
      if (isRateLimited(e)) {
        backoffFrom(e);
        return;
      }
      console.warn(`[cloud-reconcile] ${run.id.slice(0, 8)}: cancel on timeout failed — finalizing as timeout anyway`, e?.message ?? e);
    }
    await finalizeCloudRun(job, run.id, backend, ref, "timeout");
    return;
  }

  // This process is already tailing the live stream (executeCloud, or an earlier reconcile pass) —
  // it will self-finalize on its own terminal frame. Polling again here would race it.
  if (isCloudStreaming(run.id)) return;

  if (!takeSlot()) return;
  let state;
  try {
    state = await backend.getRun(ref);
  } catch (e: any) {
    if (isRateLimited(e)) backoffFrom(e);
    return; // transient — the next tick tries again
  }

  if (state.status === "running") {
    // Still going, no stream attached — reattach from where the last daemon left off. Fire-and-
    // forget from the sweep's point of view: this resolves whenever the run's stream itself ends
    // (terminal or another disconnect), which may well be well past this tick.
    void streamCloudRun(backend, ref, run.id, run.cloud_last_event_id)
      .then((r) => (r.terminal ? finalizeCloudRun(job, run.id, backend, ref) : undefined))
      .catch((e) => console.warn(`[cloud-reconcile] ${run.id.slice(0, 8)}: reattach failed`, e?.message ?? e));
    return;
  }

  // Terminal server-side — finalize through the exact path executeCloud uses.
  await finalizeCloudRun(job, run.id, backend, ref);
}

/** One sweep over every live cloud run. Exported for tests (awaitable; startCloudReconcile is not). */
export async function tick(): Promise<void> {
  const live = liveCloudRuns();
  for (const run of live) {
    const job = jobs.get(run.job_id);
    if (!job) continue;
    const backend = resolveBackend(job.backend);
    if (!isCloudBackend(backend)) continue; // defensive: the job's backend changed under us
    try {
      await reconcileOne(job, run, backend);
    } catch (e: any) {
      console.error(`[cloud-reconcile] ${run.id.slice(0, 8)}: unexpected error`, e);
    }
  }
  ensureTimer();
}

let timer: NodeJS.Timeout | null = null;

// Only while at least one run has a cloud backend and status='running' — nothing to do → no timer.
// Re-evaluated after every tick (a run finishing may mean there's nothing left to watch) and every
// time a new cloud run is dispatched (executeCloud has no reason to call this itself; the next
// scheduled tick, or the boot call, picks it up within 60s either way).
function ensureTimer(): void {
  const stillLive = liveCloudRuns().length > 0;
  if (stillLive && !timer) {
    timer = setInterval(() => void tick(), 60_000);
    timer.unref?.();
  } else if (!stillLive && timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Whether the 60s timer is currently armed. Exported for tests; not otherwise useful outside this module. */
export function isReconcileArmed(): boolean {
  return timer !== null;
}

/** Test-only reset: clears the timer and rate-limit window between test cases. */
export function resetCloudReconcileForTest(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  windowStart = Date.now();
  reqsThisWindow = 0;
  backoffUntil = 0;
  resolveBackend = getBackend;
}

/** Daemon-boot entry point (index.ts). Reconciles once immediately, then arms the 60s timer if needed. */
export function startCloudReconcile(): void {
  void tick();
}
