import { bus } from "../bus.js";
import { runs, jobs } from "../store.js";
import { send, editMessageText, esc } from "./api.js";
import { STATUS_ICON } from "./keyboards.js";

// ── pure helpers (unit-tested) ──────────────────────────────────────────────

// Last assistant text from a run.event bus payload (~150 chars), or null for non-text events.
export function extractSnippet(event: any): string | null {
  if (!event || event.type !== "assistant") return null;
  const blocks = event.message?.content ?? [];
  const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ").trim();
  return text ? text.replace(/\s+/g, " ").slice(0, 150) : null;
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function tickerText(o: {
  jobName: string; status: string; elapsedMs: number;
  numTurns?: number | null; costUsd?: number | null; snippet?: string | null;
  summary?: string | null; ended?: boolean;
}): string {
  const icon = STATUS_ICON[o.status] ?? (o.ended ? "•" : "▶");
  const meta = [fmtElapsed(o.elapsedMs)];
  if (o.numTurns) meta.push(`${o.numTurns} turns`);
  if (o.costUsd) meta.push(`$${o.costUsd.toFixed(4)}`);
  const head = `${icon} <b>${esc(o.jobName)}</b> · ${o.ended ? o.status : "running"} · ${meta.join(" · ")}`;
  const tail = o.ended
    ? (o.summary ? "\n" + esc(o.summary.slice(0, 400)) : "")
    : (o.snippet ? "\n<i>" + esc(o.snippet) + "</i>" : "");
  return head + tail;
}

// ── stateful watcher ─────────────────────────────────────────────────────────

const EDIT_THROTTLE_MS = 4000;
type Entry = { runId: string; chat: number; messageId: number; jobName: string; registeredAt: number; lastEdit: number; lastText: string; snippet: string | null };
const watched = new Map<string, Entry>(); // runId → entry (dropped on run.ended)

function jobName(runId: string): string {
  const run = runs.get(runId);
  return (run?.job_id ? jobs.get(run.job_id)?.name : null) ?? "job";
}

function render(e: Entry, ended: boolean): string {
  const run = runs.get(e.runId);
  const status = run?.status ?? (ended ? "success" : "running");
  const startMs = run?.started_at ? Date.parse(run.started_at) : e.registeredAt;
  const endMs = ended && run?.ended_at ? Date.parse(run.ended_at) : Date.now();
  return tickerText({
    jobName: e.jobName, status, elapsedMs: endMs - startMs,
    numTurns: run?.num_turns, costUsd: run?.cost_usd,
    snippet: e.snippet, summary: run?.summary, ended,
  });
}

async function edit(e: Entry, ended: boolean) {
  const text = render(e, ended);
  if (text === e.lastText) return; // Telegram 400s on identical edits
  e.lastText = text;
  e.lastEdit = Date.now();
  try { await editMessageText(e.chat, e.messageId, text); } catch { /* never crash the poll/bus loop */ }
}

// Attach a live ticker message to a run the operator triggered from Telegram.
export async function watchRun(runId: string, chat: number, name?: string) {
  const run = runs.get(runId);
  const jn = name ?? jobName(runId);
  // Already finished (e.g. /watch on a done run) → post the final form, don't register.
  if (run && run.ended_at) {
    const startMs = run.started_at ? Date.parse(run.started_at) : Date.parse(run.ended_at);
    await send(chat, tickerText({
      jobName: jn, status: run.status, elapsedMs: Date.parse(run.ended_at) - startMs,
      numTurns: run.num_turns, costUsd: run.cost_usd, summary: run.summary, ended: true,
    }));
    return;
  }
  const res: any = await send(chat, `▶ <b>${esc(jn)}</b> running…`);
  const messageId = res?.result?.message_id;
  if (!messageId) return;
  watched.set(runId, { runId, chat, messageId, jobName: jn, registeredAt: Date.now(), lastEdit: 0, lastText: "", snippet: null });
}

// Does a run have a live ticker message tracking it? Checked by push.ts to skip the redundant
// run.ended notification when the ticker already rendered the final state in-place.
export const hasTicker = (runId: string) => watched.has(runId);

export function registerTicker() {
  bus.on("event", async (ev: any) => {
    if (ev.topic === "run.event") {
      const e = watched.get(ev.run_id);
      if (!e) return;
      const snip = extractSnippet(ev.event);
      if (snip) e.snippet = snip;
      if (Date.now() - e.lastEdit < EDIT_THROTTLE_MS) return; // throttle mid-run edits
      await edit(e, false);
    } else if (ev.topic === "run.ended") {
      const e = watched.get(ev.run_id);
      if (!e) return;
      await edit(e, true); // always render the final form
      watched.delete(ev.run_id); // after the edit so push.ts's hasTicker() check still sees it
    }
  });
}
