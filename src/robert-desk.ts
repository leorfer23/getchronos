/**
 * Robert said or did something nobody typed to him — a wake, an ask he triaged, a watch check. It goes
 * in the ONE thread the operator reads on the Desk, with the steps he took, or it did not happen as
 * far as the operator can tell.
 */
import { bus } from "./bus.js";
import { chat } from "./store.js";
import type { RobertStep } from "./robert-steps.js";

export function postRobertToDesk(p: { body: string; ws: string | null; steps?: RobertStep[]; turn?: string }): void {
  const body = (p.body || "").trim();
  if (!body && !p.steps?.length) return;
  try {
    const row = chat.add("", body, "robert", p.ws, p.steps ?? null);
    chat.prune(2000);
    bus.publish({ topic: "agent.push", you: "", reply: body, at: row.created_at, source: "robert", id: row.id, ws: p.ws, turn: p.turn, steps: p.steps ?? [] });
  } catch (e) {
    console.warn("[robert-desk] post failed", e);
  }
}
