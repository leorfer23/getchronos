/**
 * The worklog — every finished piece of work, written down twice.
 *
 * Robert's problem was that a terminal closing was the end of the record: the transcript went cold,
 * the session summary was for search, and the only place "what has been worked on and what is
 * pending" existed was in whatever chat the operator happened to have open. So he reconstructed it
 * from conversation, badly, every time he was asked.
 *
 * Now each finished terminal (a desk session that HAD a goal) and each finished build run produces
 * one structured entry — what the work was, how it ended, what it left unfinished, what the worker
 * itself said should come next — and that entry lands in two places:
 *
 *   notes/<ws>/worklog.md   the full ledger, one dated block per entry, newest at the BOTTOM. History.
 *                           FTS-searchable like any note, never injected whole.
 *   the brief               ONE line under "## Recently" (capped, oldest roll off into the ledger) and
 *                           the leftovers as "- [ ]" items under "## Next" — deduped, and ticked when a
 *                           later entry turns out to BE that follow-up. This is what reaches his prompt.
 *
 * Idempotent by source id (`run:<id>` / `session:<id>`, claimed in kv before the summarizer runs), so
 * a replayed bus event, a restart, or `mc worklog backfill` can never double-append.
 */
import { CONFIG } from "./config.js";
import { bus, type BusEvent } from "./bus.js";
import { events, jobs, kv, notes as notesStore, runs, sessions, tickets, workspaces } from "./store.js";
import { appendNote, createNote } from "./notes.js";
import { briefNote, mergeNext, mergeRecently, rewriteBrief } from "./briefs.js";
import { oneShotText, stripAnsi } from "./summarize.js";
import { isReadOnlyRun } from "./runner.js";
import { storyFromEvents } from "./run-story.js";
import type { Note, Run, Session, Workspace } from "./types.js";

export const WORKLOG_SLUG = "worklog";
const WORKLOG_TITLE = "Worklog";
const MAX_ITEMS = 5;     // pending/next lists per entry — a finished piece of work owes a handful, not a backlog
const MAX_LINE = 240;
const TAIL_LINES = 200;  // of the run's own output, per the summarizer's input budget

export interface WorklogEntry {
  what: string;
  outcome: string;
  pending: string[];
  next: string[];
  pr?: string | null;
  ticket?: string | null;
}
/** A parsed ledger block: an entry plus the minute it was written. */
export interface WorklogRow extends WorklogEntry {
  at: string;
}

// ───────────────────────────── entry shape ─────────────────────────────

// "·" is the ledger's field separator, so it can never survive inside a field.
const oneLine = (v: unknown, cap = MAX_LINE): string =>
  String(v ?? "").replace(/[\r\n]+/g, " ").replace(/·/g, "-").replace(/\s+/g, " ").trim().slice(0, cap);

const itemList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [])
    .map((x) => oneLine(x))
    .filter((x) => x.length > 2)
    .slice(0, MAX_ITEMS);

/**
 * Validate what the model returned. `what` and `outcome` are the entry — without both there is
 * nothing to write. Empty pending/next are fine and are the common case.
 */
export function parseEntry(raw: unknown): WorklogEntry | null {
  const j = typeof raw === "string" ? jsonFrom(raw) : raw;
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const what = oneLine(o.what);
  const outcome = oneLine(o.outcome);
  if (!what || !outcome) return null;
  const pr = oneLine(o.pr, 400);
  const ticket = oneLine(o.ticket, 32).toUpperCase();
  return {
    what,
    outcome,
    pending: itemList(o.pending),
    next: itemList(o.next),
    pr: /^https?:\/\/\S+$/.test(pr) ? pr : null,
    ticket: /^[A-Z][A-Z0-9]*-\d+$/.test(ticket) ? ticket : null,
  };
}

function jsonFrom(s: string): unknown {
  const m = String(s ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ───────────────────────────── the ledger ─────────────────────────────

const stamp = (d: Date): string => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** One dated block: the headline, then whatever it left behind. */
export function entryBlock(e: WorklogEntry, at: string): string {
  const head = [`### ${at}`, e.what, e.outcome, e.pr ? `PR ${e.pr}` : null, e.ticket]
    .filter(Boolean)
    .join(" · ");
  return [head, ...e.pending.map((p) => `- pending: ${p}`), ...e.next.map((n) => `- next: ${n}`)].join("\n");
}

/** The ledger read back as structured entries, newest FIRST (the file is newest-last). */
export function parseWorklog(body: string, limit = 50): WorklogRow[] {
  const rows: WorklogRow[] = [];
  let cur: WorklogRow | null = null;
  for (const line of (body || "").split("\n")) {
    const head = line.match(/^###\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*·\s*(.*)$/);
    if (head) {
      const parts = head[2].split(" · ").map((p) => p.trim());
      const pr = parts.find((p) => /^PR https?:\/\//.test(p));
      const ticket = parts.find((p) => /^[A-Z][A-Z0-9]*-\d+$/.test(p));
      cur = {
        at: head[1],
        what: parts[0] ?? "",
        outcome: parts[1] && parts[1] !== pr && parts[1] !== ticket ? parts[1] : "",
        pending: [],
        next: [],
        pr: pr ? pr.slice(3) : null,
        ticket: ticket ?? null,
      };
      rows.push(cur);
      continue;
    }
    if (!cur) continue;
    const pending = line.match(/^-\s*pending:\s*(.+)$/);
    if (pending) cur.pending.push(pending[1].trim());
    const next = line.match(/^-\s*next:\s*(.+)$/);
    if (next) cur.next.push(next[1].trim());
  }
  return rows.reverse().slice(0, limit);
}

export function worklogNote(workspace_id: string, create = true): Note | null {
  const ws = workspaces.get(workspace_id);
  if (!ws) return null;
  const existing = notesStore.bySlug(ws.id, WORKLOG_SLUG);
  if (existing || !create) return existing ?? null;
  return createNote({
    workspace_id: ws.id,
    title: WORKLOG_TITLE,
    body:
      `# ${WORKLOG_TITLE}\n\n` +
      `Every finished terminal and build in this workspace, newest last. Written by the daemon ` +
      `(src/worklog.ts) as work ends; the brief's Recently/Next are the short view of it.\n`,
  });
}

export function readWorklog(workspace_id: string, limit = 50): WorklogRow[] {
  const n = worklogNote(workspace_id, false);
  return n ? parseWorklog(n.body, limit) : [];
}

/**
 * The two writes. Ledger first (history is the thing we must not lose), then the brief's two living
 * sections — every other heading on that page is the operator's prose and is left exactly as it is.
 */
export function writeEntry(workspace_id: string, e: WorklogEntry, when = new Date()): WorklogRow {
  const at = stamp(when);
  const note = worklogNote(workspace_id);
  if (!note) throw new Error("workspace not found");
  appendNote(note.id, entryBlock(e, at));

  const brief = briefNote(workspace_id);
  if (brief) {
    let body = mergeRecently(brief.body, `${at.slice(0, 10)} · ${e.what} · ${e.outcome}`);
    const open = [...e.pending, ...e.next];
    body = mergeNext(body, open, { what: e.what, date: at.slice(0, 10), ticket: e.ticket ?? null });
    rewriteBrief(workspace_id, body);
  }
  return { ...e, at };
}

// ───────────────────────────── idempotency ─────────────────────────────

const srcKey = (source: string) => `worklog:${source}`;

export function logged(source: string): boolean {
  return kv.get(srcKey(source)) !== undefined;
}

/** Claim a source BEFORE summarizing (better-sqlite3 is synchronous, so this closes the race). */
function claim(source: string): boolean {
  if (logged(source)) return false;
  kv.set(srcKey(source), `pending ${new Date().toISOString()}`);
  return true;
}
function release(source: string): void {
  kv.del(srcKey(source));
}

// ───────────────────────────── the summarizer ─────────────────────────────

export type Ask = (prompt: string) => Promise<string | null>;

export interface WorklogInput {
  /** The goal/ticket title — what the operator asked for, in their words. */
  asked: string;
  /** done | failed | killed | … as it reached us. */
  status: string;
  transcript: string;
  pr?: string | null;
  ticket?: string | null;
  cost?: { turns?: number | null; usd?: number | null };
  /** When set, skip the LLM and write this entry (session digest already summarized the work). */
  ready?: WorklogEntry;
}

const outcomeLine = (status: string): string =>
  status === "success" || status === "done"
    ? "finished"
    : status === "killed"
      ? "stopped before finishing"
      : `ended ${status}`;

/** The entry we write when the model is unreachable: the facts we already hold, no invention. */
export function fallbackEntry(input: WorklogInput): WorklogEntry {
  return {
    what: oneLine(input.asked) || "unnamed work",
    outcome: outcomeLine(input.status),
    pending: [],
    next: [],
    pr: input.pr ?? null,
    ticket: input.ticket ?? null,
  };
}

export async function summarizeWork(input: WorklogInput, ask: Ask): Promise<WorklogEntry> {
  const t = stripAnsi(input.transcript || "").trim().slice(-7000);
  if (t.length < 40) return fallbackEntry(input);
  const cost = input.cost?.turns || input.cost?.usd
    ? `Cost: ${input.cost.turns ?? "?"} turns, $${(input.cost.usd ?? 0).toFixed(2)}.`
    : "";
  const out = await ask(
    `You are Robert, chief of staff, recording ONE finished piece of work in the workspace ledger. ` +
      `Return ONLY compact JSON {"what":"...","outcome":"...","pending":[],"next":[]}:\n` +
      `- "what": one line, what this work WAS in the operator's own words (not the agent's process).\n` +
      `- "outcome": one line — "shipped X" / "failed because Y" / "stopped at Z". Be concrete.\n` +
      `- "pending": what THIS piece of work left unfinished. [] when it finished cleanly.\n` +
      `- "next": follow-ups the worker itself named ("should also…", "TODO", "later we need…"). ` +
      `Only ones actually said — [] is the expected answer for both lists, and both being empty is common.\n` +
      `Max ${MAX_ITEMS} short items each, under ${MAX_LINE} chars. No invention: if the transcript does not say it, leave it out.\n\n` +
      `Asked for: ${input.asked || "(no goal recorded)"}\n` +
      `How it ended: ${input.status}. ${cost}\n` +
      (input.ticket ? `Ticket: ${input.ticket}\n` : "") +
      (input.pr ? `PR: ${input.pr}\n` : "") +
      `\nWhat happened:\n${t}`,
  );
  const parsed = out ? parseEntry(out) : null;
  if (!parsed) return fallbackEntry(input);
  // The PR and ticket are facts we hold; never let the model's guess replace them.
  return { ...parsed, pr: input.pr ?? parsed.pr ?? null, ticket: input.ticket ?? parsed.ticket ?? null };
}

function askFor(ws: Workspace | null): Ask {
  const configDir = ws?.config_dir ?? CONFIG.profiles[CONFIG.defaultProfile] ?? CONFIG.profiles.claude ?? "";
  return (prompt) => oneShotText(prompt, configDir, ws, 25_000, CONFIG.worklogModel || null, "worklog");
}

// ───────────────────────────── what counts as finished work ─────────────────────────────

/**
 * A desk terminal earns a ledger entry when it was opened to DO something (a goal, typed at spawn or
 * sharpened later). A goal-less chat shell is a scratchpad, and a two-minute terminal with no output
 * is a mistyped command.
 */
export function shouldLogSession(
  s: Pick<Session, "goal" | "spawn_goal" | "workspace_id" | "turns"> & { created_at?: string; ended_at?: string | null },
  opts: { feedLen?: number; now?: number } = {},
): boolean {
  if (!s.workspace_id) return false;
  if (!(s.goal || s.spawn_goal)) return false;
  const started = s.created_at ? Date.parse(s.created_at) : NaN;
  const ended = s.ended_at ? Date.parse(s.ended_at) : (opts.now ?? Date.now());
  const sec = Number.isFinite(started) ? (ended - started) / 1000 : Infinity;
  const produced = (s.turns ?? 0) > 0 || (opts.feedLen ?? 0) >= 2;
  return sec >= CONFIG.worklogMinSessionSec || produced;
}

// The statuses that mean "this attempt reached an end nothing else will resume". `paused` is parked on
// an ask, `rate_limited` retries itself, and `interrupted` belongs to the recovery card (src/recovery.ts) —
// logging those as finished work would put a half-done piece in the ledger and then log it twice.
const ENDED = new Set(["success", "failed", "timeout", "killed", "blocked"]);

/** Builds and jobs are work; read-only passes and the ledger's own summarizers are not. */
export function shouldLogRun(jobName: string | null | undefined, status: string): boolean {
  if (isReadOnlyRun(jobName)) return false;
  if (/^(?:fallback:)?worklog:/.test(jobName ?? "")) return false;
  return ENDED.has(status);
}

// ───────────────────────────── recording ─────────────────────────────

async function record(source: string, workspace_id: string, input: WorklogInput, ask?: Ask): Promise<WorklogRow | null> {
  if (!claim(source)) return null;
  let entry: WorklogEntry;
  try {
    // Prefer a session digest already on the row — another haiku pass over the same transcript is
    // the closeout tax we are killing. Heads-up: the digest writes a search sentence, not the
    // worklog's what/outcome/pending shape, so we only skip when the caller handed us a ready entry.
    if (input.ready) {
      entry = input.ready;
    } else {
      entry = await summarizeWork(input, ask ?? askFor(workspaces.get(workspace_id) ?? null));
    }
  } catch (e) {
    release(source); // nothing was written — leave it backfillable
    console.error("[worklog] summarize", source, e);
    return null;
  }
  try {
    const row = writeEntry(workspace_id, entry);
    kv.set(srcKey(source), new Date().toISOString());
    return row;
  } catch (e) {
    // A half-written entry KEEPS its claim: re-running would append the ledger block twice, and a
    // duplicated history is worse than one lost line.
    console.error("[worklog] write", source, e);
    return null;
  }
}

export async function recordSession(sessionId: string, ask?: Ask): Promise<WorklogRow | null> {
  const s = sessions.get(sessionId);
  if (!s || !s.workspace_id) return null;
  if (!(s.goal || s.spawn_goal)) return null; // a goal-less chat shell: don't even read its transcript
  // Late import: terminal.ts owns the live pty map and pulls in half the daemon; a static import here
  // would put worklog.ts in that cycle for the sake of one transcript read.
  const { digestText, digestClaimed } = await import("./terminal.js");
  let transcript = "";
  try { transcript = digestText(sessionId, s.summary ?? ""); } catch {}
  if (!shouldLogSession(s, { feedLen: transcript.split("\n").length })) return null;
  const t = s.ticket_id ? tickets.get(s.ticket_id) : undefined;
  const base = {
    asked: s.spawn_goal || s.goal || s.title || "",
    status: s.goal_done_at ? "done" : "ended",
    transcript: transcript || s.summary || "",
    pr: t?.pr_url ?? null,
    ticket: t?.key ?? null,
    cost: { turns: s.turns, usd: s.cost_usd },
  };
  // Exit digest owns the narrative LLM for this session (claimed sync before the model returns).
  // Reuse its summary when present; otherwise write facts-only — never a second haiku over the same feed.
  const ready = s.summary
    ? {
        what: oneLine(s.spawn_goal || s.goal || s.title || "") || "unnamed work",
        outcome: s.summary.slice(0, 200),
        pending: [] as string[],
        next: [] as string[],
        pr: t?.pr_url ?? null,
        ticket: t?.key ?? null,
      }
    : digestClaimed(sessionId)
      ? fallbackEntry(base)
      : undefined;
  return record(`session:${sessionId}`, s.workspace_id, { ...base, ready }, ask);
}

export async function recordRun(runId: string, ask?: Ask): Promise<WorklogRow | null> {
  const run = runs.get(runId);
  if (!run) return null;
  const job = jobs.get(run.job_id);
  if (!job?.workspace_id || !shouldLogRun(job.name, run.status)) return null;
  const t = job.ticket_id ? tickets.get(job.ticket_id) : undefined;
  return record(`run:${runId}`, job.workspace_id, {
    asked: t ? `${t.key} ${t.title}` : job.description || job.name,
    status: run.status,
    transcript: runTranscript(run),
    pr: t?.pr_url ?? null,
    ticket: t?.key ?? null,
    cost: { turns: run.num_turns, usd: run.cost_usd },
  }, ask);
}

/** The run's own story (same feed the Desk shows), its output tail, and whatever it said at the end. */
function runTranscript(run: Run): string {
  let story: string[] = [];
  try {
    story = storyFromEvents(events.list(run.id)).slice(-60).map((e) => `[${e.kind}] ${e.text}`);
  } catch {}
  let tail: string[] = [];
  try { tail = events.tailLines(run.id, 30); } catch {}
  return [story.join("\n"), tail.slice(-TAIL_LINES).join("\n"), run.summary ? `Result: ${run.summary}` : null, run.error ? `Error: ${run.error}` : null]
    .filter(Boolean)
    .join("\n\n");
}

// ───────────────────────────── backfill ─────────────────────────────

/**
 * Summarize work that ended before the ledger existed, so day one is not an empty page. Idempotent
 * (every source is kv-claimed) and never automatic: one `mc worklog backfill` spends real model calls.
 */
export async function backfill(
  workspace_id: string,
  sinceIso: string,
  opts: { ask?: Ask; limit?: number } = {},
): Promise<{ scanned: number; added: number }> {
  const limit = opts.limit ?? 40;
  let scanned = 0;
  let added = 0;
  const after = (iso?: string | null) => !!iso && iso >= sinceIso;

  for (const s of sessions.list({ workspace_id, status: "ended", limit: 400 })) {
    if (added >= limit) break;
    if (!after(s.ended_at) || logged(`session:${s.id}`)) continue;
    scanned++;
    if (await recordSession(s.id, opts.ask)) added++;
  }
  for (const r of runs.list(undefined, 600)) {
    if (added >= limit) break;
    if (!after(r.ended_at) || logged(`run:${r.id}`)) continue;
    if (jobs.get(r.job_id)?.workspace_id !== workspace_id) continue;
    scanned++;
    if (await recordRun(r.id, opts.ask)) added++;
  }
  return { scanned, added };
}

/** "7d" / "36h" / an ISO date → ISO timestamp. */
export function sinceIso(spec: string, now = new Date()): string {
  const m = String(spec ?? "").trim().match(/^(\d+)\s*([dhw])$/i);
  if (m) {
    const n = Number(m[1]);
    const ms = m[2].toLowerCase() === "h" ? 3600e3 : m[2].toLowerCase() === "w" ? 7 * 864e5 : 864e5;
    return new Date(now.getTime() - n * ms).toISOString();
  }
  const d = new Date(spec);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return new Date(now.getTime() - 7 * 864e5).toISOString();
}

// ───────────────────────────── wiring ─────────────────────────────

export function startWorklog(): void {
  if (!CONFIG.worklog) return;
  bus.on("event", (e: BusEvent) => {
    // Session teardown publishes session.ended synchronously; the summarizer is fire-and-forget so a
    // slow model can never hold up a closing pty.
    if (e.topic === "session.ended") void recordSession(e.session_id).catch(() => {});
    if (e.topic === "run.ended") void recordRun(e.run_id).catch(() => {});
  });
  console.log("[worklog] finished terminals and builds land in each workspace's ledger + Robert's brief");
}
