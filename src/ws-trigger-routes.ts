/**
 * HTTP doors of workspace triggers (src/ws-triggers.ts, `mc trigger`). Handlers, not inline routes, so
 * the workspace wall is tested against the code that actually serves the request.
 *
 *  POST   /ws-triggers                 add one. The operator and Robert (that workspace's own, or the
 *                                      fleet-wide one) arm it at once. A terminal's workspace token
 *                                      PROPOSES it: it is saved off, and the operator's on arms it —
 *                                      a trigger opens work with nobody watching.
 *  POST   /ws-triggers/test            dry run of a trigger that is not saved yet (same checks as add)
 *  GET    /ws-triggers[?workspace=]    a workspace token sees only its own workspace's
 *  GET    /ws-triggers/:id             one, with its last fires
 *  PATCH  /ws-triggers/:id {enabled}   off: any caller of that workspace · on: the operator / Robert
 *  POST   /ws-triggers/:id/test        dry run: what it sees now and what each event would do —
 *                                      nothing is written, opened or filed
 *  DELETE /ws-triggers/:id             the operator / Robert
 *
 * Every :id route looks the row up inside the caller's workspace and checks it again (CLAUDE.md gotcha
 * #4): another client's trigger is a 404, never a 403 that confirms it exists. Everything a new
 * trigger names — its repo, its skill — must belong to the workspace it is added to.
 */
import type express from "express";
import { callerScope, checkScope } from "./authz.js";
import { wsTriggers, workspaces, type WsTrigger } from "./store.js";
import {
  LIMITS, createTrigger, draftTrigger, parseTrigger, publicTrigger, resolveTrigger, switchTrigger, testTrigger,
  changedTrigger, type Resolved,
} from "./ws-triggers.js";

type Req = express.Request;
type Res = express.Response;

const id8 = (id: string) => id.slice(0, 8);

/** May this caller arm work nobody watches in `wsId`? The operator (or the fleet-wide Robert), or that workspace's own rw Robert. */
export function mayArm(req: Req, wsId: string): boolean {
  const s = callerScope(req);
  if (!s) return false;
  if (s.ws === null) return s.robert !== "ro";
  return s.robert === "rw" && s.ws === wsId;
}

/** Who did it, for created_by and the paused reason. */
function who(req: Req): string {
  const s = callerScope(req);
  if (s?.robert) return "robert";
  if (s && s.ws !== null) {
    const self = req.get("x-mc-session");
    return `agent:${self ? id8(self) : "terminal"}`;
  }
  return "operator";
}
const whoWords = (req: Req) => who(req).replace(/^agent:/, "terminal ");

/** The body read into a spec and resolved inside the caller's workspace — or the error, answered. */
function readSpec(req: Req, res: Res): { wsId: string; resolved: Extract<Resolved, { ok: true }> } | null {
  const scope = callerScope(req);
  if (scope === null) { res.status(401).json({ error: "invalid workspace token" }); return null; }
  const b = req.body ?? {};
  if (b.workspace_id && !checkScope(req, res, b.workspace_id)) return null;
  const wsId: string | null = scope.ws ?? b.workspace_id ?? null;
  if (!wsId || !workspaces.get(wsId)) { res.status(400).json({ error: "which workspace? (--workspace <id>)" }); return null; }
  const p = parseTrigger(b);
  if (!p.ok) { res.status(400).json({ error: p.error }); return null; }
  const r = resolveTrigger(p.spec, wsId);
  if (!r.ok) { res.status(r.status).json({ error: r.error }); return null; }
  return { wsId, resolved: r };
}

/** POST /ws-triggers */
export function createRoute(req: Req, res: Res): void {
  const s = readSpec(req, res);
  if (!s) return;
  if (wsTriggers.count(s.wsId) >= LIMITS.perWorkspace) {
    res.status(409).json({ error: `this workspace already has ${LIMITS.perWorkspace} triggers — remove one first (mc trigger rm <id>)` });
    return;
  }
  const arm = mayArm(req, s.wsId);
  const t = createTrigger({
    workspace_id: s.wsId,
    resolved: s.resolved,
    created_by: who(req),
    enabled: arm,
    paused_reason: arm ? null : `proposed by ${whoWords(req)} — off until the operator turns it on`,
  });
  res.status(201).json(publicTrigger(t));
}

/** POST /ws-triggers/test */
export async function testSpecRoute(req: Req, res: Res): Promise<void> {
  const s = readSpec(req, res);
  if (!s) return;
  try {
    res.json(await testTrigger(draftTrigger(s.wsId, s.resolved)));
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
}

/** GET /ws-triggers */
export function listRoute(req: Req, res: Res): void {
  const scope = callerScope(req);
  if (scope === null) { res.status(401).json({ error: "invalid workspace token" }); return; }
  const want = typeof req.query.workspace === "string" && req.query.workspace ? req.query.workspace : null;
  if (want && !checkScope(req, res, want)) return;
  res.json(wsTriggers.list({ workspace_id: scope.ws ?? want }).map(publicTrigger));
}

function load(req: Req, res: Res): WsTrigger | null {
  const scope = callerScope(req);
  if (scope === null) { res.status(401).json({ error: "invalid workspace token" }); return null; }
  const t = wsTriggers.resolve(String(req.params.id ?? ""), scope.ws);
  if (!t) { res.status(404).json({ error: "not found" }); return null; }
  if (!checkScope(req, res, t.workspace_id)) return null;
  return t;
}

/** GET /ws-triggers/:id */
export function getRoute(req: Req, res: Res): void {
  const t = load(req, res);
  if (!t) return;
  res.json({ ...publicTrigger(t), fires: wsTriggers.fires(t.id, Math.min(Number(req.query.limit ?? 20) || 20, 100)) });
}

/** PATCH /ws-triggers/:id */
export function patchRoute(req: Req, res: Res): void {
  const t = load(req, res);
  if (!t) return;
  const on = req.body?.enabled === true;
  if (on && !mayArm(req, t.workspace_id)) {
    res.status(403).json({ error: "only the operator or Robert turns a trigger on — it opens work with nobody watching" });
    return;
  }
  if (on === !!t.enabled) { res.json(publicTrigger(t)); return; }
  const why = String(req.body?.why ?? "").trim().slice(0, 300) || `paused by ${whoWords(req)}`;
  res.json(publicTrigger(switchTrigger(t, on, why) ?? t));
}

/** DELETE /ws-triggers/:id */
export function deleteRoute(req: Req, res: Res): void {
  const t = load(req, res);
  if (!t) return;
  if (!mayArm(req, t.workspace_id)) {
    res.status(403).json({ error: "only the operator or Robert removes a trigger — pause it instead (mc trigger pause <id>)" });
    return;
  }
  wsTriggers.remove(t.id);
  changedTrigger({ ...t, enabled: 0 });
  res.json({ ok: true, id: t.id });
}

/** POST /ws-triggers/:id/test */
export async function testRoute(req: Req, res: Res): Promise<void> {
  const t = load(req, res);
  if (!t) return;
  try {
    res.json(await testTrigger(t));
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
}
