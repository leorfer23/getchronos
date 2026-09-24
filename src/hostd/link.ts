/**
 * The host's end of the link: one outbound WebSocket to the first brain URL that answers, kept up
 * forever with exponential backoff. Nothing connects TO a host (HOSTS.md → What it is): no inbound
 * port, no SSH, which is what lets this run on an MDM-managed Mac.
 */
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  MAX_CONTROL_BYTES, decodeControl, encodeControl, encodeData,
  type BrainToHost, type Hello, type HostToBrain, type HostVitals,
} from "../hostlink/wire.js";
import type { HostTerminals } from "./terminals.js";
import { classifyBrainUrl, pinBrain, pinnedTlsOptions } from "../hostlink/pin.js";

export type LinkState = "idle" | "connecting" | "online" | "offline" | "stopped";

export type ApiRequest = Omit<Extract<HostToBrain, { t: "api" }>, "t" | "req_id">;
export type ApiResponse = { status: number; headers: Record<string, string>; body: Buffer | null };

export type HostLinkOptions = {
  brains: string[];
  hostId: string;
  token: string;
  fp: string | null;
  hello: () => Promise<Hello>;
  vitals: () => Promise<HostVitals>;
  vitalsMs?: number;
  /** Until the brain's welcome says otherwise. */
  pingMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  cfAccess?: { id: string; secret: string } | null;
  /** rpc ops beyond the built-ins. Return a value, or throw to answer ok:false. */
  rpc?: Record<string, (args: unknown) => Promise<unknown> | unknown>;
  /** The host's PTYs (phase 3). Without it, spawn/write/kill are answered "not here". */
  terminals?: HostTerminals;
};

type Handler = (f: any) => void;

/**
 * Connect headers for one URL. CF Access service-token headers only go to a CA-verified (tunnel)
 * URL: sending them to a LAN IP would hand a Cloudflare credential to whatever answers there.
 */
export function connectHeaders(kind: "pinned" | "ca" | "loopback-plain", o: { hostId: string; token: string; cfAccess?: { id: string; secret: string } | null }): Record<string, string> {
  const h: Record<string, string> = { authorization: `Bearer ${o.token}`, "x-chronos-host-id": o.hostId };
  if (kind === "ca" && o.cfAccess?.id && o.cfAccess.secret) {
    h["cf-access-client-id"] = o.cfAccess.id;
    h["cf-access-client-secret"] = o.cfAccess.secret;
  }
  return h;
}

/** Open a WebSocket to a brain URL with the right trust for its kind. Refuses before dialing when the URL is not allowed. */
/**
 * `onCreate` runs synchronously on the new socket, before the handshake: a brain that answers in the
 * same packet as the 101 (the join reply does) would otherwise emit `message` before an `await`ing
 * caller could attach a listener, and the frame would be lost.
 */
export async function openBrainSocket(raw: string, fp: string | null, headers: Record<string, string>, onCreate?: (ws: WebSocket) => void): Promise<WebSocket> {
  const k = classifyBrainUrl(raw);
  if (!k.ok) throw new Error(k.reason);
  const opts: WebSocket.ClientOptions = { headers, maxPayload: MAX_CONTROL_BYTES, handshakeTimeout: 15_000, perMessageDeflate: false };
  if (k.kind === "pinned") {
    const { pem } = await pinBrain(k.url, fp ?? "");
    Object.assign(opts, pinnedTlsOptions(pem, fp ?? ""));
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(k.url, opts);
    onCreate?.(ws);
    ws.once("open", () => { ws.off("error", reject); resolve(ws); });
    ws.once("unexpected-response", (_req, res) => {
      reject(new Error(`brain refused the connection: HTTP ${res.statusCode}`));
      ws.terminate();
    });
    ws.once("error", reject);
  });
}

export class HostLink extends EventEmitter {
  state: LinkState = "idle";
  url: string | null = null;
  since = Date.now();
  lastError: string | null = null;
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private vitalsTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private missed = 0;
  private pingN = 0;
  private pendingApi = new Map<string, { resolve: (r: ApiResponse) => void; timer: NodeJS.Timeout }>();
  private readonly handlers: Record<string, Handler>;

  constructor(private readonly o: HostLinkOptions) {
    super();
    // The dispatch table. Anything the brain may send has an entry, including the frames this phase
    // does not implement yet — those answer with an explicit error so the brain never waits on a
    // silence it cannot tell from a slow host.
    const t = o.terminals;
    t?.attachLink({ online: () => this.state === "online", send: (f) => this.send(f), sendData: (ch, seq, b) => this.sendData(ch, seq, b) });
    this.handlers = {
      welcome: (f: Extract<BrainToHost, { t: "welcome" }>) => this.onWelcome(f),
      ping: (f) => this.send({ t: "pong", n: f.n }),
      pong: () => { this.missed = 0; },
      rpc: (f: Extract<BrainToHost, { t: "rpc" }>) => void this.onRpc(f),
      api_result: (f: Extract<BrainToHost, { t: "api_result" }>) => this.onApiResult(f),
      spawn_pty: (f: Extract<BrainToHost, { t: "spawn_pty" }>) => void this.onSpawnPty(f),
      spawn_proc: (f) => this.send({ t: "rpc_result", id: f.id, ok: false, error: "not yet: headless runs on hosts land in HOSTS.md Phase 5" }),
      // Channel frames. With no terminals (a phase-2 host) there is nothing to act on, and a write
      // to nowhere says so rather than vanishing.
      write: (f: Extract<BrainToHost, { t: "write" }>) => (t ? t.write(f.ch, f.bytes) : this.send({ t: "error", code: "not_implemented", message: `no channel ${f.ch}` })),
      resize: (f: Extract<BrainToHost, { t: "resize" }>) => t?.resize(f.ch, f.cols, f.rows),
      kill: (f: Extract<BrainToHost, { t: "kill" }>) => (t ? t.kill(f.ch, f.signal) : this.send({ t: "error", code: "not_implemented", message: `no channel ${f.ch}` })),
      ack: (f: Extract<BrainToHost, { t: "ack" }>) => t?.ack(f.ch, f.seq),
      attach: (f: Extract<BrainToHost, { t: "attach" }>) => t?.attach(f.ch, f.seq, f.transcript_offset, f.session_id),
      release: (f: Extract<BrainToHost, { t: "release" }>) => t?.release(f.ch),
      policy: (f) => this.emit("policy", f),
      error: (f) => { console.warn(`[host] brain says ${f.code}: ${f.message}`); this.lastError = `${f.code}: ${f.message}`; },
    };
  }

  start(): void {
    this.stopped = false;
    void this.cycle();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.clearTimers();
    for (const [id, p] of this.pendingApi) { clearTimeout(p.timer); p.resolve({ status: 503, headers: {}, body: null }); this.pendingApi.delete(id); }
    const ws = this.ws;
    this.ws = null;
    if (ws) await new Promise<void>((r) => { ws.once("close", () => r()); try { ws.close(1000, "host stopping"); } catch { r(); } setTimeout(r, 1000).unref?.(); });
    this.setState("stopped");
  }

  /** Forward one `mc` HTTP request over the link. Resolves 503 when the brain is not reachable. */
  api(req: ApiRequest, timeoutMs = 75_000): Promise<ApiResponse> {
    if (this.state !== "online") return Promise.resolve({ status: 503, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: "brain unreachable from this host" })) });
    const req_id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApi.delete(req_id);
        resolve({ status: 504, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: "brain did not answer in time" })) });
      }, timeoutMs);
      timer.unref?.();
      this.pendingApi.set(req_id, { resolve, timer });
      if (!this.send({ t: "api", req_id, ...req })) {
        clearTimeout(timer);
        this.pendingApi.delete(req_id);
        resolve({ status: 503, headers: {}, body: null });
      }
    });
  }

  // ───────────── connection cycle ─────────────

  private async cycle(): Promise<void> {
    if (this.stopped) return;
    this.setState("connecting");
    for (const url of this.o.brains) {
      if (this.stopped) return;
      try {
        const kind = classifyBrainUrl(url);
        if (!kind.ok) throw new Error(kind.reason);
        const ws = await openBrainSocket(url, this.o.fp, connectHeaders(kind.kind, this.o));
        if (this.stopped) { ws.terminate(); return; }
        this.adopt(ws, url);
        return;
      } catch (e: any) {
        this.lastError = `${url}: ${e?.message ?? e}`;
        console.warn(`[host] ${this.lastError}`);
      }
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.setState("offline");
    const min = this.o.backoffMinMs ?? 1000, max = this.o.backoffMaxMs ?? 60_000;
    // Full jitter: after a brain deploy every host reconnects at once; spreading them avoids a stampede.
    const cap = Math.min(max, min * 2 ** Math.min(this.attempt++, 16));
    const wait = Math.round(cap / 2 + Math.random() * (cap / 2));
    this.retryTimer = setTimeout(() => void this.cycle(), wait);
    this.retryTimer.unref?.();
  }

  private adopt(ws: WebSocket, url: string): void {
    this.ws = ws;
    this.url = url;
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return; // brain → host binary (PTY input) arrives with Phase 3
      let f: BrainToHost;
      try { f = decodeControl(raw as Buffer) as BrainToHost; } catch { return void ws.close(4400, "bad frame"); }
      const h = this.handlers[f.t];
      if (h) h(f);
    });
    ws.on("close", (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      // Link down, not process dead: the PTYs keep running and buffering; the brain re-attaches later.
      this.o.terminals?.linkDown();
      for (const [id, p] of this.pendingApi) { clearTimeout(p.timer); p.resolve({ status: 503, headers: {}, body: null }); this.pendingApi.delete(id); }
      this.lastError = `closed ${code}${reason?.length ? ` ${reason}` : ""}`;
      this.emit("offline", this.lastError);
      // 4401 revoked / 4403 identity / 4426 version: retrying cannot help, and hammering the brain
      // with a dead credential is noise. Stay down; `doctor` / the Desk says why.
      if (code === 4401 || code === 4403 || code === 4426) {
        console.warn(`[host] brain closed the link permanently (${this.lastError}) — not retrying`);
        this.stopped = true;
        this.setState("stopped");
        return;
      }
      this.scheduleRetry();
    });
    ws.on("error", () => {});
    void this.o.hello().then((h) => this.send(h));
  }

  private onWelcome(f: Extract<BrainToHost, { t: "welcome" }>): void {
    this.attempt = 0;
    this.setState("online");
    this.emit("online", f);
    const pingMs = f.ping_ms || this.o.pingMs || 15_000;
    this.clearTimers();
    // Host-side liveness mirrors the brain's: two unanswered pings and we drop and redial, so a
    // half-open socket (the brain's Mac slept) does not sit "online" forever.
    this.pingTimer = setInterval(() => {
      if (this.missed >= 2) { try { this.ws?.terminate(); } catch {} return; }
      this.missed++;
      this.send({ t: "ping", n: ++this.pingN });
    }, pingMs);
    this.pingTimer.unref?.();
    const pushVitals = () => void this.o.vitals().then((v) => this.send({ t: "vitals", ...v })).catch(() => {});
    pushVitals();
    this.vitalsTimer = setInterval(pushVitals, this.o.vitalsMs ?? 5000);
    this.vitalsTimer.unref?.();
  }

  private async onRpc(f: Extract<BrainToHost, { t: "rpc" }>): Promise<void> {
    const builtin: Record<string, (a: unknown) => unknown> = {
      vitals: () => this.o.vitals(),
      hello: () => this.o.hello(),
    };
    const fn = this.o.rpc?.[f.op] ?? builtin[f.op];
    if (!fn) return void this.send({ t: "rpc_result", id: f.id, ok: false, error: `unknown op ${f.op}` });
    try {
      this.send({ t: "rpc_result", id: f.id, ok: true, value: await fn(f.args) });
    } catch (e: any) {
      this.send({ t: "rpc_result", id: f.id, ok: false, error: String(e?.message ?? e) });
    }
  }

  /**
   * `spawn_pty`: answered as an rpc_result on the frame's id. A local-veto refusal is an ordinary
   * error whose text starts with "veto:" — the brain logs it as a policy violation.
   */
  private async onSpawnPty(f: Extract<BrainToHost, { t: "spawn_pty" }>): Promise<void> {
    if (!this.o.terminals) return void this.send({ t: "rpc_result", id: f.id, ok: false, error: "this host runs no terminals" });
    try {
      this.send({ t: "rpc_result", id: f.id, ok: true, value: await this.o.terminals.spawn(f.spec) });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.startsWith("veto:")) console.warn(`[host] refused a spawn — ${msg}`);
      this.send({ t: "rpc_result", id: f.id, ok: false, error: msg });
    }
  }

  /** One binary data frame (PTY bytes) to the brain. False when the link is not writable. */
  sendData(ch: number, seq: number, bytes: Buffer): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.state !== "online") return false;
    try { ws.send(encodeData(ch, seq, bytes)); return true; } catch { return false; }
  }

  private onApiResult(f: Extract<BrainToHost, { t: "api_result" }>): void {
    const p = this.pendingApi.get(f.req_id);
    if (!p) return;
    this.pendingApi.delete(f.req_id);
    clearTimeout(p.timer);
    p.resolve({ status: f.status, headers: f.headers ?? {}, body: f.body ? Buffer.from(f.body, "base64") : null });
  }

  private send(f: HostToBrain): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(encodeControl(f)); return true; } catch { return false; }
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.vitalsTimer) clearInterval(this.vitalsTimer);
    this.pingTimer = this.vitalsTimer = null;
    this.missed = 0;
  }

  private setState(s: LinkState): void {
    if (this.state === s) return;
    this.state = s;
    this.since = Date.now();
    this.emit("state", s);
  }
}
