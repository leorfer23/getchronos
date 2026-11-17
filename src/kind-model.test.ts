import assert from "node:assert/strict";
import test from "node:test";
import { modelForKind } from "./kind-model.js";
import { initialSessionModel } from "./terminal.js";
import { claudeBackend as claude, headlessCacheTtl } from "./backends/claude.js";

test("modelForKind: investigations get the lighter model by default; other kinds keep the usual default", () => {
  assert.equal(modelForKind("investigation", null), process.env.CHRONOS_INVESTIGATION_MODEL || "sonnet");
  for (const k of ["pr", "ui", "qa", "product", "chat", null, undefined]) assert.equal(modelForKind(k as any, null), null, String(k));
});

test("initialSessionModel: a fresh claude investigation starts on sonnet; a picked model, a reopen or another CLI is untouched", () => {
  const inv = process.env.CHRONOS_INVESTIGATION_MODEL || "sonnet";
  assert.equal(initialSessionModel({ backend: "claude-code", goal_kind: "investigation" }, "opus"), inv);
  // The kind can ride on the first goal of a list (a Lead's `mc session new` with goals).
  assert.equal(initialSessionModel({ backend: "claude-code", goals: [{ text: "check the logs", kind: "investigation" }] }, "opus"), inv);
  assert.equal(initialSessionModel({ backend: "claude-code", goal_kind: "pr" }, "opus"), "opus");
  assert.equal(initialSessionModel({ backend: "claude-code", goal_kind: "investigation", resumeId: "abc" }, "opus"), "opus");
  assert.equal(initialSessionModel({ backend: "grok", goal_kind: "investigation" }, "opus"), null);
});

test("claude env: headless runs ask for a 5-minute prompt cache; terminals keep Claude Code's own TTL", () => {
  const job = { name: "monitor:acme-app" } as any;
  assert.equal(claude.env!(job, "/Users/operator/.claude-acme").CLAUDE_CODE_PROMPT_CACHE_TTL, headlessCacheTtl());
  assert.equal(claude.env!({} as any, "/Users/operator/.claude-acme").CLAUDE_CODE_PROMPT_CACHE_TTL, undefined);
  assert.equal(headlessCacheTtl({}), "5m");
  assert.equal(headlessCacheTtl({ CHRONOS_HEADLESS_CACHE_TTL: "1h" }), "1h");
  assert.equal(headlessCacheTtl({ CHRONOS_HEADLESS_CACHE_TTL: "" }), null);
  assert.equal(headlessCacheTtl({ CHRONOS_HEADLESS_CACHE_TTL: "2h" }), null);
});
