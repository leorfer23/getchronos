import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";

/**
 * The workspace inbox (migration 138, src/inbox.ts): "something needs you", per client. A row is a
 * notification and nothing more — no code path turns one into work except the operator's Dispatch.
 */
export const INBOX_SOURCES = ["slack", "jira", "clickup"] as const;
export const INBOX_KINDS = ["dm", "mention", "self_note", "assigned", "comment", "status"] as const;
export const INBOX_STATES = ["new", "snoozed", "dismissed", "dispatched"] as const;
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
  created_at: string;
  updated_at: string;
};

export type NewInboxItem = Pick<InboxItem, "workspace_id" | "source" | "kind" | "external_key" | "title"> &
  Partial<Pick<InboxItem, "ref" | "why" | "body" | "url" | "actor">> & { urgent?: boolean; created_at?: string };

/** Snoozed rows whose time has come are simply new again — done on every read, so no timer is needed. */
function wake(at = now()): void {
  db.prepare("UPDATE inbox_items SET state='new', snooze_until=NULL, updated_at=? WHERE state='snoozed' AND snooze_until <= ?").run(at, at);
}

export const inbox = {
  /** Insert unless this workspace+source already holds the key. Returns the row, or null for a duplicate. */
  add(n: NewInboxItem): InboxItem | null {
    const at = n.created_at ?? now();
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
      created_at: at,
      updated_at: at,
    };
    const r = db.prepare(
      `INSERT OR IGNORE INTO inbox_items (id,workspace_id,source,kind,external_key,ref,title,why,body,url,actor,urgent,created_at,updated_at)
       VALUES (@id,@workspace_id,@source,@kind,@external_key,@ref,@title,@why,@body,@url,@actor,@urgent,@created_at,@updated_at)`,
    ).run(row);
    return r.changes ? this.get(row.id)! : null;
  },
  get(id: string): InboxItem | undefined {
    return db.prepare("SELECT * FROM inbox_items WHERE id=?").get(id) as InboxItem | undefined;
  },
  /** Newest first. Default: what still needs him (`new`); `all` adds snoozed/dismissed/dispatched. */
  list(filter: { workspace_id?: string | null; all?: boolean; limit?: number } = {}): InboxItem[] {
    wake();
    const where: string[] = [];
    if (filter.workspace_id) where.push("workspace_id=@workspace_id");
    if (!filter.all) where.push("state='new'");
    return db.prepare(
      `SELECT * FROM inbox_items ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT @limit`,
    ).all({ workspace_id: filter.workspace_id ?? null, limit: filter.limit ?? 200 }) as InboxItem[];
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
};
