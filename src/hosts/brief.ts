/**
 * `GET /api/hosts/brief`: where work CAN go, for anyone inside a workspace — a Lead deciding whether
 * to pin a worker, a terminal wondering where its helper will land, `mc hosts` without the admin token.
 *
 * The admin `GET /api/hosts` carries every workspace's policy and every computer's inventory. This
 * carries none of it: each computer's name, whether it is up, how much room it has, how much is
 * running there, and whether THIS workspace may run there — the same `ineligible()` verdict placement
 * itself acts on, so "may run" here never disagrees with where the next terminal actually goes.
 */
import express from "express";
import { CONFIG } from "../config.js";
import { hosts, workspaces } from "../store.js";
import { callerScope } from "../authz.js";
import { placementCandidates, placeRequest } from "./candidates.js";
import { admits, headroom, ineligible, type HostCandidate } from "./placement.js";

export type HostBrief = {
  id: string;
  name: string;
  is_brain: boolean;
  online: boolean;
  /** online | offline | draining | disabled. */
  status: HostCandidate["status"];
  /** Free capacity 0-100 (placement's own score), null with no recent reading. */
  headroom: number | null;
  live: number;
  /** Would an agent be admitted there right now (the governor), and if not why. */
  admits: boolean;
  full: string | null;
  /** May the caller's workspace run there (policy, veto, CLI, profile)? null when the caller has no workspace. */
  may_run: boolean | null;
  why_not: string | null;
};

export function hostsBrief(workspaceId: string | null, cands: HostCandidate[] = placementCandidates()): HostBrief[] {
  const counts = hosts.liveSessionCounts();
  const ws = workspaceId ? workspaces.get(workspaceId) : undefined;
  const req = ws ? { ...placeRequest({ workspace_id: ws.id, backend: ws.default_backend || null }, "agent"), fresh: true } : null;
  return cands.map((h) => {
    const a = admits(h, CONFIG.machine);
    const no = req ? ineligible(h, req) : null;
    return {
      id: h.id,
      name: h.name,
      is_brain: h.is_brain,
      online: h.online,
      status: h.status,
      headroom: h.load ? headroom(h, CONFIG.machine) : null,
      live: counts[h.id] ?? 0,
      admits: h.online && a.ok,
      full: !h.online ? "offline" : a.ok ? null : a.reason,
      may_run: req ? !no : null,
      why_not: no?.reason ?? null,
    };
  });
}

/**
 * The route, mounted on `/api` by api.ts. A workspace token answers for its own workspace and only
 * that one; the operator (admin, or a tokenless call from this Mac) may name one with
 * `?workspace=<id|slug>`, or none for the bare list.
 */
export function hostBriefRoutes(cands?: () => HostCandidate[]): express.Router {
  const r = express.Router();
  r.get("/hosts/brief", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const q = typeof req.query.workspace === "string" ? req.query.workspace : "";
    const wsId = scope.ws ?? (q ? (workspaces.get(q) ?? workspaces.getBySlug(q))?.id ?? null : null);
    res.json({ workspace_id: wsId, hosts: hostsBrief(wsId, cands ? cands() : undefined) });
  });
  return r;
}
