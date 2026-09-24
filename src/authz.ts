import crypto from "node:crypto";
import type express from "express";
import { CONFIG } from "./config.js";
import { sessions, workspaces } from "./store.js";
import type { Session } from "./types.js";
import { forwardedHost } from "./hostlink/brain-link.js";
import { hostPolicy, workspaceDenied } from "./hosts/policy.js";

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
  // A request an agent on ANOTHER computer made through its host's forwarder (HOSTS.md → `mc` on a
  // host). It arrives on loopback because the brain replays it there, and it must never inherit the
  // "no token on loopback = the operator" rule below: that rule is about THIS Mac's processes.
  const forwarded = forwardedHost(req) !== null;
  if (!forwarded && tokenOk(req.get("x-mc-admin"), CONFIG.adminToken)) return { ws: null };
  const tok = req.get("x-mc-workspace-token");
  if (!tok) return forwarded ? null : { ws: null };
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

/**
 * Why a forwarded request (HOSTS.md → `mc`, hooks and the sandbox on a host) may not proceed, or null.
 *
 * Pure over lookups so every rule is unit-testable. A request replayed by the brain from a host's
 * forwarder is REMOTE, whatever address it arrives from:
 *  1. it carries a credential the brain issued — a workspace token or a live Lead's token — never
 *     "no token = trusted", which only ever meant a process on THIS Mac;
 *  2. a Lead token is only good from the host that Lead runs on (a token seen from elsewhere was
 *     copied off that machine);
 *  3. a named session (`x-mc-session`, which `mc` sends from MC_SESSION) must exist, be live, run ON
 *     the forwarding host, and belong to the workspace the token is for — an agent on m2 cannot speak
 *     for a terminal on m5, or for one in another workspace;
 *  4. the workspace must not be denied on that host by the brain's policy (lock #1; the host's own
 *     veto is lock #2 and refused the spawn long before this).
 */
export function forwardedRefusal(
  host: string,
  creds: { wsToken: string | null; leadToken: string | null; sessionId: string | null },
  look: {
    wsByToken: (t: string) => { id: string; slug: string } | undefined;
    wsById: (id: string) => { id: string; slug: string } | undefined;
    leadByToken: (t: string) => Pick<Session, "id" | "status" | "workspace_id" | "host_id"> | undefined;
    session: (id: string) => Pick<Session, "id" | "status" | "workspace_id" | "host_id"> | undefined;
    deny: (host: string) => string[];
  },
): { status: number; error: string } | null {
  if (!creds.wsToken && !creds.leadToken) return { status: 401, error: "a request from a host needs the workspace token its session was issued" };
  const ws = creds.wsToken ? look.wsByToken(creds.wsToken) : undefined;
  if (creds.wsToken && !ws) return { status: 401, error: "invalid workspace token" };
  const lead = creds.leadToken ? look.leadByToken(creds.leadToken) : undefined;
  if (creds.leadToken && (!lead || lead.status !== "live")) return { status: 401, error: "invalid lead token" };
  if (lead && lead.host_id !== host) return { status: 403, error: "that lead does not run on this host" };
  if (ws && lead && lead.workspace_id !== ws.id) return { status: 403, error: "workspace token and lead token disagree" };
  const wsId = ws?.id ?? lead?.workspace_id ?? null;
  if (creds.sessionId) {
    const s = look.session(creds.sessionId);
    if (!s || s.status !== "live") return { status: 403, error: "that session is not live" };
    if (s.host_id !== host) return { status: 403, error: "that session does not run on this host" };
    if (s.workspace_id !== wsId) return { status: 403, error: "workspace token does not match that session's workspace" };
  }
  const target = ws ?? (wsId ? look.wsById(wsId) : undefined);
  if (target && workspaceDenied(look.deny(host), target)) return { status: 403, error: `workspace ${target.slug} is not allowed on this host` };
  return null;
}

/**
 * Express gate for forwarded requests, mounted in front of every `/api` route. A request that did not
 * come through a host link passes untouched — this changes nothing for the brain's own agents.
 */
export function forwardedGate(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const host = forwardedHost(req);
  if (!host) return next();
  const why = forwardedRefusal(
    host,
    { wsToken: req.get("x-mc-workspace-token") || null, leadToken: req.get("x-mc-lead") || null, sessionId: req.get("x-mc-session") || null },
    {
      wsByToken: (t) => workspaces.getByToken(t),
      wsById: (id) => workspaces.get(id),
      leadByToken: (t) => sessions.getByLeadToken(t),
      session: (id) => sessions.get(id),
      deny: (h) => hostPolicy(h).deny,
    },
  );
  if (why) {
    console.warn(`[authz] refused a forwarded request from host ${host}: ${why.error} (${req.method} ${req.path})`);
    res.status(why.status).json({ error: why.error });
    return;
  }
  next();
}
