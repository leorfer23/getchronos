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
 */
import http from "node:http";
import type { HostLink } from "./link.js";

const MAX_BODY = 16 * 1024 * 1024; // the daemon's own express.json limit

export type ForwarderStatus = () => Record<string, unknown>;

export function startForwarder(link: Pick<HostLink, "api">, opts: { port: number; status?: ForwarderStatus }): Promise<http.Server> {
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
      try {
        const r = await link.api({
          session_id: headers["x-mc-session"] || null,
          method: req.method ?? "GET",
          path: url,
          headers,
          body: body ? body.toString("base64") : null,
        });
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
