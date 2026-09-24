/**
 * `GET /api/hosts`: every computer as the Desk's Computers panel and header chip read it. One shape
 * for `local` and for remote hosts, so the Desk never branches on "is this the brain" except to say so.
 *
 * Never carries `token_hash` (nor the cert fingerprint): the Desk has no use for either, and a
 * response that never holds a secret cannot leak one.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { REPO_ROOT } from "../repo-root.js";
import { CONFIG } from "../config.js";
import { hosts, repoCheckouts, workspaces, repos, LOCAL_HOST_ID } from "../store.js";
import { hostById } from "../hosts/index.js";
import { which, CLI_NAMES, chronosVersion } from "../hostd/inventory.js";
import { admission, loadFromVitals, swapPctOf, type Admission } from "../machine.js";
import type { HostRow } from "../types.js";
import type { HostInstall, HostVitals, UpdateTarget } from "./wire.js";
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
  /** Phase 6: the commit this computer runs (git installs) and how it was installed. */
  commit: string | null;
  install: HostInstall | null;
  /** Phase 6: is it behind the brain, can the Desk update it, and how the last update went. null for the brain. */
  update: HostUpdateView | null;
};

// ── phase 6: version + update ──

/** What the brain runs — the version and commit every host is compared with, and updated to. */
let brainBuildCache: UpdateTarget | null = null;
export function brainBuild(): UpdateTarget {
  if (!brainBuildCache) {
    let commit: string | null = null;
    try {
      const sha = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (/^[0-9a-f]{40}$/.test(sha)) commit = sha;
    } catch {}
    // Read once per boot: a deploy restarts the daemon, and that is the only way the brain's code changes.
    brainBuildCache = { version: chronosVersion(), commit };
  }
  return brainBuildCache;
}

/** One host's last update, as the brain heard it (brain-link.ts keeps these, in memory). */
export type UpdateRecord = {
  id: string;
  target: UpdateTarget;
  state: "requested" | "running" | "restarting" | "failed" | "current" | "done";
  step?: string;
  error?: string;
  at: number;
};

export type HostUpdateView = {
  /** Behind the brain: a different commit (git) or version (npm), or a host older than self-update. */
  available: boolean;
  /** The Desk's Update button works: the host understands `update` and is an app install. */
  supported: boolean;
  target: UpdateTarget;
  /** When not supported: what to run on that Mac instead (null when there is nothing to paste). */
  manual: string | null;
  status: UpdateRecord | null;
};

/** No word from a host for this long in the middle of an update = it failed (npm ci is ~minutes). */
export const UPDATE_STALE_MS = 20 * 60_000;

/** The one line that updates a pre-phase-6 host by hand, the first time. $HOME, never `~`. */
export const MANUAL_GIT_UPDATE =
  'cd "$HOME/.chronos-host/app" && git fetch -q origin main && git reset -q --hard FETCH_HEAD && npm ci --no-audit --no-fund && launchctl kickstart -k gui/$(id -u)/sh.chronos.host';

/**
 * Is this host behind the brain, and can the Desk do something about it? Pure.
 *
 * A host that reports no `install` predates self-update. The brain running this code is newer than
 * any such host by construction, so it is "update available" — but only by hand, once.
 */
export function updateVerdict(brain: UpdateTarget, host: { version: string | null; commit: string | null; install: HostInstall | null; connected: boolean }, status: UpdateRecord | null = null, now = Date.now()): HostUpdateView {
  const st = status && (status.state === "requested" || status.state === "running") && now - status.at > UPDATE_STALE_MS
    ? { ...status, state: "failed" as const, error: `no word from the host for ${Math.round(UPDATE_STALE_MS / 60_000)} minutes — check ~/.chronos-host/host.err.log there` }
    : status;
  if (!host.version) return { available: false, supported: false, target: brain, manual: null, status: st };
  if (!host.install) return { available: true, supported: false, target: brain, manual: MANUAL_GIT_UPDATE, status: st };
  const available = host.install === "npm"
    ? host.version !== brain.version
    : !!brain.commit && !!host.commit && host.commit !== brain.commit;
  if (host.install === "dev") return { available, supported: false, target: brain, manual: null, status: st };
  // A git host can only follow a brain that has a commit to give it.
  const supported = host.connected && (host.install === "npm" || !!brain.commit);
  return { available, supported, target: brain, manual: null, status: st };
}
// ── end phase 6 ──

export type Checklist = {
  clis: Array<{ name: string; ok: boolean; version: string | null; auth?: "yes" | "no" | "unknown" }>;
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

/**
 * Would an agent be admitted onto this host now? The governor's own `admission()` on the host's
 * reported numbers and its own core count (HOSTS.md phase 4) — the verdict placement acts on, not a
 * display-only approximation of it.
 */
export function remoteAdmission(v: HostVitals | null, cfg = CONFIG.machine): Admission {
  if (!cfg.enabled) return { ok: true };
  if (!v) return { ok: false, reason: "no vitals from this host yet" };
  return admission(loadFromVitals(v), cfg);
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
    // "ok" is "placement may send this CLI's work here": installed AND not reported as logged out.
    clis: (caps?.clis ?? []).map((c) => ({
      name: c.name, ok: !!c.path && c.auth !== "no",
      version: c.path && c.auth === "no" ? `${c.version ?? "installed"} · not logged in` : c.version ?? null,
      ...(c.auth ? { auth: c.auth } : {}),
    })),
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
          link: null, version: brainBuild().version, commit: brainBuild().commit, install: null, update: null,
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
        commit: (l ? l.hello.commit : caps?.commit) ?? null,
        install: (l ? l.hello.install : caps?.install) ?? null,
        update: updateVerdict(brainBuild(), {
          version: l?.hello.version ?? caps?.version ?? null,
          commit: (l ? l.hello.commit : caps?.commit) ?? null,
          install: (l ? l.hello.install : caps?.install) ?? null,
          connected: !!l,
        }, link.updateStatus(h.id)),
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
