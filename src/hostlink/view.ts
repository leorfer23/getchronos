/**
 * `GET /api/hosts`: every computer as the Desk's Computers panel and header chip read it. One shape
 * for `local` and for remote hosts, so the Desk never branches on "is this the brain" except to say so.
 *
 * Never carries `token_hash` (nor the cert fingerprint): the Desk has no use for either, and a
 * response that never holds a secret cannot leak one.
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import { hosts, repoCheckouts, workspaces, repos, LOCAL_HOST_ID } from "../store.js";
import { hostById } from "../hosts/index.js";
import { which, CLI_NAMES } from "../hostd/inventory.js";
import { swapPctOf, type Admission } from "../machine.js";
import type { HostRow } from "../types.js";
import type { HostVitals } from "./wire.js";
import { parseCapabilities, parsePolicy, type HostCapabilities, type HostPolicy } from "./registry.js";
import type { BrainLink } from "./brain-link.js";

export type VitalsPoint = { at: number; cpu: number | null; ram: number | null; gpu: number | null };

export type HostView = {
  id: string;
  name: string;
  platform: string;
  /** The column: online | offline | draining | disabled. */
  status: HostRow["status"];
  /** The live link right now — `local` is always connected to itself. */
  connected: boolean;
  is_brain: boolean;
  created_at: string;
  last_seen_at: string | null;
  policy: HostPolicy;
  reserve: unknown;
  link: { via: string; connected_at: number; last_seen_at: number } | null;
  version: string | null;
  vitals: {
    history: VitalsPoint[];
    load_per_core: number | null;
    pressure: 1 | 2 | 4 | null;
    swap_pct: number | null;
    ram: { usedMb: number; totalMb: number } | null;
  };
  /** Would an AGENT be let onto this computer now? The operator always is. */
  admission: Admission;
  live_sessions: number;
  checklist: Checklist;
};

export type Checklist = {
  clis: Array<{ name: string; ok: boolean; version: string | null }>;
  profiles: Array<{ name: string; ok: boolean }>;
  /** Every workspace: may it run here (brain policy, host veto), and are its repos checked out. */
  workspaces: Array<{
    id: string; slug: string; name: string;
    allowed: boolean; denied_by: "policy" | "veto" | null;
    profile: { name: string; ok: boolean } | null;
    repos: Array<{ id: string; name: string; path: string | null }>;
  }>;
  veto: string[];
  reported_at: string | null;
};

/** Pressure / swap / load thresholds are machine.ts's own; a remote host reports its per-core load directly. */
export function remoteAdmission(v: HostVitals | null, cfg = CONFIG.machine): Admission {
  if (!cfg.enabled) return { ok: true };
  if (!v) return { ok: false, reason: "no vitals from this host yet" };
  const overLoad = v.loadPerCore > cfg.maxLoadPerCore;
  const critical = v.pressure === 4;
  const strained = v.pressure != null && v.pressure >= 2 && v.swapPct != null && v.swapPct > cfg.maxSwapUsedPct;
  if (!overLoad && !critical && !strained) return { ok: true };
  const pw = v.pressure === 4 ? "critical" : v.pressure === 2 ? "warning" : v.pressure === 1 ? "normal" : "unknown";
  return { ok: false, reason: `load ${v.loadPerCore.toFixed(2)}/core, memory pressure ${pw} (swap ${v.swapPct == null ? "unknown" : Math.round(v.swapPct) + "%"})` };
}

/** `~/.claude-acme` → `claude-acme`: the profile NAME hosts report (config.ts discoverProfiles). */
export const profileNameOf = (configDir: string | null | undefined): string | null =>
  configDir ? path.basename(configDir).replace(/^\./, "") || null : null;

function localCaps(): Pick<HostCapabilities, "clis" | "profiles" | "veto" | "reported_at"> {
  return {
    clis: CLI_NAMES.map((name) => ({ name, path: which(name), version: null })),
    profiles: Object.entries(CONFIG.profiles).map(([name, dir]) => ({ name, dir, exists: fs.existsSync(dir) })),
    veto: [],
    reported_at: new Date().toISOString(),
  };
}

export function checklistFor(row: HostRow, caps: Pick<HostCapabilities, "clis" | "profiles" | "veto" | "reported_at"> | null): Checklist {
  const policy = parsePolicy(row.policy_json);
  const veto = caps?.veto ?? [];
  const checkouts = new Map(repoCheckouts.forHost(row.id).map((c) => [c.repo_id, c.path]));
  const profiles = caps?.profiles ?? [];
  return {
    clis: (caps?.clis ?? []).map((c) => ({ name: c.name, ok: !!c.path, version: c.version ?? null })),
    profiles: profiles.map((p) => ({ name: p.name, ok: !!p.exists })),
    workspaces: workspaces.list().map((w) => {
      const byPolicy = policy.deny.includes(w.id) || policy.deny.includes(w.slug);
      const byVeto = veto.includes(w.id) || veto.includes(w.slug);
      const pn = profileNameOf(w.config_dir);
      return {
        id: w.id, slug: w.slug, name: w.name,
        allowed: !byPolicy && !byVeto,
        denied_by: byVeto ? "veto" as const : byPolicy ? "policy" as const : null,
        profile: pn ? { name: pn, ok: profiles.some((p) => p.name === pn && p.exists) } : null,
        repos: repos.list(w.id).map((r) => ({ id: r.id, name: r.name, path: checkouts.get(r.id) ?? null })),
      };
    }),
    veto,
    reported_at: caps?.reported_at ?? null,
  };
}

export function hostsView(link: BrainLink): HostView[] {
  const counts = hosts.liveSessionCounts();
  const online = new Map(link.list().map((l) => [l.host_id, l]));
  return hosts.list()
    // A revoked host keeps its row (sessions still point at it), but it is not a computer any more.
    .filter((h) => h.id === LOCAL_HOST_ID || !!h.token_hash)
    .map((h): HostView => {
      const policy = parsePolicy(h.policy_json);
      let reserve: unknown = null;
      try { reserve = h.reserve_json ? JSON.parse(h.reserve_json) : null; } catch {}
      if (h.id === LOCAL_HOST_ID) {
        const v = hostById(LOCAL_HOST_ID).vitals();
        const snap = v.samples;
        return {
          id: h.id, name: h.name, platform: h.platform, status: h.status, connected: true, is_brain: true,
          created_at: h.created_at, last_seen_at: new Date().toISOString(), policy, reserve,
          link: null, version: null,
          vitals: {
            history: snap.history.map((s) => ({ at: s.at, cpu: s.cpu, ram: s.ram, gpu: s.gpu })),
            load_per_core: v.load.loadPerCore, pressure: v.load.pressureLevel, swap_pct: swapPctOf(v.load), ram: snap.ram,
          },
          admission: v.admission,
          live_sessions: counts[h.id] ?? 0,
          checklist: checklistFor(h, localCaps()),
        };
      }
      const l = online.get(h.id) ?? null;
      const caps = parseCapabilities(h.capabilities_json);
      const hist = link.vitalsHistory(h.id);
      const last = l?.vitals ?? null;
      return {
        id: h.id, name: h.name, platform: h.platform, status: h.status, connected: !!l, is_brain: false,
        created_at: h.created_at, last_seen_at: l ? new Date(l.last_seen_at).toISOString() : h.last_seen_at, policy, reserve,
        link: l ? { via: l.via, connected_at: l.connected_at, last_seen_at: l.last_seen_at } : null,
        version: l?.hello.version ?? caps?.version ?? null,
        vitals: {
          history: l ? hist.map((s) => ({ at: s.at, cpu: s.cpu, ram: s.ram, gpu: s.gpu })) : [],
          load_per_core: last?.loadPerCore ?? null, pressure: last?.pressure ?? null, swap_pct: last?.swapPct ?? null, ram: null,
        },
        admission: !l ? { ok: false, reason: "offline" } : h.status === "draining" ? { ok: false, reason: "draining — takes no new work" } : remoteAdmission(last),
        live_sessions: counts[h.id] ?? 0,
        checklist: checklistFor(h, caps),
      };
    });
}
