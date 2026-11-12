import { execFile } from "node:child_process";
import { CONFIG } from "../config.js";
import { childEnv } from "../child-env.js";
import { claudeDenyArgs, NO_SEND_RULE } from "../no-send.js";
import { workspaces } from "../store/workspaces.js";
import { claudeHomeEnv, withClaudeHome } from "../parity-env.js";
import type { Job } from "../types.js";
import { CREDIT_WALL_RE, jsonLine, type AgentBackend, type NormalizedEvent, type OneShotOpts, type RateLimit, type RunResult, type SpawnSpec } from "./types.js";

/** What `claude auth status` says about one config dir. null = could not tell. Never the account itself. */
export type ClaudeAuth = { loggedIn: boolean | null; detail: string | null };

/**
 * Read `claude auth status --json` output. Only `loggedIn` and the plan are kept: the same JSON
 * carries the account's email, org id and org name, and none of that may leave this function — it
 * ends up in the Desk, in setup's terminal output and in logs. Anything that does not parse is
 * "can't tell", never "logged out".
 */
export function claudeAuthFrom(stdout: string): ClaudeAuth {
  let j: any;
  try {
    j = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
  } catch {
    return { loggedIn: null, detail: null };
  }
  if (typeof j?.loggedIn !== "boolean") return { loggedIn: null, detail: null };
  if (!j.loggedIn) return { loggedIn: false, detail: null };
  const plan = typeof j.subscriptionType === "string" && /^[a-z0-9_-]{1,20}$/i.test(j.subscriptionType) ? j.subscriptionType : null;
  if (j.authMethod === "claude.ai") return { loggedIn: true, detail: plan ? `Claude ${plan[0].toUpperCase()}${plan.slice(1)} subscription` : "claude.ai subscription" };
  if (typeof j.apiProvider === "string" && j.apiProvider !== "firstParty" && /^[a-z0-9_-]{1,20}$/i.test(j.apiProvider)) return { loggedIn: true, detail: `${j.apiProvider} account` };
  return { loggedIn: true, detail: /key|console/i.test(String(j.authMethod ?? "")) ? "Anthropic API key" : null };
}

// Per config dir, 30 s: GET /backends/claude-code/auth and the Desk's setup panel both poll, and each
// answer is a process spawn. `fresh` skips it (a sign-in in progress polls for the flip).
const authCache = new Map<string, { at: number; value: Promise<ClaudeAuth> }>();
const AUTH_TTL_MS = 30_000;

/**
 * Is claude logged in for `configDir`, asked the way a spawn asks: the home parity-env.ts gives that dir
 * (CLAUDE_CONFIG_DIR for a named profile, none for a default profile on the person's own setup)
 * and the environment an agent gets (childEnv). claude keeps one login per config dir — on macOS a
 * keychain item named after a hash of the dir — so a login made in a plain terminal is not
 * necessarily the one an agent spawned with CLAUDE_CONFIG_DIR=~/.claude reads, and a check without
 * the variable would say ✓ while every agent hit "not logged in".
 */
export function claudeAuthStatus(
  configDir: string,
  o: { bin?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; fresh?: boolean } = {},
): Promise<ClaudeAuth> {
  const bin = o.bin ?? CONFIG.claudeBin;
  const key = `${bin}\0${configDir}`;
  const hit = authCache.get(key);
  if (!o.fresh && hit && Date.now() - hit.at < AUTH_TTL_MS) return hit.value;
  const value = new Promise<ClaudeAuth>((resolve) => {
    execFile(
      bin,
      ["auth", "status", "--json"],
      { encoding: "utf8", timeout: o.timeoutMs ?? 10_000, env: withClaudeHome(o.env ?? childEnv(null), configDir) },
      // Logged out exits 1 with the JSON still on stdout, so the exit code alone means nothing here.
      (_err, stdout) => resolve(claudeAuthFrom(String(stdout ?? ""))),
    );
  });
  authCache.set(key, { at: Date.now(), value });
  return value;
}

// Flags shared by buildArgs and steerArgs — everything AFTER the prompt/session/permissions core.
function flagTail(job: Job): string[] {
  const args: string[] = [];
  if (job.allowed_tools) args.push("--allowed-tools", job.allowed_tools);
  // No agent ever sends (no-send.ts): the job's own denies ride in the same single flag.
  args.push(...claudeDenyArgs(job.disallowed_tools));
  args.push("--model", job.model || CONFIG.defaultModel);
  args.push("--append-system-prompt", [NO_SEND_RULE, job.append_system].filter(Boolean).join("\n\n"));
  if (job.max_budget_usd != null) args.push("--max-budget-usd", String(job.max_budget_usd));
  if (job.add_dirs) {
    try {
      for (const d of JSON.parse(job.add_dirs) as string[]) args.push("--add-dir", d);
    } catch {}
  }
  return args;
}

// Claude Code headless. Profile/account isolation via CLAUDE_CONFIG_DIR (parity-env.ts decides it).
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
    args.push(...claudeDenyArgs()); // a one-shot helper reads untrusted text: it must not be able to send either
    if (model) args.push("--model", model);
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    return { cmd: CONFIG.claudeBin, args, env: claudeHomeEnv(configDir) };
  },

  pinsSession: true,
  interactiveArgs(model: string | null, appendSystem?: string | null, addDirs?: string[], sessionId?: string | null, resume?: boolean): string[] {
    // Skip the trust-folder + per-tool permission prompts so a ticket terminal boots straight to the
    // chat and the seeded task lands in the input (not swallowed by a prompt). Sandbox is the real
    // boundary (see sandbox.ts), same as the headless path.
    // --no-chrome: the operator's profile has Claude-in-Chrome on by default, which makes every Desk
    // terminal pop a Chrome window at boot. A wall of agents must not open browsers on the desktop.
    const a: string[] = ["--dangerously-skip-permissions", "--no-chrome", ...claudeDenyArgs()];
    if (model) a.push("--model", model);
    if (appendSystem) a.push("--append-system-prompt", appendSystem);
    for (const d of addDirs ?? []) a.push("--add-dir", d); // reach sibling repos in the workspace
    // Pin the transcript to the Chronos session id so Focus can locate it (focus.ts). --resume reopens
    // the SAME id's transcript (continues the conversation); --session-id needs a fresh id (new chat).
    if (sessionId) a.push(resume ? "--resume" : "--session-id", sessionId);
    return a;
  },

  // CLAUDE_CODE_ARTIFACT=1: `claude -p` ships without the claude.ai Artifact tools (interactive
  // sessions have them), so a headless job could not publish a page. Undocumented switch, found in
  // the 2.1.284 binary. A workspace that wants them off sets CLAUDE_CODE_DISABLE_ARTIFACT=1 in its
  // secrets_file or vars — the disable wins over this.
  // The profile's home comes from parity-env.ts: CLAUDE_CONFIG_DIR for a named profile, nothing for a
  // default profile running with the person's own Claude Code setup (their MCP servers, their login).
  env(_job, configDir) {
    return { ...claudeHomeEnv(configDir), CLAUDE_CODE_ARTIFACT: "1" };
  },

  parseLine: jsonLine,

  // The workspace's own config dir (else the default profile's), checked the way its agents run.
  // Unknown is NOT logged out: a claude that will not start, times out or prints a shape we do not
  // know answers true. Today only GET /backends/:name/auth calls this (dispatch, failover and the
  // quota gate never do), but the day something gates work on it a false "no" would stall every
  // claude run with nothing wrong — while a false "yes" fails loudly at spawn, as it always has.
  async checkAuth(workspaceId?: string | null): Promise<boolean> {
    const ws = workspaceId ? workspaces.get(workspaceId) : undefined;
    const dir = ws?.config_dir ?? CONFIG.profiles[CONFIG.defaultProfile] ?? CONFIG.profiles.claude;
    const r = await claudeAuthStatus(dir, { env: childEnv(ws ?? null) });
    return r.loggedIn !== false;
  },

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
