import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { noteClaudeStreamEvent } from "./usage-meter.js";
import { CONFIG } from "./config.js";
import { bus } from "./bus.js";
import { asks, events, jobs, messages, repos, runs, sessions, tickets, workspaces } from "./store.js";
import { resolveVerifyMode, verdictBlocks, verify } from "./verifier.js";
import { createForRun, prDeliveryPatch } from "./reviews.js";
import { ensureWsTicketsDir, sandboxWrap, workspaceSandboxAllow } from "./sandbox.js";
import { niceWrap } from "./machine.js";
import { hostFor } from "./hosts/index.js";
import { getBackend } from "./backends/index.js";
import { isCloudBackend } from "./backends/types.js";
import type {
  CloudBackend,
  CloudLaunch,
  CloudLaunchOpts,
  CloudRef,
  CloudRunState,
  CloudStatus,
  CloudUsage,
} from "./backends/types.js";
import { gitTrackedSync, mcEnv, mcSystemText, openSession, syncAgentsMd } from "./terminal.js";
import { agentContext } from "./skills.js";
import { baseJobName } from "./job-name.js";
import { childEnv } from "./child-env.js";
import { egressEnv, egressLocked } from "./egress.js";
import { clampSandbox } from "./spawn-guard.js";
import { gatesPassed, parseGates, runGates } from "./gates.js";
import { renderReplay } from "./replay.js";
import { isStablePrefixMiss } from "./cache-health.js";
import { parseResetClock } from "./manager-fallback.js";
import type { GateResult, Job, Repo, RunStatus } from "./types.js";

const execFileAsync = promisify(execFile);

// Read-only, non-build run kinds. These manage their own ticket state via `mc` and run in the
// repo's SHARED checkout, not an isolated build worktree — so they must never trigger a review,
// run verify_cmd, or commit. `grade:` was the missing one: it slipped both guards and let the
// difficulty grader flip tickets to `review` and `git add -A` the shared tree onto main.
//
// The rate-limit fallback clones a job under `fallback:<name>` (dispatcher.ts), so the prefix has to
// be stripped before matching: `fallback:review:PER-80` read as a BUILD run, so every rate-limited
// reviewer's stand-in ended by queueing a review of itself — review.created → auto-dispatch reviewer
// → rate limit → fallback → review.created, 200 runs deep and a Telegram message on each hop.
// intake: is the chief-of-staff sweep (intake.ts) — READ-ONLY by design (disallowed Edit/Write,
// files idea drafts only). Missing it here parked a clean-exit intake run on a stray `mc ask`
// (PER-35 / run 239abc1e), same class of omission as grade: before it.
// dream: is the per-workspace memory pass (dream.ts) — read-only on code, writes memory only via mc.
const READONLY_RUN_PREFIXES = ["plan:", "review:", "distill:", "grade:", "ideas:", "intake:", "dream:"];
export function isReadOnlyRun(name?: string | null): boolean {
  const base = baseJobName(name);
  return !!base && READONLY_RUN_PREFIXES.some((p) => base.startsWith(p));
}

// Post-build agents that write in the ticket worktree (rebase/push/fix) — so they are NOT
// isReadOnlyRun (they must still take the one-agent-per-worktree lock) — but ending them is not a
// "build finished" event. Without this gate, a successful merge-gate:/ci-fix: called createForRun,
// forced the ticket back to `review`, published review.created, and re-dispatched a reviewer that
// approved the same diff again — which re-armed delivery + merge-gate (PER-4 / PER-13 loops).
const NO_REVIEW_ON_END_PREFIXES = ["merge-gate:", "ci-fix:"];
export function shouldFileReviewOnEnd(name?: string | null): boolean {
  if (isReadOnlyRun(name)) return false;
  const base = baseJobName(name);
  return !!base && !NO_REVIEW_ON_END_PREFIXES.some((p) => base.startsWith(p));
}

// Sandbox dir adjustments for a ticket that builds in an ISOLATED worktree (job.cwd) of `repoPath`.
// The shared main checkout must be WRITE-denied (guard is allow-by-default) so the agent — handed
// absolute repo paths in its context — can't edit it, `cd` there, and `git add -A && commit`, sweeping
// other concurrent builds' work onto main (the PER-36 incident). It stays READ-allowed: a linked
// worktree's git must read the main checkout (commondir) to operate, and blocking reads breaks git
// entirely. Two sub-paths are re-granted WRITE via addDirs: `.git` (shared objectstore/refs the
// worktree commits through) and `.mc` (gitignored runtime ticket store, absent from the worktree, that
// the agent reads + logs to). allow-own runs after the write-deny, so these narrower grants win.
// Empty when there's no repo or the run isn't in a worktree. (`mc` CLI lives at ~/.mc/bin, outside repo.)
export function worktreeSandboxDirs(
  repoPath: string | undefined | null,
  cwd: string,
): { readonly: string[]; grant: string[] } {
  if (!repoPath || path.resolve(repoPath) === path.resolve(cwd)) return { readonly: [], grant: [] };
  return { readonly: [repoPath], grant: [path.join(repoPath, ".git"), path.join(repoPath, ".mc")] };
}

// Pure decision extracted for unit testing (the real check lives inline in the close handler, where
// `status` and the open-asks lookup are both already in scope). A run PARKS instead of finishing when
// it would otherwise report success but left a question open: the worker committed WIP and exited
// cleanly per `mc ask`'s deadline message, or answered late mid-shutdown. A non-success outcome
// (failed/timeout/killed) is left alone — a crash is a crash, not a park, even with an open ask.
export function shouldPark(status: RunStatus, hasOpenAsk: boolean): boolean {
  return status === "success" && hasOpenAsk;
}

// Pure formatter for spawn-time mailbox injection (see execute()'s messagesNote block below) —
// extracted like shouldPark so it's testable without spawning a process. Empty input → empty string
// so the caller can .filter(Boolean).join() it straight into appendSystem alongside retryNote.
export function messagesNote(rows: { text: string; from_who: string; created_at: string }[]): string {
  if (!rows.length) return "";
  const lines = rows.map((r) => `- [${r.created_at}] ${r.from_who}: ${r.text}`).join("\n");
  return (
    `## Operator messages (delivered at spawn)\n${lines}\n` +
    `Treat these as directives from the operator; they may adjust or override parts of the ticket.`
  );
}

// Fold one result event's usage figure into the run total. `cumulative` backends (claude) report
// running totals for the whole invocation, so the latest value REPLACES the accumulator — summing
// them would double-count the moment a backend emits more than one result event (steer mode emits
// one per user message). Per-step backends (opencode's step_finish) leave it false and sum.
export function foldUsage(acc: number | null, v: number | null | undefined, cumulative: boolean): number | null {
  if (v == null) return acc;
  return cumulative ? v : (acc ?? 0) + v;
}

// Null-preserving accumulator for per-run usage totals: a field never reported by the backend stays
// null; once reported, subsequent (per-step) values add. Keeps grok's null cost null while summing tokens.
export function addUsage(acc: number | null, v: number | null | undefined): number | null {
  return v == null ? acc : (acc ?? 0) + v;
}

// Logged-out backend profile (keychain cred gone / OAuth expired). Detected on run failure so the
// daemon can open an in-app login terminal instead of silently failing job after job.
export const AUTH_ERR_RE = /invalid api key|please run \/login|not logged in|oauth token .*(expired|revoked)|authentication[_ ]?error/i;

// Live steerable runs: runId → the child's stdin + the count of user messages still awaiting their
// result event. Registered SYNCHRONOUSLY in execute()'s prologue — dispatch() returns while
// execute() is still awaiting pre-spawn work (AGENTS.md sync), so a steer can arrive before the
// child exists; those are queued and flushed right after the initial goal message at spawn.
// In-memory on purpose — a steer targets a process only THIS daemon holds a pipe to; after a
// restart the mailbox (mc tell) is the durable path.
type SteerStdin = NodeJS.WritableStream & { destroyed?: boolean; writableEnded?: boolean };
const liveSteer = new Map<
  string,
  {
    stdin: SteerStdin | null;
    outstanding: number;
    encode: (text: string) => string;
    queue: string[];
    // Mailbox rows marked delivered by a steer but not yet confirmed by a result event. A run that
    // dies with these outstanding never showed them to the agent, so the close handler puts them
    // back in the mailbox — a steer must never be able to LOSE an operator directive.
    unconfirmed: number[];
  }
>();

// Inject an operator message into a LIVE steer-mode run over stdin (or the pre-spawn queue).
// Returns false when the run isn't steerable (not steer mode, draining, or ended) — callers fall
// back to the mailbox.
export function steerRun(runId: string, text: string, from: string, messageId?: number): boolean {
  if (tryCloudSteer(runId, text, from, messageId)) return true;
  const entry = liveSteer.get(runId);
  if (!entry) return false;
  // Backstop for a registry entry orphaned by a throw between registration and the close handler:
  // the run row is authoritative about whether anything is still listening.
  if (runs.get(runId)?.status !== "running") return false;
  if (entry.stdin && (entry.stdin.destroyed || entry.stdin.writableEnded)) return false;
  const framed = entry.encode(
    `## Operator message (mid-run)\n${from}: ${text}\n` +
      `Treat this as a directive from the operator; it may adjust or override parts of the task.`,
  );
  if (entry.stdin) {
    // The child can die between our guard and this write (SIGTERM grace, crash) — the pipe then
    // raises EPIPE asynchronously on the stream. Without the 'error' listener installed at spawn
    // that is an uncaughtException that takes down the WHOLE daemon, not just this run.
    try {
      entry.stdin.write(framed);
    } catch (e: any) {
      console.warn(`[steer] ${runId.slice(0, 8)}: write failed (${e?.message ?? e}) — falling back to the mailbox`);
      return false;
    }
  } else {
    entry.queue.push(framed);
  }
  entry.outstanding++;
  if (messageId != null) entry.unconfirmed.push(messageId);
  events.add(runId, "steer", { text, from });
  bus.publish({ topic: "run.event", run_id: runId, event: { type: "steer", text, from } });
  return true;
}

// Open ONE interactive login terminal for the workspace's profile (dedupe by role) and announce it.
// The interactive CLI itself walks the operator through login; after that, re-dispatch just works.
async function promptLogin(job: Job, runId: string) {
  try {
    // Exact title + workspace match: a loose "login:"-prefix match (and omitting the workspace filter
    // for unscoped jobs, which sessions.list() treats as "no filter" = every workspace) would dedupe
    // onto an unrelated profile's login terminal — the operator logs in there and this job keeps failing.
    const wantTitle = `login: ${job.profile}`;
    const live = sessions
      .list({ status: "live" })
      .find((s) => s.title === wantTitle && s.workspace_id === (job.workspace_id ?? null));
    const sess =
      live ??
      (await openSession({
        workspace_id: job.workspace_id ?? null,
        role: "human",
        title: `login: ${job.profile}`,
        backend: job.backend,
        // It logs in the BRAIN's profile, the one this headless job runs under: never another computer.
        host_id: "local",
      } as any));
    bus.publish({
      topic: "auth.needed",
      workspace_id: job.workspace_id ?? null,
      backend: job.backend,
      run_id: runId,
      job_name: job.name ?? "job",
      session_id: sess?.id ?? null,
    });
  } catch (e) {
    console.error("[auth] promptLogin failed", e);
  }
}

// Spawn a headless coding-agent process (backend-agnostic) for a run and stream its events.
export async function execute(job: Job, runId: string): Promise<RunStatus> {
  const sessionId = randomUUID();
  // Set only on a resume run (answerAsk in src/asks.ts, after an ask is answered): the prior run's
  // session_id to reopen instead of starting a fresh transcript. See backend.buildArgs below.
  const resumeSessionId = runs.get(runId)?.resume_session ?? null;
  const backend = getBackend(job.backend);
  // A cloud run is not a child process: launch, sleep, reconcile. Branch BEFORE any of the local
  // spawn prologue below (buildArgs/oneShot/interactiveArgs on a CloudBackend are required to throw —
  // see backends/types.ts CloudBackend — so this must run before anything reaches them).
  if (isCloudBackend(backend)) return executeCloud(job, runId, backend);
  // A backend whose headless args can't reopen the prior transcript (--resume is claude-only; codex
  // resumes in oneShot but not buildArgs) used to degrade silently to a fresh session that had never
  // heard of the question it was resumed to act on. Instead: replay the prior run's event log into
  // the trigger context (replay.ts) so the fresh session continues the work.
  const nativeResume = backend.headlessResume ? resumeSessionId : null;
  let replayNote: string | null = null;
  if (resumeSessionId && !nativeResume) {
    const prior = runs.bySession(resumeSessionId);
    replayNote = prior ? renderReplay(prior.id, "paused on a question that has now been answered") : null;
  }
  // Workspace (if any) owns the config dir + isolation wall; fall back to the legacy profile map.
  const ws = job.workspace_id ? workspaces.get(job.workspace_id) : undefined;
  const profileDir = ws?.config_dir ?? CONFIG.profiles[job.profile] ?? CONFIG.profiles.claude;
  const denyDirs = job.workspace_id ? workspaces.isolationDenyDirs(job.workspace_id) : [];
  // Standing workspace context (★ memos + skill index) is injected HERE, fresh at run time, so
  // every workspace-scoped run gets it — ticket/review dispatches, cron jobs, manual `mc job new`
  // jobs alike. Merged with any job-specific append_system; equality check skips legacy jobs that
  // still carry a creation-time snapshot.
  // Jobs carry no repo_id directly — derive it from the ticket so repo-scoped ★ memos load for
  // ticket/review dispatches on that repo (cron/manual jobs with no ticket stay workspace-wide only).
  const ctxRepoId = job.ticket_id ? tickets.get(job.ticket_id)?.repo_id ?? null : null;
  const ctx = job.workspace_id ? agentContext(job.workspace_id, ctxRepoId) : "";
  // Retry recovery: on a re-run (attempt > 1) tell the agent what broke last time so it fixes the
  // cause — or works around an unrelated failure — instead of blindly repeating. The worktree still
  // holds the prior attempt's partial work.
  const attempt = runs.get(runId)?.attempt ?? 1;
  let retryNote = "";
  if (attempt > 1) {
    const prev = runs.list(job.id).find((r) => r.id !== runId && r.error && (r.status === "failed" || r.status === "timeout"));
    if (prev?.error) {
      retryNote =
        `## Retry ${attempt} — the previous attempt FAILED\nLast error:\n\`\`\`\n${prev.error.slice(-1500)}\n\`\`\`\n` +
        `Your earlier partial work is still in the working tree. Diagnose the cause and finish the task. ` +
        `If this failure is unrelated to the ticket (e.g. a pre-existing broken test or flaky infra), work around it and complete the ticket anyway.`;
    }
  }
  // Spawn-time mailbox injection: ticket-scoped only (a message addressed to a specific PRIOR run
  // that has since died delivers nowhere — `mc tell <ticket>` is the durable channel; see messages.ts).
  // NOT marked delivered here: the cwd-gone early return below can still kill this run before the
  // agent ever sees the note, and directives marked delivered to a run that never spawned are lost
  // for good. Delivery is recorded only once the spawn path is actually committed.
  let messagesNoteText = "";
  let pendingMessageIds: number[] = [];
  if (job.ticket_id) {
    const pending = messages.undeliveredFor(null, job.ticket_id);
    if (pending.length) {
      messagesNoteText = messagesNote(pending);
      pendingMessageIds = pending.map((m) => m.id);
    }
  }
  // The repo tracks its own AGENTS.md, so the file mirror below deliberately leaves it alone (it
  // would show up as a real modification and ride along in `git add -A` — Chronos must never appear
  // in a repo). Carry the same mission-control workflow in as standing system text instead. Only for
  // backends that can't read the installed Claude skill: claude-code already has it in its config
  // dir (installMcSkill), and duplicating 300+ lines into its system prompt buys nothing. Every
  // other backend accepts append_system (grok via --rules; cursor/codex/opencode fold it into the
  // prompt), and without this they would lose the `mc` CLI reference entirely — including
  // cursor-agent, which acme's route_config hands every complexity 1-2 ticket.
  //
  // gitTrackedSync, not the async twin, and NOT the syncAgentsMd call further down: every statement
  // before the `liveSteer.set` registration below has to stay await-free (see the comment there).
  const mcNote = backend.name !== "claude-code" && gitTrackedSync(job.cwd, "AGENTS.md") ? mcSystemText() : "";
  const appendSystem = [
    ctx && ctx !== job.append_system ? [ctx, job.append_system].filter(Boolean).join("\n\n") : job.append_system,
    mcNote,
    retryNote,
    messagesNoteText,
  ].filter(Boolean).join("\n\n");
  // Workspace = the access boundary: grant every sibling repo + the workspace's ticket-files dir,
  // fresh at run time (covers manual `mc job new` jobs and stale add_dirs snapshots). Both walls get
  // the dirs: OS sandbox (addDirs below) + the CLI's own --add-dir (via effJob.add_dirs).
  let addDirs: string[] = [];
  try {
    if (job.add_dirs) addDirs = JSON.parse(job.add_dirs);
  } catch {}
  const buildRepo = ctxRepoId ? repos.get(ctxRepoId) : undefined;
  const wt = worktreeSandboxDirs(buildRepo?.path, job.cwd);
  if (ws) {
    const excluded = new Set<string>([job.cwd, ...wt.readonly]);
    const grant = [
      ...repos.list(ws.id).map((r) => r.path).filter((p) => p && !excluded.has(p) && fs.existsSync(p)),
      ensureWsTicketsDir(ws.slug),
    ];
    addDirs = [...new Set([...addDirs, ...grant, ...wt.grant])];
  }
  const effJob = { ...job, append_system: appendSystem, add_dirs: addDirs.length ? JSON.stringify(addDirs) : null };
  const context = [replayNote, runs.get(runId)?.context ?? null].filter(Boolean).join("\n\n") || null;
  // Steer mode (opt-in per workspace, backends that speak streaming input): the goal moves out of
  // argv into the first stdin message, stdin stays open, and `mc tell` / POST /runs/:id/steer can
  // inject operator messages into the LIVE run instead of waiting for its next checkpoint. The CLI
  // emits one result event per user message; the run ends when we close stdin (see rl handler).
  const steerMode = !!(ws?.live_steer && backend.steerArgs && backend.encodeSteer);
  const args = steerMode
    ? backend.steerArgs!(effJob, sessionId, nativeResume)
    : backend.buildArgs(effJob, sessionId, context, nativeResume);
  // Same goal+context composition claude's buildArgs does — in steer mode we do it ourselves
  // because the goal travels over stdin.
  const initialText = context
    ? `${effJob.goal}\n\n--- Trigger context (the event that fired this run) ---\n${context}`
    : effJob.goal;
  // Register BEFORE the first await (gotcha #1's sibling): dispatch() returns mid-prologue, and a
  // steer arriving before the spawn must land in the queue, not bounce to the mailbox.
  if (steerMode) liveSteer.set(runId, { stdin: null, outstanding: 1, encode: backend.encodeSteer!, queue: [], unconfirmed: [] });

  runs.patch(runId, {
    status: "running",
    // A natively resumed run continues the OLD transcript id (backend emits --resume, not
    // --session-id), so this row's session_id must be the resumed one — else Focus/
    // `/runs/:id/continue` look for a transcript under the fresh uuid that was never actually
    // opened. A replay-based resume really does open a fresh session, so it records the fresh id.
    session_id: nativeResume ?? sessionId,
    started_at: new Date().toISOString(),
  });
  bus.publish({ topic: "run.started", run_id: runId, job_id: job.id });

  // Re-clamp at execute time (not just on job create/update) so a workspace's isolation floor is
  // enforced even against a stale row saved before the floor was tightened.
  const sandboxMode = clampSandbox(job.sandbox, job.workspace_id);
  // A build worktree is created at dispatch and pruned when the ticket lands, but a rate-limit
  // resume re-dispatches the same job hours later — into a cwd that no longer exists. Node reports
  // a missing spawn cwd as ENOENT *naming the binary* ("spawn sandbox-exec ENOENT"), which reads as
  // a broken sandbox and sent us chasing the wrong bug. Say what actually happened.
  if (!fs.existsSync(job.cwd)) {
    liveSteer.delete(runId);
    const msg = `working directory gone: ${job.cwd} (worktree pruned?) — re-dispatch the ticket to rebuild it`;
    runs.patch(runId, { status: "failed", ended_at: new Date().toISOString(), error: msg });
    console.warn(`[run] ${job.name}: ${msg}`);
    if (job.ticket_id && shouldFileReviewOnEnd(job.name)) {
      try { await createForRun(job, runId, "failed"); } catch (e) { console.error("[review] createForRun failed", e); }
    }
    bus.publish({ topic: "run.ended", run_id: runId, status: "failed" });
    return "failed";
  }
  // Headless build runs execute in a git worktree (never contains the untracked AGENTS.md a normal
  // checkout accumulates via PTY-open/boot sync) — refresh it here too, and let it re-assert the
  // local ignores for Chronos's in-repo artifacts. syncAgentsMd never throws, but this call is a
  // courtesy, not load-bearing: a failure must never block the spawn below. Stays HERE, after the
  // liveSteer registration: it is execute()'s first await and moving it earlier hung the steer tests.
  try {
    await syncAgentsMd(job.cwd);
  } catch (e: any) {
    console.warn(`[run] ${job.name}: AGENTS.md sync failed`, e?.message ?? e);
  }
  // Spawn is committed past the cwd guard — NOW record the mailbox as delivered to this run (so a
  // later checkpoint in the same run doesn't re-show it). An undelivered row survives a cwd-gone
  // failure above and re-injects on the next dispatch instead of vanishing.
  if (pendingMessageIds.length) messages.markDelivered(pendingMessageIds, runId);
  // Same credential grant a terminal in this workspace gets — a headless `bq` run needs gcloud just
  // as much as an interactive one, and the two diverging would be its own confusing bug.
  const allowSecrets = workspaceSandboxAllow(
    job.workspace_id ? (workspaces.get(job.workspace_id)?.sandbox_allow ?? null) : null,
  );
  const sandboxed = sandboxWrap(sandboxMode, job.cwd, addDirs, profileDir, denyDirs, backend.bin(), args, egressLocked(job.workspace_id), wt.readonly, allowSecrets);
  // Headless runs get the same `nice` a Desk terminal does (src/machine.ts): a dispatched build is
  // no less able to fork a full vitest pool, and the operator's UI outranks both.
  const { cmd, cmdArgs } = niceWrap(sandboxed.cmd, sandboxed.cmdArgs);
  // Through the run's host (HOSTS.md): today always the brain, which is child_process.spawn with the
  // same stdio as before (stdin piped only in steer mode, stdout/stderr always piped).
  const child = await hostFor(runs.get(runId)).spawnProcess({
    id: runId,
    cmd,
    args: cmdArgs,
    cwd: job.cwd,
    // MC_RUN: lets `mc steps`/`mc step` (unlike ticket/workspace/repo, sessions have no run — so this
    // is set here, not inside mcEnv) address this run's progress checklist without the CLI knowing its
    // own run id any other way.
    env: { ...childEnv(ws), ...backend.env(job, profileDir), ...mcEnv(job.workspace_id, null, job.ticket_id), MC_RUN: runId, ...egressEnv(job.workspace_id) },
    stdin: steerMode,
  });

  runs.patch(runId, { pid: child.pid ?? null });

  if (steerMode) {
    // outstanding = user messages sent minus result events received. The initial goal counts as 1;
    // each steer +1; each result -1. At 0 we close stdin, which is what ends the CLI process — a
    // steer that lands mid-turn is buffered by the CLI and processed as the next turn. Steers that
    // raced the spawn were queued in the prologue entry; they flush after the goal, in order.
    const entry = liveSteer.get(runId)!;
    entry.stdin = child.stdin!;
    // MUST be installed before any write: an EPIPE with no listener is an uncaughtException that
    // kills the daemon (every workspace's runs, watchdogs and timers), not just this child.
    child.stdin!.on("error", (e: any) =>
      console.warn(`[steer] ${job.name}: stdin error (${e?.code ?? e?.message ?? e}) — run continues, mailbox is the fallback`),
    );
    child.stdin!.write(backend.encodeSteer!(initialText));
    for (const framed of entry.queue.splice(0)) child.stdin!.write(framed);
  }

  let finalStatus: RunStatus = "failed";
  let timedOut = false;
  let rateLimited = false;
  let resetsAt: number | null = null; // unix seconds, when access is restored
  let resultText: string | null = null; // human-readable message from the result event
  // Answer text for backends that stream it as deltas and hand over a terminal event with no text
  // (grok). Capped because this is a transcript, not a document: what reads it back — merge-gate's
  // verdict line, the verifier's judgement — lives at the END, so the tail is the part worth keeping.
  let deltaText = "";
  const DELTA_CAP = 20000;
  // Running usage totals across result events (opencode reports per-step; others once). See rl.on("line").
  let costAcc: number | null = null;
  let costEstAcc = false; // true while costAcc is a token-table estimate, not a vendor total
  let tinAcc: number | null = null;
  let toutAcc: number | null = null;
  let turnsAcc: number | null = null; // turns reported by the terminal result (prefix-miss gate)
  let crAcc: number | null = null; // prompt-cache reads (see src/cache-health.ts)
  let cwAcc: number | null = null; // prompt-cache write tokens
  // Rolling tail — a chatty CLI must not OOM the daemon over a long run.
  const STDERR_CAP = 4000;
  let stderrTail = "";

  const watchdog = setTimeout(() => {
    timedOut = true;
    // A steer-mode CLI is blocked reading stdin; EOF is its documented way to finish, and it's more
    // reliable than a signal (the child may be mid-turn and slow to handle SIGTERM). Close first,
    // then signal — otherwise a child that misses the signal lingers holding the pipe open.
    try {
      liveSteer.get(runId)?.stdin?.end();
    } catch {}
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 10_000).unref?.();
  }, job.timeout_sec * 1000);
  watchdog.unref?.();

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const ev = backend.parseLine(trimmed);
    events.add(runId, ev.type, ev.payload);
    bus.publish({ topic: "run.event", run_id: runId, event: ev.payload });

    // Rate-limit / out-of-credits: capture reset time so the dispatcher resumes instead of
    // burning retries on a wall it can't pass.
    if (backend.name === "claude-code") noteClaudeStreamEvent(profileDir, ev.payload);
    const rlInfo = backend.detectRateLimit(ev);
    if (rlInfo?.rateLimited) {
      rateLimited = true;
      if (typeof rlInfo.resetsAt === "number") resetsAt = rlInfo.resetsAt;
    }

    const chunk = backend.textDelta?.(ev);
    if (chunk) deltaText = (deltaText + chunk).slice(-DELTA_CAP);

    const result = backend.extractResult(ev);
    if (result) {
      if (typeof result.result_text === "string") resultText = result.result_text;
      else if (deltaText.trim()) resultText = deltaText.trim();
      // Accumulate cost/tokens across result events. Backends that emit ONE terminal result
      // (claude/cursor/grok/openai) sum to that single value; opencode emits per-step step_finish
      // events, so summing is what makes its multi-step totals whole (was: last step only → undercount).
      // Null-preserving: a field never reported stays null (e.g. grok never reports cost).
      // claude reports cumulative usage per result event; opencode reports per-step. See foldUsage.
      const cum = !!result.usage_cumulative;
      if (result.cost_usd != null) {
        // A vendor total wins over any prior estimate; estimates only stick when nothing metered yet.
        if (result.cost_estimated) {
          if (costAcc == null || costEstAcc) costEstAcc = true;
        } else {
          costEstAcc = false;
        }
      }
      costAcc = foldUsage(costAcc, result.cost_usd, cum);
      tinAcc = foldUsage(tinAcc, result.tokens_in, cum);
      toutAcc = foldUsage(toutAcc, result.tokens_out, cum);
      crAcc = foldUsage(crAcc, result.tokens_cache_read, cum);
      cwAcc = foldUsage(cwAcc, result.tokens_cache_write, cum);
      turnsAcc = result.num_turns ?? turnsAcc;
      runs.patch(runId, {
        num_turns: result.num_turns ?? null,
        cost_usd: costAcc,
        cost_estimated: costAcc != null && costEstAcc ? 1 : 0,
        tokens_in: tinAcc,
        tokens_out: toutAcc,
        cache_read: crAcc,
        cache_write: cwAcc,
        is_error: result.is_error ? 1 : 0,
        // A backend supplies the answer one way or the other: whole in the terminal event, or as
        // deltas we just concatenated. Falling back here is what keeps runs.summary — the field
        // merge-gate and the verifier read their decisions out of — populated for both kinds.
        summary: result.summary ?? (deltaText.trim() || null),
      });
      finalStatus = result.is_error ? "failed" : "success";
      // Steer mode: this result closes one outstanding user message. When none remain, ending
      // stdin is what tells the CLI the conversation is over (it exits; close fires below).
      const steer = liveSteer.get(runId);
      if (steer) {
        steer.unconfirmed.shift(); // this result is the agent's answer to the oldest pending message
        if (--steer.outstanding <= 0) steer.stdin?.end();
      }
    }
  });

  child.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-STDERR_CAP);
  });

  return await new Promise<RunStatus>((resolve) => {
    child.onClose(async (code) => {
      clearTimeout(watchdog);
      // Steers written to the pipe but never answered (run timed out / was killed / crashed mid-
      // turn) were marked delivered optimistically — put them back so the next dispatch re-injects
      // them. Live steering accelerates the mailbox; it must never swallow a directive.
      const steerEntry = liveSteer.get(runId);
      liveSteer.delete(runId);
      // A run that ended WITHOUT draining its messages (timeout, kill, crash) never reached the
      // outstanding==0 path that closes stdin, so the pipe handle stays open — it keeps the event
      // loop alive and leaks one handle per such run. Tear it down explicitly.
      if (steerEntry?.stdin && !steerEntry.stdin.writableEnded) {
        try {
          (steerEntry.stdin as any).destroy?.();
        } catch {}
      }
      if (steerEntry?.unconfirmed.length) {
        messages.undeliver(steerEntry.unconfirmed);
        console.warn(
          `[steer] ${job.name}: ${steerEntry.unconfirmed.length} operator message(s) unprocessed at exit — returned to the mailbox`,
        );
      }
      let status: RunStatus = timedOut ? "timeout" : code === 0 ? finalStatus : "failed";
      // A rate-limit / out-of-credits wall isn't the job's fault: don't count it as a failure
      // (no retry, no on_failure chain). The dispatcher resumes it once access is restored.
      if (rateLimited && status !== "success") status = "rate_limited";
      // An operator kill (stopRun) already set the row to `killed`; the child then exits non-zero and
      // this used to overwrite it with `failed`, so the dispatcher auto-retried the kill — every kill
      // bred a replacement. A deliberate kill is terminal: no retry, no on_failure chain.
      if (runs.get(runId)?.status === "killed") status = "killed";
      // Prefer the CLI's own result message (e.g. "You've hit your session limit") over bare stderr,
      // which is usually empty for API-level errors.
      let err =
        status === "success"
          ? null
          : resultText || stderrTail || null;
      if (status === "rate_limited") {
        // The reset time is the single most useful thing this failure carries: the dispatcher resumes
        // off it, and the quota gate reads it back to know how long the credential stays dead. When the
        // backend's own event doesn't carry one, take the CLI's own wording ("resets 1:40pm") — it is
        // usually all a session-limit message gives, and a null here reads as "no wall at all".
        const spoken = resetsAt ? null : parseResetClock(resultText || stderrTail);
        const resetIso = resetsAt ? new Date(resetsAt * 1000).toISOString() : spoken ? new Date(spoken).toISOString() : null;
        runs.patch(runId, { resets_at: resetIso });
        if (resetIso) err = `rate limited; resets ${resetIso}${resultText ? ` — ${resultText}` : ""}`;
      }

      // Everything from here on (park check → verifier → gates → the terminal runs.patch → review
      // queueing → run.ended) is the SAME post-run path a cloud run takes at finalize — see
      // finalizeRun below. Two finalize paths that drift is the bug that design exists to avoid.
      const final = await finalizeRun(job, runId, status, err, { exitCode: code ?? null });
      resolve(final);
    });
    child.onError((e) => {
      clearTimeout(watchdog);
      liveSteer.delete(runId);
      runs.patch(runId, {
        status: "failed",
        ended_at: new Date().toISOString(),
        error: String(e),
      });
      bus.publish({ topic: "run.ended", run_id: runId, status: "failed" });
      resolve("failed");
    });
  });
}

// ───────────────────────────── shared finalize (local + cloud) ─────────────────────────────

/**
 * The one post-run path, whoever the caller is: a local run's `close` handler above, a cloud run
 * finishing inline in executeCloud, or the reconciler picking a cloud run back up hours later.
 * `status`/`err` are the caller's read of what happened (child exit code, or the cloud provider's
 * own terminal status); everything from here on — park, verifier, gates, the terminal `runs.patch`,
 * review queueing, `run.ended` — is identical either way, which is the whole point: merge-gate,
 * review and the verifier must never be able to tell a run was cloud.
 */
export async function finalizeRun(
  job: Job,
  runId: string,
  status: RunStatus,
  err: string | null,
  opts: { exitCode?: number | null } = {},
): Promise<RunStatus> {
  const ws = job.workspace_id ? workspaces.get(job.workspace_id) : undefined;

  // Park: the worker filed an `mc ask` and exited (committed WIP, per the CLI's deadline
  // instructions) before an answer arrived — or answered late, mid-shutdown. This is not a
  // finished build: skip verifier/gates/review below entirely so nothing judges half-done work
  // against the ticket's acceptance criteria. The ticket stays in_progress; answerAsk (src/asks.ts)
  // re-dispatches this same job once the operator answers. A failed/timed-out/killed run is left
  // alone even with an open ask — a crash is a crash, not a park.
  // Read-only runs (plan:/review:/…) are excluded: planners fire `mc ask --wait 0` and move on, and
  // a reviewer that falls back to `changes` after a short `mc ask` wait still has an open ask when
  // it exits — parking either one would stall the plan/review pipeline waiting on an answer nobody
  // needs to unblock a park (the ticket already got the fire-and-forget question or the "changes"
  // verdict noting it).
  if (!isReadOnlyRun(job.name) && shouldPark(status, asks.openForRun(runId).length > 0)) status = "paused";

  // Verifier pass: confirm the goal was actually met before declaring success. The stored
  // verdict always carries the mode it ran under, so shadow-mode history shows what strict
  // WOULD have blocked (the evidence for flipping a workspace to fail-closed).
  if (status === "success" && job.verify) {
    const run = runs.get(runId);
    const mode = resolveVerifyMode(ws);
    const verdict = await verify(job, run?.summary ?? "");
    runs.patch(runId, { verify_verdict: JSON.stringify({ ...verdict, mode }) });
    if (verdictBlocks(mode, verdict)) {
      status = "failed";
      err = `verifier: ${verdict.reason}`;
    } else if (!verdict.met && mode === "shadow") {
      console.warn(`[verify] ${job.name}: shadow verdict would have failed the run — ${verdict.reason}`);
    }
  }

  // Per-repo evidence gates: the repo's own typecheck/lint/test/build commands, run in the
  // build worktree. A red gate no longer fails the RUN (which parked the ticket in `blocked`
  // and needed a human to notice) — the results are handed to createForRun, which files them as
  // a changes-requested review so the build agent reworks against the real failure output.
  // A cloud run's caller (executeCloud/finalizeCloudRun) has already fetched the cloud branch into
  // job.cwd before calling here, so this runs against the agent's actual produced code either way.
  let gateResults: GateResult[] | null = null;
  if (status === "success" && job.ticket_id && shouldFileReviewOnEnd(job.name)) {
    const t = tickets.get(job.ticket_id);
    const repo = t?.repo_id ? repos.get(t.repo_id) : undefined;
    const gates = parseGates(repo);
    if (gates.length) {
      gateResults = await runGates(gates, job.cwd, childEnv(ws));
      if (!gatesPassed(gateResults)) {
        const failed = gateResults.filter((g) => !g.ok).map((g) => g.name).join(", ");
        // Keep the verifier's verdict (nested) instead of clobbering it — shadow-mode history
        // is the evidence for flipping a workspace to strict, and a gate failure erasing it
        // would punch holes in exactly that record.
        let verifier: unknown;
        try {
          verifier = JSON.parse(runs.get(runId)?.verify_verdict ?? "");
        } catch {}
        runs.patch(runId, {
          verify_verdict: JSON.stringify({ met: false, reason: `gates failed: ${failed}`, gates: gateResults, verifier }),
        });
      }
    }
  }

  runs.patch(runId, {
    status,
    exit_code: opts.exitCode ?? null,
    ended_at: new Date().toISOString(),
    error: err,
  });
  // Cache-health telemetry: a run that wrote far more prompt-cache than it read back churned
  // its prefix — usually a volatile block (dated memo, reordered skills index) re-invalidating
  // the cached system prompt on every API call. Surfaced in /api/stats; warn per run here. Read off
  // the row (not a local accumulator) so this reads the same for a local run's per-line totals and
  // a cloud run's one-shot usage() figures.
  const row = runs.get(runId);
  if (isStablePrefixMiss({ cache_read: row?.cache_read ?? null, cache_write: row?.cache_write ?? null, num_turns: row?.num_turns ?? null })) {
    console.warn(
      `[cache] ${job.name}: stable-prefix miss — wrote ${row?.cache_write} cache tokens but read ${row?.cache_read ?? 0}; ` +
        `something volatile is churning the prompt prefix`,
    );
  }

  // Ticket-bound BUILD run finished → queue a review (success) or block the ticket (otherwise).
  // Planning + reviewer runs (read-only) and post-build gates (merge-gate:/ci-fix:) are excluded —
  // they are not "build finished" events (see shouldFileReviewOnEnd).
  // Paused (parked on an open ask) is excluded too — it isn't finished, so no review yet.
  if (job.ticket_id && status !== "rate_limited" && status !== "paused" && shouldFileReviewOnEnd(job.name)) {
    try {
      await createForRun(job, runId, status, gateResults);
    } catch (e) {
      console.error("[review] createForRun failed", e);
    }
  }
  // Auth wall (logged-out profile): open an in-app login terminal + alert, instead of a bare fail.
  if (status === "failed" && err && AUTH_ERR_RE.test(err)) await promptLogin(job, runId);
  const tk = job.ticket_id ? tickets.get(job.ticket_id) : undefined;
  bus.publish({
    topic: "run.ended",
    run_id: runId,
    status,
    job_name: job.name ?? undefined,
    ticket_id: job.ticket_id ?? null,
    ticket_key: tk?.key ?? null,
    workspace_id: job.workspace_id ?? null,
  });
  return status;
}

// ───────────────────────────── cloud runs ─────────────────────────────
//
// A cloud run is not a child process: launch, sleep, reconcile. Chronos launches it on the
// provider's VM, persists the ids, and either tails the live event stream (this process) or picks
// the run back up later (cloud-reconcile.ts) — the provider keeps the run state and a replayable
// event stream, so nothing is lost whether the Mac slept for a minute or the daemon was off for a
// day. See docs/plans/2026-09-22-cursor-cloud-backend.md.

// Runs currently being tailed BY THIS PROCESS, keyed by run id — guards against executeCloud's own
// attach and the reconciler's re-attach racing each other onto the same stream (which would double-
// store every event). Checked inside streamCloudRun itself, not just by callers, so it holds no
// matter who calls it first.
const cloudStreaming = new Set<string>();
// Whether THIS process already has ref's stream open — cloud-reconcile.ts checks this before
// spending a getRun() call on a run it would otherwise redundantly (and racily) re-poll.
export function isCloudStreaming(runId: string): boolean {
  return cloudStreaming.has(runId);
}
// Runs currently inside finalizeCloudRun, keyed by run id — the reconciler's poll and an
// executeCloud that just saw its own terminal frame can both decide "this run is done" in the same
// tick; without this a run could be finalized twice (double review, double run.ended).
const cloudFinalizing = new Set<string>();

const CLOUD_LAUNCH_MAX_RETRIES = 3;
const CLOUD_LAUNCH_RETRY_SEC = 60;

function isCloudRateLimited(e: any): boolean {
  return e?.status === 429 || e?.code === 429 || /\b429\b|resource[_ ]exhausted|rate[- ]?limit/i.test(String(e?.message ?? e ?? ""));
}
function cloudRetryAfterSec(e: any): number {
  const v = Number(e?.retryAfter ?? e?.retry_after);
  return Number.isFinite(v) && v > 0 ? v : CLOUD_LAUNCH_RETRY_SEC;
}

// Launch with retry on 429 (`retryAfter` honoured when the backend supplies one), capped at 3 tries
// 60s apart per the spec — a retried dispatch must not launch (and bill) the same work twice, which
// is exactly what `opts.idempotencyKey` (the run id) is for.
export async function launchCloudWithRetry(backend: CloudBackend, opts: CloudLaunchOpts): Promise<CloudLaunch> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= CLOUD_LAUNCH_MAX_RETRIES; attempt++) {
    try {
      return await backend.launch(opts);
    } catch (e: any) {
      lastErr = e;
      if (!isCloudRateLimited(e) || attempt === CLOUD_LAUNCH_MAX_RETRIES) throw e;
      const wait = cloudRetryAfterSec(e);
      console.warn(`[cloud] ${opts.runId.slice(0, 8)}: launch 429 (attempt ${attempt}/${CLOUD_LAUNCH_MAX_RETRIES}) — retrying in ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
  throw lastErr;
}

// git@host:owner/repo.git | ssh://git@host/owner/repo.git | https://host/owner/repo(.git)? → https URL.
// Exported for tests. Returns null for anything that doesn't parse as a normal remote.
export function githubHttpsUrl(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const trimmed = remote.trim();
  let m = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?\/?$/);
  if (!m) m = trimmed.match(/^ssh:\/\/git@([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!m) m = trimmed.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return `https://${m[1]}/${m[2]}`;
}

// CloudLaunchOpts.repos: the work repo first (with its default branch as startingRef), then any
// add_dirs that resolved to a sibling repo with its own GitHub remote (read-only add_dirs on the
// provider side too) — capped at 20 per the API limit. Repos with no recognisable GitHub remote are
// dropped rather than sent malformed. Exported (pure) for tests.
export function buildCloudRepos(
  buildRepo: Repo | undefined,
  extraRepos: Repo[],
): CloudLaunchOpts["repos"] {
  const out: CloudLaunchOpts["repos"] = [];
  const seen = new Set<string>();
  const add = (r: Repo | undefined) => {
    if (!r) return;
    const url = githubHttpsUrl(r.git_remote);
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, startingRef: r.default_branch ?? null });
  };
  add(buildRepo);
  for (const r of extraRepos) add(r);
  return out.slice(0, 20);
}

const CLOUD_STATUS_MAP: Record<Exclude<CloudStatus, "running">, RunStatus> = {
  finished: "success",
  error: "failed",
  cancelled: "killed",
  expired: "timeout",
};

// Best-effort: pull the cloud branch into the ticket's LOCAL worktree so the shared gates step
// (finalizeRun → runGates, which runs in job.cwd) sees the agent's actual produced code, and so
// createForRun's own `git add -A`/commit — if it has anything left to do — lands on top of it. Never
// throws: a repo gates run against stale content is a worse review, not a crashed daemon.
async function syncWorktreeToCloudBranch(cwd: string, branch: string): Promise<void> {
  try {
    await execFileAsync("git", ["-C", cwd, "fetch", "origin", branch], { timeout: 30_000 });
    await execFileAsync("git", ["-C", cwd, "reset", "--hard", "FETCH_HEAD"], { timeout: 15_000 });
  } catch (e: any) {
    console.warn(`[cloud] sync ${branch} into ${cwd} failed — gates run against whatever is already checked out (${e?.message ?? e})`);
  }
}

/**
 * Tail a cloud run's SSE stream, storing every frame through the EXISTING run_events path (Focus and
 * the Desk render it unchanged — no second event pipeline) and batching `cloud_last_event_id` so a
 * daemon that slept mid-run resumes from there instead of replaying the whole run.
 *
 * Resolves `{terminal:true}` on a result/done/error frame — the caller finalizes. Resolves
 * `{terminal:false}` on anything else ending the stream (Mac slept, wifi dropped, the daemon
 * restarted mid-iteration): that is NOT a failure. Mark nothing; the reconciler picks the run back
 * up on its own clock, resuming from the cursor this function just persisted.
 */
export async function streamCloudRun(
  backend: CloudBackend,
  ref: CloudRef,
  runId: string,
  lastEventId: string | null,
): Promise<{ terminal: boolean }> {
  if (cloudStreaming.has(runId)) return { terminal: false }; // already tailed elsewhere in this process
  cloudStreaming.add(runId);
  let cursor = lastEventId;
  let pending = 0;
  let lastFlush = Date.now();
  const flush = () => {
    if (cursor) runs.patch(runId, { cloud_last_event_id: cursor });
    pending = 0;
    lastFlush = Date.now();
  };
  try {
    for await (const frame of backend.stream(ref, lastEventId)) {
      if (frame.eventId) cursor = frame.eventId;
      if (frame.event) {
        events.add(runId, frame.event.type, frame.event.payload);
        bus.publish({ topic: "run.event", run_id: runId, event: frame.event.payload });
      }
      // Batched (every ~2s or 20 frames), never once per frame — this is the resume cursor, not a log.
      pending++;
      if (pending >= 20 || Date.now() - lastFlush >= 2000) flush();
      if (frame.terminal) {
        flush();
        return { terminal: true };
      }
    }
  } catch (e: any) {
    console.warn(`[cloud] ${runId.slice(0, 8)}: stream disconnected (${e?.message ?? e}) — the reconciler will pick it up`);
  } finally {
    cloudStreaming.delete(runId);
  }
  flush();
  return { terminal: false };
}

/**
 * Finalize = one `getRun` + one `usage`, then the SAME post-run path a local run takes
 * (finalizeRun) — so merge-gate/review/verifier never learn this run was cloud. Called from
 * executeCloud (this process, right after the stream), and from cloud-reconcile.ts (this process or
 * a fresh one, any time later) — both go through this one function so there is exactly one place
 * that maps provider state onto a Chronos run.
 *
 * `forceStatus` is set only by the reconciler's timeout path: the provider may not have caught up to
 * a `cancel()` yet, and a timed-out run is `timeout` regardless of what `getRun` still reports.
 */
export async function finalizeCloudRun(
  job: Job,
  runId: string,
  backend: CloudBackend,
  ref: CloudRef,
  forceStatus?: RunStatus,
): Promise<RunStatus> {
  const cur = runs.get(runId);
  if (!cur || cur.status !== "running") return cur?.status ?? "failed";
  if (cloudFinalizing.has(runId)) return "running";
  cloudFinalizing.add(runId);
  try {
    let state: CloudRunState;
    try {
      state = await backend.getRun(ref);
    } catch (e: any) {
      console.warn(`[cloud] ${runId.slice(0, 8)}: getRun failed at finalize — left running for the next reconcile pass (${e?.message ?? e})`);
      return "running";
    }
    if (!forceStatus && state.status === "running") return "running"; // not actually terminal yet

    let usage: CloudUsage | null = null;
    try {
      usage = await backend.usage(ref);
    } catch (e: any) {
      console.warn(`[cloud] ${runId.slice(0, 8)}: usage() failed at finalize — cost/tokens stay unset (${e?.message ?? e})`);
    }

    const prUrl = state.branches.find((b) => b.prUrl)?.prUrl ?? null;
    if (job.ticket_id && prUrl) {
      const t = tickets.get(job.ticket_id);
      if (t) tickets.update(t.id, prDeliveryPatch(t, prUrl));
    }

    const status: RunStatus = forceStatus ?? (state.status === "running" ? "failed" : CLOUD_STATUS_MAP[state.status]);

    runs.patch(runId, {
      summary: state.result,
      ...(usage
        ? {
            tokens_in: usage.tokens_in,
            tokens_out: usage.tokens_out,
            cache_read: usage.tokens_cache_read,
            cache_write: usage.tokens_cache_write,
            cost_usd: usage.cost_usd,
            cost_estimated: 0,
          }
        : {}),
    });

    // Gates need the agent's actual code in job.cwd — sync it in before finalizeRun runs them.
    if (status === "success" && job.ticket_id) {
      const branch = state.branches.find((b) => b.prUrl === prUrl)?.branch ?? state.branches[0]?.branch ?? null;
      if (branch) await syncWorktreeToCloudBranch(job.cwd, branch);
    }

    return await finalizeRun(job, runId, status, state.error, { exitCode: null });
  } finally {
    cloudFinalizing.delete(runId);
  }
}

// Steer a LIVE cloud run (`mc tell` / POST /runs/:id/steer): a new turn on the same provider agent
// (`backend.followup`), which mints a NEW provider run id — the old one stays in run_events, the new
// one becomes cloud_run_id, and the stream keeps tailing under it. Fire-and-forget from steerRun's
// point of view (that function's contract is a synchronous boolean); failures — including the
// documented `409 agent_busy` while a turn is in flight — are surfaced as a run event instead of
// silently dropping the message.
async function steerCloudRun(
  backend: CloudBackend,
  ref: CloudRef,
  runId: string,
  text: string,
  from: string,
  messageId?: number,
): Promise<void> {
  events.add(runId, "steer", { text, from });
  bus.publish({ topic: "run.event", run_id: runId, event: { type: "steer", text, from } });
  try {
    const launch = await backend.followup(ref, text);
    events.add(runId, "cloud_followup", { prior_run_id: ref.runId, new_run_id: launch.runId });
    runs.patch(runId, { cloud_run_id: launch.runId });
    if (messageId != null) messages.markDelivered([messageId], runId);
  } catch (e: any) {
    const busy = /409|agent_busy/i.test(String(e?.message ?? e));
    const msg = busy
      ? "cloud agent is busy with another turn — try again once it responds"
      : `cloud follow-up failed: ${e?.message ?? e}`;
    console.warn(`[cloud] ${runId.slice(0, 8)}: steer failed — ${msg}`);
    events.add(runId, "steer_failed", { text, from, error: msg });
    bus.publish({ topic: "run.event", run_id: runId, event: { type: "steer_failed", text, from, error: msg } });
  }
}

/**
 * Launch a cloud run, tail its stream until a terminal frame (or a disconnect), then finalize.
 *
 * Mirrors execute()'s contract (same Job/runId in, same RunStatus out) so dispatch()/pump() need no
 * changes at all — a "running" return on disconnect is a legitimate, inert RunStatus as far as the
 * dispatcher's retry/chain/fallback logic is concerned (it only acts on success/failed/timeout/
 * rate_limited), so the run simply stays `running` in the DB until the reconciler finishes it.
 */
export async function executeCloud(job: Job, runId: string, backend: CloudBackend): Promise<RunStatus> {
  // Synchronous prologue (gotcha #1's sibling): dispatch() returns while this call is still running,
  // so everything read off `runs`/`repos` here happens before the first await.
  const priorRun = runs.get(runId);
  const context = priorRun?.context ?? null;
  const ws = job.workspace_id ? workspaces.get(job.workspace_id) : undefined;
  const ctxRepoId = job.ticket_id ? tickets.get(job.ticket_id)?.repo_id ?? null : null;
  const buildRepo = ctxRepoId ? repos.get(ctxRepoId) : undefined;
  let addDirs: string[] = [];
  try {
    if (job.add_dirs) addDirs = JSON.parse(job.add_dirs);
  } catch {}
  const extraRepos = addDirs.length
    ? repos.list(ws?.id).filter((r) => r.id !== buildRepo?.id && addDirs.includes(r.path))
    : [];
  const cloudRepos = buildCloudRepos(buildRepo, extraRepos);

  const fail = (msg: string): RunStatus => {
    runs.patch(runId, { status: "failed", ended_at: new Date().toISOString(), error: msg });
    bus.publish({
      topic: "run.ended",
      run_id: runId,
      status: "failed",
      job_name: job.name ?? undefined,
      ticket_id: job.ticket_id ?? null,
      workspace_id: job.workspace_id ?? null,
    });
    return "failed";
  };

  if (!cloudRepos.length) return fail(`cloud backend needs a repo with a GitHub remote (job ${job.name})`);

  let launch: CloudLaunch;
  try {
    launch = await launchCloudWithRetry(backend, {
      job,
      runId,
      context,
      idempotencyKey: runId,
      repos: cloudRepos,
      autoCreatePr: true,
      name: job.name,
    });
  } catch (e: any) {
    return fail(`cloud launch failed: ${e?.message ?? e}`);
  }

  // Persist ids + status BEFORE anything else can fail — this is the row a sleeping Mac wakes up to.
  runs.patch(runId, {
    status: "running",
    cloud_agent_id: launch.agentId,
    cloud_run_id: launch.runId,
    cloud_url: launch.url,
    started_at: new Date().toISOString(),
  });
  bus.publish({ topic: "run.started", run_id: runId, job_id: job.id });

  const ref: CloudRef = { agentId: launch.agentId, runId: launch.runId, workspaceId: ws?.id ?? null };
  const streamResult = await streamCloudRun(backend, ref, runId, null);
  if (!streamResult.terminal) {
    // Disconnected, not finished — Mac slept, wifi dropped, whatever. Change NOTHING; the reconciler
    // resumes from cloud_last_event_id on its own clock.
    return runs.get(runId)?.status ?? "running";
  }
  return finalizeCloudRun(job, runId, backend, ref);
}

// Cloud path for steerRun below: a run with a live cloud_agent_id/cloud_run_id and a CloudBackend
// steers via backend.followup instead of the liveSteer stdin map (which cloud runs never register
// in — they have no child process). Kept as a helper so steerRun's own contract (synchronous
// boolean) doesn't change for its other callers (api.ts, messages.ts).
function tryCloudSteer(runId: string, text: string, from: string, messageId?: number): boolean {
  const run = runs.get(runId);
  if (!run || run.status !== "running" || !run.cloud_agent_id || !run.cloud_run_id) return false;
  const job = jobs.get(run.job_id);
  if (!job) return false;
  const backend = getBackend(job.backend);
  if (!isCloudBackend(backend)) return false;
  const ref: CloudRef = { agentId: run.cloud_agent_id, runId: run.cloud_run_id, workspaceId: job.workspace_id ?? null };
  void steerCloudRun(backend, ref, runId, text, from, messageId);
  return true;
}
