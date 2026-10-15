/**
 * `/api/browser/*` — the HTTP side of `mc browser` (RESOURCES.md → Shared headless browser pool).
 * Handlers, not inline routes, so the tests drive the code that serves the request (same shape as
 * drop-routes.ts).
 *
 *   GET    /browser                this machine's browser + the leases the caller may see
 *   POST   /browser/leases         long-poll (55 s) for a context: { label, ticket?, session_id?, run_id? }
 *   PUT    /browser/leases/:id     heartbeat → { expires_at }
 *   DELETE /browser/leases/:id     release (disposes the context)
 *
 * "This machine" is the caller's (as for `mc heavy`): the brain, or — for a request forwarded from a
 * host — that host, whose browser runs there. Workspace scoping (CLAUDE.md gotcha #4): a lease
 * belongs to the caller's workspace; a workspace token sees, beats and releases only its own
 * workspace's leases (404 otherwise, so ids cannot be probed). The admin token sees all.
 */
import type express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { callerScope } from "../authz.js";
import { forwardedHost } from "../hostlink/brain-link.js";
import { findHost, LOCAL_HOST_ID } from "../hosts/index.js";
import { jobs, runs, sessions } from "../store.js";
import { egressPolicy, egressPort } from "../egress.js";
import { allBrowserPools, browserConfig, findLease, localBrowserPool, remoteBrowserPool, type BrowserPool } from "./browser-pool.js";
import type { BrowserRpc } from "./browser-engine.js";

type Req = express.Request;
type Res = express.Response;

/** How long one lease request parks before answering "still busy" (the brain's heavy-slot poll). */
export const LEASE_WAIT_MS = 55_000;

const LeaseSchema = z.object({
  label: z.string().trim().min(1).max(120).default("mc browser"),
  ticket: z.string().max(64).nullish(),
  session_id: z.string().max(64).nullish(),
  run_id: z.string().max(64).nullish(),
});

type RpcHost = { id: string; browserRpc(args: BrowserRpc): Promise<unknown> };
const isRpcHost = (h: unknown): h is RpcHost => typeof (h as RpcHost)?.browserRpc === "function";

/**
 * The brain's pool. A lease's contexts go through its workspace's egress proxy when that workspace
 * has one running (the same proxy its agents get in HTTP(S)_PROXY): borrowing the daemon's browser
 * must not be a way around an egress lock.
 */
const brainPool = () =>
  localBrowserPool((o) => {
    const port = egressPort(o.workspace_id ?? null);
    return port ? `http://127.0.0.1:${port}` : null;
  });

/** A host's pool; its `open` carries the workspace's egress policy, which the host's own proxy enforces. */
const hostPool = (h: RpcHost) =>
  remoteBrowserPool(h.id, (args) => h.browserRpc(args.op === "open" ? { ...args, egress: egressPolicy(args.workspace_id ?? null) } : args));

/** The pool of the machine the caller runs on, or null after answering the error. */
export function poolForCaller(req: Req, res: Res): BrowserPool | null {
  const fh = forwardedHost(req);
  if (!fh || fh === LOCAL_HOST_ID) return brainPool();
  const h = findHost(fh);
  if (!isRpcHost(h)) {
    res.status(409).json({ error: "the forwarding host is not registered on this brain" });
    return null;
  }
  return hostPool(h);
}

/** The caller's workspace, `null` for admin; undefined after answering 401. */
function scopeOf(req: Req, res: Res): string | null | undefined {
  const s = callerScope(req);
  if (s === null) {
    res.status(401).json({ error: "invalid workspace token" });
    return undefined;
  }
  return s.ws;
}

/** A session or run named on a lease must be the caller's own workspace's (or the lease would end with a stranger). */
function ownerWorkspace(kind: "session" | "run", id: string): string | null | undefined {
  if (kind === "session") {
    const s = sessions.get(id);
    return s ? s.workspace_id ?? null : undefined;
  }
  const r = runs.get(id);
  return r ? jobs.get(r.job_id)?.workspace_id ?? null : undefined;
}

export async function leaseRoute(req: Req, res: Res): Promise<void> {
  const ws = scopeOf(req, res);
  if (ws === undefined) return;
  const parsed = LeaseSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: `invalid request body — ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}` });
    return;
  }
  const b = parsed.data;
  if (ws !== null) {
    for (const [kind, id] of [["session", b.session_id], ["run", b.run_id]] as const) {
      if (id && ownerWorkspace(kind, id) !== ws) {
        res.status(404).json({ error: `${kind} not found` });
        return;
      }
    }
  }
  const pool = poolForCaller(req, res);
  if (!pool) return;
  if (pool.hostId === "local" && !browserConfig().enabled) {
    res.status(503).json({ error: "the shared browser is off on this machine (CHRONOS_BROWSER=off)" });
    return;
  }
  // Minted before the await so the hang-up handler can name this exact place in line (api.ts heavy slots).
  const ticket = b.ticket || randomUUID();
  // RESPONSE close, not request close — see the heavy-slot route for why.
  res.on("close", () => { if (!res.writableEnded) pool.abandon(ticket); });
  const grant = await pool.acquire({ workspace_id: ws, session_id: b.session_id ?? null, run_id: b.run_id ?? null, label: b.label, ticket }, LEASE_WAIT_MS);
  if (res.writableEnded || !res.writable) {
    // Granted to a caller that already hung up: give the context straight back.
    if (grant.granted) void pool.release(grant.lease_id);
    return;
  }
  if (!grant.granted && "error" in grant) {
    res.status(503).json({ granted: false, error: grant.error });
    return;
  }
  res.json({ ...grant, host_id: pool.hostId });
}

/** The lease if the caller may touch it; otherwise answers 404 (wrong workspace reads as missing). */
function leaseFor(req: Req, res: Res) {
  const ws = scopeOf(req, res);
  if (ws === undefined) return null;
  const hit = findLease(String(req.params.id));
  if (!hit || (ws !== null && hit.lease.workspace_id !== ws)) {
    res.status(404).json({ error: "lease not held (released or expired?)" });
    return null;
  }
  return hit;
}

export function beatRoute(req: Req, res: Res): void {
  const hit = leaseFor(req, res);
  if (!hit) return;
  const expires_at = hit.pool.beat(hit.lease.lease_id);
  if (expires_at == null) {
    res.status(404).json({ error: "lease not held (released or expired?)" });
    return;
  }
  res.json({ ok: true, expires_at });
}

export async function releaseRoute(req: Req, res: Res): Promise<void> {
  const hit = leaseFor(req, res);
  if (!hit) return;
  res.json({ released: await hit.pool.release(hit.lease.lease_id) });
}

export function statusRoute(req: Req, res: Res): void {
  const ws = scopeOf(req, res);
  if (ws === undefined) return;
  const pool = poolForCaller(req, res);
  if (!pool) return;
  res.json({
    host_id: pool.hostId,
    browser: browserBlock(pool),
    // Every machine's leases the caller may see: its own workspace's, or (admin) all.
    leases: allBrowserPools().flatMap((p) => p.list(ws)),
  });
}

/** The `browser` block of `GET /machine`: counts and the engine, never another workspace's ids. */
export function browserBlock(pool: BrowserPool) {
  const s = pool.status();
  return {
    enabled: pool.hostId === "local" ? browserConfig().enabled : null,
    engine: s.engine,
    version: s.version,
    pid: s.pid,
    running: s.running,
    in_use: s.in_use,
    cap: s.cap,
    per_ws: s.per_ws,
    waiting: s.waiting,
    idle_stops_at: s.idle_stops_at,
    error: s.error,
  };
}

/** `GET /machine`'s block for the caller's machine (null when it cannot be resolved). */
export function machineBrowserBlock(req: Req): ReturnType<typeof browserBlock> | null {
  const fh = forwardedHost(req);
  if (!fh || fh === LOCAL_HOST_ID) return browserBlock(brainPool());
  const h = findHost(fh);
  return isRpcHost(h) ? browserBlock(hostPool(h)) : null;
}

export function mountBrowserRoutes(api: express.Router): void {
  api.get("/browser", statusRoute);
  api.post("/browser/leases", (req, res) => void leaseRoute(req, res));
  api.put("/browser/leases/:id", beatRoute);
  api.delete("/browser/leases/:id", (req, res) => void releaseRoute(req, res));
}
