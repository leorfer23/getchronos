/**
 * HTTP doors of the weekly self-retro (src/retro-pass.ts, src/retro.ts). Handlers, not inline routes,
 * so the workspace wall is tested against the code that serves the request.
 *
 *   GET  /workspaces/:id/retro                 the latest week: KPIs vs last week, report, what waits on him
 *   GET  /workspaces/:id/retro/runs            recent runs (no stats, no candidates)
 *   GET  /workspaces/:id/retro/context?run=    the job's bundle — an open run of THIS workspace only
 *   POST /workspaces/:id/retro/apply           the job's rules + notes → pending proposals
 *   POST /workspaces/:id/retro/proposals/:pid  {decision: approve|dismiss, text?} — the operator's hand only
 *   POST /retro/run {workspace?}               run now (admin — it may dispatch paid jobs)
 *
 * Every :id route passes checkScope (the operator, or that workspace's own token), and every run or
 * proposal id is checked against :id inside retro-pass — another workspace's is a 404, never a 403.
 * A decision writes into every prompt of the workspace, so it takes what the ledger's approvals take
 * (ledger-routes.ts operatorHand): his token from this Mac, no agent header, `x-mc-operator: 1`.
 */
import type express from "express";
import { CONFIG } from "./config.js";
import { checkScope, tokenOk } from "./authz.js";
import { workspaces } from "./store.js";
import { retroRuns } from "./store/retro.js";
import { operatorHand } from "./ledger-routes.js";
import { applyRetro, decideProposal, publicRun, retroContext, RetroError, retroView } from "./retro-pass.js";
import { productWorkspace, retroAll, startRetro } from "./retro.js";
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
  if (e instanceof RetroError) { res.status(e.status).json({ error: e.message, problems: e.problems }); return; }
  console.error("[retro]", e);
  res.status(500).json({ error: (e as Error)?.message ?? String(e) });
}

export function showRoute(req: Req, res: Res): void {
  const ws = walled(req, res);
  if (!ws) return;
  res.json(retroView(ws));
}

export function runsRoute(req: Req, res: Res): void {
  const ws = walled(req, res);
  if (!ws) return;
  const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 8));
  res.json({ runs: retroRuns.list(ws.id, limit).map(publicRun) });
}

export function contextRoute(req: Req, res: Res): void {
  const ws = walled(req, res);
  if (!ws) return;
  // Runs open only through startRetro; this door continues one, it never opens one.
  if (!req.query.run) { res.status(400).json({ error: "pass ?run=<id> — the run named in the job's goal" }); return; }
  try { res.json(retroContext(ws, String(req.query.run))); } catch (e) { fail(res, e); }
}

export function applyRoute(req: Req, res: Res): void {
  const ws = walled(req, res);
  if (!ws) return;
  try { res.json(applyRetro(ws, req.body)); } catch (e) { fail(res, e); }
}

export async function decideRoute(req: Req, res: Res): Promise<void> {
  const ws = walled(req, res);
  if (!ws) return;
  if (!operatorHand(req, res)) return;
  const decision = req.body?.decision;
  if (decision !== "approve" && decision !== "dismiss") { res.status(400).json({ error: "decision is approve or dismiss" }); return; }
  const text = typeof req.body?.text === "string" ? req.body.text : null;
  try { res.json(await decideProposal(ws, String(req.params.pid), { decision, by: "operator", text })); } catch (e) { fail(res, e); }
}

export async function runNowRoute(req: Req, res: Res): Promise<void> {
  if (!tokenOk(req.get("x-mc-admin"), CONFIG.adminToken)) { res.status(403).json({ error: "retro run is admin-only (it may dispatch paid jobs)" }); return; }
  const w = req.body?.workspace ? String(req.body.workspace) : null;
  try {
    if (!w) { res.json({ started: await retroAll("manual", null) }); return; }
    const ws = workspaces.get(w) ?? workspaces.getBySlug(w);
    if (!ws) { res.status(404).json({ error: `workspace not found: ${w}` }); return; }
    res.json({ started: [await startRetro(ws, { source: "manual", product: productWorkspace()?.id === ws.id })] });
  } catch (e) { fail(res, e); }
}
