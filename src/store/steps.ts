import { db } from "./db.js";
import { now } from "./util.js";

export interface RunStep {
  id: number;
  run_id: string;
  idx: number;
  label: string;
  status: "todo" | "active" | "done" | "skipped";
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunProgress {
  done: number;
  total: number;
  current: string | null;
}

export const steps = {
  // Replaces the run's whole checklist — a worker only declares its plan once (at the start), so a
  // second declare means "the plan changed," not "append more steps."
  declare(run_id: string, labels: string[]): RunStep[] {
    const ts = now();
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM run_steps WHERE run_id = ?").run(run_id);
      const insert = db.prepare(
        "INSERT INTO run_steps (run_id,idx,label,status,created_at,updated_at) VALUES (?,?,?,'todo',?,?)"
      );
      labels.forEach((label, i) => insert.run(run_id, i + 1, label, ts, ts));
    });
    tx();
    return steps.list(run_id);
  },

  // Dumb on purpose: setting one step `active` does not touch any other step (e.g. auto-complete a
  // previously-active one) — the worker is the source of truth for its own checklist.
  set(run_id: string, idx: number, patch: { status?: RunStep["status"]; note?: string }): RunStep | undefined {
    const cur = db.prepare("SELECT * FROM run_steps WHERE run_id = ? AND idx = ?").get(run_id, idx) as RunStep | undefined;
    if (!cur) return undefined;
    db.prepare("UPDATE run_steps SET status = ?, note = ?, updated_at = ? WHERE run_id = ? AND idx = ?").run(
      patch.status ?? cur.status,
      patch.note !== undefined ? patch.note : cur.note,
      now(),
      run_id,
      idx
    );
    return db.prepare("SELECT * FROM run_steps WHERE run_id = ? AND idx = ?").get(run_id, idx) as RunStep;
  },

  list(run_id: string): RunStep[] {
    return db.prepare("SELECT * FROM run_steps WHERE run_id = ? ORDER BY idx ASC").all(run_id) as RunStep[];
  },

  // Liveness evidence: a worker ticking its checklist is alive even while the event stream is quiet
  // (src/liveness.ts). Newest updated_at across the run's steps, or null when it declared none.
  lastUpdatedAt(run_id: string): string | null {
    const row = db.prepare("SELECT MAX(updated_at) AS ts FROM run_steps WHERE run_id = ?").get(run_id) as
      | { ts: string | null }
      | undefined;
    return row?.ts ?? null;
  },

  progress(run_id: string): RunProgress | null {
    const rows = steps.list(run_id);
    if (!rows.length) return null;
    const done = rows.filter((s) => s.status === "done").length;
    const active = rows.find((s) => s.status === "active");
    const lastDone = [...rows].reverse().find((s) => s.status === "done");
    return { done, total: rows.length, current: active?.label ?? lastDone?.label ?? null };
  },

  // Same pattern as events.prune — a DELETE...NOT IN(...LIMIT) sweep run from the monitor's retention
  // cadence, not per-write.
  prune(cap: number): void {
    try {
      db.prepare(`DELETE FROM run_steps WHERE id NOT IN (SELECT id FROM run_steps ORDER BY id DESC LIMIT ?)`).run(cap);
    } catch {}
  },
};
