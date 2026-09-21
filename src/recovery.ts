/**
 * Recovery supervisor — the component that notices work which STOPPED without finishing.
 *
 * Chronos dispatches into an in-memory queue, so a daemon stop (every deploy) or a crash voids
 * whatever was in flight. db.ts's startup reconciliation marks those runs `interrupted` so they don't
 * hang forever, but nothing ever looked at them again: 14 `ideas:followups` runs died on one restart
 * and were dropped in silence. The same blind spot swallows tickets — `in_progress` with no live run
 * is a lie the dashboard tells until someone scrolls past it.
 *
 * DELIBERATELY NOT AUTOMATIC. This module never re-dispatches on its own. It turns a stall into a
 * pending decision, asks once (Telegram card + a board post), and waits. Resuming work costs
 * money and can collide with whatever the operator has since done by hand, so the operator decides.
 * The only thing the sweep writes is the "asked" marker.
 *
 * Decisions live in kv (`recover.<id>` = asked | approved | declined) rather than a new table: the
 * run/ticket row IS the record of the work, this only records what the human said about it. A declined
 * stall is never raised again.
 */
import { CONFIG } from "./config.js";
import { jobs, kv, runs, sessions, tickets, workspaces } from "./store.js";
import { dispatch } from "./dispatcher.js";
import { dispatchTicket } from "./tickets.js";
import { notify } from "./telegram/api.js";
import { esc } from "./telegram/api.js";
import { kb } from "./telegram/keyboards.js";
import { postToBoard } from "./board.js";
import { holdBucket } from "./hold-bucket.js";

export type StallKind = "run" | "ticket";
export type Decision = "asked" | "approved" | "declined";

export interface Stall {
  /** Stable, surface-safe handle: "r:<run id8>" or "t:<TICKET-KEY>". Fits Telegram's 64-byte callback_data. */
  id: string;
  kind: StallKind;
  /** One-line summary for a chat surface. Plain text — every surface can render it verbatim. */
  line: string;
  /** Workspace slug the stalled work belongs to — tags that workspace's board post. */
  ws: string | null;
  /** Workspace id — the scoping check an endpoint needs; the slug above is for display. */
  workspace_id: string | null;
  /** What approving actually does, so the operator is never guessing what a ✅ means. */
  action: string;
  /** When the work stopped. Named `created_at` so a Stall is a `Holdable` (src/hold-bucket.ts). */
  created_at: string;
  /** "Later": off the live list until this ISO moment. Kept in kv — a stall has no table of its own. */
  hold_until: string | null;
  hold_reason: string | null;
}

const key = (id: string) => `recover.${id}`;
const decisionOf = (id: string): Decision | null => (kv.get(key(id)) as Decision) ?? null;
const record = (id: string, d: Decision) => kv.set(key(id), d);

// A stall is derived from a run/ticket row every time it is listed, so its hold can't live on the
// row — it lives beside the decision kv already keeps for the same handle.
const holdKey = (id: string) => `recover.hold.${id}`;
interface StallHold { until: string | null; reason: string | null; resurfaced_at?: string | null }

export function stallHold(id: string): StallHold {
  const raw = kv.get(holdKey(id));
  if (!raw) return { until: null, reason: null };
  try {
    const h = JSON.parse(raw) as StallHold;
    return { until: h.until ?? null, reason: h.reason ?? null, resurfaced_at: h.resurfaced_at ?? null };
  } catch {
    return { until: null, reason: null };
  }
}

/** "Later" on a stall. `until: null` lifts it; a hold never decides anything. */
export function holdStall(id: string, until: string | null, reason: string | null): void {
  if (!until) return kv.del(holdKey(id));
  kv.set(holdKey(id), JSON.stringify({ until, reason: reason ?? null, resurfaced_at: stallHold(id).resurfaced_at ?? null }));
}

/** Clear a due hold once. Returns false when someone already cleared it (the return card fires once). */
export function resurfaceStall(id: string, at: string): boolean {
  const cur = stallHold(id);
  if (!cur.until) return false;
  kv.set(holdKey(id), JSON.stringify({ until: null, reason: null, resurfaced_at: at }));
  return true;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const wsSlug = (id: string | null | undefined) => (id ? workspaces.get(id)?.slug ?? null : null);
const wsLabel = (id: string | null | undefined) =>
  id ? workspaces.get(id)?.slug ?? id.slice(0, 8) : "unscoped";

/** Group stalls by workspace slug so each board post covers one workspace. */
export function groupByWorkspace(stalls: Stall[]): Map<string | null, Stall[]> {
  const out = new Map<string | null, Stall[]>();
  for (const s of stalls) out.set(s.ws, [...(out.get(s.ws) ?? []), s]);
  return out;
}

function age(iso: string | null | undefined): string {
  if (!iso) return "?";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "?";
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))}m`;
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/**
 * Every stall currently awaiting a decision, newest first. Pure read — safe to call from any surface
 * (this is what `recover` renders). Excludes anything already asked-and-answered.
 */
export function listStalls(includeAsked = true): Stall[] {
  const out: Stall[] = [];

  // 1. Runs a restart/crash orphaned. The job must still exist — hygiene reaps ephemeral jobs, and
  //    without the job there is no goal, model or cwd to resume from.
  for (const r of runs.interruptedSince(hoursAgo(CONFIG.recoverWindowHours))) {
    const id = `r:${r.id.slice(0, 8)}`;
    const d = decisionOf(id);
    if (d === "approved" || d === "declined") continue;
    if (d === "asked" && !includeAsked) continue;
    const job = jobs.get(r.job_id);
    if (!job) continue;
    const t = job.ticket_id ? tickets.get(job.ticket_id) : undefined;
    const hold = stallHold(id);
    out.push({
      id,
      kind: "run",
      ws: wsSlug(job.workspace_id),
      workspace_id: job.workspace_id ?? null,
      line: `🔌 ${job.name} — died ${age(r.ended_at ?? r.started_at)} ago on a daemon restart${t ? ` · ${t.key}` : ""} · ${wsLabel(job.workspace_id)}`,
      action: `re-dispatch ${job.name}`,
      created_at: r.ended_at ?? r.started_at ?? new Date().toISOString(),
      hold_until: hold.until,
      hold_reason: hold.reason,
    });
  }

  // 2. Tickets parked mid-flight with nothing running — an agent died on it. (A connector-imported
  //    status with no agent ever having touched it is status_source 'external' — that's the known,
  //    expected shape of a tracker mirror, not a stall; see TicketStatusSource in types.ts. Skip it
  //    here so the recovery sweep isn't ~20 "needs a human call" cards for ClickUp/Jira's own state.)
  for (const t of tickets.list({ status: "in_progress" })) {
    if (t.status_source === "external") continue;
    const id = `t:${t.key}`;
    const d = decisionOf(id);
    if (d === "approved" || d === "declined") continue;
    if (d === "asked" && !includeAsked) continue;
    if (runs.listForTicket(t.id).some((r) => r.status === "running" || r.status === "queued")) continue;
    // A headless run isn't the only way a ticket is being worked — a Desk terminal (`mc claim`'d to
    // this ticket) has no run row at all. Without this it's a false "no agent on it" for a ticket
    // being worked live in a terminal all day.
    if (sessions.list({ ticket_id: t.id, status: "live" }).length) continue;
    if (Date.parse(t.updated_at) > Date.parse(hoursAgo(CONFIG.stallTicketHours))) continue;
    const ever = runs.listForTicket(t.id).length;
    const hold = stallHold(id);
    out.push({
      id,
      kind: "ticket",
      ws: wsSlug(t.workspace_id),
      workspace_id: t.workspace_id ?? null,
      line: `🫥 ${t.key} — in_progress ${age(t.updated_at)} with no agent on it${ever ? "" : " (never dispatched)"} · ${wsLabel(t.workspace_id)}\n  ${t.title.slice(0, 70)}`,
      action: `build ${t.key}`,
      created_at: t.updated_at,
      hold_until: hold.until,
      hold_reason: hold.reason,
    });
  }

  return out;
}

/** True while any run of `jobId` is a stall the operator hasn't answered yet (hygiene must not reap it). */
export function awaitingRecovery(jobId: string): boolean {
  return runs
    .interruptedSince(hoursAgo(CONFIG.recoverWindowHours))
    .some((r) => r.job_id === jobId && !["approved", "declined"].includes(decisionOf(`r:${r.id.slice(0, 8)}`) ?? ""));
}

/** Resolve a handle the operator typed (`r:1a2b3c4d`, `t:CED-23`, or a bare id8/key) to a live stall. */
export function resolveStall(handle: string): Stall | undefined {
  const want = handle.trim().toLowerCase();
  const all = listStalls();
  return (
    all.find((s) => s.id.toLowerCase() === want) ??
    all.find((s) => s.id.slice(2).toLowerCase() === want)
  );
}

/**
 * Act on a decision. `approve` is the ONLY path in this module that dispatches anything, and it only
 * ever runs because a human tapped ✅ or typed `recover <id> ok`. Returns plain text for the surface.
 */
export async function decideStall(handle: string, approve: boolean): Promise<string> {
  const s = resolveStall(handle);
  if (!s) return `⚠️ Nothing stalled matches "${handle}" — it may already be decided. Try: recover`;
  // A decision retires any deferral with it: "later" was about WHEN to decide, and that is now settled.
  holdStall(s.id, null, null);
  if (!approve) {
    record(s.id, "declined");
    return `✕ Left alone: ${s.action}. Won't ask about ${s.id} again.`;
  }
  try {
    if (s.kind === "run") {
      const runId = s.id.slice(2);
      const r = runs.interruptedSince(hoursAgo(CONFIG.recoverWindowHours)).find((x) => x.id.startsWith(runId));
      if (!r) return `⚠️ Run ${runId} is no longer resumable.`;
      const out = dispatch(r.job_id, "recover:approved");
      if ("error" in out) return `⚠️ Couldn't resume: ${out.error}`;
      record(s.id, "approved");
      return `▶️ Resumed ${s.action} — run ${out.run_id.slice(0, 8)} (${out.status}).`;
    }
    const t = tickets.list().find((x) => x.key === s.id.slice(2));
    if (!t) return `⚠️ Ticket ${s.id.slice(2)} no longer exists.`;
    const out = await dispatchTicket(t.id);
    record(s.id, "approved");
    return `🚀 Dispatched ${t.key} — run ${out.run_id?.slice(0, 8) ?? "?"} (${out.status ?? "queued"}).`;
  } catch (e: any) {
    return `⚠️ Couldn't act on ${s.id}: ${String(e?.message ?? e).slice(0, 200)}`;
  }
}

/**
 * The stalled-work card, composed once so the resurface sweep can re-send the SAME card a held stall
 * came from rather than inventing a second shape for it.
 */
export function stallCard(s: Stall, lead?: string): { text: string; keyboard: ReturnType<typeof kb> } {
  return {
    text:
      (lead ? `${esc(lead)}\n` : "") +
      `🩺 <b>Stalled work</b>\n${esc(s.line)}\n\nApprove to ${esc(s.action)} — nothing runs until you say so.`,
    keyboard: kb([
      [{ text: "✅ Resume", data: `rc.ok.${s.id}` }, { text: "✕ Leave it", data: `rc.no.${s.id}` }],
      [{ text: "⏰ Later", data: `hd.c.${s.id}` }],
    ]),
  };
}

let lastSweepMs = 0;

/**
 * Detect stalls and ask about the ones nobody has been asked about yet — Telegram card with
 * ✅/✕ buttons, plus a per-workspace board post as the durable record. Capped per
 * sweep so a bad night can't flood the chat; the rest surface the next time round (or via `recover`).
 * Returns how many it asked about.
 */
export async function sweepStalls(): Promise<number> {
  if (!CONFIG.recoverSweepMin) return 0;
  if (Date.now() - lastSweepMs < CONFIG.recoverSweepMin * 60_000) return 0;
  lastSweepMs = Date.now();

  // A held stall has already had its call: "later, on this date". Asking again before then is the
  // exact live-looking card the hold exists to remove.
  const fresh = listStalls(false).filter((s) => holdBucket(s) === "live");
  if (!fresh.length) return 0;
  const batch = fresh.slice(0, CONFIG.recoverMaxAsk);
  const more = fresh.length - batch.length;

  for (const s of batch) {
    record(s.id, "asked"); // before the send: a failed notify must not re-ask forever
    const card = stallCard(s);
    await notify(card.text, card.keyboard, { board: false }).catch(() => {}); // the sweep writes its own board post below
  }
  // One board post per workspace (workspace-tagged), not one lump: an Acme stall is Acme's
  // business. Deliberately NO @mention — a scheduled sweep must never spend tokens waking Robert;
  // the Telegram card above is the actionable ask, the board post is the durable record, and the operator
  // can @robert on the thread to have it handled.
  for (const [ws, group] of groupByWorkspace(batch)) {
    const text = [
      `🩺 ${group.length} stalled item(s) need a call${more ? ` (+${more} more elsewhere)` : ""}:`,
      ...group.map((s) => `${s.line}\n  → \`mc recover ${s.id} ok\` to ${s.action} · \`mc recover ${s.id} no\` to drop it`),
    ].join("\n");
    try {
      postToBoard({ author: "chronos", body: text, workspace_id: ws ?? null });
    } catch (e) {
      console.error("[recovery] board post failed", e);
    }
  }

  console.log(`[recovery] asked about ${batch.length} stall(s)${more ? `, ${more} deferred` : ""}`);
  return batch.length;
}
