import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";

/**
 * The workspace inbox (migration 138, src/inbox.ts): "something needs you", per client. A row is a
 * notification; the operator's Dispatch or auto-dispatch (src/inbox-autodispatch.ts) turns it into a terminal.
 *
 * One thread, one row (migration 161, src/inbox-thread.ts): a new ask from a thread that already has
 * an open row is filed as that row's ask — state `merged`, merged_into = the open row — not as a row
 * of its own. It keeps its own external_key, so a re-run of the feed still finds it a duplicate.
 */
export const INBOX_SOURCES = ["slack", "jira", "clickup"] as const;
export const INBOX_KINDS = ["dm", "mention", "self_note", "assigned", "comment", "status"] as const;
/** `done`: he closed it (the tracker task too, for a tracker row). `muted`: Won't do — its ref files nothing again.
 *  `merged`: a later ask folded into an open row of its thread; it lives and closes with that row. */
export const INBOX_STATES = ["new", "snoozed", "dismissed", "dispatched", "resolved", "done", "muted", "merged"] as const;
export const PRIORITIES = ["high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
export type InboxSource = (typeof INBOX_SOURCES)[number];
export type InboxKind = (typeof INBOX_KINDS)[number];
export type InboxState = (typeof INBOX_STATES)[number];

export type InboxItem = {
  id: string;
  workspace_id: string;
  source: InboxSource;
  kind: InboxKind;
  /** Dedup key, unique per workspace+source (a Slack ts/permalink, `jira:ANA-12:comment:<id>`). */
  external_key: string;
  /** The tracker task id (ANA-12, a ClickUp id) — how Dispatch finds the Chronos ticket mirroring it. */
  ref: string | null;
  title: string;
  why: string | null;
  body: string | null;
  url: string | null;
  actor: string | null;
  urgent: number;
  state: InboxState;
  snooze_until: string | null;
  dispatched_session: string | null;
  /** Why an agent or the tracker sync closed it (state `resolved`): "you replied in the thread". */
  resolved_reason: string | null;
  /** The cleanup job's order within this workspace (0 = first). NULL = filed after the last ranking. */
  rank: number | null;
  priority: Priority | null;
  rank_why: string | null;
  /** The conversation it belongs to (src/inbox-thread.ts): a Slack `<channel>:<root ts>`, a tracker task id. Null = stands alone. */
  thread_key: string | null;
  /** State `merged`: the open row of the same thread this ask was folded into. */
  merged_into: string | null;
  created_at: string;
  updated_at: string;
};

export type NewInboxItem = Pick<InboxItem, "workspace_id" | "source" | "kind" | "external_key" | "title"> &
  Partial<Pick<InboxItem, "ref" | "why" | "body" | "url" | "actor" | "thread_key">> & { urgent?: boolean; created_at?: string };

/** One ask folded into a row: what the Desk lists under the row and the dispatch brief quotes. */
export type InboxAsk = Pick<InboxItem, "id" | "kind" | "external_key" | "title" | "why" | "body" | "url" | "actor" | "urgent" | "created_at">;
const toAsk = (r: InboxItem): InboxAsk => ({
  id: r.id, kind: r.kind, external_key: r.external_key, title: r.title, why: r.why, body: r.body, url: r.url,
  actor: r.actor, urgent: r.urgent, created_at: r.created_at,
});

/** A row and every thread folded into it: its own key, or the key of any ask merged into it (same workspace, always). */
const IN_THREAD =
  "(i.thread_key=@thread OR EXISTS (SELECT 1 FROM inbox_items c WHERE c.merged_into=i.id AND c.workspace_id=i.workspace_id AND c.thread_key=@thread))";

/** Snoozed rows whose time has come are simply new again — done on every read, so no timer is needed. */
function wake(at = now()): void {
  db.prepare("UPDATE inbox_items SET state='new', snooze_until=NULL, updated_at=? WHERE state='snoozed' AND snooze_until <= ?").run(at, at);
}

export const inbox = {
  /**
   * Insert unless this workspace+source already holds the key. Returns the row, or null for a duplicate.
   * With a thread key whose thread already has an open row (new/snoozed) in this workspace, the row is
   * filed as an ask on it instead (state `merged`, merged_into = that row) and that row is bumped: it is
   * unranked again, a snoozed one is awake, and it is urgent when the new ask is.
   */
  add(n: NewInboxItem): InboxItem | null {
    const at = n.created_at ?? now();
    const thread = n.thread_key?.trim() || null;
    return db.transaction((): InboxItem | null => {
      const open = thread ? this.openInThread(n.workspace_id, n.source, thread) : undefined;
      const row = {
        id: randomUUID(),
        workspace_id: n.workspace_id,
        source: n.source,
        kind: n.kind,
        external_key: n.external_key,
        ref: n.ref ?? null,
        title: n.title,
        why: n.why ?? null,
        body: n.body ?? null,
        url: n.url ?? null,
        actor: n.actor ?? null,
        urgent: n.urgent ? 1 : 0,
        state: open ? "merged" : "new",
        thread_key: thread,
        merged_into: open?.id ?? null,
        created_at: at,
        updated_at: at,
      };
      const r = db.prepare(
        `INSERT OR IGNORE INTO inbox_items (id,workspace_id,source,kind,external_key,ref,title,why,body,url,actor,urgent,state,thread_key,merged_into,created_at,updated_at)
         VALUES (@id,@workspace_id,@source,@kind,@external_key,@ref,@title,@why,@body,@url,@actor,@urgent,@state,@thread_key,@merged_into,@created_at,@updated_at)`,
      ).run(row);
      if (!r.changes) return null;
      if (open)
        db.prepare("UPDATE inbox_items SET state='new', snooze_until=NULL, rank=NULL, urgent=MAX(urgent, ?), updated_at=? WHERE id=?")
          .run(row.urgent, now(), open.id);
      return this.get(row.id)!;
    })();
  },
  /** The open row (new or snoozed) of a thread in this workspace — where a new ask from it is folded in. */
  openInThread(workspace_id: string, source: string, thread_key: string): InboxItem | undefined {
    return db.prepare(
      `SELECT * FROM inbox_items i WHERE i.workspace_id=@ws AND i.source=@source AND i.merged_into IS NULL
       AND i.state IN ('new','snoozed') AND ${IN_THREAD} ORDER BY i.created_at LIMIT 1`,
    ).get({ ws: workspace_id, source, thread: thread_key }) as InboxItem | undefined;
  },
  /**
   * The terminals that worked a thread, most recent first: each dispatched row of it in this workspace,
   * joined to its session — which must sit in the same workspace as the row.
   */
  threadSessions(workspace_id: string, source: string, thread_key: string): { session_id: string; ended_at: string | null }[] {
    return db.prepare(
      `SELECT s.id AS session_id, s.ended_at AS ended_at, MAX(i.updated_at) AS at FROM inbox_items i
       JOIN sessions s ON s.id = i.dispatched_session AND s.workspace_id = i.workspace_id
       WHERE i.workspace_id=@ws AND i.source=@source AND i.merged_into IS NULL AND ${IN_THREAD}
       GROUP BY s.id ORDER BY at DESC LIMIT 10`,
    ).all({ ws: workspace_id, source, thread: thread_key }) as { session_id: string; ended_at: string | null }[];
  },
  /** The asks folded into each of these rows, oldest first. An ask always sits in its row's workspace. */
  asksOf(ids: string[]): Map<string, InboxAsk[]> {
    const out = new Map<string, InboxAsk[]>();
    if (!ids.length) return out;
    const rows = db.prepare(
      `SELECT c.* FROM inbox_items c JOIN inbox_items p ON p.id = c.merged_into AND p.workspace_id = c.workspace_id
       WHERE c.merged_into IN (${ids.map(() => "?").join(",")}) ORDER BY c.created_at, c.rowid`,
    ).all(...ids) as InboxItem[];
    for (const r of rows) out.set(r.merged_into!, [...(out.get(r.merged_into!) ?? []), toAsk(r)]);
    return out;
  },
  /** These rows with their folded-in asks attached (`asks`, oldest first). */
  withAsks<T extends InboxItem>(rows: T[]): (T & { asks: InboxAsk[] })[] {
    const asks = this.asksOf(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, asks: asks.get(r.id) ?? [] }));
  },
  /**
   * The operator's Merge: open row `id` — and the asks already folded into it — becomes asks on open row
   * `into`. Same workspace and source only; each ask keeps its own thread key, so a later message from
   * either thread finds `into`. Returns `into`, or undefined when the two cannot merge.
   */
  mergeInto(id: string, into: string): InboxItem | undefined {
    return db.transaction((): InboxItem | undefined => {
      const a = this.get(id), b = this.get(into);
      const open = (r: InboxItem) => !r.merged_into && (r.state === "new" || r.state === "snoozed");
      if (!a || !b || a.id === b.id || a.workspace_id !== b.workspace_id || a.source !== b.source || !open(a) || !open(b)) return undefined;
      const at = now();
      db.prepare("UPDATE inbox_items SET state='merged', merged_into=?, snooze_until=NULL, rank=NULL, updated_at=? WHERE id=?").run(b.id, at, a.id);
      db.prepare("UPDATE inbox_items SET merged_into=?, updated_at=? WHERE merged_into=? AND workspace_id=?").run(b.id, at, a.id, a.workspace_id);
      db.prepare("UPDATE inbox_items SET state='new', snooze_until=NULL, rank=NULL, urgent=MAX(urgent, ?), updated_at=? WHERE id=?").run(a.urgent, at, b.id);
      return this.get(b.id);
    })();
  },
  get(id: string): InboxItem | undefined {
    return db.prepare("SELECT * FROM inbox_items WHERE id=?").get(id) as InboxItem | undefined;
  },
  /** A full id, or the 8-char prefix `mc inbox list` prints — undefined unless exactly one row matches. */
  find(idOrPrefix: string): InboxItem | undefined {
    const s = idOrPrefix.trim().toLowerCase();
    if (s.length >= 36) return this.get(s);
    if (!/^[0-9a-f-]{8,}$/.test(s)) return undefined;
    const r = db.prepare("SELECT * FROM inbox_items WHERE id LIKE ? LIMIT 2").all(s + "%") as InboxItem[];
    return r.length === 1 ? r[0] : undefined;
  },
  /**
   * Default: what still needs him (`new`) — rows filed since the last ranking first (newest first),
   * then in the cleanup job's order. `open` adds snoozed (what a re-check must look at); `all` is
   * everything, newest first. An ask folded into a row is part of that row (withAsks), never a row
   * of its own here — unless `state: "merged"` asks for exactly those.
   */
  list(filter: { workspace_id?: string | null; all?: boolean; open?: boolean; state?: InboxState; limit?: number } = {}): InboxItem[] {
    wake();
    const where: string[] = [];
    if (filter.state !== "merged") where.push("merged_into IS NULL");
    if (filter.workspace_id) where.push("workspace_id=@workspace_id");
    if (filter.state) where.push("state=@state");
    else if (filter.open) where.push("state IN ('new','snoozed')");
    else if (!filter.all) where.push("state='new'");
    const order = filter.all || filter.state ? "updated_at DESC" : "rank IS NOT NULL, rank, created_at DESC";
    return db.prepare(
      `SELECT * FROM inbox_items ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${order} LIMIT @limit`,
    ).all({ workspace_id: filter.workspace_id ?? null, state: filter.state ?? null, limit: filter.limit ?? 200 }) as InboxItem[];
  },
  /** Unread (`new`) per workspace — the Desk badge. Only the one workspace for a scoped caller. */
  counts(workspace_id?: string | null): Record<string, number> {
    wake();
    const rows = db.prepare(
      `SELECT workspace_id, COUNT(*) n FROM inbox_items WHERE state='new' ${workspace_id ? "AND workspace_id=?" : ""} GROUP BY workspace_id`,
    ).all(...(workspace_id ? [workspace_id] : [])) as { workspace_id: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.workspace_id, r.n]));
  },
  dismiss(id: string): InboxItem | undefined {
    db.prepare("UPDATE inbox_items SET state='dismissed', snooze_until=NULL, updated_at=? WHERE id=? AND state IN ('new','snoozed')").run(now(), id);
    return this.get(id);
  },
  snooze(id: string, until: string): InboxItem | undefined {
    db.prepare("UPDATE inbox_items SET state='snoozed', snooze_until=?, updated_at=? WHERE id=? AND state IN ('new','snoozed')").run(until, now(), id);
    return this.get(id);
  },
  /** Close a row whose ask already happened. Only an open row: a dispatched one belongs to its terminal. */
  resolve(id: string, reason: string): InboxItem | undefined {
    db.prepare("UPDATE inbox_items SET state='resolved', resolved_reason=?, snooze_until=NULL, updated_at=? WHERE id=? AND state IN ('new','snoozed')").run(reason, now(), id);
    return this.get(id);
  },
  /** The operator's undo for an agent's (or his own ✕) close: it needs him after all. */
  reopen(id: string): InboxItem | undefined {
    db.prepare("UPDATE inbox_items SET state='new', resolved_reason=NULL, rank=NULL, updated_at=? WHERE id=? AND state IN ('resolved','dismissed')").run(now(), id);
    return this.get(id);
  },
  /**
   * Write one workspace's ranking. `order` is every open row the ranker kept, most important first;
   * an open row it left out keeps rank NULL and so shows ahead as "not ranked yet". Rows of another
   * workspace in `order` are ignored — the wall holds even when the ranker gets an id wrong.
   */
  rank(workspace_id: string, order: { id: string; priority: Priority; why?: string | null }[]): number {
    const at = now();
    const set = db.prepare("UPDATE inbox_items SET rank=@rank, priority=@priority, rank_why=@why, updated_at=@at WHERE id=@id AND workspace_id=@ws AND state IN ('new','snoozed')");
    let n = 0;
    db.transaction(() => {
      db.prepare("UPDATE inbox_items SET rank=NULL WHERE workspace_id=? AND state IN ('new','snoozed')").run(workspace_id);
      order.forEach((o, i) => { n += set.run({ id: o.id, rank: i, priority: o.priority, why: o.why ?? null, at, ws: workspace_id }).changes; });
    })();
    return n;
  },
  /**
   * Close a row as `done` or `muted`, and with it every other still-open row about the same tracker
   * task (an older comment on a task he just closed is not news any more). Returns the row.
   */
  finish(id: string, state: "done" | "muted"): InboxItem | undefined {
    const row = this.get(id);
    if (!row) return undefined;
    const at = now();
    db.prepare("UPDATE inbox_items SET state=?, snooze_until=NULL, updated_at=? WHERE id=?").run(state, at, id);
    if (row.ref)
      db.prepare("UPDATE inbox_items SET state=?, snooze_until=NULL, updated_at=? WHERE workspace_id=? AND source=? AND ref=? AND id<>? AND state IN ('new','snoozed')")
        .run(state, at, row.workspace_id, row.source, row.ref, id);
    return this.get(id);
  },
  /** Take the row for a dispatch. False when it is already dispatched or dismissed — one press, one terminal. */
  claim(id: string): boolean {
    return db.prepare("UPDATE inbox_items SET state='dispatched', snooze_until=NULL, updated_at=? WHERE id=? AND state IN ('new','snoozed')").run(now(), id).changes === 1;
  },
  /** A claimed row whose terminal could not open goes back to what it was: still needs him. */
  unclaim(id: string): void {
    db.prepare("UPDATE inbox_items SET state='new', updated_at=? WHERE id=? AND state='dispatched' AND dispatched_session IS NULL").run(now(), id);
  },
  dispatchedTo(id: string, session_id: string): InboxItem | undefined {
    db.prepare("UPDATE inbox_items SET dispatched_session=?, updated_at=? WHERE id=?").run(session_id, now(), id);
    return this.get(id);
  },
  /** Highest rowid so far — auto-dispatch only takes rows filed after it was turned on. */
  maxRowid(): number {
    return (db.prepare("SELECT COALESCE(MAX(rowid),0) n FROM inbox_items").get() as { n: number }).n;
  },
  /** `new` rows filed after `afterRowid`, in the order the Desk shows them. */
  autoCandidates(afterRowid: number): InboxItem[] {
    wake();
    return db.prepare(
      "SELECT * FROM inbox_items WHERE state='new' AND rowid > ? ORDER BY urgent DESC, rank IS NOT NULL, rank, created_at",
    ).all(afterRowid) as InboxItem[];
  },
  /** A client's other rows since `sinceIso`, newest first — what the triage checks a new row against for repeats. */
  recent(workspace_id: string, sinceIso: string, exceptId: string, limit = 20): InboxItem[] {
    return db.prepare(
      "SELECT * FROM inbox_items WHERE workspace_id=? AND id<>? AND created_at>=? ORDER BY created_at DESC LIMIT ?",
    ).all(workspace_id, exceptId, sinceIso, limit) as InboxItem[];
  },
  /**
   * Slack rows of one workspace filed since `sinceIso` that a new row could be a continuation of: open
   * ones, and dispatched ones whose terminal (in the same workspace) is still live — `live_session`.
   * What the Desk's "same conversation?" suggestion is picked from (src/inbox-thread.ts relatedAmong).
   */
  relatedCandidates(workspace_id: string, sinceIso: string): (InboxItem & { live_session: string | null })[] {
    return db.prepare(
      `SELECT i.*, s.id AS live_session FROM inbox_items i
       LEFT JOIN sessions s ON s.id = i.dispatched_session AND s.workspace_id = i.workspace_id AND s.ended_at IS NULL
       WHERE i.workspace_id=? AND i.source='slack' AND i.merged_into IS NULL AND i.created_at >= ?
         AND (i.state IN ('new','snoozed') OR (i.state='dispatched' AND s.id IS NOT NULL))
       ORDER BY i.created_at DESC LIMIT 100`,
    ).all(workspace_id, sinceIso) as (InboxItem & { live_session: string | null })[];
  },
  /** Live terminals per workspace that an inbox row opened — one per terminal, however many rows it holds. */
  liveDispatched(): Record<string, number> {
    const rows = db.prepare(
      `SELECT i.workspace_id, COUNT(DISTINCT s.id) n FROM inbox_items i JOIN sessions s ON s.id = i.dispatched_session
       WHERE i.state='dispatched' AND s.ended_at IS NULL GROUP BY i.workspace_id`,
    ).all() as { workspace_id: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.workspace_id, r.n]));
  },
  /** The terminal rows were dispatched to has closed: every one of them is done with it (the item, and any follow-up typed in). */
  closeForSession(session_id: string): InboxItem[] {
    const ids = (db.prepare("SELECT id FROM inbox_items WHERE dispatched_session=? AND state='dispatched'").all(session_id) as { id: string }[]).map((r) => r.id);
    if (!ids.length) return [];
    db.prepare("UPDATE inbox_items SET state='resolved', resolved_reason='its terminal was closed', updated_at=? WHERE dispatched_session=? AND state='dispatched'").run(now(), session_id);
    return ids.map((id) => this.get(id)!);
  },
};
