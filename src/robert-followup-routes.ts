/**
 * HTTP doors of Robert's follow-ups (src/robert-followups.ts, `mc robert followup`). Handlers, not
 * inline routes, so the workspace wall is tested against the code that serves the request.
 *
 *  POST /robert/followups {when, note, subject?, workspace_id?}   set one (operator: name the workspace)
 *  GET  /robert/followups[?status=pending|done|all&workspace=]    newest first; his Robert sees only his
 *  POST /robert/followups/:id/cancel {why?}
 *
 * Mounted behind requireAdmin, so a terminal's workspace token never reaches them; robert-scope.ts
 * walls a project's Robert into his own workspace before the handler, and the handler checks again
 * (CLAUDE.md gotcha #4): another workspace's follow-up is a 404, never a probe.
 */
import type express from "express";
import { callerScope } from "./authz.js";
import { continuations, type ContinuationStatus } from "./store.js";
import { cancel } from "./continuations.js";
import { createFollowUp, followUpAccess, followUpView } from "./robert-followups.js";

type Req = express.Request;
type Res = express.Response;

function access(req: Req, res: Res, write: boolean): { ws: string | null } | null {
  const scope = callerScope(req);
  if (scope === null) { res.status(401).json({ error: "invalid token" }); return null; }
  const a = followUpAccess(scope, write);
  if (!a) res.status(403).json({ error: "a follow-up is one workspace's Robert's own: his credential or the operator's token" });
  return a;
}

/** POST /robert/followups */
export async function createRoute(req: Req, res: Res): Promise<void> {
  const a = access(req, res, true);
  if (!a) return;
  const b = req.body ?? {};
  if (a.ws && b.workspace_id && b.workspace_id !== a.ws) { res.status(404).json({ error: "not found" }); return; }
  const ws = a.ws ?? b.workspace_id ?? null;
  if (!ws) { res.status(400).json({ error: "which workspace? (workspace_id)" }); return; }
  try {
    const r = await createFollowUp(ws, b, a.ws ? "robert" : "operator");
    if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
    res.status(201).json(r.followup);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
}

/** GET /robert/followups */
export function listRoute(req: Req, res: Res): void {
  const a = access(req, res, false);
  if (!a) return;
  const ws = a.ws ?? ((req.query.workspace as string | undefined) || undefined);
  const q = req.query.status;
  const status: ContinuationStatus[] | undefined = q === "all" ? undefined : q === "done" ? ["fired", "cancelled"] : ["armed", "met"];
  const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
  res.json(continuations.list({ workspace_id: ws, on_met: "robert", status, limit }).map(followUpView));
}

/** POST /robert/followups/:id/cancel */
export function cancelRoute(req: Req, res: Res): void {
  const a = access(req, res, true);
  if (!a) return;
  const c = continuations.resolve(req.params.id);
  if (!c || c.on_met !== "robert" || (a.ws !== null && c.workspace_id !== a.ws)) { res.status(404).json({ error: "not found" }); return; }
  if (c.status !== "armed" && c.status !== "met") { res.status(409).json({ error: `already ${c.status}` }); return; }
  cancel(c, req.body?.why ?? null);
  res.json(followUpView(continuations.get(c.id)!));
}
