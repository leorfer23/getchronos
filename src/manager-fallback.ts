/**
 * When the primary manager backend (warm Claude) hits a session / rate / credit wall,
 * re-run the same turn on a fallback backend (default: grok) instead of failing the user.
 *
 * Job dispatch already has workspace.fallback_backend (dispatcher.maybeFallback). Executives
 * (Robert, and any executive you add beside him) and Telegram warm managers do NOT go through the job
 * runner — they use WarmManager — so this module covers that path.
 */
import { spawn } from "node:child_process";
import readline from "node:readline";
import { CONFIG } from "./config.js";
import { getBackend, hasBackend } from "./backends/index.js";
import { CREDIT_WALL_RE } from "./backends/types.js";
import { sandboxWrap, type SandboxMode } from "./sandbox.js";
import { workspaces } from "./store.js";
import { resultText } from "./summarize.js";

/** Default wait before retrying the primary after a limit with no parseable reset time. */
export const DEFAULT_LIMIT_COOLDOWN_MS = 90 * 60 * 1000;

const limitedUntil = new Map<string, number>();

/**
 * True when an error (or result string) means the provider is temporarily unusable —
 * session cap, rate limit, quota, 429, out of credits, etc.
 */
export function isProviderLimitError(err: unknown): boolean {
  const s = String(err instanceof Error ? err.message : err ?? "");
  return (
    (isCreditWallError(s) ||
      /session\s*limit|rate[\s_-]?limit|usage\s*limit|you've hit your|hit your (session|usage|limit)|too many requests|\b429\b|quota\s*(exceeded|limit)|overage|capacity|spend\s*limit|billing|payment\s*required|limit.?reached|resets?\s+\d/i.test(
        s,
      )) &&
    // Don't treat "rate limit" false-positives in unrelated text as hard walls.
    !/not a rate.?limit/i.test(s)
  );
}

/**
 * True when the wall is credits for THIS model rather than the account being capped — e.g. Fable's
 * "You're out of usage credits. Switch to another model to continue." Fable bills separate usage
 * credits, so the same profile can still answer on another model; a session/rate limit caps the
 * whole account and goes straight to the fallback backend instead.
 */
export function isCreditWallError(err: unknown): boolean {
  const s = String(err instanceof Error ? err.message : err ?? "");
  return CREDIT_WALL_RE.test(s);
}

/**
 * True when an error means this Claude profile has no usable credentials — expired/revoked OAuth,
 * never logged in, 401. Distinct from a limit: waiting never fixes it, only `claude /login` on that
 * profile does. So it routes to the fallback backend WITHOUT starting a cooldown.
 */
export function isAuthError(err: unknown): boolean {
  const s = String(err instanceof Error ? err.message : err ?? "");
  return /not logged in|please run \/login|invalid api key|authentication_error|oauth (token|session) (expired|revoked)|\bunauthorized\b|\b401\b/i.test(
    s,
  );
}

/** Best-effort parse of a reset timestamp (ms since epoch). null → use default cooldown. */
export function parseLimitResetsAtMs(err: unknown): number | null {
  const s = String(err instanceof Error ? err.message : err ?? "");
  const iso = s.match(/resets?\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i);
  if (iso) {
    const t = Date.parse(iso[1]);
    if (!Number.isNaN(t) && t > Date.now()) return t;
  }
  // "rate limited; resets 2026-07-30T17:20:00.000Z — …" (runner format)
  const runner = s.match(/resets\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i);
  if (runner) {
    const t = Date.parse(runner[1]);
    if (!Number.isNaN(t) && t > Date.now()) return t;
  }
  return null;
}

/**
 * A clock-style reset the way a vendor CLI actually writes it ("resets 1:40pm", "resets at 14:00").
 *
 * parseLimitResetsAtMs above only understands ISO, which is what OUR runner writes. The vendor's own
 * wording is what a session-limit message carries, and it is often the only reset time we get — a
 * null there reads downstream as "no wall at all", which is how the quota gate loses a dead window.
 */
export function parseResetClock(text: string | null | undefined, now = Date.now()): number | null {
  const s = String(text ?? "");
  const m = s.match(/resets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const mer = m[3]?.toLowerCase();
  if (h > 23 || min > 59) return null;
  if (mer === "pm" && h < 12) h += 12;
  if (mer === "am" && h === 12) h = 0;
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  // A bare clock time with no date means the NEXT time that clock reads: a reset "at 1:40pm" seen at
  // 3pm is tomorrow's, and reading it as two hours ago would mark an exhausted window healthy.
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function markProviderLimited(key: string, err: unknown): void {
  const until = parseLimitResetsAtMs(err) ?? Date.now() + DEFAULT_LIMIT_COOLDOWN_MS;
  limitedUntil.set(key, until);
}

export function isProviderLimited(key: string): boolean {
  const u = limitedUntil.get(key);
  if (u == null) return false;
  if (Date.now() >= u) {
    limitedUntil.delete(key);
    return false;
  }
  return true;
}

export function clearProviderLimited(key: string): void {
  limitedUntil.delete(key);
}

/** Cooldown key for "this caller's primary MODEL is walled" — distinct from the whole-provider one. */
export const modelLimitKey = (key: string) => `${key}#model`;

/**
 * Same backend and profile, other model: CONFIG.agent.modelFallback (default opus). null when the
 * turn already runs on it, or the step is disabled (CHRONOS_AGENT_MODEL_FALLBACK="").
 */
export function resolveModelFallback(model?: string | null): string | null {
  const to = (CONFIG.agent.modelFallback ?? "").trim();
  if (!model || !to || to === model) return null;
  return to;
}

/** Test helper — drop all cooldown state. */
export function _resetProviderLimitState(): void {
  limitedUntil.clear();
}

export type FallbackTarget = { backend: string; model: string | null };

/**
 * Resolve fallback backend/model: workspace override → global CONFIG → grok.
 * Never returns claude-code (primary managers are already Claude; falling back to itself is useless).
 */
export function resolveManagerFallback(wsId?: string | null): FallbackTarget {
  const ws = wsId ? workspaces.get(wsId) : undefined;
  let backend =
    (ws?.fallback_backend && ws.fallback_backend.trim()) ||
    CONFIG.agent.fallbackBackend ||
    "grok";
  let model =
    (ws?.fallback_model != null && String(ws.fallback_model).trim()
      ? String(ws.fallback_model).trim()
      : null) ??
    CONFIG.agent.fallbackModel ??
    null;

  if (backend === "claude" || backend === "claude-code") {
    backend = "grok";
    model = model && !/^(sonnet|opus|haiku)/i.test(model) ? model : "grok-4.5";
  }
  return { backend, model };
}

/**
 * Every engine a walled manager turn may still run on, in order: the fallback above (grok), then
 * CONFIG.agent.fallbackChain (cursor). Claude and repeats are dropped; a backend in its own cooldown
 * is left out so a dead balance costs one failed call per cooldown, not one per turn.
 */
export function resolveManagerFallbacks(wsId?: string | null): FallbackTarget[] {
  const out: FallbackTarget[] = [resolveManagerFallback(wsId)];
  for (const step of CONFIG.agent.fallbackChain ?? []) {
    const [backend, ...rest] = step.split("/");
    // getBackend() answers claude for an unknown name — a typo here must not become a Claude call.
    if (!backend || backend === "claude" || backend === "claude-code" || !hasBackend(backend)) continue;
    if (out.some((f) => f.backend === backend)) continue;
    out.push({ backend, model: rest.join("/") || null });
  }
  const live = out.filter((f) => !isProviderLimited(backendLimitKey(f.backend)));
  // Everything cooling down → still try the chain rather than fail without a single attempt.
  return live.length ? live : out;
}

export const backendLimitKey = (backend: string) => `fallback:${backend}`;

export type ManagerFallbackTurnOpts = {
  system: string;
  prompt: string;
  /**
   * Who this turn is, as declared in agents/<id>/AGENT.md. The persona is data, so it survives a
   * backend switch unchanged — but the CAPABILITIES it declares may not, and the agent has to be
   * told which ones it lost rather than discovering it by trying (or, worse, answering as if it
   * were the CLI vendor instead of itself).
   */
  agent?: { name: string; tools?: string | null; mcpConfig?: string | null };
  /** Recent turns of this thread, oldest→newest. A one-shot has no session to resume. */
  history?: string;
  wsId?: string | null;
  extraEnv?: Record<string, string>;
  cwd?: string;
  profileDir?: string;
  sandbox?: SandboxMode;
  onDelta?: (t: string, kind: "text" | "thinking" | "tool" | "tool_done") => void;
  timeoutMs?: number;
  /** Original primary error, for logging / system note. */
  limitError?: string;
  /** Engine to run on. Default: the first fallback (resolveManagerFallback). */
  target?: FallbackTarget;
};

/**
 * What this backend cannot honor from the agent's declaration. Keyed off the backend's own
 * capability flags, never off its name — a new CLI that gains --mcp-config should start carrying
 * MCP here by declaring it, with no edit to this function.
 */
export function capabilityGap(
  backendName: string,
  agent?: ManagerFallbackTurnOpts["agent"],
): string[] {
  if (!agent) return [];
  const caps = getBackend(backendName)?.capabilities ?? {};
  const gap: string[] = [];
  if (agent.mcpConfig && !caps.mcp)
    gap.push("your MCP servers (browser, Gmail, …) — this backend cannot load them");
  if (agent.tools && !caps.toolAllowlist)
    gap.push(`your declared tool set (${agent.tools}) — this backend runs its own default tools`);
  return gap;
}

/**
 * One-shot headless turn on the fallback backend. Grok streams text deltas; claude-shaped
 * backends emit a final {type:result}. Tools work under bypassPermissions so the executive can
 * still curl Chronos when CHRONOS_ADMIN is in extraEnv.
 */
export function runManagerFallbackTurn(opts: ManagerFallbackTurnOpts): Promise<string> {
  const fb = opts.target ?? resolveManagerFallback(opts.wsId);
  const backend = getBackend(fb.backend);
  const cwd = opts.cwd || process.cwd();
  const profileDir =
    opts.profileDir || CONFIG.profiles[CONFIG.agent.profile] || CONFIG.profiles.claude;
  const timeoutMs = opts.timeoutMs ?? Math.max(CONFIG.agent.timeoutSec * 1000, 90_000);

  // The identity above this note is the whole point: you are still whoever AGENT.md says, running on
  // a different engine. Saying "you are the fallback backend" instead made agents answer as the
  // vendor ("I'm Grok, not Ada") and invent facts the persona would have known.
  const gap = capabilityGap(fb.backend, opts.agent);
  const note =
    `\n\n## Degraded mode (engine swap)\n` +
    `You are still ${opts.agent?.name ?? "the same assistant described above"} — same person, same ` +
    `memory, same rules. The primary engine is unavailable` +
    (opts.limitError ? ` (${opts.limitError.slice(0, 160)})` : "") +
    `, so this turn runs on \`${fb.backend}\`${fb.model ? ` / ${fb.model}` : ""}. Never introduce ` +
    `yourself as that engine or as an AI model — answer as yourself.\n` +
    (gap.length
      ? `On this engine you do NOT have: ${gap.join("; ")}. If the answer needs one of those, say ` +
        `plainly that it is unavailable right now and offer what you CAN do — never guess the ` +
        `contents of something you could not read.\n`
      : "") +
    `Do the same job fully. Be concise. Do not mention this note unless asked.`;

  const system = (opts.system || "") + note;
  // A one-shot cannot --resume the thread, so continuity has to travel in the prompt or the agent
  // answers as if the conversation started now.
  const prompt = opts.history
    ? `## Conversación hasta ahora (para contexto, no la repitas)\n${opts.history}\n\n## Turno actual\n${opts.prompt}`
    : opts.prompt;
  const spec = backend.oneShot({
    prompt,
    system,
    model: fb.model,
    configDir: profileDir,
    cwd,
    timeoutMs,
    // The agent's OWN declaration, not a hardcoded pair. Backends that cannot honor these ignore
    // them (capabilityGap already told the agent so) — the caller does not branch per vendor.
    allowedTools: opts.agent?.tools ?? "Bash,Read",
    ...(opts.agent?.mcpConfig ? { mcpConfig: opts.agent.mcpConfig } : {}),
    maxBudgetUsd: CONFIG.agent.maxBudgetUsd * 4, // one-shot may need several tool rounds
  });

  const { cmd, cmdArgs } = sandboxWrap(
    opts.sandbox ?? "guard",
    cwd,
    [],
    profileDir,
    [],
    spec.cmd,
    spec.args,
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      fn();
    };

    const child = spawn(cmd, cmdArgs, {
      cwd,
      env: {
        ...process.env,
        ...spec.env,
        ...(opts.extraEnv ?? {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    watchdog.unref?.();

    let stdout = "";
    let errTail = "";
    const STDERR_CAP = 800;
    let streamText = "";

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      stdout += t + "\n";
      try {
        const p = JSON.parse(t);
        // Stream visible deltas to the live-status UI when present.
        if (p.type === "text" && typeof p.data === "string") {
          streamText += p.data;
          opts.onDelta?.(p.data, "text");
        } else if (p.type === "text" && typeof p.part?.text === "string") {
          streamText += p.part.text;
          opts.onDelta?.(p.part.text, "text");
        } else if (p.type === "result" && typeof p.result === "string" && p.is_error) {
          // Error result: surface after close
        } else if (
          p.type === "stream_event" &&
          p.event?.type === "content_block_delta" &&
          p.event?.delta?.type === "text_delta" &&
          typeof p.event.delta.text === "string"
        ) {
          opts.onDelta?.(p.event.delta.text, "text");
        }
      } catch {
        /* non-json line */
      }
    });

    child.stderr?.on("data", (d) => {
      errTail = (errTail + d.toString()).slice(-STDERR_CAP);
    });

    child.on("close", (code) => {
      const text = (resultText(stdout) || streamText).trim();
      // Detect limit on the fallback itself (e.g. grok also capped) so callers can surface both.
      if (text && isProviderLimitError(text) && /is_error|error/i.test(stdout)) {
        return finish(() =>
          reject(new Error(text || errTail || `fallback ${fb.backend} rate-limited`)),
        );
      }
      // Grok: success is exit 0 + text; also accept non-zero if we got answer text (some CLIs).
      if (text) return finish(() => resolve(text));
      // Claude-shaped error in stream with empty result
      if (isProviderLimitError(errTail) || isProviderLimitError(stdout)) {
        return finish(() =>
          reject(new Error(errTail || resultText(stdout) || `fallback ${fb.backend} limited`)),
        );
      }
      finish(() =>
        reject(
          new Error(
            errTail || `fallback ${fb.backend} exited ${code}${stdout ? ` — ${stdout.slice(0, 200)}` : ""}`,
          ),
        ),
      );
    });

    child.on("error", (e) => {
      finish(() => reject(e instanceof Error ? e : new Error(String(e))));
    });
  });
}

export type WithProviderFallbackOpts = {
  /** Cooldown key, e.g. "web:default", "ada", "tg:123". */
  key: string;
  /** Primary turn (usually WarmManager.turn). */
  primary: () => Promise<string>;
  /** Model the primary turn runs on — what a credit wall downgrades FROM. */
  model?: string | null;
  /**
   * The same turn on the same backend and profile, on another model. With `model`, this enables the
   * model step (fable → opus) before any backend swap. Absent → straight to the fallback backend.
   */
  primaryOn?: (model: string) => Promise<string>;
  system: string;
  prompt: string;
  wsId?: string | null;
  extraEnv?: Record<string, string>;
  cwd?: string;
  profileDir?: string;
  sandbox?: SandboxMode;
  onDelta?: ManagerFallbackTurnOpts["onDelta"];
  timeoutMs?: number;
  /** The agent's declaration (see ManagerFallbackTurnOpts.agent) — carried across the engine swap. */
  agent?: ManagerFallbackTurnOpts["agent"];
  /**
   * Fired once when a turn is about to run on a different engine. A degraded answer that looks
   * identical to a healthy one is how a dead token stayed invisible for hours: the caller uses this
   * to say so on whatever surface the human is watching.
   */
  onFallback?: (fb: { backend: string; model: string | null; why: string }) => void;
  /** Recent turns of this thread, so a one-shot fallback keeps the conversation. */
  history?: string;
  /** Kill warm primary so the next successful primary turn starts clean. */
  killPrimary?: () => void;
};

/**
 * Run primary; on a wall, degrade one step at a time:
 *   1. the primary model is out of credits (Fable) → same turn on CONFIG.agent.modelFallback (opus),
 *      remembered for a cooldown so later turns skip the walled model;
 *   2. Claude itself limited (or unauthenticated) → one-shot on the fallback backend (grok).
 * A successful turn on the primary model clears both cooldowns. Every failing step throws a combined error.
 */
export async function withProviderFallback(opts: WithProviderFallbackOpts): Promise<string> {
  const chain = resolveManagerFallbacks(opts.wsId);
  const fb = chain[0];
  // Walk the backend chain (grok → cursor): any failure on one engine moves to the next — the turn is
  // already degraded, and a 402 on grok's balance reads nothing like a Claude limit. A limit/credit
  // error puts that engine in its own cooldown.
  const runBackendFallback = async (limitError: string): Promise<string> => {
    const errs: string[] = [];
    for (let i = 0; i < chain.length; i++) {
      const target = chain[i];
      if (i > 0) {
        console.warn(`[manager-fallback] ${opts.key}: ${chain[i - 1].backend} failed → ${target.backend}${target.model ? `/${target.model}` : ""}`);
        opts.onFallback?.({ ...target, why: `${chain[i - 1].backend} también falló` });
      }
      try {
        const reply = await runOne(limitError, target);
        clearProviderLimited(backendLimitKey(target.backend));
        return reply;
      } catch (e: any) {
        const m = String(e?.message ?? e);
        if (isProviderLimitError(m) || isAuthError(m)) markProviderLimited(backendLimitKey(target.backend), m);
        errs.push(`${target.backend}: ${m.slice(0, 200)}`);
      }
    }
    throw new Error(errs.join(" · "));
  };
  const runOne = (limitError: string, target: FallbackTarget) =>
    runManagerFallbackTurn({
      target,
      system: opts.system,
      prompt: opts.prompt,
      wsId: opts.wsId,
      extraEnv: opts.extraEnv,
      cwd: opts.cwd,
      profileDir: opts.profileDir,
      sandbox: opts.sandbox,
      onDelta: opts.onDelta,
      timeoutMs: opts.timeoutMs,
      agent: opts.agent,
      history: opts.history,
      limitError,
    });

  if (isProviderLimited(opts.key)) {
    console.warn(
      `[manager-fallback] ${opts.key}: primary still limited → ${fb.backend}${fb.model ? `/${fb.model}` : ""}`,
    );
    opts.killPrimary?.();
    opts.onFallback?.({ ...fb, why: "primary en cooldown" });
    return runBackendFallback("cooldown");
  }

  const from = opts.model ?? null;
  const to = opts.primaryOn ? resolveModelFallback(from) : null;
  const mKey = modelLimitKey(opts.key);
  const downgraded = !!to && isProviderLimited(mKey);

  let err: any;
  try {
    if (downgraded) {
      opts.onFallback?.({ backend: "claude", model: to, why: `${from} en cooldown → ${to}` });
      const reply = await opts.primaryOn!(to!);
      clearProviderLimited(opts.key);
      return reply;
    }
    const reply = await opts.primary();
    clearProviderLimited(opts.key);
    clearProviderLimited(mKey);
    return reply;
  } catch (e: any) {
    err = e;
  }

  if (to && !downgraded && isCreditWallError(err)) {
    // Credits for this model, not the account: waiting on the same model is pointless, a sibling
    // model on the same login usually answers. No killPrimary — primaryOn swaps the model itself.
    markProviderLimited(mKey, err);
    console.warn(
      `[manager-fallback] ${opts.key}: ${from} out of credits (${String(err?.message ?? err).slice(0, 120)}) → ${to}`,
    );
    opts.onFallback?.({ backend: "claude", model: to, why: `${from} sin créditos → ${to}` });
    try {
      const reply = await opts.primaryOn!(to);
      clearProviderLimited(opts.key);
      return reply;
    } catch (e: any) {
      err = new Error(`${String(err?.message ?? err)} · ${to}: ${String(e?.message ?? e)}`);
      // Only a wall (or dead login) on the sibling model goes on to the backend swap; a crash
      // surfaces as a crash.
      if (!isAuthError(e) && !isProviderLimitError(e)) throw err;
    }
  }

  const auth = isAuthError(err);
  if (!auth && !isProviderLimitError(err)) throw err;
  const msg = String(err?.message ?? err);
  // A dead token is fixed by re-login, not by waiting: keep this turn alive on the fallback, but
  // never mark a cooldown — that would keep every later turn on grok long after /login.
  if (!auth) markProviderLimited(opts.key, err);
  opts.killPrimary?.();
  console.warn(
    `[manager-fallback] ${opts.key}: primary ${auth ? "not authenticated" : "limited"} (${msg.slice(0, 120)}) → ${fb.backend}${fb.model ? `/${fb.model}` : ""}`,
  );
  opts.onFallback?.({ ...fb, why: auth ? "primary sin login" : "primary rate-limited" });
  try {
    return await runBackendFallback(msg);
  } catch (fbErr: any) {
    const fbMsg = String(fbErr?.message ?? fbErr);
    throw new Error(`${msg} · fallback ${fb.backend} also failed: ${fbMsg.slice(0, 240)}`);
  }
}
