/**
 * HTTP doors of the workspace inbox (src/inbox.ts). Handlers, not inline routes, so the workspace wall
 * is tested against the code that actually serves the request (same shape as dream-routes.ts).
 *
 *  GET  /inbox[?workspace=<id>&all=1]     rows + unread counts; a workspace token sees only its own
 *  GET  /workspaces/:id/inbox[?all=1]     one client's rows (checkScope)
 *  POST /workspaces/:id/inbox             file a row — that workspace's own token (`mc inbox add` from
 *                                         the triage job) or the operator; a tokenless caller is neither
 *  POST /inbox/:id/dismiss                operator only
 *  POST /inbox/:id/snooze {until}         operator only
 *  POST /inbox/:id/dispatch               operator only — the ONE door from a row to a terminal
 *  POST /inbox/:id/resolve {reason}       the row's own workspace token (triage/cleanup job) or the
 *                                         operator: what it asked for already happened
 *  POST /inbox/:id/reopen                 operator only — undo a resolve or a dismiss
 *  POST /workspaces/:id/rank              own workspace token or operator — the cleanup job's order of
 *                                         open inbox rows + notes, most important first
 *
 * Every :id route checks the row's workspace against the caller's scope first (CLAUDE.md gotcha #4),
 * so another client's token gets the same 404 an unknown id does, never a 403 that confirms it exists.
 */
import type express from "express";
import { CONFIG } from "./config.js";
import { callerScope, checkScope, tokenOk } from "./authz.js";
import { bus } from "./bus.js";
import { inbox, jots, workspaces, INBOX_STATES, type InboxItem } from "./store.js";
import { guard } from "./guard.js";
import { addInboxItem } from "./inbox.js";
import { dispatchInboxItem, InboxDispatchError } from "./inbox-dispatch.js";
import { parseFollowUpAt } from "./jot-followup.js";
import { InboxResolveSchema, InboxSnoozeSchema, NewInboxItemSchema, RankSchema } from "./validation.js";

type Req = express.Request;
type Res = express.Response;

const isAdmin = (req: Req) => tokenOk(req.get("x-mc-admin"), CONFIG.adminToken);
const truthy = (v: unknown) => v === "1" || v === "true";

/** ?all=1 everything · ?open=1 new+snoozed (what a re-check looks at) · ?state=resolved one state. */
function listFilter(req: Req): { all?: boolean; open?: boolean; state?: InboxItem["state"] } {
  const st = typeof req.query.state === "string" && (INBOX_STATES as readonly string[]).includes(req.query.state) ? (req.query.state as InboxItem["state"]) : undefined;
  return { all: truthy(req.query.all), open: truthy(req.query.open), state: st };
}

/** GET /inbox — every client's rows the caller may see, newest first, plus unread per client. */
export function listAllRoute(req: Req, res: Res): void {
  const scope = callerScope(req);
  if (scope === null) { res.status(401).json({ error: "invalid workspace token" }); return; }
  const want = typeof req.query.workspace === "string" ? req.query.workspace : null;
  if (want && !checkScope(req, res, want)) return;
  const ws = scope.ws ?? want;
  res.json({ items: inbox.list({ workspace_id: ws, ...listFilter(req) }), counts: inbox.counts(scope.ws) });
}

/** GET /workspaces/:id/inbox */
export function listRoute(req: Req, res: Res): void {
  if (!checkScope(req, res, req.params.id)) return;
  if (!workspaces.get(req.params.id)) { res.status(404).json({ error: "workspace not found" }); return; }
  res.json({ items: inbox.list({ workspace_id: req.params.id, ...listFilter(req) }), counts: inbox.counts(req.params.id) });
}

/** POST /workspaces/:id/inbox — file one row. 201 with the row, or 200 {duplicate:true} for a key already filed. */
export function addRoute(req: Req, res: Res): void {
  if (!checkScope(req, res, req.params.id)) return;
  if (!workspaces.get(req.params.id)) { res.status(404).json({ error: "workspace not found" }); return; }
  // Loopback with no token is reachable from inside a sandbox: it is not the operator, and it is not
  // this workspace's job either.
  if (!isAdmin(req) && callerScope(req)?.ws !== req.params.id) {
    res.status(403).json({ error: "filing to the inbox needs this workspace's token (run it from the workspace's job) or the admin token" });
    return;
  }
  const p = NewInboxItemSchema.safeParse(req.body ?? {});
  if (!p.success) {
    res.status(400).json({ error: "invalid request body — " + p.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    return;
  }
  const b = p.data;
  const row = addInboxItem({
    workspace_id: req.params.id,
    source: b.source,
    kind: b.kind,
    external_key: b.key,
    title: b.title,
    why: b.why ?? null,
    body: b.body ?? null,
    url: b.url ?? null,
    actor: b.actor ?? null,
    ref: b.ref ?? null,
    urgent: !!b.urgent,
  });
  if (!row) { res.status(200).json({ duplicate: true }); return; }
  res.status(201).json(row);
}

/** Resolve :id, wall it, and require the operator. Null when the response is already written. */
function operatorRow(req: Req, res: Res): InboxItem | null {
  const item = inbox.get(req.params.id);
  if (!item) { res.status(404).json({ error: "not found" }); return null; }
  if (!checkScope(req, res, item.workspace_id)) return null;
  if (!isAdmin(req)) { res.status(403).json({ error: "the inbox is the operator's — dismiss, snooze and dispatch are admin-only" }); return null; }
  return item;
}

/** POST /inbox/:id/dismiss */
export function dismissRoute(req: Req, res: Res): void {
  const item = operatorRow(req, res);
  if (!item) return;
  const row = inbox.dismiss(item.id)!;
  bus.publish({ topic: "inbox.updated", workspace_id: row.workspace_id, item_id: row.id });
  res.json(row);
}

/** POST /inbox/:id/snooze {until} */
export function snoozeRoute(req: Req, res: Res): void {
  const item = operatorRow(req, res);
  if (!item) return;
  const p = InboxSnoozeSchema.safeParse(req.body ?? {});
  const until = p.success ? parseFollowUpAt(p.data.until) : null;
  if (!until) { res.status(400).json({ error: "can't read the snooze time — try 2h, tomorrow 9:00, monday 10, 2026-10-01 14:00" }); return; }
  if (Date.parse(until) <= Date.now()) { res.status(400).json({ error: "snooze time is in the past" }); return; }
  const row = inbox.snooze(item.id, until)!;
  bus.publish({ topic: "inbox.updated", workspace_id: row.workspace_id, item_id: row.id });
  res.json(row);
}

/** POST /inbox/:id/dispatch — open the terminal. 201 {item, session}. */
export async function dispatchRoute(req: Req, res: Res): Promise<void> {
  const item = operatorRow(req, res);
  if (!item) return;
  try {
    res.status(201).json(await dispatchInboxItem(item.id));
  } catch (e: any) {
    res.status(e instanceof InboxDispatchError ? e.status : 400).json({ error: String(e?.message ?? e) });
  }
}

/**
 * POST /inbox/:id/resolve {reason} — close a row whose ask already happened. The row's own workspace
 * token may (that is the triage and cleanup jobs), so a job can keep the inbox lean without the
 * operator's key; closing only hides a notification, and the operator can reopen it. :id may be the
 * 8-char prefix `mc inbox list` prints.
 */
export function resolveRoute(req: Req, res: Res): void {
  const item = inbox.find(req.params.id);
  if (!item) { res.status(404).json({ error: "not found" }); return; }
  if (!checkScope(req, res, item.workspace_id)) return;
  if (!isAdmin(req) && callerScope(req)?.ws !== item.workspace_id) {
    res.status(403).json({ error: "resolving needs this workspace's token or the admin token" });
    return;
  }
  const p = InboxResolveSchema.safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json({ error: "resolve needs a reason (≤300 chars)" }); return; }
  if (item.state !== "new" && item.state !== "snoozed") { res.status(409).json({ error: `already ${item.state}` }); return; }
  const row = inbox.resolve(item.id, guard(p.data.reason, "inbox resolve", item.workspace_id).slice(0, 300))!;
  bus.publish({ topic: "inbox.updated", workspace_id: row.workspace_id, item_id: row.id });
  res.json(row);
}

/** POST /inbox/:id/reopen — the operator's undo: it needs him after all. */
export function reopenRoute(req: Req, res: Res): void {
  const item = operatorRow(req, res);
  if (!item) return;
  const row = inbox.reopen(item.id)!;
  bus.publish({ topic: "inbox.updated", workspace_id: row.workspace_id, item_id: row.id });
  res.json(row);
}

/**
 * POST /workspaces/:id/rank {inbox?, notes?} — one client's order, most important first. Each list
 * replaces that list's previous ranking; ids from another client are ignored by the store.
 */
export function rankRoute(req: Req, res: Res): void {
  const wsId = req.params.id;
  if (!checkScope(req, res, wsId)) return;
  if (!workspaces.get(wsId)) { res.status(404).json({ error: "workspace not found" }); return; }
  if (!isAdmin(req) && callerScope(req)?.ws !== wsId) {
    res.status(403).json({ error: "ranking needs this workspace's token or the admin token" });
    return;
  }
  const p = RankSchema.safeParse(req.body ?? {});
  if (!p.success) {
    res.status(400).json({ error: "invalid request body — " + p.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    return;
  }
  const why = (s?: string) => (s ? guard(s, "rank", wsId).slice(0, 300) : null);
  const out: { inbox?: number; notes?: number } = {};
  if (p.data.inbox) {
    const full = p.data.inbox.map((e) => ({ ...e, id: inbox.find(e.id)?.id ?? e.id, why: why(e.why) }));
    out.inbox = inbox.rank(wsId, full);
    bus.publish({ topic: "inbox.updated", workspace_id: wsId, item_id: "" });
  }
  if (p.data.notes) {
    const open = jots.list({ workspace_id: wsId, status: "open" });
    const full = p.data.notes.map((e) => ({ ...e, id: open.find((j) => j.id.startsWith(e.id.toLowerCase()))?.id ?? e.id, why: why(e.why) }));
    out.notes = jots.rank(wsId, full);
    bus.publish({ topic: "jot.updated", jot_id: "", workspace_id: wsId });
  }
  res.json(out);
}
