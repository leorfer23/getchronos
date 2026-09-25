/**
 * The workspace inbox: ONE place per client that says "something needs you".
 *
 * Two feeds write here, and neither ever starts work:
 *  - Slack: the read-only triage job (`slack-triage:<slug>`, src/slack.ts) files each DM / @mention /
 *    self-note with `mc inbox add` (POST /workspaces/:id/inbox).
 *  - Trackers: every connector sync (src/connectors/index.ts) diffs the pull against the last one it
 *    saw and files what changed FOR the operator — a task newly assigned to him, a new comment that
 *    @mentions him or sits on his task (never his own), a status move on his task. Zero model cost.
 *
 * A row is a notification. The only way an agent starts from one is the operator pressing Dispatch
 * (POST /inbox/:id/dispatch → src/inbox-dispatch.ts). Nothing in this file opens a terminal.
 *
 * Everything that arrives here is untrusted external text on its way into an agent prompt (the
 * dispatch brief), so every field passes guard() at ingestion, same as the connector mirror.
 */
import { createHash } from "node:crypto";
import { bus } from "./bus.js";
import { guard } from "./guard.js";
import { inbox, kv, workspaces, type InboxItem, type InboxSource, type NewInboxItem } from "./store.js";
import { notify } from "./telegram/api.js";
import type { ExternalTask } from "./connectors/types.js";
import { isClosedTicketStatus } from "./types.js";

export const CAP = { title: 200, why: 300, body: 1500, actor: 80, url: 600, key: 300 } as const;

const escHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Only a real web link reaches the Desk's <a href> — never javascript:, never a file path. */
export function safeUrl(u: string | null | undefined): string | null {
  const s = (u ?? "").trim();
  if (!s) return null;
  try {
    const p = new URL(s);
    return p.protocol === "https:" || p.protocol === "http:" ? s.slice(0, CAP.url) : null;
  } catch {
    return null;
  }
}

/** The Telegram push rule: only a Slack DM or @mention the triage marked as a direct question/request. */
export const shouldPush = (i: Pick<InboxItem, "source" | "kind" | "urgent">): boolean =>
  i.source === "slack" && (i.kind === "dm" || i.kind === "mention") && !!i.urgent;

// ───────────────────────────── Won't do / Done memory ─────────────────────────────
// Per (workspace, source, ref), in kv like the tracker snapshot. A mute is Won't do: that task files
// nothing ever again — new comments, status moves, a re-assign. A closed label is what Done pushed
// the task to, so the next sync's "your task moved → Done" is recognised as his own echo.

const refKey = (kind: "mute" | "closed", wsId: string, source: string, ref: string) => `inbox.${kind}:${wsId}:${source}:${ref}`;

export function muteRef(wsId: string, source: string, ref: string): void {
  kv.set(refKey("mute", wsId, source, ref), new Date().toISOString());
}
export const isMuted = (wsId: string, source: string, ref: string | null | undefined): boolean =>
  !!ref && kv.get(refKey("mute", wsId, source, ref)) !== undefined;

export function rememberClosed(wsId: string, source: string, ref: string, label: string): void {
  kv.set(refKey("closed", wsId, source, ref), label);
}
const closedEcho = (wsId: string, source: string, t: ExternalTask): boolean => {
  const label = kv.get(refKey("closed", wsId, source, t.id));
  return !!label && label.trim().toLowerCase() === (t.statusRaw ?? "").trim().toLowerCase();
};

/**
 * File one item. Guards and caps every external field, dedups on (workspace, source, key), and — for
 * an urgent Slack DM/mention only — pushes it to the operator's phone. Returns the row, or null when
 * this key was already filed (so a re-run of the triage or a re-sync is silent) or its task is muted.
 */
export function addInboxItem(n: NewInboxItem): InboxItem | null {
  if (isMuted(n.workspace_id, n.source, n.ref)) return null;
  const where = `inbox ${n.source}`;
  const g = (s: string | null | undefined, cap: number) => {
    const t = (s ?? "").trim();
    return t ? guard(t, where, n.workspace_id).slice(0, cap) : null;
  };
  const row = inbox.add({
    ...n,
    external_key: n.external_key.trim().slice(0, CAP.key),
    title: oneLine(g(n.title, CAP.title) ?? "(no title)"),
    why: g(n.why, CAP.why),
    body: g(n.body, CAP.body),
    actor: g(n.actor, CAP.actor),
    url: safeUrl(n.url),
    ref: n.ref ? n.ref.slice(0, 120) : null,
  });
  if (!row) return null;
  bus.publish({ topic: "inbox.updated", workspace_id: row.workspace_id, item_id: row.id });
  if (shouldPush(row)) {
    const ws = workspaces.get(row.workspace_id);
    // Straight to the phone, not the board: the board wakes executives on @handles, and this is
    // someone else's words.
    notify(
      `📥 <b>${escHtml(ws?.name ?? "Slack")}</b> · ${row.kind === "dm" ? "DM" : "mention"}${row.actor ? " from " + escHtml(row.actor) : ""}\n` +
        `${escHtml(row.title)}${row.why ? "\n<i>" + escHtml(row.why) + "</i>" : ""}`,
      undefined,
      { board: false },
    ).catch(() => {});
  }
  return row;
}

// ───────────────────────────── tracker diff → inbox ─────────────────────────────

/** What the last sync saw of one task: assigned to him, its status label, the comments already seen. */
type TaskSnap = { a: boolean; s: string; c: string[]; seen: string };
export type TrackerSnapshot = { v: 1; tasks: Record<string, TaskSnap> };

/** A task missing from this many days of pulls is forgotten (it was closed long ago or moved away). */
const FORGET_MS = 60 * 86_400_000;
/** More brand-new assigned tasks than this in one pull is a changed query, not a busy morning — reseed. */
export const NEW_TASK_FLOOD = 10;
const COMMENTS_KEPT = 300;

const commentKey = (c: ExternalTask["comments"][number]) =>
  c.id ?? createHash("sha1").update(`${c.author_id ?? c.author}|${c.created ?? ""}|${c.body.slice(0, 80)}`).digest("hex").slice(0, 12);

const excerpt = (s: string | null | undefined, n = 600) => {
  const t = (s ?? "").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

type Draft = Omit<NewInboxItem, "workspace_id">;

/**
 * Pure: the items this pull means for the operator, and the snapshot to remember for the next one.
 *
 * `prev === null` is the workspace's first diff: record the baseline and say nothing — turning this
 * on must not dump every open task and every old comment on him. After that:
 *  - assigned: a task that is his now and was not last time, or a task new to the pull that is his,
 *    still open, and not one Chronos itself mirrors already (a ticket an agent filed and pushed).
 *  - comment/mention: a comment not seen before, not written by him, that @mentions him or sits on
 *    his task. His own comments are his own business.
 *  - status: his task's tracker label moved, unless Chronos is the one that pushed it there.
 */
export function diffTracker(
  prev: TrackerSnapshot | null,
  tasks: ExternalTask[],
  me: string,
  source: InboxSource,
  ctx: { mirrored?: (id: string) => boolean; selfStatus?: (t: ExternalTask) => boolean; nowIso?: string } = {},
): { items: Draft[]; next: TrackerSnapshot } {
  const nowIso = ctx.nowIso ?? new Date().toISOString();
  const next: TrackerSnapshot = { v: 1, tasks: {} };
  const items: Draft[] = [];
  const fresh: Draft[] = [];
  const label = source === "jira" ? "Jira" : source === "clickup" ? "ClickUp" : source;
  // Jira keys read well (ANA-12); a ClickUp id does not, so the title carries it instead.
  const key = (t: ExternalTask) => (source === "jira" ? ` ${t.id}` : "");

  for (const t of tasks) {
    const mine = (t.assignee_ids ?? []).map(String).includes(me);
    const keys = t.comments.map(commentKey);
    const p = prev?.tasks[t.id];
    next.tasks[t.id] = { a: mine, s: t.statusRaw ?? "", c: keys.slice(-COMMENTS_KEPT), seen: nowIso };
    if (!prev) continue;
    const base = { source, ref: t.id, url: t.url } as const;

    if (!p) {
      if (mine && !isClosedTicketStatus(t.status) && !ctx.mirrored?.(t.id))
        fresh.push({ ...base, kind: "assigned", external_key: `${source}:${t.id}:assigned:${t.updated ?? nowIso}`, title: t.title, why: `Assigned to you in ${label}${key(t)}`, body: excerpt(t.description) || null });
      continue; // a task we never saw: its comments are history, not news
    }
    if (mine && !p.a)
      items.push({ ...base, kind: "assigned", external_key: `${source}:${t.id}:assigned:${t.updated ?? nowIso}`, title: t.title, why: `Now assigned to you in ${label}${key(t)}`, body: excerpt(t.description) || null });
    else if (mine && p.s !== (t.statusRaw ?? "") && !ctx.selfStatus?.(t))
      items.push({ ...base, kind: "status", external_key: `${source}:${t.id}:status:${t.statusRaw}:${t.updated ?? nowIso}`, title: t.title, why: `Your ${label} task${key(t)} moved: ${p.s || "?"} → ${t.statusRaw || "?"}` });

    const seen = new Set(p.c);
    t.comments.forEach((c, i) => {
      if (seen.has(keys[i])) return;
      if (c.author_id != null && String(c.author_id) === me) return;
      const mentioned = (c.mentions ?? []).map(String).includes(me);
      if (!mentioned && !mine) return;
      items.push({
        ...base,
        kind: mentioned ? "mention" : "comment",
        external_key: `${source}:${t.id}:comment:${keys[i]}`,
        title: t.title,
        why: mentioned ? `${c.author} mentioned you on ${label}${key(t)}` : `${c.author} commented on your ${label} task${key(t)}`,
        body: excerpt(c.body) || null,
        actor: c.author,
      });
    });
  }
  // Tasks this pull did not return are kept a while: a task that drops out and comes back must not
  // read as brand new (and so as "assigned") the day it returns.
  for (const [id, snap] of Object.entries(prev?.tasks ?? {})) {
    if (!next.tasks[id] && Date.parse(nowIso) - Date.parse(snap.seen) < FORGET_MS) next.tasks[id] = snap;
  }
  if (fresh.length > NEW_TASK_FLOOD) {
    console.warn(`[inbox] ${fresh.length} new ${label} tasks in one pull — treating it as a changed query, not news`);
  } else items.push(...fresh);
  return { items, next };
}

const snapKey = (wsId: string, source: string) => `inbox.tracker:${wsId}:${source}`;

/** Diff one workspace's pull and file what it means. Returns how many rows were new. */
export function emitTrackerInbox(
  wsId: string,
  source: InboxSource,
  me: string,
  tasks: ExternalTask[],
  ctx: { mirrored?: (id: string) => boolean; selfStatus?: (t: ExternalTask) => boolean; nowIso?: string } = {},
): number {
  let prev: TrackerSnapshot | null = null;
  try {
    const raw = kv.get(snapKey(wsId, source));
    if (raw) prev = JSON.parse(raw) as TrackerSnapshot;
  } catch { prev = null; }
  const { items, next } = diffTracker(prev, tasks, me, source, {
    ...ctx,
    selfStatus: (t) => closedEcho(wsId, source, t) || !!ctx.selfStatus?.(t),
  });
  let added = 0;
  for (const d of items) if (addInboxItem({ ...d, workspace_id: wsId })) added++;
  kv.set(snapKey(wsId, source), JSON.stringify(next));
  if (!prev) console.log(`[inbox] ${source}: baseline recorded for ${Object.keys(next.tasks).length} task(s) — changes from the next sync on`);
  return added;
}

/**
 * The operator's tracker id per workspace, cached on success only (a flaky /myself must not blind the
 * inbox for the daemon's lifetime, and a failed lookup must not be remembered as "nobody").
 */
const meCache = new Map<string, string>();
export async function operatorId(wsId: string, lookup: () => Promise<string | null>): Promise<string | null> {
  const hit = meCache.get(wsId);
  if (hit) return hit;
  try {
    const id = await lookup();
    if (id) meCache.set(wsId, String(id));
    return id ? String(id) : null;
  } catch (e: any) {
    console.warn(`[inbox] operator id lookup failed:`, e?.message ?? e);
    return null;
  }
}

