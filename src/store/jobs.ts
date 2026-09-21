import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";
import { searchIndex } from "./search.js";
import { CONFIG } from "../config.js";
import { sanitizeCwd, sanitizeAddDirs, clampSandbox } from "../spawn-guard.js";
import type { Job, NewJob } from "../types.js";

export const jobs = {
  list(): Job[] {
    return db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all() as Job[];
  },
  get(id: string): Job | undefined {
    return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job | undefined;
  },
  enabledCron(): Job[] {
    return db
      .prepare("SELECT * FROM jobs WHERE enabled = 1 AND trigger_type = 'cron' AND cron_expr IS NOT NULL")
      .all() as Job[];
  },
  enabledOnce(): Job[] {
    return db
      .prepare("SELECT * FROM jobs WHERE enabled = 1 AND trigger_type = 'once' AND run_at IS NOT NULL")
      .all() as Job[];
  },
  create(j: NewJob): Job {
    const id = randomUUID();
    const ts = now();
    const cwd = sanitizeCwd(j.cwd, j.workspace_id) ?? process.env.HOME ?? ".";
    const addDirs = sanitizeAddDirs(j.add_dirs, j.workspace_id);
    const sandbox = clampSandbox(j.sandbox, j.workspace_id);
    db.prepare(
      `INSERT INTO jobs (id,name,description,goal,append_system,profile,workspace_id,ticket_id,backend,cwd,add_dirs,model,
        allowed_tools,disallowed_tools,trigger_type,cron_expr,run_at,timezone,max_budget_usd,timeout_sec,
        retry_max,retry_backoff_sec,verify,sandbox,on_success,on_failure,notify,enabled,created_at,updated_at)
       VALUES (@id,@name,@description,@goal,@append_system,@profile,@workspace_id,@ticket_id,@backend,@cwd,@add_dirs,@model,
        @allowed_tools,@disallowed_tools,@trigger_type,@cron_expr,@run_at,@timezone,@max_budget_usd,@timeout_sec,
        @retry_max,@retry_backoff_sec,@verify,@sandbox,@on_success,@on_failure,@notify,@enabled,@created_at,@updated_at)`
    ).run({
      id,
      name: j.name,
      description: j.description ?? null,
      goal: j.goal,
      append_system: j.append_system ?? null,
      profile: j.profile ?? CONFIG.defaultProfile,
      workspace_id: j.workspace_id ?? null,
      ticket_id: j.ticket_id ?? null,
      backend: j.backend ?? "claude-code",
      cwd,
      add_dirs: addDirs.length ? JSON.stringify(addDirs) : null,
      model: j.model ?? null,
      allowed_tools: j.allowed_tools ?? null,
      disallowed_tools: j.disallowed_tools ?? null,
      trigger_type: j.trigger_type ?? "manual",
      cron_expr: j.cron_expr ?? null,
      run_at: j.run_at ?? null,
      // A cron the operator typed means his clock, not Greenwich: default to the daemon's own zone.
      timezone: j.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
      max_budget_usd: j.max_budget_usd ?? null,
      timeout_sec: j.timeout_sec ?? CONFIG.defaultTimeoutSec,
      retry_max: j.retry_max ?? 0,
      retry_backoff_sec: j.retry_backoff_sec ?? 60,
      verify: j.verify ? 1 : 0,
      sandbox,
      on_success: j.on_success ?? null,
      on_failure: j.on_failure ?? null,
      notify: j.notify ?? null,
      enabled: j.enabled === false ? 0 : 1,
      created_at: ts,
      updated_at: ts,
    });
    const created = this.get(id)!;
    searchIndex.indexJob(created);
    return created;
  },
  update(id: string, patch: Partial<NewJob>): Job | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    // workspace_id is the trust boundary for cwd/add_dirs/sandbox — resolve it first so a patch that
    // changes workspace_id re-validates the others against the NEW workspace, not the old one.
    const wsId = patch.workspace_id !== undefined ? patch.workspace_id : cur.workspace_id;
    const addDirs = patch.add_dirs !== undefined ? sanitizeAddDirs(patch.add_dirs, wsId) : null;
    const next = {
      ...cur,
      ...patch,
      cwd: patch.cwd !== undefined ? sanitizeCwd(patch.cwd, wsId) ?? cur.cwd : cur.cwd,
      add_dirs:
        patch.add_dirs !== undefined ? (addDirs!.length ? JSON.stringify(addDirs) : null) : cur.add_dirs,
      sandbox: patch.sandbox !== undefined ? clampSandbox(patch.sandbox, wsId) : cur.sandbox,
      enabled:
        patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled,
      verify: patch.verify !== undefined ? (patch.verify ? 1 : 0) : cur.verify,
      updated_at: now(),
    };
    db.prepare(
      `UPDATE jobs SET name=@name,description=@description,goal=@goal,append_system=@append_system,
        profile=@profile,workspace_id=@workspace_id,ticket_id=@ticket_id,backend=@backend,cwd=@cwd,add_dirs=@add_dirs,model=@model,allowed_tools=@allowed_tools,
        disallowed_tools=@disallowed_tools,trigger_type=@trigger_type,cron_expr=@cron_expr,run_at=@run_at,
        timezone=@timezone,max_budget_usd=@max_budget_usd,timeout_sec=@timeout_sec,
        retry_max=@retry_max,retry_backoff_sec=@retry_backoff_sec,verify=@verify,sandbox=@sandbox,
        on_success=@on_success,on_failure=@on_failure,notify=@notify,enabled=@enabled,updated_at=@updated_at WHERE id=@id`
    ).run(next as any);
    return this.get(id);
  },
  remove(id: string): void {
    db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  },
};
