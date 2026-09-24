/**
 * HTTP doors of the dream pass (src/dream-pass.ts, src/dream.ts). Handlers, not inline routes, so the
 * workspace wall is tested against the code that actually serves the request.
 *
 * Every `/workspaces/:id/dream/*` route passes checkScope (admin, or that workspace's own token), and
 * every run id is additionally checked against :id inside dream-pass — a run of another workspace is
 * a 404, never a 403. `POST /dream/run` dispatches paid jobs, so it is admin-only.
 */
import type express from "express";
import { CONFIG } from "./config.js";
import { checkScope, tokenOk } from "./authz.js";
import { dreamRuns, workspaces } from "./store.js";
import { applyPlan, dreamBranch, dreamContext, DreamError, publicRun, undoRun, workspaceOf } from "./dream-pass.js";
import { dreamAll, startDream } from "./dream.js";
import type { Workspace } from "./types.js";

type Req = express.Request;
type Res = express.Response;

function walled(req: Req, res: Res): Workspace | null {
  if (!checkScope(req, res, req.params.id)) return null;
  const ws = workspaces.get(req.params.id);
  if (!ws) { res.status(404).json({ error: "workspace not found" }); return null; }
  return ws;
}

function fail(res: Res, e: unknown): void {
  if (e instanceof DreamError) { res.status(e.status).json({ error: e.message, problems: e.problems }); return; }
  console.error("[dream]", e);
  res.status(500).json({ error: (e as Error)?.message ?? String(e) });
}

/** GET /workspaces/:id/dream/context[?run=] — the bundle; opens (or continues) a pass. */
export function contextRoute(req: Req, res: Res): void {
  const ws = walled(req, res);
  if (!ws) return;
  try { res.json(dreamContext(ws, req.query.run ? String(req.query.run) : null)); } catch (e) { fail(res, e); }
}

/** GET /workspaces/:id/dream/branch/:slug — a branch body that does NOT count as a use. */
export function branchRoute(req: Req, res: Res): void {
  const ws = walled(req, res);
  if (!ws) return;
  try { res.type("text/plain").send(dreamBranch(ws, String(req.params.slug))); } catch (e) { fail(res, e); }
}

/** POST /workspaces/:id/dream/apply[?dry=1] — body is the plan. */
export function applyRoute(req: Req, res: Res): void {
  const ws = walled(req, res);
  if (!ws) return;
  try { res.json(applyPlan(ws, req.body, { dry: req.query.dry === "1" })); } catch (e) { fail(res, e); }
}

/** GET /workspaces/:id/dream/runs — recent passes, receipts first, never a snapshot. */
export function runsRoute(req: Req, res: Res): void {
  const ws = walled(req, res);
  if (!ws) return;
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  res.json({ runs: dreamRuns.list(ws.id, limit).map(publicRun) });
}

/** POST /workspaces/:id/dream/runs/:run/undo — put the newest applied pass back. */
export function undoRoute(req: Req, res: Res): void {
  const ws = walled(req, res);
  if (!ws) return;
  try { res.json(publicRun(undoRun(ws, String(req.params.run)))); } catch (e) { fail(res, e); }
}

/**
 * POST /dream/run {workspace?} — dream now, regardless of the slot. With a workspace (id or slug): that
 * one, even if nothing new happened (the backfill of a big inbox). Without: every active workspace.
 */
export function runNowRoute(req: Req, res: Res): void {
  if (!tokenOk(req.get("x-mc-admin"), CONFIG.adminToken)) { res.status(403).json({ error: "dream run is admin-only (it dispatches paid jobs)" }); return; }
  const w = req.body?.workspace ? String(req.body.workspace) : null;
  try {
    if (!w) { res.json({ started: dreamAll("manual", null) }); return; }
    const ws = workspaceOf(w);
    if (!ws) { res.status(404).json({ error: `workspace not found: ${w}` }); return; }
    res.json({ started: [startDream(ws, { source: "manual" })] });
  } catch (e) { fail(res, e); }
}
