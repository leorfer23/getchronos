import { CONFIG } from "../config.js";
import type { Job } from "../types.js";
import { jsonLine, type AgentBackend, type NormalizedEvent, type OneShotOpts, type RateLimit, type RunResult, type SpawnSpec } from "./types.js";

// opencode (sst/opencode), headless JSON mode — the model-agnostic harness. Its whole point here:
// route ANY provider opencode knows through one loop, including the Vercel AI Gateway (configure a
// provider in opencode's own config once; then pick it with -m provider/model). Default keyless models
// are opencode's free Zen tier (opencode/*), so it runs before any gateway/provider is wired.
//
// Headless: `opencode run <PROMPT> --format json --auto`. Events (one JSON per line):
//   {type:"step_start"} → {type:"tool_use",part:{type:"tool",tool,state}} → {type:"text",part:{type:"text",text}}
//   → {type:"step_finish",part:{type:"step-finish",reason,tokens:{input,output,...},cost}} (one PER step;
//   final step reason:"stop"). Failures: {type:"error",error:{name,data:{message,ref}}}.
// --auto auto-approves non-denied permissions (opencode's skip-permissions); the macOS Seatbelt sandbox
// (sandbox.ts) is the real boundary. Verified against opencode 1.18.3.
//
// Gateway/provider config + auth live in opencode's own files (~/.local/share/opencode/auth.json, config).
// Like grok, there's no per-workspace config-dir env, so opencode's provider keys are shared; per-provider
// keys can instead arrive via child-env (secrets_file), so env() stays empty and keys aren't re-injected.

// step_finish tokens/cost are PER-STEP. This stateless backend returns each step's numbers as they
// arrive; the runner accumulates them across the run (see runner.ts addUsage) into whole totals.
export const opencodeBackend: AgentBackend = {
  name: "opencode",
  supportsResume: false, // opencode owns its ses_ id (like codex); chronos doesn't drive resume yet
  appendsSystem: false, // no run-mode system flag — standing notes fold into the prompt (see buildArgs)
  // advisory only — any opencode `provider/model` works. opencode/* = keyless Zen free tier.
  // vercel/moonshotai/kimi-k3 was withdrawn (PER-22); keep the picker to models that still resolve.
  models: ["opencode/big-pickle", "vercel/zai/glm-5.2", "vercel/deepseek/deepseek-v4-pro"],
  bin: () => CONFIG.opencodeBin,

  buildArgs(job: Job, _sessionId: string, context: string | null, _resumeSessionId?: string | null): string[] {
    let goal = job.append_system ? `${job.append_system}\n\n---\n\n${job.goal}` : job.goal;
    if (context) goal += `\n\n--- Trigger context (the event that fired this run) ---\n${context}`;
    const args = ["run", goal, "--format", "json", "--auto"];
    if (job.model) args.push("--model", job.model); // provider/model, e.g. vercel/anthropic/claude-sonnet-4
    return args;
  },

  // resumeSessionId ignored (no resume); configDir unused (opencode reads its own config dir).
  oneShot({ prompt, system, model }: OneShotOpts): SpawnSpec {
    const goal = system ? `${system}\n\n---\n\n${prompt}` : prompt;
    const args = ["run", goal, "--format", "json", "--auto"];
    if (model) args.push("--model", model);
    return { cmd: CONFIG.opencodeBin, args, env: {} };
  },

  // Interactive = opencode's TUI, which is the DEFAULT command (no subcommand). `run` needs a positional
  // message; `run -i` still does, so a message-less terminal errors "You must provide a message or a command".
  interactiveArgs(model: string | null): string[] {
    return model ? ["--model", model] : [];
  },

  env() {
    return {}; // provider keys arrive via child-env (secrets_file) or opencode's own auth.json
  },

  parseLine: jsonLine,

  // Terminal per step: step_finish (reason "stop"/"tool-calls"/…, tokens, cost). The answer streamed as
  // `text` parts (kept as timeline events; the line-at-a-time runner can't isolate the final one, so
  // summary/result_text stay null — oneShot consumers reassemble from `text` parts, see summarize.ts).
  // error events carry the failure message.
  extractResult(ev: NormalizedEvent): RunResult | null {
    const p = ev.payload;
    if (ev.type === "error") {
      const msg = p.error?.data?.message || p.error?.name || "opencode error";
      return { num_turns: null, cost_usd: null, tokens_in: null, tokens_out: null, is_error: true, summary: String(msg).slice(0, 4000), result_text: String(msg) };
    }
    if (ev.type === "step_finish") {
      const part = p.part ?? {};
      const tok = part.tokens ?? {};
      return {
        num_turns: null,
        cost_usd: typeof part.cost === "number" ? part.cost : null,
        tokens_in: tok.input ?? null,
        tokens_out: tok.output ?? null,
        is_error: /error|abort/i.test(String(part.reason ?? "")),
        summary: null,
        result_text: null,
      };
    }
    return null;
  },

  detectRateLimit(ev: NormalizedEvent): RateLimit | null {
    if (ev.type === "error" && /rate.?limit|quota|usage limit|429|too many requests/i.test(JSON.stringify(ev.payload)))
      return { rateLimited: true, resetsAt: null };
    return null;
  },
};
