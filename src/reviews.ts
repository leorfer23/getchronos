import path from "node:path";
import { bus } from "./bus.js";
import { CONFIG } from "./config.js";
import { db, reviews, runs, jobs, tickets, workspaces, repos } from "./store.js";
import { updateTicket, appendNote, ticketBranch, formatDoneCriteria, traceDispatch, createTicket } from "./tickets.js";
import { formatAttachmentsBlock } from "./attachments.js";
import { childEnv } from "./child-env.js";
import { LOCAL_HOST_ID } from "./hosts/index.js";
import { checkoutOn, execIn, gateRunners, hostName, isRemoteDir, isSharedCheckout, workDirExists, workDirOf, type WorkDir } from "./hosts/workdir.js";
import { dispatch } from "./dispatcher.js";
import { maybeDistillSkill } from "./distill.js";
import { captureLearnings } from "./notes.js";
import { notify, tref } from "./telegram/api.js";
import { captureFeedback, lessonsBlock } from "./lessons.js";
import {
  REVIEW_LENSES,
  addVote,
  isPanelReview,
  parsePanel,
  resolvePanel,
  wantsReviewPanel,
  type Lens,
  type PanelState,
} from "./panels.js";
import {
  diffStats,
  formatGateBlock,
  gatesPassed,
  mergeGate,
  needsHumanApproval,
  parseGateResults,
  riskFor,
  riskSummary,
} from "./gates.js";
import type { GateResult, Job, Review, RiskTier, Ticket } from "./types.js";

const DIFF_CAP = 20000;

/**
 * Where this build's branch left the default branch, or null when it can't be resolved.
 *
 * Deliberately no `fetch`: mergeGate already pays that cost, and a stale `origin/<branch>` only
 * moves the base further back, which shows MORE of the change rather than less. A detached HEAD,
 * a missing branch or a non-repo returns null and the caller falls back to the working tree.
 */
async function mergeBaseRef(wd: WorkDir, defaultBranch: string, workspaceId?: string | null): Promise<string | null> {
  for (const ref of [`origin/${defaultBranch}`, defaultBranch]) {
    try {
      const { stdout } = await execIn(wd, "git", ["-C", wd.cwd, "merge-base", ref, "HEAD"], { workspaceId });
      if (stdout.trim()) return stdout.trim();
    } catch {}
  }
  return null;
}

/**
 * Everything this build changed, relative to where its branch left the default branch.
 *
 * This used to be a plain `git diff` — the unstaged working tree — on the assumption that the build
 * agent leaves its work for Chronos to commit (which createForRun does, a few lines below). Plenty
 * of agents commit as they go instead: git is in their toolbelt and the goal tells them they are
 * alone on their own branch in their own worktree. For those the working tree is already clean by
 * review time, and the capture came back empty.
 *
 * That failed silently and in the worst direction. The reviewer was handed "(no diff captured)"
 * instead of the change, and `riskFor([])` scored it `low` — not "unknown", but a confident low —
 * because there were no paths to classify. Ten of the first twelve reviews on this machine were
 * stored exactly that way, every one of them `low`, which quietly disabled the entire risk tier that
 * decides what may ship without the operator.
 *
 * Diffing from the merge-base captures the branch's commits AND anything still uncommitted, so it no
 * longer matters who commits, or when.
 */
export async function captureDiff(where: string | WorkDir, defaultBranch?: string | null, workspaceId?: string | null): Promise<string | null> {
  // A path is the brain's; a WorkDir may be a worktree on another computer (HOSTS.md phase 5).
  const wd: WorkDir = typeof where === "string" ? { host_id: LOCAL_HOST_ID, cwd: where } : where;
  const cwd = wd.cwd;
  try {
    try {
      await execIn(wd, "git", ["-C", cwd, "add", "-A", "-N"], { workspaceId });
    } catch {}
    const base = defaultBranch ? await mergeBaseRef(wd, defaultBranch, workspaceId) : null;
    // Only the head survives the cap below, so a host is asked to keep just the head (a bounded frame).
    const { stdout: out } = await execIn(wd, "git", ["-C", cwd, "diff", ...(base ? [base] : [])], {
      workspaceId, maxBuffer: isRemoteDir(wd) ? 4 * DIFF_CAP : 50 * 1024 * 1024, keep: "head",
    });
    if (!out.trim()) return null;
    return out.length > DIFF_CAP ? out.slice(0, DIFF_CAP) + "\n…(truncated)" : out;
  } catch {
    return null; // not a git repo / git unavailable
  }
}

// Called when a ticket-bound run ends: success → queue a review; failure → block the ticket.
// `gates` is the pre-review evidence run (runner.ts). Red gates never reach a reviewer: they are
// filed as changes-requested so the build agent reworks against the actual command output, and the
// existing reviewMaxIterations cap counts the attempt like any other rework cycle.
export async function createForRun(job: Job, runId: string, status: string, gates: GateResult[] | null = null): Promise<void> {
  if (!job.ticket_id) return;
  if (status === "success") {
    const t = tickets.get(job.ticket_id);
    // A settled ticket (PR shipping/landed) must not be yanked back to `review` by a late run end —
    // that was the PER-4 / PER-13 loop amplifier once merge-gate mistakenly called createForRun.
    // Do NOT refuse on pr_state=closed: markPrClosed sets closed+ready so autoplan can rebuild, and
    // that rebuild's createForRun must still file a review (pr_state stays "closed" until re-ship).
    if (t && (t.status === "done" || t.status === "shipping" || t.pr_state === "merged")) {
      return;
    }
    // delivery=pr ships from the mc/<key> branch at approve time. Commit the build's work onto
    // that branch NOW, while it exists — else a later worktree reset/checkout strands it and the
    // PR ships empty (the exact PER-7 failure). Diff string is already captured for the panel.
    const repo = t?.repo_id ? repos.get(t.repo_id) : undefined;
    // The build's directory on the computer it ran on (HOSTS.md phase 5): every git call below goes
    // there — a worktree on a host is committed, diffed and merge-checked by that host.
    const wd = workDirOf(job, runs.get(runId));
    const wsId = job.workspace_id;
    // Resolved before the commit below, but measured from the merge-base, so it reads the same
    // either way: whether the agent committed its own work or left it for us.
    const diff = await captureDiff(wd, repo?.default_branch, wsId);
    // Only ever `git add -A` + commit inside an ISOLATED worktree — never the repo's shared checkout.
    // In the shared checkout, add -A sweeps unrelated uncommitted work (a human's edits, other runs'
    // files) onto the checked-out branch. A build with no worktree lands in repo.path; skip it here
    // (delivery.ts / a rebuilt worktree carries the work) rather than corrupt the main tree. "Shared"
    // is judged against THAT computer's checkout of the repo.
    const inWorktree = !!repo?.path && !!wd.cwd && !isSharedCheckout(wd, repo);
    if (inWorktree) {
      try {
        await execIn(wd, "git", ["-C", wd.cwd, "add", "-A"], { workspaceId: wsId });
        await execIn(wd, "git", ["-C", wd.cwd, "commit", "-m", `${t!.key}: ${t!.title}`], { workspaceId: wsId });
      } catch { /* nothing to commit — branch already carries the work */ }
    }
    // Built-in mergeability gate, run after the commit above so HEAD carries the build's work.
    // Repo gates only prove the branch is good on its own; this proves it can still land on a main
    // that moved while the ticket was being worked. Appended to the same GateResult[] so a conflict
    // takes the identical red-gate path below — rework with the failure output, iteration cap, UI.
    const allGates: GateResult[] = gates ? [...gates] : [];
    if (inWorktree && repo?.default_branch) {
      const mg = await mergeGate(wd.cwd, repo.default_branch, childEnv(t ? workspaces.get(t.workspace_id) : undefined), undefined, gateRunners(wd, wsId)?.cmd);
      if (mg) allGates.push(mg);
    }
    gates = allGates.length ? allGates : null;

    // If the build agent already ran `mc review --report` (→ ensureReviewForTicket made a pending
    // review + stored the handoff on the ticket), reuse it — just refresh the diff — instead of
    // opening a second review row for the same build.
    const { files, lines } = diffStats(diff);
    const risk = riskFor(files, repo, lines);
    const gateJson = gates?.length ? JSON.stringify(gates) : null;

    const pending = reviews.byTicket(job.ticket_id).find((r) => r.state === "pending");
    let review: Review;
    if (pending) {
      reviews.setDiff(pending.id, diff);
      review = reviews.setEvidence(pending.id, gateJson, risk) ?? pending;
    } else {
      review = reviews.create({ run_id: runId, ticket_id: job.ticket_id, diff_ref: diff, gate_json: gateJson, risk });
    }

    // Red gate → straight back to the builder with the failing output, no reviewer spent on code we
    // already know doesn't build. requestChanges moves the ticket to `ready`, which pumpBuilds picks
    // up as a rework and autoplan's cap counts toward escalation.
    if (gates?.length && !gatesPassed(gates)) {
      const note =
        `Evidence gate failed — fix these and the build will be re-reviewed automatically.\n\n` +
        formatGateBlock(gates, { failuresOnly: true });
      requestChanges(review.id, note, "ai:gate");
      await notify(
        `❌ ${tref(t) || "<b>ticket</b>"} gate failed: ${gates.filter((g) => !g.ok).map((g) => g.name).join(", ")} — reworking.`,
      ).catch(() => {});
      return;
    }

    updateTicket(job.ticket_id, { status: "review" });
    // Always publish — even when reusing a pending review from ensureReviewForTicket. That path
    // already published once (and may have auto-dispatched); dispatchReviewRaw's hasActiveJobNamed
    // guard drops the duplicate spawn. Republishing still covers the case where the first dispatch
    // never started (auto_review off, budget, skip) and a reviewer is still needed.
    bus.publish({
      topic: "review.created", review_id: review.id, run_id: runId,
      ticket_id: job.ticket_id, ticket_key: t?.key, workspace_id: t?.workspace_id,
    });
  } else {
    updateTicket(job.ticket_id, { status: "blocked" });
  }
}

// Any path that moves a ticket to "review" without a run ending (mc CLI, UI status change,
// interactive-session work) lands here: make sure a pending review exists so the ticket page
// shows Approve / Request changes / Merge and the review notification fires.
export async function ensureReviewForTicket(ticketId: string): Promise<Review | undefined> {
  const existing = reviews.byTicket(ticketId).find((r) => r.state === "pending");
  if (existing) return existing;
  const t = tickets.get(ticketId);
  if (!t) return undefined;
  const run = runs.latestForTicket(ticketId);
  // ponytail: reviews.run_id is NOT NULL — a ticket with zero runs can't grow a review row;
  // relax the schema if interactive-only tickets (no plan/build run) ever need the approve UI.
  if (!run) return undefined;
  const job = jobs.get(run.job_id);
  const repo = t.repo_id ? repos.get(t.repo_id) : undefined;
  const wd: WorkDir | null = job?.cwd ? workDirOf(job, run) : repo?.path ? { host_id: LOCAL_HOST_ID, cwd: repo.path } : null;
  const diff = wd ? await captureDiff(wd, null, t.workspace_id) : null;
  const review = reviews.create({ run_id: run.id, ticket_id: ticketId, diff_ref: diff });
  bus.publish({
    topic: "review.created", review_id: review.id, run_id: run.id,
    ticket_id: ticketId, ticket_key: t.key, workspace_id: t.workspace_id,
  });
  return review;
}

// Dispatch a read-only AI reviewer to QA a finished build against the ticket plan + acceptance,
// then deliver a verdict via `mc verdict <id> approve|changes "..."`.
// Wrapped per call, not once at module load: reviews ⇄ tickets is an import cycle, so a top-level
// call into tickets.ts here runs while that module is still half-initialized.
export function dispatchReview(reviewId: string, opts: { lens?: Lens } = {}): { job_id: string; run_id?: string; status?: string } {
  return traceDispatch("AI review", dispatchReviewRaw, () => reviews.get(reviewId)?.ticket_id ?? null)(
    reviewId,
    opts,
  );
}

function dispatchReviewRaw(reviewId: string, opts: { lens?: Lens } = {}): { job_id: string; run_id?: string; status?: string } {
  const r = reviews.get(reviewId);
  if (!r) throw new Error("review not found");
  if (!r.ticket_id) throw new Error("review has no ticket");
  const t = tickets.get(r.ticket_id);
  if (!t) throw new Error("ticket not found");
  const ws = workspaces.get(t.workspace_id);
  if (!ws) throw new Error("workspace not found");
  const buildRun = runs.get(r.run_id);
  const buildJob = buildRun ? jobs.get(buildRun.job_id) : undefined;
  const repo = t.repo_id ? repos.get(t.repo_id) : undefined;
  // The reviewer reads the build's worktree, so it runs where that worktree is (HOSTS.md phase 5):
  // a build that ran on a host pins its reviewer there, in the directory the host reported.
  const buildWd = buildJob ? workDirOf(buildJob, buildRun) : null;
  const cwd = buildWd?.cwd || repo?.path;
  const reviewHost = buildWd && isRemoteDir(buildWd) ? buildWd.host_id : null;
  if (!cwd) throw new Error("no repo to review in");
  const lens = opts.lens;
  // Job name is the concurrent-dispatch identity. ensureReviewForTicket (mc review --report) and
  // createForRun (run end) both publish review.created for the SAME pending review — without this
  // guard each event spawns a full reviewer (PER-31 / PER-30: two success runs 38s apart). Exact
  // name (not hasActiveJob prefix) so a panel's review:KEY:spec does not block :correctness/:blast-radius.
  const jobName = lens ? `review:${t.key}:${lens.id}` : `review:${t.key}`;
  if (runs.hasActiveJobNamed(t.id, jobName)) {
    return { job_id: "", status: "skipped: already running" };
  }
  const relPath = repo ? path.relative(repo.path, t.file_path) : t.file_path;
  const diff = r.diff_ref || "(no diff captured — inspect the working tree)";

  const doneBlock = formatDoneCriteria(repo);
  const attachBlock = formatAttachmentsBlock(t.id);
  const gateResults = parseGateResults(r.gate_json);
  const risk = (r.risk as RiskTier | null) ?? null;
  // What previous reviews of this repo actually caught. At review time we know which files changed,
  // so a path-scoped rule fires only for the code it is about.
  const lessons = lessonsBlock(t.workspace_id, {
    repo_id: t.repo_id,
    topic: "review",
    text: `${t.title} ${r.notes ?? ""}`,
    files: diffStats(r.diff_ref).files,
    heading: "## Check these too — things review has caught in this repo before",
  });
  // The reviewer is told what the gate already proved so it spends its judgment on what a command
  // can't check — intent, edge cases, blast radius — instead of re-litigating whether tests pass.
  const evidenceBlock = gateResults?.length
    ? `\nEvidence gates already ran in the build worktree (all green — a build with a red gate never reaches you):\n${formatGateBlock(gateResults)}\n` +
      `Don't re-run them. Judge what they cannot: correctness of intent, edge cases, regressions, blast radius.\n`
    : `\nNo evidence gates are configured for this repo — you are the only check. Verify claims about tests/builds by reading, and say so if the repo needs a gate command.\n`;
  const riskBlock = risk
    ? `\nRisk tier of this change: **${risk}** (from the paths it touches).` +
      (risk === "high"
        ? ` High-risk changes ship only with human sign-off — be explicit about what an operator should look at.\n`
        : `\n`)
    : "";
  const lensBlock = lens
    ? `\n## Your lens: ${lens.label.toUpperCase()}\n${lens.brief}\n` +
      `You are one of ${REVIEW_LENSES.length} reviewers on this change, each looking for something different. ` +
      `Stay in your lane — another reviewer is covering the others, and a verdict that wanders is a verdict ` +
      `nobody can act on. Report your verdict with \`--lens ${lens.id}\`.\n`
    : "";
  const humanGate = needsHumanApproval(repo, risk, gateResults)
    ? `\nThis change requires HUMAN approval to mark Done (repo human_gate=${repo?.human_gate ?? "always"}, ${riskSummary(risk, gateResults)}) — your approve is a recommendation; prefer ` +
      `\`mc verdict ${reviewId} changes "…"\` when anything fails the Definition of Done, and only approve if you would ship it.\n`
    : `\nYour verdict is final for this change — an approve closes the ticket and ships it (${riskSummary(risk, gateResults)}). Review it like nobody is behind you, because nobody is.\n`;
  const handoffBlock = t.report?.trim()
    ? `\nThe build agent's handoff (its own account — verify it against the diff, don't take it on faith):\n${t.report.trim()}\n\n`
    : "";
  const goal =
    `QA REVIEW (read-only — do NOT modify code). A build agent just finished ticket ${t.key} "${t.title}".\n` +
    `Read the ticket at ${relPath} — especially the "## Plan" and acceptance criteria.\n\n` +
    handoffBlock +
    `Here is the working-tree diff under review:\n\`\`\`diff\n${diff}\n\`\`\`\n\n` +
    `Verify rigorously: does the change fully meet the acceptance criteria, the repo Definition of Done, and the plan? ` +
    `Check correctness, edge cases, regressions, error handling, leftover debug/TODOs, and whether tests were added/updated. ` +
    `If screenshots are attached, inspect them with the Read tool (vision) and compare to the claimed UI/behavior. ` +
    `You may read and search the repo to confirm (read-only). Do NOT edit anything.\n` +
    doneBlock +
    evidenceBlock +
    riskBlock +
    lensBlock +
    lessons +
    attachBlock +
    humanGate +
    `\nIf the verdict genuinely hinges on operator intent rather than code quality (is this the behavior the operator wanted, ` +
    `not whether it's built well), \`mc ask "..." --options "a,b"\` with the options and a short wait before falling ` +
    `back to \`changes\` with the question in your notes — don't guess at intent.\n` +
    `\nDeliver ONE verdict:\n` +
    `  • \`mc verdict ${reviewId} approve${lens ? ` --lens ${lens.id}` : ""}\` — only if you would ship it as-is.\n` +
    `  • \`mc verdict ${reviewId} changes "specific, actionable list of what must be fixed"${lens ? ` --lens ${lens.id}` : ""}\` — otherwise.\n` +
    `Be strict but fair. Stay within this repository.`;

  // Cross-vendor QA: run the reviewer on the workspace's configured review engine when set, so a
  // different backend/model audits the build than wrote it (independent failure modes > self-review).
  // Unset → inherit the builder's backend/model (legacy behavior).
  const reviewBackend = ws.review_backend || t.backend || ws.default_backend;
  const reviewModel = ws.review_model || t.model || ws.default_model || undefined;
  const builderBackend = t.backend ?? ws.default_backend;
  const crossVendor = reviewBackend !== builderBackend;

  const job = jobs.create({
    name: jobName,
    description: `QA ${t.title}`,
    goal: crossVendor
      ? goal + `\n\n(You are a DIFFERENT engine than the one that wrote this — review it with fresh, independent judgment; don't assume the author's choices were correct.)`
      : goal,
    workspace_id: ws.id,
    ticket_id: t.id,
    backend: reviewBackend,
    model: reviewModel,
    cwd,
    host_id: reviewHost,
    sandbox: ws.sandbox_mode,
    disallowed_tools: "Edit,Write,MultiEdit,NotebookEdit",
    trigger_type: "manual",
  });
  const d = dispatch(job.id, jobName);
  if ("error" in d) return { job_id: job.id, status: `error: ${d.error}` };
  return { job_id: job.id, run_id: d.run_id, status: d.status };
}

/**
 * Send a high-risk change to a panel: three reviewers, three different questions (panels.ts).
 * Returns the dispatched lens ids, or null when this review isn't panel-worthy.
 */
export function dispatchReviewPanel(reviewId: string): string[] | null {
  const r = reviews.get(reviewId);
  if (!r?.ticket_id) return null;
  const t = tickets.get(r.ticket_id);
  const ws = t ? workspaces.get(t.workspace_id) : undefined;
  if (!ws) return null;
  const risk = (r.risk as RiskTier | null) ?? null;
  if (!wantsReviewPanel(risk, parseGateResults(r.gate_json), !!ws.review_panel)) return null;

  reviews.setPanel(reviewId, JSON.stringify({ lenses: REVIEW_LENSES.map((l) => l.id), votes: [] } satisfies PanelState));
  const dispatched: string[] = [];
  for (const lens of REVIEW_LENSES) {
    try {
      const d = dispatchReview(reviewId, { lens });
      // skipped = that lens is already in flight (idempotent re-entry); still counts toward quorum.
      if (!d.status?.startsWith("error")) dispatched.push(lens.id);
    } catch (e) {
      console.error(`[review-panel] ${lens.id} dispatch failed`, e);
    }
  }
  // Record only the lenses that actually started: resolvePanel waits for every listed lens, and a
  // lens that never ran would hold the review pending forever. Re-read votes before writing — dispatch()
  // runs the executor synchronously (CLAUDE.md #1), so a fast lens can cast a real vote during this
  // loop; resetting votes to [] here used to wipe them (PER-32).
  const fresh = parsePanel(reviews.get(reviewId)?.panel_json);
  const votes = (fresh?.votes ?? []).filter((v) => dispatched.includes(v.lens));
  reviews.setPanel(reviewId, JSON.stringify({ lenses: dispatched, votes } satisfies PanelState));
  return dispatched.length ? dispatched : null;
}

/**
 * One-pass rework rule: an AI reviewer may send a ticket back for rework at most
 * CONFIG.reviewMaxReworks times (default 1). Past that, a "changes" verdict no longer loops —
 * the review takes the approve lane (every risk/gate guard in approve() still applies, so a red
 * gate or a not-handed-over repo still waits for a human) and the unresolved objections are filed
 * as a follow-up ticket instead of buying another build+panel cycle.
 *
 * Why: PER-3 burned 3 full cycles ($7.64, 16 runs) with reviewers flip-flopping one regex —
 * "too loose" → rework → "too tight" → rework → "too loose". Reviewers judge one build in
 * isolation; nothing in the loop can decide a genuine tradeoff, so past the cap that decision
 * belongs on a ticket, not in another cycle. Gate failures (`ai:gate`) don't spend the rework
 * budget — a build that doesn't compile can't ship — and aren't capped here (autoplan's
 * reviewMaxIterations backstop still bounds them).
 */
async function aiRequestChanges(reviewId: string, notes: string): Promise<Review | undefined> {
  const r = reviews.get(reviewId);
  const reworksSpent = r?.ticket_id
    ? reviews.byTicket(r.ticket_id).filter((x) => x.id !== reviewId && x.state === "changes_requested" && x.actor !== "ai:gate").length
    : 0;
  if (!r?.ticket_id || reworksSpent < CONFIG.reviewMaxReworks)
    return requestChanges(reviewId, notes, "ai:reviewer");

  const t = tickets.get(r.ticket_id);
  let followUp = "";
  if (t) {
    try {
      const f = createTicket({
        workspace_id: t.workspace_id,
        repo_id: t.repo_id,
        title: `Follow-up: unresolved review notes on ${t.key}`,
        priority: "P2",
        context:
          `${t.key} already spent its rework budget (${CONFIG.reviewMaxReworks}) and shipped under the one-pass ` +
          `review policy. A reviewer still objected; judge these notes on their merits — they may re-litigate an ` +
          `earlier round or describe a real tradeoff needing a human call:\n\n${notes}`,
      });
      followUp = ` Objections filed as ${f.key}.`;
    } catch (e) {
      console.error("[review] one-pass follow-up ticket failed", e);
    }
  }
  await notify(
    `⚖️ ${tref(t) || "<b>ticket</b>"} reviewer objected again after ${CONFIG.reviewMaxReworks} rework(s) — shipping per one-pass policy.${followUp}`,
  ).catch(() => {});
  return approve(reviewId, `${notes}\n\n[one-pass review cap: rework budget spent — shipping.${followUp}]`, "ai:reviewer");
}

/**
 * Apply an AI reviewer's verdict.
 *
 * On a panel this is one vote, not a decision — the review only moves when the panel resolves
 * (any lens asking for changes, or every lens reporting back with quorum approving).
 */
export async function applyVerdict(
  reviewId: string,
  decision: "approve" | "changes",
  notes?: string | null,
  lens?: string | null,
): Promise<Review | undefined> {
  const r = reviews.get(reviewId);
  if (!r) return undefined;
  if (r.state !== "pending") return r; // already decided (human beat the agent to it)

  if (isPanelReview(r) && lens) return castPanelVote(r, lens, decision, notes ?? null);

  return decision === "approve"
    ? approve(reviewId, notes ?? "AI reviewer: approved", "ai:reviewer")
    : aiRequestChanges(reviewId, notes ?? "AI reviewer requested changes");
}

async function castPanelVote(
  r: Review,
  lens: string,
  decision: "approve" | "changes" | "abstain",
  notes: string | null,
): Promise<Review | undefined> {
  const state = parsePanel(r.panel_json);
  if (!state) return r;
  if (!state.lenses.includes(lens)) return r; // a lens nobody asked for doesn't get a vote
  const next = addVote(state, { lens, decision, notes, at: new Date().toISOString() });
  reviews.setPanel(r.id, JSON.stringify(next));

  const outcome = resolvePanel(next, CONFIG.reviewPanelQuorum);
  if (outcome.decision === "pending") return reviews.get(r.id);
  return outcome.decision === "approve"
    ? approve(r.id, outcome.notes, "ai:reviewer")
    : aiRequestChanges(r.id, outcome.notes ?? "review panel requested changes");
}

/**
 * A panel reviewer's run ended without voting (crash, timeout, budget wall). Record an abstention so
 * the panel can still resolve instead of leaving the review pending forever — quorum then decides
 * whether the surviving lenses are enough to pass a high-risk change.
 */
export async function panelRunEnded(reviewId: string, lens: string): Promise<void> {
  const r = reviews.get(reviewId);
  if (!r || r.state !== "pending" || !isPanelReview(r)) return;
  const state = parsePanel(r.panel_json);
  if (!state || state.votes.some((v) => v.lens === lens)) return; // already voted
  await castPanelVote(r, lens, "abstain", "reviewer run ended without a verdict");
}

function transition(
  id: string,
  state: Review["state"],
  ticketStatus: "done" | "ready" | "shipping" | null,
  notes?: string | null,
  by = "human"
): Review | undefined {
  // Review state + ticket status must commit together — a review left "approved" against a ticket
  // still stuck in its old status (or vice versa) is exactly the kind of half-applied write a crash
  // between the two separate UPDATEs used to be able to produce.
  const r = db.transaction(() => {
    const rr = reviews.setState(id, state, notes, by);
    // silent: we publish below, after the transaction commits, with the actor attached.
    if (rr?.ticket_id && ticketStatus)
      updateTicket(rr.ticket_id, { status: ticketStatus }, { silent: true });
    return rr;
  })();
  if (!r) return undefined;
  if (r.ticket_id && ticketStatus) {
    bus.publish({ topic: "ticket.updated", ticket_id: r.ticket_id, status: ticketStatus, actor: by });
    // Closed learning loop: a ticket just shipped → maybe distill a reusable skill from how it
    // was done (opt-in per workspace via skill_distill; the distiller judges triviality itself).
    if (ticketStatus === "done") {
      try { maybeDistillSkill(r.ticket_id); } catch (e) { console.error("[distill] failed", e); }
    }
  }
  bus.publish({ topic: "review.updated", review_id: r.id, state, actor: by });
  return r;
}

export async function approve(id: string, notes?: string | null, by = "human"): Promise<Review | undefined> {
  const r = reviews.get(id);
  if (!r) return undefined;
  // Done means "code landed" — a human Approve always ships via merge(): commit locally for
  // delivery=commit repos, commit → push → open PR for delivery=pr. Never strand approved work.
  if (!by.startsWith("ai")) return merge(id, notes, by);
  // Risk-tiered human gate: an AI approve closes the ticket only for the lane this repo has handed
  // over. Above that tier — and whenever we have no diff to judge risk from — the approve is a
  // recommendation and the review stays pending for the operator.
  if (by.startsWith("ai") && r.ticket_id) {
    const t = tickets.get(r.ticket_id);
    const repo = t?.repo_id ? repos.get(t.repo_id) : undefined;
    const risk = (r.risk as RiskTier | null) ?? null;
    const gateResults = parseGateResults(r.gate_json);
    // Belt-and-braces: createForRun already diverts red gates to rework, but nothing that reaches
    // "approved" should ever have failing evidence behind it.
    const gateRed = !!gateResults?.length && !gatesPassed(gateResults);
    if (gateRed || needsHumanApproval(repo, risk, gateResults)) {
      const why = gateRed ? "evidence gate is red" : `human_gate=${repo?.human_gate ?? "always"}, ${riskSummary(risk, gateResults)}`;
      const note = (notes?.trim() ? notes.trim() + "\n" : "") + `[AI recommend-approve — waiting for human: ${why}]`;
      // Keep pending so a human still sees Approve / Merge.
      return reviews.setState(id, "pending", note, by) ?? r;
    }
    // Handed-over lane: ship it exactly like a human approve would, PR and all.
    return merge(id, notes ? `${notes}\n[auto-merged: ${riskSummary(risk, gateResults)}]` : `[auto-merged: ${riskSummary(risk, gateResults)}]`, by);
  }
  return transition(id, "approved", "done", notes, by);
}

/**
 * Close a review without touching the code or the ticket. Approve ships (commit/push/PR) and Changes
 * reopens the ticket — neither is right for a review row that outlived what it was reviewing: work
 * already landed by hand, a ticket closed some other way, a duplicate. Dismiss is the third exit:
 * the row leaves the pending queue and nothing else moves.
 * Only a pending review can be dismissed — a decided one stays decided.
 */
export function dismiss(id: string, notes?: string | null, by = "human"): Review | undefined {
  const r = reviews.get(id);
  if (!r) return undefined;
  if (r.state !== "pending") return r;
  return transition(id, "dismissed", null, notes ?? "[dismissed]", by);
}

export function requestChanges(id: string, notes?: string | null, by = "human"): Review | undefined {
  const prev = reviews.get(id);
  const r = transition(id, "changes_requested", "ready", notes, by);
  // Every changes-requested verdict is a labelled example of this workspace getting something
  // wrong, and it used to be spent once as a rework note on this one ticket. Distil it into a rule
  // the NEXT build hears too. A gate failure is machine output, not a judgment, so it's skipped.
  if (r?.ticket_id && notes?.trim() && by !== "ai:gate" && prev?.state !== "changes_requested") {
    const t = tickets.get(r.ticket_id);
    if (t) {
      // The operator's own corrections are also worth keeping verbatim in the learnings memo.
      if (!by.startsWith("ai")) {
        try {
          captureLearnings(t.workspace_id, [`Operator requested changes on ${t.key} (${t.title}): ${notes.trim()}`], "review-feedback");
        } catch (e) { console.error("[learn] review-feedback capture failed", e); }
      }
      captureFeedback(t.workspace_id, notes, {
        repo_id: t.repo_id,
        source: by.startsWith("ai") ? "review" : "operator",
        source_ref: t.key,
        ticketTitle: t.title,
      });
    }
  }
  return r;
}

// Commit the mc/ branch, push it, and open (or reuse) a GitHub PR. `run` executes a command in the
// repo cwd and throws (with .stderr) on non-zero exit. Factored out so the sequence is unit-testable
// without a real repo. Returns the PR URL. Throws (does NOT swallow) on push/gh failure so the caller
// can leave the review pending for retry.
type RunCmd = (cmd: string, args: string[]) => Promise<string>;
export async function shipPR(
  branch: string,
  base: string,
  title: string,
  body: string,
  run: RunCmd
): Promise<string> {
  await run("git", ["add", "-A"]);
  try {
    await run("git", ["commit", "-m", title]);
  } catch {
    // nothing to commit — the branch already carries the work
  }
  try {
    await run("git", ["push", "-u", "origin", branch]);
  } catch (e: any) {
    throw new Error(`git push failed: ${String(e?.stderr ?? e?.message ?? e).trim()}`);
  }
  // Empty branch → `gh pr create` dies with a cryptic "No commits between..." GraphQL error.
  // Catch it here with a clear message so the review stays pending for a real rebuild.
  await run("git", ["fetch", "origin", base]);
  if ((await run("git", ["rev-list", "--count", `origin/${base}..${branch}`])).trim() === "0") {
    throw new Error(`no commits on ${branch} vs origin/${base} — the build never committed its work to the ticket branch (would open an empty PR)`);
  }
  try {
    return (await run("gh", ["pr", "create", "--title", title, "--body", body, "--base", base, "--head", branch])).trim();
  } catch (e: any) {
    const stderr = String(e?.stderr ?? e?.message ?? e).trim();
    if (/already exists/i.test(stderr)) {
      return (await run("gh", ["pr", "view", branch, "--json", "url", "-q", ".url"])).trim();
    }
    throw new Error(`gh pr create failed: ${stderr}`);
  }
}

// Land a commit-delivery build onto the shared checkout's default branch. Builds now always run in
// an isolated per-ticket worktree, so their commits sit on mc/<key>; "commit delivery" still has to
// mean the work is on the default branch when the ticket closes.
//
// Refuses (rather than forces) whenever the shared checkout isn't a clean tree sitting on its
// default branch, and only ever fast-forwards: that checkout may hold a human's uncommitted work or
// another ticket's branch, and clobbering it is exactly the failure this isolation work exists to
// prevent. Returns null on success, else a human-readable reason the caller records on the ticket —
// the branch keeps the commits either way, so a refusal delays delivery, it never loses work.
export async function landOnDefaultBranch(
  branch: string,
  defaultBranch: string,
  run: RunCmd
): Promise<string | null> {
  try {
    const head = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (head !== defaultBranch) return `shared checkout is on '${head}', not '${defaultBranch}'`;
    if ((await run("git", ["status", "--porcelain"])).trim() !== "")
      return "shared checkout has uncommitted changes";
    await run("git", ["merge", "--ff-only", branch]);
    return null;
  } catch (e: any) {
    return String(e?.stderr ?? e?.message ?? e).trim();
  }
}

const PR_FOOTER = "🤖 Generated with [Claude Code](https://claude.com/claude-code)";

// Build the PR body from the build agent's structured handoff (ticket.report) — the same report the
// review card shows. Falls back to the review notes, then the title, so an approve without a handoff
// still opens a non-empty PR. Appends a link back to the external issue when the ticket has one.
export function prBody(t: Ticket, r: Review): string {
  const base = (t.report || r.notes || t.title).trim();
  const ref = t.external_url ? `\n\nRef: ${t.external_url}` : "";
  return `${base}${ref}\n\n${PR_FOOTER}`;
}

// Code already landed: closing a stale review against one of these ships nothing, so it's safe even
// with the run's worktree gone. Anything else still has work to deliver — never auto-close it.
const LANDED_STATUSES: readonly string[] = ["done", "shipping"];

// Ticket patch after shipPR. First open (or re-ship after an abandoned/closed PR) sets
// pr_state=open + ci_state=pending so delivery.ts polls; a later merge() on the same already-open
// (or already-merged) PR must NOT bounce those fields — resetting merged→open or open+passing →
// open+pending re-arms the delivery poll and merge-gate (PER-4 / PER-13 loops). closed re-arms:
// markPrClosed left pr_state=closed; the next shipPR opens a new PR that delivery must watch.
export function prDeliveryPatch(
  t: { pr_url?: string | null; pr_state?: string | null; ci_state?: string | null },
  url: string,
): { pr_url: string; pr_state?: "open"; ci_state?: "pending" } {
  if (t.pr_state === "merged" || t.pr_state === "open") {
    return { pr_url: url };
  }
  return { pr_url: url, pr_state: "open", ci_state: "pending" };
}

// Merge. delivery='commit' (default): commit the working tree in the run's repo, then close the
// ticket. delivery='pr': commit the mc/ branch, push, and open a GitHub PR — the ticket only closes
// if the PR ships. On push/gh failure we throw so the review stays pending and retry works.
export async function merge(id: string, notes?: string | null, by = "human"): Promise<Review & { pr_url?: string } | undefined> {
  const r = reviews.get(id);
  if (!r) return undefined;
  const run = runs.get(r.run_id);
  const job = run ? jobs.get(run.job_id) : undefined;
  const t = r.ticket_id ? tickets.get(r.ticket_id) : undefined;
  const repo = t?.repo_id ? repos.get(t.repo_id) : undefined;
  const ws = t ? workspaces.get(t.workspace_id) : undefined;

  // A worktree is pruned once its ticket lands, but a review row can outlive it by weeks. Spawning
  // git with a cwd that no longer exists makes Node report ENOENT *naming the binary* ("spawn git
  // ENOENT"), which reads as a broken git install and sends the reader chasing PATH (see the same
  // footgun in runner.ts). Say what actually happened — and for work that already landed, let the
  // stale review close instead of stranding it forever behind a git call with nothing left to run.
  // Where the build's worktree is — on another computer when the build ran there (HOSTS.md phase 5).
  // Everything below that touches it (commit, push, gh pr create, checkout) runs on that computer.
  const wd = job?.cwd ? workDirOf(job, run) : null;
  const wsId = t?.workspace_id ?? job?.workspace_id ?? null;
  if (wd && !(await workDirExists(wd, wsId))) {
    const where = isRemoteDir(wd) ? `${wd.cwd} on ${hostName(wd.host_id)}` : wd.cwd;
    if (!t || !LANDED_STATUSES.includes(t.status)) {
      throw new Error(
        `working directory gone: ${where} (worktree pruned?) — nothing left to ship from this run; re-dispatch the ticket, or dismiss the review if the work is obsolete`
      );
    }
    const why = `[worktree gone (${where}); ticket already ${t.status} — closing the stale review, no code shipped by this action]`;
    return transition(id, "merged", null, notes ? `${notes}\n${why}` : why, by);
  }

  // Ticket deleted under a pending review (reviews.ticket_id ON DELETE SET NULL). Commit delivery
  // would still git-commit in the worktree, but land-on-default is gated on `t` — Inbox showed
  // merged while the commit sat forever on an orphaned mc/<key> branch (PER-34). Fail closed;
  // delete is blocked for pending reviews now, but historical stranded rows still hit this.
  if (!t) {
    throw new Error(
      `ticket gone for this review — refusing to merge: nothing to land onto the default branch. Restore the ticket, or dismiss the review if the work is obsolete`,
    );
  }

  if (repo?.delivery === "pr" && wd && t) {
    const branch = ticketBranch(t.key);
    const env = childEnv(ws);
    // gh runs where the worktree is: on a host, with that host's gh login for this workspace
    // (GH_CONFIG_DIR travels in the workspace env). Push/gh get a network-sized timeout there.
    const exec: RunCmd = async (cmd, args) =>
      (await execIn(wd, cmd, args, { env, workspaceId: wsId, ...(isRemoteDir(wd) ? { timeoutMs: 120_000 } : {}) })).stdout;
    const title = `${t.key}: ${t.title}`;
    const body = prBody(t, r);
    const url = await shipPR(branch, repo.default_branch, title, body, exec); // throws on failure → review stays pending
    try {
      await execIn(wd, "git", ["-C", wd.cwd, "checkout", repo.default_branch], { workspaceId: wsId });
    } catch {
      // leave the tree on the mc/ branch; the next dispatch checks out its own branch anyway
    }
    appendNote(t.id, `Shipped PR: ${url}`, by);
    // Delivery-state tracking: the PR outcome (open → merged/closed) + CI rollup are polled by src/delivery.ts.
    updateTicket(t.id, prDeliveryPatch(t, url));
    // Done means "code landed on main" — while the PR is open the ticket sits in 'shipping';
    // delivery.ts (poll or in-app Merge PR) flips it to done on merge, back to ready on close.
    // A redundant merge() (second approve after the PR is already tracked) must not bounce a
    // done/shipping ticket — that re-notifies and looks like a fresh ship (PER-4 / PER-13).
    const nextStatus = t.status === "done" || t.status === "shipping" ? null : "shipping";
    const merged = transition(id, "merged", nextStatus, notes ? `${notes}\nPR: ${url}` : `PR: ${url}`, by);
    return merged ? { ...merged, pr_url: url } : merged;
  }

  if (job?.cwd && wd) {
    try {
      await execIn(wd, "git", ["-C", wd.cwd, "add", "-A"], { workspaceId: wsId });
      await execIn(wd, "git", ["-C", wd.cwd, "commit", "-m", `merge: ${job.name}${notes ? ` — ${notes}` : ""}`], { workspaceId: wsId });
    } catch {
      // nothing to commit / not a repo — still record the merge decision
    }
    // The commit above landed on the worktree's mc/<key> branch, not on the shared checkout's
    // default branch — fast-forward it across so commit delivery still ends with the work on main.
    // The branch exists only where the worktree is, so it lands on THAT computer's checkout (a host's
    // own clone, for a build that ran there): commit delivery is local to the machine that did the work.
    const main = repo ? checkoutOn(wd.host_id, repo) : null;
    if (t && repo?.path && main && !isSharedCheckout(wd, repo)) {
      const branch = ticketBranch(t.key);
      const env = childEnv(ws);
      const mainWd: WorkDir = { host_id: wd.host_id, cwd: main };
      const where = isRemoteDir(wd) ? `${main} on ${hostName(wd.host_id)}` : main;
      const why = await landOnDefaultBranch(branch, repo.default_branch, async (cmd, args) =>
        (await execIn(mainWd, cmd, args, { env, workspaceId: wsId })).stdout
      );
      if (why)
        appendNote(
          t.id,
          `Work is committed on branch \`${branch}\` but could not be fast-forwarded into ${repo.default_branch} at ${where}: ${why}\nLand it manually: git -C ${main} merge ${branch}`,
          by
        );
      else if (isRemoteDir(wd))
        appendNote(t.id, `Landed on ${repo.default_branch} in ${where} (the build ran on that computer; push it from there to share it).`, by);
    }
  }
  return transition(id, "merged", "done", notes, by);
}
