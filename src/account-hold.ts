/**
 * Account holds — should BACKGROUND work start on a Claude account right now?
 *
 * On 2026-11-17 two accounts ran dry the same afternoon. Up to the wall, hourly monitors, triage and a
 * dream pass kept spending the last fifth of a 5-hour window the operator needed for his own
 * terminals; after it, the daemon kept starting cron jobs, dream passes and reviews on those accounts,
 * every one failing at its first request. Two holds, both read from evidence Chronos already records:
 *
 *  - wall     a measured limit (quota-gate.ts: a run hit "You've hit your … limit", runway
 *             exhausted_now) whose reset is still ahead. Anything started now fails.
 *  - reserve  the vendor-reported 5-hour window (usage-meter.ts) is at or past
 *             `quota.background_reserve_pct`. Background work waits for the reset, so the rest of the
 *             window stays with the operator.
 *
 * Only background work is held: cron fires, dream passes, idea mining. Work the operator started
 * (tickets, terminals, the verifier on his hand-offs) is never held here — on a wall it fails fast and
 * the rate-limit resume (dispatcher.maybeResume) picks it up at the reset. A held cron fire is a
 * deliberate skip (the job check reads it as one) and runs again once the window resets.
 */
import path from "node:path";
import { CONFIG } from "./config.js";
import { getBackend } from "./backends/index.js";
import { credentialFor, entryFor, quotaSnapshotCached, type QuotaSnapshot } from "./quota-gate.js";
import { claudeWindow } from "./usage-meter.js";
import { routeConfigDir } from "./profile-route.js";
import { defineSetting, resolveSetting } from "./settings.js";
import { workspaces } from "./store.js";

defineSetting({
  key: "quota.background_reserve_pct", group: "Limits", level: "both", type: "int", env: "CHRONOS_BACKGROUND_RESERVE_PCT",
  label: "Keep the end of the 5-hour window for you (%)",
  help: "Once an account's 5-hour window is this full, cron jobs, dream passes and idea mining on it wait for the reset. Your terminals, tickets and reviews are never held. 0 turns it off.",
  default: () => {
    const raw = process.env.CHRONOS_BACKGROUND_RESERVE_PCT;
    const v = raw == null || raw === "" ? NaN : Number(raw);
    return Number.isFinite(v) ? v : 80;
  },
  min: 0,
  max: 100,
});
defineSetting({
  key: "quota.hold_on_wall", group: "Limits", level: "both", type: "bool", env: "CHRONOS_HOLD_ON_WALL",
  label: "Hold background work while an account is out",
  help: "After a real limit error, cron jobs, dream passes and idea mining on that account wait for its reset instead of starting and failing.",
  default: () => process.env.CHRONOS_HOLD_ON_WALL !== "0",
});

export interface Hold {
  kind: "wall" | "reserve";
  /** The reset the hold lasts until, when known. */
  until: string | null;
  /** Account label, e.g. ".claude-acme". */
  account: string;
  /** One line for logs, the job check and the Desk. */
  why: string;
}

/** The fields of a job this needs — a Job row satisfies it. */
export interface HoldJob {
  name: string;
  backend: string | null;
  workspace_id: string | null;
  profile?: string | null;
}

export interface HoldDeps {
  now?: number;
  /** The config dir the job would really run on (after sibling-account routing). */
  dirOf?: (job: HoldJob) => string;
  snapshot?: () => QuotaSnapshot;
  window5h?: (dir: string, now: number) => { usedPct: number; resetsAt: string | null } | null;
  reservePct?: (workspaceId: string | null) => number;
  holdOnWall?: (workspaceId: string | null) => boolean;
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** Same choice runner.execute makes: workspace pin → legacy profile map → default, then a sibling with room. */
export function holdDir(job: HoldJob, now = Date.now()): string {
  const ws = job.workspace_id ? workspaces.get(job.workspace_id) : undefined;
  const pinned = ws?.config_dir ?? (job.profile ? CONFIG.profiles[job.profile] : undefined) ?? CONFIG.profiles.claude;
  return routeConfigDir(pinned, job.workspace_id, now).dir;
}

const settingNum = (key: string, wsId: string | null) => Number(resolveSetting(key, wsId).value);

/**
 * The hold on this background job, or null to let it start. Only claude jobs: the other backends'
 * windows are not measured per account here (quota-gate.ts still gates them at dispatch).
 */
export function accountHold(job: HoldJob, deps: HoldDeps = {}): Hold | null {
  if (getBackend(job.backend).name !== "claude-code") return null;
  const now = deps.now ?? Date.now();
  const dir = (deps.dirOf ?? ((j) => holdDir(j, now)))(job);
  const account = path.basename(dir);

  const holdOnWall = deps.holdOnWall ? deps.holdOnWall(job.workspace_id) : resolveSetting("quota.hold_on_wall", job.workspace_id).value === true;
  if (holdOnWall) {
    const cred = credentialFor("claude-code", dir);
    const e = cred ? entryFor((deps.snapshot ?? (() => quotaSnapshotCached(now)))(), cred) : null;
    // Measured only: an inferred runway (our arithmetic) is a guess, and a guess never stops work.
    if (e && e.runway === "exhausted_now" && e.confidence === "measured" && (!e.resetsAt || Date.parse(e.resetsAt) > now)) {
      return { kind: "wall", until: e.resetsAt, account, why: `${account} is out of allowance${e.resetsAt ? ` until ${hhmm(e.resetsAt)}` : ""} — background work waits for the reset` };
    }
  }

  const pct = deps.reservePct ? deps.reservePct(job.workspace_id) : settingNum("quota.background_reserve_pct", job.workspace_id);
  if (pct > 0) {
    const w = (deps.window5h ?? ((d, n) => claudeWindow(d, "5h", n)))(dir, now);
    if (w && w.usedPct >= pct) {
      return {
        kind: "reserve", until: w.resetsAt, account,
        why: `${account} is at ${Math.round(w.usedPct)}% of its 5-hour window — the rest stays with the operator${w.resetsAt ? `; runs after ${hhmm(w.resetsAt)}` : ""}`,
      };
    }
  }
  return null;
}

/**
 * What whoever opens a claude terminal on this account should hear first, or null. Warn, never refuse
 * (dup-goal.ts's rule): the operator may open one anyway, to have it ready at the reset.
 */
export function accountNotice(dir: string, deps: Pick<HoldDeps, "now" | "snapshot" | "window5h"> & { warnPct?: number } = {}): string | null {
  const now = deps.now ?? Date.now();
  const account = path.basename(dir);
  const cred = credentialFor("claude-code", dir);
  const e = cred ? entryFor((deps.snapshot ?? (() => quotaSnapshotCached(now)))(), cred) : null;
  if (e && e.runway === "exhausted_now" && e.confidence === "measured" && (!e.resetsAt || Date.parse(e.resetsAt) > now))
    return `${account} is out of allowance${e.resetsAt ? ` until ${hhmm(e.resetsAt)}` : ""} — this terminal will stop at its first message`;
  const w = (deps.window5h ?? ((d, n) => claudeWindow(d, "5h", n)))(dir, now);
  const warn = deps.warnPct ?? 80;
  if (w && w.usedPct >= warn)
    return `${account} is at ${Math.round(w.usedPct)}% of its 5-hour window${w.resetsAt ? ` (resets ${hhmm(w.resetsAt)})` : ""}`;
  return null;
}

/** Background = nobody is waiting on it: a cron fire, a dream pass, idea mining. */
export function isBackgroundTrigger(triggerSrc: string): boolean {
  return /^(cron(:|$)|dream:|ideas:)/.test(triggerSrc);
}
