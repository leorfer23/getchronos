/**
 * The built-in slash commands each CLI offers in the composer (cli-commands.ts): every table well-formed
 * and provenanced, and none of the commands the module promises to leave out (a conversation switch the
 * Desk would not follow, quitting, signing out, sending to a vendor, input modes, settings dialogs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { builtinFor, cliFor, CLI_COMMANDS } from "./cli-commands.js";

const NEVER = [
  "exit", "quit", "login", "logout", "vim", "clear", "new", "reset", "resume", "continue", "fork", "branch", "teleport", "sessions",
  "feedback", "bug", "share", "unshare", "remote-control", "theme", "themes", "config", "settings", "permissions", "plugin", "plugins",
  "hooks", "memory", "editor", "upgrade", "restart", "background", "connect", "keybindings", "terminal-setup", "detach",
];

test("every CLI's table names its docs, the version it was checked against, and how it switches models", () => {
  assert.deepEqual(Object.keys(CLI_COMMANDS).sort(), ["claude-code", "codex", "cursor-agent", "grok", "opencode"]);
  for (const [backend, t] of Object.entries(CLI_COMMANDS)) {
    assert.ok(t.label.trim(), backend);
    assert.match(t.version, /^\d[\w.-]*$/, `${backend} version`);
    assert.match(t.docs, /^https:\/\/[\w.-]+\.[a-z]{2,}\//, `${backend} docs`);
    assert.ok(t.switchModel === null || /^\/[a-z-]+( \{model\})?$/.test(t.switchModel), `${backend} switchModel ${t.switchModel}`);
    assert.ok(t.commands.length >= 5, `${backend} has a useful list`);
  }
});

test("commands are typeable, unique, one line each, and never one the module leaves out", () => {
  for (const [backend, t] of Object.entries(CLI_COMMANDS)) {
    const names = t.commands.map((c) => c.name);
    assert.equal(new Set(names).size, names.length, `${backend}: duplicate names`);
    for (const c of t.commands) {
      assert.match(c.name, /^[a-z][a-z0-9-]*$/, `${backend} /${c.name}`);
      assert.ok(c.desc.trim() && c.desc.length <= 80 && !/\n/.test(c.desc), `${backend} /${c.name}: "${c.desc}"`);
      assert.ok(!c.hint || (c.hint.length <= 32 && /^[[<]/.test(c.hint)), `${backend} /${c.name} hint "${c.hint}"`);
      assert.ok(!NEVER.includes(c.name), `${backend} offers /${c.name}, which the module promises to leave out`);
      assert.ok(c.opens === undefined || c.opens === "terminal");
    }
    for (const r of t.reserved ?? []) assert.match(r, /^[a-z][a-z0-9-]*$/, `${backend} reserved ${r}`);
  }
  // Every offered claude command is also one of the names claude answers to.
  const claude = CLI_COMMANDS["claude-code"];
  for (const c of claude.commands) assert.ok(claude.reserved!.includes(c.name), `/${c.name} missing from reserved`);
});

test("builtinFor: exact invocations, the terminal-only ones marked, /loop gone while Desk terminals run lean", () => {
  const items = builtinFor("claude-code");
  assert.ok(items.every((i) => i.group === "builtin" && i.insert === `/${i.name} `));
  assert.equal(items.find((i) => i.name === "context")!.opens, "terminal");
  assert.equal(items.find((i) => i.name === "compact")!.hint, "[instructions]");
  assert.ok(items.some((i) => i.name === "loop"));
  assert.ok(!builtinFor("claude-code", { leanTools: true }).some((i) => i.name === "loop"), "CLAUDE_CODE_DISABLE_CRON: /loop would do nothing");
  assert.ok(builtinFor("codex", { leanTools: true }).length > 0, "lean only touches claude");
  for (const none of ["mock", "cursor-cloud", "openai-api", ""]) {
    assert.equal(cliFor(none), null);
    assert.deepEqual(builtinFor(none), []);
  }
});
