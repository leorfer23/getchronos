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
import { inRepo } from "./repo-root.js";
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
  /**
   * A rule past the type (the assistant's name): gets the coerced value, returns it cleaned, or
   * throws with a message fit for the Desk. Every write goes through it — the ⚙ page and any route.
   */
  check?: (v: SettingValue) => SettingValue;
  onChange?: (workspaceId: string | null) => void;
}

const REGISTRY = new Map<string, SettingDef>();
/** Page order. */
export const GROUPS = ["Workspace", "Robert", "Voice", "Alerts", "Accounts", "Failover", "Autonomy", "Memory", "Limits", "Safety", "Executor"];

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
  const v = coerceType(d, raw);
  if (v === null || !d.check) return v;
  try {
    return d.check(v);
  } catch (e: any) {
    throw new Error(`${d.label}: ${e?.message ?? e}`);
  }
}

function coerceType(d: SettingDef, raw: unknown): SettingValue {
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
      // The page says the name the operator gave him ("Ada works on his own"); keys stay robert.*.
      return {
        key: d.key, group: nameIt(d.group), label: nameIt(d.label), help: nameIt(d.help), type: d.type, level,
        options: d.options?.(), env: d.env, min: d.min, max: d.max, nullable: d.nullable,
        value, source, inherited,
      };
    });
}

/** The page's group headings, in order — the "Robert" group under the name he was given. */
export const settingGroups = (): string[] => GROUPS.map(nameIt);

// ───────────────────────────── the assistant's name ─────────────────────────────
// The operator names his assistant (the Desk's first-run welcome, or ⚙ Settings). It is a DISPLAY
// name: what every surface shows and says, and what he answers to. Ids never move — agents/robert/,
// robert-* modules, /api/robert/*, robert.* settings keys, `mc ask-robert`, MC_AGENT_NAME=robert —
// so nothing stored or scripted breaks on a rename. Read at the moment a string is built, like every
// setting here, so a rename lands on the next string with no restart.

export const DEFAULT_ASSISTANT_NAME = "Robert";

/**
 * The name as stored: 1–24 letters (any script, accents included), digits, spaces and . - '. Narrow on
 * purpose — it is spliced into prompts, notifications and page text, so it can carry no markup, no
 * newline and no instruction. Throws with a message fit for the Desk.
 */
export function cleanAssistantName(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("a name, in letters");
  // A Mac's smart quotes turn the apostrophe in "D'Arcy" into ’ as it is typed. Runs of spaces fold to
  // one; a newline or a tab is not a space, so it stays in and is refused below.
  const s = raw.normalize("NFC").replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\u00a0/g, " ").replace(/ {2,}/g, " ").trim();
  if (!s) throw new Error("it can't be empty");
  if ([...s].length > 24) throw new Error("24 characters at most");
  if (!/^[\p{L}\p{M}\p{N} .'-]+$/u.test(s)) throw new Error("letters, digits, spaces and . - ' only");
  if (!/[\p{L}\p{N}]/u.test(s)) throw new Error("it needs at least one letter");
  return s;
}

/** What the operator calls his assistant right now ("Robert" until he names him). */
export function assistantName(): string {
  const v = setting("assistant.name");
  return typeof v === "string" && v.trim() ? v : DEFAULT_ASSISTANT_NAME;
}

/**
 * A user-facing string that says "Robert", with the chosen name in its place. Whole word, capital R
 * only: "robert" in ids, keys and commands is never touched. The identity while he is still Robert.
 */
export function nameIt(text: string): string {
  const n = assistantName();
  return n === DEFAULT_ASSISTANT_NAME ? text : text.replace(/\bRobert\b/g, () => n);
}

/**
 * The line a renamed assistant's prompts open with, so he answers to his name and never calls himself
 * Robert to the operator. Empty while he is Robert: the default prompt stays byte-for-byte what it was.
 */
export function assistantNameLine(): string {
  const n = assistantName();
  if (n === DEFAULT_ASSISTANT_NAME) return "";
  return (
    `YOUR NAME — ${n}. The operator chose it: it is the only name he sees or hears for you. Introduce ` +
    `yourself, sign and refer to yourself as ${n}, and answer to it. "Robert" in these instructions, in ` +
    `messages from the daemon and in ids (agents/robert, /api/robert/*, mc ask-robert, --on robert) is ` +
    `this same role's internal name — it means you. Never call yourself Robert to him, and never rename those ids.\n\n`
  );
}

// ───────────────────────────── the settings ─────────────────────────────

const backendNames = () => listBackends().map((b) => b.name);

// Robert — every automatic turn he takes. The chat always answers the operator, whatever is off here.
defineSetting({
  key: "inbox.auto_dispatch", group: "Autonomy", level: "both", type: "bool", env: "CHRONOS_INBOX_AUTODISPATCH",
  label: "Inbox opens terminals",
  help: "Each new inbox item (Slack, Jira, ClickUp) with work in it opens its own terminal after 2 minutes, up to 3 at a time per client. Close the ones you don't need.",
  default: () => CONFIG.inboxAuto.enabled,
});
defineSetting({
  key: "inbox.triage", group: "Autonomy", level: "both", type: "bool", env: "CHRONOS_INBOX_TRIAGE",
  label: "Inbox: only open what has work",
  help: "A quick first pass reads each item before its terminal opens. Thanks, FYIs, shared links and repeats of a live terminal close in the Inbox log instead (Reopen there opens one). Off: every item opens.",
  default: () => process.env.CHRONOS_INBOX_TRIAGE !== "0",
});
// The daily job check (src/job-check.ts). Off by default on a new install: a failed job is reported and
// waits for a yes before anything re-runs it (docs/guide/safety.md). Migration 160 pins it on for an
// install that already had projects, so upgrading changes nothing there.
defineSetting({
  key: "jobcheck.auto_rerun", group: "Autonomy", level: "both", type: "bool", env: "CHRONOS_JOB_CHECK_AUTO_RERUN",
  label: "Daily job check fixes and re-runs failed jobs",
  help: "On: when the daily job check finds a failed job, a terminal opens right away to find why, fix it and re-run it — without asking. Off: the check tells you which jobs failed and asks first (Inbox → Stalled, Telegram, `mc recover`); your yes opens that terminal.",
  default: () => process.env.CHRONOS_JOB_CHECK_AUTO_RERUN === "1",
});
// First in his group, so it is the first thing the page shows under his name.
defineSetting({
  key: "assistant.name", group: "Robert", level: "global", type: "string",
  label: "Name",
  help: "What your assistant is called — on the Desk, the phone, out loud and on Telegram.",
  default: () => DEFAULT_ASSISTANT_NAME,
  check: (v) => cleanAssistantName(v),
});
// What he does himself when you talk to him: he runs Chronos, agents do the work (src/robert-hands.ts
// holds him to it in code: his sandbox, and a budget on work outside Chronos that opens the terminal
// for him). Unlike the switches below, this one is about the chat itself.
defineSetting({
  key: "robert.hands", group: "Robert", level: "both", type: "enum", env: "CHRONOS_ROBERT_HANDS",
  label: "What Robert does himself",
  help: "answers: Robert runs Chronos (projects, terminals, tickets, jobs, memory, briefs, settings); work inside a project — code, research, writing — goes to an agent terminal. He still answers a question about a project when a few lookups settle it; past four calls outside Chronos, it goes to a terminal with your request and he tells you which in one line. Your projects' folders are read-only to him. anything: he may also do the work himself in the chat, as before.",
  options: () => ["answers", "anything"],
  default: () => (process.env.CHRONOS_ROBERT_HANDS === "anything" ? "anything" : "answers"),
});
defineSetting({
  key: "robert.enabled", group: "Robert", level: "both", type: "bool",
  label: "Robert works on his own",
  help: "Off: no automatic Robert turns here — no wake-ups, prompt answers, watch reports or ask triage. Chat still answers you.",
  default: () => true,
});
defineSetting({
  key: "robert.desk_posts", group: "Robert", level: "both", type: "bool", env: "CHRONOS_ROBERT_DESK_POSTS",
  label: "Robert posts on his own",
  help: "Off: the chat only shows his replies to you. What he does on his own (wakes, triage, watch reports, ask cards) stays in the terminals he touches.",
  default: () => false,
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
  key: "robert.proactive", group: "Robert", level: "both", type: "bool", env: "CHRONOS_ROBERT_PROACTIVE",
  label: "Start work when nothing is running",
  help: "When nothing works here and something changed (a PR, a red job, a terminal left waiting, a new Next item), Robert looks once and either opens ONE terminal or stays quiet. Never a message.",
  default: () => process.env.CHRONOS_ROBERT_PROACTIVE !== "0",
});
defineSetting({
  key: "robert.proactive_hours", group: "Robert", level: "both", type: "string", env: "CHRONOS_ROBERT_PROACTIVE_HOURS",
  label: "Hours he may start work", help: "Local hours, start-end (\"09-21\"; \"22-06\" wraps midnight).",
  default: () => process.env.CHRONOS_ROBERT_PROACTIVE_HOURS ?? "09-21",
});
defineSetting({
  key: "robert.proactive_every_min", group: "Robert", level: "both", type: "int", min: 5, max: 240,
  env: "CHRONOS_ROBERT_PROACTIVE_EVERY_MIN",
  label: "Look at a quiet workspace every (min)", help: "Only a look: no model runs unless something changed since the last one.",
  default: () => Number(process.env.CHRONOS_ROBERT_PROACTIVE_EVERY_MIN ?? 30),
});
defineSetting({
  key: "robert.ship_loop", group: "Robert", level: "both", type: "bool", env: "CHRONOS_ROBERT_SHIP_LOOP",
  label: "Offer ready PRs",
  help: "A green PR whose terminal closed (or sat idle 2h) gets one Ship terminal per workspace that asks you once whether to merge and deploy it. Off: PRs are still tracked, nothing opens.",
  default: () => process.env.CHRONOS_ROBERT_SHIP_LOOP !== "0",
});
defineSetting({
  key: "robert.proactive_autotune", group: "Robert", level: "both", type: "bool", env: "CHRONOS_PROACTIVE_AUTOTUNE",
  label: "Back off ignored offers",
  help: "Terminals the daemon opens on its own are scored by whether you engaged with them (`mc proactive`). When Ship or Robert's proactive terminals here went mostly ignored this week (8+ decided, under 30% engaged or useful), they stop opening until that improves. Off: they always open.",
  default: () => process.env.CHRONOS_PROACTIVE_AUTOTUNE !== "0",
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

// Voice (src/talker.ts, src/voice-lang.ts, src/transcribe.ts): the one conversation he has with Robert.
defineSetting({
  key: "voice.talker", group: "Voice", level: "global", type: "bool", env: "CHRONOS_TALKER",
  label: "Robert answers through the fast front",
  help: "Every spoken or typed line to Robert is answered in about a second by a small fast model that reads the ledger and the queue of every project, and hands real work to that project's own Robert in the background. Off: today's per-project routing.",
  default: () => process.env.CHRONOS_TALKER === "1",
});
defineSetting({
  key: "voice.talker_engine", group: "Voice", level: "global", type: "enum", env: "CHRONOS_TALKER_ENGINE",
  label: "Front engine",
  help: "cli: its own warm claude process on your subscription (no key needed). api: the Messages API — faster to first word, needs ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY in .secrets; without a key it stays on cli.",
  options: () => ["cli", "api"],
  default: () => (process.env.CHRONOS_TALKER_ENGINE === "api" ? "api" : "cli"),
});
defineSetting({
  key: "voice.talker_cli_model", group: "Voice", level: "global", type: "enum", env: "CHRONOS_TALKER_CLI_MODEL",
  label: "Front model (cli)", help: "A Claude Code model alias. haiku is the fastest.",
  options: () => ["haiku", "sonnet", "opus"],
  default: () => process.env.CHRONOS_TALKER_CLI_MODEL || "haiku",
});
defineSetting({
  key: "voice.talker_api_model", group: "Voice", level: "global", type: "string", env: "CHRONOS_TALKER_API_MODEL",
  label: "Front model (api)", help: "A Messages API model id, e.g. claude-haiku-5-5 (the gateway form is derived).",
  default: () => process.env.CHRONOS_TALKER_API_MODEL || "claude-haiku-5-5",
});
defineSetting({
  key: "voice.talker_provider", group: "Voice", level: "global", type: "enum", env: "CHRONOS_TALKER_PROVIDER",
  label: "Front key (api)", help: "auto: an Anthropic key first, else the AI Gateway key.",
  options: () => ["auto", "anthropic", "gateway"],
  default: () => process.env.CHRONOS_TALKER_PROVIDER || "auto",
});
defineSetting({
  key: "voice.talker_persona_file", group: "Voice", level: "global", type: "string", env: "CHRONOS_TALKER_PERSONA_FILE",
  label: "Front persona file",
  help: "A text file on this Mac that tells the front who you are, the languages you speak and how you want to be spoken to. Kept out of the repo; read on every turn. Empty: the generic persona. Default: local/talker-persona.md in the Chronos checkout (gitignored), when it exists.",
  // A test run never picks up a persona file sitting in the checkout it runs from.
  default: () => process.env.CHRONOS_TALKER_PERSONA_FILE ?? (process.env.CHRONOS_TEST === "1" ? "" : inRepo("local", "talker-persona.md")),
});
defineSetting({
  key: "voice.lang_pick", group: "Voice", level: "global", type: "bool",
  label: "Speak each sentence in its own language",
  help: "An English sentence on a Spanish call is read in English, and the other way round. Off: the call's language for everything.",
  default: () => true,
});
defineSetting({
  key: "voice.islands", group: "Voice", level: "global", type: "bool",
  label: "English words inside Spanish with English sounds (experimental)",
  help: "\"Mergeá la feature branch\": the English words are read with English phonemes in the same voice. Measured: the English words improve, the Spanish right after them gets worse — off until that is fixed.",
  default: () => false,
});
defineSetting({
  key: "voice.listen", group: "Voice", level: "global", type: "enum",
  label: "Listening language",
  help: "bilingual: transcribed in the call's language unless whisper hears the other one (Spanish or English, never a third). page: always the call's language, as before.",
  options: () => ["bilingual", "page"],
  default: () => "bilingual",
});
defineSetting({
  key: "voice.final_engine", group: "Voice", level: "global", type: "enum", env: "CHRONOS_VOICE_FINAL_ENGINE",
  label: "Engine for what you said",
  help: "accurate: the finished sentence goes to the second, larger whisper (sh.chronos.whisper-final) while the live words keep the fast one — so a sentence never waits behind a preview. Falls back to the fast engine whenever the second one is not running. fast: one engine for everything, as before. cloud: the finished sentence is sent to ElevenLabs (Scribe) — THE AUDIO OF WHAT YOU SAY ON A CALL LEAVES THIS MAC for that provider, which keeps it under its own retention terms (zero retention is for enterprise accounts only); with \"Words it should know\" filled in, those words are sent too (and billed as keyterms). Needs ELEVENLABS_API_KEY in .secrets and costs per hour of audio. Live words and one-word answers stay local; no key, no network, a slow or empty answer → the same sentence goes to the local engines.",
  options: () => ["accurate", "fast", "cloud"],
  default: () => (["fast", "cloud"].includes(process.env.CHRONOS_VOICE_FINAL_ENGINE ?? "") ? process.env.CHRONOS_VOICE_FINAL_ENGINE! : "accurate"),
});
defineSetting({
  key: "voice.vocab", group: "Voice", level: "global", type: "string", env: "CHRONOS_VOICE_VOCAB",
  label: "Words it should know",
  help: "Names and terms you say on calls, comma-separated (products, people, English tech words). Given to whisper as a hint with every finished sentence; it stays on this Mac unless the engine above is cloud (then it goes to that provider with the sentence). Empty: no hint.",
  default: () => process.env.CHRONOS_VOICE_VOCAB || "",
});
defineSetting({
  key: "voice.keep_clips", group: "Voice", level: "global", type: "bool",
  label: "Keep the last call clips (diagnosis)",
  help: "Keeps the audio of the last 40 things you said on a call, with what was heard, in a folder on this Mac that no agent can read — to compare speech engines on your real voice (mc voice clips). Turning it off deletes them.",
  default: () => false,
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

// The verifier (src/request-verifier.ts): a hand-off asking for a merge, review or deploy, and every
// draft, is checked by the daemon before it is put to the operator as ready.
defineSetting({
  key: "verifier.enabled", group: "Safety", level: "both", type: "bool", env: "CHRONOS_VERIFIER",
  label: "Check work before it reaches you",
  help: "A hand-off asking for your yes is checked first: the PR is open, mergeable and up to date, the repo's checks re-run, a second model reads it against what you asked, UI changes carry before/after shots, drafts are bound to their exact words. Failures go back to the terminal (two rounds). Off: items reach you unverified.",
  default: () => process.env.CHRONOS_VERIFIER !== "0",
});
defineSetting({
  key: "verifier.data_swing_pct", group: "Safety", level: "both", type: "number", min: 1, max: 1000, env: "CHRONOS_VERIFIER_DATA_SWING_PCT",
  label: "Data PRs: largest unexplained swing (%)",
  help: "A PR that changes models, SQL or transforms in a data repo hands off before/after numbers per changed table. A row count or key aggregate that moves more than this must carry its explanation on the hand-off, or the verifier sends it back.",
  default: () => Number(process.env.CHRONOS_VERIFIER_DATA_SWING_PCT) || 20,
});

// Alerts (src/stuck-alerts.ts): work that is stuck reaches the operator once, on the first channel
// that answers — his live voice call, then his phone, then Telegram. Event-driven; silent when
// nothing is wrong.
defineSetting({
  key: "alerts.enabled", group: "Alerts", level: "both", type: "bool", env: "CHRONOS_ALERTS",
  label: "Tell me when work is stuck",
  help: "A terminal waiting on your answer or stuck, a wall nothing could move, a computer gone with work on it, a job that failed for good: one alert per episode. Robert gets a short chance first on what he may answer himself.",
  default: () => process.env.CHRONOS_ALERTS !== "0",
});
defineSetting({
  key: "alerts.voice", group: "Alerts", level: "global", type: "bool",
  label: "Say it on a live voice call", help: "When you are on a call (Desk 🎙), the alert is spoken into it first.",
  default: () => true,
});
defineSetting({
  key: "alerts.push", group: "Alerts", level: "global", type: "bool",
  label: "Phone notification", help: "Otherwise, or when the call does not answer, a push to the phone app — a tap opens the terminal.",
  default: () => true,
});
defineSetting({
  key: "alerts.telegram", group: "Alerts", level: "global", type: "bool",
  label: "Telegram as the last resort", help: "When no phone is subscribed, or the alert is not acknowledged in time.",
  default: () => true,
});
defineSetting({
  key: "alerts.mac", group: "Alerts", level: "global", type: "bool",
  label: "Last resort: say it on this Mac",
  help: "When no call, phone or Telegram took it, the Mac says it out loud and shows a notification. It does not count as reaching you: the alert is tried again on your phone or a call as soon as one can take it.",
  default: () => true,
});
defineSetting({
  key: "term.frozen_min", group: "Alerts", level: "global", type: "int", min: 1, max: 60, env: "CHRONOS_TERM_FROZEN_MIN",
  label: "A terminal frozen mid-turn is stuck after (minutes)",
  help: "Its turn never ended, its \"esc to interrupt\" line is still on screen, and it printed nothing for this many minutes the Mac was awake. A working turn repaints every second, so even 1 minute is far past normal.",
  default: () => Number(process.env.CHRONOS_TERM_FROZEN_MIN) || 3,
});
defineSetting({
  key: "alerts.ack_window_sec", group: "Alerts", level: "global", type: "int", min: 15, max: 1800,
  env: "CHRONOS_ALERTS_ACK_SEC",
  label: "Wait for an acknowledgement (seconds)", help: "Not opened, answered or acknowledged in this long → the next channel.",
  default: () => Number(process.env.CHRONOS_ALERTS_ACK_SEC) || 90,
});
defineSetting({
  key: "alerts.voice_confirm_sec", group: "Alerts", level: "global", type: "int", min: 5, max: 120,
  label: "A call must confirm it spoke within (seconds)", help: "No confirmation → the phone instead.",
  default: () => 15,
});
defineSetting({
  key: "alerts.robert_chance_sec", group: "Alerts", level: "both", type: "int", min: 0, max: 1800,
  env: "CHRONOS_ALERTS_ROBERT_CHANCE_SEC",
  label: "Robert's chance first (seconds)", help: "On a question or a block he may handle himself: the longest he gets after he is woken. Sooner when he was not woken or already looked.",
  default: () => Number(process.env.CHRONOS_ALERTS_ROBERT_CHANCE_SEC ?? 120),
});
defineSetting({
  key: "alerts.per_hour", group: "Alerts", level: "global", type: "int", min: 1, max: 60,
  label: "Alerts per hour", help: "Past this, everything else that hour is one summary.",
  default: () => 6,
});
defineSetting({
  key: "alerts.lang", group: "Alerts", level: "global", type: "enum", options: () => ["auto", "en", "es"],
  label: "Alert language", help: "auto: the language of your last voice call (English until there is one).",
  default: () => "auto",
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
