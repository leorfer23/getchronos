/**
 * The brain's reaper and budget ladder: the ledger + reaper (ledger.ts, reaper.ts) driven by what THIS
 * daemon runs, and the ladder (ladder.ts) on the same snapshot right after each reaper pass.
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
import fs from "node:fs";
import os from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { CONFIG } from "../config.js";
import { bus } from "../bus.js";
import { localHost } from "../hosts/local.js";
import { jobs, runs, sessions, workspaces } from "../store.js";
import { currentLoad, localHeavyPool, setSlotBudget } from "../machine.js";
import { setting } from "../settings.js";
import { sendInput, sessionActivity } from "../terminal.js";
import { sendMessage } from "../messages.js";
import type { Owner, Root } from "./ledger.js";
import { parseStarts, Reaper, systemReaperDeps, type ReaperMode } from "./reaper.js";
import { cleanWeight, slotBudgetOf } from "./budget.js";
import {
  Ladder, parseLadderMode, parseStatStarts, stillStopped, systemGetNice, systemSetNice,
  type LadderView, type PausedRec, type WsView,
} from "./ladder.js";

let reaper: Reaper | null = null;
let ladder: Ladder | null = null;
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

// ───────────────────────── the ladder's hands on this Mac ─────────────────────────

const weightOf = (ws: string | null): number => {
  if (!ws) return 1;
  try { return cleanWeight(setting("resources.weight", ws)); } catch { return 1; }
};
const ladderMode = () => {
  try { return parseLadderMode(String(setting("resources.ladder") ?? ""), CONFIG.ladder.mode); } catch { return CONFIG.ladder.mode; }
};

/** Workspaces with a live owner on this Mac, per the ledger (empty while the reaper is off). */
function activeWorkspaces(): string[] {
  const out = new Set<string>();
  for (const o of reaper?.ledger.owners.values() ?? []) if (!o.ended && o.workspaceId) out.add(o.workspaceId);
  return [...out];
}

/**
 * The warning, by the channels that already reach an agent. A headless run gets the `mc tell` mailbox
 * (steered live when it can be, else at its next checkpoint). A Desk terminal has no non-typing channel
 * its agent reads while busy: the mailbox refuses sessions, and the hooks only hand context back on the
 * operator's NEXT prompt (`memory_notice`, UserPromptSubmit) — an autonomous agent mid-task never sees
 * that. So it is TYPED in (as host failover tells a terminal it moved — `sendInput`, rate-limited,
 * recorded as session.input), prefixed `[chronos budget]`, and DEFERRED while anyone typed into that
 * pane in the last TYPING_QUIET_MS, so it never lands in the middle of the operator's own line.
 */
const TYPING_QUIET_MS = 30_000;
function tellOwner(o: Owner, text: string): string | null {
  if (o.kind === "session") {
    const lastIn = sessionActivity(o.id).last_in;
    if (lastIn != null && Date.now() - lastIn < TYPING_QUIET_MS) return `defer: typed into ${Math.round((Date.now() - lastIn) / 1000)}s ago`;
    return sendInput(o.id, { text }, "budget");
  }
  const r = sendMessage(o.id, text, "budget");
  return r.ok ? null : r.error;
}

/** Mirror of what the ladder has stopped: written on every change, removed when empty. */
function saveLadderState(paused: PausedRec[]): void {
  const file = CONFIG.ladderStateFile;
  if (!file) return;
  if (!paused.length) { try { fs.unlinkSync(file); } catch { /* already gone */ } return; }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, paused }) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Boot: a previous daemon that crashed (or was SIGKILLed) with processes paused left them stopped —
 * its exit handler never ran. Its state file names them: SIGCONT every one that is STILL stopped
 * (`ps` state T) and still the same process (start time). Nothing else is touched, and the file goes.
 */
async function recoverPaused(): Promise<void> {
  const file = CONFIG.ladderStateFile;
  if (!file || !fs.existsSync(file)) return;
  let recs: PausedRec[] = [];
  try { recs = JSON.parse(fs.readFileSync(file, "utf8")).paused ?? []; } catch { recs = []; }
  recs = recs.filter((r) => Number.isInteger(r?.pid) && r.pid > 1 && Number.isFinite(r?.startMs));
  if (recs.length) {
    const out = await new Promise<string | null>((resolve) =>
      execFile("/bin/ps", ["-o", "pid=,stat=,lstart=", "-p", recs.map((r) => r.pid).join(",")], { encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C" } },
        (err, o) => resolve(err && (err as any).code !== 1 ? null : o)),
    );
    if (out == null) {
      console.warn(`[ladder] boot: could not check ${recs.length} process(es) the previous daemon paused — state file kept for the next start: ${file}`);
      return;
    }
    const cont = stillStopped(recs, parseStatStarts(out));
    for (const pid of cont) {
      try { process.kill(pid, "SIGCONT"); } catch { /* gone */ }
      const r = recs.find((x) => x.pid === pid)!;
      console.log(`[ladder] boot: SIGCONT pid ${pid} — ${r.comm.split("/").pop()} — left stopped by the previous daemon`);
      bus.publish({ topic: "budget.resume", workspace_id: r.ws || null, action: "cont", reason: "boot", pids: [pid], count: 1, paused_ms: Date.now() - r.at });
    }
    console.log(`[ladder] boot: ${recs.length} process(es) recorded as paused by the previous daemon, ${cont.length} still stopped → SIGCONT`);
  }
  try { fs.unlinkSync(file); } catch { /* fine */ }
}

/** One blocking `ps` for the exit handler's start-time re-check; null = no answer (SIGCONT anyway). */
function startsSync(pids: number[]): Map<number, number> | null {
  try {
    return parseStarts(execFileSync("/bin/ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], { encoding: "utf8", timeout: 2000, env: { ...process.env, LC_ALL: "C" } }));
  } catch (e: any) {
    return typeof e?.stdout === "string" && e.status === 1 ? parseStarts(e.stdout) : null;
  }
}

/**
 * Heavy-slot fairness (machine.ts HeavyPool): a workspace's slot budget is its weighted share among
 * every workspace active on that machine plus every contender in the pool. Only the brain's own
 * ledger is known here, so a host's pool weighs its contenders alone.
 */
function installSlotBudget(): void {
  setSlotBudget((ws, contenders, slots, hostId) => slotBudgetOf(ws, contenders, slots, hostId === "local" ? activeWorkspaces() : [], weightOf));
}

export function startProcReaper(): void {
  if (reaper) return;
  installSlotBudget();
  void recoverPaused().catch((e) => console.warn(`[ladder] boot recovery failed: ${e?.message ?? e}`));
  const cfg = CONFIG.reaper;
  if (cfg.mode === "off") {
    console.log("[reaper] off (CHRONOS_REAPER=off) — no process ledger, nothing is reaped, and no budget ladder (it reads the ledger)");
    return;
  }
  reaper = new Reaper(cfg, {
    ...systemReaperDeps(),
    roots: brainRoots,
    beforeSignal: (pids) => ladder?.beforeReap(pids),
    afterTick: () => ladder?.tick(),
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
  const sys = systemReaperDeps();
  ladder = new Ladder(CONFIG.ladder, {
    ledger: reaper.ledger,
    reaper: cfg,
    mode: ladderMode,
    load: currentLoad,
    maxLoadPerCore: () => CONFIG.machine.maxLoadPerCore,
    totalMb: () => os.totalmem() / 1048576,
    slots: () => {
      const pool = localHeavyPool();
      const held = new Map<string, number>();
      for (const h of pool.holders()) if (h.workspace_id) held.set(h.workspace_id, (held.get(h.workspace_id) ?? 0) + 1);
      return { size: pool.size(), held };
    },
    weightOf,
    args: sys.args,
    starts: sys.starts,
    signal: (pid, sig) => (pid > 1 ? sys.signal(pid, sig) : false),
    getNice: systemGetNice,
    setNice: systemSetNice,
    tell: tellOwner,
    publish: (e) => bus.publish(e),
    save: saveLadderState,
    wsName: (ws) => (ws ? workspaces.get(ws)?.name ?? ws.slice(0, 8) : "(no workspace)"),
  });
  // Every paused process goes on when the daemon exits (index.ts turns SIGTERM/SIGINT into exit).
  process.on("exit", () => {
    const n = ladder?.resumeAllSync("shutdown", startsSync) ?? 0;
    if (n) console.log(`[ladder] exit: SIGCONT ${n} paused process(es)`);
  });
  setInterval(() => void reaper?.tick(), cfg.tickMs).unref?.();
  bus.on("event", (e: any) => {
    if (e?.topic === "session.ended" || e?.topic === "run.ended") reaper?.kick();
  });
  console.log(
    `[reaper] ${cfg.mode === "dry" ? "DRY RUN (logs, never signals)" : "on"} — every ${Math.round(cfg.tickMs / 1000)}s; ` +
      `ended owners' leftovers SIGTERM→SIGKILL after ${Math.round(cfg.killGraceMs / 1000)}s; leak-family orphans after ${Math.round(cfg.orphanGraceMs / 1000)}s`,
  );
  const lc = CONFIG.ladder;
  console.log(
    `[ladder] ${ladderMode()} — over-budget workspaces on a strained Mac: warn every ${Math.round(lc.warnEveryMs / 60_000)} min` +
      `, renice to ${lc.slowNice} after ${Math.round(lc.slowAfterMs / 1000)}s${ladderMode() === "warn" ? " (would)" : ""}` +
      `, pause on critical pressure${ladderMode() === "on" ? "" : " (would)"}; reserve max(${Math.round(lc.reserveMinMb / 1024)} GB, ${lc.reservePct}%) RAM`,
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
  /** Processes an ended owner left that the reaper deliberately spared (daemonized on purpose / keep-list). */
  left_running: number;
};
export type WorkspaceRollup = {
  workspace_id: string | null;
  pids: number;
  rss_mb: number;
  cpu: number;
  orphans: number;
  reaped: number;
  left_running: number;
} & Partial<Omit<WsView, "workspace_id">>;
export type ProcsView = {
  mode: ReaperMode;
  every_ms: number;
  sampled_at: number | null;
  /** The budget ladder on this Mac (RESOURCES.md → PR 2); null while it has not measured yet or the reaper is off. */
  ladder: LadderView | null;
  workspaces: WorkspaceRollup[];
  owners: OwnerRollup[];
};

/**
 * What `GET /machine` shows: per terminal/run and per workspace, what they hold right now and how
 * much was reaped since the daemon started. `ws` = the caller's workspace (null = admin, sees all):
 * a workspace token sees only its own rows — never another workspace's ids or counts.
 */
export function procsView(ws: string | null, r: Reaper | null = reaper, l: Ladder | null = r === reaper ? ladder : null): ProcsView {
  const cfg = r?.cfg ?? CONFIG.reaper;
  const lv = l?.view() ?? null;
  const base: ProcsView = { mode: r ? cfg.mode : "off", every_ms: cfg.tickMs, sampled_at: r?.ledger.sampledAt ?? null, ladder: lv?.measured_at != null ? lv : null, workspaces: [], owners: [] };
  if (!r) return base;
  const roll = r.ledger.rollup();
  const byWs = new Map<string, WorkspaceRollup>();
  const wsRow = (id: string | null) => {
    const k = id ?? "";
    let w = byWs.get(k);
    if (!w) { w = { workspace_id: id, pids: 0, rss_mb: 0, cpu: 0, orphans: 0, reaped: r.reapedByWs.get(k) ?? 0, left_running: 0 }; byWs.set(k, w); }
    return w;
  };
  for (const o of r.ledger.owners.values()) {
    if (ws != null && o.workspaceId !== ws) continue;
    const x = roll.get(o.key) ?? { pids: 0, rssKb: 0, cpu: 0, orphans: 0, left: 0 };
    const row: OwnerRollup = {
      kind: o.kind, id: o.id, workspace_id: o.workspaceId, ended: o.ended,
      pids: x.pids, rss_mb: Math.round(x.rssKb / 1024), cpu: Math.round(x.cpu * 10) / 10, orphans: x.orphans, reaped: o.reaped, left_running: x.left,
    };
    base.owners.push(row);
    const w = wsRow(o.workspaceId);
    w.pids += row.pids; w.rss_mb += row.rss_mb; w.cpu = Math.round((w.cpu + row.cpu) * 10) / 10; w.orphans += row.orphans; w.left_running += row.left_running;
  }
  // A workspace whose reaped work is all gone still shows what was reaped.
  for (const k of r.reapedByWs.keys()) {
    const id = k || null;
    if (ws != null && id !== ws) continue;
    wsRow(id);
  }
  // Each workspace's share, budget, usage and rung — a workspace token sees only its own line.
  if (l && lv?.measured_at != null) {
    for (const id of l.workspaces()) if (ws == null || id === ws) wsRow(id);
    for (const row of byWs.values()) {
      const v = l.wsView(row.workspace_id);
      if (v) { const { workspace_id: _w, ...rest } = v; Object.assign(row, rest); }
    }
  }
  base.owners.sort((a, b) => b.rss_mb - a.rss_mb);
  base.workspaces = [...byWs.values()].sort((a, b) => b.rss_mb - a.rss_mb);
  return base;
}
