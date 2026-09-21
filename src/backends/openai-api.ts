import path from "node:path";
import { fileURLToPath } from "node:url";
import { pricedOrEstimate } from "../pricing.js";
import type { Job } from "../types.js";
import { jsonLine, type AgentBackend, type NormalizedEvent, type OneShotOpts, type RateLimit, type RunResult, type SpawnSpec } from "./types.js";

// repo/{src,dist}/backends/openai-api.* → repo/scripts/openai-oneshot.mjs (2 levels up either way).
const HELPER = path.resolve(fileURLToPath(import.meta.url), "../../../scripts/openai-oneshot.mjs");

// One-shot-only backend for cheap internal LLM calls (verifier verdicts, titles, summaries) via any
// OpenAI-compatible /chat/completions endpoint (Vercel AI Gateway, OpenRouter, direct OpenAI).
// NOT an agentic coding backend — buildArgs throws so a misconfigured workspace default fails loudly.
// Keys/base-url come from env (per-workspace secrets_file: OPENAI_API_KEY, OPENAI_BASE_URL, or ambient).
export const openaiApiBackend: AgentBackend = {
  name: "openai-api",
  supportsResume: false,
  bin: () => "node",

  buildArgs(_job: Job, _sessionId: string, _context: string | null, _resumeSessionId?: string | null): string[] {
    throw new Error("openai-api backend is one-shot only — not dispatchable for build runs");
  },

  // Spawn the helper: it POSTs to /chat/completions and prints a claude-compatible stream-json result line.
  oneShot({ prompt, system, model }: OneShotOpts): SpawnSpec {
    const args = [HELPER, model ?? "", prompt];
    if (system) args.push(system);
    return { cmd: "node", args, env: {} };
  },

  env() {
    return {};
  },

  parseLine: jsonLine,

  // Mirrors claude's result-event shape (the helper emits {type:"result", result, usage}).
  // No vendor cost on the helper line — estimate so helper/review one-shots are not invisible when
  // wrapped as runs (and so stream parsers that reuse this shape stay consistent).
  extractResult(ev: NormalizedEvent): RunResult | null {
    const p = ev.payload;
    if (ev.type !== "result") return null;
    const tokens_in = p.usage?.input_tokens ?? null;
    const tokens_out = p.usage?.output_tokens ?? null;
    const { cost_usd, cost_estimated } = pricedOrEstimate(p.total_cost_usd ?? p.cost_usd ?? null, {
      model: p.model ?? null,
      tokens_in,
      tokens_out,
    });
    return {
      num_turns: null,
      cost_usd,
      cost_estimated,
      tokens_in,
      tokens_out,
      is_error: !!p.is_error,
      summary: typeof p.result === "string" ? p.result.slice(0, 4000) : null,
      result_text: typeof p.result === "string" ? p.result : null,
    };
  },

  detectRateLimit(ev: NormalizedEvent): RateLimit | null {
    const p = ev.payload;
    if (p.api_error_status === 429 || p.status_code === 429) return { rateLimited: true };
    return null;
  },
};
