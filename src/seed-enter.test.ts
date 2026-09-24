import { test } from "node:test";
import assert from "node:assert/strict";
import { seedEnterMsFor } from "./terminal.js";

// m2, 2026-09-24: cursor-agent swallowed an Enter sent 250ms after the pasted seed.
test("seed Enter waits longer for cursor, not for the CLIs that submit fine at 250ms", () => {
  assert.equal(seedEnterMsFor("claude-code"), 250);
  assert.equal(seedEnterMsFor("grok"), 250);
  assert.ok(seedEnterMsFor("cursor-agent") >= 1000);
  assert.ok(seedEnterMsFor("cursor") >= 1000);
});
