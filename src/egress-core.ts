import http from "node:http";
import net from "node:net";
import { isBlockedIp } from "./net-guard.js";

// The egress proxy itself, with no store, no bus and no Telegram — so the same code runs in the
// daemon (egress.ts wires it to the workspace rows, the audit log and the broker) and inside
// `chronos host` (hostd/egress.ts, HOSTS.md → "The per-workspace egress proxy runs on the host"),
// which must never open a Chronos database. Behaviour is exactly what egress.ts had inline.

export type EgressMode = "off" | "audit" | "enforce";
export interface EgressCfg { mode: EgressMode; allow: string[]; }

/**
 * What a host is told about one workspace's egress (spawn/proc specs carry it). The brain's own
 * CHRONOS_EGRESS_BASE_ALLOW travels with it: the host enforces the brain's floor, not its own env.
 */
export type EgressPolicy = { mode: "audit" | "enforce"; allow: string[]; base_allow: string[] };

// A host matches an allow entry by exact match, subdomain, or a leading-"*." wildcard.
export function hostMatches(host: string, entry: string): boolean {
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
export function isBlockedTarget(host: string): boolean {
  return net.isIP(host) !== 0 && isBlockedIp(host);
}

export function isAllowed(host: string, cfg: EgressCfg, baseAllow: readonly string[]): boolean {
  if (isBlockedTarget(host)) return false;
  if (cfg.mode === "audit") return true; // audit logs but never blocks
  return [...baseAllow, ...cfg.allow].some((e) => hostMatches(host, e));
}

export type EgressServerOpts = {
  /** The workspace's policy, read per connection so an edit applies without a restart. */
  cfg: () => EgressCfg;
  baseAllow: () => readonly string[];
  record: (host: string, port: number, action: "allow" | "deny") => void;
  /**
   * Credential brokering (brain only): take over an allowed CONNECT and terminate TLS. Returns true
   * when it did; false leaves the connection to the plain tunnel below.
   */
  intercept?: (socket: net.Socket, head: Buffer, host: string, port: number) => boolean;
};

export function buildEgressServer(o: EgressServerOpts): http.Server {
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
    if (!isAllowed(host, o.cfg(), o.baseAllow())) { o.record(host, port, "deny"); cres.writeHead(403); cres.end("egress blocked by Chronos"); return; }
    o.record(host, port, "allow");
    const preq = http.request({ host, port, method: creq.method, path: pathQ, headers: creq.headers }, (pres) => {
      cres.writeHead(pres.statusCode || 502, pres.headers); pres.pipe(cres);
    });
    preq.on("error", () => { try { cres.writeHead(502); cres.end("upstream error"); } catch {} });
    creq.pipe(preq);
  });

  // HTTPS (and any TCP) via CONNECT tunnel — the common path. We only see host:port, never plaintext.
  server.on("connect", (creq, socket: net.Socket, head: Buffer) => {
    const [host, portStr] = String(creq.url || "").split(":");
    const port = Number(portStr || 443);
    if (!host || !isAllowed(host, o.cfg(), o.baseAllow())) {
      o.record(host || "?", port, "deny");
      try { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); } catch {}
      socket.destroy();
      return;
    }
    o.record(host, port, "allow");
    if (o.intercept?.(socket, head, host, port)) return;

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

/** Listen on an ephemeral loopback port. Null when it cannot (the caller fails open, never strands). */
export function listenLoopback(server: http.Server): Promise<number | null> {
  return new Promise((resolve) => {
    server.once("error", (e) => { console.warn(`[egress] listener error: ${(e as any)?.message ?? e}`); resolve(null); });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : null);
    });
  });
}

/**
 * The env that points an agent at a proxy (claude/cursor honor HTTP(S)_PROXY). NO_PROXY exempts
 * localhost so the agent still reaches the MC API (the brain's loopback, or a host's forwarder).
 */
export function proxyEnv(port: number): Record<string, string> {
  const url = `http://127.0.0.1:${port}`;
  const noProxy = "localhost,127.0.0.1,::1";
  return {
    HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url, NO_PROXY: noProxy,
    http_proxy: url, https_proxy: url, all_proxy: url, no_proxy: noProxy,
  };
}
