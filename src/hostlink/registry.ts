/**
 * The brain's record of its hosts, kept in the `hosts` / `repo_checkouts` tables (HOSTS.md → Paths
 * belong to a host). The link (`brain-link.ts`) is the only writer apart from the Desk's edits:
 *
 *  - **join** inserts the row: operator's name, the token's hash, the cert fingerprint it pinned.
 *  - **hello** refreshes what the host reported (capabilities, profiles, checkouts, veto, version)
 *    and marks it online; its checkouts become `repo_checkouts` rows matched by git remote.
 *  - **link down** marks it offline. **Revoke** disables it and forgets the token hash.
 *
 * `status` carries two things at once, so the transitions are deliberate: `draining` and `disabled`
 * are the operator's and survive the link coming and going; `online` / `offline` are the link's and
 * only ever replace each other. "Is it connected right now" is always the live link, not the column.
 */
import fs from "node:fs";
import { hosts, repoCheckouts, repos, LOCAL_HOST_ID } from "../store.js";
import type { HostRow } from "../types.js";
import type { CheckoutInfo, CliInfo, Hello, ProfileInfo } from "./wire.js";
import { tokenMatches, type HostRecord } from "./join.js";

export type HostStatus = HostRow["status"];

/** What `capabilities_json` holds: the host's hello, minus what changes every connection. */
export type HostCapabilities = {
  version: string;
  proto: string;
  platform: string;
  arch: string;
  hostname: string;
  node: string;
  sandbox: boolean;
  clis: CliInfo[];
  profiles: ProfileInfo[];
  checkouts: CheckoutInfo[];
  /** The host's own veto (CHRONOS_HOST_DENY), as reported. The host enforces it; the brain shows it. */
  veto: string[];
  reported_at: string;
};

export type HostPolicy = { deny: string[] };

// Pure and store-free, so `chronos host` matches checkouts by the same key (hostd/terminals.ts).
export { normalizeGitRemote } from "./git-remote.js";
import { normalizeGitRemote } from "./git-remote.js";

export function parsePolicy(json: string | null | undefined): HostPolicy {
  try {
    const v = JSON.parse(json || "null");
    const deny = Array.isArray(v?.deny) ? v.deny.filter((x: unknown): x is string => typeof x === "string") : [];
    return { deny };
  } catch {
    return { deny: [] };
  }
}

export function parseCapabilities(json: string | null | undefined): HostCapabilities | null {
  try {
    const v = JSON.parse(json || "null");
    return v && typeof v === "object" ? (v as HostCapabilities) : null;
  } catch {
    return null;
  }
}

const iso = (ms: number) => new Date(ms).toISOString();
/** last_seen_at is written at most this often per host; the link keeps the exact value in memory. */
const SEEN_WRITE_MS = 60_000;

export class HostRegistry {
  private seenWritten = new Map<string, number>();

  get(hostId: string): HostRow | undefined {
    return hosts.get(hostId);
  }

  /** Every host that can still connect (a revoked one keeps its row for history, not its token). */
  list(): HostRow[] {
    return hosts.list().filter((h) => h.id !== LOCAL_HOST_ID && !!h.token_hash);
  }

  add(r: { host_id: string; name: string; token_hash: string; cert_fp?: string | null; created_at?: number }): HostRow {
    if (r.host_id === LOCAL_HOST_ID) throw new Error("'local' is the brain, not a joinable host");
    const existing = hosts.get(r.host_id);
    if (existing) return hosts.update(r.host_id, { name: r.name, token_hash: r.token_hash, cert_fp: r.cert_fp ?? existing.cert_fp, status: "offline" })!;
    return hosts.create({ id: r.host_id, name: r.name, token_hash: r.token_hash, cert_fp: r.cert_fp ?? null, status: "offline", created_at: r.created_at ? iso(r.created_at) : undefined });
  }

  /**
   * A presented credential, checked in constant time. The hash compare runs even for an unknown or
   * disabled id (against a dummy), so "no such host", "disabled" and "wrong token" take the same time.
   */
  verify(hostId: string, token: string): HostRow | null {
    const r = hostId && hostId !== LOCAL_HOST_ID ? hosts.get(hostId) : undefined;
    const usable = !!r && !!r.token_hash && r.status !== "disabled";
    const ok = tokenMatches(token, usable ? r!.token_hash : "0".repeat(64));
    return usable && ok ? r! : null;
  }

  /** The host said hello: record what it reported and that it is here. */
  hello(hostId: string, h: Hello, at = Date.now()): HostRow | undefined {
    const row = hosts.get(hostId);
    if (!row || hostId === LOCAL_HOST_ID) return undefined;
    const caps: HostCapabilities = {
      version: String(h.version ?? ""),
      proto: String(h.proto ?? ""),
      platform: String(h.platform ?? ""),
      arch: String(h.arch ?? ""),
      hostname: String(h.name ?? ""),
      node: String(h.capabilities?.node ?? ""),
      sandbox: !!h.capabilities?.sandbox,
      clis: Array.isArray(h.capabilities?.clis) ? h.capabilities.clis : [],
      profiles: Array.isArray(h.profiles) ? h.profiles : [],
      checkouts: Array.isArray(h.checkouts) ? h.checkouts : [],
      veto: Array.isArray(h.deny) ? h.deny.filter((x) => typeof x === "string") : [],
      reported_at: iso(at),
    };
    this.seenWritten.set(hostId, at);
    const updated = hosts.update(hostId, {
      platform: caps.platform || row.platform,
      capabilities_json: JSON.stringify(caps),
      last_seen_at: iso(at),
      // draining / disabled are the operator's; the link only moves offline → online.
      status: row.status === "offline" ? "online" : row.status,
    });
    this.syncCheckouts(hostId, caps.checkouts);
    return updated;
  }

  /** Frames arrived: keep last_seen_at roughly current without a write per vitals frame. */
  seen(hostId: string, at = Date.now()): void {
    if (at - (this.seenWritten.get(hostId) ?? 0) < SEEN_WRITE_MS) return;
    this.seenWritten.set(hostId, at);
    if (hosts.get(hostId)) hosts.update(hostId, { last_seen_at: iso(at) });
  }

  offline(hostId: string, at = Date.now()): void {
    const row = hosts.get(hostId);
    if (!row || hostId === LOCAL_HOST_ID) return;
    hosts.update(hostId, { last_seen_at: iso(at), ...(row.status === "online" ? { status: "offline" as const } : {}) });
    this.seenWritten.delete(hostId);
  }

  /** Revoke: disabled, token hash gone. Re-joining (a new code) is the only way back. */
  revoke(hostId: string): boolean {
    const row = hosts.get(hostId);
    if (!row || hostId === LOCAL_HOST_ID || (!row.token_hash && row.status === "disabled")) return false;
    hosts.update(hostId, { status: "disabled", token_hash: null });
    return true;
  }

  /** Boot: no link exists yet, so nothing is online but the brain itself. */
  bootReconcile(): void {
    for (const h of hosts.list()) if (h.id !== LOCAL_HOST_ID && h.status === "online") hosts.update(h.id, { status: "offline" });
  }

  /**
   * Hosts that joined while the credential store was `<hostlink>/hosts.json` (Phase 2) move into the
   * table once. The file is left where it is: harmless (hashes only), and the way back if needed.
   */
  importLegacy(file: string): number {
    let rows: HostRecord[];
    try {
      const v = JSON.parse(fs.readFileSync(file, "utf8"));
      rows = Array.isArray(v) ? v.filter((r) => r && typeof r.host_id === "string" && typeof r.token_hash === "string") : [];
    } catch {
      return 0;
    }
    let n = 0;
    for (const r of rows) {
      if (r.host_id === LOCAL_HOST_ID || hosts.get(r.host_id)) continue;
      const revoked = !!r.revoked_at;
      hosts.create({
        id: r.host_id,
        name: String(r.name || r.host_id).slice(0, 64),
        token_hash: revoked ? null : r.token_hash,
        status: revoked ? "disabled" : "offline",
        created_at: typeof r.created_at === "number" ? iso(r.created_at) : undefined,
      });
      n++;
    }
    return n;
  }

  /** Match each reported checkout to every repo with the same remote (a repo can live in two workspaces). */
  syncCheckouts(hostId: string, checkouts: CheckoutInfo[]): number {
    const byRemote = new Map<string, string[]>();
    for (const r of repos.list()) {
      const k = normalizeGitRemote(r.git_remote);
      if (k) byRemote.set(k, [...(byRemote.get(k) ?? []), r.id]);
    }
    const rows: Array<{ repo_id: string; path: string }> = [];
    const taken = new Set<string>();
    for (const c of checkouts) {
      const k = normalizeGitRemote(c?.remote_url);
      if (!k || typeof c.path !== "string") continue;
      for (const repoId of byRemote.get(k) ?? []) {
        if (taken.has(repoId)) continue; // two clones of one repo: the first reported wins
        taken.add(repoId);
        rows.push({ repo_id: repoId, path: c.path });
      }
    }
    repoCheckouts.replaceForHost(hostId, rows);
    return rows.length;
  }
}
