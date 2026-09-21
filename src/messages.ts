/**
 * Operator/manager → worker mailbox (`mc tell`). No dedicated polling loop: a worker already
 * checkpoints via `mc step`/`mc note`, so those API responses piggyback any undelivered messages
 * (deliverPending). Messages are ticket-scoped by default — that's what makes the mailbox survive
 * park & resume and retries for free, since any current or future run on the ticket picks them up.
 * See runner.ts's messagesNote for the spawn-time injection sibling of the retryNote block.
 */
import type { RunMessage } from "./store.js";
import { jobs, messages, runs, tickets } from "./store.js";
import { bus } from "./bus.js";
import { resolveAgent } from "./agent-lifecycle.js";
import { isReadOnlyRun, steerRun } from "./runner.js";

const TICKET_KEY_RE = /^[A-Z]{2,5}-\d+$/i;

export type DeliveredMessage = { id: number; text: string; from_who: string; created_at: string };

// Bus publish — the run_messages row itself is the durable record the ticket timeline renders.
function announce(row: RunMessage, ticket_key: string | null, from: string): void {
  bus.publish({
    topic: "message.sent",
    message_id: row.id,
    ticket_id: row.ticket_id,
    ticket_key,
    run_id: row.run_id,
    workspace_id: row.workspace_id,
    text: row.text,
    from,
    actor: from,
  });
}

export type ResolvedTarget =
  | { kind: "ticket"; ticket_id: string; ticket_key: string; workspace_id: string | null }
  | { kind: "run"; run_id: string; ticket_id: string | null; ticket_key: string | null; workspace_id: string | null };

/**
 * Read-only half of `mc tell` target resolution — no DB write. Split out so the API route can
 * checkScope against the resolved workspace BEFORE any write happens; a workspace-scoped caller
 * must not be able to land a row in another workspace's mailbox just because the write ran ahead
 * of the scope check. Preference order: ticket key (durable — survives park/resume/retry) → live
 * agent name / run id / id8 via resolveAgent → a bare run id8 as a last resort. A session target is
 * refused: it already has a human-visible PTY to type into directly.
 */
export function resolveMessageTarget(target: string): ResolvedTarget | { error: string } {
  const raw = target.trim();

  if (TICKET_KEY_RE.test(raw)) {
    const t = tickets.list().find((x) => x.key.toUpperCase() === raw.toUpperCase());
    if (!t) return { error: `ticket not found: ${raw}` };
    return { kind: "ticket", ticket_id: t.id, ticket_key: t.key, workspace_id: t.workspace_id };
  }

  const agent = resolveAgent(raw);
  if (agent?.kind === "session") {
    return { error: "mc tell targets headless runs; type into the terminal for sessions" };
  }
  const run = (agent?.kind === "run" ? runs.get(agent.id) : undefined) ?? runs.findByIdPrefix(raw);
  if (!run) return { error: `target not found: ${raw}` };

  // Both ticket_id and workspace_id come off the run's job so ticket-scoped pickup keeps working
  // even though the caller addressed a specific run.
  const job = jobs.get(run.job_id);
  const tk = job?.ticket_id ? tickets.get(job.ticket_id) : undefined;
  return { kind: "run", run_id: run.id, ticket_id: job?.ticket_id ?? null, ticket_key: tk?.key ?? null, workspace_id: job?.workspace_id ?? null };
}

/** Resolve `target` (see resolveMessageTarget) and file the message. */
export function sendMessage(
  target: string,
  text: string,
  from: string
): { ok: true; message: RunMessage; steered: boolean; resolved: { kind: "ticket" | "run"; ticket_key?: string | null; run_id?: string } } | { ok: false; error: string } {
  const resolved = resolveMessageTarget(target);
  if ("error" in resolved) return { ok: false, error: resolved.error };

  const row =
    resolved.kind === "ticket"
      ? messages.create({ ticket_id: resolved.ticket_id, workspace_id: resolved.workspace_id, text, from_who: from })
      : messages.create({ run_id: resolved.run_id, ticket_id: resolved.ticket_id, workspace_id: resolved.workspace_id, text, from_who: from });
  announce(row, resolved.ticket_key, from);

  // Live delivery: a steer-mode run gets the message NOW over stdin instead of at its next
  // checkpoint. The mailbox row is written FIRST and only marked delivered after a successful
  // steer — a run that dies between write and steer leaves the durable row for the next dispatch.
  // Read-only runs (plan:/review:/…) are skipped: a ticket-scoped tell is for the build agent, not
  // a panel reviewer that happens to be live.
  let steered = false;
  const live =
    resolved.kind === "run"
      ? runs.get(resolved.run_id)
      : runs.runningForTicket(resolved.ticket_id).find((r) => !isReadOnlyRun(r.job_name));
  if (live?.status === "running" && steerRun(live.id, text, from, row.id)) {
    // Optimistic: the message is on the pipe, not yet answered. The runner tracks it as unconfirmed
    // and reverts this delivery if the run dies before the agent's next result event.
    messages.markDelivered([row.id], live.id);
    steered = true;
  }

  return {
    ok: true,
    message: row,
    steered,
    resolved:
      resolved.kind === "ticket"
        ? { kind: "ticket", ticket_key: resolved.ticket_key }
        : { kind: "run", run_id: resolved.run_id, ticket_key: resolved.ticket_key },
  };
}

/**
 * Piggyback pickup: called from every `mc step`/`mc note` API response. Looks up the run's ticket
 * (if any), marks whatever's undelivered as delivered to THIS run, and returns it for the response
 * body. No bus publish here — publishing happens once, on send; a delivery is just bookkeeping.
 */
export function deliverPending(run_id: string): DeliveredMessage[] {
  const run = runs.get(run_id);
  const job = run ? jobs.get(run.job_id) : undefined;
  const rows = messages.undeliveredFor(run_id, job?.ticket_id ?? null);
  if (rows.length) messages.markDelivered(rows.map((r) => r.id), run_id);
  return rows.map((r) => ({ id: r.id, text: r.text, from_who: r.from_who, created_at: r.created_at }));
}
