import { randomUUID, randomBytes } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";
import type { NewTrigger, Trigger } from "../types.js";

export const triggers = {
  list(): Trigger[] {
    return db.prepare("SELECT * FROM triggers ORDER BY created_at DESC").all() as Trigger[];
  },
  get(id: string): Trigger | undefined {
    return db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as Trigger | undefined;
  },
  getByToken(token: string): Trigger | undefined {
    return db
      .prepare("SELECT * FROM triggers WHERE token = ? AND enabled = 1")
      .get(token) as Trigger | undefined;
  },
  forJob(jobId: string): Trigger[] {
    return db.prepare("SELECT * FROM triggers WHERE job_id = ?").all(jobId) as Trigger[];
  },
  create(t: NewTrigger): Trigger {
    const id = randomUUID();
    const ts = now();
    const source = t.source ?? "http";
    db.prepare(
      `INSERT INTO triggers (id,name,enabled,source,token,config,filter,job_id,inject,created_at,updated_at)
       VALUES (@id,@name,@enabled,@source,@token,@config,@filter,@job_id,@inject,@created_at,@updated_at)`
    ).run({
      id,
      name: t.name,
      enabled: t.enabled === false ? 0 : 1,
      source,
      token: source === "http" ? randomBytes(24).toString("hex") : null,
      config: t.config ? JSON.stringify(t.config) : null,
      filter: t.filter ? JSON.stringify(t.filter) : null,
      job_id: t.job_id,
      inject: t.inject ?? "none",
      created_at: ts,
      updated_at: ts,
    });
    return this.get(id)!;
  },
  update(id: string, patch: Partial<NewTrigger>): Trigger | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const params = {
      id,
      name: patch.name ?? cur.name,
      enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled,
      source: patch.source ?? cur.source,
      config: patch.config !== undefined ? (patch.config ? JSON.stringify(patch.config) : null) : cur.config,
      filter: patch.filter !== undefined ? (patch.filter ? JSON.stringify(patch.filter) : null) : cur.filter,
      job_id: patch.job_id ?? cur.job_id,
      inject: patch.inject ?? cur.inject,
      updated_at: now(),
    };
    db.prepare(
      `UPDATE triggers SET name=@name,enabled=@enabled,source=@source,config=@config,
        filter=@filter,job_id=@job_id,inject=@inject,updated_at=@updated_at WHERE id=@id`
    ).run(params);
    return this.get(id);
  },
  recordFire(id: string, ts: string): void {
    db.prepare(
      "UPDATE triggers SET fire_count = fire_count + 1, last_fired_at = ? WHERE id = ?"
    ).run(ts, id);
  },
  remove(id: string): void {
    db.prepare("DELETE FROM triggers WHERE id = ?").run(id);
  },
};
