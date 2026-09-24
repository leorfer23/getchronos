/**
 * Headless runs on other computers, brain side (HOSTS.md phase 5 → Reconnect and restarts).
 *
 * A run on a host is a child of THAT host's process: a brain restart (a deploy) does not kill it, and
 * db.ts's boot sweep leaves it `running`. When its host says hello, the host's `live[]` is reconciled
 * against the runs this brain thinks are running there — the same walk remote-terminals.ts does for
 * terminals:
 *
 *  - reported, and this brain holds it (a link blip)    → re-attach: resend after our last seq;
 *  - reported, and this brain does not (brain restarted) → ADOPT it: the same reader, watchdog and
 *    finalize a fresh spawn gets (runner.ts adoptRun), and the dispatcher's retry/chain afterwards;
 *  - NOT reported (the host restarted; its children died) → `interrupted`, with the reason naming the
 *    computer — the recovery card's to decide, as for a local run after a deploy.
 * And a run the host reports that is not running here any more (killed while the host was away) is
 * stopped there.
 */
import { bus } from "./bus.js";
import { hosts, jobs, runs, workspaces } from "./store.js";
import { adoptRun } from "./runner.js";
import { afterRun } from "./dispatcher.js";
import { recordRemote } from "./egress.js";
import { findHost, remoteHosts } from "./hosts/index.js";
import { RemoteHost, type RemoteProc } from "./hosts/remote.js";
import { hostPolicy, workspaceDenied } from "./hosts/policy.js";
import type { Job, Run, RunStatus } from "./types.js";

export type RunReconcile = { reattached: string[]; adopted: string[]; lost: string[]; orphans: number[] };

const hostLabel = (h: RemoteHost) => hosts.get(h.id)?.name || h.hello?.name || h.id;

/** End a run whose process is gone with its host, without a runner to do it (nobody holds it). */
function interrupt(run: Run, reason: string): void {
  runs.patch(run.id, { status: "interrupted", ended_at: new Date().toISOString(), error: reason });
  const job = jobs.get(run.job_id);
  bus.publish({ topic: "run.ended", run_id: run.id, status: "interrupted", job_name: job?.name ?? undefined, ticket_id: job?.ticket_id ?? null, workspace_id: job?.workspace_id ?? null });
}

/**
 * Walk what a host just reported against the runs this brain has there. `adopt` is injectable so a
 * test can assert the adoption without a real supervisor.
 */
export async function reconcileRuns(
  h: RemoteHost,
  opts: { adopt?: (job: Job, runId: string, p: RemoteProc) => Promise<RunStatus> } = {},
): Promise<RunReconcile> {
  const out: RunReconcile = { reattached: [], adopted: [], lost: [], orphans: [] };
  const reported = new Map(h.reportedLive().filter((l) => l.kind === "proc").map((l) => [l.session_id, l]));
  const why = `its host ${hostLabel(h)} restarted while the run was active`;
  for (const run of runs.runningOnHost(h.id)) {
    const l = reported.get(run.id);
    const held = h.procFor(run.id);
    if (!l) {
      // The host no longer has it: its process died with the host process.
      if (held && !held.hasEnded) h.loseProc(held, why); // the runner's close path marks it interrupted
      else interrupt(run, why);
      out.lost.push(run.id);
      continue;
    }
    if (held && held.ch === l.ch) {
      held.attach();
      out.reattached.push(run.id);
      continue;
    }
    if (held) {
      // A channel we hold that the host no longer has under this run: that process is gone.
      h.loseProc(held, why);
      out.lost.push(run.id);
      continue;
    }
    const job = jobs.get(run.job_id);
    if (!job) {
      if (!l.exit) h.send({ t: "kill", ch: l.ch });
      h.send({ t: "release", ch: l.ch });
      interrupt(run, "its job was deleted while the run was active");
      out.orphans.push(l.ch);
      continue;
    }
    // The BRAIN restarted: nothing here remembers this run. Take it back — readers first, then the
    // attach, so the resend (everything the host still holds past seq 0) lands on them.
    const ws = job.workspace_id ? workspaces.get(job.workspace_id) : undefined;
    const p = h.adoptProc(l, { cwd: run.cwd ?? "", steer: !!ws?.live_steer });
    const supervise = opts.adopt ?? adoptRun;
    void supervise(job, run.id, p)
      .then((status) => (opts.adopt ? undefined : afterRun(job, run.id, status)))
      .catch((e) => console.warn(`[hosts] adopted run ${run.id.slice(0, 8)} on ${h.id}: ${e?.message ?? e}`));
    p.attach();
    out.adopted.push(run.id);
  }
  for (const l of reported.values()) {
    const run = runs.get(l.session_id);
    if (run && run.status === "running" && run.host_id === h.id) continue;
    // A run this brain has never heard of is left alone and logged — it may be another brain's.
    if (!run) {
      console.warn(`[hosts] ${h.id} reports run ${l.session_id.slice(0, 8)} this brain does not know — leaving it`);
      continue;
    }
    // Ended here while the host was away (killed from the Desk, timed out): stop it there.
    if (!l.exit) h.send({ t: "kill", ch: l.ch });
    h.send({ t: "release", ch: l.ch });
    out.orphans.push(l.ch);
  }
  return out;
}

/**
 * A removed host (Desk → Computers → Remove) takes its runs with it: nothing will ever re-attach them.
 * Held ones end through the runner's close path; the rest are marked here.
 */
export function interruptRunsOn(hostId: string): number {
  const h = findHost(hostId);
  const label = hosts.get(hostId)?.name || hostId;
  const why = `its host ${label} was removed while the run was active`;
  let n = 0;
  for (const run of runs.runningOnHost(hostId)) {
    const held = h instanceof RemoteHost ? h.procFor(run.id) : undefined;
    if (held && !held.hasEnded) (h as RemoteHost).loseProc(held, why);
    else interrupt(run, why);
    n++;
  }
  return n;
}

/**
 * A host's egress-proxy record, into the brain's audit log — but only for a workspace that may run on
 * that host at all: a host cannot write into another client's log by naming it.
 */
export function recordHostEgress(hostId: string, f: { workspace_id: string; host: string; port: number; action: "allow" | "deny" }): void {
  const ws = workspaces.get(String(f.workspace_id ?? ""));
  if (!ws) return;
  const h = findHost(hostId);
  const deny = [...hostPolicy(hostId).deny, ...(h instanceof RemoteHost ? h.reportedDeny() : [])];
  if (workspaceDenied(deny, ws)) {
    console.warn(`[hosts] ${hostId} reported egress for ${ws.slug}, which may not run there — dropped`);
    return;
  }
  recordRemote(ws.id, f.host, f.port, f.action);
}

/** Boot hook (index.ts). Returns an unsubscribe. The per-hello reconcile is driven by remote-terminals.ts. */
export function startRemoteRuns(): () => void {
  RemoteHost.egressSink = recordHostEgress;
  const onEvent = (e: any) => {
    if (e?.topic !== "host.updated" || e.status !== "disabled") return;
    // Revoked (token gone) = removed for good; a paused host keeps its runs (they finish there).
    if (hosts.get(e.host_id)?.token_hash) return;
    const n = interruptRunsOn(e.host_id);
    if (n) console.log(`[hosts] ${e.host_id} removed — ${n} run(s) on it marked interrupted`);
  };
  bus.on("event", onEvent);
  return () => {
    bus.off("event", onEvent);
    if (RemoteHost.egressSink === recordHostEgress) RemoteHost.egressSink = null;
  };
}

/** Every remote host's live runs this brain holds (diagnostics). */
export function heldRemoteRuns(): Array<{ host_id: string; run_id: string; ch: number }> {
  return remoteHosts()
    .filter((h): h is RemoteHost => h instanceof RemoteHost)
    .flatMap((h) => h.heldProcs().map((p) => ({ host_id: h.id, run_id: p.runId, ch: p.ch })));
}
