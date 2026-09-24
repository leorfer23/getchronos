/**
 * A workspace's egress proxy, run on the host next to its agents (HOSTS.md → "The per-workspace egress
 * proxy runs on the host", phase 5). The same proxy the brain runs (egress-core.ts), fed the policy
 * the brain sent with the spawn, and reporting every connection back to the brain's audit log over the
 * link — so an egress-locked workspace no longer has to stay on the brain.
 *
 * What it deliberately does NOT do: credential brokering. The brain's proxy can terminate TLS and
 * inject an operator's secret so it never enters the sandbox; doing that here would mean shipping the
 * secret to another Mac, the opposite of least-credentials. A brokered workspace stays on the brain
 * (placement's `needs.brokered`), so no CA is generated on a host and none is trusted by its agents.
 */
import type http from "node:http";
import { buildEgressServer, listenLoopback, proxyEnv, type EgressCfg, type EgressPolicy } from "../egress-core.js";

/** How the host's proxies report a connection (the link's `egress` frame; queued while it is down). */
export type EgressSink = (e: { workspace_id: string; host: string; port: number; action: "allow" | "deny" }) => boolean;

/** Connections kept while the link is down, so a Wi-Fi drop does not punch a hole in the audit log. */
const BACKLOG_CAP = 500;

export class HostEgress {
  private proxies = new Map<string, { server: http.Server; port: number; policy: EgressPolicy }>();
  private starting = new Map<string, Promise<number | null>>();
  private backlog: Array<Parameters<EgressSink>[0]> = [];
  private sink: EgressSink | null = null;

  /** Where connection records go. Flushes anything that piled up while there was nowhere to send. */
  setSink(sink: EgressSink | null): void {
    this.sink = sink;
    this.flush();
  }

  flush(): void {
    if (!this.sink) return;
    while (this.backlog.length) {
      if (!this.sink(this.backlog[0])) return;
      this.backlog.shift();
    }
  }

  private record(e: Parameters<EgressSink>[0]): void {
    if (this.sink && !this.backlog.length && this.sink(e)) return;
    this.backlog.push(e);
    if (this.backlog.length > BACKLOG_CAP) this.backlog.shift();
  }

  /**
   * The port of this workspace's proxy, started on first use. The policy is replaced on every call:
   * the brain sends its current one with each spawn, and the proxy reads it per connection, so an
   * allowlist edit on the Desk reaches a running proxy with the next spawn. Null = could not listen.
   */
  async ensure(wsId: string, policy: EgressPolicy): Promise<number | null> {
    const live = this.proxies.get(wsId);
    if (live) { live.policy = policy; return live.port; }
    const pending = this.starting.get(wsId);
    if (pending) return pending;
    const p = (async () => {
      const entry = { policy } as { server: http.Server; port: number; policy: EgressPolicy };
      const cfg = (): EgressCfg => ({ mode: entry.policy.mode, allow: entry.policy.allow });
      entry.server = buildEgressServer({
        cfg,
        baseAllow: () => entry.policy.base_allow,
        record: (host, port, action) => this.record({ workspace_id: wsId, host, port, action }),
      });
      const port = await listenLoopback(entry.server);
      if (port == null) { try { entry.server.close(); } catch {} return null; }
      entry.port = port;
      entry.server.on("error", (e) => console.warn(`[host] egress proxy for ${wsId}: ${(e as any)?.message ?? e}`));
      this.proxies.set(wsId, entry);
      console.log(`[host] egress proxy for workspace ${wsId} (${policy.mode}) on 127.0.0.1:${port}`);
      return port;
    })();
    this.starting.set(wsId, p);
    try { return await p; } finally { this.starting.delete(wsId); }
  }

  env(port: number): Record<string, string> {
    return proxyEnv(port);
  }

  portFor(wsId: string): number | null {
    return this.proxies.get(wsId)?.port ?? null;
  }

  closeAll(): void {
    for (const p of this.proxies.values()) { try { p.server.close(); } catch {} }
    this.proxies.clear();
  }
}

/**
 * What one spawn gets from its workspace's egress on this host: the proxy env, and whether to lock
 * direct outbound to it (Seatbelt). A locked workspace with no proxy is REFUSED, never spawned open —
 * and never spawned locked with nowhere to go (the brain's own fail-open rule, egress.ts egressLocked).
 */
export async function egressForSpawn(
  egress: HostEgress | undefined,
  ws: { id: string; slug: string } | null,
  policy: EgressPolicy | null,
  locked: boolean,
): Promise<{ env: Record<string, string>; locked: boolean }> {
  if (!policy || !ws) {
    if (locked) throw new Error("this workspace's egress is locked, but the brain sent no egress policy");
    return { env: {}, locked: false };
  }
  if (!egress) {
    if (locked) throw new Error("this workspace's egress is locked, and this host runs no egress proxy");
    return { env: {}, locked: false };
  }
  const port = await egress.ensure(ws.id, policy);
  if (port == null) {
    if (locked) throw new Error("this workspace's egress is locked, and its proxy could not start on this host");
    return { env: {}, locked: false };
  }
  return { env: egress.env(port), locked: locked && policy.mode === "enforce" };
}
