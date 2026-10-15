/**
 * Chronos relay — Cloudflare Worker + Durable Object mailbox.
 *
 * Ingress  : POST /t/:jobId   (Bearer INGRESS_TOKEN, optional HMAC X-Signature, X-Nonce)
 * Agent    : GET  /ws         (Bearer AGENT_TOKEN)  ← the Mac daemon dials out here
 * The DO buffers triggers durably and pushes them to the connected daemon, which ACKs.
 */

export interface Env {
  MAILBOX: DurableObjectNamespace;
  MACHINE_ID?: string;
  AGENT_TOKEN: string; // daemon ↔ relay
  INGRESS_TOKEN: string; // remote senders → relay
  INGRESS_SECRET?: string; // optional HMAC-SHA256 over raw body
}

/** How long a nonce blocks replays. Also the max age of a message timestamp. */
const NONCE_TTL_MS = 60 * 60 * 1000; // 1 hour

function bearer(req: Request): string | null {
  const h = req.headers.get("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

/** Constant-time equality for arbitrary strings (Workers have no crypto.timingSafeEqual). */
function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Always walk the longer buffer so length differences don't short-circuit early.
  const len = Math.max(ab.byteLength, bb.byteLength);
  let diff = ab.byteLength ^ bb.byteLength;
  for (let i = 0; i < len; i++) {
    const x = i < ab.byteLength ? ab[i]! : 0;
    const y = i < bb.byteLength ? bb[i]! : 0;
    diff |= x ^ y;
  }
  return diff === 0;
}

function tokenOk(got: string | null, expected: string): boolean {
  if (!got || !expected) return false;
  return timingSafeEqualStr(got, expected);
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function hmacOk(secret: string, body: string, sigHex: string): Promise<boolean> {
  const sig = hexToBytes(sigHex);
  if (!sig) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  // subtle.verify is constant-time for same-length MACs.
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(body));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") return Response.json({ ok: true });

    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(env.MACHINE_ID ?? "default"));

    // Daemon WebSocket connection.
    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket")
        return new Response("expected websocket", { status: 426 });
      if (!tokenOk(bearer(req), env.AGENT_TOKEN)) return new Response("unauthorized", { status: 401 });
      return stub.fetch(new Request("https://do/ws", req));
    }

    // Trigger ingress.
    const m = url.pathname.match(/^\/t\/(.+)$/);
    if (m && req.method === "POST") {
      if (!tokenOk(bearer(req), env.INGRESS_TOKEN)) return new Response("unauthorized", { status: 401 });
      const body = await req.text();
      if (env.INGRESS_SECRET) {
        const sig = req.headers.get("X-Signature") ?? "";
        if (!(await hmacOk(env.INGRESS_SECRET, body, sig)))
          return new Response("bad signature", { status: 401 });
      }
      let payload: unknown = null;
      try {
        payload = body ? JSON.parse(body) : null;
      } catch {
        payload = body;
      }
      const msg = {
        id: crypto.randomUUID(),
        jobId: decodeURIComponent(m[1]),
        nonce: req.headers.get("X-Nonce") ?? crypto.randomUUID(),
        payload,
        ts: Date.now(),
      };
      return stub.fetch(
        new Request("https://do/enqueue", { method: "POST", body: JSON.stringify(msg) })
      );
    }

    return new Response("not found", { status: 404 });
  },
};

export class Mailbox {
  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server); // hibernatable
      await this.flush(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/enqueue") {
      const msg = (await req.json()) as { id: string; nonce: string; ts?: number };
      if (!msg.nonce || typeof msg.nonce !== "string" || msg.nonce.length > 128) {
        return Response.json({ ok: false, error: "bad nonce" }, { status: 400 });
      }
      const now = Date.now();
      const ts = typeof msg.ts === "number" ? msg.ts : now;
      // Reject messages outside the nonce window (replay / clock skew guard).
      if (Math.abs(now - ts) > NONCE_TTL_MS) {
        return Response.json({ ok: false, error: "stale" }, { status: 400 });
      }
      // Replay protection: skip nonces we've already accepted (within TTL).
      const seenAt = await this.state.storage.get<number>(`nonce:${msg.nonce}`);
      if (seenAt != null && now - seenAt <= NONCE_TTL_MS) {
        return Response.json({ ok: true, dedup: true });
      }
      await this.state.storage.put(`nonce:${msg.nonce}`, ts);
      await this.ensureNonceAlarm();
      await this.state.storage.put(`msg:${msg.id}`, msg);
      let delivered = false;
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.send(JSON.stringify(msg));
          delivered = true;
        } catch {}
      }
      return Response.json({ ok: true, buffered: !delivered });
    }

    return new Response("not found", { status: 404 });
  }

  // Push everything still pending to a freshly-connected daemon.
  async flush(ws: WebSocket) {
    const map = await this.state.storage.list<{ id: string }>({ prefix: "msg:" });
    for (const [, msg] of map) ws.send(JSON.stringify(msg));
  }

  async webSocketMessage(_ws: WebSocket, data: string | ArrayBuffer) {
    try {
      const m = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
      if (m.type === "ack" && m.id) await this.state.storage.delete(`msg:${m.id}`);
    } catch {}
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code, "bye");
    } catch {}
  }

  /** Schedule a one-shot purge if none is pending. */
  private async ensureNonceAlarm() {
    const existing = await this.state.storage.getAlarm();
    if (existing == null) {
      await this.state.storage.setAlarm(Date.now() + NONCE_TTL_MS);
    }
  }

  /** Drop nonces older than NONCE_TTL_MS; reschedule while any remain. */
  private async purgeExpiredNonces() {
    const now = Date.now();
    const map = await this.state.storage.list<number>({ prefix: "nonce:" });
    const doomed: string[] = [];
    for (const [k, v] of map) {
      if (typeof v !== "number" || now - v > NONCE_TTL_MS) doomed.push(k);
    }
    if (doomed.length) await this.state.storage.delete(doomed);
  }

  async alarm() {
    await this.purgeExpiredNonces();
    const left = await this.state.storage.list({ prefix: "nonce:", limit: 1 });
    if (left.size > 0) {
      await this.state.storage.setAlarm(Date.now() + NONCE_TTL_MS);
    }
  }
}
