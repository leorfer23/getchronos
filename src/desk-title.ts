import { bus, type BusEvent } from "./bus.js";
import { sessions } from "./store/sessions.js";
import type { FocusEvent } from "./focus.js";
import { indexSession } from "./session-search.js";

// Keeping a card honest without asking the agent to remember anything.
//
// A terminal is spawned with the goal its operator typed — "fix the dbt model", "look at the failing
// DAG" — which is what he knew BEFORE anyone read the code. One turn later the agent knows more, and
// the card is still showing the guess. `mc goal set` fixes that, but it depends on an agent choosing
// to run it, and the wall's whole value is that it's true at a glance.
//
// So derive it: every backend already opens a turn with "Understanding: <restatement of the task>"
// (FOCUS_CONTRACT, terminal.ts), parsed into a focus event by focus.ts. That sentence IS the accurate
// title, written by the only party who knows. We take it — but only while nobody has claimed the goal
// as theirs: `goal_source` stays 'seed' (typed at spawn) or 'auto' (derived here) until the operator
// edits the card or the agent runs `mc goal set`, and either of those ends the automatic renaming for
// good. A human who retitles a card does not want it renamed back a minute later.

const MAX = 72;

/** "Understanding: I need to open the rollback PR, then…" → "open the rollback PR". */
export function titleFromUnderstanding(text: string): string | null {
  let t = String(text ?? "")
    .replace(/\*\*/g, "")
    .replace(/^\s*understanding\s*[:\-—]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  // First clause only — the rest is scope, hedging and plan, which the Focus feed already shows.
  // A dash counts as a full stop here: models love "audit the numbering — likely a gap in V4.5x…",
  // and everything after it is speculation, not a label.
  const stop = t.search(/[.!?](\s|$)|\s*[—–]\s*|\s+-\s+/);
  if (stop > 0) t = t.slice(0, stop);
  // Drop the throat-clearing every model opens with, so the card reads as an objective.
  t = t
    .replace(
      /^(?:the\s+(?:task|goal|ask|user('s)?\s+request)\s+is\s+to\s+|(?:i|we)\s+(?:need|have|am\s+asked|'m\s+asked)\s+to\s+|(?:i|we)\s+(?:will|should|am\s+going\s+to|'m\s+going\s+to)\s+|(?:you|leo)\s+want[s]?\s+me\s+to\s+|my\s+task\s+is\s+to\s+|let'?s\s+)/i,
      "",
    )
    .trim();
  if (t.length < 8) return null;
  if (t.length > MAX) t = t.slice(0, MAX - 1).replace(/\s+\S*$/, "") + "…";
  return t;
}

/** True when the deriver still owns this terminal's title. */
export function isDerivable(s: { goal_source?: string | null; goal_done_at?: string | null; status?: string }): boolean {
  if (!s) return false;
  if (s.status === "ended") return false;
  if (s.goal_done_at) return false; // a ticked goal is a record of what was done, not a live label
  const src = s.goal_source ?? null;
  return src === null || src === "seed" || src === "auto";
}

/** Apply an Understanding to a session's card. Returns the new goal, or null if nothing changed. */
export function applyDerivedTitle(sessionId: string, text: string): string | null {
  const s = sessions.get(sessionId);
  if (!s || !isDerivable(s)) return null;
  const title = titleFromUnderstanding(text);
  if (!title || title === s.goal) return null;
  sessions.setGoal(sessionId, { goal: title, goal_source: "auto" });
  // Seeded, ticketless sessions never pass through captureFirstPrompt(), so after removing aiTitle
  // their historical `title` could remain null even though the live card has an auto-derived goal.
  // Freeze the first truthful Understanding as that original title; never replace ticket/Lead labels
  // or a title already captured from human input.
  if (!s.ticket_id && s.role === "human" && !s.title) sessions.setMeta(sessionId, { title });
  indexSession(sessionId);
  bus.publish({ topic: "session.updated", session_id: sessionId });
  return title;
}

/** "**Summary:** PR opened and tests pass." → search/worklog-ready plain text, without an LLM. */
export function summaryFromResult(text: string): string | null {
  let summary = String(text ?? "")
    .replace(/\*\*/g, "")
    .replace(/^\s*(?:summary|result)\s*[:\-—]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!summary) return null;
  if (summary.length > 300) summary = summary.slice(0, 299).replace(/\s+\S*$/, "") + "…";
  return summary;
}

/** Persist the agent's own structured closeout for live search and worklog reuse. */
export function applyDerivedSummary(sessionId: string, text: string): string | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  const summary = summaryFromResult(text);
  if (!summary || summary === s.summary) return null;
  sessions.setMeta(sessionId, { summary });
  indexSession(sessionId);
  bus.publish({ topic: "session.updated", session_id: sessionId });
  return summary;
}

export function startDeskTitles(): void {
  bus.on("event", (e: BusEvent) => {
    if (e.topic !== "focus.event") return;
    const ev = e.event as FocusEvent | undefined;
    if (!ev) return;
    try {
      if (ev.kind === "understanding") applyDerivedTitle(e.session_id, ev.text);
      else if (ev.kind === "result") applyDerivedSummary(e.session_id, ev.text);
    } catch {
      // display/search metadata is never worth taking the daemon down for
    }
  });
  console.log("[desk] card titles and summaries follow structured Focus events without helper-model calls");
}
