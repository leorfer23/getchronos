import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";

// Tombstones for connector-linked tickets deleted locally on purpose. syncWorkspace consults this
// before mirroring in an external task it doesn't already track, so a human delete stays deleted
// instead of respawning under a new key on the next pull (PER-70).
export const deletedExternals = {
  add(workspaceId: string, connector: string, externalId: string): void {
    db.prepare(
      `INSERT OR IGNORE INTO deleted_externals (id, workspace_id, connector, external_id, deleted_at)
       VALUES (@id, @workspace_id, @connector, @external_id, @deleted_at)`
    ).run({ id: randomUUID(), workspace_id: workspaceId, connector, external_id: externalId, deleted_at: now() });
  },
  has(workspaceId: string, connector: string, externalId: string): boolean {
    return !!db
      .prepare(`SELECT 1 FROM deleted_externals WHERE workspace_id = ? AND connector = ? AND external_id = ?`)
      .get(workspaceId, connector, externalId);
  },
};
