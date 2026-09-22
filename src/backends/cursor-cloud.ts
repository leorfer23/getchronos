import { workspaceVars } from "../store/workspace-vars.js";
import type { Job } from "../types.js";
import {
  jsonLine,
  type CloudBackend,
  type CloudFrame,
  type CloudLaunch,
  type CloudLaunchOpts,
  type CloudRef,
  type CloudRunState,
  type CloudStatus,
  type CloudUsage,
  type NormalizedEvent,
  type OneShotOpts,
  type RateLimit,
  type RunResult,
  type SpawnSpec,
} from "./types.js";

// Cursor Cloud Agents (Cursor-hosted VMs). Verified against the API docs 2026-09-22
// (https://cursor.com/docs/cloud-agent/api/endpoints) + a live PoC (launch → SSE → reconcile → PR,
// see docs/plans/2026-09-22-cursor-cloud-backend.md). This is the ONLY cloud backend so far: the
// work runs on someone else's VM, so bin()/buildArgs()/oneShot()/interactiveArgs()/encodeSteer()
// (a local-process spec) all throw — see NO_LOCAL_PROCESS below.
const API_BASE = "https://api.cursor.com";

const NO_LOCAL_PROCESS =
  "cursor-cloud has no local process — the runner branches on kind before here";

// Response bodies for the 409 agent_id_conflict path and the follow-up POST are NOT documented in
// the endpoints doc beyond "409 agent_id_conflict" / "a NEW run id" — parsing below is deliberately
// tolerant of several plausible field names (same defensive-alias style as cursor.ts extractResult)
// and should be tightened against a live conflict/follow-up response the first time one is seen.

function mapStatus(s: string | null | undefined): CloudStatus {
  switch (s) {
    case "FINISHED": return "finished";
    case "ERROR": return "error";
    case "CANCELLED": return "cancelled";
    case "EXPIRED": return "expired";
    default: return "running"; // RUNNING, or unknown → treat as still-alive rather than silently terminal
  }
}

/** Workspace vars first (see CloudRef doc — the key lives with the workspace, not the daemon), then env. */
function findApiKey(workspaceId: string | null): string | null {
  if (workspaceId) {
    const fromWs = workspaceVars.active(workspaceId).CURSOR_API_KEY;
    if (fromWs) return fromWs;
  }
  return process.env.CURSOR_API_KEY ?? null;
}

function resolveApiKey(workspaceId: string | null): string {
  const key = findApiKey(workspaceId);
  if (!key) throw new Error("cursor-cloud: no CURSOR_API_KEY (checked workspace vars, then env)");
  return key;
}

const GITHUB_HTTPS_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+?(?:\.git)?\/?$/i;
const GITHUB_SSH_RE = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i;

/** Phase 1 is GitHub-only (validateSpawnTarget's gate) — accepts either https or ssh remote form. */
export function isGitHubRemote(remote: string | null | undefined): boolean {
  if (!remote) return false;
  const r = remote.trim();
  return GITHUB_HTTPS_RE.test(r) || GITHUB_SSH_RE.test(r);
}

function agentIdFor(idempotencyKey: string): string {
  return `bc-${idempotencyKey}`;
}

function buildPromptText(opts: CloudLaunchOpts): string {
  // Same fold as src/backends/cursor.ts buildArgs: Cursor has no system-prompt slot, so standing
  // system text + trigger context both fold into the one prompt string.
  const job = opts.job;
  let text = job.append_system ? `${job.append_system}\n\n---\n\n${job.goal}` : job.goal;
  if (opts.context) text += `\n\n--- Trigger context (the event that fired this run) ---\n${opts.context}`;
  return text;
}

async function readJson(res: Response): Promise<any> {
  try { return await res.json(); } catch { return {}; }
}

/**
 * One block of an SSE response (delimited by a blank line) → its `id`/`event`/`data` fields.
 * `data:` is joined across multiple lines per the SSE spec (we never emit multi-line data, but a
 * vendor might).
 */
function parseSseBlock(block: string): { id: string | null; event: string | null; data: string } {
  let id: string | null = null;
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  return { id, event, data: dataLines.join("\n") };
}

const MODELS_TTL_MS = 60 * 60 * 1000; // "Models GET /v1/models ... Cache 1h" (brief)
let modelsCache: { at: number; ids: string[] } | null = null;

/**
 * The live model catalog (39 ids on 2026-09-22), cached 1h. `AgentBackend.models` stays a small
 * static fallback (below) because that field is read synchronously all over the codebase
 * (listBackends() etc.) — a real vendor catalog can only be had by awaiting a fetch, so this is
 * exported separately for a caller that can afford to await it (e.g. the Desk picker, PR 3).
 */
export async function fetchModelCatalog(workspaceId: string | null, opts: { force?: boolean } = {}): Promise<string[]> {
  if (!opts.force && modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.ids;
  const apiKey = resolveApiKey(workspaceId);
  const res = await fetch(`${API_BASE}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`cursor-cloud models failed: ${res.status}`);
  const j = await res.json();
  const raw = Array.isArray(j.models) ? j.models : Array.isArray(j) ? j : [];
  const ids: string[] = raw.map((m: any) => (typeof m === "string" ? m : m?.id)).filter((id: unknown): id is string => typeof id === "string" && !!id);
  modelsCache = { at: Date.now(), ids };
  return ids;
}

/** Test-only: forces the next fetchModelCatalog() call to hit the network again. */
export function __resetModelCatalogCache(): void {
  modelsCache = null;
}

export const cursorCloudBackend: CloudBackend = {
  name: "cursor-cloud",
  kind: "cloud",
  supportsHeadless: true,
  supportsResume: true, // resume = a follow-up turn on the same agent (see followup())
  pinsSession: true,
  appendsSystem: false,
  capabilities: {}, // no tool allowlist, no MCP in Phase 1
  // Advisory static fallback only — this field is read synchronously (listBackends() etc.), so it
  // can't hold the live 39-id catalog; see fetchModelCatalog() above for the real GET /v1/models,
  // cached 1h. auto/null omits the model field entirely (see launch()). claude-sonnet-5 deliberately
  // excluded: over its monthly spend cap on this account until 2026-10-12, so offering it here would
  // just manufacture dead runs.
  models: ["auto", "claude-opus-5", "composer-2.5"],

  bin(): string { throw new Error(NO_LOCAL_PROCESS); },
  buildArgs(): string[] { throw new Error(NO_LOCAL_PROCESS); },
  oneShot(_opts: OneShotOpts): SpawnSpec { throw new Error(NO_LOCAL_PROCESS); },
  interactiveArgs(): string[] { throw new Error(NO_LOCAL_PROCESS); },
  encodeSteer(): string { throw new Error(NO_LOCAL_PROCESS); },

  env(_job: Job, _configDir: string): Record<string, string> {
    // No child process to hand env to — see NO_LOCAL_PROCESS. Kept for interface compliance.
    return {};
  },

  // Cloud events are stored as JSON lines already tagged with `type` (see stream()'s NormalizedEvent
  // construction), so replaying them for Focus goes through the exact same jsonLine parser every
  // local backend uses.
  parseLine: jsonLine,

  extractResult(ev: NormalizedEvent): RunResult | null {
    if (ev.type !== "result") return null;
    const p = ev.payload;
    const text = typeof p.result === "string" ? p.result : typeof p.text === "string" ? p.text : null;
    // Tokens/cost are never derived here: they are the vendor's own totals from usage() (see
    // CloudUsage doc) — extracting them from a stream event would risk a stale/partial number.
    return {
      is_error: !!(p.isError ?? p.is_error ?? false),
      summary: text ? text.slice(0, 4000) : null,
      result_text: text,
    };
  },

  textDelta(ev: NormalizedEvent): string | null {
    if (ev.type !== "assistant" && ev.type !== "thinking") return null;
    const p = ev.payload;
    if (typeof p.text === "string") return p.text;
    if (typeof p.delta === "string") return p.delta;
    return null;
  },

  detectRateLimit(ev: NormalizedEvent): RateLimit | null {
    if (ev.type !== "error") return null;
    const p = ev.payload;
    const code = p.statusCode ?? p.status_code ?? p.code;
    const msg = String(p.message ?? p.error ?? "");
    if (code === 429 || /resource_exhausted|rate.?limit/i.test(msg)) {
      const retryAfter = Number(p.retryAfter ?? p.retry_after);
      const resetsAt = Number.isFinite(retryAfter) ? Math.floor(Date.now() / 1000) + retryAfter : null;
      return { rateLimited: true, resetsAt };
    }
    return null;
  },

  async checkAuth(workspaceId?: string | null): Promise<boolean> {
    // Same lookup order as every other method (see findApiKey/resolveApiKey): on this operator's
    // machine the key lives in workspace vars for Personal + Chronos, NOT daemon env, so an
    // env-only check reports "not authenticated" on the exact setup this backend runs on.
    const apiKey = findApiKey(workspaceId ?? null);
    if (!apiKey) return false;
    try {
      const res = await fetch(`${API_BASE}/v1/me`, { headers: { Authorization: `Bearer ${apiKey}` } });
      return res.ok;
    } catch {
      return false;
    }
  },

  async launch(opts: CloudLaunchOpts): Promise<CloudLaunch> {
    const apiKey = resolveApiKey(opts.job.workspace_id);
    const agentId = agentIdFor(opts.idempotencyKey);
    const body: Record<string, unknown> = {
      prompt: { text: buildPromptText(opts) },
      repos: opts.repos.map((r) => (r.startingRef ? { url: r.url, startingRef: r.startingRef } : { url: r.url })),
      autoCreatePR: opts.autoCreatePr,
      workOnCurrentBranch: false,
      agentId,
    };
    if (opts.job.model && opts.job.model !== "auto") body.model = { id: opts.job.model };
    if (opts.name) body.name = opts.name.slice(0, 100);

    const MAX_TRIES = 3;
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      const res = await fetch(`${API_BASE}/v1/agents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.status === 429 && attempt < MAX_TRIES) {
        const j = await readJson(res);
        const retryAfter = Number(j?.retryAfter ?? res.headers?.get?.("retry-after") ?? 60);
        await new Promise<void>((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }

      if (res.status === 409) {
        // A retried dispatch must not launch twice: the work is already running under this
        // agentId, so resolve to its ids instead of billing for a second VM.
        const j = await readJson(res);
        const existingAgentId = j?.agent?.id ?? agentId;
        const existingRunId = j?.run?.id ?? j?.agent?.latestRunId ?? null;
        if (!existingRunId) {
          throw new Error(`cursor-cloud launch: 409 agent_id_conflict for ${existingAgentId} but no run id in response`);
        }
        return {
          agentId: existingAgentId,
          runId: existingRunId,
          url: j?.agent?.url ?? null,
          status: mapStatus(j?.run?.status),
        };
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`cursor-cloud launch failed: ${res.status} ${text}`);
      }

      const j = await res.json();
      return {
        agentId: j.agent.id,
        runId: j.run.id,
        url: j.agent.url ?? null,
        status: mapStatus(j.run.status),
      };
    }
    throw new Error("cursor-cloud launch: unreachable (retry loop exhausted without returning)");
  },

  async *stream(ref: CloudRef, lastEventId: string | null, signal?: AbortSignal): AsyncIterable<CloudFrame> {
    const apiKey = resolveApiKey(ref.workspaceId);
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    if (lastEventId) headers["Last-Event-ID"] = lastEventId;
    const res = await fetch(`${API_BASE}/v1/agents/${ref.agentId}/runs/${ref.runId}/stream`, { headers, signal });
    if (!res.ok) throw new Error(`cursor-cloud stream failed: ${res.status}`);
    if (!res.body) return;

    let curId: string | null = lastEventId;
    // assistant/thinking deltas concatenate and only surface as a frame every ~1s or on an
    // interaction_update:text-completed signal — never one stored row per token (see the plan doc).
    let pendingType: "assistant" | "thinking" | null = null;
    let pendingText = "";
    // The SSE id AT THE TIME the buffered text was last appended to — not curId, which may already
    // have moved on to whatever event triggers the flush (a later id would mis-place the resume
    // cursor ahead of text a replay hasn't actually stored yet).
    let pendingEventId: string | null = null;
    let lastFlushAt = Date.now();

    const drain = (): CloudFrame | null => {
      if (!pendingType || !pendingText) return null;
      const frame: CloudFrame = {
        eventId: pendingEventId,
        event: { type: pendingType, payload: { type: pendingType, text: pendingText } },
        terminal: false,
      };
      pendingType = null;
      pendingText = "";
      pendingEventId = null;
      lastFlushAt = Date.now();
      return frame;
    };

    const handleBlock = (block: string): CloudFrame[] => {
      const out: CloudFrame[] = [];
      const { id, event, data } = parseSseBlock(block);
      if (id) curId = id;
      if (!event && !data) return out; // blank/keepalive block

      let payload: any = {};
      if (data) {
        try { payload = JSON.parse(data); } catch { payload = { text: data }; }
      }
      const type = event ?? payload.type ?? "raw";

      if (type === "assistant" || type === "thinking") {
        const text = typeof payload.text === "string" ? payload.text : typeof payload.delta === "string" ? payload.delta : "";
        if (pendingType && pendingType !== type) {
          const f = drain();
          if (f) out.push(f);
        }
        pendingType = type;
        pendingText += text;
        pendingEventId = curId;
        if (Date.now() - lastFlushAt >= 1000) {
          const f = drain();
          if (f) out.push(f);
        }
        return out;
      }

      const isTextCompleted = type === "interaction_update" &&
        (payload.kind === "text-completed" || payload.status === "text-completed" || payload.stage === "text-completed");
      const flushed = drain();
      if (flushed) out.push(flushed);
      if (isTextCompleted) return out; // flush trigger only — not itself a storable row

      const normalized: NormalizedEvent = { type, payload: { ...payload, type } };
      const terminal = type === "result" || type === "done" || type === "error";
      out.push({ eventId: curId, event: normalized, terminal });
      return out;
    };

    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const frame of handleBlock(block)) {
          yield frame;
          if (frame.terminal) return;
        }
      }
    }
    if (buf.trim()) {
      for (const frame of handleBlock(buf)) {
        yield frame;
        if (frame.terminal) return;
      }
    }
    const tail = drain();
    if (tail) yield tail;
  },

  async getRun(ref: CloudRef): Promise<CloudRunState> {
    const apiKey = resolveApiKey(ref.workspaceId);
    const res = await fetch(`${API_BASE}/v1/agents/${ref.agentId}/runs/${ref.runId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`cursor-cloud getRun failed: ${res.status}`);
    const j = await res.json();
    const branches = Array.isArray(j.git?.branches)
      ? j.git.branches.map((b: any) => ({ repoUrl: b.repoUrl, branch: b.branch, prUrl: b.prUrl ?? null }))
      : [];
    return {
      status: mapStatus(j.status),
      result: typeof j.result === "string" ? j.result : null,
      durationMs: typeof j.durationMs === "number" ? j.durationMs : null,
      branches,
      error: typeof j.error === "string" ? j.error : null,
    };
  },

  async usage(ref: CloudRef): Promise<CloudUsage> {
    const apiKey = resolveApiKey(ref.workspaceId);
    const res = await fetch(`${API_BASE}/v1/agents/${ref.agentId}/usage?runId=${encodeURIComponent(ref.runId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`cursor-cloud usage failed: ${res.status}`);
    const j = await res.json();
    const chargedCents = j.cost?.chargedCents;
    return {
      tokens_in: j.tokens?.input ?? j.tokens?.inputTokens ?? null,
      tokens_out: j.tokens?.output ?? j.tokens?.outputTokens ?? null,
      tokens_cache_read: j.tokens?.cacheRead ?? j.tokens?.cacheReadTokens ?? null,
      tokens_cache_write: j.tokens?.cacheWrite ?? j.tokens?.cacheWriteTokens ?? null,
      // Vendor total, not token-table arithmetic — the runner stores this with cost_estimated: false.
      cost_usd: typeof chargedCents === "number" ? chargedCents / 100 : null,
    };
  },

  async followup(ref: CloudRef, text: string): Promise<CloudLaunch> {
    const apiKey = resolveApiKey(ref.workspaceId);
    const res = await fetch(`${API_BASE}/v1/agents/${ref.agentId}/runs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: { text } }),
    });
    if (res.status === 409) throw new Error(`cursor-cloud followup: agent busy (${ref.agentId})`);
    if (!res.ok) throw new Error(`cursor-cloud followup failed: ${res.status}`);
    const j = await res.json();
    return {
      agentId: ref.agentId,
      runId: j.run?.id ?? j.id,
      url: j.agent?.url ?? null,
      status: mapStatus(j.run?.status ?? j.status),
    };
  },

  async cancel(ref: CloudRef): Promise<void> {
    const apiKey = resolveApiKey(ref.workspaceId);
    const res = await fetch(`${API_BASE}/v1/agents/${ref.agentId}/runs/${ref.runId}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok && res.status !== 404) throw new Error(`cursor-cloud cancel failed: ${res.status}`);
  },
};
