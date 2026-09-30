/**
 * The loopback `mc` forwarder (HOSTS.md → `mc`, hooks and the sandbox on a host).
 *
 * Agents on a host run the same `mc` CLI and hooks as on the brain, with the same
 * `MC_API=http://localhost:7777/api`. Seatbelt's egress lock allows only localhost and SBPL cannot
 * whitelist an IP literal, so "just point MC_API at the brain" is not an option — the API has to be
 * local. This server is that local API: every request becomes an `api` frame over the link, and the
 * brain answers it. The sandbox rules stay exactly as they are on the brain.
 *
 * Loopback only, always. It is a door into the brain; it must never be reachable from the LAN.
 *
 * While the brain is away (HOSTS.md → Reconnect and restarts) the host keeps its agents working:
 * status writes go to the `outbox` and are answered 202, `mc heavy` is granted from this host's own
 * pool, and everything else gets a 503 that says what to do (link.ts `unreachable`).
 */
import http from "node:http";
import crypto from "node:crypto";
import type { ApiRequest, HostLink } from "./link.js";
import { queueable, type Outbox } from "./outbox.js";
import type { HeavyPool } from "../machine.js";

const MAX_BODY = 16 * 1024 * 1024; // the daemon's own express.json limit
/** The brain's own long poll for a heavy slot (api.ts), so `mc heavy` behaves the same either way. */
const SLOT_WAIT_MS = 55_000;
const SLOTS = /^\/api\/machine\/slots(?:\/([^/?]+))?(?:\?.*)?$/;

export type ForwarderStatus = () => Record<string, unknown>;

export type ForwarderOptions = {
  port: number;
  status?: ForwarderStatus;
  /** Status writes kept for the brain while it is away (outbox.ts). Absent = they 503 like the rest. */
  outbox?: Outbox;
  /** This host's own heavy slots, for while the brain is away. Absent = `mc heavy` runs unthrottled then. */
  heavy?: HeavyPool;
  slotWaitMs?: number;
};

/** `state` is optional so a stub link with only `api` reads as always online. */
type ForwardLink = Pick<HostLink, "api"> & Partial<Pick<HostLink, "state">>;

export function startForwarder(link: ForwardLink, opts: ForwarderOptions): Promise<http.Server> {
  const online = () => link.state === undefined || link.state === "online";
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  /**
   * A heavy slot from this host's own pool, the same long poll the brain runs. Slots granted here stay
   * here until released (beat/release below check the local pool first), even once the brain is back:
   * for that overlap the brain does not count them, so the host may briefly run up to twice its
   * `ncpu/6` suites. Over-committing for a few minutes is the price; the alternative — handing the
   * brain permits it never granted — has no correct answer to "who reclaims it".
   */
  const localSlot = async (res: http.ServerResponse, body: Buffer | null) => {
    const heavy = opts.heavy!;
    let b: { session_id?: unknown; label?: unknown; ticket?: unknown } = {};
    try { b = JSON.parse(body?.toString("utf8") || "{}") ?? {}; } catch {}
    const ticket = typeof b.ticket === "string" && b.ticket ? b.ticket : crypto.randomUUID();
    res.on("close", () => { if (!res.writableEnded) heavy.abandon(ticket); });
    const grant = await heavy.acquire({
      session_id: typeof b.session_id === "string" ? b.session_id : null,
      label: typeof b.label === "string" && b.label ? b.label.slice(0, 200) : "mc heavy",
      ticket,
    }, opts.slotWaitMs ?? SLOT_WAIT_MS);
    if (res.writableEnded || !res.writable) return;
    json(res, 200, { ...grant, slots: heavy.size(), local: true });
  };

  const srv = http.createServer((req, res) => {
    const url = req.url ?? "/";
    // The host's own status, answered locally and never forwarded. Holds no secrets.
    if (url === "/__host/status") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify(opts.status?.() ?? {}));
    }
    const parts: Buffer[] = [];
    let n = 0;
    let tooBig = false;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > MAX_BODY) { tooBig = true; return; }
      parts.push(c);
    });
    req.on("end", async () => {
      if (tooBig) {
        res.writeHead(413, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "request body over 16 MB" }));
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      const body = parts.length ? Buffer.concat(parts) : null;
      const method = req.method ?? "GET";
      const slot = opts.heavy ? SLOTS.exec(url) : null;
      if (slot) {
        const id = slot[1] ?? null; // a UUID either side minted: nothing to decode
        if (id && method === "PUT" && opts.heavy!.beat(id)) return json(res, 200, { ok: true });
        if (id && method === "DELETE" && opts.heavy!.release(id)) return json(res, 200, { released: true });
        if (!id && method === "POST" && !online()) return void localSlot(res, body);
      }
      const apiReq: ApiRequest = {
        session_id: headers["x-mc-session"] || null,
        method,
        path: url,
        headers,
        body: body ? body.toString("base64") : null,
      };
      // Queued while the brain is away — and also while older queued writes are still being replayed,
      // or a fresh `mc state done` would land first and a stale `working` from the outbox after it.
      const ob = opts.outbox;
      if (ob && queueable(method, url) && (!online() || ob.size > 0) && ob.put(apiReq)) {
        if (online()) void ob.drain((q) => link.api(q));
        return json(res, 202, { queued: true, note: online() ? "delivering after earlier queued writes" : "brain unreachable; will deliver on reconnect" });
      }
      try {
        const r = await link.api(apiReq);
        // The link dropped while `mc heavy` was parked on the brain's queue: carry on from the local pool.
        if (slot && !slot[1] && method === "POST" && r.status === 503 && !online()) return void localSlot(res, body);
        res.writeHead(r.status, r.headers);
        res.end(r.body ?? undefined);
      } catch (e: any) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e?.message ?? e) }));
      }
    });
  });
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(opts.port, "127.0.0.1", () => {
      srv.off("error", reject);
      resolve(srv);
    });
  });
}
