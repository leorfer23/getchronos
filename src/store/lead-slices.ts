import { db } from "./db.js";
import { now } from "./util.js";

/**
 * A Lead's plan, durable (LEADS.md) — one row per slice of the goal.
 *
 * The plan used to live in the Lead's context window and nowhere else, so a compaction cost it the
 * whole map: which slices exist, which worker is on each, which are already merged. `mc lead board`
 * is the rebuild, beside `mc lead workers` (who is alive) and `mc lead inbox` (what they said).
 *
 * `n` is the Lead's own numbering and is what every other surface refers to (`--slice 3`,
 * `mc lead board set 3`), never the row id: it is stable, readable, and unique per Lead.
 */
export const SLICE_STATUSES = ["todo", "doing", "review", "done", "dropped"] as const;
export type SliceStatus = (typeof SLICE_STATUSES)[number];

export interface LeadSlice {
  id: number;
  lead_id: string;
  n: number;
  title: string;
  status: SliceStatus;
  /** The worker on it — always one of THIS Lead's own workers (checked by the route, not here). */
  session_id: string | null;
  pr_url: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface SlicePatch {
  status?: SliceStatus;
  session_id?: string | null;
  pr_url?: string | null;
  note?: string | null;
  title?: string;
}

const FIELDS: (keyof SlicePatch)[] = ["status", "session_id", "pr_url", "note", "title"];

export const leadSlices = {
  /** This Lead's board in its own order. */
  list(leadId: string): LeadSlice[] {
    return db.prepare("SELECT * FROM lead_slices WHERE lead_id = ? ORDER BY n").all(leadId) as LeadSlice[];
  },

  get(leadId: string, n: number): LeadSlice | undefined {
    return db.prepare("SELECT * FROM lead_slices WHERE lead_id = ? AND n = ?").get(leadId, n) as LeadSlice | undefined;
  },

  /** The one worker↔slice lookup that runs on a report: which slice is this terminal on, if any. */
  forSession(leadId: string, sessionId: string): LeadSlice | undefined {
    return db
      .prepare("SELECT * FROM lead_slices WHERE lead_id = ? AND session_id = ? ORDER BY n LIMIT 1")
      .get(leadId, sessionId) as LeadSlice | undefined;
  },

  /**
   * Append a slice. `n` is max+1 READ INSIDE the transaction, so two `board add` calls in one command
   * (several titles at once) cannot both compute the same number — and the UNIQUE(lead_id, n) index
   * is the second wall if they ever do.
   */
  add(leadId: string, title: string): LeadSlice {
    const tx = db.transaction((): LeadSlice => {
      const max = (db.prepare("SELECT MAX(n) AS m FROM lead_slices WHERE lead_id = ?").get(leadId) as { m: number | null }).m ?? 0;
      const ts = now();
      db.prepare(
        "INSERT INTO lead_slices (lead_id,n,title,status,created_at,updated_at) VALUES (?,?,?,'todo',?,?)",
      ).run(leadId, max + 1, title, ts, ts);
      return leadSlices.get(leadId, max + 1)!;
    });
    return tx();
  },

  /** Patch what was passed and nothing else — an omitted field keeps its value, `null` clears it. */
  patch(leadId: string, n: number, p: SlicePatch): LeadSlice | undefined {
    const cur = leadSlices.get(leadId, n);
    if (!cur) return undefined;
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const f of FIELDS) {
      if (p[f] === undefined) continue;
      sets.push(`${f} = ?`);
      params.push(p[f]);
    }
    if (!sets.length) return cur;
    sets.push("updated_at = ?");
    params.push(now(), leadId, n);
    db.prepare(`UPDATE lead_slices SET ${sets.join(", ")} WHERE lead_id = ? AND n = ?`).run(...params);
    return leadSlices.get(leadId, n);
  },

  /** `3/7` on the Desk's Lead row. `dropped` is off the board, so it counts as neither. */
  tally(leadId: string): { done: number; total: number } {
    const rows = leadSlices.list(leadId).filter((s) => s.status !== "dropped");
    return { done: rows.filter((s) => s.status === "done").length, total: rows.length };
  },

  /**
   * Move every slice from one Lead onto another, renumbering past the destination's max so
   * UNIQUE(lead_id, n) cannot collide. Used by `mc lead adopt`.
   */
  reassign(fromLeadId: string, toLeadId: string): number {
    if (fromLeadId === toLeadId) return 0;
    return db.transaction(() => {
      const rows = leadSlices.list(fromLeadId);
      if (!rows.length) return 0;
      const max =
        (db.prepare("SELECT MAX(n) AS m FROM lead_slices WHERE lead_id = ?").get(toLeadId) as { m: number | null })
          .m ?? 0;
      const upd = db.prepare("UPDATE lead_slices SET lead_id = ?, n = ?, updated_at = ? WHERE id = ?");
      const ts = now();
      let i = 0;
      for (const row of rows) {
        i += 1;
        upd.run(toLeadId, max + i, ts, row.id);
      }
      return rows.length;
    })();
  },
};
