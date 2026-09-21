import { EventEmitter } from "node:events";
import type { DeskPrompt as DeskPromptShape } from "./desk-prompt.js";

// Central event bus: runner -> ws hub. Topics broadcast as JSON envelopes.
// `actor` is optional on every event: publishers that know who acted set it (e.g. reviews set
// human/ai:reviewer); otherwise the activity recorder derives it per-topic (see activity.ts).
export type BusEvent = (
  | { topic: "run.started"; run_id: string; job_id: string }
  | { topic: "run.event"; run_id: string; event: unknown }
  // Structured worker progress (mc steps): idx 0/"declared" on the initial checklist, then one event
  // per active/done/skipped transition. `progress` is the compact "2/4" string — see steps.progress.
  | { topic: "run.step"; run_id: string; ticket_id?: string | null; ticket_key?: string | null; workspace_id?: string | null; idx: number; label: string; status: string; progress: string }
  | { topic: "run.ended"; run_id: string; status: string; job_name?: string; ticket_id?: string | null; ticket_key?: string | null; workspace_id?: string | null }
  // Worker HITL question (`mc ask`) — see src/asks.ts. ask.created fires when a worker files one;
  // ask.answered fires once an operator (Telegram button / `mc answer` / API) answers it.
  // `run_id` is null for an ask filed from a Desk terminal (`mc ask-robert`) — those carry session_id
  // instead, and `route` says who was given it first (the operator's phone, or Robert to triage).
  | { topic: "ask.created"; ask_id: string; run_id: string | null; job_id?: string | null; session_id?: string | null; route?: string; ticket_id?: string | null; ticket_key?: string | null; workspace_id?: string | null; question: string }
  | { topic: "ask.answered"; ask_id: string; run_id: string | null; job_id?: string | null; session_id?: string | null; ticket_id?: string | null; ticket_key?: string | null; workspace_id?: string | null; answer: string; answered_by: string }
  // Operator/manager → worker mailbox (`mc tell`, src/messages.ts). Delivery is piggybacked on the
  // worker's own `mc step`/`mc note` checkpoints — no separate ack event, so this fires on SEND only.
  | { topic: "message.sent"; message_id: number; ticket_id?: string | null; ticket_key?: string | null; run_id?: string | null; workspace_id?: string | null; text: string; from: string }
  | { topic: "auth.needed"; workspace_id: string | null; backend: string; run_id: string; job_name: string; session_id?: string | null }
  | { topic: "job.updated"; job_id: string }
  | { topic: "trigger.fired"; trigger_id: string; matched: boolean; run_id?: string }
  | { topic: "ticket.updated"; ticket_id: string; status?: string; workspace_id?: string }
  | { topic: "ticket.created"; ticket_id: string; workspace_id: string }
  | {
      topic: "ticket.deleted";
      ticket_id: string;
      workspace_id: string;
      ticket_key?: string;
      title?: string;
    }
  | { topic: "ticket.delivered"; ticket_id: string; pr_url: string; ticket_key?: string }
  // Something happened TO a ticket that produced no run — a dispatch that died in pre-flight, a run
  // blocked by a budget cap. run.* only speaks for work that actually started, so without this the
  // ticket's thread reads as if nothing was ever attempted. See traceDispatch in tickets.ts.
  | { topic: "ticket.event"; ticket_id: string; text: string; workspace_id?: string }
  | { topic: "session.started"; session_id: string }
  | { topic: "session.ended"; session_id: string }
  | { topic: "session.updated"; session_id: string }
  // Turn boundary of a live pty (terminal.ts): "working" = bytes are flowing, "waiting" = the
  // terminal has been silent long enough that it's the human's turn. Drives the Desk wall's dots.
  | { topic: "session.activity"; session_id: string; state: "working" | "waiting"; prompt?: DeskPromptShape | null }
  // Keystrokes typed into a terminal from OUTSIDE its own websocket — a Desk quick action, or an
  // overseeing agent answering a card on the operator's behalf. Recorded like every other event, so
  // "who told the acme terminal to use the staging schema" has an answer.
  | { topic: "session.input"; session_id: string; by: string; text: string; workspace_id: string | null }
  // A live terminal stopped on a credit/usage wall and the daemon moved it (terminal-failover.ts):
  // "model" = same terminal on another model, "backend" = a new terminal (to_session_id) took over,
  // "give_up" = nothing left to try — it waits for a human.
  | {
      topic: "session.failover";
      session_id: string;
      workspace_id: string | null;
      step: "model" | "backend" | "give_up";
      wall: "credit" | "limit";
      /** The wall as the CLI printed it. */
      detail: string;
      from_backend: string;
      from_model: string | null;
      to_backend?: string | null;
      to_model?: string | null;
      to_session_id?: string | null;
      reason: string;
    }
  // What a live terminal has spent so far — turns, context occupancy, dollars — read off the CLI's
  // own transcript. High-frequency and derivable, so activity.ts skips it.
  | { topic: "session.usage"; session_id: string; usage: unknown }
  // The resolved card of a terminal (term-status.ts): phase, one-liner, subagents, progress. Every
  // surface reads this instead of re-deriving it from activity + agent.state + focus events.
  | { topic: "session.status"; session_id: string; status: unknown }
  // Someone read or wrote the operator's Mac clipboard through the daemon (`mc clip`). The CONTENT is
  // deliberately absent — only who, and a shape description — because the clipboard is exactly where
  // a password passes through, and an activity trail that quoted it would be the leak itself.
  // Robert (or a Lead over its worker) removed a worktree. Recorded because it is the one cleanup
  // that destroys a checkout. `actor` mirrors `by` so activity.ts attributes it (actorFor only
  // special-cases session.input's `by`).
  | { topic: "worktree.removed"; path: string; branch: string | null; by: string; actor?: string }
  // A Lead closed its own done workers (`POST /leads/me/close-done`).
  | { topic: "lead.close-done"; lead_id: string; closed: string[]; by: string; actor: string }
  // A live Lead took over an ended Lead's workers/board/inbox (`mc lead adopt`).
  | {
      topic: "lead.adopted";
      lead_id: string;
      from_lead_id: string;
      workers: number;
      slices: number;
      events: number;
      by: string;
      actor: string;
      workspace_id?: string | null;
    }
  // A Lead (or admin) reopened an ended terminal; Lead path stamps by/actor lead:<id8>.
  | { topic: "session.reopened"; session_id: string; by: string; actor: string; workspace_id?: string | null }
  // Manual worklog write (admin or Lead). Lead author is forced to lead:<id8>.
  | { topic: "worklog.written"; workspace_id: string; what: string; by: string; actor: string }
  | { topic: "clipboard.read"; by: string; describe: string; chars: number }
  | { topic: "clipboard.write"; by: string; describe: string; chars: number }
  | {
      topic: "agent.state";
      kind: "session" | "run";
      id: string;
      name: string | null;
      state: string;
      /** The agent's own words for what it's doing / what it needs — shown on its Desk card. */
      state_label: string | null;
      blocked_reason: string | null;
      /** Quiet with no liveness evidence for several checks — the Desk marks it "needs a look". */
      demand_inspection?: boolean;
      workspace_id: string | null;
    }
  | { topic: "ci.failed"; ticket_id: string; pr_url: string; ticket_key?: string; workspace_id?: string }
  | { topic: "lesson.updated"; lesson_id: string; workspace_id: string; state: string }
  | { topic: "workspace.changed" }
  | { topic: "review.created"; review_id: string; run_id: string; ticket_id: string | null; ticket_key?: string; workspace_id?: string }
  | { topic: "review.updated"; review_id: string; state: string }
  | { topic: "note.updated"; note_id: string; workspace_id: string }
  | { topic: "egress.event"; workspace_id: string; host: string; action: string }
  | { topic: "guard.flagged"; workspace_id: string; where: string; rules: string }
  | { topic: "skill.created"; skill_id: string; workspace_id: string; status: string }
  | { topic: "skill.updated"; skill_id: string; workspace_id: string; status: string }
  | { topic: "idea.created"; idea_id: string; workspace_id: string }
  | { topic: "idea.decided"; idea_id: string; workspace_id: string; status: string }
  | { topic: "jot.ran"; jot_id: string; workspace_id: string; session_id: string }
  | { topic: "jot.updated"; jot_id: string; workspace_id: string }
  | { topic: "launch.updated"; launch_id: string; workspace_id: string }
  | { topic: "launch.ran"; launch_id: string; workspace_id: string; session_id: string }
  | { topic: "focus.event"; session_id: string; event: unknown }
  // The board (src/board.ts, store/board.ts) — the Buzz-channel replacement. Fires on every post;
  // `depth` is the wake-chain depth (operator/system posts are 0, an exec's auto-reply is parent+1)
  // so mention-wakes can't ping-pong two executives forever — see BOARD_WAKE_MAX_DEPTH.
  | { topic: "board.posted"; post_id: string; thread_root_id: string | null; author: string; kind: string; mentions: string[]; ticket_id?: string | null; workspace_id?: string | null; depth: number }
  // ws = the workspace thread the turn belongs to (null/absent = the unscoped Telegram+briefings thread)
  | { topic: "agent.delta"; text: string; kind?: "text" | "thinking" | "tool" | "tool_done"; ws?: string | null; client?: string; turn?: string }
  | { topic: "agent.turn.done"; ws?: string | null }
  | { topic: "agent.push"; you: string; reply: string; at: string; source?: string; ws?: string | null; client?: string; turn?: string; steps?: unknown[]; attachments?: unknown[] }
  /** One move Robert made mid-turn (robert-steps.ts), live, so the Desk draws the trail as it happens. */
  | { topic: "agent.step"; ws: string | null; turn: string; step: unknown; label?: string | null }
  /** A turn started: what was said and by which page — other surfaces draw the line right away, not when he answers. */
  | { topic: "agent.asked"; you: string; at: string; source?: string; ws?: string | null; client?: string; turn: string; attachments?: unknown[] }
) & { actor?: string };

class Bus extends EventEmitter {
  publish(e: BusEvent) {
    this.emit("event", e);
  }

  override emit(eventName: string | symbol, ...args: any[]): boolean {
    if (eventName !== "event") {
      return super.emit(eventName, ...args);
    }

    const listeners = this.listeners(eventName);
    for (const listener of listeners) {
      try {
        const result = (listener as any)(...args);
        if (result instanceof Promise) {
          result.catch((err: any) => {
            console.error("[bus]", err);
          });
        }
      } catch (err) {
        console.error("[bus]", err);
      }
    }
    return listeners.length > 0;
  }
}

export const bus = new Bus();
bus.setMaxListeners(0);
