import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict, shouldRunGate } from "./merge-gate.js";
import { workspaces } from "./store/workspaces.js";

test("parseVerdict reads the contract line", () => {
  assert.deepEqual(parseVerdict("MERGE-GATE: APPROVE — diff matches the ticket, no CI on this repo"), {
    approved: true,
    reason: "diff matches the ticket, no CI on this repo",
  });
  assert.equal(parseVerdict("MERGE-GATE: HOLD — the approach changes the public API")?.approved, false);
  // Plain hyphen and no separator at all are both accepted; the model picks its own dash.
  assert.equal(parseVerdict("MERGE-GATE: APPROVE - ok")?.approved, true);
  assert.equal(parseVerdict("MERGE-GATE: APPROVE")?.reason, "");
});

test("parseVerdict takes the LAST verdict, not a quoted instruction", () => {
  // The agent often restates its instructions (which contain both lines) before deciding. If the
  // first match won, an approval template quoted mid-report would merge a held PR.
  const summary = [
    "I was told to finish with one of:",
    "MERGE-GATE: APPROVE — <one line>",
    "MERGE-GATE: HOLD — <one line>",
    "",
    "main moved and this conflicts.",
    "MERGE-GATE: HOLD — rebase conflict with main needs a human call",
  ].join("\n");
  const v = parseVerdict(summary);
  assert.equal(v?.approved, false);
  assert.equal(v?.reason, "rebase conflict with main needs a human call");
});

test("parseVerdict refuses anything that is not the contract line", () => {
  assert.equal(parseVerdict(null), null);
  assert.equal(parseVerdict(""), null);
  // The word alone must never read as a decision — this is the difference between "the agent
  // approves" and "the agent used the word approve in a sentence".
  assert.equal(parseVerdict("I approve of this change, it looks great and should be merged."), null);
  assert.equal(parseVerdict("The review panel already gave an APPROVE verdict earlier."), null);
});

test("shouldRunGate only fires for a merge_gate workspace with an open PR", () => {
  const gated = workspaces.create({
    slug: `mg-on-${Math.random().toString(36).slice(2, 8)}`,
    name: "gated",
    config_dir: "/tmp/cfg",
    merge_gate: true,
  } as any);
  const plain = workspaces.create({
    slug: `mg-off-${Math.random().toString(36).slice(2, 8)}`,
    name: "plain",
    config_dir: "/tmp/cfg",
  } as any);

  const base = { id: "t1", workspace_id: gated.id, pr_state: "open", ci_state: null };
  assert.equal(shouldRunGate(base), true, "no CI configured → the gate IS the check");
  assert.equal(shouldRunGate({ ...base, ci_state: "passing" }), true);

  // Red CI belongs to delivery.ts's auto-fix; two agents pushing the same branch is the bug this
  // guard exists to prevent. Pending simply is not an answer yet.
  assert.equal(shouldRunGate({ ...base, ci_state: "failing" }), false);
  assert.equal(shouldRunGate({ ...base, ci_state: "pending" }), false);

  assert.equal(shouldRunGate({ ...base, pr_state: "merged" }), false);
  assert.equal(shouldRunGate({ ...base, pr_state: null }), false);
  assert.equal(shouldRunGate({ ...base, workspace_id: plain.id }), false, "opt-in only");
});
