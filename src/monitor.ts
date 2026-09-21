import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import { usageSnapshot } from "./usage-meter.js";
import { CONFIG } from "./config.js";
import { isClosedTicketStatus, type Workspace } from "./types.js";
import { db, runs, sessions, tickets, reviews, workspaces, activity, events, searchIndex, egressLog, steps, messages, jobs, asks, kv, ideas } from "./store.js";
import { buildReport } from "./report.js";
import { notify } from "./telegram.js";
import { notifyInfo } from "./telegram/api.js";
import { esc } from "./telegram/api.js";
import { kb, type Btn } from "./telegram/keyboards.js";
import { maybeHygiene, reapEphemeralJobs } from "./hygiene.js";
import { maybeExpireIdeas, maybeMineIdeas } from "./ideas.js";
import { pollDeliveries } from "./delivery.js";
import { reapDoneWorktrees } from "./worktrees.js";
import { sweepStalls } from "./recovery.js";
import { sweepHolds } from "./holds.js";
import { holdBucket } from "./hold-bucket.js";
import { declaredWait, hasRecentWrite, lastTerminalOutputMs, stallVerdict, walkableCheckout } from "./liveness.js";
import { bus } from "./bus.js";
import { reportAgentState } from "./agent-lifecycle.js";
import { checkSupervision } from "./supervision-guard.js";
import { REPO_ROOT, inRepo } from "./repo-root.js";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const todayStr = () => new Date().toISOString().slice(0, 10);

// Debounce: alert once per id, and budget/digest/backup once per day.
const alerted = new Set<string>();
let budgetAlertDay = "";
let lastDigestDay = "";
let lastWeeklyReportDay = "";
let lastBackupDay = "";
let lastDeliveryPollMs = 0;
let lastHeartbeatMs = 0;
let lastHeartbeatWarnHour = -1;
let lastRetentionSweepMs = 0;

function wsName(id: string) {
  return id ? workspaces.get(id)?.name ?? id.slice(0, 6) : "unscoped";
}

// One observability sweep: stuck runs, abandoned sessions, budget breach.
async function sweep() {
  // 1) Stuck runs — 'running' well past a sane horizon (looping / hung).
  for (const r of runs.runningSince(hoursAgo(CONFIG.stuckRunHours))) {
    const key = "run:" + r.id;
    if (alerted.has(key)) continue;
    alerted.add(key);
    await notify(`⚠️ <b>Stuck run</b> <code>${r.id.slice(0, 8)}</code> running &gt;${CONFIG.stuckRunHours}h — /logs ${r.id.slice(0, 8)} · /stop ${r.id.slice(0, 8)}`).catch(() => {});
  }
  // 2) Abandoned live terminals — a human/agent left one open for hours.
  for (const s of sessions.list({ status: "live" })) {
    if (s.created_at >= hoursAgo(CONFIG.stuckSessionHours)) continue;
    const key = "sess:" + s.id;
    if (alerted.has(key)) continue;
    alerted.add(key);
    await notifyInfo(`💤 <b>Idle terminal</b> ${wsName(s.workspace_id || "")} · “${s.title || s.ticket_key || "chat"}” open &gt;${CONFIG.stuckSessionHours}h — /killsession ${s.id.slice(0, 8)}`).catch(() => {});
  }
  // 3) Budget — warn at 80%, alarm at 100% (once/day).
  const spent = runs.spentTodayUsd();
  const cap = CONFIG.dailyBudgetUsd;
  if (cap > 0 && budgetAlertDay !== todayStr()) {
    if (spent >= cap) { budgetAlertDay = todayStr(); await notify(`🛑 <b>Daily budget hit</b> $${spent.toFixed(2)}/$${cap}. New dispatches may be blocked.`).catch(() => {}); }
    else if (spent >= cap * 0.8) { await notify(`💸 <b>Budget 80%</b> $${spent.toFixed(2)}/$${cap} today.`).catch(() => {}); }
  }
}

// Stall detector — a RUNNING run whose event stream has gone quiet too long. Pure decision, no I/O:
// nowMs/stallMinutes injected so the threshold edges are testable without wall-clock races.
// 0 stallMinutes = detector off (matches CONFIG.stallMinutes' documented 0=off).
// Quiet is only the QUESTION: what it means is stallVerdict's call (src/liveness.ts), once the sweep
// has looked for positive evidence the run is still alive.
export function isStalled(lastEventTs: string | null, startedAt: string | null, nowMs: number, stallMinutes: number): boolean {
  if (!stallMinutes) return false;
  const ref = lastEventTs ?? startedAt;
  if (!ref) return false;
  const quietMs = nowMs - Date.parse(ref);
  return Number.isFinite(quietMs) && quietMs > stallMinutes * 60_000;
}

/** Newest of the two cooperative activity records: streamed events and the declared step checklist. */
function lastActivityTs(runId: string): string | null {
  const ev = events.lastEventTs(runId);
  const st = steps.lastUpdatedAt(runId);
  if (!ev) return st;
  if (!st) return ev;
  return ev > st ? ev : st;
}

const STALL_NOTIFIED_PREFIX = "stall.notified.";
const STALL_ESCALATIONS_PREFIX = "stall.escalations.";
const STALL_SURFACED_PREFIX = "stall.surfaced.";

// null → global CONFIG default; 0 → off for this workspace (same fallback shape as max_concurrent
// in dispatcher.ts). Pick<> so callers/tests can pass a bare { stall_minutes } object.
export function effectiveStallMinutes(ws: Pick<Workspace, "stall_minutes"> | null | undefined): number {
  return ws?.stall_minutes ?? CONFIG.stallMinutes;
}
export function effectiveAskRemindHours(ws: Pick<Workspace, "ask_remind_hours"> | null | undefined): number {
  return ws?.ask_remind_hours ?? CONFIG.askRemindHours;
}

// Quiet never alarms on its own: the sweep gathers positive liveness evidence and lets
// stallVerdict (src/liveness.ts) decide. No auto-kill, no auto-retry (see src/recovery.ts's header
// comment: the operator decides). Runs every monitor tick; no separate cadence knob needed, the
// tick's own CONFIG.monitorEveryMin throttle is the sweep's cadence.
export async function maybeStallSweep() {
  const now = Date.now();
  // Fetch once per sweep, not once per run — activeByWorkspace() can return many rows.
  const wsById = new Map(workspaces.list(true).map((w) => [w.id, w]));
  const verdictCfg = { inspectCount: CONFIG.stallInspectCount, pauseResurfaceMs: CONFIG.pauseResurfaceMinutes * 60_000 };
  for (const r of runs.activeByWorkspace()) {
    if (r.status !== "running") continue;
    const stallMinutes = effectiveStallMinutes(wsById.get(r.workspace_id));
    if (!stallMinutes) continue; // 0 = off, either globally or for this workspace
    const noteKey = STALL_NOTIFIED_PREFIX + r.id;
    const escKey = STALL_ESCALATIONS_PREFIX + r.id;
    const surfKey = STALL_SURFACED_PREFIX + r.id;
    try {
      const lastTs = lastActivityTs(r.id);
      const stalled = isStalled(lastTs, r.started_at, now, stallMinutes);
      const ref = lastTs ?? r.started_at;
      const quietMs = ref ? now - Date.parse(ref) : 0;

      const full = runs.get(r.id);
      const job = full ? jobs.get(full.job_id) : undefined;
      const ticket = job?.ticket_id ? tickets.get(job.ticket_id) : undefined;
      const wait = stalled ? declaredWait({ openAskQuestion: asks.openForRun(r.id)[0]?.question, ticketStatus: ticket?.status }) : null;

      // Evidence order, stopping at the first hit. pty churn is a memory read; the worktree walk is
      // filesystem I/O, so it is taken ONLY here, in the branch that was about to escalate. Both match
      // on a real checkout rather than a bare `cwd`: a repo-less job's cwd is $HOME, and every chat
      // terminal open there would otherwise read as this run's own liveness.
      const evidence = { events: !stalled, ptyChurn: false, worktreeWrite: false };
      if (stalled && !wait) {
        const checkout = walkableCheckout(job?.cwd);
        const out = lastTerminalOutputMs({ ticketId: ticket?.id ?? null, cwd: checkout });
        evidence.ptyChurn = out != null && out > now - quietMs;
        if (!evidence.ptyChurn && checkout)
          evidence.worktreeWrite = hasRecentWrite(checkout, now - quietMs, CONFIG.stallWalk, now);
      }

      const surfacedAt = Date.parse(kv.get(surfKey) ?? "");
      const v = stallVerdict({
        quietMs,
        evidence,
        escalations: Number(kv.get(escKey) ?? 0),
        declaredWait: wait?.on ?? null,
        sinceSurfacedMs: Number.isFinite(surfacedAt) ? now - surfacedAt : null,
        cfg: verdictCfg,
      });

      if (v.action === "alive") {
        if (kv.get(noteKey) || kv.get(escKey) || kv.get(surfKey)) {
          kv.del(noteKey); kv.del(escKey); kv.del(surfKey);
          reportAgentState(r.id, { state: "working", state_label: null, blocked_reason: null, demand_inspection: false });
        }
        continue;
      }

      kv.del(escKey);
      // ttl ~2x the sweep interval: a run that ends (or a sweep that stops running) lets the overlay
      // expire on its own instead of lying 'stalled' forever.
      const ttl_ms = CONFIG.monitorEveryMin * 60_000 * 2;
      if (v.action === "defer") {
        // Writing files behind a quiet stream IS working — never a 'blocked' card in the Desk's
        // needs-you column, just a label saying which evidence bought the silence.
        reportAgentState(r.id, { state: "working", state_label: v.label, blocked_reason: null, demand_inspection: false, ttl_ms });
        continue;
      }

      const label = ticket ? `${ticket.key} — ${r.job_name}` : r.job_name;
      if (v.action === "wait") {
        reportAgentState(r.id, { state: "blocked", blocked_reason: wait!.reason, state_label: v.label, demand_inspection: false, ttl_ms });
        if (!v.surface) continue;
        kv.set(surfKey, new Date(now).toISOString());
        await notifyInfo(`⏸ <b>${esc(label)}</b> ${esc(v.label!)}`).catch(() => {});
        continue;
      }

      kv.set(escKey, String(v.escalations));
      reportAgentState(r.id, {
        state: "blocked",
        blocked_reason: "stall",
        state_label: v.label,
        demand_inspection: v.demandInspection,
        ttl_ms,
      });
      if (!v.surface) continue; // keep the overlay fresh; the operator was already told

      kv.set(noteKey, "1");
      await notify(`⚠️ <b>${esc(label)}</b> ${esc(v.label!)} — check the fleet board (no auto-action taken)`).catch(() => {});
      if (ticket)
        bus.publish({
          topic: "ticket.event",
          ticket_id: ticket.id,
          workspace_id: ticket.workspace_id,
          text: `⚠️ build ${v.label} — no auto-action; check the fleet board`,
        });
    } catch (e: any) {
      console.warn("[monitor] stall sweep", r.id.slice(0, 8), e?.message ?? e);
    }
  }
}

// Pure threshold: has it been long enough since the ask was created (or last reminded) to remind
// again? nowMs/remindHours injected so the edges are testable without wall-clock races — same shape
// as isStalled above. 0 remindHours = off (matches CONFIG.askRemindHours' documented 0=off).
export function shouldRemind(createdAt: string, lastRemindedAt: string | null, nowMs: number, remindHours: number): boolean {
  if (!remindHours) return false;
  const ref = lastRemindedAt ?? createdAt;
  const parsed = Date.parse(ref);
  return Number.isFinite(parsed) && nowMs - parsed > remindHours * 3600_000;
}

const ASK_REMINDED_PREFIX = "ask.reminded.";

// The creation card (notifyAskCreated) fires once; an ask nobody answers otherwise goes silent
// forever. Re-notify at most once per askRemindHours, tracked via a kv timestamp (not a boolean like
// stall.notified — a reminder repeats, it isn't one-shot). No cleanup sweep on answer/cancel: these
// kv rows are tiny and an orphaned marker is harmless, since it's only ever read while its ask is open.
export async function maybeAskReminders() {
  const now = Date.now();
  const wsById = new Map(workspaces.list(true).map((w) => [w.id, w]));
  for (const a of asks.list({ status: "open" })) {
    // A dated hold IS the answer to "when": re-pinging before that date is exactly the live-looking
    // card "later" exists to remove. An aged (undated) one gets holds.ts's once-a-day nudge instead.
    if (holdBucket(a, now) !== "live") continue;
    const remindHours = effectiveAskRemindHours(a.workspace_id ? wsById.get(a.workspace_id) : undefined);
    if (!remindHours) continue; // 0 = off, either globally or for this workspace
    try {
      const noteKey = ASK_REMINDED_PREFIX + a.id;
      if (!shouldRemind(a.created_at, kv.get(noteKey) ?? null, now, remindHours)) continue;
      kv.set(noteKey, new Date(now).toISOString());

      const ageMin = Math.round((now - Date.parse(a.created_at)) / 60_000);
      const age = ageMin >= 60 ? `${Math.round(ageMin / 60)}h` : `${ageMin}m`;
      const ticket = a.ticket_id ? tickets.get(a.ticket_id) : undefined;
      const who = ticket ? ticket.key : (a.asked_by ?? (a.job_id ? jobs.get(a.job_id)?.name : null) ?? "job");
      const id8 = a.id.slice(0, 8);
      await notify(`❓ still waiting <b>${age}</b>: ${esc(who)} — ${esc(a.question)} · <code>mc answer ${id8} "..."</code>`).catch(() => {});
      if (ticket)
        bus.publish({
          topic: "ticket.event",
          ticket_id: ticket.id,
          workspace_id: ticket.workspace_id,
          text: `❓ still waiting ${age} on: ${a.question}`,
        });
    } catch (e: any) {
      console.warn("[monitor] ask reminder", a.id.slice(0, 8), e?.message ?? e);
    }
  }
}

// Backups live beside the database they back up, not beside the daemon's home: a second instance
// pointed at a copy (`CHRONOS_DB=/tmp/dev.db`, the way the Desk wall gets exercised) was dropping its
// hourly snapshots into the production backup set, where a restore could later pick one up.
const BACKUP_DIR =
  CONFIG.dbPath && CONFIG.dbPath !== ":memory:" && path.dirname(CONFIG.dbPath) !== "."
    ? path.join(path.dirname(CONFIG.dbPath), "backups")
    : inRepo("backups");
const HOURLY_DIR = path.join(BACKUP_DIR, "hourly");
const BACKUP_RE = /^chronos-\d{4}-\d{2}-\d{2}\.db$/;
const HOURLY_RE = /^chronos-\d{8}-\d{2}\.db$/;

// Delete oldest matching *.db files in `dir` beyond `keep` (name sort == chronological). Exported for testing.
export function pruneBackups(dir: string, keep: number, re: RegExp = BACKUP_RE) {
  const files = fs.readdirSync(dir).filter((f) => re.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(dir, f));
}

// launchd log files (StandardOut/ErrorPath) grow forever with no rotation of their own. Once `file`
// crosses maxBytes, gzip it aside (shifting file.1.gz..file.retain.gz) and truncate in place — the
// daemon/launchd's already-open fd keeps writing (append mode) at the new, empty file. No-op if the
// file is missing or still under the cap. Exported for testing; returns whether it rotated.
export function rotateLogIfNeeded(file: string, maxBytes: number, retain: number): boolean {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return false; }
  if (size < maxBytes) return false;

  const slot = (n: number) => `${file}.${n}.gz`;
  if (fs.existsSync(slot(retain))) fs.unlinkSync(slot(retain));
  for (let i = retain - 1; i >= 1; i--) if (fs.existsSync(slot(i))) fs.renameSync(slot(i), slot(i + 1));
  fs.writeFileSync(slot(1), zlib.gzipSync(fs.readFileSync(file)));
  fs.truncateSync(file, 0);
  return true;
}

const LOG_DIR = REPO_ROOT;
// calsync.*.log stay on the list: the job is gone, but its last logs are still on disk and there is
// no reason to leave them unrotated. Drop them once the files are.
const ROTATED_LOGS = ["chronos.out.log", "chronos.err.log", "calsync.out.log", "calsync.err.log", "whisper.out.log", "whisper.err.log"];

function maybeRotateLogs() {
  for (const name of ROTATED_LOGS) {
    try {
      if (rotateLogIfNeeded(path.join(LOG_DIR, name), CONFIG.logRotate.maxBytes, CONFIG.logRotate.retain))
        console.log(`[monitor] rotated ${name}`);
    } catch (e: any) {
      console.warn("[monitor] log rotate failed", name, e?.message ?? e);
    }
  }
}

// Always-on hourly DB backup (SQLite online backup — consistent while the daemon runs). Debounced to
// once per clock hour via the monitor tick; keeps hourlyBackupRetain files. Failure is never silent.
let lastHourlyKey = "";
async function maybeHourlyBackup() {
  const now = new Date();
  const key = `${now.toISOString().slice(0, 10).replace(/-/g, "")}-${String(now.getHours()).padStart(2, "0")}`;
  if (lastHourlyKey === key) return;
  lastHourlyKey = key;
  try {
    fs.mkdirSync(HOURLY_DIR, { recursive: true });
    const dest = path.join(HOURLY_DIR, `chronos-${key}.db`);
    await db.backup(dest);
    pruneBackups(HOURLY_DIR, CONFIG.hourlyBackupRetain, HOURLY_RE);
    console.log(`[monitor] hourly backup -> ${dest}`);
  } catch (e: any) {
    await notify(`❌ <b>Hourly DB backup failed</b> ${e?.message ?? e}`).catch(() => {});
  }
}

// Nightly DB backup at the configured digest hour. Failure is never silent.
async function maybeBackup() {
  if (CONFIG.digestHour < 0) return;
  const now = new Date();
  if (now.getHours() !== CONFIG.digestHour) return;
  if (lastBackupDay === todayStr()) return;
  lastBackupDay = todayStr();
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const dest = path.join(BACKUP_DIR, `chronos-${todayStr()}.db`);
    await db.backup(dest);
    pruneBackups(BACKUP_DIR, CONFIG.backupRetain);
    console.log(`[monitor] backup -> ${dest}`);
  } catch (e: any) {
    await notify(`❌ <b>DB backup failed</b> ${e?.message ?? e}`).catch(() => {});
  }
}

// DB retention sweep: caps the highest-volume tables (run_events, egress_log) and drops search_fts
// 'event' rows orphaned by the run_events prune. Throttled to its own cadence — every store.prune()
// here is a DELETE...NOT IN(...LIMIT) scan, too hot to run on every 5-min monitor tick.
function maybeRetentionSweep() {
  if (Date.now() - lastRetentionSweepMs < CONFIG.retentionSweepMin * 60_000) return;
  lastRetentionSweepMs = Date.now();
  try {
    events.prune(CONFIG.runEventsRetain);
    searchIndex.pruneOrphanEvents();
    egressLog.prune(CONFIG.egress.logCap);
    steps.prune(50_000); // generous cap — a few rows per run, this only bites truly ancient history
    messages.prune(20_000);
  } catch (e: any) {
    console.warn("[monitor] retention sweep", e?.message ?? e);
  }
  // Disk is the other thing that grows without a cap: finished tickets' worktrees. Fire-and-forget —
  // it shells out to git per repo and nothing downstream waits on the result.
  void reapDoneWorktrees().catch((e: any) => console.warn("[monitor] worktree reap", e?.message ?? e));
}

// PR delivery-state poll, throttled to its own cadence inside the 5-min tick.
async function maybeDeliveryPoll() {
  if (!CONFIG.deliveryPollMin) return;
  if (Date.now() - lastDeliveryPollMs < CONFIG.deliveryPollMin * 60_000) return;
  lastDeliveryPollMs = Date.now();
  await pollDeliveries();
}

// Optional external heartbeat (healthchecks.io style): any 200 = alive.
async function maybeHeartbeat() {
  if (!CONFIG.heartbeatUrl) return;
  if (Date.now() - lastHeartbeatMs < CONFIG.heartbeatMin * 60_000) return;
  lastHeartbeatMs = Date.now();
  try {
    const res = await fetch(CONFIG.heartbeatUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e: any) {
    const hour = new Date().getHours();
    if (hour === lastHeartbeatWarnHour) return;
    lastHeartbeatWarnHour = hour;
    console.warn("[monitor] heartbeat failed", e?.message ?? e);
  }
}

// One workspace's slice of the morning brief. Plain data so composeBrief stays pure/testable.
export type BriefWs = {
  name: string;
  autoPlan: boolean;
  spend: number;
  open: number;
  /** Open tickets that are pure tracker mirrors (status_source 'external') — excluded from `open`. */
  mirrored: number;
  review: number;
  live: number;
  arrived: { key: string; title: string; status: string; ticketId: string; createdAt: string }[];
  builtOk: number;
  builtFail: number;
  reviewsAwaiting: number;
  /** Ideas currently sitting in the pool as 'proposed' (awaiting promote/kill). */
  ideasProposed: number;
  /** Of those, how many will hit the 14-day auto-expire within the next 7 days. */
  ideasExpiringSoon: number;
};

const trunc = (s: string, n = 48) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// Pure morning-brief composition: workspace slices + totals → Telegram HTML + tap-to-plan buttons.
// Buttons dispatch the read-only planning agent (br.p.<ticketId8>) for arrived backlog tickets in
// auto_plan-OFF workspaces only (auto_plan-ON ones get a `⚙ auto` marker — the loop picks them up),
// oldest first, global cap 6.
export function composeBrief(
  day: string,
  wsList: BriefWs[],
  totals: { spent: number; budget: number; awaitingReview: number; openAsks?: { count: number; oldestAgeMin: number } }
): { text: string; buttons: Btn[] } {
  const lines: string[] = [`📊 <b>Daily digest</b> · ${day}`];
  for (const w of wsList) {
    if (!w.open && !w.review && !w.live && !w.spend && !w.arrived.length && !w.builtOk && !w.builtFail && !w.ideasProposed) continue;
    lines.push(`\n<b>${esc(w.name)}</b> — $${w.spend.toFixed(2)} · ${w.open} open${w.mirrored ? ` (+${w.mirrored} mirrored)` : ""}${w.review ? ` · ${w.review} ⟳review` : ""}${w.live ? ` · ${w.live} ▣live` : ""}`);
    const arrived = [...w.arrived].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (arrived.length) {
      lines.push("🆕 Arrived");
      for (const t of arrived.slice(0, 5)) {
        const auto = w.autoPlan && t.status === "backlog" ? " ⚙ auto" : "";
        lines.push(`${t.key} ${esc(trunc(t.title))}${auto}`);
      }
      if (arrived.length > 5) lines.push(`+${arrived.length - 5} more`);
    }
    if (w.builtOk || w.builtFail || w.reviewsAwaiting)
      lines.push(`🌙 ${w.builtOk} built${w.builtFail ? ` · ${w.builtFail} failed` : ""}${w.reviewsAwaiting ? ` · ${w.reviewsAwaiting} awaiting review` : ""}`);
    if (w.ideasProposed)
      lines.push(`💡 ideas: ${w.ideasProposed} proposed${w.ideasExpiringSoon ? ` · ${w.ideasExpiringSoon} expiran esta semana` : ""}`);
  }
  lines.push(`\n💸 $${totals.spent.toFixed(2)}/$${totals.budget} today · ${totals.awaitingReview} awaiting review`);
  if (totals.openAsks?.count) {
    const oldest = totals.openAsks.oldestAgeMin >= 60 ? `${Math.round(totals.openAsks.oldestAgeMin / 60)}h` : `${totals.openAsks.oldestAgeMin}m`;
    lines.push(`❓ ${totals.openAsks.count} unanswered ask(s), oldest ${oldest}`);
  }

  const candidates = wsList
    .filter((w) => !w.autoPlan)
    .flatMap((w) => w.arrived)
    .filter((t) => t.status === "backlog")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, 6);
  const buttons: Btn[] = candidates.map((t) => ({ text: `▶ ${t.key}`, data: `br.p.${t.ticketId.slice(0, 8)}` }));
  return { text: lines.join("\n"), buttons };
}

// Daily morning brief (spend + arrived tickets + overnight results per workspace) at the configured hour.
async function maybeDigest() {
  if (CONFIG.digestHour < 0) return;
  const now = new Date();
  if (now.getHours() !== CONFIG.digestHour) return;
  if (lastDigestDay === todayStr()) return;
  lastDigestDay = todayStr();

  const since = hoursAgo(24);
  const spendMap = new Map(runs.spentByWorkspace(todayStr()).map((r) => [r.workspace_id, r.cost]));
  const builds = new Map<string, { ok: number; fail: number }>();
  for (const b of runs.buildOutcomesSince(since)) {
    const cur = builds.get(b.workspace_id) ?? { ok: 0, fail: 0 };
    if (b.status === "success") cur.ok += b.count;
    else if (b.status === "failed") cur.fail += b.count;
    builds.set(b.workspace_id, cur);
  }
  // Reviews awaiting a human, filed overnight — small list, group in JS by ticket → workspace.
  const revAwaiting = new Map<string, number>();
  for (const r of reviews.list("pending")) {
    if (r.created_at < since || !r.ticket_id) continue;
    const wsId = tickets.get(r.ticket_id)?.workspace_id;
    if (wsId) revAwaiting.set(wsId, (revAwaiting.get(wsId) ?? 0) + 1);
  }

  // Ideas that will hit the 14-day auto-expire (src/ideas.ts maybeExpireIdeas) within the next 7
  // days — i.e. already older than 14-7=7 days. Independent of the expire sweep's own cadence, so
  // this can only ever be a same-day-ish estimate, which is all a digest line needs to be.
  const ideaExpireSoonCutoff = hoursAgo(7 * 24);

  const wsList: BriefWs[] = workspaces.list().map((w) => {
    const wsTickets = tickets.list({ workspace_id: w.id });
    const arrived = wsTickets
      .filter((t) => t.created_at >= since && (t.status === "backlog" || t.status === "planned"))
      .map((t) => ({ key: t.key, title: t.title, status: t.status, ticketId: t.id, createdAt: t.created_at }));
    const b = builds.get(w.id) ?? { ok: 0, fail: 0 };
    // Mirror tickets (status_source 'external') are tracker state, not Chronos work — they don't
    // belong in "open"/"in review" attention counts, but they're not hidden: `mirrored` shows them
    // as "+N mirrored" alongside `open` so the digest still accounts for every ticket.
    const openTickets = wsTickets.filter((t) => !isClosedTicketStatus(t.status));
    const proposedIdeas = ideas.list({ workspace_id: w.id, status: "proposed" });
    return {
      name: w.name,
      autoPlan: !!w.auto_plan,
      spend: spendMap.get(w.id) || 0,
      open: openTickets.filter((t) => t.status_source !== "external").length,
      mirrored: openTickets.filter((t) => t.status_source === "external").length,
      review: wsTickets.filter((t) => t.status === "review" && t.status_source !== "external").length,
      live: sessions.list({ workspace_id: w.id, status: "live" }).length,
      arrived,
      builtOk: b.ok,
      builtFail: b.fail,
      reviewsAwaiting: revAwaiting.get(w.id) ?? 0,
      ideasProposed: proposedIdeas.length,
      ideasExpiringSoon: proposedIdeas.filter((i) => i.created_at <= ideaExpireSoonCutoff).length,
    };
  });

  // "N unanswered" counts what needs him TODAY — a dated hold is off that list until its date.
  const openAsks = asks.list({ status: "open" }).filter((a) => holdBucket(a) === "live");
  const oldestAsk = openAsks.reduce<string | null>((min, a) => (!min || a.created_at < min ? a.created_at : min), null);

  const { text, buttons } = composeBrief(todayStr(), wsList, {
    spent: runs.spentTodayUsd(),
    budget: CONFIG.dailyBudgetUsd,
    awaitingReview: reviews.list("pending").length,
    openAsks: openAsks.length
      ? { count: openAsks.length, oldestAgeMin: Math.round((Date.now() - Date.parse(oldestAsk!)) / 60_000) }
      : undefined,
  });
  // Chunk buttons into rows of 3; omit the keyboard entirely when there are none.
  const rows: Btn[][] = [];
  for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
  await notify(text, rows.length ? kb(rows) : undefined).catch(() => {});
}

const REPORTS_DIR = inRepo("reports");

// Weekly per-client work report: Mondays at digestHour, once. For each non-archived workspace with
// activity in the past 7 days, build the report for that window, write it to
// ~/chronos/reports/<slug>/<YYYY-MM-DD>.md, then Telegram one message listing the file paths.
async function maybeWeeklyReport() {
  if (CONFIG.digestHour < 0) return;
  const now = new Date();
  if (now.getDay() !== 1 || now.getHours() !== CONFIG.digestHour) return; // Monday only
  if (lastWeeklyReportDay === todayStr()) return;
  lastWeeklyReportDay = todayStr();

  const from = hoursAgo(24 * 7);
  const to = now.toISOString();
  const written: string[] = [];
  for (const w of workspaces.list()) {
    const recent = activity.list({ workspace_id: w.id, limit: 1 });
    if (!recent.length || recent[0].ts < from) continue; // no activity in the window
    try {
      const { markdown } = buildReport(w.id, from, to);
      const dir = path.join(REPORTS_DIR, w.slug);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${todayStr()}.md`);
      fs.writeFileSync(file, markdown);
      written.push(`${w.name} — ${file}`);
    } catch (e: any) {
      console.warn("[monitor] weekly report failed", w.slug, e?.message ?? e);
    }
  }
  if (written.length)
    await notifyInfo(`🧾 <b>Weekly reports</b> · ${todayStr()}\n` + written.map((w) => esc(w)).join("\n")).catch(() => {});
}

export function startMonitor() {
  if (!CONFIG.monitorEveryMin) return;
  // Overlap guard: a slow backup/gh sweep must not stack concurrent ticks.
  let tickBusy = false;
  const tick = async () => {
    if (tickBusy) return;
    tickBusy = true;
    try {
      await sweep();
      await maybeStallSweep();
      await maybeAskReminders();
      maybeRetentionSweep();
      maybeRotateLogs();
      await maybeBackup();
      await maybeHourlyBackup();
      await maybeHeartbeat();
      await maybeDeliveryPoll();
      // Stalled work → an approve/decline card. Asks only; never resumes anything on its own.
      await sweepStalls();
      // Work in flight with nothing armed to wake Robert is invisible on every other surface.
      await checkSupervision();
      // Holds whose date has arrived come back as the card they came from; undated ones get nudged.
      await sweepHolds();
      await maybeDigest();
      await maybeWeeklyReport();
      await maybeHygiene();
      reapEphemeralJobs();
      maybeExpireIdeas();
      await maybeMineIdeas();
      // Picks up grok's newest billing line and fires the 80%/95% alert even with no Desk open.
      usageSnapshot();
    } catch (e: any) {
      console.warn("[monitor]", e?.message ?? e);
    } finally {
      tickBusy = false;
    }
  };
  setInterval(tick, CONFIG.monitorEveryMin * 60_000).unref?.();
  setTimeout(tick, 30_000).unref?.();

  // Near-real-time CI: while any PR is open, re-poll every ciPollSec so the UI + auto-merge/fix react
  // in seconds, not on the 15-min delivery cadence. Skips the gh calls entirely when nothing is open.
  if (CONFIG.ciPollSec) {
    let ciBusy = false;
    setInterval(async () => {
      if (ciBusy) return;
      if (!tickets.list().some((t) => t.pr_state === "open")) return;
      ciBusy = true;
      try { await pollDeliveries(); } catch (e: any) { console.warn("[monitor] ci-poll", e?.message ?? e); }
      finally { ciBusy = false; }
    }, CONFIG.ciPollSec * 1000).unref?.();
    console.log(`[monitor] fast CI poll every ${CONFIG.ciPollSec}s while a PR is open`);
  }

  console.log(`[monitor] sweeps every ${CONFIG.monitorEveryMin}m · digest ${CONFIG.digestHour < 0 ? "off" : CONFIG.digestHour + ":00"}`);
}
