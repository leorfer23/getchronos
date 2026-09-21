/**
 * Usage meter — how much of each subscription's allowance is spent, as the VENDOR reports it.
 *
 * The quota gate (quota-gate.ts) can only infer runway from walls we already hit; the operator wants
 * the number before the wall: "Claude 83%" in the Desk bar, and a loud alert the moment any window
 * crosses 80%. Every reading here is a percentage the CLI itself was handed by its vendor:
 *
 *  - claude: the `rate_limits` object on the statusLine stdin (`mc statusline`, every interactive
 *    terminal and the operator's own sessions) and `rate_limit_event.rate_limit_info.unifiedWindows`
 *    on stream-json (headless runs, the warm executives). Per profile: each CLAUDE_CONFIG_DIR is its
 *    own account, so ".claude-atlas at 90%" says nothing about ".claude-cedar".
 *  - grok: grok logs `billing: fetched credits config` { creditUsagePercent, currentPeriod } to
 *    ~/.grok/logs/unified.jsonl whenever it starts or refreshes. One login for every workspace.
 *  - cursor: no local surface. Its statusLine payload carries only the context window, and its plan
 *    usage lives behind its own API — so it is reported as unmeasured, never as 0.
 *
 * No credential is read and no CLI is launched to get any of this.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { notify, esc } from "./telegram/api.js";

export type UsageCli = "claude" | "grok" | "cursor";

export interface UsageWindow {
  /** "5h" | "week" | "spend" — the vendor's own window, not ours. */
  name: string;
  usedPct: number;
  resetsAt: string | null;
}

export interface UsageMeter {
  cli: UsageCli;
  /** Which login: the profile dir's basename for claude (".claude-atlas"), the cli name otherwise. */
  scope: string;
  windows: UsageWindow[];
  /** When the vendor last told us. */
  at: string | null;
  source: string | null;
  /** Why there is no number, when there is none. */
  note?: string;
}

export interface UsageSnapshot {
  at: string;
  warnPct: number;
  critPct: number;
  meters: UsageMeter[];
}

export const WARN_PCT = Number(process.env.CHRONOS_USAGE_WARN_PCT ?? 80);
export const CRIT_PCT = Number(process.env.CHRONOS_USAGE_CRIT_PCT ?? 95);

const TESTING = !!process.env.CHRONOS_TEST || process.env.CHRONOS_DB === ":memory:";
const FILE = process.env.CHRONOS_USAGE_FILE ?? path.join(os.homedir(), ".mc", "usage-meter.json");
const GROK_LOG = () => path.join(process.env.GROK_HOME || path.join(os.homedir(), ".grok"), "logs", "unified.jsonl");

interface State {
  meters: Record<string, UsageMeter>;
  /** `${cli}:${scope}|${window}|${resetsAt}|${level}` — one alert per crossing per window period. */
  alerted: string[];
}

let state: State | null = null;
let notifier: (html: string) => void = (html) => { if (!TESTING) void notify(html).catch(() => {}); };
/** Test seam: capture alerts instead of sending them. */
export function setUsageNotifier(fn: (html: string) => void) { notifier = fn; }
let saveTimer: NodeJS.Timeout | null = null;

function load(): State {
  if (state) return state;
  state = { meters: {}, alerted: [] };
  if (!TESTING) {
    try {
      const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
      if (j && typeof j === "object") state = { meters: j.meters ?? {}, alerted: Array.isArray(j.alerted) ? j.alerted : [] };
    } catch {}
  }
  return state;
}

// statusLine fires on every repaint; the file only needs to survive a restart.
function saveSoon() {
  if (TESTING || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(state));
      fs.renameSync(`${FILE}.tmp`, FILE);
    } catch (e: any) {
      console.warn("[usage-meter] save:", e?.message ?? e);
    }
  }, 2000);
  saveTimer.unref?.();
}

/** Test seam. */
export function _resetUsage() {
  state = { meters: {}, alerted: [] };
  grokCache = null;
}

const key = (m: { cli: string; scope: string }) => `${m.cli}:${m.scope}`;
const pct = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v * 10) / 10) : null);
const epochIso = (v: unknown) => (typeof v === "number" && v > 0 ? new Date(v * (v < 1e12 ? 1000 : 1)).toISOString() : typeof v === "string" && v ? v : null);

export function profileScope(configDir: string | null | undefined): string {
  return path.basename(configDir || path.join(os.homedir(), ".claude"));
}

const WINDOW_LABEL: Record<string, string> = { "5h": "5-hour", week: "weekly", month: "monthly", spend: "spend" };
const CLI_LABEL: Record<UsageCli, string> = { claude: "Claude", grok: "Grok", cursor: "Cursor" };

function hhmm(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const t = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? t : `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${t}`;
}

/** Fire once per window period when a window first crosses warn, and again at crit. */
function evaluate(m: UsageMeter) {
  const s = load();
  for (const w of m.windows) {
    const level = w.usedPct >= CRIT_PCT ? "crit" : w.usedPct >= WARN_PCT ? "warn" : null;
    if (!level) continue;
    const id = `${key(m)}|${w.name}|${w.resetsAt ?? ""}|${level}`;
    if (s.alerted.includes(id)) continue;
    // A crit reading also covers the warn alert for the same period: one message, not two.
    const also = level === "crit" ? `${key(m)}|${w.name}|${w.resetsAt ?? ""}|warn` : null;
    s.alerted.push(id);
    if (also && !s.alerted.includes(also)) s.alerted.push(also);
    if (s.alerted.length > 200) s.alerted.splice(0, s.alerted.length - 200);
    saveSoon();
    const who = m.cli === "claude" ? `${CLI_LABEL[m.cli]} (${m.scope.replace(/^\.claude-?/, "") || "personal"})` : CLI_LABEL[m.cli];
    const icon = level === "crit" ? "🔴" : "🟠";
    const resets = w.resetsAt ? ` — resets ${hhmm(w.resetsAt)}` : "";
    const text = `${icon} <b>${esc(who)} at ${Math.round(w.usedPct)}%</b> of its ${esc(WINDOW_LABEL[w.name] ?? w.name)} limit${esc(resets)}`;
    notifier(text);
    console.log(`[usage-meter] ${level}: ${who} ${w.name} ${w.usedPct}%`);
  }
}

function record(m: UsageMeter) {
  if (!m.windows.length) return;
  const s = load();
  s.meters[key(m)] = m;
  saveSoon();
  evaluate(m);
}

/**
 * statusLine stdin's `rate_limits`: { five_hour: { used_percentage, resets_at }, seven_day: …, spend_limit: … }.
 * Absent before the session's first API response and for non-subscription logins — then nothing changes.
 */
export function noteClaudeStatusline(configDir: string | null | undefined, rateLimits: any, now = Date.now()) {
  if (!rateLimits || typeof rateLimits !== "object") return;
  const windows: UsageWindow[] = [];
  for (const [src, name] of [["five_hour", "5h"], ["seven_day", "week"], ["spend_limit", "spend"]] as const) {
    const w = rateLimits[src];
    const p = pct(w?.used_percentage);
    if (p != null) windows.push({ name, usedPct: p, resetsAt: epochIso(w?.resets_at) });
  }
  record({ cli: "claude", scope: profileScope(configDir), windows, at: new Date(now).toISOString(), source: "statusline" });
}

/** One stream-json line from a claude child; only `rate_limit_event` with `unifiedWindows` counts. */
export function noteClaudeStreamEvent(configDir: string | null | undefined, ev: any, now = Date.now()) {
  if (ev?.type !== "rate_limit_event") return;
  const uw = ev.rate_limit_info?.unifiedWindows;
  if (!uw || typeof uw !== "object") return;
  const windows: UsageWindow[] = [];
  for (const [src, name] of [["five_hour", "5h"], ["seven_day", "week"]] as const) {
    const u = uw[src]?.utilization;
    // utilization is a 0–1 fraction here (statusLine speaks percent).
    const p = typeof u === "number" ? pct(u <= 1.5 ? u * 100 : u) : null;
    if (p != null) windows.push({ name, usedPct: p, resetsAt: epochIso(uw[src]?.resetsAt) });
  }
  record({ cli: "claude", scope: profileScope(configDir), windows, at: new Date(now).toISOString(), source: "stream" });
}

// ── grok: the last billing line in its own log ────────────────────────────────

let grokCache: { mtimeMs: number; size: number; meter: UsageMeter | null } | null = null;

/** Parse a tail of grok's unified.jsonl for the newest `billing: fetched credits config` line. */
export function parseGrokBilling(tail: string): UsageMeter | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes("billing: fetched credits config")) continue;
    try {
      const j = JSON.parse(l);
      const c = j?.ctx?.config;
      const p = pct(c?.creditUsagePercent);
      if (p == null) continue;
      const period = c?.currentPeriod ?? {};
      const name = /WEEK/i.test(String(period.type ?? "")) ? "week" : /MONTH/i.test(String(period.type ?? "")) ? "month" : "period";
      return {
        cli: "grok",
        scope: "grok",
        windows: [{ name, usedPct: p, resetsAt: period.end ?? c?.billingPeriodEnd ?? null }],
        at: typeof j.ts === "string" ? j.ts : null,
        source: "grok-log",
      };
    } catch {}
  }
  return null;
}

const GROK_TAIL = 2 * 1024 * 1024;

function readGrok(file = GROK_LOG()): UsageMeter | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (grokCache && grokCache.mtimeMs === st.mtimeMs && grokCache.size === st.size) return grokCache.meter;
  let meter: UsageMeter | null = null;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const len = Math.min(st.size, GROK_TAIL);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      meter = parseGrokBilling(buf.toString("utf8"));
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  grokCache = { mtimeMs: st.mtimeMs, size: st.size, meter };
  if (meter) record(meter);
  return meter;
}

// ── the snapshot the Desk and `mc usage` read ────────────────────────────────

export function usageSnapshot(now = Date.now(), opts: { grokLog?: string } = {}): UsageSnapshot {
  readGrok(opts.grokLog);
  const s = load();
  const meters = Object.values(s.meters).map((m) => ({
    ...m,
    // A window whose reset has passed is spent history: its percentage no longer applies.
    windows: m.windows.filter((w) => !w.resetsAt || Date.parse(w.resetsAt) > now),
  }));
  for (const cli of ["claude", "grok", "cursor"] as UsageCli[]) {
    if (meters.some((m) => m.cli === cli)) continue;
    meters.push({
      cli,
      scope: cli === "claude" ? profileScope(null) : cli,
      windows: [],
      at: null,
      source: null,
      note:
        cli === "cursor"
          ? "Cursor keeps plan usage behind its own API; nothing on this Mac reports it"
          : cli === "grok"
            ? "no billing line in ~/.grok/logs yet — open grok once"
            : "no reading yet — updates on the next Claude turn",
    });
  }
  const order: Record<string, number> = { claude: 0, grok: 1, cursor: 2 };
  meters.sort((a, b) => order[a.cli] - order[b.cli] || a.scope.localeCompare(b.scope));
  return { at: new Date(now).toISOString(), warnPct: WARN_PCT, critPct: CRIT_PCT, meters };
}
