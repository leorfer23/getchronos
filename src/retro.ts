/**
 * When the weekly self-retro runs, and the one job per workspace it may dispatch (src/retro-pass.ts
 * holds what is read and written).
 *
 * A weekly slot (Monday 08:00 local unless CHRONOS_RETRO_DAY / CHRONOS_RETRO_HOUR say otherwise),
 * caught up like the dream slot: the latest slot whose time has passed is due until something marks
 * it, so a Mac asleep on Monday morning runs it when it wakes — once, not a backlog. It waits until
 * the brain has been awake a few minutes (a dark wake is not the moment to start a job), and for the
 * network when the caller can tell; the slot is only marked once it actually starts.
 *
 * Per workspace, never one job for several: the numbers are gathered by code here, and only when the
 * operator's own words turned up something to make a rule of does a `retro:<slug>` job run — on that
 * workspace's own Claude profile (runner.ts: ws.config_dir), read-only, writing only through `mc retro
 * apply` into pending proposals. Nothing reaches memory before his tap.
 *
 * The product workspace (the one holding Chronos's own checkout, else the oldest personal one) goes
 * last: its job also gets every workspace's findings summed — enum → count, nothing else — and may
 * draft up to three improvement proposals for the operator to approve. That sum is the ONLY flow from
 * one workspace to another in this feature.
 */
import path from "node:path";
import { db, jobs, repos, runs, workspaces } from "./store.js";
import { retroRuns, type RetroRun, type RetroSource } from "./store/retro.js";
import { settingOn } from "./settings.js";
import { dispatch } from "./dispatcher.js";
import { agentDef, agentPrompt } from "./agent-defs.js";
import { brainAwakeSince } from "./brain-awake.js";
import { kv } from "./store/kv.js";
import { REPO_ROOT } from "./repo-root.js";
import { esc, notifyInfo } from "./telegram/api.js";
import { retroProposals } from "./store/retro.js";
import { aggregateFindings, gatherRetro, type GatherDeps, type RetroStats } from "./retro-pass.js";
import type { Workspace } from "./types.js";

export const RETRO_KV = "retro.slot";
const pad = (n: number) => String(n).padStart(2, "0");
const envInt = (v: string | undefined, d: number, lo: number, hi: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : d;
};
export const RETRO_DAY = envInt(process.env.CHRONOS_RETRO_DAY, 1, 0, 6); // 0 = Sunday … 6 = Saturday
export const RETRO_HOUR = envInt(process.env.CHRONOS_RETRO_HOUR, 8, 0, 23);
/** A wake this fresh is not the moment: the network may still be coming up, or it is a dark wake. */
export const AWAKE_MIN_MS = 10 * 60_000;
/** An open run younger than this whose job is still queued/running blocks a second start. */
const OPEN_RUN_HOURS = 3;

/** The latest weekly slot at or before `now`, keyed `YYYY-MM-DD@HH` on local calendar fields (DST-safe). */
export function weeklySlot(now: Date, day = RETRO_DAY, hour = RETRO_HOUR): string {
  let back = (now.getDay() - day + 7) % 7;
  if (back === 0 && now.getHours() < hour) back = 7;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}@${pad(hour)}`;
}

/** A slot key → the moment it stands for (local). */
export function slotTime(slot: string): Date {
  const [y, m, d] = slot.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d, Number(slot.slice(11, 13)) || 0);
}

/** The week a run reads: the seven days before its slot (or before now, run by hand). */
export function weekBefore(end: Date): { since: string; until: string } {
  const since = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 7, end.getHours(), end.getMinutes(), end.getSeconds());
  return { since: since.toISOString(), until: end.toISOString() };
}

export function dueWeekly(now = new Date(), get: (k: string) => string | undefined = kv.get): string | null {
  const slot = weeklySlot(now);
  const last = get(RETRO_KV);
  return last && last >= slot ? null : slot;
}

/** Where cross-workspace counts are summed: the workspace that owns Chronos's own checkout, else the oldest personal one. */
export function productWorkspace(list: Workspace[] = workspaces.list()): Workspace | null {
  const same = (a: string, b: string) => path.resolve(a) === path.resolve(b);
  const owner = list.find((w) => repos.list(w.id).some((r) => !!r.path && same(r.path, REPO_ROOT)));
  if (owner) return owner;
  return list.filter((w) => w.kind === "personal").sort((a, b) => a.created_at.localeCompare(b.created_at))[0] ?? null;
}

/**
 * Every workspace's findings near this week, summed. Reads the `findings` column and nothing else —
 * enum → count by construction, re-validated key by key in aggregateFindings.
 */
export function aggregateNear(until: string): { workspaces: number; counts: Record<string, number> } {
  const lo = new Date(Date.parse(until) - 36 * 3600_000).toISOString();
  const hi = new Date(Date.parse(until) + 36 * 3600_000).toISOString();
  const rows = db.prepare(
    `SELECT r.workspace_id, r.findings FROM retro_runs r JOIN workspaces w ON w.id = r.workspace_id
     WHERE w.archived = 0 AND r.findings IS NOT NULL AND r.until >= ? AND r.until <= ?
     ORDER BY r.until DESC, r.created_at DESC`,
  ).all(lo, hi) as { workspace_id: string; findings: string }[];
  const seen = new Set<string>();
  const list: unknown[] = [];
  for (const r of rows) {
    if (seen.has(r.workspace_id)) continue;
    seen.add(r.workspace_id);
    try { list.push(JSON.parse(r.findings)); } catch {}
  }
  return aggregateFindings(list);
}

export function retroGoal(ws: Workspace, run: RetroRun, product: boolean): string {
  return (
    `Weekly self-retro for workspace "${ws.name}" (run ${run.id}). Start with \`mc retro context --run ${run.id}\`, ` +
    `turn the operator's corrections and repeated asks into at most 5 one-line rules (each citing the candidate ids it answers), ` +
    `write the week's notes${product ? `, and draft up to 3 improvement proposals for Chronos from the cross-workspace counts in \`product\`` : ""}, ` +
    `then \`mc retro apply\` exactly as your instructions say. Read-only: nothing reaches memory until the operator approves on the Desk.`
  );
}

/** Is a run for this workspace already under way (its job queued or running)? */
export function retroInFlight(workspace_id: string, now = new Date()): boolean {
  for (const r of retroRuns.open(workspace_id)) {
    const young = now.getTime() - Date.parse(r.created_at) < OPEN_RUN_HOURS * 3_600_000;
    if (young && r.status === "gathering") return true;
    if (young && r.run_id && ["queued", "running"].includes(runs.get(r.run_id)?.status ?? "")) return true;
  }
  return false;
}

export type StartResult = { workspace: string; run?: string; job_run?: string; skipped?: string; error?: string };

/**
 * Gather one workspace's week now, then — only when there is something for a model to judge — dispatch
 * its job. The run row and its numbers exist before any dispatch, so a job that fails still leaves the
 * week's KPIs on the Desk. dispatch() executes synchronously (CLAUDE.md #1): everything the job needs
 * is in its goal; only our own bookkeeping is patched on after.
 */
export async function startRetro(
  ws: Workspace,
  o: { source: RetroSource; slot?: string | null; now?: Date; product?: boolean; dispatch?: typeof dispatch; gather?: GatherDeps } = { source: "manual" },
): Promise<StartResult> {
  const now = o.now ?? new Date();
  if (retroInFlight(ws.id, now)) return { workspace: ws.slug, skipped: "a retro is already running" };
  for (const r of retroRuns.open(ws.id)) retroRuns.patch(r.id, { status: "abandoned", finished_at: now.toISOString() });
  const { since, until } = weekBefore(o.slot ? slotTime(o.slot) : now);
  let run = retroRuns.create({ workspace_id: ws.id, source: o.source, slot: o.slot ?? null, since, until });
  try {
    run = await gatherRetro(ws, run.id, o.gather);
  } catch (e: any) {
    retroRuns.patch(run.id, { status: "failed", error: String(e?.message ?? e).slice(0, 300), finished_at: new Date().toISOString() });
    return { workspace: ws.slug, run: run.id, error: String(e?.message ?? e) };
  }
  const sum = o.product ? aggregateNear(until) : null;
  if (sum) retroRuns.patch(run.id, { aggregate: JSON.stringify(sum) });
  const candidates = JSON.parse(run.candidates ?? "[]") as unknown[];
  // The product step runs whenever any workspace counted anything; a silent week everywhere needs no model.
  if (!candidates.length && !(sum && Object.keys(sum.counts).length)) {
    retroRuns.patch(run.id, { status: "applied", finished_at: new Date().toISOString() });
    return { workspace: ws.slug, run: run.id, skipped: "nothing for a model to judge — numbers only" };
  }
  const def = agentDef("retro");
  const job = jobs.create({
    name: `retro:${ws.slug}`,
    description: `Weekly self-retro — ${ws.name}${o.slot ? ` (${o.slot})` : ""}`,
    goal: retroGoal(ws, run, !!o.product),
    append_system: agentPrompt("retro"),
    workspace_id: ws.id,
    // The workspace's own Claude profile (runner.ts resolves ws.config_dir), on its default model:
    // these rules go into every prompt there, so judging them is not a job for the cheapest model.
    backend: "claude-code",
    model: null,
    cwd: ws.default_dir || repos.list(ws.id)[0]?.path || REPO_ROOT,
    sandbox: ws.sandbox_mode,
    allowed_tools: def.tools,
    disallowed_tools: "Edit,Write,MultiEdit,NotebookEdit",
    trigger_type: "manual",
    retry_max: 0, // next week's run reads the same evidence again
    timeout_sec: 900,
    notify: "failures",
  });
  retroRuns.patch(run.id, { job_id: job.id });
  const d = (o.dispatch ?? dispatch)(job.id, `retro:${ws.slug}`);
  if ("error" in d) {
    // The numbers stand; only this week's rules from his words are lost.
    retroRuns.patch(run.id, { error: d.error });
    return { workspace: ws.slug, run: run.id, error: d.error };
  }
  retroRuns.patch(run.id, { status: "dispatched", run_id: d.run_id });
  return { workspace: ws.slug, run: run.id, job_run: d.run_id };
}

/** Every workspace with the retro on, the product workspace last (its sum needs the others' findings). */
export async function retroAll(source: RetroSource, slot: string | null, now = new Date(), o: { dispatch?: typeof dispatch; gather?: GatherDeps } = {}): Promise<StartResult[]> {
  const on = workspaces.list().filter((w) => settingOn("retro.weekly", w.id));
  const prod = productWorkspace();
  const out: StartResult[] = [];
  for (const ws of [...on.filter((w) => w.id !== prod?.id), ...on.filter((w) => w.id === prod?.id)]) {
    try { out.push(await startRetro(ws, { source, slot, now, product: ws.id === prod?.id, ...o })); }
    catch (e: any) { out.push({ workspace: ws.slug, error: e?.message ?? String(e) }); }
  }
  return out;
}

/**
 * The one line he gets for the week: which workspaces have rules waiting on him and which approved rules
 * are not holding — names and counts, on his own board / phone (the only send there is: a DM to him).
 * Null when nothing waits.
 */
export function weeklyLine(list: Workspace[] = workspaces.list()): string | null {
  const parts: string[] = [];
  let waiting = 0, failing = 0;
  for (const ws of list) {
    if (!settingOn("retro.weekly", ws.id)) continue;
    const p = retroProposals.list(ws.id, { status: "pending" }).length;
    const latest = retroRuns.latest(ws.id);
    const f = latest?.stats ? (JSON.parse(latest.stats) as RetroStats).rules_failed.length : 0;
    if (!p && !f) continue;
    waiting += p;
    failing += f;
    parts.push(`${esc(ws.name)} ${p}${f ? ` (${f} not holding)` : ""}`);
  }
  if (!parts.length) return null;
  return `🔁 <b>Weekly retro</b> · ${waiting} rule${waiting === 1 ? "" : "s"} wait on you${failing ? `, ${failing} not holding` : ""}: ${parts.join(", ")} — Desk → Fleet board → Weekly retro`;
}

let running = false;
/** The week's line waits for the jobs (≤15 min each) to file their rules, so it counts them. */
export const LINE_DELAY_MS = 20 * 60_000;
export type RetroTickDeps = {
  now?: Date; awakeSince?: (nowMs: number) => number; network?: () => Promise<boolean>; all?: typeof retroAll;
  notify?: (text: string) => Promise<unknown> | void; lineDelayMs?: number;
};

/** Monitor tick: the weekly slot, caught up after sleep, once the Mac has been awake a while and the network answers. */
export async function maybeRetro(d: RetroTickDeps = {}): Promise<string | null> {
  if (running) return null;
  const now = d.now ?? new Date();
  const slot = dueWeekly(now);
  if (!slot) return null;
  if (now.getTime() - (d.awakeSince ?? brainAwakeSince)(now.getTime()) < AWAKE_MIN_MS) return null;
  if (d.network && !(await d.network())) return null;
  kv.set(RETRO_KV, slot); // before the work: a slot that throws is not retried every tick
  running = true;
  try {
    const out = await (d.all ?? retroAll)("slot", slot, now);
    if (out.length) console.log(`[retro] ${slot}: ${out.map((r) => `${r.workspace} ${r.error ? "✗ " + r.error : r.skipped ? "· " + r.skipped : "→ " + r.run?.slice(0, 8)}`).join(", ")}`);
    const send = async () => {
      const line = weeklyLine();
      if (line) await Promise.resolve((d.notify ?? ((t: string) => notifyInfo(t)))(line)).catch(() => {});
    };
    const delay = d.lineDelayMs ?? LINE_DELAY_MS;
    if (delay <= 0) await send();
    else setTimeout(() => void send(), delay).unref?.();
  } finally {
    running = false;
  }
  return slot;
}
