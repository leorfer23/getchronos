import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";

/**
 * One piece of the operator's own writing, kept per workspace (migration 131, src/prose.ts).
 *
 * `origin` is who handed it to us: `operator` (the Desk, an admin call), `connector` (a comment
 * the tracker says he authored), or `agent` (a terminal relaying text he pasted into it). The
 * learner weighs them in that order — an agent can only claim a text is his.
 */
export type ProseSample = {
  id: string;
  workspace_id: string;
  source: ProseSource;
  channel: ProseChannel;
  origin: ProseOrigin;
  body: string;
  /** The agent's draft he rewrote into `body`, when this sample is an edit. */
  draft: string | null;
  /** What he was replying to, when that shapes the register. */
  context: string | null;
  /** Where it came from (a comment id, a permalink) — also the dedupe key's companion. */
  ref: string | null;
  hash: string;
  created_at: string;
};

export const PROSE_SOURCES = ["manual", "slack", "jira", "clickup", "email", "edit"] as const;
export const PROSE_CHANNELS = ["slack", "jira", "clickup", "email", "doc", "other"] as const;
export type ProseSource = (typeof PROSE_SOURCES)[number];
export type ProseChannel = (typeof PROSE_CHANNELS)[number];
export type ProseOrigin = "operator" | "connector" | "agent";

export type NewProseSample = Omit<ProseSample, "id" | "created_at"> & { created_at?: string };

/** Newest samples kept per workspace — past this the oldest go, so the corpus tracks how he writes now. */
export const PROSE_KEEP = 500;

export const proseSamples = {
  /** Insert unless this workspace already holds the same text. Returns the row, or null for a duplicate. */
  add(s: NewProseSample): ProseSample | null {
    const row: ProseSample = { id: randomUUID(), created_at: s.created_at ?? now(), ...s } as ProseSample;
    const r = db.prepare(
      `INSERT OR IGNORE INTO prose_samples (id,workspace_id,source,channel,origin,body,draft,context,ref,hash,created_at)
       VALUES (@id,@workspace_id,@source,@channel,@origin,@body,@draft,@context,@ref,@hash,@created_at)`,
    ).run(row);
    if (!r.changes) return null;
    db.prepare(
      `DELETE FROM prose_samples WHERE workspace_id=? AND id NOT IN
         (SELECT id FROM prose_samples WHERE workspace_id=? ORDER BY created_at DESC LIMIT ?)`,
    ).run(s.workspace_id, s.workspace_id, PROSE_KEEP);
    return row;
  },
  list(workspace_id: string, filter: { channel?: string; limit?: number } = {}): ProseSample[] {
    const where = ["workspace_id=@workspace_id"];
    if (filter.channel) where.push("channel=@channel");
    return db.prepare(
      `SELECT * FROM prose_samples WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT @limit`,
    ).all({ workspace_id, channel: filter.channel, limit: filter.limit ?? PROSE_KEEP }) as ProseSample[];
  },
  get(id: string): ProseSample | undefined {
    return db.prepare("SELECT * FROM prose_samples WHERE id=?").get(id) as ProseSample | undefined;
  },
  countSince(workspace_id: string, since: string | null): number {
    return (db.prepare("SELECT COUNT(*) n FROM prose_samples WHERE workspace_id=? AND created_at > ?")
      .get(workspace_id, since ?? "") as { n: number }).n;
  },
  remove(id: string): void {
    db.prepare("DELETE FROM prose_samples WHERE id=?").run(id);
  },
};
