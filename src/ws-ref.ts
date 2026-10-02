/**
 * A workspace reference from an agent or the operator — an id OR a slug (`mc memo --workspace gfm`,
 * `mc pad list --workspace galley`). Most routes take ids only, so a slug used to fall through to
 * "memo not found" / "workspace not found". `wsRefs` resolves it once, at the front of the API router,
 * before any route runs: `/workspaces/<ref>/…`, `?workspace=` / `?workspace_id=` and a JSON body's
 * `workspace_id` are rewritten to the id, and every route's own scope check then runs on the id —
 * nothing downstream ever sees a slug.
 *
 * Security (CLAUDE.md gotcha 4): resolution never widens access. A workspace-token caller only ever
 * has its OWN slug resolved; another workspace's slug is left alone in a query/body (the route treats
 * it as the unknown id it is) and answered "unknown workspace" in a path — the same answer as a slug
 * that does not exist, so a scoped caller cannot probe which slugs exist. Ids pass through untouched,
 * so every existing id-based answer is unchanged. An invalid token is left for the route to 401.
 */
import type express from "express";
import { workspaces } from "./store.js";
import { callerScope } from "./authz.js";
import type { Workspace } from "./types.js";

export function wsByIdOrSlug(ref: unknown): Workspace | undefined {
  if (typeof ref !== "string" || !ref) return undefined;
  return workspaces.get(ref) ?? workspaces.getBySlug(ref);
}

/** The id a slug may be rewritten to for this caller, or null (unknown, or not this caller's). */
function resolveSlug(req: express.Request, ref: string): string | null | "invalid" {
  const scope = callerScope(req);
  if (scope === null) return "invalid";
  const ws = workspaces.getBySlug(ref);
  if (!ws) return null;
  return scope.ws === null || scope.ws === ws.id ? ws.id : null;
}

const PATH = /^\/workspaces\/([^/?#]+)(.*)$/s;
// Values some filters give a meaning of their own (`/analytics?workspace=all`).
const RESERVED = new Set(["all"]);

export function wsRefs(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const m = PATH.exec(req.url);
  if (m) {
    let ref = m[1];
    try { ref = decodeURIComponent(ref); } catch {}
    if (!workspaces.get(ref)) {
      const id = resolveSlug(req, ref);
      if (id === null) { res.status(404).json({ error: `unknown workspace ${ref}` }); return; }
      if (id !== "invalid") req.url = `/workspaces/${encodeURIComponent(id)}${m[2]}`;
    }
  }
  const q = req.query as Record<string, unknown> | undefined;
  for (const k of ["workspace", "workspace_id"]) {
    const v = q?.[k];
    if (typeof v !== "string" || !v || RESERVED.has(v) || workspaces.get(v)) continue;
    const id = resolveSlug(req, v);
    if (id && id !== "invalid") q![k] = id;
  }
  const b = req.body as Record<string, unknown> | undefined;
  const bv = b && typeof b === "object" && !Array.isArray(b) ? b.workspace_id : undefined;
  if (typeof bv === "string" && bv && !workspaces.get(bv)) {
    const id = resolveSlug(req, bv);
    if (id && id !== "invalid") b!.workspace_id = id;
  }
  next();
}
