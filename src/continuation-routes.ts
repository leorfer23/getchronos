/**
 * HTTP doors of continuations (src/continuations.ts, `mc when`). Handlers, not inline routes, so the
 * workspace wall is tested against the code that actually serves the request.
 *
 *  POST /continuations              arm one. A terminal (workspace token) parks only ITS OWN work —
 *                                   the session is its x-mc-session — and is capped (continuations.ts
 *                                   LIMITS). The operator / Robert may park any terminal's work, or
 *                                   none (`workspace_id` + `goal`: a fresh terminal opens when met).
 *  GET  /continuations[?workspace&session&status=armed|all]   newest first; a token sees only its own
 *  GET  /continuations/:id
 *  POST /continuations/:id/fire {evidence}   met because someone says so — any caller of that workspace
 *  POST /continuations/:id/cancel {why}      any caller of that workspace
 *
 * Every :id route checks the row's workspace against the caller's scope (CLAUDE.md gotcha #4), and so
 * do the terminal/ask a new continuation points at: another client's ids are a 404, never a probe.
 */
import type express from "express";
import { callerScope, checkScope, leadScope, spawnRefusal } from "./authz.js";
import { continuations, db, sessions, workspaces, type Continuation } from "./store.js";
import { agentLimits, arm, cancel, fireByHand, parseWhen } from "./continuations.js";
import type { Session } from "./types.js";

type Req = express.Request;
type Res = express.Response;

const id8 = (id: string) => id.slice(0, 8);

/** A session by full id or unique prefix, inside one workspace when the caller is scoped. */
function findSession(ref: string, ws: string | null): Session | undefined {
  const exact = sessions.get(ref);
  if (exact) return exact;
  if (!/^[0-9a-f-]{6,36}$/i.test(ref)) return undefined;
  const hits = db.prepare(`SELECT id FROM sessions WHERE id LIKE ?${ws ? " AND workspace_id = ?" : ""} ORDER BY created_at DESC LIMIT 2`)
    .all(...(ws ? [ref + "%", ws] : [ref + "%"])) as Array<{ id: string }>;
  return hits.length === 1 ? sessions.get(hits[0].id) : undefined;
}

function findAsk(ref: string, ws: string | null): { id: string; workspace_id: string | null } | undefined {
  if (!/^[0-9a-f-]{6,36}$/i.test(ref)) return undefined;
  const hits = db.prepare(`SELECT id, workspace_id FROM asks WHERE id LIKE ?${ws ? " AND workspace_id = ?" : ""} LIMIT 2`)
    .all(...(ws ? [ref + "%", ws] : [ref + "%"])) as Array<{ id: string; workspace_id: string | null }>;
  return hits.length === 1 ? hits[0] : undefined;
}

/** POST /continuations */
export async function createRoute(req: Req, res: Res): Promise<void> {
  const scope = callerScope(req);
  if (scope === null) { res.status(401).json({ error: "invalid workspace token" }); return; }
  const b = req.body ?? {};
  const self = req.get("x-mc-session") || null;
  const sessionRef = b.session_id || self;

  let session: Session | null = null;
  let workspace_id: string | null;
  if (sessionRef) {
    session = findSession(sessionRef, scope.ws) ?? null;
    if (!session) { res.status(404).json({ error: `no terminal matching ${sessionRef}` }); return; }
    if (!checkScope(req, res, session.workspace_id)) return;
    // A terminal parks its own work; parking someone else's is the executives' hand.
    if (scope.ws !== null && session.id !== self) { res.status(403).json({ error: "a terminal parks only its own work — ask Robert to park another terminal's" }); return; }
    workspace_id = session.workspace_id;
  } else {
    const why = spawnRefusal(scope, leadScope(req));
    if (why) { res.status(403).json({ error: `a continuation with no terminal opens one when it fires — ${why}` }); return; }
    workspace_id = b.workspace_id ?? scope.ws;
    if (b.workspace_id && !checkScope(req, res, b.workspace_id)) return;
    if (!b.goal?.trim()) { res.status(400).json({ error: "with no terminal to continue, say what the fresh one should do: goal" }); return; }
  }
  if (!workspace_id || !workspaces.get(workspace_id)) { res.status(400).json({ error: "which workspace? (workspace_id)" }); return; }

  const parsed = parseWhen(b);
  if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
  const spec = parsed.spec;

  // Point at the real row, inside the same wall.
  if (spec.kind === "terminal") {
    const t = findSession(spec.target!, workspace_id);
    if (!t || t.workspace_id !== workspace_id) { res.status(404).json({ error: `no terminal matching ${spec.target} in this workspace` }); return; }
    if (session && t.id === session.id) { res.status(400).json({ error: "a terminal cannot wait on itself" }); return; }
    spec.target = t.id;
    spec.label = `terminal ${id8(t.id)} ${spec.until === "done" ? "finishes" : "ends"}${t.goal ? ` (${t.goal.slice(0, 50)})` : ""}`;
  } else if (spec.kind === "ask") {
    const a = findAsk(spec.target!, workspace_id);
    if (!a || a.workspace_id !== workspace_id) { res.status(404).json({ error: `no ask matching ${spec.target} in this workspace` }); return; }
    spec.target = a.id;
  }

  const round = session ? continuations.firedFor(session.id) + 1 : 1;
  if (scope.ws !== null) {
    const why = agentLimits(spec, { armed: session ? continuations.countArmed({ session_id: session.id }) : 0, round });
    if (why) { res.status(409).json({ error: why }); return; }
  }
  const created_by = scope.ws !== null
    ? `agent:${session?.agent_name || (session ? id8(session.id) : "terminal")}`
    : (b.by?.trim() || "operator");
  try {
    const c = await arm({ workspace_id, session_id: session?.id ?? null, spec, created_by, round });
    res.status(201).json(c);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
}

/** GET /continuations */
export function listRoute(req: Req, res: Res): void {
  const scope = callerScope(req);
  if (scope === null) { res.status(401).json({ error: "invalid workspace token" }); return; }
  const ws = scope.ws ?? ((req.query.workspace as string | undefined) || undefined);
  const status = req.query.status === "all" ? undefined : req.query.status === "done" ? (["fired", "cancelled"] as const) : (["armed", "met"] as const);
  let session_id = (req.query.session as string | undefined) || undefined;
  if (session_id) {
    const s = findSession(session_id, scope.ws);
    if (!s) { res.json([]); return; }
    session_id = s.id;
  }
  res.json(continuations.list({ workspace_id: ws, session_id, status: status as any, limit: Math.min(Number(req.query.limit ?? 100) || 100, 500) }));
}

function load(req: Req, res: Res): Continuation | null {
  const c = continuations.resolve(req.params.id);
  if (!c) { res.status(404).json({ error: "not found" }); return null; }
  if (!checkScope(req, res, c.workspace_id)) return null;
  return c;
}

/** GET /continuations/:id */
export function getRoute(req: Req, res: Res): void {
  const c = load(req, res);
  if (c) res.json(c);
}

const callerLabel = (req: Req, fallback: string | null | undefined) => {
  const self = req.get("x-mc-session");
  return self ? `terminal ${id8(self)}` : (fallback?.trim() || "operator");
};

/** POST /continuations/:id/fire */
export function fireRoute(req: Req, res: Res): void {
  const c = load(req, res);
  if (!c) return;
  if (c.status !== "armed") { res.status(409).json({ error: `already ${c.status}` }); return; }
  fireByHand(c, req.body?.evidence ?? null, callerLabel(req, req.body?.by));
  res.json(continuations.get(c.id));
}

/** POST /continuations/:id/cancel */
export function cancelRoute(req: Req, res: Res): void {
  const c = load(req, res);
  if (!c) return;
  if (c.status !== "armed" && c.status !== "met") { res.status(409).json({ error: `already ${c.status}` }); return; }
  cancel(c, req.body?.why ?? null);
  res.json(continuations.get(c.id));
}
