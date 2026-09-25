import express from "express";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { CONFIG } from "./config.js";
import { serveHtml } from "./static-html.js";
import { bus } from "./bus.js";
import { activity, agentChat, asks, board, calEvents, calendars, chat, connectorSyncs, egressLog, events, ideas, jobs, jots, launches, lessons, repos, reviews, runs, searchIndex, sessions, sessionGoals, skills, steps, tickets, ticketLinks, triggers, watches, workspaces, workspaceVars, repoAccelerators, isAcceleratorTool, accelTelemetry } from "./store.js";
import { accelStatus } from "./accel/status.js";
import { buildGraphify, queryGraphify, GraphifyError } from "./accel/graphify.js";
import { postToBoard } from "./board.js";
import { nameError as varNameError, expiryFromHours } from "./store/workspace-vars.js";
import { answerAsk, notifyAskCreated, resolveAsk, waitForAskAnswer } from "./asks.js";
import { deliverPending, resolveMessageTarget, sendMessage } from "./messages.js";
import { egressCfg, egressPort, syncEgress } from "./egress.js";
import { createSkill, skillBody, skillRef, patchSkill, appendSkill, setSkillStatus, removeSkill, useSkill } from "./skills.js";
import { createIdea, promoteIdea, killIdea, killIdeas, dispatchIdeaFeeder } from "./ideas.js";
import { jotWritePolicy, runJot } from "./jots.js";
import { fireFollowUp, followUpPolicy, parseFollowUpAt } from "./jot-followup.js";
import { runLaunch } from "./launches.js";
import { desktop as desktopNotify } from "./notify.js";
import { vapidKeys, pushSubs, broadcast } from "./push.js";
import { planNextDay } from "./nextday.js";
import { dispatch, status as dispatchStatus, stopRun } from "./dispatcher.js";
import { steerRun } from "./runner.js";
import { brokerCall, credAllows, findCred, loadBrokerCreds, wsAllowed } from "./broker.js";
import { cacheStats } from "./cache-health.js";
import { decideStall, listStalls } from "./recovery.js";
import { applyHold, divergenceLine, divergences, resolveHoldTarget, type HoldKind } from "./holds.js";
import { filterByBucket, parseBucketFilter } from "./hold-bucket.js";
import { fireTrigger } from "./triggers.js";
import { appendNote, createTicket, dispatchTicket, dispatchPlan, dispatchGrade, gradeTicket, setPlan, getBody, removeTicket, updateTicket, ensureTicketSummary } from "./tickets.js";
import {
  listAttachments,
  getAttachment,
  saveAttachment,
  saveChatFile,
  saveChatAttachment,
  getChatAttachment,
  chatAttachmentsBlock,
  removeAttachment,
  ATTACH_ROOT,
  type ChatAttachment,
} from "./attachments.js";
import { pdfText } from "./pdf-text.js";
import { saveDrop, MAX_DROP_BYTES } from "./drops.js";
import { wsTicketsDir } from "./sandbox.js";
import { jobCreateSpawnError, jobPatchSpawnError } from "./spawn-guard.js";
import { approve, merge, requestChanges, dismiss, dispatchReview, applyVerdict, ensureReviewForTicket } from "./reviews.js";
import { isPrUrl, mergePrForTicket } from "./delivery.js";
import { deployStatus, queueSelfDeployManual, readPending } from "./self-deploy.js";
import { operationalHealth } from "./operational-health.js";
import { gateMode, quotaSnapshot, recentDecisions } from "./quota-gate.js";
import { spendToday, spendSinceDays, combinedByWorkspace } from "./spend.js";
import { helperSpendSnapshot } from "./helper-spend.js";
import { efficiencyToolsStatus } from "./efficiency-tools.js";
import { focusEfficiencySnapshot } from "./focus.js";
import { sessionArtifacts } from "./session-artifacts.js";
import { recordSessionPrs } from "./terminal-automerge.js";
import { analyticsWithDelta, RANGE_PRESETS } from "./analytics.js";
import { getBackend, listBackends, workspaceBackends } from "./backends/index.js";
import { cloudRunFor, cloudSessionState, cloudVisibleRepos, followUpCloudSession, openCloudSession, wantsCloudBackend } from "./desk-cloud.js";
import { openSession, resumeOpts, promoteToLead, leadPromotionError, attach, refreshClient, writeTo, resize, killSession, closeOutSession, focusEvents, isLive, sendInput, sessionActivity, sessionPrompt, sessionScreen, setClientRate, continueFromRun } from "./terminal.js";
import { sessionUsage, snapshotUsage } from "./session-usage.js";
import { applyHook, declare as declareStatus, sessionGoalReached, setProgress, statusOf } from "./term-status.js";
import { parseEvery, watchView } from "./desk-watch.js";
import { clipboardEnabled, readClipboard, writeClipboard } from "./clipboard.js";
import { ensureSessionWorktree, listAllWorktrees, remoteWorktreeBranch, removeWorktreeAs } from "./worktrees.js";
import { askRobertEnabled, askerLabel, escalateAsk } from "./ask-robert.js";
import * as noteSvc from "./notes.js";
import { forgetMemorySeen, markMemorySeen, memoryNotice, rememberFact } from "./memory-tree.js";
import { addSample, proseBrief, proseGuide, saveGuide, startLearning } from "./prose.js";
import { proseSamples } from "./store/prose.js";
import { recall, renderRecall } from "./recall.js";
import { recordRead, recordRecall, sessionFor, usageRoute } from "./memory-usage.js";
import * as dreamRoutes from "./dream-routes.js";
import * as inboxRoutes from "./inbox-routes.js";
import { inbox } from "./store/inbox.js";
import { openConflicts } from "./memory-conflicts.js";
import * as agentMemory from "./agent-memory.js";
import { isMemoryAgent } from "./agent-memory.js";
import { runStowPass } from "./stow.js";
import { report as memoryReport } from "./memory-budget.js";
import * as briefs from "./briefs.js";
import * as worklog from "./worklog.js";
import { isInternalJob } from "./job-name.js";
import { jobsBoard, runsFeed, type JobKind } from "./jobs-board.js";
import { storyFromEvents } from "./run-story.js";
import { installSlackMcp, slackStatus, ensureTriageJob } from "./slack.js";
import { syncWorkspace, pushComment, pushStatus, pushHours, pushClose } from "./connectors/index.js";
import { isStatusDivergent } from "./connectors/types.js";
import { refresh as refreshCal, refreshAll as refreshCals, importLocalCalendars, ingestLocal } from "./calendar.js";
import { nextRun, reloadSchedules } from "./scheduler.js";
import { buildReport } from "./report.js";
import { fleetData } from "./fleet.js";
import {
  getAgent,
  lifecycleRollup,
  listAgents,
  markAgentSeen,
  reportAgentState,
  resolveAgent,
  setAgentName,
  waitForAgent,
  type WaitUntil,
} from "./agent-lifecycle.js";
import { runCommandLine } from "./commands.js";
import { flowData } from "./flow.js";
import { transcribe, audioFilename, transcribeFailure } from "./transcribe.js";
import { speak, voiceFor, listVoices } from "./speak.js";
import { askManagerWeb, warmWebManager, getWebModel, setWebModel, webProfileDir, resetWebConversation, resetExecConversation, type ExecTurnOpts } from "./telegram/agent.js";
import { askLine, commitTurn, explainRoute, getSticky, resolveTurnSmart, setSticky } from "./thread-router.js";
import { robertWakes, leadEvents, leadSlices, memoryRelations, type RobertWake, type LeadEvent } from "./store.js";
import { addGoals, reopenGoal, setGoals, syncGoalMirror, tickAllGoals, tickCurrentGoal } from "./goals.js";
import { leadEventPayload, waitForLeadEvents } from "./robert-drive.js";
import { fileReport, leadEventLines } from "./lead-report.js";
import { leadMayAnswer, mayRouteToLead } from "./lead-asks.js";
import { WAKE_ATTEMPT_CAP, wakeBeaconAgeMs } from "./wake-queue.js";
import { supervisionGraceMs, supervisionVerdict } from "./supervision-guard.js";
import { runAgentHeartbeat, runFleetHeartbeat, runHeartbeat, type FleetAgent } from "./heartbeat.js";
import { parseGates, suggestGates } from "./gates.js";
import { publishLesson, recordLesson } from "./lessons.js";
import { listWidgets, readWidget } from "./widgets/index.js";
import { ensureIntakeJob } from "./intake.js";
import { RepoGitError, resolveRepoGitFields } from "./repo-git.js";
import type { GoalKind, LessonState, Session } from "./types.js";
import { redactConnectorConfig, publicTrigger } from "./redact.js";
import { tokenOk, callerScope, checkScope, forwardedGate, leadMayType, leadScope, type LeadScope } from "./authz.js";
import { findHost, hostOnline } from "./hosts/index.js";
import { RemoteHost } from "./hosts/remote.js";
import { resolveHostRef, sessionHostOffline } from "./remote-terminals.js";
import { invalidateWatchCache, prepareWatch } from "./watches.js";
import {
  validate,
  OpenSessionSchema, ResizeSchema, SessionPatchSchema, SessionGoalsSchema, SessionGoalPatchSchema, SessionInputSchema, SessionStatusSchema, SessionProgressSchema, SessionHookSchema, UsageReportSchema,
  AgentNameSchema, AgentReportSchema, AgentWaitSchema,
  NewNoteSchema, PatchNoteSchema, LearnSchema, RememberSchema, ProseSampleSchema, ProseGuideSchema, AgentMemoryAppendSchema, BriefAppendSchema, BriefRewriteSchema, AgentMemoryRewriteSchema, StowSchema,
  WorklogEntrySchema, WorklogBackfillSchema,
  NewJobSchema, PatchJobSchema, BulkJobsSchema,
  NewTriggerSchema, PatchTriggerSchema,
  NewWatchSchema, PatchWatchSchema,
  NewWorkspaceSchema, PatchWorkspaceSchema, SlackConfigSchema, EgressSchema,
  NewRepoSchema, PatchRepoSchema,
  NewLessonSchema, PatchLessonSchema,
  NewSkillSchema, PatchSkillSchema, ArchiveSkillSchema,
  NewWorkspaceVarSchema, PatchWorkspaceVarSchema,
  NewIdeaSchema, PromoteIdeaSchema, PromoteIdeasSchema, KillIdeasSchema, GenerateIdeasSchema,
  NewJotSchema, JotPatchSchema, JotAppendSchema, JotFollowUpSchema, JotResolveSchema, JOT_BODY_MAX, RunJotSchema, ReorderJotsSchema, PlanNextDaySchema,
  NewTicketSchema, PatchTicketSchema, TicketLinkSchema, TicketNoteSchema, PushCommentSchema, PushStatusSchema, PushHoursSchema,
  DeclareStepsSchema, SetStepSchema, NewAskSchema, AnswerAskSchema, EscalateAskSchema, HoldSchema, WatchSchema, ClipboardSchema, ClaimWorktreeSchema, RemoveWorktreeSchema, NewMessageSchema,
  DispatchTicketSchema, SetPlanSchema, GradeSchema, NewAttachmentSchema,
  ReviewNotesSchema, ReviewVerdictSchema,
  NewCalendarSchema, PatchCalendarSchema, CalendarIngestSchema, ImportLocalCalendarsSchema,
  OpenUrlSchema, HeartbeatSchema, AgentTextSchema, SpeakSchema, AgentModelSchema, AgentWarmSchema, ThreadStickySchema, AGENT_MODELS,
  NewBoardPostSchema,
  NewLaunchSchema, LaunchPatchSchema, ReorderLaunchesSchema, DeskNotifySchema, PushSubscribeSchema, PushUnsubscribeSchema,
  QuickActionsSchema, HeavySlotSchema,
  ReportSchema, LeadBroadcastSchema, LeadAdoptSchema, BoardAddSchema, BoardPatchSchema, PatchAccelSchema,
  BuildGraphifySchema, QueryGraphifySchema } from "./validation.js";
import { pressureWord, swapPctOf } from "./machine.js";
import { hostById, LOCAL_HOST_ID } from "./hosts/index.js";
import { HOST_PATH, brainLink, forwardedHost, hostRoutes } from "./hostlink/brain-link.js";
import { barRoutes } from "./hostlink/bar.js";
import { PlacementError } from "./hosts/candidates.js";
import { kv } from "./store/kv.js";
import { noteClaudeStatusline, usageSnapshot } from "./usage-meter.js";
import { defaultQuickActions, QUICK_ACTIONS_KV, type QuickAction } from "./quick-actions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Milliseconds between two workers in one `mc lead broadcast`. `sendInput` writes the text and then
 * Enter 200ms later, so anything tighter risks a second worker's write landing inside the first's
 * pending line — the same merge that made every keystroke to a Lead pace itself (LEAD_GAP_MS).
 */
const BROADCAST_GAP_MS = 300;

/** Largest drop forwarded to a remote host: it travels base64 in one control frame (cap 24 MB). */
const REMOTE_DROP_MAX = 16 * 1024 * 1024;

/**
 * The Desk footer's quick actions as stored, or the shipped set when nothing is stored — and also
 * when what IS stored no longer parses. A hand-edited kv row, or a row written by an older shape of
 * this feature, must not leave the operator with an empty footer and no way back to the defaults
 * except the dialog they can no longer reach.
 */
function readQuickActions(): QuickAction[] {
  const raw = kv.get(QUICK_ACTIONS_KV);
  if (!raw) return defaultQuickActions();
  try {
    const parsed = QuickActionsSchema.safeParse({ actions: JSON.parse(raw) });
    return parsed.success ? parsed.data.actions : defaultQuickActions();
  } catch {
    return defaultQuickActions();
  }
}

/**
 * The Desk's hot working set. Ended sessions remain durable in SQLite and are loaded only through
 * the paginated log/reopen flow; a goal must never pin historical sessions into every Desk client.
 */
export function activeDeskSessions(workspaceId: string | null): Session[] {
  return sessions.list({ workspace_id: workspaceId ?? undefined, status: "live" });
}

/**
 * GET /desk's Lead fields (LEADS.md Desk spec): for every row, the live Lead that opened it
 * (`lead_id`, null if none or that Lead has since ended) and, for a Lead row, its live worker
 * count. `live` is the live-session list, computed once per request by the caller — never per row.
 */
export function deskLeadFields(rows: Pick<Session, "id" | "role" | "lead_id">[], live: Pick<Session, "id" | "role" | "lead_id">[]) {
  const liveLeads = new Set(live.filter((x) => x.role === "lead").map((x) => x.id));
  // The column says who owns it; this only drops the link when that Lead is no longer live — an
  // orphaned worker is not a ghost row on the rail.
  const leadFor = (s: Pick<Session, "lead_id">) => (s.lead_id && liveLeads.has(s.lead_id) ? s.lead_id : null);
  const workerCounts = new Map<string, number>(); // lead session id -> live worker count
  for (const w of live) {
    const lead = leadFor(w);
    if (lead) workerCounts.set(lead, (workerCounts.get(lead) ?? 0) + 1);
  }
  return new Map(
    rows.map((s) => [
      s.id,
      {
        lead_id: leadFor(s),
        workers: s.role === "lead" ? (workerCounts.get(s.id) ?? 0) : 0,
        // How far through its plan a Lead is (lead_slices), for the quiet `3/7` on its row. Null for
        // every other terminal AND for a Lead that has not written a board — "no plan" and "nothing
        // done yet" must not draw the same.
        board: s.role === "lead" ? boardTally(s.id) : null,
      },
    ]),
  );
}

/**
 * Which of this Lead's LIVE workers a broadcast reaches. `only` is an allowlist, `except` a denylist
 * applied after it, both by id8 prefix — and both are filtered against a list that already contains
 * nothing but this Lead's own workers, so neither can name a terminal it does not own.
 */
export function broadcastTargets<T extends { id: string }>(
  workers: T[],
  sel: { only?: string[]; except?: string[] },
): T[] {
  const pick = (list: string[] | undefined) => (list ?? []).map((x) => x.trim()).filter(Boolean);
  const only = pick(sel.only), except = pick(sel.except);
  const matches = (w: T, refs: string[]) => refs.some((r) => w.id === r || w.id.startsWith(r));
  return workers.filter((w) => (!only.length || matches(w, only)) && !matches(w, except));
}

/** A Lead's board as the Desk row shows it, or null when it has not written one. */
function boardTally(leadId: string): { done: number; total: number } | null {
  const t = leadSlices.tally(leadId);
  return t.total ? t : null;
}

/**
 * The ownership columns POST /sessions stamps on a new terminal (LEADS.md) — derived from the
 * CREDENTIAL the caller presented, never from what it sent. Spread LAST over the request body so
 * nothing in the body can survive: `lead_id` decides whose pty this terminal's stops are typed into
 * and who may type into it, so a worker that could set its own would have hijacked a Lead. A Lead's
 * own workspace is forced for the same reason its workspace token forces one.
 */
export function spawnLeadFields(lead: LeadScope): { lead_id: string | null; workspace_id?: string } {
  return lead ? { lead_id: lead.leadId, workspace_id: lead.ws } : { lead_id: null };
}

/**
 * The gate on every `/api/leads/me/*` route: a live Lead's own credential and nothing else. Writes
 * the refusal and returns null when the caller is not one — 401 when no credential was offered at
 * all, 403 when one was and it is not a live Lead's (an ended Lead's burned token, a worker's).
 */
export function leadGate(req: express.Request, res: express.Response): LeadScope {
  const lead = leadScope(req);
  if (lead) return lead;
  if (!req.get("x-mc-lead")) res.status(401).json({ error: "this endpoint needs a lead credential (x-mc-lead)" });
  else res.status(403).json({ error: "not a live lead" });
  return null;
}

/**
 * Kill every live terminal whose goal is ticked. Shared by `/desk/close-done` (the whole wall) and
 * `/leads/me/close-done` (one Lead's workers only) so the two doors cannot drift.
 */
export function closeDoneSessions(filter?: (s: { id: string; lead_id: string | null }) => boolean): string[] {
  const done = sessions
    .list({ status: "live", limit: 200 })
    .filter((s) => !!s.goal_done_at && (!filter || filter(s)));
  for (const s of done) {
    try {
      killSession(s.id);
    } catch {}
  }
  return done.map((s) => s.id);
}

/**
 * One inbox row as the Lead reads it (`mc lead inbox`) — the stored payload unpacked, nothing else.
 *
 * `lines` is that row already rendered (src/lead-report.ts). Composed here rather than in `mc` so a
 * stop, a report and an ask have ONE rendering between them, asserted on without a daemon — five
 * kinds of event formatted in a shell script is how the three would have drifted apart.
 */
export function publicLeadEvent(ev: LeadEvent) {
  const p = leadEventPayload(ev);
  // An `ask` row is a pointer to a live question, and questions move on (the fallback to Robert, an
  // escalation, an answer). Read its CURRENT state so the rendered line offers `mc answer` only
  // while the Lead can actually use it. One lookup, and only for `ask` rows.
  const askId8 = ev.kind === "ask" ? (p as { ask_id8?: string }).ask_id8 : undefined;
  const asked = askId8 ? resolveAsk(askId8) : undefined;
  const askState = asked ? { status: asked.status, route: asked.route, escalated: !!asked.escalated_at } : null;
  return {
    id: ev.id,
    session_id: ev.session_id,
    id8: p.id8 ?? ev.session_id.slice(0, 8),
    kind: ev.kind,
    goal: p.goal ?? null,
    line: p.card_line ?? null,
    last_result: p.last_result ?? null,
    last_said: p.last_said ?? null,
    phase: p.phase ?? null,
    progress: p.progress ?? null,
    lines: leadEventLines(ev, askState),
    created_at: ev.created_at,
    seen_at: ev.seen_at,
    delivered_at: ev.delivered_at,
    acked_at: ev.acked_at,
  };
}

/**
 * This Lead's own workers in one screen (`mc lead workers`) — live first, then the ones it closed
 * today. Built field by field rather than spread from the row: a Lead's view of its wall has no
 * business carrying another terminal's credential, and `lead_token` is exactly what a `...w` would
 * have leaked the day the store stopped stripping it.
 */
/**
 * Cost/tokens for one session the same way `/desk/log` does: live (or never-frozen) rows read
 * `snapshotUsage`; ended rows use the frozen columns. Shared by leadWorkerRows and lead list.
 */
export function sessionCostView(s: {
  id: string;
  status: string;
  turns: number | null;
  cost_usd: number | null;
  cost_estimated?: number | boolean | null;
  tokens_in: number | null;
  tokens_out: number | null;
}) {
  const u =
    s.status === "live" || (s.turns == null && s.cost_usd == null) ? snapshotUsage(s.id) : null;
  return {
    cost_usd: u?.cost_usd ?? s.cost_usd ?? null,
    cost_estimated: u?.cost_estimated ?? !!s.cost_estimated,
    tokens_in: u?.tokens_in ?? s.tokens_in ?? null,
    tokens_out: u?.tokens_out ?? s.tokens_out ?? null,
    turns: u?.turns ?? s.turns ?? null,
  };
}

export function leadWorkerRows(leadId: string, nowMs = Date.now()) {
  const dayStart = new Date(nowMs);
  dayStart.setHours(0, 0, 0, 0);
  return sessions
    .workersOf(leadId)
    .filter((w) => w.status === "live" || (w.ended_at ? Date.parse(w.ended_at) >= dayStart.getTime() : false))
    .sort((a, b) => (a.status === b.status ? 0 : a.status === "live" ? -1 : 1))
    .map((w) => {
      const st = w.status === "live" ? statusOf(w.id) : null;
      const until = w.ended_at ? Date.parse(w.ended_at) : nowMs;
      const cost = sessionCostView(w);
      return {
        id: w.id,
        id8: w.id.slice(0, 8),
        status: w.status,
        phase: st?.phase ?? "ended",
        word: st?.word ?? "ended",
        line: st?.line ?? "",
        progress: st?.progress ?? null,
        goal: w.goal ?? w.spawn_goal ?? null,
        goal_done: !!w.goal_done_at,
        worktree_branch: w.worktree_branch ?? null,
        minutes_live: Math.max(0, Math.round((until - Date.parse(w.created_at)) / 60_000)),
        ...cost,
      };
    });
}

/** Sum cost/tokens across a Lead and its workers — what `mc lead list` prints beside the count. */
export function leadCostRollup(leadId: string) {
  const lead = sessions.get(leadId);
  const mine = lead ? sessionCostView(lead) : null;
  const workers = sessions.workersOf(leadId, { status: "live" }).map(sessionCostView);
  const all = [...(mine ? [mine] : []), ...workers];
  const sum = (k: "cost_usd" | "tokens_in" | "tokens_out" | "turns") =>
    all.reduce((a, r) => a + (typeof r[k] === "number" ? (r[k] as number) : 0), 0);
  return {
    cost_usd: Number(sum("cost_usd").toFixed(4)),
    tokens_in: sum("tokens_in"),
    tokens_out: sum("tokens_out"),
    turns: sum("turns"),
    workers: workers.length,
    cost_estimated: all.some((r) => r.cost_estimated),
  };
}

/**
 * Hand a finished Lead's live workers + board + inbox to a live Lead (`mc lead adopt`).
 * Callers must already have checked workspace + ended status.
 */
export function adoptLead(toLeadId: string, fromLeadId: string): { workers: number; slices: number; events: number } {
  const workers = sessions.reassignLiveWorkers(fromLeadId, toLeadId);
  const slices = leadSlices.reassign(fromLeadId, toLeadId);
  const events = leadEvents.reassign(fromLeadId, toLeadId);
  return { workers, slices, events };
}

export function startServer() {
  const app = express();
  // 16mb: ticket attachment base64 uploads; normal JSON stays small.
  app.use(express.json({ limit: "16mb" }));

  const api = express.Router();
  // Requests an agent on another computer made through its host (HOSTS.md): remote, never loopback-
  // trusted, and bound to their own session and host. A no-op for everything else.
  api.use(forwardedGate);

  api.get("/backends", (_req, res) => {
    res.json(listBackends());
  });

  // Auth status for a backend (e.g. is cursor-agent logged in?).
  api.get("/backends/:name/auth", async (req, res) => {
    try {
      const b = getBackend(req.params.name);
      const authenticated = b.checkAuth ? await b.checkAuth() : true;
      res.json({ name: b.name, authenticated, canLogin: !!b.login });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  // Repos the Cursor GitHub App can see for this workspace — the spawn picker's disable/tooltip
  // gate for cursor-cloud (cached server-side 10 min in src/desk-cloud.ts; Cursor's own endpoint
  // allows 1 req/min, so an uncached passthrough would rate-limit the whole Desk).
  api.get("/backends/cursor-cloud/repos", async (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const wsId = scope.ws ?? (req.query.workspace_id as string | undefined);
    if (!wsId) return res.status(400).json({ error: "workspace_id required" });
    const { repos: list, error } = await cloudVisibleRepos(wsId);
    res.json({
      repos: (list ?? []).map((r) => r.fullName ?? r.url ?? r.name ?? "").filter(Boolean),
      configured: list !== null || error !== null,
      error,
    });
  });

  // Drive an interactive CLI login (opens a browser); resolves when the session is established.
  api.post("/backends/:name/login", async (req, res) => {
    const b = getBackend(req.params.name);
    if (!b.login) return res.status(400).json({ error: `${b.name} has no login flow` });
    try {
      const r = await b.login();
      res.json(r);
    } catch (e: any) {
      res.status(500).json({ ok: false, message: String(e?.message ?? e) });
    }
  });

  // ───────────────────────────── Mission Control: terminal sessions ─────────────────────────────
  api.get("/sessions", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    res.json(
      sessions.list({
        ticket_id: req.query.ticket as string | undefined,
        status: req.query.status as string | undefined,
        workspace_id: scope.ws ?? (req.query.workspace as string | undefined),
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      })
    );
  });
  api.get("/sessions/:id", (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, s.workspace_id)) return;
    res.json({ ...s, host_offline: sessionHostOffline(s) });
  });
  api.post("/sessions", validate(OpenSessionSchema), async (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    if (scope.ws !== null) {
      if (req.body?.workspace_id && req.body.workspace_id !== scope.ws)
        return res.status(403).json({ error: "workspace token does not match requested workspace" });
      req.body = { ...req.body, workspace_id: scope.ws };
    }
    const lead = leadScope(req);
    // No nesting (LEADS.md): a Lead is Robert's deputy for one goal, not a spawner of other Leads.
    if (req.body?.role === "lead" && lead)
      return res.status(403).json({ error: "a lead may not open a lead" });
    try {
      // Who opened it, for the day's log. The caller may name itself (`mc session new` passes its
      // agent name); anything else is the operator at the wall. `created_by` is only that label now —
      // ownership is spawnLeadFields' `lead_id`, and OpenSessionSchema has no `lead_id` for zod to
      // let through from the body in the first place.
      const { slice, ...body } = req.body || {};
      const openOpts = {
        ...body,
        created_by: req.body?.created_by || "operator",
        ...spawnLeadFields(lead),
      };
      // Which computer (HOSTS.md → Placement). A pin names one, by id or name; Auto (no host_id)
      // leaves it to place() inside openSession — the same function every other open goes through
      // (mc session new, Robert, Leads, failover stand-ins, revives). A pin is checked there too:
      // connected, allowed (brain lock #1), able to run it; a refusal carries its own status below.
      if (body?.host_id && body.host_id !== LOCAL_HOST_ID) {
        const hid = resolveHostRef(String(body.host_id));
        if (!hid) return res.status(404).json({ error: `no host \`${body.host_id}\` has connected to this brain` });
        if (wantsCloudBackend(body?.backend)) return res.status(400).json({ error: "a cloud terminal runs on its provider's VM, not on a host" });
        openOpts.host_id = hid;
      } else {
        openOpts.host_id = body?.host_id === LOCAL_HOST_ID ? LOCAL_HOST_ID : null;
      }
      // A cloud terminal has no pty: it is a dispatched run on someone else's VM, not a spawned
      // process (see src/desk-cloud.ts). Routed on the NAME, not just isCloudBackend(getBackend()) —
      // a caller asking for "cursor-cloud" before its module is registered must fail closed here
      // instead of silently falling through to openSession(), which would spawn a claude-code pty
      // under a session row labeled cursor-cloud.
      const s = wantsCloudBackend(body?.backend) ? await openCloudSession(openOpts) : await openSession(openOpts);
      // `--slice n` from a Lead: link the new worker to that slice of ITS OWN board and start it.
      // Stamped here, from the credential, for the same reason `lead_id` is — and silently ignored
      // without one, because a worker naming a slice number is naming a board it cannot see.
      if (lead && slice) leadSlices.patch(lead.leadId, slice, { session_id: s.id, status: "doing" });
      res.status(201).json(s);
    } catch (e: any) {
      // A placement refusal knows its status: 403 for a workspace a computer may not run, 409 for a
      // computer that cannot take it now, 400 for "every computer is full" (as a saturated brain was).
      res.status(e instanceof PlacementError ? e.status : 400).json({ error: String(e?.message ?? e) });
    }
  });
  // Desk wall: retitle a terminal or set/clear/tick its goal. The goal is the terminal's reason to
  // exist ("open the flyway rollback PR") — the operator sets it here, the agent refines it with
  // `mc goal set`, and either can tick it off.
  //
  // A terminal may have been given SEVERAL goals (src/goals.ts). When it has, this endpoint speaks
  // for the current one: a `goal` rewrites the item on the card, and `goal_done` ticks it and moves
  // the card to the next — the terminal is only closed out when that tick was the last one.
  api.patch("/sessions/:id", validate(SessionPatchSchema), (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, s.workspace_id)) return;
    const { goal, goal_done, goal_done_all, goal_kind, goal_source, title } = req.body ?? {};
    const current = sessionGoals.current(s.id);
    if (goal !== undefined || goal_kind !== undefined) {
      if (current && goal !== null) {
        // Retitling the card retitles the goal it is showing, not some fourth copy of the words.
        sessionGoals.patch(current.id, {
          ...(goal !== undefined ? { text: goal } : {}),
          ...(goal_kind !== undefined ? { kind: goal_kind } : {}),
          // Same rule as the single-goal column write: a rename with no stated source is the
          // operator's, and that is what stops the title deriver renaming it again (desk-title.ts).
          ...(goal !== undefined || goal_source !== undefined ? { source: goal_source ?? "human" } : {}),
        });
        syncGoalMirror(s.id);
      } else {
        // `goal: null` on a list means "drop the list" — the operator clearing the card clears it.
        if (current && goal === null) sessionGoals.clear(s.id);
        sessions.setGoal(s.id, { goal, goal_kind, goal_source });
      }
    }
    // "Done" is the moment worth recording: freeze what this terminal spent and write what it did,
    // while the transcript is warm. Waiting for the pty to die means the row is written whenever the
    // window happens to be closed — often days later, sometimes never.
    if (goal_done === true) {
      const t = goal_done_all ? tickAllGoals(s.id) : tickCurrentGoal(s.id);
      if (t.finished && !s.goal_done_at) closeOutSession(s.id, { cwd: s.cwd });
    } else if (goal_done === false) {
      reopenGoal(s.id);
    }
    if (title !== undefined) sessions.setMeta(s.id, { title });
    bus.publish({ topic: "session.updated", session_id: s.id });
    res.json(sessions.get(s.id));
  });
  // The terminal's goal LIST. One terminal, several finish lines, worked in order — `mc goal add`,
  // the spawn dialog's extra lines, a Lead handing its worker the three things it needs done.
  api.get("/sessions/:id/goals", (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, s.workspace_id)) return;
    res.json({ goals: sessionGoals.list(s.id), current: sessionGoals.current(s.id) ?? null });
  });
  // Append one or more (`goals: [...]`), or replace the list outright (`replace: true`).
  api.post("/sessions/:id/goals", validate(SessionGoalsSchema), (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, s.workspace_id)) return;
    const body = req.body ?? {};
    const items: Array<{ text: string; kind?: GoalKind | null }> = (body.goals ?? []).map(
      (g: string | { text: string; kind?: GoalKind | null }) => (typeof g === "string" ? { text: g } : g),
    );
    try {
      const out = body.replace
        ? setGoals(s.id, items, body.source ?? "human")
        : addGoals(s.id, items, body.source ?? "human");
      bus.publish({ topic: "session.updated", session_id: s.id });
      res.status(201).json({ goals: out.goals, session: out.session });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });
  // Edit one item: retitle it, reshape it, tick or untick it. Ticking the LAST open one closes the
  // terminal out exactly as `mc goal done` on a single-goal terminal does.
  api.patch("/sessions/:id/goals/:goalId", validate(SessionGoalPatchSchema), (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, s.workspace_id)) return;
    const g = sessionGoals.get(req.params.goalId);
    if (!g || g.session_id !== s.id) return res.status(404).json({ error: "no such goal" });
    try {
      sessionGoals.patch(g.id, req.body ?? {});
      syncGoalMirror(s.id);
      if (req.body?.done === true && sessionGoals.allDone(s.id) && !s.goal_done_at)
        closeOutSession(s.id, { cwd: s.cwd });
      bus.publish({ topic: "session.updated", session_id: s.id });
      res.json({ goals: sessionGoals.list(s.id), session: sessions.get(s.id) });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });
  api.delete("/sessions/:id/goals/:goalId", (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, s.workspace_id)) return;
    const g = sessionGoals.get(req.params.goalId);
    if (!g || g.session_id !== s.id) return res.status(404).json({ error: "no such goal" });
    sessionGoals.remove(g.id);
    syncGoalMirror(s.id);
    bus.publish({ topic: "session.updated", session_id: s.id });
    res.json({ goals: sessionGoals.list(s.id), session: sessions.get(s.id) });
  });
  // What a terminal says about itself (term-status.ts): `mc state`, `mc progress`, and the lifecycle
  // hooks its CLI fires (`mc hook`). Workspace-scoped like the goal: an agent speaks only for its own card.
  api.get("/sessions/:id/status", (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, s.workspace_id)) return;
    res.json({ ...statusOf(s.id), host_offline: sessionHostOffline(s) });
  });
  api.post("/sessions/:id/status", validate(SessionStatusSchema), (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, s.workspace_id)) return;
    res.json(declareStatus(s.id, req.body));
  });
  // `mc report` — a worker hands its slice back to its Lead in a shape (src/lead-report.ts).
  // Workspace-scoped exactly like /status: this is a terminal speaking about its own work, and the
  // Lead it reaches is read from the row's server-stamped `lead_id`, never from the request.
  api.post("/sessions/:id/report", validate(ReportSchema), (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, s.workspace_id)) return;
    const out = fileReport(s.id, req.body);
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    res.status(201).json({ ok: true, event: publicLeadEvent(out.event), slice: out.slice });
  });
  api.post("/sessions/:id/progress", validate(SessionProgressSchema), (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, s.workspace_id)) return;
    const { n, of, label } = req.body;
    if (n != null && (of == null || n > of)) return res.status(400).json({ error: "progress needs n <= of" });
    res.json(setProgress(s.id, n == null ? null : { n, of: of!, label: label ?? null }));
  });
  api.post("/sessions/:id/hook", validate(SessionHookSchema), (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, s.workspace_id)) return;
    const status = applyHook(s.id, req.body);
    if (req.body.event === "session_end") forgetMemorySeen(s.id);
    // A ★ memo changed since this terminal's prompt was baked: hand the new text back for the CLI
    // hook to print as context on the prompt being submitted.
    const memory_notice = req.body.event === "prompt" ? memoryNotice(s.id) : "";
    res.json(memory_notice ? { ...(status ?? {}), memory_notice } : status);
  });
  // Type into a live terminal without holding its websocket. Admin-gated on purpose: a workspace
  // token is a client boundary, and driving another client's agent from inside a workspace would
  // walk straight through it. The Desk's quick actions and an overseeing agent both come through here.
  api.post("/sessions/:id/input", validate(SessionInputSchema), (req, res) => {
    // Admin token, checked here rather than via requireAdmin (declared further down this file) — OR
    // a live Lead typing into A TERMINAL IT OWNS (LEADS.md): the one thing a Lead may do that a plain
    // workspace token cannot, and the one thing a worker may never do to a peer.
    //
    // Owns = `sessions.lead_id`, stamped by the daemon at spawn. Narrower than "any terminal of my
    // workspace", which is what this used to be: that let one Lead type into another Lead's workers
    // and into the operator's own terminals — all of them peers behind the same workspace wall.
    // Anything it does not own is the same 404 a wrong-workspace caller gets, so a Lead cannot map
    // the wall by probing ids. (`lead_id === leadId` also rules out the Lead typing into itself: its
    // own lead_id is null.) The workspace check stays as a second wall in case a row ever crosses.
    const admin = tokenOk(req.get("x-mc-admin"), CONFIG.adminToken);
    const lead = admin ? null : leadScope(req);
    if (!admin && !lead)
      return res.status(403).json({ error: "typing into a terminal is admin-gated (x-mc-admin)" });
    const s = sessions.get(req.params.id);
    if (!s || (lead && !leadMayType(lead, s))) return res.status(404).json({ error: "not found" });
    // A cloud session has no tty to write keystrokes into — the composer's message maps to a
    // follow-up turn on the same cloud agent instead (src/desk-cloud.ts). Keys/nav sequences make
    // no sense there either, so only free text is honored.
    if (s.cloud_agent_id) {
      if (!req.body?.text) return res.status(409).json({ error: "a cloud terminal only takes text — no keys" });
      const r = followUpCloudSession(s, req.body.text);
      if ("error" in r) return res.status(409).json({ error: r.error });
      return res.json({ ok: true, run_id: r.run_id });
    }
    const err = sendInput(req.params.id, req.body, req.body.by || "operator");
    if (err) return res.status(err.startsWith("rate limit") ? 429 : 409).json({ error: err });
    res.json({ ok: true });
  });
  // A file dragged from Finder onto this terminal on the Desk (or an image pasted into it): raw
  // bytes in, an absolute path out, which the page then types in as a word. Raw body rather than
  // multipart because that is what every other upload here takes (/agent/upload,
  // /tickets/:id/attachments/raw) and a Blob needs no encoding to send that way.
  //
  // Admin-gated with the same inline check as /input above (requireAdmin is a const declared
  // further down this file). Deliberately NOT open to a Lead, which /input is: a Lead types words
  // it composed itself, whereas a drop writes attacker-chosen bytes to a path it then hands another
  // agent. Only the operator at the Desk drops files.
  api.post(
    "/sessions/:id/drop",
    express.raw({ type: () => true, limit: MAX_DROP_BYTES }),
    async (req, res) => {
      if (!tokenOk(req.get("x-mc-admin"), CONFIG.adminToken))
        return res.status(403).json({ error: "dropping a file on a terminal is admin-gated (x-mc-admin)" });
      const s = sessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: "not found" });
      // A terminal on another host reads files from ITS disk: the bytes go over the link, the host
      // writes them into its own ~/.mc/drops/<session>, and that path is what gets typed in.
      if (s.host_id && s.host_id !== LOCAL_HOST_ID) {
        const h = findHost(s.host_id);
        if (!(h instanceof RemoteHost) || !h.online) return res.status(409).json({ error: "this terminal's host is offline" });
        const buf = req.body as Buffer;
        if (!buf?.length) return res.status(400).json({ error: "empty file" });
        // One control frame carries it (base64, ×4/3) and the link caps a frame at 24 MB.
        if (buf.length > REMOTE_DROP_MAX) return res.status(413).json({ error: `a file dropped on a terminal on another host is capped at ${REMOTE_DROP_MAX / 1024 / 1024}MB` });
        try {
          const d = await h.drop({
            session_id: s.id,
            filename: String(req.get("x-filename") || req.query.filename || "drop"),
            mime: String(req.get("content-type") || ""),
            b64: buf.toString("base64"),
          });
          return res.status(201).json(d);
        } catch (e: any) {
          return res.status(400).json({ error: String(e?.message ?? e) });
        }
      }
      try {
        res.status(201).json(
          saveDrop({
            sessionId: s.id,
            buffer: req.body as Buffer,
            filename: String(req.get("x-filename") || req.query.filename || "drop"),
            mime: String(req.get("content-type") || ""),
          }),
        );
      } catch (e: any) {
        res.status(400).json({ error: String(e?.message ?? e) });
      }
    },
  );
  // ───────────────────────── Worktrees ─────────────────────────
  // A terminal CLAIMS its worktree once it knows which repo it needs. Scoped, not admin-gated: this
  // is an agent isolating its own work, the safest thing it can do. Idempotent — asking twice
  // returns the same path, so a confused agent gets one checkout, not four.
  api.post("/sessions/:id/worktree", validate(ClaimWorktreeSchema), async (req, res) => {
    const sess = sessions.get(req.params.id);
    if (!sess) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, sess.workspace_id)) return;
    if (sess.status !== "live") return res.status(409).json({ error: "that terminal has ended" });
    // Name it by repo name, id, or path — the agent knows the repo by whatever the task called it.
    const ref = String(req.body.repo).trim();
    const candidates = repos.list(sess.workspace_id ?? undefined);
    const repo =
      candidates.find((r) => r.id === ref) ??
      candidates.find((r) => r.name?.toLowerCase() === ref.toLowerCase()) ??
      candidates.find((r) => r.path === ref || path.resolve(r.path) === path.resolve(ref)) ??
      candidates.find((r) => r.name?.toLowerCase().includes(ref.toLowerCase()));
    if (!repo)
      return res.status(404).json({
        error: `no repo matching "${ref}" in this workspace`,
        available: candidates.map((r) => r.name),
      });
    // A terminal on another host claims its worktree THERE, under that host's own checkout of the
    // repo (found by git remote). The brain only picks the branch name, exactly as it would here.
    if (sess.host_id && sess.host_id !== LOCAL_HOST_ID) {
      const h = findHost(sess.host_id);
      if (!(h instanceof RemoteHost) || !h.online) return res.status(409).json({ error: "this terminal's host is offline" });
      if (!repo.git_remote) return res.status(409).json({ error: `${repo.name} has no git remote, so its host cannot find its checkout` });
      const branch = await remoteWorktreeBranch(sess, req.body.as);
      try {
        const got = await h.claimWorktree({ session_id: sess.id, git_remote: repo.git_remote, branch, base: repo.default_branch });
        const updated = sessions.setWorktree(sess.id, { path: got.path, branch, repo_id: repo.id });
        bus.publish({ topic: "session.updated", session_id: sess.id });
        return res.status(201).json({ path: got.path, branch, repo: repo.name, session: updated });
      } catch (e: any) {
        return res.status(409).json({ error: String(e?.message ?? e) });
      }
    }
    const wt = await ensureSessionWorktree(repo, sess, req.body.as);
    if (!wt)
      return res.status(409).json({ error: `could not create a worktree in ${repo.name} (not a git repo, or the branch is checked out elsewhere)` });
    const updated = sessions.setWorktree(sess.id, { path: wt.path, branch: wt.branch, repo_id: repo.id });
    bus.publish({ topic: "session.updated", session_id: sess.id });
    res.status(201).json({ path: wt.path, branch: wt.branch, repo: repo.name, session: updated });
  });

  // Every Chronos worktree, with what each is holding — the read behind any delete decision.
  api.get("/worktrees", async (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    res.json({ worktrees: await listAllWorktrees(scope.ws ?? undefined) });
  });

  // Deleting one is Robert's (admin-gated, exactly like typing into a terminal) — except that a
  // terminal may remove the ONE tree it claimed, by naming its own session, and a Lead may remove a
  // tree one of ITS workers claimed (live or ended). Any other terminal's checkout is still refused:
  // a workspace token is a client boundary, and a worker must never be able to remove the tree
  // another worker is holding. Refused — with what would be lost named — rather than asked, so an
  // unsafe delete becomes a sentence for the operator instead of a judgment call made alone.
  // `force` exists for when the operator (or the owner, on its own work) says yes; a Lead may never
  // force a worker's tree (LEADS.md Powers).
  api.delete("/worktrees", validate(RemoveWorktreeSchema), async (req, res) => {
    const out = await removeWorktreeAs(
      {
        admin: tokenOk(req.get("x-mc-admin"), CONFIG.adminToken),
        scope: callerScope(req),
        session: req.body.session,
        agent: req.get("x-mc-agent"),
        lead: leadScope(req),
      },
      String(req.body.path),
      { force: !!req.body.force },
    );
    if (out.removed) {
      const { path: p, branch, by, session_id } = out.removed;
      // `actor` so activity.ts records the Lead (or Robert / the owner) — `by` alone is not enough
      // for worktree.removed (actorFor only special-cases session.input).
      bus.publish({ topic: "worktree.removed", path: p, branch, by, actor: by });
      if (session_id) bus.publish({ topic: "session.updated", session_id });
    }
    res.status(out.status).json(out.body);
  });

  // ───────────────────────── Lead inbox (LEADS.md) ─────────────────────────
  // A Lead's own view of its own workers, authenticated by the `x-mc-lead` credential alone
  // (leadGate) and scoped strictly to `leadScope.leadId` — never to its workspace. Two Leads in one
  // client are two walls: neither may read the other's inbox or list the other's terminals.
  //
  // Long-poll for the next worker event, capped at 55s like GET /asks/:id/wait (under Express/proxy
  // idle timeouts); `mc lead wait` loops it to cover its full wait. Returns at once when something is
  // already unseen, and everything it returns is marked seen — a pulling Lead is never also typed at.
  api.get("/leads/me/events/wait", async (req, res) => {
    const lead = leadGate(req, res);
    if (!lead) return;
    const timeoutMs = Math.max(0, Math.min(Number(req.query.timeout_ms) || 55_000, 55_000));
    const waiter = waitForLeadEvents(lead.leadId, timeoutMs);
    // A Lead that ctrl-C'd out of `mc lead wait` must not leave a waiter holding its inbox: the next
    // event would resolve a promise nobody is reading and never be typed as a digest either.
    // `req` "close" is safe HERE only because this is a bodiless GET — on a route with a body it
    // fires as soon as the body has been read, which abandoned every parked POST the day we tried
    // it. A POST long-poll must use `res.on("close")` guarded by `!res.writableEnded`.
    req.on("close", waiter.cancel);
    res.json({ events: (await waiter.events).map(publicLeadEvent) });
  });

  // The inbox: what is still outstanding (nothing typed into that worker since), or `all=1` for the
  // recent history whatever its state.
  api.get("/leads/me/events", (req, res) => {
    const lead = leadGate(req, res);
    if (!lead) return;
    const all = req.query.all === "1" || req.query.all === "true";
    const limit = Number(req.query.limit) || undefined;
    res.json({ events: leadEvents.recent(lead.leadId, { all, limit }).map(publicLeadEvent) });
  });

  api.get("/leads/me/workers", (req, res) => {
    const lead = leadGate(req, res);
    if (!lead) return;
    const workers = leadWorkerRows(lead.leadId);
    // Cost/tokens the same way /desk/log computes them — per worker, plus a rollup that includes
    // the Lead itself so `mc lead workers` / `mc lead list` can show what this goal has spent.
    const me = sessions.get(lead.leadId);
    res.json({
      workers,
      lead: me ? sessionCostView(me) : null,
      totals: leadCostRollup(lead.leadId),
    });
  });

  // Take over a finished Lead's live workers + board + inbox in THIS workspace. The old Lead must
  // have ended — a live Lead's workers are still its own. Renumbers board slices onto the caller's
  // board so UNIQUE(lead_id, n) cannot collide.
  api.post("/leads/me/adopt", validate(LeadAdoptSchema), (req, res) => {
    const lead = leadGate(req, res);
    if (!lead) return;
    const ref = String(req.body.lead_id || "");
    const old =
      sessions.list({ workspace_id: lead.ws, limit: 500 }).find(
        (s) => s.role === "lead" && (s.id === ref || s.id.startsWith(ref)),
      ) ?? null;
    if (!old || old.workspace_id !== lead.ws) return res.status(404).json({ error: "not found" });
    if (old.id === lead.leadId) return res.status(400).json({ error: "cannot adopt yourself" });
    if (old.status === "live") return res.status(409).json({ error: "that Lead is still live — only an ended Lead can be adopted" });
    const out = adoptLead(lead.leadId, old.id);
    const by = `lead:${lead.leadId.slice(0, 8)}`;
    bus.publish({
      topic: "lead.adopted",
      lead_id: lead.leadId,
      from_lead_id: old.id,
      workers: out.workers,
      slices: out.slices,
      events: out.events,
      by,
      actor: by,
      workspace_id: lead.ws,
    });
    res.json({ ...out, from: old.id, to: lead.leadId });
  });

  // One sentence to several workers at once (`mc lead broadcast`). Measured 2026-09-18: a Lead typed
  // the same standing instruction into five workers one at a time. Not a new power — it is the same
  // `sendInput` the Lead already has per worker, spaced out and reported per worker: each keystroke
  // still counts against THAT worker's per-minute cap, and a 429 for one is a line in the result,
  // never the end of the broadcast (the whole point is that one busy worker cannot silence the rest).
  api.post("/leads/me/broadcast", validate(LeadBroadcastSchema), async (req, res) => {
    const lead = leadGate(req, res);
    if (!lead) return;
    const targets = broadcastTargets(sessions.workersOf(lead.leadId, { status: "live" }), req.body);
    const by = `lead:${lead.leadId.slice(0, 8)}`;
    const sent: { id8: string; ok: boolean; error?: string }[] = [];
    for (const w of targets) {
      // ≥300ms apart: sendInput writes Enter 200ms after the text, so two workers typed at back to
      // back through one process is fine — but a Lead's own pacing (LEAD_GAP_MS) taught us not to
      // trust that, and a broadcast is the one place N keystrokes leave in one call.
      if (sent.length) await new Promise((r) => setTimeout(r, BROADCAST_GAP_MS));
      const err = sendInput(w.id, { text: req.body.text }, by);
      sent.push({ id8: w.id.slice(0, 8), ok: !err, ...(err ? { error: err } : {}) });
    }
    res.json({ sent });
  });

  // ───────────────────────── The Lead's board (LEADS.md) ─────────────────────────
  // The plan as ROWS, so it survives a compaction: `mc lead board` after any confusion rebuilds the
  // picture the Lead's context window lost. Gated and scoped like the inbox — its own board, never
  // its neighbour's, and never its workspace's.
  api.get("/leads/me/board", (req, res) => {
    const lead = leadGate(req, res);
    if (!lead) return;
    res.json({ slices: leadSlices.list(lead.leadId), ...leadSlices.tally(lead.leadId) });
  });

  api.post("/leads/me/board", validate(BoardAddSchema), (req, res) => {
    const lead = leadGate(req, res);
    if (!lead) return;
    res.status(201).json(leadSlices.add(lead.leadId, req.body.title));
  });

  api.patch("/leads/me/board/:n", validate(BoardPatchSchema), (req, res) => {
    const lead = leadGate(req, res);
    if (!lead) return;
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "a slice is numbered 1, 2, 3…" });
    // The one field that is not the Lead's to say freely: a slice may only point at a terminal this
    // Lead owns. Otherwise a Lead's board would be a way to name (and, through /desk, to watch)
    // another Lead's workers — the same ownership wall leadMayType is.
    const ref = req.body.session_id;
    let session_id = ref;
    if (ref) {
      const own = sessions.workersOf(lead.leadId).find((w) => w.id === ref || w.id.startsWith(ref));
      if (!own) return res.status(404).json({ error: "not one of your workers" });
      session_id = own.id;
    }
    const out = leadSlices.patch(lead.leadId, n, { ...req.body, ...(ref !== undefined ? { session_id } : {}) });
    if (!out) return res.status(404).json({ error: `no slice ${n} on your board` });
    res.json(out);
  });

  // Close only THIS Lead's live workers whose goal is ticked — the same door as /desk/close-done,
  // scoped to workersOf(leadId). Never the whole Desk (that stays admin). Optional
  // `rm_worktrees` tries a non-force remove of each closed worker's claim and reports every refusal
  // (a Lead may not force — LEADS.md Powers).
  api.post("/leads/me/close-done", async (req, res) => {
    const lead = leadGate(req, res);
    if (!lead) return;
    const by = `lead:${lead.leadId.slice(0, 8)}`;
    const closed = closeDoneSessions((s) => s.lead_id === lead.leadId);
    bus.publish({ topic: "lead.close-done", lead_id: lead.leadId, closed, by, actor: by });
    const rm = req.body?.rm_worktrees === true || req.body?.rm_worktrees === "1";
    const worktrees: { id8: string; ok: boolean; error?: string; path?: string }[] = [];
    if (rm) {
      for (const id of closed) {
        const s = sessions.get(id);
        const ref = s?.worktree_path || s?.worktree_branch;
        if (!ref) {
          worktrees.push({ id8: id.slice(0, 8), ok: true });
          continue;
        }
        const out = await removeWorktreeAs(
          { admin: false, scope: { ws: lead.ws }, lead },
          ref,
          { force: false },
        );
        if (out.removed) {
          bus.publish({
            topic: "worktree.removed",
            path: out.removed.path,
            branch: out.removed.branch,
            by: out.removed.by,
            actor: out.removed.by,
          });
          if (out.removed.session_id) bus.publish({ topic: "session.updated", session_id: out.removed.session_id });
        }
        worktrees.push({
          id8: id.slice(0, 8),
          ok: out.status === 200,
          ...(out.status === 200
            ? { path: out.removed?.path }
            : { error: String(out.body?.error ?? JSON.stringify(out.body)) }),
        });
      }
    }
    res.json({ closed, ...(rm ? { worktrees } : {}) });
  });

  // A standing watch: Robert re-reads THIS terminal every N minutes and reports on Telegram. Scoped,
  // not admin-gated — a watch only ever reads a terminal and messages the operator, so a workspace
  // agent may arm one on its own work. Lifting it is the same call with every_min: null.
  api.post("/sessions/:id/watch", validate(WatchSchema), (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, s.workspace_id)) return;
    const raw = req.body.every_min;
    if (raw === null) {
      const off = sessions.setWatch(s.id, { every_min: null });
      bus.publish({ topic: "session.updated", session_id: s.id });
      return res.json({ ok: true, watching: false, session: off });
    }
    const every = parseEvery(raw);
    if (every == null)
      return res.status(400).json({ error: `not an interval: ${JSON.stringify(raw)} — try 5, "10m" or "1h"` });
    if (s.status !== "live")
      return res.status(409).json({ error: "that terminal has ended — nothing to watch" });
    const updated = sessions.setWatch(s.id, {
      every_min: every,
      note: req.body.note ?? null,
      by: req.body.by ?? "operator",
    });
    bus.publish({ topic: "session.updated", session_id: s.id });
    res.json({ ok: true, watching: true, every_min: every, session: updated });
  });
  // Every check Robert made on this terminal, newest first — the Desk's "earlier checks".
  api.get("/sessions/:id/watch", (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, s.workspace_id)) return;
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    res.json({ watch: watchView(s), reports: sessions.watchReports(s.id, limit) });
  });
  api.delete("/sessions/:id/watch", (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, s.workspace_id)) return;
    const off = sessions.setWatch(s.id, { every_min: null });
    bus.publish({ topic: "session.updated", session_id: s.id });
    res.json({ ok: true, watching: false, session: off });
  });
  // ───────────────────────────── Clipboard ─────────────────────────────
  // What the operator just copied, readable by an agent that has no clipboard of its own. Scoped like any
  // other read: the daemon is the one with hands on the Mac, so this works for a sandboxed agent
  // too. Every call is a `clipboard.read` bus event naming the caller — the content never is.
  api.get("/clipboard", async (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    if (!clipboardEnabled()) return res.status(403).json({ error: "clipboard access is disabled (CHRONOS_CLIPBOARD=0)" });
    try {
      const by = String(req.get("x-mc-agent") || req.query.by || "agent");
      const { text, describe } = await readClipboard(by);
      res.json({ text, chars: text.length, describe });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });
  api.post("/clipboard", validate(ClipboardSchema), async (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    if (!clipboardEnabled()) return res.status(403).json({ error: "clipboard access is disabled (CHRONOS_CLIPBOARD=0)" });
    try {
      const by = String(req.get("x-mc-agent") || req.body.by || "agent");
      const { describe } = await writeClipboard(req.body.text, by);
      res.json({ ok: true, describe });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });
  api.post("/sessions/:id/kill", (req, res) => {
    const s = sessions.get(req.params.id);
    if (s && !checkScope(req, res, s.workspace_id)) return;
    // No pid to signal — stop the underlying run instead, so the cloud agent actually stops
    // instead of just going unwatched. killSession() below still ends the session row either way.
    if (s?.cloud_agent_id) {
      const run = cloudRunFor(s);
      if (run) stopRun(run.id);
    }
    killSession(req.params.id);
    res.json({ ok: true });
  });
  // Resume an ended terminal: reopen a fresh pty that --resumes the same transcript (Focus + history intact).
  // A Lead may reopen ONLY its own workers (`lead_id` stays on the row through revive; openSession
  // re-injects leadWorkerBlock + MC_LEAD_ID). Another Lead's worker is the same 404 as a wrong
  // workspace — ids stay unprobeable.
  api.post("/sessions/:id/resume", validate(ResizeSchema), async (req, res) => {
    try {
      const old = sessions.get(req.params.id);
      if (!old) return res.status(404).json({ error: "not found" });
      const lead = req.get("x-mc-lead") ? leadScope(req) : null;
      if (lead) {
        if (!leadMayType(lead, old)) return res.status(404).json({ error: "not found" });
      } else if (!checkScope(req, res, old.workspace_id)) return;
      if (old.status === "live") return res.status(409).json({ error: "already live" });
      const s = await openSession({ ...resumeOpts(old), cols: req.body?.cols, rows: req.body?.rows });
      if (lead) {
        const by = `lead:${lead.leadId.slice(0, 8)}`;
        bus.publish({ topic: "session.reopened", session_id: s.id, by, actor: by, workspace_id: lead.ws });
      }
      res.status(201).json(s);
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });
  // Desk right-click → Promote to Lead: the same terminal, reopened under its own id as a Lead
  // (terminal.ts promoteToLead). No nesting, as for `POST /sessions`: a Lead may not make a Lead.
  api.post("/sessions/:id/promote-lead", validate(ResizeSchema), async (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, s.workspace_id)) return;
    if (req.get("x-mc-lead")) return res.status(403).json({ error: "a lead may not open a lead" });
    const why = leadPromotionError(s);
    if (why) return res.status(409).json({ error: why });
    try {
      res.json(await promoteToLead(s.id, { cols: req.body?.cols, rows: req.body?.rows }));
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });
  // Focus view backfill: the plain-English feed parsed from the session transcript. Live deltas arrive
  // over /ws as {topic:"focus.event", session_id, event}.
  api.get("/sessions/:id/focus", (req, res) => {
    const s = sessions.get(req.params.id);
    if (s && !checkScope(req, res, s.workspace_id)) return;
    res.json({ live: isLive(req.params.id), events: focusEvents(req.params.id) });
  });

  // What this terminal has produced that outlives its scrollback: the PRs it opened (with whether
  // they are merged yet) and the documents it wrote. The companion rail pins these — see
  // src/session-artifacts.ts for where each one comes from and what a `gh` lookup costs.
  api.get("/sessions/:id/artifacts", async (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, s.workspace_id)) return;
    // `urls`: PR links the Desk read off this terminal's own screen (`gh pr create` prints the URL and
    // the Focus feed carries no tool results). Untrusted input, so it is filtered to real PR URLs and
    // capped before anything is handed to `gh` — isPrUrl is the same guard delivery.ts merges behind.
    const seen = String(req.query.urls ?? "").split(",").map((u) => u.trim()).filter(isPrUrl).slice(0, 8);
    try {
      recordSessionPrs(s, seen);
      res.json(await sessionArtifacts(s, focusEvents(s.id), seen));
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  // ───────────────────────────── Desk wall ─────────────────────────────
  // One fetch for the whole wall: the clients you work for, what each can spawn, and every terminal
  // with its live turn state. Deltas after this arrive on /ws (session.* + focus.event), so the wall
  // polls this once on load and on reconnect — not on a timer.
  api.get("/desk", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const wsList = workspaces.list().filter((w) => !scope.ws || w.id === scope.ws);
    // History sleeps in SQLite. The log endpoint pages it on demand and /restart revives one row;
    // bootstrapping every completed goal here made each Desk refresh do O(all history) work.
    const rows = activeDeskSessions(scope.ws);
    const leadFields = deskLeadFields(rows, rows);
    res.json({
      workspaces: wsList.map((w) => ({
        id: w.id,
        slug: w.slug,
        name: w.name,
        default_backend: w.default_backend,
        default_model: w.default_model,
        config_dir: w.config_dir,
        // The plan-tomorrow picker ticks the clients you actually work in — kind client, with a home dir.
        kind: w.kind,
        default_dir: w.default_dir,
        // What this client may actually spawn. The picker reads THIS, not the global list — only
        // claude and codex carry a per-workspace config dir, so the others would put a client's work
        // through the one shared login. Enforced at spawn too (openSession); this just stops the
        // dialog offering something the daemon will refuse.
        backends: workspaceBackends(w.backends),
        // git_remote rides along so the picker can tell whether cursor-cloud may offer this repo at
        // all (GET /backends/cursor-cloud/repos checks whether the Cursor GitHub App can also see it).
        repos: repos.list(w.id).map((r) => ({ id: r.id, name: r.name, path: r.path, git_remote: r.git_remote })),
      })),
      backends: listBackends(),
      // Every client's parked rows ride the same payload as the wall: the Desk repaints on every bus
      // event, and a second round-trip per client would put the list a frame behind the terminals it
      // opens. The whole table is a handful of rows per client.
      jots: jots.list().filter((j) => !scope.ws || j.workspace_id === scope.ws),
      // Saved launches ride along for the same reason the jots do: the chips sit on the client
      // header the wall is about to paint.
      launches: launches.list().filter((l) => !scope.ws || l.workspace_id === scope.ws),
      // Unread inbox rows per client — the badge on the bar. The rows themselves load when the inbox opens.
      inbox: inbox.counts(scope.ws),
      sessions: rows.map((s) => {
        // sessionActivity() already defaults to {live:false, quiet:true, ...} for an id never in the
        // pty registry, which is every cloud session — no pty exists to read bytes from. Its state
        // comes off the run it dispatched instead (nothing headless runs `mc state` from inside a
        // Cursor VM), and its liveness is the row's own status rather than a process.
        const act = sessionActivity(s.id);
        const agent = s.cloud_agent_id ? undefined : getAgent(s.id);
        const cloudRun = cloudRunFor(s);
        // A terminal on another host whose link is down (or not back yet after a brain restart) is
        // still running over there: its row, not this brain's pty registry, says whether it is live.
        const remote = !!s.host_id && s.host_id !== LOCAL_HOST_ID;
        const host_offline = remote && s.status === "live" && !hostOnline(s.host_id);
        const live = s.cloud_agent_id ? s.status === "live" : act.live || (remote && s.status === "live");
        // Precedence: an agent that reported `blocked` (mc state) outranks byte-level silence, and a
        // ticked goal outranks both — for as long as the tick still describes it (goalReachedStands:
        // a terminal you gave more work to is not done, whatever it said ten minutes ago).
        const state = sessionGoalReached(s, act)
          ? "done"
          : !live
            ? "ended"
            : s.cloud_agent_id
              ? cloudSessionState(cloudRun)
              : agent?.state === "blocked"
                ? "blocked"
                : act.quiet
                  ? "waiting"
                  : "working";
        const { lead_id, workers, board } = leadFields.get(s.id) ?? { lead_id: null, workers: 0, board: null };
        return {
          ...s,
          state,
          // The live Lead that opened this session, if any (LEADS.md Desk spec) — null for everything
          // else, including an ended Lead's now-orphaned workers.
          lead_id,
          // Live worker count, only meaningful for role === "lead".
          workers,
          // HOSTS.md: the computer this terminal runs on is not connected right now. Not ended —
          // it keeps running there and re-attaches when the host reconnects.
          host_offline,
          // `{ done, total }` of this Lead's plan, or null when it has not written one.
          board,
          // `state` is what the operator should FEEL about this terminal; `live` is whether the work
          // is actually running — a pty for a local session, the row's own status for a cloud one.
          // They diverge from `state`: a terminal whose goal was ticked reads "done" long after its
          // process (or cloud run) is gone, and the wall must not offer a dead one a keyboard.
          live,
          // What it has cost so far: turns, how full its context window is, dollars. Read from the
          // CLI's own transcript, so it needs no cooperation from the agent. A cloud run's cost is the
          // provider's own total (runs.cost_usd, cost_estimated:false) — same column, no cloud branch.
          usage: sessionUsage(s.id),
          state_label: agent?.state_label ?? null,
          blocked_reason: agent?.blocked_reason ?? null,
          quiet: act.quiet,
          last_out: act.last_out,
          // A standing watch as the Desk draws it: the order, next look, and Robert's last words.
          watch: watchView(s),
          // What a quiet terminal is asking, read off its screen (desk-prompt.ts): the question and
          // its options, so the wall can answer without a zoom. Null while it is working. Cloud
          // sessions have no screen to read; their run status IS the state above.
          prompt: !s.cloud_agent_id && (state === "waiting" || state === "blocked") ? sessionPrompt(s.id) : null,
          // The card, resolved once (term-status.ts): phase, one-liner, subagents, progress.
          status: statusOf(s.id),
          // The PR the run opened, once it lands — the terminal card's other cloud link (cloud_url,
          // the ☁ page itself, already rides on the row via sessions.setCloud).
          pr_url: s.ticket_id ? tickets.get(s.ticket_id)?.pr_url ?? null : null,
        };
      }),
    });
  });

  // The Desk decides when the OS should speak (a card flipped to "your turn" while the window is
  // not in front) and asks here: osascript notifications work from the daemon regardless of which
  // window holds the page, and the page has no OS hand of its own in a plain browser tab.
  api.post("/desk/notify", validate(DeskNotifySchema), (req, res) => {
    // Admin token, checked inline: requireAdmin is declared further down this file (same as /input).
    if (!tokenOk(req.get("x-mc-admin"), CONFIG.adminToken))
      return res.status(403).json({ error: "admin-gated (x-mc-admin)" });
    if (!CONFIG.desktopNotify) return res.status(204).end();
    desktopNotify(req.body.title, req.body.body ?? "");
    res.status(204).end();
  });

  // The whole wall in one read, in words: what each terminal is for, whether it needs a human, and
  // the last things it said about itself. This is how an agent "looks at the screen" — without it,
  // overseeing twelve terminals is twelve round trips and a guess about which ones matter.
  // Web Push (src/push.ts): the phone hands over its subscription once; the daemon pushes when a
  // terminal needs the operator or Robert answers. The public VAPID key is not a secret (it is the
  // half the browser needs to subscribe); the subscription itself is admin-gated because whoever
  // can register one receives every prompt's text.
  api.get("/push/vapid", (_req, res) => res.json({ publicKey: vapidKeys().publicKey, enabled: CONFIG.push }));
  api.post("/push/subscribe", validate(PushSubscribeSchema), (req, res) => {
    if (!tokenOk(req.get("x-mc-admin"), CONFIG.adminToken)) return res.status(403).json({ error: "admin-gated (x-mc-admin)" });
    const row = pushSubs.add(req.body.subscription, req.get("user-agent"));
    res.status(201).json({ ok: true, endpoint: row.endpoint, count: pushSubs.list().length });
  });
  api.delete("/push/subscribe", validate(PushUnsubscribeSchema), (req, res) => {
    if (!tokenOk(req.get("x-mc-admin"), CONFIG.adminToken)) return res.status(403).json({ error: "admin-gated (x-mc-admin)" });
    res.json({ ok: true, removed: pushSubs.remove(req.body.endpoint), count: pushSubs.list().length });
  });
  api.post("/push/test", async (req, res) => {
    if (!tokenOk(req.get("x-mc-admin"), CONFIG.adminToken)) return res.status(403).json({ error: "admin-gated (x-mc-admin)" });
    const r = await broadcast({ kind: "needs", title: "Chronos", body: "Push is wired. This is what a prompt will look like.", tag: "test", url: "/phone", actions: [{ action: "open", title: "Open", input: {} }], needs: 0, at: new Date().toISOString() });
    res.json(r);
  });
  api.get("/desk/digest", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const lines = Math.min(Number(req.query.lines) || 3, 10);
    const rows = sessions
      .list({ workspace_id: scope.ws ?? undefined, status: "live", limit: 60 })
      .map((s) => {
        const act = sessionActivity(s.id);
        const agent = getAgent(s.id);
        const state = sessionGoalReached(s, act) ? "done" : agent?.state === "blocked" ? "blocked" : act.quiet ? "waiting" : "working";
        const feed = focusEvents(s.id);
        return {
          id: s.id,
          workspace: s.workspace_id ? workspaces.get(s.workspace_id)?.name ?? null : null,
          goal: s.goal,
          goal_kind: s.goal_kind,
          goal_source: s.goal_source,
          backend: s.backend,
          model: s.model,
          cwd: s.cwd,
          agent_name: s.agent_name,
          ticket: s.ticket_key ?? null,
          state,
          status: statusOf(s.id),
          state_label: agent?.state_label ?? null,
          blocked_reason: agent?.blocked_reason ?? null,
          // Seconds of silence — "waiting 4s" and "waiting 40 minutes" are different problems.
          quiet_for_sec: act.quiet && act.last_out ? Math.round((Date.now() - act.last_out) / 1000) : 0,
          // The prompt it is sitting on, if any — the thing to answer (mc session send --keys).
          prompt: state === "waiting" || state === "blocked" ? sessionPrompt(s.id) : null,
          started: s.created_at,
          usage: sessionUsage(s.id),
          // What it last said about itself, newest last. The Understanding pins what it thinks it's doing.
          says: feed.slice(-lines).map((e) => ({ kind: e.kind, text: e.text.slice(0, 400) })),
          understanding: [...feed].reverse().find((e) => e.kind === "understanding")?.text?.slice(0, 400) ?? null,
        };
      });
    const divergence = divergences(scope.ws ?? null);
    res.json({
      at: new Date().toISOString(),
      terminals: rows,
      needs_you: rows
        .filter((r) => r.status?.needs_you || (r.status ? r.status.phase === "your_turn" && r.quiet_for_sec > 120 : r.state === "blocked" || (r.state === "waiting" && r.quiet_for_sec > 120)))
        .map((r) => r.id),
      divergence,
      divergence_line: divergenceLine(divergence),
    });
  });

  // Every standing watch: which terminals Robert is checking on a clock, how often, and when the
  // next report is due. "What am I being told about, and how often" should never require a grep.
  api.get("/desk/watches", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const rows = sessions
      .watched()
      .filter((s) => !scope.ws || s.workspace_id === scope.ws)
      .map((s) => {
        const lastMs = s.watch_last_at ? Date.parse(s.watch_last_at) : NaN;
        return {
          id: s.id,
          workspace: s.workspace_id ? (workspaces.get(s.workspace_id)?.name ?? null) : null,
          goal: s.goal ?? s.spawn_goal ?? null,
          live: s.status === "live",
          every_min: s.watch_every_min,
          note: s.watch_note,
          by: s.watch_by,
          started: s.watch_started_at,
          last_report: s.watch_last_at,
          next_due: Number.isNaN(lastMs)
            ? null
            : new Date(lastMs + (s.watch_every_min ?? 0) * 60_000).toISOString(),
        };
      });
    res.json({ watches: rows });
  });

  // The day's log: one row per terminal worked on, newest first. Everything the wall knew while it
  // was running, kept after it died — what you asked for, what it turned out to be, what it cost,
  // what it left behind, and the id that reopens it with its whole conversation intact.
  api.get("/desk/log", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const sinceParam = String(req.query.since ?? "today");
    const since = (() => {
      if (sinceParam === "today") { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
      const m = /^(\d+)([hd])$/.exec(sinceParam);
      if (m) return Date.now() - Number(m[1]) * (m[2] === "h" ? 3600e3 : 86400e3);
      const t = Date.parse(sinceParam);
      return Number.isNaN(t) ? Date.now() - 86400e3 : t;
    })();
    const rows = sessions
      .list({ workspace_id: scope.ws ?? undefined, limit: 500 })
      .filter((s) => Date.parse(s.created_at) >= since || (s.status === "live"))
      .map((s) => {
        // A live terminal's numbers are still moving — read them fresh. A dead one's are frozen on the
        // row, EXCEPT for terminals that ended before this ledger existed: backfill those from the
        // transcript the first time the log asks, then they're frozen too.
        const u =
          s.status === "live" || (s.turns == null && s.cost_usd == null)
            ? snapshotUsage(s.id)
            : null;
        const mins = (from: string, to: string | null) =>
          Math.max(0, Math.round((Date.parse(to ?? new Date().toISOString()) - Date.parse(from)) / 60000));
        return {
          id: s.id,
          started: s.created_at,
          ended: s.ended_at,
          minutes: mins(s.created_at, s.ended_at),
          live: s.status === "live",
          workspace: s.workspace_id ? workspaces.get(s.workspace_id)?.name ?? null : null,
          workspace_id: s.workspace_id,
          opened_by: s.created_by ?? "operator",
          // The pair that makes a log worth reading: what you asked for, and what it turned out to be.
          asked_for: s.spawn_goal ?? null,
          became: s.goal ?? null,
          goal_kind: s.goal_kind,
          goal_reached: !!s.goal_done_at,
          summary: s.summary ?? null,          // written by the exit digest when the pty died
          ticket: s.ticket_key ?? null,
          repo: s.cwd,
          branch: s.branch ?? null,
          backend: s.backend,
          model: s.model,
          turns: u?.turns ?? s.turns ?? null,
          tokens_in: u?.tokens_in ?? s.tokens_in ?? null,
          tokens_out: u?.tokens_out ?? s.tokens_out ?? null,
          cost_usd: u?.cost_usd ?? s.cost_usd ?? null,
          cost_estimated: u?.cost_estimated ?? !!s.cost_estimated,
          context_peak: Math.max(u?.context_tokens ?? 0, s.context_peak ?? 0) || null,
          lines_added: u?.lines_added ?? s.lines_added ?? null,
          lines_removed: u?.lines_removed ?? s.lines_removed ?? null,
          // Open 90 minutes, model working 12 of them — the log should be able to say both.
          model_minutes: Math.round(((u?.model_ms ?? s.model_ms ?? 0) / 60000) * 10) / 10 || null,
          blocked_count: s.blocked_count ?? 0,
          // Reopening continues the same transcript — the log is a set of doors, not a graveyard.
          reopen: `/desk#reopen=${s.id}`,
        };
      });
    const num = (k: string) => rows.reduce((a: number, r: any) => a + (r[k] || 0), 0);
    res.json({
      since: new Date(since).toISOString(),
      terminals: rows,
      totals: {
        terminals: rows.length,
        minutes: num("minutes"),
        turns: num("turns"),
        cost_usd: Number(num("cost_usd").toFixed(2)),
        lines_added: num("lines_added"),
        lines_removed: num("lines_removed"),
        blocked: num("blocked_count"),
      },
    });
  });

  // ───────────────────────────── Agent lifecycle (herdr-inspired) ─────────────────────────────
  // Semantic states for live sessions + headless runs. Waits pin the occupant id.
  api.get("/agents", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const workspace_id = scope.ws ?? (req.query.workspace as string | undefined);
    res.json(
      listAgents({
        workspace_id,
        state: req.query.state as any,
        kind: req.query.kind as any,
        include_settled: req.query.include_settled === "1" || req.query.include_settled === "true",
      })
    );
  });
  api.get("/agents/rollup", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const workspace_id = scope.ws ?? (req.query.workspace as string | undefined);
    // Two records of one decision can disagree (a closed ticket with its question still open, a
    // merged PR with its review still pending). Reported here, never reconciled: a call closed
    // wrongly leaves review entirely, which is worse than the noise.
    res.json({ ...lifecycleRollup(workspace_id), divergence: divergences(workspace_id ?? null) });
  });
  api.get("/agents/:idOrName", (req, res) => {
    const a = getAgent(req.params.idOrName);
    if (!a) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, a.workspace_id)) return;
    res.json(a);
  });
  api.post("/agents/:idOrName/name", validate(AgentNameSchema), (req, res) => {
    const ref = resolveAgent(req.params.idOrName);
    if (!ref) return res.status(404).json({ error: "not found" });
    const cur = getAgent(ref.id);
    if (cur && !checkScope(req, res, cur.workspace_id)) return;
    const r = setAgentName(ref.id, req.body.name);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r.agent);
  });
  api.post("/agents/:idOrName/report", validate(AgentReportSchema), (req, res) => {
    const ref = resolveAgent(req.params.idOrName);
    if (!ref) return res.status(404).json({ error: "not found" });
    const cur = getAgent(ref.id);
    if (cur && !checkScope(req, res, cur.workspace_id)) return;
    const r = reportAgentState(ref.id, req.body);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r.agent);
  });
  api.post("/agents/:idOrName/seen", (req, res) => {
    const ref = resolveAgent(req.params.idOrName);
    if (!ref) return res.status(404).json({ error: "not found" });
    const cur = getAgent(ref.id);
    if (cur && !checkScope(req, res, cur.workspace_id)) return;
    const r = markAgentSeen(ref.id);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r.agent);
  });
  api.post("/agents/:idOrName/wait", validate(AgentWaitSchema), async (req, res) => {
    const ref = resolveAgent(req.params.idOrName);
    if (!ref) return res.status(404).json({ error: "not found" });
    const cur = getAgent(ref.id);
    if (cur && !checkScope(req, res, cur.workspace_id)) return;
    const result = await waitForAgent({
      idOrName: ref.id,
      until: req.body.until as WaitUntil | WaitUntil[] | undefined,
      timeout_ms: req.body.timeout_ms,
    });
    if (!result.ok) return res.status(408).json(result);
    res.json(result);
  });
  // Aliases so Robert's existing mental model (sessions/runs) still works.
  api.post("/sessions/:id/wait", validate(AgentWaitSchema), async (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, s.workspace_id)) return;
    const result = await waitForAgent({
      idOrName: s.id,
      until: req.body.until as WaitUntil | WaitUntil[] | undefined,
      timeout_ms: req.body.timeout_ms,
    });
    if (!result.ok) return res.status(408).json(result);
    res.json(result);
  });
  api.post("/runs/:id/wait", validate(AgentWaitSchema), async (req, res) => {
    const ref = resolveAgent(req.params.id);
    if (!ref || ref.kind !== "run") return res.status(404).json({ error: "not found" });
    const a = getAgent(ref.id);
    if (a && !checkScope(req, res, a.workspace_id)) return;
    const result = await waitForAgent({
      idOrName: ref.id,
      until: req.body.until as WaitUntil | WaitUntil[] | undefined,
      timeout_ms: req.body.timeout_ms,
    });
    if (!result.ok) return res.status(408).json(result);
    res.json(result);
  });

  // ───────────────────────────── Mission Control: workspace notes (Obsidian-style) ─────────────────────────────
  // Strip absolute file_path so API consumers (and any unauth localhost reader) never see home paths.
  const publicNote = <T extends { file_path?: string }>(n: T) => {
    const { file_path: _fp, ...rest } = n;
    return rest;
  };
  // Require workspace on list — unscoped list would return every client's notes (cross-tenant leak).
  // Scoped callers can't override with ?workspace= (PER-35 pattern) — their token's workspace always wins.
  api.get("/notes", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const ws = scope.ws ?? (req.query.workspace as string | undefined);
    if (!ws) return res.status(400).json({ error: "workspace query required" });
    res.json(noteSvc.listNotes(ws).map(publicNote));
  });
  api.get("/notes/:id", (req, res) => {
    const n = noteSvc.getNote(req.params.id);
    if (!n) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, n.workspace_id)) return;
    // ?use=1 = an agent reading it in full (`mc memo get`); the Desk's renders don't pass it.
    if (req.query.use === "1") recordRead(n.workspace_id, { kind: "memo_get", ref: n.id }, { source: "api", session_id: sessionFor(n.workspace_id, req.query.session) });
    res.json(publicNote(n));
  });
  // scope='global' notes land in EVERY workspace's agent context, crossing client isolation.
  // Notes routes are open on localhost (agents need them), so gate the global surface behind the
  // admin token — both PROMOTING to global and EDITING an already-global note (its body reaches all
  // clients' prompts). A client-workspace agent can never touch other clients' contexts either way.
  const rejectsGlobal = (req: express.Request, res: express.Response, targetId?: string): boolean => {
    const touchesGlobal =
      req.body?.scope === "global" ||
      (targetId ? noteSvc.getNote(targetId)?.scope === "global" : false);
    if (touchesGlobal && !tokenOk(req.get("x-mc-admin"), CONFIG.adminToken)) {
      res.status(403).json({ error: "global notes cross all workspaces — admin token required" });
      return true;
    }
    return false;
  };
  api.post("/notes", validate(NewNoteSchema), (req, res) => {
    try {
      if (rejectsGlobal(req, res)) return;
      res.status(201).json(publicNote(noteSvc.createNote(req.body || {})));
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });
  api.patch("/notes/:id", validate(PatchNoteSchema), (req, res) => {
    try {
      const cur = noteSvc.getNote(req.params.id);
      if (!cur) return res.status(404).json({ error: "not found" });
      if (!checkScope(req, res, cur.workspace_id)) return;
      if (rejectsGlobal(req, res, req.params.id)) return;
      const b = req.body || {};
      const n = b.append != null
        ? noteSvc.appendNote(req.params.id, b.append, b.heading)
        : noteSvc.updateNote(req.params.id, b);
      res.json(publicNote(n));
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });
  api.delete("/notes/:id", (req, res) => {
    const cur = noteSvc.getNote(req.params.id);
    if (!cur) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, cur.workspace_id)) return;
    if (rejectsGlobal(req, res, req.params.id)) return;
    noteSvc.deleteNote(req.params.id);
    res.json({ ok: true });
  });
  // Agent-driven learning capture (`mc learn`): append one durable fact to the workspace's
  // standing learnings memo. Not ★context until the operator promotes it.
  api.post("/workspaces/:id/learn", validate(LearnSchema), (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    const n = noteSvc.captureLearnings(req.params.id, [req.body.fact], req.body.label || "agent");
    res.status(201).json(n ? publicNote(n) : null);
  });
  // `mc remember`: a rule every future agent here must know — a short line in the ★ memory index,
  // detail in its topic branch. Refuses (409) instead of letting either level grow past its cap.
  api.post("/workspaces/:id/remember", validate(RememberSchema), (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    const r = rememberFact(req.params.id, req.body);
    if (!r.ok) return res.status(409).json({ error: r.error });
    // The writer already knows what it wrote; don't echo it back on its own next prompt.
    const writer = req.body.session ? sessions.get(req.body.session) : null;
    if (writer && writer.workspace_id === req.params.id) markMemorySeen(writer.id);
    res.status(201).json({ added: r.added, topic: r.topic, index: publicNote(r.note), branch: r.branch ? publicNote(r.branch) : null });
  });
  // Operator prose (src/prose.ts): how he writes, per workspace, for agents that draft under his name.
  // Workspace-walled like memory. `origin` is stamped here from the caller, never taken from the body:
  // only the admin (the Desk, his own shell) can say "this is mine" first-hand.
  api.get("/workspaces/:id/prose", (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    const text = proseBrief(req.params.id, {
      channel: req.query.channel ? String(req.query.channel) : undefined,
      about: req.query.about ? String(req.query.about) : undefined,
      limit: req.query.limit ? Math.min(10, Number(req.query.limit) || 4) : undefined,
    });
    const g = proseGuide(req.params.id);
    res.json({ text, guide: g ? publicNote(g) : null, samples: proseSamples.countSince(req.params.id, null) });
  });
  api.get("/workspaces/:id/prose/samples", (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    res.json(proseSamples.list(req.params.id, {
      channel: req.query.channel ? String(req.query.channel) : undefined,
      limit: req.query.limit ? Number(req.query.limit) || undefined : undefined,
    }));
  });
  api.post("/workspaces/:id/prose/samples", validate(ProseSampleSchema), (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    const origin = tokenOk(req.get("x-mc-admin"), CONFIG.adminToken) ? "operator" : "agent";
    const r = addSample(req.params.id, req.body, origin);
    if (!r.ok) return res.status(422).json({ error: r.error });
    res.status(r.sample ? 201 : 200).json({ added: !!r.sample, sample: r.sample });
  });
  api.delete("/workspaces/:id/prose/samples/:sid", (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    const s = proseSamples.get(req.params.sid);
    if (!s || s.workspace_id !== req.params.id) return res.status(404).json({ error: "not found" });
    proseSamples.remove(s.id);
    res.json({ ok: true });
  });
  api.put("/workspaces/:id/prose/guide", validate(ProseGuideSchema), (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    const r = saveGuide(req.params.id, req.body.body);
    if (!r.ok) return res.status(409).json({ error: r.error });
    res.json(publicNote(r.note));
  });
  api.post("/workspaces/:id/prose/learn", (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    const ws = workspaces.get(req.params.id);
    if (!ws) return res.status(404).json({ error: "workspace not found" });
    const r = startLearning(ws);
    if (!r.ok) return res.status(409).json({ error: r.error });
    res.status(202).json(r);
  });

  // Retrieval-first memory (`mc recall`): one workspace-walled search across memos, skills,
  // lessons and past-session digests. Scoped callers can only recall their own workspace; there is
  // deliberately NO unscoped variant — cross-workspace recall would cross client walls.
  api.get("/workspaces/:id/recall", (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    const q = String(req.query.q ?? "");
    const hits = recall(req.params.id, q);
    recordRecall(req.params.id, q, hits, { source: "api", session_id: sessionFor(req.params.id, req.query.session) });
    res.json({ hits, text: renderRecall(req.params.id, q, hits) });
  });

  // Which memory agents actually used (src/memory-usage.ts): per-ref counts, last use, which doors.
  // Workspace-walled like recall; the dream pass ranks and prunes on it. ?since=ISO or 7d/24h.
  api.get("/workspaces/:id/memory/usage", usageRoute);

  // The dream pass (src/dream-pass.ts): gather one bundle, apply one plan, undo a pass. Walled per
  // workspace in the handlers; `POST /dream/run` (dream now, any slot) is admin-only.
  api.get("/workspaces/:id/dream/context", dreamRoutes.contextRoute);
  api.get("/workspaces/:id/dream/branch/:slug", dreamRoutes.branchRoute);
  api.post("/workspaces/:id/dream/apply", dreamRoutes.applyRoute);
  api.get("/workspaces/:id/dream/runs", dreamRoutes.runsRoute);
  api.post("/workspaces/:id/dream/runs/:run/undo", dreamRoutes.undoRoute);
  api.post("/dream/run", dreamRoutes.runNowRoute);

  // The workspace inbox (src/inbox.ts, src/inbox-routes.ts): what needs the operator, per client.
  // Rows are notifications; POST /inbox/:id/dispatch (admin) is the only door from one to a terminal.
  api.get("/inbox", inboxRoutes.listAllRoute);
  api.get("/workspaces/:id/inbox", inboxRoutes.listRoute);
  api.post("/workspaces/:id/inbox", inboxRoutes.addRoute);
  api.post("/inbox/:id/dismiss", inboxRoutes.dismissRoute);
  api.post("/inbox/:id/snooze", inboxRoutes.snoozeRoute);
  api.post("/inbox/:id/dispatch", inboxRoutes.dispatchRoute);

  // Pairs of remembered facts a judge found to disagree. Read-only and workspace-walled, same as
  // recall: a conflict quotes two pieces of this workspace's memory.
  api.get("/workspaces/:id/memory/conflicts", (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    res.json({ conflicts: openConflicts(req.params.id, limit) });
  });

  // Settle one: `resolved` = the disagreement was acted on, `dismissed` = it was never real.
  api.post("/workspaces/:id/memory/conflicts/:relId", (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    const status = String(req.body?.status ?? "");
    if (status !== "resolved" && status !== "dismissed")
      return res.status(400).json({ error: "status must be resolved or dismissed" });
    // Accepts the short id every surface prints, not just the full uuid.
    const { row, ambiguous } = memoryRelations.resolveRef(req.params.id, req.params.relId);
    if (ambiguous)
      return res.status(409).json({ error: `"${req.params.relId}" matches ${ambiguous} conflicts — use more characters` });
    if (!row) return res.status(404).json({ error: "conflict not found" });
    res.json(memoryRelations.resolve(row.id, status));
  });

  // ───────────────────────── persona memory ─────────────────────────
  // One durable markdown file per named agent (Robert — the retired personas' memory files are
  // untouched on disk and still readable as ordinary notes; see MEMORY_AGENTS), injected into
  // that agent's system prompt every turn. The agent writes its own memory mid-conversation, which
  // is the whole point — recording a fact costs it one curl, not a request to the operator.
  api.get("/agents/:name/memory", (req, res) => {
    const name = req.params.name.toLowerCase();
    if (!isMemoryAgent(name)) return res.status(404).json({ error: `no memory for agent '${name}'` });
    const n = agentMemory.agentMemoryNote(name, false);
    res.json(n ? publicNote(n) : { agent: name, body: "", empty: true });
  });
  api.post("/agents/:name/memory", validate(AgentMemoryAppendSchema), (req, res) => {
    const name = req.params.name.toLowerCase();
    if (!isMemoryAgent(name)) return res.status(404).json({ error: `no memory for agent '${name}'` });
    try {
      res.status(201).json(publicNote(agentMemory.rememberFact(name, req.body.fact, req.body.heading)));
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });
  api.put("/agents/:name/memory", validate(AgentMemoryRewriteSchema), (req, res) => {
    const name = req.params.name.toLowerCase();
    if (!isMemoryAgent(name)) return res.status(404).json({ error: `no memory for agent '${name}'` });
    try {
      res.json(publicNote(agentMemory.rewriteMemory(name, req.body.body)));
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  // The stow pass: tiered decay, a token budget, and a cold archive instead of a delete
  // (src/stow.ts). Same door as the memory routes above — the agent curates its own memory — and
  // the receipt it returns is what it reports back to the operator.
  api.post("/agents/:name/stow", validate(StowSchema), (req, res) => {
    const name = req.params.name.toLowerCase();
    if (!isMemoryAgent(name)) return res.status(404).json({ error: `no memory for agent '${name}'` });
    try {
      res.json(runStowPass(name, { reinforced: req.body.reinforced ?? [] }));
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });
  api.get("/agents/:name/memory/report", (req, res) => {
    const name = req.params.name.toLowerCase();
    if (!isMemoryAgent(name)) return res.status(404).json({ error: `no memory for agent '${name}'` });
    res.json(memoryReport(name));
  });

  // ───────────────────────────── lessons ─────────────────────────────
  // Rules distilled from feedback and injected back into builders/reviewers/the manager.
  // Open to agents on localhost like the rest of the backlog: an agent that just got corrected
  // should be able to write the rule down without waiting for the operator to do it.
  api.get("/lessons", (req, res) => {
    const { workspace, repo, state, topic } = req.query as Record<string, string | undefined>;
    res.json(
      lessons.list({
        workspace_id: workspace,
        repo_id: repo,
        state: state as LessonState | undefined,
        topic,
      }),
    );
  });

  api.post("/lessons", validate(NewLessonSchema), (req, res) => {
    if (!workspaces.get(req.body.workspace_id))
      return res.status(404).json({ error: "workspace not found" });
    if (req.body.repo_id && !repos.get(req.body.repo_id))
      return res.status(404).json({ error: "repo not found" });
    res.status(201).json(recordLesson(req.body));
  });

  // Both edit and delete announce the rule as it was and as it is: a comms rule that changed, moved
  // topic or went away leaves that workspace's voice page stale (prose.ts rewrites it).
  api.patch("/lessons/:id", validate(PatchLessonSchema), (req, res) => {
    const before = lessons.get(req.params.id);
    if (!before) return res.status(404).json({ error: "lesson not found" });
    const after = lessons.update(req.params.id, req.body);
    publishLesson(before);
    if (after) publishLesson(after);
    res.json(after);
  });

  api.delete("/lessons/:id", (req, res) => {
    const before = lessons.get(req.params.id);
    lessons.remove(req.params.id);
    if (before) publishLesson(before, "deleted");
    res.json({ ok: true });
  });

  // Liveness only — no home path / profile map (those leak username + account layout). `deploy`
  // carries the running commit vs origin/<branch> drift (PER-23): a daemon nine commits behind its
  // own merged code must never again be invisible to everything that reports on it.
  // `operational` is the trust layer on top: ok stays true for launchd/Buzz presence, but
  // operational.status can be "degraded" when connectors, recoveries, or stale reviews need a human.
  api.get("/health", (_req, res) => {
    res.json({ ok: true, ...dispatchStatus(), deploy: deployStatus(), operational: operationalHealth() });
  });

  // Same snapshot as /health.operational, exposed on its own so Fleet/Inbox can poll without the
  // spend/concurrency rollup. Read-only; never mutates.
  api.get("/operational", (_req, res) => {
    res.json(operationalHealth());
  });

  // What each provider credential has left, and the last few dispatch verdicts that read it. Read
  // this BEFORE opening several terminals on one backend (agents/_blocks/quota.md says so): the
  // snapshot is the only place that knows a profile is rate-limited until 14:00 or never logged in.
  api.get("/quota", (_req, res) => {
    res.json({ mode: gateMode(), snapshot: quotaSnapshot(), decisions: recentDecisions() });
  });

  // Subscription usage as each vendor reports it (usage-meter.ts): the Desk bar's chips + `mc usage`.
  api.get("/usage", (_req, res) => {
    res.json(usageSnapshot());
  });
  // `mc statusline claude` — every Claude session's statusLine hands us its rate_limits.
  api.post("/usage/report", validate(UsageReportSchema), (req, res) => {
    noteClaudeStatusline(req.body.config_dir ?? null, req.body.rate_limits);
    res.json({ ok: true });
  });
  // ───────────────────────────── Machine governor (src/machine.ts) ─────────────────────────────
  // How loaded the Mac itself is, and whether an AGENT would currently be allowed to open a terminal
  // on it (the operator always is). Read-only and machine-wide, so it is scoped only to the extent
  // every read is: a valid token, no workspace to compare against.
  //
  // "The Mac" is the computer the CALLER runs on (HOSTS.md phase 4): the brain for the Desk and every
  // local agent, and — for an `mc machine` / `mc heavy` forwarded from a host — that host, judged on
  // its own vitals with its own core count. The forwarded host id is the brain's own stamp
  // (forwardedHost: set by the link, never by the caller), and forwardedGate has already held the
  // request to a live session on that host.
  const callerHost = (req: express.Request) => {
    const fh = forwardedHost(req);
    return fh ? findHost(fh) ?? null : hostById(LOCAL_HOST_ID);
  };
  api.get("/machine", (req, res) => {
    if (!checkScope(req, res, null)) return;
    const host = callerHost(req);
    if (!host) return res.status(409).json({ error: "the forwarding host is not registered on this brain" });
    const { load, admission, samples } = host.vitals();
    res.json({
      ...load,
      pressure: pressureWord(load.pressureLevel),
      swapUsedPct: swapPctOf(load),
      admission,
      heavy: { slots: host.slots.size(), holders: host.slots.holders(), waiting: host.slots.waiting() },
      vitals: samples,
      ...(host.id !== LOCAL_HOST_ID ? { host_id: host.id } : {}),
    });
  });
  // Heavy slots: `mc heavy -- <cmd>` long-polls here for one of N permits on ITS OWN machine, so five
  // agents cannot each start a full vitest pool in the same minute on one Mac — and two suites on two
  // Macs never wait for each other (HOSTS.md → "Heavy slots are per host"). An agent on a host reaches
  // here through that host's forwarder, and gets that host's pool (`ncpu / 6` of that machine). All
  // pools live on the brain, in memory on purpose — a slot outliving a daemon restart would be a
  // permit nobody can release — and a terminal's slots are freed when it ends (machine.ts).
  const slotsFor = (req: express.Request, res: express.Response) => {
    const host = callerHost(req);
    if (!host) res.status(409).json({ error: "the forwarding host is not registered on this brain" });
    return host?.slots ?? null;
  };
  api.post("/machine/slots", validate(HeavySlotSchema), async (req, res) => {
    if (!checkScope(req, res, null)) return;
    const heavySlots = slotsFor(req, res);
    if (!heavySlots) return;
    // The ticket is minted HERE, before the await, so the hang-up handler below can name this exact
    // place in line. `mc heavy` echoes it back on its next poll and keeps the place it already has.
    const ticket = req.body.ticket || randomUUID();
    // RESPONSE close, not request close: `req` emits "close" as soon as its body has been read, which
    // is immediately — wiring the hang-up handler there abandoned every poll on arrival and turned
    // the long poll into a busy loop. `res` closes early only when the client really went away.
    res.on("close", () => { if (!res.writableEnded) heavySlots.abandon(ticket); });
    const grant = await heavySlots.acquire({ session_id: req.body.session_id ?? null, label: req.body.label, ticket }, 55_000);
    // The caller may have hung up while we were parked (that is what woke us) — nothing to answer.
    if (res.writableEnded || !res.writable) return;
    // The count rides along so a refused caller can print "2/2 busy" without a second round trip.
    res.json({ ...grant, slots: heavySlots.size() });
  });
  api.put("/machine/slots/:id", (req, res) => {
    if (!checkScope(req, res, null)) return;
    const heavySlots = slotsFor(req, res);
    if (!heavySlots) return;
    if (!heavySlots.beat(req.params.id)) return res.status(404).json({ error: "slot not held (reclaimed?)" });
    res.json({ ok: true });
  });
  api.delete("/machine/slots/:id", (req, res) => {
    if (!checkScope(req, res, null)) return;
    const heavySlots = slotsFor(req, res);
    if (!heavySlots) return;
    res.json({ released: heavySlots.release(req.params.id) });
  });

  api.get("/stats", (_req, res) => {
    const days = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
    const counts = runs.statusCounts(days(30));
    const done = (counts.success ?? 0) + (counts.failed ?? 0) + (counts.timeout ?? 0);
    const today = spendToday();
    const last7 = spendSinceDays(7);
    const last30 = spendSinceDays(30);
    res.json({
      // Combined ledger: headless runs + Desk terminals. Breakdowns stay for diagnosis; budget
      // enforcement in the dispatcher still keys off runs alone (visibility-only phase).
      spend: {
        today: today.total_usd,
        last7: last7.total_usd,
        last30: last30.total_usd,
        runs: { today: today.runs.usd, last7: last7.runs.usd, last30: last30.runs.usd },
        sessions: { today: today.sessions.usd, last7: last7.sessions.usd, last30: last30.sessions.usd },
        metered_only: false,
        coverage: {
          today: today.coverage,
          last7: last7.coverage,
        },
        // Helper one-shots (title/digest/worklog/…) since this daemon boot — never a runs/sessions row.
        helpers: helperSpendSnapshot(),
        tools: efficiencyToolsStatus(),
      },
      runs30d: counts,
      success_rate: done ? Math.round(((counts.success ?? 0) / done) * 100) : null,
      efficiency: {
        focus: focusEfficiencySnapshot(),
        accelerators: accelTelemetry.aggregateSince(days(7)),
      },
      // Prompt-cache health (src/cache-health.ts): fleet hit share + prefix-churn run count. A
      // falling hit_share or rising prefix_miss_runs means something volatile (memos, lessons,
      // skills index) is invalidating the cached prompt prefix — burning subscription quota.
      cache_7d: cacheStats(runs.cacheRowsSince(days(7))),
      top_jobs: runs.costByJob(days(30)),
      ...dispatchStatus(),
    });
  });

  // Shared command table (src/commands.ts) over HTTP — this is how `mc` reaches the same commands
  // Telegram calls in-process, so a command added once shows up on every surface.
  // Admin-gated: the table includes mutations (stop, auto).
  api.post("/command", async (req, res) => {
    if (!tokenOk(req.get("x-mc-admin"), CONFIG.adminToken))
      return res.status(403).json({ error: "admin token required" });
    const line = String(req.body?.line ?? "").trim();
    if (!line) return res.status(400).json({ error: "line required" });
    const text = await runCommandLine(line, { workspaceId: req.body?.workspace_id ?? null });
    if (text == null) return res.status(404).json({ error: `unknown command: ${line.split(/\s+/)[0]}` });
    res.json({ text });
  });

  // One-glance fleet board: per-workspace live runs, queue, today's outcomes, PRs, spend + 5h tokens.
  api.get("/fleet", (_req, res) => {
    res.json(fleetData());
  });

  // Flow home view: state counters + the open queue + shipped (review/recently-done) work, enriched.
  api.get("/flow", (_req, res) => {
    res.json(flowData());
  });

  // Per-client cost ledger: headless runs by stage + Desk terminals. Defaults to month-to-date.
  api.get("/costs", (req, res) => {
    const from = (req.query.from as string) || new Date().toISOString().slice(0, 7) + "-01";
    const to = (req.query.to as string) || new Date().toISOString();
    const workspace = req.query.workspace as string | undefined;
    const rows = runs.costReport({ workspace_id: workspace, from, to });
    const runs_usd = rows.reduce((s, r) => s + r.cost_usd, 0);
    const desk = sessions.spendSince(from, { workspace_id: workspace, until: to });
    const sessions_usd = desk.usd;
    res.json({
      from,
      to,
      rows,
      runs_usd,
      sessions_usd,
      sessions_estimated_usd: desk.estimated_usd,
      sessions_count: desk.sessions,
      total_usd: runs_usd + sessions_usd,
      coverage: {
        priced_usd: runs_usd + desk.priced_usd,
        estimated_usd: desk.estimated_usd,
        priced_runs: rows.reduce((s, r) => s + r.runs, 0),
        priced_sessions: desk.priced,
        estimated_sessions: desk.estimated,
        unpriced_sessions: desk.unpriced,
      },
      // Retained for older clients that only read total_usd as "runs".
      legacy_runs_total_usd: runs_usd,
      by_workspace: combinedByWorkspace(from),
    });
  });

  // Daily cost/token time-series for the Fleet trend charts. One row per (day, model, workspace).
  // Defaults to the last 30 days. Frontend pivots by model / workspace / % share.
  api.get("/costs/daily", (req, res) => {
    const to = (req.query.to as string) || new Date().toISOString();
    const from =
      (req.query.from as string) || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const rows = runs.dailyCosts({ workspace_id: req.query.workspace as string | undefined, from, to });
    res.json({ from, to, rows });
  });

  // ── Altitude: the fleet from above ──────────────────────────────────────────────────────────
  // One window, every breakdown, one payload (src/analytics.ts). This is what /altitude draws and
  // what `mc altitude` prints — the surface and the CLI must never diverge by re-deriving numbers.
  //
  // Scoping is the security boundary (CLAUDE.md #4): a workspace-token caller is pinned to its own
  // workspace whatever `?workspace=` says, so a client's own token can never total the fleet.
  // Read-only; never mutates.
  api.get("/analytics", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const asked = (req.query.workspace as string | undefined) || undefined;
    const workspace_id = scope.ws ?? (asked && asked !== "all" ? asked : undefined);
    try {
      const data = analyticsWithDelta({
        preset: req.query.preset as string | undefined,
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
        bucket: req.query.bucket as any,
        workspace_id,
        scope_ws: scope.ws,
        top: req.query.top ? Number(req.query.top) : undefined,
      });
      // The window buttons ship with the data: a new preset appears in every client at once instead
      // of being hardcoded in three surfaces that then drift.
      res.json({ ...data, presets: RANGE_PRESETS });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  // The same numbers as a spreadsheet. `table` picks which grid: the time series, or any breakdown.
  // Exists because the honest answer to "can I check this in Excel / send it to a client" should be
  // yes without anyone re-querying the DB by hand.
  api.get("/analytics/export.csv", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const asked = (req.query.workspace as string | undefined) || undefined;
    let a;
    try {
      a = analyticsWithDelta({
        preset: req.query.preset as string | undefined,
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
        bucket: req.query.bucket as any,
        workspace_id: scope.ws ?? (asked && asked !== "all" ? asked : undefined),
        scope_ws: scope.ws,
        top: 500,
      });
    } catch (e: any) {
      return res.status(400).json({ error: String(e?.message ?? e) });
    }
    const table = String(req.query.table ?? "series");
    const rows: any[] =
      table === "workspaces" ? a.by_workspace
      : table === "terminals" ? a.top_terminals
      : table === "jobs" ? a.top_jobs
      : table === "models" ? a.by_model
      : table === "stages" ? a.by_stage
      : a.series.map(({ by_ws, ...rest }) => rest); // the per-bucket ws split is a map, not a column
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const cell = (v: any) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
    res.setHeader("Content-Disposition", `attachment; filename="chronos-${table}-${a.range.from.slice(0, 10)}.csv"`);
    res.type("text/csv").send(csv);
  });

  // Client billing pack: a weekly per-workspace work report. Defaults to the last 7 days.
  api.get("/report", (req, res) => {
    const workspace = req.query.workspace as string | undefined;
    if (!workspace) return res.status(400).json({ error: "workspace required" });
    const to = (req.query.to as string) || new Date().toISOString();
    const from = (req.query.from as string) || new Date(Date.now() - 7 * 86400000).toISOString();
    try {
      res.json(buildReport(workspace, from, to));
    } catch (e: any) {
      res.status(404).json({ error: e?.message ?? "not found" });
    }
  });

  // Durable activity/decision trail (bus events). Newest first; filter by workspace/topic/actor.
  api.get("/activity", (req, res) => {
    res.json(
      activity.list({
        workspace_id: req.query.workspace as string | undefined,
        topic: req.query.topic as string | undefined,
        actor: req.query.actor as string | undefined,
        entity: req.query.entity as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      })
    );
  });

  api.get("/jobs", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const kind = String(req.query.kind ?? "all");
    const all = jobs.list().filter((j) => scope.ws === null || j.workspace_id === scope.ws)
      .filter((j) => kind === "all" || (kind === "internal") === isInternalJob(j.name));
    // Operator jobs are few and are read as a list, so the last run rides along: status, when, cost.
    res.json(all.map((j) => {
      const last = kind === "operator" ? runs.list(j.id, 1)[0] : undefined;
      return { ...j, next_run: nextRun(j.id), ...(kind === "operator" ? { last_run: last ? { id: last.id, status: last.status, started_at: last.started_at, ended_at: last.ended_at, cost_usd: last.cost_usd, summary: last.summary?.slice(0, 200) ?? null } : null } : {}) };
    }));
  });

  api.post("/jobs", validate(NewJobSchema), (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    if (scope.ws !== null) {
      if (req.body?.workspace_id && req.body.workspace_id !== scope.ws)
        return res.status(403).json({ error: "workspace token does not match requested workspace" });
      req.body = { ...req.body, workspace_id: scope.ws };
    }
    const spawnErr = jobCreateSpawnError(req.body);
    if (spawnErr) return res.status(400).json({ error: spawnErr });
    const job = jobs.create(req.body);
    reloadSchedules();
    res.status(201).json(job);
  });

  // The Jobs page (Desk → ⏱ Jobs): every job with its run strip and health, plus the fleet's days.
  const boardKind = (q: unknown): JobKind => (q === "internal" || q === "all" ? q : "operator");
  api.get("/jobs/board", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const b = jobsBoard({
      ws: scope.ws, kind: boardKind(req.query.kind), days: Number(req.query.days) || undefined,
      strip: Number(req.query.strip) || undefined, tzOffsetMin: Number(req.query.tz) || 0,
    });
    res.json({ ...b, jobs: b.jobs.map((j) => ({ ...j, next_run: nextRun(j.id) })) });
  });
  api.get("/jobs/runs", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    res.json(runsFeed({
      ws: scope.ws, kind: boardKind(req.query.kind), status: req.query.status ? String(req.query.status) : undefined,
      days: Number(req.query.days) || undefined, limit: Number(req.query.limit) || undefined,
    }));
  });
  // Many jobs at once — pause a client's whole schedule, rerun every failed one. One schedule reload.
  api.post("/jobs/bulk", validate(BulkJobsSchema), (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const { ids, action } = req.body as { ids: string[]; action: "enable" | "disable" | "run" | "delete" };
    const results: Array<{ id: string; ok: boolean; error?: string; run_id?: string }> = [];
    for (const id of ids) {
      const j = jobs.get(id);
      if (!j) { results.push({ id, ok: false, error: "not found" }); continue; }
      if (scope.ws !== null && j.workspace_id !== scope.ws) { results.push({ id, ok: false, error: "forbidden" }); continue; }
      if (action === "enable" || action === "disable") {
        jobs.update(id, { enabled: action === "enable" } as any);
        results.push({ id, ok: true });
      } else if (action === "delete") {
        jobs.remove(id);
        results.push({ id, ok: true });
      } else {
        const r = dispatch(id, "manual");
        results.push("error" in r ? { id, ok: false, error: String(r.error) } : { id, ok: true, run_id: (r as { run_id?: string }).run_id });
      }
    }
    if (action !== "run") reloadSchedules();
    for (const r of results) if (r.ok && action !== "run") bus.publish({ topic: "job.updated", job_id: r.id });
    res.json({ ok: results.every((r) => r.ok), results });
  });

  api.get("/jobs/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, job.workspace_id)) return;
    res.json({ ...job, next_run: nextRun(job.id) });
  });

  api.patch("/jobs/:id", validate(PatchJobSchema), (req, res) => {
    const cur = jobs.get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, cur.workspace_id)) return;
    const spawnErr = jobPatchSpawnError(cur, req.body);
    if (spawnErr) return res.status(400).json({ error: spawnErr });
    const job = jobs.update(req.params.id, req.body);
    reloadSchedules();
    bus.publish({ topic: "job.updated", job_id: job!.id });
    res.json(job);
  });

  api.delete("/jobs/:id", (req, res) => {
    const cur = jobs.get(req.params.id);
    if (cur && !checkScope(req, res, cur.workspace_id)) return;
    jobs.remove(req.params.id);
    reloadSchedules();
    res.json({ ok: true });
  });

  api.post("/jobs/:id/run", (req, res) => {
    const job = jobs.get(req.params.id);
    if (job && !checkScope(req, res, job.workspace_id)) return;
    const r = dispatch(req.params.id, "manual");
    if ("error" in r) return res.status(400).json(r);
    res.json(r);
  });

  api.get("/runs", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const ticket = req.query.ticket as string | undefined;
    if (ticket) {
      const t = tickets.get(ticket);
      if (!t) return res.status(404).json({ error: "not found" });
      if (!checkScope(req, res, t.workspace_id)) return;
      return res.json(runs.listForTicket(ticket));
    }
    const jobId = req.query.job_id as string | undefined;
    if (jobId) {
      const j = jobs.get(jobId);
      if (!j) return res.status(404).json({ error: "not found" });
      if (!checkScope(req, res, j.workspace_id)) return;
      return res.json(runs.list(jobId));
    }
    if (scope.ws !== null) {
      // No job_id/ticket filter and the caller is workspace-scoped — only that workspace's runs
      // (unfiltered runs.list() spans every workspace, which is exactly the cross-tenant leak).
      const jobIds = new Set(jobs.list().filter((j) => j.workspace_id === scope.ws).map((j) => j.id));
      return res.json(runs.list().filter((r) => jobIds.has(r.job_id)));
    }
    res.json(runs.list());
  });

  api.get("/runs/:id", (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, jobs.get(run.job_id)?.workspace_id)) return;
    res.json(run);
  });

  // The run in plain English — what the agent understood, did and concluded — from its own event
  // log (src/run-story.ts). Same shape the Desk's Focus story reads for a terminal.
  api.get("/runs/:id/story", (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, jobs.get(run.job_id)?.workspace_id)) return;
    res.json({ run_id: run.id, status: run.status, summary: run.summary, error: run.error, events: storyFromEvents(events.list(run.id)) });
  });
  api.get("/runs/:id/events", (req, res) => {
    const run = runs.get(req.params.id);
    if (run && !checkScope(req, res, jobs.get(run.job_id)?.workspace_id)) return;
    res.json(events.list(req.params.id).map((e) => ({ ...e, payload: JSON.parse(e.payload) })));
  });

  // Readable last-lines of a run for the Fleet worker cards ("proof of life") — cheap on purpose.
  // Full raw transcript stays on /runs/:id/events.
  api.get("/runs/:id/tail", (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, jobs.get(run.job_id)?.workspace_id)) return;
    const limit = Number(req.query.limit ?? 8);
    res.json({
      run_id: run.id,
      status: run.status,
      lines: events.tailLines(run.id, Number.isFinite(limit) ? limit : 8),
      last_event_at: events.lastEventTs(run.id),
    });
  });

  api.post("/runs/:id/kill", (req, res) => {
    const run = runs.get(req.params.id);
    if (run && !checkScope(req, res, jobs.get(run.job_id)?.workspace_id)) return;
    res.json({ ok: stopRun(req.params.id) });
  });

  // Inject an operator message into a LIVE steer-mode run (workspace live_steer + a backend with
  // streaming input). Returns ok:false when the run isn't live-steerable — the caller should use
  // `mc tell` (the durable mailbox) instead; sendMessage tries this path automatically first.
  api.post("/runs/:id/steer", (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, jobs.get(run.job_id)?.workspace_id)) return;
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "text required" });
    if (text.length > 4000) return res.status(400).json({ error: "text too long (max 4000)" });
    const from = typeof req.body?.from === "string" && req.body.from ? String(req.body.from).slice(0, 80) : "operator";
    res.json({ ok: steerRun(run.id, text, from) });
  });

  // Structured worker progress (mc steps / mc step). Every publish is enriched with ticket/workspace
  // off the run's job, same as run.ended in runner.ts — the fleet view keys off those.
  function stepEventFields(run_id: string, job_id: string) {
    const job = jobs.get(job_id);
    const tk = job?.ticket_id ? tickets.get(job.ticket_id) : undefined;
    return { ticket_id: job?.ticket_id ?? null, ticket_key: tk?.key ?? null, workspace_id: job?.workspace_id ?? null };
  }

  api.post("/runs/:id/steps", validate(DeclareStepsSchema), (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, jobs.get(run.job_id)?.workspace_id)) return;
    const rows = steps.declare(run.id, req.body.labels);
    bus.publish({
      topic: "run.step",
      run_id: run.id,
      ...stepEventFields(run.id, run.job_id),
      idx: 0,
      label: "declared",
      status: "declared",
      progress: `0/${rows.length}`,
    });
    res.status(201).json({ steps: rows, progress: steps.progress(run.id), messages: deliverPending(run.id) });
  });

  api.post("/runs/:id/steps/:idx", validate(SetStepSchema), (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, jobs.get(run.job_id)?.workspace_id)) return;
    const idx = Number(req.params.idx);
    const row = steps.set(run.id, idx, req.body);
    if (!row) return res.status(404).json({ error: "not found" });
    const progress = steps.progress(run.id)!;
    bus.publish({
      topic: "run.step",
      run_id: run.id,
      ...stepEventFields(run.id, run.job_id),
      idx: row.idx,
      label: row.label,
      status: row.status,
      progress: `${progress.done}/${progress.total}`,
    });
    res.json({ step: row, progress, messages: deliverPending(run.id) });
  });

  api.get("/runs/:id/steps", (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, jobs.get(run.job_id)?.workspace_id)) return;
    res.json({ steps: steps.list(run.id), progress: steps.progress(run.id) });
  });

  // Operator/manager → worker mailbox (`mc tell`). See src/messages.ts for resolution + delivery
  // semantics. Resolve (read-only) FIRST so checkScope can gate the target's workspace before any
  // write — writing the row ahead of the scope check would let a workspace-scoped caller land a
  // message in a workspace it doesn't own.
  api.post("/messages", validate(NewMessageSchema), (req, res) => {
    const resolved = resolveMessageTarget(req.body.to);
    if ("error" in resolved) return res.status(404).json({ error: resolved.error });
    if (!checkScope(req, res, resolved.workspace_id)) return;
    const out = sendMessage(req.body.to, req.body.text, req.body.from || "human");
    if (!out.ok) return res.status(404).json({ error: out.error });
    res.status(201).json({ message: out.message, resolved: out.resolved });
  });

  // Explicit manual inbox check (GET /runs/:id/inbox). Rarely needed given piggyback delivery, but
  // cheap — and this IS a delivering read: calling it marks whatever it returns as delivered, same
  // as the piggyback points above.
  api.get("/runs/:id/inbox", (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, jobs.get(run.job_id)?.workspace_id)) return;
    res.json({ messages: deliverPending(run.id) });
  });

  /**
   * One handler for all three "Later" endpoints. Admin-gated: a workspace-scoped caller (a worker on
   * localhost) could otherwise date its OWN question or review off the operator's "needs you" list.
   * Resolution and scoping still happen before any write: holding another workspace's ask is the
   * same boundary violation as answering it (CLAUDE.md gotcha 4).
   * Admin token checked inline (not via `requireAdmin`, declared further down this file — same as
   * /input and /desk/notify) since this is called from a route registered above that declaration.
   */
  function holdRoute(req: express.Request, res: express.Response, kind: HoldKind) {
    if (!tokenOk(req.get("x-mc-admin"), CONFIG.adminToken))
      return res.status(403).json({ error: "later/hold is admin-gated (x-mc-admin)" });
    const target = resolveHoldTarget(kind, req.params.id);
    if (!target) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, target.workspace_id)) return;
    const out = applyHold(target, req.body?.until ?? null, req.body?.reason ?? null);
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    res.json(out);
  }

  // Worker HITL questions (`mc ask`). File one against the caller's own run (mc sends MC_RUN as
  // run_id), notify the operator, and hand back the row so the CLI can long-poll it.
  api.post("/asks", validate(NewAskSchema), (req, res) => {
    // A terminal's question (`mc ask-robert`). Its origin is a session, not a run — and by default it
    // goes to Robert first, who answers what is routine and hands the rest to the operator.
    if (req.body.session_id) {
      const sess = sessions.get(req.body.session_id);
      if (!sess) return res.status(404).json({ error: "session not found" });
      if (!checkScope(req, res, sess.workspace_id)) return;
      if (sess.status !== "live") return res.status(409).json({ error: "that terminal has ended" });
      const fallback = askRobertEnabled() ? "robert" : "operator";
      // `route: "lead"` is EARNED, not asserted (LEADS.md). `mc` asks for it off `MC_LEAD_ID`, which
      // is baked into the worker's env at spawn and goes stale the moment that Lead ends — and in a
      // workspace that requires human answers no agent may decide, Lead included. Refused either way
      // it becomes an ordinary ask; the response carries the route actually granted, which is how
      // `mc` knows to say so in one line instead of claiming it asked a Lead that never heard it.
      const route =
        req.body.route === "lead" && !mayRouteToLead(sess.id) ? fallback : (req.body.route ?? fallback);
      const ask = asks.create({
        session_id: sess.id,
        asked_by: askerLabel(sess.id),
        route,
        ticket_id: sess.ticket_id ?? null,
        workspace_id: sess.workspace_id ?? null,
        question: req.body.question,
        options: req.body.options ?? null,
      });
      void notifyAskCreated(ask, undefined).catch((e) => console.error("[api] ask.created notify failed", e));
      return res.status(201).json(ask);
    }
    const run = runs.get(req.body.run_id);
    if (!run) return res.status(404).json({ error: "run not found" });
    const job = jobs.get(run.job_id);
    if (!checkScope(req, res, job?.workspace_id)) return;
    const ask = asks.create({
      run_id: run.id,
      job_id: run.job_id,
      route: req.body.route ?? "operator",
      ticket_id: job?.ticket_id ?? null,
      workspace_id: job?.workspace_id ?? null,
      question: req.body.question,
      options: req.body.options ?? null,
    });
    void notifyAskCreated(ask, job).catch((e) => console.error("[api] ask.created notify failed", e));
    res.status(201).json(ask);
  });

  // Robert hands a question up rather than deciding it. Separate from answering so the operator's
  // card can carry his recommendation, and so "he escalated" is a recorded act, not an absence.
  api.post("/asks/:id/escalate", validate(EscalateAskSchema), async (req, res) => {
    const ask = resolveAsk(req.params.id);
    if (!ask) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, ask.workspace_id)) return;
    if (ask.status !== "open") return res.status(409).json({ error: `ask already ${ask.status}` });
    await escalateAsk(ask, req.body.note ?? null);
    res.json(resolveAsk(ask.id));
  });

  api.get("/asks", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const wsQuery = typeof req.query.workspace === "string" ? req.query.workspace : undefined;
    // Workspace-scoped caller can only ever see their own asks, same rule the /runs list uses.
    if (scope.ws !== null && wsQuery && wsQuery !== scope.ws) return res.status(404).json({ error: "not found" });
    const rows = asks.list({ status, workspace_id: scope.ws ?? wsQuery });
    // Default `live`: this is the "needs you" read (dashboard inbox, Robert's prompts, `mc asks`),
    // and an ask the operator dated out of today is not something he needs now. ?bucket=all|dated|aged
    // is how a surface asks for the rest, and every row carries its bucket so it can say which.
    const bucket = filterByBucket(rows, parseBucketFilter(req.query.bucket));
    res.json(bucket.map((a) => ({ ...a, ticket_key: a.ticket_id ? (tickets.get(a.ticket_id)?.key ?? null) : null })));
  });

  // "Later" is an answer: date the question off the live list instead of leaving it live or
  // fabricating a reply. `until: null` lifts the hold; answering it lifts it too (store/asks.ts).
  api.post("/asks/:id/hold", validate(HoldSchema), (req, res) => holdRoute(req, res, "ask"));

  // Long-poll: resolves as soon as the ask is answered, else after timeout_ms (capped at 55s — under
  // Express/proxy idle timeouts) with the still-open row. `mc ask` loops this to cover its full wait.
  api.get("/asks/:id/wait", async (req, res) => {
    const ask = resolveAsk(req.params.id);
    if (!ask) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, ask.workspace_id)) return;
    const timeoutMs = Math.max(0, Math.min(Number(req.query.timeout_ms) || 55_000, 55_000));
    if (ask.status !== "open") return res.json(ask);
    res.json(await waitForAskAnswer(ask.id, timeoutMs));
  });

  api.post("/asks/:id/answer", validate(AnswerAskSchema), async (req, res) => {
    const ask = resolveAsk(req.params.id);
    if (!ask) return res.status(404).json({ error: "not found" });
    // A LEAD answering one of its own workers' questions (`mc ask-lead` → `mc answer`). Its
    // credential is not a workspace token and must not read as one: the ask's terminal has to carry
    // THIS Lead's `lead_id`, so another Lead's worker, another workspace's terminal, a terminal the
    // operator opened himself and a dispatched run's ask are all the same 404 — ids stay unprobeable.
    // Nothing below changes for admin/Robert/operator: without x-mc-lead this is the route it was.
    const lead = req.get("x-mc-lead") ? leadScope(req) : null;
    if (lead) {
      if (!leadMayAnswer(lead.leadId, ask, ask.session_id ? sessions.get(ask.session_id) : undefined))
        return res.status(404).json({ error: "not found" });
    } else if (!checkScope(req, res, ask.workspace_id)) return;
    if (ask.status !== "open") return res.status(409).json({ error: `ask already ${ask.status}` });
    const by = lead ? `lead:${lead.leadId.slice(0, 8)}` : req.body.by || "human";
    const out = await answerAsk(ask.id, req.body.answer, by);
    if (!out.ok) return res.status(out.status ?? 409).json({ error: out.error });
    res.json(out.ask);
  });

  // Open an interactive terminal that --resumes the headless run's agent session (Claude).
  // Operator can take over and continue working with full transcript context.
  api.post("/runs/:id/continue", validate(ResizeSchema), async (req, res) => {
    const run = runs.get(req.params.id);
    if (run && !checkScope(req, res, jobs.get(run.job_id)?.workspace_id)) return;
    try {
      const s = await continueFromRun(req.params.id, {
        cols: req.body?.cols,
        rows: req.body?.rows,
        seed: req.body?.seed,
      });
      res.status(201).json(s);
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  // Gate workspace/repo/trigger mutations: only the native overlay (which reads the admin token
  // from ~/chronos/.admin-token itself — it runs unsandboxed, see desktop/overlay.swift) may
  // create/edit/delete them. Sandboxed agents are denied that file and the daemon never hands the
  // token out over HTTP, so they can't spin up junk workspaces or mint cross-workspace hooks. Read
  // routes stay open; ticket/memo/job routes stay open (agents need those).
  const requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (tokenOk(req.get("x-mc-admin"), CONFIG.adminToken)) return next();
    res.status(403).json({ error: "workspace mutations are dashboard-only (admin token required)" });
  };

  // The wall's text cards: one request for every terminal you are NOT reading live, returning only the
  // frames that changed since the seq each card last saw (term-screen.ts). Same gate as /term — a
  // frame is the terminal's contents. `ids` caps at 200; `since` is `id:seq,id:seq`.
  // Every live terminal whose goal is ticked, closed in one call — the Desk's "N done" count and
  // Robert's "close everything that is finished" are the same door. A Lead's narrower copy lives at
  // POST /leads/me/close-done (leadGate) and reuses closeDoneSessions below.
  // Hosts: join codes, connected links, revoke (admin only — src/hostlink/brain-link.ts).
  // The brain's menu bar item (desktop/hostbar.swift --brain): the whole fleet, every 3 s. Here and not
  // in hostRoutes because it reads pty activity from terminal.ts, which brain-link.ts must not import.
  api.use(barRoutes(requireAdmin, { link: brainLink, activity: sessionActivity }));
  api.use(hostRoutes(requireAdmin));

  api.post("/desk/close-done", requireAdmin, (_req, res) => {
    res.json({ closed: closeDoneSessions() });
  });
  // The stage footer's quick actions (src/quick-actions.ts) — the sentences the operator taps instead
  // of typing. Stored whole under one kv key: the list is short, the dialog reorders it by moving
  // rows, and a per-row API would need ids that nothing else in the feature wants. An unreadable or
  // schema-breaking value falls back to the defaults rather than leaving the footer bare — this is a
  // convenience, and a bad row must never be able to take the chips away.
  api.get("/desk/quick-actions", requireAdmin, (_req, res) => {
    res.json({ actions: readQuickActions() });
  });
  api.put("/desk/quick-actions", requireAdmin, validate(QuickActionsSchema), (req, res) => {
    kv.set(QUICK_ACTIONS_KV, JSON.stringify(req.body.actions));
    res.json({ actions: req.body.actions });
  });

  // ── live widgets (src/widgets/index.ts) ──────────────────────────────────────────────────────
  // A widget is a reader in that registry plus an ES module under static/desk-widgets/. These two
  // routes are the WHOLE server side of it: the Desk's Fleet board and Robert's `::widget <name>::`
  // both mount through them, so adding a widget never touches this file again. Admin-only like the
  // rest of /api — a card is a live read of the fleet.
  api.get("/widgets", requireAdmin, (_req, res) => res.json(listWidgets()));
  api.get("/widgets/:name", requireAdmin, async (req, res) => {
    // Express hands query values as string | string[] | object; a widget reads its own parameters and
    // should never have to defend against the other two shapes, so drop everything but strings.
    const q: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) if (typeof v === "string") q[k] = v;
    try {
      const out = await readWidget(String(req.params.name), q);
      if (!out) return res.status(404).json({ error: "unknown widget" });
      res.json(out);
    } catch (e: any) {
      // The widget's own failure, not the page's: 500 with the reason, which the card shows as one
      // muted line instead of an empty box that looks like a widget with nothing to say.
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });
  // Chronos deploying itself on request: after a merged PR that is not a ticket (a hotfix), queue
  // the same gated pull → test → build → restart the ticket path uses. Idempotent while queued.
  api.get("/self-deploy", requireAdmin, (_req, res) => res.json(deployStatus()));
  api.post("/self-deploy", requireAdmin, (req, res) => {
    const cur = readPending();
    if (cur && cur.state !== "blocked") return res.status(200).json({ queued: false, pending: cur, note: `already ${cur.state} (${cur.ticket_key})` });
    const label = typeof req.body?.label === "string" ? req.body.label : `manual by ${String(req.get("x-mc-agent") || req.body?.by || "operator")}`;
    const branch = typeof req.body?.branch === "string" && req.body.branch ? req.body.branch : "main";
    const p = queueSelfDeployManual(label, branch);
    if (!p) return res.status(409).json({ error: "self-deploy disabled or unsafe branch name" });
    console.log(`[self-deploy] queued by hand: ${p.ticket_key} (${branch}) — deploys at the next idle window`);
    res.status(201).json({ queued: true, pending: p });
  });
  // Robert's wake queue — what is still owed him, what he already handled, and the manual door out
  // of a row that can never succeed. Admin-scoped: a wake payload quotes a worker's question.
  api.get("/robert/wakes", requireAdmin, (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.recent ?? 20) || 20));
    const shape = (w: RobertWake) => ({
      id: w.id,
      generation: w.generation,
      topic: w.topic,
      key: w.key,
      subject: w.subject,
      workspace_id: w.workspace_id,
      hits: w.hits,
      attempts: w.attempts,
      parked: w.attempts >= WAKE_ATTEMPT_CAP,
      created_at: w.created_at,
      claimed_at: w.claimed_at,
      handled_at: w.handled_at,
      acked_at: w.acked_at,
      last_error: w.last_error,
    });
    const queued = robertWakes.unacked();
    res.json({
      queued: queued.map(shape),
      parked: queued.filter((w) => w.attempts >= WAKE_ATTEMPT_CAP).map(shape),
      recent: robertWakes.recentAcked(limit).map(shape),
      attempt_cap: WAKE_ATTEMPT_CAP,
      beacon_age_ms: wakeBeaconAgeMs(),
    });
  });

  api.post("/robert/wakes/:id/ack", requireAdmin, (req, res) => {
    const w = robertWakes.findByIdPrefix(req.params.id) ?? robertWakes.get(req.params.id);
    if (!w) return res.status(404).json({ error: "no such wake" });
    res.json({ wake: robertWakes.ack(w.id) });
  });

  api.get("/robert/supervision", requireAdmin, (_req, res) => {
    res.json({ ...supervisionVerdict(), grace_ms: supervisionGraceMs(), beacon_age_ms: wakeBeaconAgeMs() });
  });

  api.get("/desk/screens", requireAdmin, (req, res) => {
    const ids = String(req.query.ids ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 200);
    const since = new Map<string, number>();
    for (const pair of String(req.query.since ?? "").split(",")) {
      const i = pair.lastIndexOf(":");
      if (i > 0) since.set(pair.slice(0, i), Number(pair.slice(i + 1)) || 0);
    }
    const screens: Array<{ id: string } & NonNullable<ReturnType<typeof sessionScreen>>> = [];
    const gone: string[] = [];
    for (const id of ids) {
      const sc = sessionScreen(id);
      if (!sc) { gone.push(id); continue; }
      if (since.get(id) === sc.seq) continue;
      screens.push({ id, ...sc });
    }
    res.json({ screens, gone });
  });

  // Triggers: reusable event sources bound to a job. Decorate http triggers with their hook URL.
  const withHookUrl = (t: any) =>
    t.source === "http" && t.token
      ? { ...t, hook_url: `http://localhost:${CONFIG.port}/api/triggers/hook/${t.token}` }
      : t;

  // token/hook_url are bearer creds for the public hook route below — never serve them to a
  // non-admin caller (same rule as wsWithRepos's workspace token strip).
  const isAdminCaller = (req: express.Request) => tokenOk(req.get("x-mc-admin"), CONFIG.adminToken);
  const publicTriggerFor = (req: express.Request) => {
    const admin = isAdminCaller(req);
    return (t: any) => publicTrigger(withHookUrl(t), admin);
  };

  api.get("/triggers", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const list =
      scope.ws === null
        ? triggers.list()
        : triggers.list().filter((t) => jobs.get(t.job_id)?.workspace_id === scope.ws);
    res.json(list.map(publicTriggerFor(req)));
  });

  // Mutations are dashboard-only (admin token), same gate as workspaces/repos/ideas — a sandboxed
  // agent must never be able to mint or rebind a persistent cross-workspace hook.
  api.post("/triggers", requireAdmin, validate(NewTriggerSchema), (req, res) => {
    const job = jobs.get(req.body.job_id);
    if (!job) return res.status(400).json({ error: "job_id not found" });
    if (!checkScope(req, res, job.workspace_id)) return;
    res.status(201).json(publicTriggerFor(req)(triggers.create(req.body)));
  });

  api.get("/triggers/:id", (req, res) => {
    const t = triggers.get(req.params.id);
    if (!t) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, jobs.get(t.job_id)?.workspace_id)) return;
    res.json(publicTriggerFor(req)(t));
  });

  api.patch("/triggers/:id", requireAdmin, validate(PatchTriggerSchema), (req, res) => {
    const cur = triggers.get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, jobs.get(cur.job_id)?.workspace_id)) return;
    if (req.body?.job_id) {
      const newJob = jobs.get(req.body.job_id);
      if (!newJob) return res.status(400).json({ error: "job_id not found" });
      if (!checkScope(req, res, newJob.workspace_id)) return;
    }
    const t = triggers.update(req.params.id, req.body);
    if (!t) return res.status(404).json({ error: "not found" });
    res.json(publicTriggerFor(req)(t));
  });

  api.delete("/triggers/:id", requireAdmin, (req, res) => {
    const cur = triggers.get(req.params.id);
    if (cur && !checkScope(req, res, jobs.get(cur.job_id)?.workspace_id)) return;
    triggers.remove(req.params.id);
    res.json({ ok: true });
  });

  // Inbound webhook. Public by way of the unguessable token in the path; accepts GET or POST.
  const hook = (req: express.Request, res: express.Response) => {
    const t = triggers.getByToken(req.params.token);
    if (!t) return res.status(404).json({ error: "unknown or disabled trigger" });
    const result = fireTrigger(t, {
      method: req.method,
      headers: req.headers as Record<string, unknown>,
      query: req.query as Record<string, unknown>,
      body: req.body,
      ip: req.ip,
      ts: new Date().toISOString(),
    });
    res.status(result.matched ? 200 : 202).json(result);
  };
  api.post("/triggers/hook/:token", hook);
  api.get("/triggers/hook/:token", hook);

  // ───────────────────────────── Mission Control: workspaces ─────────────────────────────
  // Never serve `token` over HTTP (same rule PER-15 applied to the admin token) — it's the
  // per-workspace API credential, sandbox-denied to every OTHER workspace's jobs; leaking it in a
  // GET response would hand any workspace's agent every other workspace's credential right back.
  const wsWithRepos = (w: any) => {
    const { token: _token, ...rest } = w;
    return {
      ...rest,
      connector_config: redactConnectorConfig(w.connector_config),
      repos: repos.list(w.id),
    };
  };

  // Validate that config_dir is unique and not nested with/under other non-archived workspaces.
  const validateConfigDir = (configDir: string, skipWorkspaceId?: string): string | null => {
    const normalized = path.resolve(configDir).replace(/\/$/, "");
    for (const w of workspaces.list(false)) {
      if (skipWorkspaceId && w.id === skipWorkspaceId) continue;
      const otherNormalized = path.resolve(w.config_dir).replace(/\/$/, "");
      if (normalized === otherNormalized) return `config_dir already used by workspace "${w.slug}"`;
      const normalizedWithSep = normalized + path.sep;
      const otherWithSep = otherNormalized + path.sep;
      if (normalizedWithSep.startsWith(otherWithSep))
        return `config_dir is inside workspace "${w.slug}"`;
      if (otherWithSep.startsWith(normalizedWithSep))
        return `config_dir contains workspace "${w.slug}"`;
    }
    return null;
  };

  api.get("/workspaces", (req, res) => {
    const all = workspaces.list(req.query.archived === "1");
    const syncs = connectorSyncs.latestByWorkspace();
    res.json(all.map((w) => ({ ...wsWithRepos(w), last_sync: syncs[w.id] ?? null })));
  });

  api.post("/workspaces", requireAdmin, validate(NewWorkspaceSchema), (req, res) => {
    if (workspaces.getBySlug(req.body.slug))
      return res.status(409).json({ error: "slug already exists" });
    const configDirErr = validateConfigDir(req.body.config_dir);
    if (configDirErr) return res.status(409).json({ error: configDirErr });
    // Schema accepts capabilities as a real array (typos → 400); the column is JSON text.
    const body = Array.isArray(req.body?.capabilities)
      ? { ...req.body, capabilities: JSON.stringify(req.body.capabilities) }
      : req.body;
    const w = wsWithRepos(workspaces.create(body));
    bus.publish({ topic: "workspace.changed" });
    res.status(201).json(w);
  });

  api.get("/workspaces/:id", (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    const w = workspaces.get(req.params.id);
    if (!w) return res.status(404).json({ error: "not found" });
    res.json(wsWithRepos(w));
  });

  api.patch("/workspaces/:id", requireAdmin, validate(PatchWorkspaceSchema), (req, res) => {
    const cur = workspaces.get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not found" });
    if (req.body?.config_dir && req.body.config_dir !== cur.config_dir) {
      const configDirErr = validateConfigDir(req.body.config_dir, req.params.id);
      if (configDirErr) return res.status(409).json({ error: configDirErr });
    }
    // The schema validates capabilities as a real array (so a typo 400s); the column is JSON text.
    const patch = Array.isArray(req.body?.capabilities)
      ? { ...req.body, capabilities: JSON.stringify(req.body.capabilities) }
      : req.body;
    const w = workspaces.update(req.params.id, patch);
    bus.publish({ topic: "workspace.changed" });
    res.json(wsWithRepos(w));
  });

  api.delete("/workspaces/:id", requireAdmin, (req, res) => {
    workspaces.remove(req.params.id);
    bus.publish({ topic: "workspace.changed" });
    res.json({ ok: true });
  });

  // Per-workspace Slack (official OAuth MCP): enable/disable → write/remove the server in its config dir.
  // OAuth itself happens in an interactive terminal in that workspace (the user signs in once).
  api.get("/workspaces/:id/slack", async (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    try {
      const w = workspaces.get(req.params.id);
      if (!w) return res.status(404).json({ error: "not found" });
      res.json(await slackStatus(w));
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });
  api.post("/workspaces/:id/slack", validate(SlackConfigSchema), async (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    try {
      const cur = workspaces.get(req.params.id);
      if (!cur) return res.status(404).json({ error: "not found" });
      const prev = cur.slack_config ? JSON.parse(cur.slack_config) : {};
      const enabled = req.body?.enabled !== undefined ? !!req.body.enabled : (prev.enabled ?? true);
      const triage = req.body?.triage !== undefined ? !!req.body.triage : (prev.triage ?? false);
      const w = workspaces.update(req.params.id, { slack_config: enabled ? { enabled: true, triage } : null });
      if (!w) return res.status(404).json({ error: "not found" });
      installSlackMcp(w);
      ensureTriageJob(w);
      res.json(await slackStatus(w));
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });
  api.delete("/workspaces/:id/slack", (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    const w = workspaces.update(req.params.id, { slack_config: null });
    if (!w) return res.status(404).json({ error: "not found" });
    installSlackMcp(w);
    ensureTriageJob(w);
    res.json({ ok: true });
  });

  // Per-workspace egress firewall: read config + live proxy port + the host audit log.
  api.get("/workspaces/:id/egress", (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    const w = workspaces.get(req.params.id);
    if (!w) return res.status(404).json({ error: "not found" });
    res.json({ ...egressCfg(w), port: egressPort(w.id), baseAllow: CONFIG.egress.baseAllow, hosts: egressLog.hosts(w.id, 100) });
  });
  // Admin-gated: setting/clearing egress policy reconfigures the proxy fleet.
  api.put("/workspaces/:id/egress", requireAdmin, validate(EgressSchema), async (req, res) => {
    try {
      const w = workspaces.get(req.params.id);
      if (!w) return res.status(404).json({ error: "not found" });
      const mode = req.body.mode === "audit" || req.body.mode === "enforce" ? req.body.mode : "off";
      const allow = (req.body.allow ?? []).map((s: string) => s.trim().toLowerCase()).filter(Boolean);
      const up = workspaces.update(req.params.id, { egress_config: mode === "off" ? null : { mode, allow } });
      await syncEgress();
      bus.publish({ topic: "workspace.changed" });
      res.json({ ...egressCfg(up!), port: egressPort(req.params.id) });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });
  api.get("/egress/log", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    res.json(egressLog.list({
      workspace_id: scope.ws ?? (req.query.workspace as string | undefined),
      action: req.query.action as string | undefined,
      limit: Number(req.query.limit ?? 200),
    }));
  });

  // ───────────────────────────── Credential broker ───────────────────────────────────────────────
  // The daemon proxies an HTTPS call and injects the auth header server-side, so the secret never
  // enters the sandbox (see src/broker.ts). Callers must present a REAL identity: a workspace token
  // (sandboxed agents have MC_WORKSPACE_TOKEN) or the admin token — the anonymous-localhost grace
  // that older endpoints keep does NOT apply here, because this endpoint spends credentials.
  api.post("/broker/:slug", async (req, res) => {
    const isAdmin = tokenOk(req.get("x-mc-admin"), CONFIG.adminToken);
    const tok = req.get("x-mc-workspace-token");
    const ws = tok ? workspaces.getByToken(tok) : undefined;
    if (!isAdmin && !ws) return res.status(401).json({ error: "broker requires a workspace or admin token" });

    const cred = findCred(loadBrokerCreds(), req.params.slug);
    // 404 for unknown AND not-permitted: a scoped caller can't enumerate other workspaces' creds.
    if (!cred || !wsAllowed(cred, isAdmin && !ws ? null : ws!.slug)) return res.status(404).json({ error: "not found" });

    const method = String(req.body?.method ?? "GET");
    const reqPath = String(req.body?.path ?? "");
    const body = req.body?.body === undefined ? undefined : String(req.body.body);
    if (body !== undefined && body.length > 256 * 1024) return res.status(400).json({ error: "body too large (max 256KB)" });
    const contentType = req.body?.content_type ? String(req.body.content_type).slice(0, 100) : undefined;

    const checked = credAllows(cred, method, reqPath);
    const ref = `broker:${cred.slug} ${method.toUpperCase()} ${reqPath.slice(0, 200)}`;
    // Port from the cred's own host so the audit log reflects the real destination.
    const port = Number(cred.host.split(":")[1] ?? (cred.insecure_http ? 80 : 443));
    if (!checked.ok) {
      egressLog.add({ workspace_id: ws?.id ?? null, host: cred.host, port, action: "deny", ref });
      return res.status(403).json({ error: checked.error });
    }
    try {
      // The VALIDATED target goes on the wire, not the raw path (see credAllows).
      const out = await brokerCall(cred, method, checked.target, body, contentType);
      // Logged after the fact: a call that never left the box (DNS refusal, timeout) must not be
      // recorded as allowed egress.
      egressLog.add({ workspace_id: ws?.id ?? null, host: cred.host, port, action: "allow", ref });
      res.json(out);
    } catch (e: any) {
      egressLog.add({ workspace_id: ws?.id ?? null, host: cred.host, port, action: "deny", ref: `${ref} [failed]` });
      // NEVER echo the upstream error to the caller: some carry the request headers — i.e. the
      // credential — in their message text, which would hand the sandbox the very secret this
      // endpoint exists to withhold. Operator sees the detail in the daemon log.
      console.warn(`[broker] ${cred.slug} call failed:`, e?.message ?? e);
      res.status(502).json({ error: "upstream call failed (see daemon log)" });
    }
  });

  // ───────────────────────────── shared vars (per-workspace env) ────────────────────────────────
  // One env var handed to every agent in ONE workspace, optionally for N hours: "here's X_TOKEN for
  // the next 12". Values are merged into the child env at spawn (see child-env.ts), so an agent USES
  // one without ever reading it — which is the point: pasting a token into a terminal puts it in the
  // transcript, the scrollback, and whatever the agent echoes back.
  //
  // Read/list is scoped (values NEVER travel — `list` strips them). Mutations are admin-gated like
  // every other workspace mutation: an agent must not be able to mint or rewrite its own credentials.
  // The one path values leave by is /export below, which an agent reaches with its workspace token.
  // Robert's brief per workspace (src/briefs.ts): the operator writes it once from the Desk, Robert
  // keeps it current. Reads are scoped; writes are admin-gated (a worker must not rewrite the page
  // that steers its own manager).
  api.get("/briefs", requireAdmin, (_req, res) => {
    res.json(briefs.listBriefs().map((b) => ({ workspace_id: b.workspace_id, name: b.name, slug: b.slug,
      body: b.note?.body ?? briefs.BRIEF_SEED, updated_at: b.note?.updated_at ?? null, empty: !b.note })));
  });
  api.get("/workspaces/:id/brief", (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    const n = briefs.briefNote(req.params.id, false);
    res.json(n ? publicNote(n) : { workspace_id: req.params.id, body: briefs.BRIEF_SEED, empty: true });
  });
  api.put("/workspaces/:id/brief", requireAdmin, validate(BriefRewriteSchema), (req, res) => {
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    res.json(publicNote(briefs.rewriteBrief(req.params.id, req.body.body)));
  });
  api.post("/workspaces/:id/brief", requireAdmin, validate(BriefAppendSchema), (req, res) => {
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    res.status(201).json(publicNote(briefs.appendBrief(req.params.id, req.body.fact, req.body.heading)));
  });

  // The workspace's worklog (src/worklog.ts): the full ledger behind the brief's Recently/Next.
  // Reads are scoped (it is this client's work history). Writing one is admin-gated for the same
  // reason a brief write is: an entry lands in the brief's Recently/Next, and a worker must not be
  // able to write the page that steers its own manager — except a Lead may write in ITS OWN
  // workspace only, with the author forced to `lead:<id8>` (never whatever the body claimed).
  // The daemon's automatic entries never come through here. Backfill spends real model calls over
  // already-ended work, so it stays admin-only.
  api.get("/workspaces/:id/worklog", (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    const limit = Math.min(Math.max(Number(req.query.limit ?? 25) || 25, 1), 200);
    res.json({ workspace_id: req.params.id, entries: worklog.readWorklog(req.params.id, limit) });
  });
  api.post("/workspaces/:id/worklog", validate(WorklogEntrySchema), (req, res) => {
    const admin = tokenOk(req.get("x-mc-admin"), CONFIG.adminToken);
    const lead = !admin && req.get("x-mc-lead") ? leadScope(req) : null;
    if (!admin && !lead)
      return res.status(403).json({ error: "writing the worklog is admin-gated (x-mc-admin), or a Lead in its own workspace (x-mc-lead)" });
    if (lead && lead.ws !== req.params.id) return res.status(404).json({ error: "not found" });
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    try {
      // Through the same validator the model's output goes through, so a hand-written entry can't
      // put the ledger's own "·" separator inside a field.
      const entry = worklog.parseEntry(req.body);
      if (!entry) return res.status(400).json({ error: "what and outcome are required" });
      const row = worklog.writeEntry(req.params.id, entry);
      const by = lead ? `lead:${lead.leadId.slice(0, 8)}` : String(req.get("x-mc-agent") || "operator");
      bus.publish({
        topic: "worklog.written",
        workspace_id: req.params.id,
        what: row.what,
        by,
        actor: by,
      });
      res.status(201).json(row);
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });
  api.post("/workspaces/:id/worklog/backfill", requireAdmin, validate(WorklogBackfillSchema), async (req, res) => {
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    try {
      const since = worklog.sinceIso(req.body.since ?? "7d");
      const r = await worklog.backfill(req.params.id, since, { limit: req.body.limit });
      res.json({ since, ...r });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  api.get("/workspaces/:id/vars", (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    res.json(workspaceVars.list(req.params.id));
  });

  // name → value for every live var, for `mc vars export` (agents eval this; nothing is printed).
  // The ONLY route that serves values, so it does NOT use checkScope: that helper treats a caller
  // presenting no token at all as unrestricted, and every sandboxed agent has loopback — which would
  // let workspace A's agent read workspace B's credentials simply by omitting its own header. Here a
  // credential is mandatory and must match: the admin token, or THIS workspace's token.
  api.get("/workspaces/:id/vars/export", (req, res) => {
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    const admin = tokenOk(req.get("x-mc-admin"), CONFIG.adminToken);
    const wsTok = req.get("x-mc-workspace-token");
    const mine = !!wsTok && workspaces.getByToken(wsTok)?.id === req.params.id;
    if (!admin && !mine)
      return res.status(403).json({ error: "shared var values need this workspace's own token" });
    res.json(workspaceVars.active(req.params.id));
  });

  api.post("/workspaces/:id/vars", requireAdmin, validate(NewWorkspaceVarSchema), (req, res) => {
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    const name = String(req.body.name).trim();
    const err = varNameError(name);
    if (err) return res.status(400).json({ error: err });
    const v = workspaceVars.set(req.params.id, name, req.body.value, expiryFromHours(req.body.hours));
    // Activity, not the value: the trail says a credential was handed over and when it lapses.
    activity.add({
      workspace_id: req.params.id, topic: "workspace.var.set", actor: "operator", entity: name,
      detail: v.expires_at ? `expires ${v.expires_at}` : "no expiry",
    });
    res.status(201).json(v);
  });

  api.patch("/workspaces/:id/vars/:varId", requireAdmin, validate(PatchWorkspaceVarSchema), (req, res) => {
    const cur = workspaceVars.get(req.params.varId);
    if (!cur || cur.workspace_id !== req.params.id) return res.status(404).json({ error: "not found" });
    // `hours` present-but-null clears the expiry (never expires); absent leaves it untouched.
    const patch: { value?: string; expires_at?: string | null } = {};
    if (req.body.value !== undefined) patch.value = req.body.value;
    if ("hours" in req.body) patch.expires_at = expiryFromHours(req.body.hours);
    res.json(workspaceVars.patch(req.params.varId, patch));
  });

  api.delete("/workspaces/:id/vars/:varId", requireAdmin, (req, res) => {
    const cur = workspaceVars.get(req.params.varId);
    if (!cur || cur.workspace_id !== req.params.id) return res.status(404).json({ error: "not found" });
    workspaceVars.remove(req.params.varId);
    res.json({ ok: true });
  });

  // ───────────────────────────── Mission Control: skills (procedural memory) ─────────────────────
  // L0 list (progressive disclosure: just metadata). Agents call this to see what's available.
  api.get("/workspaces/:id/skills", (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    res.json(skills.list({ workspace_id: req.params.id, status: req.query.status as string | undefined }));
  });
  // L1 full skill (markdown body) or L2 reference file (?ref=). ?use=1 bumps usage (real reuse).
  api.get("/skills/:id", (req, res) => {
    const s = skills.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, s.workspace_id)) return;
    if (req.query.ref) {
      const content = skillRef(s, String(req.query.ref));
      if (content == null) return res.status(404).json({ error: "reference not found" });
      return res.type("text/plain").send(content);
    }
    if (req.query.use === "1") {
      useSkill(s.id);
      recordRead(s.workspace_id, { kind: "skill_view", ref: s.id }, { source: "api", session_id: sessionFor(s.workspace_id, req.query.session) });
    }
    res.json({ ...s, body: skillBody(s) });
  });
  // Create (open — agents author skills; they land `pending` unless the workspace auto-publishes).
  api.post("/workspaces/:id/skills", validate(NewSkillSchema), (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    try {
      const s = createSkill({
        workspace_id: req.params.id,
        name: req.body.name, description: req.body.description,
        category: req.body.category ?? null, tags: req.body.tags ?? null,
        body: req.body.body, source: req.body.source,
      });
      res.status(201).json(s);
    } catch (e: any) { res.status(400).json({ error: String(e.message ?? e) }); }
  });
  // Content patch / append (open — agents improve skills on reuse; re-gated to pending unless auto-publish).
  api.patch("/skills/:id", validate(PatchSkillSchema), (req, res) => {
    const cur = skills.get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, cur.workspace_id)) return;
    try {
      const s = "append" in req.body
        ? appendSkill(req.params.id, req.body.append, req.body.heading)
        : patchSkill(req.params.id, req.body.old, req.body.new);
      res.json(s);
    } catch (e: any) { res.status(400).json({ error: String(e.message ?? e) }); }
  });
  // Status transitions + delete are operator-only (the human gate on what enters the vault).
  api.post("/skills/:id/approve", requireAdmin, (req, res) => {
    if (!skills.get(req.params.id)) return res.status(404).json({ error: "not found" });
    res.json(setSkillStatus(req.params.id, "active"));
  });
  api.post("/skills/:id/reject", requireAdmin, (req, res) => {
    if (!skills.get(req.params.id)) return res.status(404).json({ error: "not found" });
    res.json(setSkillStatus(req.params.id, "archived"));
  });
  api.post("/skills/:id/archive", requireAdmin, validate(ArchiveSkillSchema), (req, res) => {
    if (!skills.get(req.params.id)) return res.status(404).json({ error: "not found" });
    res.json(setSkillStatus(req.params.id, req.body.to === "active" ? "active" : "archived"));
  });
  api.delete("/skills/:id", requireAdmin, (req, res) => {
    removeSkill(req.params.id);
    res.json({ ok: true });
  });

  // ───────────────────────────── Desk: jots (the parked thought) ────────────────
  // Rows a client owns, edited in place until they are worth starting. Reads follow the same
  // workspace scoping as everything else; writes are operator-only — a sandboxed agent has no
  // business rewriting the operator's own list of what to do next.
  api.get("/workspaces/:id/jots", (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    res.json(jots.list({
      workspace_id: req.params.id,
      status: req.query.status as string | undefined,
      for_date: req.query.date as string | undefined,
    }));
  });

  // Operator-only, with one carve-out: a workspace-scoped caller (a terminal's `mc pad add` / `mc jot
  // new`) may ADD a row to its own client's pad. `source` is stamped from who is calling, never from
  // the body — `nextday` for a dated card, `agent` for an undated follow-up — so the operator's own
  // list and what agents parked on it stay distinguishable. Rewriting or deleting a row stays admin.
  api.post("/workspaces/:id/jots", validate(NewJotSchema), (req, res) => {
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    if (!checkScope(req, res, req.params.id)) return;
    const policy = jotWritePolicy({ admin: isAdminCaller(req), scopedWs: callerScope(req)?.ws }, req.body);
    if (!policy.ok) return res.status(policy.status).json({ error: policy.error });
    let followAt: string | null = null;
    if (req.body.follow_up_at) {
      followAt = parseFollowUpAt(req.body.follow_up_at);
      if (!followAt) return res.status(400).json({ error: `can't read follow-up time '${req.body.follow_up_at}' — try +2d, tomorrow 9:00, monday, 2026-10-01 14:00` });
      const fp = followUpPolicy(
        { admin: isAdminCaller(req), scopedWs: callerScope(req)?.ws, session: req.get("x-mc-session") },
        { workspace_id: req.params.id, source: policy.source, follow_up_session: null, follow_up_count: 0 },
        { at: followAt },
      );
      if (!fp.ok) return res.status(fp.status).json({ error: fp.error });
    }
    const row = jots.create({
      workspace_id: req.params.id,
      title: req.body.title,
      body: req.body.body ?? null,
      for_date: req.body.for_date ?? null,
      source: policy.source,
      planned_by: policy.planned_by,
      follow_up_at: followAt,
      follow_up_check: followAt ? (req.body.follow_up_check?.trim() || null) : null,
    });
    bus.publish({ topic: "jot.updated", jot_id: row.id, workspace_id: row.workspace_id });
    res.status(201).json(row);
  });

  // Plan tomorrow: one planner terminal per client (default: every client with a default_dir). Admin
  // because it crosses every client wall by design — the Desk button and Robert both hold the token.
  api.post("/nextday", requireAdmin, validate(PlanNextDaySchema), async (req, res) => {
    try {
      const r = await planNextDay(req.body ?? {});
      res.status(r.planned.length ? 202 : 400).json(r);
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  // Append is the one edit a terminal may make, and only on its own client's rows: it adds to what is
  // written and cannot take anything away, so it is as safe as filing a new row.
  api.post("/jots/:id/append", validate(JotAppendSchema), (req, res) => {
    const j = jots.get(req.params.id);
    if (!j) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, j.workspace_id)) return;
    if (!isAdminCaller(req) && !callerScope(req)?.ws) return res.status(403).json({ error: "workspace mutations are dashboard-only (admin token required)" });
    if ((j.body?.length ?? 0) + req.body.text.length + 1 > JOT_BODY_MAX) return res.status(413).json({ error: `row detail would exceed ${JOT_BODY_MAX} chars — start a new row` });
    const row = jots.append(j.id, req.body.text)!;
    bus.publish({ topic: "jot.updated", jot_id: row.id, workspace_id: row.workspace_id });
    res.json(row);
  });

  // Follow-ups (src/jot-followup.ts): when an agent should come back to this note, and what it should
  // check. The operator schedules anything; a terminal only on its own client's agent-filed notes, or
  // the note whose follow-up opened it — so a follow-up terminal can close its own loop.
  const followCaller = (req: express.Request) => ({ admin: isAdminCaller(req), scopedWs: callerScope(req)?.ws, session: req.get("x-mc-session") });
  api.post("/jots/:id/follow-up", validate(JotFollowUpSchema), (req, res) => {
    const j = jots.get(req.params.id);
    if (!j) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, j.workspace_id)) return;
    let at: string | null = null;
    if (req.body.at) {
      at = parseFollowUpAt(req.body.at);
      if (!at) return res.status(400).json({ error: `can't read '${req.body.at}' — try +2d, tomorrow 9:00, monday 10, 2026-10-01 14:00` });
    }
    const p = followUpPolicy(followCaller(req), j, { at });
    if (!p.ok) return res.status(p.status).json({ error: p.error });
    try {
      const check = req.body.check === undefined ? undefined : (req.body.check?.trim() || null);
      const row = jots.setFollowUp(j.id, at, check)!;
      bus.publish({ topic: "jot.updated", jot_id: row.id, workspace_id: row.workspace_id });
      res.json(row);
    } catch (e: any) {
      res.status(409).json({ error: String(e?.message ?? e) });
    }
  });

  // "Follow up now": the same terminal the timer would open, without waiting for it.
  api.post("/jots/:id/follow-up/now", requireAdmin, async (req, res) => {
    const j = jots.get(req.params.id);
    if (!j) return res.status(404).json({ error: "not found" });
    if (j.status === "done") return res.status(409).json({ error: "note is done — reopen it first" });
    const nowMs = Date.now();
    jots.setFollowUp(j.id, new Date(nowMs).toISOString());
    const session = await fireFollowUp(j.id, nowMs);
    if (!session) return res.status(409).json({ error: "couldn't open a terminal now (seat cap or busy machine) — it will retry in 15 minutes" });
    res.status(201).json({ jot: jots.get(j.id), session });
  });

  // Close a note with a reason: the reason is appended so the pad keeps why, then it is marked done.
  api.post("/jots/:id/resolve", validate(JotResolveSchema), (req, res) => {
    const j = jots.get(req.params.id);
    if (!j) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, j.workspace_id)) return;
    const p = followUpPolicy(followCaller(req), j);
    if (!p.ok) return res.status(p.status).json({ error: p.error });
    const note = req.body.note?.trim();
    if (note) jots.append(j.id, `✓ Resolved ${new Date().toISOString().slice(0, 10)} — ${note}`);
    const row = jots.update(j.id, { status: "done" })!;
    bus.publish({ topic: "jot.updated", jot_id: row.id, workspace_id: row.workspace_id });
    res.json(row);
  });

  api.patch("/jots/:id", requireAdmin, validate(JotPatchSchema), (req, res) => {
    if (!jots.get(req.params.id)) return res.status(404).json({ error: "not found" });
    const row = jots.update(req.params.id, req.body)!;
    bus.publish({ topic: "jot.updated", jot_id: row.id, workspace_id: row.workspace_id });
    res.json(row);
  });

  api.delete("/jots/:id", requireAdmin, (req, res) => {
    if (!jots.remove(req.params.id)) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  });

  api.post("/workspaces/:id/jots/reorder", requireAdmin, validate(ReorderJotsSchema), (req, res) => {
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    jots.reorder(req.params.id, req.body.ids);
    res.json(jots.list({ workspace_id: req.params.id }));
  });

  // The one action: open a terminal seeded from the row. 409 rather than 500 when the workspace is
  // at its session cap — that is a "not now", not a failure of the request.
  api.post("/jots/:id/run", requireAdmin, validate(RunJotSchema), async (req, res) => {
    if (!jots.get(req.params.id)) return res.status(404).json({ error: "not found" });
    try {
      const { jot, session } = await runJot(req.params.id, req.body ?? {});
      res.status(201).json({ jot, session });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      res.status(/cap reached/.test(msg) ? 409 : 400).json({ error: msg });
    }
  });

  // ───────────────────────────── Desk launches ─────────────────────────────
  // A saved New-terminal dialog under a name (store/launches.ts). Operator-only: a launch spawns
  // a live terminal in a client, which is the operator's hand, not an agent's.
  api.get("/workspaces/:id/launches", (req, res) => {
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    if (!checkScope(req, res, req.params.id)) return;
    res.json(launches.list({ workspace_id: req.params.id }));
  });
  api.post("/workspaces/:id/launches", requireAdmin, validate(NewLaunchSchema), (req, res) => {
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    const row = launches.create({ workspace_id: req.params.id, ...req.body });
    bus.publish({ topic: "launch.updated", launch_id: row.id, workspace_id: row.workspace_id });
    res.status(201).json(row);
  });
  api.patch("/launches/:id", requireAdmin, validate(LaunchPatchSchema), (req, res) => {
    const cur = launches.get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not found" });
    const row = launches.update(req.params.id, req.body)!;
    bus.publish({ topic: "launch.updated", launch_id: row.id, workspace_id: row.workspace_id });
    res.json(row);
  });
  api.delete("/launches/:id", requireAdmin, (req, res) => {
    const cur = launches.get(req.params.id);
    if (!cur || !launches.remove(cur.id)) return res.status(404).json({ error: "not found" });
    bus.publish({ topic: "launch.updated", launch_id: cur.id, workspace_id: cur.workspace_id });
    res.status(204).end();
  });
  api.post("/workspaces/:id/launches/reorder", requireAdmin, validate(ReorderLaunchesSchema), (req, res) => {
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    launches.reorder(req.params.id, req.body.ids);
    res.json(launches.list({ workspace_id: req.params.id }));
  });
  api.post("/launches/:id/run", requireAdmin, async (req, res) => {
    if (!launches.get(req.params.id)) return res.status(404).json({ error: "not found" });
    try {
      const r = await runLaunch(req.params.id, req.body ?? {});
      res.status(201).json(r);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      res.status(/cap reached/.test(msg) ? 409 : 400).json({ error: msg });
    }
  });

  // ───────────────────────────── Mission Control: idea pool ─────────────────────
  api.get("/workspaces/:id/ideas", (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    res.json(ideas.list({ workspace_id: req.params.id, status: req.query.status as string | undefined }));
  });
  api.get("/workspaces/:id/ideas/stats", (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    res.json(ideas.stats(req.params.id));
  });
  // Create (open — agents + feeders file ideas; operator triages).
  api.post("/workspaces/:id/ideas", validate(NewIdeaSchema), (req, res) => {
    if (!checkScope(req, res, req.params.id)) return;
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    try {
      const idea = createIdea({
        workspace_id: req.params.id,
        title: req.body.title,
        pitch: req.body.pitch,
        kind: req.body.kind,
        source: req.body.source ?? "manual",
        repo_id: req.body.repo_id ?? null,
        source_ref: req.body.source_ref ?? null,
        acceptance: req.body.acceptance ?? null,
        model: req.body.model ?? null,
      });
      if (!idea) return res.status(409).json({ error: "duplicate title in proposed pool" });
      res.status(201).json(idea);
    } catch (e: any) {
      res.status(400).json({ error: String(e.message ?? e) });
    }
  });
  api.post("/ideas/:id/promote", requireAdmin, validate(PromoteIdeaSchema), async (req, res) => {
    if (!ideas.get(req.params.id)) return res.status(404).json({ error: "not found" });
    try {
      const ticket = await promoteIdea(req.params.id, { external: !!req.body.external });
      res.json({ idea: ideas.get(req.params.id), ticket });
    } catch (e: any) {
      res.status(400).json({ error: String(e.message ?? e) });
    }
  });
  api.post("/ideas/:id/kill", requireAdmin, (req, res) => {
    if (!ideas.get(req.params.id)) return res.status(404).json({ error: "not found" });
    try {
      res.json(killIdea(req.params.id));
    } catch (e: any) {
      res.status(400).json({ error: String(e.message ?? e) });
    }
  });
  api.post("/ideas/kill", requireAdmin, validate(KillIdeasSchema), (req, res) => {
    res.json(killIdeas(req.body.ids));
  });
  // Batch promote — the other half of a daily intake sweep. Triaging a morning's drafts one HTTP
  // call at a time is exactly the friction that makes an operator stop reading them. Partial
  // failures are reported per id rather than failing the batch: one bad draft must not block the rest.
  api.post("/ideas/promote", requireAdmin, validate(PromoteIdeasSchema), async (req, res) => {
    const promoted: unknown[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of req.body.ids as string[]) {
      try {
        const ticket = await promoteIdea(id, { external: !!req.body.external });
        promoted.push({ idea_id: id, ticket });
      } catch (e: any) {
        failed.push({ id, error: String(e?.message ?? e) });
      }
    }
    res.json({ promoted, failed });
  });
  // Manual trigger for miner/followups — headless job, returns immediately (UI toasts + deep-links the run).
  // force=true (default on this route) bypasses the workspace enabled flag so operators can always run.
  api.post("/workspaces/:id/ideas/generate", requireAdmin, validate(GenerateIdeasSchema), (req, res) => {
    if (!workspaces.get(req.params.id)) return res.status(404).json({ error: "workspace not found" });
    // The intake sweep is a scheduled job, not a pool feeder — "run it now" means run that job now.
    if (req.body.feeder === "intake") {
      const ws = workspaces.get(req.params.id)!;
      try {
        ensureIntakeJob(ws);
        const job = jobs.list().find((j) => j.name === `intake:${ws.slug}`);
        if (!job) return res.status(400).json({ error: "intake is disabled for this workspace" });
        const r = dispatch(job.id, `intake:${ws.slug}`);
        if ("error" in r) return res.status(400).json({ error: r.error });
        return res.status(202).json({ job_id: job.id, ...r });
      } catch (e: any) {
        return res.status(400).json({ error: String(e.message ?? e) });
      }
    }
    const feeder = req.body.feeder === "followups" ? "followups" : "miner";
    try {
      const r = dispatchIdeaFeeder(req.params.id, feeder, {
        ticketId: req.body.ticket_id ?? null,
        force: req.body.force !== false,
      });
      if (r.status?.startsWith("error")) return res.status(400).json({ error: r.status });
      res.status(202).json(r);
    } catch (e: any) {
      res.status(400).json({ error: String(e.message ?? e) });
    }
  });
  // Ticket-scoped follow-up idea generation (same headless job, ticket context pre-filled).
  api.post("/tickets/:id/ideas/generate", requireAdmin, (req, res) => {
    const t = tickets.get(req.params.id);
    if (!t) return res.status(404).json({ error: "ticket not found" });
    try {
      const r = dispatchIdeaFeeder(t.workspace_id, "followups", {
        ticketId: t.id,
        force: true,
      });
      if (r.status?.startsWith("error")) return res.status(400).json({ error: r.status });
      res.status(202).json(r);
    } catch (e: any) {
      res.status(400).json({ error: String(e.message ?? e) });
    }
  });

  api.post("/workspaces/:id/sync", async (req, res) => {
    const w = workspaces.get(req.params.id);
    if (!w) return res.status(404).json({ error: "not found" });
    try {
      res.json(await syncWorkspace(w));
    } catch (e: any) {
      res.status(400).json({ error: String(e.message ?? e) });
    }
  });

  api.post("/workspaces/:id/repos", requireAdmin, validate(NewRepoSchema), async (req, res) => {
    if (!workspaces.get(req.params.id))
      return res.status(404).json({ error: "workspace not found" });
    try {
      // Autodetect omitted default_branch/git_remote from the checkout; reject mismatches (PER-19).
      const resolved = await resolveRepoGitFields({
        path: req.body.path,
        default_branch: req.body.default_branch,
        git_remote: req.body.git_remote,
        delivery: req.body.delivery,
        explicit: {
          default_branch: Object.prototype.hasOwnProperty.call(req.body, "default_branch"),
          git_remote: Object.prototype.hasOwnProperty.call(req.body, "git_remote"),
        },
      });
      const r = repos.create({ ...req.body, ...resolved, workspace_id: req.params.id });
      bus.publish({ topic: "workspace.changed" });
      res.status(201).json(r);
    } catch (e: any) {
      if (e instanceof RepoGitError) return res.status(400).json({ error: e.message });
      // Express 4 does not forward an async handler's rejection to the error middleware:
      // rethrowing here would hang the request and only surface as an unhandledRejection.
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  api.patch("/repos/:id", requireAdmin, validate(PatchRepoSchema), async (req, res) => {
    const existing = repos.get(req.params.id);
    if (!existing) return res.status(404).json({ error: "repo not found" });
    const touchesGit =
      req.body.path !== undefined ||
      req.body.default_branch !== undefined ||
      Object.prototype.hasOwnProperty.call(req.body, "git_remote") ||
      req.body.delivery !== undefined;
    try {
      let patch = req.body;
      if (touchesGit) {
        const resolved = await resolveRepoGitFields({
          path: req.body.path ?? existing.path,
          default_branch:
            req.body.default_branch !== undefined ? req.body.default_branch : existing.default_branch,
          git_remote: Object.prototype.hasOwnProperty.call(req.body, "git_remote")
            ? req.body.git_remote
            : existing.git_remote,
          delivery: req.body.delivery ?? (existing.delivery as "commit" | "pr"),
          explicit: {
            default_branch: Object.prototype.hasOwnProperty.call(req.body, "default_branch"),
            git_remote: Object.prototype.hasOwnProperty.call(req.body, "git_remote"),
          },
        });
        patch = {
          ...req.body,
          default_branch: resolved.default_branch,
          git_remote: resolved.git_remote,
          delivery: resolved.delivery,
        };
      }
      const r = repos.update(req.params.id, patch);
      bus.publish({ topic: "workspace.changed" });
      res.json(r);
    } catch (e: any) {
      if (e instanceof RepoGitError) return res.status(400).json({ error: e.message });
      // See the POST handler above: Express 4 swallows async rejections.
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  api.delete("/repos/:id", requireAdmin, (req, res) => {
    repos.remove(req.params.id);
    bus.publish({ topic: "workspace.changed" });
    res.json({ ok: true });
  });

  // Gate commands this repo's own build files imply — npm scripts, pytest, go test, cargo, flutter,
  // dbt, gradle, make. Read-only suggestion: attaching a repo shouldn't mean the operator (or Robert)
  // remembering every stack's incantation. Nothing runs until it's saved to gate_cmds.
  api.get("/repos/:id/gates/suggest", (req, res) => {
    const repo = repos.get(req.params.id);
    if (!repo) return res.status(404).json({ error: "repo not found" });
    res.json({ current: parseGates(repo), suggested: suggestGates(repo.path) });
  });

  // ───────────────────────────── repo accelerators (graphify/ast-grep/repomix) ─────────────────────
  // Read is open to the repo's own workspace (agents inspect their own status); the switch itself is
  // admin-gated like every other repo mutation — enabling a fleet-wide tool is the operator's call,
  // not something an agent grants itself mid-run.
  api.get("/repos/:id/accel", (req, res) => {
    const repo = repos.get(req.params.id);
    if (!repo) return res.status(404).json({ error: "repo not found" });
    if (!checkScope(req, res, repo.workspace_id)) return;
    const ws = workspaces.get(repo.workspace_id);
    if (!ws) return res.status(404).json({ error: "workspace not found" });
    res.json(accelStatus(repo, ws));
  });

  api.patch("/repos/:id/accel/:tool", requireAdmin, validate(PatchAccelSchema), (req, res) => {
    const repo = repos.get(req.params.id);
    if (!repo) return res.status(404).json({ error: "repo not found" });
    const tool = req.params.tool;
    if (!isAcceleratorTool(tool)) return res.status(400).json({ error: `unknown accelerator '${tool}'` });
    const cur = repoAccelerators.get(repo.id, tool);
    const enabled = req.body.enabled !== undefined ? req.body.enabled : !!cur?.enabled;
    try {
      const row = repoAccelerators.setEnabled(repo.workspace_id, repo.id, tool, enabled, req.body.mode);
      activity.add({
        workspace_id: repo.workspace_id, topic: row.enabled ? "accel.enabled" : "accel.disabled",
        actor: "operator", entity: tool, detail: repo.name,
      });
      bus.publish({ topic: "workspace.changed" });
      res.json(row);
    } catch (e: any) {
      // setEnabled's own ownership check (workspaceId must match repos.get(repoId).workspace_id) —
      // unreachable via this route today since workspaceId is always repo.workspace_id itself, but
      // caught here rather than left to 500 in case that ever changes.
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  // Graphify canary: admin build + workspace-scoped query. Executable only — no MCP/profile/hook/
  // skill/prompt wiring. Telemetry is content-free (see accel_telemetry / migration 126).
  api.post("/repos/:id/accel/graphify/build", requireAdmin, validate(BuildGraphifySchema), async (req, res) => {
    const repo = repos.get(req.params.id);
    if (!repo) return res.status(404).json({ error: "repo not found" });
    try {
      const result = await buildGraphify(repo, {
        sessionId: req.body.session_id ?? null,
        force: !!req.body.force,
      });
      activity.add({
        workspace_id: repo.workspace_id, topic: "accel.build",
        actor: "operator", entity: "graphify", detail: repo.name,
      });
      res.json(result);
    } catch (e: any) {
      const status = e instanceof GraphifyError ? e.status : 500;
      res.status(status).json({ error: String(e?.message ?? e), code: e?.code });
    }
  });

  api.post("/repos/:id/accel/graphify/query", validate(QueryGraphifySchema), async (req, res) => {
    const repo = repos.get(req.params.id);
    if (!repo) return res.status(404).json({ error: "repo not found" });
    if (!checkScope(req, res, repo.workspace_id)) return;
    try {
      const result = await queryGraphify(repo, {
        question: req.body.question,
        budget: req.body.budget,
        sessionId: req.body.session_id ?? null,
      });
      res.json(result);
    } catch (e: any) {
      const status = e instanceof GraphifyError ? e.status : 500;
      res.status(status).json({ error: String(e?.message ?? e), code: e?.code });
    }
  });

  // ───────────────────────────── Mission Control: tickets ─────────────────────────────
  api.get("/tickets", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const wsId = scope.ws ?? (req.query.workspace as string | undefined);
    const costs = tickets.costMap(wsId);
    const blocked = ticketLinks.blockedIds();
    // One query for every repo's delivery mode instead of a repos.get() per ticket in the map below.
    const repoDelivery = new Map(repos.list().map((r) => [r.id, r.delivery]));
    res.json(
      tickets
        .list({ workspace_id: wsId, status: req.query.status as string | undefined })
        .map((t) => {
          ensureTicketSummary(t); // backfill missing one-liners lazily as they're viewed
          return {
            ...t,
            repo_delivery: t.repo_id ? repoDelivery.get(t.repo_id) ?? null : null,
            cost: costs[t.id] ?? null,
            blocked: blocked.has(t.id),
            // Derived, not stored: `external_status` (last pull) vs the live local status. Whoever
            // reads this list must be able to tell "we say it's closed, ClickUp still says In
            // Progress" from agreement — see isStatusDivergent().
            status_divergent: isStatusDivergent(t),
          };
        })
    );
  });

  api.post("/tickets", validate(NewTicketSchema), (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    if (scope.ws !== null) {
      if (req.body?.workspace_id && req.body.workspace_id !== scope.ws)
        return res.status(403).json({ error: "workspace token does not match requested workspace" });
      req.body = { ...req.body, workspace_id: scope.ws };
    }
    // `description` (what `mc ticket new --body` has always sent) and `body` are aliases for
    // `context` — they were silently stripped by the schema until 2026-07-31, so agent-filed
    // tickets arrived empty. Explicit `context` wins when both are present.
    if (!req.body.context && (req.body.description || req.body.body))
      req.body = { ...req.body, context: req.body.description ?? req.body.body };
    try {
      res.status(201).json(createTicket(req.body));
    } catch (e: any) {
      res.status(400).json({ error: String(e.message ?? e) });
    }
  });

  api.get("/tickets/:id", (req, res) => {
    const t = tickets.get(req.params.id);
    if (!t) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, t.workspace_id)) return;
    const repo = t.repo_id ? repos.get(t.repo_id) : undefined;
    ensureTicketSummary(t);
    const links = ticketLinks.forTicket(t.id).map((l) => ({
      id: l.id,
      type: l.type,
      dir: l.dir,
      ticket: { id: l.ticket.id, key: l.ticket.key, title: l.ticket.title, status: l.ticket.status, external_url: l.ticket.external_url },
    }));
    // Goal roll-up: when this ticket is a parent, summarize child completion so `mc goal`/UI can ask "is X done?"
    const kids = ticketLinks.children(t.id);
    let goal: unknown;
    if (kids.length) {
      const blk = ticketLinks.blockedIds();
      // A dismissed child is a decision, not outstanding work: counting it in the denominator would
      // hold a finished goal at 90% forever.
      const live = kids.filter((k) => k.status !== "dismissed");
      goal = {
        total: live.length,
        done: live.filter((k) => k.status === "done").length,
        dismissed: kids.length - live.length,
        in_progress: live.filter((k) => k.status === "in_progress").length,
        blocked: live.filter((k) => blk.has(k.id)).length,
        children: kids.map((k) => ({ key: k.key, title: k.title, status: k.status, blocked: blk.has(k.id) })),
      };
    }
    res.json({ ...t, markdown: getBody(t), repo_delivery: repo?.delivery ?? null, cost: tickets.cost(t.id), links, blocked: ticketLinks.blockersOpen(t.id).length > 0, goal, status_divergent: isStatusDivergent(t) });
  });

  // Ticket relationships (local-only): list is folded into GET /tickets/:id. Create/delete here.
  api.post("/tickets/:id/links", validate(TicketLinkSchema), (req, res) => {
    const t = tickets.get(req.params.id);
    if (!t) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, t.workspace_id)) return;
    try {
      res.status(201).json(ticketLinks.add(req.params.id, req.body.to_id, req.body.type));
    } catch (e: any) {
      res.status(400).json({ error: String(e.message ?? e) });
    }
  });

  api.delete("/tickets/:id/links/:linkId", (req, res) => {
    const link = ticketLinks.get(req.params.linkId);
    if (!link || (link.from_id !== req.params.id && link.to_id !== req.params.id)) {
      return res.status(404).json({ error: "not found" });
    }
    const t = tickets.get(req.params.id);
    if (!t) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, t.workspace_id)) return;
    ticketLinks.remove(req.params.linkId);
    res.json({ ok: true });
  });

  // Desktop shell can't open external links (wry swallows target=_blank) — open them
  // in the user's default browser from the daemon. Admin-gated so sandboxed agents can't
  // pop windows on the operator's desktop.
  api.post("/open", requireAdmin, validate(OpenUrlSchema), (req, res) => {
    execFile("open", [req.body.url], () => {});
    res.json({ ok: true });
  });

  // Merge the ticket's open PR from the UI (gh pr merge in the repo) → ticket done.
  api.post("/tickets/:id/merge-pr", async (req, res) => {
    const t = tickets.get(req.params.id);
    if (t && !checkScope(req, res, t.workspace_id)) return;
    try {
      res.json(await mergePrForTicket(req.params.id));
    } catch (e: any) {
      res.status(400).json({ error: String(e.message ?? e) });
    }
  });

  api.patch("/tickets/:id", validate(PatchTicketSchema), async (req, res) => {
    const cur = tickets.get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, cur.workspace_id)) return;
    try {
      const t = updateTicket(req.params.id, req.body);
      if (!t) return res.status(404).json({ error: "not found" });
      // `mc review KEY` / UI status change → make the Approve panel + notification real.
      if (req.body?.status === "review") {
        try { await ensureReviewForTicket(t.id); } catch (e) { console.error("[reviews] ensure failed", e); }
      }
      res.json(t);
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  api.delete("/tickets/:id", async (req, res) => {
    const cur = tickets.get(req.params.id);
    if (cur && !checkScope(req, res, cur.workspace_id)) return;
    try {
      // Connector-linked: try to close it upstream before the local row (and its external_id) is
      // gone. Best-effort — removeTicket tombstones the external id regardless, so a failed/unmapped
      // push still can't let the next sync respawn it (PER-70).
      let external: string | null = null;
      if (cur?.external_system && cur?.external_id) {
        const target = await pushClose(cur);
        external = target
          ? `closed upstream in ${cur.external_system} (→ ${target})`
          : `could not close upstream in ${cur.external_system} — local delete is tombstoned so it won't respawn on next sync`;
      }
      removeTicket(req.params.id);
      res.json({ ok: true, ...(external ? { external } : {}) });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // Conflict: pending review still owns the ship path — deleting would strand the merge (PER-34).
      if (/pending review/.test(msg)) return res.status(409).json({ error: msg });
      res.status(400).json({ error: msg });
    }
  });

  // ── The board — one public feed, threads, @mention wakes (src/board.ts). ──────────────────────
  // Deliberately unscoped: full cross-workspace visibility IS the design (no channels, no DMs),
  // so board reads/writes are open like ticket notes. Author is provenance, not authentication —
  // same trust model as TicketNoteSchema's `by` on this localhost-only daemon.
  api.get("/board", (req, res) => {
    // ?ticket=<id> → the posts cross-linked to that ticket (the ticket page's board section).
    if (typeof req.query.ticket === "string") {
      return res.json(board.forTicket(req.query.ticket).map((p) => ({ ...p, mentions: JSON.parse(p.mentions || "[]") })));
    }
    const limit = Number(req.query.limit ?? 50);
    const feed = board.feed(Number.isFinite(limit) ? limit : 50);
    res.json(feed.map((p) => ({ ...p, mentions: JSON.parse(p.mentions || "[]") })));
  });

  api.get("/board/:id", (req, res) => {
    const thread = board.thread(req.params.id);
    if (!thread.length) return res.status(404).json({ error: "not found" });
    res.json(thread.map((p) => ({ ...p, mentions: JSON.parse(p.mentions || "[]") })));
  });

  api.post("/board", validate(NewBoardPostSchema), (req, res) => {
    if (req.body.ticket_id && !tickets.get(req.body.ticket_id))
      return res.status(400).json({ error: "ticket_id not found" });
    try {
      const post = postToBoard({
        author: req.body.author || "operator",
        body: req.body.body,
        thread_root_id: req.body.thread_root_id ?? null,
        kind: req.body.kind,
        ticket_id: req.body.ticket_id ?? null,
        workspace_id: req.body.workspace_id ?? null,
      });
      res.status(201).json({ ...post, mentions: JSON.parse(post.mentions || "[]") });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  api.post("/tickets/:id/note", validate(TicketNoteSchema), (req, res) => {
    const cur = tickets.get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, cur.workspace_id)) return;
    const t = appendNote(req.params.id, req.body.text, req.body.by);
    if (!t) return res.status(404).json({ error: "not found" });
    // `mc note` sends MC_RUN as run_id when set — a note is a checkpoint like `mc step`, so it
    // piggybacks the same mailbox pickup when the caller identifies its run. The run must live in
    // the SAME workspace as the ticket just scope-checked above: deliverPending is a consuming read,
    // and without this gate a scoped caller noting on its own ticket could pass another workspace's
    // run_id and silently drain that run's mailbox.
    const noteRun = req.body.run_id ? runs.get(req.body.run_id) : undefined;
    const noteRunWs = noteRun ? jobs.get(noteRun.job_id)?.workspace_id ?? null : null;
    const runMessages = noteRun && noteRunWs === cur.workspace_id ? deliverPending(noteRun.id) : [];
    res.json({ ...t, messages: runMessages });
  });

  // Explicit, operator-initiated write-back to Jira/ClickUp (never automatic). Post a comment…
  api.post("/tickets/:id/push-comment", validate(PushCommentSchema), async (req, res) => {
    const t = tickets.get(req.params.id);
    if (!t) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, t.workspace_id)) return;
    try {
      await pushComment(t, req.body.body);
      res.json({ ok: true, external_system: t.external_system, external_id: t.external_id });
    } catch (e: any) {
      res.status(400).json({ error: String(e.message ?? e) });
    }
  });

  // …or push the ticket's current local status out. Optional { hours } overrides/backfills a
  // tracker-required hours-spent field on close (Jira Done); falls back to the ticket's most
  // recent "Logged Nh." note when omitted.
  api.post("/tickets/:id/push-status", validate(PushStatusSchema), async (req, res) => {
    const t = tickets.get(req.params.id);
    if (!t) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, t.workspace_id)) return;
    try {
      const status = await pushStatus(t, req.body.hours);
      res.json({ ok: true, external_system: t.external_system, external_id: t.external_id, status });
    } catch (e: any) {
      res.status(400).json({ error: String(e.message ?? e) });
    }
  });

  // …or write just the hours-spent field (Jira "Hours Spent"), leaving the status alone. Also
  // appends "Logged Nh." to the local work log, so a later Done push reuses the same number.
  api.post("/tickets/:id/push-hours", validate(PushHoursSchema), async (req, res) => {
    const t = tickets.get(req.params.id);
    if (!t) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, t.workspace_id)) return;
    try {
      const r = await pushHours(t, req.body.hours);
      res.json({ ok: true, external_system: t.external_system, ...r });
    } catch (e: any) {
      res.status(400).json({ error: String(e.message ?? e) });
    }
  });

  api.post("/tickets/:id/dispatch", validate(DispatchTicketSchema), async (req, res) => {
    const cur = tickets.get(req.params.id);
    if (cur && !checkScope(req, res, cur.workspace_id)) return;
    try {
      res.json(await dispatchTicket(req.params.id, { backend: req.body.backend, model: req.body.model }));
    } catch (e: any) {
      res.status(400).json({ error: String(e.message ?? e) });
    }
  });

  // Read-only planning agent: investigate + draft a plan, then mark the ticket 'planned'.
  api.post("/tickets/:id/dispatch-plan", (req, res) => {
    const cur = tickets.get(req.params.id);
    if (cur && !checkScope(req, res, cur.workspace_id)) return;
    try {
      res.json(dispatchPlan(req.params.id));
    } catch (e: any) {
      res.status(400).json({ error: String(e.message ?? e) });
    }
  });

  // Agent writes its plan here (via `mc plan`): saves the ## Plan section + flips status → planned.
  api.post("/tickets/:id/plan", validate(SetPlanSchema), (req, res) => {
    const cur = tickets.get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, cur.workspace_id)) return;
    const t = setPlan(req.params.id, req.body.markdown, { status: req.body.status, complexity: req.body.complexity ?? req.body.difficulty });
    if (!t) return res.status(404).json({ error: "not found" });
    res.json(t);
  });

  // Read-only second-pass grader (default k3): review the brief + grade difficulty 1-5.
  api.post("/tickets/:id/dispatch-grade", (req, res) => {
    const cur = tickets.get(req.params.id);
    if (cur && !checkScope(req, res, cur.workspace_id)) return;
    try {
      res.json(dispatchGrade(req.params.id));
    } catch (e: any) {
      res.status(400).json({ error: String(e.message ?? e) });
    }
  });

  // Grader writes its grade here (via `mc grade`): sets difficulty 1-5 + logs a review note. No status change.
  api.post("/tickets/:id/grade", validate(GradeSchema), (req, res) => {
    const cur = tickets.get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, cur.workspace_id)) return;
    try {
      const t = gradeTicket(req.params.id, req.body.difficulty, req.body.note);
      if (!t) return res.status(404).json({ error: "not found" });
      res.json(t);
    } catch (e: any) {
      res.status(400).json({ error: String(e.message ?? e) });
    }
  });

  // ───────────────────────────── Ticket attachments (screenshots / evidence) ─────────────────
  api.get("/tickets/:id/attachments", (req, res) => {
    const t = tickets.get(req.params.id);
    if (!t) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, t.workspace_id)) return;
    res.json(listAttachments(req.params.id));
  });

  // JSON body: { data_base64, filename, mime?, caption?, source? } — web drop/paste.
  api.post("/tickets/:id/attachments", validate(NewAttachmentSchema), (req, res) => {
    const t = tickets.get(req.params.id);
    if (!t) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, t.workspace_id)) return;
    try {
      const b64 = req.body.data_base64.replace(/^data:[^;]+;base64,/, "");
      if (!b64) return res.status(400).json({ error: "data_base64 required" });
      const buf = Buffer.from(b64, "base64");
      const att = saveAttachment({
        ticketId: req.params.id,
        buffer: buf,
        filename: req.body.filename || "screenshot.png",
        mime: req.body.mime,
        caption: req.body.caption ?? null,
        source: req.body.source || "upload",
      });
      res.status(201).json(att);
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  // Raw binary upload (Content-Type + X-Filename / ?filename=).
  api.post(
    "/tickets/:id/attachments/raw",
    express.raw({ type: () => true, limit: "15mb" }),
    (req, res) => {
      const t = tickets.get(req.params.id);
      if (!t) return res.status(404).json({ error: "not found" });
      if (!checkScope(req, res, t.workspace_id)) return;
      try {
        const buf = req.body as Buffer;
        const filename =
          String(req.get("x-filename") || req.query.filename || "screenshot.bin");
        const mime = String(req.get("content-type") || "application/octet-stream");
        const caption = req.get("x-caption") || (req.query.caption as string) || null;
        const att = saveAttachment({
          ticketId: req.params.id,
          buffer: buf,
          filename,
          mime,
          caption,
          source: "upload",
        });
        res.status(201).json(att);
      } catch (e: any) {
        res.status(400).json({ error: String(e?.message ?? e) });
      }
    },
  );

  // A Desk chat attachment's bytes, by id — what the thumbnails in the chat log are. Declared above
  // the ticket routes because "chat" would otherwise read as a ticket-attachment id (`/attachments/
  // :id` is a 2-segment route and this one has 3, so Express does not actually confuse them today —
  // but a later `/attachments/:id/thumb` would). requireAdmin, like the chat routes it belongs to:
  // a screenshot of the operator's screen is not something a workspace agent may pull back out.
  api.get("/attachments/chat/:id", requireAdmin, (req, res) => {
    const a = getChatAttachment(req.params.id);
    if (!a || !fs.existsSync(a.path)) return res.status(404).json({ error: "not found" });
    res.setHeader("Content-Type", a.mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${a.name.replace(/"/g, "")}"`);
    res.setHeader("Cache-Control", "private, max-age=3600");
    fs.createReadStream(a.path).pipe(res);
  });

  api.get("/attachments/:id", (req, res) => {
    const a = getAttachment(req.params.id);
    if (!a) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, a.workspace_id)) return;
    res.json(a);
  });

  api.get("/attachments/:id/file", (req, res) => {
    const a = getAttachment(req.params.id);
    if (!a?.path || !fs.existsSync(a.path))
      return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, a.workspace_id)) return;
    res.setHeader("Content-Type", a.mime || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${a.filename.replace(/"/g, "")}"`,
    );
    res.setHeader("Cache-Control", "private, max-age=3600");
    fs.createReadStream(a.path).pipe(res);
  });

  api.delete("/attachments/:id", (req, res) => {
    const a = getAttachment(req.params.id);
    if (!a) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, a.workspace_id)) return;
    if (!removeAttachment(req.params.id))
      return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  });

  // ───────────────────────────── Mission Control: watches ─────────────────────────────
  // "Wake <executive> when <condition>" — see src/watches.ts. Admin-gated on the write side for the
  // same reason triggers are: a watch is a persistent, unattended, credentialed call, and a
  // sandboxed workspace agent must not be able to mint one. The executives (who hold the token)
  // create these for themselves; Robert on Telegram PROPOSEs it and it lands on the safe tier.
  api.get("/watches", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const list = watches.list({
      ...(req.query.owner ? { owner: String(req.query.owner) } : {}),
      ...(req.query.all === "1" ? {} : { enabled: true }),
    });
    res.json(scope.ws === null ? list : list.filter((w) => w.workspace_id === null || w.workspace_id === scope.ws));
  });

  api.post("/watches", requireAdmin, validate(NewWatchSchema), (req, res) => {
    if (req.body.workspace_id && !checkScope(req, res, req.body.workspace_id)) return;
    const prepared = prepareWatch({ ...req.body, created_by: req.body.owner });
    if ("error" in prepared) return res.status(400).json({ error: prepared.error });
    const created = watches.create(prepared.row);
    invalidateWatchCache();
    res.status(201).json(created);
  });

  api.patch("/watches/:id", requireAdmin, validate(PatchWatchSchema), (req, res) => {
    const cur = watches.get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, cur.workspace_id)) return;
    const next = watches.patch(cur.id, {
      enabled: req.body.enabled ? 1 : 0,
      disabled_reason: req.body.enabled ? null : "closed by hand",
    });
    invalidateWatchCache();
    res.json(next);
  });

  api.delete("/watches/:id", requireAdmin, (req, res) => {
    const cur = watches.get(req.params.id);
    if (cur && !checkScope(req, res, cur.workspace_id)) return;
    watches.remove(req.params.id);
    invalidateWatchCache();
    res.json({ ok: true });
  });

  // ──────────────────────────── Mission Control: recovery ────────────────────────────
  // Work that stopped without finishing. Listing is open (it's the same read every surface makes);
  // deciding is admin-gated, because approving spends money by re-dispatching an agent.
  api.get("/recovery", (req, res) => res.json(filterByBucket(listStalls(), parseBucketFilter(req.query.bucket))));

  api.post("/recovery/:id/hold", validate(HoldSchema), (req, res) => holdRoute(req, res, "recovery"));

  api.post("/recovery/decide", requireAdmin, async (req, res) => {
    const id = String(req.body?.id ?? "");
    if (!id) return res.status(400).json({ error: "id required (e.g. r:1a2b3c4d or t:CED-23)" });
    if (typeof req.body?.approve !== "boolean")
      return res.status(400).json({ error: "approve must be true (resume it) or false (drop it)" });
    res.json({ ok: true, message: await decideStall(id, req.body.approve) });
  });

  // ───────────────────────────── Mission Control: reviews ─────────────────────────────
  // Reviews aren't workspace-tagged directly — resolve ownership through their ticket.
  const reviewWorkspace = (r: { ticket_id: string | null }): string | null | undefined =>
    r.ticket_id ? tickets.get(r.ticket_id)?.workspace_id : undefined;

  api.get("/reviews", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const list = reviews.list(req.query.state as string | undefined);
    const mine = scope.ws === null ? list : list.filter((r) => reviewWorkspace(r) === scope.ws);
    res.json(filterByBucket(mine, parseBucketFilter(req.query.bucket)));
  });

  api.post("/reviews/:id/hold", validate(HoldSchema), (req, res) => holdRoute(req, res, "review"));

  api.get("/reviews/:id", (req, res) => {
    const r = reviews.get(req.params.id);
    if (!r) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, reviewWorkspace(r))) return;
    res.json(r);
  });

  const reviewAction =
    (fn: (id: string, notes?: string | null) => any) =>
    async (req: express.Request, res: express.Response) => {
      const cur = reviews.get(req.params.id);
      if (cur && !checkScope(req, res, reviewWorkspace(cur))) return;
      try {
        const r = await fn(req.params.id, req.body?.notes);
        if (!r) return res.status(404).json({ error: "not found" });
        res.json(r);
      } catch (e: any) {
        // merge throws on PR-ship failure (push/gh) with the review left pending — retryable.
        res.status(502).json({ error: String(e?.message ?? e) });
      }
    };
  api.post("/reviews/:id/approve", validate(ReviewNotesSchema), reviewAction(approve));
  api.post("/reviews/:id/changes", validate(ReviewNotesSchema), reviewAction(requestChanges));
  api.post("/reviews/:id/merge", validate(ReviewNotesSchema), reviewAction(merge));
  // Third exit: close the review row without shipping (approve) or reopening the ticket (changes).
  api.post("/reviews/:id/dismiss", validate(ReviewNotesSchema), reviewAction(dismiss));

  // Dispatch the AI reviewer for a pending review (manual trigger; auto when workspace auto_review).
  api.post("/reviews/:id/dispatch-review", (req, res) => {
    const cur = reviews.get(req.params.id);
    if (cur && !checkScope(req, res, reviewWorkspace(cur))) return;
    try {
      res.json(dispatchReview(req.params.id));
    } catch (e: any) {
      res.status(400).json({ error: String(e.message ?? e) });
    }
  });
  // The reviewer agent posts its verdict here (via `mc verdict`).
  api.post("/reviews/:id/verdict", validate(ReviewVerdictSchema), async (req, res) => {
    const cur = reviews.get(req.params.id);
    if (!cur) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, reviewWorkspace(cur))) return;
    try {
      const r = await applyVerdict(req.params.id, req.body.decision, req.body.notes, req.body.lens ?? null);
      if (!r) return res.status(404).json({ error: "not found" });
      res.json(r);
    } catch (e: any) {
      res.status(502).json({ error: String(e?.message ?? e) });
    }
  });

  // ───────────────────────────── Mission Control: calendar ─────────────────────────────
  api.get("/calendars", (_req, res) => res.json(calendars.list()));

  api.post("/calendars", requireAdmin, validate(NewCalendarSchema), async (req, res) => {
    try {
      const c = calendars.create(req.body);
      let sync: any = { ok: true };
      try { sync = await refreshCal(c); } catch (e: any) { sync = { error: String(e.message ?? e) }; }
      res.status(201).json({ ...c, sync });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  api.patch("/calendars/:id", requireAdmin, validate(PatchCalendarSchema), (req, res) => {
    const c = calendars.update(req.params.id, req.body);
    if (!c) return res.status(404).json({ error: "not found" });
    res.json(c);
  });

  api.delete("/calendars/:id", requireAdmin, (req, res) => {
    calendars.remove(req.params.id);
    res.json({ ok: true });
  });

  api.post("/calendars/refresh", requireAdmin, async (_req, res) => {
    try {
      await refreshCals();
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  // Ingest local calendars+events pushed by a user-session helper (daemon lacks Calendar TCC).
  api.post("/calendars/ingest", requireAdmin, validate(CalendarIngestSchema), (req, res) => {
    res.json({ ingested: ingestLocal(req.body) });
  });

  // Import every local macOS calendar (EventKit) as a color-coded source.
  api.post("/calendars/import-local", requireAdmin, validate(ImportLocalCalendarsSchema), async (req, res) => {
    try {
      res.json({ imported: await importLocalCalendars(req.body.workspace_id ?? null) });
    } catch (e: any) {
      res.status(400).json({ error: String(e.message ?? e) });
    }
  });

  // Merged agenda. Defaults to a 30-day window from today.
  api.get("/calendar", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const from = (req.query.from as string) || new Date().toISOString().slice(0, 10) + "T00:00:00";
    const to = (req.query.to as string) || new Date(Date.now() + 30 * 86400000).toISOString();
    res.json(calEvents.agenda(from, to, scope.ws ?? (req.query.workspace as string | undefined)));
  });

  // ───────────────────────────── Mission Control: search ─────────────────────────────
  api.get("/search", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const q = (req.query.q as string) ?? "";
    res.json(
      searchIndex.search(q, {
        workspace: scope.ws ?? (req.query.workspace as string | undefined),
        kind: req.query.kind as string | undefined,
        since: req.query.since as string | undefined,
      })
    );
  });

  // Voice: browser mic → transcript. Raw audio body (webm/ogg, mp4 on iOS) → local whisper → { text }.
  api.post("/transcribe", requireAdmin, express.raw({ type: () => true, limit: "25mb" }), async (req, res) => {
    try {
      const buf = req.body as Buffer;
      if (!buf?.length) return res.status(400).json({ error: "empty audio body" });
      const ct = req.get("content-type") || "audio/webm";
      const lang = String(req.query.lang || "").toLowerCase();
      const language = lang === "en" || lang === "es" ? lang : undefined;
      const t0 = Date.now();
      const text = await transcribe(buf, { filename: audioFilename(ct), contentType: ct, language });
      res.json({ text, ms: Date.now() - t0, bytes: buf.length });
    } catch (e: any) {
      const f = transcribeFailure(e, { mime: req.get("content-type") || "-", bytes: (req.body as Buffer)?.length ?? 0 });
      console.error(f.log);
      res.status(500).json({ error: f.error });
    }
  });

  // Voice call, the other half: Robert's sentences → the Mac's Premium voice → AAC the page plays.
  api.post("/speak", requireAdmin, validate(SpeakSchema), async (req, res) => {
    try {
      const audio = await speak(req.body.text, req.body.lang ?? "en");
      res.set({ "content-type": "audio/mp4", "cache-control": "no-store" }).send(audio);
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });
  api.get("/voices", requireAdmin, async (_req, res) => {
    res.json({ en: await voiceFor("en"), es: await voiceFor("es"), installed: (await listVoices()).filter((v) => v.premium) });
  });

  // Hub open → pre-boot the persistent voice manager so the first utterance skips CLI startup.
  api.post("/agent/warm", requireAdmin, validate(AgentWarmSchema), (req, res) => {
    warmWebManager(req.body.ws ?? null);
    res.json({ ok: true });
  });

  // Model behind the web chat manager. POST recycles the warm process; the thread resumes on the new model.
  api.get("/agent/model", requireAdmin, (req, res) => {
    const ws = typeof req.query.ws === "string" ? req.query.ws : null;
    res.json({ model: getWebModel(), models: AGENT_MODELS, profile: webProfileDir(ws) });
  });
  api.post("/agent/model", requireAdmin, validate(AgentModelSchema), (req, res) => {
    setWebModel(req.body.model);
    res.json({ model: getWebModel() });
  });

  // Persisted Flow/web chat thread (WhatsApp-style, survives reloads). Oldest→newest.
  api.get("/agent/history", requireAdmin, (req, res) => {
    const ws = typeof req.query.ws === "string" ? req.query.ws : null;
    // "agent:<id>" = a per-executive thread (agent_chat), everything else a manager thread.
    if (ws?.startsWith("agent:"))
      return res.json({ messages: agentChat.recent(ws.slice("agent:".length), Number(req.query.limit) || 200) });
    // ws=all is the ONE visible thread: every workspace's rows plus the unscoped ones, in one
    // timeline, each carrying its workspace_id so the page can chip and filter it.
    if (ws === "all") return res.json({ messages: chat.recentAll(Number(req.query.limit) || 200) });
    res.json({ messages: chat.recent(Number(req.query.limit) || 200, ws) });
  });

  // Where would this message go, and why — the router's decision with everything it weighed.
  api.get("/thread/route", requireAdmin, (req, res) => {
    const text = typeof req.query.text === "string" ? req.query.text : "";
    const surface = typeof req.query.surface === "string" ? req.query.surface : "web";
    const session = typeof req.query.session === "string" ? req.query.session : null;
    res.json(explainRoute(text, { surface, stagedSessionId: session }));
  });

  // Pin the visible thread to one workspace (or {"ws":null} to hand it back to the router).
  api.post("/thread/sticky", requireAdmin, validate(ThreadStickySchema), (req, res) => {
    const surface = req.body.surface || "web";
    const ws = req.body.ws ?? null;
    if (ws && !workspaces.get(ws)) return res.status(404).json({ error: "workspace not found" });
    setSticky(surface, ws);
    const cur = getSticky(surface);
    res.json({ ok: true, surface, ws: cur?.ws ?? null, slug: cur?.ws ? workspaces.get(cur.ws)?.slug ?? null : null });
  });

  // "New conversation": mark the thread and drop the agent's session. History stays; context doesn't.
  api.post("/agent/reset", requireAdmin, validate(AgentWarmSchema), (req, res) => {
    const ws = req.body.ws ?? null;
    // "agent:<id>" is an executive's own thread, which lives in agent_chat and carries no manager
    // process — writing its divider into chat_messages would hit the workspaces FK (migration 93).
    if (ws?.startsWith("agent:")) {
      const execId = ws.slice("agent:".length);
      resetExecConversation(execId);
      const execRow = agentChat.divide(execId);
      bus.publish({ topic: "agent.push", you: "", reply: "", at: execRow.created_at, source: "divider", ws });
      return res.json({ ok: true, at: execRow.created_at });
    }
    resetWebConversation(ws);
    const row = chat.divide(ws);
    bus.publish({ topic: "agent.push", you: "", reply: "", at: row.created_at, source: "divider", ws });
    res.json({ ok: true, at: row.created_at });
  });

  // On-demand proactive briefing / fleet heartbeat tick.
  // - default / kind=now → Robert force brief (legacy)
  // - agent=fleet → every live executive (haiku gate → warm execute) — just Robert while Robert is the only executive
  // - agent=robert → that one executive
  api.post("/agent/heartbeat", requireAdmin, validate(HeartbeatSchema), (req, res) => {
    const kind = req.body.kind ?? "now";
    const agent = req.body.agent as FleetAgent | "fleet" | undefined;
    res.json({ ok: true, kind, agent: agent ?? "robert" });
    if (agent === "fleet") {
      void runFleetHeartbeat({ force: true });
    } else if (agent && agent !== "robert") {
      void runAgentHeartbeat({ agent, kind, force: true, skipDigest: true });
    } else {
      void runHeartbeat(kind, true); // fire-and-forget → Flow + Telegram + Mac + board
    }
  });

  // Chat attachments: raw file bytes → a disk path the chat agent Reads (vision for images,
  // PDF/text directly). Admin-gated like the chat routes themselves; the UI embeds the returned
  // path into the outgoing message text, so nothing else has to know attachments exist.
  api.post(
    "/agent/upload",
    requireAdmin,
    express.raw({ type: () => true, limit: "15mb" }),
    async (req, res) => {
      try {
        const f = await saveChatFile({
          thread: String(req.query.thread || "chat"),
          buffer: req.body as Buffer,
          filename: String(req.get("x-filename") || req.query.filename || "file"),
          mime: String(req.get("content-type") || ""),
        });
        res.status(201).json(f);
      } catch (e: any) {
        res.status(400).json({ error: String(e?.message ?? e) });
      }
    },
  );

  // Desk chat attachments: a screenshot pasted with ⌘V, or files dragged off Finder onto Robert's
  // chat. Uploaded the moment they are dropped (not on send) so the strip above the composer can
  // show a thumbnail and an ✕ before the operator has typed anything; the id then rides the next
  // turn. Separate from /agent/upload above, which is the /app composer's fire-and-forget path — its
  // files have no id and cannot be looked up again, which is exactly what a redrawn chat log needs.
  api.post(
    "/agent/attach",
    requireAdmin,
    express.raw({ type: () => true, limit: "15mb" }),
    async (req, res) => {
      try {
        // The app-level express.json() runs first and eats any body it recognises, so express.raw
        // never fills req.body for it (body-parser skips a request already marked as read). The Desk
        // sends such a file as text/plain for exactly this reason; anything else that gets here
        // parsed is not a file we can store, and says so rather than 400ing as "empty".
        if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: "send the raw bytes (content-type must not be application/json)" });
        const a = await saveChatAttachment({
          buffer: req.body,
          filename: String(req.get("x-filename") || req.query.filename || "file"),
          mime: String(req.get("content-type") || ""),
        });
        res.status(201).json(a);
      } catch (e: any) {
        res.status(400).json({ error: String(e?.message ?? e) });
      }
    },
  );

  // PDF → text layer, for agents whose backend can't vision-read PDFs (cursor/grok workers) and
  // as the cheap path for those that can (`mc pdf <file>`; ~5-10x fewer tokens than vision pages).
  // Reads an arbitrary disk path, so scope is NARROWER than callerScope's legacy default:
  // admin token → any path; workspace token → that workspace's repos + ticket files + attachments;
  // no token at all → attachments only (every spawned agent has MC_WORKSPACE_TOKEN, so a tokenless
  // loopback caller gets no reach into repos it couldn't already Read under its sandbox).
  api.post("/pdf/text", async (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const raw = String(req.body?.path || "");
    if (!raw) return res.status(400).json({ error: "path required" });
    let p: string;
    try { p = fs.realpathSync(path.resolve(raw)); } catch { return res.status(404).json({ error: "not found" }); }
    const isAdmin = scope.ws !== null ? false : tokenOk(req.get("x-mc-admin"), CONFIG.adminToken);
    if (!isAdmin) {
      const roots = [ATTACH_ROOT];
      if (scope.ws) {
        const w = workspaces.get(scope.ws);
        if (w) roots.push(wsTicketsDir(w.slug));
        for (const r of repos.list()) if (r.workspace_id === scope.ws && (r as any).path) roots.push((r as any).path);
      }
      const inRoots = roots.some((root) => {
        try { return (p + path.sep).startsWith(fs.realpathSync(root) + path.sep); } catch { return false; }
      });
      if (!inRoots) return res.status(404).json({ error: "not found" });
    }
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > 50 * 1024 * 1024) return res.status(400).json({ error: "not a readable pdf (max 50MB)" });
      const buf = fs.readFileSync(p);
      if (!buf.subarray(0, 5).equals(Buffer.from("%PDF-"))) return res.status(400).json({ error: "not a pdf" });
      const text = await pdfText(buf);
      res.json({ text, chars: text.length, empty: !text });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  // Voice/text → manager agent (same persona as Telegram). Returns the reply + any proposed mutation;
  // the dashboard confirms and executes a proposal itself via its admin-authed api() calls.
  api.post("/agent", requireAdmin, validate(AgentTextSchema), async (req, res) => {
    const surface = req.body.surface || "web";
    // An explicit workspace selection wins; otherwise the thread router reads the workspace out of the
    // message (a #tag, a ticket key, a project name, the terminal on screen, or where the last one
    // landed). Each workspace answers on its OWN warm Robert, so no context can cross between them.
    const turn = await resolveTurnSmart(req.body.text, {
      selected: req.body.ws ?? null,
      route: req.body.route,
      surface,
      stagedSessionId: req.body.session ?? null,
    });
    // Two projects match, or a work request with nothing to go on: offer the choice rather than guess.
    // Nothing has run yet, so the tap just re-sends the same text with a ws.
    if (turn.ask) {
      return res.json({ reply: askLine(turn.ask), ask: { why: turn.ask.why, candidates: turn.ask.candidates }, actions: [], ws: null, how: "ask" });
    }
    commitTurn(surface, turn);
    const ws = turn.ws;
    const text = turn.text; // the #tag never reaches the model
    const client = req.body.client;
    const turnId = randomUUID();
    // Files the operator pasted or dropped, resolved from OUR rows (the client sends ids only). One
    // that is gone is dropped rather than failing the turn — the words still make sense without it.
    const files = ((req.body.attachments ?? []) as Array<{ id: string }>)
      .map((a) => getChatAttachment(a.id))
      .filter((a): a is ChatAttachment => !!a);
    // Two different texts on purpose: `prompt` carries the absolute paths the model Reads, `text` is
    // what the operator typed and is what gets stored and drawn. The thumbnails come from `shown`.
    const prompt = text + chatAttachmentsBlock(files);
    const shown = files.map((a) => ({ id: a.id, url: a.url, mime: a.mime, name: a.name }));
    bus.publish({ topic: "agent.asked", you: text, at: new Date().toISOString(), source: surface, ws, client, turn: turnId, ...(shown.length ? { attachments: shown } : {}) });
    try {
      // Stream TEXT deltas to the dashboard so it can speak sentence-by-sentence while the turn runs.
      // Single operator → broadcast on the bus (no per-client routing). POST result stays authoritative.
      // client + turn on every delta: the page that asked (a Desk on a voice call) speaks its own turn's
      // sentences as they stream, and nobody else's.
      const { reply, actions, steps } = await askManagerWeb(prompt, (t, kind) => bus.publish({ topic: "agent.delta", text: t, kind, ws, client, turn: turnId }), ws, { voice: !!req.body.voice, turn: turnId });
      const row = chat.add(text, reply || "", "web", ws, steps, shown);
      chat.prune(2000);
      bus.publish({
        topic: "agent.push",
        you: text,
        reply: reply || "",
        at: row.created_at,
        source: "web",
        ws,
        client,
        turn: turnId,
        steps,
        ...(shown.length ? { attachments: shown } : {}),
      });
      bus.publish({ topic: "agent.turn.done", ws });
      res.json({ reply, actions, ws, how: turn.how, turn: turnId });
    } catch (e: any) {
      const err = "⚠️ " + String(e?.message ?? e);
      const row = chat.add(text, err, "web", ws, null, shown);
      bus.publish({
        topic: "agent.push",
        you: text,
        reply: err,
        at: row.created_at,
        source: "web",
        ws,
        client,
        turn: turnId,
        ...(shown.length ? { attachments: shown } : {}),
      });
      bus.publish({ topic: "agent.turn.done", ws });
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  // Per-executive chat panes: same contract as POST /agent, but the turn runs the named executive's
  // own warm singleton (their persona, tools, sandbox — agents/<id>/), which persists model context
  // via its --resume session in kv. Robert deliberately stays on POST /agent — his processes are
  // per-workspace — so while he is the only executive this map is empty and every id 404s. The
  // route is not dead code: it is the seam a second executive plugs into, and
  // GET /agent/history?ws=agent:<id> already reads the panes' stored history.
  const EXEC_ASK: Record<string, (text: string, opts?: ExecTurnOpts) => Promise<{ reply: string }>> = {};
  api.post("/agent/exec/:id", requireAdmin, validate(AgentTextSchema), async (req, res) => {
    const execId = req.params.id;
    const ask = EXEC_ASK[execId];
    if (!ask) return res.status(404).json({ error: "unknown executive (robert lives on POST /agent)" });
    const text = req.body.text;
    const thread = `agent:${execId}`;
    try {
      // Deltas (including this turn's "queued behind …" notice) are published inside askExec — every
      // surface that can occupy this executive goes through that seam, not just this route.
      const { reply } = await ask(text, { origin: "the operator's chat", stream: true });
      const row = agentChat.add(execId, text, reply || "");
      agentChat.prune(2000);
      bus.publish({ topic: "agent.push", you: text, reply: reply || "", at: row.created_at, source: "web", ws: thread });
      bus.publish({ topic: "agent.turn.done", ws: thread });
      res.json({ reply });
    } catch (e: any) {
      // Best-effort store on the error path: a second failure here must not swallow the response
      // (that is exactly how v1 of this route left the UI on "thinking…" forever).
      const err = "⚠️ " + String(e?.message ?? e);
      try {
        const row = agentChat.add(execId, text, err);
        bus.publish({ topic: "agent.push", you: text, reply: err, at: row.created_at, source: "web", ws: thread });
      } catch {}
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  app.use("/api", api);
  // The React dashboard (ui/) is gone — deleted along with its Vite build. The only surviving web
  // surface is the native overlay (static/overlay.html, a hand-written page with vendored
  // marked.min.js/purify.min.js under static/vendor/ — no build step). The admin token is NEVER
  // templated into static HTML, not even for loopback callers: sandboxed job agents keep loopback
  // network (the sandbox profile allows localhost so `mc`/the egress proxy keep working), so a
  // token baked into the response is one `curl localhost:7777/overlay.html` away from the very
  // agents the token file's sandbox-deny exists to keep it from. The native overlay reads
  // ~/chronos/.admin-token itself (it runs unsandboxed as the operator) and injects it with a
  // WKUserScript — see desktop/overlay.swift. A page opened in a plain browser therefore has no
  // token and cannot drive the admin-only routes; use the overlay for those.
  const staticDir = path.join(__dirname, "..", "static");
  const overlayPath = path.join(staticDir, "overlay.html");
  const noStore = {
    etag: false as const,
    lastModified: false as const,
    setHeaders: (res: express.Response) => res.setHeader("Cache-Control", "no-store, must-revalidate"),
  };
  const sendOverlay = serveHtml(overlayPath, "Overlay UI missing from static/overlay.html.");
  // Mission UI (static/app.html): Chat / Tickets / Board / Fleet — the full-window surface the
  // compact overlay satellites. Same token rules as the overlay: never injected into HTML; the
  // native wrapper supplies window.__MC_TOKEN__, a plain browser gets the token-free read-write
  // subset (tickets/board/fleet — chat and admin mutations 403).
  const sendApp = serveHtml(path.join(staticDir, "app.html"), "Mission UI missing from static/app.html.");
  app.get(["/app", "/app.html"], sendApp);
  // Desk (static/desk.html): the terminal wall — every live agent terminal as a card, grouped by
  // client, with its goal and turn state. Needs the admin token for /term, so it runs either in the
  // native window (`mc-app /desk`) or in a browser tab that stored the token once.
  const sendDesk = serveHtml(path.join(staticDir, "desk.html"), "Desk UI missing from static/desk.html.");
  app.get(["/desk", "/desk.html"], sendDesk);
  // Phone (static/phone.html): the same daemon from a phone — dashboard first, one terminal at a
  // time, a chat-style composer. Reached through the Cloudflare Access tunnel; same token as the Desk.
  const sendPhone = serveHtml(path.join(staticDir, "phone.html"), "Phone UI missing from static/phone.html.");
  app.get(["/phone", "/phone.html"], sendPhone);
  // Altitude (static/altitude.html): the same fleet from above — spend, usage and terminals over a
  // window, filtered by client. Reads /api/analytics only; same token rules as the Desk.
  const sendAltitude = serveHtml(path.join(staticDir, "altitude.html"), "Altitude UI missing from static/altitude.html.");
  app.get(["/altitude", "/altitude.html"], sendAltitude);
  // Widget modules (static/desk-widgets/*.js), fetched by the Desk's loader with a dynamic import.
  // Reachable by bare file name only: the name is the registry key, so the pattern below is the same
  // `[a-z0-9-]` alphabet and no path can be built out of it. no-store because a widget edited during
  // a session must land on the next reload, not whenever a cache decides.
  app.get("/desk-widgets/:file", (req, res) => {
    const file = String(req.params.file || "");
    if (!/^[a-z0-9-]+\.js$/.test(file)) return res.status(404).end();
    const f = path.join(staticDir, "desk-widgets", file);
    if (!fs.existsSync(f)) return res.status(404).end();
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.type("application/javascript").sendFile(f);
  });
  app.get("/sw.js", (_req, res) => {
    const f = path.join(staticDir, "sw.js");
    if (!fs.existsSync(f)) return res.status(404).end();
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.setHeader("Service-Worker-Allowed", "/");
    res.type("application/javascript").sendFile(f);
  });
  // Old vanilla dashboard paths — gone permanently.
  app.get(["/classic.html", "/classic", "/legacy.html"], (_req, res) => {
    res.status(410).type("text").send("Classic UI removed. Use http://localhost:" + CONFIG.port + "/overlay.html");
  });
  // The React dashboard used to live at "/"; it's gone, so send everyone (including the Tauri
  // desktop shell, see desktop/) straight to the overlay.
  app.get(["/", "/index.html"], (_req, res) => res.redirect(302, "/overlay.html"));
  // Registered before express.static so this handler (no-store + the 503 when the file is missing)
  // wins over the plain static file it would otherwise serve.
  app.get("/overlay.html", sendOverlay);
  if (fs.existsSync(staticDir)) {
    app.use(express.static(staticDir, noStore));
  }

  const server = http.createServer(app);

  // Heartbeat interval for both hubs: a half-open socket (laptop sleep, network drop) never fires
  // 'close', so it lingers in the client set forever. Ping every 30s; terminate any client that
  // missed the prior ping — termination fires 'close', which detaches it. Client-side auto-reconnect
  // brings live tabs back.
  const HEARTBEAT_MS = 30_000;

  // WebSocket hub: relay every bus event to connected dashboards.
  // Two WS endpoints on one server: /ws (bus relay) + /term (PTY IO). Multiple WebSocketServers bound
  // with the `server` option fight over the upgrade — so use noServer and route the upgrade by path.
  // maxPayload caps inbound frame size (client -> server) so a broken/hostile client can't balloon
  // server memory. /ws clients (dashboards) never send meaningful payloads; /term clients only send
  // keystrokes/resize — both ceilings are generous headroom, not a real limit on either.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const termWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  // Both hubs carry live client data (bus firehose) or a shell (PTY IO) — same admin token as the
  // dashboard-only REST routes, passed as ?token= since browsers can't set WS handshake headers.
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://x");
    const path = url.pathname;
    // The tunnel door for `chronos host` links (HOSTS.md → Transport). Its own auth — a host token or
    // a join code, never the admin token — lives in brain-link.ts.
    if (path === HOST_PATH) return brainLink().handleUpgrade(req, socket, head, "tunnel");
    if (path !== "/ws" && path !== "/term") return socket.destroy();
    if (!tokenOk(url.searchParams.get("token"), CONFIG.adminToken)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (path === "/ws") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    else termWss.handleUpgrade(req, socket, head, (ws) => termWss.emit("connection", ws, req));
  });

  // Backpressure: a dashboard tab that's stalled (backgrounded, slow network) stops draining its
  // send buffer. Without a ceiling, the firehose of bus events piles up in that socket's memory
  // forever. Drop the connection past a threshold instead — the client's auto-reconnect (same as
  // /term) brings it back with a fresh buffer.
  const WS_BACKPRESSURE_BYTES = 4 * 1024 * 1024;
  bus.on("event", (e) => {
    let msg: string | null = null; // stringify lazily — with topic filters, an event may go to nobody
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      const topics = (client as any)._topics as Set<string> | undefined;
      if (topics && !topics.has(e.topic)) continue;
      if (client.bufferedAmount > WS_BACKPRESSURE_BYTES) { try { client.terminate(); } catch {} continue; }
      client.send(msg ??= JSON.stringify(e));
    }
  });

  // Dead-socket reaper: same rationale as the /term heartbeat below — a half-open socket never
  // fires 'close', so it lingers in wss.clients (and keeps receiving the bus firehose) forever.
  wss.on("connection", (ws, req) => {
    (ws as any).isAlive = true;
    ws.on("pong", () => { (ws as any).isAlive = true; });
    // ?topics=a,b,c — the client names what it acts on and the rest never crosses the wire.
    // No param = the full firehose, so every existing consumer is untouched.
    const topics = new URL(req?.url ?? "", "http://x").searchParams.get("topics");
    if (topics) (ws as any)._topics = new Set(topics.split(",").map((t) => t.trim()).filter(Boolean));
  });
  const wsHeartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if ((ws as any).isAlive === false) { try { ws.terminate(); } catch {} continue; }
      (ws as any).isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, HEARTBEAT_MS);
  // Unref'd: the listening server is what keeps the daemon alive, and a test that boots the API and
  // closes it must be able to exit.
  wsHeartbeat.unref?.();
  wss.on("close", () => clearInterval(wsHeartbeat));

  // Terminal IO: one socket per attached PTY session. Server→client frames are raw pty output;
  // client→server frames are JSON ({t:'in',d} keystrokes | {t:'resize',cols,rows}).
  termWss.on("connection", (ws, req) => {
    const id = new URL(req.url ?? "", "http://x").searchParams.get("id") ?? "";
    if (!attach(id, ws)) {
      try { ws.send("\r\n\x1b[31m[session not live — it may have ended]\x1b[0m\r\n"); } catch {}
      ws.close(4404, "not-live"); // distinct code → client stops reconnecting (session is gone, not a blip)
      return;
    }
    (ws as any).isAlive = true;
    ws.on("pong", () => { (ws as any).isAlive = true; });
    ws.on("message", (raw) => {
      let m: any;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.t === "in") writeTo(id, m.d);
      else if (m.t === "resize") resize(id, m.cols, m.rows);
      else if (m.t === "refresh") refreshClient(id, ws); // pane was hidden and dropped its stream
      else if (m.t === "rate") setClientRate(id, ws, m.ms); // this socket's own frame pace (0 = every flush)
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of termWss.clients) {
      if ((ws as any).isAlive === false) { try { ws.terminate(); } catch {} continue; }
      (ws as any).isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  termWss.on("close", () => clearInterval(heartbeat));

  // Loopback-only: LAN/remote access goes through the relay (outbound-only, token+HMAC'd), never
  // by opening this port beyond the host itself.
  server.listen(CONFIG.port, "127.0.0.1", () => {
    console.log(`[chronos] overlay + API on http://localhost:${CONFIG.port}`);
  });

  return server;
}
