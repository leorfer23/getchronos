/**
 * The brain's reaper: the ledger + reaper (ledger.ts, reaper.ts) driven by what THIS daemon runs.
 *
 * Roots are `localHost.listLive()` — the Desk terminals and headless runs this daemon spawned and is
 * still holding — never `sessions.pid` from the DB, which survives a restart and can then name any
 * process on the Mac. Remote terminals are their host's business: hostd runs the same reaper over
 * its own roots (hostd/index.ts).
 *
 * The tick is CONFIG.reaper.tickMs; `session.ended` / `run.ended` kick one at once, so a closed
 * terminal's leftovers get their SIGTERM within a second instead of up to a tick later. Every signal
 * is published as `proc.reaped` (activity.ts records it — the trail PR 3's efficiency ledger reads).
 */
import { CONFIG } from "../config.js";
import { bus } from "../bus.js";
import { localHost } from "../hosts/local.js";
import { jobs, runs, sessions } from "../store.js";
import type { Root } from "./ledger.js";
import { Reaper, systemReaperDeps, type ReaperMode } from "./reaper.js";

let reaper: Reaper | null = null;
/** Owner id → workspace, for the life of the owner (a session/run never changes workspace). */
const wsCache = new Map<string, string | null>();

function workspaceOf(kind: Root["kind"], id: string): string | null {
  if (wsCache.has(id)) return wsCache.get(id)!;
  let ws: string | null = null;
  try {
    if (kind === "session") ws = sessions.get(id)?.workspace_id ?? null;
    else {
      const run = runs.get(id);
      ws = run ? jobs.get(run.job_id)?.workspace_id ?? null : null;
    }
  } catch {
    ws = null;
  }
  wsCache.set(id, ws);
  return ws;
}

async function brainRoots(): Promise<Root[]> {
  const live = await localHost.listLive();
  const roots: Root[] = [];
  for (const l of live) {
    if (!l.pid) continue;
    const kind = l.kind === "pty" ? "session" : "run";
    roots.push({ kind, id: l.id, pid: l.pid, startedAt: l.started_at, workspaceId: workspaceOf(kind, l.id) });
  }
  const ids = new Set(roots.map((r) => r.id));
  // Bounded: an id stays cached only while it is live or still owns something.
  for (const id of wsCache.keys()) {
    if (ids.has(id)) continue;
    let owning = false;
    for (const o of reaper?.ledger.owners.values() ?? []) if (o.id === id) { owning = true; break; }
    if (!owning) wsCache.delete(id);
  }
  return roots;
}

export function startProcReaper(): void {
  if (reaper) return;
  const cfg = CONFIG.reaper;
  if (cfg.mode === "off") {
    console.log("[reaper] off (CHRONOS_REAPER=off) — no process ledger, nothing is reaped");
    return;
  }
  reaper = new Reaper(cfg, {
    ...systemReaperDeps(),
    roots: brainRoots,
    onReap: (e) =>
      bus.publish({
        topic: "proc.reaped",
        signal: e.signal,
        reason: e.reason,
        dry: e.dry,
        pid: e.pid,
        group: e.group,
        count: e.count,
        rss_mb: e.rssMb,
        cmd: e.cmd,
        owner_kind: e.owner?.kind ?? null,
        ...(e.owner?.kind === "run" ? { run_id: e.owner.id } : { session_id: e.owner?.id ?? null }),
        workspace_id: e.owner?.workspaceId ?? null,
      }),
  });
  setInterval(() => void reaper?.tick(), cfg.tickMs).unref?.();
  bus.on("event", (e: any) => {
    if (e?.topic === "session.ended" || e?.topic === "run.ended") reaper?.kick();
  });
  console.log(
    `[reaper] ${cfg.mode === "dry" ? "DRY RUN (logs, never signals)" : "on"} — every ${Math.round(cfg.tickMs / 1000)}s; ` +
      `ended owners' leftovers SIGTERM→SIGKILL after ${Math.round(cfg.killGraceMs / 1000)}s; leak-family orphans after ${Math.round(cfg.orphanGraceMs / 1000)}s`,
  );
}

export type OwnerRollup = {
  kind: Root["kind"];
  id: string;
  workspace_id: string | null;
  ended: boolean;
  pids: number;
  rss_mb: number;
  cpu: number;
  orphans: number;
  reaped: number;
};
export type WorkspaceRollup = { workspace_id: string | null; pids: number; rss_mb: number; cpu: number; orphans: number; reaped: number };
export type ProcsView = {
  mode: ReaperMode;
  every_ms: number;
  sampled_at: number | null;
  workspaces: WorkspaceRollup[];
  owners: OwnerRollup[];
};

/**
 * What `GET /machine` shows: per terminal/run and per workspace, what they hold right now and how
 * much was reaped since the daemon started. `ws` = the caller's workspace (null = admin, sees all):
 * a workspace token sees only its own rows — never another workspace's ids or counts.
 */
export function procsView(ws: string | null, r: Reaper | null = reaper): ProcsView {
  const cfg = r?.cfg ?? CONFIG.reaper;
  const base: ProcsView = { mode: r ? cfg.mode : "off", every_ms: cfg.tickMs, sampled_at: r?.ledger.sampledAt ?? null, workspaces: [], owners: [] };
  if (!r) return base;
  const roll = r.ledger.rollup();
  const byWs = new Map<string, WorkspaceRollup>();
  const wsRow = (id: string | null) => {
    const k = id ?? "";
    let w = byWs.get(k);
    if (!w) { w = { workspace_id: id, pids: 0, rss_mb: 0, cpu: 0, orphans: 0, reaped: r.reapedByWs.get(k) ?? 0 }; byWs.set(k, w); }
    return w;
  };
  for (const o of r.ledger.owners.values()) {
    if (ws != null && o.workspaceId !== ws) continue;
    const x = roll.get(o.key) ?? { pids: 0, rssKb: 0, cpu: 0, orphans: 0 };
    const row: OwnerRollup = {
      kind: o.kind, id: o.id, workspace_id: o.workspaceId, ended: o.ended,
      pids: x.pids, rss_mb: Math.round(x.rssKb / 1024), cpu: Math.round(x.cpu * 10) / 10, orphans: x.orphans, reaped: o.reaped,
    };
    base.owners.push(row);
    const w = wsRow(o.workspaceId);
    w.pids += row.pids; w.rss_mb += row.rss_mb; w.cpu = Math.round((w.cpu + row.cpu) * 10) / 10; w.orphans += row.orphans;
  }
  // A workspace whose reaped work is all gone still shows what was reaped.
  for (const k of r.reapedByWs.keys()) {
    const id = k || null;
    if (ws != null && id !== ws) continue;
    wsRow(id);
  }
  base.owners.sort((a, b) => b.rss_mb - a.rss_mb);
  base.workspaces = [...byWs.values()].sort((a, b) => b.rss_mb - a.rss_mb);
  return base;
}
