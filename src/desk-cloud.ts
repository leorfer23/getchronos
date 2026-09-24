import { backendAllowed, getBackend, hasBackend, workspaceBackends } from "./backends/index.js";
import { isGitHubRemote } from "./backends/cursor-cloud.js";
import { isCloudBackend } from "./backends/types.js";
import { dispatch } from "./dispatcher.js";
import { jobs, repos, runs, sessions, tickets, workspaces, workspaceVars } from "./store.js";
import type { NewSession, Repo, Run, Session } from "./types.js";

/** True when `name` is (or would be) a cloud-kind backend. `cursor-cloud` is named explicitly, not
 *  just detected via isCloudBackend(getBackend(name)), so that a future rename/removal of its
 *  registry entry still routes here and hits hasBackend()'s fail-closed check in openCloudSession()
 *  instead of silently falling through to a local pty under a "cursor-cloud" label. */
export function wantsCloudBackend(name: string | null | undefined): boolean {
  return name === "cursor-cloud" || isCloudBackend(getBackend(name));
}

/** Exported for direct unit testing — repo resolution needs no registered backend or dispatch,
 *  unlike the rest of openCloudSession. */
export function resolveCloudRepo(opts: { workspace_id?: string | null; repo_id?: string | null; ticket_id?: string | null; cwd?: string | null }): Repo {
  if (!opts.workspace_id) throw new Error("a cloud terminal needs a workspace");
  let repo: Repo | undefined;
  if (opts.repo_id) repo = repos.get(opts.repo_id);
  else if (opts.ticket_id) {
    const t = tickets.get(opts.ticket_id);
    if (t?.repo_id) repo = repos.get(t.repo_id);
  } else if (opts.cwd) {
    repo = repos.list(opts.workspace_id).find((r) => r.path === opts.cwd);
  }
  if (!repo) throw new Error("cursor-cloud needs a repo — pick one in Where");
  // Same rule validateSpawnTarget enforces at dispatch (backends/cursor-cloud.ts isGitHubRemote) —
  // reused rather than re-checked, so a GitLab/Bitbucket remote or an ssh-form GitHub one is judged
  // identically here and there instead of drifting.
  if (!isGitHubRemote(repo.git_remote)) throw new Error(`${repo.name} has no GitHub remote — cursor-cloud needs one`);
  if (repo.delivery !== "pr") throw new Error(`${repo.name} delivers by commit — cursor-cloud only supports delivery=pr repos`);
  return repo;
}

/**
 * Opens a Desk "terminal" that is really a cloud-hosted agent — no pty, no local process. Entry
 * point 1 of the cursor-cloud rollout (see docs/plans/2026-09-22-cursor-cloud-backend.md): launch,
 * sleep and reconcile live in the runner + reconciler via the SAME jobs/runs dispatch every ticket
 * build uses, so a manually-opened cloud terminal IS a dispatched run — cost, verifier, review
 * queueing and merge-gate see it exactly as they would a local one. This module only opens the
 * door: create the session row, a one-off job, dispatch it, and link session <-> run.
 */
export async function openCloudSession(
  opts: NewSession & { description?: string | null; goal?: string | null },
): Promise<Session> {
  if (opts.role === "lead") throw new Error("a cloud terminal can't drive workers — no mc on the VM (Phase 1)");
  // Same client boundary openSession() enforces for a local pty (terminal.ts): cursor has no
  // per-workspace config dir, so a workspace that never allow-listed it must not reach it here
  // either. Checked before hasBackend() so the client wall holds even before cursor-cloud's own
  // module is registered.
  if (opts.workspace_id) {
    const ws0 = workspaces.get(opts.workspace_id);
    if (ws0 && !backendAllowed(ws0.backends, opts.backend))
      throw new Error(`${ws0.name} may not run \`${opts.backend}\` — allowed here: ${workspaceBackends(ws0.backends).join(", ")}`);
  }
  if (!opts.backend || !hasBackend(opts.backend)) throw new Error("cursor-cloud backend not available");
  const repo = resolveCloudRepo(opts);
  const goal = opts.description?.trim() || opts.goal?.trim() || "Continue the work described on the ticket.";
  const job = jobs.create({
    name: (opts.title || opts.goal || "cloud terminal").slice(0, 100),
    goal,
    workspace_id: opts.workspace_id ?? null,
    ticket_id: opts.ticket_id ?? null,
    backend: opts.backend,
    model: opts.model ?? undefined,
    cwd: repo.path,
    trigger_type: "manual",
  });
  const row = sessions.create({ ...opts, backend: opts.backend, cwd: repo.path, repo_id: repo.id });
  const disp = dispatch(job.id, "desk:cloud");
  if ("error" in disp) {
    sessions.end(row.id, `cloud launch failed: ${disp.error}`);
    jobs.remove(job.id);
    throw new Error(disp.error);
  }
  // Informational link only — not read by execute()'s synchronous prologue (CLAUDE.md gotcha #1
  // is about resume_session/context, which ride INTO dispatch above), so patching it after dispatch
  // returns is safe here.
  runs.patch(disp.run_id, { session_id: row.id });
  return sessions.get(row.id)!;
}

/**
 * A follow-up on a live cloud session's composer: a new dispatch of the SAME job, threaded as a
 * resume (dispatch's 5th arg) — the same mechanism answerAsk uses to resume a paused run
 * (src/asks.ts resumeAskingRun). The runner reads resume_session and calls the backend's
 * followup() on the pinned agent instead of launching a fresh one, per the base plan's mapping
 * (`mc tell` → `POST /v1/agents/{id}/runs`).
 */
export function followUpCloudSession(session: Session, text: string): { run_id: string; status: string } | { error: string } {
  const run = runs.bySession(session.id);
  if (!run) return { error: "no cloud run on this terminal yet" };
  const context = `## Operator message\n${text}\nTreat this as a directive; it may adjust or override the task.`;
  const r = dispatch(run.job_id, "desk:cloud:followup", 0, context, run.session_id ?? session.id);
  if (!("error" in r)) runs.patch(r.run_id, { session_id: session.id });
  return r;
}

/** The run this cloud session is currently tracking, or null for a local (pty) session. */
export function cloudRunFor(session: Pick<Session, "cloud_agent_id" | "id">): Run | null {
  if (!session.cloud_agent_id) return null;
  return runs.bySession(session.id) ?? null;
}

/** Desk "state" bucket for a cloud session, derived from its run row — no pty, so no byte-level
 *  activity to read (act.quiet/act.last_out don't apply). Mirrors the buckets /desk already uses. */
export function cloudSessionState(run: Run | null): "working" | "blocked" | "done" {
  if (!run) return "working"; // launched, run row not visible yet (race with dispatch's own read)
  switch (run.status) {
    case "success":
      return "done";
    case "failed":
    case "timeout":
    case "killed":
    case "blocked":
    case "rate_limited":
    case "interrupted":
      return "blocked";
    default: // queued | running | paused
      return "working";
  }
}

type CursorRepo = { fullName?: string; url?: string; owner?: string; name?: string };
const REPO_CACHE_MS = 10 * 60_000; // GET /v1/repositories allows 1 req/min — the picker would
// rate-limit itself in seconds without a cache this wide.
// Exported so tests can reset it between cases — the module is a singleton across a test file.
export const repoCache = new Map<string, { at: number; repos: CursorRepo[] | null; error: string | null }>();

/**
 * Repos the Cursor GitHub App can see for this workspace (GET /v1/repositories), cached 10 min.
 * `repos: null` (with no `error`) means "nothing to check" — no CURSOR_API_KEY configured, which is
 * the ordinary state for a workspace that never turned cloud on, not a failure worth surfacing.
 */
export async function cloudVisibleRepos(
  workspaceId: string,
  // Injectable for tests (CLAUDE.md gotcha #2: never hit the real network) — production callers
  // never pass this, so it always defaults to the real fetch.
  fetchImpl: typeof fetch = fetch,
): Promise<{ repos: CursorRepo[] | null; error: string | null }> {
  const hit = repoCache.get(workspaceId);
  if (hit && Date.now() - hit.at < REPO_CACHE_MS) return { repos: hit.repos, error: hit.error };
  const key = workspaceVars.active(workspaceId).CURSOR_API_KEY;
  if (!key) {
    const out = { repos: null, error: null };
    repoCache.set(workspaceId, { at: Date.now(), ...out });
    return out;
  }
  try {
    const r = await fetchImpl("https://api.cursor.com/v1/repositories", { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) throw new Error(`cursor api ${r.status}`);
    const body: any = await r.json();
    // Cursor answers {items: [{url}]} (live-verified 2026-09-24); `repositories` kept for older shapes.
    const list: CursorRepo[] = Array.isArray(body?.items) ? body.items : Array.isArray(body?.repositories) ? body.repositories : Array.isArray(body) ? body : [];
    repoCache.set(workspaceId, { at: Date.now(), repos: list, error: null });
    return { repos: list, error: null };
  } catch (e: any) {
    const out = { repos: null, error: String(e?.message ?? e) };
    repoCache.set(workspaceId, { at: Date.now(), ...out });
    return out;
  }
}

/**
 * Whether Cursor's GitHub App can see this repo's remote — the picker's disable/tooltip gate.
 * `list: null` (no key, or the lookup failed) reads as NOT visible: Phase 1 fails closed rather
 * than optimistically offering a launch that will 400 at dispatch time (see resolveCloudRepo).
 */
export function repoVisibleTo(list: CursorRepo[] | null, gitRemote: string | null): boolean {
  if (!list || !gitRemote) return false;
  const norm = (u: string) => u.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").toLowerCase();
  const want = norm(gitRemote);
  return list.some((r) => (r.fullName && norm(r.fullName) === want) || (r.url && norm(r.url) === want));
}
