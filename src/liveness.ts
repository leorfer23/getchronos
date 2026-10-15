/**
 * Liveness-aware stall detection.
 *
 * A quiet event stream is not evidence that an agent stopped. An agent writing source, then tests,
 * then docs for twenty minutes emits nothing a run event can see, and the "⚠️ quiet for 20m" alarm
 * that followed is the one the operator learned to ignore. So quiet never escalates on its own here:
 * the sweep looks for positive evidence the run is still alive — run events/steps, then pty output,
 * then writes under its own checkout, stopping at the first hit — and DEFERS instead of alarming when
 * it finds any. Only quiet with no evidence at all escalates, and then with a per-run count so the
 * third such check can say a human has to look.
 *
 * Semantics copied from the open-source firstmate supervisor (docs/architecture.md, "Event-driven
 * supervision"): stale panes, worktree write evidence, FM_STALE_ESCALATE_SECS,
 * FM_WEDGE_DEMAND_INSPECT_COUNT and the deferral rules. None of its bash.
 *
 * The decision itself (`stallVerdict`) is pure: the caller gathers evidence and injects it, so every
 * threshold edge is testable without a wall clock.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessions } from "./store.js";
import { sessionActivity } from "./terminal.js";
import type { BlockedReason } from "./agent-lifecycle.js";
import type { Session, TicketStatus } from "./types.js";

export type EvidenceKind = "events" | "pty" | "worktree";

export interface LivenessEvidence {
  /** A run event or step update landed inside the quiet window (what isStalled already reads). */
  events: boolean;
  /** A live terminal working this run's ticket/checkout rendered new output inside the window. */
  ptyChurn: boolean;
  /** A file under the run's own checkout was written inside the window. */
  worktreeWrite: boolean;
}

export type StallAction = "alive" | "wait" | "defer" | "escalate";

export interface StallVerdict {
  action: StallAction;
  /** Which evidence carried an `alive` / `defer` verdict. */
  evidence: EvidenceKind | null;
  /** Escalation count to persist for the next sweep. Evidence and declared waits reset it to 0. */
  escalations: number;
  /** Quiet with no evidence for `cfg.inspectCount` sweeps running — a human has to look. */
  demandInspection: boolean;
  /** Tell the operator on this sweep. Defers are silent by design; waits use the long cadence. */
  surface: boolean;
  /** Lifecycle `state_label` (Desk card, /api/agents/rollup). Null on `alive` — nothing to overlay. */
  label: string | null;
}

/**
 * What to do about a RUNNING run that has gone quiet. Pure: `quietMs`, the evidence and the previous
 * escalation count are all injected, so the thresholds are testable without wall-clock races.
 * The caller is responsible for the 0-means-off switch and for the quiet threshold itself (isStalled) —
 * this decides only what a confirmed quiet window means.
 */
export function stallVerdict(input: {
  quietMs: number;
  evidence: LivenessEvidence;
  /** Escalations counted by previous sweeps. */
  escalations: number;
  /** Who or what the run is openly waiting on — a declared wait, not a stall. */
  declaredWait: string | null;
  /** ms since this wait was last surfaced to the operator; null = never. */
  sinceSurfacedMs: number | null;
  cfg: { inspectCount: number; pauseResurfaceMs: number };
}): StallVerdict {
  const quiet = `quiet ${Math.max(0, Math.round(input.quietMs / 60_000))}m`;
  const ev = input.evidence;

  if (ev.events)
    return { action: "alive", evidence: "events", escalations: 0, demandInspection: false, surface: false, label: null };

  // A declared wait is a decision someone owes, not a wedge: it never escalates, and it says so at
  // most once per pauseResurfaceMs so a four-hour wait is not four hours of alarms.
  if (input.declaredWait)
    return {
      action: "wait",
      evidence: null,
      escalations: 0,
      demandInspection: false,
      surface: input.sinceSurfacedMs == null || input.sinceSurfacedMs > input.cfg.pauseResurfaceMs,
      label: `${quiet}, waiting on ${input.declaredWait}`,
    };

  const hit: EvidenceKind | null = ev.ptyChurn ? "pty" : ev.worktreeWrite ? "worktree" : null;
  if (hit)
    return {
      action: "defer",
      evidence: hit,
      escalations: 0,
      demandInspection: false,
      surface: false,
      label: `${quiet}, ${hit === "pty" ? "terminal active" : "still writing files"}`,
    };

  const escalations = input.escalations + 1;
  const demandInspection = escalations >= input.cfg.inspectCount;
  return {
    action: "escalate",
    evidence: null,
    escalations,
    demandInspection,
    // Two lines per stall, ever: the first one, and the one that says a human has to look.
    surface: escalations === 1 || escalations === input.cfg.inspectCount,
    label: demandInspection
      ? `${quiet}, no files written, no terminal output for ${escalations} checks — needs a look`
      : `${quiet}, no liveness evidence`,
  };
}

const TICKET_WAITS: Partial<Record<TicketStatus, { on: string; reason: BlockedReason }>> = {
  planned: { on: "your approve/continue on the plan", reason: "approval" },
  review: { on: "your review", reason: "review" },
  shipping: { on: "the PR to land", reason: "review" },
  blocked: { on: "you — the ticket is blocked", reason: "hitl" },
};

/**
 * Is this run in a wait it declared, rather than one it fell into? An open ask, or a ticket the
 * operator is holding (plan to approve, review to do, PR to merge, blocked by hand). Pure.
 */
export function declaredWait(input: {
  openAskQuestion?: string | null;
  ticketStatus?: string | null;
}): { on: string; reason: BlockedReason } | null {
  const q = input.openAskQuestion?.trim();
  if (q) return { on: `an answer: “${q.length > 60 ? q.slice(0, 59) + "…" : q}”`, reason: "question" };
  return TICKET_WAITS[(input.ticketStatus ?? "") as TicketStatus] ?? null;
}

export interface WalkBounds {
  /** Directory names never descended into. */
  prune: string[];
  maxDepth: number;
  timeoutMs: number;
}

/**
 * The checkout a walk may be taken in, or null. Guards the walk against a run whose `cwd` is a plain
 * home directory (jobs.create falls back to $HOME): depth 6 under $HOME always finds something freshly
 * written, which would silence the detector for every job that never declared a cwd. Only a real git
 * checkout qualifies.
 */
export function walkableCheckout(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const p = path.resolve(cwd);
  if (p === "/" || p === path.resolve(os.homedir())) return null;
  try {
    return fs.existsSync(path.join(p, ".git")) ? p : null; // dir in a repo, file in a worktree
  } catch {
    return null;
  }
}

/**
 * Is anything under `root` newer than `sinceMs`? Bounded three ways — pruned directory names, a max
 * depth, and a wall-clock deadline — because this runs on the daemon's own event loop, and only ever
 * in the branch that was about to escalate.
 *
 * ANY failure or a blown deadline returns false ("no evidence"), never true: a walk that could not
 * finish must leave the escalation schedule exactly as it was.
 */
export function hasRecentWrite(root: string, sinceMs: number, bounds: WalkBounds, nowMs = Date.now()): boolean {
  const deadline = nowMs + Math.max(0, bounds.timeoutMs);
  const prune = new Set(bounds.prune);
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let seen = 0;
  try {
    while (stack.length) {
      if (Date.now() > deadline) return false;
      const { dir, depth } = stack.pop()!;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if ((++seen & 63) === 0 && Date.now() > deadline) return false;
        if (ent.isSymbolicLink()) continue; // never follow a link back out of the tree
        const isDir = ent.isDirectory();
        if (isDir && prune.has(ent.name)) continue;
        const p = path.join(dir, ent.name);
        let mtimeMs: number;
        try { mtimeMs = fs.statSync(p).mtimeMs; } catch { continue; }
        // A directory's own mtime moves when a file is added or removed in it, so the depth bound
        // still catches writes one level below the deepest directory actually walked.
        if (mtimeMs > sinceMs) return true;
        if (isDir && depth + 1 <= bounds.maxDepth) stack.push({ dir: p, depth: depth + 1 });
      }
    }
  } catch {
    return false;
  }
  return false;
}

export interface TerminalProbe {
  live?: () => Session[];
  activity?: (id: string) => { last_out: number | null };
}

/**
 * Newest pty output (ms epoch) across the live terminals working this run's ticket or checkout, or
 * null when no terminal matches. terminal.ts already tracks `last_out` per live pty, so this is a
 * memory read — cheap enough to take on every quiet run, unlike the worktree walk.
 */
export function lastTerminalOutputMs(
  match: { ticketId?: string | null; cwd?: string | null },
  probe: TerminalProbe = {}
): number | null {
  const live = probe.live ?? (() => sessions.list({ status: "live" }));
  const activity = probe.activity ?? sessionActivity;
  let newest: number | null = null;
  for (const s of live()) {
    const mine =
      (!!match.ticketId && s.ticket_id === match.ticketId) ||
      (!!match.cwd && (s.cwd === match.cwd || s.worktree_path === match.cwd));
    if (!mine) continue;
    const out = activity(s.id).last_out;
    if (out != null && (newest == null || out > newest)) newest = out;
  }
  return newest;
}
