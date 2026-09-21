import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { credAllows, resolveSecret, secretUnsafe, type BrokerCred } from "./broker.js";

// TLS interception for the credential broker. When a workspace's proxy sees a CONNECT to a host
// that has a broker credential marked `intercept`, it stops tunnelling and terminates TLS itself
// (with a leaf from src/egress-ca.ts), injects the operator's header, and re-originates a verified
// TLS connection upstream. The agent gets an authenticated channel without the credential ever
// existing inside the sandbox — the same property POST /api/broker/:slug gives, except `git push`
// and plain `curl` get it for free.
//
// What this is NOT: a second firewall. Reachability stays the egress allowlist's job. A request to
// an intercepted host that falls outside the credential's method/path allowlist is forwarded
// UNCHANGED, just without the header — otherwise opting a host in would silently break every other
// use of it (a `git fetch` of some unrelated repo on github.com, a raw.githubusercontent read).
//
// Interception is per-credential opt-in for a reason: it breaks certificate pinning, and it means
// the daemon can read that host's plaintext. Hosts with no `intercept` cred stay opaque tunnels.

export interface InterceptCtx {
  /** Host from the CONNECT line — the only authority on where this connection actually goes. */
  host: string;
  port: number;
  cred: BrokerCred;
  /** Audit hook; called once per intercepted request with what we did and why. */
  record: (e: { method: string; path: string; injected: boolean; why: string; status?: number }) => void;
  /** Test seam: verify upstream against this CA instead of the system roots. */
  upstreamCa?: string;
}

export type Decision =
  | { kind: "inject"; header: string; value: string; path: string; why: string }
  | { kind: "pass"; why: string }
  | { kind: "reject"; status: number; why: string };

// Headers that describe THIS hop and must not be replayed upstream. `transfer-encoding` goes too:
// node's client re-frames the body it is given, and forwarding the old framing header on top of
// that produces a double-encoded request.
const HOP_BY_HOP = [
  "connection", "proxy-connection", "proxy-authorization", "keep-alive",
  "transfer-encoding", "te", "trailer", "upgrade",
];

/**
 * Whether to inject, forward as-is, or refuse — as a pure function, because this is the part that
 * decides where a credential goes and it should be readable and testable without a socket.
 */
export function decideInjection(
  cred: BrokerCred,
  method: string,
  url: string,
  hostHeader: string | undefined,
  connectHost: string,
): Decision {
  // The tunnel target is what we connected to; the Host header is just a string the agent typed.
  // If they disagree the request is trying to be one thing to our policy and another to the
  // upstream, so it does not get to proceed at all — this is the one case worth refusing outright.
  const claimed = String(hostHeader ?? "").trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (claimed && claimed !== connectHost.toLowerCase())
    return { kind: "reject", status: 403, why: `host header ${claimed} does not match the tunnel to ${connectHost}` };

  const check = credAllows(cred, method, url);
  if (!check.ok) return { kind: "pass", why: check.error };

  const secret = resolveSecret(cred);
  // Configured to inject but unable to: fail loudly. Forwarding unauthenticated would surface as a
  // baffling 401 inside the agent, several layers from the actual mistake (an unset secret_env).
  if (!secret)
    return { kind: "reject", status: 503, why: `secret for ${cred.slug} unresolved (is ${cred.secret_env ?? "secret"} set?)` };
  if (secretUnsafe(secret))
    return { kind: "reject", status: 503, why: `secret for ${cred.slug} contains control characters` };

  return {
    kind: "inject",
    header: cred.header,
    value: cred.scheme ? `${cred.scheme} ${secret}` : secret,
    path: check.target,
    why: `broker:${cred.slug}`,
  };
}

function forwardHeaders(src: http.IncomingHttpHeaders, decision: Decision): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.includes(k.toLowerCase())) continue;
    out[k] = v;
  }
  if (decision.kind === "inject") {
    // Drop every case-variant the client may have sent before setting ours: two Authorization
    // headers is undefined behaviour, and which one wins is the upstream's choice, not ours.
    const target = decision.header.toLowerCase();
    for (const k of Object.keys(out)) if (k.toLowerCase() === target) delete out[k];
    out[decision.header] = decision.value;
  }
  return out;
}

// One http.Server for every intercepted connection, wired once. Per-connection state rides in a
// WeakMap keyed by the TLS socket rather than in a closure, so the server is created once and each
// request looks up the tunnel it arrived on.
const ctxOf = new WeakMap<Duplex, InterceptCtx>();
let srv: http.Server | null = null;

function server(): http.Server {
  if (srv) return srv;
  srv = new http.Server();
  srv.on("request", onRequest);
  srv.on("upgrade", onUpgrade);
  srv.on("clientError", (_e, socket) => { try { socket.destroy(); } catch {} });
  return srv;
}

function onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const ctx = ctxOf.get(req.socket);
  if (!ctx) { req.socket.destroy(); return; }
  const method = req.method || "GET";
  const url = req.url || "/";
  const decision = decideInjection(ctx.cred, method, url, req.headers.host, ctx.host);
  ctx.record({
    method, path: url, injected: decision.kind === "inject", why: decision.why,
    status: decision.kind === "reject" ? decision.status : undefined,
  });

  if (decision.kind === "reject") {
    res.writeHead(decision.status, { "content-type": "text/plain" });
    res.end(`chronos broker: ${decision.why}\n`);
    return;
  }
  const preq = https.request({
    hostname: ctx.host,
    port: ctx.port,
    servername: ctx.host,
    method,
    // The injected path is the one credAllows() validated and composed — never the raw string
    // (see the parser-disagreement note in broker.ts).
    path: decision.kind === "inject" ? decision.path : url,
    headers: forwardHeaders(req.headers, decision),
    ...(ctx.upstreamCa ? { ca: ctx.upstreamCa } : {}),
  });
  preq.on("response", (pres) => {
    const headers = { ...pres.headers };
    delete headers["transfer-encoding"]; // our response does its own framing
    delete headers["connection"];
    res.writeHead(pres.statusCode || 502, headers);
    pres.pipe(res);
  });
  preq.on("error", () => {
    if (!res.headersSent) { res.writeHead(502, { "content-type": "text/plain" }); res.end("chronos broker: upstream error\n"); }
    else res.destroy();
  });
  res.on("close", () => preq.destroy());
  req.pipe(preq);
}

// WebSocket & friends. No injection decision is skipped here — an upgrade to an allowed path gets
// the header too — but the body is a raw byte stream once the upstream agrees, so we just splice
// the two sockets together.
function onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
  const ctx = ctxOf.get(socket);
  if (!ctx) { socket.destroy(); return; }
  const method = req.method || "GET";
  const url = req.url || "/";
  const decision = decideInjection(ctx.cred, method, url, req.headers.host, ctx.host);
  ctx.record({
    method, path: url, injected: decision.kind === "inject", why: decision.why,
    status: decision.kind === "reject" ? decision.status : undefined,
  });
  if (decision.kind === "reject") {
    const phrase = decision.status === 403 ? "Forbidden" : "Service Unavailable";
    try { socket.write(`HTTP/1.1 ${decision.status} ${phrase}\r\n\r\nchronos broker: ${decision.why}\n`); } catch {}
    socket.destroy();
    return;
  }
  const headers = forwardHeaders(req.headers, decision);
  headers.connection = "Upgrade";
  headers.upgrade = req.headers.upgrade ?? "websocket";
  const preq = https.request({
    hostname: ctx.host,
    port: ctx.port,
    servername: ctx.host,
    method,
    path: decision.kind === "inject" ? decision.path : url,
    headers,
    ...(ctx.upstreamCa ? { ca: ctx.upstreamCa } : {}),
  });
  preq.on("upgrade", (pres, psock, phead) => {
    const lines = [`HTTP/1.1 ${pres.statusCode} ${pres.statusMessage}`];
    for (const [k, v] of Object.entries(pres.headers))
      for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    // Bytes the upstream already sent past its 101 are upstream OUTPUT: they must be written down
    // to the client. unshift()ing them here would push them into the client socket's READ side, and
    // the pipe below would promptly echo the upstream's own first frame back at it.
    if (phead?.length) socket.write(phead);
    if (head?.length) psock.write(head);
    psock.pipe(socket);
    socket.pipe(psock);
    psock.on("error", () => socket.destroy());
    socket.on("error", () => psock.destroy());
  });
  // An upstream that answers a normal response instead of upgrading: relay the status and close.
  preq.on("response", (pres) => {
    try { socket.write(`HTTP/1.1 ${pres.statusCode} ${pres.statusMessage}\r\n\r\n`); } catch {}
    socket.destroy();
  });
  preq.on("error", () => { try { socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch {} socket.destroy(); });
  preq.end();
}

/**
 * Take over an accepted CONNECT: answer 200, hand the socket a certificate for `ctx.host`, and run
 * the intercepting HTTP server on top of it. The caller has already decided this connection is
 * allowed AND has a usable leaf — if the client refuses our certificate (pinning) the connection
 * simply dies, which is the honest outcome of opting that host in.
 */
export function interceptConnect(
  socket: Duplex,
  head: Buffer | undefined,
  leaf: { key: string; cert: string },
  ctx: InterceptCtx,
): void {
  socket.on("error", () => { try { socket.destroy(); } catch {} });
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head?.length) socket.unshift(head);
  const tsock = new tls.TLSSocket(socket, {
    isServer: true,
    key: leaf.key,
    cert: leaf.cert,
    // No h2: the interception path speaks HTTP/1.1, and a client that negotiated h2 over it would
    // hang. Every client we care about falls back cleanly.
    ALPNProtocols: ["http/1.1"],
  });
  ctxOf.set(tsock, ctx);
  tsock.on("error", () => { try { tsock.destroy(); } catch {} });
  server().emit("connection", tsock);
}

/** Test seam: tear down the shared server so a test run leaves no listener behind. */
export function resetMitmServer(): void {
  try { srv?.close(); } catch {}
  srv = null;
}
