import { test } from "node:test";
import assert from "node:assert/strict";
import { baseJobName } from "./job-name.js";
import { isReadOnlyRun } from "./runner.js";

test("baseJobName strips the rate-limit fallback wrapper", () => {
  assert.equal(baseJobName("review:PER-80"), "review:PER-80");
  assert.equal(baseJobName("fallback:review:PER-80"), "review:PER-80");
  assert.equal(baseJobName("fallback:fallback:plan:PER-80:risk"), "plan:PER-80:risk");
  assert.equal(baseJobName(null), "");
});

// The PER-80 loop: a fallback clone of a reviewer run was classified as a BUILD run, so its success
// re-published review.created and re-dispatched the reviewer — 92 jobs, 95 runs, one ticket.
test("a fallback clone of a read-only run stays read-only", () => {
  assert.equal(isReadOnlyRun("review:PER-80"), true);
  assert.equal(isReadOnlyRun("fallback:review:PER-80"), true);
  assert.equal(isReadOnlyRun("fallback:plan:PER-80"), true);
  assert.equal(isReadOnlyRun("fallback:grade:PER-80"), true);
  assert.equal(isReadOnlyRun("fallback:intake:personal"), true);
  assert.equal(isReadOnlyRun("ticket:PER-80"), false);
  assert.equal(isReadOnlyRun("fallback:ticket:PER-80"), false);
});
