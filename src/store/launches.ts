import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";

/**
 * A launch is a terminal you open more than once: the morning Airflow check, "review the open PRs",
 * the dbt run. Everything the New-terminal dialog asks for, saved under a name, on one client's
 * header as a chip. Tapping the chip is the dialog's Open with the fields already filled.
 *
 * Not a jot: a jot is a thought that becomes ONE terminal and closes. A launch is a recipe — it
 * never closes, and it remembers how often it has been used. Not a job: a job runs headless on a
 * schedule; a launch opens a live terminal with you at the keyboard. (See migration 108.)
 */
export type Launch = {
  id: string;
  workspace_id: string;
  name: string;
  goal: string | null;
  goal_kind: "pr" | "investigation" | "qa" | null;
  /** Typed into the terminal as its first prompt, after the goal (deskSeed). */
  description: string | null;
  backend: string | null;
  model: string | null;
  cwd: string | null;
  pos: number;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  run_count: number;
  /** The terminal it opened most recently, if any — a door back into the last run. */
  last_session_id: string | null;
};

export type NewLaunch = {
  workspace_id: string;
  name: string;
  goal?: string | null;
  goal_kind?: Launch["goal_kind"];
  description?: string | null;
  backend?: string | null;
  model?: string | null;
  cwd?: string | null;
};

const COLS = `id,workspace_id,name,goal,goal_kind,description,backend,model,cwd,pos,created_at,updated_at,last_run_at,run_count,last_session_id`;

export const launches = {
  list(filter: { workspace_id?: string } = {}): Launch[] {
    return db.prepare(
      `SELECT * FROM launches ${filter.workspace_id ? "WHERE workspace_id=@workspace_id" : ""} ORDER BY workspace_id, pos, created_at`,
    ).all(filter) as Launch[];
  },

  get(id: string): Launch | undefined {
    return db.prepare("SELECT * FROM launches WHERE id = ?").get(id) as Launch | undefined;
  },

  create(input: NewLaunch): Launch {
    const t = now();
    const pos =
      (db.prepare("SELECT COALESCE(MAX(pos), -1) AS m FROM launches WHERE workspace_id=?")
        .get(input.workspace_id) as { m: number }).m + 1;
    const row: Launch = {
      id: randomUUID(),
      workspace_id: input.workspace_id,
      name: input.name,
      goal: input.goal ?? null,
      goal_kind: input.goal_kind ?? null,
      description: input.description ?? null,
      backend: input.backend ?? null,
      model: input.model ?? null,
      cwd: input.cwd ?? null,
      pos,
      created_at: t,
      updated_at: t,
      last_run_at: null,
      run_count: 0,
      last_session_id: null,
    };
    db.prepare(
      `INSERT INTO launches (${COLS}) VALUES (@id,@workspace_id,@name,@goal,@goal_kind,@description,@backend,@model,@cwd,@pos,@created_at,@updated_at,@last_run_at,@run_count,@last_session_id)`,
    ).run(row);
    return this.get(row.id)!;
  },

  update(
    id: string,
    p: Partial<Pick<Launch, "name" | "goal" | "goal_kind" | "description" | "backend" | "model" | "cwd" | "pos">>,
  ): Launch | undefined {
    const sets: string[] = [];
    const params: any = { id, updated_at: now() };
    for (const k of ["name", "goal", "goal_kind", "description", "backend", "model", "cwd", "pos"] as const) {
      if (p[k] !== undefined) { sets.push(`${k}=@${k}`); params[k] = p[k]; }
    }
    if (!sets.length) return this.get(id);
    sets.push("updated_at=@updated_at");
    db.prepare(`UPDATE launches SET ${sets.join(", ")} WHERE id=@id`).run(params);
    return this.get(id);
  },

  /** One more run: the count, the time, and the terminal it opened. */
  ran(id: string, session_id: string): Launch | undefined {
    db.prepare(
      "UPDATE launches SET run_count=run_count+1, last_run_at=@t, last_session_id=@session_id, updated_at=@t WHERE id=@id",
    ).run({ id, session_id, t: now() });
    return this.get(id);
  },

  remove(id: string): boolean {
    return db.prepare("DELETE FROM launches WHERE id = ?").run(id).changes > 0;
  },

  reorder(workspace_id: string, ids: string[]): void {
    const stmt = db.prepare("UPDATE launches SET pos=@pos, updated_at=@t WHERE id=@id AND workspace_id=@workspace_id");
    const t = now();
    db.transaction(() => { ids.forEach((id, i) => stmt.run({ id, pos: i, workspace_id, t })); })();
  },
};
