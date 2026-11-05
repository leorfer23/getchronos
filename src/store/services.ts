import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";

/**
 * A service: one always-on, non-agent process the daemon keeps running for a workspace — a Slack bot
 * on Socket Mode, a local API, a file watcher. See migration 152 and SERVICES.md; the supervisor that
 * acts on these rows is src/services.ts.
 *
 * Two kinds of column: what the operator set (name, command, cwd, env, ref, restart, enabled) and what
 * the supervisor last saw (status, pid, started_at, next_start_at, last_exit_*, restarts, last_error).
 * `enabled` is the switch: on = keep it running, and start it again at every boot.
 */
export type RestartPolicy = "always" | "on-failure" | "never";
export const RESTART_POLICIES: readonly RestartPolicy[] = ["always", "on-failure", "never"];

/**
 * stopped  — off (the switch is off, or it was never started)
 * running  — its process is up
 * backoff  — it exited and is waiting to be started again (`next_start_at`)
 * exited   — it ended on its own and the policy says leave it (code 0 under on-failure, or never)
 * crashed  — it ended with an error and will not be started again until someone does (crash loop, or never)
 */
export type ServiceStatus = "stopped" | "running" | "backoff" | "exited" | "crashed";

export type Service = {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  /** Run as `/bin/bash -c <command>` in `cwd`. */
  command: string;
  cwd: string;
  /** JSON object of extra env vars, on top of the workspace's own (child-env.ts). */
  env: string | null;
  /** Git ref `deploy` checks out (detached) in `cwd` before a restart; null = no deploy. */
  ref: string | null;
  restart: RestartPolicy;
  enabled: number;
  status: ServiceStatus;
  pid: number | null;
  started_at: string | null;
  next_start_at: string | null;
  last_exit_code: number | null;
  last_exit_signal: string | null;
  last_exit_at: string | null;
  /** Restarts after a crash in the current streak; back to 0 once it stays up. */
  restarts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type NewService = {
  workspace_id: string;
  name: string;
  command: string;
  cwd: string;
  description?: string | null;
  env?: Record<string, string> | null;
  ref?: string | null;
  restart?: RestartPolicy;
};

/** What the operator may change after creation. Runtime columns are the supervisor's (`setRuntime`). */
export type ServicePatch = Partial<{
  name: string;
  description: string | null;
  command: string;
  cwd: string;
  env: Record<string, string> | null;
  ref: string | null;
  restart: RestartPolicy;
}>;

export type ServiceRuntime = Partial<Pick<Service,
  "enabled" | "status" | "pid" | "started_at" | "next_start_at" | "last_exit_code" | "last_exit_signal" | "last_exit_at" | "restarts" | "last_error">>;

/** A name is what `mc service <name>` and log file headers use: short, no spaces. */
export const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export function envOf(s: Pick<Service, "env">): Record<string, string> {
  if (!s.env) return {};
  try {
    const o = JSON.parse(s.env);
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

// Column names are interpolated into SQL below, so each write path keeps to its own allowlist.
const DEFINITION_COLS = new Set(["name", "description", "command", "cwd", "env", "ref", "restart"]);
const RUNTIME_COLS = new Set([
  "enabled", "status", "pid", "started_at", "next_start_at", "last_exit_code", "last_exit_signal", "last_exit_at", "restarts", "last_error",
]);

export const services = {
  list(workspaceId?: string | null): Service[] {
    return (workspaceId
      ? db.prepare("SELECT * FROM services WHERE workspace_id=? ORDER BY name").all(workspaceId)
      : db.prepare("SELECT * FROM services ORDER BY workspace_id, name").all()) as Service[];
  },
  get(id: string): Service | undefined {
    return db.prepare("SELECT * FROM services WHERE id=?").get(id) as Service | undefined;
  },
  byName(workspaceId: string, name: string): Service | undefined {
    return db.prepare("SELECT * FROM services WHERE workspace_id=? AND name=?").get(workspaceId, name) as Service | undefined;
  },
  /** Every service whose switch is on — what boot starts. */
  enabled(): Service[] {
    return db.prepare("SELECT * FROM services WHERE enabled=1 ORDER BY created_at").all() as Service[];
  },
  create(n: NewService): Service {
    const id = randomUUID();
    const t = now();
    db.prepare(
      `INSERT INTO services (id,workspace_id,name,description,command,cwd,env,ref,restart,enabled,status,restarts,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,0,'stopped',0,?,?)`,
    ).run(
      id, n.workspace_id, n.name, n.description ?? null, n.command, n.cwd,
      n.env && Object.keys(n.env).length ? JSON.stringify(n.env) : null,
      n.ref ?? null, n.restart ?? "always", t, t,
    );
    return services.get(id)!;
  },
  update(id: string, p: ServicePatch): Service | undefined {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined || !DEFINITION_COLS.has(k)) continue;
      sets.push(`${k}=?`);
      vals.push(k === "env" ? (v && Object.keys(v as object).length ? JSON.stringify(v) : null) : v);
    }
    if (sets.length) {
      sets.push("updated_at=?");
      vals.push(now(), id);
      db.prepare(`UPDATE services SET ${sets.join(",")} WHERE id=?`).run(...vals);
    }
    return services.get(id);
  },
  /** The supervisor's write: only runtime columns, never the definition. */
  setRuntime(id: string, r: ServiceRuntime): void {
    const keys = Object.keys(r).filter((k) => RUNTIME_COLS.has(k) && (r as Record<string, unknown>)[k] !== undefined);
    if (!keys.length) return;
    db.prepare(`UPDATE services SET ${keys.map((k) => `${k}=?`).join(",")},updated_at=? WHERE id=?`)
      .run(...keys.map((k) => (r as Record<string, unknown>)[k]), now(), id);
  },
  delete(id: string): boolean {
    return db.prepare("DELETE FROM services WHERE id=?").run(id).changes > 0;
  },
};
