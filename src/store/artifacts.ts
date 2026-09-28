import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";

/**
 * Artifacts (migration 142, src/artifacts.ts): an HTML page an agent published for the operator — a
 * report to read, or a question to answer by clicking. The HTML is on disk; this is the index.
 */
export type ArtifactStatus = "open" | "answered" | "closed";
export type ArtifactEventKind = "submit" | "send";

export type Artifact = {
  id: string;
  workspace_id: string | null;
  session_id: string | null;
  run_id: string | null;
  /** Set when the page IS a question: its submit answers this asks row. */
  ask_id: string | null;
  /** The publisher in words — a terminal's label, an agent handle. */
  created_by: string | null;
  title: string;
  /** Latest version on disk (v1..vN). */
  version: number;
  status: ArtifactStatus;
  /** The page's own JSON (chronos.state), or null. */
  state: string | null;
  created_at: string;
  updated_at: string;
};

export type ArtifactEvent = {
  id: number;
  artifact_id: string;
  kind: ArtifactEventKind;
  /** JSON text of what the page sent. */
  data: string;
  by: string;
  created_at: string;
};

export type NewArtifact = Pick<Artifact, "title"> &
  Partial<Pick<Artifact, "workspace_id" | "session_id" | "run_id" | "ask_id" | "created_by">>;

export const artifacts = {
  create(f: NewArtifact): Artifact {
    const id = randomUUID();
    const t = now();
    db.prepare(
      `INSERT INTO artifacts (id,workspace_id,session_id,run_id,ask_id,created_by,title,version,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,1,'open',?,?)`,
    ).run(id, f.workspace_id ?? null, f.session_id ?? null, f.run_id ?? null, f.ask_id ?? null, f.created_by ?? null, f.title, t, t);
    return this.get(id)!;
  },

  get(id: string): Artifact | undefined {
    return db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as Artifact | undefined;
  },

  /** Full id or an 8+ char prefix — the id8 agents print. */
  resolve(idOrPrefix: string): Artifact | undefined {
    if (!/^[0-9a-f-]{8,36}$/i.test(idOrPrefix)) return undefined;
    return (
      this.get(idOrPrefix) ??
      (db.prepare("SELECT * FROM artifacts WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1").get(idOrPrefix + "%") as Artifact | undefined)
    );
  },

  byAsk(askId: string): Artifact | undefined {
    return db.prepare("SELECT * FROM artifacts WHERE ask_id = ?").get(askId) as Artifact | undefined;
  },

  list(f: { workspace_id?: string | null; session_id?: string | null; limit?: number } = {}): Artifact[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.workspace_id) { where.push("workspace_id = ?"); args.push(f.workspace_id); }
    if (f.session_id) { where.push("session_id = ?"); args.push(f.session_id); }
    const sql = `SELECT * FROM artifacts ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC LIMIT ?`;
    return db.prepare(sql).all(...args, Math.min(Math.max(f.limit ?? 50, 1), 500)) as Artifact[];
  },

  patch(id: string, p: Partial<Pick<Artifact, "title" | "version" | "status" | "state" | "ask_id">>): Artifact | undefined {
    const keys = Object.keys(p) as (keyof typeof p)[];
    if (!keys.length) return this.get(id);
    db.prepare(`UPDATE artifacts SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(
      ...keys.map((k) => p[k] ?? null),
      now(),
      id,
    );
    return this.get(id);
  },

  /** Only an OPEN page moves to answered — a double submit (two tabs, the phone) cannot answer twice. */
  markAnswered(id: string): boolean {
    return db.prepare("UPDATE artifacts SET status = 'answered', updated_at = ? WHERE id = ? AND status = 'open'").run(now(), id).changes > 0;
  },

  addEvent(artifactId: string, kind: ArtifactEventKind, data: string, by: string): ArtifactEvent {
    const r = db
      .prepare("INSERT INTO artifact_events (artifact_id,kind,data,by,created_at) VALUES (?,?,?,?,?)")
      .run(artifactId, kind, data, by, now());
    return db.prepare("SELECT * FROM artifact_events WHERE id = ?").get(r.lastInsertRowid) as ArtifactEvent;
  },

  events(artifactId: string, after = 0): ArtifactEvent[] {
    return db
      .prepare("SELECT * FROM artifact_events WHERE artifact_id = ? AND id > ? ORDER BY id LIMIT 200")
      .all(artifactId, after) as ArtifactEvent[];
  },
};
