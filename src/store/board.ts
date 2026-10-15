import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";

// The board: one public feed where agents (and the operator) post and thread. No DMs, no
// channels — full visibility is the point. See migration 91 for why this replaces Buzz.
export type BoardPost = {
  id: string;
  thread_root_id: string | null;
  author: string;
  kind: string; // 'post' | 'heartbeat' — heartbeats render as fleet-summary cards, not prose
  body: string;
  mentions: string | null; // JSON array of lowercase @handles, parsed at write time
  ticket_id: string | null;
  workspace_id: string | null;
  created_at: string;
};

export type BoardFeedItem = BoardPost & { reply_count: number; last_activity: string };

// Lowercased handles after '@'. Generic on purpose: the store doesn't know who exists — the wake
// watcher (src/board.ts) filters against the real executive roster, so "@2pm" mentions nobody.
export function parseMentions(body: string): string[] {
  const out = new Set<string>();
  for (const m of String(body).matchAll(/(^|[^\w@])@([a-z][\w-]*)/gi)) out.add(m[2].toLowerCase());
  return [...out];
}

export const board = {
  create(p: {
    author: string;
    body: string;
    thread_root_id?: string | null;
    kind?: string;
    ticket_id?: string | null;
    workspace_id?: string | null;
  }): BoardPost {
    let root = p.thread_root_id ?? null;
    if (root) {
      const target = this.get(root);
      if (!target) throw new Error(`board post not found: ${root}`);
      // Replying to a reply flattens to its root: threads are two levels deep, always readable.
      if (target.thread_root_id) root = target.thread_root_id;
    }
    const row: BoardPost = {
      id: randomUUID(),
      thread_root_id: root,
      author: p.author,
      kind: p.kind ?? "post",
      body: p.body,
      mentions: JSON.stringify(parseMentions(p.body)),
      ticket_id: p.ticket_id ?? null,
      workspace_id: p.workspace_id ?? null,
      created_at: now(),
    };
    db.prepare(
      `INSERT INTO board_posts (id,thread_root_id,author,kind,body,mentions,ticket_id,workspace_id,created_at)
       VALUES (@id,@thread_root_id,@author,@kind,@body,@mentions,@ticket_id,@workspace_id,@created_at)`
    ).run(row);
    return row;
  },
  get(id: string): BoardPost | undefined {
    return db.prepare("SELECT * FROM board_posts WHERE id = ?").get(id) as BoardPost | undefined;
  },
  // Feed = root posts, forum-style bump order: a fresh reply floats its thread back up.
  feed(limit = 50): BoardFeedItem[] {
    const lim = Math.min(Math.max(limit, 1), 200);
    return db
      .prepare(
        `SELECT p.*,
           (SELECT COUNT(*) FROM board_posts r WHERE r.thread_root_id = p.id) AS reply_count,
           COALESCE((SELECT MAX(r.created_at) FROM board_posts r WHERE r.thread_root_id = p.id), p.created_at) AS last_activity
         FROM board_posts p WHERE p.thread_root_id IS NULL
         ORDER BY last_activity DESC LIMIT ?`
      )
      .all(lim) as BoardFeedItem[];
  },
  // Whole thread, root first then replies oldest→newest (read top to bottom like a conversation).
  thread(rootId: string): BoardPost[] {
    return db
      .prepare(
        `SELECT * FROM board_posts WHERE id = @id OR thread_root_id = @id
         ORDER BY (thread_root_id IS NOT NULL), created_at ASC`
      )
      .all({ id: rootId }) as BoardPost[];
  },
  // Threads cross-linked to a ticket — the ticket page's "discussed on board" section.
  forTicket(ticketId: string): BoardPost[] {
    return db
      .prepare("SELECT * FROM board_posts WHERE ticket_id = ? ORDER BY created_at ASC")
      .all(ticketId) as BoardPost[];
  },
  remove(id: string): void {
    db.prepare("DELETE FROM board_posts WHERE id = ? OR thread_root_id = ?").run(id, id);
  },
  prune(cap: number): void {
    try {
      db.prepare(
        `DELETE FROM board_posts WHERE thread_root_id IS NULL AND id NOT IN
           (SELECT id FROM board_posts WHERE thread_root_id IS NULL ORDER BY created_at DESC LIMIT ?)`
      ).run(cap);
      db.prepare(
        `DELETE FROM board_posts WHERE thread_root_id IS NOT NULL
           AND thread_root_id NOT IN (SELECT id FROM board_posts WHERE thread_root_id IS NULL)`
      ).run();
    } catch {}
  },
};
