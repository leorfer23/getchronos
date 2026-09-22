import type { Job } from "../types.js";

// One streamed line normalized to a stored event. `type` drives UI rendering + search extraction.
export interface NormalizedEvent {
  type: string;
  payload: any;
}

// Terminal-result fields mapped onto the shared `runs` columns (backend-agnostic).
export interface RunResult {
  num_turns?: number | null;
  cost_usd?: number | null;
  /** True when cost_usd is token-table arithmetic, not a vendor total. */
  cost_estimated?: boolean;
  tokens_in?: number | null;
  tokens_out?: number | null;
  tokens_cache_read?: number | null;  // prompt-cache reads (cheap) — cache-health telemetry
  tokens_cache_write?: number | null; // prompt-cache writes (1.25x) — big writes + tiny reads = churn
  // True when this event's usage/cost covers the WHOLE invocation so far, not just this step.
  // The runner ASSIGNS such totals instead of summing them — claude reports cumulative usage, so
  // summing across multiple result events (one per user message, once steering lands) would
  // double-count. opencode's per-step results leave this unset and keep summing.
  usage_cumulative?: boolean;
  is_error?: boolean;
  summary?: string | null;
  result_text?: string | null;
}

/**
 * A provider out of credits for this model/account, as the CLIs word it — "out of credits", Fable's
 * "You're out of usage credits. Switch to another model to continue.", "insufficient balance".
 * One pattern for the job runner (backends), the quota gate and the warm-manager fallback, so a
 * vendor rewording is fixed once: "out of credits?" alone missed "out of usage credits".
 */
export const CREDIT_WALL_RE =
  /out of (?:[\w-]+\s+)?credits?\b|usage credits|insufficient[_ ](?:balance|credits?)|credit balance|switch to (?:another|a different) model/i;

export interface RateLimit {
  rateLimited: boolean;
  resetsAt?: number | null; // unix seconds
}

// A single non-interactive prompt run whose plain-text answer is the goal (verifier verdicts,
// session titles/summaries, the Telegram conversational agent). Spec only — the caller spawns.
export interface OneShotOpts {
  prompt: string;
  system?: string;
  model?: string | null; // null → backend default (omit model flag)
  configDir: string;
  cwd?: string;
  timeoutMs?: number;
  resumeSessionId?: string | null; // ignored by backends where supportsResume is false
  allowedTools?: string; // e.g. "Read,Bash" — tool guardrail; honored where capabilities.toolAllowlist
  maxBudgetUsd?: number; // per-run spend cap (claude only)
  // JSON for the CLI's MCP config (AgentDef.mcp). Honored where capabilities.mcp; ignored elsewhere,
  // so a caller passes the agent's declared bundle unconditionally and asks the backend what landed.
  mcpConfig?: string;
  // Robert only: load the config dir's own MCP servers (drop --strict-mcp-config), because a remote
  // server's OAuth token lives in that dir and no bundle can carry it. See WarmOpts.inheritProfileMcp.
  inheritProfileMcp?: boolean;
}

export interface SpawnSpec {
  cmd: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * What a backend can actually honor from an agent's declaration. An agent IS its AGENT.md — persona,
 * tools, MCP bundle — and that declaration must not quietly mean different things per vendor. A
 * caller passes everything the agent declares and reads this to learn what the CLI dropped, so the
 * gap can be stated (to the agent, and to the operator) instead of silently changing who it is.
 * Absent/false = not supported.
 */
export interface BackendCapabilities {
  /** CLI can restrict the tool set for this run (claude --allowed-tools). */
  toolAllowlist?: boolean;
  /** CLI can load an MCP server bundle for this run (claude --mcp-config). */
  mcp?: boolean;
}

/**
 * Where a backend's work actually runs.
 *
 * "local" (the default, and what every backend before cursor-cloud is) = a child process on this
 * machine: the runner spawns it, reads its stdout and owns its lifetime. "cloud" = the provider
 * hosts the VM; Chronos only launches, stores the ids and RECONCILES. The distinction is load
 * bearing in exactly one place — the runner must branch before it tries to spawn a binary that
 * does not exist — and advisory everywhere else (the Desk picker badges it ☁).
 */
export type BackendKind = "local" | "cloud";

/** Provider-side status of one cloud run, normalised across vendors. */
export type CloudStatus = "running" | "finished" | "error" | "cancelled" | "expired";

/**
 * Which cloud run we are talking about. `workspaceId` is not decoration: the provider key lives in
 * that workspace's vars (CURSOR_API_KEY), and a reconcile waking up hours later has nothing else to
 * resolve it from — reading it from daemon env alone would silently use the wrong account.
 */
export interface CloudRef {
  agentId: string;
  runId: string;
  workspaceId: string | null;
}

/** What a launch (or a follow-up turn) hands back — the ids Chronos must persist before anything else. */
export interface CloudLaunch {
  agentId: string;
  /** The run id of THIS turn. A follow-up mints a new one; the old one stays in run_events. */
  runId: string;
  /** Human link to the run on the provider's site, for the Desk card. */
  url: string | null;
  status: CloudStatus;
}

/** One poll of a cloud run. `result`/`branches` only mean anything once `status` is terminal. */
export interface CloudRunState {
  status: CloudStatus;
  /** The agent's final answer — becomes runs.summary, which merge-gate parses its verdict from. */
  result: string | null;
  durationMs: number | null;
  branches: Array<{ repoUrl: string; branch: string; prUrl: string | null }>;
  error: string | null;
}

/**
 * Vendor-billed usage for one cloud run. Every field is the provider's own total, so the runner
 * stores it with `cost_estimated: false` — unlike a local run, there is no token-table arithmetic.
 */
export interface CloudUsage {
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  cost_usd: number | null;
}

/**
 * One frame off the event stream, already normalised. `eventId` is the resume cursor the runner
 * persists (runs.cloud_last_event_id) so a Mac that slept mid-run replays from there instead of
 * from the beginning. `event: null` = a frame with nothing worth storing (heartbeat, keepalive).
 */
export interface CloudFrame {
  eventId: string | null;
  event: NormalizedEvent | null;
  /** result/done/error — stop reading and go finalise via getRun + usage. */
  terminal: boolean;
}

/** Everything a launch needs that is not already on the Job row. */
export interface CloudLaunchOpts {
  job: Job;
  runId: string;
  /** Trigger-event payload, folded into the prompt exactly as a local run folds it. */
  context: string | null;
  /**
   * Stable per-run key. A dispatch that is retried after a timeout MUST NOT launch the work twice —
   * the provider rejects the second launch on this key instead of billing for a duplicate VM.
   */
  idempotencyKey: string;
  /** GitHub https urls. The first is the work repo; the rest are read-only add_dirs. */
  repos: Array<{ url: string; startingRef?: string | null }>;
  /** delivery=pr → open a draft PR on a fresh branch. Phase 1 refuses anything else. */
  autoCreatePr: boolean;
  /** Provider-side display name (ticket key / job name), truncated by the backend. */
  name?: string | null;
}

/**
 * A backend whose runs live on someone else's VM.
 *
 * The whole point is that Chronos may be OFF while the work happens: launch persists ids, the
 * stream is an optimisation for live rendering, and `getRun` + `usage` are the source of truth that
 * a reconciler can reach for at any later time. Nothing here may assume a live process, a pty, a
 * cwd, or that the same daemon instance that launched the run is the one that finishes it.
 *
 * `buildArgs`/`oneShot`/`interactiveArgs` are inherited but MUST throw: the runner branches on
 * `kind === "cloud"` before it reaches them, and a silent fallthrough would spawn a binary that
 * does not exist and report the ENOENT as the agent failing.
 */
export interface CloudBackend extends AgentBackend {
  kind: "cloud";
  launch(opts: CloudLaunchOpts): Promise<CloudLaunch>;
  /** Replay + live tail from `lastEventId` (null = from the start of the run). */
  stream(ref: CloudRef, lastEventId: string | null, signal?: AbortSignal): AsyncIterable<CloudFrame>;
  getRun(ref: CloudRef): Promise<CloudRunState>;
  usage(ref: CloudRef): Promise<CloudUsage>;
  /** Steering (`mc tell`): a new turn on the SAME agent, so it keeps its context and its branch. */
  followup(ref: CloudRef, text: string): Promise<CloudLaunch>;
  cancel(ref: CloudRef): Promise<void>;
}

export function isCloudBackend(b: AgentBackend | null | undefined): b is CloudBackend {
  return !!b && (b as any).kind === "cloud";
}

// A pluggable coding-agent CLI. Adding a new harness = one module implementing this + a registry line.
export interface AgentBackend {
  name: string;
  /** See BackendKind. Omitted → "local": the runner spawns bin() as a child process. */
  kind?: BackendKind;
  /** See BackendCapabilities. Omitted → the backend honors neither. */
  capabilities?: BackendCapabilities;
  bin(): string; // resolved binary path/name
  models?: string[]; // selectable models (advisory, for UI)
  supportsResume: boolean;
  // True when interactiveArgs() honors sessionId: the CLI's transcript is stored under that id, so
  // Focus finds it by id and a revive reopens the same conversation (claude, cursor).
  pinsSession?: boolean;
  // True when the CLI files a pinned transcript under the directory it was started in (cursor), so a
  // resume must start in that same directory or it opens an empty chat under the same id.
  transcriptPerCwd?: boolean;
  // True only when buildArgs() actually CONSUMES resumeSessionId (claude --resume). supportsResume
  // covers oneShot/interactive resume too — codex resumes in oneShot but its headless buildArgs
  // drops the id, so gating a headless resume on supportsResume alone records a session the CLI
  // never opened and skips the replay fallback. Unset/false → resume dispatches take the
  // replayed-transcript path (replay.ts).
  headlessResume?: boolean;
  // False = interactive-only (no JSONL headless). Rate-limit fallback opens a terminal instead of re-dispatch.
  // Undefined/true = headless via buildArgs works (claude, cursor, codex, …).
  supportsHeadless?: boolean;
  // True if interactiveArgs() can carry standing system text (e.g. claude --append-system-prompt).
  // When false, the caller folds that text into the typed seed instead (e.g. cursor).
  appendsSystem?: boolean;
  // resumeSessionId: set when this run continues a prior conversation (answered `mc ask`) — the
  // backend should reopen that transcript (claude: --resume) instead of starting a fresh sessionId.
  // Ignored by backends that don't implement resume (supportsResume: false) or don't yet wire it.
  buildArgs(job: Job, sessionId: string, context: string | null, resumeSessionId?: string | null): string[];
  // Mid-run steering (both or neither): the CLI accepts additional user messages over stdin while a
  // headless run is in flight. steerArgs replaces buildArgs for a steer-enabled spawn — the goal is
  // NOT in argv; the runner writes it as the first stdin message (encodeSteer) and may inject more
  // later (`mc tell` → steerRun). The CLI emits one result event per user message, and the runner
  // closes stdin once every sent message has its result — that close is what ends the run.
  steerArgs?(job: Job, sessionId: string, resumeSessionId?: string | null): string[];
  // One stdin line (newline-terminated) carrying a user message in the CLI's streaming input format.
  encodeSteer?(text: string): string;
  // Spec for a one-shot text-answer run (see OneShotOpts). Pure builder — no spawning.
  oneShot(opts: OneShotOpts): SpawnSpec;
  // Args to launch the CLI in INTERACTIVE (TTY/REPL) mode for a terminal session — no `-p`. The seed
  // prompt (ticket context) is written to the pty after spawn, not passed here. Omitted → bare bin.
  // addDirs: extra directories the agent may read/write beyond cwd (e.g. sibling repos in the same
  // workspace) — claude and cursor map these to --add-dir. Backends that ignore it (codex) just don't.
  interactiveArgs?(model: string | null, appendSystem?: string | null, addDirs?: string[], sessionId?: string | null, resume?: boolean): string[];
  // Extra env merged onto the spawn (e.g. CLAUDE_CONFIG_DIR, CURSOR_API_KEY).
  env(job: Job, configDir: string): Record<string, string>;
  parseLine(line: string): NormalizedEvent;
  extractResult(ev: NormalizedEvent): RunResult | null;
  /**
   * One chunk of the agent's answer, for backends that stream it as deltas instead of handing it
   * over whole in the terminal event. The runner concatenates these and uses the result when
   * `extractResult` returns no `result_text` — so a backend only has to implement ONE of the two.
   *
   * This is not cosmetic. `runs.summary` is what merge-gate parses its APPROVE/HOLD verdict from and
   * what the LLM-judge verifier reads: a backend with no summary silently loses every decision it
   * makes. grok did, for all 34 of its successful runs, and every merge gate it ran held a clean PR
   * open forever with "run finished without a MERGE-GATE verdict line".
   */
  textDelta?(ev: NormalizedEvent): string | null;
  detectRateLimit(ev: NormalizedEvent): RateLimit | null;
  // Auth (optional): backends needing an interactive/CLI login implement these so MC can detect a
  // missing session and drive the login flow in-app. Omitted → assumed always authenticated.
  checkAuth?(): Promise<boolean>;
  login?(): Promise<{ ok: boolean; message?: string }>;
}

export function jsonLine(line: string): NormalizedEvent {
  try {
    const p = JSON.parse(line);
    return { type: p.type ?? "raw", payload: p };
  } catch {
    return { type: "raw", payload: { type: "raw", text: line } };
  }
}
