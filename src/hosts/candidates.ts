/**
 * The impure half of placement: gathers what `place()` (src/hosts/placement.ts) decides on — every
 * computer's reported capabilities, policy, veto, checkouts and live vitals, and what the terminal
 * being opened needs and where its work already lives — then turns the answer into a host id or a
 * thrown PlacementError. openSession calls `placeTerminal()` once, before any row is written.
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import { bus } from "../bus.js";
import { hosts, repoCheckouts, repos, sessions, tickets, workspaces, LOCAL_HOST_ID } from "../store.js";
import { getBackend } from "../backends/index.js";
import { egressLocked } from "../egress.js";
import { currentLoad, loadFromVitals, vitalsSnapshot } from "../machine.js";
import { parseCapabilities, parsePolicy } from "../hostlink/registry.js";
import { worktreeRootFor } from "../worktree-core.js";
import { ticketBranch } from "../tickets.js";
import { findHost, remoteHosts } from "./index.js";
import { RemoteHost } from "./remote.js";
import { profileNameFor } from "./spawn-spec.js";
import { place, type HostCandidate, type Placed, type PlacementMode, type PlaceRequest, type Refused } from "./placement.js";

/** A refusal from placement, with the HTTP status the API answers it with. */
export class PlacementError extends Error {
  readonly status: number;
  constructor(readonly refusal: Refused) {
    super(refusal.message);
    // policy: the caller asked for a computer this workspace may not use. unavailable: that computer
    // cannot take it right now. full: 400, exactly what a saturated brain has always answered.
    this.status = refusal.kind === "policy" ? 403 : refusal.kind === "unavailable" ? 409 : 400;
  }
}

/**
 * Every computer placement may consider: the brain, then each host this brain knows — joined and not
 * revoked, or connected right now. An offline host is still a candidate: it is how a refusal can say
 * "m5: offline" instead of leaving it out.
 */
export function placementCandidates(now = Date.now()): HostCandidate[] {
  const brainRow = hosts.get(LOCAL_HOST_ID);
  const history = vitalsSnapshot().history;
  const out: HostCandidate[] = [{
    id: LOCAL_HOST_ID, name: brainRow?.name || LOCAL_HOST_ID, is_brain: true, online: true, status: "online",
    deny: [], veto: [], platform: process.platform, sandbox: true, clis: [], profiles: [], checkouts: [], auto_clone: false,
    load: currentLoad(),
    ram_pct: history.length ? history[history.length - 1].ram : null,
  }];
  const ids = new Set<string>();
  for (const r of hosts.list()) if (r.id !== LOCAL_HOST_ID && r.token_hash) ids.add(r.id);
  for (const h of remoteHosts()) ids.add(h.id);
  for (const id of [...ids].sort()) {
    const row = hosts.get(id);
    const live = findHost(id);
    const rh = live instanceof RemoteHost ? live : null;
    const hello = rh?.hello ?? null;
    const caps = parseCapabilities(row?.capabilities_json);
    const v = rh?.latestVitals(now) ?? null;
    out.push({
      id,
      // The operator's name for it (what the Desk shows), else what the Mac calls itself.
      name: row?.name || hello?.name || id,
      is_brain: false,
      online: !!rh?.online,
      status: row?.status ?? "online",
      deny: parsePolicy(row?.policy_json).deny,
      veto: hello?.deny ?? caps?.veto ?? [],
      platform: hello?.platform ?? caps?.platform ?? row?.platform ?? "",
      sandbox: !!(hello?.capabilities?.sandbox ?? caps?.sandbox),
      clis: (hello?.capabilities?.clis ?? caps?.clis ?? []).filter((c) => !!c.path).map((c) => c.name),
      profiles: (hello?.profiles ?? caps?.profiles ?? []).map((p) => ({ name: p.name, exists: !!p.exists })),
      checkouts: repoCheckouts.forHost(id).map((c) => c.repo_id),
      auto_clone: !!(hello?.capabilities?.auto_clone ?? caps?.auto_clone),
      load: v ? loadFromVitals(v) : null,
      ram_pct: v?.ram ?? null,
    });
  }
  return out;
}

/** What openSession knows about the terminal it is about to open — the fields placement reads. */
export type OpenIntent = {
  workspace_id?: string | null;
  repo_id?: string | null;
  ticket_id?: string | null;
  backend?: string | null;
  cwd?: string | null;
  host_id?: string | null;
  resumeId?: string | null;
  agentSessionId?: string | null;
  resumeAgent?: boolean;
  replaces?: string | null;
};

/**
 * Where this work already lives, if anywhere (HOSTS.md Placement step 2). Order matters: a reopen of
 * a row beats everything, then a stand-in for a walled terminal, then a ticket whose worktree is on
 * one computer, then a directory the caller named on the brain.
 */
export function stickyFor(o: OpenIntent): { host_id: string; why: string; fresh: boolean } | null {
  if (o.resumeId) {
    const r = sessions.get(o.resumeId);
    return { host_id: r?.host_id || LOCAL_HOST_ID, why: "its CLI transcript is on that computer", fresh: false };
  }
  if (o.agentSessionId && o.resumeAgent) {
    const r = sessions.get(o.agentSessionId);
    // A headless run's transcript is where the run ran — the brain, until runs move to hosts (phase 5).
    return { host_id: r?.host_id || LOCAL_HOST_ID, why: r ? "its CLI transcript is on that computer" : "it continues a headless run on the brain", fresh: false };
  }
  if (o.replaces) {
    const r = sessions.get(o.replaces);
    if (r) return { host_id: r.host_id || LOCAL_HOST_ID, why: "it stands in for a terminal whose files are there", fresh: false };
  }
  const t = o.ticket_id ? tickets.get(o.ticket_id) : undefined;
  const repo = o.repo_id ? repos.get(o.repo_id) : t?.repo_id ? repos.get(t.repo_id) : undefined;
  if (t && repo) {
    // The ticket's worktree holds its uncommitted work. On the brain it is a directory we can see;
    // on a host, the last terminal that worked the ticket there is the record of it.
    const wt = repo.path ? path.join(worktreeRootFor(repo.path), ticketBranch(t.key).replace(/\//g, "-")) : null;
    if (wt && fs.existsSync(wt)) return { host_id: LOCAL_HOST_ID, why: `${t.key}'s worktree is on that computer`, fresh: true };
    const prev = sessions.list({ ticket_id: t.id }).find((s) => s.host_id && s.host_id !== LOCAL_HOST_ID);
    // A host that was removed took its worktree with it: nothing to be sticky to any more.
    if (prev && hosts.get(prev.host_id)?.token_hash) return { host_id: prev.host_id, why: `${t.key}'s worktree is on that computer`, fresh: true };
  }
  // A directory the caller named (a launch's cwd, a job's, the dialog's) is a path on the brain's disk.
  // A pin wins over it, as it did in phase 3: a remote terminal ignores a brain cwd.
  if (o.cwd && !o.host_id) return { host_id: LOCAL_HOST_ID, why: "it was asked to start in a directory on the brain", fresh: true };
  return null;
}

/** The request `place()` decides on, from what the open carries. */
export function placeRequest(o: OpenIntent, openedBy: string): PlaceRequest {
  const ws = o.workspace_id ? workspaces.get(o.workspace_id) : undefined;
  const t = o.ticket_id ? tickets.get(o.ticket_id) : undefined;
  const repo = o.repo_id ? repos.get(o.repo_id) : t?.repo_id ? repos.get(t.repo_id) : undefined;
  const backend = getBackend(o.backend ?? undefined);
  const sticky = stickyFor(o);
  return {
    workspace: ws ? { id: ws.id, slug: ws.slug } : null,
    backend: backend.name,
    backend_kind: backend.kind === "cloud" ? "cloud" : "local",
    profile: profileNameFor(ws?.config_dir, CONFIG.profiles, CONFIG.defaultProfile),
    repo: repo ? { id: repo.id, name: repo.name, git_remote: repo.git_remote } : null,
    needs: { sandbox: String(ws?.sandbox_mode ?? CONFIG.sandbox.defaultMode), egress_locked: egressLocked(o.workspace_id) },
    pinned: o.host_id || null,
    sticky: sticky ? { host_id: sticky.host_id, why: sticky.why } : null,
    // Same rule the brain-only admission check always used: "operator" (or nothing) is the operator.
    opened_by: openedBy && openedBy !== "operator" ? "agent" : "operator",
    fresh: sticky ? sticky.fresh : true,
    exempt_admission: !!o.replaces,
  };
}

/**
 * Pick the computer for a terminal, or throw why not. A refusal of work somebody pointed at a
 * computer the workspace may not use (a pin, a sticky row) is also published as a policy violation:
 * it means something tried.
 */
export function placeTerminal(o: OpenIntent, openedBy: string, mode: PlacementMode = CONFIG.placement.mode): Placed {
  const req = placeRequest(o, openedBy);
  const r = place({ req, hosts: placementCandidates(), cfg: CONFIG.machine, reserve: CONFIG.placement.brainReserve, mode });
  if (r.ok) return r;
  if (r.kind === "policy" && req.workspace) {
    const hid = req.sticky?.host_id ?? req.pinned ?? "";
    console.warn(`[placement] POLICY: refused to place ${req.workspace.slug} on ${hid} — ${r.message}`);
    bus.publish({ topic: "host.policy_violation", host_id: hid, workspace_id: req.workspace.id, session_id: o.resumeId ?? null, reason: r.message });
  }
  throw new PlacementError(r);
}
