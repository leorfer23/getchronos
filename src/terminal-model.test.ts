/**
 * The model a terminal opened without one gets. The fleet/workspace defaults are claude aliases, so
 * they must never reach another backend's CLI (cursor-agent `--model sonnet` hits Cursor's paid cap).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "./config.js";
import { defaultSessionModel } from "./terminal.js";

test("claude terminals fall back to the workspace default, then the fleet default", () => {
  assert.equal(defaultSessionModel("claude-code", "opus"), "opus");
  assert.equal(defaultSessionModel(null, "opus"), "opus"); // no backend = claude
  assert.equal(defaultSessionModel("claude-code", null), CONFIG.defaultModel);
});

test("non-claude terminals get no claude alias — the backend picks its own default", () => {
  for (const b of ["cursor-agent", "cursor", "grok", "codex", "opencode"]) {
    assert.equal(defaultSessionModel(b, "opus"), null, b);
    assert.equal(defaultSessionModel(b, null), null, b);
  }
});
