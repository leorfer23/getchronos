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
import { ADMIN_REQUIRED, type AnyRobertScope, type FleetScope, type RobertScope } from "./authz.js";
import { asks, ideas, jots, launches, lessons, repos, reviews, sessions, skills, tickets, watches, workspaces } from "./store.js";
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

// ───────────────────── what no Robert credential may do, whatever the route ─────────────────────
//
// A Robert holding a derived credential must not be able to become the operator by another road. The
// operator's token sits in a file every agent sandbox denies (config.ts sandbox.secrets), so the
// roads are: weaken that sandbox, or have the DAEMON — which runs unsandboxed — read the file or run
// a command for him. These writes would do one or the other, or switch off the gate on a merge, so
// they are the operator's on the Desk, whichever Robert asks. Tightening stays allowed.

const STRICTNESS: Record<string, number> = { off: 0, guard: 1, strict: 2 };
/** Workspace columns no derived credential loosens: the sandbox floor, re-granted secret paths, a secrets file loaded into every agent's env, the profile dir, and the merge gates. */
export const WALL_FIELDS = ["sandbox_mode", "sandbox_allow", "secrets_file", "config_dir", "auto_merge_prs", "merge_gate"] as const;
/** Repo fields the daemon runs as shell commands outside any sandbox (gates.ts runGates, delivery.ts post-merge). */
export const REPO_COMMAND_FIELDS = ["gate_cmds", "verify_cmd", "post_merge_cmd"] as const;
/** Settings no derived credential writes: the executor's own switches, and the workspace columns above. */
const SETTING_COLUMN: Record<string, (typeof WALL_FIELDS)[number]> = {
  "ws.sandbox_mode": "sandbox_mode", "ws.auto_merge_prs": "auto_merge_prs", "ws.merge_gate": "merge_gate",
};
const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const filled = (v: unknown) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length) && !(typeof v === "string" && !v.trim());

/** Why this value of a workspace column loosens a wall (vs what it is now), or null when it does not. */
export function loosens(field: (typeof WALL_FIELDS)[number], value: unknown, current: Record<string, unknown> | null | undefined): string | null {
  switch (field) {
    case "sandbox_mode": {
      const now = String(current?.sandbox_mode ?? "guard");
      return STRICTNESS[String(value)] !== undefined && STRICTNESS[String(value)] >= (STRICTNESS[now] ?? 1) ? null : "a weaker sandbox";
    }
    case "sandbox_allow": return filled(value) ? "secret paths re-granted to agents" : null;
    case "secrets_file": return filled(value) ? "a file loaded into every agent's environment" : null;
    case "config_dir": return current && value === current.config_dir ? null : "another profile directory";
    case "auto_merge_prs": return value === true || value === 1 ? "merges with no one's yes" : null;
    case "merge_gate": return value === false || value === 0 ? "the merge gate off" : null;
  }
}

/**
 * The refusal for a write no Robert credential may make, or null. Checked before any route-level
 * allow-list, for project and fleet Robert alike: it is about what the body DOES, not who may call.
 */
export function derivedWriteRefusal(req: express.Request): string | null {
  if (req.method === "GET" || req.method === "HEAD") return null;
  const pattern = typeof req.route?.path === "string" ? req.route.path : "";
  const body = (req.body ?? {}) as Record<string, unknown>;
  const operatorOnly = (what: string) => `operator-only: ${what} — the operator sets it himself on the Desk (a Robert credential never loosens a wall)`;
  if ((pattern === "/workspaces/:id" && req.method === "PATCH") || (pattern === "/workspaces" && req.method === "POST")) {
    const current = pattern === "/workspaces/:id" ? (workspaces.get(String(req.params?.id ?? "")) as unknown as Record<string, unknown> | undefined) : null;
    for (const f of WALL_FIELDS) {
      if (!has(body, f)) continue;
      // A new workspace needs a profile dir of its own; it is the other columns that would loosen it.
      if (f === "config_dir" && pattern === "/workspaces") continue;
      const why = loosens(f, body[f], current ?? { sandbox_mode: "guard" });
      if (why) return operatorOnly(`${f} (${why})`);
    }
  }
  if ((pattern === "/repos/:id" && req.method === "PATCH") || (pattern === "/workspaces/:id/repos" && req.method === "POST")) {
    for (const f of REPO_COMMAND_FIELDS) if (has(body, f) && filled(body[f])) return operatorOnly(`${f} (the daemon runs it as a shell command, unsandboxed)`);
  }
  if (pattern === "/settings" && (req.method === "PUT" || req.method === "POST")) {
    const key = String(body.key ?? "");
    if (key.startsWith("executor.")) return operatorOnly(`${key} (the executor's switches)`);
    const col = SETTING_COLUMN[key];
    if (col) {
      const wsRef = typeof body.workspace === "string" ? body.workspace : typeof body.workspace_id === "string" ? body.workspace_id : "";
      const w = wsRef ? workspaces.get(wsRef) ?? workspaces.getBySlug(wsRef) : undefined;
      const why = loosens(col, body.value, (w as unknown as Record<string, unknown>) ?? { sandbox_mode: "guard" });
      if (why) return operatorOnly(`${key} (${why})`);
    }
  }
  return null;
}

/**
 * The fleet-wide Robert is the operator's main work surface now (he answers every unscoped turn —
 * thread-router.ts oneRobert, ledger.ts openWorkBlock), and he used to hold the operator's token and
 * run the whole admin surface. So his boundary is a DENY-list, not an allow-list: he keeps the broad
 * write access he had, and loses exactly the routes a model must never reach. The executor's own
 * integrity does NOT lean on this list — recording or carrying out a yes is gated by operatorHand
 * (the token itself), and loosening a wall by derivedWriteRefusal, both independent of it. This set is
 * the rest: the sensitive non-executor writes.
 *
 * On it (operator-only), by why:
 *  - shipping / deciding for him: self-deploy, review approve & merge (he may request changes),
 *    the ledger's own decide/close/verify are operatorHand already.
 *  - a process or command the daemon runs UNSANDBOXED: always-on services, event triggers, connecting
 *    a calendar (the gws CLI, its own OAuth dir) — refresh stays his.
 *  - spending, minting or handing out credentials: shared workspace vars, host join codes, a backend
 *    login, sharing a repo across the wall, the egress policy.
 *  - the operator's OWN surfaces, which a model speaking as him would misuse: his chat with Robert
 *    (/agent*), the clipboard, capture, voice presence/trace, opening things on his screen, quick
 *    actions, thread routing, registering a device for push.
 * A new admin route is his by default — if it belongs to one of the groups above, add it here.
 */
export const FLEET_OPERATOR_ONLY = new Set([
  "POST /self-deploy",
  "POST /reviews/:id/approve", "POST /reviews/:id/merge",
  "POST /services", "PATCH /services/:id", "DELETE /services/:id",
  "POST /services/:id/start", "POST /services/:id/stop", "POST /services/:id/restart",
  "POST /triggers", "PATCH /triggers/:id", "DELETE /triggers/:id",
  "POST /calendars", "PATCH /calendars/:id", "DELETE /calendars/:id", "POST /calendars/ingest", "POST /calendars/import-local",
  "POST /workspaces/:id/vars", "PATCH /workspaces/:id/vars/:varId", "DELETE /workspaces/:id/vars/:varId",
  "POST /repos/:id/shares", "DELETE /repos/:id/shares/:workspaceId",
  "PUT /workspaces/:id/egress",
  "POST /hosts/join-codes",
  "POST /backends/:name/login",
  "POST /agent", "POST /agent/exec/:id", "POST /agent/reset", "POST /agent/heartbeat", "POST /agent/warm", "POST /agent/model",
  "POST /push/subscribe", "DELETE /push/subscribe",
  "POST /voice/presence", "POST /voice/trace",
  "POST /open", "PUT /desk/quick-actions", "POST /thread/sticky",
  "POST /capture/open", "POST /capture/resolve", "DELETE /capture/routes/:key",
  "POST /speak", "POST /transcribe",
]);
/** Admin reads that are the operator's alone, even for the fleet-wide Robert (his clipboard contents). */
export const FLEET_PRIVATE_READS = new Set(["GET /clipboard"]);

/** The fleet-wide Robert on an admin route: null = allowed, else why not. */
export function fleetRefusal(req: express.Request, fl: FleetScope): string | null {
  const pattern = req.route?.path;
  if (typeof pattern !== "string") return ADMIN_REQUIRED;
  const key = `${req.method} ${pattern}`;
  if (req.method === "GET" || req.method === "HEAD") return FLEET_PRIVATE_READS.has(key) ? "the operator's own — not for a Robert" : null;
  if (fl.role === "ro") return "read-only Robert: propose it, the operator confirms";
  // The hard guarantees first (independent of this list), then the sensitive-write deny set.
  const wall = derivedWriteRefusal(req);
  if (wall) return wall;
  return FLEET_OPERATOR_ONLY.has(key) ? `operator-only: ${key} — the operator does this himself (not a Robert credential)` : null;
}

/** A project's Robert on an admin route: null = allowed, else why not. */
export function robertRefusal(req: express.Request, rb: RobertScope): string | null {
  const wall = derivedWriteRefusal(req);
  if (wall) return wall;
  return robertMay(req, rb) ? null : ADMIN_REQUIRED;
}

/** The gate api.ts installs for every Robert credential (authz.ts setRobertGate). */
export function robertGateFor(req: express.Request, scope: AnyRobertScope): string | null {
  return scope.ws === null ? fleetRefusal(req, scope) : robertRefusal(req, scope);
}
