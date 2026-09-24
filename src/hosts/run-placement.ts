/**
 * Where a HEADLESS run goes (HOSTS.md phase 5). The same pure `place()` a terminal goes through, fed a
 * run's needs; this module decides which runs may leave the brain at all, and what to do when none can.
 *
 * Which runs move, and why (the whole point is the brain's RAM: every headless CLI is a few hundred MB):
 *
 *  - **Builds and post-build agents** — `ticket:`, `ci-fix:`, `merge-gate:` — work in the ticket's
 *    worktree, which tickets.ts now creates ON the host it places the build on (placeTicketWork), and
 *    everything after them (review, gates, the PR) follows that worktree. `ci-fix:`/`merge-gate:` push
 *    and read GitHub, so they also need `gh` there.
 *  - **Read-only runs that only need the repo** — `plan:`, `grade:`, `review:`, `distill:`, `ideas:` —
 *    read code and talk to the brain through `mc`. A reviewer is pinned to its build's worktree; the
 *    others run in the host's checkout of the repo. Their ticket file is delivered with the spawn.
 *  - **Any other job** (cron, `mc job new`) may move when its cwd IS a workspace repo's checkout: that is
 *    a directory the host can resolve by git remote. A job pointed at any other brain directory stays.
 *
 * What stays on the brain, always (BRAIN_ONLY_KINDS, each for a reason about what it reads):
 *
 *  - `intake:` — the chief-of-staff sweep reads Slack/Jira through MCP servers logged in to the BRAIN's
 *    profile (their OAuth tokens live in that config dir; a host's copy of the profile has none).
 *  - `prose:` — the voice pass reads the operator's own Slack writing through the same MCP login.
 *  - `dream:` — the memory pass has no repo at all: it runs in the workspace's brain landing dir (or the
 *    chronos checkout) and its input is the brain's own state.
 *  - `handoff:` — a cloud hand-off has no local process anywhere.
 *  - Anything whose task prose (goal) still names a brain file after the repo paths in it are
 *    translated — a ticket with attachments (they live in the brain's attachments dir), a no-repo
 *    ticket (its markdown is in the brain's tickets dir), a goal quoting a path under the chronos
 *    checkout. The brain-side helpers that spawn CLIs of their own (Robert's manager, the title/digest
 *    one-shots, the next-day planner, accelerators) never reach this module: they are not jobs.
 *
 * When no host can take a run (none eligible, none with room), it runs on the brain exactly as before
 * hosts existed: a headless run was never refused for load, and phase 5 does not start refusing it.
 * Placement NEVER sends a run onto a host past that host's own admission.
 */
import fs from "node:fs";
import os from "node:os";
import { CONFIG } from "../config.js";
import { bus } from "../bus.js";
import { repos, runs, tickets, workspaces, LOCAL_HOST_ID } from "../store.js";
import { getBackend } from "../backends/index.js";
import { isCloudBackend } from "../backends/types.js";
import { baseJobName } from "../job-name.js";
import { egressBrokered, egressEnforced } from "../egress.js";
import { worktreeRootFor } from "../worktree-core.js";
import { REPO_ROOT } from "../repo-root.js";
import type { Job, Repo, Ticket } from "../types.js";
import { remoteHosts } from "./index.js";
import { placementCandidates, ticketWorktreeHost } from "./candidates.js";
import { place, type PlaceRequest, type Placement } from "./placement.js";
import { brainOnlyPathsIn, tokenizePaths } from "./proc-spec.js";
import { profileNameFor } from "./spawn-spec.js";

/** Kinds that never leave the brain, with the reason placement records. See the header. */
export const BRAIN_ONLY_KINDS: Record<string, string> = {
  "intake:": "the intake sweep reads Slack/MCP through the brain's own profile login",
  "prose:": "the voice pass reads the operator's Slack through the brain's own profile login",
  "dream:": "the memory pass works from the brain's own state in a brain directory, not a repo",
  "handoff:": "a cloud hand-off runs on its provider, not on a computer of ours",
};

/** Kinds that work in a ticket worktree and ship through GitHub from wherever it is. */
const NEEDS_GH = ["ci-fix:", "merge-gate:"];

/**
 * The same directory? Both sides realpath'd: a job's cwd was (spawn-guard sanitizeCwd), a repo's
 * `path` usually was not — and macOS puts /tmp and /var behind symlinks (dispatcher.ts, the same trap).
 */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p.replace(/\/+$/, ""); } };
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "") || real(a) === real(b);
}

const kindOf = (name: string | null | undefined): string => {
  const base = baseJobName(name);
  const m = /^[a-z-]+:/.exec(base);
  return m ? m[0] : "";
};

export type RunPlaced = { host_id: string; reason: string | null };
export type RunPlacement = RunPlaced | { error: string };

const brain = (reason: string | null): RunPlaced => ({ host_id: LOCAL_HOST_ID, reason });

/**
 * May this job's run leave the brain at all? Why not, when it may not. `pinnedCwd` = the job's cwd is
 * a path on a host (a worktree there), so it is not judged as a brain directory.
 */
export function runHostEligibility(job: Pick<Job, "name" | "backend" | "workspace_id" | "ticket_id" | "cwd" | "add_dirs" | "goal">, o: { pinnedCwd?: boolean } = {}): { ok: true; repo: Repo } | { ok: false; why: string } {
  const b = getBackend(job.backend);
  if (isCloudBackend(b)) return { ok: false, why: `${b.name} runs on its provider` };
  const brainOnly = BRAIN_ONLY_KINDS[kindOf(job.name)];
  if (brainOnly) return { ok: false, why: brainOnly };
  if (!job.workspace_id) return { ok: false, why: "an unscoped job runs on the brain" };
  const ws = workspaces.get(job.workspace_id);
  if (!ws) return { ok: false, why: "no workspace" };
  if (ws.placement === "brain") return { ok: false, why: `workspace ${ws.slug} keeps its jobs on the brain (placement=brain)` };
  const wsRepos = repos.list(ws.id);
  const ticketRepo = job.ticket_id ? ticketRepoId(job.ticket_id) : null;
  const repo = (ticketRepo ? wsRepos.find((r) => r.id === ticketRepo) : undefined) ?? wsRepos.find((r) => samePath(r.path, job.cwd));
  if (!repo) return { ok: false, why: "it has no repo a host could find" };
  if (!repo.git_remote) return { ok: false, why: `repo ${repo.name} has no git remote to find it by` };
  // A job placed at dispatch must start in the repo's own checkout — a host resolves THAT by remote.
  // Any other brain directory (a subfolder, a worktree the brain made, a scratch dir) stays here.
  if (!o.pinnedCwd && !samePath(repo.path, job.cwd)) return { ok: false, why: `it starts in a directory on the brain (${job.cwd})` };
  let addDirs: string[] = [];
  try { addDirs = job.add_dirs ? JSON.parse(job.add_dirs) : []; } catch {}
  const extra = addDirs.filter((d) => !wsRepos.some((r) => samePath(r.path, d)));
  if (extra.length) return { ok: false, why: `it is granted brain directories (${extra[0]})` };
  const goal = tokenizePaths(job.goal, wsRepos, worktreeRootFor) ?? "";
  const files = brainOnlyPathsIn(goal, [os.homedir(), REPO_ROOT, process.cwd()]);
  if (files.length) return { ok: false, why: `its goal reads a file only the brain has (${files[0]})` };
  return { ok: true, repo };
}

function ticketRepoId(ticketId: string): string | null {
  return tickets.get(ticketId)?.repo_id ?? null;
}

function request(job: Pick<Job, "name" | "backend" | "workspace_id" | "sandbox">, repo: Repo | null, sticky: PlaceRequest["sticky"]): PlaceRequest {
  const ws = job.workspace_id ? workspaces.get(job.workspace_id) : undefined;
  const b = getBackend(job.backend);
  return {
    workspace: ws ? { id: ws.id, slug: ws.slug } : null,
    backend: b.name,
    backend_kind: b.kind === "cloud" ? "cloud" : "local",
    profile: profileNameFor(ws?.config_dir, CONFIG.profiles, CONFIG.defaultProfile),
    repo: repo ? { id: repo.id, name: repo.name, git_remote: repo.git_remote } : null,
    needs: {
      sandbox: String(job.sandbox ?? ws?.sandbox_mode ?? CONFIG.sandbox.defaultMode),
      egress_locked: egressEnforced(job.workspace_id),
      brokered: egressBrokered(job.workspace_id),
      procs: true,
      gh: NEEDS_GH.includes(kindOf(job.name)),
    },
    pinned: null,
    sticky,
    // Never past a host's own admission: a run is an agent's work, not the operator's hand.
    opened_by: "agent",
    fresh: !sticky,
  };
}

function decide(req: PlaceRequest): Placement {
  return place({ req, hosts: placementCandidates(), cfg: CONFIG.machine, reserve: CONFIG.placement.brainReserve, mode: CONFIG.placement.mode });
}

/** A sticky run refused on its host: say so, and log a policy refusal as the violation it is. */
function stickyRefusal(req: PlaceRequest, r: Extract<Placement, { ok: false }>, runLabel: string): { error: string } {
  if (r.kind === "policy" && req.workspace) {
    console.warn(`[placement] POLICY: refused to run ${runLabel} of ${req.workspace.slug} on ${req.sticky?.host_id} — ${r.message}`);
    bus.publish({ topic: "host.policy_violation", host_id: req.sticky?.host_id ?? "", workspace_id: req.workspace.id, session_id: null, reason: r.message });
  }
  return { error: r.message };
}

/**
 * Pick the computer for a run at dispatch. Sticky first — a job pinned to a host's worktree, a native
 * resume of a transcript that lives on a host — then, for a job that may move, the most headroom.
 * Only a sticky run can be refused (its work is on a computer that cannot take it now); everything
 * else falls back to the brain. With no host joined this is `local`, and nothing else is read.
 */
export function placeRun(job: Job, o: { resumeSession?: string | null } = {}): RunPlacement {
  const pinned = job.host_id && job.host_id !== LOCAL_HOST_ID ? job.host_id : null;
  const prior = o.resumeSession ? runs.bySession(o.resumeSession) : undefined;
  const resumedOn = prior && prior.host_id && prior.host_id !== LOCAL_HOST_ID ? prior.host_id : null;
  if (!pinned && !resumedOn && !remoteHosts().length) return brain(null);
  if (isCloudBackend(getBackend(job.backend))) return brain(null);

  const sticky = pinned
    ? { host_id: pinned, why: "its worktree is on that computer" }
    : resumedOn
      ? { host_id: resumedOn, why: "it resumes a CLI transcript that is on that computer" }
      : null;
  if (sticky) {
    const repo = runRepoOf(job);
    const req = request(job, repo ?? null, sticky);
    const r = decide(req);
    return r.ok ? { host_id: r.host_id, reason: r.reason } : stickyRefusal(req, r, job.name);
  }
  // A native resume of a BRAIN transcript stays on the brain (its session file is here).
  if (prior) return brain(null);

  if (CONFIG.placement.mode !== "auto") return brain(`CHRONOS_PLACEMENT=${CONFIG.placement.mode} keeps new runs on the brain`);
  const elig = runHostEligibility(job);
  if (!elig.ok) return brain(elig.why);
  const req = request(job, elig.repo, null);
  const r = decide(req);
  if (r.ok) return { host_id: r.host_id, reason: r.chose ? r.reason : null };
  return brain(`the brain takes it — ${r.message}`);
}

function runRepoOf(job: Pick<Job, "ticket_id" | "workspace_id" | "cwd">): Repo | undefined {
  const rid = job.ticket_id ? ticketRepoId(job.ticket_id) : null;
  if (rid) return repos.get(rid);
  if (!job.workspace_id) return undefined;
  return repos.list(job.workspace_id).find((r) => samePath(r.path, job.cwd));
}

/**
 * Where a ticket's worktree work goes — a build, a CI fix, a merge gate — decided BEFORE the worktree
 * exists, because the worktree is created on the computer chosen (tickets.ts). Sticky to wherever the
 * ticket's worktree already is; otherwise a fresh placement like any run. `goalHint` is prose the job
 * will carry that is known up front (its attachments block): a brain file there keeps it on the brain.
 */
export function placeTicketWork(
  job: Pick<Job, "name" | "backend" | "workspace_id" | "sandbox">,
  t: Pick<Ticket, "id" | "key">,
  repo: Repo,
  goalHint = "",
): RunPlacement {
  const where = ticketWorktreeHost(t, repo);
  if (where === LOCAL_HOST_ID) return brain(null);
  if (where) {
    const req = request(job, repo, { host_id: where, why: `${t.key}'s worktree is on that computer` });
    const r = decide(req);
    return r.ok ? { host_id: r.host_id, reason: r.reason } : stickyRefusal(req, r, job.name);
  }
  if (!remoteHosts().length) return brain(null);
  if (isCloudBackend(getBackend(job.backend))) return brain(null);
  if (CONFIG.placement.mode !== "auto") return brain(`CHRONOS_PLACEMENT=${CONFIG.placement.mode} keeps new runs on the brain`);
  const elig = runHostEligibility({ ...job, ticket_id: t.id, cwd: repo.path, add_dirs: null, goal: goalHint });
  if (!elig.ok) return brain(elig.why);
  const r = decide(request(job, repo, null));
  if (r.ok) return { host_id: r.host_id, reason: r.chose ? r.reason : null };
  return brain(`the brain takes it — ${r.message}`);
}
