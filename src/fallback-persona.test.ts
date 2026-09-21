import test from "node:test";
import assert from "node:assert/strict";
import { capabilityGap } from "./manager-fallback.js";

// The whole point of the agents/ tree is that an agent IS its declaration. If a backend swap can
// silently change which tools that declaration grants, the declaration means different things on
// different days — so the gap has to be computed and stated, never assumed away.

const ADA = {
  name: "Ada",
  tools: "Bash,Read,Edit,Write,Grep,Glob",
  mcpConfig: '{"mcpServers":{"playwright":{}}}',
};

test("a backend that honors nothing reports both gaps, naming the tools that are gone", () => {
  const gap = capabilityGap("grok", ADA);
  assert.equal(gap.length, 2);
  assert.ok(gap.some((g) => /MCP servers/.test(g)), gap.join(" | "));
  assert.ok(gap.some((g) => g.includes(ADA.tools)), "the agent should be told WHICH tools it lost");
});

test("a backend that honors the declaration reports no gap", () => {
  assert.deepEqual(capabilityGap("claude-code", ADA), []);
});

// Keyed off declared capabilities, not off vendor names: an agent that asks for nothing loses
// nothing, whichever CLI answers.
test("an agent with no tools and no MCP has nothing to lose on any backend", () => {
  assert.deepEqual(capabilityGap("grok", { name: "Iris" }), []);
  assert.deepEqual(capabilityGap("claude-code", { name: "Iris" }), []);
});

test("no agent declaration → no gap", () => {
  assert.deepEqual(capabilityGap("grok", undefined), []);
});

// getBackend falls back to claude for an unregistered name, so that IS what will spawn — reporting
// claude's capabilities here is correct, not a hole. Asserted so the two never drift apart.
test("an unknown backend name reports the capabilities of what actually spawns", () => {
  assert.deepEqual(capabilityGap("nonexistent-backend", ADA), []);
});
