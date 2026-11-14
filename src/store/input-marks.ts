import { db } from "./db.js";
import { now } from "./util.js";

/**
 * One row per line Chronos typed into a terminal (migration 161, src/turn-source.ts): who typed it and
 * a hash of its first words — never the text. A CLI's transcript records every typed line as if the
 * operator typed it; these rows are how the weekly retro tells his words from the daemon's.
 */
export interface InputMark {
  id: number;
  session_id: string;
  workspace_id: string | null;
  /** turn-source.ts InjectKind. */
  kind: string;
  /** The raw `by` it was typed under (clipped), for the trail. */
  by: string | null;
  /** turn-source.ts textKey of what was typed. */
  text_key: string;
  at: string;
}

export const inputMarks = {
  add(m: { session_id: string; workspace_id: string | null; kind: string; by: string | null; text_key: string; at?: string }): void {
    db.prepare("INSERT INTO input_marks (session_id,workspace_id,kind,by,text_key,at) VALUES (?,?,?,?,?,?)")
      .run(m.session_id, m.workspace_id, m.kind, m.by ? m.by.slice(0, 40) : null, m.text_key, m.at ?? now());
  },
  /** Oldest first, one terminal. */
  forSession(session_id: string): InputMark[] {
    return db.prepare("SELECT * FROM input_marks WHERE session_id = ? ORDER BY at ASC, id ASC LIMIT 5000").all(session_id) as InputMark[];
  },
  /** Drop marks older than `before` (ISO) — the retro only ever looks a couple of weeks back. */
  prune(before: string): number {
    return db.prepare("DELETE FROM input_marks WHERE at < ?").run(before).changes;
  },
};
