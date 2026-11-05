/**
 * What a project's Robert may do on an admin route (authz.ts robertToken): the routes his prompts and
 * `mc` actually use, and only on things that belong to HIS workspace. Every other admin route —
 * operator surfaces (settings, the Desk chat, voice, the board, clipboard, quick actions), anything
 * spanning workspaces (shares, all briefs, workspace create/delete, egress, calendars), and the
 * operator's own decisions (review approve/merge, closing terminals, what a terminal may ship) —
 * stays the operator's.
 *
 * Ownership is checked BEFORE the handler: every `:id` the route names is resolved to its workspace
 * (fail closed: unknown owner = refused), and a body `workspace_id` / query `workspace` must be his.
 * Rollups he reads (fleet, costs, report, recovery, watches) are filtered to his workspace by their
 * handlers (callerScope gives him his workspace's scope).
 */
import type express from "express";
import type { RobertScope } from "./authz.js";
import { asks, ideas, jots, launches, lessons, repos, reviews, sessions, skills, tickets, watches } from "./store.js";
import { listStalls } from "./recovery.js";

/** "METHOD /route/:pattern" — Express's req.route.path, as registered in api.ts. */
export const ROBERT_ADMIN_ROUTES = new Set([
  "GET /sessions/:id/outcome/shot/:name", "GET /sessions/:id/media", "GET /sessions/:id/media/file",
  "POST /asks/:id/hold", "POST /reviews/:id/hold", "POST /recovery/:id/hold", "POST /recovery/decide",
  "POST /robert/proactive",
  "PUT /workspaces/:id/brief", "POST /workspaces/:id/brief", "POST /workspaces/:id/worklog/backfill",
  "PATCH /workspaces/:id", "GET /workspaces/:id/sandbox-profile", "POST /workspaces/:id/sync",
  "POST /workspaces/:id/repos", "PATCH /repos/:id", "DELETE /repos/:id", "GET /repos/:id/gates/suggest",
  "PATCH /repos/:id/accel/:tool", "POST /repos/:id/accel/graphify/build",
  "POST /skills/:id/approve", "POST /skills/:id/reject", "POST /skills/:id/archive", "DELETE /skills/:id",
  "POST /nextday", "POST /startday",
  "POST /jots/:id/follow-up/now", "PATCH /jots/:id", "DELETE /jots/:id", "POST /workspaces/:id/jots/reorder", "POST /jots/:id/run",
  "POST /workspaces/:id/launches", "PATCH /launches/:id", "DELETE /launches/:id", "POST /workspaces/:id/launches/reorder", "POST /launches/:id/run",
  "POST /ideas/:id/promote", "POST /ideas/:id/kill", "POST /ideas/kill", "POST /ideas/promote",
  "POST /workspaces/:id/ideas/generate", "POST /tickets/:id/ideas/generate",
  "POST /tickets/:id/push-status", "POST /tickets/:id/push-hours",
  "GET /watches", "POST /watches", "PATCH /watches/:id", "DELETE /watches/:id",
  "GET /recovery", "GET /fleet", "GET /costs", "GET /costs/daily", "GET /report",
  "PATCH /lessons/:id", "DELETE /lessons/:id",
]);

/** The workspace each kind of `:id` belongs to. undefined = not found / not ownable → refused. */
const OWNER: Record<string, (id: string) => string | null | undefined> = {
  workspaces: (id) => id,
  sessions: (id) => sessions.get(id)?.workspace_id,
  asks: (id) => (asks.get(id) ?? asks.findByIdPrefix(id))?.workspace_id,
  tickets: (id) => tickets.get(id)?.workspace_id,
  repos: (id) => repos.get(id)?.workspace_id,
  skills: (id) => skills.get(id)?.workspace_id,
  jots: (id) => jots.get(id)?.workspace_id,
  launches: (id) => launches.get(id)?.workspace_id,
  ideas: (id) => ideas.get(id)?.workspace_id,
  watches: (id) => (watches.get(id) as any)?.workspace_id,
  lessons: (id) => lessons.get(id)?.workspace_id,
  reviews: (id) => {
    const r = reviews.get(id);
    return r?.ticket_id ? tickets.get(r.ticket_id)?.workspace_id : undefined;
  },
  recovery: (id) => listStalls().find((s) => s.id === id)?.workspace_id,
};

/** True when this rw/ro Robert may run this admin route on these resources. */
export function robertMay(req: express.Request, rb: RobertScope): boolean {
  if (rb.role === "ro" && req.method !== "GET" && req.method !== "HEAD") return false;
  const pattern = req.route?.path;
  if (typeof pattern !== "string" || !ROBERT_ADMIN_ROUTES.has(`${req.method} ${pattern}`)) return false;
  // Every :param the route names that identifies a resource must be his.
  const kind = pattern.split("/")[1];
  if (req.params?.id !== undefined) {
    const owner = OWNER[kind]?.(String(req.params.id));
    if (!owner || owner !== rb.ws) return false;
  }
  // What the body or the query names must be his workspace too.
  const body = (req.body ?? {}) as Record<string, any>;
  if (body.workspace_id !== undefined && body.workspace_id !== rb.ws) return false;
  const q = req.query?.workspace;
  if (q !== undefined && q !== rb.ws) return false;
  // Bulk idea actions: every id his.
  if (Array.isArray(body.ids) && !body.ids.every((i: unknown) => ideas.get(String(i))?.workspace_id === rb.ws)) return false;
  // Recovery decide names its stall in the body.
  if (pattern === "/recovery/decide" && listStalls().find((s) => s.id === String(body.id ?? ""))?.workspace_id !== rb.ws) return false;
  // Plan-tomorrow / start-the-day: his workspace and only his.
  if (pattern === "/nextday" || pattern === "/startday") {
    if (Array.isArray(body.workspaces) && body.workspaces.some((w: unknown) => w !== rb.ws)) return false;
    req.body = { ...body, workspaces: [rb.ws] };
  }
  // A watch he creates is on one of his own terminals.
  if (pattern === "/watches" && req.method === "POST" && body.session_id && sessions.get(String(body.session_id))?.workspace_id !== rb.ws) return false;
  return true;
}
