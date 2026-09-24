import { z } from "zod";
import type { Request, Response, NextFunction } from "express";
import { IDEA_KINDS, IDEA_SOURCES } from "./types.js";
import { LINK_TYPES } from "./store.js";
import { MAX_LABEL, MAX_QUICK_ACTIONS, MAX_TEXT, QA_KINDS, QA_PHASES } from "./quick-actions.js";

// Express body-validation middleware: parses req.body against `schema`, replies 400 with a readable
// message on mismatch, else replaces req.body with the parsed (typed, defaulted) value and continues.
export function validate(schema: z.ZodType) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const detail = result.error.issues
        .map((i) => `${i.path.length ? i.path.join(".") : "body"}: ${i.message}`)
        .join("; ");
      return res.status(400).json({ error: `invalid request body — ${detail}` });
    }
    req.body = result.data;
    next();
  };
}

const id = z.string().min(1);
const nullableId = id.nullable();

// ───────────────────────────── sessions ─────────────────────────────
/** One item of a terminal's goal list — bare words, or words with a shape of work. */
export const GoalItemSchema = z.union([
  z.string().min(1).max(400),
  z.object({
    text: z.string().min(1).max(400),
    kind: z.enum(["pr", "investigation", "qa"]).nullable().optional(),
  }),
]);
/** `POST /sessions/:id/goals` — append to the list, or replace it outright. */
export const SessionGoalsSchema = z.object({
  goals: z.array(GoalItemSchema).min(1).max(20),
  /** true = this IS the list now (`mc goal set` with several); default appends. */
  replace: z.boolean().optional(),
  source: z.enum(["seed", "auto", "agent", "human"]).optional(),
});
/** `PATCH /sessions/:id/goals/:goalId` — retitle, reshape, tick or untick one item. */
export const SessionGoalPatchSchema = z
  .object({
    text: z.string().min(1).max(400).optional(),
    kind: z.enum(["pr", "investigation", "qa"]).nullable().optional(),
    source: z.enum(["seed", "auto", "agent", "human"]).optional(),
    done: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "nothing to patch" });

export const OpenSessionSchema = z.object({
  ticket_id: nullableId.optional(),
  workspace_id: nullableId.optional(),
  repo_id: nullableId.optional(),
  title: z.string().nullable().optional(),
  goal: z.string().max(400).nullable().optional(),
  goal_kind: z.enum(["pr", "investigation", "qa"]).nullable().optional(),
  /** More than one finish line, in the order to work them (src/goals.ts). The first becomes the
   *  card's goal; the rest queue behind it. Capped so a spawn cannot queue a novel. */
  goals: z.array(GoalItemSchema).max(20).nullable().optional(),
  /** Who opened it — for the day's ledger. operator | robert | agent:<name> | ticket | cron. */
  created_by: z.string().max(60).nullable().optional(),
  /** Free-text brief typed in the spawn dialog. Becomes the terminal's first prompt (see deskSeed). */
  description: z.string().max(4000).nullable().optional(),
  agent_name: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,31}$/, "agent_name must match [a-z][a-z0-9_-]{0,31}")
    .nullable()
    .optional(),
  backend: z.string().optional(),
  model: z.string().nullable().optional(),
  role: z.enum(["human", "worker", "reviewer", "lead"]).optional(),
  /** Desk spawn: keep this session on Focus (story + composer) and never mount its live terminal. */
  focus_only: z.boolean().optional(),
  /**
   * `mc session new --slice 3` from a Lead: the board slice this worker is being opened for. Read
   * ONLY when the caller presented that Lead's credential, and never stored on the session row — it
   * is the Lead's own board (lead_slices) that gains the link, like `lead_id` it is the daemon's to
   * stamp (api.ts).
   */
  slice: z.number().int().positive().max(999).optional(),
  cwd: z.string().optional(),
  seed: z.string().optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  resumeId: id.optional(),
  agentSessionId: nullableId.optional(),
  resumeAgent: z.boolean().optional(),
  /** Pin the terminal to a connected host (HOSTS.md phase 3), by id or name. Unset = the brain. */
  host_id: z.string().max(80).nullable().optional(),
});

export const AgentNameSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,31}$/, "name must match [a-z][a-z0-9_-]{0,31}")
    .nullable(),
});

export const AgentReportSchema = z.object({
  state: z.enum(["idle", "working", "blocked", "done", "unknown"]).optional(),
  state_label: z.string().nullable().optional(),
  blocked_reason: z
    .enum(["hitl", "approval", "question", "budget", "gate", "stall", "recovery", "review", "auth"])
    .nullable()
    .optional(),
  ttl_ms: z.number().int().positive().nullable().optional(),
});

/** `mc state` from inside a terminal (term-status.ts). */
export const SessionStatusSchema = z.object({
  state: z.enum(["working", "waiting", "blocked", "decide", "review", "done", "idle"]),
  label: z.string().max(400).nullable().optional(),
  reason: z.enum(["hitl", "approval", "question", "budget", "gate", "stall", "recovery", "review", "auth"]).nullable().optional(),
  on: z.enum(["subagents", "ci", "terminal", "command", "robert", "person", "deploy", "other"]).nullable().optional(),
  eta_min: z.number().positive().max(7 * 24 * 60).nullable().optional(),
});
/** `mc progress 2/5 "label"` — null clears. */
export const SessionProgressSchema = z.object({
  n: z.number().int().min(0).max(10000).nullable(),
  of: z.number().int().min(1).max(10000).nullable().optional(),
  label: z.string().max(200).nullable().optional(),
});
/** One lifecycle hook from a terminal's CLI, normalized by `mc hook`. */
export const SessionHookSchema = z.object({
  event: z.enum(["prompt", "stop", "subagent_start", "subagent_stop", "ask", "answered", "session_end"]),
  key: z.string().max(200).nullable().optional(),
  label: z.string().max(400).nullable().optional(),
  question: z.string().max(2000).optional(),
  options: z.array(z.string().max(200)).max(12).optional(),
  error: z.string().max(400).nullable().optional(),
  tasks: z.array(z.object({ key: z.string().max(200), label: z.string().max(400) })).max(50).optional(),
});

const UsageWindowSchema = z.object({ used_percentage: z.number().min(0).max(10000), resets_at: z.number().nullable().optional() }).passthrough();
/** `mc statusline claude` → POST /usage/report: the statusLine's rate_limits, verbatim. */
export const UsageReportSchema = z.object({
  cli: z.literal("claude"),
  config_dir: z.string().max(1000).nullable().optional(),
  rate_limits: z.object({
    five_hour: UsageWindowSchema.nullable().optional(),
    seven_day: UsageWindowSchema.nullable().optional(),
    spend_limit: UsageWindowSchema.nullable().optional(),
  }).passthrough(),
});

/** Desk wall: edit a terminal's objective (and tick it off) after it was opened. */
export const SessionPatchSchema = z.object({
  goal: z.string().max(400).nullable().optional(),
  goal_done: z.boolean().optional(),
  /** With `goal_done: true` on a terminal that has a goal LIST: tick every open item, not just the
   *  one on the card. This is the operator closing the terminal ("done is done"), where the agent's
   *  own `mc goal done` only ever ticks the one it is on. */
  goal_done_all: z.boolean().optional(),
  goal_kind: z.enum(["pr", "investigation", "qa"]).nullable().optional(),
  // Who is renaming this terminal. Omitted = the operator (the card's inline edit), which locks the
  // goal against the automatic deriver; agents pass "agent" via `mc goal set`.
  goal_source: z.enum(["seed", "auto", "agent", "human"]).optional(),
  title: z.string().max(200).optional(),
});

// Typing into someone else's terminal. `text` is a line (Enter follows unless enter:false); `key` is
// one named keystroke, so callers never hand-roll escape sequences.
export const SessionInputSchema = z
  .object({
    text: z.string().max(4000).nullable().optional(),
    key: z.enum(["enter", "esc", "tab", "up", "down", "ctrl-c", "ctrl-d"]).nullable().optional(),
    // A short sequence ("down, down, enter" = the third option in a menu), spaced out server-side
    // so a TUI sees separate keystrokes. Counts as ONE input against the per-terminal cap.
    keys: z.array(z.enum(["enter", "esc", "tab", "up", "down", "ctrl-c", "ctrl-d"])).min(1).max(8).optional(),
    enter: z.boolean().optional(),
    by: z.string().max(60).optional(),
  })
  .refine((b) => !!b.text || !!b.key || !!b.keys?.length, { message: "pass text, key or keys" });

export const AgentWaitSchema = z.object({
  until: z
    .union([
      z.enum(["idle", "working", "blocked", "done", "unknown", "settled"]),
      z.array(z.enum(["idle", "working", "blocked", "done", "unknown", "settled"])),
    ])
    .optional(),
  timeout_ms: z.number().int().positive().optional(),
});

export const ResizeSchema = z.object({
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  seed: z.string().optional(),
});

// A request for one machine-wide heavy slot (`mc heavy`). The label is what the queue shows the
// other waiters, so it is the command line — capped, since it is echoed back to every caller.
export const HeavySlotSchema = z.object({
  session_id: z.string().nullish(),
  label: z.string().trim().min(1).max(120),
  /** The place in line a previous refusal handed back, so a 55s poll timeout does not cost it. */
  ticket: z.string().max(64).nullish(),
});

// ───────────────────────────── notes ─────────────────────────────
export const NewNoteSchema = z.object({
  workspace_id: id,
  title: z.string().min(1),
  body: z.string().optional(),
  pinned: z.boolean().optional(),
  context: z.boolean().optional(),
  scope: z.enum(["workspace", "global"]).optional(),
  // repo ids this context memo is scoped to; omit/empty/null = workspace-wide.
  repo_ids: z.array(id).nullable().optional(),
});

export const PatchNoteSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  pinned: z.boolean().optional(),
  context: z.boolean().optional(),
  scope: z.enum(["workspace", "global"]).optional(),
  // null clears repo-scoping (back to workspace-wide); an array re-scopes; omit = leave unchanged.
  repo_ids: z.array(id).nullable().optional(),
  append: z.string().optional(),
  heading: z.string().optional(),
});

export const LearnSchema = z.object({
  fact: z.string().trim().min(1),
  label: z.string().optional(),
});

/** `mc remember`: one short rule into the memory tree (memory-tree.ts), optional expanded detail. */
export const RememberSchema = z.object({
  fact: z.string().trim().min(1).max(2000),
  topic: z.string().trim().max(60).optional(),
  detail: z.string().trim().max(4000).optional(),
  session: z.string().max(80).optional(),
});

/** `mc prose add`: one message the operator wrote (src/prose.ts). `draft` = the agent text he rewrote. */
export const ProseSampleSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  channel: z.string().trim().max(20).optional(),
  source: z.enum(["manual", "slack", "jira", "clickup", "email", "edit"]).optional(),
  draft: z.string().trim().max(4000).optional(),
  context: z.string().trim().max(1000).optional(),
  ref: z.string().trim().max(300).optional(),
});
// A transport bound only: the one-page cap (prose.ts GUIDE_CAP) is saveGuide's, which refuses with
// the length and what to do — a bare 400 here would teach the learner nothing.
export const ProseGuideSchema = z.object({ body: z.string().trim().min(1).max(16000) });

// Persona memory. Capped so one runaway append can't bloat a file that loads on every single turn.
export const AgentMemoryAppendSchema = z.object({
  fact: z.string().trim().min(1).max(2000),
  heading: z.string().max(120).optional(),
});
export const AgentMemoryRewriteSchema = z.object({
  body: z.string().max(20000),
});
// The stow pass (src/stow.ts). `reinforced` is EVIDENCE, not a wish: each item is an entry hash or
// the exact entry text the caller can say this session exercised. Capped so a caller cannot hand in
// the whole file and call every line reinforced.
export const StowSchema = z.object({
  reinforced: z.array(z.string().trim().min(1).max(2000)).max(100).optional(),
});
// Robert's per-workspace brief (src/briefs.ts): same shape and caps as his memory.
export const BriefAppendSchema = AgentMemoryAppendSchema;
export const BriefRewriteSchema = AgentMemoryRewriteSchema;

// A manual worklog entry (src/worklog.ts) — the operator or Robert recording a piece of work the
// daemon did not see (a call, a decision, work done outside a terminal). Same one-line discipline as
// an auto entry, so the ledger reads the same however it was written.
const worklogItems = z.array(z.string().trim().min(1).max(240)).max(5).optional();
export const WorklogEntrySchema = z.object({
  what: z.string().trim().min(1).max(240),
  outcome: z.string().trim().min(1).max(240),
  pending: worklogItems,
  next: worklogItems,
  pr: z.string().url().nullable().optional(),
  ticket: z.string().trim().max(32).nullable().optional(),
});
export const WorklogBackfillSchema = z.object({
  since: z.string().trim().min(1).max(40).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

// ───────────────────────────── jobs ─────────────────────────────
const jobFields = {
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  goal: z.string().min(1),
  append_system: z.string().nullable().optional(),
  profile: z.string().optional(),
  workspace_id: nullableId.optional(),
  ticket_id: nullableId.optional(),
  backend: z.string().optional(),
  cwd: z.string().min(1).optional(),
  add_dirs: z.array(z.string().min(1)).nullable().optional(),
  model: z.string().nullable().optional(),
  allowed_tools: z.string().nullable().optional(),
  disallowed_tools: z.string().nullable().optional(),
  trigger_type: z.enum(["cron", "manual", "webhook", "once"]).optional(),
  cron_expr: z.string().nullable().optional(),
  run_at: z.string().datetime({ offset: true }).nullable().optional(),
  timezone: z.string().optional(),
  max_budget_usd: z.number().nullable().optional(),
  timeout_sec: z.number().int().positive().optional(),
  retry_max: z.number().int().min(0).optional(),
  retry_backoff_sec: z.number().int().min(0).optional(),
  verify: z.boolean().optional(),
  sandbox: z.enum(["off", "guard", "strict"]).optional(),
  on_success: z.string().nullable().optional(),
  on_failure: z.string().nullable().optional(),
  notify: z.enum(["all", "failures", "off"]).nullable().optional(),
  enabled: z.boolean().optional(),
};
export const NewJobSchema = z.object(jobFields);
export const PatchJobSchema = z.object(jobFields).partial();
export const BulkJobsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
  action: z.enum(["enable", "disable", "run", "delete"]),
});

// ───────────────────────────── triggers ─────────────────────────────
const triggerConditionSchema = z.object({
  path: z.string().min(1),
  op: z.enum(["equals", "contains", "regex", "gt", "lt", "exists"]),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
const triggerFields = {
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  source: z.enum(["http"]).optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  filter: z.array(triggerConditionSchema).nullable().optional(),
  job_id: id,
  inject: z.enum(["none", "goal"]).optional(),
};
export const NewTriggerSchema = z.object(triggerFields);
export const PatchTriggerSchema = z.object(triggerFields).partial();

// ───────────────────────────── watches ─────────────────────────────
// Shape only. Every real rule (owner is an executive, the check path is a GET under /api/, the
// caps on interval, expiry and count) lives in prepareWatch — one place, shared with the tests.
export const NewWatchSchema = z.object({
  owner: z.string().min(1),
  what: z.string().min(1),
  on: z.string().min(1).optional(),
  where: z.record(z.string(), z.unknown()).optional(),
  check: z.string().min(1).optional(),
  when: z.string().min(1).optional(),
  every: z.union([z.string(), z.number()]).optional(),
  at: z.string().min(1).optional(),
  say: z.string().optional(),
  one_shot: z.boolean().optional(),
  until: z.string().optional(),
  workspace_id: z.string().nullable().optional(),
});
export const PatchWatchSchema = z.object({ enabled: z.boolean() });

// ───────────────────────────── workspaces ─────────────────────────────
const workspaceFields = {
  slug: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["client", "personal"]).optional(),
  config_dir: z.string().min(1),
  account_label: z.string().nullable().optional(),
  secrets_file: z.string().nullable().optional(),
  default_dir: z.string().min(1).max(300).nullable().optional(),
  git_name: z.string().nullable().optional(),
  git_email: z.string().nullable().optional(),
  daily_budget_usd: z.number().nullable().optional(),
  max_concurrent: z.number().int().positive().nullable().optional(),
  stall_minutes: z.number().int().min(0).nullable().optional(),
  ask_remind_hours: z.number().int().min(0).nullable().optional(),
  ask_policy: z.enum(["robert", "escalate"]).nullable().optional(),
  // Stored as JSON text; accepted as a real array so a typo lands as a 400 rather than as a
  // silently-ignored capability list the agents never see (PER-28).
  capabilities: z
    .array(z.object({ name: z.string().min(1), available: z.boolean(), note: z.string().optional() }))
    .nullable()
    .optional(),
  default_backend: z.string().optional(),
  default_model: z.string().nullable().optional(),
  sandbox_mode: z.enum(["off", "guard", "strict"]).optional(),
  // Credential dirs this workspace's agents may reach despite the global secrets deny. Shape only —
  // the real gate is workspaceSandboxAllow() at spawn (must exist, must be under $HOME, never $HOME
  // itself), because this value ends up in an `allow file-write*` rule.
  sandbox_allow: z.array(z.string().min(1).max(300)).max(10).nullable().optional(),
  /** Agent CLIs this workspace may spawn. Null/omitted = all. Unknown names are dropped at read. */
  backends: z.array(z.string().min(1).max(40)).max(12).nullable().optional(),
  ticket_connector: z.string().optional(),
  connector_config: z.record(z.string(), z.unknown()).nullable().optional(),
  slack_config: z.record(z.string(), z.unknown()).nullable().optional(),
  egress_config: z.record(z.string(), z.unknown()).nullable().optional(),
  ideas_config: z.record(z.string(), z.unknown()).nullable().optional(),
  review_backend: z.string().nullable().optional(),
  review_model: z.string().nullable().optional(),
  verify_mode: z.enum(["shadow", "enforce", "strict"]).nullable().optional(),
  fallback_backend: z.string().nullable().optional(),
  fallback_model: z.string().nullable().optional(),
  route_config: z.record(z.string(), z.string()).nullable().optional(),
  auto_grade: z.boolean().optional(),
  auto_skill: z.boolean().optional(),
  skill_distill: z.boolean().optional(),
  auto_plan: z.boolean().optional(),
  auto_build: z.boolean().optional(),
  auto_review: z.boolean().optional(),
  merge_gate: z.boolean().optional(),
  live_steer: z.boolean().optional(),
  // HOSTS.md phase 5: where this workspace's headless jobs may run. null = the default (`hosts` while
  // CHRONOS_PLACEMENT=auto). `hosts+cloud` is deferred: the operator never gets a surprise cloud bill.
  placement: z.enum(["brain", "hosts"]).nullable().optional(),
  plan_panel: z.boolean().optional(),
  review_panel: z.boolean().optional(),
  review_min_difficulty: z.number().int().min(0).max(5).nullable().optional(),
  archived: z.boolean().optional(),
};
// Shared vars — one env var handed to every agent in a workspace. `hours` is the whole expiry UI:
// a number of hours from now, or null/omitted for "no expiration at all". Name/reserved-word rules
// live in the store (nameError) so the CLI and the API can't drift apart on what a legal name is.
export const NewWorkspaceVarSchema = z.object({
  name: z.string().min(1).max(128),
  value: z.string().min(1).max(8192),
  hours: z.number().positive().max(24 * 365).nullable().optional(),
});
export const PatchWorkspaceVarSchema = z
  .object({
    value: z.string().min(1).max(8192).optional(),
    // Explicit null = never expires. Absent = leave the expiry alone.
    hours: z.number().positive().max(24 * 365).nullable().optional(),
  })
  .refine((b) => b.value !== undefined || "hours" in b, { message: "nothing to change" });

export const NewWorkspaceSchema = z.object(workspaceFields);
export const PatchWorkspaceSchema = z.object(workspaceFields).partial();

export const SlackConfigSchema = z.object({
  enabled: z.boolean().optional(),
  triage: z.boolean().optional(),
});

export const EgressSchema = z.object({
  mode: z.enum(["off", "audit", "enforce"]).optional(),
  allow: z.array(z.string()).optional(),
});

// ───────────────────────────── repos ─────────────────────────────
const repoFields = {
  parent_id: nullableId.optional(),
  name: z.string().min(1),
  path: z.string().min(1),
  git_remote: z.string().nullable().optional(),
  default_branch: z.string().optional(),
  delivery: z.enum(["commit", "pr"]).optional(),
  done_criteria: z.string().nullable().optional(),
  verify_cmd: z.string().nullable().optional(),
  // Evidence gates, as JSON [{name,cmd}] — validated here so a typo can't silently disable the gate.
  gate_cmds: z
    .array(z.object({ name: z.string().min(1), cmd: z.string().min(1) }))
    .transform((g) => JSON.stringify(g))
    .nullable()
    .optional(),
  risk_paths: z
    .object({
      high: z.array(z.string()).optional(),
      med: z.array(z.string()).optional(),
      low: z.array(z.string()).optional(),
      use_defaults: z.boolean().optional(),
    })
    .transform((r) => JSON.stringify(r))
    .nullable()
    .optional(),
  human_gate: z.enum(["always", "high", "med", "never"]).optional(),
  review_min_difficulty: z.number().int().min(0).max(5).nullable().optional(),
  post_merge_cmd: z.string().nullable().optional(),
  ideas_enabled: z.boolean().optional(),
};
const repoObject = z.object(repoFields);

// `require_human` was this field before risk tiers existed, and it is baked into Robert's API notes
// and the operator's muscle memory. Keep accepting it as the two extremes rather than 400-ing a
// PATCH that used to work; an explicit human_gate always wins.
const foldRequireHuman = (body: unknown): unknown => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const { require_human, ...rest } = body as Record<string, unknown>;
  if (require_human === undefined || "human_gate" in rest) return rest;
  return { ...rest, human_gate: require_human ? "always" : "never" };
};

export const NewRepoSchema = z.preprocess(foldRequireHuman, repoObject);
export const PatchRepoSchema = z.preprocess(foldRequireHuman, repoObject.partial());

// ───────────────────────────── repo accelerators ─────────────────────────────
export const PatchAccelSchema = z
  .object({
    enabled: z.boolean().optional(),
    // Explicit null clears the mode; absent leaves it untouched (same convention as workspace vars' hours).
    mode: z.string().max(64).nullable().optional(),
  })
  .refine((b) => b.enabled !== undefined || "mode" in b, { message: "nothing to change" });

export const BuildGraphifySchema = z.object({
  session_id: z.string().max(80).nullable().optional(),
  force: z.boolean().optional(),
});

export const QueryGraphifySchema = z.object({
  question: z.string().min(1).max(1000),
  budget: z.number().int().min(100).max(2000).optional(),
  session_id: z.string().max(80).nullable().optional(),
});

// ───────────────────────────── lessons ─────────────────────────────
const lessonTopic = z.enum(["build", "review", "comms", "any"]);
export const NewLessonSchema = z.object({
  workspace_id: id,
  repo_id: nullableId.optional(),
  scope: z.string().max(160).nullable().optional(),
  topic: lessonTopic.optional(),
  rule: z.string().min(8).max(200),
  source: z.enum(["operator", "review", "gate"]).optional(),
  source_ref: z.string().nullable().optional(),
  state: z.enum(["proposed", "active", "archived"]).optional(),
});
export const PatchLessonSchema = z.object({
  rule: z.string().min(8).max(200).optional(),
  scope: z.string().max(160).nullable().optional(),
  topic: lessonTopic.optional(),
  state: z.enum(["proposed", "active", "archived"]).optional(),
  repo_id: nullableId.optional(),
});

// ───────────────────────────── skills ─────────────────────────────
export const NewSkillSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  body: z.string().optional(),
  status: z.enum(["pending", "active", "archived"]).optional(),
  source: z.enum(["agent", "operator", "distill"]).optional(),
});

export const PatchSkillSchema = z.union([
  z.object({ append: z.string().min(1), heading: z.string().optional() }),
  z.object({ old: z.string(), new: z.string() }),
]);

export const ArchiveSkillSchema = z.object({
  to: z.enum(["active", "archived"]).optional(),
});

// ───────────────────────────── ideas ─────────────────────────────
export const NewIdeaSchema = z.object({
  repo_id: nullableId.optional(),
  title: z.string().min(1),
  pitch: z.string().min(1),
  acceptance: z.string().nullable().optional(),
  kind: z.enum(IDEA_KINDS as [string, ...string[]]),
  source: z.enum(IDEA_SOURCES as [string, ...string[]]).optional(),
  source_ref: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});

// A calendar day, nothing finer: the planner files cards FOR a day, and the Desk groups by it.
export const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "for_date must be YYYY-MM-DD");
export const JOT_BODY_MAX = 20000;
export const NewJotSchema = z.object({
  title: z.string().min(1).max(400),
  body: z.string().max(JOT_BODY_MAX).nullable().optional(),
  for_date: dayString.nullable().optional(),
  // The session that filed it, when an agent did. The route stamps `source` itself from who is
  // calling — a body may not claim to be the operator.
  planned_by: id.nullable().optional(),
  // "+2d", "tomorrow 9:00", "monday", an ISO stamp — parsed by the route (src/jot-followup.ts).
  follow_up_at: z.string().max(80).nullable().optional(),
  follow_up_check: z.string().max(2000).nullable().optional(),
});
// Every field optional: the Desk autosaves one field at a time as you type, and a patch that had to
// restate the row would overwrite an edit made in another window between load and save.
export const JotPatchSchema = z.object({
  title: z.string().min(1).max(400).optional(),
  body: z.string().max(JOT_BODY_MAX).nullable().optional(),
  status: z.enum(["open", "done"]).optional(),
  for_date: dayString.nullable().optional(),
}).refine((o) => Object.keys(o).length > 0, { message: "nothing to patch" });
export const JotFollowUpSchema = z.object({
  /** When to come back — null cancels. Same grammar as `mc pad follow`. */
  at: z.string().max(80).nullable(),
  check: z.string().max(2000).nullable().optional(),
});
export const JotResolveSchema = z.object({ note: z.string().max(4000).optional() });
export const JotAppendSchema = z.object({ text: z.string().trim().min(1).max(JOT_BODY_MAX) });
// "Plan tomorrow": which clients, what the operator wants weighed in (one free-text steer per
// client, keyed by workspace id), and which day the cards are for (defaults to the next workday).
export const PlanNextDaySchema = z.object({
  workspaces: z.array(id).min(1).max(20).optional(),
  steering: z.record(z.string(), z.string().max(4000)).optional(),
  date: dayString.optional(),
  created_by: z.string().max(60).optional(),
});
export const RunJotSchema = z.object({
  backend: z.string().optional(),
  model: z.string().nullable().optional(),
  cwd: z.string().optional(),
  goal_kind: z.enum(["pr", "investigation", "qa"]).nullable().optional(),
});
export const ReorderJotsSchema = z.object({ ids: z.array(id).min(1) });
// A browser PushSubscription.toJSON(): endpoint + the two keys the push service encrypts with.
export const PushSubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(2000),
    keys: z.object({ p256dh: z.string().min(10).max(500), auth: z.string().min(5).max(200) }),
  }),
});
export const PushUnsubscribeSchema = z.object({ endpoint: z.string().url().max(2000) });

// A launch is the New-terminal dialog under a name. Everything but the name is optional: a blank
// launch is legal (a named bare terminal in a chosen folder is still worth a chip).
export const NewLaunchSchema = z.object({
  name: z.string().min(1).max(80),
  goal: z.string().max(400).nullable().optional(),
  goal_kind: z.enum(["pr", "investigation", "qa"]).nullable().optional(),
  description: z.string().max(20000).nullable().optional(),
  backend: z.string().max(40).nullable().optional(),
  model: z.string().max(80).nullable().optional(),
  cwd: z.string().max(1000).nullable().optional(),
});
export const LaunchPatchSchema = NewLaunchSchema.partial().refine((o) => Object.keys(o).length > 0, { message: "nothing to patch" });
export const ReorderLaunchesSchema = z.object({ ids: z.array(id).min(1) });
// What the Desk tells the OS when a card flips to "your turn" while the window is not in front.
export const DeskNotifySchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().max(400).optional(),
  session_id: id.nullable().optional(),
});

export const PromoteIdeaSchema = z.object({ external: z.boolean().optional() });
export const KillIdeasSchema = z.object({ ids: z.array(id).min(1) });
export const PromoteIdeasSchema = z.object({ ids: z.array(id).min(1), external: z.boolean().optional() });
export const GenerateIdeasSchema = z.object({
  feeder: z.enum(["miner", "followups", "intake"]).optional(),
  ticket_id: nullableId.optional(),
  force: z.boolean().optional(),
});

// ───────────────────────────── tickets ─────────────────────────────
export const NewTicketSchema = z.object({
  workspace_id: id,
  repo_id: nullableId.optional(),
  title: z.string().min(1),
  status: z
    .enum(["backlog", "spec", "ready", "planning", "planned", "in_progress", "review", "shipping", "blocked", "done", "dismissed"])
    .optional(),
  priority: z.string().optional(),
  complexity: z.string().nullable().optional(),
  backend: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  assignee: z.string().optional(),
  tags: z.array(z.string()).nullable().optional(),
  context: z.string().optional(),
  // Aliases for context, accepted since forever by callers and silently DROPPED until now: `mc
  // ticket new --body` has always sent `description`, and ad-hoc API callers reach for `body` —
  // zod stripped both, so every agent-filed follow-up ticket lost its content. Normalized into
  // `context` by the POST /tickets handler.
  description: z.string().optional(),
  body: z.string().optional(),
  acceptance: z.string().optional(),
  external_system: z.string().nullable().optional(),
  external_id: z.string().nullable().optional(),
  external_url: z.string().nullable().optional(),
  parent_id: nullableId.optional(),
});

export const PatchTicketSchema = z.object({
  repo_id: nullableId.optional(),
  title: z.string().optional(),
  status: z
    .enum(["backlog", "spec", "ready", "planning", "planned", "in_progress", "review", "shipping", "blocked", "done", "dismissed"])
    .optional(),
  priority: z.string().optional(),
  complexity: z.string().nullable().optional(),
  backend: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  assignee: z.string().optional(),
  file_path: z.string().optional(),
  external_system: z.string().nullable().optional(),
  external_id: z.string().nullable().optional(),
  external_url: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  pr_url: z.string().nullable().optional(),
  pr_state: z.string().nullable().optional(),
  ci_state: z.string().nullable().optional(),
  ci_checks: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  report: z.string().nullable().optional(),
});

export const TicketLinkSchema = z.object({
  to_id: id,
  type: z.enum(LINK_TYPES),
});

export const TicketNoteSchema = z.object({
  text: z.string().min(1),
  by: z.string().optional(),
  // Set by `mc note` (MC_RUN) so the response can piggyback that run's undelivered mailbox — a note
  // is a checkpoint like `mc step`, just without a run_id column of its own to key off.
  run_id: z.string().optional(),
});

export const NewBoardPostSchema = z.object({
  body: z.string().min(1).max(20000),
  // Who is speaking. The web UI omits it (→ "operator"); agents pass their id. Trusted the same
  // way TicketNoteSchema trusts `by` — localhost daemon, provenance not authentication.
  author: z.string().min(1).max(40).optional(),
  thread_root_id: id.optional(),
  ticket_id: id.optional(),
  workspace_id: id.optional(),
  kind: z.enum(["post", "heartbeat"]).optional(),
});

export const DeclareStepsSchema = z.object({
  labels: z.array(z.string().min(1).max(120)).min(1).max(30),
});

export const SetStepSchema = z.object({
  status: z.enum(["active", "done", "skipped"]),
  note: z.string().optional(),
});

// Exactly one origin: a dispatched run (`mc ask`) or a Desk terminal (`mc ask-robert`). Both is a
// caller bug, neither is an ask from nowhere — refuse both shapes rather than guessing an owner.
export const NewAskSchema = z
  .object({
    run_id: id.optional(),
    session_id: id.optional(),
    /**
     * Who gets it first. 'robert' = the overseer triages before the operator's phone rings; 'lead' =
     * the asking TERMINAL's own Lead does (`mc ask-lead`). The route is still checked at the route:
     * asking for 'lead' from a terminal with no live Lead falls back to 'robert'.
     */
    route: z.enum(["operator", "robert", "lead"]).optional(),
    question: z.string().min(1).max(500),
    options: z.array(z.string().min(1).max(80)).min(1).max(6).optional(),
    wait_min: z.number().nonnegative().optional(),
  })
  .refine((b) => !!b.run_id !== !!b.session_id, {
    message: "an ask needs exactly one of run_id (a dispatched run) or session_id (a terminal)",
  });

export const ClaimWorktreeSchema = z.object({
  /** Repo by name, id or path — the agent knows it by whatever the task called it. */
  repo: z.string().min(1).max(300),
  /** The agent's name for the work — `fix/desk-scrollbar` or free text. Without it the goal names the branch. */
  as: z.string().max(120).optional(),
});

export const RemoveWorktreeSchema = z.object({
  path: z.string().min(1).max(500),
  /** Overrides the uncommitted/unpushed guards. Never overrides "a terminal is working in there". */
  force: z.boolean().optional(),
  /** The caller's MC_SESSION. Without the admin token, the only tree you may remove is the one it claimed. */
  session: z.string().min(1).max(100).optional(),
});

export const ClipboardSchema = z.object({
  text: z.string().min(1).max(100_000),
  by: z.string().max(60).optional(),
});

export const EscalateAskSchema = z.object({
  /** Robert's reason + recommended answer, shown on the operator's card. */
  note: z.string().min(1).max(600).optional(),
});

/** A standing watch on one terminal. `every_min: null` lifts it. */
export const WatchSchema = z.object({
  every_min: z.union([z.number().positive(), z.string().min(1).max(16), z.null()]),
  note: z.string().max(300).nullish(),
  by: z.string().max(60).optional(),
});

/**
 * "Later" on an ask / review / recovery item. `until` takes the watches.ts grammar (`+2h`, `+48h`,
 * `+2d`, or an ISO date); null lifts the hold. A reason is optional and is dropped with the date.
 */
export const HoldSchema = z.object({
  // Required, not optional: an empty body must never read as "lift the hold" by accident. `null` is
  // the explicit unhold.
  until: z.union([z.string().min(1).max(40), z.null()]),
  reason: z.string().max(400).nullable().optional(),
});

export const AnswerAskSchema = z.object({
  answer: z.string().min(1).max(1000),
  by: z.string().optional(),
});

/**
 * `mc report` — a worker's structured hand-back to its Lead (LEADS.md). Capped hard: this is read on
 * one screen beside five siblings', and a worker that pastes its whole transcript into `--tests`
 * makes the inbox as unreadable as the scrollback the report exists to replace.
 */
export const ReportSchema = z.object({
  state: z.enum(["done", "partial", "blocked"]),
  summary: z.string().min(1).max(2000),
  // http(s) only, and a handful: a PR list is what the Lead clicks, not a place to file notes.
  prs: z.array(z.string().url().max(500).refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL")).max(5).optional(),
  tests: z.string().max(1000).nullable().optional(),
  verified: z.string().max(1000).nullable().optional(),
  question: z.string().max(1000).nullable().optional(),
  next: z.string().max(1000).nullable().optional(),
});

/** `mc lead broadcast` — one sentence to several of this Lead's workers at once. */
export const LeadBroadcastSchema = z.object({
  text: z.string().min(1).max(4000),
  /** id8s. `only` is an allowlist, `except` a denylist; both are filtered against this Lead's own workers. */
  only: z.array(z.string().min(4).max(64)).max(50).optional(),
  except: z.array(z.string().min(4).max(64)).max(50).optional(),
});

/** `mc lead adopt <leadId>` — take an ended Lead's live workers + board + inbox. */
export const LeadAdoptSchema = z.object({
  lead_id: z.string().min(4).max(64),
});

/** `mc lead board add "title"` — one slice of the goal. */
export const BoardAddSchema = z.object({ title: z.string().min(1).max(300) });

/** `mc lead board set <n> …` — only what was passed moves; `null` clears a field. */
export const BoardPatchSchema = z.object({
  status: z.enum(["todo", "doing", "review", "done", "dropped"]).optional(),
  session_id: z.string().min(1).max(64).nullable().optional(),
  pr_url: z.string().max(500).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
  title: z.string().min(1).max(300).optional(),
});

export const NewMessageSchema = z.object({
  to: z.string().min(1).max(80),
  text: z.string().min(1).max(2000),
  from: z.string().optional(),
});

export const PushCommentSchema = z.object({ body: z.string().min(1) });

export const PushStatusSchema = z.object({ hours: z.number().positive().optional() });

export const PushHoursSchema = z.object({ hours: z.number().positive() });

export const DispatchTicketSchema = z.object({
  backend: z.string().optional(),
  model: z.string().optional(),
});

export const SetPlanSchema = z.object({
  markdown: z.string().min(1),
  status: z
    .enum(["backlog", "spec", "ready", "planning", "planned", "in_progress", "review", "shipping", "blocked", "done", "dismissed"])
    .optional(),
  complexity: z.string().optional(),
  difficulty: z.union([z.string(), z.number()]).optional(),
});

export const GradeSchema = z.object({
  difficulty: z.union([z.string(), z.number()]),
  note: z.string().optional(),
});

export const NewAttachmentSchema = z.object({
  data_base64: z.string().min(1),
  filename: z.string().optional(),
  mime: z.string().optional(),
  caption: z.string().nullable().optional(),
  source: z.string().optional(),
});

// ───────────────────────────── reviews ─────────────────────────────
export const ReviewNotesSchema = z.object({ notes: z.string().nullable().optional() });
export const ReviewVerdictSchema = z.object({
  decision: z.enum(["approve", "changes"]),
  notes: z.string().nullable().optional(),
  // Which lens is voting, when the review was dispatched to a panel (panels.ts). Absent = the
  // single-reviewer path, unchanged.
  lens: z.string().max(40).nullable().optional(),
});

// ───────────────────────────── calendars ─────────────────────────────
export const NewCalendarSchema = z
  .object({
    workspace_id: nullableId.optional(),
    name: z.string().min(1),
    source: z.enum(["ics", "gws", "local"]).optional(),
    ics_url: z.string().optional(),
    account: z.string().nullable().optional(),
    config_dir: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
  })
  .refine((v) => v.source === "gws" || !!v.ics_url, {
    message: "ics_url required (or source:'gws')",
    path: ["ics_url"],
  });

export const PatchCalendarSchema = z.object({
  workspace_id: nullableId.optional(),
  color: z.string().nullable().optional(),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
});

const localCalEventSchema = z.object({
  uid: z.string().nullable().optional(),
  title: z.string().optional(),
  start: z.string().optional(),
  end: z.string().nullable().optional(),
  all_day: z.boolean().optional(),
  location: z.string().nullable().optional(),
});
export const CalendarIngestSchema = z.object({
  workspace_id: nullableId.optional(),
  calendars: z
    .array(
      z.object({
        name: z.string().optional(),
        account: z.string().min(1),
        color: z.string().nullable().optional(),
        events: z.array(localCalEventSchema).optional(),
      }),
    )
    .optional(),
});
export const ImportLocalCalendarsSchema = z.object({ workspace_id: nullableId.optional() });

// ───────────────────────────── misc ─────────────────────────────
export const OpenUrlSchema = z.object({
  url: z.string().regex(/^https?:\/\/[^\s"']+$/, "invalid url"),
});

export const HeartbeatSchema = z.object({
  kind: z.enum(["morning", "hourly", "evening", "now", "standup"]).optional(),
  /** Run one executive or the whole fleet (default: robert for kind=now legacy). */
  agent: z.enum(["robert", "fleet"]).optional(),
});

// ws = the Flow workspace selection; picks the Claude profile the manager runs on (absent = operator's own).
// `ws` = the client's workspace selector (an explicit pick always wins). Absent/null hands the turn
// to the thread router (src/thread-router.ts); `route: false` opts out of it for a caller that means
// the unscoped fleet manager literally. `surface` names the visible thread whose sticky workspace is
// read and written; `session` is the terminal the client has on screen, the router's weakest signal.
export const AgentTextSchema = z.object({
  text: z.string().trim().min(1),
  ws: z.string().nullish(),
  route: z.boolean().optional(),
  surface: z.string().trim().max(24).optional(),
  session: z.string().trim().max(64).nullish(),
  /** The page that sent it (a random id per tab), so only THAT page skips drawing the line it already drew. */
  client: z.string().trim().max(64).optional(),
  /** Sent from the Desk voice call: the reply is read aloud, so Robert answers short and spoken. */
  voice: z.boolean().optional(),
  /** Files already uploaded to POST /agent/attach, riding this turn. Ids only — the server rebuilds
   *  the paths it hands the model from its own rows, so a client cannot name a path to be Read. */
  attachments: z.array(z.object({ id: z.string().trim().min(1).max(64) })).max(10).optional(),
});
export const SpeakSchema = z.object({ text: z.string().trim().min(1).max(4000), lang: z.enum(["en", "es"]).optional() });
export const ThreadStickySchema = z.object({ ws: z.string().nullish(), surface: z.string().trim().max(24).optional() });
export const AgentWarmSchema = z.object({ ws: z.string().nullish() });

// Web chat model picker. Enum, not free text — the value becomes a --model argv for the manager CLI.
export const AGENT_MODELS = ["opus", "sonnet", "fable", "haiku"] as const;
export const AgentModelSchema = z.object({ model: z.enum(AGENT_MODELS) });

// The Desk footer's quick actions (src/quick-actions.ts), stored whole under one kv key. The list is
// replaced on every save rather than patched: it is short, the operator reorders it by dragging rows
// around in a dialog, and a per-row API would need ids that nothing else in the feature wants.
export const QuickActionSchema = z.object({
  label: z.string().trim().min(1).max(MAX_LABEL),
  // Empty for the kinds that type nothing (changes, kill) — a required text would force placeholders.
  text: z.string().max(MAX_TEXT).default(""),
  kind: z.enum(QA_KINDS).default("text"),
  phases: z.array(z.enum(QA_PHASES)).max(QA_PHASES.length).default([]),
  key: z.number().int().min(1).max(9).nullable().default(null),
});
export const QuickActionsSchema = z.object({
  actions: z.array(QuickActionSchema).max(MAX_QUICK_ACTIONS),
});

// ───────────────────────────── hosts (HOSTS.md) ─────────────────────────────
/**
 * `PATCH /api/hosts/:id` — the Desk's Computers panel. `policy.deny` is the brain-side placement
 * policy (workspace ids or slugs this computer may not run); the host's own veto is separate and
 * not editable from here. `status` is the operator's half of the column: drain, pause (disabled),
 * or back to taking work ("online" — stored as offline until its link is up). Revoking is DELETE.
 */
export const HostPatchSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(64).regex(/^[\w.\- ]+$/, "letters, digits, space, dot, dash, underscore").optional(),
    policy: z.strictObject({ deny: z.array(z.string().trim().min(1).max(128)).max(500) }).optional(),
    status: z.enum(["online", "draining", "disabled"]).optional(),
    reserve: z.record(z.string().min(1).max(32), z.number().min(0).max(1_000_000)).nullable().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "nothing to change" });

// The workspace inbox (src/inbox.ts). What `mc inbox add` posts — the Slack triage filing a DM,
// @mention or self-note. Tracker rows never come through here; the connector sync files those itself.
export const NewInboxItemSchema = z.object({
  source: z.enum(["slack", "jira", "clickup"]).default("slack"),
  kind: z.enum(["dm", "mention", "self_note", "assigned", "comment", "status"]),
  key: z.string().trim().min(1).max(300),
  title: z.string().trim().min(1).max(500),
  why: z.string().trim().max(1000).optional(),
  body: z.string().max(8000).optional(),
  url: z.string().trim().max(1000).optional(),
  actor: z.string().trim().max(200).optional(),
  ref: z.string().trim().max(120).optional(),
  urgent: z.boolean().optional(),
});
// Snooze until — same grammar as `mc pad follow`: 2h, +1d, tomorrow 9:00, monday 10, an ISO stamp.
export const InboxSnoozeSchema = z.object({ until: z.string().trim().min(1).max(80) });
