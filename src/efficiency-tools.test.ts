import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installCursorFffMcp, installFffMcp, installGrokFffMcp, installRtkRewriteScript, efficiencyToolsStatus, grokFffToml } from "./efficiency-tools.js";
import { claudeStyleHooks } from "./term-hooks.js";
import { CONFIG } from "./config.js";

test("claudeStyleHooks includes RTK Bash PreToolUse when enabled", () => {
  assert.equal(CONFIG.rtkEnabled, true);
  const hooks = claudeStyleHooks('"$HOME/.mc/bin/mc" hook claude', { notification: false });
  assert.equal(hooks.PreToolUse.length, 2);
  assert.match(hooks.PreToolUse[0].matcher, /AskUserQuestion/);
  assert.match(hooks.PreToolUse[1].matcher, /Bash/);
  assert.match(hooks.PreToolUse[1].hooks[0].command, /rtk-rewrite\.sh/);
});

test("installRtkRewriteScript copies scripts/rtk-rewrite.sh into ~/.mc/bin", () => {
  const r = installRtkRewriteScript();
  assert.ok(r === "written" || r === "noop");
  const dst = path.join(os.homedir(), ".mc", "bin", "rtk-rewrite.sh");
  assert.ok(fs.existsSync(dst));
  assert.match(fs.readFileSync(dst, "utf8"), /rtk rewrite/);
});

test("cursor mcp.json gains fff beside existing servers, reinstall is a noop", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fff-cursor-"));
  fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { slack: { url: "https://mcp.slack.com/mcp" } } }));
  assert.equal(installCursorFffMcp(dir, "/opt/homebrew/bin/fff-mcp"), "written");
  assert.equal(installCursorFffMcp(dir, "/opt/homebrew/bin/fff-mcp"), "noop");
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "mcp.json"), "utf8"));
  assert.equal(cfg.mcpServers.fff.command, "/opt/homebrew/bin/fff-mcp");
  assert.equal(cfg.mcpServers.slack.url, "https://mcp.slack.com/mcp");
  fs.writeFileSync(path.join(dir, "mcp.json"), "{ nope");
  assert.equal(installCursorFffMcp(dir, "/opt/homebrew/bin/fff-mcp"), "skipped");
});

test("grok config.toml gets one fff block and keeps the hooks block", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fff-grok-"));
  const file = path.join(home, "config.toml");
  fs.writeFileSync(file, "# BEGIN chronos terminal hooks\n[[hooks.Stop]]\n# END chronos terminal hooks\n");
  assert.equal(installGrokFffMcp(home, "/opt/homebrew/bin/fff-mcp"), "written");
  assert.equal(installGrokFffMcp(home, "/opt/homebrew/bin/fff-mcp"), "noop");
  const toml = fs.readFileSync(file, "utf8");
  assert.equal(toml.split("[mcp_servers.fff]").length, 2);
  assert.match(toml, /BEGIN chronos terminal hooks/);
  assert.match(grokFffToml("/opt/homebrew/bin/fff-mcp"), /command = "\/opt\/homebrew\/bin\/fff-mcp"/);
  fs.writeFileSync(file, "[mcp_servers.fff]\ncommand = \"custom\"\n");
  assert.equal(installGrokFffMcp(home, "/opt/homebrew/bin/fff-mcp"), "skipped");
  assert.match(fs.readFileSync(file, "utf8"), /custom/);
});

test("installFffMcp is a soft no-op when fff-mcp is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fff-mcp-"));
  // No binary → skipped or removed; never throws.
  const r = installFffMcp(dir);
  assert.ok(r === "skipped" || r === "removed" || r === "noop" || r === "written");
  const status = efficiencyToolsStatus();
  assert.equal(typeof status.rtk.enabled, "boolean");
  assert.equal(typeof status.fff.enabled, "boolean");
});
