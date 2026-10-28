/**
 * `/api/vpn` — the HTTP side of `mc vpn` (src/vpn.ts).
 *
 *   GET  /vpn        the caller's workspace VPN: state, whether Chronos turned it on, the holds
 *   POST /vpn/up     { session_id | run_id, label? } hold it, turning it on — answers once it is up
 *   POST /vpn/down   { session_id | run_id } drop that hold (it goes off after the last one + grace)
 *
 * Workspace scoping (CLAUDE.md gotcha #4): a workspace token acts on the ONE VPN its own workspace's
 * `vpn_config` names, and a hold must name a session or run of that same workspace (404 otherwise,
 * so ids cannot be probed). The operator (admin token, or no token on this Mac) names the workspace
 * with `workspace`; with no session/run theirs is the hand on the switch — up with no hold (never
 * turned off by Chronos), down right now.
 *
 * Brain only: the VPN this daemon drives is the brain's own, so a request forwarded from another
 * computer is refused rather than flipping a network the caller is not even on.
 */
import type express from "express";
import { z } from "zod";
import { callerScope } from "./authz.js";
import { forwardedHost } from "./hostlink/brain-link.js";
import { LOCAL_HOST_ID } from "./hosts/index.js";
import { jobs, runs, sessions, workspaces } from "./store.js";
import { holderLive, vpnLeases, VpnError, workspaceVpn, type VpnConfig, type VpnHolder } from "./vpn.js";

type Req = express.Request;
type Res = express.Response;

const BodySchema = z.object({
  workspace: z.string().max(64).nullish(),
  session_id: z.string().max(64).nullish(),
  run_id: z.string().max(64).nullish(),
  label: z.string().trim().max(120).nullish(),
});

/** The workspace a named session/run belongs to; undefined when there is no such row. */
function ownerWorkspace(kind: "session" | "run", id: string): string | null | undefined {
  if (kind === "session") {
    const s = sessions.get(id);
    return s ? s.workspace_id ?? null : undefined;
  }
  const r = runs.get(id);
  return r ? jobs.get(r.job_id)?.workspace_id ?? null : undefined;
}

type Resolved = { wsId: string; slug: string; config: VpnConfig; holder: VpnHolder | null; operator: boolean };

/** Who is asking, for which workspace's VPN, holding it as what. Null after answering the refusal. */
function resolve(req: Req, res: Res, input: unknown): Resolved | null {
  const fh = forwardedHost(req);
  if (fh && fh !== LOCAL_HOST_ID) {
    res.status(409).json({ error: "the VPN Chronos switches is the brain's — a terminal on another computer cannot use mc vpn" });
    return null;
  }
  const scope = callerScope(req);
  if (scope === null) {
    res.status(401).json({ error: "invalid workspace token" });
    return null;
  }
  const parsed = BodySchema.safeParse(input ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: `invalid request — ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}` });
    return null;
  }
  const b = parsed.data;
  const ref = b.session_id ? { kind: "session" as const, id: b.session_id } : b.run_id ? { kind: "run" as const, id: b.run_id } : null;
  const refWs = ref ? ownerWorkspace(ref.kind, ref.id) : null;
  if (ref && refWs === undefined) {
    res.status(404).json({ error: `${ref.kind} not found` });
    return null;
  }
  // A token's own workspace always wins; the operator names one, or it is the named terminal's/run's.
  const named = b.workspace ? workspaces.get(b.workspace) ?? workspaces.getBySlug(b.workspace) : undefined;
  if (b.workspace && (!named || (scope.ws !== null && named.id !== scope.ws))) {
    res.status(404).json({ error: "workspace not found" });
    return null;
  }
  const wsId = scope.ws ?? named?.id ?? refWs ?? null;
  if (!wsId) {
    res.status(400).json({ error: "which workspace's VPN? pass workspace (mc vpn --workspace <slug>)" });
    return null;
  }
  if (ref && refWs !== wsId) {
    res.status(404).json({ error: `${ref.kind} not found` });
    return null;
  }
  let target: ReturnType<typeof workspaceVpn>;
  try {
    target = workspaceVpn(wsId);
  } catch (e) {
    answerError(res, e);
    return null;
  }
  const namedAs = ref?.kind === "session" ? sessions.get(ref.id)?.title : ref ? jobs.get(runs.get(ref.id)?.job_id ?? "")?.name : undefined;
  const holder: VpnHolder | null = ref
    ? { kind: ref.kind, id: ref.id, workspace_id: wsId, label: b.label || namedAs || "mc vpn", since: new Date().toISOString() }
    : null;
  return { wsId, slug: target.ws.slug, config: target.config, holder, operator: scope.ws === null };
}

function answerError(res: Res, e: unknown): void {
  if (e instanceof VpnError) res.status(e.status).json({ error: e.message });
  else res.status(500).json({ error: String((e as any)?.message ?? e) });
}

export async function upRoute(req: Req, res: Res): Promise<void> {
  const r = resolve(req, res, req.body);
  if (!r) return;
  try {
    if (!r.holder) {
      if (!r.operator) {
        res.status(400).json({ error: "mc vpn up holds the VPN for a terminal or run — run it inside one (MC_SESSION / MC_RUN)" });
        return;
      }
      res.json({ workspace: r.slug, ...(await vpnLeases().operatorUp(r.config)) });
      return;
    }
    if (!holderLive(r.holder)) {
      res.status(409).json({ error: `that ${r.holder.kind} has ended — a hold must belong to a live terminal or a running job` });
      return;
    }
    res.json({ workspace: r.slug, ...(await vpnLeases().acquire(r.config, r.holder)) });
  } catch (e) {
    answerError(res, e);
  }
}

export async function downRoute(req: Req, res: Res): Promise<void> {
  const r = resolve(req, res, req.body);
  if (!r) return;
  try {
    if (!r.holder) {
      if (!r.operator) {
        res.status(400).json({ error: "mc vpn down drops a terminal's or run's hold — run it inside one (MC_SESSION / MC_RUN)" });
        return;
      }
      res.json({ workspace: r.slug, ...(await vpnLeases().forceDown(r.config)) });
      return;
    }
    const released = vpnLeases().release(r.holder.id);
    res.json({ workspace: r.slug, released, ...(await vpnLeases().status(r.config, r.operator ? null : r.wsId)) });
  } catch (e) {
    answerError(res, e);
  }
}

export async function statusRoute(req: Req, res: Res): Promise<void> {
  const scope = callerScope(req);
  // The operator with no workspace named: every workspace that has a VPN set.
  if (scope?.ws === null && !req.query.workspace && !forwardedHost(req)) {
    const out = [];
    for (const w of workspaces.list(false)) {
      let t: ReturnType<typeof workspaceVpn>;
      try { t = workspaceVpn(w.id); } catch { continue; }
      out.push({ workspace: t.ws.slug, ...(await vpnLeases().status(t.config, null)) });
    }
    res.json(out);
    return;
  }
  const r = resolve(req, res, { workspace: typeof req.query.workspace === "string" ? req.query.workspace : undefined });
  if (!r) return;
  res.json({ workspace: r.slug, ...(await vpnLeases().status(r.config, r.operator ? null : r.wsId)) });
}

export function mountVpnRoutes(api: express.Router): void {
  api.get("/vpn", (req, res) => void statusRoute(req, res));
  api.post("/vpn/up", (req, res) => void upRoute(req, res));
  api.post("/vpn/down", (req, res) => void downRoute(req, res));
}
