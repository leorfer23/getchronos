/**
 * Quota/runway gate — "can this backend actually finish this job?", asked BEFORE the spawn.
 *
 * Twice the operator ran out of provider credits and only found out when runs started failing
 * (2026-08-23 every provider dry, 2026-09-06 the AI gateway). On 2026-09-12 Robert opened four Grok
 * terminals without a look at runway while three helper agents were dying on a Claude session limit.
 * Every guard we had is about SPEND (burn-guard, daily budgets) or reacts AFTER the wall
 * (dispatcher.maybeFallback / maybeResume). Nothing asked whether the credential a dispatch was about
 * to use still had allowance.
 *
 * The decision procedure is copied from the open-source firstmate project's `quota-array-dispatch`
 * skill: three cheap orthogonal gates (eligibility, reasoning-class fit, runway feasibility), and
 * only then ONE comparable scalar (`spendPriority`) to rank the survivors. None of its bash is here —
 * this is the same contract on our runtime, reading the evidence Chronos already records.
 *
 * Three rules from that skill matter more than the code:
 *  - **Unknown is unknown.** A surface we cannot measure stays eligible with the uncertainty stated;
 *    it is never coerced to healthy and never coerced to zero. Only concrete contradictory evidence
 *    (a recorded rate limit, an error naming credits, a credential store that does not exist) blocks.
 *  - **Never downgrade the reasoning class to save quota.** If every candidate in the required
 *    difficulty tier is blocked, the gate STOPS and reports. A cheaper model is not a substitute for
 *    a harder problem — that trade is the operator's to make, not a router's.
 *  - **Never launch a vendor CLI to test a credential.** The probes here read files and env only; a
 *    probe that cannot tell returns `indeterminate`, which is evidence of nothing.
 *
 * One deliberate divergence: firstmate stops and asks its captain on a genuine tie. Chronos is
 * headless, so a tie resolves to the FIRST candidate in the operator's own `route_config` order — and
 * the rationale says that is why.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG } from "./config.js";
import { backendAllowed, getBackend, hasBackend, validateSpawnTarget } from "./backends/index.js";
import { events, jobs, runs, tickets, workspaces } from "./store.js";
import { difficultyOf, routeCandidates } from "./tickets.js";
import { CREDIT_WALL_RE } from "./backends/types.js";
import { DEFAULT_LIMIT_COOLDOWN_MS, isProviderLimitError, parseLimitResetsAtMs, parseResetClock } from "./manager-fallback.js";
import { burnState } from "./burn-guard.js";
import { notify, esc } from "./telegram/api.js";
import type { Job } from "./types.js";

// ── shapes ───────────────────────────────────────────────────────────────────

/** Provider family = who bills the tokens. Scope = WHICH credential of that family (see credentialFor). */
export type ProviderFamily = "anthropic" | "openai" | "xai" | "gateway";
export type Runway = "through_reset" | "projected_exhaustion" | "exhausted_now" | "unknown";
export type AuthState = "authenticated" | "unauthenticated" | "indeterminate";
/** measured = the vendor said it · inferred = our arithmetic/proxy · unknown = nothing measures it. */
export type Confidence = "measured" | "inferred" | "unknown";

export interface QuotaEntry {
  provider: ProviderFamily;
  scope: string;
  /** null means unmeasured — NEVER 0, and never a stand-in for healthy. */
  effectivePercentRemaining: number | null;
  runway: Runway;
  resetsAt: string | null;
  usableRunwaySeconds: number | null;
  confidence: Confidence;
  auth: AuthState;
  /**
   * Does anything on this host actually dispatch on this credential? A surface no workspace reaches
   * for and that has spent nothing is reported for completeness but is not an operational problem —
   * codex is not installed on every host, and a permanent "codex not logged in" critical would be
   * pure alarm fatigue.
   */
  inUse: boolean;
  /** Auth, staleness and unmeasurable facts, in the words a human needs to act on them. */
  attention: string[];
  /** Higher = more paid allowance on track to go unused before reset. null = not comparable. */
  spendPriority: number | null;
}

export interface QuotaSnapshot {
  at: string;
  entries: QuotaEntry[];
  /** Fleet-wide facts that belong to no single credential (the burn brake, mostly). */
  attention: string[];
}

/** One provider-wall fact the repo already recorded, normalized onto a credential. */
export interface LimitEvent {
  provider: ProviderFamily;
  scope: string;
  kind: "rate_limit" | "credits" | "auth";
  at: string;
  resetsAt: string | null;
  detail: string;
}

export interface Surface {
  provider: ProviderFamily;
  scope: string;
  /** in+out tokens charged to this credential over the ~5h window. null = nothing to count. */
  tokens: number | null;
  auth: AuthState;
  authNote: string | null;
  /** See QuotaEntry.inUse. */
  inUse: boolean;
}

export interface SnapshotInputs {
  now: number;
  surfaces: Surface[];
  limits: LimitEvent[];
  /** Operator-declared token ceiling for the rolling 5h window. 0 = unknown, stays unknown. */
  tokenBudget: number;
  /** `provider` or `provider:scope` → percent below which the operator wants dispatch to stop. */
  floors: Record<string, number>;
  burn: string | null;
}

// The paid window we assume when turning "time until reset" into "share of the window left".
// 5h is Claude's subscription window and the one the fleet board already reports against.
const WINDOW_MS = 5 * 3600_000;

export const credKey = (c: { provider: ProviderFamily; scope: string }) => `${c.provider}:${c.scope}`;

// ── which credential does a candidate ACTUALLY use ───────────────────────────

const FAMILY: Record<string, ProviderFamily> = {
  "claude-code": "anthropic",
  claude: "anthropic",
  codex: "openai",
  "openai-api": "openai",
  grok: "xai",
  "grok-cli": "xai",
  opencode: "gateway",
  "cursor-agent": "gateway",
  cursor: "gateway",
};

/**
 * The credential a (backend, configDir) pair actually spends — not the backend's name.
 *
 * This is the relation firstmate refuses to let its deterministic shell guess, and for the same
 * reason: claude-code bills a DIFFERENT account per `CLAUDE_CONFIG_DIR`, so "anthropic" alone would
 * blame one client's exhausted profile for another client's healthy one. codex isolates the same way
 * via CODEX_HOME; grok/opencode/cursor share one login across every workspace (see backends/grok.ts),
 * so their scope is deliberately global.
 *
 * null = no credential we model (the `mock` backend in tests, or an unregistered name) — such a
 * candidate is never gated on quota, because we would be inventing the evidence.
 */
export function credentialFor(
  backend: string | null | undefined,
  configDir: string | null | undefined,
): { provider: ProviderFamily; scope: string } | null {
  const provider = FAMILY[backend ?? ""];
  if (!provider) return null;
  switch (backend) {
    case "claude-code":
    case "claude":
      return { provider, scope: `profile:${path.basename(claudeDir(configDir))}` };
    case "codex":
      return { provider, scope: `codex:${path.basename(configDir || "codex")}` };
    case "openai-api":
      return { provider, scope: "openai-api" };
    case "grok":
    case "grok-cli":
      return { provider, scope: "grok" };
    case "opencode":
      return { provider, scope: "opencode" };
    default:
      return { provider, scope: "cursor" };
  }
}

const claudeDir = (configDir: string | null | undefined) =>
  configDir || CONFIG.profiles[CONFIG.defaultProfile] || CONFIG.profiles.claude || path.join(os.homedir(), ".claude");

// ── cheap local probes (never launch a vendor CLI) ───────────────────────────

/** Is this JSON credential file's token already past its expiry? undefined = can't tell. */
function expiredCred(file: string): boolean | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const j = JSON.parse(raw);
    const at = j?.expiresAt ?? j?.expires_at ?? j?.claudeAiOauth?.expiresAt ?? j?.tokens?.expires_at;
    const ms = typeof at === "number" ? (at > 1e12 ? at : at * 1000) : typeof at === "string" ? Date.parse(at) : NaN;
    return Number.isFinite(ms) ? ms < Date.now() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the filesystem/env can say about a candidate's credential — a fact, never a verdict.
 *
 * `unauthenticated` is reserved for the case where the credential store the candidate would read
 * DOES NOT EXIST at all: waiting never fixes that, only a login does. Everything softer is
 * `indeterminate`, because both claude and codex can hold a live login in the macOS keychain or in a
 * per-workspace secrets file this process deliberately cannot read, and an expired OAuth token is a
 * short-lived session token the vendor renews on next use — not a sign-out.
 */
export function probeAuth(backend: string, configDir: string | null | undefined): { auth: AuthState; note: string | null } {
  switch (backend) {
    case "claude-code":
    case "claude": {
      const dir = claudeDir(configDir);
      if (!fs.existsSync(dir)) return { auth: "unauthenticated", note: `profile dir ${dir} does not exist — nothing to log in with` };
      const cred = path.join(dir, ".credentials.json");
      if (!fs.existsSync(cred))
        return { auth: "indeterminate", note: `${path.basename(dir)} has no .credentials.json (claude may hold this login in the keychain)` };
      return expiredCred(cred) === true
        ? { auth: "indeterminate", note: `${path.basename(dir)} OAuth token is past its expiry (the CLI usually renews it on next use)` }
        : { auth: "authenticated", note: null };
    }
    case "codex": {
      const dir = configDir || "";
      const key = !!process.env.OPENAI_API_KEY;
      if (!dir || !fs.existsSync(dir))
        return key
          ? { auth: "authenticated", note: null }
          : { auth: "unauthenticated", note: `CODEX_HOME ${dir || "(unset)"} does not exist and OPENAI_API_KEY is unset` };
      if (fs.existsSync(path.join(dir, "auth.json"))) return { auth: "authenticated", note: null };
      if (key) return { auth: "authenticated", note: null };
      return { auth: "indeterminate", note: `no auth.json under ${dir} (a workspace secrets file may still carry OPENAI_API_KEY)` };
    }
    case "openai-api":
      return process.env.OPENAI_API_KEY
        ? { auth: "authenticated", note: null }
        : { auth: "indeterminate", note: "OPENAI_API_KEY not in the daemon env (a workspace secrets file may carry it)" };
    case "grok":
    case "grok-cli": {
      const dir = path.join(os.homedir(), ".grok");
      return fs.existsSync(dir)
        ? { auth: "indeterminate", note: "grok's login state is only readable by running the CLI, which this gate never does" }
        : { auth: "unauthenticated", note: "~/.grok does not exist — grok has never been logged in on this host" };
    }
    case "cursor-agent":
    case "cursor":
      return process.env.CURSOR_API_KEY
        ? { auth: "authenticated", note: null }
        : { auth: "indeterminate", note: "CURSOR_API_KEY not in the daemon env" };
    default:
      return { auth: "indeterminate", note: "no local credential probe for this backend" };
  }
}

// ── recorded evidence → limit events ────────────────────────────────────────

/** Errors that mean the credential is out of allowance rather than the job being wrong. */
const CREDITS_RE = /\b402\b|payment required|billing|quota\s*(exceeded|limit)/i;
const isCredits = (err: string) => CREDIT_WALL_RE.test(err) || CREDITS_RE.test(err);
const AUTH_RE = /not logged in|please run \/login|invalid api key|authentication[_ ]?error|\b401\b|oauth token .*(expired|revoked)/i;

/** The reset time a recorded run knows about: our own column first, then the vendor's own wording. */
export function resetFromRun(row: { resets_at: string | null; error: string | null }, now = Date.now()): string | null {
  if (row.resets_at) return row.resets_at;
  const iso = parseLimitResetsAtMs(row.error);
  if (iso) return new Date(iso).toISOString();
  const clock = parseResetClock(row.error, now);
  return clock ? new Date(clock).toISOString() : null;
}

/** Classify one recorded run into the provider fact it carries, or nothing. */
export function limitFromRun(
  row: {
    status: string;
    error: string | null;
    resets_at: string | null;
    started_at: string | null;
    backend: string | null;
    config_dir: string | null;
  },
  now = Date.now(),
): LimitEvent | null {
  const cred = credentialFor(row.backend, row.config_dir);
  if (!cred) return null;
  const err = row.error ?? "";
  const at = row.started_at ?? new Date(now).toISOString();
  if (row.status === "rate_limited")
    return { ...cred, kind: "rate_limit", at, resetsAt: resetFromRun(row, now), detail: firstLine(err) || "run ended rate-limited" };
  if (isCredits(err))
    return { ...cred, kind: "credits", at, resetsAt: resetFromRun(row, now), detail: firstLine(err) };
  if (isProviderLimitError(err))
    return { ...cred, kind: "rate_limit", at, resetsAt: resetFromRun(row, now), detail: firstLine(err) };
  if (AUTH_RE.test(err)) return { ...cred, kind: "auth", at, resetsAt: null, detail: firstLine(err) };
  return null;
}

const firstLine = (s: string) => s.split("\n")[0].trim().slice(0, 160);

/** Is this fact still true right now? A window whose reset has passed has refilled. */
export function limitActive(e: LimitEvent, now = Date.now()): boolean {
  if (e.kind === "auth") return now - Date.parse(e.at) < DEFAULT_LIMIT_COOLDOWN_MS;
  if (e.resetsAt) return Date.parse(e.resetsAt) > now;
  // No reset time: fall back to the same cooldown the warm-manager fallback uses, so a wall with no
  // stated end does not block dispatch forever on one old row.
  const age = now - Date.parse(e.at);
  return Number.isFinite(age) && age < DEFAULT_LIMIT_COOLDOWN_MS;
}

// ── the snapshot (pure) ──────────────────────────────────────────────────────

const hhmm = (iso: string) => iso.slice(11, 16);

export function buildSnapshot(i: SnapshotInputs): QuotaSnapshot {
  const byKey = new Map<string, LimitEvent[]>();
  for (const e of i.limits) {
    if (!limitActive(e, i.now)) continue;
    const k = credKey(e);
    const list = byKey.get(k);
    if (list) list.push(e);
    else byKey.set(k, [e]);
  }

  const entries = i.surfaces.map((s): QuotaEntry => {
    const attention: string[] = [];
    const mine = (byKey.get(credKey(s)) ?? []).sort((a, b) => b.at.localeCompare(a.at));
    const wall = mine.find((e) => e.kind === "rate_limit" || e.kind === "credits");
    const authFact = mine.find((e) => e.kind === "auth");
    const floor = i.floors[credKey(s)] ?? i.floors[s.provider];

    let auth = s.auth;
    if (authFact) {
      // A run that actually failed on 401/"not logged in" outranks any file probe: that is the vendor
      // saying it, and a keychain-shaped `indeterminate` must not paper over it.
      auth = "unauthenticated";
      attention.push(`a run failed on authentication: ${authFact.detail}`);
    }
    if (s.authNote) attention.push(s.authNote);

    let percent: number | null = null;
    let runway: Runway = "unknown";
    let resetsAt: string | null = null;
    let usable: number | null = null;
    let confidence: Confidence = "unknown";

    if (wall) {
      percent = 0;
      runway = "exhausted_now";
      usable = 0;
      resetsAt = wall.resetsAt;
      confidence = wall.kind === "rate_limit" ? "measured" : "inferred";
      attention.push(
        wall.resetsAt
          ? `${wall.kind === "credits" ? "out of credits" : "rate limited"} until ${hhmm(wall.resetsAt)} — ${wall.detail}`
          : `${wall.kind === "credits" ? "out of credits" : "rate limited"}, no reset time given — ${wall.detail}`,
      );
    } else if (i.tokenBudget > 0 && s.tokens != null) {
      percent = Math.max(0, Math.min(100, 100 * (1 - s.tokens / i.tokenBudget)));
      confidence = "inferred";
      if (percent === 0) {
        runway = "exhausted_now";
        usable = 0;
        attention.push(`the ~5h window has spent its declared ${i.tokenBudget} token ceiling`);
      } else if (floor != null && percent < floor) {
        // The operator's own floor is the one number allowed to turn a measured percentage into a
        // refusal. Without it a proxy this rough must never block anything.
        runway = "projected_exhaustion";
        usable = 0;
        attention.push(`${percent.toFixed(0)}% of the declared 5h token budget left — under the operator's ${floor}% floor`);
      } else {
        attention.push(`${percent.toFixed(0)}% of the declared 5h token budget left, but the rolling window has no reset time — runway unprovable`);
      }
    } else {
      attention.push(
        i.tokenBudget > 0
          ? "no tokens charged to this credential in the window — nothing to measure yet"
          : "no quota surface: set CHRONOS_QUOTA_TOKENS_5H to give the 5h window a ceiling",
      );
    }

    if (auth === "unauthenticated" && runway === "unknown") {
      // Not exhaustion — but not eligible either, and the gate reads `auth`, so keep runway honest.
      attention.push("nothing can run on this credential until someone logs in");
    }

    return {
      provider: s.provider,
      scope: s.scope,
      effectivePercentRemaining: percent,
      runway,
      resetsAt,
      usableRunwaySeconds: usable,
      confidence,
      auth,
      inUse: s.inUse,
      attention,
      spendPriority: spendPriorityOf(percent, resetsAt, i.now),
    };
  });

  const attention: string[] = [];
  if (i.burn) attention.push(`burn brake: ${i.burn}`);
  return { at: new Date(i.now).toISOString(), entries, attention };
}

/**
 * ONE comparable scalar, positive = paid allowance on track to reach reset unused.
 *
 * percent-remaining minus share-of-window-remaining: at 60% left with half the window to go it is
 * +10 (money going spare), at 10% left with half the window to go it is -40 (overdrawn against the
 * clock). null whenever either half is unknown — 0 means EXACT utilization, a different claim.
 */
export function spendPriorityOf(percent: number | null, resetsAt: string | null, now: number): number | null {
  if (percent == null || !resetsAt) return null;
  const ms = Date.parse(resetsAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return percent - 100 * Math.min(1, ms / WINDOW_MS);
}

// ── the snapshot (probes + recorded evidence) ───────────────────────────────

const EVIDENCE_WINDOW_MS = 24 * 3600_000;
const TOKEN_WINDOW_MS = WINDOW_MS;

/**
 * Every credential this daemon could dispatch on, with what we know about each.
 *
 * Surfaces are discovered, not listed: one anthropic/codex scope per workspace `config_dir` (that IS
 * the account boundary) plus the single shared login of each global backend. A workspace nobody has
 * pointed at a profile still contributes the default one, because that is what its jobs would spend.
 */
export function quotaSnapshot(now = Date.now()): QuotaSnapshot {
  const sinceEvidence = new Date(now - EVIDENCE_WINDOW_MS).toISOString();
  const sinceTokens = new Date(now - TOKEN_WINDOW_MS).toISOString();

  const limits: LimitEvent[] = [];
  for (const row of runs.limitEvidenceSince(sinceEvidence)) {
    const e = limitFromRun(row, now);
    if (e) limits.push(e);
  }

  const tokens = new Map<string, number>();
  for (const row of runs.tokensByCredentialSince(sinceTokens)) {
    const cred = credentialFor(row.backend, row.config_dir);
    if (!cred) continue;
    tokens.set(credKey(cred), (tokens.get(credKey(cred)) ?? 0) + row.tokens);
  }

  // (backend, configDir) pairs worth reporting on. The value is the configDir so the auth probe reads
  // exactly the store a dispatch would, and `used` marks the ones something actually reaches for.
  const pairs = new Map<string, { backend: string; configDir: string | null; used: boolean }>();
  const add = (backend: string, configDir: string | null, used: boolean) => {
    const cred = credentialFor(backend, configDir);
    if (!cred) return;
    const prev = pairs.get(credKey(cred));
    if (prev) prev.used ||= used;
    else pairs.set(credKey(cred), { backend, configDir, used });
  };
  add("claude-code", null, false);
  for (const w of workspaces.list()) {
    // config_dir IS the workspace's claude account, so that surface is always reachable from here.
    // Everything else is only in use if the workspace names it: its default, its allow-list, or a
    // route_config rung. A backend nobody named is reported, never alarmed on.
    add("claude-code", w.config_dir, w.default_backend === "claude-code" || w.default_backend === "claude");
    for (const b of namedBackends(w)) add(b, w.config_dir, true);
  }
  for (const b of ["grok", "opencode", "cursor-agent", "openai-api"]) add(b, null, false);

  const surfaces: Surface[] = [];
  for (const [key, { backend, configDir, used }] of pairs) {
    const cred = credentialFor(backend, configDir)!;
    const probe = probeAuth(backend, configDir);
    const spent = tokens.get(key) ?? null;
    surfaces.push({
      ...cred,
      tokens: spent,
      auth: probe.auth,
      authNote: probe.note,
      // Spending is the strongest evidence of use there is — it already happened.
      inUse: used || (spent ?? 0) > 0 || limits.some((l) => credKey(l) === key),
    });
  }

  const burn = burnState();
  return buildSnapshot({
    now,
    surfaces,
    limits,
    tokenBudget: CONFIG.quotaTokens5h,
    floors: CONFIG.quotaFloors,
    burn: burn.level === "ok" ? null : `${burn.level} — ${burn.why}`,
  });
}

/** Every backend a workspace actually names: its default, its allow-list, and its route_config rungs. */
function namedBackends(w: { default_backend: string | null; backends: string | null; route_config: string | null }): string[] {
  const out = new Set<string>();
  if (w.default_backend) out.add(w.default_backend);
  for (const raw of [w.backends, w.route_config]) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const values = Array.isArray(parsed) ? parsed : Object.values(parsed ?? {});
      for (const v of values) {
        if (typeof v !== "string") continue;
        // route_config values are "backend:model" (or several, comma-separated); `backends` is bare names.
        for (const one of v.split(",")) {
          const name = one.trim().split(":")[0];
          if (name && hasBackend(name)) out.add(name);
        }
      }
    } catch {
      // A workspace column holding a typo must narrow what we claim, never widen it.
    }
  }
  return [...out];
}

/**
 * The same snapshot, memoized, for surfaces that POLL (operational health rides on /health, which the
 * phone and `mc fleet` hit every few seconds). The dispatch gate deliberately does NOT use this: a wall
 * recorded three seconds ago is exactly the one it has to see.
 */
let memo: { at: number; snap: QuotaSnapshot } | null = null;
export function quotaSnapshotCached(now = Date.now(), ttlMs = 30_000): QuotaSnapshot {
  if (memo && now - memo.at < ttlMs) return memo.snap;
  const snap = quotaSnapshot(now);
  memo = { at: now, snap };
  return snap;
}

export function entryFor(snapshot: QuotaSnapshot, cred: { provider: ProviderFamily; scope: string }): QuotaEntry | null {
  return snapshot.entries.find((e) => e.provider === cred.provider && e.scope === cred.scope) ?? null;
}

// ── three gates, then rank ───────────────────────────────────────────────────

export interface Candidate {
  backend: string;
  model: string | null;
  /** The difficulty tier this candidate was listed for. Lower than required = a downgrade. */
  reasoningClass: number;
}

export interface GateContext {
  /** The class the work needs. A candidate below it is reported and never chosen. */
  reasoningClass: number;
  /** How long this run plausibly needs. Known runway must outlast it. */
  horizonSeconds: number;
  snapshot: QuotaSnapshot;
  /** The config dir the dispatch would use — decides WHICH credential each candidate spends. */
  configDir?: string | null;
  /** `workspaces.backends` allow-list json, so the gate refuses what the workspace may not spawn. */
  wsBackends?: string | null;
  /**
   * This dispatch is headless. An interactive-only CLI (grok) has no JSONL mode — its buildArgs throws
   * async and strands the ticket at in_progress — so the gate must never rank it as a stand-in here,
   * even when its quota is the healthiest on the host.
   */
  headlessOnly?: boolean;
}

export interface CandidateReport {
  backend: string;
  model: string | null;
  provider: ProviderFamily | null;
  scope: string | null;
  reasoningClass: number;
  eligible: boolean;
  classFit: boolean;
  runwayOk: boolean;
  spendPriority: number | "unknown";
  /** Why it was blocked, or the uncertainty it carries. */
  why: string;
  /** One rationale line naming the evidence, the three gate results and the scalar. */
  line: string;
}

export interface GateDecision {
  at: string;
  choice: Candidate | null;
  rationale: string[];
  /** `why` is the evidence; `phrase` is the same fact in the words the operator gets paged with. */
  blocked: Array<{ backend: string; model: string | null; why: string; phrase: string }>;
  candidates: CandidateReport[];
  /** True when the winner was picked by the operator's route_config order, not by evidence. */
  tie: boolean;
  summary: string;
}

const label = (c: { backend: string; model: string | null }) => `${c.backend}/${c.model ?? "default"}`;

/**
 * One blocked candidate in the words the operator is paged with — "Claude is out of allowance until
 * 14:00", not "runway exhausted_now". A page nobody can act on from the lock screen is noise.
 */
function phraseFor(r: CandidateReport, ctx: GateContext): string {
  const who = human(r.backend);
  const e = r.scope && r.provider ? entryFor(ctx.snapshot, { provider: r.provider, scope: r.scope }) : null;
  if (e?.auth === "unauthenticated") return `${who} isn't logged in`;
  if (!r.runwayOk && e?.runway === "exhausted_now")
    return `${who} is out of allowance${e.resetsAt ? ` until ${hhmm(e.resetsAt)}` : ""}`;
  if (!r.runwayOk && e?.usableRunwaySeconds != null)
    return `${who} has only ${Math.round(e.usableRunwaySeconds / 60)}m of runway left`;
  if (!r.classFit) return `${who}/${r.model ?? "default"} is a weaker tier than this work needs`;
  return `${who} can't be used (${r.why})`;
}

export function chooseBackend(candidates: Candidate[], ctx: GateContext): GateDecision {
  const at = ctx.snapshot.at;
  if (!candidates.length)
    return { at, choice: null, rationale: [], blocked: [], candidates: [], tie: false, summary: "no candidates were resolved for this run" };

  const reports: CandidateReport[] = candidates.map((c) => {
    const cred = credentialFor(c.backend, ctx.configDir);
    const entry = cred ? entryFor(ctx.snapshot, cred) : null;
    const notes: string[] = [];

    // ── gate 1: eligibility ───────────────────────────────────────────────
    let eligible = true;
    if (!hasBackend(c.backend)) {
      eligible = false;
      notes.push(`${c.backend} is not a registered backend`);
    }
    const spawnErr = validateSpawnTarget(c.backend, c.model);
    if (spawnErr) {
      eligible = false;
      notes.push(spawnErr);
    }
    if (!backendAllowed(ctx.wsBackends, c.backend)) {
      eligible = false;
      notes.push(`this workspace may not spawn ${c.backend}`);
    }
    if (ctx.headlessOnly && hasBackend(c.backend) && getBackend(c.backend).supportsHeadless === false) {
      eligible = false;
      notes.push(`${c.backend} has no headless mode — it can only be driven in a terminal`);
    }
    if (entry?.auth === "unauthenticated") {
      eligible = false;
      notes.push(`${c.backend} is not logged in (${entry.attention[0] ?? "credential store missing"})`);
    } else if (entry?.auth === "indeterminate") {
      // Uncertainty is disclosed, never a verdict — firstmate's rule, and the one that keeps a
      // keychain-held login from reading as a logout.
      notes.push("login state indeterminate (disclosed, not blocking)");
    }

    // ── gate 2: reasoning-class fit ───────────────────────────────────────
    const classFit = c.reasoningClass >= ctx.reasoningClass;
    if (!classFit) notes.push(`class ${c.reasoningClass} is weaker than the required ${ctx.reasoningClass} — never substituted to save quota`);

    // ── gate 3: runway feasibility ────────────────────────────────────────
    let runwayOk = true;
    if (entry?.runway === "exhausted_now") {
      runwayOk = false;
      notes.push(entry.resetsAt ? `exhausted now, back at ${hhmm(entry.resetsAt)}` : "exhausted now, no reset time known");
    } else if (entry?.runway === "projected_exhaustion") {
      const secs = entry.usableRunwaySeconds;
      if (secs == null) notes.push("projected exhaustion with no usable-seconds figure (disclosed, not blocking)");
      else if (secs < ctx.horizonSeconds) {
        runwayOk = false;
        notes.push(`${Math.round(secs / 60)}m of runway left against a ${Math.round(ctx.horizonSeconds / 60)}m horizon`);
      }
    } else if (entry?.runway === "unknown" || !entry) {
      notes.push("runway unknown (disclosed, not blocking)");
    }

    const sp: number | "unknown" = entry?.spendPriority ?? "unknown";
    const ok = eligible && classFit && runwayOk;
    const line =
      `${label(c)} · ${cred ? `${cred.provider} ${cred.scope}` : "no credential we model"} · ` +
      `eligible ${eligible ? "yes" : "NO"} · class ${c.reasoningClass}${classFit ? "≥" : "<"}${ctx.reasoningClass} · ` +
      `runway ${entry?.runway ?? "unknown"}${runwayOk ? "" : " FAILS"} · spendPriority ${sp === "unknown" ? "unknown" : sp.toFixed(1)}` +
      (notes.length ? ` · ${notes.join("; ")}` : "");

    return {
      backend: c.backend,
      model: c.model,
      provider: cred?.provider ?? null,
      scope: cred?.scope ?? null,
      reasoningClass: c.reasoningClass,
      eligible,
      classFit,
      runwayOk,
      spendPriority: sp,
      why: notes.join("; ") || (ok ? "nothing contradicts it" : "blocked"),
      line,
    };
  });

  const anySurvivor = reports.some((r) => r.eligible && r.classFit && r.runwayOk);
  const blocked = reports
    .filter((r) => !(r.eligible && r.classFit && r.runwayOk))
    .map((r) => ({ backend: r.backend, model: r.model, why: r.why, phrase: phraseFor(r, ctx) }));

  if (!anySurvivor) {
    const inClass = reports.filter((r) => r.classFit);
    // The "not downgrading" sentence is only said when there WAS a weaker rung to fall to — otherwise
    // it reads as a decision nobody made.
    const weaker = reports.some((r) => !r.classFit);
    const summary = inClass.length
      ? `every candidate in class ${ctx.reasoningClass} is blocked — ${inClass.map((r) => `${label(r)} (${r.why})`).join("; ")}.` +
        (weaker ? " Not routing to a weaker class." : "")
      : `no candidate meets the required reasoning class ${ctx.reasoningClass}`;
    return { at, choice: null, rationale: reports.map((r) => r.line), blocked, candidates: reports, tie: false, summary };
  }

  // Rank: a known scalar always beats an unknown one (firstmate: prefer known viable evidence), and
  // among knowns the highest wins. Ranked by INDEX, and the sort is stable, so the operator's own
  // route_config order survives underneath as the tie-break — which is the whole tie rule.
  const spOf = (i: number) => reports[i].spendPriority;
  const ranked = reports
    .map((_, i) => i)
    .filter((i) => reports[i].eligible && reports[i].classFit && reports[i].runwayOk)
    .sort((a, b) => {
      const x = spOf(a);
      const y = spOf(b);
      if (x === "unknown" && y === "unknown") return 0;
      if (x === "unknown") return 1;
      if (y === "unknown") return -1;
      return y - x;
    });
  const choice = candidates[ranked[0]];
  const top = spOf(ranked[0]);
  const tie = ranked.length > 1 && spOf(ranked[1]) === top;
  const rationale = reports.map((r) => r.line);
  const summary =
    `${label(choice)} — ` +
    (tie
      ? `tied on spendPriority ${top === "unknown" ? "unknown" : top.toFixed(1)} with ` +
        `${ranked.slice(1).filter((i) => spOf(i) === top).map((i) => label(reports[i])).join(", ")}; ` +
        `taking the first in the operator's route_config order`
      : top === "unknown"
        ? "the only survivor with no comparable spendPriority; nothing contradicts it"
        : `highest spendPriority ${top.toFixed(1)} among ${ranked.length} survivors`);
  return { at, choice, rationale, blocked, candidates: reports, tie, summary };
}

// ── dispatch wiring ─────────────────────────────────────────────────────────

export type GateMode = "off" | "warn" | "enforce";

export function gateMode(): GateMode {
  const m = String(CONFIG.quotaGate ?? "warn").toLowerCase();
  return m === "off" || m === "enforce" ? m : "warn";
}

/** Last N decisions, for GET /api/quota and `mc quota`. In memory: a verdict is a diagnostic, not a record. */
const decisions: Array<GateDecision & { job: string; run: string; mode: GateMode }> = [];
export function recentDecisions(limit = CONFIG.quotaDecisionsKept): Array<GateDecision & { job: string; run: string; mode: GateMode }> {
  return decisions.slice(0, Math.max(1, limit));
}
export function resetQuotaGateState(): void {
  decisions.length = 0;
  notified.clear();
  memo = null;
}

// Side effects behind setters, the shape wake-queue already uses: a test must never reach Telegram,
// and the wake import is lazy so this module stays out of the dispatcher's import cycle.
type Notifier = (text: string) => Promise<unknown>;
type Waker = (w: { topic: string; key: string; subject?: string | null; workspace_id?: string | null; payload?: unknown }) => unknown;
let notifier: Notifier = (text) => notify(text);
let waker: Waker = (w) => void import("./wake-queue.js").then((m) => m.enqueueWake(w)).catch(() => {});
export function setQuotaNotifier(fn: Notifier): void {
  notifier = fn;
}
export function setQuotaWaker(fn: Waker): void {
  waker = fn;
}

// One alert per credential per cooldown. A blocked tier re-parks every ticket behind it; the operator
// needs the fact once, not once per run.
const NOTIFY_COOLDOWN_MS = 60 * 60_000;
const notified = new Map<string, number>();

/** Plain words: what stopped, which providers are out and what the operator can do about it. */
export function blockMessage(what: string, decision: GateDecision): string {
  // Deduped: two route_config rungs on one exhausted profile are ONE fact, and reading it twice in a
  // notification is how an alert stops being read at all.
  const parts = [...new Set(decision.blocked.map((b) => b.phrase))].slice(0, 3);
  return `${what} can't start — ${parts.join(" and ")}; top up or say which backend to use.`;
}

const HUMAN: Record<string, string> = {
  "claude-code": "Claude",
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  "grok-cli": "Grok",
  opencode: "the gateway",
  "cursor-agent": "Cursor",
  cursor: "Cursor",
  "openai-api": "the OpenAI API",
};
const human = (backend: string) => HUMAN[backend] ?? backend;

/**
 * How long this run plausibly needs — the horizon the runway gate measures against.
 *
 * Median of this workspace's own finished runs at this difficulty, because a tier-1 config tweak and
 * a tier-5 redesign are not the same bet. No history yet → the configured fallback, never zero (a
 * zero horizon would let a window with two minutes left pass every gate).
 */
export function horizonSeconds(workspaceId: string | null, difficulty: number): number {
  const fallback = Math.max(60, CONFIG.quotaHorizonSec);
  if (!workspaceId) return fallback;
  const secs = runs.durationsForDifficulty(workspaceId, difficultyValues(difficulty), 40).filter((s) => s > 0);
  if (!secs.length) return fallback;
  secs.sort((a, b) => a - b);
  return Math.max(60, Math.round(secs[Math.floor(secs.length / 2)]));
}

// The column still holds legacy words for rows graded before the 1-5 scale; match both spellings.
const LEGACY_BY_DIFFICULTY: Record<number, string[]> = { 1: ["trivial"], 2: ["easy"], 3: ["medium"], 4: ["hard"], 5: [] };
const difficultyValues = (d: number) => [String(d), ...(LEGACY_BY_DIFFICULTY[d] ?? [])];

/**
 * The gate at the dispatch seam. Returns a block reason, or null to proceed.
 *
 * Wraps the existing difficulty→route_config resolution rather than replacing it: candidate 0 is
 * always what the job already resolved to, and the extras are the other entries the operator listed
 * for that same tier. `warn` records the verdict and never blocks; `enforce` blocks, and may move the
 * run onto a higher-ranked candidate of the SAME class.
 */
export function gateDispatch(job: Job, runId: string): string | null {
  const mode = gateMode();
  if (mode === "off") return null;
  const cred = credentialFor(job.backend, null);
  // A backend we model no credential for (mock, and anything unregistered) has no evidence to gate
  // on. Inventing a verdict for it would be exactly the coercion this module exists to refuse.
  if (!cred) return null;

  const ws = job.workspace_id ? workspaces.get(job.workspace_id) : undefined;
  const ticket = job.ticket_id ? tickets.get(job.ticket_id) : undefined;
  const difficulty = difficultyOf(ticket?.complexity);
  const primary: Candidate = { backend: job.backend, model: job.model, reasoningClass: difficulty };
  const extras: Candidate[] = ws
    // model: the ticket's own pin, so routeCandidates returns nothing for a ticket whose model the
    // operator fixed by hand — the gate may refuse that choice, never quietly replace it.
    ? routeCandidates({ complexity: ticket?.complexity ?? null, backend: ticket?.backend ?? null, model: ticket?.model ?? null }, ws)
        .map((r) => ({ backend: r.backend ?? ws.default_backend, model: r.model ?? job.model, reasoningClass: difficulty }))
        .filter((c) => !(c.backend === primary.backend && c.model === primary.model))
    : [];

  const snapshot = quotaSnapshot();
  const decision = chooseBackend([primary, ...extras], {
    reasoningClass: difficulty,
    horizonSeconds: horizonSeconds(job.workspace_id, difficulty),
    snapshot,
    configDir: ws?.config_dir ?? null,
    wsBackends: ws?.backends ?? null,
    headlessOnly: true,
  });
  decisions.unshift({ ...decision, job: job.name, run: runId, mode });
  decisions.length = Math.min(decisions.length, Math.max(1, CONFIG.quotaDecisionsKept));

  if (decision.choice) {
    const line = `route: ${label(decision.choice)} — ${decision.summary}`;
    events.add(runId, "route", { text: line, mode, rationale: decision.rationale });
    const moved = decision.choice.backend !== primary.backend || decision.choice.model !== primary.model;
    if (mode === "enforce" && moved) {
      jobs.update(job.id, { backend: decision.choice.backend, model: decision.choice.model });
      job.backend = decision.choice.backend;
      job.model = decision.choice.model;
      console.log(`[quota-gate] ${job.name}: ${label(primary)} → ${label(decision.choice)} — ${decision.summary}`);
    } else if (moved) {
      console.log(`[quota-gate] warn: ${job.name} would move ${label(primary)} → ${label(decision.choice)} — ${decision.summary}`);
    }
    return null;
  }

  const reason = `no viable backend: ${decision.summary}`;
  events.add(runId, "route", { text: `route: BLOCKED — ${decision.summary}`, mode, rationale: decision.rationale });
  if (mode === "warn") {
    console.warn(`[quota-gate] warn: ${job.name} would be parked — ${decision.summary}`);
    return null;
  }
  console.error(`[quota-gate] ${job.name}: ${reason}`);
  announce(job, decision);
  return reason;
}

/** Tell the operator once, and wake Robert so the call gets made instead of waiting for a human. */
function announce(job: Job, decision: GateDecision): void {
  const what = job.ticket_id ? (tickets.get(job.ticket_id)?.key ?? job.name) : job.name;
  // Keyed on the credentials that are actually out, not on backend names: one client's exhausted
  // claude profile must not silence the alert about another client's.
  const out = decision.candidates.filter((c) => !(c.eligible && c.classFit && c.runwayOk));
  const key = `quota-block:${[...new Set(out.map((c) => `${c.provider}:${c.scope}`))].sort().join(",")}`;
  const now = Date.now();
  const last = notified.get(key);
  if (last == null || now - last > NOTIFY_COOLDOWN_MS) {
    notified.set(key, now);
    void Promise.resolve(notifier(`🪫 <b>Blocked on quota</b>\n${esc(blockMessage(what, decision))}`)).catch(() => {});
  }
  waker({
    topic: "quota.blocked",
    key: `${key}:${what}`,
    subject: job.ticket_id ?? null,
    workspace_id: job.workspace_id ?? null,
    payload: { say: `${blockMessage(what, decision)} Read GET /api/quota before you re-dispatch anything on those backends.` },
  });
}
