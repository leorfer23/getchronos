import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG } from "../config.js";
import { pricedOrEstimate } from "../pricing.js";
import type { Job } from "../types.js";
import { jsonLine, type AgentBackend, type NormalizedEvent, type OneShotOpts, type RateLimit, type RunResult, type SpawnSpec } from "./types.js";

const pexec = promisify(execFile);

// OpenAI Codex CLI (`codex exec`), headless JSONL mode.
//
// ⚠️ WRITTEN FROM DOCS, UNTESTED AGAINST A LIVE BINARY (codex not installed here). Flags/events verified from:
//   - https://developers.openai.com/codex/cli/reference (→ learn.chatgpt.com/docs/developer-commands)
//   - JSONL event shapes: https://gist.github.com/alexfazio/359c17d84cb6a5af12bac88fa1db9770
// Verified flag set: `codex exec <PROMPT> --json --model/-m <m> --dangerously-bypass-approvals-and-sandbox`,
//   resume via `codex exec resume <SESSION_ID>`, auth check via `codex login status` (exit 0 = authed).
// JSONL events: thread.started{thread_id} → turn.started → item.completed{item:{type:"agent_message",text}} → turn.completed{usage}.
//
// Auth: ChatGPT-subscription login lives under $CODEX_HOME → map each workspace's configDir to CODEX_HOME
// so capsules isolate their own login. API-key auth (OPENAI_API_KEY) arrives via child-env (secrets_file
// for scoped workspaces, ambient for unscoped) — deliberately NOT re-injected here (see env()).
export const codexBackend: AgentBackend = {
  name: "codex",
  supportsResume: true,
  appendsSystem: false, // no --append-system-prompt; standing system text is folded into the prompt
  models: ["gpt-5-codex", "gpt-5"],
  bin: () => CONFIG.codexBin,

  buildArgs(job: Job, _sessionId: string, context: string | null, _resumeSessionId?: string | null): string[] {
    // Codex assigns its own thread_id (emitted in thread.started); the chronos sessionId can't be injected.
    let goal = job.append_system ? `${job.append_system}\n\n---\n\n${job.goal}` : job.goal;
    if (context) goal += `\n\n--- Trigger context (the event that fired this run) ---\n${context}`;
    // Unattended autonomy — bypass Codex's own approvals/sandbox; the macOS Seatbelt sandbox (sandbox.ts)
    // is the real boundary, same rationale as claude's --dangerously-skip-permissions.
    const args = ["exec", goal, "--json", "--dangerously-bypass-approvals-and-sandbox"];
    // No CONFIG.defaultModel fallback: that's a claude alias ("sonnet") codex wouldn't accept — omit → codex default.
    if (job.model) args.push("--model", job.model);
    return args;
  },

  // No --append-system-prompt: fold system into the prompt. Resume is a subcommand (`exec resume <id>`).
  // allowedTools/maxBudgetUsd ignored — codex exec has no CLI equivalent.
  oneShot({ prompt, system, model, resumeSessionId, configDir }: OneShotOpts): SpawnSpec {
    const goal = system ? `${system}\n\n---\n\n${prompt}` : prompt;
    const args = ["exec"];
    if (resumeSessionId) args.push("resume", resumeSessionId);
    args.push(goal, "--json", "--dangerously-bypass-approvals-and-sandbox");
    if (model) args.push("--model", model);
    return { cmd: CONFIG.codexBin, args, env: { CODEX_HOME: configDir } };
  },

  interactiveArgs(model: string | null): string[] {
    const a: string[] = [];
    if (model) a.push("--model", model);
    return a;
  },

  env(_job, configDir) {
    // CODEX_HOME isolates each workspace's codex login. OPENAI_API_KEY is intentionally NOT pulled from
    // process.env here — that would leak the daemon's ambient key into scoped workspaces (child-env
    // guards against exactly that). It arrives via child-env: secrets_file (scoped) or ambient (unscoped).
    return { CODEX_HOME: configDir };
  },

  parseLine: jsonLine,

  // Terminal event = item.completed{agent_message}: carries the final text (what verifier/summarize read).
  // Usage arrives on a separate turn.completed event — both feed the runner's accumulators. Cost is
  // estimated from tokens when present (codex never reports a dollar on either event).
  extractResult(ev: NormalizedEvent): RunResult | null {
    const p = ev.payload;
    if (ev.type === "turn.completed") {
      const u = p.usage ?? {};
      const tokens_in = u.input_tokens ?? u.prompt_tokens ?? null;
      const tokens_out = u.output_tokens ?? u.completion_tokens ?? null;
      const tokens_cache_read = u.cached_input_tokens ?? u.cache_read_input_tokens ?? null;
      const { cost_usd, cost_estimated } = pricedOrEstimate(null, {
        model: p.model ?? "codex",
        tokens_in,
        tokens_out,
        cache_read: tokens_cache_read,
      });
      return {
        num_turns: null,
        cost_usd,
        cost_estimated,
        tokens_in,
        tokens_out,
        tokens_cache_read,
        is_error: false,
        summary: null,
        result_text: null,
      };
    }
    if (ev.type !== "item.completed" || p.item?.type !== "agent_message") return null;
    const text = typeof p.item?.text === "string" ? p.item.text : null;
    return {
      num_turns: null,
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      is_error: false,
      summary: text ? text.slice(0, 4000) : null,
      result_text: text,
    };
  },

  // Codex surfaces failures as error / turn.failed events; match rate-limit/quota text. No reset time provided.
  detectRateLimit(ev: NormalizedEvent): RateLimit | null {
    const p = ev.payload;
    const isErr = ev.type === "error" || ev.type === "turn.failed" || p.error != null;
    if (isErr && /rate.?limit|quota|usage limit|429|too many requests/i.test(JSON.stringify(p)))
      return { rateLimited: true, resetsAt: null };
    return null;
  },

  // `codex login status` exits 0 when credentials are present (subscription or API key).
  async checkAuth(): Promise<boolean> {
    if (process.env.OPENAI_API_KEY) return true;
    try {
      await pexec(CONFIG.codexBin, ["login", "status"], { timeout: 15000 });
      return true;
    } catch {
      return false;
    }
  },

  // `codex login` opens the ChatGPT browser flow and waits; poll status instead of blocking on it.
  async login(): Promise<{ ok: boolean; message?: string }> {
    try {
      const child = execFile(CONFIG.codexBin, ["login"], { timeout: 180000 }, () => {});
      const deadline = Date.now() + 170000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        if (await codexBackend.checkAuth!()) {
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
