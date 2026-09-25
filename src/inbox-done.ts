/**
 * The inbox's two ways to be finished with a row (src/inbox.ts), both the operator's own press on the
 * Desk or `mc inbox done|wontdo`:
 *
 *  - ✓ Done: the work is finished. A tracker row closes its Jira/ClickUp task by the task's own id —
 *    no Chronos ticket needed — with his hours if he gave them (Jira: the Hours Spent field; ClickUp: a
 *    time entry) and an optional comment. A Slack row just resolves. A Chronos ticket mirroring the task
 *    closes with it, tagged so write-back (src/writeback.ts) does not offer to tell the tracker again.
 *  - Won't do: the task is muted. Nothing is written anywhere outside Chronos; that ref simply never
 *    files an inbox row again (addInboxItem checks the mute first).
 *
 * Either one also resolves the other still-open rows about the same task.
 */
import { bus } from "./bus.js";
import { inbox, tickets, type InboxItem } from "./store.js";
import { closeExternal } from "./connectors/index.js";
import { muteRef, rememberClosed } from "./inbox.js";
import { appendNote, updateTicket } from "./tickets.js";
import { isClosedTicketStatus } from "./types.js";

export class InboxDoneError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** The actor on a mirror ticket closed from the inbox — write-back skips it, the tracker already knows. */
export const INBOX_DONE_ACTOR = "inbox-done";

const TRACKERS = new Set(["jira", "clickup"]);
/** One close per row at a time: a double press must not log a ClickUp time entry twice. */
const inFlight = new Set<string>();

export async function doneInboxItem(
  id: string,
  opts: { hours?: number; comment?: string } = {},
): Promise<{ item: InboxItem; target: string | null; warning?: string }> {
  const item = inbox.get(id);
  if (!item) throw new InboxDoneError(404, "not found");
  if (item.state === "done") throw new InboxDoneError(409, "already done");
  if (inFlight.has(id)) throw new InboxDoneError(409, "already closing");
  const tracker = TRACKERS.has(item.source) && !!item.ref;
  if (!tracker && (opts.hours !== undefined || opts.comment)) throw new InboxDoneError(400, "hours and a comment go to a tracker task — this row has none");
  inFlight.add(id);
  try {
    let target: string | null = null;
    let warning: string | undefined;
    if (tracker) {
      try {
        ({ target, warning } = await closeExternal(item.workspace_id, item.source, item.ref!, opts));
      } catch (e: any) {
        throw new InboxDoneError(502, `${item.source} ${item.ref}: ${String(e?.message ?? e).slice(0, 300)}`);
      }
      rememberClosed(item.workspace_id, item.source, item.ref!, target);
      const mirror = tickets.byExternal(item.source, item.ref!);
      if (mirror && mirror.workspace_id === item.workspace_id) {
        if (!isClosedTicketStatus(mirror.status))
          updateTicket(mirror.id, { status: "done", status_source: "external", external_status: target }, { actor: INBOX_DONE_ACTOR });
        if (opts.hours !== undefined) appendNote(mirror.id, `Logged ${opts.hours}h.`);
      }
    }
    const row = inbox.resolve(id, "done")!;
    bus.publish({ topic: "inbox.updated", workspace_id: row.workspace_id, item_id: row.id });
    return { item: row, target, ...(warning ? { warning } : {}) };
  } finally {
    inFlight.delete(id);
  }
}

export function wontdoInboxItem(id: string): InboxItem {
  const item = inbox.get(id);
  if (!item) throw new InboxDoneError(404, "not found");
  if (item.ref) muteRef(item.workspace_id, item.source, item.ref);
  const row = inbox.resolve(id, "muted")!;
  bus.publish({ topic: "inbox.updated", workspace_id: row.workspace_id, item_id: row.id });
  return row;
}
