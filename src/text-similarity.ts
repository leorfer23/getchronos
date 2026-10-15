/**
 * Shared token-overlap helpers for lessons, recall, and session-learnings dedupe.
 *
 * Kept free of store imports so callers can use it from notes, lessons, and tests without
 * pulling the whole feedback loop into memo capture.
 */

const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "if", "to", "of", "in", "on", "for", "with", "is", "are",
  "be", "was", "were", "it", "this", "that", "when", "then", "than", "not", "no", "do", "dont",
  "use", "using", "used", "should", "must", "always", "never", "you", "your", "we", "our",
]);

export function tokens(s: string): Set<string> {
  return new Set(
    (s || "")
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      // Crude singular fold, applied to both sides: a rule about "migrations" has to match a ticket
      // about "a migration". Over-stemming ("status" → "statu") is harmless because it's symmetric.
      .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)),
  );
}

/** Jaccard overlap — enough to tell "same complaint again" from "a different complaint". */
export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}
