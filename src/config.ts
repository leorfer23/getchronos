import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
// Imports node builtins only — safe to pull in this early (no cycle back through config).
import { caKeyFile, leafKeyFile } from "./egress-ca.js";
import { inRepo } from "./repo-root.js";

const home = os.homedir();

/** The machine's timezone, so a fresh install schedules in the operator's day and not in UTC. */
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// Admin token gates workspace mutations (create/delete/repos) so sandboxed agents curling
// localhost can't spin up junk workspaces — only the native overlay, which reads this same file
// directly (it runs unsandboxed; see desktop/overlay.swift), may mutate workspaces. Persisted in a
// sandbox-denied file so agents can't read it, and NEVER served back over HTTP — not even to a
// loopback caller, since agents share the same loopback path as the overlay and could just curl it
// back out (that was PER-4; see src/static-html.ts).
function loadOrCreateAdminToken(): string {
  if (process.env.CHRONOS_ADMIN_TOKEN) return process.env.CHRONOS_ADMIN_TOKEN;
  const file = inRepo(".admin-token");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    const tok = randomUUID();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, tok, { mode: 0o600 });
      try { fs.chmodSync(file, 0o600); } catch {}
    } catch {}
    return tok;
  }
}

// Parse a "trivial=haiku,easy=sonnet,..." spec into a complexity→model map (build model auto-routing).
export function parseRouteModels(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of spec.split(",")) {
    const [k, v] = pair.split("=").map((s) => s.trim());
    if (k && v) out[k] = v;
  }
  return out;
}

/**
 * Parse "anthropic=10,anthropic:profile:.claude-atlas=25" into a percent floor per provider family
 * (or one exact credential scope). The quota gate (src/quota-gate.ts) is the only thing allowed to
 * turn a measured percentage into a refusal, and only against a floor the operator declared here —
 * an invented default floor would block dispatch on a proxy far too rough to justify it.
 */
export function parseQuotaFloors(spec: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const pair of (spec ?? "").split(",")) {
    const at = pair.lastIndexOf("=");
    if (at < 1) continue;
    const key = pair.slice(0, at).trim();
    const pct = Number(pair.slice(at + 1).trim());
    if (key && Number.isFinite(pct) && pct >= 0) out[key] = pct;
  }
  return out;
}

// Parse "at=atlas,cd=cedar" into alias → workspace slug (thread router tags/mentions).
export function parseAliases(spec: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (spec ?? "").split(/[,;]/)) {
    const at = pair.indexOf("=");
    if (at < 1) continue;
    const alias = pair.slice(0, at).trim();
    const slug = pair.slice(at + 1).trim();
    if (alias && slug) out[alias] = slug;
  }
  return out;
}

// Split a colon-separated path list from the environment. Tolerates empty/undefined and stray
// whitespace so a machine's .secrets can use a trailing `:` or wrap lines without silently
// injecting an empty string — an empty entry in a Seatbelt deny-list is a malformed rule.
export function splitPaths(spec: string | undefined): string[] {
  return (spec ?? "").split(":").map((s) => s.trim()).filter(Boolean);
}

// Parse "13,22" into sorted, de-duplicated local hours (0-23). Empty, "-1" or garbage → [] (off):
// a typo in .secrets must switch the slot off, never schedule it at a surprise hour.
export function parseHours(spec: string | undefined): number[] {
  const hours = (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  return [...new Set(hours.filter((h) => Number.isInteger(h) && h >= 0 && h <= 23))].sort((a, b) => a - b);
}

// Referenced twice below: as the actual DB path, and in the sandbox deny-list (PER-24) — the DB
// holds every workspace's API token (workspaces.token), so a sandboxed job reading it directly
// would bypass per-workspace scoping entirely, same as if it read the admin token file.
const dbPath = process.env.CHRONOS_DB ?? inRepo("chronos.db");

/**
 * Named CLI config directories, one per account or plan.
 *
 * `claude` (~/.claude) always exists. Anything else is found rather than declared: every
 * `~/.claude-<name>` directory becomes a profile of that name, which is how a second account —
 * a client's, a work one — becomes available to pin on a project without editing this file or
 * restarting into a config change. `CHRONOS_PROFILES` adds or overrides entries for directories
 * that do not follow the convention, as `name=/abs/path` pairs separated by `:`.
 *
 * Discovery is deliberately one level deep and $HOME-only. A profile directory holds a live login,
 * so pointing one at an arbitrary path is a decision the operator makes explicitly.
 */
function discoverProfiles(): Record<string, string> {
  const out: Record<string, string> = { claude: path.join(home, ".claude") };
  try {
    for (const name of fs.readdirSync(home)) {
      if (!name.startsWith(".claude-")) continue;
      const dir = path.join(home, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      out[name.slice(1)] = dir; // ".claude-acme" -> profile "claude-acme"
    }
  } catch {
    // No home, or unreadable: the default profile alone is enough to boot.
  }
  for (const pair of (process.env.CHRONOS_PROFILES ?? "").split(":")) {
    const at = pair.indexOf("=");
    if (at < 1) continue;
    out[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  return out;
}

export const CONFIG = {
  port: Number(process.env.CHRONOS_PORT ?? 7777),
  dbPath,
  adminToken: loadOrCreateAdminToken(),
  claudeBin: process.env.CHRONOS_CLAUDE_BIN ?? "claude",
  cursorBin: process.env.CHRONOS_CURSOR_BIN ?? "cursor-agent",
  codexBin: process.env.CHRONOS_CODEX_BIN ?? "codex",
  grokBin: process.env.CHRONOS_GROK_BIN ?? path.join(home, ".grok/bin/grok"), // absolute: daemon PATH may lack ~/.grok/bin
  opencodeBin: process.env.CHRONOS_OPENCODE_BIN ?? "opencode",
  gwsBin: process.env.CHRONOS_GWS_BIN ?? "gws",
  icalBin: process.env.CHRONOS_ICAL_BIN ?? "/opt/homebrew/bin/ical",
  maxConcurrent: Number(process.env.CHRONOS_MAX_CONCURRENT ?? 0), // 0 = unlimited; per-workspace max_concurrent (Spaces tab) is the real control
  // Max concurrent LIVE terminal sessions per workspace (fork-bomb guard for agent-spawned terminals).
  maxSessionsPerWorkspace: Number(process.env.CHRONOS_MAX_WS_SESSIONS ?? 6),
  // Scheduling priority every agent CLI (Desk pty + headless run) is spawned at, so the Desk webview
  // and the daemon outrank the fleet under oversubscription. Children (vitest, tsc, workerd) inherit
  // it. 0 = off. See src/machine.ts for the measurements this defends against.
  agentNice: Number(process.env.CHRONOS_AGENT_NICE ?? 10),
  // Machine governor (src/machine.ts): what "this Mac is full" means, and how many full test
  // suites/builds may run at once across every workspace (`mc heavy`).
  machine: {
    enabled: (process.env.CHRONOS_MACHINE_GOVERNOR ?? "1") !== "0" && process.env.CHRONOS_MACHINE_GOVERNOR !== "off",
    // 1-minute load average per core. 2.5 = heavily oversubscribed but still responsive; past it a
    // new agent CLI buys nothing but more context switching.
    maxLoadPerCore: Number(process.env.CHRONOS_MAX_LOAD_PER_CORE ?? 2.5),
    // Swap-in-use %, but only ever as a SECOND opinion on top of macOS's memory-pressure level:
    // the swapfile is dynamically sized and never eagerly paged back in, so a calm Mac commonly
    // sits above this number with pressure "normal". See admission() in src/machine.ts.
    maxSwapUsedPct: Number(process.env.CHRONOS_MAX_SWAP_USED_PCT ?? 90),
    // Machine-wide heavy slots. One suite per ~6 cores: a vitest pool alone forks that many workers.
    heavySlots: Number(process.env.CHRONOS_HEAVY_SLOTS ?? Math.max(1, Math.floor((os.cpus().length || 1) / 6))),
  },
  // Auto-sync external ticket connectors (clickup/jira) every N minutes (0 = off).
  connectorSyncMin: Number(process.env.CHRONOS_CONNECTOR_SYNC_MIN ?? 30),
  // Auto-register git checkouts found in a workspace's default_dir every N minutes (0 = off).
  // Daily, not every few minutes: this sweep only has something to find when a repo is CLONED, which
  // happens a handful of times a month. startRepoScan also ticks once at boot, so a fresh clone is
  // picked up by the next daemon restart without waiting out the interval.
  repoScanMin: Number(process.env.CHRONOS_REPO_SCAN_MIN ?? 1440),
  // Write-back card (src/writeback.ts): on for every connector-linked workspace by default — a
  // ticket reaching 'done' composes a comment+close proposal and asks via Telegram/board. The push
  // itself is ALWAYS a human tap (src/connectors/index.ts's write-back functions are explicit-only,
  // non-negotiable); this only gates whether the card is offered at all. CHRONOS_WRITEBACK_CARD=off disables.
  writebackCard: process.env.CHRONOS_WRITEBACK_CARD !== "off",
  // Durable activity trail: keep at most this many bus-event rows (pruned on insert).
  activityRetain: Number(process.env.CHRONOS_ACTIVITY_RETAIN ?? 20000),
  // run_events: one row per streamed message per run — far higher volume than activity, so it's
  // pruned periodically from the monitor sweep (see CONFIG.retentionSweepMin) rather than per-insert.
  runEventsRetain: Number(process.env.CHRONOS_RUN_EVENTS_RETAIN ?? 300000),
  // Cadence (minutes) for the retention sweep: run_events cap, orphaned search_fts 'event' rows,
  // egress_log cap. Independent of digestHour so it still runs with the nightly digest disabled.
  retentionSweepMin: Number(process.env.CHRONOS_RETENTION_SWEEP_MIN ?? 60),
  // Connector sync history: keep at most this many rows.
  connectorSyncRetain: Number(process.env.CHRONOS_CONNECTOR_SYNC_RETAIN ?? 2000),
  dailyBudgetUsd: Number(process.env.CHRONOS_DAILY_BUDGET ?? 0), // 0 = no global cap; per-workspace daily_budget_usd (Spaces tab) is the control
  // Auto-memory: on session end, distill durable learnings into the workspace's learnings memo (0/false = off).
  autoMemory: (process.env.CHRONOS_AUTO_MEMORY ?? "1") !== "0",
  // Worklog (src/worklog.ts): every finished terminal/run is summarized into the workspace's
  // `worklog` ledger and Robert's brief. 0/false = off (nothing is written, nothing is summarized).
  worklog: (process.env.CHRONOS_WORKLOG ?? "1") !== "0",
  // How many "## Recently" lines a brief keeps. Older ones roll off — the ledger still has them.
  briefRecentlyMax: Number(process.env.CHRONOS_BRIEF_RECENTLY_MAX ?? 12),
  // Model for the worklog summarizer. Empty = the workspace's review model, else the backend's
  // cheapest (haiku) — same routing every other one-shot helper uses.
  worklogModel: process.env.CHRONOS_WORKLOG_MODEL ?? "",
  // A terminal shorter than this that produced nothing is a mistyped command, not a piece of work.
  worklogMinSessionSec: Number(process.env.CHRONOS_WORKLOG_MIN_SESSION_SEC ?? 120),
  // Slack triage: cron + cheap model for the per-workspace read-only DM/@mention → ticket agent.
  // Business-hours gating: every 30m, Mon-Fri 10:00-18:30 in slackTriageTz (no nights/weekends).
  slackTriageCron: process.env.CHRONOS_SLACK_TRIAGE_CRON ?? "*/30 10-18 * * 1-5",
  // The machine's zone, not a literal: "business hours" means the operator's, and a committed
  // timezone is just the author's. Override per deployment with CHRONOS_SLACK_TRIAGE_TZ.
  slackTriageTz: process.env.CHRONOS_SLACK_TRIAGE_TZ ?? LOCAL_TZ,
  slackTriageModel: process.env.CHRONOS_SLACK_TRIAGE_MODEL ?? "haiku",
  // Observability sweep cadence + thresholds.
  monitorEveryMin: Number(process.env.CHRONOS_MONITOR_MIN ?? 5),
  stuckRunHours: Number(process.env.CHRONOS_STUCK_RUN_HRS ?? 2),   // a 'running' run older than this = stuck
  // Stall detector: a 'running' run whose event stream has gone quiet this many minutes gets one
  // Telegram + board notice (lifecycle overlay 'blocked'/'stall') — never repeated for the same run,
  // no auto-kill/retry (src/recovery.ts's header comment: the operator decides). 0 = detector off.
  // 15 (was 10): a long quiet tool call — e.g. a 12-min test suite that emits no stream events —
  // false-positived at 10. Bump via CHRONOS_STALL_MINUTES if a slower toolchain still trips it.
  stallMinutes: Number(process.env.CHRONOS_STALL_MINUTES ?? 15),
  // Quiet alone never escalates (src/liveness.ts): the sweep looks for positive liveness evidence
  // first — run events/steps, pty output, then writes under the run's own checkout — and defers
  // silently when it finds any. These three knobs govern what happens when it finds none.
  // Consecutive evidence-free checks before the run is marked demand_inspection ("needs a look").
  stallInspectCount: Number(process.env.CHRONOS_STALL_INSPECT_COUNT ?? 3),
  // A declared wait (open ask, operator-held ticket) is never a wedge — it is re-surfaced at most
  // once per this many minutes, naming what it waits on. Deliberately long: 4h, not 15m.
  pauseResurfaceMinutes: Number(process.env.CHRONOS_PAUSE_RESURFACE_MIN ?? 240),
  // Bounds on the worktree-write probe. Taken ONLY in the branch about to escalate, never per sweep;
  // it runs on the daemon's event loop, so a repo on a hung mount must not stall the tick. A pruned,
  // timed-out or failed walk reads as "no evidence", never as "alive".
  stallWalk: {
    prune: (process.env.CHRONOS_STALL_WALK_PRUNE ?? "node_modules .git dist build .next target vendor")
      .split(/[\s,]+/)
      .filter(Boolean),
    maxDepth: Number(process.env.CHRONOS_STALL_WALK_MAXDEPTH ?? 6),
    timeoutMs: Number(process.env.CHRONOS_STALL_WALK_TIMEOUT_MS ?? 2000),
  },
  // Ask reminders: re-notify (Telegram) once per this many hours while an
  // ask sits open and unanswered — the creation card only fires once otherwise. 0 = off.
  askRemindHours: Number(process.env.CHRONOS_ASK_REMIND_HOURS ?? 2),
  // "Later" holds (src/holds.ts): an undated hold has no resurface date, so nothing would ever bring
  // it back. After this many hours it reads `aged` — off the live "needs you" list still, but carrying
  // a once-a-day nudge line. Presentation safety net only; the durable mechanism is the date.
  holdAgedHours: Number(process.env.CHRONOS_HOLD_AGED_HOURS ?? 72),
  stuckSessionHours: Number(process.env.CHRONOS_STUCK_SESSION_HRS ?? 8), // a live terminal older than this = likely abandoned
  digestHour: Number(process.env.CHRONOS_DIGEST_HOUR ?? 8),        // local hour for the daily Telegram digest (-1 = off)
  // Dream slots: local hours when memory maintenance runs (hygiene now; per-workspace dream pass
  // later — src/dream.ts). Independent of digestHour on purpose: turning the morning message off
  // silently killed memory hygiene for weeks. A slot missed while the Mac slept runs on wake.
  dreamHours: parseHours(process.env.CHRONOS_DREAM_HOURS ?? "13,22"),
  // Recovery supervisor: work that stopped without finishing. NOTHING here re-dispatches on its own —
  // every stall becomes an approve/decline card (see recovery.ts). 0 min = supervisor off.
  recoverSweepMin: Number(process.env.CHRONOS_RECOVER_SWEEP_MIN ?? 30),
  recoverWindowHours: Number(process.env.CHRONOS_RECOVER_WINDOW_HRS ?? 24), // older interrupted runs are history, not a decision
  stallTicketHours: Number(process.env.CHRONOS_STALL_TICKET_HRS ?? 24),     // in_progress with no live run for this long = stalled
  recoverMaxAsk: Number(process.env.CHRONOS_RECOVER_MAX_ASK ?? 3),          // cards per sweep, so a bad night can't flood the chat
  // PR delivery-state poll: how often (min) to check open delivery=pr PRs for merge/close (0 = off).
  deliveryPollMin: Number(process.env.CHRONOS_DELIVERY_POLL_MIN ?? 15),
  // Fast CI poll: while any delivery=pr PR is open, re-check every N sec for near-real-time CI (0 = off).
  ciPollSec: Number(process.env.CHRONOS_CI_POLL_SEC ?? 25),
  // Auto-merge a Chronos-shipped PR the moment its CI goes green (no manual merge click). 0 = off.
  autoMerge: process.env.CHRONOS_AUTO_MERGE !== "0",
  // Auto-dispatch a fix terminal on the PR branch when CI fails; cap re-tries per ticket per process.
  autoCiFix: process.env.CHRONOS_AUTO_CI_FIX !== "0",
  ciFixMaxAttempts: Number(process.env.CHRONOS_CI_FIX_MAX ?? 2),
  // Merge gate: how many times the gate agent may push a fix to a PR before it stops and asks for a
  // human. The gate both fixes and merges, so it has no independent check on its own work — the cap
  // is what stops a wrong fix from being re-justified forever. Each attempt is a FRESH agent run
  // (no shared reasoning), so a real problem tends to be re-flagged rather than rationalised away.
  mergeGateMaxFixes: Number(process.env.CHRONOS_MERGE_GATE_MAX_FIXES ?? 2),
  // Model for the gate. It is the last thing between an agent's work and main, so it defaults to a
  // strong-enough model rather than the cheapest one.
  mergeGateModel: process.env.CHRONOS_MERGE_GATE_MODEL ?? "sonnet",
  // Self-deploy (src/self-deploy.ts): merging a Chronos PR must end with the daemon running that
  // commit, without a human. Off inside the test suite — the deploy chain restarts the daemon.
  selfDeploy: {
    enabled: (process.env.CHRONOS_SELF_DEPLOY ?? "1") !== "0" && process.env.CHRONOS_TEST !== "1",
    pollSec: Number(process.env.CHRONOS_SELF_DEPLOY_POLL_SEC ?? 60),
    // How long a pending deploy waits on a busy fleet before escalating to the operator. It NEVER
    // stops waiting: restarting on live runs is what makes the naive post_merge_cmd fix unsafe.
    idleWaitMin: Number(process.env.CHRONOS_SELF_DEPLOY_WAIT_MIN ?? 90),
    retryMin: Number(process.env.CHRONOS_SELF_DEPLOY_RETRY_MIN ?? 30), // backoff after a failed round
    maxAttempts: Number(process.env.CHRONOS_SELF_DEPLOY_MAX_ATTEMPTS ?? 3), // then wait for a human/next merge
    testTimeoutMin: Number(process.env.CHRONOS_SELF_DEPLOY_TEST_MIN ?? 20),
    driftCheckMin: Number(process.env.CHRONOS_DRIFT_CHECK_MIN ?? 30), // running-commit vs origin/<branch>
    launchdLabel: process.env.CHRONOS_LAUNCHD_LABEL ?? "sh.chronos.daemon",
  },
  // Nightly DB backup: keep this many chronos-YYYY-MM-DD.db files under ~/chronos/backups (runs at digestHour).
  backupRetain: Number(process.env.CHRONOS_BACKUP_RETAIN ?? 7),
  // Hourly DB backup: keep this many chronos-YYYYMMDD-HH.db files under ~/chronos/backups/hourly (always on).
  hourlyBackupRetain: Number(process.env.CHRONOS_HOURLY_BACKUP_RETAIN ?? 48),
  // Log rotation: launchd's StandardOut/ErrorPath files (chronos.*.log, calsync.*.log, whisper.*.log)
  // never rotate on their own. Truncated in place once over maxBytes (keeps the daemon's open append
  // fd valid — same trick as logrotate's copytruncate), gzipped copies kept up to `retain`.
  logRotate: {
    maxBytes: Number(process.env.CHRONOS_LOG_ROTATE_MAX_MB ?? 20) * 1024 * 1024,
    retain: Number(process.env.CHRONOS_LOG_ROTATE_RETAIN ?? 3),
  },
  // Optional external heartbeat (e.g. healthchecks.io) — GET this URL every heartbeatMin minutes. Empty = off.
  heartbeatUrl: process.env.CHRONOS_HEARTBEAT_URL ?? "",
  heartbeatMin: Number(process.env.CHRONOS_HEARTBEAT_MIN ?? 5),
  // Fleet heartbeat (OpenClaw-style): every N minutes during active hours, a cheap haiku GATE decides
  // whether to wake the executive (Robert — the only one, while Robert is the only executive). On WAKE, the warm sonnet/opus agent
  // executes and posts to the board (+ Flow/Telegram for Robert). Silence tokens: NOOP / HEARTBEAT_OK.
  // Cron fires often; activeStart/activeEnd (local) are the real window. "0" disables entirely.
  dayHeartbeat: {
    enabled: (process.env.CHRONOS_DAY_HEARTBEAT ?? "1") !== "0",
    cron: process.env.CHRONOS_DAY_HEARTBEAT_CRON ?? "*/30 * * * *",
    tz: process.env.CHRONOS_DAY_HEARTBEAT_TZ ?? "", // empty = daemon local time
    activeStart: process.env.CHRONOS_DAY_HEARTBEAT_START ?? "09:00",
    activeEnd: process.env.CHRONOS_DAY_HEARTBEAT_END ?? "20:00",
    gateModel: process.env.CHRONOS_DAY_HEARTBEAT_GATE_MODEL ?? "haiku",
    /** Skip an agent if the operator talked to them within this many minutes (avoid nagging). */
    recentTurnSkipMin: Number(process.env.CHRONOS_DAY_HEARTBEAT_RECENT_MIN ?? 12),
    /**
     * When true, skip haiku if the agent's digest fingerprint is unchanged (cheaper, quieter).
     * Default true — changed fleet state still gets a gate chance; unchanged hourly ticks do not
     * pay for the same decision again. Set 0 to restore proactive re-evaluation every tick.
     */
    digestSkip: (process.env.CHRONOS_DAY_HEARTBEAT_DIGEST_SKIP ?? "1") === "1",
    /**
     * Mirror Robert's hourly WAKE briefs to Telegram too (bookends always mirror). On = the phone
     * hears the shop: stalled tickets, proposals, blocked agents — without opening the app.
     */
    telegramMirror: (process.env.CHRONOS_DAY_HEARTBEAT_TG ?? "1") !== "0",
  },
  // Personal heartbeat: a short-cadence loop for a personal-assistant executive. OFF by default and
  // currently unwired — the driver in src/heartbeat.ts was removed with the agent that owned it,
  // because every step named that agent. The knobs survive so a cadence and window you tune are not
  // lost. Setting CHRONOS_PERSONAL_HEARTBEAT=1 does nothing on its own: nothing reads `enabled`
  // until something calls runAgentHeartbeat with an owner.
  personalHeartbeat: {
    enabled: (process.env.CHRONOS_PERSONAL_HEARTBEAT ?? "0") !== "0",
    cron: process.env.CHRONOS_PERSONAL_HEARTBEAT_CRON ?? "*/5 * * * *",
    activeStart: process.env.CHRONOS_PERSONAL_HEARTBEAT_START ?? "08:30",
    activeEnd: process.env.CHRONOS_PERSONAL_HEARTBEAT_END ?? "22:00",
  },
  // Mail sweep: read the last window's UNREAD Gmail and speak ONLY when something needs the operator.
  // OFF by default and unowned: it needs an executive with a Gmail MCP configured, and Robert has
  // none. The fleet cron no longer calls it; the logic in src/heartbeat.ts is kept and takes an
  // injected askFn/deliverFn. Turning this back on without giving runMailSweep an owner throws by
  // design rather than sweeping silently.
  mailSweep: {
    enabled: (process.env.CHRONOS_MAIL_SWEEP ?? "0") !== "0",
    everyMin: Number(process.env.CHRONOS_MAIL_SWEEP_MIN ?? 60),
  },
  // Daily standup: Robert researches each project's real trail (PRs, tracker tickets, commits, agent
  // runs) and posts a paste-ready standup on the board. Separate cron from the fleet heartbeat
  // because it is pinned to the time you actually stand up, not to the active-hours window.
  standup: {
    enabled: (process.env.CHRONOS_STANDUP ?? "1") !== "0",
    cron: process.env.CHRONOS_STANDUP_CRON ?? "0 10 * * *",
    tz: process.env.CHRONOS_STANDUP_TZ ?? LOCAL_TZ,
    /**
     * Project slugs that get a standup. Empty by default: a standup only makes sense for a project
     * you report on to someone, and guessing which of yours those are would post noise on the rest.
     */
    workspaces: (process.env.CHRONOS_STANDUP_WORKSPACES ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },
  // Auto-plan worker: read-only planning agents auto-dispatched on backlog tickets (per opt-in workspace).
  autoPlanEveryMin: Number(process.env.CHRONOS_AUTOPLAN_MIN ?? 5), // sweep cadence (0 = off)
  planConcurrencyPerWs: Number(process.env.CHRONOS_PLAN_CONCURRENCY ?? 1), // max simultaneous planning agents per workspace
  planRetryCooldownMin: Number(process.env.CHRONOS_PLAN_COOLDOWN_MIN ?? 120), // don't re-plan a failed ticket for this long
  buildConcurrencyPerWs: Number(process.env.CHRONOS_BUILD_CONCURRENCY ?? 1), // max simultaneous build agents per workspace (auto_build)
  // AI reviewer (auto_review): QA each finished build; bounded auto-rework so it can't loop forever.
  reviewMaxIterations: Number(process.env.CHRONOS_REVIEW_MAX_ITER ?? 3), // build↔review cycles before escalating to a human (backstop; gate reworks count here)
  // One-pass review policy: reviewer-driven reworks an AI verdict may trigger per ticket. Past this
  // a "changes" verdict ships via the approve lane and the objections become a follow-up ticket
  // (reviews.ts aiRequestChanges) — reviewers flip-flopping a tradeoff must not buy extra cycles.
  reviewMaxReworks: Number(process.env.CHRONOS_REVIEW_MAX_REWORKS ?? 1),
  reviewConcurrencyPerWs: Number(process.env.CHRONOS_REVIEW_CONCURRENCY ?? 2),
  // Last-resort loop guard (dispatcher.ts): runs one job NAME may start in an hour before every
  // trigger source is refused. Catches any re-trigger cycle — review→fallback→review, a chain, a
  // feeder — not just the one that has already happened. 0 disables.
  runsPerJobHourCap: Number(process.env.CHRONOS_RUNS_PER_JOB_HOUR ?? 12),
  // Global burn velocity brake (burn-guard.ts) — the fleet-wide backstop the per-job cap can't be.
  // Trailing-hour thresholds, sized off real history: the busiest legitimate hour in a month was 37
  // runs / $35, and the 2026-07-30 loop hour was 101 runs (at $0.00 reported — hence the run count).
  // 0 disables any individual threshold; burnSampleMin 0 disables the guard entirely.
  burnSampleMin: Number(process.env.CHRONOS_BURN_SAMPLE_MIN ?? 2),
  burnAlertRunsPerHour: Number(process.env.CHRONOS_BURN_ALERT_RUNS ?? 60),
  burnHaltRunsPerHour: Number(process.env.CHRONOS_BURN_HALT_RUNS ?? 100),
  burnAlertUsdPerHour: Number(process.env.CHRONOS_BURN_ALERT_USD ?? 40),
  burnHaltUsdPerHour: Number(process.env.CHRONOS_BURN_HALT_USD ?? 60),
  // Per-gate wall clock. Generous: a repo's real test suite is the point, and a hung command is
  // caught by the timeout rather than by never delivering.
  gateTimeoutSec: Number(process.env.CHRONOS_GATE_TIMEOUT_SEC ?? 900),
  // Lessons: feedback distilled into durable rules and injected back into agents (src/lessons.ts).
  // Panels (src/panels.ts): more than one agent on the work that deserves it.
  panelMinDifficulty: Number(process.env.CHRONOS_PANEL_MIN_DIFFICULTY ?? 4), // scout panel at this graded difficulty and above
  reviewPanelQuorum: Number(process.env.CHRONOS_REVIEW_PANEL_QUORUM ?? 2), // approving lenses needed to pass a high-risk change
  // Chief-of-staff intake sweep (src/intake.ts): reads signals outside the repo and drafts specced work.
  intakeModel: process.env.CHRONOS_INTAKE_MODEL ?? "sonnet", // needs judgment about what IS work; not a haiku job
  // "No is no" (src/ideas.ts createIdea): a killed idea blocks its zombie twin (same source_ref or
  // title) forever — killing it was a decision. An expired idea (the operator just never got to it)
  // only blocks for this many days: silence isn't a "no", but it isn't "ask again next week" either.
  ideaExpiredCooldownDays: Number(process.env.CHRONOS_IDEA_EXPIRED_COOLDOWN_DAYS ?? 30),
  // Persona memory (src/memory-budget.ts, src/stow.ts): the always-injected memory file has a token
  // ceiling, so growth becomes a decision the stow pass makes instead of a tax nobody notices.
  // Per-agent override: `memory_budget` in agents/<id>/AGENT.md.
  memoryBudgetTokens: Number(process.env.CHRONOS_MEMORY_BUDGET_TOKENS ?? 4000),
  // Opt-in second horizon: count stow passes that evaluated an entry without reinforcing it, so a
  // daemon that stows daily is not judging everything against a 30-day clock it never reaches.
  stowPassHorizon: process.env.CHRONOS_STOW_PASS_HORIZON === "1",
  lessonDedupeSimilarity: Number(process.env.CHRONOS_LESSON_DEDUPE ?? 0.55), // token overlap that counts as "the same complaint again"
  lessonPromoteAfter: Number(process.env.CHRONOS_LESSON_PROMOTE_AFTER ?? 2), // times a reviewer rule must recur before it binds everyone
  lessonProposedTtlDays: Number(process.env.CHRONOS_LESSON_PROPOSED_TTL_DAYS ?? 60), // a proposal nobody saw twice
  lessonIdleTtlDays: Number(process.env.CHRONOS_LESSON_IDLE_TTL_DAYS ?? 120), // an active rule that stopped matching any work
  // Audit a newly captured fact against the ones it might contradict (src/memory-conflicts.ts).
  // One helper call per capture that has candidates, and none when nothing looks comparable.
  // Off under CHRONOS_TEST so the suite never shells out to a model.
  memoryConflictChecks:
    process.env.CHRONOS_MEMORY_CONFLICTS === "1" ||
    (process.env.CHRONOS_MEMORY_CONFLICTS !== "0" && !process.env.CHRONOS_TEST),
  defaultTimeoutSec: Number(process.env.CHRONOS_TIMEOUT ?? 3600),
  // Auto-resume a run that hit a rate-limit/credit wall, once access resets — but only if the wait
  // is within this many hours (0 disables). Avoids burning retries on a wall the job can't pass.
  resumeAfterRateLimitMaxHours: Number(process.env.CHRONOS_RESUME_RL_MAX_HOURS ?? 6),
  // Default model when a job doesn't pick one. Sonnet ≈ 5× cheaper than Opus for similar tasks;
  // jobs can still set model:"opus" for heavy work. Desk terminals also fall back here (then to the
  // workspace default_model) so interactive spend is not profile-null / unknown.
  defaultModel: process.env.CHRONOS_DEFAULT_MODEL ?? "sonnet",
  // Shell-output compression via RTK (rtk-ai/rtk). PreToolUse rewrite for Claude/Grok Bash tools.
  // Off with CHRONOS_RTK=0. Soft no-op when `rtk` is not on PATH.
  rtkEnabled: process.env.CHRONOS_RTK !== "0",
  // Fast repo search MCP (dmtrKovalenko/fff). Written into each Claude profile's .claude.json.
  // Off with CHRONOS_FFF=0. Soft no-op when fff-mcp is not installed.
  fffEnabled: process.env.CHRONOS_FFF !== "0",
  // Daemon-wide verifier policy for `verify` jobs; a workspace's verify_mode overrides it.
  // shadow = record only; enforce = met:false blocks, inconclusive doesn't (fail-open);
  // strict = fail-closed. See verifier.ts.
  verifyMode: process.env.CHRONOS_VERIFY_MODE ?? "enforce",
  // Build model auto-routing: map a plan-graded difficulty 1-5 → claude-code model (global fallback when a
  // workspace has no route_config). Legacy trivial/easy/medium/hard keys still parse. Owner's delegation rule.
  routeModels: parseRouteModels(process.env.CHRONOS_ROUTE_MODELS ?? "1=haiku,2=haiku,3=sonnet,4=opus,5=opus,trivial=haiku,easy=sonnet,medium=opus,hard=opus"),
  // Second-pass grader: a strong model reviews the explorer's brief + grades difficulty 1-5. Read-only.
  // Live defaults — the previous kimi-k3/opencode pair died when the Vercel gateway model was
  // withdrawn (PER-22). Env still wins; when unset, dispatchGradeRaw prefers the workspace's
  // route_config tier-4 before falling back here.
  graderBackend: process.env.CHRONOS_GRADER_BACKEND ?? "claude-code",
  graderModel: process.env.CHRONOS_GRADER_MODEL ?? "sonnet",
  // Quota/runway gate (src/quota-gate.ts): "can this backend actually FINISH this job?", asked before
  // the spawn. `warn` (the default, and what the first deploy runs) records the verdict on the run and
  // never blocks; `enforce` parks a run no candidate can serve; `off` skips the gate entirely.
  quotaGate: (process.env.CHRONOS_QUOTA_GATE ?? "warn") as "off" | "warn" | "enforce",
  // Token ceiling for the rolling ~5h subscription window. 0 = unknown, and unknown STAYS unknown —
  // the gate reports null headroom rather than inventing either a healthy or an empty window.
  quotaTokens5h: Number(process.env.CHRONOS_QUOTA_TOKENS_5H ?? 0),
  // Fallback completion horizon when a workspace has no finished runs at this difficulty to median.
  quotaHorizonSec: Number(process.env.CHRONOS_QUOTA_HORIZON_SEC ?? 1800),
  // Operator-declared percent floors — see parseQuotaFloors. Empty = no floor, which is the default.
  quotaFloors: parseQuotaFloors(process.env.CHRONOS_QUOTA_FLOOR),
  // Gate verdicts kept in memory for GET /api/quota and `mc quota`.
  quotaDecisionsKept: Number(process.env.CHRONOS_QUOTA_DECISIONS ?? 20),
  // Default profile/account for new jobs, used only when the project does not pin one. A project
  // that belongs to a client should pin its own via `workspaces.config_dir` — that is what keeps
  // one client's work off another's account. See `profiles` at the bottom of this file.
  defaultProfile: process.env.CHRONOS_DEFAULT_PROFILE ?? "claude",
  desktopNotify: process.env.CHRONOS_DESKTOP_NOTIFY !== "0",
  // Web Push to the phone (src/push.ts). Off in tests; CHRONOS_PUSH=0 turns it off in the daemon.
  push: process.env.CHRONOS_PUSH !== "0" && process.env.CHRONOS_TEST !== "1",
  // Robert answers a review/blocked event with the call he'd make. Off → those events stay mirrored
  // lines nobody owns (the behaviour before this switch existed).
  robertWake: process.env.CHRONOS_ROBERT_WAKE !== "0",
  // Robert is woken when a Desk terminal STOPS — turn finished, goal done, decide, declared blocked or
  // waiting on him (src/robert-drive.ts). 0 → those terminals wait for the operator, as before.
  robertDrive: {
    enabled: process.env.CHRONOS_ROBERT_DRIVE !== "0",
    graceSec: Number(process.env.CHRONOS_ROBERT_DRIVE_GRACE_SEC ?? 90),
    perSessionHour: Math.max(1, Number(process.env.CHRONOS_ROBERT_DRIVE_PER_TERMINAL_HOUR ?? 4)),
    globalHour: Math.max(1, Number(process.env.CHRONOS_ROBERT_DRIVE_PER_HOUR ?? 30)),
    maxAgeHours: Number(process.env.CHRONOS_ROBERT_DRIVE_MAX_AGE_H ?? 12),
  },
  // A Lead's own wake budget (LEADS.md), deliberately NOT Robert's. A Lead steering six workers
  // legitimately hears from them an order of magnitude more often than Robert hears from the whole
  // wall, and sharing one budget meant either Robert's cap throttled the Leads or the Leads burned
  // Robert's. Over the cap a stop is escalated to Robert rather than dropped — nothing goes quiet.
  leadDrive: {
    perWorkerHour: Math.max(1, Number(process.env.CHRONOS_LEAD_DRIVE_PER_WORKER_HOUR ?? 20)),
    perLeadHour: Math.max(1, Number(process.env.CHRONOS_LEAD_DRIVE_PER_LEAD_HOUR ?? 120)),
    // A Lead that is not pulling its inbox gets ONE typed digest per burst, not a keystroke per
    // worker: wait this long after the first unseen event for its siblings to land…
    digestDebounceSec: Math.max(0, Number(process.env.CHRONOS_LEAD_DIGEST_DEBOUNCE_SEC ?? 5)),
    // …and never hold the oldest one longer than this, however long the stops keep trickling in.
    digestMaxWaitSec: Math.max(0, Number(process.env.CHRONOS_LEAD_DIGEST_MAX_WAIT_SEC ?? 20)),
    // A worker of a live Lead reaches it far sooner than Robert's 90s grace, which was tuned for "the
    // operator answers in ten seconds and Robert never needs to know". For a Lead sitting in
    // `mc lead wait` that grace is 90 seconds of dead air per worker turn. Caps robertDrive's grace,
    // never raises it — the operator-owns rule still applies on top (robert-drive.ts armTimer).
    graceSec: Math.max(0, Number(process.env.CHRONOS_LEAD_DRIVE_GRACE_SEC ?? 15)),
    // How long a question routed to a Lead (`mc ask-lead`) may sit with it before it becomes Robert's
    // anyway — the same safety net CHRONOS_ASK_TRIAGE_MIN is for Robert. The worker is BLOCKED on it.
    askFallbackMin: Math.max(0, Number(process.env.CHRONOS_LEAD_ASK_FALLBACK_MIN ?? 10)),
    // Live workers stamped with this Lead's id count against THIS cap, not maxSessionsPerWorkspace.
    // The Lead itself still occupies a workspace seat. Machine admission (admissionNow) still applies.
    maxWorkers: Math.max(1, Number(process.env.CHRONOS_LEAD_MAX_WORKERS ?? 10)),
  },
  // Robert is woken when a Desk terminal STOPS on a question (src/terminal-prompts.ts) and answers it
  // with the same primitive as the Desk's tap. 0 → a 🟠 prompt waits for the operator, as before.
  terminalPrompts: process.env.CHRONOS_TERMINAL_PROMPTS !== "0",
  // Seconds after his keystrokes before the daemon checks the terminal actually moved off that
  // prompt. Still there → one re-wake ("your answer didn't land"), then the operator's card.
  terminalPromptConfirmSec: Number(process.env.CHRONOS_TERMINAL_PROMPT_CONFIRM_SEC ?? 90),
  // Minutes a prompt may sit with him before the operator gets it with the options as buttons. The
  // terminal is blocked the whole time, so this is deliberately short.
  terminalPromptDeadlineMin: Number(process.env.CHRONOS_TERMINAL_PROMPT_DEADLINE_MIN ?? 8),
  // A Desk terminal that stops on a credit/usage wall (src/terminal-failover.ts): first the same
  // terminal on agent.modelFallback, then a new terminal on the next backend here. off → it waits.
  terminalFailover: !/^(off|0|false|no)$/i.test(process.env.CHRONOS_TERMINAL_FAILOVER ?? "on"),
  // Tried in order after workspace.fallback_backend. Names not registered or not installed are skipped.
  terminalFallbackBackends: (process.env.CHRONOS_TERMINAL_FALLBACK_BACKENDS ?? "grok,cursor")
    .split(",").map((s) => s.trim()).filter(Boolean),
  // Failover steps per lineage (the original terminal and every stand-in opened for it).
  terminalFailoverMax: Math.max(1, Number(process.env.CHRONOS_TERMINAL_FAILOVER_MAX ?? 3)),
  // Someone typed into it this recently → it is theirs; hold off and look again after the window.
  terminalFailoverTypingSec: Math.max(1, Number(process.env.CHRONOS_TERMINAL_FAILOVER_TYPING_SEC ?? 20)),
  // Minutes before a timed calendar event to fire a Mac + Telegram reminder (0 = off).
  reminderLeadMin: Number(process.env.CHRONOS_REMINDER_LEAD ?? 10),
  // Calendar noise filters (case-insensitive substring match). Hidden from agenda + reminders.
  // Yours are personal: the recurring blocks that are not really meetings. Set them in .secrets.
  calIgnoreTitles: (process.env.CHRONOS_CAL_IGNORE_TITLES?.split(",") ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean),
  calIgnoreCals: (process.env.CHRONOS_CAL_IGNORE_CALS?.split(",") ?? ["holidays", "birthdays"]).map((s) => s.trim().toLowerCase()).filter(Boolean),
  sandbox: {
    // Default mode for new jobs: off | guard | strict.
    defaultMode: (process.env.CHRONOS_SANDBOX_DEFAULT ?? "guard") as "off" | "guard" | "strict",
    // Absolute deny (read+write) even inside a job's cwd — secrets & credential stores.
    // The list below is the portable baseline (every entry is $HOME-relative). Machine-specific
    // paths — where THIS Mac keeps its project checkouts — belong in
    // `CHRONOS_PROTECTED_SECRETS_EXTRA`, appended below, so a second machine can protect its own
    // layout without editing (and then having to merge) this file. `CHRONOS_PROTECTED_SECRETS`
    // still replaces the whole baseline for the rare case that's what you want.
    secrets: [...(process.env.CHRONOS_PROTECTED_SECRETS
      ? process.env.CHRONOS_PROTECTED_SECRETS.split(":")
      : [
          `${home}/.ssh`,
          `${home}/.aws`,
          `${home}/.config/gcloud`,
          // gws (Google Workspace CLI) OAuth client + token cache. ponytail: file-level deny only —
          // gws stores its refresh token in the login keychain (see the Keychains note below), so
          // `gws auth export` still works from a guard-mode Bash. Closing that needs a command-level
          // deny, which Seatbelt can't express; upgrade path is a Claude Code PreToolUse hook.
          `${home}/.config/gws`,
          `${home}/.kube`,
          inRepo(".admin-token"),
          // Broker credentials (src/broker.ts) — the whole point is that sandboxed agents can
          // SPEND these via POST /api/broker/:slug but never READ them. Resolved, not hardcoded:
          // an operator who sets CHRONOS_BROKER_FILE would otherwise move the creds OUT of the
          // deny list and make them readable from inside the sandbox.
          process.env.CHRONOS_BROKER_FILE || inRepo(".broker.json"),
          // Egress broker CA private keys (src/egress-ca.ts). The cert + bundle sitting next to them
          // are meant to be READ — that is how a child trusts the proxy — but these two keys are
          // what mint a trusted certificate for any host, so they are denied like the broker file.
          // Same "resolved, not hardcoded" reasoning: CHRONOS_EGRESS_CA_DIR must not move the keys
          // out of the deny list.
          caKeyFile(), leafKeyFile(),
          // Holds every project's API token — same rationale as .admin-token above.
          dbPath, `${dbPath}-wal`, `${dbPath}-shm`,
          // NOTE: ~/Library/Keychains intentionally NOT denied — Claude reads its own auth token
          // from the login keychain (denying it breaks login), and the keychain is encrypted +
          // securityd-mediated, so a file-read deny wouldn't protect it anyway.
          `${home}/Library/Application Support/Google/Chrome`,
          `${home}/Library/Application Support/Firefox`,
          `${home}/Library/Application Support/BraveSoftware`,
        ]),
      ...splitPaths(process.env.CHRONOS_PROTECTED_SECRETS_EXTRA)],
    // Denied, but a job's own cwd / add_dirs are re-granted (so a job scoped INTO one of these
    // still works, while jobs elsewhere can't touch sibling project folders).
    // No portable default: where project checkouts live differs per machine, so this is
    // configured entirely via env (see .secrets.example).
    projectDirs: [...(process.env.CHRONOS_PROTECTED_DIRS
      ? process.env.CHRONOS_PROTECTED_DIRS.split(":")
      : []),
      ...splitPaths(process.env.CHRONOS_PROTECTED_DIRS_EXTRA)],
  },
  // Per-workspace outbound network policy (egress firewall). A proxy per opted-in workspace
  // audits/blocks agent egress; `enforce` mode also locks direct outbound via Seatbelt → no bypass.
  egress: {
    // Always-permitted dev infra (even in enforce) so agents don't break on routine traffic.
    // Per-workspace `allow` lists add client APIs on top. Matched by exact host or subdomain.
    baseAllow: (process.env.CHRONOS_EGRESS_BASE_ALLOW
      ? process.env.CHRONOS_EGRESS_BASE_ALLOW.split(",")
      : [
          "anthropic.com", "claude.ai", "claude.com",
          "cursor.com", "cursor.sh", "cursorapi.com",
          "github.com", "githubusercontent.com", "githubassets.com", "ghcr.io", "codeload.github.com",
          "registry.npmjs.org", "npmjs.org", "npmjs.com", "yarnpkg.com", "jsdelivr.net", "unpkg.com", "nodejs.org",
          "pypi.org", "pythonhosted.org",
          "slack.com", "slack-edge.com",  // covers mcp.slack.com via subdomain match
          "sentry.io", "statsig.com", "statsig.anthropic.com",  // claude telemetry — avoid noisy denies
        ]).map((s) => s.trim().toLowerCase()).filter(Boolean),
    // Audit-log retention: keep at most this many rows (pruned on each egress sync).
    logCap: Number(process.env.CHRONOS_EGRESS_LOG_CAP ?? 5000),
  },
  telegram: {
    token: process.env.CHRONOS_TG_TOKEN ?? "",
    // Only this chat may control the bot + receives notifications. Leave unset to onboard.
    chatId: process.env.CHRONOS_TG_CHAT_ID ?? "",
    // Confirm-card proposals survive daemon restarts in kv; TTL is the real safety valve so a late
    // ✅ can't fire a mutation decided days ago. Cap is FIFO — bump from 20 because persistence
    // means overnight cards stick around instead of vanishing on every deploy.
    proposalTtlMs: Number(process.env.CHRONOS_TG_PROPOSAL_TTL_MS ?? 24 * 60 * 60 * 1000),
    proposalCap: Number(process.env.CHRONOS_TG_PROPOSAL_CAP ?? 40),
  },
  relay: {
    // wss URL of the Cloudflare relay /ws endpoint; empty = disabled.
    url: process.env.CHRONOS_RELAY_URL ?? "",
    token: process.env.CHRONOS_RELAY_TOKEN ?? "",
  },
  // Conversational Telegram agent: non-command messages spawn this Claude instance.
  // ONE visible thread, N isolated conversations (src/thread-router.ts): how long a message with no
  // workspace signal keeps landing on the workspace the previous one did, and the operator's
  // shorthand for a project — "at=atlas,cd=cedar" makes `#at` and "en cd" route. A workspace's
  // slug and name always route without being listed here.
  thread: {
    stickyMinutes: Number(process.env.CHRONOS_THREAD_STICKY_MIN ?? 90),
    aliases: parseAliases(process.env.CHRONOS_THREAD_ALIASES),
  },
  // Operator prose (src/prose.ts): per workspace, a read-only agent turns the operator's own writing
  // into a style guide agents follow when they draft Slack/Jira/email on his behalf. It re-learns once
  // `minNew` fresh samples have landed since the last pass, at most once a day. auto=0 → only
  // `mc prose learn` runs it.
  prose: {
    auto: process.env.CHRONOS_PROSE_AUTO !== "0",
    minNew: Number(process.env.CHRONOS_PROSE_MIN_NEW ?? 10),
    model: process.env.CHRONOS_PROSE_MODEL ?? "opus",
  },
  agent: {
    backend: process.env.CHRONOS_AGENT_BACKEND ?? "claude-code",
    profile: process.env.CHRONOS_AGENT_PROFILE ?? "claude", // a name from `profiles` below
    model: process.env.CHRONOS_AGENT_MODEL ?? "opus",
    // Voice/web manager runs as ONE warm persistent process (no per-turn CLI boot). Default opus;
    // Desk UI can pick another (kv web.model). CHRONOS_VOICE_MODEL=haiku for max speed, sonnet/fable to save.
    voiceModel: process.env.CHRONOS_VOICE_MODEL ?? "opus",
    maxBudgetUsd: Number(process.env.CHRONOS_AGENT_BUDGET ?? 0.5),
    timeoutSec: Number(process.env.CHRONOS_AGENT_TIMEOUT ?? 180),
    // When warm Claude hits session/rate limit, executives + Telegram re-run the turn here
    // (see manager-fallback.ts). Workspace.fallback_backend/model override per project.
    fallbackBackend: process.env.CHRONOS_AGENT_FALLBACK_BACKEND ?? "grok",
    fallbackModel: process.env.CHRONOS_AGENT_FALLBACK_MODEL ?? "grok-4.5",
    // Tried BEFORE the backend swap when the manager's model is out of its own credits (Fable bills
    // usage credits separately from the subscription): same profile, this model. "" disables it.
    modelFallback: process.env.CHRONOS_AGENT_MODEL_FALLBACK ?? "opus",
    // Tried in order after fallbackBackend fails too (grok out of balance → cursor). "backend" or
    // "backend/model", comma-separated. "" disables the extra steps.
    fallbackChain: (process.env.CHRONOS_AGENT_FALLBACK_CHAIN ?? "cursor")
      .split(",").map((s) => s.trim()).filter(Boolean),
  },
  // Profile name -> CLAUDE_CONFIG_DIR. Selects plan/account/skills/MCP per job: each directory
  // carries its own login, settings, skills and MCP servers, so the profile a job runs under decides
  // whose account is billed and which tools it has. Discovered, not hardcoded — see `discoverProfiles`.
  profiles: discoverProfiles(),
};
