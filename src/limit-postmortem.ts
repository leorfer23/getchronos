/**
 * Limit post-mortem — where a Claude profile's usage window went, the moment it hit its wall, and
 * which levers would have spent less. Pure code: arithmetic over that profile's own transcripts and the
 * DB rows that say who opened what. No model reads any of it — the point is to save tokens, not spend
 * them. The trigger, the notes, the terminal and the Telegram line live in limit-postmortem-run.ts.
 *
 *   profileTranscripts / scanProfile   one profile's `projects/<cwd>/<id>.jsonl` (and its subagents'
 *                      `<id>/subagents/*.jsonl`, credited to the parent) → deduped requests and the
 *                      synthetic "You've hit your … limit" messages. One message is written on several
 *                      lines (thinking, text, tool call): (message.id, requestId) counts it once.
 *   categorize         a transcript + its `sessions` / `runs` row → who spent it (Desk terminal by
 *                      creator, Lead, Lead worker, Robert's turns, a job family, verify/review, an SDK app
 *                      or anything else outside Chronos, named by its cwd).
 *   analyze            the window: shares, the top sessions, the previous slices' rate, the calls after the
 *                      wall, and the levers — each only when the data carries it, ranked by its saving.
 *   renderPostmortem   the markdown the operator's workspace notes get.
 *
 * Weights are LIST prices (pricing.ts listRates): the vendor does not publish how its windows weigh
 * tokens, so every number is a share or "$ list-equivalent", never a claim about the window's size.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { CACHE_WRITE_1H, CACHE_WRITE_5M, listRates, type ListRates } from "./pricing.js";
import { baseJobName } from "./job-name.js";

export type WindowName = "5h" | "week";
export const WINDOWS: readonly WindowName[] = ["5h", "week"];
export const WINDOW_MS: Record<WindowName, number> = { "5h": 5 * 3600_000, week: 7 * 86_400_000 };
export const WINDOW_LABEL: Record<WindowName, string> = { "5h": "5-hour", week: "weekly" };
/** Earlier slices of the window's own length that "the usual rate" is the median of. */
export const BASELINE_SLICES: Record<WindowName, number> = { "5h": 6, week: 2 };
export const TOP_SESSIONS = 10;
export const MAX_LEVERS = 5;
const HOUR = 3600_000;

// ───────────────────────────── one request ─────────────────────────────

export interface Usage { input: number; output: number; cacheRead: number; cw5: number; cw1: number }
export interface Req extends Usage {
  at: number;
  model: string;
  /** A subagent's request — credited to its parent session, kept apart for the context peak and the replays. */
  sub: boolean;
  cost: number;
}

export function reqCost(model: string, u: Usage, r: ListRates = listRates(model)): number {
  return (u.input * r.in + u.cw5 * r.in * CACHE_WRITE_5M + u.cw1 * r.in * CACHE_WRITE_1H + u.cacheRead * r.cacheRead + u.output * r.out) / 1e6;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** The API's usage block → tokens. A write with no TTL split (older CLIs) counts as 5-minute. */
export function usageOf(u: any): Usage {
  const total = num(u?.cache_creation_input_tokens);
  const cc = u?.cache_creation && typeof u.cache_creation === "object" ? u.cache_creation : null;
  const cw1 = num(cc?.ephemeral_1h_input_tokens);
  let cw5 = num(cc?.ephemeral_5m_input_tokens);
  if (cw5 + cw1 < total) cw5 += total - cw5 - cw1;
  return { input: num(u?.input_tokens), output: num(u?.output_tokens), cacheRead: num(u?.cache_read_input_tokens), cw5, cw1 };
}

const ctxOf = (u: Usage) => u.input + u.cacheRead + u.cw5 + u.cw1;
const writeOf = (u: Usage) => u.cw5 + u.cw1;

// ───────────────────────────── transcripts ─────────────────────────────

export interface Scanned {
  /** The session id: the file's name, or the parent's for a subagent's file. */
  id: string;
  entry: string | null;
  cwd: string | null;
  /** The first prompt, ≤200 chars: read only to tell a Robert turn from other rowless headless runs. Never rendered. */
  head: string | null;
  reqs: Req[];
  /** When the API refused a call with a limit message — a call made after the wall. */
  walls: number[];
}

export interface ScanWindow { since: number; until: number }
export interface TranscriptFile { file: string; id: string; sub: boolean; mtime: number }

const AUTH_TEXT = /log ?in|authenticat|oauth/i;
const LIMIT_TEXT = /you'?ve hit your\b.*\blimit|usage limit|\blimit\b.*\bresets?\b/i;
const textOf = (c: unknown): string =>
  Array.isArray(c) ? c.map((b: any) => (b && typeof b.text === "string" ? b.text : "")).join(" ") : typeof c === "string" ? c : "";

/** A synthetic assistant line the CLI writes when the API refused the call on a usage limit. */
export function isWallLine(d: any): boolean {
  if (d?.type !== "assistant" || d.message?.model !== "<synthetic>") return false;
  if (d.error === "rate_limit" || d.apiError === "usage_limit_reached" || d.quotaLimits?.status === "rejected") return true;
  const t = textOf(d.message?.content);
  return LIMIT_TEXT.test(t) && !AUTH_TEXT.test(t);
}

/** Every transcript of one profile touched since `since`, oldest first (the older copy of a message wins the dedupe). */
export function profileTranscripts(configDir: string, since: number): TranscriptFile[] {
  const out: TranscriptFile[] = [];
  const root = path.join(configDir, "projects");
  const ls = (d: string) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
  const add = (file: string, id: string, sub: boolean) => {
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs >= since) out.push({ file, id, sub, mtime: st.mtimeMs });
    } catch {}
  };
  for (const proj of ls(root)) {
    if (!proj.isDirectory()) continue;
    const pdir = path.join(root, proj.name);
    for (const e of ls(pdir)) {
      if (e.isFile() && e.name.endsWith(".jsonl")) add(path.join(pdir, e.name), e.name.slice(0, -6), false);
      else if (e.isDirectory()) {
        const sd = path.join(pdir, e.name, "subagents");
        for (const f of ls(sd)) if (f.isFile() && f.name.endsWith(".jsonl")) add(path.join(sd, f.name), e.name, true);
      }
    }
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

const blankScan = (id: string): Scanned => ({ id, entry: null, cwd: null, head: null, reqs: [], walls: [] });

/** One transcript line into its session. `seen` is shared by the whole profile scan. */
export function absorbLine(s: Scanned, line: string, ctx: { sub: boolean; seen: Set<string>; win: ScanWindow; headDone: { v: boolean } }): void {
  const assistant = line.includes('"type":"assistant"');
  if (!assistant && (ctx.headDone.v || !line.includes('"type":"user"'))) {
    if (s.entry || !line.includes('"entrypoint"')) return;
  }
  if (assistant && ctx.headDone.v) {
    // Newer CLIs write the line's own timestamp before the message: skip what is outside the window unparsed.
    const i = line.indexOf('"timestamp":"');
    if (i >= 0 && i < 400) {
      const t = Date.parse(line.slice(i + 13, i + 45).split('"')[0]);
      if (Number.isFinite(t) && (t < ctx.win.since || t >= ctx.win.until)) return;
    }
  }
  let d: any;
  try { d = JSON.parse(line); } catch { return; }
  if (!s.entry && typeof d.entrypoint === "string") s.entry = d.entrypoint;
  if (!s.cwd && typeof d.cwd === "string") s.cwd = d.cwd;
  if (d.type === "user" && !ctx.headDone.v) {
    const c = d.message?.content;
    if (Array.isArray(c) && c.some((b: any) => b?.type === "tool_result")) return;
    const t = textOf(c).trim();
    if (t) { s.head = t.slice(0, 200); ctx.headDone.v = true; }
    return;
  }
  if (d.type !== "assistant") return;
  const at = Date.parse(d.timestamp ?? "");
  if (!Number.isFinite(at) || at < ctx.win.since || at >= ctx.win.until) return;
  const m = d.message ?? {};
  const key = typeof m.id === "string" ? `${m.id}|${d.requestId ?? ""}` : null;
  if (m.model === "<synthetic>") {
    if (!isWallLine(d)) return;
    if (key) { if (ctx.seen.has(`w|${key}`)) return; ctx.seen.add(`w|${key}`); }
    s.walls.push(at);
    return;
  }
  if (!m.usage) return;
  if (key) { if (ctx.seen.has(key)) return; ctx.seen.add(key); }
  const u = usageOf(m.usage);
  if (!u.input && !u.output && !u.cacheRead && !u.cw5 && !u.cw1) return;
  const model = typeof m.model === "string" ? m.model : "";
  s.reqs.push({ ...u, at, model, sub: ctx.sub || d.isSidechain === true, cost: reqCost(model, u) });
}

async function scanFile(f: TranscriptFile, into: Map<string, Scanned>, seen: Set<string>, win: ScanWindow): Promise<void> {
  const s = into.get(f.id) ?? blankScan(f.id);
  into.set(f.id, s);
  // A subagent's first prompt is its task, not the session's: only the main file names the session.
  const ctx = { sub: f.sub, seen, win, headDone: { v: f.sub || s.head != null } };
  const input = fs.createReadStream(f.file, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) if (line) absorbLine(s, line, ctx);
  } catch {
    // a transcript that vanished or went unreadable mid-read: what was read so far stands
  } finally {
    rl.close();
    input.destroy();
  }
}

/** Read one profile's transcripts for [since, until): sessions with at least one request or wall in it. */
export async function scanProfile(configDir: string, win: ScanWindow, extra: TranscriptFile[] = []): Promise<Scanned[]> {
  const files = [...extra, ...profileTranscripts(configDir, win.since)].sort((a, b) => a.mtime - b.mtime);
  const into = new Map<string, Scanned>();
  const seen = new Set<string>();
  // Every main file before any subagent file, so a session's own entrypoint and cwd name it.
  for (const f of files.filter((x) => !x.sub)) await scanFile(f, into, seen, win);
  for (const f of files.filter((x) => x.sub)) await scanFile(f, into, seen, win);
  const out: Scanned[] = [];
  for (const s of into.values()) {
    if (!s.reqs.length && !s.walls.length) continue;
    s.reqs.sort((a, b) => a.at - b.at);
    s.walls.sort((a, b) => a - b);
    out.push(s);
  }
  return out;
}

// ───────────────────────────── who spent it ─────────────────────────────

export interface SessionRow {
  id: string;
  workspace_id: string | null;
  created_by: string | null;
  role: string | null;
  lead_id: string | null;
  model: string | null;
  goal: string | null;
  goal_kind: string | null;
  created_at: string;
  ended_at: string | null;
}
export interface RunRow { session_id: string; job_name: string; trigger_type: string | null; workspace_id: string | null }

export type Group = "desk" | "lead" | "lead-worker" | "robert" | "robert-helper" | "job" | "review" | "sdk" | "cli" | "headless";
export interface Cat {
  key: string;
  label: string;
  group: Group;
  /** A job nobody asked for in the moment: cron, or the daemon's own families (dream, inbox cleanup…). */
  background: boolean;
}

const REVIEW_HEADS = new Set(["review", "verify", "merge-gate", "grade"]);
const DAEMON_FAMILIES = new Set([
  "dream", "inbox-cleanup", "monitor", "slack-triage", "job-check", "distill", "ideas", "intake", "prose", "style", "hygiene",
  "note-work", "retro", "nextday", "oncall-gate",
]);
const TERMINAL_GROUPS: ReadonlySet<Group> = new Set(["desk", "lead", "lead-worker"]);

/** `sessions.created_by` → the creator a report groups by. */
export function creatorOf(by: string | null | undefined): string {
  const b = (by ?? "").trim();
  if (!b || b === "operator" || b === "ticket") return "operator";
  if (b === "robert" || b === "proactive") return "robert";
  if (b === "failover" || b === "handoff") return "stand-in";
  if (b.startsWith("lead:")) return "lead";
  return b.slice(0, 40);
}

/** A job name → its family: `review:verify-1a2b3c4d` → review:verify, `dream:acme` → dream, `reap-stale-worktrees-acme` → reap-stale-worktrees. */
export function jobFamily(name: string, slugs: readonly string[] = []): string {
  const base = baseJobName(name).trim();
  const i = base.indexOf(":");
  if (i > 0) {
    const head = base.slice(0, i);
    if (REVIEW_HEADS.has(head)) {
      const sub = base.slice(i + 1).match(/^[a-z]+/)?.[0];
      return sub ? `${head}:${sub}` : head;
    }
    return head;
  }
  for (const s of slugs) if (s && base.endsWith(`-${s}`) && base.length > s.length + 1) return base.slice(0, -(s.length + 1));
  return base.slice(0, 60) || "unnamed job";
}

export function shortPath(p: string | null | undefined, home: string): string {
  if (!p) return "";
  return home && (p === home || p.startsWith(home + "/")) ? "~" + p.slice(home.length) : p;
}

const ROBERT_TURN = /^(HOSTS:|FLEET NOW)/;
const ROBERT_HELPER = /^You are Robert, chief of staff/;

export function categorize(s: Pick<Scanned, "entry" | "cwd" | "head">, row: SessionRow | undefined, run: RunRow | undefined, o: { slugs?: readonly string[]; home?: string } = {}): Cat {
  if (row) {
    if (row.role === "lead") return { key: "lead", label: "Leads", group: "lead", background: false };
    if (row.lead_id || (row.created_by ?? "").startsWith("lead:")) return { key: "lead-worker", label: "Lead workers", group: "lead-worker", background: false };
    const c = creatorOf(row.created_by);
    return { key: `desk:${c}`, label: `Desk · ${c}`, group: "desk", background: false };
  }
  if (run) {
    const fam = jobFamily(run.job_name, o.slugs);
    const head = fam.split(":")[0];
    if (REVIEW_HEADS.has(head)) return { key: `review:${fam}`, label: `Verify/review · ${fam}`, group: "review", background: false };
    const cron = run.trigger_type === "cron";
    return { key: `job:${fam}`, label: `Job · ${fam}${cron ? " (cron)" : ""}`, group: "job", background: cron || DAEMON_FAMILIES.has(head) };
  }
  const head = (s.head ?? "").trimStart();
  // Robert's turns run headless (`claude -p`, sdk-cli) with no row of their own; each opens with the fleet line.
  if (s.entry === "sdk-cli" || !s.entry) {
    if (ROBERT_TURN.test(head)) return { key: "robert", label: "Robert turns", group: "robert", background: false };
    if (ROBERT_HELPER.test(head)) return { key: "robert-helper", label: "Robert digests (summaries, worklog)", group: "robert-helper", background: false };
  }
  const where = shortPath(s.cwd, o.home ?? "") || "unknown dir";
  if (s.entry === "sdk-py" || s.entry === "sdk-ts") return { key: `sdk:${where}`, label: `SDK app outside Chronos · ${where}`, group: "sdk", background: false };
  if (s.entry === "cli") return { key: `cli:${where}`, label: `Interactive, outside the Desk · ${where}`, group: "cli", background: false };
  return { key: `headless:${where}`, label: `Headless, no Chronos row · ${where}`, group: "headless", background: false };
}

export function shortModel(m: string | null | undefined): string {
  const s = m ?? "";
  for (const k of ["opus", "sonnet", "haiku", "fable"]) if (s.toLowerCase().includes(k)) return k;
  return s.replace(/^claude-/, "") || "?";
}

// ───────────────────────────── the window ─────────────────────────────

export interface AnalyzeInput {
  /** The profile's directory name, e.g. ".claude-acme". */
  profile: string;
  window: WindowName;
  start: number;
  /** When the trigger saw the wall; null for an on-demand read. The first refused call moves it earlier. */
  wallAt: number | null;
  resetsAt: number | null;
  /** The end of what was scanned (≤ now). */
  until: number;
  sessions: Scanned[];
  rows: Map<string, SessionRow>;
  runs: Map<string, RunRow>;
  /** Workspaces pinned to THIS profile. A row from any other workspace never prints its goal. */
  onProfile?: ReadonlySet<string>;
  slugs?: readonly string[];
  home?: string;
}

export interface CatLine { key: string; label: string; group: Group; usd: number; pct: number; sessions: number; requests: number; subUsd: number }
export interface DeskLine { creator: string; model: string; kind: string; usd: number; pct: number; terminals: number }
export interface TopLine {
  id8: string; source: string; model: string; goal: string; usd: number; pct: number; requests: number;
  peakCtx: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; subUsd: number;
}
export type LeverId =
  | "opus-investigation" | "background-past-80" | "headless-1h-cache" | "short-lived" | "cold-rebuilds" | "startup-baseline" | "sdk-apps" | "after-wall";
export interface Lever { id: LeverId; title: string; usd: number; pct: number; detail: string; action: string }

export interface Postmortem {
  profile: string;
  window: WindowName;
  start: string;
  wallAt: string;
  resetsAt: string | null;
  until: string;
  /** A wall was seen (the trigger's reading or a refused call) — not just the end of what was read. */
  walled: boolean;
  total: number;
  requests: number;
  sessions: number;
  subUsd: number;
  categories: CatLine[];
  desk: DeskLine[];
  top: TopLine[];
  baseline: { rate: number; usual: number | null; slices: number; ratio: number | null; grew: { label: string; from: number; to: number } | null };
  afterWall: { refused: number; bySource: { label: string; n: number }[]; billed: number };
  levers: Lever[];
  /** Spend by workspace (rows only) — which pinned workspace gets the terminal. Never rendered. */
  byWorkspace: Record<string, number>;
}

interface Sess {
  s: Scanned;
  cat: Cat;
  row?: SessionRow;
  run?: RunRow;
  win: Req[];
  usd: number;
  subUsd: number;
}

const sum = (xs: Iterable<number>) => { let t = 0; for (const x of xs) t += x; return t; };
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const activeHours = (ats: Iterable<number>) => { const h = new Set<number>(); for (const t of ats) h.add(Math.floor(t / HOUR)); return h.size; };
const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const usd = (v: number) => `$${v >= 100 ? v.toFixed(0) : v.toFixed(2)}`;
const pctOf = (v: number, total: number) => (total > 0 ? (100 * v) / total : 0);
const pctTxt = (p: number) => `${p >= 10 ? p.toFixed(0) : p.toFixed(1)}%`;
const ktok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

export function analyze(i: AnalyzeInput): Postmortem {
  const len = WINDOW_MS[i.window];
  const all: Sess[] = i.sessions.map((s) => {
    const row = i.rows.get(s.id);
    const run = row ? undefined : i.runs.get(s.id);
    return { s, row, run, cat: categorize(s, row, run, { slugs: i.slugs, home: i.home }), win: [], usd: 0, subUsd: 0 };
  });

  // The wall: whichever came first, the trigger's reading or the first refused call in the window.
  let firstWall = Infinity;
  for (const x of all) for (const t of x.s.walls) if (t >= i.start && t < firstWall) firstWall = t;
  let wallAt = Math.min(i.wallAt ?? Infinity, firstWall);
  const walled = Number.isFinite(wallAt);
  if (!walled) wallAt = i.until;
  wallAt = Math.max(i.start, Math.min(wallAt, i.until));
  const inWindow = (t: number) => t >= i.start && t <= wallAt;

  for (const x of all) {
    x.win = x.s.reqs.filter((r) => inWindow(r.at));
    x.usd = sum(x.win.map((r) => r.cost));
    x.subUsd = sum(x.win.filter((r) => r.sub).map((r) => r.cost));
  }
  const live = all.filter((x) => x.win.length);
  const total = sum(live.map((x) => x.usd));
  const requests = sum(live.map((x) => x.win.length));

  // Shares by category.
  const cats = new Map<string, CatLine>();
  for (const x of live) {
    const c = cats.get(x.cat.key) ?? { key: x.cat.key, label: x.cat.label, group: x.cat.group, usd: 0, pct: 0, sessions: 0, requests: 0, subUsd: 0 };
    c.usd += x.usd; c.sessions++; c.requests += x.win.length; c.subUsd += x.subUsd;
    cats.set(x.cat.key, c);
  }
  const categories = [...cats.values()].map((c) => ({ ...c, pct: pctOf(c.usd, total) })).sort((a, b) => b.usd - a.usd);

  // Desk terminals: creator × model × goal kind.
  const desk = new Map<string, DeskLine>();
  for (const x of live) {
    if (!TERMINAL_GROUPS.has(x.cat.group)) continue;
    const creator = x.cat.group === "desk" ? x.cat.key.slice(5) : x.cat.group === "lead" ? "lead" : "lead worker";
    const model = shortModel(mainModel(x.win));
    const kind = x.row?.goal_kind || "—";
    const k = `${creator}|${model}|${kind}`;
    const d = desk.get(k) ?? { creator, model, kind, usd: 0, pct: 0, terminals: 0 };
    d.usd += x.usd; d.terminals++;
    desk.set(k, d);
  }
  const deskLines = [...desk.values()].map((d) => ({ ...d, pct: pctOf(d.usd, total) })).sort((a, b) => b.usd - a.usd);

  // Top sessions.
  const top = [...live].sort((a, b) => b.usd - a.usd).slice(0, TOP_SESSIONS).map((x): TopLine => {
    const main = x.win.filter((r) => !r.sub);
    const own = !x.row?.workspace_id || !i.onProfile || i.onProfile.has(x.row.workspace_id);
    const goal = x.row ? (own ? oneLine(x.row.goal) : "(another profile's terminal)") : x.run ? x.run.job_name : "";
    return {
      id8: x.s.id.slice(0, 8),
      source: x.cat.label,
      model: shortModel(mainModel(x.win)),
      goal: clip(goal, 80),
      usd: x.usd,
      pct: pctOf(x.usd, total),
      requests: x.win.length,
      peakCtx: main.reduce((m, r) => Math.max(m, ctxOf(r)), 0),
      cacheRead: sum(x.win.map((r) => r.cacheRead)),
      cacheWrite: sum(x.win.map(writeOf)),
      cacheWrite1h: sum(x.win.map((r) => r.cw1)),
      subUsd: x.subUsd,
    };
  });

  // Against the previous slices of the same length: rate per hour that had any request.
  const winHours = Math.max(1, activeHours(live.flatMap((x) => x.win.map((r) => r.at))));
  const rate = total / winHours;
  const slices: { usd: number; hours: number; byCat: Map<string, number> }[] = [];
  for (let k = 1; k <= BASELINE_SLICES[i.window]; k++) {
    const a = i.start - k * len, b = i.start - (k - 1) * len;
    const byCat = new Map<string, number>();
    const ats: number[] = [];
    let u = 0;
    for (const x of all) for (const r of x.s.reqs) {
      if (r.at < a || r.at >= b) continue;
      u += r.cost; ats.push(r.at);
      byCat.set(x.cat.key, (byCat.get(x.cat.key) ?? 0) + r.cost);
    }
    slices.push({ usd: u, hours: activeHours(ats), byCat });
  }
  const active = slices.filter((s) => s.hours > 0 && s.usd > 0);
  const usual = active.length >= 2 ? median(active.map((s) => s.usd / s.hours)) : null;
  let grew: Postmortem["baseline"]["grew"] = null;
  if (active.length >= 2) {
    const baseHours = sum(active.map((s) => s.hours));
    let best = 0;
    for (const c of categories) {
      const from = sum(active.map((s) => s.byCat.get(c.key) ?? 0)) / baseHours;
      const to = c.usd / winHours;
      if (to - from > best) { best = to - from; grew = { label: c.label, from, to }; }
    }
  }
  const baseline = { rate, usual, slices: active.length, ratio: usual && usual > 0 ? rate / usual : null, grew };

  // Calls after the wall, and anything still billed after it (usage credits, another model's allowance).
  const capEnd = Math.min(i.resetsAt ?? Infinity, i.until);
  const bySrc = new Map<string, number>();
  let refused = 0;
  for (const x of all) {
    const n = x.s.walls.filter((t) => t >= i.start && t < Math.max(capEnd, wallAt + 1)).length;
    if (!n) continue;
    refused += n;
    bySrc.set(x.cat.label, (bySrc.get(x.cat.label) ?? 0) + n);
  }
  const billed = sum(all.flatMap((x) => x.s.reqs.filter((r) => r.at > wallAt && r.at < capEnd).map((r) => r.cost)));
  const afterWall = { refused, bySource: [...bySrc].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n), billed };

  const byWorkspace: Record<string, number> = {};
  for (const x of live) {
    const ws = x.row?.workspace_id ?? x.run?.workspace_id;
    if (ws) byWorkspace[ws] = (byWorkspace[ws] ?? 0) + x.usd;
  }

  const p: Postmortem = {
    profile: i.profile, window: i.window, start: iso(i.start), wallAt: iso(wallAt), resetsAt: i.resetsAt == null ? null : iso(i.resetsAt),
    until: iso(i.until), walled, total, requests, sessions: live.length, subUsd: sum(live.map((x) => x.subUsd)),
    categories, desk: deskLines, top, baseline, afterWall, levers: [], byWorkspace,
  };
  p.levers = levers(live, p, wallAt);
  return p;
}

const iso = (t: number) => new Date(t).toISOString();

function mainModel(reqs: Req[]): string {
  const by = new Map<string, number>();
  for (const r of reqs) if (!r.sub) by.set(r.model, (by.get(r.model) ?? 0) + r.cost);
  if (!by.size) for (const r of reqs) by.set(r.model, (by.get(r.model) ?? 0) + r.cost);
  return [...by].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

// ───────────────────────────── levers ─────────────────────────────

const INVESTIGATION_KINDS = new Set(["investigation", "qa", "chat"]);
const SONNET = "claude-sonnet-5-5";
const SHORT_LIFE_MS = 2 * 60_000;
const SHORT_FIRST_WRITE = 20_000;
const REBUILD_MIN = 50_000;
const TTL_MS = { "5m": 5 * 60_000, "1h": HOUR };

/**
 * What one-shot headless requests would cost with the 5-minute TTL instead of the 1-hour one they wrote
 * (port of the hand replay that started this). Every write becomes a 5-minute write; a read after a gap
 * over 5 minutes becomes a write. The first request's reads: optimistic keeps them reads (a sibling run in
 * the same directory warmed the prefix), pessimistic turns them into writes. Main-conversation requests only.
 */
export function replay5m(reqs: Req[]): { actual: number; optimistic: number; pessimistic: number } {
  let actual = 0, optimistic = 0, pessimistic = 0, prev: number | null = null;
  for (const r of reqs) {
    const rt = listRates(r.model);
    const base = (r.input * rt.in + r.output * rt.out) / 1e6;
    actual += r.cost;
    const gap = prev == null ? null : r.at - prev;
    const lostO = gap != null && gap > TTL_MS["5m"] ? r.cacheRead : 0;
    const lostP = gap == null || gap > TTL_MS["5m"] ? r.cacheRead : 0;
    optimistic += base + ((r.cw5 + r.cw1 + lostO) * rt.in * CACHE_WRITE_5M + (r.cacheRead - lostO) * rt.cacheRead) / 1e6;
    pessimistic += base + ((r.cw5 + r.cw1 + lostP) * rt.in * CACHE_WRITE_5M + (r.cacheRead - lostP) * rt.cacheRead) / 1e6;
    prev = r.at;
  }
  return { actual, optimistic, pessimistic };
}

/** Requests that wrote > REBUILD_MIN after idling longer than their cache's TTL, and what the rewrite cost over a warm read. */
export function coldRebuilds(main: Req[]): { n: number; tokens: number; excess: number } {
  let n = 0, tokens = 0, excess = 0, prev: number | null = null;
  let ttl: number | null = null;
  for (const r of main) {
    const w = writeOf(r);
    if (prev != null && ttl != null && r.at - prev > ttl && w > REBUILD_MIN) {
      const rt = listRates(r.model);
      n++;
      tokens += w;
      excess += (r.cw5 * (rt.in * CACHE_WRITE_5M - rt.cacheRead) + r.cw1 * (rt.in * CACHE_WRITE_1H - rt.cacheRead)) / 1e6;
    }
    if (r.cw1 > 0) ttl = TTL_MS["1h"];
    else if (r.cw5 > 0 && ttl == null) ttl = TTL_MS["5m"];
    prev = r.at;
  }
  return { n, tokens, excess };
}

function levers(live: Sess[], p: Postmortem, wallAt: number): Lever[] {
  const total = p.total;
  if (total <= 0) return [];
  const out: Lever[] = [];
  const mk = (id: LeverId, title: string, v: number, detail: string, action: string) => out.push({ id, title, usd: v, pct: pctOf(v, total), detail, action });
  const terminals = live.filter((x) => TERMINAL_GROUPS.has(x.cat.group));

  // 1. Opus on investigation-shaped terminals: Sonnet 5.5 is half of Opus 5.5 at list.
  {
    let actual = 0, asSonnet = 0, n = 0;
    for (const x of terminals) {
      if (!INVESTIGATION_KINDS.has(x.row?.goal_kind ?? "")) continue;
      const opus = x.win.filter((r) => /opus/i.test(r.model));
      if (!opus.length) continue;
      n++;
      actual += sum(opus.map((r) => r.cost));
      asSonnet += sum(opus.map((r) => reqCost(SONNET, r)));
    }
    const save = actual - asSonnet;
    if (pctOf(save, total) >= 1) {
      mk("opus-investigation", "Sonnet for investigation-shaped terminals", save,
        `${n} investigation/QA/chat terminal${n === 1 ? "" : "s"} ran on Opus: ${usd(actual)} (${pctTxt(pctOf(actual, total))} of the window). The same tokens on Sonnet 5.5 weigh half.`,
        "Open investigation, QA and chat terminals on Sonnet (the workspace's default model, or `--model sonnet`) and keep Opus for build work.");
    }
  }

  // 2. Background jobs, and what they spent once the window was past 80% (by list weight).
  {
    const bg = live.filter((x) => x.cat.background);
    const bgUsd = sum(bg.map((x) => x.usd));
    const ordered = live.flatMap((x) => x.win).sort((a, b) => a.at - b.at);
    let cum = 0, t80 = wallAt;
    for (const r of ordered) { cum += r.cost; if (cum >= 0.8 * total) { t80 = r.at; break; } }
    const after = sum(bg.flatMap((x) => x.win.filter((r) => r.at >= t80).map((r) => r.cost)));
    const opus = sum(bg.flatMap((x) => x.win.filter((r) => /opus/i.test(r.model)).map((r) => r.cost)));
    if (pctOf(after, total) >= 1) {
      const fams = new Map<string, number>();
      for (const x of bg) fams.set(x.cat.label, (fams.get(x.cat.label) ?? 0) + x.usd);
      const topF = [...fams].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([l, v]) => `${l.replace(/^Job · /, "")} ${pctTxt(pctOf(v, total))}`).join(", ");
      mk("background-past-80", "Hold background jobs once the window passes 80%", after,
        `Background jobs took ${pctTxt(pctOf(bgUsd, total))} of the window (${topF}); ${usd(after)} of it after the window passed ~80% at ${hhmm(t80)}.` +
          (opus > 0 && pctOf(opus, total) >= 1 ? ` ${usd(opus)} of their spend ran on Opus.` : ""),
        "Gate cron and daemon jobs (dream, inbox cleanup, monitors, triage) on the profile's usage: hold them past 80% of a window, and move the Opus ones to Sonnet.");
    }
  }

  // 3. One-shot headless runs writing the 1-hour cache.
  {
    let actual = 0, opt = 0, pes = 0, runsN = 0;
    for (const x of live) {
      if (x.s.entry !== "sdk-cli" || x.cat.group === "robert") continue;
      const main = x.win.filter((r) => !r.sub);
      if (!main.some((r) => r.cw1 > 0)) continue;
      const rp = replay5m(main);
      actual += rp.actual; opt += rp.optimistic; pes += rp.pessimistic; runsN++;
    }
    const low = actual - pes, high = actual - opt;
    if (low > 0 && pctOf(low, total) >= 1) {
      mk("headless-1h-cache", "5-minute cache for one-shot headless runs", low,
        `${runsN} headless run${runsN === 1 ? "" : "s"} wrote the 1-hour cache (2× input per token written) for work that rarely idles 5 minutes. Replayed with the 5-minute TTL: ${usd(low)}–${usd(high)} less.`,
        "Run one-shot headless jobs with `CLAUDE_CODE_PROMPT_CACHE_TTL=5m` (Claude Code ≥ 2.1.242): a run that never idles 5 minutes pays 1.25× instead of 2× for every cache write.");
    }
  }

  // 4. Terminals that opened (one big first write) and were gone within ~2 minutes.
  {
    const short = terminals.filter((x) => {
      const r = x.row;
      if (!r?.ended_at) return false;
      const life = Date.parse(r.ended_at) - Date.parse(r.created_at);
      const first = x.s.reqs.find((q) => !q.sub);
      return Number.isFinite(life) && life >= 0 && life <= SHORT_LIFE_MS && !!first && writeOf(first) >= SHORT_FIRST_WRITE && x.win.includes(first);
    });
    const v = sum(short.map((x) => x.usd));
    if (short.length >= 2 && pctOf(v, total) >= 1) {
      const firstW = median(short.map((x) => writeOf(x.s.reqs.find((q) => !q.sub)!))) ?? 0;
      mk("short-lived", "Terminals that open and close within two minutes", v,
        `${short.length} terminals closed within 2 minutes of opening, each after a first cache write of ~${ktok(firstW)} tokens: ${usd(v)} for nothing kept.`,
        "Find what opens and immediately closes them (a duplicate open, a failed start, the wrong workspace) and stop it before the CLI starts.");
    }
  }

  // 5. Cold-cache rebuilds: a big write after idling past the cache's TTL.
  {
    let n = 0, tokens = 0, excess = 0;
    for (const x of live) {
      const r = coldRebuilds(x.win.filter((q) => !q.sub));
      n += r.n; tokens += r.tokens; excess += r.excess;
    }
    if (n && pctOf(excess, total) >= 2) {
      mk("cold-rebuilds", "Cold-cache rebuilds after idle gaps", excess,
        `${n} request${n === 1 ? "" : "s"} re-wrote ${ktok(tokens)} tokens of context after idling past the cache's lifetime; read warm, that would have cost ${usd(excess)} less.`,
        "Keep ⚙ Settings → Limits → `cache.keeper` on (compacts idle terminals before their cache expires) and close terminals you are done with instead of returning to them hours later.");
    }
  }

  // 6. The startup baseline every new terminal pays.
  {
    const fresh = terminals.filter((x) => x.row && Date.parse(x.row.created_at) >= Date.parse(p.start));
    const firsts = fresh.map((x) => ({ x, first: x.s.reqs.find((q) => !q.sub) })).filter((f) => f.first && f.x.win.includes(f.first)) as { x: Sess; first: Req }[];
    const sizes = firsts.map((f) => ctxOf(f.first));
    const med = median(sizes) ?? 0;
    if (firsts.length >= 5 && med >= 30_000) {
      let per10k = 0;
      for (const f of firsts) {
        const rt = listRates(f.first.model);
        const later = f.x.win.filter((q) => !q.sub && q !== f.first).length;
        per10k += (10_000 * rt.in * (f.first.cw1 > 0 ? CACHE_WRITE_1H : CACHE_WRITE_5M) + later * 10_000 * rt.cacheRead) / 1e6;
      }
      const startup = sum(firsts.map((f) => f.first.cost));
      if (pctOf(per10k, total) >= 1) {
        mk("startup-baseline", "A smaller startup prompt", per10k,
          `${firsts.length} terminals opened in the window; their first request carried a median ${ktok(med)} tokens (${usd(startup)} just to start). Each 10k tokens cut from that baseline is worth ≈ ${usd(per10k)} (${pctTxt(pctOf(per10k, total))}) on this window's traffic.`,
          "Trim what every terminal loads: ⚙ Settings → Limits (`desk.lean_skills`, `desk.mcp_deny`, `desk.lean_tools`).");
      }
    }
  }

  // 7. Agent SDK apps running on the subscription.
  {
    const sdk = live.filter((x) => x.cat.group === "sdk");
    const v = sum(sdk.map((x) => x.usd));
    const walls = sum(p.afterWall.bySource.filter((b) => b.label.startsWith("SDK app")).map((b) => b.n));
    if (sdk.length && (pctOf(v, total) >= 2 || walls >= 10)) {
      const where = [...new Set(sdk.map((x) => x.cat.label.replace(/^SDK app outside Chronos · /, "")))].slice(0, 3).join(", ");
      const opus = sum(sdk.flatMap((x) => x.win.filter((r) => /opus/i.test(r.model)).map((r) => r.cost)));
      mk("sdk-apps", "Agent SDK apps off the subscription", v,
        `${sdk.length} Agent SDK session${sdk.length === 1 ? "" : "s"} outside Chronos (${where}) took ${usd(v)} (${pctTxt(pctOf(v, total))})` +
          (v > 0 ? `, ${pctTxt(pctOf(opus, v))} of it on Opus` : "") + (walls ? `; ${walls} of the calls refused after the wall were theirs.` : "."),
        "Put eval and bot apps on an API key instead of the subscription, default them to Haiku or Sonnet, bound their concurrency, and stop on the first limit error.");
    }
  }

  // 8. Calls after the wall.
  {
    const a = p.afterWall;
    if (a.refused >= 5 || pctOf(a.billed, total) >= 1) {
      const src = a.bySource.slice(0, 3).map((b) => `${b.label} ${b.n}`).join(", ");
      mk("after-wall", "Stop calling once the wall is hit", a.billed,
        `${a.refused} call${a.refused === 1 ? "" : "s"} hit the wall after ${hhmm(wallAt)}${src ? ` (${src})` : ""}.` +
          (a.billed > 0 ? ` ${usd(a.billed)} more was billed after it (usage credits).` : " Refused calls spend nothing, but each one is a process that kept going."),
        "Make the top source stop on its first limit error and wait for the reset (Chronos jobs wait on the quota gate; apps outside Chronos do not).");
    }
  }

  return out.sort((a, b) => b.usd - a.usd).slice(0, MAX_LEVERS);
}

// ───────────────────────────── rendering ─────────────────────────────

let TZ: string | undefined;
/** The operator's clock for every time a report prints (CONFIG's timezone in the daemon; UTC in tests). */
export function setReportTimezone(tz: string | undefined) { TZ = tz; }
function hhmm(t: number | string): string {
  const d = new Date(t);
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}
function dayHhmm(t: number | string): string {
  const d = new Date(t);
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(d).replace(",", "");
}

export function profileName(profile: string): string {
  return profile.replace(/^\.claude-?/, "") || "personal";
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function headline(p: Postmortem): string {
  const when = p.window === "week" ? dayHhmm : hhmm;
  const reset = p.resetsAt ? ` · resets ${when(p.resetsAt)}` : "";
  return `${WINDOW_LABEL[p.window]} window ${when(p.start)}–${when(p.wallAt)}${p.walled ? " (wall)" : ""}${reset} · ${usd(p.total)} list-equivalent over ${p.requests.toLocaleString("en-US")} requests in ${p.sessions} sessions`;
}

export function rateLine(p: Postmortem): string | null {
  const b = p.baseline;
  if (b.usual == null || b.ratio == null) return null;
  const word = b.ratio >= 1.15 ? `Burned ${b.ratio.toFixed(1)}× the usual rate` : b.ratio <= 0.87 ? `Burned ${b.ratio.toFixed(1)}× the usual rate (slower than usual)` : "Burned at about the usual rate";
  const grew = b.grew ? ` Grew most: ${b.grew.label} (${usd(b.grew.from)}/h → ${usd(b.grew.to)}/h).` : "";
  return `${word}: ${usd(b.rate)}/h against a median ${usd(b.usual)}/h over the previous ${b.slices} active ${WINDOW_LABEL[p.window]} slices (per hour with any request).${grew}`;
}

export function renderPostmortem(p: Postmortem): string {
  const L: string[] = [];
  L.push(`# Where the ${WINDOW_LABEL[p.window]} window went — ${profileName(p.profile)}`, "");
  L.push(headline(p), "");
  const r = rateLine(p);
  if (r) L.push(r, "");
  L.push("_Weights are list prices — the vendor does not publish how its windows weigh tokens — so read shares, not dollars._", "");

  L.push("## Levers", "");
  if (!p.levers.length) L.push("Nothing in the data stands out enough to act on.", "");
  p.levers.forEach((l, n) => {
    L.push(`${n + 1}. **${l.title}** — ${l.id === "startup-baseline" ? "≈ " + pctTxt(l.pct) + " per 10k tokens cut" : "≈ " + pctTxt(l.pct) + " of the window"} (${usd(l.usd)}).`);
    L.push(`   ${l.detail}`);
    L.push(`   → ${l.action}`);
  });
  if (p.levers.length) L.push("");

  L.push("## Where it went", "", "| Source | $ | Share | Sessions | Requests |", "|---|---:|---:|---:|---:|");
  const shown = p.categories.slice(0, 14);
  for (const c of shown) L.push(`| ${cell(c.label)} | ${usd(c.usd)} | ${pctTxt(c.pct)} | ${c.sessions} | ${c.requests} |`);
  const rest = p.categories.slice(14);
  if (rest.length) L.push(`| ${rest.length} more | ${usd(sum(rest.map((c) => c.usd)))} | ${pctTxt(sum(rest.map((c) => c.pct)))} | ${sum(rest.map((c) => c.sessions))} | ${sum(rest.map((c) => c.requests))} |`);
  L.push("");
  if (p.subUsd > 0) L.push(`Subagents: ${usd(p.subUsd)} (${pctTxt(pctOf(p.subUsd, p.total))}), counted above in their parent session's row.`, "");

  if (p.desk.length) {
    L.push("## Desk terminals — creator × model × kind", "", "| Creator | Model | Kind | $ | Share | Terminals |", "|---|---|---|---:|---:|---:|");
    for (const d of p.desk.slice(0, 12)) L.push(`| ${cell(d.creator)} | ${d.model} | ${cell(d.kind)} | ${usd(d.usd)} | ${pctTxt(d.pct)} | ${d.terminals} |`);
    L.push("");
  }

  if (p.top.length) {
    L.push(`## Top ${p.top.length} sessions`, "", "| Session | Source | Model | Goal | $ | Share | Peak context | Cache read / write |", "|---|---|---|---|---:|---:|---:|---|");
    for (const t of p.top) {
      const w = t.cacheWrite1h > 0 ? `${ktok(t.cacheWrite)} (${ktok(t.cacheWrite1h)} 1h)` : ktok(t.cacheWrite);
      L.push(`| \`${t.id8}\` | ${cell(t.source)} | ${t.model} | ${cell(t.goal) || "—"} | ${usd(t.usd)}${t.subUsd > 0 ? ` (sub ${usd(t.subUsd)})` : ""} | ${pctTxt(t.pct)} | ${ktok(t.peakCtx)} | ${ktok(t.cacheRead)} / ${w} |`);
    }
    L.push("");
  }

  const a = p.afterWall;
  if (a.refused || a.billed > 0) {
    L.push("## After the wall", "");
    if (a.refused) L.push(`${a.refused} call${a.refused === 1 ? "" : "s"} refused with a limit message: ${a.bySource.slice(0, 6).map((b) => `${b.label} ${b.n}`).join(" · ")}.`);
    if (a.billed > 0) L.push(`${usd(a.billed)} billed after the wall (usage credits or another model's allowance).`);
    L.push("");
  }

  L.push("## How this was measured", "",
    `Every assistant request in this profile's transcripts between the window start and the wall, counted once per (message id, request id); subagents credited to their parent. ` +
    `Weights: list $/MTok per model — input, output, cache read; cache writes 1.25× input (5-minute) or 2× (1-hour). ` +
    `Sources come from the Desk's own rows (who opened a terminal, which job a run belongs to); Robert's turns are the headless runs that open with the fleet line; ` +
    `anything else is "outside Chronos", named by its directory. Terminals on other computers count only through their transcript mirror.`, "");
  return L.join("\n");
}

/** A label for a phone screen: a directory shrinks to its last part. */
const shortLabel = (l: string) => l.replace(/ · (~|\/)\S*?([^/\s]+)$/, " · $2");

/** The one Telegram line (HTML-escaped by the caller's esc). */
export function telegramText(p: Postmortem): { who: string; tops: string; lever: string | null } {
  return {
    who: `Claude (${profileName(p.profile)})`,
    tops: p.categories.slice(0, 2).map((c) => `${shortLabel(c.label)} ${pctTxt(c.pct)}`).join(", "),
    lever: p.levers[0] ? `${p.levers[0].title} (≈${pctTxt(p.levers[0].pct)})` : null,
  };
}

/** What the post-mortem terminal is told when it opens. */
export function terminalBrief(p: Postmortem, notePath: string | null): string {
  const L: string[] = [];
  L.push(`A Claude usage window ran out on this workspace's account, and the daemon opened this terminal to go over it with the operator.`, "");
  L.push(`Profile ${p.profile} — ${headline(p)}.`);
  if (notePath) L.push(`Full report (read it first): ${notePath} — the note "Limit post-mortem" in this workspace.`);
  const r = rateLine(p);
  if (r) L.push(r);
  L.push("", "Top consumers:");
  for (const c of p.categories.slice(0, 4)) L.push(`- ${c.label} — ${pctTxt(c.pct)} (${usd(c.usd)})`);
  if (p.levers.length) {
    L.push("", "Levers (estimated saving, share of the window, list-equivalent):");
    p.levers.forEach((l, n) => L.push(`${n + 1}. ${l.title} — ≈${pctTxt(l.pct)} (${usd(l.usd)}). ${l.action}`));
  }
  L.push("", "What to do:",
    "- Open with ONE short message: the top three levers, each with its number and the exact change it means.",
    "- Apply only what he approves, here. Nothing changes before he says yes.",
    "- ⚙ Settings are his to flip — name the exact key. A job's model or schedule: show the change, make it only after his yes.",
    "- The numbers are list-price weights over the transcripts, not the vendor's accounting: talk in shares.",
    "- Finish with `mc outcome` naming what changed (or that he chose to change nothing).");
  return L.join("\n");
}
