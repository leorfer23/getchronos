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
import { randomUUID } from "node:crypto";
import { bus } from "./bus.js";
import { desktop } from "./notify.js";
import { events, jobs, runs, workspaces } from "./store.js";
import { esc, notify } from "./telegram/api.js";
import { lastVoiceLang } from "./voice-presence.js";

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

const DRAFT_TEXT = {
  en: { title: "Draft ready", unsent: "Not sent: review it and send it yourself." },
  es: { title: "Draft listo", unsent: "No se envió: revisalo y mandalo vos." },
};

const recent = new Map<string, number>();
/** One notice per (where, label) per 2 minutes — an agent that rewrites its draft three times is one draft. */
export async function notifyDraft(d: { workspace_id: string | null; where: string; label: string }, nowMs = Date.now()): Promise<boolean> {
  const key = `${d.where}|${d.label}`;
  if (nowMs - (recent.get(key) ?? 0) < 120_000) return false;
  recent.set(key, nowMs);
  if (recent.size > 500) for (const [k, t] of recent) if (nowMs - t > 120_000) recent.delete(k);
  const ws = d.workspace_id ? workspaces.get(d.workspace_id)?.name ?? "—" : "—";
  // The language of his last call, English until there is one — the rule every alert follows
  // (stuck-alerts.ts alertLang): a Mac that never heard Spanish gets no Spanish notifications.
  const t = DRAFT_TEXT[lastVoiceLang() ?? "en"];
  await send(`📝 <b>${t.title}</b> · ${esc(ws)} · ${esc(d.where)}\n${esc(d.label)}\n<i>${t.unsent}</i>`).catch(() => {});
  ping(`📝 ${t.title} · ${ws}`, d.label);
  return true;
}

/**
 * The drafts the phone puts in front of the operator for his yes (static/phone-deck.js): who wrote it,
 * to whom, and — when the terminal's hook carried it — the full text exactly as it would go out.
 * Memory only, last 50 for 24 hours: a stopgap so announced drafts are readable at all, until the
 * request ledger records deliverables. Nothing here sends anything (no-send.ts).
 */
export type RecentDraft = {
  id: string;
  session_id: string | null;
  workspace_id: string | null;
  /** What the terminal is for, in its own words — never an id. */
  where: string;
  label: string;
  kind: "slack" | "email";
  to: string | null;
  channel: string | null;
  subject: string | null;
  text: string | null;
  at: string;
};
const DRAFT_KEEP = 50, DRAFT_TTL_MS = 24 * 3600_000;
const recentList: RecentDraft[] = [];
export function recordDraft(d: Omit<RecentDraft, "id" | "at">, nowMs = Date.now()): RecentDraft {
  // The same draft saved again (update_draft, a second pass at the wording) is one card, with the
  // newest words — under a NEW id, so a yes given on the phone to the old words never covers these.
  const dest = (x: { to: string | null; channel: string | null }) => (x.to ?? x.channel ?? "").toLowerCase();
  for (let i = recentList.length - 1; i >= 0; i--) {
    const x = recentList[i];
    if (x.session_id && x.session_id === d.session_id && x.kind === d.kind && dest(x) === dest(d)) recentList.splice(i, 1);
  }
  const row: RecentDraft = { ...d, id: randomUUID().replace(/-/g, "").slice(0, 16), at: new Date(nowMs).toISOString() };
  recentList.push(row);
  while (recentList.length > DRAFT_KEEP) recentList.shift();
  return row;
}
export function recentDrafts(nowMs = Date.now()): RecentDraft[] {
  return recentList.filter((d) => nowMs - Date.parse(d.at) < DRAFT_TTL_MS).slice().reverse();
}
/** Tests only. */
export function clearRecentDrafts(): void { recentList.length = 0; }
/** The hook's `draft` body, cut to size and typed. Untrusted: it is what an agent passed its tool. */
export function draftFields(raw: any): Pick<RecentDraft, "kind" | "to" | "channel" | "subject" | "text"> {
  const str = (v: unknown, n: number) => { const t = typeof v === "string" ? v.trim() : ""; return t ? t.slice(0, n) : null; };
  // The text verbatim — not even trimmed: the phone hashes exactly these words to match the ledger's
  // target (src/ledger-model.ts draftHash), and a yes is bound to the words he heard.
  const text = typeof raw?.text === "string" && raw.text.length ? raw.text.slice(0, 20000) : null;
  return {
    kind: raw?.kind === "email" ? "email" : "slack",
    to: str(raw?.to, 400), channel: str(raw?.channel, 200), subject: str(raw?.subject, 400), text,
  };
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
