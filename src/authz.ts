import crypto from "node:crypto";
import type express from "express";
import { CONFIG } from "./config.js";
import { repos, sessions, workspaces } from "./store.js";
import type { Repo, Session } from "./types.js";
import { forwardedHost } from "./hostlink/brain-link.js";
import { hostPolicy, workspaceDenied } from "./hosts/policy.js";

/** Every admin-gated route's 403 — reads included, so it never claims a GET is a "mutation". */
export const ADMIN_REQUIRED = "admin token required (x-mc-admin)";

// Constant-time token compare (mirrors relay/src/worker.ts) — avoids leaking a secret one byte at
// a time via response-time side channel.
export function tokenOk(got: string | undefined | null, expected: string): boolean {
  if (!got || !expected) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The admin-token gate for every admin-only route (api.ts mounts it; hostRoutes/barRoutes take it). */
export function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (tokenOk(req.get("x-mc-admin"), CONFIG.adminToken)) return next();
  // A Robert (robertToken) is never the operator. A project's Robert: admin inside his own workspace,
  // on the routes he uses. The fleet-wide Robert: reads every workspace, writes only what
  // robert-scope.ts lists. Either way robertGate decides, and says why when it refuses.
  const scope = forwardedHost(req) === null ? robertIdentity(req.get("x-mc-admin")) : null;
  if (scope) {
    const why = robertGate(req, scope);
    if (why === null) return next();
    res.status(403).json({ error: why });
    return;
  }
  res.status(403).json({ error: ADMIN_REQUIRED });
}

// ───────────────────── Robert's credentials: derived, lane-tagged, never the operator's ─────────────────────
// Every workspace has its own Robert (its own profile, brief, thread), and one Robert spans the fleet.
// None of them carries the operator's admin token: each process gets a credential derived from it —
// HMAC(admin token, "robert:<role>:<lane>:<workspace | @fleet>") — so it needs no storage, rotates with
// the admin token, names exactly one workspace (or the fleet), and the server can always tell it from
// the operator's own devices, which hold the token itself. That difference is what the executor's
// approvals stand on (executor.ts): no Robert credential can record or carry out a yes.
//   role  `rw` acts (Desk/web); `ro` only reads (Telegram's propose-and-confirm Robert).
//   lane  which of his processes holds it: `operator` (the conversation with the operator) or `wake`
//         (the daemon's wakes, ask triage, desk watches) — they share a profile, never a credential.
// Sent in the same x-mc-admin header, so his prompts, `mc` and curl habits work unchanged.
export type RobertRole = "rw" | "ro";
export type RobertLane = "operator" | "wake";
export type RobertScope = { ws: string; role: RobertRole; lane: RobertLane };
/** The fleet-wide Robert's credential: every workspace to READ (the operator granted that), robert-scope.ts FLEET_ROBERT_WRITES to write. */
export type FleetScope = { ws: null; role: RobertRole; lane: RobertLane; fleet: true };
export type AnyRobertScope = RobertScope | FleetScope;
/** Never a workspace id (those are UUIDs) — what the fleet-wide Robert's credential names instead of one. */
const FLEET = "@fleet";
const ROLES = ["rw", "ro"] as const;
const LANES = ["operator", "wake"] as const;
export function robertToken(wsId: string | null, role: RobertRole = "rw", lane: RobertLane = "operator"): string {
  return crypto.createHmac("sha256", CONFIG.adminToken).update(`robert:${role}:${lane}:${wsId ?? FLEET}`).digest("hex");
}
const looksDerived = (tok: string | undefined | null): tok is string => !!tok && tok.length === 64 && /^[0-9a-f]+$/.test(tok);
const robertCache = new Map<string, RobertScope>();
/** The workspace a project Robert's token belongs to, or null. Constant-time against every workspace's tokens. */
export function robertScopeOf(tok: string | undefined | null): RobertScope | null {
  if (!looksDerived(tok)) return null;
  const hit = robertCache.get(tok);
  if (hit && workspaces.get(hit.ws)) return hit;
  for (const w of workspaces.list(true)) {
    for (const role of ROLES) {
      for (const lane of LANES) {
        if (tokenOk(tok, robertToken(w.id, role, lane))) {
          const s: RobertScope = { ws: w.id, role, lane };
          robertCache.set(tok, s);
          return s;
        }
      }
    }
  }
  return null;
}
/** The fleet-wide Robert's token → its role and lane, or null. */
export function fleetScopeOf(tok: string | undefined | null): FleetScope | null {
  if (!looksDerived(tok)) return null;
  for (const role of ROLES) {
    for (const lane of LANES) if (tokenOk(tok, robertToken(null, role, lane))) return { ws: null, role, lane, fleet: true };
  }
  return null;
}
/** Any Robert's credential (a project's or the fleet's), or null. */
export function robertIdentity(tok: string | undefined | null): AnyRobertScope | null {
  return robertScopeOf(tok) ?? fleetScopeOf(tok);
}
/** null = allowed; otherwise the refusal, said to the caller. */
type RobertGate = (req: express.Request, scope: AnyRobertScope) => string | null;
let robertGate: RobertGate = () => ADMIN_REQUIRED; // fail closed until api.ts installs the real one
export function setRobertGate(fn: RobertGate): void {
  robertGate = fn;
}
/**
 * The operator's own credential, on this Mac: the admin token itself, not replayed by a host. The
 * only identity that may record or carry out an approval (ledger-routes.ts operatorHand).
 */
export function isOperator(req: express.Request): boolean {
  return forwardedHost(req) === null && tokenOk(req.get("x-mc-admin"), CONFIG.adminToken);
}
/**
 * The operator, or the rw Robert of `wsId` — for handlers that check a privilege inline. `fleet`: the
 * fleet-wide Robert passes too, for the few inline privileges he keeps (typing into a terminal).
 */
export function operatorOrRobertOf(req: express.Request, wsId: string | null | undefined, opts: { fleet?: boolean } = {}): boolean {
  if (tokenOk(req.get("x-mc-admin"), CONFIG.adminToken)) return true;
  if (forwardedHost(req) !== null) return false;
  const rb = robertScopeOf(req.get("x-mc-admin"));
  if (rb) return rb.role === "rw" && !!wsId && rb.ws === wsId;
  const fl = opts.fleet ? fleetScopeOf(req.get("x-mc-admin")) : null;
  return !!fl && fl.role === "rw";
}
/**
 * The operator, or the fleet-wide Robert where he kept the operator's old reach when his raw admin
 * token was taken away (reads; and, with `write`, the rw fleet credential). Never for approvals,
 * secrets or anything that loosens a wall — those stay `isOperator`.
 */
export function operatorOrFleet(req: express.Request, opts: { write?: boolean } = {}): boolean {
  if (isOperator(req)) return true;
  if (forwardedHost(req) !== null) return false;
  const fl = fleetScopeOf(req.get("x-mc-admin"));
  return !!fl && (!opts.write || fl.role === "rw");
}
/**
 * An environment for an agent process, minus the operator's token in any variable that carries it.
 * Robert's fleet-wide process used to be handed the daemon's own env and the raw token; neither may
 * reach a model now — whatever .secrets or launchd puts in the daemon's env.
 */
export function withoutOperatorToken<E extends Record<string, string | undefined>>(env: E): E {
  const out = { ...env } as Record<string, string | undefined>;
  delete out.CHRONOS_ADMIN_TOKEN;
  for (const [k, v] of Object.entries(out)) if (v && CONFIG.adminToken && v.trim() === CONFIG.adminToken) delete out[k];
  return out as E;
}

/**
 * Closing a Desk terminal is the operator's hand only — Desk ✕, phone Kill, or a Telegram ✅ on a
 * proposed kill. Robert, Leads and workers may PROPOSE; they never execute. The positive signal is
 * `x-mc-operator: 1`, which only those three surfaces set (never `mc`, never a Lead credential).
 * Daemon-internal `killSession` (host failover, etc.) does not go through HTTP and is unchanged.
 */
export function operatorMayCloseTerminal(req: express.Request, res: express.Response): boolean {
  if (!tokenOk(req.get("x-mc-admin"), CONFIG.adminToken)) {
    res.status(403).json({
      error: "closing a terminal is operator-only (Desk ✕, phone, or Telegram confirm)",
    });
    return false;
  }
  if (req.get("x-mc-lead") || req.get("x-mc-session") || req.get("x-mc-agent")) {
    res.status(403).json({
      error: "agents may not close terminals — ask the operator (Desk ✕ / phone / Telegram ✅)",
    });
    return false;
  }
  if (req.get("x-mc-operator") !== "1") {
    res.status(403).json({
      error: "closing a terminal needs the operator's hand (Desk ✕, phone, or Telegram ✅)",
    });
    return false;
  }
  return true;
}

// Per-workspace API token (PER-24) — the trust boundary for cross-tenant authz. Every sandboxed
// job/session gets its own workspace's token injected as MC_WORKSPACE_TOKEN (see mcEnv in
// terminal.ts) and `mc` sends it as x-mc-workspace-token on every call. checkScope() 404s any
// :id-keyed request whose resource belongs to a DIFFERENT workspace than the caller's token —
// closing the loopback-reachable gap where an agent sandboxed for workspace A could otherwise
// reach workspace B's tickets/jobs/sessions/runs/attachments/reviews. The admin token (dashboard)
// and requests presenting neither header stay unrestricted, same as before this ticket.
export type CallerScope = { ws: string | null; robert?: RobertRole; fleet?: true } | null; // { ws: null } = admin/unrestricted (or the fleet-wide Robert, who reads every workspace); null = invalid token

// ───────────────────── tokenless requests: the hole in the wall, being closed ─────────────────────
// "No token from this Mac = the operator" let ANY local process — every sandboxed agent included —
// reach every workspace by leaving its token off a curl. Workspaces never mix, so a request now has
// to say who it is. Rolled out in three modes (CHRONOS_TOKENLESS): `allow` (old behaviour), `log`
// (allow, but record every caller so nothing legitimate breaks when it flips), `deny` (refused).

/** Paths a caller may reach with no token at all: liveness, the push key, webhooks with their own secret. */
const TOKENLESS_PUBLIC = [/^\/health$/, /^\/push\/vapid$/, /^\/triggers\/hook\/[^/]+$/];
export type TokenlessSeen = { method: string; path: string; ua: string; n: number; first: string; last: string };
const tokenlessSeen = new Map<string, TokenlessSeen>();
const idSeg = (seg: string) => (/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(seg) || /^[0-9a-f]{8,}$/i.test(seg) || /^\d+$/.test(seg) ? ":id" : seg);
export function tokenlessMode(): "allow" | "log" | "deny" {
  const m = String(process.env.CHRONOS_TOKENLESS ?? CONFIG.tokenlessMode ?? "log").toLowerCase();
  return m === "allow" || m === "deny" ? m : "log";
}
/** Who called with no token, grouped by route shape and client (GET /api/authz/tokenless). */
export function tokenlessReport(): TokenlessSeen[] {
  return [...tokenlessSeen.values()].sort((a, b) => b.n - a.n);
}
export function resetTokenless(): void {
  tokenlessSeen.clear();
}
function noteTokenless(req: express.Request): void {
  const p = (req.path || "/").split("/").map(idSeg).join("/");
  const ua = String(req.get("user-agent") ?? "-").slice(0, 80);
  const key = `${req.method} ${p} ${ua}`;
  const now = new Date().toISOString();
  const cur = tokenlessSeen.get(key);
  if (cur) { cur.n++; cur.last = now; return; }
  if (tokenlessSeen.size >= 500) return; // bounded: a flood of shapes is not worth more memory
  tokenlessSeen.set(key, { method: req.method, path: p, ua, n: 1, first: now, last: now });
  console.warn(`[authz] tokenless request: ${req.method} /api${p} (${ua})${tokenlessMode() === "deny" ? " — refused" : ""}`);
}
/** True when the request names no identity the daemon can check (a WRONG admin token counts as none). */
function isTokenless(req: express.Request): boolean {
  if (tokenOk(req.get("x-mc-admin"), CONFIG.adminToken)) return false;
  if (robertIdentity(req.get("x-mc-admin"))) return false;
  return !req.get("x-mc-workspace-token") && !req.get("x-mc-lead");
}
/**
 * Mounted on the whole API, right after forwardedGate. Forwarded host requests are already never
 * trusted (callerScope); everything else without a token is recorded, and refused in `deny` mode.
 */
export function tokenlessGate(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (forwardedHost(req) !== null) return next();
  // A header is a claim, not an identity: a workspace or Lead token nobody issued is refused outright
  // (any mode) — otherwise `x-mc-lead: x` walked past this gate onto every unscoped route.
  // A read-only Robert (Telegram's) reads, and only reads — his writes are proposals the operator taps.
  const rbo = robertIdentity(req.get("x-mc-admin"));
  if (rbo?.role === "ro" && req.method !== "GET" && req.method !== "HEAD") {
    res.status(403).json({ error: "read-only Robert: propose it, the operator confirms" });
    return;
  }
  if (!tokenOk(req.get("x-mc-admin"), CONFIG.adminToken)) {
    const ws = req.get("x-mc-workspace-token");
    if (ws && !workspaces.getByToken(ws)) { res.status(401).json({ error: "invalid workspace token" }); return; }
    if (req.get("x-mc-lead") && !leadScope(req)) { res.status(401).json({ error: "invalid lead token" }); return; }
  }
  if (!isTokenless(req)) return next();
  if (TOKENLESS_PUBLIC.some((re) => re.test(req.path))) return next();
  const mode = tokenlessMode();
  if (mode === "allow") return next();
  noteTokenless(req);
  if (mode === "deny") {
    res.status(401).json({ error: "token required — x-mc-admin (operator/Robert) or x-mc-workspace-token (agents)" });
    return;
  }
  next();
}
export function callerScope(req: express.Request): CallerScope {
  // A request an agent on ANOTHER computer made through its host's forwarder (HOSTS.md → `mc` on a
  // host). It arrives on loopback because the brain replays it there, and it must never inherit the
  // "no token on loopback = the operator" rule below: that rule is about THIS Mac's processes.
  const forwarded = forwardedHost(req) !== null;
  if (!forwarded && tokenOk(req.get("x-mc-admin"), CONFIG.adminToken)) return { ws: null };
  if (!forwarded) {
    const rb = robertScopeOf(req.get("x-mc-admin"));
    if (rb) return { ws: rb.ws, robert: rb.role };
    // The fleet-wide Robert reads every workspace, as he did with the operator's token; what he may
    // write is still decided route by route (requireAdmin → robert-scope.ts, and inline checks).
    const fl = fleetScopeOf(req.get("x-mc-admin"));
    if (fl) return { ws: null, robert: fl.role, fleet: true };
  }
  const tok = req.get("x-mc-workspace-token");
  // `Origin: null` is a sandboxed iframe (an artifact page, src/artifacts.ts) or a file:// page — a
  // browser context, never one of this Mac's own processes, so it never gets the tokenless pass.
  if (!tok) {
    if (forwarded || req.get("origin") === "null") return null;
    // A wrong admin token or none at all: unrestricted only while the rollout allows it (tokenlessGate).
    return tokenlessMode() === "deny" ? null : { ws: null };
  }
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
 * May this caller open a terminal (POST /sessions)? Null = yes, otherwise the refusal.
 *
 * Opening terminals is the executives' hand: the operator at the Desk and Robert (no workspace token,
 * or the admin one) and a live Lead of that same workspace (its own credential). A plain terminal
 * carries only its workspace token — it used to `mc session new` its own helpers, and did: fans of
 * workers with no `lead_id`, so no one who opened them was woken when they stopped or could steer
 * them. A terminal that needs more hands says so to Robert.
 */
export function spawnRefusal(scope: CallerScope, lead: LeadScope): string | null {
  if (scope === null) return "invalid workspace token";
  if (scope.ws === null) return null;
  if (scope.robert === "rw") return null; // his own workspace: POST /sessions pins workspace_id to scope.ws
  if (lead && lead.ws === scope.ws) return null;
  return "only a Lead, Robert or the operator opens terminals — need more hands? `mc ask-robert`";
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
/** Just "is this a valid identity" (401 when not) — for routes with no one row to own (the machine pool). */
export function checkToken(req: express.Request, res: express.Response): boolean {
  if (callerScope(req) === null) { res.status(401).json({ error: "invalid workspace token" }); return false; }
  return true;
}

export function checkScope(req: express.Request, res: express.Response, ownerWsId: string | null | undefined): boolean {
  const scope = callerScope(req);
  if (scope === null) { res.status(401).json({ error: "invalid workspace token" }); return false; }
  // A row with NO workspace (null — an operator session, a ticket-less review) is the operator's:
  // never a workspace token's. `undefined` still means "nothing found", which the route 404s itself.
  if (scope.ws !== null && (ownerWsId === null || (ownerWsId !== undefined && ownerWsId !== scope.ws))) {
    res.status(404).json({ error: "not found" });
    return false;
  }
  return true;
}

/**
 * checkScope for a READ an agent makes on a repo it works in: the owner's workspace, or a workspace
 * the repo was explicitly shared with (repo_shares). Every other workspace token still gets the same
 * 404 checkScope gives. Never use it for a mutation — those stay admin-gated / owner-scoped.
 */
export function checkRepoScope(req: express.Request, res: express.Response, repo: Pick<Repo, "id" | "workspace_id">): boolean {
  const scope = callerScope(req);
  if (scope === null) { res.status(401).json({ error: "invalid workspace token" }); return false; }
  if (scope.ws !== null && !repos.canAccess(repo, scope.ws)) {
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
