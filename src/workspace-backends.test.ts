/**
 * Which agent CLIs a workspace may spawn.
 *
 * The reason this is enforced and not merely filtered: of the five CLIs, only claude
 * (CLAUDE_CONFIG_DIR) and codex (CODEX_HOME) take a per-workspace config dir. cursor, grok and
 * opencode have none, so on a client workspace they run that client's work through the same shared
 * login as every other workspace. A picker that merely hides them is a suggestion; the spawn path
 * has to refuse.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { backendAllowed, listBackends, workspaceBackends } from "./backends/index.js";

const ALL = listBackends().map((b) => b.name);

describe("workspaceBackends", () => {
  test("an unrestricted workspace gets every registered backend", () => {
    // The default, and what every workspace had before this existed — no silent narrowing.
    assert.deepEqual(workspaceBackends(null), ALL);
    assert.deepEqual(workspaceBackends(undefined), ALL);
    assert.deepEqual(workspaceBackends(""), ALL);
  });

  test("a client pinned to claude gets exactly that", () => {
    assert.deepEqual(workspaceBackends(JSON.stringify(["claude-code"])), ["claude-code"]);
  });

  test("personal keeps the full set when listed explicitly", () => {
    const personal = ["claude-code", "cursor-agent", "codex", "grok", "opencode", "openai-api"];
    assert.deepEqual(workspaceBackends(JSON.stringify(personal)), personal);
  });

  test("unknown names are dropped, never trusted through", () => {
    // A typo must narrow to the real ones. Passing it through would let a name reach the spawner,
    // which resolves anything unknown to claude-code — silently running a backend nobody chose.
    assert.deepEqual(workspaceBackends(JSON.stringify(["claude-code", "cursr-agent", "nope"])), ["claude-code"]);
  });

  test("junk or an all-invalid list falls back to everything, rather than to nothing", () => {
    // Failing OPEN is deliberate: this column is client hygiene, not a security control. Failing
    // closed on a typo would strand a workspace with no usable backend and no obvious cause.
    assert.deepEqual(workspaceBackends("not json"), ALL);
    assert.deepEqual(workspaceBackends('{"not":"an array"}'), ALL);
    assert.deepEqual(workspaceBackends(JSON.stringify(["nonsense-only"])), ALL);
    assert.deepEqual(workspaceBackends(JSON.stringify([])), ALL);
  });

  test("the picker never offers a backend that is deliberately unadvertised", () => {
    // `mock` is resolvable by name but hidden from every picker on purpose — in the UI it would
    // fake a verified success with zero work done.
    assert.ok(!workspaceBackends(null).includes("mock"));
    assert.ok(!workspaceBackends(JSON.stringify(["claude-code", "mock"])).includes("mock"));
  });
});

describe("backendAllowed", () => {
  const claudeOnly = JSON.stringify(["claude-code"]);

  test("a claude-only client may run claude and nothing else", () => {
    assert.equal(backendAllowed(claudeOnly, "claude-code"), true);
    for (const b of ["cursor-agent", "grok", "opencode", "codex"]) {
      assert.equal(backendAllowed(claudeOnly, b), false, `${b} must be refused`);
    }
  });

  test("the three shared-login CLIs are refused on a restricted client", () => {
    // Named explicitly because this is the actual client-separation risk, not a style rule.
    for (const shared of ["cursor-agent", "grok", "opencode"]) {
      assert.equal(backendAllowed(claudeOnly, shared), false);
    }
  });

  test("an unrestricted workspace allows anything registered", () => {
    for (const b of ALL) assert.equal(backendAllowed(null, b), true);
  });

  test("an unrestricted workspace still allows UNADVERTISED backends", () => {
    // The regression that broke 11 tests: the gate was built on the advertised list, so `mock` —
    // hidden from pickers but how the entire suite spawns — was refused at every dispatch. "Not
    // shown in the dropdown" must never mean "may not run".
    assert.equal(backendAllowed(null, "mock"), true);
    // …but a workspace with an explicit list is still held to exactly that list.
    assert.equal(backendAllowed(JSON.stringify(["claude-code"]), "mock"), false);
  });

  test("no explicit backend is allowed — the workspace default applies", () => {
    assert.equal(backendAllowed(claudeOnly, null), true);
    assert.equal(backendAllowed(claudeOnly, undefined), true);
    assert.equal(backendAllowed(claudeOnly, ""), true);
  });
});
