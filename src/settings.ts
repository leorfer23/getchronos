/**
 * Settings the operator changes from the Desk (⋯ → ⚙ Settings), per workspace or for every one.
 *
 * Every knob here used to be a CHRONOS_* line in .secrets plus a daemon restart, so turning Robert
 * off for an evening meant editing a file and bouncing the daemon. Now a knob resolves on every read:
 *   workspace override → global override → the env/CONFIG default it always had.
 * Overrides live in kv (`settings:global`, `settings:ws:<id>`) as JSON objects; unset = inherit.
 * A few settings are the workspace row's own columns (the ones PATCH /api/workspaces/:id already
 * owned): those are per workspace only and are written through the same validation as that route.
 *
 * Call sites read `setting(key, workspaceId)` at the moment they decide, never at boot, so a change
 * lands on the next decision with no restart.
 */
import { CONFIG } from "./config.js";
import { kv } from "./store/kv.js";
import { workspaces } from "./store.js";
import { bus } from "./bus.js";
import { PatchWorkspaceSchema } from "./validation.js";
import { listBackends } from "./backends/index.js";
import type { Workspace } from "./types.js";

export type SettingType = "bool" | "int" | "number" | "string" | "enum" | "list";
export type SettingValue = boolean | number | string | string[] | null;
/** both: a global value plus per-workspace overrides; global: one for the Mac; ws: per workspace only (a row column, or kv). */
export type SettingLevel = "both" | "global" | "ws";
export type SettingSource = "default" | "global" | "workspace";

export interface SettingDef {
  key: string;
  group: string;
  label: string;
  help: string;
  type: SettingType;
  level: SettingLevel;
  options?: () => string[];
  /** The CHRONOS_* variable the default comes from, so .secrets and the Desk say the same thing. */
  env?: string;
  default: (ws?: Workspace | null) => SettingValue;
  min?: number;
  max?: number;
  nullable?: boolean;
  /** level "ws": the workspaces column it reads and writes. */
  column?: keyof Workspace & string;
  /** level "global": a kv key some older code already reads (web.model). */
  kvKey?: string;
  onChange?: (workspaceId: string | null) => void;
}

const REGISTRY = new Map<string, SettingDef>();
/** Page order. */
export const GROUPS = ["Workspace", "Robert", "Accounts", "Failover", "Autonomy", "Memory", "Limits", "Safety"];

export function defineSetting(d: SettingDef): SettingDef {
  REGISTRY.set(d.key, d);
  return d;
}

export const settingDefs = (): SettingDef[] => [...REGISTRY.values()];

/** A hook for code that must react to a change (e.g. restarting warm managers on a model switch). */
export function onSettingChange(key: string, fn: (workspaceId: string | null) => void): void {
  const d = REGISTRY.get(key);
  if (d) d.onChange = fn;
}

const GLOBAL_KEY = "settings:global";
const wsKey = (id: string) => `settings:ws:${id}`;
const cache = new Map<string, Record<string, SettingValue>>();

function overrides(key: string): Record<string, SettingValue> {
  const hit = cache.get(key);
  if (hit) return hit;
  let v: Record<string, SettingValue> = {};
  try {
    const raw = kv.get(key);
    const j = raw ? JSON.parse(raw) : {};
    if (j && typeof j === "object" && !Array.isArray(j)) v = j;
  } catch {}
  cache.set(key, v);
  return v;
}

/** Test seam. */
export function _resetSettingsCache() {
  cache.clear();
}

function def(key: string): SettingDef {
  const d = REGISTRY.get(key);
  if (!d) throw new Error(`unknown setting: ${key}`);
  return d;
}

/** Rows keep booleans as 0/1 and lists as JSON text. */
function fromRow(d: SettingDef, v: unknown): SettingValue {
  if (v === undefined || v === null) return null;
  if (d.type === "bool") return v === true || v === 1;
  if (d.type === "list") {
    if (Array.isArray(v)) return v as string[];
    try { const j = JSON.parse(String(v)); return Array.isArray(j) ? j : []; } catch { return []; }
  }
  return v as SettingValue;
}

export function resolveSetting(key: string, workspaceId?: string | null): { value: SettingValue; source: SettingSource } {
  const d = def(key);
  const ws = workspaceId ? workspaces.get(workspaceId) ?? null : null;
  if (d.level === "ws" && d.column) {
    if (!ws) return { value: d.default(ws), source: "default" };
    return { value: fromRow(d, ws[d.column]) ?? d.default(ws), source: "workspace" };
  }
  if (d.level === "ws") {
    const w = ws ? overrides(wsKey(ws.id)) : {};
    return key in w ? { value: w[key], source: "workspace" } : { value: d.default(ws), source: "default" };
  }
  if (ws && d.level === "both") {
    const w = overrides(wsKey(ws.id));
    if (key in w) return { value: w[key], source: "workspace" };
  }
  if (d.kvKey) {
    const raw = kv.get(d.kvKey);
    if (raw != null && raw !== "") return { value: raw, source: "global" };
  } else {
    const g = overrides(GLOBAL_KEY);
    if (key in g) return { value: g[key], source: "global" };
  }
  return { value: d.default(ws), source: "default" };
}

export function setting<T extends SettingValue = SettingValue>(key: string, workspaceId?: string | null): T {
  return resolveSetting(key, workspaceId).value as T;
}

export const settingOn = (key: string, workspaceId?: string | null): boolean => setting(key, workspaceId) === true;

/** Coerce and check a value from the wire. Throws with a message fit for the Desk. */
export function coerceSetting(d: SettingDef, raw: unknown): SettingValue {
  if (raw === null && d.nullable) return null;
  switch (d.type) {
    case "bool":
      if (typeof raw === "boolean") return raw;
      throw new Error(`${d.label}: expected on/off`);
    case "int":
    case "number": {
      const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
      if (typeof n !== "number" || !Number.isFinite(n) || (d.type === "int" && !Number.isInteger(n)))
        throw new Error(`${d.label}: expected ${d.type === "int" ? "a whole number" : "a number"}`);
      if (d.min != null && n < d.min) throw new Error(`${d.label}: at least ${d.min}`);
      if (d.max != null && n > d.max) throw new Error(`${d.label}: at most ${d.max}`);
      return n;
    }
    case "enum": {
      const opts = d.options?.() ?? [];
      if (typeof raw === "string" && opts.includes(raw)) return raw;
      throw new Error(`${d.label}: one of ${opts.join(", ")}`);
    }
    case "list": {
      const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : null;
      if (!arr || arr.some((x) => typeof x !== "string")) throw new Error(`${d.label}: expected a list`);
      const out = [...new Set((arr as string[]).map((s) => s.trim()).filter(Boolean))];
      const opts = d.options?.();
      const bad = opts ? out.filter((x) => !opts.includes(x)) : [];
      if (bad.length) throw new Error(`${d.label}: unknown ${bad.join(", ")}`);
      return out;
    }
    case "string":
      if (typeof raw === "string") return raw.trim().slice(0, 500);
      throw new Error(`${d.label}: expected text`);
  }
}

/**
 * Write one setting. `value === null` on a "both"/"global" setting clears the override (inherit
 * again); on a workspace column it writes NULL when the column allows it.
 */
export function writeSetting(key: string, value: unknown, workspaceId?: string | null): void {
  const d = def(key);
  const wsId = workspaceId || null;
  if (d.level === "global" && wsId) throw new Error(`${d.label} is one setting for every workspace`);
  if (d.level === "ws" && !wsId) throw new Error(`${d.label} belongs to a workspace — pick one`);
  if (wsId && !workspaces.get(wsId)) throw new Error("workspace not found");
  if (d.level === "ws" && d.column && wsId) {
    const v = coerceSetting(d, value);
    const parsed = PatchWorkspaceSchema.safeParse({ [d.column]: v });
    if (!parsed.success) throw new Error(`${d.label}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    workspaces.update(wsId, parsed.data as any);
    bus.publish({ topic: "workspace.changed", workspace_id: wsId } as any);
  } else if (d.kvKey) {
    if (value === null || value === undefined) kv.del(d.kvKey);
    else kv.set(d.kvKey, String(coerceSetting(d, value)));
  } else {
    const k = wsId ? wsKey(wsId) : GLOBAL_KEY;
    const next = { ...overrides(k) };
    if (value === null || value === undefined) delete next[key];
    else next[key] = coerceSetting(d, value);
    if (Object.keys(next).length) kv.set(k, JSON.stringify(next));
    else kv.del(k);
    cache.delete(k);
  }
  bus.publish({ topic: "settings.changed", key, workspace_id: wsId } as any);
  try { d.onChange?.(wsId); } catch (e: any) { console.warn(`[settings] ${key} onChange:`, e?.message ?? e); }
}

export interface SettingView {
  key: string;
  group: string;
  label: string;
  help: string;
  type: SettingType;
  level: SettingLevel;
  options?: string[];
  env?: string;
  min?: number;
  max?: number;
  nullable?: boolean;
  value: SettingValue;
  source: SettingSource;
  /** What clearing this level's override would give: the global value, or the default. */
  inherited: SettingValue;
}

/** Everything the Settings page shows for one level: a workspace (both + ws) or global (both + global). */
export function settingsView(workspaceId?: string | null): SettingView[] {
  const ws = workspaceId ? workspaces.get(workspaceId) ?? null : null;
  const rank = (g: string) => { const i = GROUPS.indexOf(g); return i < 0 ? GROUPS.length : i; };
  return settingDefs()
    .sort((a, b) => rank(a.group) - rank(b.group))
    .filter((d) => (ws ? d.level !== "global" : d.level !== "ws"))
    .map((d) => {
      const { value, source } = resolveSetting(d.key, ws?.id ?? null);
      const inherited = ws && d.level === "both" ? resolveSetting(d.key, null).value : d.default(ws);
      // A per-workspace kv setting can be reset to its default like any override; a column cannot.
      const level: SettingLevel = d.level === "ws" && !d.column ? "both" : d.level;
      return {
        key: d.key, group: d.group, label: d.label, help: d.help, type: d.type, level,
        options: d.options?.(), env: d.env, min: d.min, max: d.max, nullable: d.nullable,
        value, source, inherited,
      };
    });
}

// ───────────────────────────── the settings ─────────────────────────────

const backendNames = () => listBackends().map((b) => b.name);

// Robert — every automatic turn he takes. The chat always answers the operator, whatever is off here.
defineSetting({
  key: "robert.enabled", group: "Robert", level: "both", type: "bool",
  label: "Robert works on his own",
  help: "Off: no automatic Robert turns here — no wake-ups, prompt answers, watch reports or ask triage. Chat still answers you.",
  default: () => true,
});
defineSetting({
  key: "robert.drive", group: "Robert", level: "both", type: "bool", env: "CHRONOS_ROBERT_DRIVE",
  label: "Wake when a terminal stops",
  help: "Robert looks at terminals when they finish, block or need a decision (all of them, or only 🤖 ones — see Watch every terminal).",
  default: () => CONFIG.robertDrive.enabled,
});
defineSetting({
  key: "robert.watch_all", group: "Robert", level: "both", type: "bool", env: "CHRONOS_ROBERT_WATCH_ALL",
  label: "Watch every terminal",
  help: "Off: Robert only wakes for terminals you handed him (🤖), Lead workers, and ones waiting on him.",
  default: () => process.env.CHRONOS_ROBERT_WATCH_ALL !== "0",
});
defineSetting({
  key: "robert.sweep", group: "Robert", level: "both", type: "bool", env: "CHRONOS_ROBERT_SWEEP",
  label: "Check in while terminals work",
  help: "Every few minutes, while a terminal here is working, Robert looks over this workspace's fleet and pushes what is stuck.",
  default: () => process.env.CHRONOS_ROBERT_SWEEP !== "0",
});
defineSetting({
  key: "robert.prompts", group: "Robert", level: "both", type: "bool", env: "CHRONOS_TERMINAL_PROMPTS",
  label: "Answer orange prompts",
  help: "Robert picks an option on a terminal's on-screen question when it is in scope.",
  default: () => CONFIG.terminalPrompts,
});
defineSetting({
  key: "robert.ticket_wakes", group: "Robert", level: "both", type: "bool", env: "CHRONOS_ROBERT_WAKE",
  label: "Wake on reviews and blocked tickets",
  help: "New reviews, new asks and blocked tickets wake Robert to make a call.",
  default: () => CONFIG.robertWake,
});
defineSetting({
  key: "robert.asks", group: "Robert", level: "both", type: "bool", env: "CHRONOS_ASK_ROBERT",
  label: "Agents ask Robert first",
  help: "Off: an agent's question goes straight to you.",
  default: () => process.env.CHRONOS_ASK_ROBERT !== "0",
});
defineSetting({
  key: "robert.watches", group: "Robert", level: "both", type: "bool",
  label: "Standing watch reports",
  help: "Off: watches stay set but send no reports (and cost nothing) until turned back on.",
  default: () => true,
});
defineSetting({
  key: "robert.hosts", group: "Robert", level: "global", type: "bool", env: "CHRONOS_ROBERT_HOST_WAKES",
  label: "Wake on computer trouble",
  help: "A computer offline with work on it, terminals failover could not move, a policy refusal, a logged-out CLI, a host long behind the brain.",
  default: () => process.env.CHRONOS_ROBERT_HOST_WAKES !== "0",
});
defineSetting({
  key: "robert.per_terminal_hour", group: "Robert", level: "both", type: "int", min: 0, max: 60,
  env: "CHRONOS_ROBERT_DRIVE_PER_TERMINAL_HOUR",
  label: "Wake-ups per terminal per hour", help: "0 stops terminal wake-ups.",
  default: () => CONFIG.robertDrive.perSessionHour,
});
defineSetting({
  key: "robert.per_hour", group: "Robert", level: "global", type: "int", min: 0, max: 600,
  env: "CHRONOS_ROBERT_DRIVE_PER_HOUR",
  label: "Wake-ups per hour, all workspaces", help: "The fleet-wide ceiling on terminal wake-ups.",
  default: () => CONFIG.robertDrive.globalHour,
});
defineSetting({
  key: "robert.model", group: "Robert", level: "global", type: "enum", kvKey: "web.model", env: "CHRONOS_VOICE_MODEL",
  label: "Robert's model", help: "The Desk chat and his automatic turns. Switching restarts his warm sessions.",
  options: () => ["opus", "sonnet", "fable", "haiku"],
  default: () => CONFIG.agent.voiceModel,
});

// Failover
defineSetting({
  key: "failover.enabled", group: "Failover", level: "both", type: "bool", env: "CHRONOS_TERMINAL_FAILOVER",
  label: "Move walled terminals on",
  help: "A terminal out of credits switches model, then opens a stand-in on the next backend.",
  default: () => CONFIG.terminalFailover,
});
defineSetting({
  key: "failover.backends", group: "Failover", level: "both", type: "list", env: "CHRONOS_TERMINAL_FALLBACK_BACKENDS",
  label: "Stand-in backends, in order", help: "Tried after the workspace's fallback backend.",
  // The env list may use an alias ("cursor"): keep it pickable so the chips show what is really set.
  options: () => [...new Set([...backendNames(), ...CONFIG.terminalFallbackBackends])],
  default: () => CONFIG.terminalFallbackBackends,
});
defineSetting({
  key: "failover.max", group: "Failover", level: "both", type: "int", min: 1, max: 10, env: "CHRONOS_TERMINAL_FAILOVER_MAX",
  label: "Failover steps per terminal", help: "How many times one piece of work may move on.",
  default: () => CONFIG.terminalFailoverMax,
});

// Memory
defineSetting({
  key: "memory.summaries", group: "Memory", level: "both", type: "bool",
  label: "Summarize ended sessions", help: "One short model call per ended terminal: its summary, tags and learnings.",
  default: () => true,
});
defineSetting({
  key: "memory.learnings", group: "Memory", level: "both", type: "bool", env: "CHRONOS_AUTO_MEMORY",
  label: "Save learnings to memory", help: "Durable facts from a session's summary go into the workspace memo.",
  default: () => CONFIG.autoMemory,
});
defineSetting({
  key: "memory.dream", group: "Memory", level: "both", type: "bool", env: "CHRONOS_DREAM_HOURS",
  label: "Nightly memory pass", help: "Prune, compact and rank this workspace's memory at the dream hours.",
  default: () => CONFIG.dreamHours.length > 0,
});

// Limits
defineSetting({
  key: "limits.max_terminals", group: "Limits", level: "both", type: "int", min: 1, max: 50, env: "CHRONOS_MAX_WS_SESSIONS",
  label: "Open terminals per workspace", help: "Lead workers are counted separately.",
  default: () => CONFIG.maxSessionsPerWorkspace,
});

// Resources (RESOURCES.md → PR 2): each workspace's share of a machine, and what happens when one
// takes more than it while the Mac is strained. The weight lives in kv like every other per-workspace
// override (no migration, resolved on every read, and the Settings page shows it with the rest).
defineSetting({
  key: "resources.weight", group: "Limits", level: "ws", type: "number", min: 0.1, max: 100,
  label: "Share of the machine (weight)",
  help: "This workspace's weight when RAM, CPU and heavy slots are split among the workspaces active on a Mac. 2 = twice a weight-1 workspace's share; an idle workspace lends its share.",
  default: () => 1,
});
defineSetting({
  key: "resources.ladder", group: "Limits", level: "global", type: "enum", env: "CHRONOS_LADDER",
  options: () => ["off", "warn", "slow", "on"],
  label: "Over-budget ladder",
  help: "While the Mac is strained, a workspace over its share is warned (warn), then reniced (slow), then its newest heavy process paused when memory is critical (on). off releases anything slowed or paused.",
  default: () => CONFIG.ladder.mode,
});

// The workspace row's own columns.
const col = (d: Omit<SettingDef, "level" | "default"> & { column: keyof Workspace & string; default?: SettingDef["default"] }) =>
  defineSetting({ level: "ws", default: () => null, ...d });

col({ key: "ws.name", column: "name", group: "Workspace", type: "string", label: "Name", help: "" });
col({ key: "ws.default_backend", column: "default_backend", group: "Workspace", type: "enum", options: backendNames,
  label: "Default backend", help: "What a new terminal opens on." });
col({ key: "ws.default_model", column: "default_model", group: "Workspace", type: "string", nullable: true,
  label: "Default model", help: "Blank = the backend's default." });
col({ key: "ws.backends", column: "backends", group: "Workspace", type: "list", options: backendNames,
  label: "Backends in the picker", help: "Empty = all installed." });
col({ key: "ws.fallback_backend", column: "fallback_backend", group: "Failover", type: "enum", nullable: true,
  options: backendNames, label: "First stand-in backend", help: "Tried before the list above." });
col({ key: "ws.ask_policy", column: "ask_policy", group: "Robert", type: "enum", nullable: true, options: () => ["robert", "escalate"],
  label: "Who answers asks", help: "escalate: a human answers every ask here, Robert never does." });
col({ key: "ws.auto_plan", column: "auto_plan", group: "Autonomy", type: "bool", label: "Auto-plan tickets", help: "" });
col({ key: "ws.auto_build", column: "auto_build", group: "Autonomy", type: "bool", label: "Auto-build planned tickets", help: "" });
col({ key: "ws.auto_review", column: "auto_review", group: "Autonomy", type: "bool", label: "Auto-review PRs", help: "" });
col({ key: "ws.merge_gate", column: "merge_gate", group: "Autonomy", type: "bool", label: "Merge gate", help: "A reviewer model must pass a PR before it can merge." });
col({ key: "ws.auto_merge_prs", column: "auto_merge_prs", group: "Autonomy", type: "bool", label: "Auto-merge passing PRs", help: "" });
col({ key: "ws.live_steer", column: "live_steer", group: "Autonomy", type: "bool", label: "Live steering of headless runs", help: "" });
col({ key: "ws.max_concurrent", column: "max_concurrent", group: "Limits", type: "int", nullable: true, min: 1, max: 50,
  label: "Headless jobs at once", help: "Blank = no workspace cap." });
col({ key: "ws.daily_budget_usd", column: "daily_budget_usd", group: "Limits", type: "number", nullable: true, min: 0, max: 10000,
  label: "Daily budget (USD)", help: "Blank = no budget." });
col({ key: "ws.stall_minutes", column: "stall_minutes", group: "Limits", type: "int", nullable: true, min: 1, max: 1440,
  label: "Stalled after (minutes)", help: "Blank = the global default." });
col({ key: "ws.sandbox_mode", column: "sandbox_mode", group: "Safety", type: "enum", options: () => ["off", "guard", "strict"],
  label: "Sandbox", help: "guard: other workspaces and secrets are off limits. strict: writes only in the repo." });
col({ key: "ws.placement", column: "placement", group: "Safety", type: "enum", nullable: true, options: () => ["brain", "hosts"],
  label: "Where terminals run", help: "brain: this Mac only. hosts: any connected computer." });
