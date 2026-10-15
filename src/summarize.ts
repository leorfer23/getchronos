import { execFile } from "node:child_process";
import { getBackend } from "./backends/index.js";
import { childEnv } from "./child-env.js";
import { noteHelperCall, type HelperKind } from "./helper-spend.js";
import type { Workspace } from "./types.js";

// Lightweight one-shot text helper for the few metadata jobs that require synthesis. Routed through
// the workspace's backend so per-workspace provider choice applies; null ws → claude + haiku
// (operator's personal helper). `modelOverride` wins over the workspace's review model.
/**
 * The model `oneShotText` will actually run on, given a workspace and an optional override.
 *
 * Exported because callers that RECORD which model produced an answer have to record the same one
 * that ran. Reading `ws.review_model` directly is wrong: it is unset on most workspaces, and the
 * call then falls through to the backend's own default — so the caller would file a verdict under
 * a model that never saw the prompt, or under null when something did.
 */
export function helperModel(ws?: Workspace | null, modelOverride?: string | null): string | null {
  const backend = getBackend(ws?.review_backend || ws?.default_backend);
  return modelOverride || ws?.review_model || (backend.name === "claude-code" ? "haiku" : null);
}

export function oneShotText(
  prompt: string,
  configDir: string,
  ws?: Workspace | null,
  timeoutMs = 25_000,
  modelOverride?: string | null,
  kind: HelperKind = "other",
): Promise<string | null> {
  const backend = getBackend(ws?.review_backend || ws?.default_backend);
  const model = helperModel(ws, modelOverride);
  const env = childEnv(ws ?? null);
  const spec = backend.oneShot({ prompt, model, configDir, timeoutMs });
  return new Promise((resolve) => {
    try {
      execFile(
        spec.cmd,
        spec.args,
        { timeout: timeoutMs, maxBuffer: 1 << 20, env: { ...env, ...spec.env } },
        (err, stdout) => {
          // Count every attempt — a failed digest that retries on exit is exactly the churn we want
          // visible on /stats. Token counts when the stream-json result line carries usage.
          const usage = helperUsage(stdout);
          noteHelperCall(kind, { model, ...usage });
          resolve(err ? null : resultText(stdout));
        },
      );
    } catch {
      noteHelperCall(kind, { model });
      resolve(null);
    }
  });
}

/** Best-effort token pull from a stream-json one-shot transcript (claude / openai-api shape). */
function helperUsage(stdout: string): { tokens_in?: number; tokens_out?: number; cost_usd?: number } {
  for (const line of (stdout || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const p = JSON.parse(t);
      if (p.type !== "result") continue;
      const tin = p.usage?.input_tokens ?? p.usage?.inputTokens;
      const tout = p.usage?.output_tokens ?? p.usage?.outputTokens;
      const cost = p.total_cost_usd ?? p.cost_usd;
      return {
        ...(typeof tin === "number" ? { tokens_in: tin } : {}),
        ...(typeof tout === "number" ? { tokens_out: tout } : {}),
        ...(typeof cost === "number" ? { cost_usd: cost } : {}),
      };
    } catch {}
  }
  return {};
}

// Pull the final answer out of a stream-json transcript (the backends emit stream-json, not text).
// claude/codex carry it on a single {type:"result"} line; grok streams it as {type:"text",data} deltas.
export function resultText(stdout: string): string | null {
  let grok = "";
  for (const line of (stdout || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const p = JSON.parse(t);
      if (p.type === "result" && typeof p.result === "string") return p.result.trim() || null;
      if (p.type === "text" && typeof p.data === "string") grok += p.data; // grok deltas
      if (p.type === "text" && typeof p.part?.text === "string") grok += p.part.text; // opencode text parts
    } catch {}
  }
  return grok.trim() || null;
}

// Strip ANSI/OSC escape sequences + carriage returns so the model sees clean text.
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "") // OSC (e.g. title sets)
    .replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "")          // CSI
    .replace(/\x1B[@-Z\\-_]/g, "")                       // other escapes
    .replace(/\r/g, "");
}

// Instant title from the prompt. The main agent's structured Understanding can refine it later.
export const quickTitle = (p: string) =>
  stripAnsi(p).replace(/\s+/g, " ").trim().split(" ").slice(0, 7).join(" ").slice(0, 60) || "session";

// One-sentence plain-English description of a ticket for the detail header + terminal subtitles.
// Given the title (+ optional body context). Returns null on any failure — caller keeps the old value.
export async function aiTicketSummary(
  title: string,
  body: string,
  configDir: string,
  ws?: Workspace | null
): Promise<string | null> {
  const ctx = stripAnsi(body).replace(/\s+/g, " ").trim().slice(0, 1500);
  const out = await oneShotText(
    `In ONE plain sentence (max 20 words, no quotes, no trailing period), describe what this coding ticket is about — what needs to happen and why. Title: "${title}".${ctx ? ` Context: ${ctx}` : ""}`,
    configDir,
    ws,
    15_000,
    null,
    "ticket-summary",
  );
  if (!out) return null;
  return out.split("\n")[0].replace(/^["'#\s\-*]+|["'\s]+$/g, "").slice(0, 200) || null;
}

// Parse helpers so the batched exit call degrades per-field exactly like the two separate calls did.
function parseSummary(j: any): { summary: string; tags: string[] } | null {
  const summary = String(j?.summary ?? "").slice(0, 300);
  const tags = Array.isArray(j?.tags) ? j.tags.map((x: any) => String(x).toLowerCase().slice(0, 24)).slice(0, 8) : [];
  return summary || tags.length ? { summary, tags } : null;
}
function parseLearnings(j: any): string[] {
  const arr = j?.learnings;
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => String(x).replace(/\s+/g, " ").trim().slice(0, 140)).filter((x) => x.length > 8).slice(0, 3);
}

// Session-EXIT digest: ONE haiku call returning BOTH the search summary+tags AND durable learnings,
// so teardown pays a single CLI cold-boot instead of two. Tolerant parse with per-field fallback: a
// failed or garbled call degrades to {summary:null, learnings:[]} — the same no-op two calls produced.
//
// The learnings half is Robert's pass — the SECOND of exactly three sanctioned memory-capture
// sources (the driving agent's own `mc learn` is first, the operator's explicit "memorize X" is
// third). It reviews the finished session with the vault's existing facts in hand, so it never
// re-records what the workspace already knows, and it is told the truthful prior: most sessions
// teach nothing, and [] is the expected answer.
export async function aiSessionDigest(
  transcript: string,
  configDir: string,
  ws?: Workspace | null,
  knownFacts: string[] = []
): Promise<{ summary: { summary: string; tags: string[] } | null; learnings: string[] }> {
  const t = stripAnsi(transcript).slice(-7000).trim();
  if (t.length < 40) return { summary: null, learnings: [] };
  const known = knownFacts.slice(0, 40).join("\n").slice(0, 1500);
  const out = await oneShotText(
    `You are Robert, chief of staff reviewing a finished coding terminal session. Return ONLY compact JSON ` +
      `{"summary":"...","tags":["a","b"],"learnings":["..."]}:\n` +
      `- "summary": ONE sentence describing the session. "tags": 3-6 lowercase topic tags (tech, files, or task type).\n` +
      `- "learnings": durable facts a future agent in this SAME workspace genuinely needs — gotchas, non-obvious ` +
      `decisions, conventions, config/credential locations, dead-ends to avoid. The bar is HIGH: most sessions ` +
      `teach nothing durable and [] is the expected answer. EXCLUDE one-off task status, chit-chat, anything ` +
      `obvious from reading the code, secrets/tokens themselves, and anything already in the known facts below. ` +
      `Max 3 short imperative bullet strings, each <140 chars.\n` +
      (known ? `\nAlready known (do NOT re-record):\n${known}\n` : "") +
      `\nTranscript:\n${t}`,
    configDir,
    ws,
    25_000,
    null,
    "digest",
  );
  if (!out) return { summary: null, learnings: [] };
  let j: any = null;
  try {
    const m = out.match(/\{[\s\S]*\}/);
    if (m) j = JSON.parse(m[0]);
  } catch {}
  return { summary: parseSummary(j), learnings: parseLearnings(j) };
}
