/**
 * Robert's own questions for the operator — the Ask widget's first-class door for him.
 *
 * He already ends a reply with `UI {...}` lines the page runs (agents/robert/web.md). One more op,
 * `UI {"op":"ask","question":"...","options":["..",".."]}`, files an ordinary `asks` row instead of
 * leaving the question as a sentence in a bubble the operator has to scroll back to find. The row is
 * the same one `mc ask` and `mc ask-robert` file, so it is on the phone's card, in the Desk's
 * "? N" list, and answerable from any of them through the one answer path (answerAsk).
 *
 * The directive line is swapped for an `::ask <id>::` marker in his reply — the chat renders that as
 * the live Ask card, in the bubble where he asked, and it stays live across a reload because the
 * card reads the row, not the text.
 *
 * When the operator answers, Robert hears it on a queued wake (src/wake-queue.ts): he asked in one
 * turn and the answer can come hours later, from the phone.
 */
import { asks, workspaces, type Ask } from "./store.js";
import type { UiAction } from "./telegram/agent.js";

/** Who a Robert-raised ask says it is from. Its only other distinguishing mark is having no run and no terminal. */
export const ROBERT_ASKER = "Robert";

/** The line the chat renders as a live Ask card. One per line, alone on it. */
export const askMarker = (id: string) => `::ask ${id}::`;
export const ASK_MARKER_RE = /^::ask ([0-9a-f-]{8,36})::$/;

/** An ask Robert raised himself — no run, no terminal behind it; it is his own question. */
export const isRobertAsk = (a: Pick<Ask, "run_id" | "session_id" | "asked_by">): boolean =>
  !a.run_id && !a.session_id && a.asked_by === ROBERT_ASKER;

/**
 * Is this open ask the operator's to answer right now? Robert still triaging one (route robert, not
 * escalated) or a Lead holding one is not — it has not reached him yet, and the "? N" count is
 * "questions waiting on you", not "questions anywhere in the building".
 */
export const isOperatorsAsk = (a: Pick<Ask, "status" | "route" | "escalated_at">): boolean =>
  a.status === "open" && (a.route === "operator" || !!a.escalated_at);

function resolveWs(v: unknown, fallback: string | null): string | null {
  if (typeof v !== "string" || !v.trim()) return fallback;
  const key = v.trim().replace(/^#/, "");
  return (workspaces.get(key) ?? workspaces.getBySlug(key))?.id ?? fallback;
}

function cleanOptions(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v
    .filter((o): o is string => typeof o === "string")
    .map((o) => o.trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 6);
  return out.length ? out : null;
}

type Raise = (f: { question: string; options: string[] | null; workspace_id: string | null }) => Ask;

/** File one Robert ask and tell the operator (phone card). Late import: asks.ts pulls the dispatcher. */
export const raiseRobertAsk: Raise = (f) => {
  const ask = asks.create({ asked_by: ROBERT_ASKER, route: "operator", ...f });
  void import("./asks.js")
    .then((m) => m.notifyAskCreated(ask, undefined, { desk: false }))
    .catch((e) => console.error("[robert-asks] notify failed", e));
  return ask;
};

/**
 * Lift every `ask` directive out of a reply: file it, and put its card marker where the operator
 * reads. Every other action passes through untouched. A directive with no question is dropped —
 * a blank card is worse than no card.
 */
export function liftRobertAsks(
  out: { reply: string; actions: UiAction[] },
  wsId: string | null,
  raise: Raise = raiseRobertAsk,
): { reply: string; actions: UiAction[]; asks: Ask[] } {
  const raised: Ask[] = [];
  const rest: UiAction[] = [];
  for (const a of out.actions) {
    if (a.op !== "ask") { rest.push(a); continue; }
    const q = typeof a.question === "string" ? a.question : typeof a.q === "string" ? a.q : "";
    const question = q.trim().slice(0, 500);
    if (!question) continue;
    raised.push(raise({ question, options: cleanOptions(a.options), workspace_id: resolveWs(a.ws ?? a.workspace, wsId) }));
  }
  if (!raised.length) return { ...out, asks: [] };
  const reply = [out.reply, ...raised.map((a) => askMarker(a.id))].filter(Boolean).join("\n\n");
  return { reply, actions: rest, asks: raised };
}
