/**
 * "Needs you" — everything the fleet is waiting on the OPERATOR for, in one ordered list.
 *
 * Before this card the answer was spread across three surfaces: the Desk rail (terminals sitting on
 * a prompt), the phone's triage screen (the same terminals again), and `mc asks` / Telegram (the
 * questions workers and Robert filed). Each one knew about part of the queue, so "what is actually
 * waiting on me" was a thing the operator assembled in his head — and an escalated ask with no
 * terminal behind it was invisible on the Desk entirely.
 *
 * Two sources, one list:
 *   · live terminals whose phase is one of his (src/term-status.ts), with the options they are
 *     sitting on read off their own screen (src/desk-prompt.ts, via sessionPrompt);
 *   · open asks addressed to HIM — routed to the operator, or Robert's that he escalated.
 *
 * Every row carries the exact request that answers it (`answer.route` + `options[].body`), which is
 * the door the Focus view and the phone already use: `/sessions/:id/input` for a terminal (keys for
 * a select, text + Enter for free-form), `/asks/:id/answer` for an ask. The card never invents a
 * second way in; it posts what this reader hands it.
 */
import { asks as asksStore, sessions as sessionsStore, type Ask } from "../store.js";
import { sessionPrompt } from "../terminal.js";
import { statusOf, type Phase, type TermStatus } from "../term-status.js";
import { holdBucket } from "../hold-bucket.js";
import type { DeskPrompt } from "../desk-prompt.js";
import type { Session } from "../types.js";
import type { Widget } from "./index.js";

/**
 * The phases that are HIS turn. Wider than `TermStatus.needs_you` (blocked | decide) on purpose:
 * that flag means "it cannot move until you speak", while this card is the whole queue — a finished
 * turn and a goal waiting to be accepted are things only he can clear too. Same four bands the
 * Desk rail already groups under "needs you" / "to review" / "your turn".
 */
export const NEEDS_YOU: Phase[] = ["blocked", "decide", "review", "your_turn"];

/**
 * Triage order. An ask sits with `decide`, because that is what it is — a question waiting on a
 * word — which is how asks "interleave by age" with the terminals that are also asking, instead of
 * being a second list stapled underneath.
 */
const RANK: Record<string, number> = { blocked: 0, decide: 1, ask: 1, review: 2, your_turn: 3 };

/** `/sessions/:id/input` takes at most 8 keystrokes, so a menu option further down than that
 *  cannot be answered in one request — the row offers the ones that can, and `open` for the rest. */
const MAX_KEYS = 8;
/** Enough chips to decide with; more than this and the card is a menu, not a card. */
const MAX_OPTIONS = 6;

/** One thing the operator can send. `body` is posted verbatim to the row's `answer.route`. */
export type DecideOption = { key: string; label: string; body: Record<string, unknown> };

/** How a row is answered. A typed answer goes in `body[field]`; the rest of `body` rides with it. */
export type DecideAnswer = { route: string; field: "text" | "answer"; body: Record<string, unknown> };

export type DecideItem = {
  kind: "terminal" | "ask";
  /** Session id for a terminal, ask id for an ask — what `ctx.stage(id)` / the route is built from. */
  id: string;
  workspace_id: string | null;
  title: string;
  /** Terminals only: the phase whose colour the row's mark takes. */
  phase?: Phase;
  /** The question, or the terminal's one-liner. */
  line: string;
  /** Robert's note when he handed an ask up, so his recommendation reaches the row. */
  note?: string | null;
  options?: DecideOption[];
  /** When this became his (ms) — the age the list is sorted by. */
  since: number;
  answer: DecideAnswer;
};

/** Everything the list is computed from, so ordering and mapping are testable without a pty. */
export type DecideSource = {
  terminals: { session: Session; status: TermStatus; prompt: DeskPrompt | null }[];
  asks: Ask[];
  now: number;
};

const clip = (s: unknown, n = 160) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** The same label the Desk rail puts on a chip (`title()` in desk.html), computed here for a card
 *  whose session may not be in the page's own list yet. */
export const termTitle = (s: Session): string =>
  clip(s.goal || s.title || (s.backend ? s.backend.replace("-code", "") + " terminal" : "terminal"), 60);

/**
 * A select option's keystrokes: offsets are relative to the highlighted row, so "down × n, Enter"
 * answers it without the card ever knowing which CLI is on the other end. Mirrors `optionBody` in
 * static/desk.html and static/phone.html — the one place this shape is not shared, because the two
 * pages have no build step to import from.
 */
export const optionKeys = (offset: number): string[] => [
  ...Array(Math.abs(offset)).fill(offset > 0 ? "down" : "up"),
  "enter",
];

function parseAskOptions(a: Ask): string[] {
  if (!a.options) return [];
  try {
    const v = JSON.parse(a.options);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** The chips a terminal's current screen offers. A free question or a finished turn has none. */
function promptOptions(p: DeskPrompt | null): DecideOption[] {
  if (!p) return [];
  if (p.kind === "yn")
    return [
      { key: "y", label: "Yes", body: { text: "y", enter: true, by: "operator" } },
      { key: "n", label: "No", body: { text: "n", enter: true, by: "operator" } },
    ];
  if (p.kind !== "select" || !p.options?.length) return [];
  return p.options
    .filter((o) => Math.abs(o.offset) + 1 <= MAX_KEYS)
    .slice(0, MAX_OPTIONS)
    .map((o, i) => ({
      key: String(i),
      label: clip(o.label, 40),
      body: { keys: optionKeys(o.offset), by: "operator" },
    }));
}

/**
 * The ordered list. Rank first (blocked → decide/ask → review → your turn), then oldest first
 * inside a rank: the thing that has been waiting longest is the thing he is most overdue on.
 */
export function decideItems(src: DecideSource): DecideItem[] {
  const items: DecideItem[] = [];
  const staged = new Set<string>();

  for (const { session, status, prompt } of src.terminals) {
    if (!NEEDS_YOU.includes(status.phase)) continue;
    staged.add(session.id);
    const options = promptOptions(prompt);
    items.push({
      kind: "terminal",
      id: session.id,
      workspace_id: session.workspace_id ?? null,
      title: termTitle(session),
      phase: status.phase,
      line: clip(status.line) || status.word,
      options: options.length ? options : undefined,
      since: status.since,
      answer: {
        route: `/sessions/${session.id}/input`,
        field: "text",
        body: { enter: true, by: "operator" },
      },
    });
  }

  for (const a of src.asks) {
    // Robert's own triage queue is not the operator's list: an ask only becomes his when it was
    // routed to him, or when Robert looked at it and handed it up.
    if (a.route === "robert" && !a.escalated_at) continue;
    // A terminal's escalated ask is ALREADY this list's `decide` row for that terminal
    // (term-status.ts folds it into the line). Listing it twice would ask the same question twice
    // and answer only one of them.
    if (a.session_id && staged.has(a.session_id)) continue;
    const options = parseAskOptions(a)
      .slice(0, MAX_OPTIONS)
      .map((o) => ({ key: o, label: clip(o, 40), body: { answer: o, by: "operator" } }));
    items.push({
      kind: "ask",
      id: a.id,
      workspace_id: a.workspace_id,
      title: clip(a.asked_by || "a question", 60),
      line: clip(a.question, 300),
      note: a.triage ? clip(a.triage, 200) : null,
      options: options.length ? options : undefined,
      since: Date.parse(a.created_at) || src.now,
      answer: {
        route: `/asks/${a.id}/answer`,
        field: "answer",
        body: { by: "operator" },
      },
    });
  }

  return items.sort((x, y) => {
    const rx = RANK[x.kind === "ask" ? "ask" : String(x.phase)] ?? 9;
    const ry = RANK[y.kind === "ask" ? "ask" : String(y.phase)] ?? 9;
    return rx - ry || x.since - y.since;
  });
}

/** Read the live half of the source: every live terminal's resolved card and the screen it sits on. */
function liveTerminals(now: number): DecideSource["terminals"] {
  const out: DecideSource["terminals"] = [];
  for (const s of sessionsStore.list({ status: "live", limit: 200 })) {
    const status = statusOf(s.id, now);
    if (!status) continue;
    out.push({ session: s, status, prompt: sessionPrompt(s.id) });
  }
  return out;
}

const decide: Widget = {
  name: "decide",
  title: "Needs you",
  // A phase flip, a question filed, one answered, a terminal gone: all four change who is waiting.
  topics: ["session.status", "ask.created", "ask.answered", "session.ended"],
  data: () => {
    const now = Date.now();
    // Only a DATED hold hides a question: "later" means "bring it back then", and until then it is
    // genuinely not his. `aged` is deliberately kept — that bucket is a row nobody ever dated, and a
    // three-day-old unanswered question is the last thing a card called "needs you" should drop.
    const open = asksStore.list({ status: "open" }).filter((a) => holdBucket(a, now) !== "dated");
    return { now, items: decideItems({ terminals: liveTerminals(now), asks: open, now }) };
  },
};

export default decide;
