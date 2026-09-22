/**
 * Hand a LIVE local Desk terminal off to Cursor Cloud, with all its context, so the work continues
 * on a Cursor-hosted VM instead of this Mac. Cursor can only start an agent from a GitHub ref, so a
 * handoff is: get the terminal's work onto a branch on GitHub, then launch a cloud agent from it
 * with enough context to carry on (Leo's own idea — see docs/plans/2026-09-22-cursor-cloud-backend.md
 * for the wider rollout this is PR 4 of).
 *
 * Two entry points, deliberately separate: `prepareHandoff` is pure inspection for the confirm card
 * (zero side effects, safe to call repeatedly); `executeHandoff` is the one-shot action, only ever
 * called after the operator has seen the plan and approved it.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileTimed } from "./exec.js";
import { bus } from "./bus.js";
import { CONFIG } from "./config.js";
import { db, repos, sessions, tickets } from "./store.js";
import { getBody } from "./tickets.js";
import { digestText, killSession } from "./terminal.js";
import { getBackend } from "./backends/index.js";
import { isCloudBackend, type AgentBackend } from "./backends/types.js";
import type { Job, Repo, Session, Ticket } from "./types.js";

async function git(cwd: string, args: string[], timeoutMs = 20_000): Promise<string> {
  const { stdout } = await execFileTimed("git", ["-C", cwd, ...args], { timeout: timeoutMs });
  return stdout.trim();
}

// ---------------------------------------------------------------------------------------------
// "Is this Chronos's own repo?" — Robert's first constraint. A chronos/handoff/* branch pushed to
// a CLIENT's remote is client-facing; auto-offering the handoff there would be wrong. This must
// stay a narrow allowlist, not "anything owned by leorfer23" — Leo hosts client work under his own
// GitHub account too, and owner-level matching would defeat the whole point of the check. Add a
// repo here (one line) the day Chronos grows another mirror.
const OWN_REPOS = new Set(["github.com/leorfer23/getchronos", "github.com/leorfer23/chronos"]);

/** `git@host:owner/repo(.git)` or `https://host/owner/repo(.git)` -> `https://host/owner/repo`. Null on anything else — callers fail closed on null. */
function toHttpsUrl(remote: string): string | null {
  const s = remote.trim().replace(/\.git$/i, "");
  let m = s.match(/^git@([^:]+):(.+)$/i);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = s.match(/^(?:https?|ssh):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i);
  if (m) return `https://${m[1]}/${m[2]}`;
  return null;
}

function isGitHubRemote(remote: string | null | undefined): boolean {
  if (!remote) return false;
  const https = toHttpsUrl(remote);
  return !!https && https.toLowerCase().startsWith("https://github.com/");
}

/** Fails closed: no remote, or anything this parser cannot positively identify, is never "ours". */
export function isOwnRepo(gitRemote: string | null | undefined): boolean {
  if (!gitRemote) return false;
  const https = toHttpsUrl(gitRemote);
  if (!https) return false;
  return OWN_REPOS.has(https.toLowerCase().replace(/^https:\/\//, ""));
}

// ---------------------------------------------------------------------------------------------

export interface HandoffPlan {
  sessionId: string;
  /** chronos/handoff/<session id8> — fixed, deterministic per session. */
  branch: string;
  remoteName: string | null;
  remoteUrl: string | null;
  currentBranch: string | null;
  /** Repo-relative paths that would be pushed: tracked modifications + untracked, gitignored excluded. */
  files: string[];
  warnings: string[];
  /** True when the target remote is one of Chronos's own repos — safe to auto-offer. */
  ownRepo: boolean;
  /** True when the operator must say yes explicitly before executeHandoff may proceed. */
  requiresConfirm: boolean;
  /** Set = cannot proceed at all; the reason to show, never a thrown stack trace. Other fields are best-effort when this is set. */
  refused: string | null;
}

/** repo-relative paths from `git status --porcelain` (already excludes gitignored files). */
async function pendingFiles(worktreePath: string): Promise<string[]> {
  const out = await git(worktreePath, ["status", "--porcelain"]);
  if (!out) return [];
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const body = line.slice(3);
      const arrow = body.indexOf(" -> "); // renames: "old -> new"
      const p = arrow === -1 ? body : body.slice(arrow + 4);
      return p.replace(/^"|"$/g, "");
    });
}

/**
 * Pure inspection — zero side effects. Everything the confirm card needs before Leo approves a
 * handoff, or a clear reason it cannot happen at all.
 */
export async function prepareHandoff(sessionId: string): Promise<HandoffPlan> {
  const branch = `chronos/handoff/${sessionId.slice(0, 8)}`;
  const refuse = (reason: string): HandoffPlan => ({
    sessionId,
    branch,
    remoteName: null,
    remoteUrl: null,
    currentBranch: null,
    files: [],
    warnings: [],
    ownRepo: false,
    requiresConfirm: false,
    refused: reason,
  });

  const session = sessions.get(sessionId);
  if (!session) return refuse("no such session");
  if (!session.worktree_path) return refuse("session has no claimed worktree — nothing to hand off");
  if (!fs.existsSync(session.worktree_path)) return refuse(`worktree is gone from disk: ${session.worktree_path}`);

  const repo: Repo | undefined = session.repo_id ? repos.get(session.repo_id) : undefined;
  if (!repo || !repo.git_remote) return refuse("session's repo has no GitHub remote registered");
  if (!isGitHubRemote(repo.git_remote)) return refuse(`repo remote is not on GitHub: ${repo.git_remote}`);
  // Phase 1 (see the rollout plan): GitHub + delivery=pr only.
  if (repo.delivery !== "pr") return refuse(`repo delivery is "${repo.delivery}", not "pr" — handoff needs delivery=pr`);

  let currentBranch: string | null = null;
  let files: string[] = [];
  try { currentBranch = await git(session.worktree_path, ["rev-parse", "--abbrev-ref", "HEAD"]); } catch {}
  try { files = await pendingFiles(session.worktree_path); } catch {}

  const ownRepo = isOwnRepo(repo.git_remote);
  const warnings: string[] = [];
  if (!ownRepo)
    warnings.push(
      `"${repo.git_remote}" is not a Chronos-owned remote — a chronos/handoff/* branch pushed there is client-facing. This must be confirmed explicitly, never auto-offered.`,
    );
  if (!files.length)
    warnings.push("no uncommitted changes in the worktree — the handoff branch will carry only what is already committed");

  return {
    sessionId,
    branch,
    remoteName: "origin",
    remoteUrl: repo.git_remote,
    currentBranch,
    files,
    warnings,
    ownRepo,
    requiresConfirm: !ownRepo,
    refused: null,
  };
}

// ---------------------------------------------------------------------------------------------

export interface HandoffOpts {
  /** Required (must be true) when prepareHandoff's plan.requiresConfirm is true — Leo's explicit yes for a non-Chronos remote. */
  confirmNonOwnRemote?: boolean;
  /** Test seam: defaults to getBackend("cursor-cloud"). Production callers should never set this. */
  backend?: AgentBackend;
}

export interface HandoffResult {
  ok: boolean;
  error?: string;
  branch?: string;
  pushedSha?: string;
  cloudAgentId?: string;
  cloudRunId?: string;
  cloudUrl?: string | null;
  /** The new live cloud session row replacing the ended local one. */
  newSessionId?: string;
}

function buildPrompt(session: Session, ticket: Ticket | undefined, digest: string): string {
  const parts: string[] = [
    "You are continuing a Chronos Desk terminal that was handed off to Cursor Cloud mid-work. " +
      "There is no earlier conversation to read — everything you need to continue is below.",
    `Goal: ${session.goal || session.spawn_goal || "(no goal recorded)"}`,
  ];
  if (ticket) {
    parts.push(`Ticket ${ticket.key}: ${ticket.title}`);
    const body = getBody(ticket).trim();
    if (body) parts.push(`Ticket body:\n${body}`);
  }
  parts.push(
    digest
      ? `Progress so far (local session digest — what has been done):\n${digest}`
      : "No local progress digest is available — treat this as an early-stage handoff.",
  );
  parts.push(
    "Continue the work above to completion. If what remains is unclear from the digest, use the ticket's own definition of done.",
  );
  return parts.join("\n\n");
}

function syntheticJob(session: Session, goal: string, cwd: string): Job {
  const ts = new Date().toISOString();
  return {
    id: randomUUID(),
    name: `handoff:${session.id.slice(0, 8)}`,
    description: "Cursor Cloud handoff of a live Desk terminal",
    goal,
    append_system: null,
    profile: CONFIG.defaultProfile,
    workspace_id: session.workspace_id,
    ticket_id: session.ticket_id,
    backend: "cursor-cloud",
    cwd,
    add_dirs: null,
    model: session.model,
    allowed_tools: null,
    disallowed_tools: null,
    trigger_type: "manual",
    cron_expr: null,
    run_at: null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    max_budget_usd: null,
    timeout_sec: CONFIG.defaultTimeoutSec,
    retry_max: 0,
    retry_backoff_sec: 0,
    verify: 0,
    sandbox: "off",
    on_success: null,
    on_failure: null,
    notify: null,
    enabled: 1,
    created_at: ts,
    updated_at: ts,
  };
}

// Temporary — replaced by sessions.setCloud (PR3) at merge; the lead owns that swap.
function setCloudIds(id: string, c: { cloud_agent_id: string; cloud_run_id: string; cloud_url: string | null }) {
  db.prepare("UPDATE sessions SET cloud_agent_id=?, cloud_run_id=?, cloud_url=? WHERE id=?").run(c.cloud_agent_id, c.cloud_run_id, c.cloud_url, id);
}

/**
 * Only ever called after the operator confirmed the plan from `prepareHandoff`.
 *
 * Order matters throughout: commit -> push (the one outward-facing, must-not-fail-silently step) ->
 * build the cloud prompt -> launch (guarded, fails closed) -> persist the new cloud session BEFORE
 * ending the old one, so the Desk never has a moment with neither row live -> end the local terminal
 * -> keep the worktree.
 *
 * The new session keeps the old one's `ticket_id` on purpose, and not only for continuity: ending a
 * terminal fires terminal.ts's own worktree cleanup when NO live session remains on that ticket —
 * carrying `ticket_id` forward means the new cloud row keeps that check false, so the worktree this
 * handoff just pushed is never swept out from under it. See CLAUDE.md workflow rules.
 */
export async function executeHandoff(sessionId: string, opts: HandoffOpts = {}): Promise<HandoffResult> {
  const plan = await prepareHandoff(sessionId);
  if (plan.refused) return { ok: false, error: plan.refused };
  if (plan.requiresConfirm && !opts.confirmNonOwnRemote)
    return { ok: false, error: "target remote is not a Chronos-owned repo — needs an explicit confirm (confirmNonOwnRemote)" };

  const session = sessions.get(sessionId)!;
  const wt = session.worktree_path!;

  try {
    await git(wt, ["checkout", "-B", plan.branch]);
    const dirty = await git(wt, ["status", "--porcelain"]);
    if (dirty) {
      await git(wt, ["add", "-A"]);
      const msg = `chronos: handoff snapshot — session ${sessionId.slice(0, 8)}\n\nHanding off to Cursor Cloud. Goal: ${session.goal || session.spawn_goal || "(none recorded)"}`;
      await git(wt, ["commit", "-m", msg]);
    }
  } catch (e: any) {
    return { ok: false, error: `commit failed: ${String(e?.message ?? e).slice(0, 300)}` };
  }

  let pushedSha: string;
  try {
    pushedSha = await git(wt, ["rev-parse", "HEAD"]);
    // Force: this branch is exclusively owned by the handoff mechanism (fresh per session, never
    // shared history) — a retried handoff after a failed launch must be able to re-push it.
    await git(wt, ["push", "--force", "origin", plan.branch], 30_000);
  } catch (e: any) {
    return { ok: false, error: `push failed — refusing to launch from a stale ref: ${String(e?.message ?? e).slice(0, 300)}` };
  }
  // The worktree now lives on the handoff branch — keep the session row's own record in sync so a
  // later worktree lookup (removeWorktreeAs, listAllWorktrees) still recognises it as claimed.
  try { sessions.setWorktree(sessionId, { path: wt, branch: plan.branch }); } catch {}

  const ticket = session.ticket_id ? tickets.get(session.ticket_id) : undefined;
  const digest = digestText(sessionId, "");
  const promptText = buildPrompt(session, ticket, digest);
  const job = syntheticJob(session, promptText, wt);

  const backend = opts.backend ?? getBackend("cursor-cloud");
  if (!isCloudBackend(backend))
    return {
      ok: false,
      error: `cursor-cloud backend is not available — branch ${plan.branch} was pushed but no cloud agent was launched`,
      branch: plan.branch,
      pushedSha,
    };

  let launch;
  try {
    launch = await backend.launch({
      job,
      runId: randomUUID(),
      context: null,
      idempotencyKey: `handoff:${sessionId}`,
      repos: [{ url: plan.remoteUrl!, startingRef: plan.branch }],
      autoCreatePr: true,
      name: ticket?.key || session.title || `chronos-handoff-${sessionId.slice(0, 8)}`,
    });
  } catch (e: any) {
    return { ok: false, error: `cloud launch failed: ${String(e?.message ?? e).slice(0, 300)}`, branch: plan.branch, pushedSha };
  }

  // The new live cloud row must exist before the old one ends — never a moment with neither on the Desk.
  const newSession = sessions.create({
    ticket_id: session.ticket_id,
    workspace_id: session.workspace_id,
    repo_id: session.repo_id,
    title: session.title || session.goal || "Cloud handoff",
    goal: session.goal,
    goal_kind: session.goal_kind,
    goal_source: "agent",
    created_by: "handoff",
    role: session.role,
    backend: "cursor-cloud",
    cwd: wt,
  });
  setCloudIds(newSession.id, { cloud_agent_id: launch.agentId, cloud_run_id: launch.runId, cloud_url: launch.url });
  bus.publish({ topic: "session.started", session_id: newSession.id });

  killSession(
    sessionId,
    `handed off to Cursor Cloud — continues as session ${newSession.id.slice(0, 8)}${launch.url ? ` (${launch.url})` : ""}`,
  );
  bus.publish({ topic: "session.ended", session_id: sessionId });

  return {
    ok: true,
    branch: plan.branch,
    pushedSha,
    cloudAgentId: launch.agentId,
    cloudRunId: launch.runId,
    cloudUrl: launch.url,
    newSessionId: newSession.id,
  };
}
