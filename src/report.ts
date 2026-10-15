import { workspaces, tickets, reviews, runs, sessions, connectorSyncs } from "./store.js";
import { isClosedTicketStatus } from "./types.js";

// A client-facing weekly work report for one workspace over [fromIso, toIso). Reads current DB
// state (tickets/reviews/runs/syncs) and composes concise professional markdown — no internal
// job-name jargon or per-run costs above the "— internal —" divider. Pure-ish: data in → markdown out.

export interface ReportSummary {
  workspace: string;
  slug: string;
  from: string;
  to: string;
  shipped: number;
  inFlight: number;
  builds: { ok: number; total: number };
  reviews: { approved: number; changes: number; merged: number; human: number; ai: number };
  /** Combined headless + Desk. */
  costTotal: number;
  costRuns: number;
  costSessions: number;
  costSessionsEstimated: number;
}

const day = (iso: string) => iso.slice(0, 10);
const inWin = (ts: string | null, from: string, to: string) => !!ts && ts >= from && ts <= to;
// P0..P3 sort, then key.
const byPriority = (a: { priority: string; key: string }, b: { priority: string; key: string }) =>
  a.priority.localeCompare(b.priority) || a.key.localeCompare(b.key);

export function buildReport(
  workspaceId: string,
  fromIso: string,
  toIso: string
): { markdown: string; summary: ReportSummary } {
  const ws = workspaces.get(workspaceId);
  if (!ws) throw new Error("workspace not found");

  const all = tickets.list({ workspace_id: workspaceId });
  const shipped = all.filter((t) => t.status === "done" && inWin(t.updated_at, fromIso, toIso)).sort(byPriority);
  const inFlight = all.filter((t) => !isClosedTicketStatus(t.status) && t.status !== "backlog").sort(byPriority);

  // Builds: ticket-build runs in window, success rate over terminal outcomes.
  const outcomes = runs.buildOutcomes({ workspace_id: workspaceId, from: fromIso, to: toIso });
  const count = (s: string) => outcomes.find((o) => o.status === s)?.count ?? 0;
  const buildOk = count("success");
  const buildTotal = buildOk + count("failed") + count("timeout");

  // Reviews decided in window (join to workspace via ticket); split human vs automated by actor.
  const wsTicketIds = new Set(all.map((t) => t.id));
  const rev = reviews.list().filter((r) => r.ticket_id && wsTicketIds.has(r.ticket_id) && inWin(r.reviewed_at, fromIso, toIso));
  const isAi = (actor: string | null) => !!actor && actor.startsWith("ai");
  const revSum = {
    approved: rev.filter((r) => r.state === "approved").length,
    changes: rev.filter((r) => r.state === "changes_requested").length,
    merged: rev.filter((r) => r.state === "merged").length,
    human: rev.filter((r) => !isAi(r.actor)).length,
    ai: rev.filter((r) => isAi(r.actor)).length,
  };

  const costRows = runs.costReport({ workspace_id: workspaceId, from: fromIso, to: toIso });
  const costRuns = costRows.reduce((s, r) => s + r.cost_usd, 0);
  const desk = sessions.spendSince(fromIso, { workspace_id: workspaceId, until: toIso });
  const costSessions = desk.usd;
  const costTotal = costRuns + costSessions;

  const sync = connectorSyncs.latestByWorkspace()[workspaceId];

  const md: string[] = [
    `# ${ws.name} — Weekly Report`,
    `**Period:** ${day(fromIso)} → ${day(toIso)}`,
    ``,
    `## Shipped`,
  ];
  if (shipped.length) for (const t of shipped) md.push(`- **${t.key}** ${t.title} _(${t.priority})_`);
  else md.push(`_Nothing shipped this period._`);

  md.push(``, `## In Flight`);
  if (inFlight.length) for (const t of inFlight) md.push(`- **${t.key}** ${t.title} — ${t.status} _(${t.priority})_`);
  else md.push(`_Nothing in flight._`);

  md.push(``, `## Builds`);
  md.push(
    buildTotal
      ? `${buildTotal} build${buildTotal === 1 ? "" : "s"} run · ${Math.round((buildOk / buildTotal) * 100)}% success (${buildOk}/${buildTotal}).`
      : `_No builds this period._`
  );

  md.push(``, `## Reviews`);
  if (rev.length)
    md.push(
      `Approved ${revSum.approved} · Changes requested ${revSum.changes} · Merged ${revSum.merged}.`,
      `_By reviewer: ${revSum.human} human · ${revSum.ai} automated._`
    );
  else md.push(`_No reviews this period._`);

  if (sync) {
    md.push(``, `## Connector Sync`);
    md.push(`Last synced via ${sync.connector} on ${day(sync.ts)} — pulled ${sync.pulled}, updated ${sync.updated}, created ${sync.created}.`);
  }

  // Internal-only tail: cost/stage table a freelancer wouldn't share with the client.
  md.push(``, `— internal —`, ``, `## Cost by stage (headless)`);
  if (costRows.length) {
    md.push(`| Stage | Runs | Cost | Tokens (in→out) |`, `| --- | --- | --- | --- |`);
    for (const r of costRows)
      md.push(`| ${r.stage} | ${r.runs} | $${r.cost_usd.toFixed(2)} | ${r.tokens_in}→${r.tokens_out} |`);
    md.push(`| **Headless** | | **$${costRuns.toFixed(2)}** | |`);
  } else md.push(`_No headless cost recorded._`);
  md.push(``, `## Desk terminals`);
  md.push(
    desk.sessions
      ? `${desk.sessions} terminal${desk.sessions === 1 ? "" : "s"} · $${costSessions.toFixed(2)}` +
          (desk.estimated_usd
            ? ` (of which $${desk.estimated_usd.toFixed(2)} estimated — not CLI-metered)`
            : ` (exact)`) +
          `.`
      : `_No Desk terminal spend this period._`,
  );
  md.push(``, `**Combined total: $${costTotal.toFixed(2)}**`);

  return {
    markdown: md.join("\n"),
    summary: {
      workspace: ws.name,
      slug: ws.slug,
      from: fromIso,
      to: toIso,
      shipped: shipped.length,
      inFlight: inFlight.length,
      builds: { ok: buildOk, total: buildTotal },
      reviews: revSum,
      costTotal,
      costRuns,
      costSessions,
      costSessionsEstimated: desk.estimated_usd,
    },
  };
}
