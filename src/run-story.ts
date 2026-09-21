/**
 * A run's story — the same plain-English feed the Desk shows for a terminal, built from the run's
 * own event log (the CLI's stream-json, stored per line in `events`). A headless claude run emits
 * the same assistant/user records its transcript holds, so the terminal's adapter applies as-is.
 * Other backends carry only their result text; the story is then the summary alone.
 */
import { claudeLine, type FocusEvent } from "./focus.js";

export function storyFromEvents(events: Array<{ type: string; payload: any }>): FocusEvent[] {
  const out: FocusEvent[] = [];
  events.forEach((e, i) => {
    const p = typeof e.payload === "string" ? safeJson(e.payload) : e.payload;
    if (!p || (e.type !== "assistant" && e.type !== "user")) return;
    out.push(...claudeLine(p, i));
  });
  return out;
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}
