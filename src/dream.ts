import { CONFIG } from "./config.js";
import { db, dreamRuns, jobs, kv, notes, repos, runs, workspaces } from "./store.js";
import type { DreamSource } from "./store.js";
import { dispatch } from "./dispatcher.js";
import { agentDef, agentPrompt } from "./agent-defs.js";
import { inboxLines } from "./dream-pass.js";
import { INBOX_SLUG } from "./memory-tree.js";
import { WORKLOG_SLUG } from "./worklog.js";
import { REPO_ROOT } from "./repo-root.js";
import type { Workspace } from "./types.js";

// The dream slot: the moments of the day when memory maintenance runs, after the operator's work
// blocks instead of during them. A slot is a local date + hour, keyed `YYYY-MM-DD@HH`.
//
// Catch-up, not a clock match: the laptop sleeps through slots, and the old `hour === digestHour`
// gates simply never fired. The most recent slot whose time has passed is due until something marks
// it, so a Mac that wakes at 15:40 runs the 13:00 pass then. Only that latest slot — two slots
// missed over a weekend are one pass, not a backlog. The mark lives in kv, so a restart does not
// rerun a slot it already ran.
//
// All arithmetic is on local calendar fields (getFullYear/getMonth/getDate/getHours), never on
// ms offsets, so a 23- or 25-hour DST day cannot shift or skip a slot.

const pad = (n: number) => String(n).padStart(2, "0");

export function slotKey(day: Date, hour: number): string {
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}@${pad(hour)}`;
}

/** The latest slot at or before `now`, or null when there are no slot hours (off). */
export function latestSlot(now: Date, hours: number[]): string | null {
  if (!hours.length) return null;
  const today = hours.filter((h) => h <= now.getHours());
  if (today.length) return slotKey(now, Math.max(...today));
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return slotKey(yesterday, Math.max(...hours));
}

/**
 * The slot the caller named by `kvKey` should run now, or null. Keys are zero-padded so they sort as
 * strings; a stored key at or after the latest slot (already ran, or the clock went backwards) holds.
 */
export function dueSlot(
  kvKey: string,
  now = new Date(),
  hours = CONFIG.dreamHours,
  get: (k: string) => string | undefined = kv.get,
): string | null {
  const slot = latestSlot(now, hours);
  if (!slot) return null;
  const last = get(kvKey);
  return last && last >= slot ? null : slot;
}

/** Record that `kvKey` ran `slot`. Mark before the work, so a pass that throws is not retried every tick. */
export function markSlot(kvKey: string, slot: string, set: (k: string, v: string) => void = kv.set): void {
  set(kvKey, slot);
}

/** The local calendar day of a slot key, as a Date at local midnight. */
export function slotDay(slot: string): Date {
  const [y, m, d] = slot.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

// ───────────────────────────── the pass, per workspace ─────────────────────────────
//
// At each slot, ONE job per workspace that has had activity since its last pass (src/dream-pass.ts
// holds what the job does). Never one job for several workspaces: the workspace wall is a security
// boundary, so each dreamer runs on its own workspace's Claude profile (runner.ts: ws.config_dir),
// sees only its own memory, and writes only through `mc` → the API, where every cap is enforced.

export const DREAM_KV = "dream.slot";
/** An open pass younger than this whose job is still queued/running blocks a second dispatch. */
const OPEN_RUN_HOURS = 3;

export interface ActivitySignals {
  inbox_lines: number;
  worklog_changed: boolean;
  sessions_ended: number;
  lessons_new: number;
  usage_rows: number;
}

/**
 * Anything to dream about? A backlog in the inbox always counts (a 70k inbox drains a chunk per pass
 * even on a quiet day); everything else only counts when it is newer than the last pass.
 */
export function isActive(s: ActivitySignals): boolean {
  return s.inbox_lines > 0 || s.worklog_changed || s.sessions_ended > 0 || s.lessons_new > 0 || s.usage_rows > 0;
}

export function activitySignals(ws: Pick<Workspace, "id">, since: string | null): ActivitySignals {
  const from = since ?? "";
  const n = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  const worklog = notes.bySlug(ws.id, WORKLOG_SLUG);
  return {
    inbox_lines: inboxLines(notes.bySlug(ws.id, INBOX_SLUG)?.body).length,
    worklog_changed: !!worklog && worklog.updated_at > from,
    sessions_ended: n("SELECT COUNT(*) n FROM sessions WHERE workspace_id=? AND ended_at > ?", ws.id, from),
    lessons_new: n("SELECT COUNT(*) n FROM lessons WHERE workspace_id=? AND created_at > ?", ws.id, from),
    usage_rows: n("SELECT COUNT(*) n FROM memory_usage WHERE workspace_id=? AND ts > ?", ws.id, from),
  };
}

/** Is a pass for this workspace already under way (its job queued or running)? */
export function passInFlight(workspace_id: string, now = new Date()): boolean {
  for (const r of dreamRuns.open(workspace_id)) {
    const young = now.getTime() - Date.parse(r.created_at) < OPEN_RUN_HOURS * 3_600_000;
    const live = r.run_id ? ["queued", "running"].includes(runs.get(r.run_id)?.status ?? "") : false;
    if (young && live) return true;
  }
  return false;
}

export type StartResult = { workspace: string; run?: string; job_run?: string; skipped?: string; error?: string };

/**
 * Dispatch one dream job for one workspace, now. The run row goes first so the job's goal can name
 * it; dispatch() executes synchronously (CLAUDE.md #1), so nothing the executor needs is patched on
 * afterwards — only our own bookkeeping (dream_runs.run_id).
 */
export function startDream(
  ws: Workspace,
  opts: { source: DreamSource; slot?: string | null; now?: Date; dispatch?: typeof dispatch },
): StartResult {
  const now = opts.now ?? new Date();
  if (passInFlight(ws.id, now)) return { workspace: ws.slug, skipped: "a pass is already running" };
  // Anything still open belonged to a job that ended without applying — this pass supersedes it.
  for (const r of dreamRuns.open(ws.id)) dreamRuns.patch(r.id, { status: "abandoned", finished_at: now.toISOString() });
  const run = dreamRuns.create({ workspace_id: ws.id, source: opts.source, slot: opts.slot ?? null });
  const def = agentDef("dreamer");
  const job = jobs.create({
    name: `dream:${ws.slug}`,
    description: `Dream pass — ${ws.name}${opts.slot ? ` (${opts.slot})` : ""}`,
    goal:
      `Dream pass for workspace "${ws.name}" (run ${run.id}). ` +
      `Start with \`mc dream context --run ${run.id}\`, then triage, prune, rank, rebuild hot and apply ` +
      `with \`mc dream apply\` exactly as your instructions say. Read-only on code; memory changes only through mc.`,
    append_system: agentPrompt("dreamer"),
    workspace_id: ws.id,
    // The workspace's own Claude profile (runner.ts resolves ws.config_dir), on its DEFAULT model:
    // judging what is worth remembering is the whole job, not a text merge — never pinned to haiku.
    backend: "claude-code",
    model: null,
    cwd: ws.default_dir || repos.list(ws.id)[0]?.path || REPO_ROOT,
    sandbox: ws.sandbox_mode,
    allowed_tools: def.tools,
    disallowed_tools: "Edit,Write,MultiEdit,NotebookEdit",
    trigger_type: "manual",
    retry_max: 0, // a failed pass is retried at the next slot anyway — the activity it missed still counts
    timeout_sec: 1800,
    notify: "failures",
  });
  dreamRuns.patch(run.id, { job_id: job.id });
  const d = (opts.dispatch ?? dispatch)(job.id, `dream:${ws.slug}`);
  if ("error" in d) {
    dreamRuns.patch(run.id, { status: "failed", error: d.error, finished_at: new Date().toISOString() });
    return { workspace: ws.slug, run: run.id, error: d.error };
  }
  dreamRuns.patch(run.id, { run_id: d.run_id });
  return { workspace: ws.slug, run: run.id, job_run: d.run_id };
}

/** Which workspaces a slot dreams for — pure over the signals, so the selection is testable. */
export function pickActive<W extends Pick<Workspace, "id">>(list: W[], signals: (ws: W) => ActivitySignals): W[] {
  return list.filter((ws) => isActive(signals(ws)));
}

/** One pass per active workspace, now — a slot's body, and `POST /api/dream/run` with no workspace. */
export function dreamAll(source: DreamSource, slot: string | null, now = new Date()): StartResult[] {
  const out: StartResult[] = [];
  for (const ws of pickActive(workspaces.list(), (w) => activitySignals(w, dreamRuns.lastFinished(w.id)))) {
    try { out.push(startDream(ws, { source, slot, now })); }
    catch (e: any) { out.push({ workspace: ws.slug, error: e?.message ?? String(e) }); }
  }
  return out;
}

/** Monitor tick: at each dream slot (13:00, 22:00; caught up after sleep), dream every active workspace. */
export async function maybeDream(): Promise<void> {
  const slot = dueSlot(DREAM_KV);
  if (!slot) return;
  markSlot(DREAM_KV, slot);
  const out = dreamAll("slot", slot);
  if (out.length) {
    const line = out.map((r) => `${r.workspace} ${r.error ? "✗ " + r.error : r.skipped ? "· " + r.skipped : "→ " + r.run?.slice(0, 8)}`);
    console.log(`[dream] ${slot}: ${line.join(", ")}`);
  }
}
