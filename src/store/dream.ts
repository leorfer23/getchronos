import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";

/**
 * One dream pass over one workspace's memory (migration 133, src/dream-pass.ts).
 *
 *   dispatched → gathered → applied → (undone)
 *        └──────────┴──→ abandoned   (the job ended without applying; the next pass supersedes it)
 *                   └──→ failed      (dispatch refused)
 */
export type DreamStatus = "dispatched" | "gathered" | "applied" | "undone" | "abandoned" | "failed";
export type DreamSource = "slot" | "manual" | "followup";

export interface DreamRun {
  id: string;
  workspace_id: string;
  slot: string | null;
  source: DreamSource;
  status: DreamStatus;
  job_id: string | null;
  run_id: string | null;
  /** JSON string[] — the inbox line ids the bundle showed. */
  chunk: string | null;
  /** JSON DreamStats. */
  stats: string | null;
  receipt: string | null;
  /** JSON DreamSnapshot — never leaves the daemon except through undo. */
  snapshot: string | null;
  error: string | null;
  created_at: string;
  gathered_at: string | null;
  finished_at: string | null;
  undone_at: string | null;
}

const OPEN: DreamStatus[] = ["dispatched", "gathered"];

export const dreamRuns = {
  create(r: { workspace_id: string; source: DreamSource; slot?: string | null }): DreamRun {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO dream_runs (id,workspace_id,slot,source,status,created_at) VALUES (?,?,?,?, 'dispatched', ?)`,
    ).run(id, r.workspace_id, r.slot ?? null, r.source, now());
    return this.get(id)!;
  },
  get(id: string): DreamRun | undefined {
    return db.prepare("SELECT * FROM dream_runs WHERE id = ?").get(id) as DreamRun | undefined;
  },
  patch(id: string, p: Partial<Omit<DreamRun, "id" | "workspace_id" | "created_at">>): DreamRun | undefined {
    const keys = Object.keys(p).filter((k) => (p as any)[k] !== undefined);
    if (keys.length) db.prepare(`UPDATE dream_runs SET ${keys.map((k) => `${k}=@${k}`).join(", ")} WHERE id=@id`).run({ ...p, id });
    return this.get(id);
  },
  /** Newest first, ONE workspace — the wall holds in the query. */
  list(workspace_id: string, limit = 20): DreamRun[] {
    return db.prepare("SELECT * FROM dream_runs WHERE workspace_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(workspace_id, limit) as DreamRun[];
  },
  open(workspace_id: string): DreamRun[] {
    return db.prepare(`SELECT * FROM dream_runs WHERE workspace_id=? AND status IN (${OPEN.map(() => "?").join(",")}) ORDER BY created_at DESC, rowid DESC`)
      .all(workspace_id, ...OPEN) as DreamRun[];
  },
  /** The last pass that actually changed memory (and was not undone) — the "since" of activity. */
  lastApplied(workspace_id: string): DreamRun | undefined {
    return db.prepare("SELECT * FROM dream_runs WHERE workspace_id=? AND status='applied' ORDER BY finished_at DESC, rowid DESC LIMIT 1")
      .get(workspace_id) as DreamRun | undefined;
  },
  /** When memory was last dreamed at all (applied or later undone) — undoing a pass must not make it re-run at once. */
  lastFinished(workspace_id: string): string | null {
    const r = db.prepare("SELECT MAX(finished_at) t FROM dream_runs WHERE workspace_id=? AND status IN ('applied','undone')")
      .get(workspace_id) as { t: string | null };
    return r.t;
  },
};

export interface MemoryClock {
  workspace_id: string;
  hash: string;
  /** YYYY-MM-DD the line was last reinforced by evidence (or first seen). */
  reinforced: string;
  first_seen: string;
}

export const memoryClocks = {
  map(workspace_id: string): Map<string, MemoryClock> {
    const rows = db.prepare("SELECT * FROM memory_clocks WHERE workspace_id=?").all(workspace_id) as MemoryClock[];
    return new Map(rows.map((r) => [r.hash, r]));
  },
  set(workspace_id: string, hash: string, reinforced: string, first_seen: string): void {
    db.prepare(
      `INSERT INTO memory_clocks (workspace_id,hash,reinforced,first_seen) VALUES (?,?,?,?)
       ON CONFLICT(workspace_id,hash) DO UPDATE SET reinforced=excluded.reinforced`,
    ).run(workspace_id, hash, reinforced, first_seen);
  },
  remove(workspace_id: string, hash: string): void {
    db.prepare("DELETE FROM memory_clocks WHERE workspace_id=? AND hash=?").run(workspace_id, hash);
  },
};
