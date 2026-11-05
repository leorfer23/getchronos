/**
 * A draft is ready — tell the operator. No agent ever sends (no-send.ts): it leaves a Slack or Gmail
 * draft and the operator sends it himself. He reads terminals, but a draft can sit unseen in Slack's
 * drafts list, so every draft an agent writes is also announced on his Telegram (and the Mac's
 * notification center): which workspace, which terminal or job, and to whom.
 *
 * Two sources: a Desk terminal's PostToolUse hook (term-hooks.ts → `mc hook claude` → POST
 * /sessions/:id/hook {event:"draft"}), and a headless run's own event stream, read once when the run
 * ends. The message goes only to the operator — never to the draft's recipients, never to another
 * workspace's channel.
 */
import { bus } from "./bus.js";
import { desktop } from "./notify.js";
import { events, jobs, runs, workspaces } from "./store.js";
import { esc, notify } from "./telegram/api.js";

/** The draft tools: Slack's draft, Gmail's create/update draft — on any MCP server spelling. */
export const DRAFT_TOOL_RE = /^mcp__.+__(slack_send_message_draft|create_draft|update_draft)$/;
/** The same, as a Claude Code hook matcher (term-hooks.ts). */
export const DRAFT_TOOL_MATCHER = "mcp__.*__(slack_send_message_draft|create_draft|update_draft)";

const one = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** "Slack draft → #channel: first words…" / "Email draft → ana@x · Subject" — from the tool's input. */
export function draftLabel(tool: string, input: Record<string, any> | null | undefined): string {
  const i = input ?? {};
  if (/slack_send_message_draft$/.test(tool)) {
    const where = i.channel_name || i.channel || i.channel_id || i.user_id || "Slack";
    return `Slack draft → ${one(where, 60)}${i.message || i.text ? `: ${one(i.message || i.text, 90)}` : ""}`;
  }
  const to = Array.isArray(i.to) ? i.to.join(", ") : i.to || i.recipients || "";
  const subject = i.subject || "";
  return `Email draft${to ? ` → ${one(to, 60)}` : ""}${subject ? ` · ${one(subject, 80)}` : ""}`;
}

type Send = (html: string) => Promise<unknown>;
let send: Send = (html) => notify(html, undefined, { board: false });
let ping: (title: string, body: string) => void = (t, b) => { try { desktop(t, b); } catch { /* courtesy */ } };
/** Tests only. */
export function setDraftNotifier(s: Send | null, p?: ((t: string, b: string) => void) | null): void {
  send = s ?? ((html) => notify(html, undefined, { board: false }));
  if (p !== undefined) ping = p ?? ((t, b) => { try { desktop(t, b); } catch {} });
}

const recent = new Map<string, number>();
/** One notice per (where, label) per 2 minutes — an agent that rewrites its draft three times is one draft. */
export async function notifyDraft(d: { workspace_id: string | null; where: string; label: string }, nowMs = Date.now()): Promise<boolean> {
  const key = `${d.where}|${d.label}`;
  if (nowMs - (recent.get(key) ?? 0) < 120_000) return false;
  recent.set(key, nowMs);
  if (recent.size > 500) for (const [k, t] of recent) if (nowMs - t > 120_000) recent.delete(k);
  const ws = d.workspace_id ? workspaces.get(d.workspace_id)?.name ?? "—" : "—";
  await send(`📝 <b>Draft listo</b> · ${esc(ws)} · ${esc(d.where)}\n${esc(d.label)}\n<i>No se envió: revisalo y mandalo vos.</i>`).catch(() => {});
  ping(`📝 Draft listo · ${ws}`, d.label);
  return true;
}

/** Every draft tool call in a finished run's event stream (stream-json assistant tool_use items). */
export function draftsInRun(runId: string): Array<{ tool: string; label: string }> {
  const out: Array<{ tool: string; label: string }> = [];
  for (const e of events.list(runId)) {
    if (!e.payload.includes("tool_use") || !/draft/.test(e.payload)) continue;
    let j: any;
    try { j = JSON.parse(e.payload); } catch { continue; }
    for (const c of j?.message?.content ?? []) {
      if (c?.type === "tool_use" && DRAFT_TOOL_RE.test(String(c.name))) out.push({ tool: c.name, label: draftLabel(c.name, c.input) });
    }
  }
  return out;
}

export function startDraftNotify(): void {
  bus.on("event", (e: any) => {
    if (e?.topic !== "run.ended") return;
    try {
      const run = runs.get(e.run_id);
      const job = run ? jobs.get(run.job_id) : undefined;
      for (const d of draftsInRun(e.run_id)) {
        void notifyDraft({ workspace_id: job?.workspace_id ?? e.workspace_id ?? null, where: `job ${one(job?.name ?? e.job_name ?? e.run_id.slice(0, 8), 60)}`, label: d.label });
      }
    } catch (err) {
      console.warn("[draft-notify] run", e.run_id, err);
    }
  });
}
