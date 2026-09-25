import { tickets as store, workspaces, connectorSyncs, deletedExternals } from "../store.js";
import { createTicket, updateTicket, writeExternalSection, lastLoggedHours, appendNote } from "../tickets.js";
import { bus } from "../bus.js";
import { CONFIG } from "../config.js";
import { notify } from "../telegram.js";
import { guard } from "../guard.js";
import { clickup } from "./clickup.js";
import { jira } from "./jira.js";
import { externalStatusFor } from "./types.js";
import { harvestComments, markPushed } from "../prose.js";
import { emitTrackerInbox, operatorId } from "../inbox.js";
import type { Connector } from "./types.js";
import { isClosedTicketStatus, type Ticket, type TicketRow, type TicketStatus, type Workspace } from "../types.js";

// Exported so tests can register a stub connector (CONNECTORS.stub = ...) without hitting the
// network via clickup.ts/jira.ts — CLAUDE.md forbids the real backend in tests; the same applies to
// hitting real external APIs.
export const CONNECTORS: Record<string, Connector> = { clickup, jira };

// States where Chronos is actively driving its own lifecycle — the tracker has no equivalent, and we
// already pushed the collapsed status out, so a pull must NOT overwrite these back down.
const LOCAL_OWNED: ReadonlySet<TicketStatus> = new Set<TicketStatus>(["planning", "planned", "in_progress", "review"]);

// The tracker's own status label, normalized for storage: untrusted external text (same ingestion
// surface as the title — it renders on boards and in `mc ticket` output), capped because a status
// column is a short label and nothing downstream wants a paragraph.
function externalLabel(statusRaw: string, conn: string, extId: string, wsId: string): string | null {
  const raw = (statusRaw ?? "").trim();
  if (!raw) return null;
  return guard(raw, `${conn} sync ${extId} status`, wsId).slice(0, 80);
}

export interface SyncResult {
  connector: string;
  pulled: number;
  created: number;
  updated: number;
  pushed: number;
  unseen: number; // locally-tracked tickets not returned by this pull (likely closed long ago / stale)
  errors: string[];
}

// Pull-only reconcile for a workspace. Internal mirror — Chronos NEVER writes back to Jira/ClickUp
// here (or anywhere automatically); the tracker is only ever read. external → local: new tasks create
// tickets; existing mirror title/status/priority + a regenerated `## External` section (description,
// metadata, comments). External write-back, if ever wanted, is an explicit operator action only.
export async function syncWorkspace(ws: Workspace): Promise<SyncResult> {
  const res: SyncResult = { connector: ws.ticket_connector, pulled: 0, created: 0, updated: 0, pushed: 0, unseen: 0, errors: [] };
  if (ws.ticket_connector === "native") return res; // nothing to sync
  const conn = CONNECTORS[ws.ticket_connector];
  if (!conn) throw new Error(`unknown connector: ${ws.ticket_connector}`);
  const cfg = ws.connector_config ? JSON.parse(ws.connector_config) : {};

  const record = (error: string | null) => {
    connectorSyncs.add({ workspace_id: ws.id, connector: res.connector, pulled: res.pulled, created: res.created, updated: res.updated, pushed: res.pushed, error });
    connectorSyncs.prune(CONFIG.connectorSyncRetain);
  };

  try {
    const external = await conn.pull(cfg);
    res.pulled = external.length;
    const seen = new Set<string>();

    // Who the operator is on this tracker — the inbox diff and the prose harvest both key on it.
    const me = conn.me ? await operatorId(ws.id, () => conn.me!(cfg)) : null;

    // The workspace inbox (src/inbox.ts): what changed FOR the operator since the last pull. Runs
    // before the mirror loop so "does Chronos already mirror this task?" means before this sync.
    // Notifications only — nothing here starts work. Best-effort: the mirror must never fail on it.
    if (me && (conn.name === "jira" || conn.name === "clickup")) {
      try {
        const n = emitTrackerInbox(ws.id, conn.name, me, external, {
          mirrored: (id) => !!store.byExternal(conn.name, id),
          // A status Chronos pushed out itself (the local ticket already maps to it) is not news.
          selfStatus: (t) => {
            const local = store.byExternal(conn.name, t.id);
            const target = local ? externalStatusFor(local.status, cfg) : null;
            return !!target && target.trim().toLowerCase() === (t.statusRaw ?? "").trim().toLowerCase();
          },
        });
        if (n) console.log(`[inbox] ${ws.slug}: +${n} from ${conn.name}`);
      } catch (e: any) {
        console.warn(`[inbox] ${ws.slug} tracker diff failed:`, e?.message ?? e);
      }
    }

    for (const t of external) {
      seen.add(t.id);
      // External title is untrusted input (arrives verbatim from ClickUp/Jira) and later flows into
      // agent goal prompts via dispatchTicket/dispatchPlan — guard it here too, at ingestion.
      const title = guard(t.title, `${conn.name} sync ${t.id}`, ws.id);
      const existing = store.byExternal(conn.name, t.id);
      if (!existing) {
        // Deleted here on purpose (PER-70) — a still-open external task must NOT respawn a local
        // mirror; the operator's delete is the deciding signal, not the tracker's status.
        if (deletedExternals.has(ws.id, conn.name, t.id)) continue;
        const created = createTicket({
          workspace_id: ws.id,
          title,
          status: t.status,
          // Brand-new mirror: this status came straight from the tracker, not Chronos deciding
          // anything. dispatchPlan/dispatchTicket flip it to 'local' the moment real work starts.
          status_source: "external",
          priority: t.priority ?? undefined,
          external_system: conn.name,
          external_id: t.id,
          external_url: t.url,
          external_status: externalLabel(t.statusRaw, conn.name, t.id, ws.id),
        });
        writeExternalSection(created.id, t);
        res.created++;
        continue;
      }

      const patch: Partial<TicketRow> = {};
      if (isClosedTicketStatus(t.status) && !isClosedTicketStatus(existing.status)) {
        // Tracker closed it → mirror the close in, even if Chronos was mid-lifecycle on it. A ticket
        // already closed here keeps the closure it has: 'dismissed' says more than 'done' does.
        patch.status = t.status;
        patch.status_source = "external"; // this status came from the tracker, not from Chronos
      } else if (!isClosedTicketStatus(existing.status) && !LOCAL_OWNED.has(existing.status) && existing.status !== t.status) {
        // Mirror the tracker's status while Chronos isn't actively mid-lifecycle on this ticket (those
        // states are protected from a spurious tracker downgrade). A Chronos-local close (done or
        // dismissed) is left as-is — the tracker is never written, so we just don't reopen it here.
        patch.status = t.status;
        patch.status_source = "external"; // this status came from the tracker, not from Chronos
      }
      // Keep the tracker's own label as DATA, not just as `## External` prose. Neither branch above
      // fires when Chronos already closed a ticket the tracker still shows open (the ACM-3 shape) —
      // that disagreement is deliberate (we never write back, and we don't reopen), but before this
      // it left no trace anywhere and got read as "open P1" for days. isStatusDivergent() derives the
      // mismatch from this column at read time. Written only when the label actually moved: every
      // patch bumps updated_at, which orders every board and "recently done" list.
      const label = externalLabel(t.statusRaw, conn.name, t.id, ws.id);
      if ((existing.external_status ?? null) !== label) patch.external_status = label;
      // Mirror low-risk fields the tracker owns (title always; priority when it maps).
      if (existing.title !== title) patch.title = title;
      if (t.priority && existing.priority !== t.priority) patch.priority = t.priority;
      // actor: "connector-sync" tags this as a tracker-originated update — write-back (src/writeback.ts)
      // listens for ticket.updated status:"done" and must NOT treat this one as "Chronos shipped it,
      // propose telling the tracker": the tracker is exactly where this status came from.
      if (Object.keys(patch).length) { updateTicket(existing.id, patch, { actor: "connector-sync" }); res.updated++; }
      writeExternalSection(existing.id, t);
    }

    // "Review all the ones we have": tickets we track that the pull didn't return. The widened query
    // (open + recently-closed) catches active closures; anything still missing is stale/long-closed.
    // ponytail: just surface the count — per-ticket refetch can come later if it proves needed.
    // The operator's own comments are the best record of how he writes to this client. Best-effort:
    // a failed /myself or a bad row must never fail the ticket sync around it.
    if (me && (conn.name === "jira" || conn.name === "clickup")) {
      try {
        const n = harvestComments(ws, conn.name, me, external);
        if (n) console.log(`[prose] ${ws.slug}: +${n} sample(s) from ${conn.name} comments`);
      } catch (e: any) {
        console.warn(`[prose] ${ws.slug} harvest failed:`, e?.message ?? e);
      }
    }

    res.unseen = store.list({ workspace_id: ws.id }).filter((t) => t.external_system === conn.name && t.external_id && !seen.has(t.external_id)).length;

    if (res.created || res.updated) bus.publish({ topic: "ticket.updated", ticket_id: "" });
    record(res.errors.length ? res.errors.join("; ").slice(0, 500) : null);
    return res;
  } catch (e: any) {
    record(String(e?.message ?? e).slice(0, 500));
    throw e;
  }
}

// ───────────────────────────── explicit, operator-initiated write-back ─────────────────────────────
// Sync never writes to the tracker; these do — and ONLY when the operator calls them (mc comment /
// mc push-status / a dashboard button). Nothing here fires automatically.

function connFor(t: Pick<Ticket, "external_system" | "external_id" | "workspace_id">): { conn: Connector; cfg: Record<string, any>; } {
  if (!t.external_system || !t.external_id) throw new Error("ticket is not linked to a Jira/ClickUp task");
  const conn = CONNECTORS[t.external_system];
  const ws = workspaces.get(t.workspace_id);
  if (!conn || !ws?.connector_config) throw new Error(`no ${t.external_system} connector configured for this workspace`);
  return { conn, cfg: JSON.parse(ws.connector_config) };
}

// Post a comment to the ticket's linked external task. Explicit operator action only.
export async function pushComment(t: Ticket, body: string): Promise<void> {
  const { conn, cfg } = connFor(t);
  await conn.addComment(cfg, t.external_id!, body);
  // Posted with his credentials, but not his words — keep it out of his prose corpus.
  markPushed(body);
}

// Push the ticket's CURRENT local status out to the tracker (collapsed via status_map). Returns the
// external label targeted. Explicit operator action only.
// `hours`: explicit Hours Spent override; falls back to the ticket's most recent "Logged Nh." note
// when closing to Done, so trackers whose Done screen requires it (Jira) don't 400 on the transition.
export async function pushStatus(t: Ticket, hours?: number): Promise<string> {
  const { conn, cfg } = connFor(t);
  const target = externalStatusFor(t.status, cfg);
  if (!target) throw new Error(`no external status mapped for local '${t.status}' (set connector_config.status_map)`);
  const h = t.status === "done" ? (hours ?? lastLoggedHours(t) ?? undefined) : undefined;
  await conn.pushStatus(cfg, t.external_id!, target, h);
  return target;
}

// Write hours-spent onto the linked external task without touching its status, and mirror the same
// number into the local Work log so `lastLoggedHours` (the Done-push fallback) agrees with the
// tracker. Explicit operator/agent action only.
export async function pushHours(t: Ticket, hours: number): Promise<{ external_id: string; hours: number }> {
  const { conn, cfg } = connFor(t);
  if (!conn.setHours) throw new Error(`${conn.name} has no hours field to write (only Jira supports hours)`);
  await conn.setHours(cfg, t.external_id!, hours);
  appendNote(t.id, `Logged ${hours}h.`);
  return { external_id: t.external_id!, hours };
}

// Close a tracker task by its own id, with no Chronos ticket needed — the inbox's ✓ Done
// (src/inbox-done.ts). Explicit operator action only. Order is idempotent writes first, so a failure
// can simply be retried: Jira's Hours Spent field (set, not added) → the close → then the writes that
// would double on a retry (a ClickUp time entry, the comment). Those come back as `warning` instead of
// throwing: the task is closed by then, and a retry would log the time or post the comment twice.
// The comment is his own words, so unlike pushComment it is not marked as pushed (it stays his prose).
export async function closeExternal(
  wsId: string,
  system: string,
  externalId: string,
  opts: { hours?: number; comment?: string } = {},
): Promise<{ target: string; warning?: string }> {
  const ws = workspaces.get(wsId);
  const conn = ws ? CONNECTORS[ws.ticket_connector] : undefined;
  if (!conn || conn.name !== system) throw new Error(`this workspace has no ${system} connector (it syncs ${ws?.ticket_connector ?? "nothing"})`);
  let cfg: Record<string, any>;
  try { cfg = ws!.connector_config ? JSON.parse(ws!.connector_config) : {}; } catch { throw new Error(`${system} connector_config is not valid JSON`); }
  const target = system === "clickup"
    ? cfg.done_status ?? externalStatusFor("done", cfg) ?? "complete"
    : externalStatusFor("done", cfg) ?? "Done";
  const { hours, comment } = opts;
  if (hours !== undefined && !conn.setHours && !conn.logTime) throw new Error(`${system} has no way to record hours`);
  if (hours !== undefined && conn.setHours) await conn.setHours(cfg, externalId, hours);
  await conn.pushStatus(cfg, externalId, target, hours);
  const warnings: string[] = [];
  if (hours !== undefined && !conn.setHours && conn.logTime) {
    try { await conn.logTime(cfg, externalId, hours); } catch (e: any) { warnings.push(`closed, but the ${hours}h time entry failed: ${String(e?.message ?? e).slice(0, 200)}`); }
  }
  if (comment) {
    try { await conn.addComment(cfg, externalId, comment); } catch (e: any) { warnings.push(`closed, but the comment failed: ${String(e?.message ?? e).slice(0, 200)}`); }
  }
  return { target, ...(warnings.length ? { warning: warnings.join("; ") } : {}) };
}

// Best-effort close on delete: push the tracker's mapped 'done' status so the upstream task doesn't
// sit open forever. Never throws — the caller (the delete route) always tombstones the external id
// regardless of whether this succeeds, so a failed/unmapped push never lets the ticket respawn.
// Returns the external status label pushed, or null when nothing was pushed.
export async function pushClose(t: Ticket): Promise<string | null> {
  try {
    const { conn, cfg } = connFor(t);
    const target = externalStatusFor("done", cfg);
    if (!target) return null;
    await conn.pushStatus(cfg, t.external_id!, target);
    return target;
  } catch (e: any) {
    console.warn(`[connector] pushClose ${t.external_system}/${t.external_id} failed:`, e?.message ?? e);
    return null;
  }
}

// A dead credential is not a transient sync error. It fails identically every cycle until a human
// replaces the token, and as a warn line in chronos.err.log it is invisible: acme's ClickUp token
// was revoked and the workspace quietly stopped mirroring its tracker, which nobody noticed until
// somebody read the log. Say it ONCE, where the operator actually is, and again only after the
// connector has recovered and broken anew.
export const isCredentialError = (msg: string): boolean =>
  /\b(401|403)\b/.test(msg) || /token invalid|unauthorized|invalid credentials|authentication failed/i.test(msg);
const credBroken = new Set<string>();

// Periodically reconcile every non-native workspace with its external tracker.
let syncTimer: NodeJS.Timeout | undefined;
export function startConnectorSync() {
  if (!CONFIG.connectorSyncMin || syncTimer) return;
  const run = async () => {
    for (const ws of workspaces.list()) {
      if (ws.ticket_connector === "native") continue;
      try {
        const r = await syncWorkspace(ws);
        credBroken.delete(ws.id); // recovered: the next dead token is news again
        if (r.created || r.updated || r.pushed)
          console.log(`[connector] ${ws.slug}: +${r.created} ~${r.updated} →${r.pushed}${r.errors.length ? " err:" + r.errors.length : ""}`);
        if (r.created) notify(`🔄 <b>${ws.name}</b>: ${r.created} new ${ws.ticket_connector} ticket${r.created > 1 ? "s" : ""}`).catch(() => {});
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        console.warn(`[connector] ${ws.slug} sync failed:`, msg);
        if (isCredentialError(msg) && !credBroken.has(ws.id)) {
          credBroken.add(ws.id);
          notify(
            `🔑 <b>${ws.name}</b>: the ${ws.ticket_connector} credential is invalid — tickets have STOPPED mirroring. ` +
              `Fix on the daemon host: <code>node scripts/set-connector-token.mjs ${ws.slug}</code>`
          ).catch(() => {});
        }
      }
    }
  };
  syncTimer = setInterval(run, CONFIG.connectorSyncMin * 60_000);
  setTimeout(run, 15_000); // first reconcile shortly after boot
  console.log(`[connector] auto-sync every ${CONFIG.connectorSyncMin}m`);
}
