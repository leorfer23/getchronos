/**
 * The skills listing and tools a Desk claude terminal is opened with: every skill by name except the
 * few kept in full, and the env switches that drop tools nobody here used.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "./store.js";
import { _resetSettingsCache, writeSetting } from "./settings.js";
import { leanClaudeArgs, leanClaudeEnv, SHIPPED_SKILLS, skillNames, skillOverrides } from "./lean-prompt.js";

beforeEach(() => {
  for (const k of ["desk.lean_skills", "desk.artifact_tool", "desk.lean_tools", "desk.skills_full"]) writeSetting(k, null);
  _resetSettingsCache();
});

function profile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lean-"));
  for (const s of ["mission-control", "airflow", "cloudflare"]) {
    fs.mkdirSync(path.join(dir, "skills", s), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", s, "SKILL.md"), "---\nname: " + s + "\n---\n");
  }
  fs.mkdirSync(path.join(dir, "skills", "not-a-skill"));
  fs.mkdirSync(path.join(dir, "commands"));
  fs.writeFileSync(path.join(dir, "commands", "analyze.md"), "x");
  return dir;
}

test("skill names: the profile's skills and commands plus what Claude Code ships; a folder without SKILL.md is not one", () => {
  const n = skillNames(profile());
  for (const s of ["mission-control", "airflow", "cloudflare", "analyze", ...SHIPPED_SKILLS]) assert.ok(n.includes(s), s);
  assert.ok(!n.includes("not-a-skill"));
});

test("overrides: everything name-only but the ones kept in full", () => {
  assert.deepEqual(skillOverrides(["airflow", "mission-control", "dataviz"], ["mission-control"]), { airflow: "name-only", dataviz: "name-only" });
});

test("args: one --settings with the overrides by default; none when lean skills is off", () => {
  const dir = profile();
  const a = leanClaudeArgs(dir, null);
  assert.equal(a[0], "--settings");
  const o = JSON.parse(a[1]).skillOverrides;
  assert.equal(o.airflow, "name-only");
  assert.equal(o["mission-control"], undefined, "kept in full by default");
  writeSetting("desk.lean_skills", false);
  assert.deepEqual(leanClaudeArgs(dir, null), []);
});

test("env: workflows and /loop off by default, the Artifact tool only when switched off", () => {
  assert.deepEqual(leanClaudeEnv(null), { CLAUDE_CODE_DISABLE_WORKFLOWS: "1", CLAUDE_CODE_DISABLE_CRON: "1" });
  writeSetting("desk.artifact_tool", false);
  assert.equal(leanClaudeEnv(null).CLAUDE_CODE_DISABLE_ARTIFACT, "1");
});
