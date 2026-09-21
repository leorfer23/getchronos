import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG } from "../config.js";
import { pricedOrEstimate } from "../pricing.js";
import type { Job } from "../types.js";
import { jsonLine, type AgentBackend, type NormalizedEvent, type OneShotOpts, type RateLimit, type RunResult, type SpawnSpec } from "./types.js";

const pexec = promisify(execFile);

// Cursor CLI (`cursor-agent`). Headless print mode + stream-json (same streaming shape family as Claude).
// Auth is a single CURSOR_API_KEY (no per-workspace config-dir isolation like Claude) — the kernel
// Seatbelt FS wall still applies via the runner regardless of backend.
//
// Result schema live-verified 2026-07-12 (see extractResult). Still unverified: rate-limit signaling.
export const cursorBackend: AgentBackend = {
  name: "cursor-agent",
  supportsResume: false,
  appendsSystem: false,
  models: ["auto", "gpt-5", "sonnet-4.5", "opus-4.1"],
  bin: () => CONFIG.cursorBin,

  buildArgs(job: Job, _sessionId: string, context: string | null, _resumeSessionId?: string | null): string[] {
    // Cursor has no --append-system-prompt; fold standing system text into the prompt itself.
    let goal = job.append_system ? `${job.append_system}\n\n---\n\n${job.goal}` : job.goal;
    if (context) goal += `\n\n--- Trigger context (the event that fired this run) ---\n${context}`;
    // --force/--trust: auto-allow tool use and workspace trust so a headless run never blocks on a prompt.
    const args = ["-p", goal, "--output-format", "stream-json", "--force", "--trust"];
    // Always explicit, never omitted: cursor-agent's CLI has its own persisted default model
    // (~/.cursor/cli-config.json `selectedModel`), independent of "auto" being its catalog default —
    // once a human picks a paid model in an interactive session that pin sticks for every subsequent
    // headless invocation too, silently burning paid usage instead of the account's auto allowance
    // (2026-09-21: Leo's Pro+ hit its Sonnet cap this way while Chronos never asked for Sonnet).
    args.push("--model", job.model || "auto");
    return args;
  },

  // No --append-system-prompt and no resume: fold system into the prompt, ignore resumeSessionId.
  // allowedTools/maxBudgetUsd also ignored — cursor-agent has no CLI equivalent.
  oneShot({ prompt, system, model }: OneShotOpts): SpawnSpec {
    const goal = system ? `${system}\n\n---\n\n${prompt}` : prompt;
    const args = ["-p", goal, "--output-format", "stream-json", "--force", "--trust"];
    args.push("--model", model || "auto"); // see buildArgs: always explicit, never inherit the CLI's pinned default
    return { cmd: CONFIG.cursorBin, args, env: {} };
  },

  // --force/--approve-mcps: a Desk terminal has nobody to answer "Run this command?" — claude gets
  // --dangerously-skip-permissions and grok --always-approve for the same reason; the OS sandbox is
  // the boundary. --resume <id> both opens a fresh chat under that id and reopens an existing one,
  // which is what pins the transcript to the Chronos session for Focus (focus.ts) and revive.
  pinsSession: true,
  transcriptPerCwd: true,
  interactiveArgs(model: string | null, _appendSystem?: string | null, addDirs?: string[], sessionId?: string | null): string[] {
    const a = ["--trust", "--force", "--approve-mcps"];
    a.push("--model", model || "auto"); // see buildArgs: always explicit, never inherit the CLI's pinned default
    for (const d of addDirs ?? []) a.push("--add-dir", d);
    if (sessionId) a.push("--resume", sessionId);
    return a;
  },

  env(_job, _configDir) {
    // CURSOR_API_KEY inherited from the daemon env (or a per-workspace secrets file, future).
    return {};
  },

  parseLine: jsonLine,

  // Verified against a live run 2026-07-12: {type:"result",subtype:"success",is_error,result,
  // session_id,usage:{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}} — camelCase usage,
  // no cost or turn fields (subscription pricing) — estimate from tokens when the vendor is silent.
  extractResult(ev: NormalizedEvent): RunResult | null {
    const p = ev.payload;
    if (ev.type !== "result") return null;
    const text = typeof p.result === "string" ? p.result : typeof p.text === "string" ? p.text : null;
    const tokens_in = p.usage?.inputTokens ?? p.usage?.input_tokens ?? p.usage?.prompt_tokens ?? null;
    const tokens_out = p.usage?.outputTokens ?? p.usage?.output_tokens ?? p.usage?.completion_tokens ?? null;
    const tokens_cache_read = p.usage?.cacheReadTokens ?? p.usage?.cache_read_input_tokens ?? null;
    const tokens_cache_write = p.usage?.cacheWriteTokens ?? p.usage?.cache_creation_input_tokens ?? null;
    const { cost_usd, cost_estimated } = pricedOrEstimate(p.total_cost_usd ?? p.cost_usd ?? p.cost ?? null, {
      model: p.model ?? null,
      tokens_in,
      tokens_out,
      cache_read: tokens_cache_read,
      cache_write: tokens_cache_write,
    });
    return {
      num_turns: p.num_turns ?? p.turns ?? null,
      cost_usd,
      cost_estimated,
      tokens_in,
      tokens_out,
      tokens_cache_read,
      tokens_cache_write,
      is_error: !!(p.is_error ?? p.error),
      summary: text ? text.slice(0, 4000) : null,
      result_text: text,
    };
  },

  detectRateLimit(ev: NormalizedEvent): RateLimit | null {
    const p = ev.payload;
    const code = p.api_error_status ?? p.status_code;
    if (code === 429) return { rateLimited: true };
    return null;
  },

  // `cursor-agent status` prints "Logged in" / "Not logged in".
  async checkAuth(): Promise<boolean> {
    if (process.env.CURSOR_API_KEY) return true;
    try {
      const { stdout, stderr } = await pexec(CONFIG.cursorBin, ["status"], { timeout: 15000 });
      return /logged in/i.test(stdout + stderr) && !/not logged in/i.test(stdout + stderr);
    } catch {
      return false;
    }
  },

  // Spawn the interactive login (opens a browser); resolve once `status` flips to logged-in.
  async login(): Promise<{ ok: boolean; message?: string }> {
    try {
      // Detached: cursor-agent login opens the browser and waits; we poll status instead of blocking on it.
      const child = execFile(CONFIG.cursorBin, ["login"], { timeout: 180000 }, () => {});
      const deadline = Date.now() + 170000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        if (await cursorBackend.checkAuth!()) {
          try { child.kill(); } catch {}
          return { ok: true };
        }
      }
      try { child.kill(); } catch {}
      return { ok: false, message: "login timed out (browser flow not completed)" };
    } catch (e: any) {
      return { ok: false, message: String(e?.message ?? e) };
    }
  },
};
