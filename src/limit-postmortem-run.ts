/**
 * The limit post-mortem's IO (the analysis itself is limit-postmortem.ts — pure code, no model).
 *
 *   trigger   A Claude profile hits a wall: a usage-meter reading of a 5h/week window at 100% with its
 *             reset ahead (usage-meter.ts onClaudeWall, and the stored readings on every tick), or a run
 *             that recorded a real limit error with a reset time (quota-gate.ts limitFromRun). One
 *             post-mortem per (profile, window, reset), kept in kv so a restart never repeats one.
 *   report    At the wall: read the profile's window, write the markdown into the note "Limit
 *             post-mortem" of EVERY workspace pinned to that same profile — and only those (workspaces
 *             never mix: a report built from one account's transcripts lands only where that account is
 *             the workspace's own) — and send one Telegram line through the usage meter's channel.
 *   terminal  Once the window has reset (never while the profile is still walled), read it once more so
 *             the after-the-wall counts are final, then open ONE Desk terminal in the pinned workspace that
 *             spent the most, created_by "postmortem", to go over the levers with the operator. The
 *             operator reads terminals, not chat: the terminal IS the delivery. Setting-gated.
 *   on demand `GET /api/limits/postmortem` (`mc limits postmortem`) reads a window without writing
 *             anything; `GET /api/limits/postmortems` lists the stored reports. A workspace token sees
 *             its own profile only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG } from "./config.js";
import { db, kv, notes as noteStore, runs, sessions, workspaces } from "./store.js";
import { createNote, updateNote } from "./notes.js";
import { defineSetting, setting, settingOn } from "./settings.js";
import { notify, esc } from "./telegram/api.js";
import { claudeMeters, claudeWall, onClaudeWall, type ClaudeWallReading } from "./usage-meter.js";
import { limitActive, limitFromRun, resetFromRun } from "./quota-gate.js";
import { mirrorFile } from "./hosts/transcript-mirror.js";
import { LOCAL_HOST_ID } from "./store/hosts.js";
import {
  analyze, BASELINE_SLICES, profileName, renderPostmortem, scanProfile, setReportTimezone, telegramText, terminalBrief,
  WINDOW_LABEL, WINDOW_MS, WINDOWS, type Postmortem, type RunRow, type SessionRow, type TranscriptFile, type WindowName,
} from "./limit-postmortem.js";
import type { Workspace } from "./types.js";

export const POSTMORTEM_BY = "postmortem";
export const NOTE_SLUG = "limit-postmortem";
const NOTE_TITLE = "Limit post-mortem";
const STATE_KEY = "limits.postmortem.walls";
const KEEP = 30;
const TICK_MS = 60_000;
/** A wall whose reset passed longer ago than this gets no report (the daemon was down): stale news. */
const REPORT_STALE_MS = 24 * 3600_000;
/** …and no terminal past this after its reset: the operator has moved on. */
const TERMINAL_STALE_MS = 12 * 3600_000;
/** Two readings of one wall: the meter's exact reset and a reset parsed off "resets 2:20pm". */
const SAME_RESET_MS = 15 * 60_000;
const TERMINAL_TRIES = 3;
const TERMINAL_RETRY_MS = 10 * 60_000;
const TESTING = !!process.env.CHRONOS_TEST || process.env.CHRONOS_DB === ":memory:";

defineSetting({
  key: "limits.postmortem", group: "Limits", level: "global", type: "bool",
  label: "Post-mortem when a Claude account hits its limit",
  help: "When a profile's 5-hour or weekly window runs out: where it went and what would spend less, written to the notes of the workspaces on that account, plus one Telegram line. Pure arithmetic over the transcripts — no model call.",
  default: () => true,
});
defineSetting({
  key: "limits.postmortem_terminal", group: "Limits", level: "both", type: "bool",
  label: "…and open a terminal to go over it after the reset",
  help: "Once the window resets, one terminal opens in the workspace that spent the most on that account, to review the levers with you and apply the ones you approve.",
  default: () => true,
});
defineSetting({
  key: "limits.postmortem_model", group: "Limits", level: "both", type: "string",
  label: "…on this model",
  help: "The post-mortem terminal's model (claude backend).",
  default: () => "sonnet",
});

// ───────────────────────────── profiles ─────────────────────────────

const expand = (p: string) => (p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
export const normDir = (p: string | null | undefined): string => (p ? path.resolve(expand(p)).replace(/\/+$/, "") : "");
const defaultDir = () => normDir(CONFIG.profiles?.[CONFIG.defaultProfile] || CONFIG.profiles?.claude || path.join(os.homedir(), ".claude"));

/** Every Claude profile directory this daemon knows: the workspaces' config_dir, CONFIG.profiles, the default. */
export function knownProfileDirs(): string[] {
  const set = new Set<string>();
  for (const w of workspaces.list(true)) if (w.config_dir) set.add(normDir(w.config_dir));
  for (const d of Object.values(CONFIG.profiles ?? {})) if (d) set.add(normDir(d));
  set.add(defaultDir());
  return [...set];
}

/** ".claude-acme", "acme", "personal" or a path → its one directory; null when unknown or two directories share the name. */
export function resolveProfileDir(name: string | null | undefined): string | null {
  const n = String(name ?? "").trim();
  if (!n) return null;
  const dirs = knownProfileDirs();
  if (n.includes("/") || n.startsWith("~")) {
    const d = normDir(n);
    return dirs.includes(d) ? d : null;
  }
  const want = n === "personal" ? [".claude"] : n.startsWith(".claude") ? [n] : [`.claude-${n}`, n];
  const hits = dirs.filter((d) => want.includes(path.basename(d)));
  return hits.length === 1 ? hits[0] : null;
}

/** The live (non-archived) workspaces whose own account IS this profile directory. */
export function workspacesOnProfile(configDir: string): Workspace[] {
  const d = normDir(configDir);
  return workspaces.list().filter((w) => normDir(w.config_dir) === d);
}

// ───────────────────────────── one analysis ─────────────────────────────

export interface RunOpts {
  configDir: string;
  window: WindowName;
  /** The vendor's reset: the window is [resetsAt − length, wall]. */
  resetsAt?: number | null;
  wallAt?: number | null;
  /** On demand without a reset: the window ends here. */
  at?: number | null;
  now?: number;
}

const chunks = <T>(xs: T[], n = 400): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

function sessionRows(ids: string[]): Map<string, SessionRow> {
  const out = new Map<string, SessionRow>();
  for (const c of chunks(ids)) {
    const rows = db.prepare(
      `SELECT id, workspace_id, created_by, role, lead_id, model, goal, goal_kind, created_at, ended_at FROM sessions WHERE id IN (${c.map(() => "?").join(",")})`,
    ).all(...c) as SessionRow[];
    for (const r of rows) out.set(r.id, r);
  }
  return out;
}

function runRows(ids: string[]): Map<string, RunRow> {
  const out = new Map<string, RunRow>();
  for (const c of chunks(ids)) {
    const rows = db.prepare(
      `SELECT r.session_id, j.name AS job_name, j.trigger_type, j.workspace_id FROM runs r JOIN jobs j ON j.id = r.job_id
       WHERE r.session_id IN (${c.map(() => "?").join(",")})`,
    ).all(...c) as RunRow[];
    for (const r of rows) if (!out.has(r.session_id)) out.set(r.session_id, r);
  }
  return out;
}

/** Terminals of this profile on another computer: their transcript is the mirror the host streams in. */
function remoteMirrors(configDir: string, since: number): TranscriptFile[] {
  const rows = db.prepare(
    `SELECT s.id, w.config_dir FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
     WHERE s.host_id != ? AND (s.ended_at IS NULL OR s.ended_at >= ?)`,
  ).all(LOCAL_HOST_ID, new Date(since).toISOString()) as { id: string; config_dir: string }[];
  const out: TranscriptFile[] = [];
  for (const r of rows) {
    if (normDir(r.config_dir) !== normDir(configDir)) continue;
    const file = mirrorFile(r.id);
    try { out.push({ file, id: r.id, sub: false, mtime: fs.statSync(file).mtimeMs }); } catch {}
  }
  return out;
}

/** Read one profile's window and analyse it. Reads only `<configDir>/projects` (+ that profile's mirrors). */
export async function runPostmortem(o: RunOpts): Promise<Postmortem> {
  setReportTimezone(CONFIG.slackTriageTz || undefined);
  const now = o.now ?? Date.now();
  const configDir = normDir(o.configDir);
  const len = WINDOW_MS[o.window];
  const end = o.resetsAt ?? o.at ?? now;
  const start = end - len;
  const until = Math.min(now, end);
  const since = start - BASELINE_SLICES[o.window] * len;
  const scanned = await scanProfile(configDir, { since, until }, remoteMirrors(configDir, since));
  const ids = scanned.map((s) => s.id);
  return analyze({
    profile: path.basename(configDir),
    window: o.window,
    start,
    wallAt: o.wallAt ?? null,
    resetsAt: o.resetsAt ?? null,
    until,
    sessions: scanned,
    rows: sessionRows(ids),
    runs: runRows(ids),
    onProfile: new Set(workspacesOnProfile(configDir).map((w) => w.id)),
    slugs: workspaces.list(true).map((w) => w.slug).sort((a, b) => b.length - a.length),
    home: os.homedir(),
  });
}

// ───────────────────────────── the walls we saw ─────────────────────────────

export interface WallSeen { configDir: string; window: WindowName; resetsAt: number; at: number; source: "meter" | "run" }
export interface WallRec {
  key: string;
  profile: string;
  configDir: string;
  window: WindowName;
  resetsAt: string;
  seenAt: string;
  source: "meter" | "run";
  attempts: number;
  error?: string;
  reportAt?: string;
  finalAt?: string;
  summary?: { total: number; tops: string; lever: string | null };
  markdown?: string;
  notes?: { workspace_id: string; note_id: string; file: string }[];
  targetWs?: string | null;
  terminal?: { at: string; tries: number; session_id?: string; workspace_id?: string; skipped?: string; error?: string };
}

let state: { walls: WallRec[] } | null = null;
function load(): { walls: WallRec[] } {
  if (state) return state;
  state = { walls: [] };
  try {
    const j = JSON.parse(kv.get(STATE_KEY) ?? "null");
    if (j && Array.isArray(j.walls)) state = { walls: j.walls };
  } catch {}
  return state;
}
function save() {
  const s = load();
  if (s.walls.length > KEEP) s.walls.splice(0, s.walls.length - KEEP);
  kv.set(STATE_KEY, JSON.stringify(s));
}
/** Test seams: drop everything, or only the in-memory copy (what a daemon restart does). */
export function _resetPostmortemState() { state = null; kv.del(STATE_KEY); }
export function _forgetPostmortemCache() { state = null; }
export const wallRecords = (): WallRec[] => [...load().walls];

export const wallKey = (configDir: string, window: WindowName, resetsAt: number) =>
  `${path.basename(configDir)}|${window}|${new Date(Math.round(resetsAt / 60_000) * 60_000).toISOString()}`;

/** Record a wall once. Returns the new record, or null when this wall (± a clock-parsed reset) is already known. */
export function noteWall(w: WallSeen): WallRec | null {
  const s = load();
  const dir = normDir(w.configDir);
  if (s.walls.some((r) => r.configDir === dir && r.window === w.window && Math.abs(Date.parse(r.resetsAt) - w.resetsAt) <= SAME_RESET_MS)) return null;
  const rec: WallRec = {
    key: wallKey(dir, w.window, w.resetsAt), profile: path.basename(dir), configDir: dir, window: w.window,
    resetsAt: new Date(w.resetsAt).toISOString(), seenAt: new Date(w.at).toISOString(), source: w.source, attempts: 0,
  };
  s.walls.push(rec);
  save();
  console.log(`[limit-postmortem] wall: ${rec.profile} ${w.window}, resets ${rec.resetsAt} (${w.source})`);
  return rec;
}

const isWindow = (n: string): n is WindowName => (WINDOWS as readonly string[]).includes(n);

/** The meter's stored readings: windows at 100% whose reset is ahead (or only just passed). */
export function wallsFromMeter(now = Date.now()): WallSeen[] {
  const out: WallSeen[] = [];
  for (const m of claudeMeters()) {
    for (const w of m.windows) {
      const reset = Date.parse(w.resetsAt ?? "");
      if (!isWindow(w.name) || w.usedPct < 100 || !Number.isFinite(reset) || reset < now - REPORT_STALE_MS) continue;
      const dir = resolveProfileDir(m.scope);
      if (!dir) continue;
      out.push({ configDir: dir, window: w.name, resetsAt: reset, at: Date.parse(m.at ?? "") || now, source: "meter" });
    }
  }
  return out;
}

/** Which window a limit message names; else the one its reset fits. */
export function windowOfLimit(detail: string, at: number, resetsAt: number): WindowName {
  if (/5-hour|five.?hour|session limit/i.test(detail)) return "5h";
  if (/week|7-day|seven.?day/i.test(detail)) return "week";
  return resetsAt - at <= WINDOW_MS["5h"] + 10 * 60_000 ? "5h" : "week";
}

type EvidenceRow = ReturnType<typeof runs.limitEvidenceSince>[number];
type Evidence = { row: EvidenceRow; e: NonNullable<ReturnType<typeof limitFromRun>>; reset: number | null };
/**
 * Anthropic limit errors runs recorded in the last day. The reset is read against the RUN's own start, not
 * now: "resets 2pm" re-read at 3pm would roll to tomorrow (parseResetClock), invent a second wall, and keep
 * the profile "walled" for a day.
 */
function evidence(now: number): Evidence[] {
  const out: Evidence[] = [];
  for (const row of runs.limitEvidenceSince(new Date(now - REPORT_STALE_MS).toISOString())) {
    const e = limitFromRun(row, now);
    if (!e || e.provider !== "anthropic" || e.kind !== "rate_limit") continue;
    const started = Date.parse(row.started_at ?? "");
    const r = Date.parse(resetFromRun(row, Number.isFinite(started) ? started : now) ?? "");
    out.push({ row, e: { ...e, resetsAt: Number.isFinite(r) ? new Date(r).toISOString() : null }, reset: Number.isFinite(r) ? r : null });
  }
  return out;
}

/** Runs that recorded a real limit error with a reset time — measured evidence, even with no meter reading. */
export function wallsFromRuns(now = Date.now()): WallSeen[] {
  const out: WallSeen[] = [];
  for (const { row, e, reset } of evidence(now)) {
    if (reset == null || reset < now - REPORT_STALE_MS) continue;
    // `e.at` is when the run STARTED — maybe hours before it hit the wall. Seen now; the transcript's first
    // refused call (analyze) moves the wall back to when it really happened.
    const started = Date.parse(e.at) || now;
    out.push({ configDir: normDir(row.config_dir) || defaultDir(), window: windowOfLimit(row.error ?? e.detail, started, reset), resetsAt: reset, at: now, source: "run" });
  }
  return out;
}

/** Still walled: the meter has a window at 100% not yet reset, or a run's limit error is still in force. */
export function stillWalled(configDir: string, now = Date.now()): boolean {
  if (claudeWall(configDir, now)) return true;
  const dir = normDir(configDir);
  return evidence(now).some(({ row, e }) => (normDir(row.config_dir) || defaultDir()) === dir && limitActive(e, now));
}

// ───────────────────────────── delivery ─────────────────────────────

let notifier: (html: string) => void = (html) => { if (!TESTING) void notify(html).catch(() => {}); };
/** Test seam: capture the Telegram line instead of sending it. */
export function setPostmortemNotifier(fn: (html: string) => void) { notifier = fn; }

export function telegramLine(p: Postmortem): string {
  const t = telegramText(p);
  return `📉 <b>${esc(t.who)} hit its ${esc(WINDOW_LABEL[p.window])} limit</b> — top: ${esc(t.tops || "nothing measured")}` +
    (t.lever ? ` · lever: ${esc(t.lever)}` : "") + ` · report in the workspace notes`;
}

function earlierLines(rec: WallRec): string {
  const prev = load().walls.filter((r) => r.configDir === rec.configDir && r.key !== rec.key && r.summary).slice(-5).reverse();
  if (!prev.length) return "";
  return "\n## Earlier walls on this account\n\n" + prev.map((r) =>
    `- ${r.resetsAt.slice(0, 16).replace("T", " ")} UTC · ${WINDOW_LABEL[r.window]} · $${r.summary!.total.toFixed(0)} · ${r.summary!.tops}${r.summary!.lever ? ` · ${r.summary!.lever}` : ""}`).join("\n") + "\n";
}

/**
 * Write the report into the note of every workspace pinned to the report's own profile — and refuse any
 * other. `targets` is the caller's list; the check is repeated here so no caller can widen it.
 */
export function deliverNotes(rec: Pick<WallRec, "configDir">, markdown: string, targets: Workspace[]): { workspace_id: string; note_id: string; file: string }[] {
  const dir = normDir(rec.configDir);
  const out: { workspace_id: string; note_id: string; file: string }[] = [];
  for (const w of targets) {
    if (normDir(w.config_dir) !== dir) {
      console.warn(`[limit-postmortem] refused: a ${path.basename(dir)} report into ${w.slug}, pinned to ${path.basename(normDir(w.config_dir))}`);
      continue;
    }
    try {
      const cur = noteStore.bySlug(w.id, NOTE_SLUG);
      const n = cur ? updateNote(cur.id, { body: markdown }) : createNote({ workspace_id: w.id, title: NOTE_TITLE, slug: NOTE_SLUG, body: markdown });
      out.push({ workspace_id: w.id, note_id: n.id, file: n.file_path });
    } catch (e: any) {
      console.warn(`[limit-postmortem] note in ${w.slug}: ${e?.message ?? e}`);
    }
  }
  return out;
}

/** The pinned workspace that spent the most in the window; for a tie, the operator's own (kind personal) first. */
export function pickWorkspace(p: Pick<Postmortem, "byWorkspace">, wss: Workspace[]): Workspace | null {
  if (!wss.length) return null;
  return [...wss].sort((a, b) =>
    (p.byWorkspace[b.id] ?? 0) - (p.byWorkspace[a.id] ?? 0) || Number(b.kind === "personal") - Number(a.kind === "personal") || a.slug.localeCompare(b.slug))[0];
}

function renderWithHistory(rec: WallRec, p: Postmortem): string {
  return renderPostmortem(p) + earlierLines(rec);
}

export interface TickDeps {
  run?: (o: RunOpts) => Promise<Postmortem>;
  opener?: (opts: any) => Promise<{ id: string }>;
  walled?: (configDir: string, now: number) => boolean;
  /** Extra walls to consider this tick (tests; the meter listener). */
  seen?: WallSeen[];
}

async function report(rec: WallRec, now: number, deps: TickDeps) {
  rec.attempts++;
  save();
  try {
    const p = await (deps.run ?? runPostmortem)({ configDir: rec.configDir, window: rec.window, resetsAt: Date.parse(rec.resetsAt), wallAt: Date.parse(rec.seenAt), now });
    const wss = workspacesOnProfile(rec.configDir);
    const md = renderWithHistory(rec, p);
    rec.notes = deliverNotes(rec, md, wss);
    rec.markdown = md;
    const t = telegramText(p);
    rec.summary = { total: Math.round(p.total * 100) / 100, tops: t.tops, lever: t.lever };
    rec.targetWs = pickWorkspace(p, wss)?.id ?? null;
    rec.reportAt = new Date(now).toISOString();
    delete rec.error;
    save();
    notifier(telegramLine(p));
  } catch (e: any) {
    rec.error = String(e?.message ?? e).slice(0, 300);
    save();
    console.warn(`[limit-postmortem] report ${rec.key}: ${rec.error}`);
  }
}

function terminalDue(rec: WallRec, now: number): boolean {
  if (!rec.reportAt || now < Date.parse(rec.resetsAt)) return false;
  const t = rec.terminal;
  if (!t) return true;
  if (t.session_id || t.skipped) return false;
  return t.tries < TERMINAL_TRIES && now - Date.parse(t.at) >= TERMINAL_RETRY_MS;
}

async function openTerminal(rec: WallRec, now: number, deps: TickDeps) {
  const walled = deps.walled ?? stillWalled;
  if (walled(rec.configDir, now)) return; // not yet: the next tick looks again
  const skip = (why: string) => { rec.terminal = { at: new Date(now).toISOString(), tries: rec.terminal?.tries ?? 0, skipped: why }; save(); };
  if (now - Date.parse(rec.resetsAt) > TERMINAL_STALE_MS) return skip("the reset was more than 12 hours ago");
  const wss = workspacesOnProfile(rec.configDir);
  if (!wss.length) return skip("no workspace is pinned to this profile");
  // Claim it before anything awaits: one terminal per wall, whatever happens next.
  rec.terminal = { at: new Date(now).toISOString(), tries: (rec.terminal?.tries ?? 0) + 1 };
  save();
  // Read once more now the window is over: the calls refused after the wall are all in.
  let p: Postmortem | null = null;
  try {
    p = await (deps.run ?? runPostmortem)({ configDir: rec.configDir, window: rec.window, resetsAt: Date.parse(rec.resetsAt), wallAt: Date.parse(rec.seenAt), now });
    const md = renderWithHistory(rec, p);
    rec.notes = deliverNotes(rec, md, wss);
    rec.markdown = md;
    rec.targetWs = pickWorkspace(p, wss)?.id ?? rec.targetWs ?? null;
    rec.finalAt = new Date(now).toISOString();
  } catch (e: any) {
    console.warn(`[limit-postmortem] final read ${rec.key}: ${e?.message ?? e}`);
  }
  const target = wss.find((w) => w.id === rec.targetWs) ?? wss[0];
  if (!settingOn("limits.postmortem_terminal", target.id)) return skip("off in ⚙ Settings (limits.postmortem_terminal)");
  if (sessions.list({ workspace_id: target.id, status: "live" }).some((s) => s.created_by === POSTMORTEM_BY)) return skip("a post-mortem terminal is already open there");
  const recent = load().walls.find((r) => r !== rec && r.configDir === rec.configDir && r.terminal?.session_id && now - Date.parse(r.terminal.at) < 3 * 3600_000);
  if (recent) return skip(`this account's post-mortem terminal ${recent.terminal!.session_id!.slice(0, 8)} opened under 3 hours ago`);
  const note = rec.notes?.find((n) => n.workspace_id === target.id) ?? null;
  const backend = target.default_backend || "claude-code";
  const model = backend === "claude-code" || backend === "claude" ? String(setting<string>("limits.postmortem_model", target.id) || "sonnet") : null;
  const brief = p
    ? terminalBrief(p, note ? `\`mc memo get ${NOTE_SLUG}\` (file ${note.file})` : null)
    : `The ${WINDOW_LABEL[rec.window]} window of ${rec.profile} ran out. Report: \`mc memo get ${NOTE_SLUG}\`. Go over its levers with the operator and apply only the ones he approves.`;
  try {
    const s = await (deps.opener ?? (await import("./terminal.js")).openSession)({
      workspace_id: target.id,
      goal: `Where the ${WINDOW_LABEL[rec.window]} window went on ${profileName(rec.profile)} — review the levers with the operator and apply the ones he approves`.slice(0, 400),
      goal_kind: "investigation",
      goal_source: "human",
      description: brief,
      backend,
      model,
      created_by: POSTMORTEM_BY,
      role: "human",
    } as any);
    rec.terminal = { ...rec.terminal!, session_id: s.id, workspace_id: target.id };
    delete rec.terminal.error;
    save();
    console.log(`[limit-postmortem] terminal ${s.id.slice(0, 8)} in ${target.slug} for ${rec.key}`);
  } catch (e: any) {
    rec.terminal = { ...rec.terminal!, workspace_id: target.id, error: String(e?.message ?? e).slice(0, 300) };
    save();
    console.warn(`[limit-postmortem] terminal for ${rec.key} refused: ${rec.terminal.error}`);
  }
}

let busy = false;
/** One pass: record new walls, report the unreported, open the terminal for walls whose window reset. */
export async function postmortemTick(now = Date.now(), deps: TickDeps = {}): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    if (!settingOn("limits.postmortem")) return;
    for (const w of [...(deps.seen ?? []), ...wallsFromMeter(now), ...wallsFromRuns(now)]) noteWall(w);
    for (const rec of [...load().walls]) {
      if (!rec.reportAt && rec.attempts < 3 && Date.parse(rec.resetsAt) > now - REPORT_STALE_MS) await report(rec, now, deps);
      else if (terminalDue(rec, now)) await openTerminal(rec, now, deps);
    }
  } finally {
    busy = false;
  }
}

export function startLimitPostmortem(): void {
  const kick = () => void postmortemTick().catch((e) => console.warn("[limit-postmortem] tick:", e?.message ?? e));
  onClaudeWall((w: ClaudeWallReading) => {
    if (!isWindow(w.window) || !w.resetsAt || !settingOn("limits.postmortem")) return;
    const dir = resolveProfileDir(w.scope);
    if (!dir) return;
    if (noteWall({ configDir: dir, window: w.window, resetsAt: Date.parse(w.resetsAt), at: Date.parse(w.at) || Date.now(), source: "meter" })) setTimeout(kick, 1000).unref?.();
  });
  setInterval(kick, TICK_MS).unref?.();
  setTimeout(kick, 30_000).unref?.();
  console.log(`[limit-postmortem] a report when a Claude profile hits its 5h/week wall, a terminal after the reset (checked every ${TICK_MS / 1000}s)`);
}

// ───────────────────────────── routes ─────────────────────────────

type Scope = { ws: string | null } | null;
const scopeDir = (scope: { ws: string | null }): string | null => {
  if (!scope.ws) return null;
  const w = workspaces.get(scope.ws);
  return w ? normDir(w.config_dir) : "";
};

/** GET /limits/postmortems — the stored reports, newest first. A workspace token: its own profile's only. */
export function listRequest(scope: Scope, q: { profile?: unknown; full?: unknown }): { status: number; body: unknown } {
  if (scope === null) return { status: 401, body: { error: "invalid workspace token" } };
  const own = scopeDir(scope);
  if (own === "") return { status: 404, body: { error: "workspace not found" } };
  let dir: string | null = own;
  if (q.profile != null && String(q.profile)) {
    const want = resolveProfileDir(String(q.profile));
    if (own && want !== own) return { status: 403, body: { error: "a workspace token reads its own account's reports only" } };
    if (!want) return { status: 404, body: { error: `unknown profile ${String(q.profile)}` } };
    dir = want;
  }
  const full = q.full === "1" || q.full === "true";
  const rows = load().walls.filter((r) => !dir || r.configDir === dir).slice().reverse().map((r) => ({
    key: r.key, profile: r.profile, window: r.window, resets_at: r.resetsAt, seen_at: r.seenAt, source: r.source,
    report_at: r.reportAt ?? null, final_at: r.finalAt ?? null, error: r.error ?? null, summary: r.summary ?? null,
    terminal: r.terminal ? { at: r.terminal.at, session_id: r.terminal.session_id ?? null, skipped: r.terminal.skipped ?? null, error: r.terminal.error ?? null } : null,
    ...(full ? { markdown: r.markdown ?? null } : {}),
  }));
  return { status: 200, body: { reports: rows } };
}

/** GET /limits/postmortem — read one window now, write nothing. A workspace token: its own profile only. */
export async function onDemandRequest(scope: Scope, q: { profile?: unknown; window?: unknown; at?: unknown }, now = Date.now(), run = runPostmortem): Promise<{ status: number; body: unknown }> {
  if (scope === null) return { status: 401, body: { error: "invalid workspace token" } };
  const own = scopeDir(scope);
  if (own === "") return { status: 404, body: { error: "workspace not found" } };
  const window = String(q.window ?? "5h");
  if (!isWindow(window)) return { status: 400, body: { error: "--window is 5h or week" } };
  let dir: string | null = own;
  if (q.profile != null && String(q.profile)) {
    const want = resolveProfileDir(String(q.profile));
    if (own && want !== own) return { status: 403, body: { error: "a workspace token reads its own account only" } };
    if (!want) return { status: 404, body: { error: `unknown or ambiguous profile ${String(q.profile)}` } };
    dir = want;
  }
  dir ??= defaultDir();
  let at: number | null = null;
  if (q.at != null && String(q.at)) {
    at = Date.parse(String(q.at));
    if (!Number.isFinite(at)) return { status: 400, body: { error: "--at takes an ISO time" } };
    at = Math.min(at, now);
  }
  // No --at: the meter's window for this profile — the current one, or the one that just ended.
  let resetsAt: number | null = null;
  if (at == null) {
    const m = claudeMeters().find((x) => resolveProfileDir(x.scope) === dir);
    const r = Date.parse(m?.windows.find((w) => w.name === window)?.resetsAt ?? "");
    if (Number.isFinite(r) && r > now - WINDOW_MS[window]) resetsAt = r;
  }
  try {
    const p = await run({ configDir: dir, window, resetsAt, at: resetsAt == null ? at ?? now : null, now });
    const { byWorkspace: _spendByWorkspace, ...report } = p;
    return { status: 200, body: { report, markdown: renderPostmortem(p) } };
  } catch (e: any) {
    return { status: 500, body: { error: String(e?.message ?? e).slice(0, 300) } };
  }
}
