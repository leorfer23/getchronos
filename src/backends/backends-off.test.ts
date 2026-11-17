import { test } from "node:test";
import assert from "node:assert/strict";
import { backendAllowed, backendInstalled, backendOff, backendReady, listBackends, validateSpawnTarget } from "./index.js";
import { cliOnThisMac } from "../usage-meter.js";

function withOff<T>(value: string | undefined, fn: () => T): T {
  const before = process.env.CHRONOS_BACKENDS_OFF;
  if (value === undefined) delete process.env.CHRONOS_BACKENDS_OFF;
  else process.env.CHRONOS_BACKENDS_OFF = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.CHRONOS_BACKENDS_OFF;
    else process.env.CHRONOS_BACKENDS_OFF = before;
  }
}

test("a backend named in CHRONOS_BACKENDS_OFF is off under every alias, and nothing else is", () => {
  const env = { CHRONOS_BACKENDS_OFF: " grok , nonsense" };
  assert.equal(backendOff("grok", env), true);
  assert.equal(backendOff("grok-cli", env), true);
  assert.equal(backendOff("claude-code", env), false);
  assert.equal(backendOff("cursor", env), false);
  assert.equal(backendOff("grok", {}), false);
  assert.equal(backendOff(null, env), false);
});

test("an off backend is refused at the spawn gates and missing from the picker", () => {
  withOff("grok", () => {
    assert.match(validateSpawnTarget("grok", "grok-4.5") ?? "", /switched off/);
    assert.equal(validateSpawnTarget("claude-code", "opus"), null);
    assert.equal(backendAllowed(null, "grok"), false, "no allow-list still refuses it");
    assert.equal(backendAllowed('["claude-code","grok"]', "grok"), false, "an allow-list naming it still refuses it");
    assert.equal(backendAllowed('["claude-code","grok"]', "claude-code"), true);
    assert.ok(!listBackends().some((b) => b.name === "grok"));
    assert.ok(listBackends().some((b) => b.name === "claude-code"));
  });
});

test("failover chains skip an off backend: it never counts as installed or ready", () => {
  withOff("grok", () => {
    assert.equal(backendInstalled("grok"), false);
    assert.equal(backendReady("grok"), false);
  });
});

test("the usage meter shows no chip for an off CLI", () => {
  assert.equal(cliOnThisMac("grok", { CHRONOS_BACKENDS_OFF: "grok", PATH: "" }, "/nonexistent"), false);
  assert.equal(cliOnThisMac("claude", { CHRONOS_BACKENDS_OFF: "grok" }), true);
});

test("clearing the variable brings it back", () => {
  withOff(undefined, () => {
    assert.equal(validateSpawnTarget("grok", "grok-4.5"), null);
    assert.equal(backendAllowed(null, "grok"), true);
    assert.ok(listBackends().some((b) => b.name === "grok"));
  });
});
