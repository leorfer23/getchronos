import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { installCursorFffMcp, installFffMcp, installFffWrapperScript, installGrokFffMcp, installRtkRewriteScript, efficiencyToolsStatus, fffCommand, grokFffToml } from "./efficiency-tools.js";
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
  assert.equal(installCursorFffMcp(dir, "/opt/homebrew/bin/fff-mcp", null), "written");
  assert.equal(installCursorFffMcp(dir, "/opt/homebrew/bin/fff-mcp", null), "noop");
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "mcp.json"), "utf8"));
  assert.equal(cfg.mcpServers.fff.command, "/opt/homebrew/bin/fff-mcp");
  assert.equal(cfg.mcpServers.slack.url, "https://mcp.slack.com/mcp");
  fs.writeFileSync(path.join(dir, "mcp.json"), "{ nope");
  assert.equal(installCursorFffMcp(dir, "/opt/homebrew/bin/fff-mcp", null), "skipped");
});

test("grok config.toml gets one fff block and keeps the hooks block", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fff-grok-"));
  const file = path.join(home, "config.toml");
  fs.writeFileSync(file, "# BEGIN chronos terminal hooks\n[[hooks.Stop]]\n# END chronos terminal hooks\n");
  assert.equal(installGrokFffMcp(home, "/opt/homebrew/bin/fff-mcp", null), "written");
  assert.equal(installGrokFffMcp(home, "/opt/homebrew/bin/fff-mcp", null), "noop");
  const toml = fs.readFileSync(file, "utf8");
  assert.equal(toml.split("[mcp_servers.fff]").length, 2);
  assert.match(toml, /BEGIN chronos terminal hooks/);
  assert.match(grokFffToml("/opt/homebrew/bin/fff-mcp", null), /command = "\/opt\/homebrew\/bin\/fff-mcp"/);
  fs.writeFileSync(file, "[mcp_servers.fff]\ncommand = \"custom\"\n");
  assert.equal(installGrokFffMcp(home, "/opt/homebrew/bin/fff-mcp", null), "skipped");
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

// ── fff through the launcher (scripts/fff-mcp.sh) ──────────────────────────────────────────────
const BIN = "/opt/homebrew/bin/fff-mcp";
const tmpd = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

test("the launcher is copied into ~/.mc/bin (here a tmp dir) and is executable; reinstall is a noop", () => {
  const dir = tmpd("fff-bin-");
  assert.equal(installFffWrapperScript(dir), "written");
  assert.equal(installFffWrapperScript(dir), "noop");
  assert.ok(fs.statSync(path.join(dir, "fff-mcp.sh")).mode & 0o100, "executable");
});

test("claude, cursor and grok all register the launcher with the binary as its arg; a bare-binary entry migrates", () => {
  const wrapper = "/home/u/.mc/bin/fff-mcp.sh";
  assert.deepEqual(fffCommand(BIN, wrapper), { command: wrapper, args: [BIN] });
  assert.deepEqual(fffCommand(BIN, null), { command: BIN, args: [] }, "no launcher installed: the bare binary, as before");

  const prof = tmpd("fff-claude-");
  fs.writeFileSync(path.join(prof, ".claude.json"), JSON.stringify({ mcpServers: { fff: { type: "stdio", command: BIN, args: [] }, other: { command: "x" } } }));
  assert.equal(installFffMcp(prof, BIN, wrapper), "written", "the old bare-binary entry is rewritten");
  assert.equal(installFffMcp(prof, BIN, wrapper), "noop");
  const claude = JSON.parse(fs.readFileSync(path.join(prof, ".claude.json"), "utf8"));
  assert.deepEqual(claude.mcpServers.fff, { type: "stdio", command: wrapper, args: [BIN] });
  assert.equal(claude.mcpServers.other.command, "x");

  const cur = tmpd("fff-cursor2-");
  fs.writeFileSync(path.join(cur, "mcp.json"), JSON.stringify({ mcpServers: { fff: { command: BIN, args: [] } } }));
  assert.equal(installCursorFffMcp(cur, BIN, wrapper), "written");
  assert.equal(installCursorFffMcp(cur, BIN, wrapper), "noop");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cur, "mcp.json"), "utf8")).mcpServers.fff, { command: wrapper, args: [BIN] });

  const grok = tmpd("fff-grok2-");
  assert.equal(installGrokFffMcp(grok, BIN, null), "written");
  assert.equal(installGrokFffMcp(grok, BIN, wrapper), "written", "the managed block is replaced in place");
  assert.equal(installGrokFffMcp(grok, BIN, wrapper), "noop");
  const toml = fs.readFileSync(path.join(grok, "config.toml"), "utf8");
  assert.equal(toml.split("[mcp_servers.fff]").length, 2);
  assert.match(toml, new RegExp(`command = "${esc(wrapper)}"\\nargs = \\["${esc(BIN)}"\\]`));
});

// The launcher itself, against a stand-in fff-mcp that prints the args it was exec'd with.
const LAUNCHER = path.join(process.cwd(), "scripts", "fff-mcp.sh");
const fakeBin = (() => {
  const p = path.join(tmpd("fff-fake-"), "fff-mcp");
  fs.writeFileSync(p, '#!/bin/sh\necho "ARGS $*"\n', { mode: 0o755 });
  return p;
})();
const launch = (cwd: string, extra: Record<string, string> = {}) =>
  spawnSync("/bin/bash", [LAUNCHER, fakeBin], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...extra },
  });

test("launcher: inside a git repo (even a subdir) fff indexes the repo's toplevel", () => {
  const repo = tmpd("fff-repo-");
  execFileSync("git", ["init", "-q", repo]);
  fs.mkdirSync(path.join(repo, "src"));
  const r = launch(path.join(repo, "src"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `ARGS --no-update-check ${repo}`);
});

test("launcher: $MC_REPO wins when it is a directory; a repo id (what Chronos sets) is ignored", () => {
  const repo = tmpd("fff-repo2-");
  const plain = tmpd("fff-plain-");
  fs.writeFileSync(path.join(plain, "notes.txt"), "x");
  assert.equal(launch(plain, { MC_REPO: repo }).stdout.trim(), `ARGS --no-update-check ${repo}`);
  assert.equal(launch(plain, { MC_REPO: "8c1f0e2a-repo-id" }).stdout.trim(), `ARGS --no-update-check ${plain}`, "a plain folder of files is indexed as is");
});

test("launcher: $HOME and a landing dir of symlinked repos are refused with a reason, and fff never starts", () => {
  const home = tmpd("fff-home-");
  const h = launch(home, { HOME: home });
  assert.equal(h.status, 0);
  assert.equal(h.stdout, "", "fff-mcp was not exec'd");
  assert.match(h.stderr, /not indexing .* \(home or filesystem root\)/);

  const repo = tmpd("fff-linked-");
  const farm = tmpd("fff-farm-");
  fs.writeFileSync(path.join(farm, "AGENTS.md"), "# landing");
  fs.symlinkSync(repo, path.join(farm, "app"));
  const f = launch(farm);
  assert.equal(f.status, 0);
  assert.equal(f.stdout, "");
  assert.match(f.stderr, /landing dir of symlinked repos/);
});
