/**
 * Process-local build lock per repo. Query never takes this lock — it only reads a fresh
 * manifest/artifact. Build uses try-acquire so a concurrent build returns busy instead of
 * queueing behind a ten-minute extract.
 */

const holders = new Set<string>();

/** Acquire immediately or return null if another build already holds the repo. */
export function tryAcquireBuildLock(repoId: string): (() => void) | null {
  if (holders.has(repoId)) return null;
  holders.add(repoId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders.delete(repoId);
  };
}

export function isBuildLocked(repoId: string): boolean {
  return holders.has(repoId);
}

/** Test seam. */
export function resetBuildLocks(): void {
  holders.clear();
}
