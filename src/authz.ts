import crypto from "node:crypto";
import type express from "express";
import { CONFIG } from "./config.js";
import { sessions, workspaces } from "./store.js";
import type { Session } from "./types.js";

// Constant-time token compare (mirrors relay/src/worker.ts) — avoids leaking a secret one byte at
// a time via response-time side channel.
export function tokenOk(got: string | undefined | null, expected: string): boolean {
  if (!got || !expected) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Per-workspace API token (PER-24) — the trust boundary for cross-tenant authz. Every sandboxed
// job/session gets its own workspace's token injected as MC_WORKSPACE_TOKEN (see mcEnv in
// terminal.ts) and `mc` sends it as x-mc-workspace-token on every call. checkScope() 404s any
// :id-keyed request whose resource belongs to a DIFFERENT workspace than the caller's token —
// closing the loopback-reachable gap where an agent sandboxed for workspace A could otherwise
// reach workspace B's tickets/jobs/sessions/runs/attachments/reviews. The admin token (dashboard)
// and requests presenting neither header stay unrestricted, same as before this ticket.
export type CallerScope = { ws: string | null } | null; // { ws: null } = admin/unrestricted; null = invalid token
export function callerScope(req: express.Request): CallerScope {
  if (tokenOk(req.get("x-mc-admin"), CONFIG.adminToken)) return { ws: null };
  const tok = req.get("x-mc-workspace-token");
  if (!tok) return { ws: null };
  const w = workspaces.getByToken(tok);
  return w ? { ws: w.id } : null;
}
// A Lead's credential (LEADS.md) — narrower than the workspace token: it grants exactly one thing
// (typing into another live terminal of its own workspace, see POST /sessions/:id/input in api.ts),
// not the whole workspace surface. `getByLeadToken` does the DB lookup a raw string can't avoid
// (unlike callerScope's admin token, there is no single expected value to timing-safe-compare against).
export type LeadScope = { ws: string; leadId: string } | null;
export function leadScope(req: express.Request): LeadScope {
  const tok = req.get("x-mc-lead");
  if (!tok) return null;
  const s = sessions.getByLeadToken(tok);
  if (!s || s.status !== "live" || s.role !== "lead" || !s.workspace_id) return null;
  return { ws: s.workspace_id, leadId: s.id };
}
/**
 * May this Lead type into that terminal (POST /sessions/:id/input)?
 *
 * Ownership, not neighbourhood: only the terminals the daemon stamped with this Lead's id at spawn.
 * "Any terminal of my workspace" — what this was — made every Lead able to drive every OTHER Lead's
 * workers and the operator's own windows, all peers behind one workspace wall. The workspace check
 * is kept as a second wall: two ways to be wrong, one answer (a 404, so ids can't be probed).
 */
export function leadMayType(
  lead: { ws: string; leadId: string },
  target: Pick<Session, "id" | "workspace_id" | "lead_id">,
): boolean {
  // A Lead's own `lead_id` is null (a Lead may not open a Lead), so this also refuses itself.
  return target.workspace_id === lead.ws && target.lead_id === lead.leadId;
}
// 404 (not 403) so a scoped caller can't distinguish "wrong workspace" from "doesn't exist". Writes
// the response and returns false when the caller should stop (invalid token, or workspace mismatch).
export function checkScope(req: express.Request, res: express.Response, ownerWsId: string | null | undefined): boolean {
  const scope = callerScope(req);
  if (scope === null) { res.status(401).json({ error: "invalid workspace token" }); return false; }
  if (scope.ws !== null && ownerWsId != null && ownerWsId !== scope.ws) {
    res.status(404).json({ error: "not found" });
    return false;
  }
  return true;
}
