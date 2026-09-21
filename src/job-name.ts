// A rate-limit fallback clones a job under `fallback:<original name>`. Every kind check in the
// system is a prefix match on the job name, so the wrapper silently reclassified the clone: a
// `fallback:review:PER-80` run stopped counting as read-only, ran createForRun on success,
// re-published review.created, and re-dispatched the reviewer — a 92-run loop (PER-80, 2026-07-30).
// Strip the wrapper before any prefix test.
const WRAPPER_PREFIXES = ["fallback:"];

export function baseJobName(name?: string | null): string {
  let n = name ?? "";
  for (;;) {
    const p = WRAPPER_PREFIXES.find((w) => n.startsWith(w));
    if (!p) return n;
    n = n.slice(p.length);
  }
}

// Jobs the machinery files for itself — one per ticket dispatch, review, plan, grade, follow-up
// sweep, fallback clone. They are runs, not something the operator set up; the Jobs surface
// (Desk `⋯ → Jobs`, `GET /api/jobs?kind=operator`) shows everything else.
export const INTERNAL_JOB_PREFIXES = [
  "ticket:", "review:", "plan:", "grade:", "distill:", "ideas:", "intake:", "ci-fix:", "merge-gate:", "verify:", "nextday:",
];
export function isInternalJob(name?: string | null): boolean {
  const base = baseJobName(name);
  return !!base && INTERNAL_JOB_PREFIXES.some((p) => base.startsWith(p));
}
