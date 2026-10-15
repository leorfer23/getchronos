/**
 * Per-workspace budgets: each workspace's share of THIS machine (RESOURCES.md → PR 2). Pure math, no
 * `ps`, no store — the ladder (ladder.ts) and the heavy-slot fairness rule (machine.ts HeavyPool, via
 * brain.ts) both read it.
 *
 * Measured 2026-10-02 on the 12-core / 18 GB brain: ONE Desk terminal's subagents held both heavy
 * slots and 2-4 GB of headless Chrome while load sat at 21-30. Nothing said that workspace was taking
 * more than its turn, because "its turn" was never defined. This defines it:
 *
 *  - ACTIVE workspace = owns at least one live (not ended) owner on this machine.
 *  - WEIGHT w per workspace (setting `resources.weight`, default 1). SHARE = w / Σ w(active). An idle
 *    workspace is not in the sum, so its share is lent to the rest without anyone asking.
 *  - CAPACITY = what the agents may use: RAM = total − max(3 GB, 20 %) (the OS, the daemon and the
 *    Desk keep the rest); CPU = ncpu × 100 %; heavy slots = the machine's pool size.
 *  - BUDGET = share × capacity. Slots: max(1, floor(share × slots)) — a lone workspace may hold every
 *    slot, and two equal workspaces can never both be starved to zero.
 *  - USAGE = Σ RSS and Σ %CPU of what its LIVE owners hold (CPU = median of the last 3 ticks, so one
 *    tsc spike is not a verdict), plus the slots it holds. An ended owner's leftovers are the reaper's
 *    business (killed, or deliberately left running) and do not count against the live work.
 *
 * OVER = RSS over budget or CPU over budget. Slots are not part of "over": holding more than the slot
 * budget is lending, which HeavyPool already takes back the moment another workspace waits.
 */

export const RESERVE_MIN_MB = 3 * 1024;
export const RESERVE_PCT = 20;
export const CPU_WINDOW = 3;

export type Capacity = { rssMb: number; cpu: number; slots: number };
export type Budget = { rssMb: number; cpu: number; slots: number };
export type Usage = { rssMb: number; cpu: number; slots: number };

/** What agents may use on a machine with `totalMb` RAM, `ncpu` cores and `slots` heavy slots. */
export function capacityOf(
  totalMb: number,
  ncpu: number,
  slots: number,
  reserve: { minMb: number; pct: number } = { minMb: RESERVE_MIN_MB, pct: RESERVE_PCT },
): Capacity {
  const keep = Math.max(reserve.minMb, (totalMb * reserve.pct) / 100);
  return { rssMb: Math.max(0, totalMb - keep), cpu: Math.max(1, ncpu) * 100, slots: Math.max(1, Math.round(slots)) };
}

/** A weight as the setting gives it: a positive finite number, else the default 1. */
export const cleanWeight = (w: unknown): number => (typeof w === "number" && Number.isFinite(w) && w > 0 ? w : 1);

/**
 * Each workspace's share among `active`. A workspace asked about that is NOT active (`also`) gets the
 * share it would have if it became active — what `GET /machine` shows for a workspace with nothing
 * running, and never part of anyone else's denominator.
 */
export function sharesOf(active: Iterable<string>, weightOf: (ws: string) => number, also: Iterable<string> = []): Map<string, { weight: number; share: number }> {
  const act = [...new Set(active)];
  const sum = act.reduce((s, ws) => s + cleanWeight(weightOf(ws)), 0);
  const out = new Map<string, { weight: number; share: number }>();
  for (const ws of act) {
    const w = cleanWeight(weightOf(ws));
    out.set(ws, { weight: w, share: sum > 0 ? w / sum : 1 });
  }
  for (const ws of also) {
    if (out.has(ws)) continue;
    const w = cleanWeight(weightOf(ws));
    out.set(ws, { weight: w, share: w / (sum + w) });
  }
  return out;
}

export function budgetOf(share: number, cap: Capacity): Budget {
  const s = Math.max(0, Math.min(1, share));
  return { rssMb: s * cap.rssMb, cpu: s * cap.cpu, slots: Math.max(1, Math.floor(s * cap.slots + 1e-9)) };
}

/** Over on RAM or CPU (see the header for why slots are not a verdict). */
export const isOver = (u: Usage, b: Budget): boolean => u.rssMb > b.rssMb || u.cpu > b.cpu;

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The heavy-slot budget HeavyPool asks about (machine.ts `SlotBudget`): `ws`'s share among every
 * workspace active on the machine plus every contender in the pool (a waiter is active by definition,
 * even on a host whose ledger the brain does not see).
 */
export function slotBudgetOf(ws: string, contenders: string[], slots: number, active: Iterable<string>, weightOf: (ws: string) => number): number {
  const all = new Set<string>([...active, ...contenders, ws]);
  const share = sharesOf(all, weightOf).get(ws)!.share;
  return budgetOf(share, { rssMb: 0, cpu: 0, slots }).slots;
}

/**
 * Is the machine strained — the only time the ladder acts? Admission's own inputs (machine.ts
 * `MachineLoad`): memory pressure at warning or worse, or load per core over the governor's line.
 * `critical` = pressure critical: the pause rung's extra condition.
 */
export function strainOf(load: { loadPerCore: number; pressureLevel: 1 | 2 | 4 | null }, maxLoadPerCore: number): { strained: boolean; critical: boolean } {
  const critical = load.pressureLevel === 4;
  const strained = critical || load.pressureLevel === 2 || load.loadPerCore > maxLoadPerCore;
  return { strained, critical };
}
