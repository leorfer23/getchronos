/**
 * What a Claude Desk terminal is told about the two artifact systems — the block terminal.ts folds
 * into its system prompt. Claude Code's own Artifact tool is told to publish unasked, so without this
 * it quietly chose claude.ai over `mc artifact`. The agent must ask the operator which one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { artifactChoiceBlock } from "./terminal.js";

test("a Claude terminal is told to ask which artifact system before its first page", () => {
  const block = artifactChoiceBlock("claude-code");
  assert.match(block, /mc artifact/);
  assert.match(block, /Artifact tool/);
  assert.match(block, /AskUserQuestion/, "asks through the Desk's prompt card, not by guessing");
  assert.match(block, /Never choose for them/);
  assert.match(block, /never publish before they answer/);
  assert.match(block, /every later page/, "asks once per terminal, not every page");
  assert.ok(block.split("\n").filter((l) => l.trim()).length <= 8, `${block.split("\n").length} lines`);
  assert.ok(!block.includes("<!--"), "editor notes are stripped");
});

test("other backends have no Artifact tool, so they get nothing", () => {
  for (const b of ["cursor", "codex", "grok", "opencode", "mock"]) assert.equal(artifactChoiceBlock(b), "");
});
