/**
 * The dream pass — how one workspace's memory is kept small, fresh and true, without losing anything.
 *
 * Agents learn all day (`mc learn` → the session-learnings inbox, worklog entries, lessons, recall
 * misses). Nothing used to turn that into memory an agent actually loads: inboxes grew to 70k chars
 * that no prompt ever saw. Twice a day (src/dream.ts) one agent per active workspace — the dreamer,
 * agents/dreamer/AGENT.md — reads ONE bounded bundle and hands back ONE plan. This module owns both
 * ends, and every rule that must not depend on the model behaving:
 *
 *   dreamContext(ws)          GATHER — the bundle: the tree as it stands (with each index line's clock
 *                             and evidence), the oldest inbox chunk, the last 14 days of work, usage.
 *   preparePlan(ws, plan)     VALIDATE + PRUNE — caps, slugs, pointers, the wall, every inbox line of
 *                             the chunk decided; then the clocks (memory-tiers semantics, evidence only)
 *                             demote stale index lines to their branch and archive stale branch lines.
 *   applyPlan / undoRun       one transaction each; every run stores the snapshot that reverses it.
 *
 * Layers (caps are enforced here, never trusted to the prompt):
 *   L1  memory-index ★ ≤3000, lines ≤200     the map: critical + recent rules, `→ memory-x` pointers
 *   hot memory-hot   ★ ≤1500, lines ≤200     rebuilt every pass from the last 14 days
 *   L2  memory-<topic> / memory-repo-<repo> ≤6000   detail, pulled on demand
 *   L3  session-learnings (inbox), worklog, memory-archive — FTS only
 *
 * Nothing is lost: any line of the index or a branch that is not in the new tree is appended to
 * `memory-archive` with where it came from and why — whether the plan said so or not. Consumed inbox
 * lines go there too, as `triaged→<dest>`. The one exception is `drop-secret`, whose text is not kept
 * anywhere, including the undo snapshot.
 *
 * Reinforcement requires evidence (the stow rule): a line's clock moves only when the daemon can
 * point at a use — its branch read or recalled, a recall whose query names it, an inbox fact that
 * re-learned it. The dreamer's opinion of a line never moves its clock; only the operator pins.
 */
import { createHash } from "node:crypto";
import {
  db, notes as noteStore, repos, tickets, lessons as lessonStore, memoryUsage, memoryRelations,
  dreamRuns, memoryClocks, workspaces, activity,
} from "./store.js";
import type { DreamRun, MemoryClock, MemoryUsageRow } from "./store.js";
import { createNote, updateNote, deleteNote, appendNote } from "./notes.js";
import { guard } from "./guard.js";
import { similarity, tokens } from "./text-similarity.js";
import { daysBetween, entryHash, parseMarker, sectionPins, STALE_DAYS, today } from "./memory-tiers.js";
import {
  ARCHIVE_SLUG, BRANCH_CAP, HOT_CAP, HOT_SLUG, INBOX_SLUG, INDEX_CAP, INDEX_SLUG, LINE_CAP, topicSlug,
} from "./memory-tree.js";
import { readWorklog } from "./worklog.js";
import { usageReport } from "./memory-usage.js";
import { openConflicts } from "./memory-conflicts.js";
import type { Note, Workspace } from "./types.js";

export const HOT_DAYS = 14;
/** An index line unreinforced this long leaves the index for its branch (memory-tiers `aging`). */
export const INDEX_STALE_DAYS = STALE_DAYS.aging;
/** A branch line unreinforced this long goes to the archive. */
export const BRANCH_STALE_DAYS = 90;
export const CHUNK_CHARS = 12_000;
export const CHUNK_LINES = 120;
const RELEARN_SIM = 0.5;
const INHERIT_SIM = 0.5;
const REASON_CAP = 120;

const INDEX_SEED =
  "# Memory index\n\nOne line per rule, grouped by topic. `→ memory-x` = details in that memo (`mc memo get memory-x`).\n";
const ARCHIVE_SEED =
  "# Memory archive\n\nCold tier: everything the dream pass took out of this workspace's memory, with where it came from " +
  "and why. Never injected — `mc recall` finds it. Recovery is copy back (or `mc dream undo <run>`).\n";
const INBOX_SEED =
  "# Session learnings\n\nInbox of durable facts from agent sessions. The dream pass triages it into the memory tree twice a day.\n";

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// ───────────────────────────── reading a memo as lines ─────────────────────────────

export interface MemLine {
  raw: string;
  /** Prose only: bullet, trailing `→ memory-x` pointer and tier marker stripped. */
  text: string;
  hash: string;
  bullet: boolean;
  /** The nearest `##`-or-deeper heading above it; null under the title or none. */
  section: string | null;
  pinned: boolean;
  pointer: string | null;
}

const BULLET_RE = /^\s*[-*]\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;
const POINTER_RE = /\s*→\s*(memory-[a-z0-9-]+)\s*$/;

/**
 * Every non-empty, non-heading line of a memo. Paragraph lines count too, so an operator's prose in a
 * branch is accounted for (archived if a rewrite drops it) exactly like a bullet.
 */
export function memLines(body: string): MemLine[] {
  const out: MemLine[] = [];
  let section: string | null = null;
  let secPinned = false;
  for (const raw of (body || "").split("\n")) {
    if (!raw.trim()) continue;
    const h = HEADING_RE.exec(raw.trim());
    if (h) {
      section = h[1].length >= 2 ? h[2] : null;
      secPinned = !!section && sectionPins(section);
      continue;
    }
    const b = BULLET_RE.exec(raw);
    let prose = (b ? b[1] : raw).trim();
    const m = parseMarker(prose);
    if (m) prose = m.text.trim();
    const p = POINTER_RE.exec(prose);
    if (p) prose = prose.slice(0, p.index).trim();
    out.push({ raw, text: prose, hash: entryHash(prose), bullet: !!b, section, pinned: secPinned || m?.tier === "pinned", pointer: p ? p[1] : null });
  }
  return out;
}

/** Drop `##` headings left with nothing under them (a topic whose last line moved out). */
export function dropEmptySections(body: string): string {
  const lines = body.split("\n");
  const keep = lines.map(() => true);
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING_RE.exec(lines[i].trim());
    if (!h || h[1].length < 2) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    const next = j < lines.length ? HEADING_RE.exec(lines[j].trim()) : null;
    if (j >= lines.length || (next && next[1].length <= h[1].length)) keep[i] = false;
  }
  return lines.filter((_, i) => keep[i]).join("\n").replace(/\n{3,}/g, "\n\n");
}

function removeLines(body: string, raws: Set<string>): string {
  return dropEmptySections(body.split("\n").filter((l) => !raws.has(l)).join("\n"));
}

// ───────────────────────────── the tree as it stands ─────────────────────────────

const BRANCH_SLUG_RE = /^memory-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED = new Set([INDEX_SLUG, HOT_SLUG, ARCHIVE_SLUG]);

/**
 * A branch is a workspace memo named `memory-<topic>` that belongs to the tree. Not the index, hot or
 * archive, not a stow archive (`memory-archive-<agent>`), and not a persona memory (`Memory — robert`,
 * which lives in the personal workspace under the same prefix and is never the dream pass's to touch).
 */
export function isBranch(n: Pick<Note, "slug" | "title" | "scope">): boolean {
  return BRANCH_SLUG_RE.test(n.slug) && !RESERVED.has(n.slug) && !n.slug.startsWith("memory-archive")
    && n.scope !== "global" && !/^Memory\s+—/.test(n.title);
}

export interface Tree {
  ws: Workspace;
  index: Note | undefined;
  hot: Note | undefined;
  archive: Note | undefined;
  inbox: Note | undefined;
  branches: Map<string, Note>;
  /** Every non-branch note in the workspace, by slug — a plan may not overwrite one. */
  others: Set<string>;
}

export function loadTree(ws: Workspace): Tree {
  const all = noteStore.list(ws.id);
  const bySlug = (s: string) => all.find((n) => n.slug === s && n.scope !== "global");
  const branches = new Map(all.filter(isBranch).map((n) => [n.slug, n] as const));
  const others = new Set(all.filter((n) => !isBranch(n)).map((n) => n.slug));
  return { ws, index: bySlug(INDEX_SLUG), hot: bySlug(HOT_SLUG), archive: bySlug(ARCHIVE_SLUG), inbox: bySlug(INBOX_SLUG), branches, others };
}

export interface InboxLine { id: string; text: string; from: string | null }

/** The inbox's bullets, oldest first (captureLearnings appends at the bottom), one per distinct fact. */
export function inboxLines(body: string | undefined): InboxLine[] {
  const seen = new Set<string>();
  const out: InboxLine[] = [];
  for (const l of memLines(body ?? "")) {
    if (!l.bullet || !l.text || seen.has(l.hash)) continue;
    seen.add(l.hash);
    out.push({ id: l.hash, text: l.text, from: l.section });
  }
  return out;
}

/** The oldest slice of the inbox that fits the budget. The rest waits for the next pass — and the bundle says so. */
export function inboxChunk(lines: InboxLine[], chars = CHUNK_CHARS, max = CHUNK_LINES): InboxLine[] {
  const out: InboxLine[] = [];
  let used = 0;
  for (const l of lines) {
    if (out.length >= max || (out.length && used + l.text.length > chars)) break;
    out.push(l);
    used += l.text.length;
  }
  return out;
}

// ───────────────────────────── evidence + clocks ─────────────────────────────

/** Usage rows since `sinceDay` (YYYY-MM-DD) grouped by the note they touched. */
function usageByNote(rows: MemoryUsageRow[]): Map<string, MemoryUsageRow[]> {
  const m = new Map<string, MemoryUsageRow[]>();
  for (const r of rows) {
    if (r.ref_kind !== "note" || !r.ref) continue;
    (m.get(r.ref) ?? m.set(r.ref, []).get(r.ref)!).push(r);
  }
  return m;
}

/** A recall that hit the index and whose query names this line: ≥2 shared tokens, or all of a 1-token query. */
export function queryNames(query: string, line: string): boolean {
  const q = tokens(query);
  if (!q.size) return false;
  const l = tokens(line);
  let shared = 0;
  for (const t of q) if (l.has(t)) shared++;
  return shared >= Math.min(2, q.size);
}

export interface Evidence {
  /** note id → usage rows (window already applied by the caller). */
  usage: Map<string, MemoryUsageRow[]>;
  indexId: string | null;
  branchId: (slug: string) => string | null;
  /** Inbox facts this plan consumed (not secrets) — re-learning is evidence. */
  relearned: string[];
  /** Line hashes the plan claims were re-learned, already checked against consumed inbox ids. */
  claimed: Set<string>;
}

/** Did anything use this line since its clock's date? `where` is `memory-index` or the branch slug it lives in. */
export function reinforcedBy(line: MemLine, where: string, since: string, ev: Evidence): string | null {
  const after = (rows: MemoryUsageRow[] | undefined) => (rows ?? []).filter((r) => r.ts.slice(0, 10) >= since);
  if (ev.claimed.has(line.hash)) return "re-learned";
  if (ev.relearned.some((t) => similarity(t, line.text) >= RELEARN_SIM)) return "re-learned";
  if (where === INDEX_SLUG) {
    const target = line.pointer ? ev.branchId(line.pointer) : null;
    if (target && after(ev.usage.get(target)).length) return `${line.pointer} read`;
    const hits = after(ev.usage.get(ev.indexId ?? "")).filter((r) => r.kind === "recall_hit" && r.query && queryNames(r.query, line.text));
    return hits.length ? "recalled" : null;
  }
  const id = ev.branchId(where);
  return id && after(ev.usage.get(id)).length ? `${where} read` : null;
}

/**
 * A line's clock: its own if it has one; else inherited from the most similar line of the tree as it
 * stood (a reworded or merged rule keeps its age — rewording must not be a way to reset it); else today.
 */
export function clockFor(line: MemLine, clocks: Map<string, MemoryClock>, prior: MemLine[], day: string): { reinforced: string; first_seen: string } {
  const own = clocks.get(line.hash);
  if (own) return { reinforced: own.reinforced, first_seen: own.first_seen };
  let best: MemoryClock | undefined;
  let score = 0;
  for (const p of prior) {
    const c = clocks.get(p.hash);
    if (!c) continue;
    const s = similarity(p.text, line.text);
    if (s >= INHERIT_SIM && s > score) { best = c; score = s; }
  }
  return best ? { reinforced: best.reinforced, first_seen: best.first_seen } : { reinforced: day, first_seen: day };
}

// ───────────────────────────── GATHER ─────────────────────────────

export interface DreamBundle {
  run: string;
  workspace: { slug: string; name: string };
  today: string;
  last_dream: string | null;
  caps: { index: number; hot: number; branch: number; line: number; index_stale_days: number; branch_stale_days: number };
  index: {
    chars: number;
    body: string;
    lines: { hash: string; section: string | null; text: string; pointer: string | null; pinned: boolean; days_unreinforced: number | null; uses_30d: number }[];
  };
  hot: { chars: number; body: string };
  branches: { slug: string; chars: number; lines: number; repo: string | null; uses_30d: number; last_used: string | null; stale_soon: number }[];
  repos: string[];
  inbox: { total_lines: number; total_chars: number; shown: number; left_after_this_pass: number; lines: InboxLine[] };
  worklog: { at: string; what: string; outcome: string; pending: string[]; next: string[]; pr: string | null; ticket: string | null }[];
  sessions: { status: string; title: string | null; goal: string | null; done: boolean; summary: string | null; at: string }[];
  tickets: { key: string; title: string; status: string; pr: string | null; updated: string }[];
  lessons: { id: string; topic: string; rule: string; hits: number; last_fired: string | null; new: boolean }[];
  usage: { recalls_14d: number; top: { label: string | null; kind: string; count: number; last_used: string }[]; misses: { query: string; count: number }[] };
  conflicts: { id: string; a: string; b: string }[];
}

const repoSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function openRun(ws: Workspace, runId?: string | null): DreamRun {
  if (runId) {
    const r = dreamRuns.get(runId);
    // The wall: a run id from another workspace is "not found", same as one that never existed.
    if (!r || r.workspace_id !== ws.id) throw new DreamError(404, "dream run not found");
    if (r.status !== "dispatched" && r.status !== "gathered") throw new DreamError(409, `dream run ${r.id.slice(0, 8)} is ${r.status}`);
    return r;
  }
  return dreamRuns.open(ws.id)[0] ?? dreamRuns.create({ workspace_id: ws.id, source: "followup" });
}

export class DreamError extends Error {
  constructor(public status: number, message: string, public problems: string[] = []) { super(message); }
}

export function dreamContext(ws: Workspace, runId?: string | null, now = new Date()): DreamBundle {
  const run = openRun(ws, runId);
  const tree = loadTree(ws);
  const day = today(now);
  const d14 = new Date(now.getTime() - HOT_DAYS * 86_400_000).toISOString();
  const d30 = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const clocks = memoryClocks.map(ws.id);
  const usage = usageByNote(memoryUsage.list(ws.id, d30));
  const uses = (id: string | undefined) => (id ? usage.get(id)?.length ?? 0 : 0);
  const lastUse = (id: string) => usage.get(id)?.reduce((m, r) => (r.ts > m ? r.ts : m), "") || null;

  const indexLines = memLines(tree.index?.body ?? "").filter((l) => l.bullet).map((l) => {
    const c = clocks.get(l.hash);
    const pointed = l.pointer ? tree.branches.get(l.pointer)?.id : undefined;
    const recalled = (usage.get(tree.index?.id ?? "") ?? []).filter((r) => r.kind === "recall_hit" && r.query && queryNames(r.query, l.text)).length;
    return {
      hash: l.hash, section: l.section, text: l.text, pointer: l.pointer, pinned: l.pinned,
      days_unreinforced: c ? daysBetween(c.reinforced, now) : null, uses_30d: uses(pointed) + recalled,
    };
  });

  const wsRepos = repos.list(ws.id);
  const branches = [...tree.branches.values()].map((b) => {
    const repo = b.slug.startsWith("memory-repo-") ? wsRepos.find((r) => `memory-repo-${repoSlug(r.name)}` === b.slug)?.name ?? null : null;
    const bl = memLines(b.body).filter((l) => l.bullet);
    const staleSoon = bl.filter((l) => { const c = clocks.get(l.hash); return !l.pinned && c && daysBetween(c.reinforced, now) >= BRANCH_STALE_DAYS - 14; }).length;
    return { slug: b.slug, chars: b.body.length, lines: bl.length, repo, uses_30d: uses(b.id), last_used: lastUse(b.id), stale_soon: staleSoon };
  }).sort((a, b) => b.uses_30d - a.uses_30d || a.slug.localeCompare(b.slug));

  const allInbox = inboxLines(tree.inbox?.body);
  const chunk = inboxChunk(allInbox);
  const since = dreamRuns.lastFinished(ws.id);

  const worklog = readWorklog(ws.id, 40).filter((w) => w.at >= d14.slice(0, 10)).slice(0, 30).map((w) => ({
    at: w.at, what: w.what, outcome: w.outcome, pending: w.pending, next: w.next, pr: w.pr ?? null, ticket: w.ticket ?? null,
  }));
  const sess = db.prepare(
    `SELECT status, title, goal, goal_done_at, summary, created_at, ended_at FROM sessions
     WHERE workspace_id=? AND (status='live' OR ended_at >= ?) ORDER BY COALESCE(ended_at, created_at) DESC LIMIT 30`,
  ).all(ws.id, d14) as { status: string; title: string | null; goal: string | null; goal_done_at: string | null; summary: string | null; created_at: string; ended_at: string | null }[];
  const inFlight = new Set(["spec", "ready", "planning", "planned", "in_progress", "review", "shipping", "blocked"]);
  const tix = tickets.list({ workspace_id: ws.id })
    .filter((t) => inFlight.has(t.status) || (t.status === "done" && t.updated_at >= d14))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 25);
  const les = lessonStore.list({ workspace_id: ws.id, state: "active" }).slice(0, 30);
  const rep = usageReport(ws.id, d14, now.getTime());

  const bundle: DreamBundle = {
    run: run.id,
    workspace: { slug: ws.slug, name: ws.name },
    today: day,
    last_dream: since,
    caps: { index: INDEX_CAP, hot: HOT_CAP, branch: BRANCH_CAP, line: LINE_CAP, index_stale_days: INDEX_STALE_DAYS, branch_stale_days: BRANCH_STALE_DAYS },
    index: { chars: tree.index?.body.length ?? 0, body: tree.index?.body ?? "", lines: indexLines },
    hot: { chars: tree.hot?.body.length ?? 0, body: tree.hot?.body ?? "" },
    branches,
    repos: wsRepos.map((r) => `memory-repo-${repoSlug(r.name)}`),
    inbox: {
      total_lines: allInbox.length,
      total_chars: allInbox.reduce((a, l) => a + l.text.length, 0),
      shown: chunk.length,
      left_after_this_pass: allInbox.length - chunk.length,
      lines: chunk,
    },
    worklog,
    sessions: sess.map((s) => ({
      status: s.status, title: s.title, goal: s.goal, done: !!s.goal_done_at,
      summary: s.summary ? clip(s.summary, 300) : null, at: (s.ended_at ?? s.created_at).slice(0, 16),
    })),
    tickets: tix.map((t) => ({ key: t.key, title: t.title, status: t.status, pr: t.pr_url, updated: t.updated_at.slice(0, 10) })),
    lessons: les.map((l) => ({ id: l.id.slice(0, 8), topic: l.topic, rule: clip(l.rule, 200), hits: l.hits, last_fired: l.last_fired, new: !!since && l.created_at > since })),
    usage: {
      recalls_14d: rep.recalls,
      top: rep.refs.slice(0, 20).map((r) => ({ label: r.label, kind: r.ref_kind, count: r.count, last_used: r.last_used.slice(0, 10) })),
      misses: rep.misses.slice(0, 15).map((m) => ({ query: m.query, count: m.count })),
    },
    conflicts: openConflicts(ws.id, 5).map((c) => ({ id: c.id.slice(0, 8), a: c.source_text, b: c.target_text })),
  };
  dreamRuns.patch(run.id, { status: "gathered", gathered_at: now.toISOString(), chunk: JSON.stringify(chunk.map((l) => l.id)) });
  // Workspace-authored text going into a model's context: one guard pass over the serialized bundle
  // would mangle JSON, so guard the free-text bodies that can carry an injection.
  bundle.index.body = guard(bundle.index.body, "dream-bundle index", ws.id);
  bundle.hot.body = guard(bundle.hot.body, "dream-bundle hot", ws.id);
  for (const l of bundle.inbox.lines) l.text = guard(l.text, "dream-bundle inbox", ws.id);
  return bundle;
}

/** One branch body for the dreamer — deliberately NOT `mc memo get`, which would count as a use. */
export function dreamBranch(ws: Workspace, slug: string): string {
  const n = noteStore.bySlug(ws.id, slug);
  if (!n || !isBranch(n)) throw new DreamError(404, `no branch ${slug} in this workspace`);
  return guard(n.body, `dream-branch ${slug}`, ws.id);
}

// ───────────────────────────── the plan ─────────────────────────────

export interface InboxDecision { id: string; to: string; with?: string; why?: string }
export interface DreamPlan {
  run: string;
  /** Full new body of memory-index; omitted = unchanged. */
  index?: string;
  /** Full new body of memory-hot — required: every pass rebuilds it. */
  hot: string;
  /** slug → full new body, or null to retire the branch (its lines go to the archive). */
  branches?: Record<string, string | null>;
  inbox?: InboxDecision[];
  reinforce?: { hash: string; by: string }[];
  archive?: { hash: string; reason: string }[];
  note?: string;
}

export interface ArchiveEntry { text: string; from: string; reason: string }

export interface DreamStats {
  rules_before: number;
  rules_after: number;
  rules_added: number;
  demoted: number;
  archived: number;
  inbox_triaged: number;
  inbox_left: number;
  hot_items: number;
  branches_written: string[];
  branches_retired: string[];
  reinforced: number;
  conflicts: number;
}

interface NoteWrite { slug: string; title: string; body: string | null; context: boolean; repo_ids?: string[] | null }

export interface Prepared {
  run: DreamRun;
  writes: NoteWrite[];
  inboxBody: string | null;
  consumed: InboxLine[];
  secrets: Set<string>;
  archive: ArchiveEntry[];
  clocks: { hash: string; reinforced: string; first_seen: string }[];
  conflicts: { inbox: InboxLine; target: MemLine; why: string | null }[];
  stats: DreamStats;
  receipt: string;
}

const DEST_FIXED = new Set(["drop", "drop-secret", "index", "hot", "conflict"]);

function titleFor(slug: string): string {
  if (slug === INDEX_SLUG) return "Memory index";
  if (slug === HOT_SLUG) return "Memory hot";
  if (slug === ARCHIVE_SLUG) return "Memory archive";
  return `Memory: ${slug.slice("memory-".length).replace(/-/g, " ")}`;
}

/**
 * Check a plan against the tree as it stands and work out every write it implies — without writing.
 * Throws DreamError: 400 for a malformed plan, 409 for one that only breaks a cap (the fix is to
 * condense), each with every problem found, so one round-trip fixes all of them.
 */
export function preparePlan(ws: Workspace, plan: DreamPlan, now = new Date()): Prepared {
  const invalid: string[] = [];
  const caps: string[] = [];
  if (!plan || typeof plan !== "object") throw new DreamError(400, "plan must be a JSON object");
  const run = dreamRuns.get(String(plan.run ?? ""));
  if (!run || run.workspace_id !== ws.id) throw new DreamError(404, "dream run not found — run `mc dream context` first and pass its `run`");
  if (run.status !== "gathered") throw new DreamError(409, `dream run ${run.id.slice(0, 8)} is ${run.status}${run.status === "dispatched" ? " — run `mc dream context` first" : ""}`);

  const tree = loadTree(ws);
  const day = today(now);
  const wsRepos = repos.list(ws.id);

  // ── bodies: guard first, then check what will actually be stored ──
  const guardBody = (slug: string, body: string) => guard(String(body).replace(/\r\n/g, "\n").trim() + "\n", `dream ${slug}`, ws.id);
  if (typeof plan.hot !== "string") invalid.push("hot is required: rebuild memory-hot from the last 14 days (an empty string clears it)");
  const newIndex = plan.index == null ? tree.index?.body ?? null : guardBody(INDEX_SLUG, plan.index);
  const newHot = typeof plan.hot === "string" ? guardBody(HOT_SLUG, plan.hot) : tree.hot?.body ?? "";
  const branchPlan = plan.branches ?? {};
  if (typeof branchPlan !== "object" || Array.isArray(branchPlan)) invalid.push("branches must be an object of slug → body|null");
  const newBranches = new Map<string, string>([...tree.branches].map(([s, n]) => [s, n.body]));
  const retired: string[] = [];
  const written: string[] = [];
  const repoIds = new Map<string, string>();
  for (const [slug, body] of Object.entries(branchPlan)) {
    if (!BRANCH_SLUG_RE.test(slug) || slug.length > 60 || RESERVED.has(slug) || slug.startsWith("memory-archive")) {
      invalid.push(`branches: "${slug}" is not a branch slug (memory-<topic>, lowercase, ≤60 chars; not index/hot/archive)`);
      continue;
    }
    if (tree.others.has(slug)) { invalid.push(`branches: ${slug} is an existing memo outside the memory tree — pick another slug`); continue; }
    if (slug.startsWith("memory-repo-")) {
      const repo = wsRepos.find((r) => `memory-repo-${repoSlug(r.name)}` === slug);
      if (!repo) { invalid.push(`branches: ${slug} names no repo of this workspace (have: ${wsRepos.map((r) => `memory-repo-${repoSlug(r.name)}`).join(", ") || "none"})`); continue; }
      repoIds.set(slug, repo.id);
    }
    if (body === null) {
      if (!tree.branches.has(slug)) invalid.push(`branches: cannot retire ${slug} — it does not exist`);
      else { newBranches.delete(slug); retired.push(slug); }
      continue;
    }
    if (typeof body !== "string") { invalid.push(`branches: ${slug} must be a string body or null`); continue; }
    newBranches.set(slug, guardBody(slug, body));
    written.push(slug);
  }

  // ── caps + shape ──
  if (newIndex && newIndex.length > INDEX_CAP) caps.push(`memory-index is ${newIndex.length}/${INDEX_CAP} chars — merge or drop lines, or move detail into branches`);
  if (newHot.length > HOT_CAP) caps.push(`memory-hot is ${newHot.length}/${HOT_CAP} chars — fewer threads, one line each`);
  for (const s of written) {
    const len = newBranches.get(s)!.length;
    if (len > BRANCH_CAP) caps.push(`${s} is ${len}/${BRANCH_CAP} chars — condense it, or split a topic into its own branch`);
  }
  const idxLines = memLines(newIndex ?? "");
  for (const l of idxLines) {
    if (l.bullet && !l.section) invalid.push(`memory-index: every rule goes under a "## Topic" heading — "${clip(l.text, 60)}" has none`);
    if (l.bullet && l.text.length > LINE_CAP) caps.push(`memory-index line is ${l.text.length}/${LINE_CAP} chars — "${clip(l.text, 60)}": keep the rule, move the rest to its branch`);
    if (l.pointer && !newBranches.has(l.pointer)) invalid.push(`memory-index points at ${l.pointer}, which ${retired.includes(l.pointer) ? "this plan retires" : "does not exist"}`);
  }
  for (const l of memLines(newHot)) {
    if (l.bullet && l.text.length > LINE_CAP) caps.push(`memory-hot line is ${l.text.length}/${LINE_CAP} chars — "${clip(l.text, 60)}"`);
  }

  // ── pinned lines are the operator's: the dreamer keeps them, verbatim, and adds none ──
  const oldIdx = memLines(tree.index?.body ?? "");
  const pinnedOld = new Set(oldIdx.filter((l) => l.pinned && l.bullet).map((l) => l.hash));
  const pinnedNew = new Set(idxLines.filter((l) => l.pinned && l.bullet).map((l) => l.hash));
  for (const h of pinnedOld) if (!pinnedNew.has(h)) invalid.push(`memory-index: pinned line "${clip(oldIdx.find((l) => l.hash === h)!.text, 60)}" must stay as it is — only the operator unpins`);
  for (const h of pinnedNew) if (!pinnedOld.has(h)) invalid.push(`memory-index: "${clip(idxLines.find((l) => l.hash === h)!.text, 60)}" is new under Pinned — only the operator pins`);

  // ── inbox: every line the bundle showed must be decided, exactly once ──
  const inbox = inboxLines(tree.inbox?.body);
  const inboxById = new Map(inbox.map((l) => [l.id, l]));
  const chunk = new Set<string>(JSON.parse(run.chunk ?? "[]"));
  const decided = new Map<string, InboxDecision>();
  const oldTreeLines = [...oldIdx, ...[...tree.branches.values()].flatMap((b) => memLines(b.body))];
  const oldByHash = new Map(oldTreeLines.map((l) => [l.hash, l]));
  for (const d of plan.inbox ?? []) {
    if (!d || typeof d.id !== "string" || typeof d.to !== "string") { invalid.push("inbox: each decision is {id, to, with?, why?}"); continue; }
    if (decided.has(d.id)) { invalid.push(`inbox: ${d.id} decided twice`); continue; }
    if (!inboxById.has(d.id)) { if (!chunk.has(d.id)) invalid.push(`inbox: ${d.id} is not a line of the inbox`); continue; }
    if (!DEST_FIXED.has(d.to) && !newBranches.has(d.to)) invalid.push(`inbox: ${d.id} → "${d.to}" is not drop|drop-secret|index|hot|conflict or a branch of the new tree`);
    if (d.to === "conflict" && !(d.with && oldByHash.has(d.with))) invalid.push(`inbox: ${d.id} → conflict needs "with": the hash of the index/branch line it contradicts`);
    decided.set(d.id, d);
  }
  const undecided = [...chunk].filter((id) => inboxById.has(id) && !decided.has(id));
  if (undecided.length) invalid.push(`inbox: ${undecided.length} line(s) of this pass's chunk are undecided (${undecided.slice(0, 5).join(", ")}${undecided.length > 5 ? ", …" : ""}) — every one needs a destination, drop included`);

  const consumed = [...decided.values()].map((d) => inboxById.get(d.id)!);
  const secrets = new Set([...decided.values()].filter((d) => d.to === "drop-secret").map((d) => d.id));
  const relearned = consumed.filter((l) => !secrets.has(l.id)).map((l) => l.text);

  // ── reinforce claims must be backed by an inbox fact this plan consumed ──
  const claimed = new Set<string>();
  for (const r of plan.reinforce ?? []) {
    const d = r && decided.get(r.by);
    if (!d || d.to === "drop-secret") invalid.push(`reinforce: ${r?.hash} — "by" must be an inbox id this plan consumes (the fact that re-learned it)`);
    else claimed.add(r.hash);
  }
  const reasons = new Map<string, string>();
  for (const a of plan.archive ?? []) {
    if (!a || !oldByHash.has(a.hash)) { invalid.push(`archive: ${a?.hash} is not a line of the current index or branches`); continue; }
    reasons.set(a.hash, clip(String(a.reason ?? "removed"), REASON_CAP));
  }
  if (plan.note != null && String(plan.note).length > 200) caps.push(`note is ${String(plan.note).length}/200 chars`);

  if (invalid.length) throw new DreamError(400, invalid.join("\n"), [...invalid, ...caps]);
  if (caps.length) throw new DreamError(409, caps.join("\n"), caps);

  // ── PRUNE: clocks, evidence, demotion, archive ──
  const clocks = memoryClocks.map(ws.id);
  const oldest = new Date(now.getTime() - BRANCH_STALE_DAYS * 86_400_000).toISOString();
  const branchIdOf = (slug: string) => tree.branches.get(slug)?.id ?? null;
  const ev: Evidence = { usage: usageByNote(memoryUsage.list(ws.id, oldest)), indexId: tree.index?.id ?? null, branchId: branchIdOf, relearned, claimed };

  const archive: ArchiveEntry[] = [];
  const nextClocks = new Map<string, { hash: string; reinforced: string; first_seen: string }>();
  let reinforced = 0;
  let demoted = 0;
  const stamp = (l: MemLine, where: string) => {
    const done = nextClocks.get(l.hash);
    if (done) return done;
    const c = clockFor(l, clocks, oldTreeLines, day);
    if (!l.pinned && c.reinforced !== day && reinforcedBy(l, where, c.reinforced, ev)) { c.reinforced = day; reinforced++; }
    const row = { hash: l.hash, ...c };
    nextClocks.set(l.hash, row);
    return row;
  };

  let finalIndex = newIndex;
  if (finalIndex != null) {
    const drop = new Set<string>();
    for (const l of memLines(finalIndex)) {
      if (!l.bullet) continue;
      const c = stamp(l, INDEX_SLUG);
      const age = daysBetween(c.reinforced, now);
      if (l.pinned || age < INDEX_STALE_DAYS) continue;
      // Stale in the index ≠ wrong: it leaves the always-loaded map for its branch, one hop away.
      drop.add(l.raw);
      const target = l.pointer ?? topicSlug(l.section ?? "general").replace(/-+$/, "");
      const cur = newBranches.get(target);
      if (cur != null && memLines(cur).some((x) => x.hash === l.hash)) { demoted++; continue; }
      if (tree.others.has(target)) { archive.push({ text: l.text, from: INDEX_SLUG, reason: `unreinforced ${age}d` }); continue; }
      const base = cur ?? `# ${titleFor(target)}\n\nDetail behind the "${l.section ?? "General"}" lines of the memory index.\n`;
      const next = base.replace(/\n*$/, "\n") + `- ${l.text}\n`;
      if (next.length > BRANCH_CAP) { archive.push({ text: l.text, from: INDEX_SLUG, reason: `unreinforced ${age}d (${target} full)` }); continue; }
      newBranches.set(target, next);
      if (!written.includes(target)) written.push(target);
      demoted++;
    }
    if (drop.size) finalIndex = removeLines(finalIndex, drop);
  }

  for (const [slug, body] of newBranches) {
    const drop = new Set<string>();
    for (const l of memLines(body)) {
      if (!l.bullet) continue;
      const c = stamp(l, slug);
      const age = daysBetween(c.reinforced, now);
      if (!l.pinned && age >= BRANCH_STALE_DAYS) {
        drop.add(l.raw);
        archive.push({ text: l.text, from: slug, reason: `unreinforced ${age}d` });
      }
    }
    if (drop.size) {
      newBranches.set(slug, removeLines(body, drop));
      if (!written.includes(slug)) written.push(slug);
    }
  }

  // ── nothing lost: every old line that is in no part of the new tree goes to the archive ──
  const kept = new Set<string>([...memLines(finalIndex ?? ""), ...[...newBranches.values()].flatMap((b) => memLines(b))].map((l) => l.hash));
  const archivedHashes = new Set(archive.map((a) => entryHash(a.text)));
  const seen = new Set<string>();
  const addLost = (lines: MemLine[], from: string) => {
    for (const l of lines) {
      if (kept.has(l.hash) || archivedHashes.has(l.hash) || seen.has(l.hash)) continue;
      seen.add(l.hash);
      archive.push({ text: l.text, from, reason: reasons.get(l.hash) ?? (retired.includes(from) ? "branch retired" : "rewritten away") });
    }
  };
  addLost(oldIdx, INDEX_SLUG);
  for (const [slug, n] of tree.branches) addLost(memLines(n.body), slug);

  // ── consumed inbox lines: provenance into the archive, text out of the inbox ──
  for (const l of consumed) {
    const d = decided.get(l.id)!;
    const why = d.why ? ` (${clip(String(d.why), REASON_CAP)})` : "";
    const from = `${INBOX_SLUG}${l.from ? ` · ${l.from}` : ""}`;
    archive.push(secrets.has(l.id)
      ? { text: "(dropped as a secret — text not kept)", from, reason: "triaged→drop-secret" }
      : { text: l.text, from, reason: `triaged→${d.to}${why}` });
  }
  const consumedIds = new Set(consumed.map((l) => l.id));
  const inboxBody = consumed.length && tree.inbox
    ? dropEmptySections(tree.inbox.body.split("\n").filter((raw) => {
        const b = BULLET_RE.exec(raw);
        if (!b) return true;
        const m = parseMarker(b[1].trim());
        return !consumedIds.has(entryHash(m ? m.text : b[1].trim()));
      }).join("\n"))
    : null;

  const conflicts = [...decided.values()].filter((d) => d.to === "conflict")
    .map((d) => ({ inbox: inboxById.get(d.id)!, target: oldByHash.get(d.with!)!, why: d.why ? clip(String(d.why), REASON_CAP) : null }));

  // ── writes ──
  const writes: NoteWrite[] = [];
  if (finalIndex != null && finalIndex !== tree.index?.body) writes.push({ slug: INDEX_SLUG, title: titleFor(INDEX_SLUG), body: finalIndex, context: true });
  if (typeof plan.hot === "string" && newHot !== tree.hot?.body) writes.push({ slug: HOT_SLUG, title: titleFor(HOT_SLUG), body: newHot, context: true });
  for (const slug of written) {
    const body = newBranches.get(slug)!;
    if (body !== tree.branches.get(slug)?.body) writes.push({ slug, title: tree.branches.get(slug)?.title ?? titleFor(slug), body, context: false, repo_ids: repoIds.has(slug) ? [repoIds.get(slug)!] : undefined });
  }
  for (const slug of retired) writes.push({ slug, title: tree.branches.get(slug)!.title, body: null, context: false });

  const oldRules = oldIdx.filter((l) => l.bullet);
  const newRules = memLines(finalIndex ?? "").filter((l) => l.bullet);
  const oldRuleSet = new Set(oldRules.map((l) => l.hash));
  const stats: DreamStats = {
    rules_before: oldRules.length,
    rules_after: newRules.length,
    rules_added: newRules.filter((l) => !oldRuleSet.has(l.hash)).length,
    demoted,
    archived: archive.length - consumed.length,
    inbox_triaged: consumed.length,
    inbox_left: inbox.length - consumed.length,
    hot_items: memLines(newHot).filter((l) => l.bullet).length,
    branches_written: writes.filter((w) => w.body != null && w.slug !== INDEX_SLUG && w.slug !== HOT_SLUG).map((w) => w.slug),
    branches_retired: retired,
    reinforced,
    conflicts: conflicts.length,
  };
  return {
    run, writes, inboxBody, consumed, secrets, archive, clocks: [...nextClocks.values()], conflicts, stats,
    receipt: receiptLine(ws.slug, stats, plan.note),
  };
}

/** The one line the operator reads: "gfm: +3 rules, 2 demoted, 12 archived, 40 inbox triaged (360 left), hot rebuilt (6 threads)". */
export function receiptLine(slug: string, s: DreamStats, note?: string | null): string {
  const parts = [
    s.rules_added ? `+${s.rules_added} rule${s.rules_added === 1 ? "" : "s"}` : null,
    s.rules_after !== s.rules_before + s.rules_added ? `${s.rules_before}→${s.rules_after} in index` : null,
    s.demoted ? `${s.demoted} demoted` : null,
    s.archived ? `${s.archived} archived` : null,
    s.branches_written.length ? `${s.branches_written.length} branch${s.branches_written.length === 1 ? "" : "es"} written` : null,
    s.inbox_triaged ? `${s.inbox_triaged} inbox triaged${s.inbox_left ? ` (${s.inbox_left} left)` : ""}` : null,
    s.conflicts ? `${s.conflicts} conflict${s.conflicts === 1 ? "" : "s"} flagged` : null,
    `hot rebuilt (${s.hot_items} thread${s.hot_items === 1 ? "" : "s"})`,
  ].filter(Boolean);
  const tail = note ? ` — ${clip(String(note).replace(/\s+/g, " ").trim(), 200)}` : "";
  return `${slug}: ${parts.join(", ")}${tail}`;
}

// ───────────────────────────── APPLY + UNDO ─────────────────────────────

interface SnapNote { slug: string; before: { title: string; body: string; context: number; repo_ids: string[] | null } | null; after: string | null }
interface DreamSnapshot {
  notes: SnapNote[];
  inbox_restore: string[];
  archive_block: string | null;
  relations: string[];
  clocks: { hash: string; before: { reinforced: string; first_seen: string } | null }[];
}

function writeNote(ws: Workspace, w: NoteWrite, cur: Note | undefined): string | null {
  if (w.body == null) { if (cur) deleteNote(cur.id); return null; }
  if (cur) {
    const repoPatch = w.repo_ids && !cur.repo_ids ? { repo_ids: w.repo_ids } : {};
    return sha(updateNote(cur.id, { body: w.body, ...(w.context && !cur.context ? { context: true } : {}), ...repoPatch }).body);
  }
  return sha(createNote({ workspace_id: ws.id, slug: w.slug, title: w.title, body: w.body, context: w.context, repo_ids: w.repo_ids ?? null }).body);
}

function archiveBlock(run: DreamRun, entries: ArchiveEntry[], now: Date): string {
  const head = `## dream ${now.toISOString().slice(0, 16).replace("T", " ")} · run ${run.id.slice(0, 8)}`;
  return [head, ...entries.map((e) => `- ${e.text.replace(/\s+/g, " ")} — from ${e.from} · ${e.reason}`)].join("\n");
}

export interface ApplyResult { run: string; receipt: string; stats: DreamStats; dry: boolean; archived: ArchiveEntry[]; writes: { slug: string; chars: number | null }[] }

export function applyPlan(ws: Workspace, plan: DreamPlan, opts: { dry?: boolean; now?: Date } = {}): ApplyResult {
  const now = opts.now ?? new Date();
  const p = preparePlan(ws, plan, now);
  const out: ApplyResult = {
    run: p.run.id, receipt: p.receipt, stats: p.stats, dry: !!opts.dry, archived: p.archive,
    writes: p.writes.map((w) => ({ slug: w.slug, chars: w.body?.length ?? null })),
  };
  if (opts.dry) return out;

  const tree = loadTree(ws);
  const byslug = (slug: string) => noteStore.bySlug(ws.id, slug);
  const snap: DreamSnapshot = { notes: [], inbox_restore: p.consumed.filter((l) => !p.secrets.has(l.id)).map((l) => l.text), archive_block: null, relations: [], clocks: [] };
  const prevClocks = memoryClocks.map(ws.id);
  const touched = new Set<string>();

  const tx = db.transaction(() => {
    for (const w of p.writes) {
      const cur = byslug(w.slug);
      snap.notes.push({ slug: w.slug, before: cur ? { title: cur.title, body: cur.body, context: cur.context, repo_ids: cur.repo_ids ?? null } : null, after: writeNote(ws, w, cur) });
      touched.add(w.slug);
    }
    if (p.inboxBody != null && tree.inbox) updateNote(tree.inbox.id, { body: p.inboxBody });
    if (p.archive.length) {
      const block = archiveBlock(p.run, p.archive, now);
      const arc = tree.archive ?? createNote({ workspace_id: ws.id, slug: ARCHIVE_SLUG, title: titleFor(ARCHIVE_SLUG), body: ARCHIVE_SEED });
      appendNote(arc.id, block);
      snap.archive_block = block;
    }
    for (const c of p.conflicts) {
      const row = memoryRelations.record({
        workspace_id: ws.id, source_kind: "memory-line", source_ref: c.inbox.id, source_text: clip(c.inbox.text, 300),
        target_kind: "memory-line", target_ref: c.target.hash, target_text: clip(c.target.text, 300),
        relation: "conflicts_with", confidence: null, reason: c.why, judged_by: "dreamer",
      });
      if (row) snap.relations.push(row.id);
    }
    for (const c of p.clocks) {
      const before = prevClocks.get(c.hash);
      if (before && before.reinforced === c.reinforced) continue;
      snap.clocks.push({ hash: c.hash, before: before ? { reinforced: before.reinforced, first_seen: before.first_seen } : null });
      memoryClocks.set(ws.id, c.hash, c.reinforced, c.first_seen);
    }
    dreamRuns.patch(p.run.id, {
      status: "applied", finished_at: now.toISOString(), receipt: p.receipt,
      stats: JSON.stringify(p.stats), snapshot: JSON.stringify(snap),
    });
    activity.add({ topic: "memory.dream", actor: "dreamer", workspace_id: ws.id, entity: p.run.id, detail: p.receipt });
  });
  try {
    tx();
  } catch (e) {
    // The DB rolled back; the markdown mirror may not have. Rewrite each touched memo's file from its row.
    for (const slug of touched) { const n = byslug(slug); if (n) try { updateNote(n.id, { body: n.body }); } catch {} }
    throw e;
  }
  return out;
}

/**
 * Put a pass back. Only the newest applied pass of the workspace, and only while nothing it wrote has
 * been edited since — undo must never overwrite the operator's own later edit. Inbox lines come back
 * (secrets excepted), the archive block leaves, the clocks and conflict rows it wrote are reverted.
 */
export function undoRun(ws: Workspace, runId: string, now = new Date()): DreamRun {
  const run = dreamRuns.get(runId) ?? dreamRuns.list(ws.id, 50).find((r) => r.id.startsWith(runId));
  if (!run || run.workspace_id !== ws.id) throw new DreamError(404, "dream run not found");
  if (run.status !== "applied") throw new DreamError(409, `dream run ${run.id.slice(0, 8)} is ${run.status} — only an applied pass can be undone`);
  const last = dreamRuns.lastApplied(ws.id);
  if (last && last.id !== run.id) throw new DreamError(409, `undo the newer pass first (${last.id.slice(0, 8)}) — passes are undone newest first`);
  const snap = JSON.parse(run.snapshot ?? "{}") as DreamSnapshot;
  const changed: string[] = [];
  for (const s of snap.notes ?? []) {
    const cur = noteStore.bySlug(ws.id, s.slug);
    if (s.after == null ? !!cur : !cur || sha(cur.body) !== s.after) changed.push(s.slug);
  }
  if (changed.length) throw new DreamError(409, `changed since this pass: ${changed.join(", ")} — undo would overwrite those edits; fix them by hand (the old text is in the pass's snapshot)`, changed);

  db.transaction(() => {
    for (const s of snap.notes ?? []) {
      const cur = noteStore.bySlug(ws.id, s.slug);
      if (!s.before) { if (cur) deleteNote(cur.id); continue; }
      if (cur) { updateNote(cur.id, { body: s.before.body, context: !!s.before.context }); continue; }
      createNote({ workspace_id: ws.id, slug: s.slug, title: s.before.title, body: s.before.body, context: !!s.before.context, repo_ids: s.before.repo_ids });
    }
    if (snap.inbox_restore?.length) {
      const inbox = noteStore.bySlug(ws.id, INBOX_SLUG) ?? createNote({ workspace_id: ws.id, slug: INBOX_SLUG, title: "Session learnings", body: INBOX_SEED });
      appendNote(inbox.id, snap.inbox_restore.map((t) => `- ${t}`).join("\n"), `restored by undo of dream ${run.id.slice(0, 8)}`);
    }
    if (snap.archive_block) {
      const arc = noteStore.bySlug(ws.id, ARCHIVE_SLUG);
      if (arc && arc.body.includes(snap.archive_block)) updateNote(arc.id, { body: arc.body.replace("\n" + snap.archive_block, "").replace(snap.archive_block, "") });
    }
    for (const id of snap.relations ?? []) memoryRelations.remove(id);
    for (const c of snap.clocks ?? []) {
      if (c.before) memoryClocks.set(ws.id, c.hash, c.before.reinforced, c.before.first_seen);
      else memoryClocks.remove(ws.id, c.hash);
    }
    dreamRuns.patch(run.id, { status: "undone", undone_at: now.toISOString() });
    activity.add({ topic: "memory.dream.undo", actor: "operator", workspace_id: ws.id, entity: run.id, detail: `undid: ${run.receipt ?? ""}` });
  })();
  return dreamRuns.get(run.id)!;
}

/** Recent passes for the Desk / `mc dream runs` — never the snapshot (it holds whole memo bodies). */
export function publicRun(r: DreamRun) {
  const { snapshot: _s, chunk: _c, ...rest } = r;
  return { ...rest, stats: r.stats ? (JSON.parse(r.stats) as DreamStats) : null };
}

export function workspaceOf(idOrSlug: string): Workspace | undefined {
  return workspaces.get(idOrSlug) ?? workspaces.getBySlug(idOrSlug);
}
