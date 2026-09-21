/**
 * Operational health — what `/health.ok` cannot say.
 *
 * `ok: true` means the daemon process answers (launchd / Buzz presence). It does NOT mean the
 * desk is usable: a dead ClickUp token, a nine-commit deploy drift, or a review still "pending"
 * after its PR merged all leave `ok: true` while the operator's Inbox lies. This module is the read-only
 * snapshot that names those issues so Fleet and Inbox can surface them without changing liveness.
 */
import { CONFIG } from "./config.js";
import { deployStatus } from "./self-deploy.js";
import { listStalls } from "./recovery.js";
import { isCredentialError } from "./connectors/index.js";
import { gateMode, quotaSnapshotCached } from "./quota-gate.js";
import { connectorSyncs, reviews, tickets, workspaces, repos } from "./store.js";

export type IssueSeverity = "critical" | "warn" | "info";
export type IssueKind =
  | "connector"
  | "deploy"
  | "recovery"
  | "guardrail"
  | "quota"
  | "stale_review";

export type OperationalIssue = {
  id: string;
  kind: IssueKind;
  severity: IssueSeverity;
  title: string;
  detail: string;
  fix: string;
  workspace_id?: string | null;
  workspace?: string | null;
};

export type OperationalHealth = {
  status: "ok" | "degraded";
  issues: OperationalIssue[];
  checked_at: string;
};

/** How long after a connector sync we treat silence as "stale" (2× the configured interval). */
function connectorStaleMs(): number {
  const min = CONFIG.connectorSyncMin > 0 ? CONFIG.connectorSyncMin : 30;
  return min * 2 * 60_000;
}

/** Pending review older than this with no PR URL on a delivery=pr repo is stale inventory. */
const STALE_REVIEW_MS = 7 * 86_400_000;

export function operationalHealth(now = new Date()): OperationalHealth {
  const issues: OperationalIssue[] = [];
  const nowMs = now.getTime();

  // ── connectors ────────────────────────────────────────────────────────────
  const syncs = connectorSyncs.latestByWorkspace();
  for (const w of workspaces.list()) {
    if (w.ticket_connector === "native") continue;
    const sync = syncs[w.id];
    if (!sync) {
      issues.push({
        id: `connector-never:${w.id}`,
        kind: "connector",
        severity: "warn",
        title: `${w.name}: never synced`,
        detail: `No ${w.ticket_connector} sync recorded yet — tickets may be stale.`,
        fix: `Wait for the next auto-sync, or run a manual sync for ${w.slug}.`,
        workspace_id: w.id,
        workspace: w.slug,
      });
      continue;
    }
    if (sync.error) {
      const cred = isCredentialError(String(sync.error));
      issues.push({
        id: `connector-error:${w.id}`,
        kind: "connector",
        severity: cred ? "critical" : "warn",
        title: cred
          ? `${w.name}: ${w.ticket_connector} credential invalid`
          : `${w.name}: ${w.ticket_connector} sync failed`,
        detail: String(sync.error).slice(0, 240),
        fix: cred
          ? `Fix on the daemon host: node scripts/set-connector-token.mjs ${w.slug}`
          : `Inspect the last sync for ${w.slug} and retry.`,
        workspace_id: w.id,
        workspace: w.slug,
      });
      continue;
    }
    const age = nowMs - Date.parse(sync.ts);
    if (Number.isFinite(age) && age > connectorStaleMs()) {
      const hours = Math.round(age / 3_600_000);
      issues.push({
        id: `connector-stale:${w.id}`,
        kind: "connector",
        severity: "warn",
        title: `${w.name}: last sync ${hours}h ago`,
        detail: `Expected sync every ${CONFIG.connectorSyncMin || 30}m; last success was ${sync.ts}.`,
        fix: `Check connector sync for ${w.slug}.`,
        workspace_id: w.id,
        workspace: w.slug,
      });
    }
  }

  // ── deploy drift ──────────────────────────────────────────────────────────
  const deploy = deployStatus();
  if (deploy.summary) {
    issues.push({
      id: "deploy-drift",
      kind: "deploy",
      severity: deploy.pending?.state === "blocked" ? "critical" : "warn",
      title: "Chronos deploy drift",
      detail: deploy.summary,
      fix: deploy.pending
        ? "Wait for an idle fleet, or deploy by hand with npm run deploy."
        : "Deploy with npm run deploy.",
    });
  }

  // ── recovery stalls ───────────────────────────────────────────────────────
  const stalls = listStalls(true);
  if (stalls.length) {
    issues.push({
      id: "recovery-stalls",
      kind: "recovery",
      severity: "warn",
      title: `${stalls.length} stalled item${stalls.length === 1 ? "" : "s"} awaiting a call`,
      detail: stalls
        .slice(0, 3)
        .map((s) => s.line.split("\n")[0])
        .join(" · "),
      fix: "Open Inbox → Stalled, or: mc recover",
    });
  }

  // ── guardrails off ────────────────────────────────────────────────────────
  // 0 means "unlimited" by design (config.ts). Reporting that as an issue is intentional: the operator's
  // stated spend policy lives in memory notes, but the live knobs are currently all null/0.
  const anyWsBudget = workspaces.list().some((w) => w.daily_budget_usd != null && w.daily_budget_usd > 0);
  const anyWsConc = workspaces.list().some((w) => w.max_concurrent != null && w.max_concurrent > 0);
  if (CONFIG.dailyBudgetUsd <= 0 && !anyWsBudget) {
    issues.push({
      id: "guardrail-budget",
      kind: "guardrail",
      severity: "info",
      title: "No daily spend cap set",
      detail: "Global and per-workspace daily_budget_usd are all unset/0 — headless runs are uncapped.",
      fix: "Set CHRONOS_DAILY_BUDGET or a workspace daily_budget_usd.",
    });
  }
  if (CONFIG.maxConcurrent <= 0 && !anyWsConc) {
    issues.push({
      id: "guardrail-concurrency",
      kind: "guardrail",
      severity: "info",
      title: "No concurrency cap set",
      detail: "Global and per-workspace max_concurrent are all unset/0 — the fleet can fork without a ceiling.",
      fix: "Set CHRONOS_MAX_CONCURRENT or a workspace max_concurrent.",
    });
  }

  // ── provider quota ────────────────────────────────────────────────────────
  // The two facts that used to surface only as a failed run: a credential with nothing left, and one
  // nobody is logged into. Both are critical because every dispatch that reaches for them fails, and
  // neither is visible anywhere else until it does. Two deliberate silences: uncertainty is NOT
  // reported (an unmeasurable surface is not an issue, it is just unmeasurable), and neither is a
  // credential nothing on this host reaches for — see QuotaEntry.inUse. Gate off = subsystem off.
  for (const e of gateMode() === "off" ? [] : quotaSnapshotCached(nowMs).entries) {
    if (!e.inUse) continue;
    if (e.runway === "exhausted_now") {
      issues.push({
        id: `quota-exhausted:${e.provider}:${e.scope}`,
        kind: "quota",
        severity: "critical",
        title: `${e.provider} ${e.scope}: out of allowance`,
        detail: e.attention[0] ?? `runway exhausted_now${e.resetsAt ? `, back at ${e.resetsAt}` : ", no reset time known"}`,
        fix: e.resetsAt ? `Wait for ${e.resetsAt}, top up, or dispatch on another backend.` : "Top up, or dispatch on another backend.",
      });
      continue;
    }
    if (e.auth === "unauthenticated") {
      issues.push({
        id: `quota-auth:${e.provider}:${e.scope}`,
        kind: "quota",
        severity: "critical",
        title: `${e.provider} ${e.scope}: not logged in`,
        detail: e.attention[0] ?? "the credential store this backend reads does not exist",
        fix: "Log that profile in (claude /login, codex login, grok auth) — waiting never fixes it.",
      });
    }
  }

  // ── stale reviews ─────────────────────────────────────────────────────────
  // A pending review whose ticket already landed (done/shipping/pr_state=merged) is Inbox noise —
  // markDelivered should have dismissed it. Also flag long-lived pending PR-delivery reviews with
  // no pr_url: delivery.ts never polls them, so they sit forever (PER-92 class).
  for (const r of reviews.list("pending")) {
    if (!r.ticket_id) continue;
    const t = tickets.get(r.ticket_id);
    if (!t) continue;
    const ws = workspaces.get(t.workspace_id);
    if (t.status === "done" || t.status === "shipping" || t.pr_state === "merged") {
      issues.push({
        id: `stale-review-landed:${r.id}`,
        kind: "stale_review",
        severity: "warn",
        title: `${t.key}: pending review after land`,
        detail: `Ticket is ${t.status}${t.pr_state ? ` / pr=${t.pr_state}` : ""} but review ${r.id.slice(0, 8)} is still pending.`,
        fix: "Will auto-resolve on the next delivery reconcile, or dismiss in Inbox.",
        workspace_id: t.workspace_id,
        workspace: ws?.slug ?? null,
      });
      continue;
    }
    const repo = t.repo_id ? repos.get(t.repo_id) : undefined;
    if (repo?.delivery !== "pr") continue;
    if (t.pr_url) continue;
    const age = nowMs - Date.parse(r.created_at);
    if (!Number.isFinite(age) || age < STALE_REVIEW_MS) continue;
    issues.push({
      id: `stale-review-orphan:${r.id}`,
      kind: "stale_review",
      severity: "warn",
      title: `${t.key}: pending review with no PR URL`,
      detail: `Review pending since ${r.created_at.slice(0, 10)}; delivery=pr but ticket has no pr_url — delivery poll never sees it.`,
      fix: "Delivery reconcile will look up mc/<key> on GitHub; or open/dismiss manually.",
      workspace_id: t.workspace_id,
      workspace: ws?.slug ?? null,
    });
  }

  // critical > warn > info; within a severity, stable by id so the UI doesn't reshuffle.
  const rank: Record<IssueSeverity, number> = { critical: 0, warn: 1, info: 2 };
  issues.sort((a, b) => rank[a.severity] - rank[b.severity] || a.id.localeCompare(b.id));

  const status = issues.some((i) => i.severity === "critical" || i.severity === "warn") ? "degraded" : "ok";
  return { status, issues, checked_at: now.toISOString() };
}
