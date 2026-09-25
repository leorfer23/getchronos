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
 *  POST /inbox/:id/done {hours?, comment?} operator only — close the tracker task too (src/inbox-done.ts)
 *  POST /inbox/:id/wontdo                 operator only — mute the task: it files nothing again
 *
 * Every :id route checks the row's workspace against the caller's scope first (CLAUDE.md gotcha #4),
 * so another client's token gets the same 404 an unknown id does, never a 403 that confirms it exists.
 */
import type express from "express";
import { CONFIG } from "./config.js";
import { callerScope, checkScope, tokenOk } from "./authz.js";
import { bus } from "./bus.js";
import { inbox, workspaces, type InboxItem } from "./store.js";
import { addInboxItem } from "./inbox.js";
import { dispatchInboxItem, InboxDispatchError } from "./inbox-dispatch.js";
import { parseFollowUpAt } from "./jot-followup.js";
import { doneInboxItem, InboxDoneError, wontdoInboxItem } from "./inbox-done.js";
import { InboxDoneSchema, InboxSnoozeSchema, NewInboxItemSchema } from "./validation.js";

type Req = express.Request;
type Res = express.Response;

const isAdmin = (req: Req) => tokenOk(req.get("x-mc-admin"), CONFIG.adminToken);
const truthy = (v: unknown) => v === "1" || v === "true";

/** GET /inbox — every client's rows the caller may see, newest first, plus unread per client. */
export function listAllRoute(req: Req, res: Res): void {
  const scope = callerScope(req);
  if (scope === null) { res.status(401).json({ error: "invalid workspace token" }); return; }
  const want = typeof req.query.workspace === "string" ? req.query.workspace : null;
  if (want && !checkScope(req, res, want)) return;
  const ws = scope.ws ?? want;
  res.json({ items: inbox.list({ workspace_id: ws, all: truthy(req.query.all) }), counts: inbox.counts(scope.ws) });
}

/** GET /workspaces/:id/inbox */
export function listRoute(req: Req, res: Res): void {
  if (!checkScope(req, res, req.params.id)) return;
  if (!workspaces.get(req.params.id)) { res.status(404).json({ error: "workspace not found" }); return; }
  res.json({ items: inbox.list({ workspace_id: req.params.id, all: truthy(req.query.all) }), counts: inbox.counts(req.params.id) });
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
  if (!isAdmin(req)) { res.status(403).json({ error: "the inbox is the operator's — dismiss, snooze, dispatch, done and won't do are admin-only" }); return null; }
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

/** POST /inbox/:id/done {hours?, comment?} — 200 {item, target, warning?}; a tracker refusal leaves the row as it was. */
export async function doneRoute(req: Req, res: Res): Promise<void> {
  const item = operatorRow(req, res);
  if (!item) return;
  const p = InboxDoneSchema.safeParse(req.body ?? {});
  if (!p.success) {
    res.status(400).json({ error: "invalid request body — " + p.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    return;
  }
  try {
    res.json(await doneInboxItem(item.id, p.data));
  } catch (e: any) {
    res.status(e instanceof InboxDoneError ? e.status : 500).json({ error: String(e?.message ?? e) });
  }
}

/** POST /inbox/:id/wontdo — mute the row's task; nothing is written to the tracker. */
export function wontdoRoute(req: Req, res: Res): void {
  const item = operatorRow(req, res);
  if (!item) return;
  res.json(wontdoInboxItem(item.id));
}
