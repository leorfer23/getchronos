export type TriggerType = "cron" | "manual" | "webhook" | "once";

// Event-driven triggers: a reusable object that fires a job when a matching event arrives.
// "http" = inbound webhook (push). Extensible later to "poll" | "telegram" | etc.
export type TriggerSource = "http";
export type InjectMode = "none" | "goal";
export type ConditionOp = "equals" | "contains" | "regex" | "gt" | "lt" | "exists";

export interface TriggerCondition {
  path: string; // dot-path into the event, e.g. "body.alert_type"
  op: ConditionOp;
  value?: string | number | boolean;
}

export interface Trigger {
  id: string;
  name: string;
  enabled: number;
  source: TriggerSource;
  token: string | null; // secret in the hook URL (http source)
  config: string | null; // json, source-specific
  filter: string | null; // json TriggerCondition[]; null/empty = match all
  job_id: string;
  inject: InjectMode; // how the event payload reaches the job
  last_fired_at: string | null;
  fire_count: number;
  created_at: string;
  updated_at: string;
}

export interface NewTrigger {
  name: string;
  enabled?: boolean;
  source?: TriggerSource;
  config?: Record<string, unknown> | null;
  filter?: TriggerCondition[] | null;
  job_id: string;
  inject?: InjectMode;
}
export type RunStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "timeout"
  | "killed"
  | "blocked"
  | "rate_limited"
  | "interrupted"
  // A worker filed an `mc ask` and exited before an answer arrived — no review/verifier/gates ran,
  // the ticket stays in_progress, and the concurrency slot is free. See shouldPark (runner.ts).
  | "paused";

export type WorkspaceKind = "client" | "personal";

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  kind: WorkspaceKind;
  config_dir: string; // CLAUDE_CONFIG_DIR for this workspace (auth + skills + MCP)
  account_label: string | null;
  secrets_file: string | null; // env file injected into runs; denied to other workspaces
  default_dir: string | null; // where a session with no repo lands (null = first repo / home)
  git_name: string | null;  // GIT_AUTHOR/COMMITTER_NAME for this workspace's agents
  git_email: string | null; // GIT_AUTHOR/COMMITTER_EMAIL for this workspace's agents
  daily_budget_usd: number | null; // per-ws daily spend cap; null = global cap only
  max_concurrent: number | null;   // per-ws in-flight run cap; null = global cap only
  stall_minutes: number | null;    // per-ws stall-sweep threshold; null = global CONFIG.stallMinutes, 0 = off
  ask_remind_hours: number | null; // per-ws ask-reminder threshold; null = global CONFIG.askRemindHours, 0 = off
  ask_policy: "robert" | "escalate" | null; // null/"robert" = Robert may auto-answer routine asks; "escalate" = human-only
  capabilities: string | null;   // JSON [{name,available,note}] — only the UNAVAILABLE ones reach agent goals (PER-28)
  default_backend: string;
  default_model: string | null;
  sandbox_mode: "off" | "guard" | "strict";
  /** JSON string[] of absolute paths under $HOME that THIS workspace's agents may read+write even
   *  though the global secrets deny-list covers them (e.g. ~/.config/gcloud for a BigQuery client).
   *  Null = the global deny stands, which is the default for every workspace. */
  sandbox_allow: string | null;
  /** JSON string[] of backend names this workspace may spawn. Null = every registered backend.
   *  Set for a client that must stay on the CLIs which isolate per workspace (see migration 101). */
  backends: string | null;
  ticket_connector: string; // native | clickup | jira
  connector_config: string | null; // json creds/ids
  slack_config: string | null; // json {bot_token, team_id} → per-workspace Slack MCP in this config_dir
  egress_config: string | null; // json {mode:off|audit|enforce, allow:string[]} → per-workspace outbound network policy
  ideas_config: string | null; // json IdeasConfig — per-feeder enable/count/model + push_external
  review_backend: string | null; // cross-vendor QA: backend the auto-reviewer runs on (null = inherit builder's)
  review_model: string | null;   // cross-vendor QA: model the auto-reviewer runs on (null = inherit builder's)
  // Verifier policy for this workspace's `verify` jobs (null = CONFIG.verifyMode):
  // shadow = record the verdict, never flip the run (rollout mode); enforce = a parseable
  // met:false fails the run, an unavailable/unparseable verifier does not (fail-open);
  // strict = fail-closed — an inconclusive verifier also fails the run. See verifier.ts.
  verify_mode: "shadow" | "enforce" | "strict" | null;
  fallback_backend: string | null; // when primary hits rate_limit, re-run on this backend (null = wait-for-resume only)
  fallback_model: string | null;   // model for the fallback backend (null = that backend's default)
  route_config: string | null; // json {"1".."5": "backend:model" | "model"} — plan-graded difficulty → build agent (null = global fallback)
  auto_grade: number;    // 1 = auto-dispatch the k3 grading pass after every plan (default on; off = keep the explorer's grade)
  auto_skill: number;    // 1 = agent-authored/distilled skills publish live (skip the pending gate)
  skill_distill: number; // 1 = run the background skill distiller when a ticket completes
  auto_plan: number; // 1 = auto-dispatch read-only planning agents on backlog tickets (opt-in)
  auto_build: number; // 1 = auto-dispatch the build agent once a ticket is planned (trust; skips human plan-gate)
  auto_review: number; // 1 = auto-dispatch an AI reviewer to QA each finished build (approve/changes)
  merge_gate: number; // 1 = after the PR opens, an agent reviews it, fixes small gaps, and merges when clean
  // 1 = steer-capable backends spawn with streaming stdin so `mc tell` / POST /runs/:id/steer
  // reach the LIVE run instead of waiting for its next checkpoint. See runner.ts steerRun.
  live_steer: number;

  // 1 = hard tickets get a scout PANEL (map / prior-art / risk) merged into one brief, not one scout.
  plan_panel: number;
  // 1 = high-risk changes get a REVIEW panel (spec / correctness / blast-radius), not one reviewer.
  review_panel: number;
  // Skip the AI reviewer entirely (0 reviewers) for tickets graded BELOW this difficulty (1-5
  // scale, see dispatchGrade). null/0 = review everything. Repo.review_min_difficulty overrides.
  review_min_difficulty: number | null;
  archived: number;
  token: string; // per-workspace API credential (PER-24) — injected into that workspace's jobs as MC_WORKSPACE_TOKEN
  created_at: string;
  updated_at: string;
}

export interface NewWorkspace {
  slug: string;
  name: string;
  kind?: WorkspaceKind;
  config_dir: string;
  account_label?: string | null;
  secrets_file?: string | null;
  default_dir?: string | null;
  git_name?: string | null;
  git_email?: string | null;
  daily_budget_usd?: number | null;
  max_concurrent?: number | null;
  stall_minutes?: number | null;
  ask_remind_hours?: number | null;
  ask_policy?: "robert" | "escalate" | null;
  capabilities?: string | null;
  default_backend?: string;
  default_model?: string | null;
  sandbox_mode?: "off" | "guard" | "strict";
  sandbox_allow?: string[] | null;
  backends?: string[] | null;
  ticket_connector?: string;
  connector_config?: Record<string, unknown> | null;
  slack_config?: Record<string, unknown> | null;
  egress_config?: Record<string, unknown> | null;
  ideas_config?: IdeasConfig | Record<string, unknown> | null;
  review_backend?: string | null;
  review_model?: string | null;
  verify_mode?: "shadow" | "enforce" | "strict" | null;
  fallback_backend?: string | null;
  fallback_model?: string | null;
  route_config?: string | Record<string, string> | null;
  auto_grade?: boolean;
  auto_skill?: boolean;
  skill_distill?: boolean;
  auto_plan?: boolean;
  auto_build?: boolean;
  auto_review?: boolean;
  merge_gate?: boolean;
  live_steer?: boolean;
  plan_panel?: boolean;
  review_panel?: boolean;
  review_min_difficulty?: number | null;
  archived?: boolean;
}

export interface Repo {
  id: string;
  workspace_id: string;
  parent_id: string | null; // nest under another repo (group), one level
  name: string;
  path: string; // absolute repo root (an allowed cwd / write root for its workspace)
  git_remote: string | null;
  default_branch: string;
  // How approved work ships. 'pr' (default) = push mc/<key> and open a GitHub PR; 'commit' = merge
  // fast-forwards mc/<key> into the checked-out default branch locally (for repos with no remote).
  // NOT an isolation switch: every ticket build gets its own worktree either way.
  delivery: "commit" | "pr";
  // Per-repo "definition of done" — injected into build + review agents; optional hard gate.
  done_criteria: string | null; // markdown checklist the agent must satisfy before claiming done
  verify_cmd: string | null; // legacy single gate; folded into gate_cmds by parseGates (see gates.ts)
  // Evidence gates: JSON [{name,cmd}] run in the build worktree before review. Per repo, because
  // every repo has its own language and toolchain — `go test ./...` here, `dbt build` there.
  gate_cmds: string | null;
  // JSON RiskPaths: per-repo glob overrides on top of gates.ts RISK_DEFAULTS.
  risk_paths: string | null;
  // When an AI approve still needs a human: 'always' | 'high' | 'med' | 'never' (see gates.ts).
  human_gate: string;
  // Overrides the workspace's review_min_difficulty for this repo (null = inherit).
  review_min_difficulty: number | null;
  post_merge_cmd: string | null; // shell command run in repo root after the ticket's PR merges to main; e.g. "npm run build"
  ideas_enabled: number; // 1 = AI idea feeders may attribute ideas to this repo (workspace feeders still gate)
  created_at: string;
}

/** One evidence gate: a named shell command the build must pass before review. */
export interface Gate {
  name: string;
  cmd: string;
}

export interface GateResult extends Gate {
  ok: boolean;
  ms: number;
  output: string | null; // tail of stdout+stderr, capped
}

export type RiskTier = "low" | "med" | "high";

/** Where a lesson came from. `operator` is ground truth; `review` is a hypothesis until it repeats. */
export type LessonSource = "operator" | "review" | "gate";
export type LessonState = "proposed" | "active" | "archived";

/** One durable rule learned from feedback, injected back into the agents it applies to. */
export interface Lesson {
  id: string;
  workspace_id: string;
  repo_id: string | null; // null = applies across the workspace
  scope: string | null; // path glob it applies to; null = everywhere
  topic: string; // build | review | comms | any
  rule: string;
  source: LessonSource;
  source_ref: string | null; // review id / ticket key it came from
  hits: number; // times injected into a prompt
  seen: number; // times this same rule has been learned again
  last_fired: string | null;
  state: LessonState;
  created_at: string;
  updated_at: string;
}

// Memory relations — a judged relationship between two remembered facts. The vocabulary is closed
// on purpose: a free-text verdict cannot be counted, filtered or acted on. Borrowed from engram
// (MIT, Gentleman-Programming/engram), which locks the same six verbs so stored verdicts stay
// comparable across models.
export type MemoryRelationVerb =
  | "conflicts_with" // the two make contradictory claims — the only one that demands a decision
  | "supersedes" // one replaces the other; the older should retire
  | "scoped" // one is a narrower instance of the other, so both can hold
  | "related" // same subject, no conflict
  | "compatible" // consistent and complementary
  | "not_conflict"; // no meaningful overlap — recorded so the pair is never judged twice

/** What a side of a relation points at: a lesson row, or a line in the memory tree (by prose hash). */
export type MemoryRelationKind = "lesson" | "memory-line";

export type MemoryRelationStatus = "open" | "resolved" | "dismissed";

export interface MemoryRelation {
  id: string;
  workspace_id: string;
  source_kind: MemoryRelationKind;
  source_ref: string;
  /** Denormalized: the row must still show what disagreed after the source is edited. */
  source_text: string;
  target_kind: MemoryRelationKind;
  target_ref: string;
  target_text: string;
  relation: MemoryRelationVerb;
  confidence: number | null;
  reason: string | null;
  /** Model id that judged the pair, for when a verdict looks wrong. */
  judged_by: string | null;
  status: MemoryRelationStatus;
  resolved_at: string | null;
  created_at: string;
}

export type NewMemoryRelation = Omit<MemoryRelation, "id" | "created_at" | "resolved_at" | "status"> & {
  status?: MemoryRelationStatus;
};

// Repo/workspace accelerators — opt-in tools an agent MAY use in a repo (graphify, ast-grep,
// repomix). `enabled` only flips a stored switch — nothing reads this table to change a prompt or
// context yet; see src/accel/zero-tax.test.ts for the boundary that pins that until it does.
export type AcceleratorTool = "graphify" | "ast-grep" | "repomix";

export interface RepoAccelerator {
  id: string;
  workspace_id: string;
  repo_id: string;
  tool: AcceleratorTool;
  enabled: number; // 0/1, same convention as repos.ideas_enabled
  mode: string | null; // e.g. graphify's "code-only" canary; null for tools with no mode
  created_at: string;
  updated_at: string;
}

export interface NewLesson {
  workspace_id: string;
  repo_id?: string | null;
  scope?: string | null;
  topic?: string;
  rule: string;
  source?: LessonSource;
  source_ref?: string | null;
  state?: LessonState;
}

/** Per-repo risk glob overrides. `low` demotes (checked first); `use_defaults:false` drops the built-ins. */
export interface RiskPaths {
  high?: string[];
  med?: string[];
  low?: string[];
  use_defaults?: boolean;
}

export interface NewRepo {
  workspace_id: string;
  parent_id?: string | null;
  name: string;
  path: string;
  git_remote?: string | null;
  default_branch?: string;
  delivery?: "commit" | "pr";
  done_criteria?: string | null;
  verify_cmd?: string | null;
  gate_cmds?: string | null;
  risk_paths?: string | null;
  human_gate?: string;
  review_min_difficulty?: number | null;
  post_merge_cmd?: string | null;
  ideas_enabled?: boolean;
}

export type TicketStatus =
  | "backlog"
  | "spec"
  | "ready"
  | "planning"   // an autonomous agent is investigating + drafting a plan (read-only)
  | "planned"    // plan ready in the ticket, awaiting human approve/continue
  | "in_progress"
  | "review"
  | "shipping"   // PR open, awaiting merge to main — done only when the code lands
  | "blocked"
  | "done"
  | "dismissed"; // decided against — kept as a record, never worked again (delete is for mistakes)

/**
 * A ticket nobody will work again: it shipped, or it was dropped on purpose.
 *
 * Both leave every active surface — the board, the forum, the queue, the open counts — and the
 * difference between them is the record, not the routing. Deleting is still there for the ticket
 * that should never have been filed; dismissing is for the one that was a real call.
 */
export const CLOSED_TICKET_STATUSES: readonly TicketStatus[] = ["done", "dismissed"];

export function isClosedTicketStatus(status: string | null | undefined): boolean {
  return (CLOSED_TICKET_STATUSES as readonly string[]).includes(String(status ?? ""));
}

/**
 * Who last set `status`. 'external' = the value is a mirror of the upstream tracker (ClickUp/Jira
 * sync) — nobody at Chronos is actually working it. 'local' = Chronos itself decided the status
 * (API/mc/autonomous loop/reviews), including the moment it starts real work on a formerly-mirrored
 * ticket. The single choke point is updateTicket() (src/tickets.ts): 'local' is the default whenever
 * `status` changes, and ONLY connector sync (src/connectors/index.ts) passes 'external' explicitly.
 */
export type TicketStatusSource = "local" | "external";

/**
 * Who last set `complexity` (the plan-graded 1-5 difficulty that drives build-agent routing and
 * review_min_difficulty). 'human' = the operator (mc/API) or Robert set it explicitly — authoritative,
 * nothing may overwrite it and maybeGrade() (src/autoplan.ts) refuses to even dispatch a grader against
 * it. 'scout' = the planning agent graded it while saving its plan (setPlan). 'grader' = the second-pass
 * k3 grader (gradeTicket/`mc grade`) graded it. null = legacy/unknown — no source has claimed it yet.
 * The choke point is updateTicket() (src/tickets.ts): 'human' is the default whenever `complexity`
 * changes through the generic PATCH and the caller didn't say otherwise; setPlan/gradeTicket bypass that
 * choke point and stamp their own source directly, and gradeTicket refuses to write at all once the
 * source is 'human'.
 */
export type TicketComplexitySource = "human" | "scout" | "grader";

export interface Ticket {
  id: string;
  workspace_id: string;
  repo_id: string | null;
  key: string; // human id, e.g. ACM-14 (unique per workspace)
  slug: string; // kebab title
  title: string;
  status: TicketStatus;
  status_source: TicketStatusSource; // 'external' = mirrors the upstream tracker, not real Chronos work — see TicketStatusSource
  priority: string; // P0..P3
  complexity: string | null; // difficulty "1".."5" (5=hardest; legacy trivial|easy|medium|hard) — plan-graded; drives build agent routing. null → treated as 3
  complexity_source: TicketComplexitySource | null; // who set `complexity` — see TicketComplexitySource. null = legacy/unset.
  backend: string | null; // overrides workspace default
  model: string | null;
  assignee: string; // agent | human:<name>
  file_path: string; // the .md source of truth
  external_system: string | null; // clickup | jira | null
  external_id: string | null;
  external_url: string | null;
  external_status: string | null; // the tracker's own status label as of the last sync — see isStatusDivergent()
  status_divergent?: boolean; // derived by the API (not a column) — local status contradicts external_status
  tags: string | null; // json array
  pr_url: string | null;   // delivery=pr: the GitHub PR opened by merge()
  pr_state: string | null; // null | 'open' | 'merged' | 'closed' — polled delivery state (db-only, volatile)
  ci_state: string | null; // null | 'pending' | 'passing' | 'failing' — PR check rollup, polled alongside pr_state
  ci_checks: string | null; // json CiCheck[] — per-check detail from the PR rollup (db-only, volatile)
  repo_delivery?: "commit" | "pr" | null; // joined by the API from the ticket's repo (not a column)
  blocked?: boolean; // joined by the API — has ≥1 open `blocks` upstream ticket (not a column)
  summary: string | null; // AI-generated one-sentence description (generate-on-read)
  report: string | null; // build agent's structured handoff (markdown) — set via `mc review --report`; feeds review card + PR body
  // buzz_event_id / buzz_channel_id still exist as dead nullable DB columns (migration 76) — the
  // Buzz transport is gone and nothing reads or writes them anymore.
  cost?: TicketCost; // joined by the API (not a column) — headless run spend rollup
  created_at: string;
  updated_at: string;
}

export interface TicketCost {
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  runs: number;
  models: string[];
}

export interface NewTicket {
  workspace_id: string;
  repo_id?: string | null;
  title: string;
  status?: TicketStatus;
  // Internal-only (not part of the public NewTicketSchema/zod-validated body — connector sync is the
  // only in-process caller that sets this). Defaults to 'local' in createTicket().
  status_source?: TicketStatusSource;
  priority?: string;
  complexity?: string | null;
  // Internal-only (not part of the public NewTicketSchema/zod-validated body). createTicket() defaults
  // it to 'human' whenever `complexity` is set on create and the caller didn't say otherwise — the
  // public API (POST /tickets, an operator/Robert call) is the only caller that sets complexity on
  // create today. setPlan ('scout') and gradeTicket ('grader') grade complexity post-creation and
  // write it directly through store.update(), bypassing createTicket entirely.
  complexity_source?: TicketComplexitySource | null;
  backend?: string | null;
  model?: string | null;
  assignee?: string;
  tags?: string[] | null;
  context?: string; // body: ## Context
  acceptance?: string; // body: ## Spec / Acceptance criteria
  external_system?: string | null; // clickup | jira (when imported)
  external_id?: string | null;
  external_url?: string | null;
  // Internal-only (not part of the public NewTicketSchema) — connector sync stamps the tracker's own
  // status label on a freshly-mirrored ticket so divergence is derivable before the next pull.
  external_status?: string | null;
  parent_id?: string | null; // attach under this goal ticket → writes a `parent` link on create
}

// Row as persisted by the store (service computes id/key/slug/file_path).
export interface TicketRow {
  id: string;
  workspace_id: string;
  repo_id: string | null;
  key: string;
  slug: string;
  title: string;
  status: TicketStatus;
  status_source: TicketStatusSource;
  priority: string;
  complexity: string | null;
  complexity_source: TicketComplexitySource | null;
  backend: string | null;
  model: string | null;
  assignee: string;
  file_path: string;
  external_system: string | null;
  external_id: string | null;
  external_url: string | null;
  external_status: string | null;
  tags: string | null;
  pr_url: string | null;
  pr_state: string | null;
  ci_state: string | null;
  ci_checks: string | null;
  summary: string | null;
  report: string | null;
}

// One CI check as surfaced from gh's statusCheckRollup — normalized across CheckRun + StatusContext.
export interface CiCheck {
  name: string;
  state: "pending" | "passing" | "failing";
  url: string | null;
}

export type CalendarSource = "ics" | "gws" | "local";

export interface Calendar {
  id: string;
  workspace_id: string | null; // null = personal/global
  name: string;
  source: CalendarSource;
  ics_url: string; // ICS feed (source=ics) or "gws://<account>" placeholder
  account: string | null; // gws: calendarId/email (defaults to "primary")
  config_dir: string | null; // gws: XDG_CONFIG_HOME isolating this account's credentials
  color: string | null;
  enabled: number;
  last_sync: string | null;
  created_at: string;
}

export interface NewCalendar {
  workspace_id?: string | null;
  name: string;
  source?: CalendarSource;
  ics_url?: string;
  account?: string | null;
  config_dir?: string | null;
  color?: string | null;
}

export interface CalEvent {
  id: string;
  calendar_id: string;
  uid: string | null;
  title: string;
  start: string; // ISO
  end: string | null; // ISO
  all_day: number;
  location: string | null;
}

/** Operator/agent screenshot or file attached to a ticket (validation evidence). */
export interface TicketAttachment {
  id: string;
  ticket_id: string;
  workspace_id: string;
  filename: string; // original name
  stored_name: string; // on-disk name
  mime: string;
  size: number;
  caption: string | null;
  source: string; // upload | telegram | agent
  created_at: string;
  /** Absolute path on the daemon host (agents can Read this). */
  path?: string;
  /** Relative API URL to fetch bytes: /api/attachments/:id/file */
  url?: string;
}

export type ReviewState = "pending" | "approved" | "changes_requested" | "merged" | "dismissed";

export interface Review {
  id: string;
  run_id: string;
  ticket_id: string | null;
  state: ReviewState;
  diff_ref: string | null; // captured git diff (truncated)
  gate_json: string | null; // JSON GateResult[] from the pre-review gate run (null = no gates ran)
  // JSON PanelState when this review was judged by a lens panel (see panels.ts); null = single reviewer.
  panel_json: string | null;
  risk: string | null; // RiskTier computed from the diff's paths (null = unknown → treated as high)
  notes: string | null;
  actor: string | null; // who made the last state transition: "human" | "ai:reviewer" | "ai:gate" (null legacy)
  created_at: string;
  reviewed_at: string | null;
  /** ISO. Set = deferred to a date ("later"), off the live review queue until then (src/holds.ts). */
  hold_until: string | null;
  hold_reason: string | null;
  /** ISO of the last resurface — keeps the "back from later" card to once per hold. */
  resurfaced_at: string | null;
}

export interface Job {
  id: string;
  name: string;
  description: string | null;
  goal: string;
  append_system: string | null;
  profile: string;
  workspace_id: string | null; // null = legacy/unscoped (uses profile + global sandbox)
  ticket_id: string | null; // ticket this run is working, if any
  backend: string; // claude-code | cursor-agent | ... (registry key)
  cwd: string;
  add_dirs: string | null; // json array
  model: string | null;
  allowed_tools: string | null;
  disallowed_tools: string | null;
  trigger_type: TriggerType;
  cron_expr: string | null;
  run_at: string | null; // trigger_type "once": ISO time of the single fire; cleared once it ran
  timezone: string;
  max_budget_usd: number | null;
  timeout_sec: number;
  retry_max: number;
  retry_backoff_sec: number;
  verify: number;
  sandbox: "off" | "guard" | "strict";
  on_success: string | null;
  on_failure: string | null;
  notify: "all" | "failures" | "off" | null; // telegram push policy for run.ended; null = "all"
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: string;
  job_id: string;
  status: RunStatus;
  trigger_src: string | null;
  session_id: string | null;
  pid: number | null;
  started_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
  num_turns: number | null;
  cost_usd: number | null;
  /** 1 when cost_usd is token-table arithmetic, not a vendor total (mirrors sessions.cost_estimated). */
  cost_estimated: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read: number | null;  // prompt-cache read tokens summed across the run's result events
  cache_write: number | null; // prompt-cache write tokens — see src/cache-health.ts
  is_error: number | null;
  summary: string | null;
  error: string | null;
  attempt: number;
  verify_verdict: string | null;
  resets_at: string | null;
  context: string | null; // trigger-event payload injected into this run
  resume_session: string | null; // set on a resume run: the prior run's session_id to --resume into
}

export interface NewJob {
  name: string;
  description?: string | null;
  goal: string;
  append_system?: string | null;
  profile?: string;
  workspace_id?: string | null;
  ticket_id?: string | null;
  backend?: string;
  cwd?: string;
  add_dirs?: string[] | null;
  model?: string | null;
  allowed_tools?: string | null;
  disallowed_tools?: string | null;
  trigger_type?: TriggerType;
  cron_expr?: string | null;
  run_at?: string | null;
  timezone?: string;
  max_budget_usd?: number | null;
  timeout_sec?: number;
  retry_max?: number;
  retry_backoff_sec?: number;
  verify?: boolean;
  sandbox?: "off" | "guard" | "strict";
  on_success?: string | null;
  on_failure?: string | null;
  notify?: "all" | "failures" | "off" | null;
  enabled?: boolean;
}

// An interactive terminal session (PTY) running an agent CLI. May be bound to a ticket or free-floating
// (human ↔ agent chat, no ticket). Many sessions can target one ticket; role distinguishes who drives it.
export type SessionRole = "human" | "worker" | "reviewer" | "lead";
export type SessionStatus = "live" | "ended";
/** What a terminal is FOR, coarsely — the operator picks it in the spawn dialog and it sets the
 *  agent's finish line: a PR to open, a question to answer, a build to verify. */
export type GoalKind = "pr" | "investigation" | "qa";
/** Who last wrote a session's goal. The Desk title deriver only overwrites 'seed' and 'auto'. */
export type GoalSource = "seed" | "auto" | "agent" | "human";
export interface Session {
  id: string;
  ticket_id: string | null;
  workspace_id: string | null;
  repo_id: string | null;
  title: string | null;
  /** Operator's objective for this terminal ("open the rollback PR"). Set at spawn, editable on the
   *  Desk wall, refinable by the agent via `mc goal set`. Independent of tickets. */
  goal: string | null;
  /** ISO timestamp the goal was marked reached (by the operator or `mc goal done`). */
  goal_done_at: string | null;
  /** Shape of the work: what "done" looks like for this terminal. Chip on the Desk card. */
  goal_kind: GoalKind | null;
  /** Who last wrote the goal. 'seed'/'auto' are refinable by the title deriver; 'human'/'agent' are not. */
  goal_source: GoalSource | null;
  /** Who opened this terminal: operator | robert | agent:<name> | ticket | cron. */
  created_by: string | null;
  /** The Lead (role "lead") that opened this terminal, if any — stamped by the daemon from the
   *  `x-mc-lead` credential at spawn, never from the request body. Ownership: its stops wake this
   *  Lead instead of Robert, and only this Lead may type into it. Not a secret (unlike lead_token),
   *  so it rides out on rows. */
  lead_id: string | null;
  /** The goal as TYPED at spawn, kept beside the one the agent sharpened. */
  spawn_goal: string | null;
  // The day's ledger — refreshed while live, frozen when the pty dies (snapshotUsage).
  turns: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read: number | null;
  cache_write: number | null;
  cost_usd: number | null;
  /** 1 when cost_usd is token-table arithmetic, not the CLI's own total. */
  cost_estimated: number | null;
  context_peak: number | null;
  lines_added: number | null;
  lines_removed: number | null;
  model_ms: number | null;
  branch: string | null;
  blocked_count: number | null;
  /** The worktree this terminal claimed once it knew its repo (`mc worktree`). Null = never claimed
   *  one, so it is working in a shared checkout. Preferred over `cwd` when reopening. */
  worktree_path: string | null;
  worktree_branch: string | null;
  // A standing order to re-read this terminal on a clock: Robert looks, then reports on Telegram.
  /** Minutes between checks. Null = nobody is watching this terminal. */
  watch_every_min: number | null;
  /** What the operator asked to be watched FOR, in their words ("tell me if it goes near prod"). */
  watch_note: string | null;
  /** Who set the watch: operator | robert | agent:<name>. */
  watch_by: string | null;
  watch_started_at: string | null;
  /** Last report sent. The sweeper's clock — survives a restart, so a reboot doesn't fire them all. */
  watch_last_at: string | null;
  /** Unique live handle (herdr-style) for attach/wait/Robert briefs. Cleared when the session ends. */
  agent_name: string | null;
  backend: string;
  model: string | null;
  role: SessionRole;
  /** Opened from the Desk as story + composer only. The raw terminal is not offered on the stage. */
  focus_only: boolean;
  cwd: string;
  pid: number | null;
  status: SessionStatus;
  created_at: string;
  ended_at: string | null;
  /** Why the daemon ended it (e.g. "out of credits → grok terminal ab12cd34"). Null = closed or died. */
  end_reason?: string | null;
  summary?: string | null;
  tags?: string | null;
  first_prompt?: string | null;
  ticket_key?: string | null;
  ticket_title?: string | null;
}

/** One standing-watch check: what Robert saw and said (desk-watch.ts). */
export interface WatchReport {
  id: number;
  session_id: string;
  at: string;
  /** The terminal's state when he looked: working · waiting · blocked · done · ended. */
  state: string;
  body: string;
  /** The closing verdict sent when the terminal finished and the watch lifted itself. */
  final: boolean;
  /** Robert couldn't be reached; body is the raw state instead of his words. */
  failed: boolean;
}
export interface NewSession {
  ticket_id?: string | null;
  workspace_id?: string | null;
  repo_id?: string | null;
  title?: string | null;
  goal?: string | null;
  goal_kind?: GoalKind | null;
  goal_source?: GoalSource | null;
  created_by?: string | null;
  /** Set by api.ts from `leadScope(req)` alone — never from what the caller sent. */
  lead_id?: string | null;
  agent_name?: string | null;
  backend?: string;
  model?: string | null;
  role?: SessionRole;
  focus_only?: boolean;
  cwd: string;
}

// 'workspace' = client-isolated (default). 'global' = operator profile, injected into every
// workspace's agents by design; only the operator may set it (admin-gated in api.ts).
export type NoteScope = "workspace" | "global";
export interface Note {
  id: string;
  workspace_id: string;
  title: string;
  slug: string;
  file_path: string;
  body: string;
  pinned: number;
  context: number;
  scope: NoteScope;
  // Repo-scoping for context memos: repo ids this note applies to. null/empty = workspace-wide.
  // Parsed to an array at the service boundary; stored as JSON TEXT in SQLite.
  repo_ids: string[] | null;
  created_at: string;
  updated_at: string;
}
export interface NewNote {
  workspace_id: string;
  title: string;
  body?: string;
  pinned?: boolean;
  context?: boolean;
  scope?: NoteScope;
  repo_ids?: string[] | null;
}

export type SkillStatus = "pending" | "active" | "archived";
export type SkillSource = "agent" | "operator" | "distill";
// Procedural skill (Hermes-style): a SKILL.md the agents author from successful work + improve on
// reuse. File on disk is source of truth; this row is the index + L0 progressive-disclosure metadata.
export interface Skill {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  description: string;  // search-result-style prose — the only thing the L0 index shows
  category: string | null;
  tags: string | null;  // json array
  status: SkillStatus;
  version: number;
  usage_count: number;
  last_used_at: string | null;
  file_path: string;    // <skills-vault>/<ws-slug>/<slug>/SKILL.md
  source: SkillSource;
  created_at: string;
  updated_at: string;
}
export interface NewSkill {
  workspace_id: string;
  name: string;
  description?: string;
  category?: string | null;
  tags?: string[] | null;
  body?: string;        // the markdown body (When to use / Procedure / Pitfalls / Verification …)
  status?: SkillStatus;
  source?: SkillSource;
}

// Idea Pool — staging layer before real tickets. Soft decisions only (no row delete).
export type IdeaKind = "expansion" | "new" | "improvement" | "ux-ui" | "qa" | "visibility";
export type IdeaSource = "followups" | "miner" | "signals" | "intake" | "manual";
export type IdeaStatus = "proposed" | "promoted" | "killed" | "expired";

export interface Idea {
  id: string;
  workspace_id: string;
  repo_id: string | null;
  title: string;
  pitch: string;
  kind: IdeaKind;
  source: IdeaSource;
  source_ref: string | null;
  // The spec an intake draft carries: becomes the promoted ticket's acceptance criteria verbatim,
  // so an approved draft is buildable without the operator writing it up himself.
  acceptance: string | null;
  status: IdeaStatus;
  model: string | null;
  promoted_ticket_id: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface NewIdea {
  workspace_id: string;
  repo_id?: string | null;
  title: string;
  pitch: string;
  kind: IdeaKind;
  source: IdeaSource;
  source_ref?: string | null;
  acceptance?: string | null;
  model?: string | null;
}

export type FeederConfig = {
  enabled: boolean;
  count: number;
  model: string | null;
};

/** The chief-of-staff sweep: reads signals outside the repo and drafts specced work (src/intake.ts). */
export type IntakeConfig = FeederConfig & {
  cron?: string;
  tz?: string;
  /** Signal sources to sweep; omitted/empty = every source available to the workspace. */
  sources?: string[];
};

export type IdeasConfig = Partial<Record<"followups" | "miner", FeederConfig>> & {
  intake?: IntakeConfig;
  push_external?: boolean;
};

export const IDEA_KINDS: IdeaKind[] = ["expansion", "new", "improvement", "ux-ui", "qa", "visibility"];
export const IDEA_SOURCES: IdeaSource[] = ["followups", "miner", "signals", "intake", "manual"];
