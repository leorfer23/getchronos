/**
 * Quick actions — the sentences the operator types over and over, as one tap in the stage footer.
 *
 * Answering a terminal is almost never a new thought: it is "Approved, go ahead", "Continue",
 * "Where are you? One line". Typing those into the composer costs a mode switch (the pane has the
 * keyboard, the composer does not) and a few seconds each, dozens of times a day. So they become
 * chips in `#sbar`, and each one goes through the SAME door as the composer —
 * POST /sessions/:id/input with `by: "operator"` — so nothing here is a second way to talk to an
 * agent, only a shorter way to say the same thing.
 *
 * What lives here is everything that decides WHICH chips exist and in what order, so
 * src/desk-quick-actions.test.ts can pin it without a browser. The page cannot import a TS module
 * (desk.html has no build step), so static/desk-quick-actions.js is a hand-kept mirror of this file
 * and the test asserts the two agree — the same trick term-links.js uses, inverted: the canonical
 * copy is here because the daemon needs the defaults too (an empty kv must still give the operator
 * a footer full of chips, without the page ever having written one).
 *
 * Deliberately dependency-free: the API route reads/writes the kv around it, the page reads its
 * mirror. Nothing in here touches the database or the DOM.
 */

/** The phases a chip may be pinned to — src/term-status.ts PHASES, plus "always". */
export const QA_PHASES = ["blocked", "decide", "review", "your_turn", "waiting", "working", "stalled", "always"] as const;
export type QuickActionPhase = (typeof QA_PHASES)[number];

/**
 * What a tap does.
 *   · text       — types the action's text into the terminal and hits Enter.
 *   · approve    — the same, EXCEPT while a parsed prompt is open: then it takes the prompt's first
 *                  option (or "y"), because a terminal sitting on "1. Yes / 2. No" does not want the
 *                  word "Approved" typed at it. See `smart` on a resolved action.
 *   · changes    — types nothing; focuses wherever the operator types, so they can say what to change.
 *   · ask-robert — hands the terminal to Robert instead of answering it yourself.
 *   · kill       — the footer's existing end-terminal action, confirm and all.
 */
export const QA_KINDS = ["text", "approve", "changes", "ask-robert", "kill"] as const;
export type QuickActionKind = (typeof QA_KINDS)[number];

export type QuickAction = {
  label: string;
  /** What gets typed. Empty for the kinds that type nothing. */
  text: string;
  kind: QuickActionKind;
  phases: QuickActionPhase[];
  /** ⌥<key> fires it. null = take the next free number in visible order. */
  key: number | null;
};

/** A visible chip: the action plus what the footer needs to draw and fire it. */
export type ResolvedQuickAction = QuickAction & {
  /** The ⌥ number it answers to, or null when the row ran past nine. */
  n: number | null;
  /** An approve chip sitting on an open prompt: take the prompt's first option, not the text. */
  smart: boolean;
};

/** More than this and the footer is a menu, not a row of moves. */
export const MAX_VISIBLE = 8;
/** A ceiling on the stored list, so a bad PUT cannot make the footer unrenderable. */
export const MAX_QUICK_ACTIONS = 40;
export const MAX_LABEL = 24;
export const MAX_TEXT = 2000;

/** Where the list lives when the operator has edited it. Empty kv = DEFAULT_QUICK_ACTIONS. */
export const QUICK_ACTIONS_KV = "desk.quick_actions";

/**
 * The shipped set. Ordered by phase, because order IS the ⌥ numbering: within a phase the chips
 * come out 1, 2, 3 in the order written here, and the two "always" chips land after them.
 *
 * "ended" is missing on purpose — the footer already offers ↻ Reopen and nothing else applies.
 */
export const DEFAULT_QUICK_ACTIONS: readonly QuickAction[] = Object.freeze([
  { label: "✓ Approve", text: "Approved, go ahead", kind: "approve", phases: ["review", "decide"], key: null },
  { label: "🔀 Merge", text: "Merge it and close the terminal", kind: "text", phases: ["review"], key: null },
  { label: "🔍 QA pass", text: "Do a QA pass: run the tests, try the happy path and two edge cases, report what broke", kind: "text", phases: ["review"], key: null },
  { label: "✎ Changes", text: "", kind: "changes", phases: ["review"], key: null },
  { label: "▶ Continue", text: "Continue", kind: "text", phases: ["decide", "your_turn"], key: null },
  { label: "🎲 Your call", text: "Use your judgement and continue, don't ask me", kind: "text", phases: ["decide", "your_turn"], key: null },
  { label: "❓ Status", text: "Where are you? One line", kind: "text", phases: ["working", "waiting"], key: null },
  { label: "⏸ Pause", text: "Finish this step and stop", kind: "text", phases: ["working", "waiting"], key: null },
  { label: "📝 Summary", text: "Write the Summary block now", kind: "text", phases: ["working", "waiting"], key: null },
  { label: "↻ Retry", text: "Retry from where you left off", kind: "text", phases: ["blocked", "stalled"], key: null },
  { label: "🤖 Ask Robert", text: "Have a look at this terminal and tell me what you'd do", kind: "ask-robert", phases: ["blocked", "stalled"], key: null },
  { label: "⏹ Kill", text: "", kind: "kill", phases: ["blocked", "stalled"], key: null },
  { label: "▶ Continue", text: "Continue", kind: "text", phases: ["always"], key: null },
  { label: "🤖 Ask Robert", text: "Have a look at this terminal and tell me what you'd do", kind: "ask-robert", phases: ["always"], key: null },
] as QuickAction[]);

/** A fresh, mutable copy — callers hand this straight to a route or a dialog and may edit it. */
export function defaultQuickActions(): QuickAction[] {
  return DEFAULT_QUICK_ACTIONS.map((a) => ({ ...a, phases: [...a.phases] }));
}

/**
 * The chips for one terminal, in order, with their ⌥ numbers resolved.
 *
 * Three rules, and they are the whole feature:
 *   · a chip shows in its own phases plus "always";
 *   · the same label twice is one chip — the "always" ▶ Continue must not sit beside the decide one;
 *   · an ended terminal gets nothing.
 *
 * `hasPrompt` is whether src/desk-prompt.ts parsed an open question out of the screen. It does not
 * change which chips show — only whether the approve chip goes through the prompt.
 */
export function visibleActions(actions: readonly QuickAction[], phase: string, hasPrompt = false): ResolvedQuickAction[] {
  if (!phase || phase === "ended") return [];
  const picked: QuickAction[] = [];
  const seen = new Set<string>();
  for (const a of actions || []) {
    if (!a || !Array.isArray(a.phases)) continue;
    if (!a.phases.includes(phase as QuickActionPhase) && !a.phases.includes("always")) continue;
    const key = String(a.label ?? "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    picked.push(a);
    if (picked.length >= MAX_VISIBLE) break;
  }
  // Pinned numbers first, so a chip that says ⌥2 keeps saying ⌥2 whatever else is on the row; the
  // rest fill the gaps left over. First pin wins a contested number — two chips cannot share one.
  const taken = new Set<number>();
  const pinned = new Map<number, number>();
  picked.forEach((a, i) => {
    const k = Number(a.key);
    if (Number.isInteger(k) && k >= 1 && k <= 9 && !taken.has(k)) { taken.add(k); pinned.set(i, k); }
  });
  let next = 1;
  return picked.map((a, i) => {
    let n = pinned.has(i) ? (pinned.get(i) as number) : null;
    if (n === null) {
      while (next <= 9 && taken.has(next)) next++;
      if (next <= 9) { n = next; taken.add(next); }
    }
    return {
      label: a.label, text: a.text, kind: a.kind || "text", phases: [...a.phases], key: a.key ?? null,
      n, smart: a.kind === "approve" && !!hasPrompt,
    };
  });
}
