/**
 * Who typed a line into a terminal — the operator, or Chronos on his behalf.
 *
 * A CLI's transcript cannot tell: the daemon types into the pty (sendInput, the spawn seed, the
 * revive nudge), so a verifier round, a network nudge, Robert's tell or a continuation lands in the
 * transcript exactly like a line the operator typed (claude records them all as `promptSource:
 * "typed"`, `origin: human`). Anything that mines "what the operator keeps asking for" must first
 * take the daemon's lines out, or it learns from its own voice.
 *
 *   mark      every line the daemon types leaves an `input_marks` row: its kind and a hash of its
 *             first words (textKey) — never the text. sendInput and openSession's seed write them.
 *   classify  a transcript's typed turns are matched against those marks (and, for history from
 *             before marks existed, the `session.input` trail in `activity` and the fixed openings
 *             of the daemon's own lines); whatever matches nothing is the operator's.
 */
import { createHash } from "node:crypto";
import { inputMarks } from "./store/input-marks.js";
import { REVIVE_NUDGE } from "./revive.js";

export const INJECT_KINDS = [
  "operator", "verifier", "revive", "network", "robert", "lead", "continuation", "approval", "ask", "seed", "system",
] as const;
export type InjectKind = (typeof INJECT_KINDS)[number];

/** What a line's identity is cut from: enough words to be unique, few enough that a CLI's tail edits don't matter. */
export const KEY_CHARS = 80;
/** A mark may be stamped a little after the turn it typed (Enter goes 200ms later; clocks skew). */
const MARK_SKEW_MS = 60_000;
/** A line typed while the agent works waits in the CLI's queue — sometimes for a long turn. */
const QUEUE_MAX_MS = 12 * 3600_000;

/** The `by` a line was typed under → its kind. Anything not the operator's or the daemon's own is an agent's tell. */
const SYSTEM_BY = new Set(["cache-keeper", "executor", "failover", "budget", "ship", "daemon"]);
export function kindOfBy(by: string | null | undefined): InjectKind {
  const b = String(by ?? "").trim().toLowerCase();
  if (!b || b === "operator") return "operator";
  if (b === "verifier") return "verifier";
  if (b === "net-nudge") return "network";
  if (b === "ask") return "ask";
  if (b.startsWith("lead:")) return "lead";
  if (b.startsWith("continuation")) return "continuation";
  if (SYSTEM_BY.has(b)) return "system";
  return "robert";
}

/** Whitespace-, case- and paste-marker-insensitive form of a typed line. */
export function normTurn(s: string): string {
  return String(s ?? "").replace(/\x1b\[20[01]~/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}
export const textKey = (s: string): string => createHash("sha256").update(normTurn(s).slice(0, KEY_CHARS)).digest("hex").slice(0, 16);

/** Record one line the daemon typed. Never throws: a mark must not cost the keystroke. */
export function markInput(m: { session_id: string; workspace_id: string | null; kind: InjectKind; by?: string | null; text: string; at?: string }): void {
  if (!m.text || !normTurn(m.text)) return;
  try {
    inputMarks.add({ session_id: m.session_id, workspace_id: m.workspace_id, kind: m.kind, by: m.by ?? null, text_key: textKey(m.text), at: m.at });
  } catch (e: any) {
    console.warn("[turn-source] mark failed", e?.message ?? e);
  }
}

/**
 * The daemon's own lines open the same way every time. Used for turns typed before marks existed, and
 * as a second net under them. Kept beside the text they match: tellLine (verify-model.ts),
 * REVIVE_NUDGE (revive.ts), NETWORK_NUDGE (net-nudge.ts), continuationMessage (continuations.ts),
 * holderAnswerLine (asks.ts) — turn-source.test.ts runs each real producer through this.
 */
const OPENINGS: Array<[InjectKind, string]> = [
  ["verifier", "[verifier] "],
  ["revive", REVIVE_NUDGE.slice(0, 48)],
  ["network", "Your last turn died because the network was down"],
  ["continuation", "⏰ Chronos continuation "],
  ["continuation", "⚠️ Chronos continuation "],
  ["ask", "The operator answered Robert's question"],
];
export function openingKind(text: string): InjectKind | null {
  const t = normTurn(text);
  for (const [kind, head] of OPENINGS) if (t.startsWith(normTurn(head))) return kind;
  return null;
}

export interface Mark { kind: InjectKind; key: string; at: number }
export interface TypedTurn { text: string; at: number; /** the transcript's first typed turn — where a seed lands */ first?: boolean }

/** Marks for one terminal: its own rows, plus the `session.input` trail (best effort — the activity table is capped). */
export function marksFor(sessionId: string, trail: Array<{ ts: string; detail: string | null }> = []): Mark[] {
  const out: Mark[] = inputMarks.forSession(sessionId).map((r) => ({
    kind: (INJECT_KINDS as readonly string[]).includes(r.kind) ? (r.kind as InjectKind) : "system",
    key: r.text_key,
    at: Date.parse(r.at),
  }));
  for (const row of trail) {
    let d: any;
    try { d = JSON.parse(row.detail ?? "{}"); } catch { continue; }
    if (typeof d?.text !== "string" || /^<[a-z-]+>/.test(d.text)) continue; // a key press, not a line
    out.push({ kind: kindOfBy(d.by), key: textKey(d.text), at: Date.parse(row.ts) });
  }
  return out.filter((m) => Number.isFinite(m.at)).sort((a, b) => a.at - b.at);
}

/**
 * Each typed turn's author, in order. A mark is spent on one turn, the earliest that fits: same key
 * (the whole turn, or one of its lines — a CLI may hand several queued lines over as one turn), typed
 * before the turn landed (within the skew) and not longer ago than a queue can hold. A turn no mark
 * claims falls back to the daemon's fixed openings, then to `seedKey` for the first turn, then to the
 * operator.
 */
export function classifyTurns(turns: TypedTurn[], marks: Mark[], seedKey?: string | null): InjectKind[] {
  const used = new Set<number>();
  return turns.map((t) => {
    const keys = new Set([textKey(t.text), ...t.text.split("\n").filter((l) => normTurn(l)).map(textKey)]);
    const i = marks.findIndex((m, j) => !used.has(j) && keys.has(m.key) && m.at <= t.at + MARK_SKEW_MS && m.at >= t.at - QUEUE_MAX_MS);
    if (i >= 0) {
      used.add(i);
      return marks[i].kind;
    }
    const opening = openingKind(t.text);
    if (opening) return opening;
    if (t.first && seedKey && keys.has(seedKey)) return "seed";
    return "operator";
  });
}
