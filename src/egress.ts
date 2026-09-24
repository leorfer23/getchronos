import type http from "node:http";
import { CONFIG } from "./config.js";
import { workspaces, egressLog } from "./store.js";
import { bus } from "./bus.js";
import { notify } from "./telegram/api.js";
import { loadBrokerCreds, wsAllowed, type BrokerCred } from "./broker.js";
import { leafFor, caEnv } from "./egress-ca.js";
import { interceptConnect } from "./egress-mitm.js";
import { buildEgressServer, listenLoopback, proxyEnv, type EgressCfg, type EgressMode, type EgressPolicy } from "./egress-core.js";
import type { Workspace } from "./types.js";

// Per-workspace egress firewall. Each opted-in workspace gets a forward proxy on an ephemeral
// localhost port; agents are pointed at it via HTTP(S)_PROXY env. The proxy audits every outbound
// host and, in `enforce` mode, blocks anything off the allowlist. `enforce` is paired (in sandbox.ts)
// with a Seatbelt rule that denies all direct outbound except localhost — so the agent CANNOT bypass
// the proxy. The daemon itself is unsandboxed, so it can still reach the real upstream on the agent's
// behalf. audit = log-only (allow all). off = no proxy, no env, no lockdown (legacy behavior).
//
// The proxy itself is store-free in egress-core.ts: a workspace's terminals and runs on ANOTHER
// computer get the same proxy inside `chronos host` (hostd/egress.ts), fed the policy below and
// reporting each connection back here (recordRemote) — HOSTS.md phase 5.

export type { EgressCfg, EgressMode } from "./egress-core.js";

export function egressCfg(ws?: Workspace): EgressCfg {
  if (!ws?.egress_config) return { mode: "off", allow: [] };
  try {
    const c = JSON.parse(ws.egress_config);
    const mode: EgressMode = ["audit", "enforce"].includes(c.mode) ? c.mode : "off";
    return { mode, allow: Array.isArray(c.allow) ? c.allow.map(String) : [] };
  } catch {
    return { mode: "off", allow: [] };
  }
}

// ---- credential brokering -----------------------------------------------------------------
// A host with an `intercept` broker credential stops being an opaque tunnel: the proxy terminates
// TLS and injects the operator's header, so the secret never enters the sandbox (src/egress-mitm.ts).

// loadBrokerCreds() re-reads the file on every call by design, but a `git clone` opens a tunnel per
// connection — memoise briefly so we don't stat the file per CONNECT, while still picking up an
// operator's edit within seconds.
const CREDS_TTL_MS = 5_000;
let credCache: { at: number; creds: BrokerCred[] } | null = null;
function interceptCreds(): BrokerCred[] {
  const t = Date.now();
  if (!credCache || t - credCache.at > CREDS_TTL_MS)
    credCache = { at: t, creds: loadBrokerCreds().filter((c) => c.intercept) };
  return credCache.creds;
}

function splitHostPort(hostPort: string): { host: string; port: number } {
  const m = /^(.*?)(?::(\d+))?$/.exec(String(hostPort).trim());
  return { host: (m?.[1] ?? "").toLowerCase(), port: Number(m?.[2] || 443) };
}

// The credential whose host:port this connection matches and whose workspace list admits this
// workspace, or null. Deliberately does NOT use wsAllowed's null/admin case: proxy traffic always
// belongs to a workspace, so a missing workspace row must narrow a cred's scope, never widen it.
export function interceptCredFor(ws: Workspace | undefined, host: string, port: number): BrokerCred | null {
  if (!ws?.slug) return null;
  const h = host.toLowerCase().replace(/\.$/, "");
  for (const c of interceptCreds()) {
    const t = splitHostPort(c.host);
    if (t.host === h && t.port === port && wsAllowed(c, ws.slug)) return c;
  }
  return null;
}

function hasInterceptCreds(wsId?: string | null): boolean {
  const ws = wsId ? workspaces.get(wsId) : undefined;
  if (!ws?.slug) return false;
  return interceptCreds().some((c) => wsAllowed(c, ws.slug));
}

/** Test seam: forget the memoised broker file. */
export function resetInterceptCache(): void {
  credCache = null;
}

// Per-REQUEST audit for intercepted connections (the outer CONNECT is already recorded). Kept
// separate from record() on purpose: a broker refusal is not an allowlist block, so it must not
// fire the "blocked outbound" Telegram alert with a reason that isn't true.
function recordBroker(wsId: string, host: string, port: number, e: { method: string; path: string; injected: boolean; why: string; status?: number }): void {
  const action = e.status && e.status >= 400 ? "deny" : "allow";
  const verb = e.injected ? "inject" : e.status ? "reject" : "pass";
  const ref = `${verb} ${e.method} ${e.path} · ${e.why}`.slice(0, 200);
  try { egressLog.add({ workspace_id: wsId, host, port, action, ref }); } catch {}
  try { bus.publish({ topic: "egress.event", workspace_id: wsId, host, action }); } catch {}
}

interface Listener { server: http.Server; port: number; }
const listeners = new Map<string, Listener>();
const blockNotifyAt = new Map<string, number>(); // per-ws debounce for Telegram block alerts

function record(wsId: string, host: string, port: number, action: "allow" | "deny"): void {
  try { egressLog.add({ workspace_id: wsId, host, port, action }); } catch {}
  try { bus.publish({ topic: "egress.event", workspace_id: wsId, host, action }); } catch {}
  if (action === "deny") {
    const last = blockNotifyAt.get(wsId) ?? 0;
    const t = Date.now();
    if (t - last > 60_000) {
      blockNotifyAt.set(wsId, t);
      const w = workspaces.get(wsId);
      notify(`🛡️ <b>${w?.name ?? "egress"}</b> blocked outbound → <code>${host}:${port}</code> (not allowlisted)`).catch(() => {});
    }
  }
}

function buildServer(wsId: string): http.Server {
  return buildEgressServer({
    cfg: () => egressCfg(workspaces.get(wsId)),
    baseAllow: () => CONFIG.egress.baseAllow,
    record: (host, port, action) => record(wsId, host, port, action),
    // Opted-in host → terminate TLS here and inject the credential. If the CA can't produce a leaf
    // (no openssl, unwritable dir) we fall through to the plain tunnel: the agent loses the
    // credential, not its network.
    intercept: (socket, head, host, port) => {
      const cred = interceptCredFor(workspaces.get(wsId), host, port);
      if (!cred) return false;
      const leaf = leafFor(host);
      if (!leaf) return false;
      interceptConnect(socket, head, leaf, { host, port, cred, record: (e) => recordBroker(wsId, host, port, e) });
      return true;
    },
  });
}

async function startListener(wsId: string): Promise<Listener | null> {
  const server = buildServer(wsId);
  const port = await listenLoopback(server);
  if (port == null) { try { server.close(); } catch {} return null; }
  server.on("error", (e) => console.warn(`[egress] listener error ws=${wsId}:`, (e as any)?.message ?? e));
  return { server, port };
}

// Reconcile running listeners against the set of workspaces with egress enabled. Idempotent;
// call on boot and after any egress_config change.
export async function syncEgress(): Promise<void> {
  const want = new Set<string>();
  for (const w of workspaces.list()) if (egressCfg(w).mode !== "off") want.add(w.id);
  for (const [id, l] of listeners) if (!want.has(id)) { try { l.server.close(); } catch {} listeners.delete(id); }
  for (const id of want) {
    if (listeners.has(id)) continue;
    const l = await startListener(id);
    if (l) { listeners.set(id, l); console.log(`[egress] ws ${id} proxy on 127.0.0.1:${l.port}`); }
  }
  egressLog.prune(CONFIG.egress.logCap);
}

export async function startEgress(): Promise<void> {
  await syncEgress();
  console.log(`[egress] ready · ${listeners.size} workspace proxy(ies) active`);
}

// Live proxy port for a workspace, or null if it has no running proxy.
export function egressPort(wsId?: string | null): number | null {
  if (!wsId) return null;
  return listeners.get(wsId)?.port ?? null;
}

// Proxy env injected into a workspace's agent processes (claude/cursor honor HTTP(S)_PROXY).
// NO_PROXY exempts localhost so the agent still reaches the MC API directly.
export function egressEnv(wsId?: string | null): Record<string, string> {
  const port = egressPort(wsId);
  if (!port) return {};
  const env: Record<string, string> = proxyEnv(port);
  // Trust the interception CA only where interception can actually happen — a workspace with no
  // intercept credential never sees a certificate of ours, so it has no business trusting one.
  if (hasInterceptCreds(wsId)) Object.assign(env, caEnv());
  return env;
}

// Whether to lock direct outbound (Seatbelt) for a workspace's spawns: only in enforce mode AND
// only when a live proxy exists — never strand an agent with no route out (fail-open on misconfig).
export function egressLocked(wsId?: string | null): boolean {
  if (!wsId) return false;
  if (egressCfg(workspaces.get(wsId)).mode !== "enforce") return false;
  return egressPort(wsId) != null;
}

// ───────────── the proxy on another computer (HOSTS.md phase 5) ─────────────

/**
 * The policy a host's own proxy enforces for this workspace, or null when its egress is off. Sent in
 * every remote spawn: the host keeps no copy of its own, so an edit here reaches the next spawn.
 */
export function egressPolicy(wsId?: string | null): EgressPolicy | null {
  const cfg = egressCfg(wsId ? workspaces.get(wsId) : undefined);
  if (cfg.mode === "off") return null;
  return { mode: cfg.mode, allow: cfg.allow, base_allow: [...CONFIG.egress.baseAllow] };
}

/**
 * Does this workspace's egress need the BRAIN's proxy — i.e. does it broker a credential by
 * intercepting TLS? A host's proxy does not intercept: the broker's premise is that the secret never
 * leaves the process that injects it, and shipping it to another Mac (one an employer may manage) is
 * the opposite of least-credentials. Such a workspace's work stays on the brain.
 */
export function egressBrokered(wsId?: string | null): boolean {
  return egressCfg(wsId ? workspaces.get(wsId) : undefined).mode !== "off" && hasInterceptCreds(wsId);
}

/**
 * Must this workspace's spawns be network-locked to their proxy? `enforce`, wherever the proxy runs.
 * (egressLocked() above additionally requires the BRAIN's listener, because on the brain the lock
 * without a live proxy would strand the agent; a host checks its own proxy before it locks.)
 */
export function egressEnforced(wsId?: string | null): boolean {
  return egressCfg(wsId ? workspaces.get(wsId) : undefined).mode === "enforce";
}

/** One connection a host's proxy saw, into the same audit log / bus / alert a local one uses. */
export function recordRemote(wsId: string, host: string, port: number, action: "allow" | "deny"): void {
  if (!workspaces.get(wsId)) return;
  record(wsId, String(host).slice(0, 255), Number(port) || 0, action === "deny" ? "deny" : "allow");
}
