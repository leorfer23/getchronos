import { type BusEvent } from "./bus.js";
import { tickets, workspaces } from "./store.js";
import { OP_PREFIX } from "./operational-prefix.js";
import { getWebModel, warmWebManager } from "./telegram/agent.js";

// Robert's event-triggered triage — ported from the Buzz agent worker when the transport died.
// Decision events (a review landed, a ticket blocked, a worker asked) wake Robert to say what he'd
// do; his reply lands on the board tagged with the ticket, so it shows on the ticket page and in
// the feed. Deliberately NOT the escalation/gate notices: those are already a sentence telling the operator
// what to do, and a second opinion on them is noise. One Robert turn per ticket per window.
//
// The wake itself is queued and drained by src/wake-queue.ts — this file owns only what he is TOLD
// (the predicate, the model, the prompt).

// Operator-picked model (Desk chat select → web.model, else voiceModel). Heavy keywords still force opus.
const HEAVY_RE = /\b(opus|think hard|ultrathink|deep dive|architect|design (?:the|a) (?:system|plan)|plan this properly)\b/i;
export function robertModelFor(prompt: string): string {
  return HEAVY_RE.test(prompt) ? "opus" : (getWebModel() || "opus");
}

export type RobertWakeEvent = Extract<BusEvent, { topic: "review.created" | "ticket.updated" | "ask.created" }>;
export type WakeEvent = RobertWakeEvent;

export function wakesRobert(e: BusEvent): e is RobertWakeEvent {
  if (e.topic === "review.created") return !!e.ticket_id;
  if (e.topic === "ask.created") return !!e.ticket_id;
  return e.topic === "ticket.updated" && e.status === "blocked";
}

/**
 * What Robert is told when an event wakes him. Pure, and its own exported function so the wording
 * is reviewable in a test and so the queueing/acking mechanics around askManagerWeb can move
 * underneath it without touching a single sentence of prompt.
 *
 * The ask branch does NOT restate the decide-vs-escalate rules: `agents/_blocks/ask-authority.md`
 * owns them and is already in his system prompt. Two copies of that policy is how one of them ends
 * up stale, and the stale one is always the copy an inline string literal holds. What stays here is
 * what the block cannot know: which ticket, which ask, and this workspace's own ask_policy.
 */
export function buildWakePrompt(
  e: WakeEvent,
  t: { key?: string; workspace_id?: string } | undefined,
  askPolicy: string | null | undefined,
): string {
  const ticketId = e.ticket_id;
  const surface =
    `Your reply is posted to the board (public to the operator and every executive) tagged with the ticket — ` +
    `write the post itself, nothing else.`;

  if (e.topic === "ask.created") {
    const id8 = e.ask_id.slice(0, 8);
    const what = `${e.ticket_key ?? "A worker"} just ASKED: "${e.question}" (ask \`${id8}\`).`;
    // Soft mirror of the hard gate in asks.ts answerAsk: this workspace requires a human answer, so
    // don't even offer Robert the "answer it directly" path — swap it for assess-and-escalate.
    const escalateOnly = askPolicy === "escalate";
    return (
      `${OP_PREFIX}${what} the operator did NOT ask you anything; you are being woken to triage this. The ask card ` +
      `already reached the operator — you are not repeating it, you are deciding what to do about it.\n` +
      `Read the ticket (GET /api/tickets/${ticketId}) and the ask (GET /api/asks?status=open). Then apply WHEN YOU ` +
      `DECIDE AND WHEN YOU ASK from your instructions — it owns that line and this prompt does not restate it.\n` +
      (escalateOnly
        ? `THIS WORKSPACE'S ask_policy IS "escalate": a human must answer every ask here, so the decide side is shut ` +
          `for you (POST /api/asks/${id8}/answer is blocked). Recommend; do not decide.\n`
        : `The decide side is genuinely open here — answering unblocks a parked worker and a wrong answer is ` +
          `reversible with a follow-up \`mc tell\`: POST /api/asks/${id8}/answer {"answer":"...","by":"robert"}.\n`) +
      `Either way, post ONE or TWO lines: what was asked, and what you did or what you recommend. ${surface}`
    );
  }

  const what =
    e.topic === "review.created"
      ? `${t?.key ?? "A build"} just moved to REVIEW (review \`${e.review_id}\`, run \`${e.run_id.slice(0, 8)}\`).`
      : `${t?.key ?? "A ticket"} just went BLOCKED.`;
  return (
    `${OP_PREFIX}${what} the operator did NOT ask you anything; you are being woken because this needs a call.\n` +
    `Read the ticket (GET /api/tickets/${ticketId}) and, for a review, GET /api/reviews?state=pending plus the run's ` +
    `events. Then post ONE or TWO lines: what it is, and the call you would make — approve · send to @Ham · rework ` +
    `with the specific thing to fix · or "needs the operator because X". Name the ticket key. Do NOT approve, merge, or ` +
    `dispatch anything: recommend and wait for his go. If it is routine and you would just approve, say so in one ` +
    `line — brevity is the point. ${surface}`
  );
}

/** What one queued wake tells him: the prompt above, with the ticket and its workspace looked up. */
export function wakePromptFor(e: RobertWakeEvent): string {
  const t = e.ticket_id ? tickets.get(e.ticket_id) : undefined;
  const ws = t ? workspaces.get(t.workspace_id) : undefined;
  return buildWakePrompt(e, t, ws?.ask_policy);
}

export function startRobertWake(): void {
  // Chat is a conversation, and a cold CLI spawn costs ~a minute on the first message — long
  // enough to read as "not responding". Keep the executive spawned, and re-warm inside the
  // idle-rotate window so he never goes cold while the operator is awake. One executive means one
  // warm CLI process held open; add more and this warms each of them.
  const warmAll = () => {
    try {
      warmWebManager(null);
    } catch (e) {
      console.error("[robert-wake] warm failed", e);
    }
  };
  setTimeout(warmAll, 5_000).unref?.();
  setInterval(warmAll, 45 * 60 * 1000).unref?.();
  console.log("[robert-wake] warm executive held open");
}
