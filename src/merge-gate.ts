import { bus, type BusEvent } from "./bus.js";
import { CONFIG } from "./config.js";
import { notify } from "./telegram.js";
import { tref } from "./telegram/api.js";
import { mergePrForTicket } from "./delivery.js";
import { appendNote, dispatchMergeGate } from "./tickets.js";
import { runs } from "./store/runs.js";
import { tickets } from "./store/tickets.js";
import { workspaces } from "./store/workspaces.js";

// The gate agent's contract: its LAST line is the verdict. Anchored to line start and tolerant of
// the em-dash/hyphen the model may pick, but NOT of a bare "APPROVE" elsewhere in the prose —
// a gate that merely mentions the word must not be read as a decision to merge.
const VERDICT_RE = /^MERGE-GATE:\s*(APPROVE|HOLD)\b\s*[—–-]?\s*(.*)$/im;

export function parseVerdict(summary: string | null | undefined): { approved: boolean; reason: string } | null {
  if (!summary) return null;
  // Last match wins: the agent may quote its own instructions (which contain both lines) before
  // emitting the real verdict at the end.
  let m: RegExpExecArray | null = null;
  const re = new RegExp(VERDICT_RE.source, "gim");
  for (let x = re.exec(summary); x; x = re.exec(summary)) m = x;
  if (!m) return null;
  return { approved: m[1].toUpperCase() === "APPROVE", reason: (m[2] ?? "").trim() };
}

// Per-ticket count of gate runs, process-lifetime. Same growth profile (and same caveat) as
// delivery.ts's ciFixAttempts: one entry per gated ticket until the daemon restarts.
const gateAttempts = new Map<string, number>();

export function gateAttemptsFor(ticketId: string): number {
  return gateAttempts.get(ticketId) ?? 0;
}

/** Should the delivery poll start a gate for this ticket right now? */
export function shouldRunGate(t: { id: string; workspace_id: string; pr_state?: string | null; ci_state?: string | null }): boolean {
  if (t.pr_state !== "open") return false;
  const ws = workspaces.get(t.workspace_id);
  if (!ws?.merge_gate) return false;
  // Red CI is delivery.ts's auto-fix problem, not the gate's — running both would have two agents
  // pushing to the same branch. Pending means the answer isn't in yet; wait for the next tick.
  // null = the repo has no CI at all, which is the common case here — the gate IS the check then.
  if (t.ci_state === "failing" || t.ci_state === "pending") return false;
  if (gateAttemptsFor(t.id) >= CONFIG.mergeGateMaxFixes) return false;
  return true;
}

export async function maybeRunGate(t: { id: string; key: string; workspace_id: string; pr_state?: string | null; ci_state?: string | null }): Promise<void> {
  if (!shouldRunGate(t)) return;
  gateAttempts.set(t.id, gateAttemptsFor(t.id) + 1);
  try {
    await dispatchMergeGate(t.id);
  } catch (e: any) {
    // Already-running / no-worktree are expected races on a 12s poll — log, don't alarm.
    console.warn(`[merge-gate] dispatch failed for ${t.key}: ${String(e?.message ?? e).trim()}`);
  }
}

async function onGateEnded(runId: string, ticketId: string): Promise<void> {
  const run = runs.get(runId);
  const t = tickets.get(ticketId);
  if (!run || !t) return;

  if (run.status !== "success") {
    await notify(`⚠️ ${tref(t)} merge gate run ${run.status} — PR left open for you: ${t.pr_url}`).catch(() => {});
    return;
  }

  const verdict = parseVerdict(run.summary);
  if (!verdict) {
    // No parseable verdict is a HOLD, never a merge: an agent that failed to follow the contract is
    // exactly the one whose judgement we should not act on.
    appendNote(t.id, "[merge-gate] run finished without a MERGE-GATE verdict line — not merging.", "system");
    await notify(`⚠️ ${tref(t)} merge gate gave no verdict — needs you: ${t.pr_url}`).catch(() => {});
    return;
  }

  if (!verdict.approved) {
    appendNote(t.id, `[merge-gate] HOLD — ${verdict.reason}`, "system");
    await notify(`🛑 ${tref(t)} merge gate held the PR — ${verdict.reason}\n${t.pr_url}`).catch(() => {});
    return;
  }

  // Re-read: the gate may have pushed a fix, which restarts CI. Merging now would race the checks
  // it just invalidated, so hand back to the poll — the next tick re-gates once CI settles.
  const fresh = tickets.get(ticketId);
  if (fresh?.ci_state === "pending") {
    appendNote(t.id, "[merge-gate] approved, but CI re-started after the gate's push — waiting for it.", "system");
    return;
  }
  if (fresh?.ci_state === "failing") {
    await notify(`🛑 ${tref(t)} merge gate approved but CI is red — not merging: ${t.pr_url}`).catch(() => {});
    return;
  }

  try {
    await mergePrForTicket(ticketId);
    appendNote(t.id, `[merge-gate] APPROVE — ${verdict.reason}. Merged.`, "system");
    console.log(`[merge-gate] ${t.key} merged — ${verdict.reason}`);
  } catch (e: any) {
    const why = String(e?.message ?? e).trim();
    appendNote(t.id, `[merge-gate] approved but the merge failed: ${why}`, "system");
    await notify(`⚠️ ${tref(t)} merge gate approved but merge failed — ${why}\n${t.pr_url}`).catch(() => {});
  }
}

/** One bus listener: act on the gate agent's verdict when its run ends. */
export function startMergeGate(): void {
  bus.on("event", (e: BusEvent) => {
    try {
      if (e.topic !== "run.ended" || !e.ticket_id) return;
      // run.ended carries job_name, not job_id — match on the name this dispatch always sets.
      if (!e.job_name?.startsWith("merge-gate:")) return;
      void onGateEnded(e.run_id, e.ticket_id).catch((err) => console.error("[merge-gate]", err));
    } catch (err) {
      console.error("[merge-gate]", err);
    }
  });
  console.log(`[merge-gate] listening — max ${CONFIG.mergeGateMaxFixes} attempt(s)/ticket, model ${CONFIG.mergeGateModel}`);
}
