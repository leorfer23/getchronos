import http from "node:http";
import net from "node:net";
import { CONFIG } from "./config.js";
import { workspaces, egressLog } from "./store.js";
import { bus } from "./bus.js";
import { notify } from "./telegram/api.js";
import { isBlockedIp } from "./net-guard.js";
import { loadBrokerCreds, wsAllowed, type BrokerCred } from "./broker.js";
import { leafFor, caEnv } from "./egress-ca.js";
import { interceptConnect } from "./egress-mitm.js";
import type { Workspace } from "./types.js";

// Per-workspace egress firewall. Each opted-in workspace gets a forward proxy on an ephemeral
// localhost port; agents are pointed at it via HTTP(S)_PROXY env. The proxy audits every outbound
// host and, in `enforce` mode, blocks anything off the allowlist. `enforce` is paired (in sandbox.ts)
// with a Seatbelt rule that denies all direct outbound except localhost — so the agent CANNOT bypass
// the proxy. The daemon itself is unsandboxed, so it can still reach the real upstream on the agent's
// behalf. audit = log-only (allow all). off = no proxy, no env, no lockdown (legacy behavior).

export type EgressMode = "off" | "audit" | "enforce";
export interface EgressCfg { mode: EgressMode; allow: string[]; }

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

// A host matches an allow entry by exact match, subdomain, or a leading-"*." wildcard.
function hostMatches(host: string, entry: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  let e = entry.toLowerCase().trim();
  if (!e) return false;
  if (e.startsWith("*.")) e = e.slice(2);
  return h === e || h.endsWith("." + e);
}

// Hard floor, independent of mode/allowlist: never let a proxied request reach loopback/RFC1918/
// link-local (incl. cloud metadata @169.254.169.254) by IP literal — that's how a workspace's own
// egress "allow" list (e.g. a client API host) could otherwise be abused to pivot into the host
// network. Hostname-based SSRF (DNS rebinding to an allowed name) is a separate, harder problem —
// not handled here.
function isBlockedTarget(host: string): boolean {
  return net.isIP(host) !== 0 && isBlockedIp(host);
}

function isAllowed(host: string, cfg: EgressCfg): boolean {
  if (isBlockedTarget(host)) return false;
  if (cfg.mode === "audit") return true; // audit logs but never blocks
  return [...CONFIG.egress.baseAllow, ...cfg.allow].some((e) => hostMatches(host, e));
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
  // Plain-HTTP proxying (absolute-form request). Rare for coding agents (most egress is HTTPS),
  // handled for completeness. Credential brokering deliberately does NOT happen here: a cred is
  // an https origin (validateCred rejects intercept + insecure_http), so injecting into a
  // cleartext request would put the token on the wire in the clear.
  const server = http.createServer((creq, cres) => {
    let host = "", port = 80, pathQ = "/";
    try {
      const u = new URL(creq.url!.startsWith("http") ? creq.url! : `http://${creq.headers.host}${creq.url}`);
      host = u.hostname; port = Number(u.port || 80); pathQ = u.pathname + u.search;
    } catch { cres.writeHead(400); cres.end("bad request"); return; }
    const cfg = egressCfg(workspaces.get(wsId));
    if (!isAllowed(host, cfg)) { record(wsId, host, port, "deny"); cres.writeHead(403); cres.end("egress blocked by Chronos"); return; }
    record(wsId, host, port, "allow");
    const preq = http.request({ host, port, method: creq.method, path: pathQ, headers: creq.headers }, (pres) => {
      cres.writeHead(pres.statusCode || 502, pres.headers); pres.pipe(cres);
    });
    preq.on("error", () => { try { cres.writeHead(502); cres.end("upstream error"); } catch {} });
    creq.pipe(preq);
  });

  // HTTPS (and any TCP) via CONNECT tunnel — the common path. We only see host:port, never plaintext.
  server.on("connect", (creq, socket, head) => {
    const [host, portStr] = String(creq.url || "").split(":");
    const port = Number(portStr || 443);
    const ws = workspaces.get(wsId);
    const cfg = egressCfg(ws);
    if (!host || !isAllowed(host, cfg)) {
      record(wsId, host || "?", port, "deny");
      try { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); } catch {}
      socket.destroy();
      return;
    }
    record(wsId, host, port, "allow");

    // Opted-in host → terminate TLS here and inject the credential. If the CA can't produce a leaf
    // (no openssl, unwritable dir) we fall through to the plain tunnel: the agent loses the
    // credential, not its network.
    const cred = interceptCredFor(ws, host, port);
    if (cred) {
      const leaf = leafFor(host);
      if (leaf) {
        interceptConnect(socket, head, leaf, {
          host, port, cred,
          record: (e) => recordBroker(wsId, host, port, e),
        });
        return;
      }
    }

    const up = net.connect(port, host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => { try { socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch {} socket.destroy(); });
    socket.on("error", () => up.destroy());
  });

  server.on("clientError", (_e, socket) => { try { socket.destroy(); } catch {} });
  return server;
}

function startListener(wsId: string): Promise<Listener | null> {
  return new Promise((resolve) => {
    const server = buildServer(wsId);
    server.on("error", (e) => { console.warn(`[egress] listener error ws=${wsId}:`, (e as any)?.message ?? e); resolve(null); });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
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
  const url = `http://127.0.0.1:${port}`;
  const noProxy = "localhost,127.0.0.1,::1";
  const env: Record<string, string> = {
    HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url, NO_PROXY: noProxy,
    http_proxy: url, https_proxy: url, all_proxy: url, no_proxy: noProxy,
  };
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
