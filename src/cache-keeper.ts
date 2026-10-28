/**
 * Compact an idle Desk terminal while its prompt cache is still warm.
 *
 * A claude terminal on a subscription caches its whole conversation for an hour (session-usage.ts
 * reads which TTL each request got). Inside that hour the next prompt re-reads the context at the
 * cache rate — on Opus 5.5, 0.05x input. After it, the next prompt writes all of it again at the
 * one-hour write rate, 2x: forty times the warm price for the same tokens, on contexts that are
 * routinely 200k–700k on the Desk. Most of those cold wake-ups were not the operator coming back:
 * a background command finishing overnight, a budget notice, a continuation firing hours later.
 *
 * So a terminal that has sat at its prompt for most of the hour with a large context gets `/compact`
 * typed into it before the hour is up. The summary is written from the warm cache (a cache read plus
 * the summary's own output), the terminal stays the same tab on the same session, and whatever wakes
 * it next reloads a summary instead of the whole day. The rail shows ❄ once its cache is gone.
 *
 * Claude Code does the same on its own (idle compaction) where Anthropic has it switched on, which
 * is not every account; a terminal it already compacted is skipped (`compacted_at`).
 */
import { sessions } from "./store.js";
import { CONFIG } from "./config.js";
import { defineSetting, setting } from "./settings.js";
import { sessionUsage, type CacheState } from "./session-usage.js";
import { signalsOf, statusOf, type Signals } from "./term-status.js";
import { isLive, sendInput, sessionActivity, sessionPrompt } from "./terminal.js";

export const TTL_MS = { "1h": 60 * 60_000, "5m": 5 * 60_000 } as const;
/** Idle this long before the keeper acts: the operator who steps away for a coffee keeps every detail. */
export const FIRE_AFTER_MS = 45 * 60_000;
/** …and no later than this. The TTL counts from a request's START; the transcript stamps its END, and
 * a long answer can take minutes. A compaction sent after the cache is gone costs a full uncached read. */
export const LATEST_MS = 54 * 60_000;
const TICK_MS = 60_000;

defineSetting({
  key: "cache.keeper", group: "Limits", level: "both", type: "bool", env: "CHRONOS_CACHE_KEEPER",
  label: "Compact idle terminals before their cache expires",
  help: "A claude terminal idle for 45 minutes with a large context gets /compact typed in while its prompt cache is still warm. Waking it later reloads a summary instead of re-sending the whole conversation at the cache-write price.",
  default: () => process.env.CHRONOS_CACHE_KEEPER !== "0",
});
defineSetting({
  key: "cache.keeper_min_tokens", group: "Limits", level: "both", type: "int", env: "CHRONOS_CACHE_KEEPER_MIN_TOKENS",
  label: "…from this context size (tokens)",
  help: "Smaller contexts are cheap to reload and keep every detail.",
  default: () => Number(process.env.CHRONOS_CACHE_KEEPER_MIN_TOKENS) || 150_000,
  min: 50_000,
});

export type KeeperView = {
  backend: string;
  live: boolean;
  cache: CacheState;
  contextTokens: number;
  phase: string;
  /** What the screen shows at rest: a menu or question means the CLI is not at its composer. */
  promptKind: string | null;
  turn: Signals["turn"];
  /** What the agent said it is doing (`mc state`). A submitted prompt clears a declaration, so typing
   * `/compact` could erase "waiting on CI" from its card. */
  declared: string | null;
  /** Last keystroke into the pty, the daemon's own typing excluded. */
  lastIn: number | null;
  /** The request the keeper already compacted after. */
  firedFor: number | null;
};

/** null = compact now; otherwise why not. Pure, so every guard is a test. */
export function whyNot(v: KeeperView, minTokens: number, now: number): string | null {
  if (v.backend !== "claude-code") return "not claude";
  if (!v.live) return "not live here";
  const c = v.cache;
  if (c.last_request_at == null) return "no request yet";
  // Five minutes is gone before anything could act on it — that terminal is on usage credits, and
  // the rail says so instead.
  if (c.ttl !== "1h") return c.ttl ? `ttl ${c.ttl}` : "no cache write yet";
  if (c.compacted_at != null && c.compacted_at >= c.last_request_at) return "already compacted";
  if (v.firedFor === c.last_request_at) return "already sent";
  if (v.contextTokens < minTokens) return "small";
  const idle = now - c.last_request_at;
  if (idle < FIRE_AFTER_MS) return "not idle long enough";
  if (idle > LATEST_MS) return "too late: the cache is expiring";
  if (!["your_turn", "review", "waiting"].includes(v.phase)) return `phase ${v.phase}`;
  if (v.promptKind && v.promptKind !== "turn") return `prompt open (${v.promptKind})`;
  if (v.declared && v.declared !== "review") return `declared ${v.declared}`;
  // Hooks tell when the turn ended; without them there is no telling a quiet turn from a long tool call.
  if (v.turn?.state !== "stopped") return "turn not finished";
  // Typed after the turn ended and never sent: a draft may be sitting in the box, and `/compact`
  // would land on the end of it.
  if (v.lastIn != null && v.lastIn > v.turn.at) return "a draft may be in the box";
  return null;
}

/** One line, typed as keystrokes (under PASTE_MIN) like failover's `/model`: a slash command must not arrive as a paste. */
export function compactLine(idleMin: number): string {
  return `/compact Chronos cache keeper: idle ${idleMin} min, and the prompt cache expires soon. Keep the goal, what is done, ` +
    `what is still running (background commands, subagents, PRs, branch and worktree path), anything the operator was asked, and the exact next step.`;
}

const fired = new Map<string, number>();

export function keeperTick(now = Date.now()): void {
  for (const s of sessions.list({ status: "live", limit: 200 })) {
    if (s.backend !== "claude-code") continue;
    try {
      if (!setting<boolean>("cache.keeper", s.workspace_id)) continue;
      const u = sessionUsage(s.id);
      if (!u) continue;
      const act = sessionActivity(s.id);
      const sig = signalsOf(s.id);
      const why = whyNot({
        backend: s.backend,
        live: isLive(s.id),
        cache: u.cache,
        contextTokens: u.context_tokens,
        phase: statusOf(s.id, now)?.phase ?? "ended",
        promptKind: sessionPrompt(s.id)?.kind ?? null,
        turn: sig.turn,
        declared: sig.declared?.state ?? null,
        lastIn: act.last_in,
        firedFor: fired.get(s.id) ?? null,
      }, setting<number>("cache.keeper_min_tokens", s.workspace_id), now);
      if (why) continue;
      const idleMin = Math.round((now - u.cache.last_request_at!) / 60_000);
      fired.set(s.id, u.cache.last_request_at!);
      const err = sendInput(s.id, { text: compactLine(idleMin), machine: true }, "cache-keeper");
      console.log(`[cache-keeper] ${s.id.slice(0, 8)} ${err ? `not compacted: ${err}` : `compacting ${Math.round(u.context_tokens / 1000)}k after ${idleMin} min idle`}`);
    } catch (e) {
      console.warn(`[cache-keeper] ${s.id.slice(0, 8)}: ${(e as Error).message}`);
    }
  }
  for (const id of fired.keys()) if (!isLive(id)) fired.delete(id);
}

export function startCacheKeeper(): void {
  if (CONFIG.dbPath === ":memory:") return;
  setInterval(() => keeperTick(), TICK_MS).unref?.();
  console.log(`[cache-keeper] idle claude terminals ≥ their min context compact before the 1h cache expires (checked every ${TICK_MS / 1000}s)`);
}
