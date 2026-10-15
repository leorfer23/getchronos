import WebSocket from "ws";
import { CONFIG } from "./config.js";
import { jobs } from "./store.js";
import { dispatch } from "./dispatcher.js";

// Resolve a relay-supplied identifier (exact name, then id prefix) to a job id.
function resolveJob(idOrName: string): string | null {
  const list = jobs.list();
  const hit =
    list.find((j) => j.name === idOrName) ??
    list.find((j) => j.id === idOrName || j.id.startsWith(idOrName));
  return hit?.id ?? null;
}

let backoff = 1000;

// Maintain an OUTBOUND WebSocket to the Cloudflare relay. No inbound port on the Mac.
// The Durable Object pushes buffered triggers; we dispatch and ACK each so it can drop them.
export function startRelay() {
  const { url, token } = CONFIG.relay;
  if (!url) {
    console.log("[relay] disabled (set CHRONOS_RELAY_URL to enable)");
    return;
  }

  const connect = () => {
    const ws = new WebSocket(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

    ws.on("open", () => {
      backoff = 1000;
      console.log("[relay] connected");
    });

    ws.on("message", (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg?.id || !msg.jobId) return;

      const jobId = resolveJob(String(msg.jobId));
      if (jobId) {
        const r = dispatch(jobId, `relay:${msg.nonce ?? msg.id}`);
        console.log(`[relay] trigger ${msg.jobId} ->`, r);
      } else {
        console.warn(`[relay] unknown job "${msg.jobId}" — acking & dropping`);
      }
      // ACK so the DO removes it from the durable queue (at-most-once delivery).
      ws.send(JSON.stringify({ type: "ack", id: msg.id }));
    });

    ws.on("close", () => {
      console.warn(`[relay] disconnected — retrying in ${backoff}ms`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });

    ws.on("error", (e) => {
      console.error("[relay] error", (e as Error).message);
      ws.close();
    });
  };

  connect();
}
