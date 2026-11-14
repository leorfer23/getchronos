import { Cron } from "croner";
import { jobs, kv, runs } from "./store.js";
import { dispatch } from "./dispatcher.js";
import { onceDecision } from "./once.js";
import { missedFire } from "./cron-catchup.js";
import { CONFIG } from "./config.js";
import { brainAwakeSince } from "./brain-awake.js";
import type { Job } from "./types.js";

const tasks = new Map<string, Cron>();

/**
 * A cheap daemon-side check that can skip a cron fire before any model runs — keyed by job-name
 * prefix (e.g. `inbox-cleanup:` skips a client with nothing open). Returns the skip reason, or null.
 */
type CronGate = (job: { id: string; name: string; workspace_id: string | null }) => string | null;
const gates = new Map<string, CronGate>();
export function registerCronGate(prefix: string, gate: CronGate): void { gates.set(prefix, gate); }
export function cronSkipReason(job: { id: string; name: string; workspace_id: string | null }): string | null {
  for (const [prefix, gate] of gates) {
    if (!job.name.startsWith(prefix)) continue;
    try { const why = gate(job); if (why) return why; } catch (e) { console.warn(`[scheduler] gate ${prefix} threw:`, e); }
  }
  return null;
}

/**
 * The last cron fire of a job that started no run, and why — the job check (src/job-check.ts) reads it
 * to tell a fire skipped on purpose from one that never happened (daemon down at that minute).
 * gate: a cron gate said there was nothing to do · inflight: the previous run was still going ·
 * refused: dispatch() said no (budget, loop guard, burn brake, backend not allowed…) — that one is a
 * failure to run, and used to vanish into the scheduler's ignored return value.
 */
export interface CronSkip { at: string; kind: "gate" | "inflight" | "refused"; why: string }
const SKIP_KEY = "cron.skip.";
function noteSkip(jobId: string, kind: CronSkip["kind"], why: string): void {
  try { kv.set(SKIP_KEY + jobId, JSON.stringify({ at: new Date().toISOString(), kind, why })); } catch (e) { console.warn("[scheduler] could not record a skip", e); }
}
export function lastCronSkip(jobId: string): CronSkip | null {
  try { const v = kv.get(SKIP_KEY + jobId); return v ? (JSON.parse(v) as CronSkip) : null; } catch { return null; }
}

// True when this job still has a queued/running run — skip stacking cron fires on a long job.
function hasInflight(jobId: string): boolean {
  return runs.list(jobId, 20).some((r) => r.status === "running" || r.status === "queued");
}

// One cron fire: skip a stacked or gated fire (recorded, so the job check can tell), else dispatch.
function fireCron(job: Job, trigger: string): void {
  try {
    if (hasInflight(job.id)) {
      console.log(`[scheduler] skip cron ${job.id.slice(0, 8)} — prior run still inflight`);
      noteSkip(job.id, "inflight", "prior run still inflight");
      return;
    }
    const skip = cronSkipReason(job);
    if (skip) {
      console.log(`[scheduler] skip cron ${job.name} — ${skip}`);
      noteSkip(job.id, "gate", skip);
      return;
    }
    const r = dispatch(job.id, trigger);
    if ("error" in r) {
      console.warn(`[scheduler] cron ${job.name} refused: ${r.error}`);
      noteSkip(job.id, "refused", r.error);
    }
  } catch (e) {
    console.error(`[scheduler] dispatch failed for job ${job.id}:`, e);
  }
}

/**
 * A cron fire waits until the Mac has been awake this long. A fire it slept through comes due in the next
 * dark wake — 2 seconds, no network — so the run started, the Mac slept again, and the run timed out on
 * the wake after (2026-11-12, reap-stale-worktrees-chronos). A Mac in use is long past it; the minute
 * after the lid opens is the only fire it delays.
 */
const AWAKE_BEFORE_FIRE_MS = 60_000;
/** How long a cron fire at `nowMs` waits for the Mac to have been awake a minute; 0 = fire now. */
export function cronFireWait(nowMs: number, awakeSinceMs: number): number {
  return Math.min(AWAKE_BEFORE_FIRE_MS, Math.max(0, AWAKE_BEFORE_FIRE_MS - (nowMs - awakeSinceMs)));
}
const waitingToFire = new Set<string>();
/** The cron fire, held until the Mac has been awake a minute — re-checked each time, so a later dark wake waits again. */
export function fireCronWhenAwake(job: Job): void {
  const wait = cronFireWait(Date.now(), brainAwakeSince());
  if (wait === 0) return fireCron(job, "cron");
  if (waitingToFire.has(job.id)) return;
  waitingToFire.add(job.id);
  console.log(`[scheduler] ${job.name} waits ${Math.ceil(wait / 1000)}s — the Mac just woke (a dark wake has no network)`);
  setTimeout(() => {
    waitingToFire.delete(job.id);
    const cur = jobs.get(job.id); // disabled or deleted while it waited → no fire
    if (cur?.enabled && cur.cron_expr) fireCronWhenAwake(cur);
  }, wait).unref?.();
}

// Rebuild all cron registrations from the jobs table. Called on boot and on any job CRUD.
export function reloadSchedules(): void {
  for (const c of tasks.values()) c.stop();
  tasks.clear();

  for (const job of jobs.enabledCron()) {
    if (!job.cron_expr) continue;
    try {
      const cron = new Cron(
        job.cron_expr,
        // protect: block re-entry while the callback itself is still on the stack/promise;
        // hasInflight covers the longer case where the prior run is still queued/executing.
        { timezone: job.timezone || "UTC", name: job.id, protect: true },
        () => fireCronWhenAwake(job)
      );
      tasks.set(job.id, cron);
    } catch (e) {
      console.error(`[scheduler] bad cron for job ${job.id}: ${job.cron_expr}`, e);
    }
  }
  // One-time jobs: a single fire at run_at. Firing clears run_at, so the job stays a manual job
  // with that run in its history; a fire missed while the daemon was down is caught up if recent.
  for (const job of jobs.enabledOnce()) {
    const ranSince = runs.list(job.id, 5).some((r) => r.started_at && r.started_at >= job.run_at!);
    const d = onceDecision(job.run_at, ranSince);
    if (d === "retire") { jobs.update(job.id, { run_at: null }); continue; }
    if (d === "fire") { fireOnce(job.id); continue; }
    try {
      tasks.set(job.id, new Cron(new Date(job.run_at!), { name: job.id, protect: true }, () => fireOnce(job.id)));
    } catch (e) {
      console.error(`[scheduler] bad run_at for job ${job.id}: ${job.run_at}`, e);
    }
  }
  console.log(`[scheduler] ${tasks.size} cron job(s) active`);
}
function fireOnce(jobId: string) {
  try {
    const r = dispatch(jobId, "once");
    if ("error" in r) console.error(`[scheduler] once-dispatch refused for job ${jobId.slice(0, 8)}: ${r.error}`);
  } catch (e) {
    console.error(`[scheduler] once-dispatch failed for job ${jobId}:`, e);
  }
  jobs.update(jobId, { run_at: null });
  tasks.get(jobId)?.stop();
  tasks.delete(jobId);
}

/**
 * Boot only: run once every enabled cron job whose latest fire fell while the daemon was down
 * (src/cron-catchup.ts has the rule). The job check goes last — it judges the others, and their
 * catch-up runs are live by then, so it does not call them missed. Returns how many it fired.
 */
export function catchUpMissedCron(now = new Date()): number {
  const windowMs = CONFIG.cronCatchupHours * 3_600_000;
  if (!(windowMs > 0)) return 0;
  const due: { job: Job; at: Date }[] = [];
  for (const job of jobs.enabledCron()) {
    if (!job.cron_expr) continue;
    const lastStartedAt = runs.list(job.id, 5).reduce<string | null>((m, r) => (r.started_at && (!m || r.started_at > m) ? r.started_at : m), null);
    const at = missedFire({
      expr: job.cron_expr, tz: job.timezone || "UTC", createdAt: job.created_at,
      lastStartedAt, lastSkipAt: lastCronSkip(job.id)?.at ?? null, windowMs, now,
    });
    if (at) due.push({ job, at });
  }
  due.sort((a, b) => Number(a.job.name.startsWith("job-check:")) - Number(b.job.name.startsWith("job-check:")));
  for (const { job, at } of due) {
    console.log(`[scheduler] catch-up ${job.name} — due ${at.toISOString()}, the daemon was down then`);
    fireCron(job, "cron:catchup");
  }
  return due.length;
}

export function nextRun(jobId: string): string | null {
  const t = tasks.get(jobId);
  const n = t?.nextRun();
  return n ? n.toISOString() : null;
}
