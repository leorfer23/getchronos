import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG } from "../config.js";
import { pricedOrEstimate } from "../pricing.js";
import type { Job } from "../types.js";
import { jsonLine, type AgentBackend, type NormalizedEvent, type OneShotOpts, type RateLimit, type RunResult, type SpawnSpec } from "./types.js";

const pexec = promisify(execFile);

// xAI Grok CLI (`grok`), headless streaming-json mode.
//
// Headless: `grok -p <PROMPT> --output-format streaming-json --permission-mode bypassPermissions`.
// Events (one JSON per line): {type:"thought",data} reasoning deltas → {type:"text",data} answer deltas →
// {type:"end",stopReason,sessionId,usage,num_turns} terminal. Failures emit {type:"error",message} + a
// nonzero exit. The answer arrives as `text` deltas (no single final-text event), so extractResult can't
// rebuild it from the line-at-a-time runner stream — it reports tokens/status only; the runner still
// stores every `text` event, so the answer shows in the timeline. oneShot consumers (verifier/summaries)
// buffer full stdout and concatenate the deltas themselves (see summarize.ts/verifier.ts).
//
// bypassPermissions auto-approves tool executions (grok's equivalent of claude --dangerously-skip-
// permissions) so unattended runs don't stall on prompts; the macOS Seatbelt sandbox (sandbox.ts) is the
// real boundary. Interactive terminal sessions still use the TUI (see interactiveArgs).
//
// Auth: grok logs into grok.com (one xAI account) under ~/.grok. There is no per-workspace config-dir
// env (unlike CLAUDE_CONFIG_DIR / CODEX_HOME), so grok's own login + session history are shared across
// workspaces. Code/FS/egress isolation still holds via the OS sandbox (sandbox.ts). Upgrade path: if
// grok adds a config-dir env, map it per workspace in env() for full capsule isolation.

// ponytail: streaming-json exposes no per-tool events (only thought/text/end), so headless-run timelines
// show reasoning + answer but not discrete tool calls. Interactive sessions (focus.ts) still render tools.
export const grokBackend: AgentBackend = {
  name: "grok",
  supportsResume: true,
  headlessResume: true,
  // Pin the transcript to the Chronos session UUID (`--session-id` / `--resume`) so Focus and Desk
  // reopen find the same chat. Chats live under encodeURIComponent(cwd), like cursor.
  pinsSession: true,
  transcriptPerCwd: true,
  appendsSystem: true, // standing workspace notes → --rules (appended to grok's system prompt)
  models: ["grok-4.5", "grok-composer-2.5-fast"],
  bin: () => CONFIG.grokBin,

  buildArgs(job: Job, sessionId: string, context: string | null, resumeSessionId?: string | null): string[] {
    const goal = context
      ? `${job.goal}\n\n--- Trigger context (the event that fired this run) ---\n${context}`
      : job.goal;
    const args = [
      "-p",
      goal,
      "--output-format",
      "streaming-json",
      "--permission-mode",
      "bypassPermissions",
      // --resume reopens the same transcript; --session-id pins a fresh UUID. Mutually exclusive.
      ...(resumeSessionId ? ["--resume", resumeSessionId] : ["--session-id", sessionId]),
    ];
    // No CONFIG.defaultModel fallback: that's a claude alias ("sonnet") grok rejects — omit → grok default.
    if (job.model) args.push("--model", job.model);
    if (job.append_system) args.push("--rules", job.append_system); // standing notes appended to system prompt
    return args;
  },

  // configDir unused (grok reads ~/.grok, no config-dir env).
  // allowedTools/maxBudgetUsd ignored — grok headless has no per-run tool/budget flag chronos maps here.
  oneShot({ prompt, system, model, resumeSessionId }: OneShotOpts): SpawnSpec {
    const args = ["-p", prompt, "--output-format", "streaming-json", "--permission-mode", "bypassPermissions"];
    if (system) args.push("--rules", system);
    if (model) args.push("--model", model);
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    return { cmd: CONFIG.grokBin, args, env: {} };
  },

  interactiveArgs(model: string | null, appendSystem?: string | null, _addDirs?: string[], sessionId?: string | null, resume?: boolean): string[] {
    // --always-approve = auto-approve all tool executions (grok's equivalent of claude
    // --dangerously-skip-permissions) so the seeded task runs without permission prompts. The OS
    // sandbox is the real boundary. Grok has no --add-dir; sibling-repo FS access comes from the
    // sandbox grant, not from grok itself.
    // --session-id pins a NEW chat to the Chronos row UUID; --resume reopens that same UUID's
    // transcript (Desk reopen / daemon revive). Without these, every reopen was an empty chat.
    const a: string[] = ["--always-approve"];
    if (model) a.push("--model", model);
    if (appendSystem) a.push("--rules", appendSystem);
    if (sessionId) a.push(resume ? "--resume" : "--session-id", sessionId);
    return a;
  },

  env() {
    return {}; // grok reads ~/.grok; no per-workspace config-dir env exists
  },

  parseLine: jsonLine,

  // grok streams its answer as `{type:"text", data:"…"}` deltas and its terminal `end` event carries
  // usage but no text. The runner concatenates these into the result text, which is what every
  // decision Chronos reads back off a run — merge-gate's verdict, the verifier's judgement — is
  // parsed from. Leaving them unmerged cost every grok merge gate its verdict.
  textDelta(ev: NormalizedEvent): string | null {
    return ev.type === "text" && typeof ev.payload?.data === "string" ? ev.payload.data : null;
  },

  // Terminal events: `end` (success — carries usage/num_turns; the answer text arrives separately as
  // `text` deltas, see textDelta above) and `error` (failure — message is the result text).
  // grok reports no cost — estimate from tokens so the run is not invisible on the spend ledger.
  extractResult(ev: NormalizedEvent): RunResult | null {
    const p = ev.payload;
    if (ev.type === "error") {
      const msg = typeof p.message === "string" ? p.message : "grok error";
      return { num_turns: null, cost_usd: null, tokens_in: null, tokens_out: null, is_error: true, summary: msg.slice(0, 4000), result_text: msg };
    }
    if (ev.type === "end") {
      const u = p.usage ?? {};
      const tokens_in = u.input_tokens ?? null;
      const tokens_out = u.output_tokens ?? null;
      const { cost_usd, cost_estimated } = pricedOrEstimate(null, {
        model: p.model ?? "grok",
        tokens_in,
        tokens_out,
      });
      return {
        num_turns: p.num_turns ?? null,
        cost_usd,
        cost_estimated,
        tokens_in,
        tokens_out,
        is_error: false,
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

  // `grok models` exits 0 and prints the model list only when logged in.
  async checkAuth(): Promise<boolean> {
    try {
      await pexec(CONFIG.grokBin, ["models"], { timeout: 15000 });
      return true;
    } catch {
      return false;
    }
  },

  // `grok login` runs a browser/OAuth flow. It wants a TTY, so a headless spawn may not complete —
  // grok is typically already logged in (checkAuth passes and login is skipped). Best-effort poll.
  async login(): Promise<{ ok: boolean; message?: string }> {
    try {
      const child = execFile(CONFIG.grokBin, ["login"], { timeout: 180000 }, () => {});
      const deadline = Date.now() + 170000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        if (await grokBackend.checkAuth!()) {
          try { child.kill(); } catch {}
          return { ok: true };
        }
      }
      try { child.kill(); } catch {}
      return { ok: false, message: "login timed out — run `grok login` in a terminal once, then retry" };
    } catch (e: any) {
      return { ok: false, message: String(e?.message ?? e) };
    }
  },
};
