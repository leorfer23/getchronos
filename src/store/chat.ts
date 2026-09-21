import { db } from "./db.js";
import { now } from "./util.js";

// Manager chat threads, one per workspace (Flow's selection picks the thread AND the Claude profile).
// workspace_id NULL = the unscoped thread: Telegram, briefings, and "all workspaces" in Flow.
// A "divider" row is the operator's "new conversation" marker: the UI draws a line at it and
// contextBlock() stops there, so the agent starts fresh while the display history stays intact.
export type ChatSource = "web" | "telegram" | "heartbeat" | "robert" | "divider";

// Per-executive chat threads (the /app Chat panes). No executive uses them since a retirement left only Robert, who is per-workspace — the stored history is kept and still reads. Separate from
// chat_messages on purpose: that table's workspace_id is a real FK to workspaces, and an exec
// thread is not a workspace (see migration 93 for the bug this fixed). Display history only —
// the exec's model context lives in its --resume session (kv `<id>.session`).
export const agentChat = {
  add(
    agent: string,
    you: string,
    reply: string,
    source: ChatSource = "web",
  ): { id: number; created_at: string } {
    const ts = now();
    const r = db
      .prepare(`INSERT INTO agent_chat (agent,you,reply,created_at,source) VALUES (?,?,?,?,?)`)
      .run(agent, you, reply, ts, source);
    return { id: Number(r.lastInsertRowid), created_at: ts };
  },
  // Operator hit "new conversation" on an executive's thread. An exec's model context is its
  // --resume session id, so dropping that id is the actual reset (resetExecConversation); this row
  // is only what the UI draws the line at, and where execHistory() starts the fallback recap.
  divide(agent: string): { id: number; created_at: string } {
    return this.add(agent, "", "", "divider");
  },
  // Oldest→newest window for one executive; same render contract as chat.recent.
  recent(agent: string, limit = 200): any[] {
    const lim = Math.min(Math.max(limit, 1), 1000);
    return db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM agent_chat WHERE agent = ? ORDER BY id DESC LIMIT ${lim}
         ) ORDER BY id ASC`,
      )
      .all(agent);
  },
  prune(cap: number): void {
    try {
      db.prepare(
        `DELETE FROM agent_chat WHERE id NOT IN (SELECT id FROM agent_chat ORDER BY id DESC LIMIT ?)`,
      ).run(cap);
    } catch {}
  },
};
export const chat = {
  add(
    you: string,
    reply: string,
    source: ChatSource = "web",
    workspaceId: string | null = null,
    steps: unknown[] | null = null,
    // What the operator pasted or dropped into the composer, as display JSON ({id,url,mime,name}).
    // `you` never carries the attachment lines the model is given (see chatAttachmentsBlock) — the
    // chat log draws thumbnails from this column instead, so a reload shows the screenshot and not
    // a wall of paths.
    attachments: unknown[] | null = null,
  ): { id: number; created_at: string; source: ChatSource } {
    const ts = now();
    const r = db
      .prepare(`INSERT INTO chat_messages (you,reply,created_at,source,workspace_id,steps,attachments) VALUES (?,?,?,?,?,?,?)`)
      .run(you, reply, ts, source, workspaceId, steps && steps.length ? JSON.stringify(steps) : null,
        attachments && attachments.length ? JSON.stringify(attachments) : null);
    return { id: Number(r.lastInsertRowid), created_at: ts, source };
  },
  // Oldest→newest window for one thread (dashboard renders chronologically). Dividers are included —
  // the UI draws them as "new conversation" lines.
  recent(limit = 200, workspaceId: string | null = null): any[] {
    const lim = Math.min(Math.max(limit, 1), 1000);
    return db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM chat_messages WHERE workspace_id IS ? ORDER BY id DESC LIMIT ${lim}
         ) ORDER BY id ASC`,
      )
      .all(workspaceId);
  },
  /**
   * Every thread at once, oldest→newest — the ONE visible thread the Desk renders. Each row keeps its
   * workspace_id, so the page can chip it and filter by it; the model never sees this view (a manager
   * only ever gets contextBlock for its own workspace, which is where the isolation lives).
   */
  recentAll(limit = 200): any[] {
    const lim = Math.min(Math.max(limit, 1), 1000);
    return db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM chat_messages ORDER BY id DESC LIMIT ${lim}
         ) ORDER BY id ASC`,
      )
      .all();
  },
  // Operator hit "new conversation": mark the boundary. Everything before it stays visible in the UI
  // but drops out of the agent's context.
  divide(workspaceId: string | null = null): { id: number; created_at: string } {
    return this.add("", "", "divider", workspaceId);
  },
  clear(workspaceId: string | null = null): void {
    db.prepare(`DELETE FROM chat_messages WHERE workspace_id IS ?`).run(workspaceId);
  },
  prune(cap: number): void {
    try {
      db.prepare(
        `DELETE FROM chat_messages WHERE id NOT IN (SELECT id FROM chat_messages ORDER BY id DESC LIMIT ?)`,
      ).run(cap);
    } catch {}
  },
  /**
   * Compact thread recap for the model when switching channels (Telegram ↔ web) or resuming after a
   * process recycle. Display history is always full in the UI; this is only for agent continuity.
   * Stops at the last divider — "new conversation" means the model sees none of what came before.
   * Excludes the brand-new user line (not stored yet). Caps length so prompts stay small.
   */
  contextBlock(
    opts: { limit?: number; maxChars?: number; workspaceId?: string | null } = {},
  ): string {
    const limit = Math.min(Math.max(opts.limit ?? 12, 1), 40);
    const maxChars = opts.maxChars ?? 6000;
    const all = this.recent(limit, opts.workspaceId ?? null) as Array<{
      you: string;
      reply: string;
      source?: string;
    }>;
    const lastDivider = all.map((r) => r.source).lastIndexOf("divider");
    const rows = lastDivider === -1 ? all : all.slice(lastDivider + 1);
    if (!rows.length) return "";
    const lines: string[] = [
      "Operator↔manager thread for this workspace (web + Telegram + briefings). Use for continuity; do not re-introduce yourself.",
      "",
    ];
    for (const r of rows) {
      const src = r.source || "web";
      const you = String(r.you || "").trim().slice(0, 800);
      const reply = String(r.reply || "").trim().slice(0, 1200);
      if (you) lines.push(`[${src}] Operator: ${you}`);
      if (reply) lines.push(`[${src}] Manager: ${reply}`);
      lines.push("");
    }
    let block = lines.join("\n").trim();
    if (block.length > maxChars) block = "…\n" + block.slice(-maxChars);
    return block + "\n\n---\nNew message from the operator:\n";
  },
};
