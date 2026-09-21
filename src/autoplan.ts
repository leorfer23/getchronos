import { CONFIG } from "./config.js";
import { tickets, workspaces, runs, jobs, reviews, ticketLinks, repos } from "./store.js";
import { dispatchPlan, dispatchPlanMerge, dispatchPlanPanel, dispatchTicket, dispatchGrade, updateTicket, appendNote } from "./tickets.js";
import { dispatchReview, dispatchReviewPanel, panelRunEnded, approve } from "./reviews.js";
import { bus } from "./bus.js";
import { notify } from "./telegram.js";
import { notifyInfo } from "./telegram/api.js";
import { tref } from "./telegram/api.js";
import { REVIEW_LENSES, SCOUT_LENSES, reviewSkipReason } from "./panels.js";
import { baseJobName } from "./job-name.js";
import type { Ticket, Workspace } from "./types.js";

// Tickets we just failed to plan — don't immediately re-pick and burn budget in a loop.
const cooldown = new Map<string, number>(); // ticket_id -> unix ms until eligible again
const PRIORITY = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;

// How many build slots a workspace has free right now. A tracker-mirrored 'in_progress' ticket
// (status_source 'external') has no agent on it — counting it against the concurrency cap would let
// ClickUp/Jira's own board state starve real dispatch. Pure + exported so it's unit-testable without
// a live pump.
export function activeBuildSlots(wsId: string): number {
  const inProgress = tickets
    .list({ workspace_id: wsId, status: "in_progress" })
    .filter((t) => t.status_source !== "external").length;
  return CONFIG.buildConcurrencyPerWs - inProgress;
}

function eligible(wsId: string) {
  const now = Date.now();
  const goals = ticketLinks.goalIds(); // goals are umbrellas, not plannable/buildable work — skip them
  return tickets
    .list({ workspace_id: wsId })
    .filter((t) => t.status === "backlog" && t.repo_id && !goals.has(t.id)) // 'ready' = post-review rework → goes to build, not re-plan
    .filter((t) => (cooldown.get(t.id) ?? 0) < now)
    .sort((a, b) => (PRIORITY[a.priority as keyof typeof PRIORITY] ?? 9) - (PRIORITY[b.priority as keyof typeof PRIORITY] ?? 9));
}

async function sweep() {
  // Global budget gate — never let the planner blow the daily cap.
  if (CONFIG.dailyBudgetUsd > 0 && runs.spentTodayUsd() >= CONFIG.dailyBudgetUsd) return;

  for (const ws of workspaces.list()) {
    if (!ws.auto_plan) continue;
    const active = tickets.list({ workspace_id: ws.id, status: "planning" }).length;
    let slots = CONFIG.planConcurrencyPerWs - active;
    if (slots <= 0) continue;

    for (const t of eligible(ws.id)) {
      if (slots <= 0) break;
      try {
        // A hard ticket gets three scouts with different questions; everything else gets one.
        const panel = dispatchPlanPanel(t.id);
        if (panel) {
          slots--;
          await notifyInfo(`🧭 <b>${ws.name}</b> · scout panel on ${tref(t)} (${panel.join(", ")})`).catch(() => {});
          continue;
        }
        const r = dispatchPlan(t.id);
        if (r.status && r.status.startsWith("error")) {
          cooldown.set(t.id, Date.now() + CONFIG.planRetryCooldownMin * 60_000);
          continue;
        }
        slots--;
        await notifyInfo(`🧭 <b>${ws.name}</b> · auto-planning ${tref(t)} (read-only)`).catch(() => {});
      } catch (e: any) {
        cooldown.set(t.id, Date.now() + CONFIG.planRetryCooldownMin * 60_000);
      }
    }
  }
}

// A planning run ended. Two cases:
//  - agent never saved a plan (status still 'planning') → unstick to backlog with a cooldown (no dead tickets).
//  - plan saved (status 'planned') → kick the second-pass k3 grader if the workspace opts in.
function onRunEnded(run_id: string) {
  const run = runs.get(run_id);
  if (!run) return;
  const job = jobs.get(run.job_id);
  const jobName = baseJobName(job?.name);
  if (!job?.ticket_id || !jobName.startsWith("plan:")) return;
  const t = tickets.get(job.ticket_id);
  if (!t) return;
  // A scout panel ends three runs, not one. Wait for the last of them, then merge the findings —
  // and never unstick the ticket while its siblings are still investigating.
  if (runs.hasActiveJob(t.id, "plan:")) return;
  const wasScout = SCOUT_LENSES.some((l) => jobName === `plan:${t.key}:${l.id}`);
  if (wasScout && t.status === "planning") {
    try {
      const r = dispatchPlanMerge(t.id);
      if (!r.status?.startsWith("error")) {
        notifyInfo(`🧵 ${tref(t)} · merging scout briefs into one plan`).catch(() => {});
        return;
      }
    } catch (e) {
      console.warn("[autoplan] plan merge dispatch failed", e);
    }
    // fall through to the unstick path — a panel we can't merge is a failed plan, not a hung ticket
  }
  if (t.status === "planning") { // agent never flipped it to 'planned' → treat as failed plan
    updateTicket(t.id, { status: "backlog" });
    cooldown.set(t.id, Date.now() + CONFIG.planRetryCooldownMin * 60_000);
    try { appendNote(t.id, `planning run ended without a saved plan (${run.status}) — returned to backlog`, "system"); } catch {}
    notifyInfo(`⚠️ ${tref(t)} planning ended without a plan (${run.status}) — back to backlog`).catch(() => {});
    return;
  }
  maybeGrade(t.id);
}

// Pure guard for maybeGrade: should the second-pass grader even be considered for this ticket right
// now? Extracted so the "human complexity is authoritative, grading never runs against it" rule is
// unit-testable without dispatch/runs/notify (CLAUDE.md gotcha #2). complexity set by the SCOUT (or
// left ungraded, complexity_source null) still re-grades normally — only 'human' blocks it.
export function shouldGrade(
  t: Pick<Ticket, "status" | "complexity_source"> | undefined,
  ws: Pick<Workspace, "auto_grade"> | undefined,
): boolean {
  if (!t || t.status !== "planned") return false; // only grade a fresh plan awaiting build
  if (!ws?.auto_grade) return false;
  if (t.complexity_source === "human") return false; // the operator's call is authoritative — never re-graded
  return true;
}

// Second grading pass (default k3): grade difficulty 1-5 so the build agent auto-routes by difficulty.
// Runs after every plan when ws.auto_grade is on. Build is held (pumpBuilds) until this finishes.
function maybeGrade(ticketId: string) {
  const t = tickets.get(ticketId);
  const ws = t ? workspaces.get(t.workspace_id) : undefined;
  if (!shouldGrade(t, ws)) return;
  if (CONFIG.dailyBudgetUsd > 0 && runs.spentTodayUsd() >= CONFIG.dailyBudgetUsd) return;
  if (runs.hasActiveJob(t!.id, "grade:")) return; // already grading
  try {
    const r = dispatchGrade(t!.id);
    if (!r.status?.startsWith("error")) notifyInfo(`🎓 <b>${ws!.name}</b> · grading ${tref(t!)} difficulty (k3)`).catch(() => {});
  } catch {}
}

// Trust mode: in an auto_build workspace, auto-approve 'planned' tickets into the build agent (the
// human's only remaining gate is the review queue). Respects per-ws build concurrency + daily budget.
// Pump-style so queued plans build as slots free (re-run on each planned + each run end).
const escalated = new Set<string>(); // tickets that hit the rework cap (notify once)
async function pumpBuilds(wsId: string) {
  const ws = workspaces.get(wsId);
  if (!ws?.auto_build) return;
  if (CONFIG.dailyBudgetUsd > 0 && runs.spentTodayUsd() >= CONFIG.dailyBudgetUsd) return;
  let slots = activeBuildSlots(wsId);
  if (slots <= 0) return;
  // 'planned' = first build (approve the plan). 'ready' = rework after a reviewer requested changes.
  const queue = [...tickets.list({ workspace_id: wsId, status: "planned" }), ...tickets.list({ workspace_id: wsId, status: "ready" })];
  for (const t of queue) {
    if (slots <= 0) break;
    // Hold the build until the k3 difficulty grade lands — it drives build-agent routing.
    if (runs.hasActiveJob(t.id, "grade:")) continue;
    // Loop guard: cap build↔review cycles, then leave it for a human.
    if (t.status === "ready" && reviews.countByTicket(t.id) >= CONFIG.reviewMaxIterations) {
      if (!escalated.has(t.id)) {
        escalated.add(t.id);
        await notify(`🙋 <b>${ws.name}</b> · ${tref(t)} hit ${CONFIG.reviewMaxIterations} build↔review cycles — needs a human. Left in 'ready'.`).catch(() => {});
      }
      continue;
    }
    try {
      const r = await dispatchTicket(t.id);
      if (r.status && r.status.startsWith("error")) continue;
      slots--;
      const verb = t.status === "ready" ? "reworking" : "auto-approved plan → building";
      await notifyInfo(`🤖 <b>${ws.name}</b> · ${verb} ${tref(t)}`).catch(() => {});
    } catch {}
  }
}
function pumpAllBuilds() {
  for (const ws of workspaces.list()) if (ws.auto_build) pumpBuilds(ws.id);
}

// AI reviewer: a build just queued a review → auto-dispatch a read-only QA agent (if opted in).
function onReviewCreated(reviewId: string, ticketId: string | null) {
  if (!ticketId) return;
  const t = tickets.get(ticketId);
  const ws = t ? workspaces.get(t.workspace_id) : undefined;
  if (!ws?.auto_review) return;
  if (CONFIG.dailyBudgetUsd > 0 && runs.spentTodayUsd() >= CONFIG.dailyBudgetUsd) return;
  // 0-reviewer lane: easy graded tickets (per-repo threshold, else workspace) skip the AI reviewer.
  // The review takes the approve lane unseen — repo.human_gate still decides ship vs. your queue.
  const repo = t!.repo_id ? repos.get(t!.repo_id) : undefined;
  const skip = reviewSkipReason(repo?.review_min_difficulty ?? ws.review_min_difficulty, t!.complexity);
  if (skip) {
    approve(reviewId, `[review skipped: ${skip} — no AI reviewer dispatched]`, "ai:policy")
      .then(() => notifyInfo(`⏭️ <b>${ws.name}</b> · ${tref(t!)} skipped AI review (${skip})`).catch(() => {}))
      .catch((e) => console.error("[autoplan] skip-review approve failed", e));
    return;
  }
  try {
    // High-risk changes get three reviewers looking for different things; the rest get one.
    const panel = dispatchReviewPanel(reviewId);
    if (panel) {
      notifyInfo(`🔬 <b>${ws.name}</b> · review panel on ${tref(t!)} (${panel.join(", ")}) — high risk`).catch(() => {});
      return;
    }
    const r = dispatchReview(reviewId);
    // "skipped:" = concurrent review.created already has a reviewer in flight (PER-31) — no second ping.
    if (!r.status?.startsWith("error") && !r.status?.startsWith("skipped"))
      notifyInfo(`🔍 <b>${ws.name}</b> · AI reviewing ${tref(t!)}`).catch(() => {});
  } catch {}
}

// A panel reviewer that died without voting must not hold the review pending forever — record the
// abstention so quorum can decide with the lenses that did report.
function onReviewRunEnded(run_id: string) {
  const run = runs.get(run_id);
  const job = run ? jobs.get(run.job_id) : undefined;
  const jobName = baseJobName(job?.name);
  if (!job?.ticket_id || !jobName.startsWith("review:")) return;
  const lens = REVIEW_LENSES.find((l) => jobName.endsWith(`:${l.id}`));
  if (!lens) return;
  const pending = reviews.byTicket(job.ticket_id).find((r) => r.state === "pending");
  if (pending) void panelRunEnded(pending.id, lens.id).catch(() => {});
}

// Once per process: a second startAutoPlan() would stack identical bus listeners and fire
// onReviewCreated N times per review.created (same failure class as PER-80's re-trigger loop).
let autoPlanStarted = false;
export function startAutoPlan() {
  if (autoPlanStarted) return;
  autoPlanStarted = true;
  if (!CONFIG.autoPlanEveryMin && !workspaces.list().some((w) => w.auto_build)) {
    // still wire the planned→build listener even if the planner sweep is off
  }
  bus.on("event", (e: any) => {
    if (e.topic === "run.ended") { onRunEnded(e.run_id); onReviewRunEnded(e.run_id); pumpAllBuilds(); } // a freed slot may admit a queued plan/rework
    if (e.topic === "ticket.updated" && (e.status === "planned" || e.status === "ready")) pumpBuilds(e.workspace_id || tickets.get(e.ticket_id)?.workspace_id);
    if (e.topic === "review.created") onReviewCreated(e.review_id, e.ticket_id);
  });
  if (!CONFIG.autoPlanEveryMin) { console.log("[autoplan] sweep off; trust(auto_build) listener active"); return; }
  const tick = async () => { try { await sweep(); } catch (err: any) { console.warn("[autoplan]", err?.message ?? err); } };
  setInterval(tick, CONFIG.autoPlanEveryMin * 60_000);
  setTimeout(tick, 45_000);
  console.log(`[autoplan] read-only planner every ${CONFIG.autoPlanEveryMin}m · ${CONFIG.planConcurrencyPerWs}/workspace`);
}
