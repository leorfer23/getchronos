import { tickets, repos, workspaces, reviews } from "./store.js";
import { updateTicket, dispatchCiFix, ticketBranch } from "./tickets.js";
import { maybeRunGate } from "./merge-gate.js";
import { dismiss } from "./reviews.js";
import { childEnv } from "./child-env.js";
import { execFileTimed } from "./exec.js";
import { bus } from "./bus.js";
import { CONFIG } from "./config.js";
import { notify } from "./telegram.js";
import { notifyInfo } from "./telegram/api.js";
import { tref } from "./telegram/api.js";
import { maybeDistillSkill } from "./distill.js";
import { queueSelfDeploy } from "./self-deploy.js";
import type { Ticket, CiCheck } from "./types.js";

const MAX_POLL = 20; // cap open PRs polled per sweep (protect the tick from a huge backlog)
// Orphan pending reviews (delivery=pr, no pr_url) — look up the deterministic mc/<key> branch.
// Capped so a backlog of old reviews can't stall the monitor tick behind dozens of gh calls.
const MAX_ORPHAN_RECONCILE = 10;

// A gh PR state string → the ticket transition it implies. OPEN/unknown → null (leave as-is).
export function applyPrState(ghState: string): { pr_state: "merged" | "closed"; delivered: boolean } | null {
  const s = ghState.trim().toUpperCase();
  if (s === "MERGED") return { pr_state: "merged", delivered: true };
  if (s === "CLOSED") return { pr_state: "closed", delivered: false };
  return null;
}

// Collapse gh's statusCheckRollup array into one CI signal. A rollup entry is either a CheckRun
// (has `.status` COMPLETED/IN_PROGRESS/QUEUED + `.conclusion` SUCCESS/FAILURE/…) or a legacy
// StatusContext (has `.state` SUCCESS/PENDING/FAILURE/ERROR). Empty → null (repo has no CI).
export function ciRollup(rollup: any[] | null | undefined): "pending" | "passing" | "failing" | null {
  const checks = ciChecks(rollup);
  if (checks === null) return null;
  if (checks.some((c) => c.state === "failing")) return "failing"; // one red → failing
  if (checks.some((c) => c.state === "pending")) return "pending";
  return "passing";
}

// Per-check breakdown for the UI. A rollup entry is either a CheckRun (name/status/conclusion/detailsUrl)
// or a legacy StatusContext (context/state/targetUrl). null = no CI configured on the repo.
export function ciChecks(rollup: any[] | null | undefined): CiCheck[] | null {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  const bad = ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"];
  const running = ["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED"];
  return rollup.map((c) => {
    const status = String(c?.status ?? "").toUpperCase();
    const concl = String(c?.conclusion ?? "").toUpperCase();
    const state = String(c?.state ?? "").toUpperCase();
    let s: CiCheck["state"] = "passing";
    if (bad.includes(concl) || bad.includes(state)) s = "failing";
    else if ((status && status !== "COMPLETED") || running.includes(state) || (!status && !state && !concl)) s = "pending";
    return {
      name: String(c?.name || c?.context || c?.workflowName || "check"),
      state: s,
      url: c?.detailsUrl || c?.targetUrl || null,
    };
  });
}

// gh generates the PR URL, but validate its shape before handing it to execFile — never trust a
// stored string blindly as a CLI arg. https://github.com/<owner>/<repo>/pull/<n> only.
export function isPrUrl(u: string | null | undefined): u is string {
  return !!u && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(u);
}

// Split open PRs into the sweep batch + overflow count (capping).
export function pollList(open: Ticket[]): { poll: Ticket[]; overflow: number } {
  return { poll: open.slice(0, MAX_POLL), overflow: Math.max(0, open.length - MAX_POLL) };
}

// PR landed on main → the ticket is truly done. Shared by the poll sweep and the in-app Merge PR.
// A review can still be "pending" here — e.g. merged by hand on GitHub, bypassing the in-app
// Approve/Merge — and would otherwise sit in the queue forever (nothing else ever re-checks a
// merged ticket's review). Auto-resolve it: the code already landed, so dismiss (not approve/merge)
// is the right exit — it closes the row without re-running ship logic on an already-merged PR.
export async function markDelivered(t: Ticket): Promise<void> {
  updateTicket(t.id, { pr_state: "merged", status: "done" });
  const pending = reviews.byTicket(t.id).find((r) => r.state === "pending");
  if (pending) dismiss(pending.id, "[auto-resolved: PR merged]", "system");
  bus.publish({ topic: "ticket.delivered", ticket_id: t.id, pr_url: t.pr_url!, ticket_key: t.key });
  try { maybeDistillSkill(t.id); } catch (e) { console.error("[distill] failed", e); }
  // Chronos' own repo: merged code does nothing until dist/ is rebuilt and launchd re-execs us, so
  // queue a deploy (self-deploy.ts waits for an idle fleet) and say so — "merged" and "running" were
  // the same word all through PER-23's bad day, and they are not the same thing.
  let selfDeploy = false;
  try { selfDeploy = queueSelfDeploy(t); } catch (e) { console.error("[self-deploy] queue failed", e); }
  await notifyInfo(`🎉 ${tref(t)} PR merged${selfDeploy ? " — <b>not yet deployed</b> (waiting for an idle fleet)" : ""} — ${t.pr_url}`).catch(() => {});
  await runPostMerge(t);
}

// Per-repo post-merge command (e.g. "npm run build"): sync the repo's default branch to the just-merged
// main, then run the command in the repo root. Never throws — merge already landed; failure only notifies.
// ponytail: fetch + ff-only pull is enough because pr-delivery keeps repo.path on the default branch
// (ticket branches live in worktrees); a dirty/diverged checkout will fail the pull and just notify.
async function runPostMerge(t: Ticket): Promise<void> {
  const repo = t.repo_id ? repos.get(t.repo_id) : undefined;
  const cmd = repo?.post_merge_cmd?.trim();
  if (!cmd || !repo?.path) return;
  const ws = workspaces.get(t.workspace_id);
  const full = `git checkout ${repo.default_branch} && git pull --ff-only && ${cmd}`;
  try {
    await execFileTimed("bash", ["-lc", full], {
      cwd: repo.path,
      encoding: "utf8",
      timeout: 600_000, // arbitrary user post-merge command, not a git/gh metadata call
      env: childEnv(ws),
    });
    await notifyInfo(`🏗️ ${tref(t)} post-merge ran — <code>${cmd}</code>`).catch(() => {});
  } catch (e: any) {
    const stderr = String(e?.stderr ?? e?.message ?? e).trim().slice(-1000);
    await notify(`⚠️ ${tref(t)} post-merge failed (<code>${cmd}</code>): ${stderr}`).catch(() => {});
  }
}

// PR closed without merging → the work needs another round: back to ready.
export async function markPrClosed(t: Ticket): Promise<void> {
  updateTicket(t.id, { pr_state: "closed", status: "ready" });
  await notify(`⚠️ ${tref(t)} PR closed without merge — ${t.pr_url}`).catch(() => {});
}

// Merge the ticket's open PR from Mission Control (no GitHub tab needed).
// ponytail: squash is the fixed strategy; add a per-repo merge-method column if it ever matters.
export async function mergePrForTicket(ticketId: string): Promise<Ticket> {
  const t = tickets.get(ticketId);
  if (!t) throw new Error("ticket not found");
  if (!isPrUrl(t.pr_url)) throw new Error("ticket has no valid PR URL");
  const repo = t.repo_id ? repos.get(t.repo_id) : undefined;
  if (!repo?.path) throw new Error("ticket has no repo path");
  const ws = workspaces.get(t.workspace_id);
  try {
    await execFileTimed("gh", ["pr", "merge", t.pr_url, "--squash"], {
      cwd: repo.path,
      env: childEnv(ws),
      encoding: "utf8",
      timeout: 30_000, // merge can take longer than a metadata read (required-checks re-evaluation)
    });
  } catch (e: any) {
    throw new Error(`gh pr merge failed: ${String(e?.stderr ?? e?.message ?? e).trim()}`);
  }
  await markDelivered(t);
  return tickets.get(ticketId)!;
}

// ponytail: process-lifetime set, one entry per failing ticket per day — same growth profile as
// monitor's `alerted`. Prune if it ever matters.
const ghFailAlerted = new Set<string>();

// Process-lifetime count of auto-fix dispatches per ticket — cap so a fix that keeps failing doesn't
// loop forever (each failing→push→failing transition would otherwise re-trigger).
const ciFixAttempts = new Map<string, number>();

async function maybeAutoFix(t: Ticket): Promise<void> {
  const n = ciFixAttempts.get(t.id) ?? 0;
  if (n >= CONFIG.ciFixMaxAttempts) {
    await notify(`🔴 ${tref(t)} CI still failing after ${n} auto-fix ${n === 1 ? "try" : "tries"} — needs you.`).catch(() => {});
    return;
  }
  ciFixAttempts.set(t.id, n + 1);
  try {
    await dispatchCiFix(t.id);
    await notifyInfo(`🔧 ${tref(t)} CI failed — dispatched auto-fix (attempt ${n + 1}/${CONFIG.ciFixMaxAttempts}).`).catch(() => {});
  } catch (e: any) {
    console.warn(`[delivery] auto-fix dispatch failed for ${t.key}: ${String(e?.message ?? e).trim()}`);
  }
}

/**
 * Pending PR-delivery reviews with no `pr_url` are invisible to the open-PR poll — delivery.ts only
 * walks `pr_state='open'`. When a human (or GitHub auto-merge) lands the branch outside Chronos,
 * the review sits in Inbox forever (PER-92 class). Look up the deterministic `mc/<key>` branch and
 * apply the same transitions the open-PR poll would.
 *
 * `viewPr` is injectable so tests never shell out to `gh` (CLAUDE.md).
 */
export type GhPrView = {
  url?: string;
  state?: string;
  statusCheckRollup?: any[];
};

export type ViewPrFn = (branch: string, cwd: string, env: NodeJS.ProcessEnv) => Promise<GhPrView | null>;

const realViewPr: ViewPrFn = async (branch, cwd, env) => {
  try {
    const raw = (
      await execFileTimed("gh", ["pr", "view", branch, "--json", "url,state,statusCheckRollup"], {
        cwd,
        env,
        encoding: "utf8",
        timeout: 15_000,
      })
    ).stdout.trim();
    return JSON.parse(raw) as GhPrView;
  } catch {
    return null; // no PR for this branch, or gh unavailable — leave the review alone
  }
};

let viewPr: ViewPrFn = realViewPr;

/** Swap the gh lookup for tests. Pass null to restore. */
export function setViewPr(fn: ViewPrFn | null): void {
  viewPr = fn ?? realViewPr;
}

/**
 * Candidates: pending review + delivery=pr repo + ticket has no pr_url (or pr_state still null).
 * Newest first so a fresh ship surfaces before ancient noise.
 */
export function orphanReviewCandidates(limit = MAX_ORPHAN_RECONCILE): Ticket[] {
  const seen = new Set<string>();
  const out: Ticket[] = [];
  for (const r of reviews.list("pending")) {
    if (!r.ticket_id || seen.has(r.ticket_id)) continue;
    const t = tickets.get(r.ticket_id);
    if (!t) continue;
    if (t.pr_url && t.pr_state) continue; // already on the open-PR poll path
    const repo = t.repo_id ? repos.get(t.repo_id) : undefined;
    if (repo?.delivery !== "pr" || !repo.path) continue;
    seen.add(t.id);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Reconcile orphan pending reviews by looking up `mc/<key>` on GitHub. Returns how many tickets
 * it advanced (URL written and/or delivered/closed). Never throws.
 */
export async function reconcileOrphanReviews(limit = MAX_ORPHAN_RECONCILE): Promise<number> {
  let advanced = 0;
  for (const t of orphanReviewCandidates(limit)) {
    const repo = t.repo_id ? repos.get(t.repo_id) : undefined;
    if (!repo?.path) continue;
    const ws = workspaces.get(t.workspace_id);
    const branch = ticketBranch(t.key);
    const parsed = await viewPr(branch, repo.path, childEnv(ws) as NodeJS.ProcessEnv);
    if (!parsed?.url || !isPrUrl(parsed.url)) continue;

    const ci = ciRollup(parsed.statusCheckRollup);
    const checks = ciChecks(parsed.statusCheckRollup);
    const checksJson = checks ? JSON.stringify(checks) : null;
    // Persist the URL first so markDelivered's notify / bus payload carries a real link.
    updateTicket(t.id, {
      pr_url: parsed.url,
      ...(t.pr_state ? {} : { pr_state: "open" as const }),
      ...(ci !== t.ci_state ? { ci_state: ci } : {}),
      ...(checksJson !== t.ci_checks ? { ci_checks: checksJson } : {}),
    });
    const fresh = tickets.get(t.id)!;
    const tr = applyPrState(parsed.state ?? "");
    if (tr?.delivered) {
      await markDelivered(fresh);
      advanced++;
    } else if (tr && !tr.delivered) {
      await markPrClosed(fresh);
      advanced++;
    } else {
      // Still open — URL is enough; the regular open-PR poll takes over from here.
      advanced++;
      console.log(`[delivery] reconciled ${t.key} → ${parsed.url} (still ${parsed.state ?? "OPEN"})`);
    }
  }
  return advanced;
}

// Poll every ticket with pr_state='open': ask gh whether its PR merged/closed, apply the transition,
// and notify. Never throws (gh wrapped per-ticket; notify swallowed) so the monitor tick stays alive.
export async function pollDeliveries(now = new Date()): Promise<void> {
  // Orphans first: a ticket with no pr_url never enters the open list below. Cheap when empty.
  try {
    const n = await reconcileOrphanReviews();
    if (n) console.log(`[delivery] reconciled ${n} orphan review(s)`);
  } catch (e: any) {
    console.warn(`[delivery] orphan reconcile failed: ${String(e?.message ?? e).trim()}`);
  }

  const day = now.toISOString().slice(0, 10);
  const openAll = tickets.list().filter((t) => t.pr_state === "open");
  const { poll, overflow } = pollList(openAll);
  if (overflow) console.warn(`[delivery] ${openAll.length} open PRs — polling ${poll.length}, deferring ${overflow}`);

  for (const t of poll) {
    if (!isPrUrl(t.pr_url)) continue;
    const repo = t.repo_id ? repos.get(t.repo_id) : undefined;
    const cwd = repo?.path;
    if (!cwd) continue;
    const ws = workspaces.get(t.workspace_id);

    let raw: string;
    try {
      raw = (await execFileTimed("gh", ["pr", "view", t.pr_url, "--json", "state,statusCheckRollup"], {
        cwd,
        env: childEnv(ws),
        encoding: "utf8",
      })).stdout.trim();
    } catch (e: any) {
      const k = `${t.id}:${day}`;
      if (!ghFailAlerted.has(k)) {
        ghFailAlerted.add(k);
        console.warn(`[delivery] gh pr view failed for ${t.key}: ${String(e?.stderr ?? e?.message ?? e).trim()}`);
      }
      continue;
    }

    let parsed: { state?: string; statusCheckRollup?: any[] } = {};
    try { parsed = JSON.parse(raw); } catch { continue; }

    // CI rollup: store per-check detail + the summary state. updateTicket publishes a statusless
    // ticket.updated on any change so the UI refetches immediately (near-real-time via the fast
    // poll), not just on the next 12s tick — statusless because CI moving is not a status change,
    // and bridges that key off transitions must not announce one.
    const ci = ciRollup(parsed.statusCheckRollup);
    const checks = ciChecks(parsed.statusCheckRollup);
    const checksJson = checks ? JSON.stringify(checks) : null;
    if (ci !== t.ci_state || checksJson !== t.ci_checks) {
      updateTicket(t.id, { ci_state: ci, ci_checks: checksJson });
      if (ci === "failing" && t.ci_state !== "failing") {
        bus.publish({ topic: "ci.failed", ticket_id: t.id, pr_url: t.pr_url, ticket_key: t.key, workspace_id: t.workspace_id });
        await notify(`🔴 ${tref(t)} CI failing — ${t.pr_url}`).catch(() => {});
        if (CONFIG.autoCiFix) await maybeAutoFix(t);
      }
    }

    const tr = applyPrState(parsed.state ?? "");
    if (!tr) {
      // Still open. A merge_gate workspace routes through the agent gate INSTEAD of the blind
      // auto-merge below — otherwise green CI would merge before the gate ever looked at the diff,
      // and on a repo with no CI at all (ci === null) nothing would merge it. The gate decides both
      // cases; it re-checks CI itself before asking us to merge.
      if (ws?.merge_gate) {
        await maybeRunGate({ ...t, ci_state: ci });
        continue;
      }
      // Green CI + auto-merge on → ship it now, no manual click. Merge closes the loop.
      if (CONFIG.autoMerge && ci === "passing") {
        try {
          await mergePrForTicket(t.id);
        } catch (e: any) {
          const k = `${t.id}:${day}:merge`;
          if (!ghFailAlerted.has(k)) {
            ghFailAlerted.add(k);
            console.warn(`[delivery] auto-merge failed for ${t.key}: ${String(e?.message ?? e).trim()}`);
          }
        }
      }
      continue;
    }
    if (tr.delivered) await markDelivered(t);
    else await markPrClosed(t);
  }
}
