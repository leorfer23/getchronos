/**
 * Late-bound reindex callback so sessions / session_prs can bump FTS without importing
 * session-search.ts (which reads those stores — a load-order cycle).
 *
 * session-search.installSessionSearchHooks() registers the real indexer at boot.
 */
type Bump = (sessionId: string) => void;

let bump: Bump | null = null;

export const sessionSearchHook = {
  set(fn: Bump): void {
    bump = fn;
  },
  /** Best-effort: a failed reindex must never fail the write that triggered it. */
  bump(sessionId: string): void {
    try {
      bump?.(sessionId);
    } catch {}
  },
};
