import { test } from "node:test";
import assert from "node:assert/strict";
import { isReadOnlyRun, shouldFileReviewOnEnd, worktreeSandboxDirs } from "./runner.js";

// Building in a worktree must WRITE-DENY the shared main checkout (guard is allow-by-default) while
// re-granting its .git (worktree commits) + .mc (ticket store) — else the agent commits its edits
// onto main (PER-36). Read stays allowed (readonly, not deny) so linked-worktree git still works.
test("worktreeSandboxDirs marks the shared checkout readonly, re-grants .git + .mc", () => {
  const r = worktreeSandboxDirs("/Users/dev/chronos", "/Users/dev/.chronos-worktrees/chronos/mc-per-36");
  assert.deepEqual(r.readonly, ["/Users/dev/chronos"]);
  assert.deepEqual(r.grant, ["/Users/dev/chronos/.git", "/Users/dev/chronos/.mc"]);
});

test("worktreeSandboxDirs is a no-op when not in a worktree (cwd === repo) or no repo", () => {
  assert.deepEqual(worktreeSandboxDirs("/Users/dev/chronos", "/Users/dev/chronos"), { readonly: [], grant: [] });
  assert.deepEqual(worktreeSandboxDirs(null, "/anywhere"), { readonly: [], grant: [] });
  assert.deepEqual(worktreeSandboxDirs(undefined, "/anywhere"), { readonly: [], grant: [] });
});

// Regression: `grade:` was missing from the read-only list, so difficulty-grader runs created
// reviews and git-add-A-committed the shared checkout onto main. `intake:` was missing the same
// way — a clean-exit intake sweep parked on a stray ask (PER-35). All read-only kinds must be caught.
test("isReadOnlyRun excludes every read-only run kind, includes builds", () => {
  for (const name of [
    "plan:PER-1", "review:PER-1", "distill:PER-1", "grade:PER-1",
    "ideas:miner:personal", "intake:personal",
  ]) {
    assert.equal(isReadOnlyRun(name), true, `${name} must be read-only`);
  }
  assert.equal(isReadOnlyRun("build:PER-1"), false);
  assert.equal(isReadOnlyRun("slack-triage:globex"), false);
  // The rate-limit fallback clones a job as `fallback:<name>`. Read as a build, a stand-in reviewer
  // queued a review of its own run → auto-dispatch → rate limit → fallback → 200 runs on PER-80.
  for (const name of [
    "fallback:review:PER-1", "fallback:plan:PER-1",
    "fallback:ideas:followups:PER-1", "fallback:intake:personal",
  ]) {
    assert.equal(isReadOnlyRun(name), true, `${name} must be read-only`);
  }
  assert.equal(isReadOnlyRun("fallback:ticket:PER-1"), false);
  assert.equal(isReadOnlyRun(null), false);
  assert.equal(isReadOnlyRun(undefined), false);
});

// merge-gate:/ci-fix: write in the ticket worktree, so they stay OFF isReadOnlyRun (worktree lock).
// Ending them must still skip createForRun — otherwise review.created → auto-review → approve →
// merge() re-arms delivery and the gate runs again (PER-4 / PER-13).
test("shouldFileReviewOnEnd skips read-only and post-build gates; keeps real builds", () => {
  for (const name of ["plan:PER-1", "review:PER-1", "merge-gate:PER-1", "ci-fix:PER-1", "fallback:merge-gate:PER-1", "fallback:ci-fix:PER-1"]) {
    assert.equal(shouldFileReviewOnEnd(name), false, `${name} must not file a review on end`);
  }
  // Still take the worktree lock — not classified as read-only.
  assert.equal(isReadOnlyRun("merge-gate:PER-1"), false);
  assert.equal(isReadOnlyRun("ci-fix:PER-1"), false);
  assert.equal(shouldFileReviewOnEnd("ticket:PER-1"), true);
  assert.equal(shouldFileReviewOnEnd("build:PER-1"), true);
  assert.equal(shouldFileReviewOnEnd("fallback:ticket:PER-1"), true);
  assert.equal(shouldFileReviewOnEnd(null), false);
});
