/**
 * Robert said or did something nobody typed to him — a wake, an ask he triaged, a watch check. With
 * `robert.desk_posts` on it goes in the chat thread with the steps he took. Off (the default) the
 * chat holds only his replies to the operator: he reads terminals, not the chat, so unprompted posts
 * piled up unread. The work itself still lands where he looks — the terminal Robert typed into.
 */
import { bus } from "./bus.js";
import { chat } from "./store.js";
import { settingOn } from "./settings.js";
import type { RobertStep } from "./robert-steps.js";

export function postRobertToDesk(p: { body: string; ws: string | null; steps?: RobertStep[]; turn?: string; engine?: string | null }): void {
  const body = (p.body || "").trim();
  if (!body && !p.steps?.length) return;
  if (!settingOn("robert.desk_posts", p.ws)) {
    console.log(`[robert-desk] quiet (${p.ws ?? "default"}): ${body.slice(0, 120).replace(/\s+/g, " ")}`);
    return;
  }
  try {
    const row = chat.add("", body, "robert", p.ws, p.steps ?? null, null, null, p.engine ?? null);
    chat.prune(2000);
    bus.publish({ topic: "agent.push", you: "", reply: body, at: row.created_at, source: "robert", id: row.id, ws: p.ws, turn: p.turn, steps: p.steps ?? [], engine: p.engine ?? null });
  } catch (e) {
    console.warn("[robert-desk] post failed", e);
  }
}
