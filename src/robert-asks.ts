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
import { CONFIG } from "./config.js";
import { asks, kv, sessions, workspaces, type Ask } from "./store.js";
import type { Session } from "./types.js";
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

/**
 * The terminal that holds Robert's questions (kv `ask.holder:<session id>` → ask ids, comma-joined;
 * `ask.at:<ask id>` → session id back). The operator reads terminals, not the chat. A question about
 * work a terminal is already doing rides on THAT terminal — its rail row turns red with a count and
 * he answers by typing there (src/ask-in-terminal.ts). Only a question no terminal owns opens a new
 * one to hold it. Robert hears the answer on his usual wake; closing the terminal unanswered drops it.
 */
const holderKey = (sessionId: string) => `ask.holder:${sessionId}`;
const atKey = (askId: string) => `ask.at:${askId}`;
export function holderAsks(sessionId: string): Ask[] {
  const ids = (kv.get(holderKey(sessionId)) ?? "").split(",").filter(Boolean);
  return ids.map((id) => asks.get(id)).filter((a): a is Ask => a?.status === "open");
}
/** The terminal a Robert question rides on, if any. */
export const heldBy = (askId: string): string | null => kv.get(atKey(askId)) ?? null;
export function holdOn(sessionId: string, askId: string): void {
  const ids = [...holderAsks(sessionId).map((a) => a.id), askId];
  kv.set(holderKey(sessionId), [...new Set(ids)].join(","));
  kv.set(atKey(askId), sessionId);
}

const ID8 = /\b[0-9a-f]{8}\b/g;
/**
 * The live terminal a Robert question is about: the one he named (`"terminal":"<id8>"`), else the one
 * its text names by id8 ("PR triage (6de592b0): …") when exactly one live terminal matches. Same
 * workspace when he gave one.
 */
export function targetTerminal(f: { question: string; terminal?: string | null; workspace_id: string | null }): Session | null {
  const live = sessions.list({ status: "live", limit: 500 }).filter((s) => !f.workspace_id || s.workspace_id === f.workspace_id);
  const named = f.terminal?.trim().toLowerCase().replace(/^#/, "");
  if (named && named.length >= 6) {
    const hit = live.find((s) => s.id.startsWith(named));
    if (hit) return hit;
  }
  const ids = new Set(f.question.toLowerCase().match(ID8) ?? []);
  const hits = live.filter((s) => ids.has(s.id.slice(0, 8)));
  return hits.length === 1 ? hits[0] : null;
}

export function holderBrief(a: Pick<Ask, "question" | "options">): string {
  const opts = a.options ? (JSON.parse(a.options) as string[]) : [];
  return [
    "Robert (the operator's master agent) needs a decision from the operator, and the operator only reads terminals — this one holds the question.",
    "",
    "## The question",
    a.question,
    ...(opts.length ? ["", "Options: " + opts.map((o) => `"${o}"`).join(" / ")] : []),
    "",
    "## What to do",
    "1. Gather just enough context to make the call easy (read the repo, PR, data or thread it refers to) — a few minutes, not a project.",
    "2. Put on screen, last: the question in one line, the options, and the one you recommend with a one-line reason. Run `mc state decide \"<the question in a few words>\"` and stop.",
    "3. When he answers here, Robert receives the answer and acts on it. Acknowledge in one line and `mc goal done`. Do not carry out the decision yourself unless he tells you to in this terminal.",
  ].join("\n");
}

type RaiseFields = { question: string; options: string[] | null; workspace_id: string | null; terminal?: string | null };
type Raise = (f: RaiseFields) => Ask;

/**
 * File one Robert ask. About a live terminal → it rides on that terminal (no new one). Otherwise, for
 * a project, open the terminal that holds it. Late imports: asks.ts pulls the dispatcher, terminal.ts the world.
 */
export const raiseRobertAsk: Raise = ({ terminal, ...f }) => {
  const on = targetTerminal({ ...f, terminal });
  const ask = asks.create({ asked_by: ROBERT_ASKER, route: "operator", ...f, workspace_id: on?.workspace_id ?? f.workspace_id });
  void import("./asks.js")
    .then((m) => m.notifyAskCreated(ask, undefined, { desk: false }))
    .catch((e) => console.error("[robert-asks] notify failed", e));
  if (on) {
    holdOn(on.id, ask.id);
    void import("./term-status.js").then((m) => m.refresh(on.id)).catch(() => {});
  } else if (f.workspace_id && CONFIG.robertAskTerminals) {
    void import("./terminal.js")
      .then((m) =>
        m.openSession({
          workspace_id: f.workspace_id,
          goal: `Robert asks: ${f.question}`.slice(0, 400),
          goal_kind: "investigation",
          goal_source: "human",
          description: holderBrief(ask),
          model: "sonnet",
          created_by: "robert",
          role: "human",
        } as any),
      )
      .then((s) => holdOn(s.id, ask.id))
      .catch((e) => console.error("[robert-asks] holder terminal failed", e?.message ?? e));
  }
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
    const question = q.trim().slice(0, 1000);
    if (!question) continue;
    const terminal = typeof a.terminal === "string" ? a.terminal : typeof a.session === "string" ? a.session : null;
    raised.push(raise({ question, options: cleanOptions(a.options), workspace_id: resolveWs(a.ws ?? a.workspace, wsId), ...(terminal ? { terminal } : {}) }));
  }
  if (!raised.length) return { ...out, asks: [] };
  const reply = [out.reply, ...raised.map((a) => askMarker(a.id))].filter(Boolean).join("\n\n");
  return { reply, actions: rest, asks: raised };
}
