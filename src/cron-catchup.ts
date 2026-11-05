import { Cron } from "croner";

/**
 * Cron fires the daemon was not there for (Mac off, reboot, a deploy restart at that minute). On boot,
 * each enabled cron job whose most recent due fire has no run and no recorded skip runs once — one
 * catch-up per job, not one per missed fire. A Mac that only slept needs none of this: the daemon stays
 * up and croner fires the overdue slot within 30s of waking.
 *
 * Bounds: a fire older than the window is dropped rather than run at a random later hour (same rule as
 * one-time jobs, src/once.ts), and a job whose next regular fire is minutes away just waits for it.
 */
export const CATCHUP_SOON_MS = 15 * 60_000;
/** A run or skip that started within this of the due fire is that fire's (the job check's SLACK_MS). */
const SLACK_MS = 90_000;
/** A `* * * * *` job has 1,440 fires a day. */
const CAP = 5000;

export interface CatchupInput {
  expr: string;
  tz: string;
  /** The job's created_at — a fire before the job existed is not missed. */
  createdAt: string | null;
  /** Newest started_at among the job's runs. */
  lastStartedAt: string | null;
  /** When the scheduler last recorded a skip for it (gate / inflight / refused). */
  lastSkipAt: string | null;
  windowMs: number;
  now?: Date;
}

/** The fire to catch up now, or null. */
export function missedFire(i: CatchupInput): Date | null {
  if (!(i.windowMs > 0)) return null;
  const now = i.now ?? new Date();
  let c: Cron;
  try { c = new Cron(i.expr, { timezone: i.tz || "UTC" }); } catch { return null; }
  const born = i.createdAt ? Date.parse(i.createdAt) : NaN;
  let t: Date | null = new Date(Math.max(now.getTime() - i.windowMs, Number.isNaN(born) ? 0 : born));
  let due: Date | null = null;
  for (let n = 0; n < CAP; n++) {
    t = c.nextRun(t);
    if (!t || t > now) break;
    due = t;
  }
  if (!due) return null;
  const handled = (iso: string | null) => !!iso && Date.parse(iso) >= due!.getTime() - SLACK_MS;
  if (handled(i.lastStartedAt) || handled(i.lastSkipAt)) return null;
  const next = c.nextRun(now);
  if (next && next.getTime() - now.getTime() <= CATCHUP_SOON_MS) return null;
  return due;
}
