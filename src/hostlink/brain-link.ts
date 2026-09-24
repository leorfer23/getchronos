/**
 * The brain's end of the host link (HOSTS.md → Transport, Security, Reconnect).
 *
 * Two doors lead here, and both need a host token:
 *
 *  - The **dedicated host listener** (`CHRONOS_HOST_LISTEN`, off by default): an HTTPS server with
 *    the brain's self-signed cert. It serves `/host` WebSocket upgrades and nothing else — every
 *    other request is a 404 before any auth runs, so opening a port on the LAN exposes no API.
 *  - **`/host` on the loopback API server**: the Cloudflare tunnel path. cloudflared already
 *    forwards to `127.0.0.1:7777`, so a host reaching the brain from outside the house needs no new
 *    port. A local process can reach this too; it gets nothing without a host token or a join code.
 *
 * What this file does NOT do yet (Phase 3+): place work, spawn remote PTYs, ack/replay data. It keeps
 * the link: who is connected, their hello and vitals, liveness, RPC, and the `mc` forwarder's `api`
 * frames. Everything else in the daemon talks to hosts through the events and methods below.
 */
import http from "node:http";
import https from "node:https";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Duplex } from "node:stream";
import { EventEmitter } from "node:events";
import express from "express";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import {
  MAX_CONTROL_BYTES, PROTOCOL_VERSION, checkCompat, decodeControl, decodeData, encodeControl, encodeData,
  type BrainToHost, type DataFrame, type Hello, type HostToBrain, type HostVitals,
} from "./wire.js";
import { JoinCodes, ensureBrainCert, mintHostCredential, hashToken, legacyHostsFile, type BrainCert } from "./join.js";
import { HostRegistry } from "./registry.js";
import { hostsView } from "./view.js";
import { hosts, workspaces, LOCAL_HOST_ID } from "../store.js";
import type { HostPatch } from "../store/hosts.js";
import { validate, HostPatchSchema } from "../validation.js";
import type { z } from "zod";
import { bus } from "../bus.js";
import { REPO_ROOT } from "../repo-root.js";

export const HOST_PATH = "/host";
/** Ping cadence and the miss count that means "link down" (HOSTS.md: 15s; 2 missed). */
export const PING_MS = 15_000;
export const MISSED_PINGS_DOWN = 2;
/** A connection that authenticates but never says hello is dropped after this. */
const HELLO_TIMEOUT_MS = 10_000;
/** Longest a forwarded `mc` request may take. `mc heavy` long-polls for 55s, so above that. */
const API_TIMEOUT_MS = 70_000;
/** Concurrent forwarded requests per host. A looping agent must not be able to queue unbounded work. */
const API_MAX_INFLIGHT = 32;
const API_MAX_RESPONSE = 16 * 1024 * 1024;

export type LinkVia = "lan" | "tunnel";

/** Remote vitals kept per host for the Desk's sparklines — the same 10 minutes `machine.ts` keeps. */
export const VITALS_KEEP = 120;

export type HostLinkInfo = {
  host_id: string;
  name: string;
  via: LinkVia;
  connected_at: number;
  last_seen_at: number;
  hello: Omit<Hello, "t">;
  vitals: HostVitals | null;
};

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

type Link = {
  id: string;
  name: string;
  ws: WebSocket;
  via: LinkVia;
  connectedAt: number;
  lastSeen: number;
  hello: Hello | null;
  vitals: HostVitals | null;
  missed: number;
  pingN: number;
  pingTimer: NodeJS.Timeout | null;
  helloTimer: NodeJS.Timeout | null;
  pending: Map<string, Pending>;
  apiInflight: number;
  closed: boolean;
};

export type BrainLinkOptions = {
  /** Where hosts and their token hashes live: the `hosts` table. */
  creds?: HostRegistry;
  codes?: JoinCodes;
  pingMs?: number;
  /** Where forwarded `mc` requests go: the daemon's own loopback API. */
  apiTarget?: () => { host: string; port: number };
  /**
   * Is this forwarded request carrying a credential the brain issued? The default checks the
   * workspace token / Lead token against the store. Injected so the link can be tested without a DB.
   */
  verifyCaller?: (headers: Record<string, string>) => boolean | Promise<boolean>;
  /** Public URLs to advertise in join codes (the tunnel). */
  publicUrls?: () => string[];
};

// Headers a host may never set on a forwarded request. The admin token is the dashboard's and never
// crosses to a host; x-mc-host / x-mc-remote / x-mc-forwarded are the brain's own stamps.
const STRIP_REQ = new Set([
  "host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer",
  "content-length", "x-mc-admin", "x-mc-host", "x-mc-session", "x-mc-remote", "x-mc-forwarded", "authorization", "cookie",
  "cf-access-client-id", "cf-access-client-secret", "cf-access-jwt-assertion",
]);
const PASS_RES = new Set(["content-type", "cache-control", "retry-after", "content-disposition", "x-mc-ticket"]);

/**
 * A per-boot secret the brain stamps on every request it forwards, so the API can tell a real
 * forwarded request from a local process that merely typed `x-mc-remote: 1` into curl. Never leaves
 * this process: the host never sees it, and the stamp is stripped from anything a host sends.
 */
const FORWARD_SECRET = crypto.randomBytes(24).toString("base64url");

/**
 * The host id a request was forwarded from, or null for a request that did not come through a host
 * link. What `authz.ts` will key "forwarded = remote" off in Phase 3 (a forwarded request never gets
 * the no-token-on-loopback trust).
 */
export function forwardedHost(req: { get(name: string): string | undefined }): string | null {
  const got = req.get("x-mc-forwarded");
  if (!got) return null;
  const a = Buffer.from(got), b = Buffer.from(FORWARD_SECRET);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return req.get("x-mc-host") || null;
}

async function defaultVerifyCaller(headers: Record<string, string>): Promise<boolean> {
  const ws = headers["x-mc-workspace-token"], lead = headers["x-mc-lead"];
  if (!ws && !lead) return false;
  // Lazy: pulling the store in at module load would open the DB for anything that imports the wire code.
  const { workspaces, sessions } = await import("../store.js");
  if (ws && workspaces.getByToken(ws)) return true;
  if (lead) {
    const s = sessions.getByLeadToken(lead);
    if (s && s.status === "live") return true;
  }
  return false;
}

export class BrainLink extends EventEmitter {
  readonly creds: HostRegistry;
  readonly codes: JoinCodes;
  private readonly pingMs: number;
  private readonly wss: WebSocketServer;
  private readonly links = new Map<string, Link>();
  private listener: https.Server | null = null;
  private listenUrls: string[] = [];
  private cert: BrainCert | null = null;
  /** Last VITALS_KEEP vitals per host. Survives a link blip so a sparkline does not restart on every reconnect. */
  private readonly history = new Map<string, HostVitals[]>();

  constructor(private readonly opts: BrainLinkOptions = {}) {
    super();
    this.creds = opts.creds ?? new HostRegistry();
    this.codes = opts.codes ?? new JoinCodes();
    this.pingMs = opts.pingMs ?? PING_MS;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CONTROL_BYTES });
  }

  // ───────────── events (typed sugar over EventEmitter) ─────────────

  onHostOnline(cb: (info: HostLinkInfo) => void): () => void { return this.sub("online", cb); }
  /** Link down, NOT process dead: a host's PTYs keep running through a Wi-Fi drop. */
  onHostOffline(cb: (hostId: string, reason: string) => void): () => void { return this.sub("offline", cb); }
  onVitals(cb: (hostId: string, v: HostVitals) => void): () => void { return this.sub("vitals", cb); }
  onData(cb: (hostId: string, f: DataFrame) => void): () => void { return this.sub("data", cb); }
  /** Every control frame not handled here (exit, transcript, …) — Phase 3 consumers hang off this. */
  onControl(cb: (hostId: string, f: HostToBrain) => void): () => void { return this.sub("control", cb); }

  private sub(ev: string, cb: (...a: any[]) => void): () => void {
    this.on(ev, cb);
    return () => this.off(ev, cb);
  }

  // ───────────── upgrade handling (both doors) ─────────────

  /**
   * Authenticate a `/host` upgrade and take it over. The caller has already routed by path. Anything
   * without a valid credential is answered 401 and destroyed before a WebSocket exists.
   */
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, via: LinkVia): void {
    const auth = String(req.headers.authorization ?? "");
    const deny = (status = "401 Unauthorized") => {
      try { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch {}
      socket.destroy();
    };
    if (auth.startsWith("Join ")) {
      const r = this.codes.consume(auth.slice(5).trim());
      if (!r.ok) {
        // Never log the code itself — only that one was refused, and why.
        console.warn(`[hostlink] join refused (${r.reason}) from ${req.socket.remoteAddress} via ${via}`);
        return deny();
      }
      // The name the operator typed when minting the code wins; the host's own hostname is the fallback.
      const name = String(r.name || req.headers["x-chronos-host-name"] || "host").slice(0, 64).replace(/[^\w.\- ]/g, "") || "host";
      const cred = mintHostCredential();
      try {
        this.creds.add({ host_id: cred.host_id, name, token_hash: hashToken(cred.token), cert_fp: via === "lan" ? this.cert?.fingerprint ?? null : null, created_at: Date.now() });
      } catch (e: any) {
        // The code is spent either way (single use beats convenience); the operator mints another.
        console.warn(`[hostlink] join accepted but the credential could not be stored: ${e?.message ?? e}`);
        return deny("500 Internal Server Error");
      }
      console.log(`[hostlink] host ${cred.host_id} (${name}) joined via ${via}`);
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(encodeControl({ t: "joined", host_id: cred.host_id, token: cred.token }));
        ws.close(1000, "joined");
      });
      return;
    }
    const m = /^Bearer\s+(\S+)$/.exec(auth);
    const hostId = String(req.headers["x-chronos-host-id"] ?? "");
    const rec = m && hostId ? this.creds.verify(hostId, m[1]) : null;
    if (!rec) {
      console.warn(`[hostlink] host upgrade refused (bad credential${hostId ? ` for ${hostId.slice(0, 16)}` : ""}) from ${req.socket.remoteAddress} via ${via}`);
      return deny();
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.adopt(ws, rec.id, rec.name, via));
  }

  private adopt(ws: WebSocket, id: string, name: string, via: LinkVia): void {
    const link: Link = {
      id, name, ws, via, connectedAt: Date.now(), lastSeen: Date.now(), hello: null, vitals: null,
      missed: 0, pingN: 0, pingTimer: null, helloTimer: null, pending: new Map(), apiInflight: 0, closed: false,
    };
    link.helloTimer = setTimeout(() => this.drop(link, 4408, "no hello"), HELLO_TIMEOUT_MS);
    link.helloTimer.unref?.();
    ws.on("message", (raw: RawData, isBinary: boolean) => this.onMessage(link, raw, isBinary));
    ws.on("close", (code, reason) => this.gone(link, `closed ${code}${reason?.length ? ` ${reason}` : ""}`));
    ws.on("error", (e) => this.gone(link, `error ${e.message}`));
  }

  private onMessage(link: Link, raw: RawData, isBinary: boolean): void {
    link.lastSeen = Date.now();
    if (link.hello) this.creds.seen(link.id, link.lastSeen);
    const buf = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    if (isBinary) {
      if (!link.hello) return this.drop(link, 4400, "data before hello");
      try {
        this.emit("data", link.id, decodeData(buf));
      } catch (e: any) {
        this.drop(link, 4400, `bad data frame: ${e.message}`);
      }
      return;
    }
    let f: HostToBrain;
    try {
      f = decodeControl(buf) as HostToBrain;
    } catch (e: any) {
      return this.drop(link, 4400, `bad control frame: ${e.message}`);
    }
    if (!link.hello && f.t !== "hello") return this.drop(link, 4400, `${f.t} before hello`);
    switch (f.t) {
      case "hello": return this.onHello(link, f);
      case "vitals": {
        const { t: _t, ...v } = f;
        link.vitals = v as HostVitals;
        const hist = this.history.get(link.id) ?? [];
        hist.push(link.vitals);
        if (hist.length > VITALS_KEEP) hist.splice(0, hist.length - VITALS_KEEP);
        this.history.set(link.id, hist);
        this.emit("vitals", link.id, link.vitals);
        return;
      }
      case "ping": this.send(link, { t: "pong", n: f.n }); return;
      case "pong": link.missed = 0; return;
      case "rpc_result": {
        const p = link.pending.get(f.id);
        if (!p) return;
        link.pending.delete(f.id);
        clearTimeout(p.timer);
        if (f.ok) p.resolve(f.value);
        else p.reject(new Error(f.error));
        return;
      }
      case "api": return void this.forwardApi(link, f);
      case "error":
        console.warn(`[hostlink] ${link.id} reported ${f.code}: ${f.message}`);
        if (f.id) {
          const p = link.pending.get(f.id);
          if (p) { link.pending.delete(f.id); clearTimeout(p.timer); p.reject(new Error(`${f.code}: ${f.message}`)); }
        }
        return;
      default:
        this.emit("control", link.id, f);
    }
  }

  private onHello(link: Link, h: Hello): void {
    if (link.hello) return; // a second hello on one link is ignored, not re-announced
    const compat = checkCompat(h.proto);
    if (!compat.ok) {
      this.send(link, { t: "error", code: "version", message: compat.reason });
      return this.drop(link, 4426, "incompatible protocol");
    }
    if (h.host_id !== link.id) {
      this.send(link, { t: "error", code: "identity", message: "hello.host_id does not match the credential" });
      return this.drop(link, 4403, "identity mismatch");
    }
    if (link.helloTimer) { clearTimeout(link.helloTimer); link.helloTimer = null; }
    link.hello = h;
    // The Desk shows the operator's name for a host (set at join, renamed from the Desk); the host's
    // own hostname is kept in its capabilities.
    // One live link per host: a reconnect that beats the old socket's close replaces it.
    const prev = this.links.get(link.id);
    if (prev && prev !== link) this.drop(prev, 4409, "replaced by a newer connection");
    this.links.set(link.id, link);
    this.send(link, { t: "welcome", proto: PROTOCOL_VERSION, host_id: link.id, ping_ms: this.pingMs });
    link.pingTimer = setInterval(() => this.pingTick(link), this.pingMs);
    link.pingTimer.unref?.();
    console.log(`[hostlink] ${link.id} (${link.name}) online via ${link.via} — ${h.platform}/${h.arch}, chronos ${h.version}`);
    try {
      const row = this.creds.hello(link.id, h);
      if (row) link.name = row.name;
    } catch (e: any) {
      console.warn(`[hostlink] ${link.id}: could not record hello: ${e?.message ?? e}`);
    }
    this.pushPolicy(link.id);
    bus.publish({ topic: "host.online", host_id: link.id, name: link.name, via: link.via });
    this.emit("online", this.info(link));
  }

  /**
   * Two pings without a pong = the link is down. That says nothing about the host's processes: a
   * laptop that slept keeps its PTYs, and it comes back with `hello.live[]`.
   */
  private pingTick(link: Link): void {
    if (link.missed >= MISSED_PINGS_DOWN) return this.drop(link, 4000, `link down: ${MISSED_PINGS_DOWN} pings missed`, true);
    link.missed++;
    this.send(link, { t: "ping", n: ++link.pingN });
  }

  private drop(link: Link, code: number, reason: string, terminate = false): void {
    if (link.closed) return;
    try {
      if (terminate) link.ws.terminate();
      else link.ws.close(code, reason);
    } catch {}
    this.gone(link, reason);
  }

  private gone(link: Link, reason: string): void {
    if (link.closed) return;
    link.closed = true;
    if (link.pingTimer) clearInterval(link.pingTimer);
    if (link.helloTimer) clearTimeout(link.helloTimer);
    for (const p of link.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`host ${link.id} link down`)); }
    link.pending.clear();
    if (this.links.get(link.id) !== link) return; // never announced, or already replaced
    this.links.delete(link.id);
    console.log(`[hostlink] ${link.id} (${link.name}) offline — ${reason}`);
    try { this.creds.offline(link.id); } catch (e: any) { console.warn(`[hostlink] ${link.id}: could not record offline: ${e?.message ?? e}`); }
    bus.publish({ topic: "host.offline", host_id: link.id, name: link.name, reason });
    this.emit("offline", link.id, reason);
  }

  private send(link: Link, f: BrainToHost): boolean {
    if (link.closed || link.ws.readyState !== 1) return false;
    try {
      link.ws.send(encodeControl(f));
      return true;
    } catch {
      return false;
    }
  }

  // ───────────── outbound API for the rest of the daemon ─────────────

  isOnline(hostId: string): boolean { return this.links.has(hostId); }

  sendControl(hostId: string, f: BrainToHost): boolean {
    const l = this.links.get(hostId);
    return l ? this.send(l, f) : false;
  }

  sendData(hostId: string, ch: number, seq: number, bytes: Buffer): boolean {
    const l = this.links.get(hostId);
    if (!l || l.ws.readyState !== 1) return false;
    l.ws.send(encodeData(ch, seq, bytes));
    return true;
  }

  /** Request/response over the link. Rejects on timeout, on a host-side error, or when the link drops. */
  request(hostId: string, op: string, args?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const l = this.links.get(hostId);
    if (!l) return Promise.reject(new Error(`host ${hostId} is offline`));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        l.pending.delete(id);
        reject(new Error(`host ${hostId}: ${op} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      l.pending.set(id, { resolve, reject, timer });
      // spawn_pty / spawn_proc are their own frame kinds on the wire; everything else is a generic rpc.
      const frame: BrainToHost =
        op === "spawn_pty" || op === "spawn_proc" ? { t: op, id, spec: args } : { t: "rpc", id, op, args };
      if (!this.send(l, frame)) {
        clearTimeout(timer);
        l.pending.delete(id);
        reject(new Error(`host ${hostId}: link not writable`));
      }
    });
  }

  list(): HostLinkInfo[] {
    return [...this.links.values()].map((l) => this.info(l));
  }

  private info(l: Link): HostLinkInfo {
    const { t: _t, ...hello } = l.hello!;
    return { host_id: l.id, name: l.name, via: l.via, connected_at: l.connectedAt, last_seen_at: l.lastSeen, hello, vitals: l.vitals };
  }

  /** Revoke a host's credential and drop its link. Its token stops working immediately. */
  revoke(hostId: string): boolean {
    const had = this.creds.revoke(hostId);
    this.disconnect(hostId, "revoked");
    return had;
  }

  /** Drop a host's live link, if any (revoked, or disabled from the Desk). */
  disconnect(hostId: string, reason: string): void {
    const l = this.links.get(hostId);
    if (l) this.drop(l, 4401, reason);
  }

  /** The vitals this brain has seen from a host lately, oldest first. */
  vitalsHistory(hostId: string): HostVitals[] {
    return this.history.get(hostId) ?? [];
  }

  /**
   * Tell a connected host the brain's policy for it. Advisory on the host (its own veto is the lock
   * it enforces); the brain checks the same list before it ever sends a spawn.
   */
  pushPolicy(hostId: string): boolean {
    const row = this.creds.get(hostId);
    if (!row) return false;
    let deny: string[] = [];
    let reserve: unknown;
    try { deny = JSON.parse(row.policy_json || "{}")?.deny ?? []; } catch {}
    try { reserve = row.reserve_json ? JSON.parse(row.reserve_json) : undefined; } catch {}
    return this.sendControl(hostId, { t: "policy", deny: Array.isArray(deny) ? deny : [], ...(reserve !== undefined ? { reserve } : {}) });
  }

  // ───────────── the `mc` forwarder, brain side ─────────────

  /**
   * An `mc` call an agent on the host made to its local forwarder. It is replayed against this
   * daemon's own loopback API with the brain's stamps set — `x-mc-host`, `x-mc-remote: 1`, and the
   * per-boot forward secret — and the host's own copies of those headers thrown away.
   *
   * A forwarded request must carry a credential the brain issued (a workspace token or a live Lead's
   * token). Without that check a host would inherit the "no token on loopback = trusted" rule, which
   * is exactly the hole HOSTS.md says forwarding must not open.
   */
  private async forwardApi(link: Link, f: Extract<HostToBrain, { t: "api" }>): Promise<void> {
    const reply = (status: number, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
      this.send(link, {
        t: "api_result", req_id: f.req_id, status, headers,
        body: body == null ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body)).toString("base64"),
      });
    let target: URL;
    try {
      target = new URL(String(f.path ?? ""), "http://brain.invalid");
    } catch {
      return void reply(400, { error: "bad path" });
    }
    // Normalized by URL(): `/api/../desk` has already become `/desk` here and is refused.
    if (target.origin !== "http://brain.invalid" || !target.pathname.startsWith("/api/")) return void reply(404, { error: "not found" });
    const method = String(f.method ?? "GET").toUpperCase();
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(method)) return void reply(405, { error: "method not allowed" });
    if (link.apiInflight >= API_MAX_INFLIGHT) return void reply(429, { error: "too many forwarded requests in flight" }, { "content-type": "application/json", "retry-after": "1" });

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(f.headers ?? {})) {
      const key = k.toLowerCase();
      if (!STRIP_REQ.has(key) && typeof v === "string" && !/[\r\n]/.test(v)) headers[key] = v;
    }
    let ok = false;
    try {
      ok = await (this.opts.verifyCaller ?? defaultVerifyCaller)(headers);
    } catch {
      ok = false;
    }
    if (!ok) return void reply(401, { error: "forwarded requests need the workspace token this session was issued" });

    const body = f.body ? Buffer.from(f.body, "base64") : null;
    headers["x-mc-host"] = link.id;
    headers["x-mc-remote"] = "1";
    headers["x-mc-forwarded"] = FORWARD_SECRET;
    if (f.session_id) headers["x-mc-session"] = String(f.session_id);
    if (body) headers["content-length"] = String(body.length);
    const t = (this.opts.apiTarget ?? defaultApiTarget)();

    link.apiInflight++;
    try {
      const res = await new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
        const req = http.request({ host: t.host, port: t.port, method, path: target.pathname + target.search, headers, timeout: API_TIMEOUT_MS }, (r) => {
          const parts: Buffer[] = [];
          let n = 0;
          r.on("data", (c: Buffer) => {
            n += c.length;
            if (n > API_MAX_RESPONSE) { r.destroy(new Error("response too large")); return; }
            parts.push(c);
          });
          r.on("end", () => {
            const h: Record<string, string> = {};
            for (const [k, v] of Object.entries(r.headers)) if (PASS_RES.has(k) && typeof v === "string") h[k] = v;
            resolve({ status: r.statusCode ?? 502, headers: h, body: Buffer.concat(parts) });
          });
          r.on("error", reject);
        });
        req.on("timeout", () => req.destroy(new Error("brain API timed out")));
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
      });
      this.send(link, { t: "api_result", req_id: f.req_id, status: res.status, headers: res.headers, body: res.body.length ? res.body.toString("base64") : null });
    } catch (e: any) {
      reply(502, { error: `brain API unreachable: ${e?.message ?? e}` });
    } finally {
      link.apiInflight--;
    }
  }

  // ───────────── join codes ─────────────

  /** URLs a new host could reach this brain at, best first: LAN listener addresses, then public ones. */
  advertisedUrls(): string[] {
    return [...new Set([...this.listenUrls, ...(this.opts.publicUrls?.() ?? [])])];
  }

  /**
   * Mint a join code and the command to paste on the new Mac, one per way in: `lan` (only when the
   * host listener is up) and `tunnel` (only when CHRONOS_HOST_PUBLIC_URL is set). `command` is the
   * best of them — or the one for `url`, when the caller named one.
   */
  mintJoin(opts: { name?: string | null; url?: string | null } = {}): {
    code: string; command: string; commands: { lan: string | null; tunnel: string | null }; expires_at: number; urls: string[]; fingerprint: string;
  } {
    const cert = this.cert ?? ensureBrainCert();
    const urls = this.advertisedUrls();
    const { code, expires_at } = this.codes.mint({ fp: cert?.fingerprint ?? "", urls, name: opts.name ?? null });
    const lan = this.listenUrls[0] ?? null;
    const tunnel = (this.opts.publicUrls?.() ?? [])[0] ?? null;
    const url = opts.url || lan || tunnel || urls[0] || "<brain-url>";
    return {
      code,
      command: hostJoinCommand(url, code),
      commands: { lan: lan ? hostJoinCommand(lan, code) : null, tunnel: tunnel ? hostJoinCommand(tunnel, code) : null },
      expires_at,
      urls,
      fingerprint: cert?.fingerprint ?? "",
    };
  }

  // ───────────── the dedicated LAN listener ─────────────

  /**
   * Start the HTTPS listener on `spec` (`0.0.0.0:7779`, `:7779`, `7779`, `192.168.1.20:7779`).
   * Resolves once listening. Every non-upgrade request, and every upgrade to a path other than
   * `/host`, is a bare 404 — no body, no auth attempted, nothing about the daemon revealed.
   */
  listen(spec: string, cert: BrainCert): Promise<https.Server> {
    const { host, port } = parseListen(spec);
    this.cert = cert;
    const srv = https.createServer({ key: cert.keyPem, cert: cert.certPem }, (_req, res) => {
      res.writeHead(404, { Connection: "close" }).end();
    });
    srv.on("upgrade", (req, socket, head) => {
      let p = "";
      try { p = new URL(req.url ?? "", "http://x").pathname; } catch {}
      if (p !== HOST_PATH) {
        try { socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); } catch {}
        return socket.destroy();
      }
      this.handleUpgrade(req, socket, head, "lan");
    });
    // A TLS handshake that fails (a scanner, a host with the wrong pin hanging up) must not crash anything.
    srv.on("tlsClientError", () => {});
    return new Promise((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(port, host, () => {
        srv.off("error", reject);
        const bound = (srv.address() as { port: number }).port;
        this.listener = srv;
        this.listenUrls = lanUrls(host, bound);
        console.log(`[hostlink] host listener on ${host}:${bound} (cert ${cert.fingerprint.slice(0, 16)}…)`);
        resolve(srv);
      });
    });
  }

  async close(): Promise<void> {
    for (const l of [...this.links.values()]) this.drop(l, 1001, "brain shutting down");
    this.wss.close();
    if (this.listener) {
      const srv = this.listener;
      this.listener = null;
      srv.closeAllConnections?.();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  }
}

export function parseListen(spec: string): { host: string; port: number } {
  const s = spec.trim();
  const m = /^(?:\[?([^\]]*?)\]?:)?(\d+)$/.exec(s);
  if (!m) throw new Error(`CHRONOS_HOST_LISTEN must look like 0.0.0.0:7779 (got ${JSON.stringify(spec)})`);
  const port = Number(m[2]);
  if (port < 0 || port > 65535) throw new Error(`bad port in CHRONOS_HOST_LISTEN: ${port}`);
  return { host: m[1] || "0.0.0.0", port };
}

/** The wss:// URLs a listener bound to `host` is reachable at. A wildcard bind lists every LAN IPv4. */
export function lanUrls(host: string, port: number, ifaces = os.networkInterfaces()): string[] {
  if (host !== "0.0.0.0" && host !== "::") return [`wss://${host.includes(":") ? `[${host}]` : host}:${port}${HOST_PATH}`];
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(`wss://${a.address}:${port}${HOST_PATH}`);
    }
  }
  return out;
}

/**
 * Where a new host gets the code from. The package is not on npm yet, so a host runs a clone of the
 * repo: CHRONOS_HOST_REPO_URL, else package.json's `repository`, else the public GitHub repo.
 */
export const DEFAULT_HOST_REPO_URL = "https://github.com/leorfer23/getchronos";
let pkgRepoCache: string | null | undefined;
export function hostRepoUrl(env: NodeJS.ProcessEnv = process.env): string {
  const set = (env.CHRONOS_HOST_REPO_URL ?? "").trim();
  if (set) return set;
  if (pkgRepoCache === undefined) {
    pkgRepoCache = null;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
      const raw = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
      if (typeof raw === "string" && raw.trim()) pkgRepoCache = raw.trim().replace(/^git\+/, "").replace(/\.git$/, "");
    } catch {}
  }
  return pkgRepoCache || DEFAULT_HOST_REPO_URL;
}

/** Single-quote for a POSIX shell, so a URL or code can never break out of the pasted command. */
const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * The one line the operator pastes on a new Mac (needs git, Node >= 22 and the Xcode command-line
 * tools for node-pty). Re-running it is safe: an existing clone is fast-forwarded, not re-cloned.
 * `npm run host` runs `src/hostd` through tsx (a devDependency `npm ci` installs), and so does the
 * LaunchAgent join installs — so no build step.
 */
export function hostJoinCommand(url: string, code: string, repo = hostRepoUrl()): string {
  const dir = "~/.chronos-host/app";
  return `{ [ -d ${dir}/.git ] && git -C ${dir} pull --ff-only || git clone ${shq(repo)} ${dir}; } && cd ${dir} && npm ci && npm run host -- join ${shq(url)} ${shq(code)}`;
}

function defaultApiTarget(): { host: string; port: number } {
  return { host: "127.0.0.1", port: Number(process.env.CHRONOS_PORT ?? 7777) };
}

// ───────────────────────────── the daemon's singleton + wiring ─────────────────────────────

let singleton: BrainLink | null = null;

/** The daemon's one BrainLink. Created on first use, so the tunnel door works with the listener off. */
export function brainLink(): BrainLink {
  if (!singleton) {
    singleton = new BrainLink({
      publicUrls: () => (process.env.CHRONOS_HOST_PUBLIC_URL ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    });
  }
  return singleton;
}

/**
 * Boot hook (index.ts). Always: hosts that joined under Phase 2's `hosts.json` move into the `hosts`
 * table once, and no remote host is "online" before its link says hello. With `CHRONOS_HOST_LISTEN`
 * unset — the default — that is all: no port, no cert. A single-machine install stays what it was.
 */
export async function startHostLink(listen: string): Promise<void> {
  try {
    const reg = brainLink().creds;
    const n = reg.importLegacy(legacyHostsFile());
    if (n) console.log(`[hostlink] imported ${n} host(s) from ${legacyHostsFile()} into the hosts table (file left in place)`);
    reg.bootReconcile();
  } catch (e: any) {
    console.warn(`[hostlink] host registry boot failed: ${e?.message ?? e}`);
  }
  if (!listen.trim()) return;
  const cert = ensureBrainCert();
  if (!cert) {
    console.warn("[hostlink] CHRONOS_HOST_LISTEN is set but no brain TLS cert could be made — LAN hosts cannot connect (tunnel still works)");
    return;
  }
  try {
    await brainLink().listen(listen, cert);
  } catch (e: any) {
    console.warn(`[hostlink] host listener failed to start on ${listen}: ${e?.message ?? e}`);
  }
}

/**
 * Admin routes, mounted on the `/api` router by api.ts. Admin only: minting a join code is minting a
 * machine's way into the fleet, and the host list shows every computer's inventory.
 */
export function hostRoutes(requireAdmin: express.RequestHandler, link: () => BrainLink = brainLink): express.Router {
  const r = express.Router();
  r.post("/hosts/join-codes", requireAdmin, (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 64).replace(/[^\w.\- ]/g, "") || null : null;
    const url = typeof req.body?.url === "string" ? req.body.url : null;
    res.json(link().mintJoin({ name, url }));
  });
  r.get("/hosts", requireAdmin, (_req, res) => {
    const l = link();
    res.json({ hosts: hostsView(l), listen_urls: l.advertisedUrls(), pending_codes: l.codes.pending() });
  });
  r.get("/hosts/links", requireAdmin, (_req, res) => {
    const l = link();
    const online = new Set(l.list().map((h) => h.host_id));
    res.json({
      links: l.list(),
      known: l.creds.list().map((h) => ({ host_id: h.id, name: h.name, created_at: h.created_at, status: h.status, online: online.has(h.id) })),
      listen_urls: l.advertisedUrls(),
    });
  });
  r.patch("/hosts/:id", requireAdmin, validate(HostPatchSchema), (req, res) => {
    const l = link();
    const id = String(req.params.id);
    const row = hosts.get(id);
    if (!row || (id !== LOCAL_HOST_ID && !row.token_hash)) return res.status(404).json({ error: "no such computer" });
    const b = req.body as z.infer<typeof HostPatchSchema>;
    if (id === LOCAL_HOST_ID && b.status) return res.status(400).json({ error: "this Mac is the brain: it cannot be drained or disabled" });
    const patch: HostPatch = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.policy) {
      const all = workspaces.list();
      const known = new Set(all.flatMap((w) => [w.id, w.slug]));
      const unknown = b.policy.deny.filter((d) => !known.has(d));
      if (unknown.length) return res.status(400).json({ error: `unknown workspace(s): ${unknown.join(", ")}` });
      patch.policy_json = JSON.stringify({ deny: [...new Set(b.policy.deny)] });
    }
    if (b.reserve !== undefined) patch.reserve_json = b.reserve === null ? null : JSON.stringify(b.reserve);
    if (b.status === "draining" || b.status === "disabled") patch.status = b.status;
    // "online" = take work again. The column says offline until the link is actually up.
    if (b.status === "online") patch.status = l.isOnline(id) ? "online" : "offline";
    hosts.update(id, patch);
    if (b.status === "disabled") l.disconnect(id, "disabled from the Desk");
    else if (b.policy || b.reserve !== undefined) l.pushPolicy(id);
    const after = hosts.get(id)!;
    bus.publish({ topic: "host.updated", host_id: id, status: after.status, actor: "human" });
    res.json(hostsView(l).find((h) => h.id === id) ?? null);
  });
  r.delete("/hosts/:id", requireAdmin, (req, res) => {
    const id = String(req.params.id);
    if (id === LOCAL_HOST_ID) return res.status(400).json({ error: "this Mac is the brain: it cannot be revoked" });
    const revoked = link().revoke(id);
    if (revoked) bus.publish({ topic: "host.updated", host_id: id, status: "disabled", actor: "human" });
    res.json({ revoked });
  });
  return r;
}
