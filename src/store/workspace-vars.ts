import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";

/**
 * A shared var is one env var the operator hands to every agent in ONE workspace, with an optional
 * shelf life: "here's X_TOKEN for the next 12 hours". See migration 106.
 *
 * It exists because the alternative was pasting the value into a terminal — which puts a live
 * credential in that agent's transcript, in its scrollback, and (once it repeats it back) in a log.
 * Here the value only ever moves daemon → child env, so an agent USES it without ever seeing it.
 *
 * Expiry is enforced on READ, not by a sweeper: `active()` filters, and every read path purges what
 * is past its date, so a lapsed value stops existing rather than sitting on disk waiting for a cron.
 * A null `expires_at` means forever — the same row shape, no second concept.
 */
export type WorkspaceVar = {
  id: string;
  workspace_id: string;
  name: string;
  value: string;
  /** ISO date, or null for no expiry. */
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

/** What the API hands back: everything except the one field that must not travel. */
export type PublicWorkspaceVar = Omit<WorkspaceVar, "value"> & { length: number };

// Names the daemon (or the shell) already owns. Letting one be overridden isn't a policy question,
// it's a broken spawn: a shared PATH takes down every terminal in the workspace at once.
export const RESERVED = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "LANG", "LC_ALL", "TZ", "COLORTERM",
  "PWD", "OLDPWD", "IFS",
]);

/** Same shape a shell demands of an export: uppercase-ish, no spaces, never leading-numeric. */
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Human answer or null if the name is usable. Callers turn it into a 400. */
export function nameError(name: string): string | null {
  if (!NAME_RE.test(name)) return `invalid name '${name}' — use letters, digits and _ (not starting with a digit)`;
  if (RESERVED.has(name.toUpperCase())) return `'${name}' is reserved — overriding it would break every spawn`;
  if (/^MC_/i.test(name)) return `'${name}' is reserved — MC_* is how the daemon tells an agent who it is`;
  return null;
}

/** Hours → an ISO expiry, or null for "no expiration at all". */
export function expiryFromHours(hours: number | null | undefined): string | null {
  if (hours == null) return null;
  return new Date(Date.now() + hours * 3600_000).toISOString();
}

const strip = (v: WorkspaceVar): PublicWorkspaceVar => {
  const { value, ...rest } = v;
  return { ...rest, length: value.length };
};

export const workspaceVars = {
  /** Drop everything past its expiry. Cheap, and every read calls it — see the type doc. */
  purgeExpired(): number {
    return db.prepare("DELETE FROM workspace_vars WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .run(now()).changes;
  },
  /** Live rows for a workspace, values stripped — this is what the dashboard lists. */
  list(workspaceId: string): PublicWorkspaceVar[] {
    workspaceVars.purgeExpired();
    return (db.prepare("SELECT * FROM workspace_vars WHERE workspace_id=? ORDER BY name")
      .all(workspaceId) as WorkspaceVar[]).map(strip);
  },
  get(id: string): WorkspaceVar | undefined {
    return db.prepare("SELECT * FROM workspace_vars WHERE id=?").get(id) as WorkspaceVar | undefined;
  },
  /** name → value for every live var in a workspace. The only path values leave the DB by. */
  active(workspaceId: string): Record<string, string> {
    workspaceVars.purgeExpired();
    const out: Record<string, string> = {};
    for (const r of db.prepare("SELECT name,value FROM workspace_vars WHERE workspace_id=? ORDER BY name")
      .all(workspaceId) as { name: string; value: string }[]) out[r.name] = r.value;
    return out;
  },
  /** Add or replace by (workspace, name) — re-adding a var is how you rotate or re-arm one. */
  set(workspaceId: string, name: string, value: string, expiresAt: string | null): PublicWorkspaceVar {
    const ts = now();
    const existing = db.prepare("SELECT * FROM workspace_vars WHERE workspace_id=? AND name=?")
      .get(workspaceId, name) as WorkspaceVar | undefined;
    if (existing) {
      db.prepare("UPDATE workspace_vars SET value=?, expires_at=?, updated_at=? WHERE id=?")
        .run(value, expiresAt, ts, existing.id);
      return strip({ ...existing, value, expires_at: expiresAt, updated_at: ts });
    }
    const row: WorkspaceVar = {
      id: randomUUID(), workspace_id: workspaceId, name, value,
      expires_at: expiresAt, created_at: ts, updated_at: ts,
    };
    db.prepare(`INSERT INTO workspace_vars (id,workspace_id,name,value,expires_at,created_at,updated_at)
                VALUES (@id,@workspace_id,@name,@value,@expires_at,@created_at,@updated_at)`).run(row);
    return strip(row);
  },
  /** Edit in place. `expires_at: null` clears the expiry (never expires); omit it to leave it alone. */
  patch(id: string, patch: { value?: string; expires_at?: string | null }): PublicWorkspaceVar | undefined {
    const cur = workspaceVars.get(id);
    if (!cur) return undefined;
    const next: WorkspaceVar = {
      ...cur,
      value: patch.value ?? cur.value,
      expires_at: "expires_at" in patch ? patch.expires_at ?? null : cur.expires_at,
      updated_at: now(),
    };
    db.prepare("UPDATE workspace_vars SET value=?, expires_at=?, updated_at=? WHERE id=?")
      .run(next.value, next.expires_at, next.updated_at, id);
    return strip(next);
  },
  remove(id: string): void {
    db.prepare("DELETE FROM workspace_vars WHERE id=?").run(id);
  },
};
