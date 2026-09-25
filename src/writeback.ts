/**
 * Write-back card — close the loop with an external tracker (ClickUp/Jira) when Chronos finishes a
 * ticket that mirrors one, at the cost of exactly one tap.
 *
 * src/connectors/index.ts is unambiguous: sync is pull-only, and any write-back is an EXPLICIT,
 * operator-initiated action — that is not negotiable here either. What this module removes is the
 * friction of remembering to do it by hand: when a connector-linked ticket reaches `done`, it composes
 * a plain-text comment (title, what shipped, PR link if any — template only, no LLM call, ever) plus
 * the mapped close transition, and asks. Nothing reaches ClickUp/Jira until a human taps ✅.
 *
 * State lives in `kv` (`writeback.<ticket_id>` = JSON WritebackProposal), same pattern as
 * recovery.ts's `recover.<id>`: the ticket row is the record of the work, this only records what was
 * proposed and what the human said about it. Survives restarts — the Telegram card's callback_data
 * only carries a ticket id prefix, so decideWriteback re-reads the real proposal from kv every time.
 */
import { bus } from "./bus.js";
import { CONFIG } from "./config.js";
import { kv, tickets, workspaces } from "./store.js";
import { pushComment, pushStatus } from "./connectors/index.js";
import { externalStatusFor } from "./connectors/types.js";
import { notify, esc } from "./telegram/api.js";
import { kb } from "./telegram/keyboards.js";
import type { Ticket } from "./types.js";

export type WritebackDecision = "proposed" | "approved" | "declined" | "failed";

export interface WritebackProposal {
  ticketId: string;
  ticketKey: string;
  workspaceId: string;
  externalSystem: string;
  externalId: string;
  /** Plain-text comment body — posted to the tracker verbatim, so no HTML/markdown here. */
  comment: string;
  /** The tracker's status label the close would push, or null when this local status isn't mapped
   *  (connector_config.status_map) — the proposal then offers comment-only. */
  targetStatus: string | null;
  prUrl: string | null;
  decision: WritebackDecision;
  proposedAt: string;
  decidedAt?: string;
  /** Last push error, kept so a failed attempt is legible without re-deriving it. */
  error?: string;
}

const key = (ticketId: string) => `writeback.${ticketId}`;

export function getProposal(ticketId: string): WritebackProposal | undefined {
  const raw = kv.get(key(ticketId));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as WritebackProposal;
  } catch {
    return undefined;
  }
}

function saveProposal(p: WritebackProposal): void {
  kv.set(key(p.ticketId), JSON.stringify(p));
}

/**
 * Pure, template-only composition — no LLM call (the operator is cost-sensitive about agents; this
 * costs nothing but a string join). Prefers the build agent's structured handoff, falls back to the
 * AI-generated summary, then to just the title. Truncated so a huge handoff doesn't blow up a tracker
 * comment field.
 */
export function composeWritebackComment(
  t: Pick<Ticket, "title" | "report" | "summary" | "pr_url">
): string {
  const body = (t.report?.trim() || t.summary?.trim() || "").slice(0, 1200);
  const lines = [`Shipped via Chronos: ${t.title}`.trim()];
  if (body) lines.push("", body);
  if (t.pr_url) lines.push("", `PR: ${t.pr_url}`);
  return lines.join("\n");
}

function cardText(p: WritebackProposal): string {
  return (
    `🔗 <b>Write-back ready</b> — ${esc(p.ticketKey)} → ${esc(p.externalSystem)}\n` +
    `<i>${esc(p.comment.slice(0, 500))}</i>\n\n` +
    (p.targetStatus
      ? `Tap ✅ to post that comment and close it (→ ${esc(p.targetStatus)}) on ${esc(p.externalSystem)}.`
      : `Tap ✅ to post that comment on ${esc(p.externalSystem)} (no status mapped for 'done' — comment only).`)
  );
}

const wbKb = (p: WritebackProposal) => {
  const i = p.ticketId.slice(0, 8);
  return kb([[{ text: "✅ Push", data: `wb.ok.${i}` }, { text: "✕ Skip", data: `wb.no.${i}` }]]);
};

/**
 * Compose + persist + notify. Called once per ticket, off the `ticket.updated` status:"done" bus
 * event (see startWriteback below) — a ticket already carrying a proposal is left alone (including a
 * declined one: like recovery.ts, a decline is never re-asked). Returns null when there's nothing to
 * propose (killswitch off, no external link, no connector configured) so callers can no-op quietly.
 */
export async function proposeWriteback(t: Ticket): Promise<WritebackProposal | null> {
  if (!CONFIG.writebackCard) return null;
  if (!t.external_system || !t.external_id) return null;
  if (getProposal(t.id)) return null; // already asked about this ticket (proposed/approved/declined/failed)

  const ws = workspaces.get(t.workspace_id);
  if (!ws?.connector_config) return null;
  let cfg: Record<string, any>;
  try {
    cfg = JSON.parse(ws.connector_config);
  } catch {
    return null;
  }

  const proposal: WritebackProposal = {
    ticketId: t.id,
    ticketKey: t.key,
    workspaceId: t.workspace_id,
    externalSystem: t.external_system,
    externalId: t.external_id,
    comment: composeWritebackComment(t),
    targetStatus: externalStatusFor("done", cfg),
    prUrl: t.pr_url,
    decision: "proposed",
    proposedAt: new Date().toISOString(),
  };
  saveProposal(proposal);

  await notify(cardText(proposal), wbKb(proposal)).catch(() => {});
  return proposal;
}

/**
 * Apply the operator's decision. ✅ is the ONLY path that ever calls the tracker — declining just
 * records the decision. A push failure leaves `decision: "failed"` (not "approved"), so the exact
 * same proposal (comment + target status) can be retried by tapping ✅ again.
 */
export async function decideWriteback(ticketId: string, approve: boolean): Promise<string> {
  const p = getProposal(ticketId);
  if (!p) return "⚠️ No write-back proposal for that ticket (may already be handled).";
  if (p.decision === "approved") return `Already pushed to ${p.externalSystem}.`;
  if (p.decision === "declined") return `Already skipped — not pushing to ${p.externalSystem}.`;

  if (!approve) {
    p.decision = "declined";
    p.decidedAt = new Date().toISOString();
    saveProposal(p);
    return `✕ Skipped — ${p.ticketKey} won't be pushed to ${p.externalSystem}.`;
  }

  const t = tickets.get(ticketId);
  if (!t) return `⚠️ ${p.ticketKey} no longer exists.`;

  try {
    await pushComment(t, p.comment);
    if (p.targetStatus) await pushStatus(t);
    p.decision = "approved";
    p.decidedAt = new Date().toISOString();
    p.error = undefined;
    saveProposal(p);
    return `✅ Pushed to ${p.externalSystem}${p.targetStatus ? " — comment + closed" : " — comment only"}.`;
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 300);
    p.decision = "failed";
    p.error = msg;
    saveProposal(p);
    // Re-offer the same card — the original's buttons were stripped by the caller (telegram.ts), so
    // without a fresh one there'd be no way to retap ✅ and retry.
    await notify(
      `⚠️ <b>Write-back failed</b> — ${esc(p.ticketKey)} → ${esc(p.externalSystem)}: ${esc(msg)}\nTap ✅ to retry.`,
      wbKb(p),
    ).catch(() => {});
    return `⚠️ Push to ${p.externalSystem} failed: ${msg}`;
  }
}

/**
 * Wire the choke point. Every path that lands a ticket on 'done' — reviews.ts merge()/transition(),
 * delivery.ts's PR-merge poll, `mc done` / PATCH /tickets/:id — funnels
 * through either tickets.ts's updateTicket() or reviews.ts's own transition(), and BOTH publish the
 * same `ticket.updated` / status:"done" bus event. That shared event is the one real choke point;
 * hooking here (like ideas.ts's followups listener) covers all of them without touching each site.
 *
 * The one status:"done" source this deliberately ignores is connectors/index.ts's sync reconcile,
 * tagged `actor: "connector-sync"` — that fires when the TRACKER told Chronos the ticket is done, so
 * proposing to tell the tracker back would be an odd echo of itself, not a write-back. Same for the
 * inbox's ✓ Done (`actor: "inbox-done"`, src/inbox-done.ts): it closed the tracker task first.
 */
export function startWriteback(): void {
  bus.on("event", (e: any) => {
    if (e.topic !== "ticket.updated" || e.status !== "done") return;
    if (e.actor === "connector-sync" || e.actor === "inbox-done") return;
    const t = tickets.get(e.ticket_id);
    if (!t) return;
    proposeWriteback(t).catch((err) => console.warn(`[writeback] propose failed for ${t.key}:`, err?.message ?? err));
  });
  console.log("[writeback] card listener ready" + (CONFIG.writebackCard ? "" : " (CHRONOS_WRITEBACK_CARD=off)"));
}
