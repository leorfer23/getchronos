/**
 * HTTP doors of artifacts (src/artifacts.ts). Handlers, not inline routes, so the workspace wall is
 * tested against the code that actually serves the request (same shape as inbox-routes.ts).
 *
 *  POST /artifacts                      publish — from a terminal (session_id), a run (run_id), or the
 *                                       operator/Robert (workspace_id). With `question` it is an ask.
 *  GET  /artifacts[?workspace&session]  newest first; a workspace token sees only its own
 *  GET  /artifacts/:id                  the row + its events
 *  PUT  /artifacts/:id                  a new version of the page
 *  GET  /artifacts/:id/html[?v=]        the agent's HTML as JSON {html} — never served as a page
 *  GET  /artifacts/:id/frame[?v=]       {html} ready for the viewer's sandboxed srcdoc (CSP + SDK)
 *  POST /artifacts/:id/events           {kind: submit|send, data} — what the page sent back
 *  GET  /artifacts/:id/events[?after&wait_ms]  events after `after`, long-polled up to 55s
 *  PUT  /artifacts/:id/state            {state} — chronos.state.set
 *
 * Every :id route checks the row's workspace against the caller's scope (CLAUDE.md gotcha #4): another
 * client's token gets the same 404 an unknown id does. The page's HTML is only ever returned inside
 * JSON — served as text/html from the daemon's origin it would run with the Desk's origin.
 */
import type express from "express";
import { callerScope, checkScope } from "./authz.js";
import { artifacts, jobs, runs, sessions, workspaces, type Artifact } from "./store.js";
import { askerLabel } from "./ask-robert.js";
import {
  ArtifactError,
  artifactView,
  frameContext,
  frameHtml,
  publishArtifact,
  readVersion,
  sendArtifact,
  setArtifactState,
  submitArtifact,
  updateArtifact,
  waitArtifactEvents,
} from "./artifacts.js";

type Req = express.Request;
type Res = express.Response;

function fail(res: Res, e: unknown): void {
  if (e instanceof ArtifactError) { res.status(e.status).json({ error: e.message }); return; }
  console.error("[artifacts]", e);
  res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
}

/** The row behind :id, or a 404 already written — unknown and other-workspace look the same. */
function load(req: Req, res: Res): Artifact | null {
  const a = artifacts.resolve(req.params.id);
  if (!a) { res.status(404).json({ error: "not found" }); return null; }
  if (!checkScope(req, res, a.workspace_id)) return null;
  return a;
}

const version = (req: Req, a: Artifact): number => (req.query.v != null ? Number(req.query.v) : a.version);

/** POST /artifacts */
export async function createRoute(req: Req, res: Res): Promise<void> {
  const scope = callerScope(req);
  if (scope === null) { res.status(401).json({ error: "invalid workspace token" }); return; }
  const b = req.body;
  let workspace_id: string | null;
  let created_by: string | null;
  if (b.session_id) {
    const s = sessions.get(b.session_id);
    if (!s) { res.status(404).json({ error: "session not found" }); return; }
    if (!checkScope(req, res, s.workspace_id)) return;
    if (b.question && s.status !== "live") { res.status(409).json({ error: "that terminal has ended" }); return; }
    workspace_id = s.workspace_id ?? null;
    created_by = askerLabel(s.id);
  } else if (b.run_id) {
    const r = runs.get(b.run_id);
    if (!r) { res.status(404).json({ error: "run not found" }); return; }
    const job = jobs.get(r.job_id);
    if (!checkScope(req, res, job?.workspace_id)) return;
    workspace_id = job?.workspace_id ?? null;
    created_by = job?.name ?? null;
  } else {
    workspace_id = b.workspace_id ?? scope.ws;
    if (b.workspace_id && !checkScope(req, res, b.workspace_id)) return;
    created_by = b.by ?? (scope.ws === null ? "Robert" : null);
  }
  if (workspace_id && !workspaces.get(workspace_id)) { res.status(404).json({ error: "workspace not found" }); return; }
  try {
    const out = await publishArtifact({
      title: b.title,
      html: b.html,
      workspace_id,
      session_id: b.session_id ?? null,
      run_id: b.run_id ?? null,
      created_by,
      question: b.question ?? null,
      options: b.options ?? null,
      route: b.route,
      notify: !!b.notify,
    });
    res.status(201).json(artifactView(out.artifact));
  } catch (e) {
    fail(res, e);
  }
}

/** GET /artifacts */
export function listRoute(req: Req, res: Res): void {
  const scope = callerScope(req);
  if (scope === null) { res.status(401).json({ error: "invalid workspace token" }); return; }
  const want = typeof req.query.workspace === "string" ? req.query.workspace : null;
  if (want && !checkScope(req, res, want)) return;
  const session = typeof req.query.session === "string" ? req.query.session : null;
  const limit = Number(req.query.limit) || 50;
  const rows = artifacts.list({ workspace_id: scope.ws ?? want, session_id: session, limit });
  res.json(rows.map((a) => ({ ...a, state: undefined })));
}

/** GET /artifacts/:id */
export function getRoute(req: Req, res: Res): void {
  const a = load(req, res);
  if (!a) return;
  res.json({ ...artifactView(a), events: artifacts.events(a.id) });
}

/** PUT /artifacts/:id */
export function updateRoute(req: Req, res: Res): void {
  const a = load(req, res);
  if (!a) return;
  try {
    res.json(artifactView(updateArtifact(a, req.body.html, req.body.title ?? null)));
  } catch (e) {
    fail(res, e);
  }
}

/** GET /artifacts/:id/html */
export function htmlRoute(req: Req, res: Res): void {
  const a = load(req, res);
  if (!a) return;
  try {
    const v = version(req, a);
    res.json({ id: a.id, version: v, html: readVersion(a, v) });
  } catch (e) {
    fail(res, e);
  }
}

/** GET /artifacts/:id/frame */
export function frameRoute(req: Req, res: Res): void {
  const a = load(req, res);
  if (!a) return;
  try {
    const v = version(req, a);
    res.set("Cache-Control", "no-store");
    res.json({ id: a.id, version: v, latest: a.version, title: a.title, status: a.status, html: frameHtml(readVersion(a, v), frameContext(a, v)) });
  } catch (e) {
    fail(res, e);
  }
}

/**
 * POST /artifacts/:id/events. The Desk (admin) speaks as the operator. A workspace token is an AGENT
 * of that client: it may `send`, and may `submit` only to a page that is not a question — a page's ask
 * is answered by whoever it was put to, never by a neighbour terminal that can reach the same API.
 */
export async function eventRoute(req: Req, res: Res): Promise<void> {
  const a = load(req, res);
  if (!a) return;
  const scope = callerScope(req)!;
  const agent = scope.ws !== null;
  const sid = req.get("x-mc-session");
  const by = agent ? `agent:${sid ? askerLabel(sid) : "terminal"}`.slice(0, 80) : req.body.by || "operator";
  try {
    if (req.body.kind === "send") {
      const ev = sendArtifact(a, req.body.data, by);
      res.status(201).json({ event: ev });
      return;
    }
    if (agent && a.ask_id) { res.status(403).json({ error: "this page is a question for the operator — only he answers it" }); return; }
    const out = await submitArtifact(a, req.body.data, by);
    res.status(201).json({ event: out.event, status: out.artifact.status });
  } catch (e) {
    fail(res, e);
  }
}

/** GET /artifacts/:id/events */
export async function eventsRoute(req: Req, res: Res): Promise<void> {
  const a = load(req, res);
  if (!a) return;
  const after = Math.max(0, Number(req.query.after) || 0);
  const waitMs = Math.max(0, Math.min(Number(req.query.wait_ms) || 0, 55_000));
  const events = await waitArtifactEvents(a.id, after, waitMs);
  res.json({ status: artifacts.get(a.id)?.status ?? a.status, events });
}

/** PUT /artifacts/:id/state */
export function stateRoute(req: Req, res: Res): void {
  const a = load(req, res);
  if (!a) return;
  try {
    setArtifactState(a, req.body.state ?? null);
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
}
