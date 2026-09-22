import { CONFIG } from "../config.js";
import type { Job } from "../types.js";
import { CREDIT_WALL_RE, jsonLine, type AgentBackend, type NormalizedEvent, type OneShotOpts, type RateLimit, type RunResult, type SpawnSpec } from "./types.js";

// Flags shared by buildArgs and steerArgs — everything AFTER the prompt/session/permissions core.
function flagTail(job: Job): string[] {
  const args: string[] = [];
  if (job.allowed_tools) args.push("--allowed-tools", job.allowed_tools);
  if (job.disallowed_tools) args.push("--disallowed-tools", job.disallowed_tools);
  args.push("--model", job.model || CONFIG.defaultModel);
  if (job.append_system) args.push("--append-system-prompt", job.append_system);
  if (job.max_budget_usd != null) args.push("--max-budget-usd", String(job.max_budget_usd));
  if (job.add_dirs) {
    try {
      for (const d of JSON.parse(job.add_dirs) as string[]) args.push("--add-dir", d);
    } catch {}
  }
  return args;
}

// Claude Code headless. Profile/account isolation via CLAUDE_CONFIG_DIR (set by the runner).
export const claudeBackend: AgentBackend = {
  name: "claude-code",
  capabilities: { toolAllowlist: true, mcp: true },
  supportsResume: true,
  headlessResume: true,
  appendsSystem: true,
  models: ["sonnet", "opus", "fable", "haiku"],
  bin: () => CONFIG.claudeBin,

  buildArgs(job: Job, sessionId: string, context: string | null, resumeSessionId?: string | null): string[] {
    const goal = context
      ? `${job.goal}\n\n--- Trigger context (the event that fired this run) ---\n${context}`
      : job.goal;
    const args = [
      "-p",
      goal,
      "--output-format",
      "stream-json",
      "--verbose",
      // --resume reopens the SAME transcript (an answered `mc ask` continuing the worker's prior
      // conversation); --session-id pins a fresh chat. Mutually exclusive — never both.
      ...(resumeSessionId ? ["--resume", resumeSessionId] : ["--session-id", sessionId]),
      // Unattended autonomy — the macOS Seatbelt sandbox is the real boundary (see sandbox.ts).
      "--dangerously-skip-permissions",
    ];
    args.push(...flagTail(job));
    return args;
  },

  // Steer-enabled spawn: print mode with streaming input — NO goal in argv; the runner writes it
  // as the first stdin message and can push more mid-run. One result event per user message.
  steerArgs(job: Job, sessionId: string, resumeSessionId?: string | null): string[] {
    return [
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      ...(resumeSessionId ? ["--resume", resumeSessionId] : ["--session-id", sessionId]),
      "--dangerously-skip-permissions",
      ...flagTail(job),
    ];
  },

  encodeSteer(text: string): string {
    return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
  },

  oneShot({ prompt, system, model, configDir, resumeSessionId, allowedTools, maxBudgetUsd, mcpConfig, inheritProfileMcp }: OneShotOpts): SpawnSpec {
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
    if (system) args.push("--append-system-prompt", system);
    if (allowedTools !== undefined) args.push("--allowed-tools", allowedTools);
    // strict by default (same as the warm path): only the bundle asked for here loads, never
    // whatever the profile dir happens to have configured. inheritProfileMcp is Robert's exception.
    if (mcpConfig) args.push("--mcp-config", mcpConfig);
    if (!inheritProfileMcp) args.push("--strict-mcp-config");
    if (maxBudgetUsd != null) args.push("--max-budget-usd", String(maxBudgetUsd));
    args.push("--dangerously-skip-permissions");
    if (model) args.push("--model", model);
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    return { cmd: CONFIG.claudeBin, args, env: { CLAUDE_CONFIG_DIR: configDir } };
  },

  pinsSession: true,
  interactiveArgs(model: string | null, appendSystem?: string | null, addDirs?: string[], sessionId?: string | null, resume?: boolean): string[] {
    // Skip the trust-folder + per-tool permission prompts so a ticket terminal boots straight to the
    // chat and the seeded task lands in the input (not swallowed by a prompt). Sandbox is the real
    // boundary (see sandbox.ts), same as the headless path.
    // --no-chrome: the operator's profile has Claude-in-Chrome on by default, which makes every Desk
    // terminal pop a Chrome window at boot. A wall of agents must not open browsers on the desktop.
    const a: string[] = ["--dangerously-skip-permissions", "--no-chrome"];
    if (model) a.push("--model", model);
    if (appendSystem) a.push("--append-system-prompt", appendSystem);
    for (const d of addDirs ?? []) a.push("--add-dir", d); // reach sibling repos in the workspace
    // Pin the transcript to the Chronos session id so Focus can locate it (focus.ts). --resume reopens
    // the SAME id's transcript (continues the conversation); --session-id needs a fresh id (new chat).
    if (sessionId) a.push(resume ? "--resume" : "--session-id", sessionId);
    return a;
  },

  env(_job, configDir) {
    return { CLAUDE_CONFIG_DIR: configDir };
  },

  parseLine: jsonLine,

  extractResult(ev: NormalizedEvent): RunResult | null {
    const p = ev.payload;
    if (ev.type !== "result") return null;
    return {
      num_turns: p.num_turns ?? null,
      cost_usd: p.total_cost_usd ?? null,
      tokens_in: p.usage?.input_tokens ?? null,
      tokens_out: p.usage?.output_tokens ?? null,
      tokens_cache_read: p.usage?.cache_read_input_tokens ?? null,
      tokens_cache_write: p.usage?.cache_creation_input_tokens ?? null,
      usage_cumulative: true,
      is_error: !!p.is_error,
      summary: typeof p.result === "string" ? p.result.slice(0, 4000) : null,
      result_text: typeof p.result === "string" ? p.result : null,
    };
  },

  detectRateLimit(ev: NormalizedEvent): RateLimit | null {
    const p = ev.payload;
    if (ev.type === "rate_limit_event") {
      const info = p.rate_limit_info ?? {};
      if (info.status === "rejected" || info.overageStatus === "rejected" || info.overageDisabledReason)
        return { rateLimited: true, resetsAt: typeof info.resetsAt === "number" ? info.resetsAt : null };
    }
    if (ev.type === "result" && p.api_error_status === 429) return { rateLimited: true };
    // A credit wall arrives as a plain error result (no rate_limit_event, no 429). Unflagged it ended
    // the run "failed" and the retry loop re-hit the same wall instead of the workspace fallback.
    if (ev.type === "result" && p.is_error && typeof p.result === "string" && CREDIT_WALL_RE.test(p.result))
      return { rateLimited: true, resetsAt: null };
    return null;
  },
};
