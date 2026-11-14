/**
 * Which conversation an inbox row belongs to — the key that keeps one Slack thread or one tracker task
 * to ONE inbox row, and so to ONE terminal (migration 161, src/store/inbox.ts, src/inbox-dispatch.ts).
 *
 * Why (2026-11-10): one requester asked several questions in one Slack thread. The triage filed each
 * message as its own row and each row opened its own terminal — four in two and a half hours, with
 * competing drafts for the same thread and the same follow-up pasted into two of them.
 *
 * Deterministic keys only, read from what the feed itself handed over — never a guess:
 *  - Slack: channel + thread root ts. A reply's permalink carries `thread_ts`; a top-level message is
 *    its own root (`/archives/<C>/p<ts>`); the triage's `<channel id>:<message ts>` key stands in for a
 *    message filed without a link.
 *  - Jira / ClickUp: the task id (`ref`).
 *  - Whatever a feed names itself (`thread`: a Slack `<channel>:<root ts>`, an email thread id).
 * No key → the row stands alone, exactly as before.
 *
 * `relatedAmong` is the one fuzzy rule, and it never merges anything: the same sender in the same Slack
 * conversation within a day is a SUGGESTION the Desk shows beside the row, and its Merge button is the
 * operator's own press.
 *
 * Pure (no store import at runtime), so the migration's backfill uses it too.
 */
import type { InboxItem } from "./store/inbox.js";
import { similarity } from "./text-similarity.js";

/** A Slack message ts: seconds, a dot, microseconds ("1794248726.385579"). */
const TS = /^\d{9,11}\.\d{1,6}$/;
const CHANNEL = /^[A-Z][A-Z0-9]{0,19}$/;
export const THREAD_CAP = 200;

/** A Slack permalink's channel, the thread root it names (`thread_ts`, replies only) and the message's own ts. */
function slackUrl(url: string | null | undefined): { chan: string; root: string | null; own: string | null } | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)slack\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/\/archives\/([A-Za-z0-9]+)\/p(\d{10})(\d{6})(?:\/|$)/);
  const chan = (m?.[1] ?? u.searchParams.get("cid") ?? "").toUpperCase();
  if (!CHANNEL.test(chan)) return null;
  const root = u.searchParams.get("thread_ts");
  return { chan, root: root && TS.test(root) ? root : null, own: m ? `${m[2]}.${m[3]}` : null };
}

/** `<channel>:<ts>` from a Slack permalink: the thread's root for a reply (`thread_ts`), else the message itself. */
export function slackThreadFromUrl(url: string | null | undefined): string | null {
  const p = slackUrl(url);
  const ts = p?.root ?? p?.own;
  return p && ts ? `${p.chan}:${ts}` : null;
}

/** `<channel>:<ts>` from a key written that way (the triage's `--key`, a `--thread`), else null. */
export function slackKeyThread(key: string | null | undefined): string | null {
  const m = (key ?? "").trim().match(/^([A-Za-z0-9]+):(\d{9,11}\.\d{1,6})$/);
  if (!m || !CHANNEL.test(m[1].toUpperCase())) return null;
  return `${m[1].toUpperCase()}:${m[2]}`;
}

/**
 * The thread key of one item about to be filed, or null when nothing names its conversation. For Slack,
 * strongest first: the root a permalink names (Slack's own `thread_ts`), then the thread the feed names
 * (`thread`), then the message as its own root (a permalink without `thread_ts` cannot tell a top-level
 * message from a reply, so a named thread beats it).
 */
export function threadKeyOf(n: {
  source: string;
  external_key?: string | null;
  ref?: string | null;
  url?: string | null;
  thread?: string | null;
}): string | null {
  const t = (n.thread ?? "").trim();
  const named = t ? slackKeyThread(t) ?? slackThreadFromUrl(t) ?? t.slice(0, THREAD_CAP) : null;
  if (n.source === "slack") {
    const p = slackUrl(n.url);
    if (p?.root) return `${p.chan}:${p.root}`;
    return named ?? (p?.own ? `${p.chan}:${p.own}` : slackKeyThread(n.external_key));
  }
  if (named) return named;
  if (n.source === "jira" || n.source === "clickup") return n.ref?.trim().slice(0, THREAD_CAP) || null;
  return null;
}

/** The Slack channel a thread key lives in, or null for any other kind of key. */
export function slackChannelOf(threadKey: string | null | undefined): string | null {
  const m = (threadKey ?? "").match(/^([A-Z][A-Z0-9]*):\d{9,11}\.\d{1,6}$/);
  return m ? m[1] : null;
}

export const RELATED_WINDOW_MS = 24 * 3_600_000;
/** Titles this alike (word Jaccard, text-similarity.ts) read as the same ask in a channel; DMs need none. */
export const RELATED_TITLE_MIN = 0.5;

type RelRow = Pick<InboxItem, "id" | "workspace_id" | "source" | "kind" | "thread_key" | "actor" | "title" | "created_at">;
const who = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * The earlier row in the SAME workspace that this one most likely continues, or null — a suggestion
 * only. Conservative on purpose: both Slack, the same channel but not the same thread (the same thread
 * has already merged by key), the same sender, filed up to a day before this one, and either both
 * direct messages (a DM's conversation is the channel itself) or titles that read alike. Newest wins.
 */
export function relatedAmong<T extends RelRow>(item: RelRow, others: T[]): T | null {
  if (item.source !== "slack") return null;
  const chan = slackChannelOf(item.thread_key);
  const from = who(item.actor);
  const at = Date.parse(item.created_at);
  if (!chan || !from || !Number.isFinite(at)) return null;
  let best: T | null = null;
  for (const o of others) {
    if (o.id === item.id || o.workspace_id !== item.workspace_id || o.source !== "slack") continue;
    if (!o.thread_key || o.thread_key === item.thread_key || slackChannelOf(o.thread_key) !== chan) continue;
    if (who(o.actor) !== from) continue;
    const dt = at - Date.parse(o.created_at);
    if (!(dt >= 0 && dt <= RELATED_WINDOW_MS)) continue;
    const alike = (item.kind === "dm" && o.kind === "dm") || similarity(item.title, o.title) >= RELATED_TITLE_MIN;
    if (alike && (!best || o.created_at > best.created_at)) best = o;
  }
  return best;
}
