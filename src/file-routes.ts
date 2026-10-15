/**
 * HTTP doors of the file shelf (src/shared-files.ts). Handlers, not inline routes, so the workspace
 * wall is tested against the code that actually serves the request (same shape as artifact-routes.ts).
 *
 *  POST   /files                         {name,size,workspace_id?,note?,by?} → the row + `chunk_bytes`
 *  POST   /files/:id/chunk               {offset,data_base64} — append-only, a resent chunk is a no-op
 *  POST   /files/:id/complete            {sha256?} — verified, then it is on the shelf
 *  GET    /files[?workspace=]            newest first; a workspace token sees only its own
 *  GET    /files/:id                     the row (`:id` = id, id prefix, or the file's name)
 *  GET    /files/:id/chunk?offset&length {offset,data_base64,eof}
 *  DELETE /files/:id
 *
 * JSON + base64 both ways rather than raw bodies: a host's `mc` reaches these through the forwarder
 * as an `api` frame, and this is the shape that already travels there unchanged.
 *
 * Every :id route resolves the ref INSIDE the caller's workspace (CLAUDE.md gotcha #4), so another
 * client's token gets the same 404 an unknown id does. Not checkScope: that lets a row with no
 * workspace through to everyone, and a shelf row with no workspace is the operator's own.
 */
import type express from "express";
import { callerScope } from "./authz.js";
import { hosts, workspaces } from "./store.js";
import { forwardedHost } from "./hostlink/brain-link.js";
import {
  CHUNK_BYTES,
  FileError,
  appendChunk,
  beginUpload,
  completeUpload,
  listFiles,
  readChunk,
  removeFile,
  resolveFile,
  sweepFiles,
  type SharedFile,
} from "./shared-files.js";

type Req = express.Request;
type Res = express.Response;

function fail(res: Res, e: unknown): void {
  if (e instanceof FileError) { res.status(e.status).json({ error: e.message }); return; }
  console.error("[files]", e);
  res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
}

/** undefined = the admin scope (every workspace); a string = exactly that one. null = a 401 already written. */
function wall(req: Req, res: Res): { ws: string | undefined } | null {
  const scope = callerScope(req);
  if (scope === null) { res.status(401).json({ error: "invalid workspace token" }); return null; }
  return { ws: scope.ws ?? undefined };
}

/** The row behind :id, or a 404 already written — unknown and other-workspace look the same. */
function load(req: Req, res: Res): SharedFile | null {
  const w = wall(req, res);
  if (!w) return null;
  const f = resolveFile(req.params.id, w.ws);
  if (!f) { res.status(404).json({ error: "not found" }); return null; }
  return f;
}

/** The computer a request came from, by the operator's name for it. */
function fromHost(req: Req): string {
  const id = forwardedHost(req) ?? "local";
  return hosts.get(id)?.name || id;
}

/** POST /files */
export function createRoute(req: Req, res: Res): void {
  const w = wall(req, res);
  if (!w) return;
  const asked: string | null = req.body.workspace_id || null;
  if (w.ws !== undefined && asked && asked !== w.ws) { res.status(404).json({ error: "not found" }); return; }
  const workspaceId = w.ws ?? asked;
  if (workspaceId && !workspaces.get(workspaceId)) { res.status(400).json({ error: "unknown workspace" }); return; }
  try {
    const f = beginUpload({
      workspaceId,
      name: req.body.name,
      size: req.body.size,
      note: req.body.note,
      fromHost: fromHost(req),
      by: req.get("x-mc-agent") || req.body.by || null,
    });
    res.status(201).json({ ...f, chunk_bytes: CHUNK_BYTES });
  } catch (e) {
    fail(res, e);
  }
}

/** GET /files */
export function listRoute(req: Req, res: Res): void {
  const w = wall(req, res);
  if (!w) return;
  sweepFiles();
  const asked = typeof req.query.workspace === "string" && req.query.workspace ? req.query.workspace : undefined;
  if (w.ws !== undefined && asked && asked !== w.ws) { res.json([]); return; }
  res.json(listFiles(w.ws ?? asked));
}

/** GET /files/:id */
export function getRoute(req: Req, res: Res): void {
  const f = load(req, res);
  if (f) res.json(f);
}

/** POST /files/:id/chunk */
export function chunkInRoute(req: Req, res: Res): void {
  const f = load(req, res);
  if (!f) return;
  try {
    const now = appendChunk(f.id, req.body.offset, Buffer.from(req.body.data_base64, "base64"));
    res.json({ id: now.id, received: now.received, size: now.size });
  } catch (e) {
    fail(res, e);
  }
}

/** POST /files/:id/complete */
export async function completeRoute(req: Req, res: Res): Promise<void> {
  const f = load(req, res);
  if (!f) return;
  try {
    res.json(await completeUpload(f.id, req.body?.sha256));
  } catch (e) {
    fail(res, e);
  }
}

/** GET /files/:id/chunk */
export function chunkOutRoute(req: Req, res: Res): void {
  const f = load(req, res);
  if (!f) return;
  try {
    const offset = Number(req.query.offset ?? 0);
    const { bytes, eof } = readChunk(f.id, offset, Number(req.query.length ?? CHUNK_BYTES));
    res.json({ offset, data_base64: bytes.toString("base64"), eof });
  } catch (e) {
    fail(res, e);
  }
}

/** DELETE /files/:id */
export function removeRoute(req: Req, res: Res): void {
  const f = load(req, res);
  if (!f) return;
  removeFile(f.id);
  res.json({ ok: true, id: f.id, name: f.name });
}
