import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilitiesGoal, parseCapabilities } from "./tickets.js";

/**
 * PER-27 / PER-28. 10 of the 12 asks in Chronos' history were avoidable before the run started:
 * 7 were "this already shipped", 3 were "this environment cannot reach X". Both are answered by
 * telling the agent up front instead of letting it spend the run finding out.
 */

// ── capabilities (PER-28) ───────────────────────────────────────────────────────────────────────

test("nothing declared injects nothing — existing prompts are unchanged", () => {
  assert.equal(capabilitiesGoal(null), "");
  assert.equal(capabilitiesGoal(undefined), "");
  assert.equal(capabilitiesGoal("[]"), "");
});

test("only the UNAVAILABLE capabilities reach the prompt", () => {
  const caps = JSON.stringify([
    { name: "GitHub", available: true },
    { name: "BigQuery", available: false, note: "sandbox denies ~/.config/gcloud" },
  ]);
  const g = capabilitiesGoal(caps);
  assert.match(g, /BigQuery/);
  assert.match(g, /sandbox denies ~\/\.config\/gcloud/);
  assert.ok(!g.includes("GitHub"), "what works is noise in a prompt — only what's missing earns space");
});

test("an all-available workspace still injects nothing", () => {
  assert.equal(capabilitiesGoal(JSON.stringify([{ name: "GitHub", available: true }])), "");
});

test("the agent is told to stop, not to ask — 'we don't have it' is not an answerable question", () => {
  const g = capabilitiesGoal(JSON.stringify([{ name: "Redshift", available: false }]));
  assert.match(g, /stop/i);
  assert.match(g, /do not open an ask/i);
});

test("malformed capabilities are ignored rather than crashing a dispatch", () => {
  assert.deepEqual(parseCapabilities("not json"), []);
  assert.deepEqual(parseCapabilities('{"not":"an array"}'), []);
  assert.deepEqual(parseCapabilities("[1,2,3]"), [], "entries without a name are dropped");
  assert.equal(capabilitiesGoal("not json"), "");
});

test("a capability with no note still renders", () => {
  const g = capabilitiesGoal(JSON.stringify([{ name: "VPN", available: false }]));
  assert.match(g, /• VPN\n/, "no note must not leave a dangling dash");
});
