/**
 * Hand a LIVE local Desk terminal off to Cursor Cloud, with all its context, so the work continues
 * on a Cursor-hosted VM instead of this Mac. Cursor can only start an agent from a GitHub ref, so a
 * handoff is: get the terminal's work onto a branch on GitHub, then dispatch a cloud run from it
 * with enough context to carry on (Leo's own idea — see docs/plans/2026-09-22-cursor-cloud-backend.md
 * for the wider rollout this is PR 4 of).
 *
 * Two entry points, deliberately separate: `prepareHandoff` is pure inspection for the confirm card
 * (zero side effects, safe to call repeatedly); `executeHandoff` is the one-shot action, only ever
 * called after the operator has seen the plan and approved it.
 *
 * This module does NOT launch a cloud agent itself. It persists a job and calls the real `dispatch()`
 * — the same choke point every other run goes through — so the run lands in `runs` where the
 * reconciler (PR2's `executeCloud`) can find it and finish it even if this Mac is off when the cloud
 * agent completes. A second, private launch path here would drift from PR2's and leave the handoff
 * path unreconciled: a run that exists only as a `sessions` row with no `runs` row is invisible to
 * the reconciler, which scans `runs`, not `sessions`.
 */
import fs from "node:fs";
import { execFileTimed } from "./exec.js";
import { bus } from "./bus.js";
import { jobs, repos, runs, sessions, tickets } from "./store.js";
import { dispatch } from "./dispatcher.js";
import { isGitHubRemote } from "./backends/cursor-cloud.js";
import { getBody } from "./tickets.js";
import { digestText, killSession } from "./terminal.js";
import type { Repo, Session, Ticket } from "./types.js";

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

  // Resolved via the TICKET's repo, not session.repo_id: dispatcher.ts's validateSpawnTarget gate
  // for cursor-cloud can only resolve a job's repo through job.ticket_id -> ticket.repo_id (jobs
  // carry no repo_id of their own) — so that is the repo that actually governs whether dispatch()
  // will accept this handoff, and refusing here on the same resolution avoids discovering the gap
  // only after the local terminal has already been ended.
  if (!session.ticket_id)
    return refuse("session has no ticket — cursor-cloud can only resolve its target repo through a ticket in Phase 1");
  const ticket = tickets.get(session.ticket_id);
  if (!ticket) return refuse("session's ticket no longer exists");
  const repo: Repo | undefined = ticket.repo_id ? repos.get(ticket.repo_id) : undefined;
  if (!repo || !repo.git_remote) return refuse("ticket's repo has no GitHub remote registered");
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
  if (session.repo_id && session.repo_id !== ticket.repo_id)
    warnings.push("session's own repo differs from its ticket's repo — the ticket's repo is what cursor-cloud will actually resolve");

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
  /** Test seam: the registered backend name to dispatch under. Defaults to "cursor-cloud"; production callers should never set this. */
  backendName?: string;
}

export interface HandoffResult {
  ok: boolean;
  error?: string;
  branch?: string;
  pushedSha?: string;
  jobId?: string;
  runId?: string;
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

/**
 * Only ever called after the operator confirmed the plan from `prepareHandoff`.
 *
 * Order, and why it is NOT the order in the plan's numbered list:
 *
 * 1. Create the new (placeholder) live cloud session FIRST. Two reasons, not one: it is what makes
 *    "a live card on the Desk replacing the ended one" true (the new row exists before the old one
 *    ends), and — less obviously — it is what stops terminal.ts's own onExit handler from reclaiming
 *    the worktree out from under us. That handler removes a ticket's worktree once NO live session
 *    remains on that ticket; the new row keeps that check false for as long as it stays live. See
 *    CLAUDE.md's worktree-worktree discipline.
 * 2. End the local terminal SECOND, before any git write. A CLI mid-write gives a torn snapshot —
 *    committing and pushing a live agent's half-written tree would ship broken work to a VM. A dead
 *    terminal with intact work beats a live one whose half-written files just shipped out.
 * 3. Commit -> push (plain, never --force: this is an automated path, and the local branch is
 *    always the remote's descendant on a legitimate retry, so a plain push already fast-forwards).
 *    A failed push stops here — never dispatch from a ref that was never actually pushed.
 * 4. Persist a job and go through the real `dispatch()` — the same choke point every other run
 *    uses — instead of launching a cloud agent directly. The reconciler (PR2) scans `runs`, not
 *    `sessions`; a run that only exists as a `sessions` row with cloud ids is invisible to it and
 *    never gets finalised if this Mac is off when the cloud agent finishes.
 *
 * On any failure after step 1, the placeholder session is ended too (with a reason) rather than
 * left "live" pointing at nothing — the Desk must never show a card for a cloud agent that was
 * never actually launched.
 */
export async function executeHandoff(sessionId: string, opts: HandoffOpts = {}): Promise<HandoffResult> {
  const plan = await prepareHandoff(sessionId);
  if (plan.refused) return { ok: false, error: plan.refused };
  if (plan.requiresConfirm && !opts.confirmNonOwnRemote)
    return { ok: false, error: "target remote is not a Chronos-owned repo — needs an explicit confirm (confirmNonOwnRemote)" };

  const session = sessions.get(sessionId)!;
  const wt = session.worktree_path!;
  const backendName = opts.backendName ?? "cursor-cloud";

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
    backend: backendName,
    cwd: wt,
  });
  bus.publish({ topic: "session.started", session_id: newSession.id });

  const fail = (error: string, extra: Partial<HandoffResult> = {}): HandoffResult => {
    try { sessions.end(newSession.id, `handoff did not complete: ${error}`); } catch {}
    try { bus.publish({ topic: "session.ended", session_id: newSession.id }); } catch {}
    return { ok: false, error, newSessionId: newSession.id, ...extra };
  };

  killSession(
    sessionId,
    `handed off to Cursor Cloud — see session ${newSession.id.slice(0, 8)} for the outcome`,
  );
  bus.publish({ topic: "session.ended", session_id: sessionId });

  try {
    await git(wt, ["checkout", "-B", plan.branch]);
    const dirty = await git(wt, ["status", "--porcelain"]);
    if (dirty) {
      await git(wt, ["add", "-A"]);
      const msg = `chronos: handoff snapshot — session ${sessionId.slice(0, 8)}\n\nHanding off to Cursor Cloud. Goal: ${session.goal || session.spawn_goal || "(none recorded)"}`;
      await git(wt, ["commit", "-m", msg]);
    }
  } catch (e: any) {
    return fail(`commit failed: ${String(e?.message ?? e).slice(0, 300)}`, { branch: plan.branch });
  }

  let pushedSha: string;
  try {
    pushedSha = await git(wt, ["rev-parse", "HEAD"]);
    // Plain push, deliberately no --force: this is an automated path, and a legitimate retry's
    // local branch is always a descendant of what is already on the remote, so a plain push
    // fast-forwards on its own. A genuine non-fast-forward here means something else touched this
    // branch — that is the operator's call, not the mechanism's.
    await git(wt, ["push", "origin", plan.branch], 30_000);
  } catch (e: any) {
    return fail(`push of branch "${plan.branch}" failed — refusing to dispatch from a stale ref: ${String(e?.message ?? e).slice(0, 300)}`, { branch: plan.branch });
  }
  // The worktree now lives on the handoff branch — keep the old session's own record in sync so a
  // later worktree lookup (removeWorktreeAs, listAllWorktrees) still recognises it as claimed.
  try { sessions.setWorktree(sessionId, { path: wt, branch: plan.branch }); } catch {}

  const ticket = session.ticket_id ? tickets.get(session.ticket_id) : undefined;
  const digest = digestText(sessionId, "");
  const promptText = buildPrompt(session, ticket, digest);

  const job = jobs.create({
    name: `handoff:${sessionId.slice(0, 8)}`,
    description: "Cursor Cloud handoff of a live Desk terminal",
    goal: promptText,
    workspace_id: session.workspace_id,
    ticket_id: session.ticket_id,
    backend: backendName,
    cwd: wt,
    model: session.model,
    trigger_type: "manual",
    retry_max: 0,
  });

  const res = dispatch(job.id, `handoff:${sessionId.slice(0, 8)}`);
  if ("error" in res) return fail(res.error, { branch: plan.branch, pushedSha, jobId: job.id });

  // `runs.session_id` is normally the local CLI's own transcript id (see runner.ts); a cloud run has
  // no local transcript, so this field is repurposed to link the run back to the Desk session that
  // displays it — the reconciler and the Desk card both key off it once PR2/3 land.
  try { runs.patch(res.run_id, { session_id: newSession.id }); } catch {}

  return { ok: true, branch: plan.branch, pushedSha, jobId: job.id, runId: res.run_id, newSessionId: newSession.id };
}
