import { Cron } from "croner";
import { jobs, runs } from "./store.js";
import { dispatch } from "./dispatcher.js";
import { onceDecision } from "./once.js";

const tasks = new Map<string, Cron>();

// True when this job still has a queued/running run — skip stacking cron fires on a long job.
function hasInflight(jobId: string): boolean {
  return runs.list(jobId, 20).some((r) => r.status === "running" || r.status === "queued");
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
        () => {
          try {
            if (hasInflight(job.id)) {
              console.log(`[scheduler] skip cron ${job.id.slice(0, 8)} — prior run still inflight`);
              return;
            }
            dispatch(job.id, "cron");
          } catch (e) {
            console.error(`[scheduler] dispatch failed for job ${job.id}:`, e);
          }
        }
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

export function nextRun(jobId: string): string | null {
  const t = tasks.get(jobId);
  const n = t?.nextRun();
  return n ? n.toISOString() : null;
}
