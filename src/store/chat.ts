import { db } from "./db.js";
import { now } from "./util.js";

// Manager chat threads, one per workspace (Flow's selection picks the thread AND the Claude profile).
// workspace_id NULL = the unscoped thread: Telegram, briefings, and "all workspaces" in Flow.
// A "divider" row is the operator's "new conversation" marker: the UI draws a line at it and
// contextBlock() stops there, so the agent starts fresh while the display history stays intact.
export type ChatSource = "web" | "telegram" | "heartbeat" | "robert" | "divider";

// A line sent as a reply to one bubble. A row holds a whole exchange, so the bubble is the row plus
// which half of it: "you" (the operator's line) or "reply" (Robert's). `text` is whatever the caller
// holds — the whole parent for the model (quotePrompt), a one-line excerpt for display (stored).
export type ChatQuoteSide = "you" | "reply";
export type ChatQuote = { id: number; side: ChatQuoteSide; text: string };
const QUOTE_SHOWN = 240; // the stored excerpt; the UI clamps it to one line
const QUOTE_TO_MODEL = 1500; // enough of a long answer for him to know which point is being answered

/** One line of plain text out of markdown: no emphasis marks, links as their words, whitespace collapsed. */
export function quoteExcerpt(text: string, max = QUOTE_SHOWN): string {
  const t = String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^::ask [0-9a-f-]{8,36}::$/gm, "a question for you") // an Ask card (src/robert-asks.ts)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/\*\*|__|~~|[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/**
 * What Robert is told a reply is answering: the quoted bubble as a markdown quote above the words
 * typed ("> Robert: …\n\n<reply>"), so a "yes, do that" lands on the comment it was about and not on
 * whatever he said last. Empty for a line that is not a reply.
 */
export function quotePrompt(q: ChatQuote | null | undefined): string {
  if (!q) return "";
  let body = String(q.text ?? "").trim();
  if (!body) return "";
  if (body.length > QUOTE_TO_MODEL) body = body.slice(0, QUOTE_TO_MODEL).trimEnd() + " …";
  const who = q.side === "reply" ? "Robert" : "Operator";
  return body.split("\n").map((l, i) => "> " + (i ? "" : who + ": ") + l).join("\n") + "\n\n";
}

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
    // The bubble this line answers. The row keeps the parent's id plus a display excerpt, so the
    // quote still draws after prune() has dropped the parent.
    quote: ChatQuote | null = null,
  ): { id: number; created_at: string; source: ChatSource } {
    const ts = now();
    const r = db
      .prepare(`INSERT INTO chat_messages (you,reply,created_at,source,workspace_id,steps,attachments,reply_to,reply_quote) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(you, reply, ts, source, workspaceId, steps && steps.length ? JSON.stringify(steps) : null,
        attachments && attachments.length ? JSON.stringify(attachments) : null,
        quote ? quote.id : null,
        quote ? JSON.stringify({ side: quote.side, text: quoteExcerpt(quote.text) }) : null);
    return { id: Number(r.lastInsertRowid), created_at: ts, source };
  },
  /**
   * The bubble a reply points at, whole — what quotePrompt gives the model. Null when the row is gone
   * (pruned, cleared), is a divider, or that half of it is empty (a wake has no operator line).
   */
  quoteOf(id: number, side: ChatQuoteSide): ChatQuote | null {
    const row = db.prepare(`SELECT you, reply, source FROM chat_messages WHERE id = ?`).get(id) as
      | { you: string; reply: string; source: string }
      | undefined;
    if (!row || row.source === "divider") return null;
    const text = String((side === "you" ? row.you : row.reply) ?? "").trim();
    return text ? { id, side, text } : null;
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
    opts: { limit?: number; maxChars?: number; workspaceId?: string | null; everywhere?: boolean } = {},
  ): string {
    const limit = Math.min(Math.max(opts.limit ?? 12, 1), 40);
    const maxChars = opts.maxChars ?? 6000;
    // everywhere = the one thread the operator sees (every workspace interleaved) — what the fleet-wide
    // Robert reads on an auto-routed turn. Only an unscoped divider cuts it: one project's "new
    // conversation" must not blank the whole shop's recap.
    const all = (opts.everywhere ? this.recentAll(limit) : this.recent(limit, opts.workspaceId ?? null)) as Array<{
      you: string;
      reply: string;
      source?: string;
      workspace_id?: string | null;
    }>;
    const lastDivider = all.map((r) => (r.source === "divider" && (!opts.everywhere || !r.workspace_id) ? "divider" : "")).lastIndexOf("divider");
    const rows = lastDivider === -1 ? all : all.slice(lastDivider + 1);
    if (!rows.length) return "";
    const lines: string[] = [
      opts.everywhere
        ? "Operator↔manager thread across every workspace (web + Telegram + briefings). Use for continuity; do not re-introduce yourself."
        : "Operator↔manager thread for this workspace (web + Telegram + briefings). Use for continuity; do not re-introduce yourself.",
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
